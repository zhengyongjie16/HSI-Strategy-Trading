/** 订单累计事实纯裁决：单调数量、独立 revision/执行时间与终态资源事实，不提交 tracking 状态。 */

import type { OrderReadStatus, OrderStateCheckResult } from '../../types/orderReadMetadata.js';
import type { BrokerOrderExecutionFact } from '../../types/orderRecorder.js';

import { exactCompare } from '../../utils/numeric/exact.js';
import { mergeBrokerOrderExecutionFact } from './executionFact.js';
import { orderReadStatusPriority } from './orderReadLifecycle.js';
import type {
  KnownOrderFact,
  MonotonicOrderFact,
  NormalizedTerminalStateSnapshot,
  OrderObservedFact,
  TerminalStateSnapshot,
  TrackedOrder,
} from './types.js';

/** 订单运行态合并：复用唯一累计事实裁决，执行 T 来自 ledger/durable，绝不由 revision 派生。 */

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

/** 正成交观察必须完整；未知 T 显式拒绝，不从 tracked 或本地时钟补造新增成交。 */
function assertRawExecution(
  known: Pick<TrackedOrder, 'orderId' | 'executedQuantity' | 'lastOrderUpdateAtMs'>,
  observed: Omit<OrderObservedFact, 'executionPhase'>,
): asserts observed is Omit<OrderObservedFact, 'executionPhase'> &
  Readonly<{ executedQuantity: number }> {
  const quantity = observed.executedQuantity;
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 0)
    throw new Error('[订单监控] 无效累计成交数量');

  if (quantity === 0) {
    if (exactCompare(observed.executedAmount, '0') !== 0 || observed.executedTimeMs !== null)
      throw new Error('[订单监控] 零成交存在金额或执行时间');

    return;
  }

  if (
    observed.executedPrice === null ||
    exactCompare(observed.executedPrice, '0') <= 0 ||
    exactCompare(observed.executedAmount, '0') <= 0 ||
    observed.executedTimeMs === null ||
    !Number.isSafeInteger(observed.executedTimeMs) ||
    observed.executedTimeMs <= 0 ||
    observed.updatedAtMs === null ||
    !Number.isSafeInteger(observed.updatedAtMs) ||
    observed.updatedAtMs <= 0
  )
    throw new Error('[订单监控] 正累计成交缺少有效金额、成交价格、真实执行时间或 broker revision');

  if (
    quantity > known.executedQuantity &&
    known.lastOrderUpdateAtMs !== null &&
    observed.updatedAtMs < known.lastOrderUpdateAtMs
  )
    throw new Error('[订单监控] 累计成交推进但 broker revision 倒退');
}

/** 保护性 SELL 在 durable progress 之前要求当前原始观察完整。 */
export function assertProtectiveSellRawObservationFactsReady(
  known: Pick<
    TrackedOrder,
    | 'orderId'
    | 'executionSide'
    | 'isProtectiveLiquidation'
    | 'executedQuantity'
    | 'lastOrderUpdateAtMs'
  >,
  observed: OrderObservedFact & Readonly<{ executionStatus: 'NONE' | 'PARTIAL' | 'FILLED' }>,
): void {
  if (known.executionSide !== 'SELL' || !known.isProtectiveLiquidation) return;

  const executionStatus: unknown = observed.executionStatus;
  if (executionStatus !== 'NONE' && executionStatus !== 'PARTIAL' && executionStatus !== 'FILLED')
    throw new TypeError('[订单监控] 观察缺少已验证中性executionStatus');

  assertRawExecution(known, observed);
  if (
    (known.executedQuantity > 0 || executionStatus === 'FILLED' || executionStatus === 'PARTIAL') &&
    observed.executedQuantity === 0
  )
    throw new Error('[订单监控] 保护性 SELL 存在正累计成交但原始观察否认执行事实');
}

