import type { SnapshotToken } from './accountPosition.js';

/**
 * 成交后业务就绪凭据；由 settlement owner 在全部派生投影与完成事务提交后签发。
 * snapshotToken 只证明对应 canonical 事实，settlementVersion 单独标识刷新需求水位。
 */
export type SettlementReadinessReceipt = {
  readonly snapshotToken: SnapshotToken;
  readonly settlementVersion: number;
  readonly ready: true;
};

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
