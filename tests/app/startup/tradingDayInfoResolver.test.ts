/**
 * 交易日信息解析器单元测试：接口失败保持原始错误，不回退为非交易日事实。
 */
import { describe, expect, it } from 'bun:test';
import { createTradingDayInfoResolver } from '../../../src/app/startup/tradingDayInfoResolver.js';

describe('trading day info resolver', () => {
  it('rethrows trading-day resolver failures without treating the day as non-trading', async () => {
    const thrownError = new Error('trading day service unavailable');
    const resolveErrors: unknown[] = [];
    let lookupCalls = 0;
    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient: {
        isTradingDay: async () => {
          lookupCalls += 1;
          throw thrownError;
        },
      },
      onResolveError: (error) => {
        resolveErrors.push(error);
      },
    });

    let caught: unknown = null;
    try {
      await resolveTradingDayInfo(new Date('2026-03-09T09:30:00.000Z'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrownError);
    expect(resolveErrors).toEqual([thrownError]);
    expect(lookupCalls).toBe(1);
  });
});
