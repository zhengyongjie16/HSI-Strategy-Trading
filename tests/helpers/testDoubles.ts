/**
 * 测试替身与工厂（testDoubles）
 *
 * 功能：
 * - 提供测试替身与工厂方法，供其他测试模块使用
 */

import { createMonitorConfig } from '../../mock/factories/configFactory.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import type { WarrantCandidateSearch } from '../../src/application/autoSearch/types.js';
import type {
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  DoomsdayClearanceWorkflow,
} from '../../src/application/doomsdayClearance/types.js';
import type { OrderMonitor } from '../../src/application/orderTracking/types.js';
import type { OrdinaryBuyWorkflow } from '../../src/application/ordinaryBuy/types.js';
import type { OrdinarySellWorkflow } from '../../src/application/ordinarySell/types.js';
import type {
  PostTradeSettlementBusinessDeps,
  SettlementCompletionPersistence,
} from '../../src/application/postTradeSettlement/types.js';
import type { WarrantRiskRefresh } from '../../src/application/riskRefresh/types.js';
import type { SeatActivationWorkflow } from '../../src/application/seatActivation/types.js';
import { TIME } from '../../src/constants/index.js';
import type {
  ClearMidnightEligibleParams,
  GetRemainingMsParams,
  LiquidationCooldownTracker,
  RecordCooldownParams,
  RecordLiquidationTriggerParams,
  RestoreTriggerCountParams,
} from '../../src/domain/liquidation/cooldown/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../src/domain/liquidation/episode/types.js';
import { orderAnalysis } from '../../src/domain/order/orderAnalysis.js';
import { createDailyLossTracker } from '../../src/domain/risk/dailyLossTracker.js';
import type { QuoteSubscriptionRuntime } from '../../src/runtime/quoteSubscriptionRuntime/types.js';
import type { TradingGateEventRuntime } from '../../src/runtime/tradingGateEventRuntime/types.js';
import type { AutoSearchWakeupRuntime } from '../../src/runtime/autoSearchWakeupRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../src/runtime/periodicSwitchWakeupRuntime/types.js';
import type { SeatActivationDispatcher } from '../../src/runtime/seatActivationDispatcher/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../../src/runtime/seatRuntimeCleanupDispatcher/types.js';
import type { AccountSnapshot, Position } from '../../src/types/account.js';
import type { AccountPositionSnapshotReader } from '../../src/types/accountPosition.js';
import type { MonitorConfig } from '../../src/types/config.js';
import type { NormalizedCandle } from '../../src/types/data.js';
import type {
  CandlestickCacheSnapshot,
  CandlestickPeriod,
  MarketDataClient,
  MarketQuoteContext,
} from '../../src/types/marketPorts.js';
import type { SeatSwitchWorkflow } from '../../src/types/seatSwitch.js';
import type { Quote } from '../../src/types/quote.js';
import type { DailyLossTracker } from '../../src/types/risk.js';
import type { UnrealizedLossMonitor } from '../../src/types/unrealizedLoss.js';
import type { RuntimeTermination } from '../../src/types/runtime.js';
import type { SeatState, SeatStateChangedEvent, SymbolRegistry } from '../../src/types/seat.js';
import type { TradeRuntime } from '../../src/app/runtime/types.js';
import type { TradeRuntimeOverrides } from './types.js';
import type { OrderRecorder } from '../../src/types/orderRecorder.js';

import type { RateLimiter, TradeMutationPermit } from '../../src/types/rateLimit.js';
import type { RiskChecker, RiskCheckResult } from '../../src/types/riskCheck.js';
import type {
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../../src/types/warrantRisk.js';
import type { Signal, SignalType } from '../../src/types/signal.js';
import type { MonitorContextAssembly } from '../../src/app/context/types.js';
import type { TradingSignalStrategy } from '../../src/types/strategy.js';
import type { TradeMutationPort } from '../../src/types/tradeMutationPorts.js';
import type { Logger } from '../../src/types/logger.js';
import {
  getHKDateKey,
  resolveHKDayStartUtcMs,
  toHongKongTimeIso,
} from '../../src/utils/time/index.js';

type TestSeatTruthChangedEvent = Parameters<Parameters<SymbolRegistry['onSeatTruthChanged']>[0]>[0];

/**
 * 构建测试用 K 线缓存快照。
 *
 * 当测试替身已经持有 candle fixtures 时，直接暴露本地缓存快照，便于
 * processMonitor / quoteClient 类测试沿用真实语义；没有缓存时返回 null。
 *
 * @param symbol 标的代码
 * @param period K 线周期
 * @param candles 本地缓存的 K 线序列
 * @param version 当前缓存版本
 * @returns 本地 K 线缓存快照；无有效缓存时返回 null
 */
function createCandlestickCacheSnapshot(
  symbol: string,
  period: CandlestickPeriod,
  candles: ReadonlyArray<NormalizedCandle>,
  version: number,
): CandlestickCacheSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const latest = candles.at(-1);
  const lastBarTimestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;

  return {
    symbol,
    period,
    version,
    candles,
    lastBarTimestamp,
    lastBarConfirmed: false,
    initialized: true,
  };
}

/**
 * 枚举闭区间内的港股日期键，供行情客户端默认交易日批量响应使用。
 *
 * @param startDate 区间起始时间
 * @param endDate 区间结束时间
 * @returns 升序港股日期键数组；无效区间返回空数组
 */
function listHKDateKeysInRange(startDate: Date, endDate: Date): ReadonlyArray<string> {
  const startDateKey = getHKDateKey(startDate);
  const endDateKey = getHKDateKey(endDate);
  if (!startDateKey || !endDateKey) {
    return [];
  }

  const startDayStartMs = resolveHKDayStartUtcMs(startDateKey);
  const endDayStartMs = resolveHKDayStartUtcMs(endDateKey);
  if (startDayStartMs === null || endDayStartMs === null || endDayStartMs < startDayStartMs) {
    return [];
  }

  const dateKeys: string[] = [];
  for (
    let dayStartMs = startDayStartMs;
    dayStartMs <= endDayStartMs;
    dayStartMs += TIME.MILLISECONDS_PER_DAY
  ) {
    const dateKey = getHKDateKey(new Date(dayStartMs));
    if (dateKey) {
      dateKeys.push(dateKey);
    }
  }

  return dateKeys;
}

