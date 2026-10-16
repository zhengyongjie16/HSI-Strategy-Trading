/**
 * 交易 mutation permit。
 * 类型用途：只在 RateLimiter.withTradeMutation 回调内使用，确保最终报价、同步授权与真实 SDK mutation 保持同一 FIFO 临界区。
 * 数据来源：由 RateLimiter 在取得交易 mutation 序列席位后创建。
 * 使用范围：订单提交、撤单、改单与超时市价转单的最终 SDK 调用边界。
 */
export interface TradeMutationPermit {
  /** 在当前 permit 内执行唯一一次真实 SDK mutation；调用前才消耗 Trade API 配额。 */
  readonly invoke: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * API 频率限制器接口。
 * 类型用途：依赖注入用接口，读取使用 throttle，订单 mutation 必须使用 callback permit。
 * 数据来源：如适用；实现由调用方提供。
 * 使用范围：订单读取、共享执行与 tracking等限流场景；见调用方。
 */
export interface RateLimiter {
  /** 等待读取 API 的限流通过，并立即记入该次 API 配额。 */
  readonly throttle: () => Promise<void>;

  /**
   * 在全局 FIFO trade mutation 序列内执行回调。
   * 回调可先等待最终行情；仅 permit.invoke() 会在实际 SDK 调用前消耗配额，且每个 permit 只能 invoke 一次。
   */
  readonly withTradeMutation: <T>(
    callback: (permit: TradeMutationPermit) => Promise<T>,
  ) => Promise<T>;
}
