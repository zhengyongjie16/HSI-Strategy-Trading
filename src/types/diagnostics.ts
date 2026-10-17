/** 诊断字段值仅承载日志安全的标量与标签集合；金融值必须由调用方提供保真十进制文本。 */
export type DiagnosticFieldValue = string | number | boolean | null | ReadonlyArray<string>;

/** 由各真实 owner 在事实边界采集的结构化字段；版本 token 分解为独立字段，不计算跨序列差值。 */
export type DiagnosticFields = Readonly<Record<string, DiagnosticFieldValue>>;

/** 被动诊断能力；生产实现同步隔离 logger 异常，不参与业务状态、调度、持久化或 fatal 处理。 */
export interface DiagnosticObserver {
  readonly record: (operation: string, fields: DiagnosticFields) => void;
}
