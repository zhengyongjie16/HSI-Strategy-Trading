import type { Logger } from '../../../types/logger.js';
import type { DiagnosticObserver } from '../../../types/diagnostics.js';
import type {
  OrdinarySellWorkflow,
  SellQuoteRetry,
} from '../../../application/ordinarySell/types.js';
import type { RuntimeScheduler, RuntimeTermination } from '../../../types/runtime.js';
import type { TaskQueue, SellTaskType } from '../tradeTaskQueue/types.js';

/** scheduler 私有句柄；retry 决策和原业务授权均由 application 签发。 */
export type ScheduledSellRetry = {
  handle: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  readonly retry: SellQuoteRetry;
};

/** SELL FIFO worker 依赖；不包含 snapshot、风险、账户或数量能力。 */
export interface SellProcessorDeps {
  readonly diagnostics: DiagnosticObserver;
  readonly logger: Logger;
  readonly taskQueue: TaskQueue<SellTaskType>;
  readonly workflow: OrdinarySellWorkflow;
  readonly scheduler: RuntimeScheduler;
  readonly getCanProcessTask: () => boolean;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}
