/**
 * 累计订单事实裁决。
 * API 与 WS 使用同一 broker identity、累计金额和独立 revision；裁决不提交任何经济副作用。
 */
import type {
  BrokerOrderExecutionFact,
  OrderExecutionTimeEvidence,
  OrderExecutionTimeObservation,
} from '../../types/orderRecorder.js';
import { canonicalDecimal, exactCompare } from '../../utils/numeric/exact.js';

/** 验证累计经济与真实 T/revision；不为 V1 baseline 补造未持久化的 phase。 */
function assertExecutionPayload(fact: Omit<BrokerOrderExecutionFact, 'phase'>): void {
  if (
    fact.brokerOrderId.length === 0 ||
    fact.symbol.length === 0 ||
    !['BUY', 'SELL'].includes(fact.side) ||
    !Number.isSafeInteger(fact.cumulativeQuantity) ||
    fact.cumulativeQuantity < 0 ||
    !Number.isSafeInteger(fact.updatedAtMs) ||
    fact.updatedAtMs <= 0
  ) {
    throw new Error('[订单事实] broker identity、数量、phase 或 revision 无效');
  }

  const amountComparison = exactCompare(fact.cumulativeAmount, '0');
  if (fact.cumulativeQuantity === 0) {
    if (amountComparison !== 0 || fact.executionTimeMs !== null) {
      throw new Error('[订单事实] 零成交不得声明金额或执行时间');
    }
  } else if (
    amountComparison <= 0 ||
    fact.executionTimeMs === null ||
    !Number.isSafeInteger(fact.executionTimeMs) ||
    fact.executionTimeMs <= 0 ||
    fact.executionTimeMs > fact.updatedAtMs
  ) {
    throw new Error('[订单事实] 正成交缺少可信金额或独立执行时间');
  }
}

/** 验证完整中立累计事实；缺失可信 execution 时间不得用 revision 代替。 */
export function assertBrokerOrderExecutionFact(fact: BrokerOrderExecutionFact): void {
  assertExecutionPayload(fact);
  if (!['OPEN', 'TERMINAL'].includes(fact.phase)) throw new Error('[订单事实] phase 无效');
}

/**
 * 纯裁决同一订单的累计事实；旧观察返回既有对象，合法新事实返回规范金额新对象。
 * 同 revision 允许正累计量推进及 OPEN→TERMINAL 的合法最终金额修订；同阶段同量异载荷、倒退均拒绝。
 */
export function mergeBrokerOrderExecutionFact(
  previous: BrokerOrderExecutionFact | undefined,
  incoming: BrokerOrderExecutionFact,
): BrokerOrderExecutionFact {
  assertBrokerOrderExecutionFact(incoming);
  const normalized = {
    ...incoming,
    cumulativeAmount: canonicalDecimal(incoming.cumulativeAmount),
  };
  if (previous === undefined) {
    return Object.freeze(normalized);
  }

  if (
    previous.brokerOrderId !== incoming.brokerOrderId ||
    previous.symbol !== incoming.symbol ||
    previous.side !== incoming.side
  ) {
    throw new Error('[订单事实] 同 broker identity 的归属冲突');
  }

  const quantityAdvanced = incoming.cumulativeQuantity > previous.cumulativeQuantity;
  if (incoming.updatedAtMs < previous.updatedAtMs) {
    if (quantityAdvanced) {
      throw new Error('[订单事实] 累计数量推进但 revision 倒退');
    }

    return previous;
  }

  if (previous.phase === 'TERMINAL' && incoming.phase === 'OPEN') {
    throw new Error('[订单事实] fact stage regression: TERMINAL -> OPEN');
  }

  if (incoming.cumulativeQuantity < previous.cumulativeQuantity) {
    throw new Error('[订单事实] 同/新 revision 累计数量倒退');
  }

  const amountChanged = exactCompare(previous.cumulativeAmount, incoming.cumulativeAmount) !== 0;
  const phaseAdvanced = previous.phase === 'OPEN' && incoming.phase === 'TERMINAL';
  if (
    incoming.updatedAtMs === previous.updatedAtMs &&
    !quantityAdvanced &&
    ((amountChanged && !phaseAdvanced) || incoming.executionTimeMs !== previous.executionTimeMs)
  ) {
    throw new Error('[订单事实] 同 revision 同量同阶段的累计经济或执行时间冲突');
  }

  if (quantityAdvanced && exactCompare(incoming.cumulativeAmount, previous.cumulativeAmount) <= 0) {
    throw new Error('[订单事实] 正成交增量缺少正金额增量');
  }

  if (
    previous.executionTimeMs !== null &&
    incoming.executionTimeMs !== null &&
    incoming.executionTimeMs < previous.executionTimeMs
  ) {
    throw new Error('[订单事实] 新 revision 的可信执行时间倒退');
  }

  const phase = incoming.phase;
  if (
    !quantityAdvanced &&
    !amountChanged &&
    phase === previous.phase &&
    incoming.updatedAtMs === previous.updatedAtMs
  ) {
    return previous;
  }

  return Object.freeze({ ...normalized, phase });
}

