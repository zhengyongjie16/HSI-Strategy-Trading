/** 订单累计事实纯裁决：单调数量、独立 revision/执行时间与终态资源事实，不提交 tracking 状态。 */

import type { OrderReadStatus, OrderStateCheckResult } from '../../types/orderReadMetadata.js';
import type { BrokerOrderExecutionFact } from '../../types/orderRecorder.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import { mergeExecutionFact } from './executionFact.js';
import { orderReadStatusPriority } from './orderReadLifecycle.js';
import type {
  KnownExecutionBaseline,
  KnownOrderFact,
  MonotonicOrderFact,
  NormalizedTerminalStateSnapshot,
  OrderObservedFact,
  TerminalStateSnapshot,
  TrackedOrder,
} from './types.js';

/** 明确 broker 观察才有阶段；缺失/未知 phase 不得进入累计裁决。 */
function requireExecutionPhase(value: unknown): 'OPEN' | 'TERMINAL' {
  if (value === 'OPEN' || value === 'TERMINAL') return value;

  throw new TypeError('[订单监控] broker事实缺少已验证中性executionPhase');
}

/** 判断值是否是可用于累计成交事实的有限正数。 */
function isValidPositiveFactNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 判断原始价格是否为正的精确十进制。 */
function hasPositivePrice(value: string | null): value is string {
  return value !== null && exactCompare(value, '0') > 0;
}

/** 判断原始金额是否缺失或为零。 */
function isMissingOrZeroAmount(value: string | null): boolean {
  return value === null || exactCompare(value, '0') === 0;
}

/** 原始数量边界在一切运行态和经济写入之前检查。 */
export function assertExecutionQuantityWithinSubmittedQuantity(
  orderId: string,
  submittedQuantity: number,
  executedQuantity: number,
): void {
  if (
    !Number.isSafeInteger(submittedQuantity) ||
    submittedQuantity < 0 ||
    !Number.isSafeInteger(executedQuantity) ||
    executedQuantity < 0
  )
    throw new Error(`[订单监控] 订单 ${orderId} 收到无效累计成交数量`);

  if (executedQuantity > submittedQuantity)
    throw new Error(`[订单监控] 订单 ${orderId} 累计成交量超过有效委托数量`);
}

/** known 经济事实完整才允许普通同量终态保留旧价/金额/T；零成交要求无金额无 T。 */
function hasCompleteKnownEconomics(known: KnownOrderFact): boolean {
  if (known.executedQuantity === 0)
    return exactCompare(known.executedAmount, '0') === 0 && known.lastExecutedTimeMs === null;

  return (
    hasPositivePrice(known.executedPrice) &&
    exactCompare(known.executedAmount, '0') > 0 &&
    isValidPositiveFactNumber(known.lastExecutedTimeMs) &&
    isValidPositiveFactNumber(known.lastOrderUpdateAtMs)
  );
}

/**
 * develop 明确限定的入站弱观察过滤：仅 known/observed 都是 OPEN、同 revision、
 * 数量下降、金额不增加且执行时间不推进时忽略；不得扩展到终态或恢复/经济 owner。
 */
export function isWeakOpenOrderObservation(
  known: Pick<
    KnownOrderFact,
    'executionPhase' | 'executedQuantity' | 'executedAmount' | 'lastExecutedTimeMs' | 'lastOrderUpdateAtMs'
  >,
  observed: OrderObservedFact,
): boolean {
  if (known.executionPhase !== 'OPEN' || observed.executionPhase !== 'OPEN') return false;

  if (known.lastOrderUpdateAtMs === null || observed.updatedAtMs !== known.lastOrderUpdateAtMs)
    return false;

  if (observed.executedQuantity === null || observed.executedQuantity >= known.executedQuantity)
    return false;

  if (exactCompare(observed.executedAmount ?? '0', known.executedAmount) > 0) return false;

  const observedTimeMs = observed.executedTimeMs;
  return (
    observedTimeMs === null ||
    (known.lastExecutedTimeMs !== null && observedTimeMs <= known.lastExecutedTimeMs)
  );
}

/**
 * 普通同量终态资源收口：原始价/金额缺失或 revision 已旧时，保留完整 known 经济事实。
 * 增量、不同量或 known 不完整都不得走此旁路；保护性 SELL 在调用前已独立校验原始事实。
 */
