/**
 * 恢复历史快照的完整一致性校验。
 * 只做纯校验与排序；不合并、不提交任何状态，也不建立第二账本。
 */
import { mergeExecutionFact } from '../order/executionFact.js';
import type { KnownExecutionBaseline } from '../order/types.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import type { ExecutionHistorySnapshot } from './types.js';

/** 阶段强弱：null（V1 baseline 未持久化）< OPEN < TERMINAL，用于同 revision/数量的择新。 */
function phaseRank(stage: ExecutionHistorySnapshot['factStage']): number {
  if (stage === null) return 0;

  return stage === 'OPEN' ? 1 : 2;
}

/** 历史快照排序：revision、累计数量、阶段、执行时间；与文件/记录到达顺序无关。 */
function compareExecutionHistorySnapshots(
  left: ExecutionHistorySnapshot,
  right: ExecutionHistorySnapshot,
): number {
  return (
    left.orderId.localeCompare(right.orderId) ||
    left.orderUpdatedAtMs - right.orderUpdatedAtMs ||
    left.cumulativeQuantity - right.cumulativeQuantity ||
    phaseRank(left.factStage) - phaseRank(right.factStage) ||
    (left.lastExecutionTimeMs ?? 0) - (right.lastExecutionTimeMs ?? 0)
  );
}

function assertSnapshotShape(snapshot: ExecutionHistorySnapshot): void {
  if (
    snapshot.orderId.length === 0 ||
    snapshot.symbol.length === 0 ||
    !['BUY', 'SELL'].includes(snapshot.side) ||
    !Number.isSafeInteger(snapshot.orderUpdatedAtMs) ||
    snapshot.orderUpdatedAtMs <= 0 ||
    !Number.isSafeInteger(snapshot.cumulativeQuantity) ||
    snapshot.cumulativeQuantity < 0 ||
    exactCompare(snapshot.cumulativeAmount, '0') < 0
  )
    throw new Error(`[DailyLossTracker] invalid execution history snapshot: ${snapshot.orderId}`);

  if (snapshot.cumulativeQuantity === 0) {
    if (exactCompare(snapshot.cumulativeAmount, '0') !== 0 || snapshot.lastExecutionTimeMs !== null)
      throw new Error(
        `[DailyLossTracker] zero-quantity execution history declares amount or time: ${snapshot.orderId}`,
      );

    return;
  }

  if (
    exactCompare(snapshot.cumulativeAmount, '0') <= 0 ||
    snapshot.lastExecutionTimeMs === null ||
    !Number.isSafeInteger(snapshot.lastExecutionTimeMs) ||
    snapshot.lastExecutionTimeMs <= 0
  )
    throw new Error(
      `[DailyLossTracker] positive execution history lacks amount or execution time: ${snapshot.orderId}`,
    );
}

function addDistinctAmount(amounts: string[], amount: string): void {
  if (!amounts.some((existing) => exactCompare(existing, amount) === 0)) amounts.push(amount);
}

/**
 * 校验同一 revision + 累计数量组内的阶段/T/金额一致性。
 * 同 revision 同量异金额只允许已证明的 OPEN→TERMINAL 收口；phase-null baseline 不得授权修正。
 */
