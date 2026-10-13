import type { PeriodicSwitchTaskStatus } from '../../../application/seatSwitch/types.js';
import type {
  SeatActivationRequest,
  SeatActivationWorkflow,
} from '../../../application/seatActivation/types.js';
import type { PeriodicSwitchTaskData } from '../../../types/periodicSwitch.js';
import type { RuntimeScheduler, RuntimeTermination } from '../../../types/runtime.js';
import type { Logger } from '../../../utils/logger/types.js';
import type { MonitorTask, MonitorTaskQueue } from '../monitorTaskQueue/types.js';

/** 监控队列的判别联合；席位业务输入直接由 application 定义，runtime 不复制失败计数。 */
export type MonitorTaskDataMap = Readonly<{
  AUTO_SYMBOL_TICK: PeriodicSwitchTaskData;
  SEAT_REFRESH: SeatActivationRequest;
}>;

/** 实际监控 worker 的依赖；业务 owner 已由 composition 创建并注入。 */
export interface MonitorTaskProcessorDeps {
  readonly scheduler: RuntimeScheduler;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  readonly seatActivation: SeatActivationWorkflow;
  readonly handlePeriodicSwitchTask: (
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
    canOwnTask: () => boolean,
  ) => Promise<PeriodicSwitchTaskStatus>;
  readonly onPeriodicSwitchTaskResult: (
    task: MonitorTask<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>,
    status: PeriodicSwitchTaskStatus,
    canOwnTask: () => boolean,
  ) => void;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly getCanProcessTask?: () => boolean;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}

/** 实际监控 worker 的具名启停/排空契约，不另建业务 owner 或通用 lifecycle executor。 */
export interface MonitorTaskProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly restart: () => void;
}
