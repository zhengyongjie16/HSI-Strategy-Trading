/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 在 Trader 创建前组装唯一 RiskChecker，统一浮亏缓存与买入门禁读取
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */
import { TIME } from '../../constants/index.js';
import { createDailyLossOrderAnalysisDeps } from '../../core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../core/riskController/dailyLossTracker.js';
import { createRiskChecker } from '../../core/riskController/index.js';
import { createPositionLimitChecker } from '../../core/riskController/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../core/riskController/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../core/riskController/warrantRiskChecker.js';
import { createDoomsdayProtection } from '../../core/doomsdayProtection/index.js';
import { createSignalProcessor } from '../../core/signalProcessor/index.js';
import { createPostTradeConsistencyRuntime } from './createPostTradeConsistencyRuntime.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createMonitorTaskQueue } from '../../main/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../main/asyncProgram/tradeTaskQueue/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createTradingRiskEventRuntime } from '../../main/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import { createAutoSearchWakeupRuntime } from '../../main/autoSearchWakeupRuntime/index.js';
import { createQuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/index.js';
import { createSeatActivationDispatcher } from '../../main/seatActivationDispatcher/index.js';
import { createSeatRuntimeCleanupDispatcher } from '../../main/seatRuntimeCleanupDispatcher/index.js';
import { createTradingGateEventRuntime } from '../../main/tradingGateEventRuntime/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../../main/periodicSwitchWakeupRuntime/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createMonitorDisplayRuntime } from '../../main/monitorDisplayRuntime/index.js';
import { createTradingQuoteDisplayRuntime } from '../../main/tradingQuoteDisplayRuntime/index.js';
import { createMarketMonitor } from '../../services/marketMonitor/index.js';
import { buildPriceDisplayInfo } from '../../services/marketMonitor/priceDisplayInfo.js';
import { createLiquidationCooldownTracker } from '../../services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../services/liquidationCooldown/tradeLogHydrator.js';
import { createMixedTradeLogRepository } from '../../services/mixedTradeLogRepository/index.js';
import { createPositionCache } from '../../utils/positionCache/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import {
  calculateTradingDurationDueAtMs,
  getRequiredHKDateKey,
  toHongKongTimeIso,
} from '../../utils/time/index.js';
import { DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS } from './createPostGateRuntimeDeps.js';
import type { LastState } from '../../types/state.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../types/risk.js';
import type { OrderStateChangedEvent } from '../../types/services.js';
import type { MonitorTaskDataMap } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { QuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/types.js';
import type { CreatePostGateRuntimeParams, PostGateRuntime } from '../types.js';
import type { PersistableTradeRecord } from '../../types/trader.js';

/**
 * 创建一次性运行时绑定，显式解决互相依赖对象的构造环。
 *
 * @param name 绑定名称，用于 fail-fast 错误
 * @returns 只允许绑定一次且禁止未绑定读取的端口
 */
function createSingleAssignmentBinding<T>(name: string): Readonly<{
  bind: (value: T) => void;
  get: () => T;
}> {
  let binding: Readonly<{ value: T }> | undefined;

  return {
    bind: (value) => {
      if (binding !== undefined) {
        throw new Error(`[createPostGateRuntime] ${name} 已绑定，禁止重复绑定`);
      }

      binding = { value };
    },
    get: () => {
      if (binding === undefined) {
        throw new Error(`[createPostGateRuntime] ${name} 尚未绑定`);
      }

      return binding.value;
    },
  };
}

function hasPersistableTradeExecutionContext(
  event: OrderStateChangedEvent,
): event is OrderStateChangedEvent & {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly isLongSymbol: boolean;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
} {
  return (
    event.symbol !== null &&
    event.side !== null &&
    event.isLongSymbol !== null &&
    isValidPositiveNumber(event.executedPrice) &&
    isValidPositiveNumber(event.executedQuantity) &&
    isValidPositiveNumber(event.executedTimeMs)
  );
}

function resolveTradeAction(params: {
  readonly side: 'BUY' | 'SELL';
  readonly isLongSymbol: boolean;
}): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
  const { side, isLongSymbol } = params;
  if (side === 'BUY') {
    return isLongSymbol ? 'BUYCALL' : 'BUYPUT';
  }

  return isLongSymbol ? 'SELLCALL' : 'SELLPUT';
}

