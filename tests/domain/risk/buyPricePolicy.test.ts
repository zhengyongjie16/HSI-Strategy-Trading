/** 普通 BUY 价格纯规则：原成本金额/数量才是权威依据，不使用显示舍入或 number 比较。 */
import { describe, expect, it } from 'bun:test';
import { isBuyPriceWithinLatestOrderLimit } from '../../../src/domain/risk/buyPricePolicy.js';

describe('exact ordinary BUY price limit', () => {
  it('uses original repeating average and rejects equality rather than quantizing the cost', () => {
    const cost = { costAmount: '1000', quantity: 3000 };
    expect(isBuyPriceWithinLatestOrderLimit('0.333', cost)).toBeTrue();
    expect(isBuyPriceWithinLatestOrderLimit('0.334', cost)).toBeFalse();
    expect(
      isBuyPriceWithinLatestOrderLimit('0.001', { costAmount: '1', quantity: 1000 }),
    ).toBeFalse();

    expect(() => isBuyPriceWithinLatestOrderLimit('1', { costAmount: '1', quantity: 0 })).toThrow(
      '正安全整数',
    );
  });
});