function assertGroupConsistency(
  group: ReadonlyArray<ExecutionHistorySnapshot>,
  finalSnapshot: ExecutionHistorySnapshot | undefined,
): void {
  const first = group[0];
  if (first === undefined) return;

  const executionTimeMs = first.lastExecutionTimeMs;
  for (const snapshot of group) {
    if (snapshot.lastExecutionTimeMs !== executionTimeMs)
      throw new Error(
        `[DailyLossTracker] same revision/quantity execution time conflict: ${snapshot.orderId}`,
      );
  }

  const openAmounts: string[] = [];
  const terminalAmounts: string[] = [];
  const unknownAmounts: string[] = [];
  for (const snapshot of group) {
    if (snapshot.factStage === 'OPEN') addDistinctAmount(openAmounts, snapshot.cumulativeAmount);
    else if (snapshot.factStage === 'TERMINAL')
      addDistinctAmount(terminalAmounts, snapshot.cumulativeAmount);
    else addDistinctAmount(unknownAmounts, snapshot.cumulativeAmount);
  }

  if (openAmounts.length > 1 || terminalAmounts.length > 1)
    throw new Error(
      `[DailyLossTracker] same revision/quantity phase amount conflict: ${first.orderId}`,
    );

  const provenAmounts = [...openAmounts, ...terminalAmounts];
  if (provenAmounts.length === 0) {
    if (unknownAmounts.length > 1)
      throw new Error(
        `[DailyLossTracker] same revision/quantity baseline amount conflict: ${first.orderId}`,
      );
  } else {
    for (const amount of unknownAmounts) {
      if (!provenAmounts.some((proven) => exactCompare(proven, amount) === 0))
        throw new Error(
          `[DailyLossTracker] unknown-phase baseline amount is not anchored: ${first.orderId}`,
        );
    }
  }

  if (
    finalSnapshot !== undefined &&
    group.includes(finalSnapshot) &&
    terminalAmounts.length > 0 &&
    finalSnapshot.factStage === 'OPEN'
  )
    throw new Error(
      `[DailyLossTracker] execution phase regression at final fact: ${first.orderId}`,
    );
}

/**
 * 校验完整历史（可选 final API 事实）的 identity、revision、数量、金额、阶段与执行时间。
 * 所有失败都在任何状态发布前抛出；返回已验证排序的最新快照（空历史返回 undefined），不提交事实。
 */
export function assertExecutionHistory(params: {
  readonly snapshots: ReadonlyArray<ExecutionHistorySnapshot>;
  readonly finalSnapshot?: ExecutionHistorySnapshot;
}): ExecutionHistorySnapshot | undefined {
  const { snapshots, finalSnapshot } = params;
  const all = finalSnapshot === undefined ? [...snapshots] : [...snapshots, finalSnapshot];
  const identity = all[0];
  if (identity === undefined) return undefined;

  for (const snapshot of all) {
    assertSnapshotShape(snapshot);
    if (
      snapshot.orderId !== identity.orderId ||
      snapshot.symbol !== identity.symbol ||
      snapshot.side !== identity.side
    )
      throw new Error(
        `[DailyLossTracker] execution history identity conflict: ${snapshot.orderId}`,
      );
  }

  if (finalSnapshot !== undefined) {
    for (const snapshot of snapshots) {
      if (
        snapshot.orderUpdatedAtMs > finalSnapshot.orderUpdatedAtMs ||
        snapshot.cumulativeQuantity > finalSnapshot.cumulativeQuantity
      )
        throw new Error(
          `[DailyLossTracker] execution progress exceeds current fact: ${snapshot.orderId}`,
        );
    }
  }

  const ordered = [...all].sort(compareExecutionHistorySnapshots);
  const groups: ExecutionHistorySnapshot[][] = [];
  for (const snapshot of ordered) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.[0];
    if (
      previousGroup !== undefined &&
      previous?.orderUpdatedAtMs === snapshot.orderUpdatedAtMs &&
      previous.cumulativeQuantity === snapshot.cumulativeQuantity
    ) {
      previousGroup.push(snapshot);
      continue;
    }

    groups.push([snapshot]);
  }

  let previous: KnownExecutionBaseline | undefined;
  let terminalSeen = false;
  for (const group of groups) {
    if (terminalSeen && group.some((snapshot) => snapshot.factStage === 'OPEN'))
      throw new Error(`[DailyLossTracker] execution history phase regression: ${identity.orderId}`);

    if (group.some((snapshot) => snapshot.factStage === 'TERMINAL')) terminalSeen = true;

    assertGroupConsistency(group, finalSnapshot);
    // null baseline 仅锚定已证明的载荷，不能插入 OPEN/TERMINAL 之间授权阶段修订。
    const proven = group.filter((snapshot) => snapshot.factStage !== null);
    const steps = proven.length > 0 ? proven : group.slice(0, 1);
    for (const snapshot of steps) {
      const current = {
        brokerOrderId: snapshot.orderId,
        symbol: snapshot.symbol,
        side: snapshot.side,
        phase: snapshot.factStage,
        cumulativeQuantity: snapshot.cumulativeQuantity,
        cumulativeAmount: snapshot.cumulativeAmount,
        executionTimeMs: snapshot.lastExecutionTimeMs,
        updatedAtMs: snapshot.orderUpdatedAtMs,
      };
      if (
        previous !== undefined &&
        (current.executionTimeMs ?? 0) < (previous.executionTimeMs ?? 0)
      )
        throw new Error(
          `[DailyLossTracker] execution history execution time regression: ${snapshot.orderId}`,
        );

      if (current.phase !== null) {
        mergeExecutionFact(previous, { ...current, phase: current.phase });
      } else if (previous !== undefined) {
        // V1 未持久化 phase；只有已知阶段观察可传入在线 merge，不能伪造 phase。
        // null-only 历史只验证累计载荷推进，不授权任何同 revision 金额特例。
        if (current.cumulativeQuantity < previous.cumulativeQuantity)
          throw new Error(
            `[DailyLossTracker] execution history quantity regression: ${snapshot.orderId}`,
          );

        if (
          current.cumulativeQuantity > previous.cumulativeQuantity &&
          exactCompare(current.cumulativeAmount, previous.cumulativeAmount) <= 0
        )
          throw new Error(
            `[DailyLossTracker] quantity advance lacks positive amount advance: ${snapshot.orderId}`,
          );
      }

      // 持久化历史允许跨 revision 同量 T 非倒退；在线 merge 的同量保留 T 不重写旧日志。
      previous = current;
    }
  }

  return ordered.at(-1);
}

