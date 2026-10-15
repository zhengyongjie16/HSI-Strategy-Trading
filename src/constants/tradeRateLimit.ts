/** Trade API 共享 FIFO 限流窗口的既有默认配置。 */
export const DEFAULT_TRADE_RATE_LIMIT = {
  maxCalls: 30,
  windowMs: 30000,
} as const;
