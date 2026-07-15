/**
 * OrderRecorder 执行事实边界测试
 *
 * 覆盖公开记录入口与直达存储入口都只接受完整的 broker 成交事实，避免无效事实污染本地订单记录。
 */
import { describe, expect, it } from 'bun:test';
import { createOrderRecorder } from '../../../src/core/orderRecorder/index.js';
import { createOrderStorage } from '../../../src/core/orderRecorder/orderStorage.js';
import type { RateLimiter, TradeMutationPermit } from '../../../src/types/services.js';
import { createTradeContextDouble } from '../../helpers/testDoubles.js';

const SYMBOL = 'BULL.HK';

function createImmediateRateLimiter(): RateLimiter {
  return {
    throttle: async (): Promise<void> => {},
    withTradeMutation: async <T>(
      callback: (permit: TradeMutationPermit) => Promise<T>,
    ): Promise<T> =>
      callback({
        invoke: async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => operation(),
      }),
  };
}

function createRecorder() {
  return createOrderRecorder({
    ctx: createTradeContextDouble(),
    rateLimiter: createImmediateRateLimiter(),
  });
}

const invalidExecutionFacts: ReadonlyArray<{
  readonly label: string;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
}> = [
  {
    label: 'price',
    executedPrice: 0,
    executedQuantity: 100,
    executedTimeMs: 1_000,
  },
  {
    label: 'quantity',
    executedPrice: 1,
    executedQuantity: Number.NaN,
    executedTimeMs: 1_000,
  },
  {
    label: 'time',
    executedPrice: 1,
    executedQuantity: 100,
    executedTimeMs: Number.POSITIVE_INFINITY,
  },
];

describe('OrderRecorder execution-fact boundary', () => {
  for (const invalidFact of invalidExecutionFacts) {
    it(`rejects invalid ${invalidFact.label} at the public buy boundary without mutation`, () => {
      const recorder = createRecorder();

      expect(() => {
        recorder.recordLocalBuy(
          SYMBOL,
          invalidFact.executedPrice,
          invalidFact.executedQuantity,
          true,
          invalidFact.executedTimeMs,
        );
      }).toThrow(/执行事实/);
      expect(recorder.getBuyOrdersForSymbol(SYMBOL, true)).toEqual([]);
    });

    it(`rejects invalid ${invalidFact.label} at the public sell boundary without mutation`, () => {
      const recorder = createRecorder();
      recorder.recordLocalBuy(SYMBOL, 1, 100, true, 1_000);
      const beforeBuyOrders = recorder.getBuyOrdersForSymbol(SYMBOL, true);

      expect(() => {
        recorder.recordLocalSell(
          SYMBOL,
          invalidFact.executedPrice,
          invalidFact.executedQuantity,
          true,
          invalidFact.executedTimeMs,
        );
      }).toThrow(/执行事实/);
      expect(recorder.getBuyOrdersForSymbol(SYMBOL, true)).toEqual(beforeBuyOrders);
      expect(recorder.getLatestSellRecord(SYMBOL, true)).toBeNull();
    });

    it(`rejects invalid ${invalidFact.label} at direct storage entrypoints without mutation`, () => {
      const storage = createOrderStorage();
      storage.addBuyOrder(SYMBOL, 1, 100, true, 1_000);
      const beforeBuyOrders = storage.getBuyOrdersList(SYMBOL, true);

      expect(() => {
        storage.addBuyOrder(
          SYMBOL,
          invalidFact.executedPrice,
          invalidFact.executedQuantity,
          true,
          invalidFact.executedTimeMs,
        );
      }).toThrow(/执行事实/);

      expect(() => {
        storage.updateAfterSell(
          SYMBOL,
          invalidFact.executedPrice,
          invalidFact.executedQuantity,
          true,
          invalidFact.executedTimeMs,
        );
      }).toThrow(/执行事实/);
      expect(storage.getBuyOrdersList(SYMBOL, true)).toEqual(beforeBuyOrders);
      expect(storage.getLatestSellRecord(SYMBOL, true)).toBeNull();
    });
  }

  it('keeps valid broker execution times and price-priority deduction behavior', () => {
    const recorder = createRecorder();
    recorder.recordLocalBuy(SYMBOL, 1.2, 100, true, 3_000);
    recorder.recordLocalBuy(SYMBOL, 0.8, 100, true, 1_000);
    recorder.recordLocalBuy(SYMBOL, 0.8, 100, true, 2_000);

    recorder.recordLocalSell(SYMBOL, 1.1, 200, true, 4_000);

    expect(recorder.getBuyOrdersForSymbol(SYMBOL, true)).toMatchObject([
      {
        executedPrice: 1.2,
        executedQuantity: 100,
        executedTime: 3_000,
      },
    ]);

    expect(recorder.getLatestSellRecord(SYMBOL, true)).toMatchObject({
      executedPrice: 1.1,
      executedQuantity: 200,
      executedTime: 4_000,
    });
  });
});
