import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../../../src/infrastructure/externalApi/index.js';
import { wait } from '../../../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';

/** WebSocket乱序/重复：私SDK入站与实际Daily/O/H/S经济及资源owner。 */

import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import type { DailyLossCumulativeExecutionResult } from '../../../../src/types/risk.js';

import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../recorder/executionFixture.js';

describe('chaos: websocket out-of-order and duplicate pushes', () => {
  it('keeps sell fill side-effects idempotent under out-of-order/duplicate orderChanged events', async () => {
    let localSellCount = 0;
    let markSellFilledCount = 0;
    let markSellPartialCount = 0;
    const refreshNeeds: Array<{
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }> = [];
    const admissions: DailyLossCumulativeExecutionResult[] = [];
    const terminalSettlements = Promise.withResolvers<undefined>();
    const economic = createExecutionFixture({
      observeRefresh: (need) => {
        refreshNeeds.push({
          refreshAccount: need.refreshAccount,
          refreshPositions: need.refreshPositions,
        });
      },
      observeDaily: (owner) => ({
        ...owner,
        recordCumulativeExecution: (...args) => {
          const receipt = owner.recordCumulativeExecution(...args);
          admissions.push(receipt);
          return receipt;
        },
      }),
      observeRecorder: (owner) => ({
        ...owner,
        commitExecutionFact: (...args) => {
          const fact = args[0];
          const previous = owner.getSellRecordByOrderId(fact.brokerOrderId);
          owner.commitExecutionFact(...args);
          // 提交回执已收敛为 void；卖单经济记录被真实替换才计一次经济投影。
          if (owner.getSellRecordByOrderId(fact.brokerOrderId) !== previous) localSellCount += 1;
        },
        markSellFilled: (...args) => {
          markSellFilledCount += 1;
          const result = owner.markSellFilled(...args);
          if (markSellFilledCount === 2) terminalSettlements.resolve();

          return result;
        },
        markSellPartialFilled: (...args) => {
          markSellPartialCount += 1;
          return owner.markSellPartialFilled(...args);
        },
      }),
    });
    const frame = (
      orderId: string,
      symbol: string,
      quantity: string,
      status: 'New' | 'Filled' | 'PartialFilled',
      revision: number,
    ) => ({
      orderId,
      symbol,
      stockName: symbol === 'BULL.HK' ? 'HSI RC' : 'HSI RP',
      remark: '',
      side: 'SELL' as const,
      orderType: 'ELO' as const,
      status,
      quantity: '100',
      executedQuantity: quantity,
      submittedPrice: '1',
      executedPrice: quantity === '0' ? '0' : '1',
      submittedAtMs: economic.now - 1000,
      executionTimeMs: quantity === '0' ? null : economic.now - 100,
      updatedAtMs: revision,
    });
    const native = await createBrokerIngressFixture(
      frame('WS-CHAOS-001', 'BULL.HK', '0', 'New', economic.now),
    );
    const monitor = native.createMonitor({
      diagnostics: createDiagnosticObserverDouble(),
      logger: createLoggerDouble(),
      wait: wait,
      requestExternalApi: wrapExternalApiRequest,
      scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
      now: () => new Date(economic.now),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      rateLimiter: economic.rateLimiter,
      cacheManager: { clearCache() {}, getPendingOrders: async () => [] },
      marketDataClient: createMarketDataClientDouble(),
      orderRecorder: economic.recorder,
      dailyLossTracker: economic.daily,
      orderHoldRegistry: economic.holds,
      persistProtectiveLiquidationExecutionProgress() {},
      protectiveLiquidationEpisodeTracker: economic.episode,
      postTradeConsistencyRuntime: economic.sink,
      tradingConfig: createTradingConfig(),
      symbolRegistry: createSymbolRegistryDouble(),
      isContinuousTradingAllowed: () => true,
      termination: economic.termination,
    });
    await monitor.initialize();
    await monitor.recoverOrderTrackingFromSnapshot([]);
    for (const [orderId, symbol, isLongSymbol] of [
      ['WS-CHAOS-001', 'BULL.HK', true],
      ['WS-CHAOS-002', 'BEAR.HK', false],
    ] as const) {
      const metadata = await createBrokerIngressFixture(
        frame(orderId, symbol, '0', 'New', economic.now),
      );
      const fact = metadata.queryObservation;
      economic.recorder.submitSellOrder(
        orderId,
        symbol,
        isLongSymbol ? 'LONG' : 'SHORT',
        fact.quantity,
        [],
        fact.submittedAt.getTime(),
      );

      monitor.trackOrder({
        orderId,
        symbol,
        side: fact.executionSide,
        executionSide: fact.executionSide,
        initialExecutionPhase: fact.executionPhase,
        initialStatus: fact.status,
        price: fact.price,
        initialSubmittedPrice: fact.price,
        quantity: fact.quantity,
        isLongSymbol,
        monitorSymbol: 'HSI.HK',
        isProtectiveLiquidation: false,
        orderType: fact.orderType,
      });
    }

    let dispatched = 0;
    for (const event of [
      frame('WS-CHAOS-001', 'BULL.HK', '100', 'Filled', economic.now),
      frame('WS-CHAOS-002', 'BEAR.HK', '100', 'Filled', economic.now),
      // Explicit older broker revision arrives late; it cannot replace a completed economic fact.
      frame('WS-CHAOS-002', 'BEAR.HK', '20', 'PartialFilled', economic.now - 200),
      frame('WS-CHAOS-001', 'BULL.HK', '100', 'Filled', economic.now + 1),
    ]) {
      native.emitOrderChangedFrame(event);
      dispatched += 1;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    await terminalSettlements.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(dispatched).toBe(4);
    expect(native.nativeReadCounts().detail).toBe(0);
    expect(localSellCount).toBe(2);
    expect(markSellFilledCount).toBe(2);
    expect(markSellPartialCount).toBe(0);
    expect(refreshNeeds).toEqual([
      { refreshAccount: true, refreshPositions: true },
      { refreshAccount: true, refreshPositions: true },
    ]);
    expect(monitor.getPendingSellOrders('BULL.HK')).toHaveLength(0);
    expect(monitor.getPendingSellOrders('BEAR.HK')).toHaveLength(0);
    expect(admissions.some((receipt) => receipt.admission === 'ADMITTED')).toBeTrue();
    expect(admissions).toEqual([
      { admission: 'ADMITTED', authoritativeFactChanged: true, executionAdvanced: true },
      { admission: 'ADMITTED', authoritativeFactChanged: true, executionAdvanced: true },
      // closed 后的更高 revision 仅推进水位，不重复资源/经济投影。
      { admission: 'ADMITTED', authoritativeFactChanged: true, executionAdvanced: false },
    ]);
    await monitor.teardown();
  });
});
