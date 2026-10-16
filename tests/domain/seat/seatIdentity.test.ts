/** 席位版本规则测试：只接受有限且严格相等的版本，不新增整数化或缺失值兜底。 */
import { describe, expect, it } from 'bun:test';
import { isSeatVersionMatch } from '../../../src/domain/seat/seatIdentity.js';

describe('seat version matching', () => {
  it('保留有限数与严格相等边界', () => {
    expect(isSeatVersionMatch(2, 2)).toBeTrue();
    expect(isSeatVersionMatch(2, 3)).toBeFalse();
    expect(isSeatVersionMatch(null, 0)).toBeFalse();
    expect(isSeatVersionMatch(undefined, 0)).toBeFalse();
    expect(isSeatVersionMatch(Number.NaN, Number.NaN)).toBeFalse();
    expect(isSeatVersionMatch(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBeFalse();
    expect(isSeatVersionMatch(1.5, 1.5)).toBeTrue();
  });
});