/**
 * 将测试 seed 的 K 线复制为本地缓存使用的 frozen primitive-only K 线。
 *
 * @param candles 中性 seed 或测试 fixture 的 K 线数组
 * @returns 可供本地快照与指标计算消费的 K 线数组；每根 K 线独立冻结，数组保持可变
 */
function normalizeCandlestickData(
  candles: ReadonlyArray<NormalizedCandle>,
): ReadonlyArray<NormalizedCandle> {
  return candles.map((candle) => {
    const timestamp = normalizeTimestamp(candle.timestamp);
    const normalized = {
      open: normalizeCandleValue(candle.open),
      high: normalizeCandleValue(candle.high),
      low: normalizeCandleValue(candle.low),
      close: normalizeCandleValue(candle.close),
      volume: normalizeCandleValue(candle.volume),
    };
    return Object.freeze(timestamp === undefined ? normalized : { ...normalized, timestamp });
  });
}

/**
 * 将测试行情值收敛为缓存边界允许的 primitive。
 *
 * @param value 原始行情值
 * @returns primitive 行情值；不可转换的对象返回 undefined
 */
function normalizeCandleValue(value: unknown): number | string | null | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const toNumber = Reflect.get(value, 'toNumber');
  if (typeof toNumber !== 'function') {
    return undefined;
  }

  const normalized = Reflect.apply(toNumber, value, []);
  return typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : undefined;
}

/**
 * 将测试 K 线时间字段收敛为有效毫秒时间戳。
 *
 * @param value 原始时间字段
 * @returns 有效毫秒时间戳；无法解析时返回 undefined
 */
function normalizeTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  return undefined;
}

/**
 * 创建无输出 logger 测试替身。
 *
 * @returns 具备完整日志能力且不产生外部副作用的 Logger
 */
export function createLoggerDouble(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 创建 H 只读端口测试替身；输入 view 与 current 校验由用例显式提供，无 cache/update 或默认授权。
 * @param reader 用例提供的不可变事实读取与授权函数
 * @returns 无刷新/写入能力的只读端口；不代表真实 owner commit 或业务 ready
 */
export function createAccountPositionSnapshotReaderDouble(
  reader: Pick<AccountPositionSnapshotReader, 'getView' | 'isCurrent'>,
): AccountPositionSnapshotReader {
  return {
    getView: reader.getView,
    isCurrent: reader.isCurrent,
    getAvailablePosition: (symbol) => {
      const view = reader.getView();
      return view.positionsValid
        ? (view.positions.find(
            (position) => position.symbol === symbol && position.availableQuantity > 0,
          ) ?? null)
        : null;
    },
    getStatus: () => ({
      admission: 'CLOSED',
      token: reader.getView().token,
    }),
  };
}

/**
 * 创建 OrderRecorder 测试替身。
 *
 * 默认提供空实现，并允许按用例覆盖关键行为。
 */
export function createOrderRecorderDouble(overrides: Partial<OrderRecorder> = {}): OrderRecorder {
  const base: OrderRecorder = {
    commitExecutionFact: (_fact, _isLong, _related, beforeCommit) => {
      beforeCommit();
    },
    getExecutionFact: () => null,
    commitRebuildSnapshot: (_targets, _orders, isCurrent) =>
      isCurrent() ? { status: 'COMMITTED' } : { status: 'ABORTED' },
    clearBuyOrders: () => {},
    getLatestBuyOrderCost: () => null,
    getSellRecordByOrderId: () => null,
    fetchAllOrdersFromAPI: async () => [],
    validateRebuildSnapshot: () => {},
    getBuyOrdersForSymbol: () => [],
    submitSellOrder: () => {},
    updatePendingSell: () => null,
    markSellFilled: () => null,
    markSellPartialFilled: () => null,
    markSellCancelled: () => null,
    getPendingSellSnapshot: () => [],
    allocateRelatedBuyOrderIdsForRecovery: () => [],
    getCostBasis: () => null,
    selectSellableOrders: () => ({
      orders: [],
      totalQuantity: 0,
    }),
    resetAll: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 Trader 测试替身。
 *
 * 用于隔离下单与查询副作用，聚焦流程编排断言。
 */
export function createTradeRuntimeDouble(overrides: TradeRuntimeOverrides = {}): TradeRuntime {
  return {
    accountService: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
      ...overrides.accountService,
    },
    cacheManager: {
      getPendingOrders: async () => [],
      clearCache: () => {},
      ...overrides.cacheManager,
    },
    orderRecorder: createOrderRecorderDouble(overrides.orderRecorder),
    orderHoldRegistry: {
      trackOrder: () => {},
      markOrderClosed: () => {},
      seedFromOrders: () => {},
      getHoldSymbols: () => new Set<string>(),
      onOrderHoldSymbolsChanged: () => () => {},
      clear: () => {},
      ...overrides.orderHoldRegistry,
    },
    orderMonitor: createOrderMonitorDouble(overrides.orderMonitor),
    orderExecutor: {
      canTradeNow: () => ({ canTrade: true }),
      executeSignals: async () => ({ executedOrderIds: [], quoteFailures: [] }),
      executeDoomsdayClearanceSignals: async () => ({
        executedOrderIds: [],
        reevaluationSymbols: [],
        unresolvedQuoteSymbols: [],
      }),
      resetBuyThrottle: () => {},
      ...overrides.orderExecutor,
    },
  };
}

type RateLimiterDoubleOptions = {
  /** 读取动作进入同一 FIFO 序列后执行的测试钩子。 */
  readonly onThrottle?: () => void | Promise<void>;

  /** mutation callback 取得 FIFO 席位后执行的测试钩子。 */
  readonly onMutationPermitAcquired?: () => void | Promise<void>;

  /** permit 内实际 SDK mutation 开始前执行的测试钩子。 */
  readonly onMutationInvoked?: () => void | Promise<void>;
};

/**
 * 创建具备真实 FIFO permit 语义的 RateLimiter 测试替身。
 *
 * callback 和读取动作共享同一队列；一个 permit 最多只能执行一次真实 mutation。
 * 无最终行情或授权失败时业务代码可合法地不调用 invoke，因此不把“零次调用”误判为契约错误。
 *
 * @param options 用于时间与并发场景的最小观察钩子
 * @returns 可注入生产依赖边界的 RateLimiter
 */
export function createRateLimiterDouble(options: RateLimiterDoubleOptions = {}): RateLimiter {
  let sequenceTail = Promise.resolve();

  async function runInSequence<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = sequenceTail;
    let releaseCurrentTurn!: () => void;
    const currentTurn = new Promise<void>((resolve) => {
      releaseCurrentTurn = resolve;
    });
    sequenceTail = predecessor.then(() => currentTurn);

    await predecessor;
    try {
      return await operation();
    } finally {
      releaseCurrentTurn();
    }
  }

  async function throttle(): Promise<void> {
    await runInSequence(async () => {
      await options.onThrottle?.();
    });
  }

  async function withTradeMutation<T>(
    callback: (permit: TradeMutationPermit) => Promise<T>,
  ): Promise<T> {
    return runInSequence(async () => {
      await options.onMutationPermitAcquired?.();
      let invoked = false;
      const permit: TradeMutationPermit = {
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
          if (invoked) {
            throw new Error('[test double] 一个 trade mutation permit 只能调用一次');
          }

          invoked = true;
          await options.onMutationInvoked?.();
          return operation();
        },
      };
      return callback(permit);
    });
  }

  return {
    throttle,
    withTradeMutation,
  };
}