function isResourceOnlyTerminalObservation(
  known: KnownOrderFact,
  observed: OrderObservedFact,
): boolean {
  if (observed.executionPhase !== 'TERMINAL') return false;

  if (observed.executedQuantity !== known.executedQuantity) return false;

  if (!hasCompleteKnownEconomics(known)) return false;

  const rawMissing =
    !hasPositivePrice(observed.executedPrice) || isMissingOrZeroAmount(observed.executedAmount);
  const staleRevision =
    observed.updatedAtMs !== null &&
    known.lastOrderUpdateAtMs !== null &&
    observed.updatedAtMs < known.lastOrderUpdateAtMs;
  return rawMissing || staleRevision;
}

/** 校验本次观察的累计数量/revision/成交价与金额基本自洽；其余增量规则交给共享 merge。 */
function validateObservedFacts(known: KnownOrderFact, observed: OrderObservedFact): number | null {
  if (
    observed.executedQuantity === null ||
    !Number.isSafeInteger(observed.executedQuantity) ||
    observed.executedQuantity < 0
  )
    throw new Error('[订单监控] 订单观察缺少有效累计成交数量');

  if (observed.executedQuantity === 0) {
    // 零成交不消费价格；只禁止伪造金额或执行时间。零成交资源关闭允许缺少 broker revision。
    if (!isMissingOrZeroAmount(observed.executedAmount) || observed.executedTimeMs !== null)
      throw new Error('[订单监控] 零成交观察不得声明金额或执行时间');

    if (observed.updatedAtMs !== null && !isValidPositiveFactNumber(observed.updatedAtMs))
      throw new Error('[订单监控] 订单观察缺少有效 broker revision');

    return observed.updatedAtMs;
  }

  const rawPricePresent = hasPositivePrice(observed.executedPrice);
  const rawAmountPresent = !isMissingOrZeroAmount(observed.executedAmount);
  if (rawPricePresent !== rawAmountPresent)
    throw new Error('[订单监控] 原始成交价格与金额不一致');

  const resourceOnly = isResourceOnlyTerminalObservation(known, observed);
  if ((!rawPricePresent || !rawAmountPresent) && !resourceOnly) {
    throw new Error('[订单监控] 正累计成交缺少本次原始价格或金额');
  }

  if (
    (observed.updatedAtMs === null || !isValidPositiveFactNumber(observed.updatedAtMs)) &&
    !resourceOnly
  ) {
    throw new Error('[订单监控] 订单观察缺少有效 broker revision');
  }

  if (
    observed.executedTimeMs !== null &&
    !isValidPositiveFactNumber(observed.executedTimeMs)
  )
    throw new Error('[订单监控] 原始执行时间无效');


  return observed.updatedAtMs;
}

/** 将已验证观察转换为共享累计事实；T 缺省时使用本次原始 observation 时间代理。 */
function toExecutionFact(
  known: KnownOrderFact,
  observed: OrderObservedFact,
  observedRevision: number,
  observedPhase: 'OPEN' | 'TERMINAL',
): BrokerOrderExecutionFact {
  const quantity = observed.executedQuantity ?? 0;
  const executionTimeMs = quantity === 0 ? null : (observed.executedTimeMs ?? observedRevision);

  return {
    brokerOrderId: known.orderId,
    symbol: known.symbol,
    side: known.executionSide,
    cumulativeQuantity: quantity,
    cumulativeAmount: observed.executedAmount ?? '0',
    executionTimeMs,
    updatedAtMs: observedRevision,
    phase: observedPhase,
  };
}

/** known 仅在已有 broker revision 时参与累计裁决；初始 tracking 尚未有事实。 */
function resolveKnownBaseline(known: KnownOrderFact): KnownExecutionBaseline | undefined {
  if (known.lastOrderUpdateAtMs === null) return undefined;

  return {
    brokerOrderId: known.orderId,
    symbol: known.symbol,
    side: known.executionSide,
    cumulativeQuantity: known.executedQuantity,
    cumulativeAmount: known.executedAmount,
    executionTimeMs: known.lastExecutedTimeMs,
    updatedAtMs: known.lastOrderUpdateAtMs,
    phase: known.executionPhase,
  };
}

/** 提取正成交保留后的成交价：增量/金额修订接受本次原始价，否则保留 known。 */
function resolveMergedExecutedPrice(
  known: KnownOrderFact,
  observed: OrderObservedFact,
  executionAdvanced: boolean,
  amountRevised: boolean,
): string | null {
  if (executionAdvanced || amountRevised) return observed.executedPrice;

  if (known.executedPrice !== null) return known.executedPrice;

  return observed.executedPrice;
}

