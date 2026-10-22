import { createDiagnosticObserverDouble } from '../../../helpers/diagnostics.js';

/**
 * settlementFlow 业务测试：保留原20项终态、durable失败、归属与资源 oracle。
 * 使用真实 recorder/DailyLoss 的同步准入，不以 LOCAL 或空 callback mock 代替经济事实。
 */

import { describe, expect, it } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import { createSettlementFlow } from '../../../../src/application/orderTracking/orderMonitor/settlementFlow.js';
import type {
  FinalizeOrderSettlementParams,
  OrderMonitorRuntimeStore,
} from '../../../../src/application/orderTracking/orderMonitor/types.js';
import type { OrderHoldRegistry } from '../../../../src/application/orderTracking/types.js';
import { createSettlementReadinessGate } from '../../../../src/application/postTradeSettlement/readinessGate.js';
import { orderAnalysis } from '../../../../src/domain/order/orderAnalysis.js';
import type { OrderMonitorTrackedOrder } from '../../../../src/domain/order/types.js';
import { createDailyLossTracker } from '../../../../src/domain/risk/dailyLossTracker.js';
import type { BrokerOrderExecutionFact } from '../../../../src/types/orderRecorder.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../../../src/types/risk.js';
import type { OrderStateChangedEvent } from '../../../../src/types/orderTracking.js';
import { toHongKongTimeIso } from '../../../../src/utils/time/index.js';
import {
  createAccountSnapshotDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from '../../../helpers/testDoubles.js';
import { createSettlementRecorder } from './settlementFlow.testFactory.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../../../src/domain/liquidation/episode/index.js';

const PROTECTIVE_EXECUTION_TIME_MS = Date.parse('2026-02-25T03:11:00.000Z');

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceTerminalByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
}

function createOrderHoldRegistry(): OrderHoldRegistry {
  return {
    trackOrder: () => {},
    markOrderClosed: () => {},
    seedFromOrders: () => {},
    getHoldSymbols: () => new Set(),
    onOrderHoldSymbolsChanged: () => () => {},
    clear: () => {},
  };
}

function createTrackedProtectiveSell(orderId: string): OrderMonitorTrackedOrder {
  return {
    orderId,
    symbol: 'BULL.HK',
    side: 'SELL',
    executionSide: 'SELL',
    executionPhase: 'OPEN',
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
    orderType: 'ELO',
    submittedPrice: '1',
    initialSubmittedPrice: '1',
    submittedQuantity: 100,
    executedQuantity: 0,
    executedPrice: null,
    executedAmount: '0',
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
    status: 'WORKING',
    submittedAt: PROTECTIVE_EXECUTION_TIME_MS - 60000,
    lastPriceUpdateAt: PROTECTIVE_EXECUTION_TIME_MS - 60000,
    convertedToMarket: false,
    nextCancelAttemptAt: PROTECTIVE_EXECUTION_TIME_MS - 60000,
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    timeoutMarketConversionPending: false,
    timeoutMarketConversionTerminalState: null,
  };
}

function terminalParams(
  orderId: string,
  overrides: Partial<FinalizeOrderSettlementParams> = {},
): FinalizeOrderSettlementParams {
  return {
    orderId,
    closedReason: 'FILLED',
    source: 'WS',
    symbol: 'BULL.HK',
    side: 'SELL',
    monitorSymbol: 'HSI.HK',
    isLongSymbol: true,
    isProtectiveLiquidation: true,
    executedPrice: '1.02',
    executedQuantity: 100,
    executedAmount: '102',
    executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
    orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
    ...overrides,
  };
}

