import type { OrderRecord } from './services.js';

/** 订单归属；解析来自 broker remark 与唯一监控标的映射，不由本地 ID 推造。 */
export type OrderOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
};

/** 同一 broker 订单的累计权威事实；成交时间与 broker revision 必须独立保留。 */
export type BrokerOrderExecutionFact = {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly executionTimeMs: number | null;
  readonly updatedAtMs: number;
  readonly phase: 'OPEN' | 'TERMINAL';
};

/** 已由SDK mapper验证的累计观察最小输入；不携带未消费的SDK side/status/orderType。 */
export type OrderExecutionTimeObservation = {
  readonly orderId: string;
  readonly symbol: string;
  readonly executionSide: 'BUY' | 'SELL';
  readonly executedQuantity: number;
  readonly executedAmount: string;
  readonly executionTimeMs: number | null;
  readonly updatedAtMs: number;
  readonly executionPhase: 'OPEN' | 'TERMINAL';
};

/** 成本投影/重建只消费已验证累计事实与原提交时间，不读取SDK订单元数据。 */
export type OrderExecutionRecordObservation = OrderExecutionTimeObservation &
  Readonly<{ submittedAt: Date }>;

/** 从已成功提交事实或 durable progress/baseline 提供的可信执行时间证据，revision 独立保存。 */
export type OrderExecutionTimeEvidence = {
  readonly brokerOrderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderRevisionMs: number;

  /** V1 boundary baseline 未持久化 phase，显式未知；不得补造 OPEN/TERMINAL。 */
  readonly phase: 'OPEN' | 'TERMINAL' | null;
};

/** 同步成交准入；封存/非当日抑制与已准入事实的纯重复明确区分，重复仍允许首次经济投影。 */
export type OrderExecutionAdmission = 'ADMITTED' | 'DUPLICATE' | 'SUPPRESSED';

/** 成功提交订单事实的收据；冲突/无归属/过期必须在成功路径之外处理。 */
export type OrderFactCommitReceipt = {
  readonly brokerOrderId: string;
  readonly authoritativeFactChanged: boolean;
  readonly executionAdvanced: boolean;
  readonly economicProjectionChanged: boolean;
};

/** 成本计算保留金额和经证明的安全整数数量，不将舍入均价回写金融状态。 */
export type OrderCostBasis = {
  readonly costAmount: string;
  readonly quantity: number;
};

/** 同一 API batch 的投影对象，调用前必须完成全部标的归属与 token 预检。 */
export type OrderProjectionTarget = {
  readonly symbol: string;
  readonly isLongSymbol: boolean;
};

/** 原子 batch 的外部结果；过期只返回 ABORTED，绝不返回成功事实 receipt。 */
export type OrderFactBatchCommitResult =
  | { readonly status: 'COMMITTED'; readonly receipts: ReadonlyArray<OrderFactCommitReceipt> }
  | { readonly status: 'ABORTED' };

/** 订单过滤引擎；按成本金额/数量 cross product 排序并整笔消除。 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm: (
    allBuyOrders: ReadonlyArray<OrderRecord>,
    executedSellOrders: ReadonlyArray<OrderRecord>,
  ) => ReadonlyArray<OrderRecord>;
}