/** 保护性 SELL 的 known 或本次原始观察只要存在成交事实，就必须由本次原始量价/revision 证明。 */
export function assertProtectiveSellRawObservationFactsReady(
  known: Pick<
    TrackedOrder,
    | 'orderId'
    | 'executionSide'
    | 'isProtectiveLiquidation'
    | 'executedQuantity'
    | 'lastOrderUpdateAtMs'
  >,
  observed: OrderObservedFact & Readonly<{ executionStatus?: 'NONE' | 'PARTIAL' | 'FILLED' }>,
): void {
  if (known.executionSide !== 'SELL' || !known.isProtectiveLiquidation) return;

  const rawDeclaresExecution =
    observed.executionStatus === 'PARTIAL' ||
    observed.executionStatus === 'FILLED' ||
    observed.status === 'PARTIALLY_FILLED' ||
    observed.status === 'FILLED' ||
    isValidPositiveFactNumber(observed.executedQuantity);
  if (known.executedQuantity <= 0 && !rawDeclaresExecution) return;

  if (!isValidPositiveFactNumber(observed.executedQuantity))
    throw new Error(
      `[订单监控] 订单 ${known.orderId} 保护性 SELL 存在成交事实但本次观察缺少原始累计成交数量`,
    );

  if (!hasPositivePrice(observed.executedPrice))
    throw new Error(
      `[订单监控] 订单 ${known.orderId} 保护性 SELL 存在成交事实但本次观察缺少有效成交价`,
    );

  if (observed.updatedAtMs === null || !isValidPositiveFactNumber(observed.updatedAtMs))
    throw new Error(
      `[订单监控] 订单 ${known.orderId} 保护性 SELL 存在成交事实但本次观察缺少有效 broker revision`,
    );

  const executionTimeMs = observed.executedTimeMs ?? observed.updatedAtMs;
  if (!isValidPositiveFactNumber(executionTimeMs))
    throw new Error(
      `[订单监控] 订单 ${known.orderId} 保护性 SELL 存在成交事实但本次观察缺少有效执行时间`,
    );

  if (
    observed.executedQuantity > known.executedQuantity &&
    known.lastOrderUpdateAtMs !== null &&
    observed.updatedAtMs < known.lastOrderUpdateAtMs
  )
    throw new Error(
      `[订单监控] 订单 ${known.orderId} 保护性 SELL 累计成交推进但 broker revision 倒退，阻断状态推进`,
    );
}

/**
 * state-check TERMINAL 原始事实准入。
 * 与 OPEN 共用同一原始量价/revision 规则，且必须在任何 resourceOnly 旁路之前执行。
 */
export function assertProtectiveSellRawTerminalStateFactsReady(
  known: KnownOrderFact & Partial<Pick<TrackedOrder, 'isProtectiveLiquidation'>>,
  terminal: TerminalStateSnapshot,
): void {
  assertProtectiveSellRawObservationFactsReady(
    {
      orderId: known.orderId,
      executionSide: known.executionSide,
      isProtectiveLiquidation: known.isProtectiveLiquidation === true,
      executedQuantity: known.executedQuantity,
      lastOrderUpdateAtMs: known.lastOrderUpdateAtMs,
    },
    {
      status: terminal.status,
      executionPhase: 'TERMINAL',
      executionStatus: terminal.executionStatus,
      executedQuantity: terminal.executedQuantity,
      executedAmount: terminal.executedAmount,
      executedPrice: terminal.executedPrice,
      executedTimeMs: terminal.executionTimeMs,
      updatedAtMs: terminal.orderUpdatedAtMs,
    },
  );
}

