/** 智能平仓金融临界纯规则：保留金额/数量，显示均价或超卖不能改变阶段选择。 */
import { describe, expect, it } from 'bun:test';
import {
  isOverallProfitable,
  remainingSellQuantity,
  sumSmartCloseQuantities,
} from '../../../src/domain/order/smartClose.js';

describe('exact ordinary SELL rules', () => {
  it('compares cross products to original cost without quantizing a repeating average', () => {
    const cost = { costAmount: '1000', quantity: 3000 };
    expect(isOverallProfitable('0.333', cost)).toBeFalse();
    expect(isOverallProfitable('0.334', cost)).toBeTrue();

    expect(isOverallProfitable('0.001', { costAmount: '1', quantity: 1000 })).toBeFalse();
  });

  it('keeps safe integer stage caps and refuses a stage result beyond the available position', () => {
    expect(remainingSellQuantity(300, 250)).toBe(50);
    expect(sumSmartCloseQuantities(300, 250, 50)).toBe(300);
    expect(() => sumSmartCloseQuantities(300, 250, 51)).toThrow('超过授权上限');
    expect(() => remainingSellQuantity(300, 0.5)).toThrow('安全整数');
  });
});
