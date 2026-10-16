import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { nowMonotonicMs, wait } from '../../src/infrastructure/time/index.js';

/** 真实共享执行 → tracking/O/Daily/episode → settlement 隔离检查；仅 broker、行情、时钟及持久化 IO 为离线边界。 */

import { describe, expect, it } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createAccountService } from '../../src/application/accountQuery/index.js';
import { createOrderExecutor } from '../../src/application/orderExecution/index.js';
import { createRateLimiter } from '../../src/application/orderExecution/rateLimiter.js';
import { createOrderHoldRegistry } from '../../src/application/orderTracking/orderHoldRegistry.js';
import { createOrderMonitor } from '../../src/application/orderTracking/orderMonitor/index.js';
import { createOrderRecorder } from '../../src/application/orderTracking/recorder/index.js';
import { createPostTradeSettlementWorkflow } from '../../src/application/postTradeSettlement/index.js';
import type { SettlementProtectionCompletion } from '../../src/application/postTradeSettlement/types.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { orderEconomics } from '../../src/domain/order/orderEconomics.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../src/types/risk.js';
import { exactMultiply } from '../../src/utils/numeric/exact.js';
import { toHongKongTimeIso } from '../../src/utils/time/index.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
} from '../helpers/testDoubles.js';
import {
  createBrokerIngressFixture,
  type BrokerIngressInput,
} from '../infrastructure/longbridge/trade/brokerIngressFixture.js';

const T = Date.parse('2026-10-07T02:00:00Z');
const oldFrame: BrokerIngressInput = {
  orderId: 'OLD-PROTECTIVE',
  tradeId: 'OLD-EXECUTION',
  symbol: 'BULL.HK',
  stockName: 'HSI RC',
  remark: '|PL',
  side: 'SELL',
  status: 'New',
  orderType: 'ELO',
  quantity: '1500',
  executedQuantity: '0',
  submittedPrice: '0.9',
  executedPrice: '0',
  submittedAtMs: T,
  executionTimeMs: null,
  updatedAtMs: T,
};

/** 等待真实 ledger/limiter 入站链发布完整成交事实；让出 timer，超时或 fatal 必须暴露，禁止把空状态当隔离成功。 */
async function waitForExecutionFact(
  f: Awaited<ReturnType<typeof createHarness>>,
  frame: BrokerIngressInput,
): Promise<void> {
  const deadline = performance.now() + 2000;
  const expectedAmount = exactMultiply(frame.executedQuantity, frame.executedPrice);
  while (performance.now() < deadline) {
    if (f.fatal.length > 0) {
      throw new Error('真实订单入站失败', { cause: f.fatal[0] });
    }

    const fact = f.recorder.getExecutionFact(frame.orderId);
    if (
      fact !== null &&
      String(fact.cumulativeQuantity) === frame.executedQuantity &&
      fact.cumulativeAmount === expectedAmount &&
      fact.executionTimeMs === frame.executionTimeMs &&
      fact.updatedAtMs === frame.updatedAtMs &&
      fact.phase === (frame.status === 'Filled' ? 'TERMINAL' : 'OPEN')
    ) {
      return;
    }

    await delay(5);
  }

  throw new Error(`等待真实订单成交事实超时: ${frame.orderId}`);
}

