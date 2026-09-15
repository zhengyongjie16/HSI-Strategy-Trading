/** T11–T13：最近样本、ADX、派生窗口、终态化与时间异常。 */
import { describe, expect, it } from 'bun:test';
import type { StrategyDecision } from '../../../../../src/core/strategy/types.js';
import type { DelayedCandidate } from '../../../../../src/core/strategy/intradayRegression/verification/types.js';
import {
  createPendingVerification,
  passesVerification,
} from '../../../../../src/core/strategy/intradayRegression/verification/index.js';
import { createVerificationSampleStore } from '../../../../../src/core/strategy/intradayRegression/verification/sampleStore.js';

import { prepareFixture, configObject, createHarness, marketContext } from '../fixtures.js';

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

describe('private verification', () => {
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

  it('keeps max BOTH sides delay +25 seconds including empty-indicator immediate side', () => {
    const h = createHarness();
    const strategy = prepareFixture(configObject(120, 1, [], ['K'])).create(h.deps);
    const result: StrategyDecision[] = [];
    strategy.onCandlestick(marketContext(), (value) => {
      result.push(value);
    });

    strategy.onCandlestick(
      { ...marketContext(80, 2, now + 6000), allowNewEvaluation: false },
      () => {},
    );

    // 139 秒时仍保留最早样本（窗口145秒），T0 最近为初始值，因此不能通过。
    strategy.onCandlestick(
      { ...marketContext(80, 2, now + 139000), allowNewEvaluation: false },
      () => {},
    );
    h.timers[1]?.callback();
    expect(result.map((value) => value.action)).toEqual(['BUYCALL', 'BUYPUT']);
    strategy.destroy();
    const store = createVerificationSampleStore(145000);
    store.push({ K: { kind: 'value', value: 1 } }, now);
    expect(store.getClosest(now)?.timestamp).toBe(now);
    store.push({ K: { kind: 'value', value: 2 } }, now + 145000);
    expect(store.getClosest(now)?.timestamp).toBe(now);
    store.push({ K: { kind: 'value', value: 3 } }, now + 145001);
    expect(store.getClosest(now)?.timestamp).toBe(now + 145000);
  });

  it('terminalizes before emitter reentrancy, and callback failures are fatal only once per token', () => {
    const h = createHarness();
    const store = createVerificationSampleStore(85000);
    store.push({ K: { kind: 'value', value: 51 }, ADX: { kind: 'value', value: 29 } }, now + 5000);
    const pending = createPendingVerification(store, h.deps);
    const item = candidate();
    pending.register(item, () => {
      pending.register(item, () => {});
      throw new Error('emitter');
    });
    h.timers[0]?.callback();
    expect(h.errors).toHaveLength(1);
    expect(h.timers).toHaveLength(2);
    h.timers[0]?.callback();
    expect(h.errors).toHaveLength(1);
    h.timers[1]?.callback();
    pending.destroy();
  });

  it('uses zero relative delay for overdue deadlines, never epoch and rejects timer overflow/invalid ready dates', () => {
    const h = createHarness();
    const store = createVerificationSampleStore(85000);
    const pending = createPendingVerification(store, h.deps);
    h.setNow(now + 10001);
    pending.register(candidate(), () => {});
    expect(h.timers[0]?.delay).toBe(0);
    h.setNow(now - 2_147_483_647);
    expect(() => {
      pending.register({ ...candidate(), symbol: 'NEW.HK' }, () => {});
    }).toThrow('timer');

    expect(() => {
      pending.register(
        { ...candidate(), decision: { action: 'BUYCALL', triggerTimeMs: 8_640_000_000_000_000 } },
        () => {},
      );
    }).toThrow('时间');
    pending.destroy();
  });
});
