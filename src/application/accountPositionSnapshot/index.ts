/**
 * Canonical account/position snapshot owner。
 * 私有深度不可变 store、单批在途与未发批合并；同步失效先于异步 drain。
 */
import {
  createExternalApiAggregateRequestError,
  isExternalApiRequestError,
} from '../../utils/apiFailure/index.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import type { DiagnosticFields } from '../../types/diagnostics.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type {
  AccountPositionSnapshot,
  AccountPositionSnapshotView,
  SnapshotRefreshHandle,
  SnapshotRefreshRequest,
  SnapshotToken,
} from '../../types/accountPosition.js';
import type { AccountPositionSnapshotDeps, SnapshotBatch, SnapshotParticipant } from './types.js';

/** 所有本地版本递增均证明安全，溢出不能降级成旧版本或 fallback。 */
function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Snapshot revision exceeds safe integer range');
  }

  return value + 1;
}

/** 私有 store 不保留 broker 或调用方可修改的嵌套引用。 */
function immutableAccount(account: AccountSnapshot): AccountSnapshot {
  exactCompare(account.totalCash, '0');
  exactCompare(account.netAssets, '0');
  exactCompare(account.positionValue, '0');
  return Object.freeze({
    ...account,
    cashInfos: Object.freeze(
      account.cashInfos.map((cash) => {
        exactCompare(cash.availableCash, '0');
        return Object.freeze({ ...cash });
      }),
    ),
  });
}

/** 保留全部持仓明细；available lookup 保持原裁剪，不改变成本聚合政策。 */
function immutablePositions(positions: ReadonlyArray<Position>): ReadonlyArray<Position> {
  return Object.freeze(
    positions.map((position) => {
      if (
        !Number.isSafeInteger(position.quantity) ||
        position.quantity < 0 ||
        !Number.isSafeInteger(position.availableQuantity) ||
        position.availableQuantity < 0 ||
        position.availableQuantity > position.quantity
      ) {
        throw new RangeError('Position quantities must be nonnegative safe integers');
      }

      exactCompare(position.costPrice, '0');
      return Object.freeze({ ...position });
    }),
  );
}

/** 离开 pending 时停止当前区间；issued IO 及其 drain 永不计入 pending wait。 */
function stopPendingWait(participant: SnapshotParticipant, atMs: number | null): void {
  if (participant.pendingSinceMs !== null) {
    participant.pendingWaitDurationMs =
      atMs === null || participant.pendingWaitDurationMs === null
        ? null
        : participant.pendingWaitDurationMs + Math.max(0, atMs - participant.pendingSinceMs);
    participant.pendingSinceMs = null;
  }
}

