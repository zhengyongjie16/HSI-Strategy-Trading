import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

/** closed tracking 不关闭 O/Daily revision 水位：真实 SDK push→EventFlow→结算及经济/刷新幂等回归。 */

import { expect, test } from 'bun:test';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';

import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

const T = Date.parse('2026-10-07T02:00:00.000Z');

/** 原始订单观察时间即 broker updatedAt；同量修订保留首次正成交的 known T。 */
function frame(revision: number, price = '1') {
  return {
    orderId: 'closed-buy',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY' as const,
    status: 'Filled' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: price,
    submittedAtMs: T - 1000,
    updatedAtMs: T + revision,
  };
}

async function waitUntil(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;

    await Bun.sleep(2);
  }

  throw new Error('registered ingress did not finish');
}

for (const conflictingRevision of [20, 15])
  test(`M2 10/100→20/100 stores watermark only; ${conflictingRevision}/110 cannot overwrite or re-close`, async () => {
    const native = await createBrokerIngressFixture(frame(10));
    let admissions = 0;
    const f = createExecutionFixture({
      nowMs: T,
      observeDaily: (daily) => ({
        ...daily,
        recordCumulativeExecution: (...args) => {
          admissions++;
          return daily.recordCumulativeExecution(...args);
        },
      }),
    });
    const closed: string[] = [];
    const monitor = native.createMonitor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      requestExternalApi: wrapExternalApiRequest,
      scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
      now: () => new Date(T),
      scheduleTimer: setTimeout,
      clearTimer: clearTimeout,
      rateLimiter: f.rateLimiter,
      cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
      orderHoldRegistry: f.holds,
      protectiveLiquidationEpisodeTracker: f.episode,
      persistProtectiveLiquidationExecutionProgress: () => {
        throw new Error('ordinary BUY cannot persist protection');
      },
      postTradeConsistencyRuntime: f.sink,
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isContinuousTradingAllowed: () => false,
      termination: f.termination,
    });
    monitor.onOrderStateChanged((e) => {
      closed.push(e.orderId);
    });

    try {
      await monitor.initialize();
      await monitor.recoverOrderTrackingFromSnapshot([]);
      monitor.trackOrder({
        orderId: 'closed-buy',
        symbol: 'BULL.HK',
        side: 'BUY',
        executionSide: 'BUY',
        orderType: 'LO',
        price: '1',
        initialSubmittedPrice: '1',
        quantity: 100,
        isLongSymbol: true,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
      });
      f.holds.trackOrder('closed-buy', 'BULL.HK');
      native.emitOrderChangedFrame(frame(10));
      await waitUntil(() => closed.length === 1);
      const list = f.recorder.getBuyOrdersForSymbol('BULL.HK', true);
      const before = { token: f.snapshot.getView().token, status: f.sink.getStatus(), admissions };
      native.emitOrderChangedFrame(frame(20));
      await waitUntil(() => f.recorder.getExecutionFact('closed-buy')?.updatedAtMs === T + 20);
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual(list);
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)[0]).toBe(list[0]);
      expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({
        costAmount: '100',
        quantity: 100,
      });

      // revision-only 修订只保存水位：金额/成本不变，known T 不推进，也不重复资源终态。
      expect(f.recorder.getExecutionFact('closed-buy')).toMatchObject({
        cumulativeAmount: '100',
        executionTimeMs: T + 10,
        updatedAtMs: T + 20,
        phase: 'TERMINAL',
      });
      expect(f.daily.getLossOffset('LONG')).toBe('0');
      expect(f.snapshot.getView().token).toEqual(before.token);
      expect(f.sink.getStatus()).toEqual(before.status);
      expect(closed).toEqual(['closed-buy']);
      expect(f.holds.getHoldSymbols()).toEqual(new Set());
      expect(admissions).toBe(before.admissions + 1);
      const admissionsBeforeConflict = admissions;
      native.emitOrderChangedFrame(frame(conflictingRevision, '1.1'));
      if (conflictingRevision === 20) {
        await f.termination.waitForTermination();
        const fatal = f.termination.getFatalState();
        expect(fatal.hasFatalError).toBe(true);
        if (!fatal.hasFatalError) throw new Error('same revision payload conflict was swallowed');

        expect(String(fatal.error)).toContain('同 revision');
      } else {
        await waitUntil(() => admissions > admissionsBeforeConflict);
        expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
      }

      // 旧 revision 金额修订不覆盖已存水位；真实修订必须由更高 revision 证明。
      expect(f.recorder.getExecutionFact('closed-buy')).toMatchObject({
        cumulativeAmount: '100',
        executionTimeMs: T + 10,
        updatedAtMs: T + 20,
      });
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual(list);
      expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)[0]).toBe(list[0]);
      expect(f.snapshot.getView().token).toEqual(before.token);
      expect(f.sink.getStatus()).toEqual(before.status);
      expect(closed).toEqual(['closed-buy']);
      if (conflictingRevision === 15) {
        native.emitOrderChangedFrame(frame(30, '1.1'));
        await waitUntil(() => f.recorder.getExecutionFact('closed-buy')?.updatedAtMs === T + 30);
        expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({
          costAmount: '110',
          quantity: 100,
        });

        // 合法金额修订更新经济与刷新水位，但 known T 仍为首次正成交时间，且不重复终态。
        expect(f.recorder.getExecutionFact('closed-buy')).toMatchObject({
          cumulativeAmount: '110',
          executionTimeMs: T + 10,
          updatedAtMs: T + 30,
        });

        expect(f.snapshot.getView().token.snapshotGeneration).toBe(
          before.token.snapshotGeneration + 1,
        );
        expect(f.sink.getStatus().staleVersion).toBe(before.status.staleVersion + 1);
        expect(closed).toEqual(['closed-buy']);
        expect(f.holds.getHoldSymbols()).toEqual(new Set());
      }
    } finally {
      await monitor.stopRuntimeAndDrain();
      await monitor.teardown();
      await f.sink.stopAndDrain();
    }
  });
