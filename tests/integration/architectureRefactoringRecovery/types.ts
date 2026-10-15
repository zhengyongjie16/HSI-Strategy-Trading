import type { OrderFact } from '../../../src/types/trade.js';

/** 脱敏订单文本：日期使用固定 ISO 文本，SDK 无关金融字段保留原始字符串。 */
export type OfflineOrder = Omit<
  OrderFact,
  | 'submittedAt'
  | 'updatedAt'
  | 'updatedAtMs'
  | 'executionTimeMs'
  | 'executedAmount'
  | 'quantity'
  | 'executedQuantity'
> & {
  readonly quantity: string;
  readonly executedQuantity: string;
  readonly submittedAt: string;
  readonly updatedAt: string;
};

/** 人工核算 oracle 与模拟权威输入；不得从被测 tracker 反向生成期望。 */
export type OfflineRecoveryFixture = {
  readonly dayKey: string;
  readonly now: string;
  readonly boundaryMs: number;
  readonly revisionMs: number;
  readonly orders: ReadonlyArray<OfflineOrder>;
  readonly oracle: {
    readonly initialLoss: number;
    readonly segmentLoss: number;
    readonly cooldownRemainingMs: number;
  };
};
