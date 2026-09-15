/**
 * app 异步运行时工厂模块
 *
 * 职责：
 * - 创建监控任务处理器、买入处理器与卖出处理器
 * - 消费已完成顶层装配的共享依赖，不再承担其他 runtime 的绑定副作用
 */
import { createBuyProcessor } from '../../main/asyncProgram/buyProcessor/index.js';
import { createMonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/index.js';
import { createSellProcessor } from '../../main/asyncProgram/sellProcessor/index.js';
import { ordinarySignalGuard } from '../../main/ordinarySignalGuard/index.js';
import type { AsyncRuntime, AsyncRuntimeFactoryDeps } from '../types.js';

/**
 * 创建异步运行时对象。
 *
 * @param params pre-gate runtime 与 post-gate runtime
 * @returns 顶层异步处理器集合
 */

export function createAsyncRuntime(params: AsyncRuntimeFactoryDeps): AsyncRuntime | null {
  const { preGateRuntime, postGateRuntime, clock, scheduler, termination, resources, cleanup } =
    params;
  const { tradingConfig, marketDataClient } = preGateRuntime;
  const {
    monitorContext,
    trader,
    lastState,
    postTradeConsistencyRuntime,
    signalProcessor,
    doomsdayProtection,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
  } = postGateRuntime;
  const canProcessOrdinaryTradeTask = (): boolean =>
    !termination.isTerminated() &&
    ordinarySignalGuard({
      lastState,
      now: clock.now(),
      doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    });

  const monitorTaskProcessor = createMonitorTaskProcessor({
    clock,
    scheduler,
    monitorTaskQueue,
    monitorContext,
    trader,
    marketDataClient,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
    lastState,
    getCanProcessTask: () => !termination.isTerminated() && lastState.isTradingEnabled,
    getCanTradeNow: canProcessOrdinaryTradeTask,
    termination,
  });

  resources.monitorTaskProcessor = monitorTaskProcessor;
  cleanup.register({
    phase: 'STOP_MONITOR_TASK_PROCESSOR',
    step: '停止 monitorTaskProcessor',
    handler: () => monitorTaskProcessor.stopAndDrain(),
  });

  if (termination.isTerminated()) return null;

  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient,
    doomsdayProtection,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
    now: clock.now,
    getCanProcessTask: canProcessOrdinaryTradeTask,
    termination,
  });

  resources.buyProcessor = buyProcessor;
  cleanup.register({
    phase: 'STOP_BUY_PROCESSOR',
    step: '停止 buyProcessor',
    handler: () => buyProcessor.stopAndDrain(),
  });

  if (termination.isTerminated()) return null;

  const sellProcessor = createSellProcessor({
    clock,
    scheduler,
    taskQueue: sellTaskQueue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient,
    getLastState: () => lastState,
    postTradeConsistencyRuntime,
    getCanProcessTask: canProcessOrdinaryTradeTask,
    termination,
  });

  resources.sellProcessor = sellProcessor;
  cleanup.register({
    phase: 'STOP_SELL_PROCESSOR',
    step: '停止 sellProcessor',
    handler: () => sellProcessor.stopAndDrain(),
  });

  if (termination.isTerminated()) return null;

  return {
    monitorTaskProcessor,
    buyProcessor,
    sellProcessor,
  };
}
