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

/**
 * 运行时 fatal 状态。
 * 类型用途：区分尚未发生 fatal 与已锁存的原始 fatal 值，包括 null 或 undefined。
 * 数据来源：由 composition root 的 RuntimeTermination owner 维护。
 * 使用范围：运行时终止门禁、app 主流程与清理结果处理。
 */
export type RuntimeFatalState =
  | {
      readonly hasFatalError: false;
    }
  | {
      readonly hasFatalError: true;
      readonly error: unknown;
    };

/**
 * 运行时终止行为契约。
 * 类型用途：统一提供不可逆终止 latch、首个 fatal 锁存、同步关门和唯一终止通知。
 * 数据来源：由 app composition root 创建并注入各受影响 owner。
 * 使用范围：app、main runtime 与异步生产者；不承载具体业务状态或清理编排。
 */
export interface RuntimeTermination {
  /** 读取不可逆终止状态。 */
  readonly isTerminated: () => boolean;

  /** 读取当前锁存的 fatal 状态。 */
  readonly getFatalState: () => RuntimeFatalState;

  /** 请求正常终止，不制造 fatal 错误。 */
  readonly requestShutdown: () => void;

  /** 锁存首个 fatal，并同步关闭交易与生产者入口。 */
  readonly reportFatalError: (error: unknown) => void;

  /** 等待终止 latch 被正常退出或 fatal 请求置位。 */
  readonly waitForTermination: () => Promise<void>;
}

/**
 * 运行时终止 owner 的创建依赖。
 * 类型用途：注入终止时必须同步执行的交易关门、producer admission 关闭和 stop 回调。
 * 数据来源：由 composition root 按已创建资源逐项组装。
 * 使用范围：createTerminationRuntime 与 app 终止接线。
 */
export type RuntimeTerminationDeps = {
  readonly closeTradingGate: () => void;
  readonly closeProducerAdmission: () => void;
  readonly stopProducers: ReadonlyArray<() => void>;
  readonly onSecondaryError: (error: unknown) => void;
};