/** 真实经济 owner 与可观察资源：只有真实 commit 后才记录经济通知，durable抛错不留下虚假成功调用。 */
function createHarness(failPersistence = false) {
  const runtime = createRuntime();
  const commits: Array<{
    readonly fact: BrokerOrderExecutionFact;
    readonly relatedBuyOrderIds: ReadonlyArray<string>;
  }> = [];
  const refreshNeeds: Array<{
    readonly refreshAccount: boolean;
    readonly refreshPositions: boolean;
  }> = [];
  const resourceCalls: string[] = [],
    holdClosed: string[] = [];
  const persisted: ProtectiveLiquidationExecutionProgressInput[] = [];
  const episodes: Array<{
    readonly direction: 'LONG' | 'SHORT';
    readonly symbol: string;
    readonly executedTimeMs: number;
  }> = [];
  const events: OrderStateChangedEvent[] = [];
  const followUps: Array<{
    readonly orderId: string;
    readonly quantity: number;
    readonly relatedBuyOrderIds: ReadonlyArray<string>;
    readonly submittedAtMs: number;
  }> = [];
  const persistenceError = new Error('protective progress persistence failed');
  let shouldThrowOnPersist = failPersistence;
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(new Date(PROTECTIVE_EXECUTION_TIME_MS));
  const sink = {
    recordSettlementRefreshNeed: (need: {
      readonly refreshAccount: boolean;
      readonly refreshPositions: boolean;
    }) => {
      refreshNeeds.push(need);
    },
  };
  const owner = createSettlementRecorder(sink, {}, (fact, relatedBuyOrderIds) => {
    commits.push({ fact, relatedBuyOrderIds });
  });
  const recorder = {
    ...owner,
    markSellFilled: (orderId: string) => {
      resourceCalls.push('markSellFilled');
      return owner.markSellFilled(orderId);
    },
    markSellCancelled: (orderId: string) => {
      resourceCalls.push('markSellCancelled');
      return owner.markSellCancelled(orderId);
    },
    submitSellOrder: (...args: Parameters<typeof owner.submitSellOrder>) => {
      const [orderId, _symbol, _direction, quantity, relatedBuyOrderIds, submittedAtMs] = args;
      followUps.push({ orderId, quantity, relatedBuyOrderIds, submittedAtMs });
      owner.submitSellOrder(...args);
    },
  };
  const flow = createSettlementFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    runtime,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: {
      ...createOrderHoldRegistry(),
      markOrderClosed: (orderId) => {
        holdClosed.push(orderId);
      },
    },
    persistProtectiveLiquidationExecutionProgress: (progress) => {
      persisted.push(progress);
      if (shouldThrowOnPersist) throw persistenceError;
    },
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble({
      recordProtectiveFillProgress: (progress) => {
        episodes.push(progress);
      },
    }),
    postTradeConsistencyRuntime: sink,
    emitOrderStateChanged: (event) => {
      events.push(event);
    },
  });
  function trackProtective(orderId: string): void {
    runtime.trackedOrders.set(orderId, createTrackedProtectiveSell(orderId));
    owner.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      100,
      [],
      PROTECTIVE_EXECUTION_TIME_MS - 60000,
    );
  }
  return {
    runtime,
    recorder,
    owner,
    flow,
    daily,
    commits,
    refreshNeeds,
    resourceCalls,
    persisted,
    episodes,
    holdClosed,
    events,
    followUps,
    trackProtective,
    persistenceError,
    allowPersistence: () => {
      shouldThrowOnPersist = false;
    },
  };
}

function assertNoCommittedEffects(
  harness: ReturnType<typeof createHarness>,
  orderId: string,
): void {
  expect(harness.commits).toEqual([]);
  expect(harness.daily.getLossOffset('LONG')).toBe('0');
  expect(harness.recorder.getExecutionFact(orderId)).toBeNull();
  expect(harness.recorder.getSellRecordByOrderId(orderId)).toBeNull();
  expect(harness.resourceCalls).toEqual([]);
  expect(harness.episodes).toEqual([]);
  expect(harness.refreshNeeds).toEqual([]);
  expect(harness.holdClosed).toEqual([]);
  expect(harness.events).toEqual([]);
  expect(harness.runtime.closedOrderIds.has(orderId)).toBe(false);
}