/**
 * 将可信事实/durable 证据与 API 累计量匹配；未知执行时间保持未知，绝不取 API revision 替代。
 * @param orders 已映射 API 观察
 * @param evidence 唯一事实 owner 或原 durable progress/baseline 的可信执行时间证据
 * @returns 新的只读 API 观察数组，原输入不写入；同量合法金额修订仍使用真实执行时间
 */
export function withTrustedOrderExecutionTimes<T extends OrderExecutionTimeObservation>(
  orders: ReadonlyArray<T>,
  evidence: ReadonlyArray<OrderExecutionTimeEvidence>,
): ReadonlyArray<T> {
  for (const item of evidence) {
    assertExecutionPayload({
      brokerOrderId: item.brokerOrderId,
      symbol: item.symbol,
      side: item.side,
      cumulativeQuantity: item.cumulativeQuantity,
      cumulativeAmount: item.cumulativeAmount,
      executionTimeMs: item.lastExecutionTimeMs,
      updatedAtMs: item.orderRevisionMs,
    });

    if (item.phase !== null && !['OPEN', 'TERMINAL'].includes(item.phase))
      throw new Error('[订单事实] evidence phase 无效');
  }

  return orders.map((order) => {
    const matching = evidence.filter(
      (item) =>
        item.brokerOrderId === order.orderId &&
        item.symbol === order.symbol &&
        item.side === order.executionSide &&
        item.cumulativeQuantity === order.executedQuantity,
    );
    if (matching.length === 0) return order;

    const proven = matching.filter((item) => item.phase !== null);
    // 未存 phase 的 baseline 只能由同 revision 同 payload 的 progress/API 锚定，不能当假 OPEN 放宽金额冲突。
    for (const item of matching.filter((candidate) => candidate.phase === null)) {
      const sameRevision = matching.filter(
        (candidate) => candidate.orderRevisionMs === item.orderRevisionMs,
      );
      if (
        sameRevision.some(
          (candidate) => candidate.lastExecutionTimeMs !== item.lastExecutionTimeMs,
        ) ||
        (order.updatedAtMs === item.orderRevisionMs &&
          order.executionTimeMs !== null &&
          order.executionTimeMs !== item.lastExecutionTimeMs)
      )
        throw new Error('[订单事实] 同 revision 的可信执行时间冲突');

      const hasProvenPayload = proven.some(
        (candidate) =>
          candidate.orderRevisionMs === item.orderRevisionMs &&
          exactCompare(candidate.cumulativeAmount, item.cumulativeAmount) === 0 &&
          candidate.lastExecutionTimeMs === item.lastExecutionTimeMs,
      );
      const matchesApi =
        order.updatedAtMs === item.orderRevisionMs &&
        exactCompare(order.executedAmount, item.cumulativeAmount) === 0 &&
        (order.executionTimeMs === null || order.executionTimeMs === item.lastExecutionTimeMs);
      const conflict =
        sameRevision.some(
          (candidate) =>
            exactCompare(candidate.cumulativeAmount, item.cumulativeAmount) !== 0 ||
            candidate.lastExecutionTimeMs !== item.lastExecutionTimeMs,
        ) ||
        (order.updatedAtMs === item.orderRevisionMs &&
          (exactCompare(order.executedAmount, item.cumulativeAmount) !== 0 ||
            (order.executionTimeMs !== null &&
              order.executionTimeMs !== item.lastExecutionTimeMs)));
      if (conflict && !hasProvenPayload && !matchesApi)
        throw new Error('[订单事实] 未知 phase baseline 的同 revision 载荷无法锚定到真实 phase');
    }

    const ordered = [...proven].sort((left, right) => {
      const revision = left.orderRevisionMs - right.orderRevisionMs;
      if (revision !== 0 || left.phase === right.phase) return revision;

      return left.phase === 'OPEN' ? -1 : 1;
    });
    let latest: BrokerOrderExecutionFact | undefined;
    for (const item of ordered) {
      if (item.phase === null) throw new Error('[订单事实] proven execution evidence lacks phase');

      latest = mergeBrokerOrderExecutionFact(latest, {
        brokerOrderId: item.brokerOrderId,
        symbol: item.symbol,
        side: item.side,
        cumulativeQuantity: item.cumulativeQuantity,
        cumulativeAmount: item.cumulativeAmount,
        executionTimeMs: item.lastExecutionTimeMs,
        updatedAtMs: item.orderRevisionMs,
        phase: item.phase,
      });
    }

    const newest = [...matching].sort(
      (left, right) => right.orderRevisionMs - left.orderRevisionMs,
    )[0];
    if (newest === undefined) throw new Error('[订单事实] matching execution evidence disappeared');

    const executionTimeMs =
      order.executionTimeMs ??
      (latest !== undefined && latest.updatedAtMs >= newest.orderRevisionMs
        ? latest.executionTimeMs
        : newest.lastExecutionTimeMs);
    mergeBrokerOrderExecutionFact(latest, {
      brokerOrderId: order.orderId,
      symbol: order.symbol,
      side: order.executionSide,
      cumulativeQuantity: order.executedQuantity,
      cumulativeAmount: order.executedAmount,
      executionTimeMs,
      updatedAtMs: order.updatedAtMs,
      phase: order.executionPhase,
    });
    return order.executionTimeMs === null ? Object.freeze({ ...order, executionTimeMs }) : order;
  });
}
