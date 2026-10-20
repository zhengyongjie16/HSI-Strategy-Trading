/**
 * 累计订单事实唯一裁决。
 * API/WS/恢复/durable 使用同一 broker identity、累计数量、累计金额、执行时间与 revision；
 * 裁决不提交任何经济副作用，调用方不得在本入口之外另造数量、金额、T 或 revision 规则。
 */
import type { BrokerOrderExecutionFact } from '../../types/orderRecorder.js';
import type { KnownExecutionBaseline } from './types.js';
import { canonicalDecimal, exactCompare } from '../../utils/numeric/exact.js';

/** 判断值是否是可用于累计成交事实的正安全毫秒时间。 */
function isValidPositiveMillis(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** observed 必须声明明确 phase；仅 known baseline 允许未持久化 phase（null）。 */
function isKnownPhase(phase: unknown): boolean {
  return phase === 'OPEN' || phase === 'TERMINAL';
}

/** 校验累计金额文本为非负规范十进制；金额始终保留原文精度。 */
function assertCumulativeAmount(cumulativeAmount: string): string {
  const canonical = canonicalDecimal(cumulativeAmount);
  if (exactCompare(canonical, '0') < 0)
    throw new Error('[订单事实] 累计成交金额不得为负');

  return canonical;
}

/**
 * 校验累计事实的 identity、数量、金额、T 与 revision 自洽。
 * known 正成交必须携带正金额与有效 T；仅 baseline phase 允许未知（null）。observed 必须完整。
 */
function assertExecutionPayload(
  fact: KnownExecutionBaseline,
  allowNullPhase = false,
): void {
  if (
    fact.brokerOrderId.length === 0 ||
    fact.symbol.length === 0 ||
    !['BUY', 'SELL'].includes(fact.side) ||
    !Number.isSafeInteger(fact.cumulativeQuantity) ||
    fact.cumulativeQuantity < 0 ||
    !isValidPositiveMillis(fact.updatedAtMs) ||
    !(isKnownPhase(fact.phase) || (allowNullPhase && fact.phase === null))
  ) {
    throw new Error('[订单事实] broker identity、数量、phase 或 revision 无效');
  }

  const amount = assertCumulativeAmount(fact.cumulativeAmount);
  if (fact.cumulativeQuantity === 0) {
    if (exactCompare(amount, '0') !== 0 || fact.executionTimeMs !== null) {
      throw new Error('[订单事实] 零成交不得声明金额或执行时间');
    }

    return;
  }

  if (exactCompare(amount, '0') === 0)
    throw new Error('[订单事实] 正成交缺少可信金额');

  if (!isValidPositiveMillis(fact.executionTimeMs))
    throw new Error('[订单事实] 正成交缺少可信执行时间');
}

/**
 * 合并同一订单的已知累计事实与本次完整观察。
 *
 * 规则（唯一实现）：
 * - 零成交 => T 必须为 null；
 * - 首次正成交/累计量推进 => 使用本次原始观察时间代理作为 T，且金额必须产生正增量；
 * - 同量状态/合法金额修订 => 保留 known T，revision 可推进；
 * - revision 不倒退、数量不回退；旧 revision 的纯重复返回 null 表示不可消费；
 * - 旧 revision 携带数量增量直接拒绝。
 *
 * @param known durable/runtime 已知事实；phase 允许 null（V1 baseline）
 * @param observed 本次 broker 观察的完整累计事实
 * @returns 可消费事实；null 仅表示旧 revision 的非增量观察应被忽略
 */
export function mergeExecutionFact(
  known: KnownExecutionBaseline | undefined,
  observed: BrokerOrderExecutionFact,
): BrokerOrderExecutionFact | null {
  assertExecutionPayload(observed);
  const normalized: BrokerOrderExecutionFact = Object.freeze({
    ...observed,
    cumulativeAmount: canonicalDecimal(observed.cumulativeAmount),
  });
  if (known === undefined) return normalized;

  assertExecutionPayload(known, true);
  if (
    known.brokerOrderId !== observed.brokerOrderId ||
    known.symbol !== observed.symbol ||
    known.side !== observed.side
  ) {
    throw new Error('[订单事实] 同 broker identity 的归属冲突');
  }

  const quantityAdvanced = observed.cumulativeQuantity > known.cumulativeQuantity;
  if (observed.updatedAtMs < known.updatedAtMs) {
    if (quantityAdvanced) throw new Error('[订单事实] 累计数量推进但 revision 倒退');

    return null;
  }

  if (known.phase === 'TERMINAL' && observed.phase === 'OPEN')
    throw new Error('[订单事实] fact stage regression: TERMINAL -> OPEN');

  if (observed.cumulativeQuantity < known.cumulativeQuantity)
    throw new Error('[订单事实] 同/新 revision 累计数量倒退');

  const amountChanged =
    exactCompare(known.cumulativeAmount, normalized.cumulativeAmount) !== 0;

  if (quantityAdvanced) {
    if (exactCompare(normalized.cumulativeAmount, known.cumulativeAmount) <= 0)
      throw new Error('[订单事实] 正成交增量缺少正金额增量');

    const executionTimeMs = normalized.executionTimeMs;
    if (!isValidPositiveMillis(executionTimeMs))
      throw new Error('[订单事实] 正成交缺少可信执行时间');

    if (known.executionTimeMs !== null && executionTimeMs < known.executionTimeMs)
      throw new Error('[订单事实] 新 revision 的可信执行时间倒退');

    return normalized;
  }

  if (observed.cumulativeQuantity === 0) {
    // 零成交资源关闭：不允许金额或 T；revision/phase 可继续推进。
    return Object.freeze({ ...normalized, executionTimeMs: null });
  }

  if (amountChanged) {
    // 同 revision 的金额修订只允许由已证明的 OPEN->TERMINAL 收口授权；
    // phase 未知的 durable baseline 不得据此授权任何阶段修订。
    const phaseAdvanced = known.phase === 'OPEN' && observed.phase === 'TERMINAL';
    if (observed.updatedAtMs === known.updatedAtMs && !phaseAdvanced)
      throw new Error('[订单事实] 同 revision 同量同阶段的累计经济或执行时间冲突');

    return Object.freeze({
      ...normalized,
      executionTimeMs: known.executionTimeMs,
    });
  }

  if (
    known.phase !== null &&
    observed.updatedAtMs === known.updatedAtMs &&
    observed.phase === known.phase
  ) {
    return known as BrokerOrderExecutionFact;
  }

  return Object.freeze({
    ...normalized,
    executionTimeMs: known.executionTimeMs,
  });
}

/**
 * 兼容既有日损/runtime owner 的旧观察语义：旧 revision 的纯重复返回既有事实。
 * 完整 previous 与新观察的全部数量/金额/T/phase 规则仍由 mergeExecutionFact 唯一裁决。
 */
export function mergeBrokerOrderExecutionFact(
  previous: BrokerOrderExecutionFact | undefined,
  incoming: BrokerOrderExecutionFact,
): BrokerOrderExecutionFact {
  const merged = mergeExecutionFact(previous, incoming);
  if (merged !== null) return merged;

  if (previous === undefined) throw new Error('[订单事实] 缺少可消费的累计事实');

  return previous;
}
