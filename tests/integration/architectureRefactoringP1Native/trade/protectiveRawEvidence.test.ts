import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/** 注册 SDK callback→真实 Monitor/termination/经济 owner：坏价或 FILLED 零量首次 fatal 且零副作用。 */

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
async function fixture(
  params: Readonly<{
    protective: boolean;
    side?: 'BUY' | 'SELL';
    activate?: boolean;
    track?: boolean;
  }>,
) {
  const { protective, side = 'SELL' } = params;
  const time = Date.parse('2026-07-13T02:00:00.000Z');
  const frame = {
    orderId: 'RAW-TERMINAL',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: protective ? 'HSI|PL' : 'HSI',
    side,
    status: 'PartialFilled' as const,
    orderType: 'ELO' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: '1',
    submittedAtMs: time,
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
  const diagnostics: Array<Parameters<OrderMonitorDeps['diagnostics']['record']>> = [];
  const monitor = native.createMonitor({
    diagnostics: {
      record: (...args) => {
        diagnostics.push(args);
      },
    },
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
  if (params.activate !== false) await monitor.recoverOrderTrackingFromSnapshot([]);

  if (params.track !== false)
    monitor.trackOrder({
      orderId: frame.orderId,
      symbol: frame.symbol,
      side,
      executionSide: side,
      price: '1',
      initialSubmittedPrice: '1',
      quantity: 100,
      submittedAtMs: frame.submittedAtMs,
      isLongSymbol: true,
      monitorSymbol: 'HSI.HK',
      isProtectiveLiquidation: protective,
      orderType: native.queryObservation.orderType,
    });

  if (params.track !== false && side === 'SELL') {
    economic.recorder.submitSellOrder(frame.orderId, frame.symbol, 'LONG', 100, [], time);
  }

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
    diagnostics,
  };
}

/** 捕获已有成交及资源基线，避免只检查 fatal 而遗漏失败前写入。 */
function observations(f: Awaited<ReturnType<typeof fixture>>) {
  return structuredClone({
    fact: f.economic.recorder.getExecutionFact(f.frame.orderId),
    sell: f.economic.recorder.getSellRecordByOrderId(f.frame.orderId),
    buys: f.economic.recorder.getBuyOrdersForSymbol(f.frame.symbol, true),
    cost: f.economic.recorder.getCostBasis(f.frame.symbol, true),
    snapshot: f.economic.snapshot.getView().token,
    consistency: f.economic.sink.getStatus(),
    pending: f.economic.recorder.getPendingSellSnapshot(),
    tracked: f.monitor.getPendingSellOrders(f.frame.symbol),
    unsettled: f.monitor.getUnsettledSellOrderIds(f.frame.symbol),
    operation: f.monitor.getSellOperationState(f.frame.orderId),
    holds: [...f.economic.holds.getHoldSymbols()],
    protectivePending: f.monitor.hasPendingProtectiveLiquidationOrders('LONG'),
    loss: f.economic.daily.getLossOffset('LONG'),
    episode: f.economic.episode.getInProgressEpisodes(),
    durable: f.durable,
    events: f.events,
    refreshes: f.refreshes,
    diagnostics: f.diagnostics,
  });
}

describe('raw terminal admission through registered broker ingress', () => {
  it.each([
    { protective: false, side: 'BUY' as const, status: 'Filled' as const, rejected: true },
    { protective: false, side: 'SELL' as const, status: 'Filled' as const, rejected: true },
    { protective: true, side: 'SELL' as const, status: 'Filled' as const, rejected: true },
    { protective: false, side: 'SELL' as const, status: 'Canceled' as const, rejected: false },
    { protective: true, side: 'SELL' as const, status: 'Rejected' as const, rejected: false },
  ])(
    'first callback $status Q=0 for $side protective=$protective rejects=$rejected',
    async (scenario) => {
      const f = await fixture(scenario);
      try {
        const before = observations(f);
        expect(before.fact).toBeNull();
        expect(before.holds).toEqual([f.frame.symbol]);
        expect(before.pending).toHaveLength(scenario.side === 'SELL' ? 1 : 0);
        // fixture 初始化和 trackOrder 均合法；第一条实际 callback 才注入零量终态。
        f.native.emitOrderChangedFrame({
          ...f.frame,
          status: scenario.status,
          executedQuantity: '0',
          executedPrice: '0',
        });
        expect(f.termination.isTerminated()).toBe(scenario.rejected);
        expect(f.fatalReports).toHaveLength(scenario.rejected ? 1 : 0);

        if (scenario.rejected) {
          expect(f.fatalReports[0]).toBeInstanceOf(TypeError);
          expect(f.termination.getFatalState()).toEqual({
            hasFatalError: true,
            error: f.fatalReports[0],
          });
          expect(f.gateClosures).toEqual(['TRADING', 'PRODUCERS']);
          expect(observations(f)).toEqual(before);
        } else {
          await waitForIngress(() => f.events.length === 1 || f.fatalReports.length > 0);
          expect(f.fatalReports).toEqual([]);
          expect(f.events).toMatchObject([
            {
              status: scenario.status === 'Canceled' ? 'CANCELED' : 'REJECTED',
              executedQuantity: 0,
            },
          ]);
          expect(f.monitor.getPendingSellOrders(f.frame.symbol)).toEqual([]);
          expect(f.monitor.getUnsettledSellOrderIds(f.frame.symbol)).toEqual([]);
          expect(f.monitor.getSellOperationState(f.frame.orderId)).toBe('SETTLED_WITH_REMAINDER');
          expect(f.economic.recorder.getPendingSellSnapshot()).toEqual([]);
          expect(f.economic.holds.getHoldSymbols().has(f.frame.symbol)).toBe(false);
          expect(f.economic.recorder.getExecutionFact(f.frame.orderId)).toBeNull();
          expect(f.economic.daily.getLossOffset('LONG')).toBe(before.loss);
          expect(f.economic.snapshot.getView().token).toEqual(before.snapshot);
          expect(f.economic.sink.getStatus()).toEqual(before.consistency);
          expect(f.durable).toEqual([]);
          expect(f.refreshes).toEqual([]);
        }

        expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
        expect(f.native.orderSnapshotReadCounts()).toEqual({ history: 0, today: 0 });
        expect(f.native.nativeMutations()).toEqual([]);
        expect(f.secondaryErrors).toEqual([]);
      } finally {
        await f.monitor.stopRuntimeAndDrain();
        await f.monitor.teardown();
      }
    },
  );

  it.each([
    { protective: false, side: 'BUY' as const, terminalPrice: '0', rejected: true },
    { protective: false, side: 'BUY' as const, terminalPrice: null, rejected: true },
    { protective: false, side: 'SELL' as const, terminalPrice: '0', rejected: true },
    { protective: true, side: 'SELL' as const, terminalPrice: null, rejected: true },
    { protective: true, side: 'SELL' as const, terminalPrice: '0', rejected: true },
    { protective: false, side: 'BUY' as const, terminalPrice: '-1', rejected: true },
    { protective: true, side: 'SELL' as const, terminalPrice: '1', rejected: false },
  ])(
    '$side protective=$protective terminalPrice=$terminalPrice rejected=$rejected',
    async (scenario) => {
      const f = await fixture(scenario);
      try {
        // 先由同一个真实 callback 提交部分成交，不手工填 tracked/confirmed 伪造前提。
        f.native.emitOrderChangedFrame(f.frame);
        await waitForIngress(
          () =>
            f.fatalReports.length > 0 ||
            f.economic.recorder.getExecutionFact(f.frame.orderId)?.cumulativeQuantity === 100,
        );
        expect(f.fatalReports).toEqual([]);
        expect(f.economic.recorder.getExecutionFact(f.frame.orderId)).toMatchObject({
          phase: 'OPEN',
          cumulativeQuantity: 100,
          cumulativeAmount: '100',
          executionTimeMs: f.frame.updatedAtMs,
          updatedAtMs: f.frame.updatedAtMs,
        });
        expect(f.durable).toHaveLength(scenario.protective ? 1 : 0);
        expect(f.monitor.getUnsettledSellOrderIds(f.frame.symbol)).toEqual(
          scenario.side === 'SELL' ? [f.frame.orderId] : [],
        );
        expect(f.economic.holds.getHoldSymbols().has(f.frame.symbol)).toBe(true);
        const before = observations(f);

        // 仅发一次坏终态；不得等待第二帧、补查 detail 或继承 partial 价格完成结算。
        f.native.emitOrderChangedFrame({
          ...f.frame,
          status: scenario.rejected ? 'Filled' : 'Canceled',
          executedPrice: scenario.terminalPrice,
          updatedAtMs: f.frame.updatedAtMs + 50,
        });
        expect(f.termination.isTerminated()).toBe(scenario.rejected);

        await waitForIngress(
          () => f.fatalReports.length > 0 || f.events.length > before.events.length,
        );
        expect(f.native.nativeMutations()).toEqual([]);
        expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
        expect(f.secondaryErrors).toEqual([]);

        if (scenario.rejected) {
          expect(f.fatalReports).toHaveLength(1);
          const originalError = f.fatalReports[0];
          expect(originalError).toBeInstanceOf(TypeError);
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
            cumulativeQuantity: 100,
            cumulativeAmount: '100',
            executionTimeMs: f.frame.updatedAtMs,
            updatedAtMs: f.frame.updatedAtMs + 50,
          });

          expect(f.economic.recorder.getSellRecordByOrderId(f.frame.orderId)).toMatchObject({
            costAmount: '100',
            executedQuantity: 100,
            executedTime: f.frame.updatedAtMs,
          });

          expect(f.events).toMatchObject([{ status: 'CANCELED', executedQuantity: 100 }]);
          expect(f.durable).toHaveLength(2);
          expect(f.economic.recorder.getPendingSellSnapshot()).toEqual([]);
          expect(f.monitor.getPendingSellOrders(f.frame.symbol)).toEqual([]);
          expect(f.economic.holds.getHoldSymbols().has(f.frame.symbol)).toBe(false);
          expect(f.monitor.hasPendingProtectiveLiquidationOrders('LONG')).toBe(false);

          // 真正 detach 后的同 revision 完整 OPEN 只是晚到重放，即使其订单时间代理晚于 known T。
          const afterClosed = observations(f);
          f.native.emitOrderChangedFrame({ ...f.frame, updatedAtMs: f.frame.updatedAtMs + 50 });
          expect(f.fatalReports).toEqual([]);
          expect(observations(f)).toEqual(afterClosed);

          // 同 revision 不能成为坏 OPEN 的豁免条件。
          f.native.emitOrderChangedFrame({
            ...f.frame,
            executedPrice: '0',
            updatedAtMs: f.frame.updatedAtMs + 50,
          });
          expect(f.fatalReports).toHaveLength(1);
          expect(f.termination.isTerminated()).toBe(true);
          expect(observations(f)).toEqual(afterClosed);
        }
      } finally {
        await f.monitor.stopRuntimeAndDrain();
        await f.monitor.teardown();
      }
    },
  );

  it.each([false, true])(
    'first malformed unknown terminal is fatal before bootstrap cache/unknown-order filtering (active=%s)',
    async (activate) => {
      const f = await fixture({ protective: false, activate, track: false });
      try {
        f.native.emitOrderChangedFrame(f.frame);
        const before = observations(f);
        f.native.emitOrderChangedFrame({ ...f.frame, status: 'Filled', executedPrice: '0' });
        expect(f.fatalReports).toHaveLength(1);
        expect(f.termination.isTerminated()).toBe(true);
        expect(f.gateClosures).toEqual(['TRADING', 'PRODUCERS']);
        expect(observations(f)).toEqual(before);

        // 同 orderId 的后续完整帧不得覆盖首次坏证据或解除已闭合 fatal 门禁。
        const firstError = f.fatalReports[0];
        f.native.emitOrderChangedFrame({ ...f.frame, status: 'Filled' });
        expect(f.fatalReports).toEqual([firstError]);
        expect(observations(f)).toEqual(before);
        expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
      } finally {
        await f.monitor.stopRuntimeAndDrain();
        await f.monitor.teardown();
      }
    },
  );
});
