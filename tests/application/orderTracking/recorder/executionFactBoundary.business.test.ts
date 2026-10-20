import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** 执行事实边界回归：真实同步 O/Daily/S 准入保留原无效输入、无污染与价格优先抵扣 oracle。 */

import { describe, expect, it } from 'bun:test';
import { createOrderStorage } from '../../../../src/application/orderTracking/recorder/orderStorage.js';
import { calculateOrderStatistics } from '../../../../src/domain/order/orderRecordPolicy.js';
import { createExecutionFixture } from './executionFixture.js';

const SYMBOL = 'BULL.HK';
const invalidExecutionFacts = [
  { label: 'price', price: '0', amount: '0', quantity: 100, offsetMs: 1_000 },
  { label: 'quantity', price: '1', amount: '100', quantity: Number.NaN, offsetMs: 1_000 },
  { label: 'time', price: '1', amount: '100', quantity: 100, offsetMs: Number.POSITIVE_INFINITY },
];

describe('OrderRecorder execution-fact boundary', () => {
  for (const invalid of invalidExecutionFacts) {
    it(`rejects invalid ${invalid.label} at the public buy boundary without mutation`, () => {
      const f = createExecutionFixture();
      const token = f.snapshot.getView().token;
      const status = f.sink.getStatus();
      expect(() =>
        f.commit(
          'INVALID',
          'BUY',
          invalid.price,
          invalid.amount,
          invalid.quantity,
          invalid.offsetMs,
          SYMBOL,
        ),
      ).toThrow();
      expect(f.recorder.getBuyOrdersForSymbol(SYMBOL, true)).toEqual([]);
      expect(f.recorder.getExecutionFact('INVALID')).toBeNull();
      expect(f.snapshot.getView().token).toBe(token);
      expect(f.sink.getStatus()).toEqual(status);
    });

    it(`rejects invalid ${invalid.label} at the public sell boundary without mutation`, () => {
      const f = createExecutionFixture();
      f.commit('BUY', 'BUY', '1', '100', 100, 1_000, SYMBOL);
      const before = f.recorder.getBuyOrdersForSymbol(SYMBOL, true);
      const token = f.snapshot.getView().token;
      const status = f.sink.getStatus();
      expect(() =>
        f.commit(
          'INVALID',
          'SELL',
          invalid.price,
          invalid.amount,
          invalid.quantity,
          invalid.offsetMs,
          SYMBOL,
        ),
      ).toThrow();
      expect(f.recorder.getBuyOrdersForSymbol(SYMBOL, true)).toEqual(before);
      expect(f.recorder.getSellRecordByOrderId('INVALID')).toBeNull();
      expect(f.snapshot.getView().token).toBe(token);
      expect(f.sink.getStatus()).toEqual(status);
    });

    it(`rejects invalid ${invalid.label} at the direct cost-analysis boundary without mutating storage`, () => {
      const storage = createOrderStorage(createLoggerDouble());
      const valid = {
        orderId: 'BUY',
        symbol: SYMBOL,
        costAmount: '100',
        executedQuantity: 100,
        executedTime: 1_000,
      };
      storage.setBuyOrdersListForLong(SYMBOL, [valid]);
      const before = storage.getBuyOrdersList(SYMBOL, true);
      expect(() =>
        calculateOrderStatistics([
          {
            ...valid,
            costAmount: invalid.amount,
            executedQuantity: invalid.quantity,
            executedTime: invalid.offsetMs,
          },
        ]),
      ).toThrow();
      expect(storage.getBuyOrdersList(SYMBOL, true)).toEqual(before);
      expect(storage.getCostBasis(SYMBOL, true)).toEqual({ costAmount: '100', quantity: 100 });
      // 废弃的无 broker identity 存储写入能力不再存在；业务写入走上面的真实事实链。
      expect(Object.hasOwn(storage, 'addBuyOrder')).toBe(false);
      expect(Object.hasOwn(storage, 'updateAfterSell')).toBe(false);
    });
  }

  it('keeps valid broker execution times and price-priority deduction behavior', () => {
    const f = createExecutionFixture();
    f.commit('BUY-HIGH', 'BUY', '1.2', '120', 100, 3_000, SYMBOL);
    f.commit('BUY-LOW-1', 'BUY', '0.8', '80', 100, 1_000, SYMBOL);
    f.commit('BUY-LOW-2', 'BUY', '0.8', '80', 100, 2_000, SYMBOL);
    expect(f.commit('SELL', 'SELL', '1.1', '220', 200, 4_000, SYMBOL).admission).toBe('ADMITTED');
    expect(f.recorder.getBuyOrdersForSymbol(SYMBOL, true)).toMatchObject([
      {
        orderId: 'BUY-HIGH',
        costAmount: '120',
        executedQuantity: 100,
        executedTime: f.now + 3_000,
      },
    ]);
    expect(f.sink.getStatus().staleVersion).toBe(4);
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(4);
    expect(f.io.calls).toEqual([]);
  });

  it('a real duplicate does not register another stale generation', () => {
    const f = createExecutionFixture();
    expect(f.commit('BUY', 'BUY', '1', '100', 100, 1_000, SYMBOL).admission).toBe('ADMITTED');
    const before = f.snapshot.getView().token;
    expect(f.commit('BUY', 'BUY', '1', '100', 100, 1_000, SYMBOL).admission).toBe('DUPLICATE');
    expect(f.snapshot.getView().token).toBe(before);
    expect(f.sink.getStatus().staleVersion).toBe(1);
    expect(f.recorder.getCostBasis(SYMBOL, true)).toEqual({ costAmount: '100', quantity: 100 });
  });

  it('a sealed daily projection retains a later original-time revision in the recorder and refresh owner', () => {
    const f = createExecutionFixture();
    f.commit('BUY', 'BUY', '1', '100', 100, 1_000, SYMBOL);
    f.daily.commitProtectionBoundary(
      f.daily.prepareProtectionBoundary({
        direction: 'LONG',
        boundaryExecutedTimeMs: f.now + 1_000,
      }),
    );
    const before = f.snapshot.getView().token;
    expect(
      f.flow.recordCumulativeExecution({
        factStage: 'TERMINAL',
        orderId: 'BUY',
        side: 'BUY',
        monitorSymbol: 'HSI.HK',
        symbol: SYMBOL,
        isLongSymbol: true,
        isProtectiveLiquidation: false,
        executedQuantity: 100,
        executedPrice: '1.1',
        executedAmount: '110',
        executedTimeMs: f.now + 1_000,
        orderUpdatedAtMs: f.now + 1_001,
      }).admission,
    ).toBe('ADMITTED');
    expect(f.recorder.getExecutionFact('BUY')?.cumulativeAmount).toBe('110');
    expect(f.recorder.getCostBasis(SYMBOL, true)).toEqual({ costAmount: '110', quantity: 100 });
    expect(f.snapshot.getView().token.snapshotGeneration).toBe(before.snapshotGeneration + 1);
    expect(f.sink.getStatus().staleVersion).toBe(2);
    expect(f.daily.getLossOffset('LONG')).toBe('0');
  });
});