describe('settlementFlow business flow', () => {
  for (const source of ['WS', 'STATE_CHECK'] as const) {
    for (const closedReason of ['FILLED', 'CANCELED', 'REJECTED'] as const) {
      it(`保护性 SELL 正累计成交缺少执行时间时，${source} ${closedReason} 在公共结算入口零副作用失败`, () => {
        const orderId = `PROTECTIVE-MISSING-TIME-${source}-${closedReason}`,
          harness = createHarness();
        harness.trackProtective(orderId);
        const pending = harness.recorder.getPendingSellSnapshot();
        expect(() =>
          harness.flow.settleOrder(
            terminalParams(orderId, {
              source,
              closedReason,
              executedQuantity: 40,
              executedAmount: '40.8',
              executedTimeMs: null,
            }),
          ),
        ).toThrow('[订单监控] 正成交原始价格/金额/归属/执行时间不完整');
        assertNoCommittedEffects(harness, orderId);
        expect(harness.persisted).toEqual([]);
        expect(harness.recorder.getPendingSellSnapshot()).toEqual(pending);
        expect(harness.runtime.trackedOrders.has(orderId)).toBe(true);
      });
    }
  }

  it.each(['FILLED', 'CANCELED', 'REJECTED'] as const)(
    '保护性 SELL %s 的执行时间晚于 revision 仍按真实成交时间结算',
    (closedReason) => {
      const orderId = `PROTECTIVE-LATE-EXECUTION-${closedReason}`,
        harness = createHarness(),
        executedTimeMs = PROTECTIVE_EXECUTION_TIME_MS + 1;
      harness.trackProtective(orderId);
      expect(() =>
        harness.flow.settleOrder(terminalParams(orderId, { closedReason, executedTimeMs })),
      ).not.toThrow();
      expect(harness.commits).toHaveLength(1);
      expect(harness.commits[0]?.fact).toMatchObject({
        brokerOrderId: orderId,
        executionTimeMs: executedTimeMs,
        updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
      });
    },
  );

  it('保护性 SELL timeout prepare 的执行时间晚于 revision 时仍使用真实成交时间', () => {
    const orderId = 'PROTECTIVE-TIMEOUT-PREPARE-LATE-EXECUTION',
      harness = createHarness(),
      executedTimeMs = PROTECTIVE_EXECUTION_TIME_MS + 1;
    harness.trackProtective(orderId);
    const result = harness.flow.prepareProtectiveTerminalExecution(
      terminalParams(orderId, { closedReason: 'CANCELED', executedTimeMs }),
    );
    expect(result).not.toBeNull();
    expect(harness.commits[0]?.fact.executionTimeMs).toBe(executedTimeMs);
  });

  it('protective FILLED persists durable progress before any local settlement and retries the uncommitted fact', () => {
    const orderId = 'PROTECTIVE-FILLED-PERSIST-FAIL',
      harness = createHarness(true);
    harness.trackProtective(orderId);
    expect(() => harness.flow.settleOrder(terminalParams(orderId))).toThrow(
      harness.persistenceError,
    );
    assertNoCommittedEffects(harness, orderId);
    expect(harness.runtime.trackedOrders.has(orderId)).toBe(true);
    expect(harness.recorder.getPendingSellSnapshot()).toHaveLength(1);
    harness.allowPersistence();
    harness.flow.settleOrder(terminalParams(orderId));
    expect(harness.persisted.map((item) => item.orderId)).toEqual([orderId, orderId]);
    expect(harness.commits).toEqual([
      {
        fact: {
          brokerOrderId: orderId,
          symbol: 'BULL.HK',
          side: 'SELL',
          phase: 'TERMINAL',
          cumulativeQuantity: 100,
          cumulativeAmount: '102',
          executionTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
          updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
        },
        relatedBuyOrderIds: [],
      },
    ]);
    expect(harness.resourceCalls).toEqual(['markSellFilled']);
    expect(harness.refreshNeeds).toHaveLength(1);
    expect(harness.holdClosed).toEqual([orderId]);
    expect(harness.events).toHaveLength(1);
    expect(harness.episodes).toHaveLength(1);
    expect(harness.recorder.getPendingSellSnapshot()).toEqual([]);
    harness.flow.settleOrder(terminalParams(orderId));
    expect(harness.persisted).toHaveLength(2);
    expect(harness.commits).toHaveLength(1);
    expect(harness.refreshNeeds).toHaveLength(1);
    expect(harness.episodes).toHaveLength(1);
  });

  it('protective partially-filled CANCELED persists durable progress before releasing pending sell occupancy', () => {
    const orderId = 'PROTECTIVE-CANCELED-PARTIAL-PERSIST-FAIL',
      harness = createHarness(true);
    harness.trackProtective(orderId);
    const params = terminalParams(orderId, {
      closedReason: 'CANCELED',
      executedQuantity: 40,
      executedAmount: '40.8',
    });
    const pending = harness.recorder.getPendingSellSnapshot();
    expect(() => harness.flow.settleOrder(params)).toThrow(harness.persistenceError);
    assertNoCommittedEffects(harness, orderId);
    expect(harness.recorder.getPendingSellSnapshot()).toEqual(pending);
    expect(harness.runtime.trackedOrders.has(orderId)).toBe(true);
    harness.allowPersistence();
    harness.flow.settleOrder(params);
    expect(harness.persisted.map((item) => item.orderId)).toEqual([orderId, orderId]);
    expect(harness.commits).toHaveLength(1);
    expect(harness.recorder.getExecutionFact(orderId)).toMatchObject({
      brokerOrderId: orderId,
      cumulativeQuantity: 40,
      cumulativeAmount: '40.8',
      phase: 'TERMINAL',
    });
    expect(harness.resourceCalls).toEqual(['markSellCancelled']);
    expect(harness.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(harness.refreshNeeds).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
  });

  it('settles FILLED buy order once and records a post-trade refresh need plus order state event without closeSync runtime state', () => {
    const harness = createHarness(),
      orderId = 'BUY-SETTLEMENT-IDEMPOTENT';
    const params = terminalParams(orderId, { side: 'BUY', isProtectiveLiquidation: false });
    // Daily 已有真实成交证据而 O 尚无经济覆盖，DUPLICATE 准入仍允许首次 terminal 投影。
    expect(
      harness.daily.recordCumulativeExecution({
        orderId,
        factStage: 'TERMINAL',
        direction: 'LONG',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '1.02',
        executedQuantity: 100,
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
        orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
      }).admission,
    ).toBe('ADMITTED');
    const settled = harness.flow.settleOrder(params),
      duplicate = harness.flow.settleOrder(params);
    expect(settled.handled).toBe(true);
    expect(duplicate.handled).toBe(false);
    expect(harness.commits).toHaveLength(1);
    expect(harness.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '102',
      quantity: 100,
    });

    expect(harness.refreshNeeds).toEqual([{ refreshAccount: true, refreshPositions: true }]);
    expect(harness.events).toEqual([
      {
        orderId,
        symbol: 'BULL.HK',
        side: 'BUY',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: '1.02',
        executedQuantity: 100,
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
      },
    ]);
    expect(harness.holdClosed).toEqual([orderId]);
    expect(harness.runtime.closedOrderIds.has(orderId)).toBe(true);
    expect('closeSyncQueue' in harness.runtime).toBe(false);
    // 资源已关闭不挡合法金额修订；只刷新经济，不再次关闭资源或发送终态事件。
    harness.flow.settleOrder({
      ...params,
      executedPrice: '1.03',
      executedAmount: '103',
      orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS + 30000,
    });

    expect(harness.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '103',
      quantity: 100,
    });
    expect(harness.refreshNeeds).toHaveLength(2);
    expect(harness.events).toHaveLength(1);
    expect(harness.holdClosed).toEqual([orderId]);
  });

  it('settles partially-filled canceled sell with recovered quantity and records a post-trade refresh need', () => {
    const harness = createHarness(),
      orderId = 'SELL-PARTIAL-FALLBACK';
    harness.recorder.commitExecutionFact(
      {
        brokerOrderId: 'BUY-A',
        symbol: 'BULL.HK',
        side: 'BUY',
        phase: 'TERMINAL',
        cumulativeQuantity: 70,
        cumulativeAmount: '70',
        executionTimeMs: PROTECTIVE_EXECUTION_TIME_MS - 660000,
        updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS - 660000,
      },
      true,
      [],
      () => 'ADMITTED',
    );

    harness.recorder.commitExecutionFact(
      {
        brokerOrderId: 'BUY-B',
        symbol: 'BULL.HK',
        side: 'BUY',
        phase: 'TERMINAL',
        cumulativeQuantity: 70,
        cumulativeAmount: '84',
        executionTimeMs: PROTECTIVE_EXECUTION_TIME_MS - 360000,
        updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS - 360000,
      },
      true,
      [],
      () => 'ADMITTED',
    );

    harness.owner.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      140,
      ['BUY-A', 'BUY-B'],
      PROTECTIVE_EXECUTION_TIME_MS - 120000,
    );
    harness.commits.length = 0;
    harness.refreshNeeds.length = 0;
    const result = harness.flow.settleOrder(
      terminalParams(orderId, {
        closedReason: 'CANCELED',
        isProtectiveLiquidation: false,
        executedPrice: '1.05',
        executedAmount: '105',
      }),
    );
    expect(result.handled).toBe(true);
    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0]?.relatedBuyOrderIds).toEqual([]);
    expect(
      harness.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId),
    ).toEqual(['BUY-B']);

    expect(harness.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '84',
      quantity: 70,
    });

    expect(harness.recorder.getExecutionFact(orderId)).toMatchObject({
      cumulativeQuantity: 100,
      cumulativeAmount: '105',
      phase: 'TERMINAL',
    });
    expect(harness.refreshNeeds).toEqual([{ refreshAccount: true, refreshPositions: true }]);
    expect(harness.resourceCalls).toEqual(['markSellCancelled']);
    expect(harness.events).toEqual([
      {
        orderId,
        symbol: 'BULL.HK',
        side: 'SELL',
        status: 'CANCELED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedPrice: '1.05',
        executedQuantity: 100,
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
      },
    ]);
    // 原 oracle 保留：累计100不精确覆盖关联70+70，不能将 survivor 冒充可精确归属的 terminal result。
    expect(result.relatedBuyOrderIds).toBeNull();
  });

  it('保留 timeout->market follow-up 占用时会在旧 orderId 下重建连续 placeholder', () => {
    const harness = createHarness(),
      orderId = 'SELL-HANDOFF-PLACEHOLDER';
    harness.recorder.commitExecutionFact(
      {
        brokerOrderId: 'BUY-A',
        symbol: 'BULL.HK',
        side: 'BUY',
        phase: 'TERMINAL',
        cumulativeQuantity: 100,
        cumulativeAmount: '100',
        executionTimeMs: PROTECTIVE_EXECUTION_TIME_MS - 660000,
        updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS - 660000,
      },
      true,
      [],
      () => 'ADMITTED',
    );

    harness.recorder.commitExecutionFact(
      {
        brokerOrderId: 'BUY-B',
        symbol: 'BULL.HK',
        side: 'BUY',
        phase: 'TERMINAL',
        cumulativeQuantity: 100,
        cumulativeAmount: '110',
        executionTimeMs: PROTECTIVE_EXECUTION_TIME_MS - 360000,
        updatedAtMs: PROTECTIVE_EXECUTION_TIME_MS - 360000,
      },
      true,
      [],
      () => 'ADMITTED',
    );

    harness.runtime.trackedOrders.set(orderId, {
      ...createTrackedProtectiveSell(orderId),
      isProtectiveLiquidation: false,
      submittedQuantity: 200,
    });

    harness.owner.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      200,
      ['BUY-A', 'BUY-B'],
      PROTECTIVE_EXECUTION_TIME_MS - 60000,
    );
    const pending = harness.recorder.getPendingSellSnapshot();
    const params = terminalParams(orderId, {
      closedReason: 'CANCELED',
      isProtectiveLiquidation: false,
      executedPrice: null,
      executedQuantity: null,
      executedAmount: '0',
      executedTimeMs: null,
      pendingSellDisposition: { kind: 'HANDOFF_TO_FOLLOW_UP_SELL', followUpQuantity: 200 },
    });
    expect(() => harness.flow.settleOrder(params)).toThrow(/terminal 累计数量无效/);
    expect(harness.followUps).toEqual([]);
    expect(harness.recorder.getPendingSellSnapshot()).toEqual(pending);
    expect(harness.runtime.closedOrderIds.has(orderId)).toBe(false);
    // 只有真实确认的累计零成交才能释放/接续；未知 null 不被 fixture 或生产 fallback 洗成零。
    const result = harness.flow.settleOrder({ ...params, executedQuantity: 0 });
    expect(result.handled).toBe(true);
    expect(result.relatedBuyOrderIds).toEqual(['BUY-A', 'BUY-B']);
    expect(harness.followUps).toEqual([
      {
        orderId,
        quantity: 200,
        relatedBuyOrderIds: ['BUY-A', 'BUY-B'],
        submittedAtMs: PROTECTIVE_EXECUTION_TIME_MS - 60000,
      },
    ]);

    expect(harness.recorder.getPendingSellSnapshot()).toMatchObject([
      { orderId, submittedQuantity: 200, relatedBuyOrderIds: ['BUY-A', 'BUY-B'] },
    ]);
  });

  it('fails fast when executed close lacks attribution context', () => {
    const harness = createHarness(),
      orderId = 'BUY-PARTIAL-MISSING-ATTR';
    expect(() =>
      harness.flow.settleOrder({
        orderId,
        closedReason: 'CANCELED',
        source: 'RECOVERY',
        symbol: 'BULL.HK',
        side: 'BUY',
        executedPrice: '1.02',
        executedQuantity: 20,
        executedAmount: '20.4',
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
        orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
      }),
    ).toThrow(/无法解析唯一 monitor\/direction/);
    assertNoCommittedEffects(harness, orderId);
  });

  it('fails fast when an attributed cumulative execution lacks explicit revision progress', () => {
    const harness = createHarness(),
      orderId = 'BUY-MISSING-REVISION-PROGRESS';
    expect(() =>
      harness.flow.settleOrder(
        terminalParams(orderId, {
          side: 'BUY',
          isProtectiveLiquidation: false,
          executedQuantity: 20,
          executedAmount: '20.4',
          orderUpdatedAtMs: null,
        }),
      ),
    ).toThrow(/缺少完整累计数量\/revision/);
    assertNoCommittedEffects(harness, orderId);
  });

  it('fails fast when executed close lacks monitor attribution', () => {
    const harness = createHarness(),
      orderId = 'SELL-PROTECTIVE-MISSING-MONITOR';
    expect(() =>
      harness.flow.settleOrder({
        orderId,
        closedReason: 'FILLED',
        source: 'WS',
        symbol: 'BULL.HK',
        side: 'SELL',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: '1.02',
        executedQuantity: 100,
        executedAmount: '102',
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
        orderUpdatedAtMs: PROTECTIVE_EXECUTION_TIME_MS,
      }),
    ).toThrow(/无法解析唯一 monitor\/direction/);
    assertNoCommittedEffects(harness, orderId);
  });

  it('records original liquidation symbol when protective sell settlement updates episode progress', () => {
    const harness = createHarness(),
      orderId = 'PL-SETTLEMENT-001';
    const result = harness.flow.settleOrder(
      terminalParams(orderId, {
        symbol: 'BULL.OLD.HK',
        executedPrice: '1.03',
        executedAmount: '103',
      }),
    );
    expect(result.handled).toBe(true);
    expect(harness.episodes).toEqual([
      { direction: 'LONG', symbol: 'BULL.OLD.HK', executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS },
    ]);

    expect(harness.events).toEqual([
      {
        orderId,
        symbol: 'BULL.OLD.HK',
        side: 'SELL',
        status: 'FILLED',
        monitorSymbol: 'HSI.HK',
        isLongSymbol: true,
        isProtectiveLiquidation: true,
        executedPrice: '1.03',
        executedQuantity: 100,
        executedTimeMs: PROTECTIVE_EXECUTION_TIME_MS,
      },
    ]);
    expect(harness.persisted[0]?.symbol).toBe('BULL.OLD.HK');
    expect(harness.recorder.getExecutionFact(orderId)?.symbol).toBe('BULL.OLD.HK');
  });

  it('settlement 在关闭最后一个订单时移除 symbol bucket 并销毁 route state', () => {
    const harness = createHarness(),
      orderId = 'SELL-ROUTE-CLOSE-1';
    harness.runtime.trackedOrders.set(orderId, {
      ...createTrackedProtectiveSell(orderId),
      isProtectiveLiquidation: false,
    });

    harness.owner.submitSellOrder(
      orderId,
      'BULL.HK',
      'LONG',
      100,
      [],
      PROTECTIVE_EXECUTION_TIME_MS - 60000,
    );
    harness.runtime.trackedOrderIdsBySymbol.set('BULL.HK', new Set([orderId]));
    harness.runtime.routeStatesBySymbol.set('BULL.HK', {
      symbol: 'BULL.HK',
      generation: 1,
      inFlight: false,
      dirty: false,
      latestQuote: null,
      pendingWakeupKind: null,
      timerHandles: new Map(),
    });
    const params = terminalParams(orderId, {
      closedReason: 'CANCELED',
      executedQuantity: null,
      executedPrice: null,
      executedAmount: '0',
      executedTimeMs: null,
    });
    expect(() => harness.flow.settleOrder(params)).toThrow(/terminal 累计数量无效/);
    expect(harness.runtime.trackedOrderIdsBySymbol.has('BULL.HK')).toBe(true);
    expect(harness.runtime.routeStatesBySymbol.has('BULL.HK')).toBe(true);
    const result = harness.flow.settleOrder({ ...params, executedQuantity: 0 });
    expect(result.handled).toBe(true);
    expect(harness.runtime.trackedOrderIdsBySymbol.has('BULL.HK')).toBe(false);
    expect(harness.runtime.routeStatesBySymbol.has('BULL.HK')).toBe(false);
    expect(harness.holdClosed).toEqual([orderId]);
  });
});

