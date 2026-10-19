import { createLoggerDouble } from '../../helpers/testDoubles.js';

/**
 * 同一真实订单 owner 的累计经济覆盖与风险成本回归。
 * API 使用内部 plain RawOrder，在线使用中性累计 fact；仅 broker IO 是替身。
 * 本文件不宣称 SDK push → tracking/settlement 自然接线；资源用真实 owner 公共方法独立验证。
 * oracle 为人工整单账本，不调用 numeric、均价或 delta-slice 实现生成期望。
 */

import { describe, expect, it } from 'bun:test';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { withTrustedOrderExecutionTimes } from '../../../src/domain/order/executionFact.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import type {
  BrokerOrderExecutionFact,
  OrderExecutionTimeEvidence,
} from '../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createOfflineBrokerPort } from './offlinePorts.js';

const targets = [{ symbol: 'COVERED.HK', isLongSymbol: true }];

function fact(
  id: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  amount: string,
  executionTimeMs: number,
): BrokerOrderExecutionFact {
  return {
    brokerOrderId: id,
    symbol: 'COVERED.HK',
    side,
    cumulativeQuantity: quantity,
    cumulativeAmount: amount,
    executionTimeMs,
    updatedAtMs: executionTimeMs,
    phase: 'TERMINAL',
  };
}

/** 原内部显式FILLED查询fixture的中性元数据；只供rebuild/helper，不冒充SDK callback。 */
function apiOrder(input: BrokerOrderExecutionFact): OrderFact {
  return {
    orderId: input.brokerOrderId,
    symbol: input.symbol,
    stockName: 'covered order',
    executionSide: input.side,
    executionStatus: 'FILLED',
    executionPhase: input.phase,
    status: 'FILLED',
    orderType: 'ELO',
    quantity: input.cumulativeQuantity,
    price: null,
    executedQuantity: input.cumulativeQuantity,
    executedPrice: null,
    executedAmount: input.cumulativeAmount,
    executionTimeMs: input.executionTimeMs,
    updatedAtMs: input.updatedAtMs,
    submittedAt: new Date(1),
    updatedAt: new Date(input.updatedAtMs),
  };
}

