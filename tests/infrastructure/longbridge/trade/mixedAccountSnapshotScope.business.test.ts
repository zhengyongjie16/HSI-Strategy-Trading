/**
 * 混合账户业务边界：账户小数读取经真实 mapper 进入 canonical snapshot，US 持仓只做估值/行情，
 * 不进入可卖 lookup 或港股卖出数量；港股数量异常仍按安全整数拒绝。
 */
import { describe, expect, it } from 'bun:test';
import type { StockPositionsResponse } from 'longbridge';
import { createAccountPositionSnapshot } from '../../../../src/application/accountPositionSnapshot/index.js';
import { createQuantityResolver } from '../../../../src/application/orderExecution/quantityResolver.js';
import { mapStockPositions } from '../../../../src/infrastructure/longbridge/trade/accountMapper.js';
import type { AccountSnapshot, Position } from '../../../../src/types/account.js';
import { createLoggerDouble, createRateLimiterDouble } from '../../../helpers/testDoubles.js';

const account: AccountSnapshot = {
  currency: 'HKD',
  totalCash: '100000',
  netAssets: '100450.5',
  positionValue: '450.5',
  cashInfos: [{ currency: 'HKD', availableCash: '100000' }],
};

function decimal(text: string): { toString: () => string } {
  return { toString: () => text };
}

/** 真实 SDK DTO 形状只在 infrastructure 边界构造；业务断言读取映射后事实。 */
function createPositionsResponse(
  positions: ReadonlyArray<{
    symbol: string;
    quantity: string;
    availableQuantity: string;
    currency: string;
    costPrice: string;
  }>,
): StockPositionsResponse {
  return {
    channels: [
      {
        accountChannel: 'lb',
        positions: positions.map((holding) => ({
          symbol: holding.symbol,
          symbolName: holding.symbol,
          quantity: decimal(holding.quantity),
          availableQuantity: decimal(holding.availableQuantity),
          currency: holding.currency,
          costPrice: decimal(holding.costPrice),
        })),
      },
    ],
  } as unknown as StockPositionsResponse;
}

async function commitSnapshot(response: StockPositionsResponse) {
  const owner = createAccountPositionSnapshot({
    dayEpoch: 1,
    scheduler: {
      schedule: (callback) => {
        queueMicrotask(callback);
      },
    },
    clock: { now: () => new Date(0) },
    diagnostics: { record: () => {} },
    reportFatalError: (error) => {
      throw error;
    },
    readPort: {
      getAccountSnapshot: async () => account,
      getStockPositions: async () => mapStockPositions(response),
    },
  });
  const receipt = await owner.requestRefresh({
    source: 'MIXED_ACCOUNT_TEST',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  }).result;
  if (receipt.status !== 'COMMITTED') throw new Error('mixed account snapshot aborted');

  return owner;
}

function position(params: {
  symbol: string;
  quantity: number;
  availableQuantity: number;
}): Position {
  return {
    accountChannel: 'lb',
    symbol: params.symbol,
    symbolName: params.symbol,
    quantity: params.quantity,
    availableQuantity: params.availableQuantity,
    currency: 'HKD',
    costPrice: '1',
  };
}

describe('mixed account market scope', () => {
  it('commits fractional US holdings, keeps them out of the sell lookup and still exposes HK', async () => {
    const owner = await commitSnapshot(
      createPositionsResponse([
        {
          symbol: '700.HK',
          quantity: '100',
          availableQuantity: '80',
          currency: 'HKD',
          costPrice: '300.5',
        },
        {
          symbol: 'AAPL.US',
          quantity: '1.125',
          availableQuantity: '0.5',
          currency: 'USD',
          costPrice: '180.5',
        },
      ]),
    );

    const view = owner.getView();
    expect(view.positions).toHaveLength(2);
    expect(view.positions.find((item) => item.symbol === 'AAPL.US')?.quantity).toBe(1.125);
    expect(view.positions.find((item) => item.symbol === 'AAPL.US')?.availableQuantity).toBe(0.5);
    expect(owner.getAvailablePosition('700.HK')?.availableQuantity).toBe(80);
    expect(owner.getAvailablePosition('AAPL.US')).toBeNull();
  });

  it('HK sell quantity ignores unrelated fractional US positions but rejects fractional HK quantity', async () => {
    const resolver = createQuantityResolver({
      logger: createLoggerDouble(),
      rateLimiter: createRateLimiterDouble(),
      readSellPositions: async () => [
        position({ symbol: '700.HK', quantity: 100, availableQuantity: 80 }),
        position({ symbol: 'AAPL.US', quantity: 1.125, availableQuantity: 0.5 }),
      ],
    });

    expect(await resolver.readFreshAvailableSellQuantity('700.HK', () => true)).toBe(80);

    const fractionalHk = createQuantityResolver({
      logger: createLoggerDouble(),
      rateLimiter: createRateLimiterDouble(),
      readSellPositions: async () =>
        mapStockPositions(
          createPositionsResponse([
            {
              symbol: '700.HK',
              quantity: '100.5',
              availableQuantity: '100.5',
              currency: 'HKD',
              costPrice: '300.5',
            },
          ]),
        ),
    });

    const fractionalHkError = await fractionalHk
      .readFreshAvailableSellQuantity('700.HK', () => true)
      .catch((error: unknown) => error);
    expect(fractionalHkError).toBeInstanceOf(RangeError);
  });
});