/** 创建唯一事实提交者；同步 commit 不执行业务回调，不等待 settlement ready。 */
export function createAccountPositionSnapshot(
  deps: AccountPositionSnapshotDeps,
): AccountPositionSnapshot {
  const { readPort, scheduler, clock, diagnostics, reportFatalError } = deps;
  if (!Number.isSafeInteger(deps.dayEpoch) || deps.dayEpoch < 0) {
    throw new RangeError('Invalid snapshot day epoch');
  }

  let token: SnapshotToken = Object.freeze({
    dayEpoch: deps.dayEpoch,
    snapshotGeneration: 0,
    commitRevision: 0,
    accountRevision: 0,
    positionRevision: 0,
    pairedRevision: 0,
  });
  let view: AccountPositionSnapshotView = Object.freeze({
    token,
    account: null,
    positions: Object.freeze([]),
    accountInitialized: false,
    positionsInitialized: false,
    accountValid: false,
    positionsValid: false,
  });
  let availablePositions = new Map<string, Position>();
  let pairedToken: SnapshotToken | null = null;
  let admission: 'OPEN' | 'REBUILD' | 'CLOSED' = 'OPEN';
  let pending: ReadonlyArray<SnapshotParticipant> = [];
  let inFlight: SnapshotBatch | null = null;
  let running: Promise<void> | null = null;
  let issuedDrain: Promise<void> | null = null;
  let scheduled = false;
  let clearDrain: Promise<void> | null = null;
  let fatalFailure: Readonly<{ error: unknown }> | null = null;

  /** 诊断依赖失效仅使采样缺失，不进入 fatal、取消或 commit 协议。 */
  function diagnosticTime(): number | null {
    try {
      const nowMs = clock.now().getTime();
      return Number.isFinite(nowMs) ? nowMs : null;
    } catch {
      return null;
    }
  }

  function record(operation: string, fields: DiagnosticFields): void {
    try {
      diagnostics.record(operation, Object.freeze(fields));
    } catch {
      // 即使注入的 observer 违反不抛出契约，诊断也不能覆盖业务结果。
    }
  }

  function recordBatch(
    operation: string,
    batch: SnapshotBatch,
    fields: DiagnosticFields = {},
    snapshotToken: SnapshotToken = batch.token,
  ): void {
    record(operation, {
      sources: batch.sources,
      participantCount: batch.participants.length,
      refreshAccount: batch.refreshAccount,
      refreshPositions: batch.refreshPositions,
      dayEpoch: snapshotToken.dayEpoch,
      snapshotGeneration: snapshotToken.snapshotGeneration,
      snapshotCommitRevision: snapshotToken.commitRevision,
      accountRevision: snapshotToken.accountRevision,
      positionRevision: snapshotToken.positionRevision,
      pairedCommitRevision: snapshotToken.pairedRevision,
      ...fields,
    });
  }

  function enqueue(participant: SnapshotParticipant): void {
    participant.pendingSinceMs = diagnosticTime();
    if (participant.pendingSinceMs === null) participant.pendingWaitDurationMs = null;

    pending = [...pending, participant];
  }

  /** 每个参与者只在最终完成/失败/取消时汇总一次，重排队不重置累计值。 */
  function completePendingWait(participant: SnapshotParticipant, outcome: string): void {
    if (participant.pendingSinceMs !== null) stopPendingWait(participant, diagnosticTime());

    record(DIAGNOSTIC_OPERATIONS.SNAPSHOT_PENDING_WAIT_COMPLETED, {
      source: participant.request.source,
      dayEpoch: participant.request.dayEpoch,
      outcome,
      pendingWaitDurationMs: participant.pendingWaitDurationMs,
    });
  }

  /** 已issued内部错误独立于waiter取消；首错立即报告，drain仍等整个issued批settled。 */
  function reportFatalOnce(error: unknown): void {
    if (fatalFailure === null) {
      fatalFailure = { error };
      reportFatalError(error);
    }
  }

  /** 重建是 lifecycle 独占准入，普通业务不得借关门期间刷新绕过交易屏障。 */
  function isAdmitted(request: SnapshotRefreshRequest): boolean {
    return (
      admission === 'OPEN' || (admission === 'REBUILD' && request.source === 'LIFECYCLE_REBUILD')
    );
  }

  function finish(participant: SnapshotParticipant): void {
    if (!participant.settled) {
      participant.settled = true;
      participant.resolve({ status: 'ABORTED' });
      completePendingWait(participant, 'aborted');
    }
  }

  function publishToken(next: SnapshotToken): void {
    token = Object.freeze(next);
    view = Object.freeze({ ...view, token });
  }

  /** 失效同步生效；已发 IO 不假取消，其结果只能重新排队或丢弃。 */
  function invalidate(): void {
    publishToken({ ...token, snapshotGeneration: increment(token.snapshotGeneration) });
    view = Object.freeze({ ...view, accountValid: false, positionsValid: false });
  }

  /** 每个读取在 rejection 点立即报告内部错误，仍持有到兄弟 IO settled。 */
  function observed<T>(start: () => Promise<T>): Promise<T> {
    return (async () => start())().catch((error: unknown) => {
      if (!isExternalApiRequestError(error)) {
        reportFatalOnce(error);
      }

      throw error;
    });
  }

  /** 全批 preflight 后无 await 提交；paired 任一失败绝不提交半边。 */
  async function execute(batch: SnapshotBatch): Promise<void> {
    const issuedAtMs = diagnosticTime();
    for (const participant of batch.participants) stopPendingWait(participant, issuedAtMs);

    const reads = [
      batch.refreshAccount
        ? observed(async () => immutableAccount(await readPort.getAccountSnapshot()))
        : Promise.resolve(null),
      batch.refreshPositions
        ? observed(async () => immutablePositions(await readPort.getStockPositions()))
        : Promise.resolve(null),
    ] as const;
    recordBatch(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REQUEST_STARTED, batch);
    const [accountResult, positionsResult] = await Promise.allSettled(reads);
    const settledAtMs = diagnosticTime();
    const refreshDurationMs =
      issuedAtMs === null || settledAtMs === null ? null : Math.max(0, settledAtMs - issuedAtMs);
    let completionFields: DiagnosticFields = { outcome: 'failure', failureKind: 'internal' };
    try {
      const failures = [accountResult, positionsResult].filter(
        (result) => result.status === 'rejected',
      );
      const internal = failures.find((result) => !isExternalApiRequestError(result.reason));
      if (internal) {
        for (const participant of batch.participants) {
          if (!participant.settled) {
            participant.settled = true;
            participant.reject(internal.reason);
            completePendingWait(participant, 'failure');
          }
        }

        throw internal.reason;
      }

      // 同日仍有效的外部失败归原refresh owner重试，generation失效不吞掉其失败/退避政策。
      const failure = failures[0];
      if (failure) {
        completionFields = { outcome: 'failure', failureKind: 'external' };
        const error: unknown =
          failures.length === 1
            ? failure.reason
            : createExternalApiAggregateRequestError({
                operation: 'AccountPositionSnapshot.pairedRead',
                attempts: 1,
                causes: failures
                  .map((result): unknown => result.reason)
                  .filter(isExternalApiRequestError),
              });
        for (const participant of batch.participants) {
          if (
            !participant.settled &&
            isAdmitted(participant.request) &&
            participant.request.dayEpoch === token.dayEpoch
          ) {
            participant.settled = true;
            participant.reject(error);
            completePendingWait(participant, 'failure');
          } else if (!participant.settled) {
            finish(participant);
          }
        }

        return;
      }

      const current =
        batch.participants.some((participant) => isAdmitted(participant.request)) &&
        batch.token.dayEpoch === token.dayEpoch &&
        batch.token.snapshotGeneration === token.snapshotGeneration;
      if (!current) {
        let discardReason = 'admission_closed';
        if (batch.token.dayEpoch !== token.dayEpoch) {
          discardReason = 'stale_epoch';
        } else if (batch.token.snapshotGeneration !== token.snapshotGeneration) {
          discardReason = 'stale_generation';
        }

        recordBatch(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_DISCARDED, batch, {
          discardReason,
          discardCount: 1,
          currentDayEpoch: token.dayEpoch,
          currentSnapshotGeneration: token.snapshotGeneration,
        });

        completionFields = { outcome: 'discarded', discardReason };

        for (const participant of batch.participants) {
          if (participant.settled) {
            continue;
          }

          if (isAdmitted(participant.request) && participant.request.dayEpoch === token.dayEpoch) {
            enqueue(participant);
          } else {
            finish(participant);
          }
        }

        return;
      }

      if (!batch.participants.some((participant) => !participant.settled)) {
        completionFields = { outcome: 'aborted' };
        return;
      }

      if (accountResult.status !== 'fulfilled' || positionsResult.status !== 'fulfilled') {
        throw new TypeError('Snapshot read result invariant violated');
      }

      const account =
        batch.refreshAccount && accountResult.value !== null ? accountResult.value : view.account;
      const positions =
        batch.refreshPositions && positionsResult.value !== null
          ? positionsResult.value
          : view.positions;
      const commitRevision = increment(token.commitRevision);
      const nextToken = Object.freeze({
        ...token,
        commitRevision,
        accountRevision: batch.refreshAccount
          ? increment(token.accountRevision)
          : token.accountRevision,
        positionRevision: batch.refreshPositions
          ? increment(token.positionRevision)
          : token.positionRevision,
        pairedRevision:
          batch.refreshAccount && batch.refreshPositions ? commitRevision : token.pairedRevision,
      });
      const nextAvailable = new Map<string, Position>();
      for (const position of positions) {
        if (position.symbol.length > 0 && position.availableQuantity > 0) {
          nextAvailable.set(position.symbol, position);
        }
      }

      token = nextToken;
      if (batch.refreshAccount && batch.refreshPositions) pairedToken = nextToken;

      view = Object.freeze({
        token,
        account,
        positions,
        accountInitialized: batch.refreshAccount || view.accountInitialized,
        positionsInitialized: batch.refreshPositions || view.positionsInitialized,
        accountValid: batch.refreshAccount || view.accountValid,
        positionsValid: batch.refreshPositions || view.positionsValid,
      });
      availablePositions = nextAvailable;
      const receipt = Object.freeze({
        status: 'COMMITTED' as const,
        snapshotToken: token,
        refreshedAccount: batch.refreshAccount,
        refreshedPositions: batch.refreshPositions,
        view,
      });
      const committedParticipants = batch.participants.filter(
        (participant) => !participant.settled,
      );
      for (const participant of committedParticipants) {
        participant.settled = true;
        participant.resolve(receipt);
      }

      // 诊断只在同步事实/receipt 事务完成后发出，不穿插 store、索引与参与者结算。
      completionFields = { outcome: 'success' };
      recordBatch(DIAGNOSTIC_OPERATIONS.SNAPSHOT_RESPONSE_ACCEPTED, batch);
      recordBatch(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED, batch, {}, nextToken);
      for (const participant of committedParticipants)
        completePendingWait(participant, 'committed');
    } finally {
      recordBatch(DIAGNOSTIC_OPERATIONS.SNAPSHOT_REFRESH_COMPLETED, batch, {
        ...completionFields,
        refreshDurationMs,
      });
    }
  }

  /** 单 pump 持有所有已发 IO；新需求只合并 pending，不附着已发批次。 */
  async function pump(): Promise<void> {
    while (admission !== 'CLOSED' && pending.length > 0) {
      const participants = pending.filter(
        (participant) => !participant.settled && isAdmitted(participant.request),
      );
      pending = [];
      if (participants.length === 0) {
        continue;
      }

      const batch: SnapshotBatch = {
        participants,
        refreshAccount: participants.some((participant) => participant.request.refreshAccount),
        refreshPositions: participants.some((participant) => participant.request.refreshPositions),
        token,
        sources: Object.freeze([
          ...new Set(participants.map((participant) => participant.request.source)),
        ]),
      };
      inFlight = batch;
      let finishIssued!: () => void;
      let rejectIssued!: (error: unknown) => void;
      // 在发IO前建立真实批settled身份；drain错误通道与已取消waiter结果独立。
      issuedDrain = new Promise<void>((resolve, reject) => {
        finishIssued = resolve;
        rejectIssued = reject;
      });
      void issuedDrain.catch(reportFatalOnce);
      try {
        await execute(batch);
      } catch (error) {
        reportFatalOnce(error);
        rejectIssued(error);
        admission = 'CLOSED';
        for (const participant of pending) finish(participant);

        pending = [];
        for (const participant of participants) {
          if (!participant.settled) {
            participant.settled = true;
            participant.reject(error);
            completePendingWait(participant, 'failure');
          }
        }
      } finally {
        inFlight = null;
        issuedDrain = null;
        finishIssued();
      }
    }
  }

  function schedule(): void {
    if (scheduled || running !== null) {
      return;
    }

    scheduled = true;
    scheduler.schedule(() => {
      scheduled = false;
      running = pump().finally(() => {
        running = null;
        if (admission !== 'CLOSED' && pending.length > 0) {
          schedule();
        }
      });
    });
  }

  function requestRefresh(request: SnapshotRefreshRequest): SnapshotRefreshHandle {
    if (!request.refreshAccount && !request.refreshPositions) {
      throw new TypeError('Snapshot refresh must request at least one component');
    }

    let participant: SnapshotParticipant;
    const result = new Promise<Awaited<SnapshotRefreshHandle['result']>>((resolve, reject) => {
      participant = {
        request: Object.freeze({ ...request }),
        resolve,
        reject,
        settled: false,
        pendingSinceMs: null,
        pendingWaitDurationMs: 0,
      };

      if (!isAdmitted(request) || request.dayEpoch !== token.dayEpoch) {
        finish(participant);
        return;
      }

      enqueue(participant);
      schedule();
    });
    return {
      result,
      cancel: () => {
        finish(participant);
      },
      cancelIfNotIssued: () => {
        if (inFlight?.participants.includes(participant)) return;

        finish(participant);
      },
    };
  }

  /** 捕获本时点真实issued批；无在途时仍保留已issued首个内部fault，不等待后继pending。 */
  async function waitForIssuedDrain(): Promise<void> {
    if (issuedDrain !== null) await issuedDrain;
    else if (fatalFailure !== null) throw fatalFailure.error;
  }

  return {
    getView: () => view,
    getAvailablePosition: (symbol) =>
      view.positionsValid ? (availablePositions.get(symbol) ?? null) : null,
    getStatus: () =>
      Object.freeze({
        admission,
        inFlight: inFlight !== null,
        pending: pending.some((participant) => !participant.settled),
        token,
      }),
    isCurrent: (candidate, components) =>
      candidate.dayEpoch === token.dayEpoch &&
      candidate.snapshotGeneration === token.snapshotGeneration &&
      (!components.account ||
        (view.accountValid && candidate.accountRevision === token.accountRevision)) &&
      (!components.positions ||
        (view.positionsValid && candidate.positionRevision === token.positionRevision)) &&
      (!components.paired ||
        (view.accountValid &&
          view.positionsValid &&
          pairedToken !== null &&
          candidate.pairedRevision === pairedToken.pairedRevision &&
          token.pairedRevision === pairedToken.pairedRevision &&
          token.dayEpoch === pairedToken.dayEpoch &&
          token.snapshotGeneration === pairedToken.snapshotGeneration &&
          candidate.accountRevision === pairedToken.accountRevision &&
          candidate.positionRevision === pairedToken.positionRevision &&
          token.accountRevision === pairedToken.accountRevision &&
          token.positionRevision === pairedToken.positionRevision)),

    requestRefresh,
    invalidate,
    invalidateAccount: () => {
      publishToken({ ...token, snapshotGeneration: increment(token.snapshotGeneration) });
      view = Object.freeze({ ...view, accountValid: false });
    },
    waitForIssuedDrain,
    beginRebuild: () => {
      admission = 'REBUILD';
      clearDrain = null;
      invalidate();
      for (const participant of [...pending, ...(inFlight?.participants ?? [])]) {
        if (!isAdmitted(participant.request)) finish(participant);
      }

      pending = pending.filter((participant) => !participant.settled);
    },
    openAdmission: () => {
      admission = 'OPEN';
      clearDrain = null;
      schedule();
    },
    requestClear: (request) => {
      if (
        !Number.isSafeInteger(request.dayEpoch) ||
        request.dayEpoch < token.dayEpoch ||
        (request.reason === 'STOP' && request.dayEpoch !== token.dayEpoch)
      ) {
        throw new RangeError('Invalid snapshot clear epoch');
      }

      if (admission === 'CLOSED' && request.dayEpoch === token.dayEpoch) {
        return clearDrain ?? waitForIssuedDrain();
      }

      const nextGeneration = increment(token.snapshotGeneration);
      admission = 'CLOSED';
      publishToken({ ...token, dayEpoch: request.dayEpoch, snapshotGeneration: nextGeneration });
      for (const participant of pending) {
        finish(participant);
      }

      for (const participant of inFlight?.participants ?? []) {
        finish(participant);
      }

      pending = [];
      availablePositions = new Map();
      view = Object.freeze({
        token,
        account: null,
        positions: Object.freeze([]),
        accountInitialized: false,
        positionsInitialized: false,
        accountValid: false,
        positionsValid: false,
      });
      pairedToken = null;
      clearDrain = waitForIssuedDrain();
      return clearDrain;
    },
  };
}
