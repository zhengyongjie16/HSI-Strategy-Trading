import type { AccountPositionSnapshotReader, SnapshotToken } from '../../types/accountPosition.js';
import type { SettlementReadinessReceipt } from '../../types/settlement.js';

/** settlement owner 私有等待者；只在当前 snapshot 与水位共同有效时签发凭据。 */
export type ReadinessWaiter = {
  readonly resolve: (receipt: SettlementReadinessReceipt) => void;
  readonly reject: (error: Error) => void;
};

/** 业务完成后发布 readiness 水位；普通 snapshot commit 不签发也不撤销完成凭据，消费 snapshot 另行授权。 */
export interface SettlementReadinessGate {
  markStale: () => number;
  markFresh: (version: number, token: SnapshotToken) => boolean;
  waitForFresh: () => Promise<SettlementReadinessReceipt>;
  isCurrent: (receipt: SettlementReadinessReceipt) => boolean;
  abortWaiting: (reason: 'STOP_AND_DRAIN' | 'FATAL_INVARIANT') => void;
  resetAbort: () => void;
  getStatus: () => {
    readonly currentVersion: number;
    readonly staleVersion: number;
    readonly abortReason: 'STOP_AND_DRAIN' | 'FATAL_INVARIANT' | null;
    readonly ready: boolean;
  };
}

/** gate 仅读取 canonical owner，不持有第二份账户或持仓事实。 */
export type SettlementReadinessGateDeps = {
  readonly snapshot: AccountPositionSnapshotReader;
};