/** state-check 到达后、任何 cache/运行态写入前验证原始事实；增量缺价由共享 merge 再次拒绝。 */
export function assertStateCheckRawExecutionFactsReady(
  known: (KnownOrderFact & Partial<Pick<TrackedOrder, 'isProtectiveLiquidation'>>) | null | undefined,
  result: Exclude<OrderStateCheckResult, { kind: 'QUERY_FAILED' }>,
): void {
  const observation: OrderObservedFact & Readonly<{ executionStatus: 'NONE' | 'PARTIAL' | 'FILLED' }> =
    {
      status: result.status,
      executionPhase: result.kind,
      executionStatus: result.executionStatus,
      executedQuantity: result.executedQuantity,
      executedAmount: result.executedAmount,
      executedPrice: result.executedPrice,
      executedTimeMs: result.executionTimeMs,
      updatedAtMs: result.kind === 'OPEN' ? result.updatedAtMs : result.orderUpdatedAtMs,
    };

  const reference = known ?? {
    orderId: 'state-check',
    symbol: '',
    executionSide: 'BUY' as const,
    executionPhase: null,
    submittedQuantity: observation.executedQuantity ?? 0,
    status: result.status,
    executedQuantity: 0,
    executedPrice: null,
    executedAmount: '0',
    lastExecutedTimeMs: null,
    lastOrderUpdateAtMs: null,
  };
  validateObservedFacts(reference, observation);

  if (known === null || known === undefined) return;

  assertExecutionQuantityWithinSubmittedQuantity(
    known.orderId,
    known.submittedQuantity,
    observation.executedQuantity ?? 0,
  );

  if (
    (observation.executedQuantity ?? 0) > known.executedQuantity &&
    observation.updatedAtMs !== null &&
    known.lastOrderUpdateAtMs !== null &&
    observation.updatedAtMs < known.lastOrderUpdateAtMs
  )
    throw new Error('[订单事实] 累计数量推进但 revision 倒退');

  assertProtectiveSellRawObservationFactsReady(
    {
      orderId: known.orderId,
      executionSide: known.executionSide,
      isProtectiveLiquidation: known.isProtectiveLiquidation === true,
      executedQuantity: known.executedQuantity,
      lastOrderUpdateAtMs: known.lastOrderUpdateAtMs,
    },
    observation,
  );
}

/** 按订单操作语义解析同 timestamp OPEN 状态的事实阶段。 */
function resolveOpenStatusFactPhase(status: OrderReadStatus): number {
  if (status === 'CANCELLATION_PENDING') return 6;

  if (status === 'CANCELLATION_REQUESTED') return 5;

  if (status === 'PARTIALLY_FILLED') return 4;

  if (status === 'WORKING' || status === 'REPLACED') return 3;

  if (status === 'REPLACEMENT_PENDING') return 2;

  if (status === 'REPLACEMENT_REQUESTED') return 1;

  if (
    status === 'SUBMISSION_PENDING' ||
    status === 'UNREPORTED' ||
    status === 'REPLACEMENT_UNREPORTED' ||
    status === 'PROTECTION_UNREPORTED' ||
    status === 'CONDITIONAL_UNREPORTED'
  ) {
    return 0;
  }

  throw new Error(`[订单监控] 非 OPEN 状态不能参与 OPEN 事实阶段裁决: ${status}`);
}

/** 同 timestamp 无法依赖先后顺序时，按业务事实阶段选择结果。 */
function resolveSameTimestampOpenStatus(
  left: OrderReadStatus,
  right: OrderReadStatus,
): OrderReadStatus {
  const leftPhase = resolveOpenStatusFactPhase(left);
  const rightPhase = resolveOpenStatusFactPhase(right);
  if (leftPhase !== rightPhase) return leftPhase > rightPhase ? left : right;

  if (left === right) return left;

  if (left === 'WORKING' || right === 'WORKING') return 'WORKING';

  return orderReadStatusPriority(left) > orderReadStatusPriority(right) ? left : right;
}

/** 判断较新 OPEN 状态是否属于合法生命周期推进。 */
function canAdvanceOpenStatus(current: OrderReadStatus, next: OrderReadStatus): boolean {
  if (current === next) return true;

  if (
    current === 'UNREPORTED' ||
    current === 'REPLACEMENT_UNREPORTED' ||
    current === 'PROTECTION_UNREPORTED' ||
    current === 'CONDITIONAL_UNREPORTED' ||
    current === 'SUBMISSION_PENDING'
  ) {
    return true;
  }

  if (current === 'WORKING' || current === 'REPLACED') {
    return (
      next === 'WORKING' ||
      next === 'REPLACEMENT_REQUESTED' ||
      next === 'REPLACEMENT_PENDING' ||
      next === 'REPLACED' ||
      next === 'PARTIALLY_FILLED' ||
      next === 'CANCELLATION_REQUESTED' ||
      next === 'CANCELLATION_PENDING'
    );
  }

  if (current === 'REPLACEMENT_REQUESTED' || current === 'REPLACEMENT_PENDING') {
    return (
      next === 'WORKING' ||
      next === 'REPLACEMENT_REQUESTED' ||
      next === 'REPLACEMENT_PENDING' ||
      next === 'REPLACED' ||
      next === 'PARTIALLY_FILLED' ||
      next === 'CANCELLATION_REQUESTED' ||
      next === 'CANCELLATION_PENDING'
    );
  }

  if (current === 'PARTIALLY_FILLED') {
    return (
      next === 'PARTIALLY_FILLED' ||
      next === 'REPLACEMENT_REQUESTED' ||
      next === 'REPLACEMENT_PENDING' ||
      next === 'REPLACED' ||
      next === 'CANCELLATION_REQUESTED' ||
      next === 'CANCELLATION_PENDING'
    );
  }

  if (current === 'CANCELLATION_REQUESTED') {
    return (
      next === 'CANCELLATION_REQUESTED' ||
      next === 'CANCELLATION_PENDING' ||
      next === 'WORKING' ||
      next === 'REPLACED' ||
      next === 'PARTIALLY_FILLED' ||
      next === 'REPLACEMENT_REQUESTED' ||
      next === 'REPLACEMENT_PENDING'
    );
  }

  if (current === 'CANCELLATION_PENDING') {
    return (
      next === 'CANCELLATION_PENDING' ||
      next === 'WORKING' ||
      next === 'REPLACED' ||
      next === 'PARTIALLY_FILLED' ||
      next === 'REPLACEMENT_REQUESTED' ||
      next === 'REPLACEMENT_PENDING'
    );
  }

  throw new Error(`[订单监控] 未识别的 OPEN 状态推进起点: ${current}`);
}

