/** 订单整手数量规则测试：保留精确预算边界、每手整数约束与不足一手的原用例。 */
import { describe, expect, it } from 'bun:test';
import { wholeLotQuantity } from '../../../src/domain/order/orderQuantity.js';

describe('whole lot quantity', () => {
  it('整数手数按精确名义预算向下取整，不经过近似除法', () => {
    expect(wholeLotQuantity('7000', '0.07', '10000')).toBe('100000');
    expect(wholeLotQuantity('7499.999', '2.500', '1000')).toBe('2000');
    expect(wholeLotQuantity('7500', '2.500', '1000')).toBe('3000');
    expect(wholeLotQuantity('1', '2.500', '1000')).toBe('0');
    expect(() => wholeLotQuantity('1', '0', '100')).toThrow(RangeError);
    expect(() => wholeLotQuantity('1', '1', '0.5')).toThrow(RangeError);
  });
});
