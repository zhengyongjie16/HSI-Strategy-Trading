/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 在 Trader 创建前组装唯一 RiskChecker，统一浮亏缓存与买入门禁读取
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */

import { createAccountPositionSnapshot } from '../../application/accountPositionSnapshot/index.js';
import { createWarrantCandidateSearch } from '../../application/autoSearch/candidateSearch.js';
import { createAutoSearch } from '../../application/autoSearch/index.js';
import { createStartupSeatSearch } from '../../application/autoSearch/startupSeatSearch.js';
import { createDoomsdayClearanceWorkflow } from '../../application/doomsdayClearance/index.js';
import { createOrdinaryBuyWorkflow } from '../../application/ordinaryBuy/index.js';
import { createOrdinarySellWorkflow } from '../../application/ordinarySell/index.js';
import { createProtectiveLiquidationWorkflow } from '../../application/protectiveLiquidation/index.js';
import { createTradeLogHydrator } from '../../application/protectiveLiquidation/tradeLogHydrator.js';
import { createWarrantRiskRefresh } from '../../application/riskRefresh/warrantRiskRefresh.js';
import { createSeatActivationWorkflow } from '../../application/seatActivation/index.js';
import { createStaticLiquidationExecutor } from '../../application/staticLiquidation/index.js';
import { TIME } from '../../constants/index.js';
import { createLiquidationCooldownTracker } from '../../domain/liquidation/cooldown/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/index.js';
import { orderAnalysis } from '../../domain/order/orderAnalysis.js';
import { orderEconomics } from '../../domain/order/orderEconomics.js';
import { createDailyLossTracker } from '../../domain/risk/dailyLossTracker.js';
import { createRiskChecker } from '../../domain/risk/index.js';
import { createPositionLimitChecker } from '../../domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../domain/risk/warrantRiskChecker.js';
import { ordinarySignalGuard } from '../../domain/strategy/ordinarySignalGuard.js';
import { createMarketMonitor } from '../../infrastructure/display/marketMonitor/index.js';
import { buildPriceDisplayInfo } from '../../infrastructure/display/marketMonitor/priceDisplayInfo.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createMonitorDisplayRuntime } from '../../main/monitorDisplayRuntime/index.js';
import { createQuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/index.js';
import type { QuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/types.js';
import { createTradingGateEventRuntime } from '../../main/tradingGateEventRuntime/index.js';
import { createTradingQuoteDisplayRuntime } from '../../main/tradingQuoteDisplayRuntime/index.js';
import type { MonitorTaskDataMap } from '../../runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../runtime/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../runtime/asyncProgram/tradeTaskQueue/index.js';
import { createAutoSearchWakeupRuntime } from '../../runtime/autoSearchWakeupRuntime/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createPeriodicSwitchWakeupRuntime } from '../../runtime/periodicSwitchWakeupRuntime/index.js';
import { createSeatActivationDispatcher } from '../../runtime/seatActivationDispatcher/index.js';
import { createSeatRuntimeCleanupDispatcher } from '../../runtime/seatRuntimeCleanupDispatcher/index.js';
import { createTradingRiskEventRuntime } from '../../runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import type { OrderStateChangedEvent } from '../../types/services.js';
import type { LastState } from '../../types/state.js';
import type { PersistableTradeRecord } from '../../types/trader.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { exactCompare, formatDecimal } from '../../utils/numeric/exact.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import {
  calculateTradingDurationDueAtMs,
  getRequiredHKDateKey,
  getTradingMinutesSinceOpen,
  toHongKongTimeIso,
} from '../../utils/time/index.js';
import type { CreatePostGateRuntimeParams, PostGateRuntime } from '../types.js';
import { DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS } from './createPostGateRuntimeDeps.js';
import { createPostTradeConsistencyRuntime } from './createPostTradeConsistencyRuntime.js';

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
  readonly executedPrice: string;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
} {
  return (
    event.symbol !== null &&
    event.side !== null &&
    event.isLongSymbol !== null &&
    event.executedPrice !== null &&
    exactCompare(event.executedPrice, '0') > 0 &&
    event.executedQuantity !== null &&
    Number.isSafeInteger(event.executedQuantity) &&
    event.executedQuantity > 0 &&
    event.executedTimeMs !== null &&
    Number.isSafeInteger(event.executedTimeMs) &&
    event.executedTimeMs > 0
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
    price: event.executedPrice,
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

/**
 * 创建 post-gate runtime 工厂。
 *
 * @param deps post-gate 创建链路中的可注入依赖
 * @returns post-gate runtime 创建函数
 */
function createPostGateRuntimeFactory(
  deps: typeof DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
): (params: CreatePostGateRuntimeParams) => Promise<PostGateRuntime | null> {
  const {
    createTrader: buildTrader,
    createMonitorContext: buildMonitorContext,
    createMixedTradeLogRepository: buildMixedTradeLogRepository,
  } = deps;

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
      brokerClientFactory,
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      startupTradingDayInfo,
    } = preGateRuntime;
    const warrantRiskChecker = createWarrantRiskChecker({
      onInvalidCallPrice: (symbol, callPrice) => {
        logger.warn(`[风险检查] ${symbol} 的回收价无效（${callPrice}），拒绝买入`);
      },
      onWarrantInfoSet: (symbol, callPrice, isLongSymbol, symbolName) => {
        logger.info(
          `[风险检查] ${isLongSymbol ? '做多' : '做空'}标的 ${formatSymbolDisplay(symbol, symbolName)}，回收价=${formatDecimal(callPrice, 3, 'unsigned')}`,
        );
      },
    });
    const warrantRiskRefresh = createWarrantRiskRefresh({
      marketDataClient,
      warrantRiskChecker,
      logger,
    });
    const riskChecker = createRiskChecker({
      warrantRiskChecker,
      positionLimitChecker: createPositionLimitChecker({
        maxPositionNotional: tradingConfig.monitor.maxPositionNotional,
      }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: tradingConfig.monitor.maxUnrealizedLossPerSymbol,
        onMissingData: (symbol) => {
          logger.warn(`[浮亏监控] ${symbol} 浮亏数据未初始化，跳过检查`);
        },
      }),
    });
    const liquidationCooldownTracker = createLiquidationCooldownTracker();
    const dailyLossTracker = createDailyLossTracker({
      ...orderAnalysis,
      toHongKongTimeIso,
      onOwnershipWarning: logger.warn,
    });
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const mixedTradeLogRepository = buildMixedTradeLogRepository({
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
    const snapshot = createAccountPositionSnapshot({
      dayEpoch: 0,
      scheduler: {
        schedule: (callback) => {
          scheduler.scheduleTimer(callback, 0);
        },
      },
      readPort: {
        getAccountSnapshot: () => traderBinding.get().getAccountSnapshot(),
        getStockPositions: () => traderBinding.get().getStockPositions(),
      },
      reportFatalError: termination.reportFatalError,
    });
    resources.snapshot = snapshot;
    let snapshotDrain: Promise<void> | null = null;
    const closeSnapshotAdmission = (): void => {
      if (snapshotDrain !== null) return;

      snapshotDrain = snapshot.requestClear({
        reason: 'STOP',
        dayEpoch: snapshot.getView().token.dayEpoch,
      });
      void snapshotDrain.catch(termination.reportFatalError);
    };
    resources.closeSnapshotAdmission = closeSnapshotAdmission;
    cleanup.register({
      phase: 'CLOSE_TRADING_GATE',
      step: '关闭 Snapshot 准入并取消旧等待',
      handler: closeSnapshotAdmission,
    });

    cleanup.register({
      phase: 'STOP_ACCOUNT_POSITION_SNAPSHOT',
      step: '排空 Snapshot 券商读取',
      handler: async () => {
        if (snapshotDrain !== null) await snapshotDrain;
      },
    });
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      termination,
      getTrader: traderBinding.get,
      snapshot,
      onPositionsCommitted: async (token) => {
        await quoteSubscriptionRuntimeBinding.get().reconcilePositionHoldFromCurrentTruth(token);
        // S owner 在此 awaited ack 后按原 token/席位/水位复核；对账不签发 ready。
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
      brokerAccess: () => brokerClientFactory.createBrokerAccess(orderEconomics),
      tradingConfig,
      marketDataClient,
      unrealizedLossBuyGate: riskChecker,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress:
        mixedTradeLogRepository.appendExecutionProgressIdempotent,
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
      snapshot,
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

    const candidateSearch = createWarrantCandidateSearch({
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      autoSearchConfig: tradingConfig.monitor.autoSearchConfig,
      marketDataClient,
      logger,
      getTradingMinutesSinceOpen,
    });
    const startupSeatSearch = createStartupSeatSearch({
      monitorSymbol: tradingConfig.monitor.monitorSymbol,
      symbolRegistry,
      candidateSearch,
      logger,
    });
    const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
      marketDataClient,
      trader,
      lastState,
      snapshot,
      tradingConfig,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      tradeLogHydrator,
      mixedTradeLogRepository,
      protectionRecovery: postTradeConsistencyRuntime,
      startupSeatSearch,
      seatActivationDispatcher,
      reportFatalError: termination.reportFatalError,
    });
    const marketMonitor = createMarketMonitor();
    const doomsdayClearanceWorkflow = createDoomsdayClearanceWorkflow({
      now: clock.now,
      logger,
    });
    const doomsdayProtectionEnabled = tradingConfig.global.doomsdayProtection;
    const tradingGateEventRuntime = createTradingGateEventRuntime({ logger });

    const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
      logger,
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      lastState,
      snapshot,
      termination,
    });
    quoteSubscriptionRuntimeBinding.bind(quoteSubscriptionRuntime);
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
        candidateSearch,
        lastState,
      },
      quotesMap: null,
      clock,
      strategy,
    });
    const seatActivation = createSeatActivationWorkflow({
      clock,
      config: monitorContext.config,
      symbolRegistry,
      orders: monitorContext.orderRecorder,
      dailyLoss: dailyLossTracker,
      risk: {
        prepareUnrealizedLossData: (symbol, isLong, lossOffset) =>
          riskChecker.prepareUnrealizedLossData(
            monitorContext.orderRecorder,
            symbol,
            isLong,
            lossOffset,
          ),
        publishUnrealizedLossData: riskChecker.publishUnrealizedLossData,
        setWarrantInfoFromCallPrice: riskChecker.setWarrantInfoFromCallPrice,
      },
      snapshot,
      subscriptions: quoteSubscriptionRuntime,
      getQuotes: marketDataClient.getQuotes,
      setDirectionSymbolName: (direction, name) => {
        if (direction === 'LONG') monitorContext.longSymbolName = name;
        else monitorContext.shortSymbolName = name;
      },
      logger,
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext,
      dailyLossTracker,
      liquidationCooldownTracker,
      protectiveLiquidationEpisodeTracker,
      mixedTradeLogRepository,
    });

    const protectiveLiquidationWorkflow = createProtectiveLiquidationWorkflow({
      logger,
      trader,
      symbolRegistry,
      monitorContext,
      lastState,
      snapshot,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      now: clock.now,
      termination,
    });
    const tradingRiskEventRuntime = createTradingRiskEventRuntime({
      logger,
      marketDataClient,
      symbolRegistry,
      postTradeConsistencyRuntime,
      workflow: protectiveLiquidationWorkflow,
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
      snapshot,
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

    const executeStaticLiquidation = createStaticLiquidationExecutor({
      trader,
      marketDataClient,
      snapshot,
      postTradeConsistencyRuntime,
      now: clock.now,
    });
    const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
      logger,
      marketDataClient,
      monitorContext,
      executeStaticLiquidation,
      lastState,
      snapshot,
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

    const canProcessOrdinaryTradeTask = (): boolean =>
      !termination.isTerminated() &&
      ordinarySignalGuard({
        lastState,
        now: clock.now(),
        doomsdayProtectionEnabled,
      });
    const ordinaryBuy = createOrdinaryBuyWorkflow({
      logger,
      config: monitorContext.config,
      doomsdayProtection: doomsdayProtectionEnabled,
      symbolRegistry,
      orderRecorder: monitorContext.orderRecorder,
      riskChecker,
      trader,
      marketDataClient,
      liquidationCooldownTracker,
      snapshot,
      getIsHalfDay: () => lastState.isHalfDay ?? false,
      now: clock.now,
      getCanProcessTask: canProcessOrdinaryTradeTask,
      termination,
    });
    const ordinarySell = createOrdinarySellWorkflow({
      logger,
      config: monitorContext.config,
      symbolRegistry,
      orderRecorder: monitorContext.orderRecorder,
      trader,
      marketDataClient,
      snapshot,
      settlement: postTradeConsistencyRuntime,
      getTradingCalendar: () => ({
        isHalfDay: lastState.isHalfDay ?? false,
        tradingCalendarSnapshot: lastState.tradingCalendarSnapshot,
      }),
      clock,
      getCanProcessTask: canProcessOrdinaryTradeTask,
      termination,
    });
    const autoSearch = createAutoSearch({
      monitorSymbol: monitorContext.config.monitorSymbol,
      autoSearchConfig: monitorContext.config.autoSearchConfig,
      symbolRegistry,
      candidateSearch,
      logger,
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
      autoSearch,
      autoSearchConfig: monitorContext.config.autoSearchConfig,
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
      snapshot,
      getCanTradeNow: () =>
        !termination.isTerminated() && lastState.isTradingEnabled && lastState.canTrade === true,
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
      seatActivation,
      warrantRiskRefresh,
      seatRuntimeCleanupDispatcher,
      autoSearchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      tradingRiskEventRuntime,
      monitorQuoteEventRuntime,
      monitorDisplayRuntime,
      tradingQuoteDisplayRuntime,
      switchWakeupRuntime,
      postTradeConsistencyRuntime,
      snapshot,
      lastState,
      trader,
      loadTradingDayRuntimeSnapshot,
      doomsdayClearanceWorkflow,
      ordinaryBuy,
      ordinarySell,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    };
  };
}

export const createPostGateRuntime = createPostGateRuntimeFactory(
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
);