/** 非成交终态只关闭资源：等量、等金额且无新增执行证据时保留已有可信经济事实。 */
function isResourceOnlyTerminal(known: KnownOrderFact, terminal: TerminalStateSnapshot): boolean {
  if (terminal.closedReason === 'FILLED' || terminal.executedQuantity !== known.executedQuantity)
    return false;

  const missingEconomicEvidence =
    terminal.executedPrice === null && terminal.orderUpdatedAtMs === null;
  const amountMatches = exactCompare(terminal.executedAmount, known.executedAmount) === 0;
  if (
    !amountMatches &&
    !(missingEconomicEvidence && exactCompare(terminal.executedAmount, '0') === 0)
  )
    return false;

  if (
    terminal.executedPrice !== null &&
    known.executedPrice !== null &&
    exactCompare(terminal.executedPrice, known.executedPrice) !== 0
  )
    return false;

  if (
    terminal.executionTimeMs !== null &&
    (!Number.isSafeInteger(terminal.executionTimeMs) ||
      terminal.executionTimeMs <= 0 ||
      known.lastExecutedTimeMs === null ||
      terminal.executionTimeMs > known.lastExecutedTimeMs)
  )
    return false;

  if (
    terminal.orderUpdatedAtMs !== null &&
    known.lastOrderUpdateAtMs !== null &&
    terminal.orderUpdatedAtMs < known.lastOrderUpdateAtMs
  )
    return false;

  if (
    terminal.executedPrice !== null &&
    terminal.executionTimeMs !== null &&
    terminal.orderUpdatedAtMs !== null
  )
    return false;

  assertRawExecution(known, {
    status: known.status,
    executedQuantity: known.executedQuantity,
    executedAmount: known.executedAmount,
    executedPrice: known.executedPrice,
    executedTimeMs: known.lastExecutedTimeMs,
    updatedAtMs: known.lastOrderUpdateAtMs,
  });
  return true;
}

/** query 与 push 使用同一原始 amount/T 准入，terminal 不拿 updatedAt 洗白 T。 */
export function assertProtectiveSellRawTerminalStateFactsReady(
  known: KnownOrderFact & Pick<TrackedOrder, 'isProtectiveLiquidation'>,
  terminal: TerminalStateSnapshot,
): void {
  if (isResourceOnlyTerminal(known, terminal)) return;

  assertProtectiveSellRawObservationFactsReady(known, {
    executionStatus: terminal.executionStatus,
    executionPhase: terminal.kind,
    status: terminal.status,
    executedQuantity: terminal.executedQuantity,
    executedPrice: terminal.executedPrice,
    executedAmount: terminal.executedAmount,
    executedTimeMs: terminal.executionTimeMs,
    updatedAtMs: terminal.orderUpdatedAtMs,
  });
}