/**
 * 创建订单监控器测试替身。
 *
 * 默认 REPLACE 均 fail-fast，避免没有明确业务断言的测试意外走到改单路径。
 * 需要验证 REPLACE 的测试必须显式覆盖 replaceOrderPriceWithPermit，且在传入 permit.invoke 内模拟 broker mutation。
 *
 * @param overrides 当前测试确实需要观察或驱动的行为
 * @returns 完整的 OrderMonitor 契约测试替身
 */
export function createOrderMonitorDouble(overrides: Partial<OrderMonitor> = {}): OrderMonitor {
  let trackingGeneration = 0;
  const base: OrderMonitor = {
    initialize: async () => {},
    teardown: async () => {},
    onOrderStateChanged: () => () => {},
    trackOrder: () => {},
    cancelOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    }),
    cancelDoomsdayOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    }),
    replaceOrderPriceWithPermit: async () => {
      throw new Error('[test double] 未预期的 permit REPLACE 调用');
    },
    startRuntime: () => {},
    stopRuntimeAndDrain: async () => {},
    recoverOrderTrackingFromSnapshot: async () => {},
    getPendingSellOrders: () => [],
    captureSellAvailabilityGuard: (symbol) => {
      const generation = trackingGeneration;
      const pending = JSON.stringify(overrides.getPendingSellOrders?.(symbol) ?? []);
      return () =>
        generation === trackingGeneration &&
        pending === JSON.stringify(overrides.getPendingSellOrders?.(symbol) ?? []);
    },
    onSellOperationChanged: () => () => {},
    getKnownSellOrderIds: () => [],
    getUnsettledSellOrderIds: () => [],
    getSellOperationState: () => 'SETTLED',
    getSellOperationOrderIds: (originalOrderId) => [originalOrderId],
    hasPendingProtectiveLiquidationOrders: () => false,
    clearTrackedOrders: () => {},
  };

  return {
    ...base,
    ...overrides,
    trackOrder: (params) => {
      trackingGeneration += 1;
      (overrides.trackOrder ?? base.trackOrder)(params);
    },
    clearTrackedOrders: () => {
      trackingGeneration += 1;
      (overrides.clearTrackedOrders ?? base.clearTrackedOrders)();
    },
  };
}

/**
 * 创建 RiskChecker 测试替身。
 *
 * 默认放行风控，按需覆盖指定风险分支返回值。
 */