/**
 * 校验单条历史快照相对最终事实的边界。
 * 回放只校验 identity、数量/revision 上界与同 revision 金额/阶段规则；
 * API 最终事实的 T 是订单驱动代理（= updatedAt）；同 revision/数量的 durable T 一致性与跨快照单调性由启动预检统一校验。
 */
export function assertExecutionSnapshotWithinFinal(params: {
  readonly snapshot: ExecutionHistorySnapshot;
  readonly finalSnapshot: ExecutionHistorySnapshot;
}): void {
  const { snapshot, finalSnapshot } = params;
  assertSnapshotShape(snapshot);
  assertSnapshotShape(finalSnapshot);

  if (
    snapshot.orderId !== finalSnapshot.orderId ||
    snapshot.symbol !== finalSnapshot.symbol ||
    snapshot.side !== finalSnapshot.side
  )
    throw new Error(`[DailyLossTracker] execution history identity conflict: ${snapshot.orderId}`);

  if (
    snapshot.orderUpdatedAtMs > finalSnapshot.orderUpdatedAtMs ||
    snapshot.cumulativeQuantity > finalSnapshot.cumulativeQuantity
  )
    throw new Error(
      `[DailyLossTracker] execution progress exceeds current fact: ${snapshot.orderId}`,
    );

  if (snapshot.cumulativeQuantity !== finalSnapshot.cumulativeQuantity) return;

  // 同量更低 revision 是历史合法修订；同 revision 只校验金额/阶段，T 由启动完整历史校验裁决。
  if (snapshot.orderUpdatedAtMs !== finalSnapshot.orderUpdatedAtMs) return;

  if (snapshot.factStage === finalSnapshot.factStage) {
    if (exactCompare(snapshot.cumulativeAmount, finalSnapshot.cumulativeAmount) !== 0)
      throw new Error(
        `[DailyLossTracker] same revision/quantity/phase amount conflict: ${snapshot.orderId}`,
      );

    return;
  }

  if (snapshot.factStage === 'TERMINAL' && finalSnapshot.factStage === 'OPEN')
    throw new Error(`[DailyLossTracker] execution phase regression: ${snapshot.orderId}`);
}
