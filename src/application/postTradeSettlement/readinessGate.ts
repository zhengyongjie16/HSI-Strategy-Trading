/**
 * 成交后业务就绪门禁
 * pending settlement 按当前 canonical token 签发完成水位；完成凭据不是未来 snapshot revision 的租约。
 */
import type { SnapshotToken } from '../../types/accountPosition.js';
import type {
  SettlementReadinessAbortReason,
  SettlementReadinessReceipt,
} from '../../types/settlement.js';
import type {
  ReadinessWaiter,
  SettlementReadinessGate,
  SettlementReadinessGateDeps,
} from './types.js';

/** 为所有等待中断入口统一构造原因，避免消费者依赖旧门禁实现。 */
function formatAbortErrorMessage(reason: SettlementReadinessAbortReason): string {
  return `[postTradeConsistencyRuntime] freshness wait aborted: ${reason}`;
}

/** 构造正式 settlement readiness 中断错误；已等待和后续等待采用相同语义。 */
function createAbortError(reason: SettlementReadinessAbortReason): Error {
  return new Error(formatAbortErrorMessage(reason));
}

/** 判断是否为正式 readiness 中断；指定原因时只匹配该原因，不误吞 fatal 或外部错误。 */
export function isSettlementReadinessAbortError(
  error: unknown,
  reason?: SettlementReadinessAbortReason,
): boolean {
  if (!(error instanceof Error)) return false;

  return reason === undefined
    ? error.message === formatAbortErrorMessage('STOP_AND_DRAIN') ||
        error.message === formatAbortErrorMessage('FATAL_INVARIANT')
    : error.message === formatAbortErrorMessage(reason);
}

/** 创建独占 settlement 水位的门禁；不复制 snapshot 财务账。 */
export function createSettlementReadinessGate(
  deps: SettlementReadinessGateDeps,
): SettlementReadinessGate {
  let currentVersion = 0;
  let staleVersion = 0;
  let abortReason: SettlementReadinessAbortReason | null = null;
  let receipt: SettlementReadinessReceipt | null = null;
  let waiters: ReadinessWaiter[] = [];

  /** 完成凭据只随 epoch/generation 或 settlement 水位失效；消费 owner 独立复核选单 snapshot。 */
  function isCurrent(candidate: SettlementReadinessReceipt): boolean {
    return (
      receipt !== null &&
      abortReason === null &&
      candidate.settlementVersion === staleVersion &&
      currentVersion === staleVersion &&
      deps.snapshot.isCurrent(candidate.snapshotToken, {
        account: false,
        positions: false,
      })
    );
  }

  function markStale(): number {
    if (abortReason === 'FATAL_INVARIANT') {
      throw new Error('[settlementReadiness] cannot mark stale after fatal invariant');
    }

    if (!Number.isSafeInteger(staleVersion) || staleVersion === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('[settlementReadiness] settlement version exceeds safe integer range');
    }

    staleVersion += 1;
    receipt = null;
    return staleVersion;
  }

  /** 最终检查与签发在同一同步段，旧水位不得发布 completion 或 fresh。 */
  function markFresh(version: number, token: SnapshotToken): boolean {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new RangeError('[settlementReadiness] invalid settlement version');
    }

    if (
      abortReason !== null ||
      version !== staleVersion ||
      !deps.snapshot.isCurrent(token, { account: true, positions: true, paired: true })
    )
      return false;

    const view = deps.snapshot.getView();
    if (
      !view.accountInitialized ||
      !view.positionsInitialized ||
      !view.accountValid ||
      !view.positionsValid
    )
      return false;

    currentVersion = version;
    receipt = Object.freeze({ snapshotToken: token, settlementVersion: version, ready: true });
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.resolve(receipt);

    return true;
  }

  function waitForFresh(): Promise<SettlementReadinessReceipt> {
    if (abortReason !== null) return Promise.reject(createAbortError(abortReason));

    if (receipt !== null && isCurrent(receipt)) return Promise.resolve(receipt);

    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  /** 生命周期 consumer drain 前同步取消等待，不等待自身刷新。 */
  function abortWaiting(reason: SettlementReadinessAbortReason): void {
    abortReason = reason;
    receipt = null;
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter.reject(createAbortError(reason));
  }

  return {
    markStale,
    markFresh,
    waitForFresh,
    isCurrent,
    abortWaiting,
    resetAbort: () => {
      abortReason = null;
    },
    getStatus: () => ({
      currentVersion,
      staleVersion,
      abortReason,
      ready: receipt !== null && isCurrent(receipt),
    }),
  };
}
