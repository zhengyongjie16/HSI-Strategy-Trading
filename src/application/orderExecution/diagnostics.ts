/** 共享执行器被动结果采集：只读取调用点已确定的事实，诊断与字段构造失败均不参与业务。 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import type { DiagnosticFields, DiagnosticObserver } from '../../types/diagnostics.js';
import type { Signal } from '../../types/signal.js';

/**
 * 在原业务分支记录结果，不复算授权、行情、数量或当前时间。
 * 字段延迟构造并与 observer 一并隔离，避免格式化失败掩盖远端事实或原错误。
 *
 * @param diagnostics 既有被动诊断依赖
 * @param signal 原命令信号，仅读取已有身份与触发时间
 * @param stage 原执行阶段
 * @param outcome 本分支已确定的结果
 * @param reasonCode 本分支已确定的原因
 * @param readFields 读取本分支已有局部事实，不得请求或复核业务状态
 * @returns 无返回值；诊断失败仅丢弃本条记录
 */
export function recordOrderExecutionOutcome(
  diagnostics: DiagnosticObserver,
  signal: Signal,
  stage: string,
  outcome: string,
  reasonCode: string,
  readFields?: () => DiagnosticFields,
): void {
  try {
    const seatVersion = signal.seatVersion;
    const triggerTimeMs = signal.triggerTime?.getTime();
    diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_EXECUTION_OUTCOME, {
      stage,
      outcome,
      reasonCode,
      symbol: signal.symbol,
      action: signal.action,
      ...(typeof seatVersion === 'number' && Number.isFinite(seatVersion) ? { seatVersion } : {}),
      ...(typeof triggerTimeMs === 'number' && Number.isFinite(triggerTimeMs)
        ? { triggerTimeMs }
        : {}),
      ...readFields?.(),
    });
  } catch {
    // 已发生的订单事实与原始错误不受 observer 或诊断字段构造失败影响。
  }
}
