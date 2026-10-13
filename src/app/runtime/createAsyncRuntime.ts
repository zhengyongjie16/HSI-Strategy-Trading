/**
 * app 异步运行时工厂模块
 *
 * 职责：
 * - 创建监控任务处理器、买入处理器与卖出处理器
 * - 消费已完成顶层装配的共享依赖，不再承担其他 runtime 的绑定副作用
 */
import { createBuyProcessor } from '../../runtime/asyncProgram/buyProcessor/index.js';
import { createMonitorTaskProcessor } from '../../runtime/asyncProgram/monitorTaskProcessor/index.js';
import { createSellProcessor } from '../../runtime/asyncProgram/sellProcessor/index.js';
import { ordinarySignalGuard } from '../../domain/strategy/ordinarySignalGuard.js';
import { createPeriodicSwitchTaskHandler } from '../../application/seatSwitch/periodicSwitchTask.js';
import type { AsyncRuntime, AsyncRuntimeFactoryDeps } from '../types.js';

/**
 * 创建异步运行时对象。
 *
 * @param params pre-gate runtime 与 post-gate runtime
 * @returns 顶层异步处理器集合
 */

export function createAsyncRuntime(params: AsyncRuntimeFactoryDeps): AsyncRuntime | null {
  const {
    logger,
    preGateRuntime,
    postGateRuntime,
    clock,
    scheduler,
    termination,
    resources,
    cleanup,
  } = params;
  const { tradingConfig } = preGateRuntime;
  const {
    monitorContext,
    snapshot,
    lastState,
    ordinaryBuy,
    ordinarySell,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    seatActivation,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
  } = postGateRuntime;
  const canProcessOrdinaryTradeTask = (): boolean =>
    !termination.isTerminated() &&
    ordinarySignalGuard({
      lastState,
      now: clock.now(),
      doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    });

  const periodicSwitchTaskHandler = createPeriodicSwitchTaskHandler({
    monitorContext,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    snapshot,
    getCanTradeNow: canProcessOrdinaryTradeTask,
    logger,
    now: clock.now,
  });
  const monitorTaskProcessor = createMonitorTaskProcessor({
    scheduler,
    monitorTaskQueue,
    seatActivation,
    logger,
    handlePeriodicSwitchTask: periodicSwitchTaskHandler.handlePeriodicSwitchTask,
    onPeriodicSwitchTaskResult: periodicSwitchTaskHandler.onPeriodicSwitchTaskResult,
    getCanProcessTask: () => !termination.isTerminated() && lastState.isTradingEnabled,
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
    workflow: ordinaryBuy,
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
    scheduler,
    taskQueue: sellTaskQueue,
    workflow: ordinarySell,
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
