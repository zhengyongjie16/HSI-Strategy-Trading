/**
 * orderMonitor/settlementFlow 业务测试
 *
 * 覆盖当前结算职责：
 * - 终态后清理 tracked order / hold
 * - 写 recent filled 摘要
 * - 推送 post-trade refresh
 * - 缺少归属上下文时拒绝结算
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import type { TradeRecord } from '../../../../src/types/trader.js';
import type { StrategyRuntimeConfig } from '../../../../src/types/config.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorTrackedOrder,
} from '../../../../src/core/trader/orderMonitor/types.js';
import { createSettlementFlow } from '../../../../src/core/trader/orderMonitor/settlementFlow.js';
import {
  createDailyLossTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createStrategyRuntimeConfigDouble,
} from '../../../helpers/testDoubles.js';

const recordedTrades: TradeRecord[] = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- 导入前注册模块替身
mock.module('../../../../src/core/trader/tradeLogger.js', () => ({
  recordTrade: (tradeRecord: TradeRecord) => {
    recordedTrades.push(tradeRecord);
  },
}));

const defaultMonitorConfig = createStrategyRuntimeConfigDouble();

function createTrackedOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly isLongSymbol: boolean;
  readonly status?: OrderStatus;
  readonly executedPrice?: number | null;
  readonly executedQuantity?: number;
  readonly submittedQuantity?: number;
  readonly lastExecutedTimeMs?: number | null;
  readonly baseInstrumentSymbol?: string | null;
  readonly isProtectiveLiquidation?: boolean;
  readonly liquidationTriggerLimit?: number;
  readonly liquidationCooldownConfig?: StrategyRuntimeConfig['liquidationCooldown'];
}): OrderMonitorTrackedOrder {
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: params.isLongSymbol,
    baseInstrumentSymbol: params.baseInstrumentSymbol ?? defaultMonitorConfig.baseInstrumentSymbol,
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit:
      params.liquidationTriggerLimit ?? defaultMonitorConfig.liquidationTriggerLimit,
    liquidationCooldownConfig:
      params.liquidationCooldownConfig ?? defaultMonitorConfig.liquidationCooldown,
    orderType: OrderType.ELO,
    submittedPrice: 1,
    initialSubmittedPrice: 1,
    submittedQuantity: params.submittedQuantity ?? 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    status: params.status ?? OrderStatus.New,
    submittedAt: Date.parse('2026-02-16T01:00:00.000Z'),
    lastPriceUpdateAt: Date.parse('2026-02-16T01:00:00.000Z'),
    convertedToMarket: false,
    nextCancelAttemptAt: Date.parse('2026-02-16T01:00:00.000Z'),
    cancelRetryCount: 0,
    replaceCapability: 'SUPPORTED',
    replaceBlockedUntilAt: null,
    nextStateCheckAt: null,
    stateCheckRetryCount: 0,
    stateCheckBlockedUntilAt: null,
    replaceTempBlockedCount: 0,
    replaceResumeMode: 'TIME_BACKOFF',
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    timeoutMarketConversionPending: false,
    timeoutMarketConversionTerminalState: null,
  };
}

function createRuntime(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map<string, OrderMonitorTrackedOrder>(),
    trackedOrderLifecycles: new Map(),
    pendingRefreshSymbols: [],
    recentFilledOrders: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    runtimeState: 'ACTIVE',
  };
}

describe('orderMonitor settlementFlow', () => {
  beforeEach(() => {
    recordedTrades.length = 0;
  });

  const monitorConfig = defaultMonitorConfig;

  it('records filled sell summary, refresh request and tracking cleanup', () => {
    const runtime = createRuntime();
    const closedOrderIds: string[] = [];
    runtime.trackedOrders.set(
      'SELL-001',
      createTrackedOrder({
        orderId: 'SELL-001',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        isLongSymbol: true,
        executedPrice: 1.08,
        executedQuantity: 300,
        submittedQuantity: 300,
        lastExecutedTimeMs: Date.parse('2026-02-16T01:30:00.000Z'),
      }),
    );

    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: (orderId) => {
          closedOrderIds.push(orderId);
        },
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        clear: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorConfig,
      refreshGate: {
        markStale: () => 1,
        markFresh: () => {},
        waitForFresh: async () => {},
        getStatus: () => ({
          currentVersion: 0,
          staleVersion: 1,
        }),
      },
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-001',
      closedReason: 'FILLED',
      source: 'WS',
    });

    expect(result).toEqual({ handled: true });
    expect(runtime.trackedOrders.has('SELL-001')).toBeFalse();
    expect(runtime.trackedOrderLifecycles.get('SELL-001')).toBe('CLOSED');
    expect(runtime.recentFilledOrders.get('SELL-001')).toEqual({
      orderId: 'SELL-001',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 1.08,
      executedQuantity: 300,
      executedTimeMs: Date.parse('2026-02-16T01:30:00.000Z'),
    });

    expect(runtime.pendingRefreshSymbols).toEqual([
      {
        symbol: 'BULL.HK',
        isLongSymbol: true,
        refreshAccount: true,
        refreshPositions: true,
      },
    ]);
    expect(closedOrderIds).toEqual(['SELL-001']);
    expect(recordedTrades).toHaveLength(1);
    expect(recordedTrades[0]?.status).toBe('FILLED');
  });

  it('records partial execution summary for canceled sell when attribution context is complete', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        clear: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorConfig,
    });

    const result = settlementFlow.settleOrder({
      orderId: 'SELL-002',
      closedReason: 'CANCELED',
      source: 'STATE_CHECK',
      symbol: 'BULL.HK',
      side: 'SELL',
      baseInstrumentSymbol: 'HSI.HK',
      isLongSymbol: true,
      executedPrice: 1.03,
      executedQuantity: 120,
      executedTimeMs: Date.parse('2026-02-16T01:31:00.000Z'),
    });

    expect(result).toEqual({ handled: true });
    expect(runtime.recentFilledOrders.get('SELL-002')).toEqual({
      orderId: 'SELL-002',
      symbol: 'BULL.HK',
      side: OrderSide.Sell,
      executedPrice: 1.03,
      executedQuantity: 120,
      executedTimeMs: Date.parse('2026-02-16T01:31:00.000Z'),
    });
    expect(runtime.pendingRefreshSymbols).toHaveLength(1);
    expect(recordedTrades.at(-1)?.reason).toBe('CANCELED');
  });

  it('rejects settlement when execution exists but attribution context is incomplete', () => {
    const runtime = createRuntime();
    const settlementFlow = createSettlementFlow({
      runtime,
      orderHoldRegistry: {
        trackOrder: () => {},
        markOrderClosed: () => {},
        seedFromOrders: () => {},
        getHoldSymbols: () => new Set<string>(),
        clear: () => {},
      },
      dailyLossTracker: createDailyLossTrackerDouble(),
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorConfig,
    });

    const result = settlementFlow.settleOrder({
      orderId: 'BUY-001',
      closedReason: 'CANCELED',
      source: 'RECOVERY',
      symbol: 'BULL.HK',
      side: 'BUY',
      executedPrice: 1.01,
      executedQuantity: 20,
      executedTimeMs: Date.parse('2026-02-16T01:32:00.000Z'),
    });

    expect(result).toEqual({ handled: false });
    expect(runtime.closedOrderIds.has('BUY-001')).toBeFalse();
    expect(runtime.recentFilledOrders.has('BUY-001')).toBeFalse();
    expect(runtime.pendingRefreshSymbols).toHaveLength(0);
  });
});
