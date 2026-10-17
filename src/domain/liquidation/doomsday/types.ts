/**
 * 同一末日 workflow 的私有执行状态。
 * 买单检查按 HK 日期隔离；可卖计划重评估与缺行情预算分别保留标的，不记录订单事实或伪 accepted 数量。
 * 此状态仅由 application/doomsdayClearance 的唯一实例修改，不发布给 runtime 或 canonical snapshot。
 */
export type DoomsdayExecutionState = {
  cancelCheckExecutedDate: string | null;
  lastClearanceNoticeKey: string | null;
  clearanceRetryAttempts: number;
  clearanceRetrySymbols: ReadonlySet<string> | null;
  clearanceRetryDueAtMs: number | null;
  clearanceReevaluationSymbols: ReadonlySet<string> | null;
  readonly clearanceRetryExhaustedSymbols: Set<string>;
};
