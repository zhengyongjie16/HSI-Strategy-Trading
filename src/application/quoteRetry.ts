/**
 * 跨交易用例共享的行情有限重试状态计算。
 * 只返回次数、下次时点和耗尽事实；重试状态及唤醒仍由各用例/runtime 持有。
 */
import { ORDER_QUOTE_RETRY } from '../constants/common.js';
import type { ResolveNextQuoteRetryParams, ResolveNextQuoteRetryResult } from './types.js';

/**
 * 计算下一次行情重试；达到既有最大次数后不再产生可调度时点。
 * @param params 已执行重试次数、当前时间以及可选有限重试配置
 * @returns 下一次重试次数、时点与是否耗尽
 */
export function resolveNextQuoteRetry(
  params: ResolveNextQuoteRetryParams,
): ResolveNextQuoteRetryResult {
  const intervalMs = params.intervalMs ?? ORDER_QUOTE_RETRY.INTERVAL_MS;
  const maxAttempts = params.maxAttempts ?? ORDER_QUOTE_RETRY.MAX_ATTEMPTS;
  const nextAttempts = params.attempts + 1;
  const exhausted = nextAttempts > maxAttempts;
  return {
    nextAttempts,
    nextRetryAt: exhausted ? null : params.nowMs + intervalMs,
    exhausted,
  };
}