async function createHarness(
  params: { readonly protective?: boolean; readonly triggerLimit?: number } = {},
) {
  const frame = { ...oldFrame, remark: params.protective === false ? '' : '|PL' };
  const native = await createBrokerIngressFixture(frame, orderEconomics);
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000',
    netAssets: '10000',
    availableCash: '10000',
  });
  const limiter = createRateLimiter({
    wait: wait,
    nowMonotonicMs: nowMonotonicMs,
    logger: createLoggerDouble(),
  });
  let clock = T;
  const trace: string[] = [];
  const fatal: unknown[] = [];
  const progress: ProtectiveLiquidationExecutionProgressInput[] = [];
  const completions: SettlementProtectionCompletion[] = [];
  const account = createAccountService({
    accountReadPort: native.ports.createAccountReadPort(),
    rateLimiter: limiter,
  });
  const snapshot = createAccountPositionSnapshot({
    dayEpoch: 1,
    readPort: account,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      fatal.push(error);
    },
  });
  const episodes = createProtectiveLiquidationEpisodeTracker();
  const daily = createDailyLossTracker({
    ...orderAnalysis,
    toHongKongTimeIso,
    onOwnershipWarning: () => {},
  });
  daily.resetAll(new Date(T));
  const base = createTradingConfig();
  const registry = createSymbolRegistry(base.monitor);
  const tradingConfig = {
    ...base,
    global: {
      ...base.global,
      tradingOrderType: 'ELO' as const,
      liquidationOrderType: 'ELO' as const,
    },
    monitor: {
      ...base.monitor,
      orderOwnershipMapping: ['HSI'],
      liquidationTriggerLimit: params.triggerLimit ?? 1,
      liquidationCooldown: { mode: 'minutes' as const, minutes: 5 },
    },
  };
  let monitor: ReturnType<typeof createOrderMonitor> | null = null;
  const settlement = createPostTradeSettlementWorkflow({
    snapshot,
    hasPendingProtectiveOrders: (direction) => {
      if (monitor === null) throw new Error('tracking not assembled');

      return monitor.hasPendingProtectiveLiquidationOrders(direction);
    },
    onPositionsCommitted: async () => {
      trace.push('positions-committed');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
    termination: {
      isTerminated: () => fatal.length > 0,
      reportFatalError: (error) => {
        fatal.push(error);
      },
    },
    logger: createLoggerDouble(),
    retryDelayMs: 1000,
    isExternalFailure: () => false,
  });
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: native.ports.createOrderSnapshotReadPort({
      rateLimiter: limiter,
      executionLedgerPort: native.executionLedgerPort,
    }),
    getExecutionTimeEvidence: daily.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: settlement,
  });
  const cooldown = createLiquidationCooldownTracker();
  const risk = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
    onMissingData: () => {},
  });
  settlement.bindBusinessDeps({
    monitorSymbol: 'HSI.HK',
    seats: registry,
    episodes: {
      ...episodes,
      commitCompletion: (prepared) => {
        trace.push('episode');
        episodes.commitCompletion(prepared);
      },
    },
    completionPersistence: {
      appendCompletionIdempotent: (completion) => {
        trace.push('completion');
        completions.push(completion);
      },
    },
    lossBoundaries: {
      getLossOffset: daily.getLossOffset,
      prepareProtectionBoundary: daily.prepareProtectionBoundary,
      commitProtectionBoundary: (prepared) => {
        trace.push('boundary');
        daily.commitProtectionBoundary(prepared);
      },
    },
    cooldownTriggers: {
      recordLiquidationTrigger: (input) => {
        trace.push('cooldown');
        cooldown.recordLiquidationTrigger({
          ...input,
          triggerLimit: tradingConfig.monitor.liquidationTriggerLimit,
          cooldownConfig: tradingConfig.monitor.liquidationCooldown,
        });
      },
    },
    riskProjection: {
      prepare: (symbol, direction, offset) =>
        risk.prepare(recorder, symbol, direction === 'LONG', offset),
      publish: risk.publish,
    },
  });
  const tracking = createOrderMonitor({
    wait: wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
    logger: createLoggerDouble(),
    orderDetailReadPort: native.ports.createOrderDetailReadPort(),
    executionLedgerPort: native.executionLedgerPort,
    orderPushPort: native.ports.createOrderPushPort(),
    tradeMutationPort: native.ports.createTradeMutationPort(),
    rateLimiter: limiter,
    cacheManager: { clearCache() {}, getPendingOrders: async () => [] },
    marketDataClient: createMarketDataClientDouble(),
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: createOrderHoldRegistry(),
    protectiveLiquidationEpisodeTracker: episodes,
    persistProtectiveLiquidationExecutionProgress: (input) => {
      trace.push('progress');
      progress.push(input);
    },
    postTradeConsistencyRuntime: settlement,
    tradingConfig,
    symbolRegistry: registry,
    isContinuousTradingAllowed: () => false,
    now: () => new Date(clock),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
    termination: {
      isTerminated: () => fatal.length > 0,
      reportFatalError: (error) => {
        fatal.push(error);
      },
    },
  });
  monitor = tracking;
  await tracking.initialize();
  await tracking.recoverOrderTrackingFromSnapshot([native.queryObservation]);
  const cancelOutcomes: Awaited<ReturnType<typeof tracking.cancelOrder>>[] = [];
  const executor = createOrderExecutor({
    logger: createLoggerDouble(),
    readSellPositions: native.ports.createSellPositionReader(),
    tradeMutationPort: native.ports.createTradeMutationPort(),
    rateLimiter: limiter,
    cacheManager: { clearCache() {} },
    orderMonitor: {
      ...tracking,
      cancelOrder: async (...args) => {
        const outcome = await tracking.cancelOrder(...args);
        cancelOutcomes.push(outcome);
        return outcome;
      },
    },
    orderRecorder: recorder,
    unrealizedLossBuyGate: {
      checkUnrealizedLoss: () => {
        throw new Error('SELL cannot invoke BUY loss gate');
      },
    },
    tradingConfig,
    symbolRegistry: registry,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.9', 100)]]),
    }),
    isExecutionAllowed: () => fatal.length === 0,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(clock),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-10-07',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  function positions(quantity: number, availableQuantity: number) {
    native.setStockPositions(
      quantity === 0
        ? []
        : [
            {
              symbol: 'BULL.HK',
              symbolName: 'HSI RC',
              accountChannel: 'HK',
              currency: 'HKD',
              quantity: String(quantity),
              availableQuantity: String(availableQuantity),
              costPrice: '1',
            },
          ],
    );
  }
  positions(2500, 1000);
  const signal = {
    ...createSignal({ symbol: 'BULL.HK', action: 'SELLCALL', triggerTimeMs: T }),
    quantity: 1000,
    isProtectiveLiquidation: false as const,
    orderTypeOverride: 'ELO' as const,
  };
  return {
    native,
    executor,
    cancelOutcomes,
    signal,
    tracking,
    recorder,
    daily,
    episodes,
    progress,
    completions,
    trace,
    fatal,
    settlement,
    cooldown,
    positions,
    advance: (value: number) => {
      clock = value;
    },
    close: async () => {
      await tracking.stopRuntimeAndDrain();
      await tracking.teardown();
      await settlement.stopAndDrain();
    },
  };
}

