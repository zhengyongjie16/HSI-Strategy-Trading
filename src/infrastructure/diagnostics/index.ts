/**
 * 最小结构化诊断适配器。
 * 仅向既有 logger 写入 owner 提供的字段；日志失败不得中断同步事务或覆盖原 fatal。
 */
import { DIAGNOSTIC_LOG_MESSAGE } from '../../constants/diagnostics.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { CreateDiagnosticObserverDeps } from './types.js';

/** 创建不抛出日志异常的被动 observer；不持有业务状态，不注册调度或全局实例。 */
export function createDiagnosticObserver(deps: CreateDiagnosticObserverDeps): DiagnosticObserver {
  return {
    record: (operation, fields) => {
      try {
        deps.logger.info(DIAGNOSTIC_LOG_MESSAGE, { ...fields, operation });
      } catch {
        // 诊断是旁路：不重试日志，不借其他日志或 fatal 通道再次引入业务副作用。
      }
    },
  };
}
