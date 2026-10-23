/**
 * 账户持仓 mapper：账户数量允许有限非负小数，不截断、不丢美股持仓；金额仍保持精确文本。
 */
import { describe, expect, it } from 'bun:test';
import type { StockPositionsResponse } from 'longbridge';
import { mapStockPositions } from '../../../../src/infrastructure/longbridge/trade/accountMapper.js';

type WirePosition = Readonly<{
  symbol: string;
  symbolName: string;
  quantity: string;
  availableQuantity: string;
  currency: string;
  costPrice: string;
}>;

function decimal(text: string): { toString: () => string } {
  return { toString: () => text };
}

/** SDK DTO 只在 infrastructure 测试内构造；mapper 只读取 toString 文本字段。 */
function createResponse(
  channels: ReadonlyArray<ReadonlyArray<WirePosition>>,
): StockPositionsResponse {
  return {
    channels: channels.map((positions, index) => ({
      accountChannel: `channel-${index}`,
      positions: positions.map((position) => ({
        symbol: position.symbol,
        symbolName: position.symbolName,
        quantity: decimal(position.quantity),
        availableQuantity: decimal(position.availableQuantity),
        currency: position.currency,
        costPrice: decimal(position.costPrice),
      })),
    })),
  } as unknown as StockPositionsResponse;
}

describe('mapStockPositions', () => {
  it('keeps fractional US holdings alongside integer HK holdings without truncation', () => {
    const positions = mapStockPositions(
      createResponse([
        [
          {
            symbol: '700.HK',
            symbolName: 'Tencent',
            quantity: '100',
            availableQuantity: '80',
            currency: 'HKD',
            costPrice: '300.5000',
          },
          {
            symbol: 'AAPL.US',
            symbolName: 'Apple',
            quantity: '1.125',
            availableQuantity: '0.0625',
            currency: 'USD',
            costPrice: '180.1234567890123456789',
          },
        ],
      ]),
    );

    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      symbol: '700.HK',
      quantity: 100,
      availableQuantity: 80,
      costPrice: '300.5',
    });

    expect(positions[1]).toMatchObject({
      symbol: 'AAPL.US',
      quantity: 1.125,
      availableQuantity: 0.0625,
      costPrice: '180.1234567890123456789',
    });
  });

  it('filters nonzero positions with an empty symbol or name across channels', () => {
    const settlementPosition: WirePosition = {
      symbol: '',
      symbolName: '',
      quantity: '270000',
      availableQuantity: '270000',
      currency: 'HKD',
      costPrice: '0.071',
    };
    const positions = mapStockPositions(
      createResponse([
        [
          settlementPosition,
          { ...settlementPosition, symbol: '700.HK', symbolName: 'Tencent' },
          { ...settlementPosition, symbol: '9988.HK' },
        ],
        [
          {
            ...settlementPosition,
            symbol: 'AAPL.US',
            symbolName: 'Apple',
            quantity: '1.125',
            availableQuantity: '0.5',
            currency: 'USD',
          },
          { ...settlementPosition, symbolName: 'Pending settlement' },
        ],
      ]),
    );

    expect(positions.map(({ accountChannel, symbol }) => ({ accountChannel, symbol }))).toEqual([
      { accountChannel: 'channel-0', symbol: '700.HK' },
      { accountChannel: 'channel-1', symbol: 'AAPL.US' },
    ]);

    expect(
      mapStockPositions(
        createResponse([
          [settlementPosition, { ...settlementPosition, symbol: '9988.HK' }],
          [],
          [{ ...settlementPosition, symbolName: 'Pending settlement' }],
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects negative, non-finite and malformed account quantities', () => {
    const responseFor = (quantity: string): StockPositionsResponse =>
      createResponse([
        [
          {
            symbol: 'AAPL.US',
            symbolName: 'Apple',
            quantity,
            availableQuantity: quantity,
            currency: 'USD',
            costPrice: '1',
          },
        ],
      ]);

    expect(() => mapStockPositions(responseFor('-0.5'))).toThrow(RangeError);
    expect(() => mapStockPositions(responseFor('9'.repeat(400)))).toThrow(RangeError);
    expect(() => mapStockPositions(responseFor('abc'))).toThrow(TypeError);
  });
});
