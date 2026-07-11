/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */
import fs from 'node:fs';
import path from 'node:path';
import { INDICATOR_CACHE, LOGGING, TIME, TRADING, VERIFICATION } from '../../constants/index.js';
import { createTrader } from '../../core/trader/index.js';
import { createDailyLossOrderAnalysisDeps } from '../../core/orderRecorder/index.js';
import { createDailyLossTracker } from '../../core/riskController/dailyLossTracker.js';
import { createDoomsdayProtection } from '../../core/doomsdayProtection/index.js';
import { createSignalProcessor } from '../../core/signalProcessor/index.js';
import { createMonitorContext } from '../context/createMonitorContext.js';
import { createPostTradeConsistencyRuntime } from './createPostTradeConsistencyRuntime.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createIndicatorCache } from '../../main/asyncProgram/indicatorCache/index.js';
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
import { createPositionCache } from '../../utils/positionCache/index.js';
import { initMonitorState, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { buildTradeLogPath } from '../../utils/trading/tradeLogPath.js';
import {
  calculateTradingDurationDueAtMs,
  getRequiredHKDateKey,
  toHongKongTimeIso,
} from '../../utils/time/index.js';
import { logger, retainLatestLogFiles } from '../../utils/logger/index.js';
import { toError } from '../../utils/error/index.js';
import type { LastState } from '../../types/state.js';
import type { OrderStateChangedEvent } from '../../types/services.js';
import type { MonitorTaskDataMap } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { QuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/types.js';
import type {
  CreatePostGateRuntimeParams,
  PersistableTradeRecord,
  PostGateRuntime,
} from '../types.js';
import type { CreatePostGateRuntimeDeps, SingleAssignmentBinding } from './types.js';

const DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: CreatePostGateRuntimeDeps = {
  createTrader,
  createMonitorContext,
};

/**
 * 创建一次性运行时绑定，显式解决互相依赖对象的构造环。
 *
 * @param name 绑定名称，用于 fail-fast 错误
 * @returns 只允许绑定一次且禁止未绑定读取的端口
 */
function createSingleAssignmentBinding<T>(name: string): SingleAssignmentBinding<T> {
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
  if (event.isProtectiveLiquidation && event.side === 'SELL' && event.status === 'FILLED') {
    return TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON;
  }

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
  readonly env: NodeJS.ProcessEnv;
  readonly event: OrderStateChangedEvent;
  readonly expectedMonitorSymbol: string;
}): void {
  const tradeRecord = resolveTradeRecordFromOrderStateChangedEvent(
    params.event,
    params.expectedMonitorSymbol,
  );
  if (tradeRecord === null) {
    return;
  }

  const logRootDir = resolveLogRootDir(params.env);
  const logDir = path.join(logRootDir, 'trades');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = buildTradeLogPath(logRootDir, new Date(tradeRecord.executedAtMs));
  retainLatestLogFiles(logDir, LOGGING.MAX_RETAINED_LOG_FILES, 'json', path.basename(logFile));

  let records: unknown[] = [];
  if (fs.existsSync(logFile)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new TypeError('[createPostGateRuntime] trade log 根节点必须为数组');
    }

    records = parsed;
  }

  records.push(tradeRecord);
  fs.writeFileSync(logFile, JSON.stringify(records, null, 2), 'utf8');
}

/**
 * 创建 post-gate runtime 工厂。
 *
 * @param deps post-gate 创建链路中的可注入依赖
 * @returns post-gate runtime 创建函数
 */
