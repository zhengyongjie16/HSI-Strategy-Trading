/**
 * Longbridge warrant 金融 mapper 测试：真实 SDK Decimal 原文、固定独立 oracle、缺失语义与失败不降级。
 * 仅检查 adapter 边界，不导入业务 recorder；该窄 warrant mapper 不处理 lot/quantity。
 */
import { describe, expect, it } from 'bun:test';
import { Decimal, WarrantStatus } from 'longbridge';
import {
  mapQuoteDecimal,
  mapWarrantQuote,
  mapWarrantListItem,
} from '../../../../src/infrastructure/longbridge/market/quoteFinancialMapper.js';

const CALL_PRICE = '18800.123456789012345678901235';
const TO_CALL_PRICE = '0.0035000000000000000000000001';
const TURNOVER = '9876543210987654321.123456789';
const LAST_DONE = '0.1234567890123456789012345678';
const FINANCIAL_FIELDS = ['callPrice', 'toCallPrice', 'turnover', 'lastDone'] as const;
const LIST_OUTPUT_FIELDS = ['callPrice', 'toCallPrice', 'turnover'] as const;

describe('Longbridge quoteFinancialMapper boundary', () => {
  it('preserves all four high-significant native SDK texts without a second financial rounding', () => {
    const sdk = Object.freeze({
      symbol: 'BULL.HK',
      name: '高精度牛证',
      warrantType: 7,
      status: WarrantStatus.Normal,
      callPrice: new Decimal(CALL_PRICE),
      toCallPrice: new Decimal(TO_CALL_PRICE),
      turnover: new Decimal(TURNOVER),
      lastDone: new Decimal(LAST_DONE),
    });
    // 固定原文既独立于 mapper，也先证实 SDK 本身提供了这些尾数。
    expect(sdk.callPrice.toString()).toBe(CALL_PRICE);
    expect(sdk.toCallPrice.toString()).toBe(TO_CALL_PRICE);
    expect(sdk.turnover.toString()).toBe(TURNOVER);
    expect(sdk.lastDone.toString()).toBe(LAST_DONE);
    expect(mapWarrantListItem(sdk)).toEqual({
      symbol: 'BULL.HK',
      status: 'NORMAL',
      callPrice: CALL_PRICE,
      toCallPrice: TO_CALL_PRICE,
      turnover: TURNOVER,
    });

    expect(mapWarrantQuote({ symbol: sdk.symbol, callPrice: sdk.callPrice, category: 1 })).toEqual({
      callPrice: CALL_PRICE,
      category: 1,
    });
    expect(sdk.turnover.toString()).toBe(TURNOVER);
  });

  it('accepts only the named Normal warrant status and keeps other SDK statuses non-normal', () => {
    expect(mapWarrantListItem({ symbol: 'BULL.HK', status: WarrantStatus.Normal }).status).toBe(
      'NORMAL',
    );

    for (const status of [WarrantStatus.Unknown, WarrantStatus.Suspend, WarrantStatus.PrepareList]) {
      expect(mapWarrantListItem({ symbol: 'BULL.HK', status }).status).toBe('NON_NORMAL');
    }
  });

  it('uses actual native toString evidence, never promises to reconstruct digits already lost inside SDK construction', () => {
    const native = new Decimal('18800.12345678901234567890123456');
    expect(native.toString()).toBe('18800.123456789012345678901235');
    expect(mapWarrantQuote({ symbol: 'BULL.HK', callPrice: native }).callPrice).toBe(
      '18800.123456789012345678901235',
    );

    expect(mapQuoteDecimal('0018800.12345678901234567890123500')).toBe(
      '18800.123456789012345678901235',
    );
  });

  it('keeps absent, explicit undefined and null distinct without manufacturing zero financial evidence', () => {
    const absentQuote = mapWarrantQuote({ symbol: 'BULL.HK' });
    const undefinedQuote = mapWarrantQuote({ symbol: 'BULL.HK', callPrice: undefined });
    const nullQuote = mapWarrantQuote({ symbol: 'BULL.HK', callPrice: null });
    expect(Object.hasOwn(absentQuote, 'callPrice')).toBe(false);
    expect(Object.hasOwn(undefinedQuote, 'callPrice')).toBe(true);
    expect(undefinedQuote.callPrice).toBeUndefined();
    expect(nullQuote.callPrice).toBeNull();
    const absentList = mapWarrantListItem({ symbol: 'BULL.HK' });
    expect(absentList.toCallPrice).toBeUndefined();
    expect(absentList.turnover).toBeUndefined();
    expect(Object.hasOwn(absentList, 'callPrice')).toBe(false);
    const unknownList = mapWarrantListItem({
      symbol: 'BULL.HK',
      lastDone: null,
      toCallPrice: undefined,
      turnover: null,
      callPrice: undefined,
    });
    expect(unknownList.toCallPrice).toBeUndefined();
    expect(unknownList.turnover).toBeNull();
    expect(Object.hasOwn(unknownList, 'callPrice')).toBe(true);
    expect(unknownList.callPrice).toBeUndefined();
    const nullList = mapWarrantListItem({
      symbol: 'BULL.HK',
      lastDone: null,
      toCallPrice: null,
      turnover: null,
      callPrice: null,
    });
    for (const field of LIST_OUTPUT_FIELDS) expect(nullList[field]).toBeNull();
  });

  it('preserves observed native-negative-zero text but does not fabricate a sign discarded by the actual SDK', () => {
    const native = new Decimal('-0');
    expect(native.toString()).toBe('0');
    expect(mapQuoteDecimal(native)).toBe('0');
    expect(mapWarrantQuote({ symbol: 'BULL.HK', callPrice: native }).callPrice).toBe('0');
    // Adapter 原始文本证据可以保留符号；这是原文 fixture，不是 number→SDK bridge。
    const signed = mapWarrantListItem({
      symbol: 'BULL.HK',
      callPrice: '-0',
      toCallPrice: '-0.000',
      turnover: { toString: () => '-0' },
      lastDone: '-000.00',
    });
    for (const field of LIST_OUTPUT_FIELDS) expect(signed[field]).toBe('-0');

    const zero = mapWarrantListItem({
      symbol: 'BULL.HK',
      callPrice: new Decimal('0'),
      toCallPrice: new Decimal('0'),
      turnover: new Decimal('0'),
      lastDone: new Decimal('0'),
    });
    for (const field of LIST_OUTPUT_FIELDS) expect(zero[field]).toBe('0');
  });

  it('rejects number financial bridges independently for every consumed warrant field', () => {
    for (const field of FINANCIAL_FIELDS) {
      expect(() => mapWarrantListItem({ symbol: 'BULL.HK', [field]: 1.25 })).toThrow(
        /must originate from Decimal text/,
      );
    }

    expect(() => mapWarrantQuote({ symbol: 'BULL.HK', callPrice: 18800.5 })).toThrow(
      /must originate from Decimal text/,
    );
    expect(() => mapQuoteDecimal(0)).toThrow(/must originate from Decimal text/);
  });

  it('fails malformed/nonfinite canonical input and non-text SDK toString without unknown/zero fallback', () => {
    for (const text of ['NaN', 'Infinity', '-Infinity', '1e3', '']) {
      expect(() =>
        mapWarrantQuote({ symbol: 'BULL.HK', callPrice: { toString: () => text } }),
      ).toThrow();
      expect(() => mapWarrantListItem({ symbol: 'BULL.HK', turnover: text })).toThrow();
    }

    expect(() =>
      mapWarrantListItem({ symbol: 'BULL.HK', lastDone: { toString: () => 12 } }),
    ).toThrow(/toString must return text/);
    expect(() => mapWarrantListItem({ symbol: 'BULL.HK', lastDone: 'NaN' })).toThrow();
    expect(() => mapWarrantListItem({ symbol: 'BULL.HK', warrantType: { kind: 'BULL' } })).toThrow(
      /Warrant enum field must be a scalar/,
    );
    expect(() => new Decimal('NaN')).toThrow();
    expect(() => new Decimal('Infinity')).toThrow();
  });

  it('propagates the original SDK text-read error rather than catching/reclassifying it as a missing value', () => {
    const original = new Error('native text read failed');
    let captured: unknown;
    try {
      mapWarrantListItem({
        symbol: 'BULL.HK',
        callPrice: {
          toString: () => {
            throw original;
          },
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBe(original);
    expect(() => mapWarrantQuote({ callPrice: new Decimal('1') })).toThrow(/identity missing/);
    expect(() => mapWarrantListItem({ symbol: 'BULL.HK', name: 12 })).toThrow(/name must be text/);
    expect(() => mapWarrantListItem({ symbol: 'BULL.HK', name: null })).not.toThrow();
  });
});
