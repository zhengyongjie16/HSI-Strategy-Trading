/** adapter已验证的执行流水，中性价格原文和安全整数数量不含SDK类型。 */
export type OrderExecutionLedgerFact = Readonly<{
  orderId: string;
  tradeId: string;
  symbol: string;
  quantity: number;
  price: string;
  tradeDoneAtMs: number;
}>;

/** 实际执行流水读取能力；错误分类、原授权、限流和重试仍归原调用owner。 */
export interface OrderExecutionLedgerPort {
  readonly todayExecutions: (
    params?: Readonly<{ orderId?: string }>,
  ) => Promise<ReadonlyArray<OrderExecutionLedgerFact>>;
  readonly historyExecutions: (
    params: Readonly<{ symbol?: string; endAt: Date }>,
  ) => Promise<ReadonlyArray<OrderExecutionLedgerFact>>;
}