export function createPostGateRuntimeFactory(
  deps: CreatePostGateRuntimeDeps,
): (params: CreatePostGateRuntimeParams) => Promise<PostGateRuntime> {
  const { createTrader: buildTrader, createMonitorContext: buildMonitorContext } = deps;

  return async function createPostGateRuntime(
    params: CreatePostGateRuntimeParams,
  ): Promise<PostGateRuntime> {
    const { env, preGateRuntime, now, cleanup } = params;
    const {
      config,
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      startupTradingDayInfo,
      warrantListCacheConfig,
    } = preGateRuntime;
    const liquidationCooldownTracker = createLiquidationCooldownTracker({
      nowMs: () => Date.now(),
    });
    const dailyLossTracker = createDailyLossTracker({
      ...createDailyLossOrderAnalysisDeps(),
      toHongKongTimeIso,
    });
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
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
      targetTradingDayKey: null,
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
      monitorState: initMonitorState(tradingConfig.monitor),
      allTradingSymbols: new Set(),
    };
    cleanup.register({
      phase: 'CLOSE_TRADING_GATE',
      step: '关闭交易门禁',
      handler: () => {
        lastState.isTradingEnabled = false;
      },
    });

    cleanup.register({
      phase: 'CLEAR_MONITOR_SNAPSHOT',
      step: '清空监控快照引用',
      handler: () => {
        lastState.monitorState.lastMonitorSnapshot = null;
      },
    });

    const traderBinding =
      createSingleAssignmentBinding<Awaited<ReturnType<typeof createTrader>>>('Trader');
    const quoteSubscriptionRuntimeBinding = createSingleAssignmentBinding<QuoteSubscriptionRuntime>(
      'QuoteSubscriptionRuntime',
    );
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      getTrader: traderBinding.get,
      lastState,
      onPositionsCommitted: async () => {
        await quoteSubscriptionRuntimeBinding.get().reconcilePositionHoldFromCurrentTruth();
      },
    });
    cleanup.register({
      phase: 'ABORT_FRESHNESS_WAITING',
      step: '终止 Freshness 等待',
      handler: () => {
        postTradeConsistencyRuntime.abortWaiting();
      },
    });

    cleanup.register({
      phase: 'STOP_POST_TRADE_CONSISTENCY_RUNTIME',
      step: '停止 PostTradeConsistencyRuntime',
      handler: () => postTradeConsistencyRuntime.stopAndDrain(),
    });
    let fatalError: Error | null = null;
    const fatalRejectors = new Set<(error: Error) => void>();

    const handleFatalError = (error: unknown): void => {
      if (fatalError !== null) {
        return;
      }

      fatalError = toError(error);
      for (const reject of fatalRejectors) {
        reject(fatalError);
      }

      fatalRejectors.clear();
    };

    const drainFatalError = (): Promise<never> => {
      if (fatalError !== null) {
        return Promise.reject(fatalError);
      }

      return new Promise<never>((_, reject) => {
        fatalRejectors.add(reject);
      });
    };

    const trader = await buildTrader({
      config,
      tradingConfig,
      marketDataClient,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      postTradeConsistencyRuntime,
      isExecutionAllowed: () => lastState.isTradingEnabled,
      onFatalError: handleFatalError,
    });
    traderBinding.bind(trader);
    cleanup.register({
      phase: 'STOP_ORDER_MONITOR_RUNTIME',
      step: '停止订单监控 runtime',
      handler: () => trader.stopOrderMonitorRuntimeAndDrain(),
    });
    const tradeLogHydrator = createTradeLogHydrator({
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      resolveLogRootDir: () => resolveLogRootDir(env),
      nowMs: () => Date.now(),
      logger,
      tradingConfig,
      liquidationCooldownTracker,
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const seatActivationDispatcher = createSeatActivationDispatcher({
      symbolRegistry,
      monitorTaskQueue,
    });
    cleanup.register({
      phase: 'STOP_SEAT_ACTIVATION_DISPATCHER',
      step: '停止 SeatActivationDispatcher',
      handler: () => {
        seatActivationDispatcher.stop();
      },
    });

    const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
      marketDataClient,
      trader,
      lastState,
      tradingConfig,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      tradeLogHydrator,
      warrantListCacheConfig,
      seatActivationDispatcher,
    });
    const marketMonitor = createMarketMonitor();
    const doomsdayProtection = createDoomsdayProtection();
    const doomsdayProtectionEnabled = tradingConfig.global.doomsdayProtection;
    const tradingGateEventRuntime = createTradingGateEventRuntime();

    const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      lastState,
      onFatalError: handleFatalError,
    });
    quoteSubscriptionRuntimeBinding.bind(quoteSubscriptionRuntime);
    cleanup.register({
      phase: 'STOP_QUOTE_SUBSCRIPTION_RUNTIME',
      step: '停止 QuoteSubscriptionRuntime',
      handler: () => quoteSubscriptionRuntime.stopAndDrain(),
    });

    const unsubscribeOrderStateChanged = trader.onOrderStateChanged((event) => {
      try {
        persistTradeRecordFromOrderStateChangedEvent({
          env,
          event,
          expectedMonitorSymbol: tradingConfig.monitor.monitorSymbol,
        });
      } catch (error) {
        handleFatalError(error);
        throw error;
      }
    });
    cleanup.register({
      phase: 'UNSUBSCRIBE_TRADER_LISTENER',
      step: '取消 Trader 订单状态监听',
      handler: unsubscribeOrderStateChanged,
    });

    const maxDelaySeconds = Math.max(
      tradingConfig.monitor.verificationConfig.buy.delaySeconds,
      tradingConfig.monitor.verificationConfig.sell.delaySeconds,
    );
    const indicatorCacheRetentionSeconds =
      maxDelaySeconds +
      VERIFICATION.READY_DELAY_SECONDS +
      INDICATOR_CACHE.RETENTION_SAFETY_MARGIN_SECONDS;
    // 额外保留缓存安全余量，确保延迟验证读取最近样本时窗口充足。
    const indicatorCache = createIndicatorCache({
      retentionWindowMs: indicatorCacheRetentionSeconds * TIME.MILLISECONDS_PER_SECOND,
    });
    cleanup.register({
      phase: 'CLEAR_INDICATOR_CACHE',
      step: '清空指标缓存',
      handler: () => {
        indicatorCache.clearAll();
      },
    });

    const monitorContext = buildMonitorContext({
      preGateRuntime,
      postGateRuntime: {
        trader,
        dailyLossTracker,
        indicatorCache,
        lastState,
      },
      quotesMap: null,
    });
    cleanup.register({
      phase: 'DESTROY_DELAYED_SIGNAL_VERIFIER',
      step: `销毁延迟验证器 ${monitorContext.config.monitorSymbol}`,
      handler: () => {
        monitorContext.delayedSignalVerifier.destroy();
      },
    });

    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker,
      protectiveLiquidationEpisodeTracker,
    });

    const tradingRiskEventRuntime = createTradingRiskEventRuntime({
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      now: () => new Date(),
      onFatalError: handleFatalError,
    });
    cleanup.register({
      phase: 'STOP_TRADING_RISK_EVENT_RUNTIME',
      step: '停止 TradingRiskEventRuntime',
      handler: () => tradingRiskEventRuntime.stopAndDrain(),
    });
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
      onFatalError: handleFatalError,
    });
    cleanup.register({
      phase: 'STOP_SWITCH_WAKEUP_RUNTIME',
      step: '停止 SwitchWakeupRuntime',
      handler: () => switchWakeupRuntime.stopAndDrain(),
    });
    const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
      marketDataClient,
      monitorContext,
      trader,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
      now: () => new Date(),
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
      onFatalError: handleFatalError,
    });
    cleanup.register({
      phase: 'STOP_MONITOR_QUOTE_EVENT_RUNTIME',
      step: '停止 MonitorQuoteEventRuntime',
      handler: () => monitorQuoteEventRuntime.stopAndDrain(),
    });
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
    const tradingQuoteDisplayRuntime = createTradingQuoteDisplayRuntime({
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
          ...renderParams,
          monitorSymbol: monitorContext.config.monitorSymbol,
          displayInfo,
        });
      },
      onFatalError: handleFatalError,
    });
    cleanup.register({
      phase: 'STOP_TRADING_QUOTE_DISPLAY_RUNTIME',
      step: '停止 TradingQuoteDisplayRuntime',
      handler: () => tradingQuoteDisplayRuntime.stopAndDrain(),
    });
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker,
    });
    const seatRuntimeCleanupDispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });
    cleanup.register({
      phase: 'STOP_SEAT_RUNTIME_CLEANUP_DISPATCHER',
      step: '停止 SeatRuntimeCleanupDispatcher',
      handler: () => {
        seatRuntimeCleanupDispatcher.stop();
      },
    });

    const autoSearchWakeupRuntime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState,
      tradingGateEventRuntime,
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    cleanup.register({
      phase: 'STOP_AUTO_SEARCH_WAKEUP_RUNTIME',
      step: '停止 AutoSearchWakeupRuntime',
      handler: () => autoSearchWakeupRuntime.stopAndDrain(),
    });
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
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
          calendarSnapshot: lastState.tradingCalendarSnapshot ?? new Map(),
        }),
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    cleanup.register({
      phase: 'STOP_PERIODIC_SWITCH_WAKEUP_RUNTIME',
      step: '停止 PeriodicSwitchWakeupRuntime',
      handler: () => periodicSwitchWakeupRuntime.stopAndDrain(),
    });

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
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      drainFatalError,
    };
  };
}

export const createPostGateRuntime = createPostGateRuntimeFactory(
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
);
