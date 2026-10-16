import type { Logger } from '../../../types/logger.js';
import type { OrdinaryBuyWorkflow } from '../../../application/ordinaryBuy/types.js';
import type { RuntimeTermination } from '../../../types/runtime.js';
import type { BuyTaskType, TaskQueue } from '../tradeTaskQueue/types.js';

/** BUY FIFO worker 依赖；业务及冷却属于注入的唯一 ordinaryBuy owner。 */
export interface BuyProcessorDeps {
  readonly logger: Logger;
  readonly taskQueue: TaskQueue<BuyTaskType>;
  readonly workflow: Pick<OrdinaryBuyWorkflow, 'execute'>;
  readonly getCanProcessTask: () => boolean;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}
