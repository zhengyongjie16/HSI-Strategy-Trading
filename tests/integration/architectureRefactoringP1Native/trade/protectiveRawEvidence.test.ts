import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/** 注册 broker callback→真实 Monitor/eventFlow/settlement：保护性缺价拒绝与普通同量复用分别守护。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import { createTerminationRuntime } from '../../../../src/runtime/lifecycle/terminationRuntime.js';
import type { OrderMonitorDeps } from '../../../../src/application/orderTracking/types.js';
import type { OrderStateChangedEvent } from '../../../../src/types/orderTracking.js';
import type { RateLimiter } from '../../../../src/types/rateLimit.js';
import { createExecutionFixture } from '../../../application/orderTracking/recorder/executionFixture.js';

import { createBrokerIngressFixture } from './brokerIngressFixture.js';

/** 仅排空已发 callback 的微任务，不靠 stop 使尚未处理的 ingress 失效。 */
async function waitForIngress(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (done()) return;

    await Promise.resolve();
  }

  throw new Error('registered Monitor ingress did not reach its expected result');
}

/** 只替换 IO/时钟；经济、日损、episode、hold 和终态结算使用原生产 owner。 */
async function fixture(protective: boolean) {
  const time = Date.parse('2026-07-13T02:00:00.000Z');
  const frame = {
    orderId: 'RAW-TERMINAL',
    tradeId: 'RAW-EXECUTION',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: protective ? 'HSI|PL' : 'HSI',
    side: 'SELL' as const,
    status: 'PartialFilled' as const,
    orderType: 'ELO' as const,
    quantity: '100',
    executedQuantity: '40',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: time,
    executionTimeMs: time + 100,
    updatedAtMs: time + 150,
  };
  const native = await createBrokerIngressFixture(frame);
  const fatalReports: unknown[] = [];
  const gateClosures: string[] = [];
  const secondaryErrors: unknown[] = [];
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      gateClosures.push('TRADING');
    },
    closeProducerAdmission: () => {
      gateClosures.push('PRODUCERS');
    },
    stopProducers: [],
    onSecondaryError: (error) => {
      secondaryErrors.push(error);
    },
  });
  const rateLimiter: RateLimiter = {
    throttle: async () => {},
    withTradeMutation: async (callback) => callback({ invoke: (operation) => operation() }),
  };
  const durable: Array<
    Parameters<OrderMonitorDeps['persistProtectiveLiquidationExecutionProgress']>[0]
  > = [];
  const persistProgress: OrderMonitorDeps['persistProtectiveLiquidationExecutionProgress'] = (
    progress,
  ) => {
    durable.push(progress);
  };
  const refreshes: unknown[] = [];
  const economic = createExecutionFixture({
    nowMs: time,
    termination,
    rateLimiter,
    createRecorder: native.createRecorder,
    persistProgress,
    observeRefresh: (need) => {
      refreshes.push(need);
    },
  });
  const events: OrderStateChangedEvent[] = [];
  const monitor = native.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    marketDataClient: createMarketDataClientDouble(),
    orderRecorder: economic.recorder,
    dailyLossTracker: economic.daily,
    orderHoldRegistry: economic.holds,
    protectiveLiquidationEpisodeTracker: economic.episode,
    persistProtectiveLiquidationExecutionProgress: persistProgress,
    postTradeConsistencyRuntime: economic.sink,
    tradingConfig: createTradingConfig(),
    symbolRegistry: createSymbolRegistryDouble(),
    isContinuousTradingAllowed: () => false,
    now: () => new Date(time + 200),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    termination: {
      isTerminated: termination.isTerminated,
      reportFatalError: (error) => {
        fatalReports.push(error);
        termination.reportFatalError(error);
      },
    },
  });
  monitor.onOrderStateChanged((event) => {
    events.push(event);
  });
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  monitor.trackOrder({
    orderId: frame.orderId,
    symbol: frame.symbol,
    side: 'SELL',
    executionSide: 'SELL',
    price: '1',
    initialSubmittedPrice: '1',
    quantity: 100,
    submittedAtMs: frame.submittedAtMs,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: protective,
    orderType: native.queryObservation.orderType,
  });
  economic.recorder.submitSellOrder(frame.orderId, frame.symbol, 'LONG', 100, [], time);
  return {
    native,
    frame,
    monitor,
    economic,
    durable,
    events,
    refreshes,
    termination,
    fatalReports,
    gateClosures,
    secondaryErrors,
  };
}

