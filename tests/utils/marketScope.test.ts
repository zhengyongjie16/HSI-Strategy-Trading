/** 市场范围 helper：港股判定只依赖 ticker.region，坏结构直接抛内部契约错误。 */
import { describe, expect, it } from 'bun:test';
import { isHongKongSymbol } from '../../src/utils/marketScope.js';

describe('isHongKongSymbol', () => {
  it.each(['700.HK', '00700.HK', 'HSI.HK', 'A.HK', 'BULL.OLD.HK'])(
    'accepts Hong Kong symbol %s',
    (symbol) => {
      expect(isHongKongSymbol(symbol)).toBe(true);
    },
  );

  it.each(['AAPL.US', 'BRK.A.US', '700.SG', '700.JP', 'D05.SI'])(
    'rejects well-formed non-Hong-Kong symbol %s',
    (symbol) => {
      expect(isHongKongSymbol(symbol)).toBe(false);
    },
  );

  it.each([
    ['', 'empty string'],
    [' ', 'blank string'],
    ['AAPL', 'missing market region'],
    ['700.hk', 'lowercase ticker/region'],
    [' HK.HK', 'leading whitespace'],
    ['HK.12345', 'region in ticker position'],
    [123, 'non-string value'],
    [null, 'null value'],
    [undefined, 'undefined value'],
  ] as const)('throws on broken symbol structure: %s', (symbol) => {
    expect(() => isHongKongSymbol(symbol)).toThrow(TypeError);
  });
});
