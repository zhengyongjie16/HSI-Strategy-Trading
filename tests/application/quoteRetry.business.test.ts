/**
 * 跨 application 行情有限重试计算回归。
 * 保留既有五次/两秒边界、显式覆盖以及零次即耗尽的时点语义。
 */
import { describe, expect, it } from 'bun:test';
import { resolveNextQuoteRetry } from '../../src/application/quoteRetry.js';

describe('application quote retry attempt and interval policy', () => {
  it('keeps five default retry slots at the established two-second interval', () => {
    for (let attempts = 0; attempts < 5; attempts += 1) {
      expect(resolveNextQuoteRetry({ attempts, nowMs: 10_000 })).toEqual({
        nextAttempts: attempts + 1,
        nextRetryAt: 12_000,
        exhausted: false,
      });
    }

    expect(resolveNextQuoteRetry({ attempts: 5, nowMs: 10_000 })).toEqual({
      nextAttempts: 6,
      nextRetryAt: null,
      exhausted: true,
    });
  });

  it('retains explicit caller attempt limits and intervals including an exhausted zero-attempt policy', () => {
    expect(
      resolveNextQuoteRetry({ attempts: 1, nowMs: 10_000, intervalMs: 25, maxAttempts: 2 }),
    ).toEqual({
      nextAttempts: 2,
      nextRetryAt: 10_025,
      exhausted: false,
    });

    expect(
      resolveNextQuoteRetry({ attempts: 2, nowMs: 10_000, intervalMs: 25, maxAttempts: 2 }),
    ).toEqual({
      nextAttempts: 3,
      nextRetryAt: null,
      exhausted: true,
    });

    expect(
      resolveNextQuoteRetry({ attempts: 0, nowMs: 10_000, intervalMs: 0, maxAttempts: 0 }),
    ).toEqual({
      nextAttempts: 1,
      nextRetryAt: null,
      exhausted: true,
    });
  });
});
