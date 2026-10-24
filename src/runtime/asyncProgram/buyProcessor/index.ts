/** 普通 BUY FIFO worker：只串行消费任务并委托业务 owner，不复制风险或业务失败策略。 */
import { createBaseProcessor } from '../processor.js';
import type { Processor } from '../types.js';
import type { BuyProcessorDeps } from './types.js';

/** 独立 BUY 队列不阻塞 SELL；stopAndDrain 等待真实在途用例完成。 */
export function createBuyProcessor(deps: BuyProcessorDeps): Processor {
  return createBaseProcessor({
    diagnostics: deps.diagnostics,
    logger: deps.logger,
    loggerPrefix: 'BuyProcessor',
    taskQueue: deps.taskQueue,
    processTask: (task) => deps.workflow.execute(task.data),
    getCanProcessTask: deps.getCanProcessTask,
    termination: deps.termination,
  });
}