/**
 * 将订单观察合并为单调事实。
 * 数量/金额/revision/T 全部由共享累计 merge 裁决；本函数只裁决 OPEN 状态生命周期推进。
 */
export function mergeMonotonicOrderFact(
  known: KnownOrderFact,
  observed: OrderObservedFact,
): MonotonicOrderFact | null {
  const observedPhase = requireExecutionPhase(observed.executionPhase);
  if (known.executionPhase !== null) requireExecutionPhase(known.executionPhase);

  const observedRevision = validateObservedFacts(known, observed);
  assertExecutionQuantityWithinSubmittedQuantity(
    known.orderId,
    known.submittedQuantity,
    observed.executedQuantity ?? 0,
  );

  if (known.executionPhase === 'TERMINAL') return null;

  if (isWeakOpenOrderObservation(known, observed)) return null;

  if (observed.executedQuantity === 0 && observedRevision === null) {
    // 无 revision 的零关闭只能用于 known 本身完整为零的事实；不得借旧 revision 包装 zero 否认正量。
    if (
      known.executedQuantity !== 0 ||
      exactCompare(known.executedAmount, '0') !== 0 ||
      known.lastExecutedTimeMs !== null
    ) {
      throw new Error('[订单监控] 无 revision 零关闭不得否认已知正累计成交');
    }

    return {
      status: observed.status,
      executionPhase: observed.executionPhase,
      executedQuantity: 0,
      executedAmount: '0',
      executedPrice: null,
      executedTimeMs: null,
      updatedAtMs: known.lastOrderUpdateAtMs,
    };
  }

  if (isResourceOnlyTerminalObservation(known, observed)) {
    if (observed.updatedAtMs === null) throw new Error('[订单监控] 订单观察缺少 broker revision');

    const knownRevision = known.lastOrderUpdateAtMs;
    return {
      status: observed.status,
      executionPhase: 'TERMINAL',
      executedQuantity: known.executedQuantity,
      executedAmount: known.executedAmount,
      executedPrice: known.executedPrice,
      executedTimeMs: known.lastExecutedTimeMs,
      updatedAtMs:
        knownRevision === null ? observed.updatedAtMs : Math.max(knownRevision, observed.updatedAtMs),
    };
  }

  if (observedRevision === null) throw new Error('[订单监控] 订单观察缺少有效 broker revision');

  const merged = mergeExecutionFact(
    resolveKnownBaseline(known),
    toExecutionFact(known, observed, observedRevision, observedPhase),
  );
  if (merged === null) return null;

  const executionAdvanced = merged.cumulativeQuantity > known.executedQuantity;
  const amountRevised =
    merged.cumulativeQuantity === known.executedQuantity &&
    exactCompare(merged.cumulativeAmount, known.executedAmount) !== 0;

  let status: OrderReadStatus;
  if (merged.phase === 'TERMINAL') {
    status = observed.status;
  } else if (known.lastOrderUpdateAtMs !== null && merged.updatedAtMs === known.lastOrderUpdateAtMs) {
    status = resolveSameTimestampOpenStatus(known.status, observed.status);
  } else if (
    known.lastOrderUpdateAtMs !== null &&
    !canAdvanceOpenStatus(known.status, observed.status)
  ) {
    if (!executionAdvanced) return null;

    status = known.status;
  } else {
    status = observed.status;
  }

  if (
    status === known.status &&
    merged.phase === known.executionPhase &&
    merged.updatedAtMs === known.lastOrderUpdateAtMs &&
    merged.cumulativeQuantity === known.executedQuantity &&
    exactCompare(merged.cumulativeAmount, known.executedAmount) === 0 &&
    merged.executionTimeMs === known.lastExecutedTimeMs
  )
    return null;

  const executedPrice = resolveMergedExecutedPrice(
    known,
    observed,
    executionAdvanced,
    amountRevised,
  );
  if (merged.cumulativeQuantity > 0 && executedPrice === null)
    throw new Error(`[订单监控] 订单 ${known.orderId} 正成交缺少可保留的成交价`);

  return {
    status,
    executionPhase: merged.phase,
    executedQuantity: merged.cumulativeQuantity,
    executedAmount: merged.cumulativeAmount,
    executedPrice,
    executedTimeMs: merged.executionTimeMs,
    updatedAtMs: merged.updatedAtMs,
  };
}

