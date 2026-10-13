/** 换标领域 policy 测试：显式区分周期替换与距离移仓，并验证精确卖出预算的整手/安全整数边界。 */
import { describe, expect, it } from 'bun:test';
import {
  calculateBuyQuantityByNotional,
  resolveSeatSwitchPolicy,
} from '../../../src/domain/seat/switchPolicy.js';
import { initialSwitchState } from '../../../src/domain/seat/switchState.js';

describe('seat switch policy', () => {
  it('PERIODIC_REPLACE 不卖旧、不回补；DISTANCE_MOVE 使用实际卖出金额在 SWITCHING 内回补', () => {
    const periodic = resolveSeatSwitchPolicy('PERIODIC');
    const distance = resolveSeatSwitchPolicy('DISTANCE');
    expect(periodic).toMatchObject({
      kind: 'PERIODIC_REPLACE',
      oldSeatHandling: 'REQUIRE_EMPTY',
      stageAfterCancellation: 'BIND_NEW',
      rebuy: 'NONE',
    });

    expect(distance).toMatchObject({
      kind: 'DISTANCE_MOVE',
      oldSeatHandling: 'SELL_AVAILABLE_AND_WAIT_EMPTY',
      stageAfterCancellation: 'SELL_OUT',
      rebuy: 'ACTUAL_SELL_AMOUNT_IN_SWITCHING',
      orderTypeOverride: 'ELO',
    });
    const state = initialSwitchState({
      direction: 'LONG',
      switchMode: 'PERIODIC',
      seatVersion: 2,
      oldSymbol: 'OLD.HK',
      nextSymbol: 'NEXT.HK',
      nextCallPrice: '21000',
      shouldRebuy: true,
    });
    expect(state.shouldRebuy).toBeFalse();
  });

  it('低于整手预算的最后一位不可经 number 舍入进下一手，安全整数溢出直接暴露', () => {
    expect(calculateBuyQuantityByNotional('999.999999999999999999', '1', 100)).toBe(900);
    expect(calculateBuyQuantityByNotional('1000.000000000000000001', '1', 100)).toBe(1000);
    expect(calculateBuyQuantityByNotional('99.999999999999999999', '1', 100)).toBeNull();
    expect(calculateBuyQuantityByNotional('9007199254740991', '1', 1)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => calculateBuyQuantityByNotional('9007199254740992', '1', 1)).toThrow(RangeError);
    expect(() => calculateBuyQuantityByNotional('1000', '1', 1.5)).toThrow(RangeError);
  });
});
