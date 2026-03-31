/**
 * app 异步运行时工厂模块
 *
 * 职责：
 * - 创建订单监控、成交后刷新、监控任务处理器、买入处理器与卖出处理器
 * - 固定异步处理器的顶层所有权边界
 */
import { createBuyProcessor } from '../../main/asyncProgram/buyProcessor/index.js';
import { createMonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/index.js';
import { createOrderMonitorWorker } from '../../main/asyncProgram/orderMonitorWorker/index.js';
import { createPostTradeRefresher } from '../../main/asyncProgram/postTradeRefresher/index.js';
import { createSellProcessor } from '../../main/asyncProgram/sellProcessor/index.js';
import { clearMonitorDirectionQueuesWithLog } from '../../main/processMonitor/queueCleanup.js';
import { logger } from '../../utils/logger/index.js';
import { displayAccountAndPositions } from '../../services/accountDisplay/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import { requireStrategyRuntime } from '../utils.js';
import type { AsyncRuntime, AsyncRuntimeFactoryDeps } from '../types.js';

/**
 * 创建异步运行时对象。
 *
 * @param params pre-gate runtime 与 post-gate runtime
 * @returns 顶层异步处理器集合
 */
export function createAsyncRuntime(params: AsyncRuntimeFactoryDeps): AsyncRuntime {
  const { preGateRuntime, postGateRuntime } = params;
  const { monitorConfig } = preGateRuntime;
  const monitorContext = requireStrategyRuntime(postGateRuntime.monitorContext);
  const {
    refreshGate,
    trader,
    lastState,
    dailyLossTracker,
    liquidationCooldownTracker,
    protectiveLiquidationEpisodeTracker,
    signalProcessor,
    doomsdayProtection,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  } = postGateRuntime;
  const orderMonitorWorker = createOrderMonitorWorker({
    monitorAndManageOrders: () => trader.monitorAndManageOrders(),
  });
  const postTradeRefresher = createPostTradeRefresher({
    refreshGate,
    trader,
    lastState,
    monitorContext,
    dailyLossTracker,
    liquidationCooldownTracker,
    protectiveLiquidationEpisodeTracker,
    displayAccountAndPositions,
  });
  const monitorTaskProcessor = createMonitorTaskProcessor({
    monitorTaskQueue,
    refreshGate,
    monitorContext,
    clearMonitorDirectionQueues: (direction) => {
      clearMonitorDirectionQueuesWithLog({
        direction,
        monitorContext,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        releaseSignal: (signal) => {
          signalObjectPool.release(signal);
        },
        logger,
      });
    },
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    lastState,
    monitorConfig,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });
  const sellProcessor = createSellProcessor({
    taskQueue: sellTaskQueue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    getLastState: () => lastState,
    refreshGate,
    scheduleRetry: (callback, delayMs) => {
      return setTimeout(callback, delayMs);
    },
    clearRetry: (handle) => {
      clearTimeout(handle);
    },
    getCanProcessTask: () => lastState.isTradingEnabled,
  });

  return {
    orderMonitorWorker,
    postTradeRefresher,
    monitorTaskProcessor,
    buyProcessor,
    sellProcessor,
  };
}
