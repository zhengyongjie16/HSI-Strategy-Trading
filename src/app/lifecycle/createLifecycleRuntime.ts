/**
 * app 生命周期运行时装配模块
 *
 * 职责：
 * - 在唯一注册点固定 cache domain 注册顺序
 * - 创建 dayLifecycleManager
 * - 固化 open rebuild 统一入口与 signal runtime 恢复顺序
 */
import { createDayLifecycleManager } from '../../runtime/lifecycle/dayLifecycleManager.js';
import { createGlobalStateDomain } from '../../runtime/lifecycle/cacheDomains/globalStateDomain.js';
import { createMarketDataDomain } from '../../runtime/lifecycle/cacheDomains/marketDataDomain.js';
import { createOrderDomain } from '../../runtime/lifecycle/cacheDomains/orderDomain.js';
import { createRiskDomain } from '../../runtime/lifecycle/cacheDomains/riskDomain.js';
import { createSeatDomain } from '../../runtime/lifecycle/cacheDomains/seatDomain.js';
import { createSignalRuntimeDomain } from '../../runtime/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { executeTradingDayOpenRebuild } from '../../application/tradingDayRebuild/openRebuild.js';
import type { CacheDomain } from '../../runtime/lifecycle/types.js';
import type { DayLifecycleManager } from '../../types/timeControlPlane.js';
import type { LifecycleRuntimeFactories, LifecycleRuntimeFactoryDeps } from './types.js';

const DEFAULT_LIFECYCLE_RUNTIME_FACTORIES: LifecycleRuntimeFactories = {
  createSignalRuntimeDomain,
  createMarketDataDomain,
  createSeatDomain,
  createOrderDomain,
  createRiskDomain,
  createGlobalStateDomain,
  executeTradingDayOpenRebuild,
  createDayLifecycleManager,
};

/**
 * 按固定顺序创建 lifecycle cache domains。
 *
 * @param params pre-gate runtime、post-gate runtime、异步 runtime 与重建函数
 * @returns 按注册顺序排列的 cache domains
 */
function createLifecycleCacheDomains(
  params: LifecycleRuntimeFactoryDeps,
  factories: LifecycleRuntimeFactories = DEFAULT_LIFECYCLE_RUNTIME_FACTORIES,
): ReadonlyArray<CacheDomain> {
  const {
    logger,
    preGateRuntime,
    postGateRuntime,
    asyncRuntime,
    businessEventProgram,
    rebuildTradingDayState,
  } = params;
  const { symbolRegistry, warrantListCache, marketDataClient } = preGateRuntime;
  const {
    monitorContext,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    tradingRiskEventRuntime,
    monitorQuoteEventRuntime,
    monitorDisplayRuntime,
    tradingQuoteDisplayRuntime,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
    autoSearchWakeupRuntime,
    seatActivationDispatcher,
    seatRuntimeCleanupDispatcher,
    postTradeConsistencyRuntime,
    snapshot,
    tradeRuntime,
    tradingTimeState,
    tradingCalendarState,
    quoteSubscriptionState,
    ordinaryBuy,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    liquidationCooldownTracker,
    loadTradingDayRuntimeSnapshot,
  } = postGateRuntime;
  const { orderRecorder, cacheManager, orderHoldRegistry, orderMonitor, orderExecutor } =
    tradeRuntime;
  const { buyProcessor, sellProcessor, monitorTaskProcessor } = asyncRuntime;
  const {
    createSignalRuntimeDomain: buildSignalRuntimeDomain,
    createMarketDataDomain: buildMarketDataDomain,
    createSeatDomain: buildSeatDomain,
    createOrderDomain: buildOrderDomain,
    createRiskDomain: buildRiskDomain,
    createGlobalStateDomain: buildGlobalStateDomain,
    executeTradingDayOpenRebuild: runTradingDayOpenRebuild,
  } = factories;

  return [
    buildSignalRuntimeDomain({
      logger,
      termination: params.termination,
      monitorContext,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      businessEventProgram,
      tradingRiskEventRuntime,
      monitorQuoteEventRuntime,
      monitorDisplayRuntime,
      tradingQuoteDisplayRuntime,
      switchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      quoteSubscriptionRuntime,
      autoSearchWakeupRuntime,
      seatActivationDispatcher,
      seatRuntimeCleanupDispatcher,
      orderMonitor,
      postTradeConsistencyRuntime,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    }),
    buildMarketDataDomain({
      logger,
      marketDataClient,
    }),
    buildSeatDomain({
      logger,
      symbolRegistry,
      seatSwitch: monitorContext.seatSwitch,
      warrantListCache,
    }),
    buildOrderDomain({
      logger,
      orderRecorder,
      cacheManager,
      orderHoldRegistry,
      orderMonitor,
      orderExecutor,
    }),
    buildRiskDomain({
      logger,
      ordinaryBuy,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      monitorContext,
      liquidationCooldownTracker,
    }),
    buildGlobalStateDomain({
      logger,
      tradingTimeState,
      tradingCalendarState,
      quoteSubscriptionState,
      snapshot,
      runTradingDayOpenRebuild: (now) =>
        runTradingDayOpenRebuild({
          now,
          termination: params.termination,
          snapshot,
          loadTradingDayRuntimeSnapshot,
          rebuildTradingDayState,
          postTradeConsistencyRuntime,
          quoteSubscriptionRuntime,
        }),
    }),
  ];
}

/**
 * 创建 dayLifecycleManager。
 *
 * @param params pre-gate runtime、post-gate runtime、异步 runtime 与重建函数
 * @param factories cache domain 与 dayLifecycleManager 工厂集合；默认使用生产实现
 * @returns 生命周期管理器
 */
export function createLifecycleRuntime(
  params: LifecycleRuntimeFactoryDeps,
  factories: LifecycleRuntimeFactories = DEFAULT_LIFECYCLE_RUNTIME_FACTORIES,
): DayLifecycleManager {
  const { logger, postGateRuntime } = params;
  const cacheDomains = createLifecycleCacheDomains(params, factories);

  return factories.createDayLifecycleManager({
    mutableState: postGateRuntime.lifecycleState,
    snapshot: postGateRuntime.snapshot,
    cacheDomains,
    logger,
    termination: params.termination,
  });
}
