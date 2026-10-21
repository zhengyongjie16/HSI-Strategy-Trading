import type { OrderSnapshotReadPort } from '../../../../src/types/orderSnapshotReadPorts.js';
import type { createBrokerIngressFixture } from './brokerIngressFixture.js';

/** 快照 adapter 定向测试的虚拟时间控制，不改变生产 retry 或共享 limiter 机制。 */
export type OrderSnapshotTimerHarness = {
  readonly nowMs: () => number;
  readonly pendingDelays: () => ReadonlyArray<number>;
  readonly advanceBy: (delayMs: number) => Promise<void>;
  readonly restore: () => void;
};

/** 同一离线 broker 的真实 port 与 native reply 控制；无 SDK DTO 越过 infra 测试边界。 */
export type OrderSnapshotReadFixture = {
  readonly native: Awaited<ReturnType<typeof createBrokerIngressFixture>>;
  readonly port: OrderSnapshotReadPort;
};

/** pending/snapshot 共享的中性元数据损坏控制，仅在 native 回复阶段转换为原始 SDK 字段。 */
export type OrderSnapshotMetadataControl = {
  readonly field: 'side' | 'status' | 'orderType';
  readonly kind: 'UNKNOWN' | 'NON_MEMBER' | 'MISSING';
};
