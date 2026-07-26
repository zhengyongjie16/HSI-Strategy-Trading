/**
 * 运行时时钟行为契约。
 * 类型用途：为业务时间判断提供唯一可替换的当前时间源。
 * 数据来源：生产环境由 app composition root 绑定系统时钟，回放与测试注入确定性时钟。
 * 使用范围：策略、风控、订单与事件 runtime 的时间依赖。
 */
export interface RuntimeClock {
  readonly now: () => Date;
}

/**
 * 运行时 timer 行为契约。
 * 类型用途：为一次性唤醒和重试提供可替换的调度与取消能力。
 * 数据来源：生产环境由 app composition root 绑定原生 timer，回放与测试注入确定性 scheduler。
 * 使用范围：延迟验证、订单 route、行情 route 与成交后一致性重试的 timer 依赖。
 */
export interface RuntimeScheduler {
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}
