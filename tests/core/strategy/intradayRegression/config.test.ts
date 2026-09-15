/** T02–T04：真实资产、严格 JSON 和旧 DSL 接受集合回归。 */
import { describe, expect, it } from 'bun:test';
import asset from '../../../../src/core/strategy/intradayRegression/config.json';
import { parseStrategyConfig } from '../../../../src/core/strategy/intradayRegression/config.js';
import { strategyDefinition } from '../../../../src/core/strategy/intradayRegression/definition.js';
import { parseSignalConfig } from '../../../../src/core/strategy/intradayRegression/dsl.js';
import { evaluateSignalConfig } from '../../../../src/core/strategy/intradayRegression/utils.js';
import { configObject, createHarness } from './fixtures.js';

function expectFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}

describe('strict strategy prepare', () => {
  it('prepares the explicitly authorized local env asset, preserving expressions and both sides', () => {
    const config = parseStrategyConfig(asset);
    expect(config.signals).toEqual({
      BUYCALL: '(RSI:6<25,MFI<15,D<25,J<0.5)/3|(J<-25)',
      SELLCALL: '(RSI:6>70,MFI>75,D>70,J>90)/3|(J>125)',
      BUYPUT: '(RSI:6>80,MFI>85,D>80,J>95)/3|(J>125)',
      SELLPUT: '(RSI:6<30,MFI<20,D<30,J<5)/3|(J<-25)',
    });

    expect(config.verification).toEqual({
      buy: { delaySeconds: 60, indicators: ['D', 'ADX'] },
      sell: { delaySeconds: 60, indicators: ['K'] },
    });
    expect(config.profile.requiredPeriods.rsi).toEqual([6]);
    expect(config.profile.verificationIndicatorsBySide).toEqual({ buy: ['D', 'ADX'], sell: ['K'] });
    expectFrozen(config);
    const prepared = strategyDefinition.prepare();
    const harness = createHarness();
    const instance = prepared.create(harness.deps);
    expect(instance.strategyId).toBe('intraday-regression');
    expect(harness.events).toEqual([]);
    instance.destroy();
  });

  it('rejects missing/null/unknown/own fields and wrong types without text parsing', () => {
    const valid = configObject();
    const invalid: ReadonlyArray<unknown> = [
      '{}',
      null,
      [],
      {},
      { ...valid, extra: true },
      { ...valid, signals: null },
      { ...valid, signals: { ...valid.signals, BUYCALL: null } },
      { ...valid, signals: { ...valid.signals, BUYCALL: '(ADX>1)' } },
      {
        ...valid,
        verification: { ...valid.verification, buy: { delaySeconds: '0', indicators: [] } },
      },
      {
        ...valid,
        verification: { ...valid.verification, buy: { delaySeconds: 0, indicators: [null] } },
      },
      Object.create(valid),
      Object.assign({}, valid, { [Symbol('extra')]: true }),
      Object.defineProperty({ ...valid }, 'extra', { value: true }),
    ];
    for (const value of invalid) expect(() => parseStrategyConfig(value)).toThrow();
  });

  it('normalizes and freezes an independent copy, never the shared imported object', () => {
    const source = configObject(1, 2, [' EMA:007 ', 'EMA:7', 'ADX'], ['K']);
    const before = structuredClone(source);
    const config = parseStrategyConfig(source);
    expect(source).toEqual(before);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.verification.buy.indicators)).toBe(false);
    expect(config.verification.buy.indicators).toEqual(['EMA:7', 'ADX']);
    expect(config.verification.buy.indicators).not.toBe(source.verification.buy.indicators);
    expectFrozen(config);
    strategyDefinition.prepare();
    expect(Object.isFrozen(asset)).toBe(false);
    expect(Object.isFrozen(asset.verification.buy.indicators)).toBe(false);
  });

  it('accepts finite decimal delays and preserves indicator normalization and order', () => {
    for (const value of [0, 120, 0.5, 0.0001, 1e-10])
      expect(parseStrategyConfig(configObject(value)).verification.buy.delaySeconds).toBe(value);

    for (const value of [-1, 120.1, Number.NaN, Infinity, -Infinity])
      expect(() => parseStrategyConfig(configObject(value))).toThrow();

    const config = parseStrategyConfig(configObject(0, 120, [' EMA:007 ', 'ADX', 'EMA:7'], []));
    expect(config.verification.buy.indicators).toEqual(['EMA:7', 'ADX']);
    expect(config.profile.displayPlan).toContain('EMA:7');
    expect(config.profile.displayPlan).toContain('ADX');
    for (const item of ['RSI:6', 'MFI', 'EMA:0', 'EMA:251', 'PSY:101', 'K,D', ''])
      expect(() => parseStrategyConfig(configObject(1, 0, [item]))).toThrow();
  });

  it('keeps empty OR segment counting, whitespace distinctions, N-of-M, negatives and decimal literals', () => {
    for (const text of [
      '|(K<20)',
      '(K<20)||',
      '(K<20)|',
      '(K<20,MFI<15)/1|(J<-25)',
      'K<0.00000001',
    ])
      expect(parseSignalConfig(text)).not.toBeNull();

    for (const text of ['(K<20)|||', '(K<20)| |', '(K<20)/0', '(K<20)/2', '(K<1e-8)'])
      expect(parseSignalConfig(text)).toBeNull();

    const partial = parseSignalConfig('(RSI:6<25,MFI<15,D<25,J<0.5)/2');
    expect(evaluateSignalConfig({ kdj: { d: 20, j: -5 } }, partial).triggered).toBe(true);
    expect(evaluateSignalConfig({ kdj: { d: 20 } }, partial).triggered).toBe(false);
  });
});
