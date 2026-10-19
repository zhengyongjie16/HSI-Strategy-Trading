import type {
  SnapshotReadPort,
  SnapshotRefreshReceipt,
  SnapshotRefreshRequest,
  SnapshotToken,
} from '../../types/accountPosition.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { RuntimeClock } from '../../types/runtime.js';

/** 只安排 owner pump 的注入调度能力；不创建第二个 runtime 或全局调度器。 */
interface SnapshotPumpScheduler {
  readonly schedule: (callback: () => void) => void;
}

/** Snapshot owner 的外部依赖；broker、pump 与被动诊断均由 composition 显式注入。 */
export type AccountPositionSnapshotDeps = {
  readonly readPort: SnapshotReadPort;
  readonly scheduler: SnapshotPumpScheduler;
  readonly clock: RuntimeClock;
  readonly diagnostics: DiagnosticObserver;
  readonly reportFatalError: (error: unknown) => void;
  readonly dayEpoch: number;
};

/** 每个请求独立完成/取消，已发批次不再接纳新的参与者。 */
export type SnapshotParticipant = {
  readonly request: SnapshotRefreshRequest;
  readonly resolve: (receipt: SnapshotRefreshReceipt) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;

  /** 仅 pending 区间持有起点；issue 后清空，requeue 重新开始。 */
  pendingSinceMs: number | null;

  /** 跨 requeue 累加真实排队时间；时钟不可读时标记未知，不影响参与者结果。 */
  pendingWaitDurationMs: number | null;
};

/** 私有 pending/in-flight 批次；issue 时冻结 token 与字段并集。 */
export type SnapshotBatch = {
  readonly participants: ReadonlyArray<SnapshotParticipant>;
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
  readonly token: SnapshotToken;
  readonly sources: ReadonlyArray<string>;
};
