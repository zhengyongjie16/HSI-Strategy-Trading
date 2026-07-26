/**
 * delayedSignalVerifier 业务测试
 *
 * 功能：
 * - 验证延迟验证在单 monitor 内部契约下的通过、拒绝、取消与 fatal 上报语义。
 */
import { describe, expect, it } from 'bun:test';

import { createIndicatorCache as createIndicatorCacheImpl } from '../../../../src/main/asyncProgram/indicatorCache/index.js';
import { createDelayedSignalVerifier as createDelayedSignalVerifierImpl } from '../../../../src/main/asyncProgram/delayedSignalVerifier/index.js';
import { performVerification } from '../../../../src/main/asyncProgram/delayedSignalVerifier/utils.js';
import type { IndicatorCache } from '../../../../src/main/asyncProgram/indicatorCache/types.js';
import type { VerificationIndicator } from '../../../../src/types/indicatorProfile.js';
import { createSignal } from '../../../../mock/factories/signalFactory.js';

const K_VERIFICATION_INDICATORS: ReadonlyArray<VerificationIndicator> = ['K'];
const ADX_VERIFICATION_INDICATORS: ReadonlyArray<VerificationIndicator> = ['ADX'];

function createIndicatorCache(): IndicatorCache {
  return createIndicatorCacheImpl();
}

function createDelayedSignalVerifier(params: {
  readonly indicatorCache: IndicatorCache;
  readonly onFatalError: (error: unknown) => void;
}) {
  return createDelayedSignalVerifierImpl({
    ...params,
    clock: { now: () => new Date(Date.now()) },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
}

function rethrowFatalError(error: unknown): never {
  throw error;
}

function withMockedNowSync<T>(nowMs: number, run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function createSampleK(k: number) {
  return {
    K: {
      kind: 'value' as const,
      value: k,
    },
  };
}

function createSampleAdx(adx: number) {
  return {
    ADX: {
      kind: 'value' as const,
      value: adx,
    },
  };
}

describe('delayedSignalVerifier business flow', () => {
  it('passes BUYCALL from minimal verification samples without full snapshot payload', async () => {
    const baseTime = 90_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: rethrowFatalError,
    });

    for (const sample of [
      { values: createSampleK(11), timestamp: baseTime },
      { values: createSampleK(12), timestamp: baseTime + 5_000 },
      { values: createSampleK(13), timestamp: baseTime + 10_000 },
    ]) {
      indicatorCache.push(sample.values, sample.timestamp);
    }

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(verified).toBe(1);
    expect(verifier.getPendingCount()).toBe(0);
  });

  it('exposes verification execution errors to fatal handler', async () => {
    const baseTime = 91_000;
    const errors: unknown[] = [];
    const indicatorCache: IndicatorCache = {
      push: () => {},
      getClosest: () => {
        throw new TypeError('indicator cache broken');
      },
      clearAll: () => {},
    };
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: (error) => {
        errors.push(error);
      },
    });
    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect((errors[0] as Error).message).toContain('indicator cache broken');
  });

  it('exposes verified callback exceptions to fatal handler', async () => {
    const baseTime = 92_000;
    const errors: unknown[] = [];
    const indicatorCache = createIndicatorCache();
    for (const sample of [
      { values: createSampleK(11), timestamp: baseTime },
      { values: createSampleK(12), timestamp: baseTime + 5_000 },
      { values: createSampleK(13), timestamp: baseTime + 10_000 },
    ]) {
      indicatorCache.push(sample.values, sample.timestamp);
    }

    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: (error) => {
        errors.push(error);
      },
    });
    verifier.onVerified(() => {
      throw new TypeError('verified callback invariant broken');
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal: createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: baseTime,
          indicators1: { K: 10 },
        }),
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect((errors[0] as Error).message).toBe('verified callback invariant broken');
  });

  it('passes BUYCALL plus ADX when all verification points decline', async () => {
    const baseTime = 500_000;
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: rethrowFatalError,
    });

    for (const sample of [
      { values: createSampleAdx(22), timestamp: baseTime },
      { values: createSampleAdx(21), timestamp: baseTime + 5_000 },
      { values: createSampleAdx(20), timestamp: baseTime + 10_000 },
    ]) {
      indicatorCache.push(sample.values, sample.timestamp);
    }

    let verified = 0;
    verifier.onVerified(() => {
      verified += 1;
    });

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { ADX: 25 },
    });

    withMockedNowSync(baseTime + 10_000, () => {
      verifier.addSignal({
        signal,
        verificationIndicators: ADX_VERIFICATION_INDICATORS,
      });
    });

    await Bun.sleep(20);

    expect(verified).toBe(1);
  });

  it('rejects invalid sample points and reports 值无效', () => {
    const baseTime = 200_000;
    const indicatorCache = createIndicatorCache();
    for (const timestamp of [baseTime, baseTime + 5_000, baseTime + 10_000]) {
      indicatorCache.push({ K: { kind: 'invalid' } }, timestamp);
    }

    const signal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: baseTime,
      indicators1: { K: 10 },
    });
    const timerId = setTimeout(() => {}, 0);
    const result = performVerification(indicatorCache, {
      signal,
      triggerTime: baseTime,
      initialIndicators: { K: 10 },
      indicatorNames: K_VERIFICATION_INDICATORS,
      timerId,
    });
    clearTimeout(timerId);

    expect(result.passed).toBeFalse();
    expect(result.reason).toContain('值无效');
  });

  it('clears pending signals by direction on symbol switch', () => {
    const indicatorCache = createIndicatorCache();
    const verifier = createDelayedSignalVerifier({
      indicatorCache,
      onFatalError: rethrowFatalError,
    });

    const now = 500_000;
    withMockedNowSync(now, () => {
      verifier.addSignal({
        signal: createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: now,
          indicators1: { K: 10 },
        }),
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });

      verifier.addSignal({
        signal: createSignal({
          symbol: 'BEAR.HK',
          action: 'BUYPUT',
          triggerTimeMs: now,
          indicators1: { K: 10 },
        }),
        verificationIndicators: K_VERIFICATION_INDICATORS,
      });
    });

    const cancelledLong = verifier.cancelAllForDirection('LONG');

    expect(cancelledLong).toBe(1);
    expect(verifier.getPendingCount()).toBe(1);
    verifier.destroy();
  });
});