describe('same-instance economic coverage across neutral API and online facts', () => {
  it('accepts the original same-revision quantity and OPEN-to-TERMINAL amount protocol using phase-aware trusted times', () => {
    const io = createOfflineBrokerPort();
    const owner = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: io.broker,
      getExecutionTimeEvidence: () => [],
      settlementRefreshNeedRecorder: io.settlementRefreshNeedRecorder,
    });
    const risk = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    });
    const evidence: ReadonlyArray<OrderExecutionTimeEvidence> = [
      {
        brokerOrderId: 'PHASE-BUY',
        symbol: 'COVERED.HK',
        side: 'BUY',
        cumulativeQuantity: 5,
        cumulativeAmount: '44',
        lastExecutionTimeMs: 1000,
        orderRevisionMs: 1030,
        phase: 'OPEN',
      },
      {
        brokerOrderId: 'PHASE-BUY',
        symbol: 'COVERED.HK',
        side: 'BUY',
        cumulativeQuantity: 5,
        cumulativeAmount: '45',
        lastExecutionTimeMs: 1000,
        orderRevisionMs: 1030,
        phase: 'TERMINAL',
      },
    ];
    const terminal = { ...fact('PHASE-BUY', 'BUY', 5, '45', 1000), updatedAtMs: 1030 };
    const untrustedTime: OrderFact = { ...apiOrder(terminal), executionTimeMs: null };
    const observations = withTrustedOrderExecutionTimes([untrustedTime], evidence);
    expect(observations[0]?.executionTimeMs).toBe(1000);
    expect(observations[0]?.updatedAtMs).toBe(1030);
    expect(untrustedTime.executionTimeMs).toBeNull();
    owner.commitExecutionFact(
      { ...terminal, cumulativeAmount: '44', phase: 'OPEN' },
      true,
      [],
      () => 'ADMITTED',
    );
    const beforeTerminal = owner.getExecutionFact('PHASE-BUY');
    owner.commitExecutionFact(terminal, true, [], () => 'ADMITTED');
    // 同量 OPEN->TERMINAL 不推进数量，只补上终态经济投影。
    expect(owner.getExecutionFact('PHASE-BUY')?.cumulativeQuantity).toBe(
      beforeTerminal?.cumulativeQuantity,
    );
    expect(owner.getExecutionFact('PHASE-BUY')?.phase).toBe('TERMINAL');
    expect(owner.getCostBasis('COVERED.HK', true)).toEqual({ costAmount: '45', quantity: 5 });
    expect(
      owner.commitRebuildSnapshot(targets, observations, () => true, 'ACTIVATION').status,
    ).toBe('COMMITTED');

    owner.commitExecutionFact(terminal, true, [], () => 'DUPLICATE');
    risk.publish(risk.prepare(owner, 'COVERED.HK', true, '0'));
    expect(risk.getUnrealizedLossData('COVERED.HK')).toEqual({ r1: '45', n1: 5 });
    const earlier = {
      ...fact('SAME-REVISION', 'BUY', 50, '50', 2000),
      updatedAtMs: 2030,
      phase: 'OPEN' as const,
    };
    owner.commitExecutionFact(earlier, true, [], () => 'ADMITTED');
    const advanced = {
      ...earlier,
      cumulativeQuantity: 100,
      cumulativeAmount: '100',
      executionTimeMs: 2010,
    };
    owner.commitExecutionFact(advanced, true, [], () => 'ADMITTED');
    expect(owner.getExecutionFact('SAME-REVISION')?.cumulativeQuantity).toBe(100);
    expect(owner.getExecutionFact('SAME-REVISION')?.updatedAtMs).toBe(2030);
    owner.commitExecutionFact({ ...advanced, phase: 'TERMINAL' }, true, [], () => 'ADMITTED');
    expect(owner.getExecutionFact('SAME-REVISION')?.cumulativeQuantity).toBe(100);
    expect(owner.getExecutionFact('SAME-REVISION')?.phase).toBe('TERMINAL');
    expect(owner.getCostBasis('COVERED.HK', true)).toEqual({ costAmount: '145', quantity: 105 });
    expect(io.calls).toEqual([]);
  });

  it('keeps cumulative SELL as one whole-order deduction after API/online replay', () => {
    const io = createOfflineBrokerPort();
    const owner = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: io.broker,
      getExecutionTimeEvidence: () => [],
      settlementRefreshNeedRecorder: io.settlementRefreshNeedRecorder,
    });
    const risk = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    });
    const buy150 = fact('BUY150', 'BUY', 150, '150', 1000);
    const buy50 = fact('BUY50', 'BUY', 50, '100', 1100);
    const sell100 = fact('CUMULATIVE-SELL', 'SELL', 100, '120', 1200);
    expect(
      owner.commitRebuildSnapshot(
        targets,
        [apiOrder(buy150), apiOrder(buy50)],
        () => true,
        'ACTIVATION',
      ).status,
    ).toBe('COMMITTED');
    owner.commitExecutionFact(sell100, true, [], () => 'ADMITTED');
    // 100 无法整笔覆盖 150，先整笔覆盖 50；余额 50 不能拆 150。
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true).map((order) => order.orderId)).toEqual([
      'BUY150',
    ]);

    const retained = owner.getBuyOrdersForSymbol('COVERED.HK', true).map((order) => order.orderId);
    for (const original of [buy150, buy50, sell100]) {
      owner.commitExecutionFact(original, true, [], () => 'DUPLICATE');
    }

    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true).map((order) => order.orderId)).toEqual(
      retained,
    );

    const sell200 = fact('CUMULATIVE-SELL', 'SELL', 200, '240', 1300);
    owner.commitExecutionFact(sell200, true, [], () => 'ADMITTED');
    expect(owner.getExecutionFact('CUMULATIVE-SELL')?.cumulativeQuantity).toBe(200);
    // 同一 SELL 的累计 200 应整笔覆盖两张 BUY，不能把 100/100 当两笔卖出。
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true)).toEqual([]);
    expect(owner.getCostBasis('COVERED.HK', true)).toBeNull();
    risk.publish(risk.prepare(owner, 'COVERED.HK', true, '0'));
    expect(risk.getUnrealizedLossData('COVERED.HK')).toEqual({ r1: '0', n1: 0 });
    expect(
      owner.commitRebuildSnapshot(
        targets,
        [apiOrder(buy150), apiOrder(buy50), apiOrder(sell200)],
        () => true,
        'ACTIVATION',
      ).status,
    ).toBe('COMMITTED');

    owner.commitExecutionFact(sell200, true, [], () => 'DUPLICATE');

    owner.commitExecutionFact(buy150, true, [], () => 'DUPLICATE');
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true)).toEqual([]);
    expect(io.calls).toEqual([]);
  });

  it('retains exact authoritative revisions across clear without reviving cleared cost, but admits later quantity', () => {
    const io = createOfflineBrokerPort();
    const owner = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: io.broker,
      getExecutionTimeEvidence: () => [],
      settlementRefreshNeedRecorder: io.settlementRefreshNeedRecorder,
    });
    const risk = createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    });
    const original = fact('CLEARED-BUY', 'BUY', 150, '150', 1000);
    owner.commitRebuildSnapshot(targets, [apiOrder(original)], () => true, 'ACTIVATION');
    owner.clearBuyOrders('COVERED.HK', true);
    const corrected = { ...original, cumulativeAmount: '150.00000000000000015', updatedAtMs: 1100 };
    owner.commitExecutionFact(corrected, true, [], () => 'ADMITTED');
    // 权威事实变化但清理后的经济范围不复活；数量未推进。
    expect(owner.getExecutionFact(original.brokerOrderId)?.cumulativeQuantity).toBe(150);
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true)).toEqual([]);
    expect(owner.getExecutionFact(original.brokerOrderId)?.cumulativeAmount).toBe(
      '150.00000000000000015',
    );
    owner.commitRebuildSnapshot(targets, [apiOrder(corrected)], () => true, 'ACTIVATION');
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true)).toEqual([]);
    risk.publish(risk.prepare(owner, 'COVERED.HK', true, '0'));
    expect(risk.getUnrealizedLossData('COVERED.HK')).toEqual({ r1: '0', n1: 0 });
    const later = fact('CLEARED-BUY', 'BUY', 300, '300', 1200);
    owner.commitExecutionFact(later, true, [], () => 'ADMITTED');
    owner.commitExecutionFact(fact('NEW-BUY', 'BUY', 100, '200', 1300), true, [], () => 'ADMITTED');
    // 明确提供的新累计单价 1：清理过的 150 不复活，新 150 + 新订单 100 入账。
    expect(owner.getCostBasis('COVERED.HK', true)).toEqual({ costAmount: '350', quantity: 250 });
    risk.publish(risk.prepare(owner, 'COVERED.HK', true, '0'));
    expect(risk.getUnrealizedLossData('COVERED.HK')).toEqual({ r1: '350', n1: 250 });
    owner.commitExecutionFact(later, true, [], () => 'DUPLICATE');
    expect(io.calls).toEqual([]);
  });

  it('first terminal projects an OPEN partial once while pending-sell release remains a separate idempotent operation', () => {
    const io = createOfflineBrokerPort();
    const owner = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: io.broker,
      getExecutionTimeEvidence: () => [],
      settlementRefreshNeedRecorder: io.settlementRefreshNeedRecorder,
    });
    const partial = { ...fact('PARTIAL-BUY', 'BUY', 100, '100', 1000), phase: 'OPEN' as const };
    owner.commitExecutionFact(partial, true, [], () => 'ADMITTED');
    expect(owner.getCostBasis('COVERED.HK', true)).toBeNull();
    const terminal = { ...partial, phase: 'TERMINAL' as const, updatedAtMs: 1100 };
    const beforeTerminal = owner.getExecutionFact('PARTIAL-BUY');
    owner.commitExecutionFact(terminal, true, [], () => 'ADMITTED');
    expect(owner.getExecutionFact('PARTIAL-BUY')?.cumulativeQuantity).toBe(
      beforeTerminal?.cumulativeQuantity,
    );
    expect(owner.getCostBasis('COVERED.HK', true)).toEqual({ costAmount: '100', quantity: 100 });
    owner.submitSellOrder('RESOURCE-SELL', 'COVERED.HK', 'LONG', 100, ['PARTIAL-BUY'], 1200);
    const sell = fact('RESOURCE-SELL', 'SELL', 100, '110', 1300);
    owner.commitExecutionFact(sell, true, [], () => 'ADMITTED');
    expect(owner.getSellRecordByOrderId('RESOURCE-SELL')?.executedQuantity).toBe(100);
    expect(owner.getCostBasis('COVERED.HK', true)).toBeNull();
    expect(owner.getPendingSellSnapshot()).toHaveLength(1);
    owner.commitExecutionFact(sell, true, [], () => 'DUPLICATE');
    expect(owner.getPendingSellSnapshot()).toHaveLength(1);
    expect(owner.getCostBasis('COVERED.HK', true)).toBeNull();
    expect(owner.markSellFilled('RESOURCE-SELL')?.orderId).toBe('RESOURCE-SELL');
    expect(owner.markSellFilled('RESOURCE-SELL')).toBeNull();
    expect(owner.getPendingSellSnapshot()).toEqual([]);
    owner.commitExecutionFact(terminal, true, [], () => 'DUPLICATE');
    expect(owner.getBuyOrdersForSymbol('COVERED.HK', true)).toEqual([]);
    expect(io.calls).toEqual([]);
  });
});
