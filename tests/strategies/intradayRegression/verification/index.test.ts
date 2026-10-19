/** T11–T13：最近样本、ADX、派生窗口、终态化与时间异常。 */
import { describe, expect, it } from 'bun:test';
import type { StrategyDecision } from '../../../../src/types/strategy.js';
import type { DelayedCandidate } from '../../../../src/strategies/intradayRegression/verification/types.js';
import { passesVerification } from '../../../../src/strategies/intradayRegression/verification/index.js';
import { createVerificationSampleStore } from '../../../../src/strategies/intradayRegression/verification/sampleStore.js';

const now = 1_700_000_000_000;
function candidate(action: StrategyDecision['action'] = 'BUYCALL'): DelayedCandidate {
  return {
    symbol: 'BULL.HK',
    direction: 'LONG',
    decision: { action, triggerTimeMs: now },
    initial: { K: 50, ADX: 30 },
    indicators: ['K', 'ADX'],
  };
}

describe('pure verification', () => {
  it('allows one nearest sample for all three targets and requires strict ADX decline for all actions', () => {
    const store = createVerificationSampleStore(85000);
    for (const action of ['BUYCALL', 'SELLCALL', 'BUYPUT', 'SELLPUT'] as const) {
      store.clearAll();
      const k = action === 'BUYCALL' || action === 'SELLPUT' ? 51 : 49;
      store.push({ K: { kind: 'value', value: k }, ADX: { kind: 'value', value: 29 } }, now + 5000);
      expect(passesVerification(store, candidate(action))).toBe(true);
      store.push({ K: { kind: 'value', value: k }, ADX: { kind: 'value', value: 30 } }, now + 5001);
      expect(passesVerification(store, candidate(action))).toBe(false);
      store.clearAll();
      store.push(
        { K: { kind: 'value', value: 50 }, ADX: { kind: 'value', value: 29 } },
        now + 5000,
      );
      expect(passesVerification(store, candidate(action))).toBe(false);
    }
  });

  it('fails missing/invalid/nonfinite samples and missing initial without retry', () => {
    const store = createVerificationSampleStore(85000);
    expect(passesVerification(store, candidate())).toBe(false);
    for (const point of [
      { kind: 'missing' },
      { kind: 'invalid' },
      { kind: 'value', value: Number.NaN },
    ] as const) {
      store.clearAll();
      store.push({ K: point, ADX: { kind: 'value', value: 29 } }, now + 5000);
      expect(passesVerification(store, candidate())).toBe(false);
    }

    store.clearAll();
    store.push({ K: { kind: 'value', value: 51 }, ADX: { kind: 'value', value: 29 } }, now + 5000);
    expect(passesVerification(store, { ...candidate(), initial: { K: 51 } })).toBe(false);
  });
});