export function createRiskCheckerDouble(overrides: Partial<RiskChecker> = {}): RiskChecker {
  const allowedResult: RiskCheckResult = { allowed: true };
  const base: RiskChecker = {
    setWarrantInfoFromCallPrice: (): WarrantRefreshResult => ({ status: 'ok' }),
    checkBeforeOrder: () => allowedResult,
    checkWarrantRisk: () => allowedResult,
    checkWarrantDistanceLiquidation: (): WarrantDistanceLiquidationResult => ({
      shouldLiquidate: false,
    }),
    getWarrantDistanceInfo: (): WarrantDistanceInfo | null => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
    prepareUnrealizedLossData: (_recorder, symbol) => ({ symbol, data: { r1: '0', n1: 0 } }),
    publishUnrealizedLossData: () => {},
    checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    getUnrealizedLossMetrics: () => null,
    clearUnrealizedLossData: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/** 独立异步 warrant 刷新端口替身；不向同步 RiskChecker 添加旧查询能力。 */
export function createWarrantRiskRefreshDouble(
  overrides: Partial<WarrantRiskRefresh> = {},
): WarrantRiskRefresh {
  return {
    refreshWarrantInfoForSymbol: async (_symbol, _isLongSymbol, isCurrent) =>
      isCurrent() ? { status: 'notWarrant' } : { status: 'INVALIDATED' },
    ...overrides,
  };
}

/** 席位激活端口替身；只供不执行激活业务的 app/lifecycle 装配测试补齐接口。 */
export function createSeatActivationWorkflowDouble(
  overrides: Partial<SeatActivationWorkflow> = {},
): SeatActivationWorkflow {
  return {
    activate: async () => ({ status: 'processed' }),
    isCurrent: () => true,
    ...overrides,
  };
}

/**
 * 创建 DailyLossTracker 单元测试工厂。
 *
 * 默认使用真实内存 owner 与分析依赖，不构造 SDK context、不发 IO，也不自动初始化交易日。
 * 5参 prepare/publish、归属校验、候选身份与状态失效均遵循真实契约；未初始化成交不会默认准入。
 * overrides 仅供单元 spy/隔离，不代表自然成交、durable、H/S readiness 或跨 owner 原子协议证明。
 */
export function createDailyLossTrackerDouble(
  overrides: Partial<DailyLossTracker> = {},
): DailyLossTracker {
  const base = createDailyLossTracker({
    onOwnershipWarning: () => {},
    ...orderAnalysis,
    toHongKongTimeIso,
  });

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建策略测试替身。
 *
 * 默认不生成任何信号，用于隔离组装层与上下文测试。
 */
export function createStrategyDouble(
  overrides: Partial<TradingSignalStrategy> = {},
): TradingSignalStrategy {
  const base: TradingSignalStrategy = {
    strategyId: 'test-strategy',
    onCandlestick: () => null,
    invalidateDirection: () => {},
    invalidateAll: () => {},
    resetForTradingDay: () => {},
    destroy: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建浮亏监控器测试替身。
 *
 * 默认无副作用，便于仅验证装配与数据填充。
 */
export function createUnrealizedLossMonitorDouble(
  overrides: Partial<UnrealizedLossMonitor> = {},
): UnrealizedLossMonitor {
  const base: UnrealizedLossMonitor = {
    monitorDirectionalUnrealizedLoss: async () => false,
  };

  return {
    ...base,
    ...overrides,
  };
}

/** 创建窄候选查询替身；不拥有运行期失败计数、席位或缓存。 */
export function createWarrantCandidateSearchDouble(
  overrides: Partial<WarrantCandidateSearch> = {},
): WarrantCandidateSearch {
  return {
    resolveDistanceRange: () => null,
    findCandidate: async () => null,
    ...overrides,
  };
}

/** 创建普通 BUY 用例替身，仅暴露执行和日切冷却清理。 */
export function createOrdinaryBuyWorkflowDouble(
  overrides: Partial<OrdinaryBuyWorkflow> = {},
): OrdinaryBuyWorkflow {
  return { execute: async () => {}, resetRiskCheckCooldown: () => {}, ...overrides };
}

/** 创建普通 SELL 用例替身，重试事实只由测试场景显式签发。 */
export function createOrdinarySellWorkflowDouble(
  overrides: Partial<OrdinarySellWorkflow> = {},
): OrdinarySellWorkflow {
  return { execute: async () => ({ status: 'COMPLETED' }), ...overrides };
}

/**
 * 创建席位换标用例测试替身。
 *
 * 默认不触发周期/距离换标，不包含空席位寻标能力。
 */
export function createSeatSwitchWorkflowDouble(
  overrides: Partial<SeatSwitchWorkflow> = {},
): SeatSwitchWorkflow {
  const base: SeatSwitchWorkflow = {
    evaluatePeriodicSwitchDue: async () => ({
      kind: 'NOOP',
    }),
    startSwitchOnDistance: async (params) => ({
      started: false,
      direction: params.direction,
      driveResult: {
        kind: 'NOOP',
      },
    }),
    advancePendingSwitch: async (params) => ({
      advanced: false,
      direction: params.direction,
      stillPending: false,
      driveResult: {
        kind: 'NOOP',
      },
    }),
    hasPendingSwitch: () => false,
    getPeriodicSwitchPendingState: () => ({
      pending: false,
    }),
    resetAllState: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 QuoteSubscriptionRuntime 测试替身。
 *
 * 默认只维护空异步端口，用于需要显式传入订阅 owner 的装配测试。
 */
export function createQuoteSubscriptionRuntimeDouble(
  overrides: Partial<QuoteSubscriptionRuntime> = {},
): QuoteSubscriptionRuntime {
  const base: QuoteSubscriptionRuntime = {
    reconcileFromCurrentTruth: async () => {},
    reconcilePositionHoldFromCurrentTruth: async () => {},
    start: () => {},
    stopAndDrain: async () => {},
    retainSymbols: async () => {},
    releaseRetain: async () => {},
    waitForAdmission: async () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 TradingGateEventRuntime 测试替身。
 *
 * 默认发布与订阅均为空实现，供 time wakeup evaluation 与 app wiring 测试注入。
 */
export function createTradingGateEventRuntimeDouble(
  overrides: Partial<TradingGateEventRuntime> = {},
): TradingGateEventRuntime {
  const base: TradingGateEventRuntime = {
    emitGateStateChanged: () => {},
    onGateStateChanged: () => () => {},
    emitAutoSearchAuthorizationChanged: () => {},
    onAutoSearchAuthorizationChanged: () => () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 AutoSearchWakeupRuntime 测试替身。
 *
 * 默认无副作用，供 lifecycle 与 cleanup 测试验证调用顺序。
 */
export function createAutoSearchWakeupRuntimeDouble(
  overrides: Partial<AutoSearchWakeupRuntime> = {},
): AutoSearchWakeupRuntime {
  const base: AutoSearchWakeupRuntime = {
    stop: () => {},
    start: () => {},
    stopAndDrain: async () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 PeriodicSwitchWakeupRuntime 测试替身。
 *
 * 默认无副作用，供 app、lifecycle 与 monitor task 测试验证调用顺序。
 */
export function createPeriodicSwitchWakeupRuntimeDouble(
  overrides: Partial<PeriodicSwitchWakeupRuntime> = {},
): PeriodicSwitchWakeupRuntime {
  const base: PeriodicSwitchWakeupRuntime = {
    stop: () => {},
    start: () => {},
    stopAndDrain: async () => {},
    markWaitingEmpty: () => {},
    clearWaitingEmpty: () => {},
    replanRouteAfterTask: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 SeatActivationDispatcher 测试替身。
 *
 * 默认无副作用，供 lifecycle 与 cleanup 测试验证调用顺序。
 */
export function createSeatActivationDispatcherDouble(
  overrides: Partial<SeatActivationDispatcher> = {},
): SeatActivationDispatcher {
  const base: SeatActivationDispatcher = {
    start: () => {},
    stop: () => {},
    dispatchCurrentActivatingSeats: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 SeatRuntimeCleanupDispatcher 测试替身。
 *
 * 默认无副作用，供 lifecycle 与 cleanup 测试验证调用顺序。
 */
export function createSeatRuntimeCleanupDispatcherDouble(
  overrides: Partial<SeatRuntimeCleanupDispatcher> = {},
): SeatRuntimeCleanupDispatcher {
  const base: SeatRuntimeCleanupDispatcher = {
    start: () => {},
    stop: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建窄中立 warrant 查询端口测试替身；用例直接提供金融文本与真实 null/undefined，不在 domain fixture 内适配 SDK。
 * @param overrides 明确采用对象请求与文本返回值的中立查询能力；未传时返回无事实的空列表
 * @returns 不包含 SDK Decimal 或 SDK 位置参数桥的 MarketQuoteContext
 */
export function createQuoteContextDouble(
  overrides: Partial<MarketQuoteContext> = {},
): MarketQuoteContext {
  return {
    warrantQuote: overrides.warrantQuote ?? (async () => []),
    warrantList: overrides.warrantList ?? (async () => []),
  };
}

/**
 * 创建中性交易 mutation 测试替身，不构造 SDK context，也不依据 cause 猜测分类。
 * @param overrides 测试场景显式提供的单次 mutation 行为
 * @returns 默认返回 ACK/ACCEPTED 且执行原 caller issued callback 的中性 port
 */
export function createTradeMutationPortDouble(
  overrides: Partial<TradeMutationPort> = {},
): TradeMutationPort {
  return {
    cancelOrder:
      overrides.cancelOrder ??
      (async () => ({
        kind: 'ACKNOWLEDGED',
        operation: 'TradeContext.cancelOrder',
        requestAttempted: true,
      })),
    replaceOrder:
      overrides.replaceOrder ??
      (async (_command, onRemoteIssued) => {
        onRemoteIssued();
        return {
          kind: 'ACKNOWLEDGED',
          operation: 'TradeContext.replaceOrder',
          requestAttempted: true,
        };
      }),
    submitOrder:
      overrides.submitOrder ??
      (async (_command, onRemoteIssued) => {
        onRemoteIssued();
        return {
          kind: 'ACCEPTED',
          operation: 'TradeContext.submitOrder',
          requestAttempted: true,
          orderId: 'TEST-ACCEPTED-ORDER',
        };
      }),
  };
}

/**
 * 创建 MarketDataClient 测试替身。
 *
 * 默认返回无副作用实现，并提供可覆盖的 getQuoteContext / getQuotes 等方法。
 */
export function createMarketDataClientDouble(
  overrides: Partial<MarketDataClient> = {},
): MarketDataClient {
  const quoteContext: MarketQuoteContext = {
    warrantQuote: async () => [],
    warrantList: async () => [],
  };
  const candlestickCache = new Map<string, ReadonlyArray<NormalizedCandle>>();
  const candlestickVersions = new Map<string, number>();
  const baseOnQuoteUpdated: NonNullable<MarketDataClient['onQuoteUpdated']> = () => () => {};

  const baseOnCandlestickUpdated: MarketDataClient['onCandlestickUpdated'] = () => () => {};

  function makeCandlestickKey(symbol: string, period: CandlestickPeriod): string {
    return `${symbol}:${period}`;
  }

  function getCandlestickCacheSnapshot(
    symbol: string,
    period: CandlestickPeriod,
  ): CandlestickCacheSnapshot | null {
    const key = makeCandlestickKey(symbol, period);
    const candles = candlestickCache.get(key);
    if (!candles) {
      return null;
    }

    return createCandlestickCacheSnapshot(
      symbol,
      period,
      candles,
      candlestickVersions.get(key) ?? 1,
    );
  }

  async function seedCandlestickCacheFromOverride(
    symbol: string,
    period: CandlestickPeriod,
    tradeSessions?: Parameters<MarketDataClient['subscribeCandlesticks']>[2],
  ): Promise<ReadonlyArray<NormalizedCandle>> {
    const seedCandles = overrides.subscribeCandlesticks
      ? await overrides.subscribeCandlesticks(symbol, period, tradeSessions)
      : [];
    const normalizedCandles = normalizeCandlestickData(seedCandles);
    const key = makeCandlestickKey(symbol, period);
    candlestickCache.set(key, normalizedCandles);
    candlestickVersions.set(key, (candlestickVersions.get(key) ?? 0) + 1);
    return seedCandles;
  }

  const base: MarketDataClient = {
    getQuoteContext: async () => quoteContext,
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    onQuoteUpdated: baseOnQuoteUpdated,
    onCandlestickUpdated: baseOnCandlestickUpdated,
    subscribeCandlesticks: async (symbol, period, tradeSessions) =>
      seedCandlestickCacheFromOverride(symbol, period, tradeSessions),
    getCandlestickSnapshot: (symbol, period) => getCandlestickCacheSnapshot(symbol, period),
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    getTradingDays: async (startDate, endDate) => ({
      tradingDays: listHKDateKeysInRange(startDate, endDate),
      halfTradingDays: [],
    }),
    resetRuntimeSubscriptionsAndCaches: async () => {},
  };

  return {
    getQuoteContext: overrides.getQuoteContext ?? base.getQuoteContext,
    getQuotes: overrides.getQuotes ?? base.getQuotes,
    subscribeSymbols: overrides.subscribeSymbols ?? base.subscribeSymbols,
    unsubscribeSymbols: overrides.unsubscribeSymbols ?? base.unsubscribeSymbols,
    onQuoteUpdated: overrides.onQuoteUpdated ?? baseOnQuoteUpdated,
    onCandlestickUpdated: overrides.onCandlestickUpdated ?? baseOnCandlestickUpdated,
    subscribeCandlesticks: async (symbol, period, tradeSessions) =>
      seedCandlestickCacheFromOverride(symbol, period, tradeSessions),
    getCandlestickSnapshot: overrides.getCandlestickSnapshot ?? base.getCandlestickSnapshot,
    isTradingDay: overrides.isTradingDay ?? base.isTradingDay,
    getTradingDays: overrides.getTradingDays ?? base.getTradingDays,
    resetRuntimeSubscriptionsAndCaches: async () => {
      candlestickCache.clear();
      candlestickVersions.clear();
      if (overrides.resetRuntimeSubscriptionsAndCaches) {
        await overrides.resetRuntimeSubscriptionsAndCaches();
      }
    },
  };
}

/**
 * 创建距回收价中立比例基数测试数据；不提前除法/舍入，也不经 number 或 SDK Decimal 转换。
 * @param params 牛熊证类型与精确分子/分母；未知时两者同时为 null
 * @returns 独立的中立比例基数对象
 */
export function createWarrantDistanceInfoDouble(params: WarrantDistanceInfo): WarrantDistanceInfo {
  return { ...params };
}

/**
 * 创建 DoomsdayClearanceWorkflow 测试替身。
 *
 * 默认不触发清算，便于按场景精确注入极端保护行为。
 */
export function createDoomsdayClearanceWorkflowDouble(
  overrides: Partial<DoomsdayClearanceWorkflow> = {},
): DoomsdayClearanceWorkflow {
  const base: DoomsdayClearanceWorkflow = {
    evaluate: async () => ({ executed: false, nextRetryAtMs: null }),
    executeClearance: async (
      _context: DoomsdayClearanceContext,
    ): Promise<DoomsdayClearanceResult> => ({
      executed: false,
      nextRetryAtMs: null,
    }),
    cancelPendingBuyOrders: async (
      _context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> => ({
      executed: false,
      cancelRequestAcceptedCount: 0,
      nextRetryAtMs: null,
    }),
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 LiquidationCooldownTracker 测试替身。
 *
 * 用于在测试中模拟冷却窗口读写而不依赖真实时间状态。
 */
export function createLiquidationCooldownTrackerDouble(
  overrides: Partial<LiquidationCooldownTracker> = {},
): LiquidationCooldownTracker {
  const base: LiquidationCooldownTracker = {
    recordLiquidationTrigger: (_params: RecordLiquidationTriggerParams): void => {},
    recordCooldown: (_params: RecordCooldownParams): void => {},
    restoreTriggerCount: (_params: RestoreTriggerCountParams): void => {},
    getRemainingMs: (_params: GetRemainingMsParams): number => 0,
    clearMidnightEligible: (_params: ClearMidnightEligibleParams): void => {},
    resetAllTriggerCounts: (): void => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 ProtectiveLiquidationEpisodeTracker 测试替身。
 *
 * 用于在测试中模拟保护性清仓事件进度与完成判定。
 */
export function createProtectiveLiquidationEpisodeTrackerDouble(
  overrides: Partial<ProtectiveLiquidationEpisodeTracker> = {},
): ProtectiveLiquidationEpisodeTracker {
  const base: ProtectiveLiquidationEpisodeTracker = {
    recordProtectiveFillProgress: () => {},
    prepareCompletion: () => null,
    commitCompletion: () => {},
    restoreCompletedBoundary: () => {},
    restoreInProgressEpisode: () => {},
    getInProgressEpisodes: () => [],
    resetAll: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

type SymbolRegistryDouble = SymbolRegistry &
  Readonly<{
    getSeatStateChangedListenerCount: () => number;
    getSeatTruthChangedListenerCount: () => number;
    getSeatStateListenerErrors: () => ReadonlyArray<unknown>;
  }>;

/**
 * 创建 SymbolRegistry 测试替身。
 *
 * 提供可变席位与版本号，支持换标流程与并发校验测试。
 */
export function createSymbolRegistryDouble(params?: {
  readonly longSeat?: SeatState;
  readonly shortSeat?: SeatState;
  readonly longVersion?: number;
  readonly shortVersion?: number;
}): SymbolRegistryDouble {
  let longSeat = params?.longSeat ?? {
    symbol: 'BULL.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  let shortSeat = params?.shortSeat ?? {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  let longVersion = params?.longVersion ?? 1;
  let shortVersion = params?.shortVersion ?? 1;
  let longLastEventVersion = longVersion;
  let shortLastEventVersion = shortVersion;
  const seatStateChangedListeners = new Set<(event: SeatStateChangedEvent) => void>();
  const seatTruthChangedListeners = new Set<(event: TestSeatTruthChangedEvent) => void>();
  const seatStateListenerErrors: unknown[] = [];

  function emitSeatStateChanged(event: SeatStateChangedEvent): unknown[] {
    const errors: unknown[] = [];
    for (const listener of seatStateChangedListeners) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
        seatStateListenerErrors.push(error);
      }
    }

    return errors;
  }

  function emitSeatTruthChanged(event: TestSeatTruthChangedEvent): unknown[] {
    const errors: unknown[] = [];
    for (const listener of seatTruthChangedListeners) {
      try {
        listener(event);
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  function throwIfListenerErrors(errors: ReadonlyArray<unknown>): void {
    if (errors.length > 0) {
      throw new AggregateError(errors, 'SymbolRegistry listener 执行失败');
    }
  }

  type SeatStateCandidate = Readonly<{
    symbol: string | null;
    status: 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';
    lastSwitchAt: number | null;
    lastSearchAt: number | null;
    lastSeatActivatedAt: number | null;
    callPrice?: string | null;
    searchFailCountToday: number;
    frozenTradingDayKey: string | null;
  }>;
  type RuntimeWritableSeatState = Exclude<
    SeatState,
    { readonly status: 'ACTIVE'; readonly lastSeatActivatedAt: null }
  >;

  function assertSeatStateInvariant(
    seatState: SeatStateCandidate,
    allowStaticBootstrap: boolean,
  ): void {
    if (seatState.status === 'EMPTY' || seatState.status === 'SEARCHING') {
      if (seatState.symbol !== null) {
        throw new Error(`SymbolRegistry 席位状态无效：${seatState.status} 不得绑定标的`);
      }
    } else if (typeof seatState.symbol !== 'string' || seatState.symbol.length === 0) {
      throw new Error(`SymbolRegistry 席位状态无效：${seatState.status} 必须绑定标的`);
    }

    for (const [field, value] of [
      ['lastSwitchAt', seatState.lastSwitchAt],
      ['lastSearchAt', seatState.lastSearchAt],
      ['lastSeatActivatedAt', seatState.lastSeatActivatedAt],
    ] as const) {
      if (value !== null && !Number.isFinite(value)) {
        throw new Error(`SymbolRegistry 席位状态无效：${field} 必须是有限时间戳`);
      }
    }

    if (seatState.status !== 'ACTIVE' || seatState.lastSeatActivatedAt !== null) {
      return;
    }

    if (!allowStaticBootstrap) {
      throw new Error('SymbolRegistry 席位状态无效：运行时 ACTIVE 必须具有有效激活时间');
    }

    if (
      seatState.lastSwitchAt !== null ||
      seatState.lastSearchAt !== null ||
      (seatState.callPrice ?? null) !== null ||
      seatState.searchFailCountToday !== 0 ||
      seatState.frozenTradingDayKey !== null
    ) {
      throw new Error('SymbolRegistry 席位状态无效：仅静态 bootstrap ACTIVE 可缺少激活时间');
    }
  }

  function normalizeSeatState(nextState: SeatState): SeatState {
    assertRuntimeSeatStateInvariant(nextState);

    return {
      ...nextState,
      callPrice: nextState.callPrice ?? null,
    };
  }

  function assertRuntimeSeatStateInvariant(
    seatState: SeatStateCandidate,
  ): asserts seatState is RuntimeWritableSeatState {
    assertSeatStateInvariant(seatState, false);
  }

  assertSeatStateInvariant(longSeat, true);
  assertSeatStateInvariant(shortSeat, true);

  return {
    getSeatState(direction: 'LONG' | 'SHORT'): SeatState {
      return direction === 'LONG' ? longSeat : shortSeat;
    },
    getSeatVersion(direction: 'LONG' | 'SHORT'): number {
      return direction === 'LONG' ? longVersion : shortVersion;
    },
    resolveSeatBySymbol(symbol: string) {
      if (
        longSeat.status !== 'EMPTY' &&
        longSeat.status !== 'SEARCHING' &&
        longSeat.symbol === symbol
      ) {
        return {
          direction: 'LONG' as const,
          seatVersion: longVersion,
        };
      }

      if (
        shortSeat.status !== 'EMPTY' &&
        shortSeat.status !== 'SEARCHING' &&
        shortSeat.symbol === symbol
      ) {
        return {
          direction: 'SHORT' as const,
          seatVersion: shortVersion,
        };
      }

      return null;
    },
    updateSeatState(direction: 'LONG' | 'SHORT', nextState: SeatState): void {
      const normalizedNextState = normalizeSeatState(nextState);

      if (direction === 'LONG') {
        const previousState = longSeat;
        const previousVersion = longLastEventVersion;
        longSeat = normalizedNextState;
        longLastEventVersion = longVersion;
        const listenerErrors = [
          ...emitSeatStateChanged({
            direction,
            previousState,
            nextState: longSeat,
            previousVersion,
            nextVersion: longVersion,
          }),
          ...emitSeatTruthChanged({ direction }),
        ];
        throwIfListenerErrors(listenerErrors);
        return;
      }

      const previousState = shortSeat;
      const previousVersion = shortLastEventVersion;
      shortSeat = normalizedNextState;
      shortLastEventVersion = shortVersion;
      const listenerErrors = [
        ...emitSeatStateChanged({
          direction,
          previousState,
          nextState: shortSeat,
          previousVersion,
          nextVersion: shortVersion,
        }),
        ...emitSeatTruthChanged({ direction }),
      ];
      throwIfListenerErrors(listenerErrors);
    },
    updateSeatStateWithVersionBump(
      direction: 'LONG' | 'SHORT',
      nextState: SeatState,
    ): { readonly seatVersion: number } {
      const normalizedNextState = normalizeSeatState(nextState);

      if (direction === 'LONG') {
        const previousState = longSeat;
        const previousStateEventVersion = longLastEventVersion;
        longSeat = normalizedNextState;
        longVersion += 1;
        longLastEventVersion = longVersion;
        const listenerErrors = [
          ...emitSeatStateChanged({
            direction,
            previousState,
            nextState: longSeat,
            previousVersion: previousStateEventVersion,
            nextVersion: longVersion,
          }),
          ...emitSeatTruthChanged({ direction }),
        ];
        throwIfListenerErrors(listenerErrors);
        return { seatVersion: longVersion };
      }

      const previousState = shortSeat;
      const previousStateEventVersion = shortLastEventVersion;
      shortSeat = normalizedNextState;
      shortVersion += 1;
      shortLastEventVersion = shortVersion;
      const listenerErrors = [
        ...emitSeatStateChanged({
          direction,
          previousState,
          nextState: shortSeat,
          previousVersion: previousStateEventVersion,
          nextVersion: shortVersion,
        }),
        ...emitSeatTruthChanged({ direction }),
      ];
      throwIfListenerErrors(listenerErrors);
      return { seatVersion: shortVersion };
    },
    onSeatStateChanged: (listener) => {
      seatStateChangedListeners.add(listener);
      return () => {
        seatStateChangedListeners.delete(listener);
      };
    },
    onSeatTruthChanged: (listener) => {
      seatTruthChangedListeners.add(listener);
      return () => {
        seatTruthChangedListeners.delete(listener);
      };
    },
    getSeatStateChangedListenerCount: () => seatStateChangedListeners.size,
    getSeatTruthChangedListenerCount: () => seatTruthChangedListeners.size,
    getSeatStateListenerErrors: () => [...seatStateListenerErrors],
  };
}

/**
 * 构造账户快照测试数据。
 *
 * 使用单币种最小结构覆盖买力与现金相关逻辑。
 */
export function createAccountSnapshotDouble(availableCash: string): AccountSnapshot {
  return {
    currency: 'HKD',
    totalCash: availableCash,
    netAssets: availableCash,
    positionValue: '0',
    cashInfos: [
      {
        currency: 'HKD',
        availableCash,
      },
    ],
  };
}

/**
 * 构造持仓测试数据。
 *
 * 统一最小字段，便于验证仓位数量与可卖数量逻辑。
 */
export function createPositionDouble(params: {
  readonly symbol: string;
  readonly quantity: number;
  readonly availableQuantity: number;
  readonly costPrice?: string;
}): Position {
  if (
    !Number.isSafeInteger(params.quantity) ||
    params.quantity < 0 ||
    !Number.isSafeInteger(params.availableQuantity) ||
    params.availableQuantity < 0 ||
    params.availableQuantity > params.quantity
  ) {
    throw new Error('[test double] 持仓数量必须是安全非负整数且可卖数量不得超过总量');
  }

  return {
    accountChannel: 'lb_papertrading',
    symbol: params.symbol,
    symbolName: params.symbol,
    quantity: params.quantity,
    availableQuantity: params.availableQuantity,
    currency: 'HKD',
    costPrice: params.costPrice ?? '1',
  };
}

/**
 * 构造行情快照测试数据。
 *
 * 默认前收与现价一致，减少无关价格波动影响。
 */
export function createQuoteDouble(symbol: string, price: string, lotSize: number = 100): Quote {
  return {
    symbol,
    name: symbol,
    price,
    prevClose: price,
    timestamp: Date.now(),
    lotSize,
  };
}

/**
 * 构造监控配置测试数据。
 *
 * 委托 mock/factories/configFactory.createMonitorConfig，测试需默认值时传空 overrides，需覆盖时传入部分字段。
 */
export function createMonitorConfigDouble(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return createMonitorConfig(overrides);
}

/**
 * 创建 MonitorContextAssembly 测试替身。
 *
 * 默认填充最小完整结构，允许调用方覆盖任意字段以聚焦特定断言。
 */
export function createMonitorContextDouble(
  overrides: Partial<MonitorContextAssembly> = {},
): MonitorContextAssembly {
  const config = overrides.config ?? createMonitorConfigDouble();
  const symbolRegistry = overrides.symbolRegistry ?? createSymbolRegistryDouble();

  return {
    config,
    symbolRegistry,
    seatSwitch: overrides.seatSwitch ?? createSeatSwitchWorkflowDouble(),
    strategy: overrides.strategy ?? createStrategyDouble(),
    orderRecorder: overrides.orderRecorder ?? createOrderRecorderDouble(),
    dailyLossTracker: overrides.dailyLossTracker ?? createDailyLossTrackerDouble(),
    riskChecker: overrides.riskChecker ?? createRiskCheckerDouble(),
    unrealizedLossMonitor: overrides.unrealizedLossMonitor ?? createUnrealizedLossMonitorDouble(),
    longSymbolName: overrides.longSymbolName ?? '',
    shortSymbolName: overrides.shortSymbolName ?? '',
    monitorSymbolName: overrides.monitorSymbolName ?? config.monitorSymbol,
  };
}

/** 将旧业务 fixture 的真实协作者投影为 workflow 窄能力；测试直接调用 application owner。 */
export function createSettlementBusinessDeps(params: {
  readonly monitorContext: MonitorContextAssembly;
  readonly dailyLossTracker: DailyLossTracker;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly mixedTradeLogRepository: SettlementCompletionPersistence;
}): PostTradeSettlementBusinessDeps {
  const { monitorContext, dailyLossTracker, liquidationCooldownTracker } = params;
  return {
    monitorSymbol: monitorContext.config.monitorSymbol,
    seats: {
      getSeatState: monitorContext.symbolRegistry.getSeatState,
      getSeatVersion: monitorContext.symbolRegistry.getSeatVersion,
    },
    episodes: params.protectiveLiquidationEpisodeTracker,
    completionPersistence: params.mixedTradeLogRepository,
    lossBoundaries: {
      prepareProtectionBoundary: dailyLossTracker.prepareProtectionBoundary,
      commitProtectionBoundary: dailyLossTracker.commitProtectionBoundary,
      getLossOffset: monitorContext.dailyLossTracker.getLossOffset,
    },
    cooldownTriggers: {
      recordLiquidationTrigger: (input) => {
        liquidationCooldownTracker.recordLiquidationTrigger({
          ...input,
          triggerLimit: monitorContext.config.liquidationTriggerLimit,
          cooldownConfig: monitorContext.config.liquidationCooldown,
        });
      },
    },
    riskProjection: {
      prepare: (symbol, direction, dailyLossOffset) =>
        monitorContext.riskChecker.prepareUnrealizedLossData(
          monitorContext.orderRecorder,
          symbol,
          direction === 'LONG',
          dailyLossOffset,
        ),
      publish: monitorContext.riskChecker.publishUnrealizedLossData,
    },
  };
}

/**
 * 构造交易信号测试数据。
 *
 * 默认给定席位版本与触发时间，便于流水线直接消费。
 */
export function createSignalDouble<TAction extends SignalType>(
  action: TAction,
  symbol: string,
): Signal & { readonly action: TAction; readonly seatVersion: number } {
  return {
    action,
    symbol,
    symbolName: symbol,
    seatVersion: 1,
    triggerTime: new Date(),
  };
}

/** 创建带真实首错锁存和终态语义的终止替身，按需覆盖测试观察端口。 */
export function createTerminationDouble(
  overrides: Partial<RuntimeTermination> = {},
): RuntimeTermination {
  const runtime = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  return {
    ...runtime,
    ...overrides,
    reportFatalError(error) {
      runtime.reportFatalError(error);
      overrides.reportFatalError?.(error);
    },
  };
}
