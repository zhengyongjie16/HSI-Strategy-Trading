/**
 * 订单累计经济纯规则：SDK 均价×累计量是金额依据，真实 ledger 证明执行时间与同量终态补价。
 * 不读取 broker、不持有第二 ledger，不改变既有重复 tradeId、revision 或精确相等口径。
 * 错误保留原 [orderMapper] 前缀，保证调用链已有拒绝诊断不因规则迁位而改变。
 */
import type { OrderExecutionLedgerFact } from '../../types/orderExecutionLedger.js';
import type { OrderExecutionPriceEvidence } from '../../types/orderPushPorts.js';
import type { OrderEconomics, OrderEconomicsObservation } from '../../types/orderEconomics.js';
import { exactAdd, exactCompare, exactMultiply } from '../../utils/numeric/exact.js';

/** 保持 SDK 累计均价原文为成本依据；不能用 ledger 的另一个均价重写正常订单金额。 */
function cumulativeExecutionAmount(executedPrice: string | null, executedQuantity: number): string {
  return executedQuantity === 0 || executedPrice === null
    ? '0'
    : exactMultiply(executedPrice, String(executedQuantity));
}

/**
 * 完整累计量才确认真实执行时间；重复 tradeId 必须同载荷。
 * trade_done_at 与 order updated_at 是两个独立券商事实，不互相约束先后。
 * 保持原提前匹配行为：满足当前累计量后的额外流水不倒推此次观察的执行时间。
 */
function matchingExecutionTime(
  order: OrderEconomicsObservation,
  executions: ReadonlyArray<OrderExecutionLedgerFact>,
): number | null {
  const expected = order.executedQuantity;
  if (expected === 0) return null;

  const byTrade = new Map<string, OrderExecutionLedgerFact>();
  for (const execution of executions) {
    if (execution.orderId !== order.orderId) continue;

    if (execution.symbol !== order.symbol || execution.tradeId.length === 0) {
      throw new TypeError('[orderMapper] execution ownership or identity conflict');
    }

    const previous = byTrade.get(execution.tradeId);
    if (
      previous !== undefined &&
      (previous.symbol !== execution.symbol ||
        previous.quantity !== execution.quantity ||
        previous.price !== execution.price ||
        previous.tradeDoneAtMs !== execution.tradeDoneAtMs)
    ) {
      throw new TypeError('[orderMapper] same tradeId execution conflict');
    }

    byTrade.set(execution.tradeId, execution);
  }

  let quantity = 0;
  const ordered = [...byTrade.values()].sort(
    (left, right) => left.tradeDoneAtMs - right.tradeDoneAtMs,
  );
  for (const execution of ordered) {
    const doneAt = execution.tradeDoneAtMs;
    const increment = execution.quantity;
    if (increment === 0 || exactCompare(execution.price, '0') <= 0) {
      throw new TypeError('[orderMapper] execution lacks positive quantity/price');
    }

    quantity += increment;
    if (!Number.isSafeInteger(quantity))
      throw new RangeError('[orderMapper] execution quantity overflow');

    if (quantity > expected) return null;

    if (quantity === expected) return doneAt;
  }

  return null;
}

/** 缺失/零终态价只能由同 broker、同量已确认事实和此次完整 ledger 精确共同证明。 */
function compatibleTerminalExecutionPrice(
  order: OrderEconomicsObservation,
  executions: ReadonlyArray<OrderExecutionLedgerFact>,
  confirmed?: OrderExecutionPriceEvidence,
): string | null {
  if (
    confirmed?.executedPrice === undefined ||
    confirmed.executedPrice === null ||
    confirmed.brokerOrderId !== order.orderId ||
    confirmed.symbol !== order.symbol ||
    confirmed.side !== order.executionSide ||
    confirmed.cumulativeQuantity !== order.executedQuantity ||
    confirmed.executionTimeMs === null ||
    order.updatedAtMs === null ||
    order.updatedAtMs < confirmed.updatedAtMs ||
    exactCompare(confirmed.executedPrice, '0') <= 0
  )
    return null;

  if (
    !Number.isSafeInteger(confirmed.updatedAtMs) ||
    confirmed.updatedAtMs <= 0 ||
    !Number.isSafeInteger(confirmed.executionTimeMs) ||
    confirmed.executionTimeMs <= 0 ||
    !['OPEN', 'TERMINAL'].includes(confirmed.phase) ||
    exactCompare(confirmed.cumulativeAmount, '0') <= 0
  )
    throw new TypeError('[orderMapper] invalid confirmed terminal execution basis');

  const byTrade = new Map<string, OrderExecutionLedgerFact>();
  let quantity = 0;
  let amount = '0';
  let lastTime = 0;
  for (const execution of executions) {
    if (execution.orderId !== order.orderId) continue;

    if (
      execution.symbol !== order.symbol ||
      execution.tradeId.length === 0 ||
      !Number.isSafeInteger(execution.quantity) ||
      execution.quantity <= 0 ||
      !Number.isSafeInteger(execution.tradeDoneAtMs) ||
      execution.tradeDoneAtMs <= 0 ||
      exactCompare(execution.price, '0') <= 0
    )
      throw new TypeError('[orderMapper] incompatible terminal execution ledger');

    const previous = byTrade.get(execution.tradeId);
    if (previous !== undefined) {
      if (
        previous.quantity !== execution.quantity ||
        previous.price !== execution.price ||
        previous.tradeDoneAtMs !== execution.tradeDoneAtMs
      )
        throw new TypeError('[orderMapper] same tradeId execution conflict');

      continue;
    }

    byTrade.set(execution.tradeId, execution);
    quantity += execution.quantity;
    if (!Number.isSafeInteger(quantity))
      throw new RangeError('[orderMapper] execution quantity overflow');

    amount = exactAdd(amount, exactMultiply(execution.price, String(execution.quantity)));
    lastTime = Math.max(lastTime, execution.tradeDoneAtMs);
  }

  if (
    quantity !== confirmed.cumulativeQuantity ||
    lastTime !== confirmed.executionTimeMs ||
    exactCompare(amount, confirmed.cumulativeAmount) !== 0 ||
    exactCompare(exactMultiply(confirmed.executedPrice, String(quantity)), amount) !== 0
  )
    return null;

  return confirmed.executedPrice;
}

/** 无状态纯规则对象；由 app 明确提供给 SDK adapter，不产生生命周期或经济副作用。 */
export const orderEconomics: OrderEconomics = {
  cumulativeAmount: cumulativeExecutionAmount,
  executionTime: matchingExecutionTime,
  compatibleTerminalPrice: compatibleTerminalExecutionPrice,
};
