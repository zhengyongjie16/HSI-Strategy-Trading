import type { OrderReadStatus, OrderReadType } from './orderReadMetadata.js';

/**
 * broker 已映射的中性订单事实，供查询、push、恢复和经济投影共同消费。
 * 数据来源：trade adapter 的 SDK DTO 映射；正成交以订单自身 updatedAt 作为执行时间代理（T），零成交为 null。
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

  /** SDK 累计成交均价原文 × 累计安全整数数量；正成交缺价时显式 null，不伪造成 0。 */
  readonly executedAmount: string | null;

  /**
   * 原始订单观察时间代理：正成交取订单原始 updatedAt，零成交显式为 null。
   * 这只是订单级观察时间，不是逐笔 execution 时间。
   */
  readonly executionTimeMs: number | null;

  /** 独立 broker 修订时间，零成交初始事实才允许采用其真实提交时间。 */
  readonly updatedAtMs: number;
  readonly submittedAt: Date;
  readonly updatedAt: Date | null;
};
