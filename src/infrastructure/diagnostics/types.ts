import type { Logger } from '../../types/logger.js';

/** 结构化诊断 adapter 的唯一外部能力；不依赖业务状态或调度器。 */
export type CreateDiagnosticObserverDeps = {
  readonly logger: Pick<Logger, 'info'>;
};
