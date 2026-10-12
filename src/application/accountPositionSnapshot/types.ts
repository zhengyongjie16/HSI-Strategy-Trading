import type {
  SnapshotReadPort,
  SnapshotRefreshReceipt,
  SnapshotRefreshRequest,
  SnapshotToken,
} from '../../types/accountPosition.js';

/** 只安排 owner pump 的注入调度能力；不创建第二个 runtime 或全局调度器。 */
export interface SnapshotPumpScheduler {
  readonly schedule: (callback: () => void) => void;
}

/** Snapshot owner 的外部依赖，broker 与 pump 调度均由 composition 显式注入。 */
export type AccountPositionSnapshotDeps = {
  readonly readPort: SnapshotReadPort;
  readonly scheduler: SnapshotPumpScheduler;
  readonly reportFatalError: (error: unknown) => void;
  readonly dayEpoch: number;
};

/** 每个请求独立完成/取消，已发批次不再接纳新的参与者。 */
export type SnapshotParticipant = {
  readonly request: SnapshotRefreshRequest;
  readonly resolve: (receipt: SnapshotRefreshReceipt) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
};

/** 私有 pending/in-flight 批次；issue 时冻结 token 与字段并集。 */
export type SnapshotBatch = {
  readonly participants: ReadonlyArray<SnapshotParticipant>;
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
  readonly token: SnapshotToken;
};