function ledger(frame: BrokerIngressInput) {
  return {
    orderId: frame.orderId,
    tradeId: frame.tradeId,
    symbol: frame.symbol,
    quantity: frame.executedQuantity,
    price: frame.executedPrice,
    tradeDoneAtMs: frame.executionTimeMs ?? T,
  };
}

async function fillNewOrder(f: Awaited<ReturnType<typeof createHarness>>, quantity: number) {
  const observation = f.native.nativeSubmitObservations()[0];
  if (observation === undefined) throw new Error('new native order missing');

  const newFrame: BrokerIngressInput = {
    ...oldFrame,
    orderId: 'NEW-NON-PROTECTIVE',
    tradeId: 'NEW-EXECUTION',
    remark: observation.remark ?? '',
    status: 'Filled',
    quantity: String(quantity),
    executedQuantity: String(quantity),
    executedPrice: '0.9',
    submittedAtMs: T + 3000,
    executionTimeMs: T + 4000,
    updatedAtMs: T + 4010,
  };
  f.native.setExecutionReplies([ledger(newFrame)]);
  f.positions(0, 0);
  f.advance(T + 5000);
  f.native.emitOrderChangedFrame(newFrame);
  await waitForExecutionFact(f, newFrame);
  expect(f.recorder.getExecutionFact(newFrame.orderId)).toMatchObject({
    phase: 'TERMINAL',
    cumulativeQuantity: quantity,
    cumulativeAmount: exactMultiply(String(quantity), '0.9'),
    executionTimeMs: T + 4000,
    updatedAtMs: T + 4010,
  });
  expect(f.tracking.getPendingSellOrders('BULL.HK')).toEqual([]);
  expect(f.fatal).toEqual([]);
}