function resolveTradeReason(
  event: OrderStateChangedEvent & { readonly side: 'BUY' | 'SELL' },
): string | null {
  if (event.status === 'FILLED') {
    return null;
  }

  return event.status;
}

/**
 * 根据订单状态变化事件构造可持久化的 TradeRecord。
 *
 * @param event 订单状态变化事件
 * @returns 可写入 trade log 的记录；事件上下文不足时返回 null
 */
function resolveTradeRecordFromOrderStateChangedEvent(
  event: OrderStateChangedEvent,
  expectedMonitorSymbol: string,
): PersistableTradeRecord | null {
  if (!hasPersistableTradeExecutionContext(event)) {
    return null;
  }

  if (event.monitorSymbol !== expectedMonitorSymbol) {
    throw new Error(
      `[createPostGateRuntime] order event monitorSymbol mismatch: expected=${expectedMonitorSymbol} actual=${event.monitorSymbol}`,
    );
  }

  return {
    orderId: event.orderId,
    symbol: event.symbol,
    symbolName: null,
    monitorSymbol: event.monitorSymbol,
    action: resolveTradeAction({
      side: event.side,
      isLongSymbol: event.isLongSymbol,
    }),
    side: event.side,
    quantity: String(event.executedQuantity),
    price: String(event.executedPrice),
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: resolveTradeReason(event),
    signalTriggerTime: null,
    executedAt: toHongKongTimeIso(new Date(event.executedTimeMs)),
    executedAtMs: event.executedTimeMs,
    timestamp: toHongKongTimeIso(),
    isProtectiveClearance: event.isProtectiveLiquidation,
  };
}

/**
 * 处理订单状态事件并持久化 trade log；旧日志损坏或根节点结构错误时直接抛错。
 *
 * @param params 运行时环境与订单状态事件
 */
function persistTradeRecordFromOrderStateChangedEvent(params: {
  readonly event: OrderStateChangedEvent;
  readonly expectedMonitorSymbol: string;
  readonly appendTradeRecord: (record: PersistableTradeRecord) => void;
}): void {
  const tradeRecord = resolveTradeRecordFromOrderStateChangedEvent(
    params.event,
    params.expectedMonitorSymbol,
  );
  if (tradeRecord === null) {
    return;
  }

  params.appendTradeRecord(tradeRecord);
}

function persistProtectiveLiquidationExecutionProgress(params: {
  readonly repository: ReturnType<typeof createMixedTradeLogRepository>;
  readonly input: ProtectiveLiquidationExecutionProgressInput;
}): void {
  const { repository, input } = params;
  repository.appendExecutionProgressIdempotent(input);
}

/**
 * 创建 post-gate runtime 工厂。
 *
 * @param deps post-gate 创建链路中的可注入依赖
 * @returns post-gate runtime 创建函数
 */