/** state-check 到达后、任何 cache/运行态写入前验证原始事实。 */
export function assertStateCheckRawExecutionFactsReady(
  known: (KnownOrderFact & Pick<TrackedOrder, 'isProtectiveLiquidation'>) | null | undefined,
  result: Exclude<OrderStateCheckResult, { kind: 'QUERY_FAILED' }>,
): void {
  if (
    known !== null &&
    known !== undefined &&
    result.kind === 'TERMINAL' &&
    isResourceOnlyTerminal(known, result)
  )
    return;

  const observation: OrderObservedFact &
    Readonly<{ executionStatus: 'NONE' | 'PARTIAL' | 'FILLED' }> = {
    executionPhase: result.kind,
    executionStatus: result.executionStatus,
    status: result.status,
    executedQuantity: result.executedQuantity,
    executedPrice: result.executedPrice,
    executedAmount: result.executedAmount,
    executedTimeMs: result.executionTimeMs,
    updatedAtMs: result.kind === 'OPEN' ? result.updatedAtMs : result.orderUpdatedAtMs,
  };
  assertRawExecution(
    known ?? { orderId: 'state-check', executedQuantity: 0, lastOrderUpdateAtMs: null },
    observation,
  );

  if (known !== null && known !== undefined) {
    assertExecutionQuantityWithinSubmittedQuantity(
      known.orderId,
      known.submittedQuantity,
      observation.executedQuantity,
    );
    assertProtectiveSellRawObservationFactsReady(known, observation);
  }
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
  if (leftPhase !== rightPhase) {
    return leftPhase > rightPhase ? left : right;
  }

  if (left === right) {
    return left;
  }

  if (left === 'WORKING' || right === 'WORKING') {
    return 'WORKING';
  }

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

/** 明确broker观察才有阶段；V1/未有事实的未知phase不能补票参与累计经济裁决。 */
function requireExecutionPhase(value: unknown): 'OPEN' | 'TERMINAL' {
  if (value === 'OPEN' || value === 'TERMINAL') return value;

  throw new TypeError('[订单监控] broker事实缺少已验证中性executionPhase');
}

/** shared 判定累计事实，具体 OPEN 生命周期推进仍使用原业务状态规则。 */
export function mergeMonotonicOrderFact(
  known: KnownOrderFact,
  observed: OrderObservedFact,
): MonotonicOrderFact | null {
  const observedPhase = requireExecutionPhase(observed.executionPhase);
  const knownPhase =
    known.lastOrderUpdateAtMs === null ? null : requireExecutionPhase(known.executionPhase);

  assertRawExecution(known, observed);
  assertExecutionQuantityWithinSubmittedQuantity(
    known.orderId,
    known.submittedQuantity,
    observed.executedQuantity,
  );

  if (observed.updatedAtMs === null) throw new Error('[订单监控] 订单观察缺少 broker revision');

  const doesNotAdvanceTime =
    observed.executedTimeMs === null
      ? true
      : known.lastExecutedTimeMs !== null && observed.executedTimeMs <= known.lastExecutedTimeMs;
  // 同broker已验证的迟到弱观察在入站单调层丢弃；经济commit本身仍严格禁止数量/phase倒退。
  if (
    knownPhase === 'OPEN' &&
    observedPhase === 'OPEN' &&
    known.lastOrderUpdateAtMs !== null &&
    observed.updatedAtMs === known.lastOrderUpdateAtMs &&
    observed.executedQuantity < known.executedQuantity &&
    exactCompare(observed.executedAmount, known.executedAmount) <= 0 &&
    doesNotAdvanceTime
  )
    return null;

  if (
    knownPhase === 'TERMINAL' &&
    observedPhase === 'OPEN' &&
    observed.executedQuantity === known.executedQuantity &&
    exactCompare(observed.executedAmount, known.executedAmount) === 0 &&
    doesNotAdvanceTime
  )
    return null;

  const previous: BrokerOrderExecutionFact | undefined =
    known.lastOrderUpdateAtMs === null
      ? undefined
      : {
          brokerOrderId: known.orderId,
          symbol: known.symbol,
          side: known.executionSide,
          cumulativeQuantity: known.executedQuantity,
          cumulativeAmount: known.executedAmount,
          executionTimeMs: known.lastExecutedTimeMs,
          updatedAtMs: known.lastOrderUpdateAtMs,
          phase: requireExecutionPhase(knownPhase),
        };
  const next = mergeBrokerOrderExecutionFact(previous, {
    brokerOrderId: known.orderId,
    symbol: known.symbol,
    side: known.executionSide,
    cumulativeQuantity: observed.executedQuantity,
    cumulativeAmount: observed.executedAmount,
    executionTimeMs: observed.executedTimeMs,
    updatedAtMs: observed.updatedAtMs,
    phase: observedPhase,
  });
  if (previous !== undefined && observed.updatedAtMs < previous.updatedAtMs) return null;

  let status =
    previous?.updatedAtMs === observed.updatedAtMs && next.phase === 'OPEN'
      ? resolveSameTimestampOpenStatus(known.status, observed.status)
      : observed.status;
  if (
    next.phase === 'OPEN' &&
    previous !== undefined &&
    observed.updatedAtMs > previous.updatedAtMs &&
    !canAdvanceOpenStatus(known.status, observed.status)
  ) {
    if (next.cumulativeQuantity <= known.executedQuantity) return null;

    status = known.status;
  }

  if (next === previous && status === known.status) return null;

  return {
    status,
    executionPhase: next.phase,
    executedQuantity: next.cumulativeQuantity,
    executedAmount: next.cumulativeAmount,
    executedPrice: observed.executedPrice,
    executedTimeMs: next.executionTimeMs,
    updatedAtMs: next.updatedAtMs,
  };
}

/** 终态只使用共享裁决已接受的累计 amount/T/revision，不能补造 broker 执行。 */
export function normalizeTerminalStateSnapshot(
  known: KnownOrderFact,
  terminal: TerminalStateSnapshot,
  isProtectiveSell = false,
): NormalizedTerminalStateSnapshot {
  if (isResourceOnlyTerminal(known, terminal)) {
    return {
      ...terminal,
      executedQuantity: known.executedQuantity,
      executedAmount: known.executedAmount,
      executedPrice: known.executedPrice,
      executionTimeMs: known.lastExecutedTimeMs,
      executedTimeMs: known.lastExecutedTimeMs,
      orderUpdatedAtMs: known.lastOrderUpdateAtMs,
    };
  }

  if (isProtectiveSell)
    assertRawExecution(known, {
      status: terminal.status,
      executedQuantity: terminal.executedQuantity,
      executedAmount: terminal.executedAmount,
      executedPrice: terminal.executedPrice,
      executedTimeMs: terminal.executionTimeMs,
      updatedAtMs: terminal.orderUpdatedAtMs,
    });

  const merged = mergeMonotonicOrderFact(known, {
    executionPhase: terminal.kind,
    status: terminal.status,
    executedQuantity: terminal.executedQuantity,
    executedAmount: terminal.executedAmount,
    executedPrice: terminal.executedPrice,
    executedTimeMs: terminal.executionTimeMs,
    updatedAtMs: terminal.orderUpdatedAtMs,
  });
  if (merged === null) {
    // 较旧原始候选已经严格预检；资源终态不能抹掉同broker更强的已知经济事实。
    if (
      terminal.orderUpdatedAtMs !== null &&
      known.lastOrderUpdateAtMs !== null &&
      terminal.orderUpdatedAtMs < known.lastOrderUpdateAtMs &&
      terminal.executedQuantity !== null &&
      terminal.executedQuantity <= known.executedQuantity
    ) {
      assertRawExecution(known, {
        status: known.status,
        executedQuantity: known.executedQuantity,
        executedAmount: known.executedAmount,
        executedPrice: known.executedPrice,
        executedTimeMs: known.lastExecutedTimeMs,
        updatedAtMs: known.lastOrderUpdateAtMs,
      });
      return {
        ...terminal,
        executedQuantity: known.executedQuantity,
        executedAmount: known.executedAmount,
        executedPrice: known.executedPrice,
        executionTimeMs: known.lastExecutedTimeMs,
        executedTimeMs: known.lastExecutedTimeMs,
        orderUpdatedAtMs: known.lastOrderUpdateAtMs,
      };
    }

    throw new Error(`[订单监控] 订单 ${known.orderId} 终态事实无法与当前已知事实合并`);
  }

  return {
    ...terminal,
    status: merged.status,
    executedQuantity: merged.executedQuantity,
    executedPrice: merged.executedPrice,
    executedAmount: merged.executedAmount,
    executedTimeMs: merged.executedTimeMs,
    executionTimeMs: merged.executedTimeMs,
    orderUpdatedAtMs: merged.updatedAtMs,
  };
}
