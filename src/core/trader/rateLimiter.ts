/**
 * Trade API 频率限制器
 *
 * 职责：
 * - 以单一 FIFO 序列协调读取 throttle 与订单 mutation。
 * - 读取调用在通过限流时计入配额；mutation 只有 permit.invoke() 才在真实 SDK 调用前计入配额。
 * - mutation callback 持有序列席位直到最终报价、授权、SDK 调用与回调收口完成，避免 quote-to-order TOCTOU。
 */
import { logger } from '../../utils/logger/index.js';
import { API } from '../../constants/index.js';
import type { RateLimiter, TradeMutationPermit } from '../../types/services.js';
import type { RateLimiterDeps, RateLimiterConfig } from './types.js';

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxCalls: 30,
  windowMs: 30000,
};

/** 等待指定毫秒数。 */
function wait(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * 创建频率限制器。
 * 所有读取和订单 mutation 共享同一 FIFO 序列；mutation callback 不会因取得席位而提前消耗 SDK 配额。
 *
 * @param deps 依赖配置（config 可选，缺省为 30 次/30 秒）
 * @returns RateLimiter 接口实例（throttle、withTradeMutation）
 */
export const createRateLimiter = (deps: RateLimiterDeps = {}): RateLimiter => {
  const config = deps.config ?? DEFAULT_CONFIG;
  const { maxCalls, windowMs } = config;
  let callTimestamps: number[] = [];
  let sequenceTail = Promise.resolve();

  /**
   * 在共享 FIFO 队列中运行一个动作，动作结束前不会释放后续调用。
   *
   * @param operation 当前队列动作
   * @returns 当前动作结果
   */
  async function runInSequence<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = sequenceTail;
    let releaseCurrentTurn!: () => void;
    const currentTurn = new Promise<void>((resolve) => {
      releaseCurrentTurn = resolve;
    });
    sequenceTail = predecessor.then(() => currentTurn);

    await predecessor;
    try {
      return await operation();
    } finally {
      releaseCurrentTurn();
    }
  }

  /** 等待当前 API 调用可执行，但不写入本次调用时间戳。 */
  async function waitForApiSlot(): Promise<void> {
    let now = performance.now();
    const lastCallTime = callTimestamps.at(-1);
    if (lastCallTime !== undefined) {
      while (now - lastCallTime < API.MIN_CALL_INTERVAL_MS) {
        await wait(API.MIN_CALL_INTERVAL_MS - (now - lastCallTime));
        now = performance.now();
      }
    }

    callTimestamps = callTimestamps.filter((timestamp) => now - timestamp < windowMs);
    while (callTimestamps.length >= maxCalls) {
      const oldestCall = callTimestamps[0];
      if (oldestCall === undefined) {
        throw new Error('[频率限制] 调用时间戳数组异常');
      }

      const waitTime = windowMs - (now - oldestCall) + API.RATE_LIMIT_BUFFER_MS;
      logger.warn(
        `[频率限制] Trade API 调用频率达到上限 (${maxCalls}次/${windowMs}ms)，等待 ${waitTime}ms`,
      );
      await wait(waitTime);
      now = performance.now();
      const currentNow = now;
      callTimestamps = callTimestamps.filter((timestamp) => currentNow - timestamp < windowMs);
    }
  }

  /** 在真实 API 调用即将开始时记录配额。 */
  function recordApiInvocation(): void {
    callTimestamps.push(performance.now());
  }

  /** 读取 API 的限流入口。 */
  async function throttle(): Promise<void> {
    await runInSequence(async () => {
      await waitForApiSlot();
      recordApiInvocation();
    });
  }

  /**
   * 在单一 mutation 席位中执行最终订单动作。
   * callback 可以安全等待最终行情；若它提前跳过或抛错，配额不会被消耗。
   */
  async function withTradeMutation<T>(
    callback: (permit: TradeMutationPermit) => Promise<T>,
  ): Promise<T> {
    return runInSequence(async () => {
      await waitForApiSlot();
      let invoked = false;
      const permit: TradeMutationPermit = {
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
          if (invoked) {
            throw new Error('[频率限制] 单个 trade mutation permit 只能调用一次');
          }

          invoked = true;
          recordApiInvocation();
          return operation();
        },
      };

      return callback(permit);
    });
  }

  return {
    throttle,
    withTradeMutation,
  };
};