function createPostGateRuntimeFactory(
  deps: typeof DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
): (params: CreatePostGateRuntimeParams) => Promise<PostGateRuntime | null> {
  const { createTrader: buildTrader, createMonitorContext: buildMonitorContext } = deps;

  return async function createPostGateRuntime(
    params: CreatePostGateRuntimeParams,
  ): Promise<PostGateRuntime | null> {
    const {
      env,
      preGateRuntime,
      now,
      clock,
      scheduler,
      cleanup,
      logger,
      termination,
      resources,
      strategy,
    } = params;
    const {
      config,
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      startupTradingDayInfo,
      warrantListCacheConfig,
    } = preGateRuntime;
    const riskChecker = createRiskChecker({
      warrantRiskChecker: createWarrantRiskChecker(),
      positionLimitChecker: createPositionLimitChecker({
        maxPositionNotional: tradingConfig.monitor.maxPositionNotional,
      }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: tradingConfig.monitor.maxUnrealizedLossPerSymbol,
      }),
    });
    const liquidationCooldownTracker = createLiquidationCooldownTracker({
      nowMs: () => clock.now().getTime(),
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      toHongKongTimeIso,
    });
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const mixedTradeLogRepository = createMixedTradeLogRepository({
      resolveLogRootDir: () => resolveLogRootDir(env),
    });
    const initialDayKey = getRequiredHKDateKey(now);
    const initialTradingDayInfo =
      startupTradingDayInfo !== null && startupTradingDayInfo.dateKey === initialDayKey
        ? startupTradingDayInfo.info
        : null;
    const lastState: LastState = {
      canTrade: null,
      isHalfDay: null,
      openProtectionActive: null,
      currentDayKey: initialDayKey,
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
      cachedAccount: null,
      cachedPositions: [],
      positionCache: createPositionCache(),
      cachedTradingDayInfo:
        initialTradingDayInfo === null
          ? null
          : {
              dateKey: initialDayKey,
              info: initialTradingDayInfo,
            },
      tradingCalendarSnapshot:
        initialTradingDayInfo === null
          ? new Map()
          : new Map([[initialDayKey, initialTradingDayInfo]]),
      allTradingSymbols: new Set(),
    };
    resources.lastState = lastState;
    cleanup.register({
      phase: 'CLOSE_TRADING_GATE',
      step: '关闭交易门禁',
      handler: () => {
        lastState.isTradingEnabled = false;
      },
    });

    if (termination.isTerminated()) return null;

    const traderBinding =
      createSingleAssignmentBinding<
        Awaited<ReturnType<(typeof DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS)['createTrader']>>
      >('Trader');
    const quoteSubscriptionRuntimeBinding = createSingleAssignmentBinding<QuoteSubscriptionRuntime>(
      'QuoteSubscriptionRuntime',
    );
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      termination,
      getTrader: traderBinding.get,
      lastState,
      onPositionsCommitted: async () => {
        await quoteSubscriptionRuntimeBinding.get().reconcilePositionHoldFromCurrentTruth();
      },
      scheduler,
    });
    resources.postTradeConsistencyRuntime = postTradeConsistencyRuntime;
    cleanup.register({
      phase: 'ABORT_FRESHNESS_WAITING',
      step: '终止 Freshness 等待',
      handler: () => {
        postTradeConsistencyRuntime.abortWaiting();
      },
    });

    if (termination.isTerminated()) return null;

    cleanup.register({
      phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
      step: '停止 PostTradeConsistencyRuntime',
      handler: () => postTradeConsistencyRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const trader = await buildTrader({
      config,
      tradingConfig,
      marketDataClient,
      unrealizedLossBuyGate: riskChecker,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress: (input) => {
        persistProtectiveLiquidationExecutionProgress({
          repository: mixedTradeLogRepository,
          input,
        });
      },
      postTradeConsistencyRuntime,
      isExecutionAllowed: () => !termination.isTerminated() && lastState.isTradingEnabled,
      isContinuousTradingAllowed: () =>
        !termination.isTerminated() && lastState.isTradingEnabled && lastState.canTrade === true,
      now: clock.now,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
      readCurrentTradingDayInfo: () => lastState.cachedTradingDayInfo,
      termination,
    });
    traderBinding.bind(trader);
    resources.trader = trader;
    cleanup.register({
      phase: 'STOP_ORDER_MONITOR_RUNTIME',
      step: '停止订单监控 runtime',
      handler: () => trader.stopOrderMonitorRuntimeAndDrain(),
    });

    cleanup.register({
      phase: 'TEARDOWN_TRADER',
      step: '退订 Trader Private 主题',
      handler: () => trader.teardown(),
    });

    if (termination.isTerminated()) return null;

    const tradeLogHydrator = createTradeLogHydrator({
      nowMs: () => clock.now().getTime(),
      logger,
      tradingConfig,
      liquidationCooldownTracker,
      mixedTradeLogRepository,
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    resources.buyTaskQueue = buyTaskQueue;
    resources.sellTaskQueue = sellTaskQueue;
    resources.monitorTaskQueue = monitorTaskQueue;
    const seatActivationDispatcher = createSeatActivationDispatcher({
      termination,
      symbolRegistry,
      monitorTaskQueue,
    });
    resources.seatActivationDispatcher = seatActivationDispatcher;
    cleanup.register({
      phase: 'STOP_SEAT_ACTIVATION_DISPATCHER',
      step: '停止 SeatActivationDispatcher',
      handler: () => {
        seatActivationDispatcher.stop();
      },
    });

    if (termination.isTerminated()) return null;

    const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
      marketDataClient,
      trader,
      lastState,
      tradingConfig,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      tradeLogHydrator,
      mixedTradeLogRepository,
      warrantListCacheConfig,
      seatActivationDispatcher,
      reportFatalError: termination.reportFatalError,
    });
    const marketMonitor = createMarketMonitor();
    const doomsdayProtection = createDoomsdayProtection({ now: clock.now });
    const doomsdayProtectionEnabled = tradingConfig.global.doomsdayProtection;
    const tradingGateEventRuntime = createTradingGateEventRuntime({ logger });

    const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
      logger,
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      lastState,
      termination,
    });
    quoteSubscriptionRuntimeBinding.bind(quoteSubscriptionRuntime);
    resources.quoteSubscriptionRuntime = quoteSubscriptionRuntime;
    cleanup.register({
      phase: 'STOP_QUOTE_SUBSCRIPTION_RUNTIME',
      step: '停止 QuoteSubscriptionRuntime',
      handler: () => quoteSubscriptionRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const unsubscribeOrderStateChanged = trader.onOrderStateChanged((event) => {
      try {
        persistTradeRecordFromOrderStateChangedEvent({
          event,
          expectedMonitorSymbol: tradingConfig.monitor.monitorSymbol,
          appendTradeRecord: mixedTradeLogRepository.appendTradeRecord,
        });
      } catch (error) {
        termination.reportFatalError(error);
        throw error;
      }
    });
    cleanup.register({
      phase: 'UNSUBSCRIBE_TRADER_LISTENER',
      step: '取消 Trader 订单状态监听',
      handler: unsubscribeOrderStateChanged,
    });

    if (termination.isTerminated()) return null;

    const monitorContext = buildMonitorContext({
      preGateRuntime,
      postGateRuntime: {
        trader,
        dailyLossTracker,
        riskChecker,
        lastState,
      },
      quotesMap: null,
      clock,
      strategy,
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker,
      protectiveLiquidationEpisodeTracker,
      mixedTradeLogRepository,
    });

    const tradingRiskEventRuntime = createTradingRiskEventRuntime({
      logger,
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      now: clock.now,
      termination,
    });
    resources.tradingRiskEventRuntime = tradingRiskEventRuntime;
    cleanup.register({
      phase: 'STOP_TRADING_RISK_EVENT_RUNTIME',
      step: '停止 TradingRiskEventRuntime',
      handler: () => tradingRiskEventRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const switchWakeupRuntime = createSwitchWakeupRuntime({
      logger,
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
      now: clock.now,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
      termination,
    });
    resources.switchWakeupRuntime = switchWakeupRuntime;
    cleanup.register({
      phase: 'STOP_SWITCH_WAKEUP_RUNTIME',
      step: '停止 SwitchWakeupRuntime',
      handler: () => switchWakeupRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
      logger,
      marketDataClient,
      monitorContext,
      trader,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
      now: clock.now,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
      termination,
    });
    resources.monitorQuoteEventRuntime = monitorQuoteEventRuntime;
    cleanup.register({
      phase: 'STOP_MONITOR_QUOTE_EVENT_RUNTIME',
      step: '停止 MonitorQuoteEventRuntime',
      handler: () => monitorQuoteEventRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const monitorDisplayRuntime = createMonitorDisplayRuntime({
      marketDataClient,
      monitorContext,
      lastState,
      marketMonitor,
    });
    cleanup.register({
      phase: 'STOP_MONITOR_DISPLAY_RUNTIME',
      step: '停止 MonitorDisplayRuntime',
      handler: () => monitorDisplayRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const tradingQuoteDisplayRuntime = createTradingQuoteDisplayRuntime({
      logger,
      marketDataClient,
      symbolRegistry,
      monitorContext,
      lastState,
      renderTradingQuote: (renderParams) => {
        const displayInfo = buildPriceDisplayInfo({
          seatActive: true,
          symbol: renderParams.tradingSymbol,
          monitorCurrentPrice: renderParams.monitorQuote?.price ?? null,
          quotePrice: renderParams.event.quote.price,
          isLongSymbol: renderParams.direction === 'LONG',
          riskChecker: monitorContext.riskChecker,
          orderRecorder: monitorContext.orderRecorder,
        });
        marketMonitor.renderTradingQuote({
          event: renderParams.event,
          tradingSymbol: renderParams.tradingSymbol,
          direction: renderParams.direction,
          displayInfo,
        });
      },
      termination,
    });
    resources.tradingQuoteDisplayRuntime = tradingQuoteDisplayRuntime;
    cleanup.register({
      phase: 'STOP_TRADING_QUOTE_DISPLAY_RUNTIME',
      step: '停止 TradingQuoteDisplayRuntime',
      handler: () => tradingQuoteDisplayRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker,
      reportFatalError: termination.reportFatalError,
    });
    const seatRuntimeCleanupDispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });
    resources.seatRuntimeCleanupDispatcher = seatRuntimeCleanupDispatcher;
    cleanup.register({
      phase: 'STOP_SEAT_RUNTIME_CLEANUP_DISPATCHER',
      step: '停止 SeatRuntimeCleanupDispatcher',
      handler: () => {
        seatRuntimeCleanupDispatcher.stop();
      },
    });

    if (termination.isTerminated()) return null;

    const autoSearchWakeupRuntime = createAutoSearchWakeupRuntime({
      termination,
      symbolRegistry,
      monitorContext,
      lastState,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled,
      now: clock.now,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
    });
    resources.autoSearchWakeupRuntime = autoSearchWakeupRuntime;
    cleanup.register({
      phase: 'STOP_AUTO_SEARCH_WAKEUP_RUNTIME',
      step: '停止 AutoSearchWakeupRuntime',
      handler: () => autoSearchWakeupRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      termination,
      monitorContext,
      symbolRegistry,
      monitorTaskQueue,
      trader,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime,
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * TIME.MILLISECONDS_PER_MINUTE,
          calendarSnapshot: lastState.tradingCalendarSnapshot,
        }),
      now: clock.now,
      scheduleTimer: scheduler.scheduleTimer,
      clearTimer: scheduler.clearTimer,
    });
    resources.periodicSwitchWakeupRuntime = periodicSwitchWakeupRuntime;
    cleanup.register({
      phase: 'STOP_PERIODIC_SWITCH_WAKEUP_RUNTIME',
      step: '停止 PeriodicSwitchWakeupRuntime',
      handler: () => periodicSwitchWakeupRuntime.stopAndDrain(),
    });

    if (termination.isTerminated()) return null;

    return {
      liquidationCooldownTracker,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      monitorContext,
      tradingGateEventRuntime,
      quoteSubscriptionRuntime,
      seatActivationDispatcher,
      seatRuntimeCleanupDispatcher,
      autoSearchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      tradingRiskEventRuntime,
      monitorQuoteEventRuntime,
      monitorDisplayRuntime,
      tradingQuoteDisplayRuntime,
      switchWakeupRuntime,
      postTradeConsistencyRuntime,
      lastState,
      trader,
      loadTradingDayRuntimeSnapshot,
      doomsdayProtection,
      signalProcessor,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    };
  };
}

export const createPostGateRuntime = createPostGateRuntimeFactory(
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
);