it('真实旧 boundary 同量45→46保留权威/durable与刷新，冻结日损不变且terminal资源只关闭一次', async () => {
  const now = new Date(PROTECTIVE_EXECUTION_TIME_MS);
  const daily = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });
  daily.resetAll(now);
  const snapshot = createAccountPositionSnapshot({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    reportFatalError: (error) => {
      throw error;
    },
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
    },
  });
  const refreshed = await snapshot.requestRefresh({
    source: 'TEST',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  expect(refreshed.status).toBe('COMMITTED');
  if (refreshed.status !== 'COMMITTED') throw new Error('snapshot not committed');

  const gate = createSettlementReadinessGate({
    snapshot,
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
  });
  expect(gate.markFresh(0, refreshed.snapshotToken)).toBe(true);
  const recorder = createSettlementRecorder(
    {
      recordSettlementRefreshNeed: () => {
        gate.markStale();
      },
    },
    {},
  );
  const initial = {
    factStage: 'OPEN' as const,
    orderId: 'BOUNDARY-SELL',
    direction: 'LONG' as const,
    symbol: 'BULL.HK',
    side: 'SELL' as const,
    executedQuantity: 100,
    executedPrice: '0.45',
    executedTimeMs: now.getTime(),
    orderUpdatedAtMs: now.getTime(),
  };
  const initialDaily = daily.recordCumulativeExecution(initial);
  expect(initialDaily.admission).toBe('ADMITTED');
  recorder.commitExecutionFact(
    {
      brokerOrderId: initial.orderId,
      symbol: initial.symbol,
      side: 'SELL',
      phase: 'OPEN',
      cumulativeQuantity: 100,
      cumulativeAmount: '45',
      executionTimeMs: now.getTime(),
      updatedAtMs: now.getTime(),
    },
    true,
    [],
    () => initialDaily.admission,
  );
  expect(gate.markFresh(1, refreshed.snapshotToken)).toBe(true);
  daily.commitProtectionBoundary(
    daily.prepareProtectionBoundary({ direction: 'LONG', boundaryExecutedTimeMs: now.getTime() }),
  );

  recorder.submitSellOrder(initial.orderId, initial.symbol, 'LONG', 100, [], now.getTime() - 1000);
  const before = {
    fact: recorder.getExecutionFact(initial.orderId),
    cost: recorder.getCostBasis(initial.symbol, true),
    sell: recorder.getSellRecordByOrderId(initial.orderId),
    baseline: daily.prepareProtectionBoundary({
      direction: 'LONG',
      boundaryExecutedTimeMs: now.getTime() + 1,
    }),
    loss: daily.getLossOffset('LONG'),
    token: snapshot.getView().token,
    gate: gate.getStatus(),
  };
  const runtime = createRuntime();
  runtime.trackedOrders.set(initial.orderId, createTrackedProtectiveSell(initial.orderId));
  const persisted: unknown[] = [],
    closed: string[] = [],
    events: OrderStateChangedEvent[] = [];
  const episodeOwner = createProtectiveLiquidationEpisodeTracker();
  episodeOwner.restoreCompletedBoundary({
    direction: 'LONG',
    boundaryExecutedTimeMs: now.getTime(),
  });
  const flow = createSettlementFlow({
    diagnostics: createDiagnosticObserverDouble(),
    now: () => new Date('2031-01-02T03:04:05.000Z'),
    runtime,
    orderRecorder: recorder,
    dailyLossTracker: daily,
    orderHoldRegistry: {
      ...createOrderHoldRegistry(),
      markOrderClosed: (orderId) => {
        closed.push(orderId);
      },
    },
    persistProtectiveLiquidationExecutionProgress: (progress) => {
      persisted.push(progress);
    },
    protectiveLiquidationEpisodeTracker: episodeOwner,
    postTradeConsistencyRuntime: {
      recordSettlementRefreshNeed: () => {
        gate.markStale();
      },
    },
    emitOrderStateChanged: (event) => {
      events.push(event);
    },
  });
  const result = flow.settleOrder({
    orderId: initial.orderId,
    closedReason: 'FILLED',
    source: 'WS',
    executedQuantity: 100,
    executedPrice: '0.46',
    executedAmount: '46',
    executedTimeMs: now.getTime(),
    orderUpdatedAtMs: now.getTime() + 30000,
    preparedProtectiveTerminalExecution: initialDaily,
  });
  expect(result.handled).toBe(true);
  expect(recorder.getExecutionFact(initial.orderId)).toMatchObject({
    cumulativeAmount: '46',
    updatedAtMs: now.getTime() + 30000,
    phase: 'TERMINAL',
  });
  expect(recorder.getCostBasis(initial.symbol, true)).toEqual(before.cost);
  expect(recorder.getSellRecordByOrderId(initial.orderId)).toMatchObject({ costAmount: '46' });
  expect(
    daily
      .prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: now.getTime() + 1,
      })
      .orderBaselines.find((b) => b.orderId === initial.orderId),
  ).toMatchObject({ cumulativeAmount: '46', orderRevisionMs: now.getTime() + 30000 });
  expect(daily.getLossOffset('LONG')).toBe(before.loss);
  expect(snapshot.getView().token).toEqual(before.token);
  expect(gate.getStatus()).toEqual({
    ...before.gate,
    ready: false,
    staleVersion: before.gate.staleVersion + 1,
  });

  expect(persisted).toMatchObject([
    { cumulativeAmount: '46', orderRevisionMs: now.getTime() + 30000 },
  ]);
  expect(episodeOwner.getInProgressEpisodes()).toEqual([]);
  expect(closed).toEqual([initial.orderId]);
  expect(events).toHaveLength(1);
  expect(runtime.closedOrderIds.has(initial.orderId)).toBe(true);
  expect(runtime.trackedOrders.has(initial.orderId)).toBe(false);
  expect(recorder.getPendingSellSnapshot()).toEqual([]);
});
