/**
 * 单标的持仓市值限制测试。
 * 保留成本价估值和包含上限等号的规则，验证金融文本低位不能因显示舍入被放行。
 */
import { describe, expect, it } from 'bun:test';
import { createPositionLimitChecker } from '../../../src/domain/risk/positionLimitChecker.js';
import { createPositionDouble, createSignalDouble } from '../../helpers/testDoubles.js';

const signal = createSignalDouble('BUYCALL', 'BULL.HK');

describe('position limit exact financial boundaries', () => {
  it('allows exact equality and rejects a lower-digit excess in planned or existing notional', () => {
    const checker = createPositionLimitChecker({ maxPositionNotional: '100' });
    const positions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 3,
        availableQuantity: 3,
        costPrice: '0.1',
      }),
    ];
    expect(checker.checkLimit(signal, positions, '99.7')).toEqual({ allowed: true });
    expect(checker.checkLimit(signal, positions, '99.700000000000000001').allowed).toBeFalse();
    expect(checker.checkLimit(signal, [], '100')).toEqual({ allowed: true });
    expect(checker.checkLimit(signal, [], '100.000000000000000001').allowed).toBeFalse();
  });

  it('checks planned notional first and does not replace a nonpositive cost price with market value', () => {
    const checker = createPositionLimitChecker({ maxPositionNotional: '100' });
    const positions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 1000,
        availableQuantity: 1000,
        costPrice: '0',
      }),
    ];
    expect(checker.checkLimit(signal, positions, '100')).toEqual({ allowed: true });
    expect(checker.checkLimit(signal, positions, '101').allowed).toBeFalse();
    expect(checker.checkLimit(signal, positions, '-1').allowed).toBeFalse();
  });

  it('fails fast for malformed financial or unsafe quantity facts instead of granting permission', () => {
    const checker = createPositionLimitChecker({ maxPositionNotional: '100' });
    const position = createPositionDouble({ symbol: 'BULL.HK', quantity: 3, availableQuantity: 3 });
    expect(() => checker.checkLimit(signal, [], 'NaN')).toThrow(TypeError);
    expect(() => checker.checkLimit(signal, [{ ...position, costPrice: '1e2' }], '1')).toThrow(
      TypeError,
    );

    expect(() => checker.checkLimit(signal, [{ ...position, quantity: 1.5 }], '1')).toThrow(
      RangeError,
    );
  });
});
