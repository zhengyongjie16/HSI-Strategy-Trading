/**
 * 时间唤醒候选。
 * 类型用途：表达一个系统级未来唤醒时间点。
 * 数据来源：外部运行时对各系统级时间边界的计算结果。
 * 使用范围：timeWakeupEvaluationProgram 输出、TimeWakeupPlanner 输入与内部过滤排序。
 */
export type TimeWakeupCandidate = Readonly<{
  atMs: number;
}>;

/**
 * 时间唤醒规划输入。
 * 类型用途：提供当前时间与待裁剪的系统级候选集合。
 * 数据来源：事件唤醒运行时装配层。
 * 使用范围：planNextTimeWakeup 纯函数参数。
 */
export type TimeWakeupPlannerInput = Readonly<{
  nowMs: number;
  candidates: ReadonlyArray<TimeWakeupCandidate>;
}>;

/**
 * 时间唤醒规划结果。
 * 类型用途：表达下一次系统级时间唤醒是否存在。
 * 数据来源：planNextTimeWakeup 对输入候选过滤排序后的结果。
 * 使用范围：事件唤醒运行时调度 one-shot timer。
 */
export type TimeWakeupPlan =
  | Readonly<{
      hasWork: false;
      nextWakeupAtMs: null;
    }>
  | Readonly<{
      hasWork: true;
      nextWakeupAtMs: number;
    }>;
