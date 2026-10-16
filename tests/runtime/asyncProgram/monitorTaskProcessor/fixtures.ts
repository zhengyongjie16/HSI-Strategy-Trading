import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** 监控 worker 测试装配：真实 application 激活 owner 与既有周期换标 owner，共享原快照和席位身份。 */
import { createMonitorTaskProcessor } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/index.js';
import { createSeatActivationFixture } from '../../../application/seatActivation/fixtures.js';
import { createPeriodicSwitchTaskHandler } from '../../../../src/application/seatSwitch/periodicSwitchTask.js';
import { logger } from '../../../../src/infrastructure/logger/index.js';
import type { MonitorTaskProcessor } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskRuntimeFixtureDeps } from './types.js';

/** 装配具名 worker；未发行周期任务的 activation 用例不会触发周期 owner。 */
export function createMonitorTaskRuntimeFixture(
  deps: MonitorTaskRuntimeFixtureDeps,
): MonitorTaskProcessor {
  const periodicSwitchTaskHandler = createPeriodicSwitchTaskHandler({
    monitorContext: deps.monitorContext,
    switchWakeupRuntime: deps.switchWakeupRuntime,
    periodicSwitchWakeupRuntime: deps.periodicSwitchWakeupRuntime,
    snapshot: deps.snapshot,
    getCanTradeNow: deps.getCanTradeNow,
    logger,
    now: deps.clock.now,
  });
  return createMonitorTaskProcessor({
    scheduler: deps.scheduler,
    monitorTaskQueue: deps.monitorTaskQueue,
    seatActivation: createSeatActivationFixture(deps),
    handlePeriodicSwitchTask: periodicSwitchTaskHandler.handlePeriodicSwitchTask,
    onPeriodicSwitchTaskResult: periodicSwitchTaskHandler.onPeriodicSwitchTaskResult,

    ...(deps.getCanProcessTask === undefined
      ? { logger: createLoggerDouble() }
      : { logger: createLoggerDouble(), getCanProcessTask: deps.getCanProcessTask }),
    termination: deps.termination,
  });
}
