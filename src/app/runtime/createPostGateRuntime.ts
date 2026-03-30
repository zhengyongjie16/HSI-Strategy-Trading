/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */
import fs from 'node:fs';
import { createTrader } from '../../core/trader/index.js';
import { createOrderFilteringEngine } from '../../core/orderRecorder/orderFilteringEngine.js';
import { classifyAndConvertOrders } from '../../core/orderRecorder/utils.js';
import { resolveOrderOwnership } from '../../core/orderRecorder/orderOwnershipParser.js';
import { createDailyLossTracker } from '../../core/riskController/dailyLossTracker.js';
import { createDoomsdayProtection } from '../../core/doomsdayProtection/index.js';
import { createSignalProcessor } from '../../core/signalProcessor/index.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createMonitorTaskQueue } from '../../main/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../main/asyncProgram/tradeTaskQueue/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createMarketMonitor } from '../../services/marketMonitor/index.js';
import { createLiquidationCooldownTracker } from '../../services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../services/liquidationCooldown/tradeLogHydrator.js';
import { createPositionCache } from '../../utils/positionCache/index.js';
import { createRefreshGate } from '../../utils/refreshGate/index.js';
import { createStrategyState } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { getHKDateKey, toHongKongTimeIso } from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import type { LastState } from '../../types/state.js';
import type { MonitorTaskDataMap } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type {
  CreatePostGateRuntimeParams,
  MutableStrategyRuntimePostGateRuntime,
} from '../types.js';

/**
 * 创建 post-gate 阶段共享运行时对象。
 *
 * @param params 当前环境、pre-gate runtime 与当前时间
 * @returns post-gate runtime
 */
export async function createPostGateRuntime(
  params: CreatePostGateRuntimeParams,
): Promise<MutableStrategyRuntimePostGateRuntime> {
  const { env, preGateRuntime, now } = params;
  const {
    config,
    tradingConfig,
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    startupTradingDayInfo,
    warrantListCacheConfig,
  } = preGateRuntime;
  const liquidationCooldownTracker = createLiquidationCooldownTracker({ nowMs: () => Date.now() });
  const dailyLossTracker = createDailyLossTracker({
    filteringEngine: createOrderFilteringEngine(),
    resolveOrderOwnership,
    classifyAndConvertOrders,
    toHongKongTimeIso,
  });
  const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
  const refreshGate = createRefreshGate();
  const initialDayKey = getHKDateKey(now);
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
    cachedTradingDayInfo: startupTradingDayInfo,
    tradingCalendarSnapshot: new Map([[initialDayKey, startupTradingDayInfo]]),
    monitorState: createStrategyState(monitorConfig),
    allTradingSymbols: new Set(),
  };
  const trader = await createTrader({
    config,
    globalConfig: tradingConfig.global,
    monitorConfig,
    marketDataClient,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    refreshGate,
    isExecutionAllowed: () => lastState.isTradingEnabled,
  });
  const tradeLogHydrator = createTradeLogHydrator({
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    resolveLogRootDir: () => resolveLogRootDir(env),
    nowMs: () => Date.now(),
    logger,
    monitorConfig,
    liquidationCooldownTracker,
  });
  const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
    marketDataClient,
    trader,
    lastState,
    monitorConfig,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  });
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const signalProcessor = createSignalProcessor({
    globalConfig: tradingConfig.global,
    liquidationCooldownTracker,
  });
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

  return {
    liquidationCooldownTracker,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    monitorContext: null,
    refreshGate,
    lastState,
    trader,
    tradeLogHydrator,
    loadTradingDayRuntimeSnapshot,
    marketMonitor,
    doomsdayProtection,
    signalProcessor,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  };
}
