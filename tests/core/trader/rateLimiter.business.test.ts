/**
 * rateLimiter 业务测试
 *
 * 功能：
 * - 验证限流器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import { API } from '../../../src/constants/index.js';
import { createRateLimiter } from '../../../src/core/trader/rateLimiter.js';

describe('rateLimiter business behavior', () => {
  it('rechecks the interval when the scheduler wakes early', async () => {
    const originalNow = performance.now;
    const originalSetTimeout = globalThis.setTimeout;
    let currentTimeMs = 1_000;
    let waitCount = 0;

    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => currentTimeMs,
    });

    globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
      waitCount += 1;
      currentTimeMs += waitCount === 1 ? 25 : (delayMs ?? 0);
      const handle = originalSetTimeout(() => {}, 0);
      callback();
      return handle;
    }) as typeof setTimeout;

    try {
      const limiter = createRateLimiter({
        config: {
          maxCalls: 30,
          windowMs: 30_000,
        },
      });

      await limiter.throttle();
      const firstCallTimeMs = currentTimeMs;
      await limiter.throttle();

      expect(currentTimeMs - firstCallTimeMs).toBeGreaterThanOrEqual(API.MIN_CALL_INTERVAL_MS);
    } finally {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: originalNow,
      });
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('serializes concurrent calls and enforces minimum API interval', async () => {
    const originalNow = performance.now;
    const originalSetTimeout = globalThis.setTimeout;
    const initialTimeMs = 1_000;
    let currentTimeMs = initialTimeMs;
    const delays: number[] = [];
    const completions: number[] = [];

    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => currentTimeMs,
    });

    globalThis.setTimeout = ((callback: () => void, delayMs: number = 0) => {
      delays.push(delayMs);
      currentTimeMs += delayMs;
      const handle = originalSetTimeout(() => {}, 0);
      callback();
      return handle;
    }) as typeof setTimeout;

    try {
      const limiter = createRateLimiter({
        config: {
          maxCalls: 30,
          windowMs: 30_000,
        },
      });

      await Promise.all([
        limiter.throttle().then(() => {
          completions.push(1);
        }),
        limiter.throttle().then(() => {
          completions.push(2);
        }),
        limiter.throttle().then(() => {
          completions.push(3);
        }),
      ]);

      expect(completions).toEqual([1, 2, 3]);
      expect(delays).toEqual([API.MIN_CALL_INTERVAL_MS, API.MIN_CALL_INTERVAL_MS]);
      expect(currentTimeMs).toBe(initialTimeMs + API.MIN_CALL_INTERVAL_MS * 2);
    } finally {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: originalNow,
      });
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('serializes concurrent cancel submit and replace mutations through one callback permit', async () => {
    const limiter = createRateLimiter({
      config: {
        maxCalls: 30,
        windowMs: 30_000,
      },
    });
    const events: string[] = [];
    let releaseCancelQuote: (() => void) | undefined;
    const cancelQuoteEntered = new Promise<void>((resolve) => {
      releaseCancelQuote = resolve;
    });

    const cancel = limiter.withTradeMutation(async (permit) => {
      events.push('quote:cancel');
      await cancelQuoteEntered;
      return permit.invoke(async () => {
        events.push('sdk:cancel');
        return 'cancelled';
      });
    });
    const submit = limiter.withTradeMutation(async (permit) => {
      events.push('quote:submit');
      return permit.invoke(async () => {
        events.push('sdk:submit');
        return 'submitted';
      });
    });
    const replace = limiter.withTradeMutation(async (permit) => {
      events.push('quote:replace');
      return permit.invoke(async () => {
        events.push('sdk:replace');
        return 'replaced';
      });
    });

    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }

    expect(events).toEqual(['quote:cancel']);
    if (releaseCancelQuote === undefined) {
      throw new Error('cancel quote release is unavailable');
    }

    releaseCancelQuote();

    const results = await Promise.all([cancel, submit, replace]);

    expect(results).toEqual(['cancelled', 'submitted', 'replaced']);

    expect(events).toEqual([
      'quote:cancel',
      'sdk:cancel',
      'quote:submit',
      'sdk:submit',
      'quote:replace',
      'sdk:replace',
    ]);
  });

  it('does not consume SDK quota when a callback skips before invoking its permit', async () => {
    const originalNow = performance.now;
    const originalSetTimeout = globalThis.setTimeout;
    let waitCount = 0;

    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => 1_000,
    });

    globalThis.setTimeout = ((callback: () => void, _delayMs?: number) => {
      waitCount += 1;
      const handle = originalSetTimeout(() => {}, 0);
      callback();
      return handle;
    }) as typeof setTimeout;

    try {
      const limiter = createRateLimiter({
        config: {
          maxCalls: 1,
          windowMs: 30_000,
        },
      });

      await limiter.withTradeMutation(async () => 'quote-unavailable');
      await limiter.throttle();

      expect(waitCount).toBe(0);
    } finally {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: originalNow,
      });
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