/** 捕获已有成交及资源基线，避免只检查 fatal 而遗漏失败前写入。 */
function observations(f: Awaited<ReturnType<typeof fixture>>) {
  return structuredClone({
    fact: f.economic.recorder.getExecutionFact(f.frame.orderId),
    sell: f.economic.recorder.getSellRecordByOrderId(f.frame.orderId),
    pending: f.economic.recorder.getPendingSellSnapshot(),
    tracked: f.monitor.getPendingSellOrders(f.frame.symbol),
    holds: [...f.economic.holds.getHoldSymbols()],
    protectivePending: f.monitor.hasPendingProtectiveLiquidationOrders('LONG'),
    daily: f.economic.daily.getExecutionTimeEvidence(),
    loss: f.economic.daily.getLossOffset('LONG'),
    episode: f.economic.episode.getInProgressEpisodes(),
    durable: f.durable,
    events: f.events,
    refreshes: f.refreshes,
  });
}

describe('protective raw terminal price admission through registered broker ingress', () => {
  it.each([
    { protective: true, terminalPrice: '0', rejected: true },
    { protective: false, terminalPrice: '0', rejected: false },
    { protective: true, terminalPrice: '1', rejected: false },
  ])('protective=$protective terminalPrice=$terminalPrice rejected=$rejected', async (scenario) => {
    const f = await fixture(scenario.protective);
    try {
      // 先由同一个真实 callback 提交部分成交，不手工填 tracked/confirmed 伪造前提。
      f.native.emitOrderChangedFrame(f.frame);
      await waitForIngress(
        () =>
          f.fatalReports.length > 0 ||
          f.monitor.getPendingSellOrders(f.frame.symbol)[0]?.executedQuantity === 40,
      );
      expect(f.fatalReports).toEqual([]);
      expect(f.economic.recorder.getExecutionFact(f.frame.orderId)).toMatchObject({
        phase: 'OPEN',
        cumulativeQuantity: 40,
        cumulativeAmount: '40',
        executionTimeMs: f.frame.executionTimeMs,
        updatedAtMs: f.frame.updatedAtMs,
      });
      expect(f.durable).toHaveLength(scenario.protective ? 1 : 0);
      expect(f.monitor.getPendingSellOrders(f.frame.symbol)).toHaveLength(1);
      expect(f.economic.holds.getHoldSymbols().has(f.frame.symbol)).toBe(true);
      const before = observations(f);
      const reads = f.native.readCounts();

      // ledger 保持完整且完全匹配；唯一变量是当前终态原价，不是缺 execution T。
      f.native.emitOrderChangedFrame({
        ...f.frame,
        status: 'Canceled',
        executedPrice: scenario.terminalPrice,
        updatedAtMs: f.frame.updatedAtMs + 50,
      });

      await waitForIngress(
        () => f.fatalReports.length > 0 || f.events.length > before.events.length,
      );
      expect(f.native.readCounts()).toEqual({ today: reads.today + 1, history: reads.history + 1 });
      expect(f.native.nativeMutations()).toEqual([]);
      expect(f.secondaryErrors).toEqual([]);

      if (scenario.rejected) {
        expect(f.fatalReports).toHaveLength(1);
        const originalError = f.fatalReports[0];
        expect(originalError).toBeInstanceOf(TypeError);
        expect(originalError).toHaveProperty(
          'message',
          '[orderMapper] invalid cumulative execution quantity/price',
        );
        const fatal = f.termination.getFatalState();
        expect(fatal.hasFatalError).toBe(true);
        if (!fatal.hasFatalError) throw new Error('missing latched fatal');

        expect(fatal.error).toBe(originalError);
        expect(f.gateClosures).toEqual(['TRADING', 'PRODUCERS']);
        expect(observations(f)).toEqual(before);
      } else {
        expect(f.fatalReports).toEqual([]);
        expect(f.termination.isTerminated()).toBe(false);
        expect(f.economic.recorder.getExecutionFact(f.frame.orderId)).toMatchObject({
          phase: 'TERMINAL',
          cumulativeQuantity: 40,
          cumulativeAmount: '40',
          executionTimeMs: f.frame.executionTimeMs,
          updatedAtMs: f.frame.updatedAtMs + 50,
        });

        expect(f.economic.recorder.getSellRecordByOrderId(f.frame.orderId)).toMatchObject({
          costAmount: '40',
          executedQuantity: 40,
          executedTime: f.frame.executionTimeMs,
        });

        expect(f.events).toMatchObject([{ status: 'CANCELED', executedQuantity: 40 }]);
        expect(f.durable).toHaveLength(scenario.protective ? 2 : 0);
        expect(f.economic.recorder.getPendingSellSnapshot()).toEqual([]);
        expect(f.monitor.getPendingSellOrders(f.frame.symbol)).toEqual([]);
        expect(f.economic.holds.getHoldSymbols().has(f.frame.symbol)).toBe(false);
        expect(f.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(false);
      }
    } finally {
      await f.monitor.stopRuntimeAndDrain();
      await f.monitor.teardown();
    }
  });
});
