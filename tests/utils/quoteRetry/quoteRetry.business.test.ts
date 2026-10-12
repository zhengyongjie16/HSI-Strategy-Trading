/**
 * quoteRetry 就绪分类与重试政策业务回归。
 * 保留原 missing/非正价格/lot 分类，验证精确文本与结构安全整数边界；
 * 内部非法金融契约直接抛错，不伪装成普通可重试报价，也不签自然成交或 H/S ready。
 */
import { describe, expect, it } from 'bun:test';

import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../../src/utils/quoteRetry/index.js';
import type { Quote } from '../../../src/types/quote.js';

function createQuote(params: Partial<Quote> = {}): Quote {
  return {
    symbol: 'BULL.HK',
    name: '测试牛证',
    price: '1.23',
    prevClose: '1.2',
    timestamp: Date.parse('2026-05-10T01:30:00.000Z'),
    ...params,
  };
}

describe('quoteRetry readiness classification', () => {
  it('classifies missing quote as MISSING', () => {
    expect(resolveQuoteReadinessForRequirement({ quote: null, requirement: 'PRICE' })).toBe(
      'MISSING',
    );
  });

  it('classifies invalid price separately from missing quote', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ price: '0' }),
        requirement: 'PRICE',
      }),
    ).toBe('INVALID_PRICE');

    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ price: '-1' }),
        requirement: 'PRICE',
      }),
    ).toBe('INVALID_PRICE');
  });

  it('classifies ready price-only quotes as READY', () => {
    expect(
      resolveQuoteReadinessForRequirement({ quote: createQuote(), requirement: 'PRICE' }),
    ).toBe('READY');
  });

  it('classifies missing and invalid lot size for price-and-lot-size requirement', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote(),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('MISSING_LOT_SIZE');

    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ lotSize: 0 }),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('INVALID_LOT_SIZE');
  });

  it('classifies price-and-lot-size quote as READY only when both fields are valid', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ lotSize: 500 }),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('READY');
  });

  it('accepts literal 1 and exact positive text without mutating its original precision', () => {
    for (const price of [
      '1',
      '0.0000000000000000000000000001',
      '9007199254740993.0000000000000001',
    ]) {
      const quote = Object.freeze(createQuote({ price, lotSize: 100 }));
      expect(resolveQuoteReadinessForRequirement({ quote, requirement: 'PRICE' })).toBe('READY');
      expect(
        resolveQuoteReadinessForRequirement({ quote, requirement: 'PRICE_AND_LOT_SIZE' }),
      ).toBe('READY');
      expect(quote.price).toBe(price);
    }
  });

  it('keeps zero, signed zero and negative text in the original nontrading INVALID_PRICE class', () => {
    for (const price of ['0', '-0', '+0.000', '-0.0000000000000000000000000001']) {
      expect(
        resolveQuoteReadinessForRequirement({
          quote: createQuote({ price }),
          requirement: 'PRICE_AND_LOT_SIZE',
        }),
      ).toBe('INVALID_PRICE');
    }
  });

  it('fails fast on malformed financial text rather than returning a retry classification', () => {
    for (const price of ['', 'NaN', 'Infinity', '1e2', ' 1', '1 ', '.1', '1.2.3']) {
      expect(() =>
        resolveQuoteReadinessForRequirement({
          quote: createQuote({ price }),
          requirement: 'PRICE',
        }),
      ).toThrow(TypeError);
    }
  });

  it('rejects runtime number and Decimal-like bridges without invoking financial coercion', () => {
    let coerced = 0;
    const decimalLike = {
      toString: () => {
        coerced += 1;
        return '1';
      },
    };
    for (const price of [1, Number.NaN, decimalLike]) {
      const quote = createQuote();
      // 仅模拟内部契约损坏：不通过类型桥为生产调用提供兼容入口。
      Reflect.set(quote, 'price', price);
      expect(() =>
        resolveQuoteReadinessForRequirement({ quote, requirement: 'PRICE_AND_LOT_SIZE' }),
      ).toThrow(TypeError);
    }

    expect(coerced).toBe(0);
  });

  it('requires a positive safe integer lot size while price-only does not require lot evidence', () => {
    for (const lotSize of [
      -1,
      0,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        resolveQuoteReadinessForRequirement({
          quote: createQuote({ price: '1', lotSize }),
          requirement: 'PRICE_AND_LOT_SIZE',
        }),
      ).toBe('INVALID_LOT_SIZE');

      expect(
        resolveQuoteReadinessForRequirement({
          quote: createQuote({ price: '1', lotSize }),
          requirement: 'PRICE',
        }),
      ).toBe('READY');
    }

    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ price: '1', lotSize: Number.MAX_SAFE_INTEGER }),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('READY');
  });
});

describe('quoteRetry attempt and interval policy', () => {
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
