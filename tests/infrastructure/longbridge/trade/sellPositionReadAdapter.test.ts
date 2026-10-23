/**
 * 卖出专用持仓读取边界：目标港股原始数量必须可证明为非负安全整数；
 * 账户 mapper 的 number 投影不能把 99.99999999999999999 当成 100 向上卖出；
 * 同一响应中的美股小数持仓不参与目标校验，不阻断港股卖出。
 */
import { describe, expect, it } from 'bun:test';
import type { StockPositionsResponse } from 'longbridge';
import { createQuantityResolver } from '../../../../src/application/orderExecution/quantityResolver.js';
import { createSellPositionReadAdapter } from '../../../../src/infrastructure/longbridge/trade/sellPositionReadAdapter.js';
import { createLoggerDouble, createRateLimiterDouble } from '../../../helpers/testDoubles.js';

type WirePosition = Readonly<{
  symbol: string;
  symbolName: string;
  quantity: string;
  availableQuantity: string;
}>;

function decimal(text: string): { toString: () => string } {
  return { toString: () => text };
}

/** 真实 SDK DTO 形状只在 infrastructure 测试内构造；adapter 读取原始文本后交给 mapper。 */
function createResponse(positions: ReadonlyArray<WirePosition>): StockPositionsResponse {
  return {
    channels: [
      {
        accountChannel: 'lb',
        positions: positions.map((position) => ({
          symbol: position.symbol,
          symbolName: position.symbolName,
          quantity: decimal(position.quantity),
          availableQuantity: decimal(position.availableQuantity),
          currency: position.symbol.endsWith('.HK') ? 'HKD' : 'USD',
          costPrice: decimal('1'),
        })),
      },
    ],
  } as unknown as StockPositionsResponse;
}

function createContext(response: StockPositionsResponse): unknown {
  return {
    stockPositions: async (_symbols?: ReadonlyArray<string>) => response,
  };
}

function createResolver(response: StockPositionsResponse) {
  const readSellPositions = createSellPositionReadAdapter(createContext(response));
  return {
    readSellPositions,
    resolver: createQuantityResolver({
      logger: createLoggerDouble(),
      rateLimiter: createRateLimiterDouble(),
      readSellPositions,
    }),
  };
}

describe('sellPositionReadAdapter target quantity proof', () => {
  it('passes a normal HK integer and keeps an unrelated fractional US holding non-blocking', async () => {
    const { readSellPositions, resolver } = createResolver(
      createResponse([
        { symbol: '700.HK', symbolName: 'Tencent', quantity: '100', availableQuantity: '80' },
        { symbol: 'AAPL.US', symbolName: 'Apple', quantity: '1.125', availableQuantity: '0.5' },
      ]),
    );

    const positions = await readSellPositions('700.HK');
    expect(positions.find((position) => position.symbol === 'AAPL.US')?.quantity).toBe(1.125);
    expect(await resolver.readFreshAvailableSellQuantity('700.HK', () => true)).toBe(80);
  });

  it('ignores empty-name target positions before proving raw quantities', async () => {
    const settlementPosition: WirePosition = {
      symbol: '700.HK',
      symbolName: '',
      quantity: '99.99999999999999999',
      availableQuantity: '99.99999999999999999',
    };
    const { readSellPositions, resolver } = createResolver(
      createResponse([
        settlementPosition,
        { symbol: '700.HK', symbolName: 'Tencent', quantity: '100', availableQuantity: '80' },
      ]),
    );

    expect(await readSellPositions('700.HK')).toMatchObject([
      { symbol: '700.HK', symbolName: 'Tencent', quantity: 100, availableQuantity: 80 },
    ]);
    expect(await resolver.readFreshAvailableSellQuantity('700.HK', () => true)).toBe(80);

    const onlySettlement = createResolver(createResponse([settlementPosition]));
    expect(await onlySettlement.readSellPositions('700.HK')).toEqual([]);
    expect(await onlySettlement.resolver.readFreshAvailableSellQuantity('700.HK', () => true)).toBe(
      0,
    );
  });

  it.each(['99.99999999999999999', '100.00000000000000001', '100.5'])(
    'rejects HK quantity text %s that number mapping could round into an integer',
    async (quantity) => {
      const { resolver } = createResolver(
        createResponse([
          { symbol: '700.HK', symbolName: 'Tencent', quantity, availableQuantity: quantity },
          { symbol: 'AAPL.US', symbolName: 'Apple', quantity: '1.125', availableQuantity: '0.5' },
        ]),
      );

      const error = await resolver
        .readFreshAvailableSellQuantity('700.HK', () => true)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RangeError);
    },
  );

  it('does not strict-check US rows when the HK target has no position', async () => {
    const { resolver } = createResolver(
      createResponse([
        { symbol: 'AAPL.US', symbolName: 'Apple', quantity: '1.125', availableQuantity: '0.5' },
      ]),
    );

    expect(await resolver.readFreshAvailableSellQuantity('700.HK', () => true)).toBe(0);
  });
});
