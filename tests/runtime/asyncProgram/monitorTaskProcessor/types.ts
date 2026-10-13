import type { AccountPositionSnapshot } from '../../../../src/types/accountPosition.js';
import type { RuntimeScheduler, RuntimeTermination } from '../../../../src/types/runtime.js';
import type { Trader } from '../../../../src/types/services.js';
import type { MonitorTaskDataMap } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../../../src/runtime/asyncProgram/monitorTaskQueue/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../../src/runtime/periodicSwitchWakeupRuntime/types.js';
import type { SwitchWakeupRuntime } from '../../../../src/runtime/monitorQuoteEventRuntime/types.js';
import type { ActivationFixtureDeps } from '../../../application/seatActivation/types.js';

/** 离线 worker 联动装配输入，保留周期 owner 真实授权；不为 application 提供队列能力。 */
export type MonitorTaskRuntimeFixtureDeps = ActivationFixtureDeps &
  Readonly<{
    scheduler: RuntimeScheduler;
    monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
    snapshot: AccountPositionSnapshot;
    trader: Trader;
    switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'handoffPendingSwitch'>;
    periodicSwitchWakeupRuntime: Pick<
      PeriodicSwitchWakeupRuntime,
      'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
    >;
    getCanTradeNow: () => boolean;
    getCanProcessTask?: () => boolean;
    termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  }>;

/** 监控业务场景的显式装配参数，供独立创建 canonical snapshot 的测试工厂消费。 */
export type CreateBusinessProcessorParams = Readonly<{
  queue: MonitorTaskRuntimeFixtureDeps['monitorTaskQueue'];
  context: ActivationFixtureDeps['monitorContext'];
  clock?: MonitorTaskRuntimeFixtureDeps['clock'];
  scheduler?: MonitorTaskRuntimeFixtureDeps['scheduler'];
  trader?: MonitorTaskRuntimeFixtureDeps['trader'];
  marketDataClient?: MonitorTaskRuntimeFixtureDeps['marketDataClient'];
  quoteSubscriptionRuntime?: MonitorTaskRuntimeFixtureDeps['quoteSubscriptionRuntime'];
  getCanProcessTask?: MonitorTaskRuntimeFixtureDeps['getCanProcessTask'];
  getCanTradeNow?: MonitorTaskRuntimeFixtureDeps['getCanTradeNow'];
  termination?: MonitorTaskRuntimeFixtureDeps['termination'];
  periodicSwitchWakeupRuntime?: MonitorTaskRuntimeFixtureDeps['periodicSwitchWakeupRuntime'];
}>;