describe('real shared sell protective isolation', () => {
  it('恢复的零成交 protective ELO 原身份进入真实 pending view，可信取消后新单成交不创建 episode', async () => {
    const f = await createHarness();
    try {
      expect(f.tracking.getPendingSellOrders('BULL.HK')).toMatchObject([
        { isProtectiveLiquidation: true },
      ]);
      expect(f.episodes.getInProgressEpisodes()).toEqual([]);
      f.native.setCancelFailure(Object.assign(new Error('closed'), { code: '601012' }));
      f.native.setOrderDetailReplies([{ ...oldFrame, status: 'Canceled', updatedAtMs: T + 2000 }]);
      f.native.setCancelBeforeReply(async () => {
        f.positions(2500, 2500);
      });
      f.native.setSubmitBehavior(async () => 'NEW-NON-PROTECTIVE');
      const beforeReads = f.native.accountReadCounts().positions;
      expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
        executedOrderIds: ['NEW-NON-PROTECTIVE'],
        quoteFailures: [],
      });
      expect(f.native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toEqual([]);
      expect(f.native.accountReadCounts().positions - beforeReads).toBe(2);
      expect(f.native.nativeSubmitObservations()).toMatchObject([
        { quantity: '2500', orderType: 'ELO' },
      ]);
      expect(f.native.nativeSubmitObservations()[0]?.remark).not.toEndWith('|PL');
      await fillNewOrder(f, 2500);
      expect(f.progress).toEqual([]);
      expect(f.episodes.getInProgressEpisodes()).toEqual([]);
      f.settlement.start();
      await f.settlement.waitForFresh();
      expect(f.completions).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('旧1500/partial500实绩原样保留；新单卖空后旧episode仅由settlement按旧执行时间完成一次', async () => {
    const f = await createHarness({ triggerLimit: 2 });
    try {
      const partial: BrokerIngressInput = {
        ...oldFrame,
        status: 'PartialFilled',
        executedQuantity: '500',
        executedPrice: '0.9',
        executionTimeMs: T + 1000,
        updatedAtMs: T + 1010,
      };
      f.native.setExecutionReplies([ledger(partial)]);
      f.native.emitOrderChangedFrame(partial);
      await waitForExecutionFact(f, partial);
      expect(f.fatal).toEqual([]);
      expect(f.progress).toEqual([
        {
          monitorSymbol: 'HSI.HK',
          direction: 'LONG',
          symbol: 'BULL.HK',
          orderId: 'OLD-PROTECTIVE',
          factStage: 'OPEN',
          cumulativeQuantity: '500',
          cumulativeAmount: '450',
          lastExecutionTimeMs: T + 1000,
          orderRevisionMs: T + 1010,
        },
      ]);
      f.positions(2000, 1000);
      f.native.setCancelFailure(Object.assign(new Error('closed'), { code: '601012' }));
      f.native.setOrderDetailReplies([{ ...partial, status: 'Canceled', updatedAtMs: T + 2000 }]);
      f.native.setCancelBeforeReply(async () => {
        f.positions(2000, 2000);
      });
      f.native.setSubmitBehavior(async () => 'NEW-NON-PROTECTIVE');
      expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
        executedOrderIds: ['NEW-NON-PROTECTIVE'],
        quoteFailures: [],
      });
      expect(f.native.nativeMutations().filter((m) => m.kind === 'REPLACE')).toEqual([]);
      expect(f.native.nativeSubmitObservations()).toMatchObject([{ quantity: '2000' }]);
      const oldProgress = [...f.progress];
      await fillNewOrder(f, 2000);
      expect(f.progress).toEqual(oldProgress);
      expect(f.recorder.getExecutionFact('OLD-PROTECTIVE')?.cumulativeQuantity).toBe(500);
      expect(f.recorder.getExecutionFact('NEW-NON-PROTECTIVE')?.cumulativeQuantity).toBe(2000);
      expect(f.episodes.getInProgressEpisodes()).toMatchObject([
        { latestExecutedTimeMs: T + 1000 },
      ]);
      f.settlement.start();
      await f.settlement.waitForFresh();
      expect(f.completions).toMatchObject([{ boundaryExecutedTimeMs: T + 1000 }]);
      expect(
        f.trace.filter((entry) =>
          ['completion', 'boundary', 'cooldown', 'episode'].includes(entry),
        ),
      ).toEqual(['completion', 'boundary', 'cooldown', 'episode']);
      expect(f.episodes.getInProgressEpisodes()).toEqual([]);
      await f.settlement.waitForFresh();
      expect(f.completions).toHaveLength(1);
      expect(
        f.cooldown.getRemainingMs({
          direction: 'LONG',
          cooldownConfig: { mode: 'minutes', minutes: 5 },
          currentTimeMs: T + 5000,
        }),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('仅cancel ACK不得提前新提交，旧身份与后续真实progress仍有效', async () => {
    const f = await createHarness();
    try {
      f.native.setCancelBeforeReply(async () => {});
      const beforeCancel = f.native.nativeReadCounts();
      expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
        executedOrderIds: [],
        quoteFailures: [],
      });
      expect(f.cancelOutcomes).toEqual([{ kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null }]);
      expect(f.native.nativeReadCounts()).toEqual({
        cancel: beforeCancel.cancel + 1,
        detail: beforeCancel.detail,
      });
      expect(f.native.nativeCancelOrderIds()).toEqual(['OLD-PROTECTIVE']);
      expect(f.native.nativeMutations()).toEqual([]);
      expect(f.tracking.getPendingSellOrders('BULL.HK')).toMatchObject([
        { isProtectiveLiquidation: true },
      ]);
      const partial: BrokerIngressInput = {
        ...oldFrame,
        status: 'PartialFilled',
        executedQuantity: '500',
        executedPrice: '0.9',
        executionTimeMs: T + 1000,
        updatedAtMs: T + 1010,
      };
      f.native.setExecutionReplies([ledger(partial)]);
      f.native.emitOrderChangedFrame(partial);
      await waitForExecutionFact(f, partial);
      expect(f.progress).toEqual([
        {
          monitorSymbol: 'HSI.HK',
          direction: 'LONG',
          symbol: 'BULL.HK',
          orderId: 'OLD-PROTECTIVE',
          factStage: 'OPEN',
          cumulativeQuantity: '500',
          cumulativeAmount: '450',
          lastExecutionTimeMs: T + 1000,
          orderRevisionMs: T + 1010,
        },
      ]);
      expect(f.fatal).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
