import type { OrderReadStatus, OrderReadType } from './orderReadMetadata.js';

/**
 * broker 已映射的中性订单事实，供查询、push、恢复和经济投影共同消费。
 * 数据来源：trade adapter 的 SDK DTO 映射及同一订单的可信 execution/durable 时间证据。
 * 金融字段保持精确十进制文本；数量仅在证明为非负安全整数后使用 number。
 * 本契约不拥有订单账、归属判定或结算副作用，也不承诺已消费该累计事实。
 */
export type OrderFact = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly executionSide: 'BUY' | 'SELL';
  readonly executionStatus: 'NONE' | 'PARTIAL' | 'FILLED';
  readonly executionPhase: 'OPEN' | 'TERMINAL';
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;

  /** broker 原始归属证据，保留 protective 标记；不得被新命令目的覆盖或补造。 */
  readonly remark?: string | null;
  readonly price: string | null;
  readonly quantity: number;
  readonly executedPrice: string | null;
  readonly executedQuantity: number;

  /** SDK 累计成交均价原文 × 累计安全整数数量，非显示均价回乘。 */
  readonly executedAmount: string;

  /** 真实 execution 流水或匹配 durable 证据；未知时显式 null，不借用 broker revision。 */
  readonly executionTimeMs: number | null;

  /** 独立 broker 修订时间，零成交初始事实才允许采用其真实提交时间。 */
  readonly updatedAtMs: number;
  readonly submittedAt: Date;
  readonly updatedAt: Date | null;
};
