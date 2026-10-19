import type { SnapshotToken } from './accountPosition.js';

/**
 * 成交后业务就绪凭据；由 settlement owner 在全部派生投影与完成事务提交后签发。
 * snapshotToken 只证明对应 canonical 事实，settlementVersion 单独标识刷新需求水位。
 */
export type SettlementReadinessReceipt = {
  readonly snapshotToken: SnapshotToken;
  readonly settlementVersion: number;
};

/** 生命周期中断或内部不变量失败；消费者只按明确原因取消原等待，不吞掉其他失败。 */
export type SettlementReadinessAbortReason = 'STOP_AND_DRAIN' | 'FATAL_INVARIANT';

/** 成交后 owner 的可观察调度状态；不暴露内部刷新队列或可变业务事实。 */
export type PostTradeSettlementStatus = {
  readonly started: boolean;
  readonly currentVersion: number;
  readonly staleVersion: number;
};

/** 恢复时已封存的 canonical 事实和未终结保护性卖单方向；不接受 loader 提供的完成结论。 */
export type SettlementProtectionRecoveryRequest = {
  readonly snapshotToken: SnapshotToken;
  readonly pendingProtectiveDirections: ReadonlySet<'LONG' | 'SHORT'>;
};

/** 同一 settlement owner 的同步 crash-gap 收口能力；冷却随后由 durable log hydrate，避免重复触发。 */
export interface SettlementProtectionRecovery {
  readonly completeProtectionRecovery: (request: SettlementProtectionRecoveryRequest) => boolean;
}

/** 成交后账户/持仓刷新需求；真实订单事实成功提交的同一同步段登记。 */
export type SettlementRefreshNeed = {
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
};

/** 成交后业务就绪读取能力；等待完成后仍须在派生发布或执行前复核凭据。 */
export interface SettlementFreshnessReader {
  readonly waitForFresh: () => Promise<SettlementReadinessReceipt>;
  readonly isCurrent: (receipt: SettlementReadinessReceipt) => boolean;
  readonly onFreshReached: (listener: () => void) => () => void;
}

/** 订单事实提交方使用的窄刷新登记能力，不混入席位身份或全局生命周期控制。 */
export interface SettlementRefreshNeedRecorder {
  readonly recordSettlementRefreshNeed: (need: SettlementRefreshNeed) => void;
}
