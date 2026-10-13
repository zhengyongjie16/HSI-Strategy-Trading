/** 卖单目的隔离规则：有效旧 protective 剩余量必须撤旧，普通合法单仍可 REPLACE。 */
import { describe, expect, it } from 'bun:test';
import { resolveSellMergeDecision } from '../../../src/domain/order/sellMergePolicy.js';
import type { PendingSellOrderSnapshot } from '../../../src/domain/order/types.js';

const pending: PendingSellOrderSnapshot = {
  orderId: 'OLD',
  symbol: 'BULL.HK',
  side: 'SELL',
  status: 'WORKING',
  orderType: 'ELO',
  isProtectiveLiquidation: true,
  submittedPrice: '0.9',
  submittedQuantity: 1500,
  executedQuantity: 500,
  submittedAt: 1000,
};

function decide(orders: ReadonlyArray<PendingSellOrderSnapshot>, protective = false) {
  return resolveSellMergeDecision({
    symbol: pending.symbol,
    pendingOrders: orders,
    newOrderQuantity: 1000,
    newOrderType: 'ELO',
    isProtectiveLiquidation: protective,
  });
}

describe('sell merge protective identity', () => {
  it('protective ELO 剩余量不被非 protective 新请求扩量', () => {
    expect(decide([pending])).toMatchObject({
      action: 'CANCEL_AND_SUBMIT',
      mergedQuantity: 2000,
      targetOrderId: null,
      pendingRemainingQuantity: 1000,
    });
  });

  it('普通同类型可改单保留 REPLACE，新 protective 请求保留撤旧规则', () => {
    const ordinary = { ...pending, isProtectiveLiquidation: false };
    expect(decide([ordinary])).toMatchObject({ action: 'REPLACE', targetOrderId: 'OLD' });
    expect(decide([ordinary], true).action).toBe('CANCEL_AND_SUBMIT');
  });

  it('旧 protective 无有效剩余量不产生额外撤单或影响普通新提交', () => {
    expect(decide([{ ...pending, executedQuantity: 1500 }]).action).toBe('SUBMIT');
  });

  it('身份遗漏是内部契约错误，不按 false 放行', () => {
    const malformed = {
      ...pending,
      isProtectiveLiquidation: undefined,
    } as unknown as PendingSellOrderSnapshot;
    expect(() => decide([malformed])).toThrow(/protective 身份/);
  });
});
