/** 跨 application 用例共用的行情有限重试计算输入；状态与显式当前时点来自各自业务 owner。 */
export type ResolveNextQuoteRetryParams = {
  readonly attempts: number;
  readonly nowMs: number;
  readonly intervalMs?: number;
  readonly maxAttempts?: number;
};

/** 行情有限重试推进事实；耗尽时 nextRetryAt 为 null，不创建 timer 或改变用例生命周期。 */
export type ResolveNextQuoteRetryResult = {
  readonly nextAttempts: number;
  readonly nextRetryAt: number | null;
  readonly exhausted: boolean;
};