/** 用已知完整经济事实收口同量终态，不推进 T，也不制造新成交；broker revision 可取本次进度。 */
function normalizeResourceOnlyTerminal(
  known: KnownOrderFact,
  terminal: TerminalStateSnapshot,
): NormalizedTerminalStateSnapshot {
  const knownRevision = known.lastOrderUpdateAtMs;
  const terminalRevision = terminal.orderUpdatedAtMs;
  let orderUpdatedAtMs = knownRevision;
  if (
    orderUpdatedAtMs === null ||
    (terminalRevision !== null && terminalRevision > orderUpdatedAtMs)
  )
    orderUpdatedAtMs = terminalRevision;

  return {
    ...terminal,
    executedQuantity: known.executedQuantity,
    executedPrice: known.executedPrice,
    executedAmount: known.executedAmount,
    executionTimeMs: known.lastExecutedTimeMs,
    executedTimeMs: known.lastExecutedTimeMs,
    orderUpdatedAtMs,
  };
}

/**
 * 将 API TERMINAL state-check 与当前已知订单事实合并为可结算终态。
 * 保护性 SELL 原始事实检查必须先于普通 resourceOnly 旁路；终态不得否认更强的已知经济事实。
 */
export function normalizeTerminalStateSnapshot(
  known: KnownOrderFact & Partial<Pick<TrackedOrder, 'isProtectiveLiquidation'>>,
  terminal: TerminalStateSnapshot,
  isProtectiveSell: boolean = false,
): NormalizedTerminalStateSnapshot {
  if (isProtectiveSell) assertProtectiveSellRawTerminalStateFactsReady(known, terminal);

  const observed: OrderObservedFact = {
    status: terminal.status,
    executionPhase: 'TERMINAL',
    executedQuantity: terminal.executedQuantity,
    executedAmount: terminal.executedAmount,
    executedPrice: terminal.executedPrice,
    executedTimeMs: terminal.executionTimeMs,
    updatedAtMs: terminal.orderUpdatedAtMs,
  };

  if (isResourceOnlyTerminalObservation(known, observed))
    return normalizeResourceOnlyTerminal(known, terminal);

  const merged = mergeMonotonicOrderFact(known, observed);
  if (merged === null) {
    // 旧 revision 的非增量终态不能推进事实；known 完整时用其收口资源（只允许同量或更低的原始量）。
    const staleRevision =
      terminal.orderUpdatedAtMs !== null &&
      known.lastOrderUpdateAtMs !== null &&
      terminal.orderUpdatedAtMs < known.lastOrderUpdateAtMs;
    if (
      staleRevision &&
      hasCompleteKnownEconomics(known) &&
      (terminal.executedQuantity === null ||
        terminal.executedQuantity <= known.executedQuantity)
    )
      return normalizeResourceOnlyTerminal(known, terminal);

    throw new Error(`[订单监控] 订单 ${known.orderId} 终态事实无法与当前已知事实合并`);
  }

  return {
    ...terminal,
    status: merged.status,
    executedQuantity: merged.executedQuantity,
    executedPrice: merged.executedPrice,
    executedAmount: merged.executedAmount,
    executionTimeMs: merged.executedTimeMs,
    executedTimeMs: merged.executedTimeMs,
    orderUpdatedAtMs: merged.updatedAtMs,
  };
}
