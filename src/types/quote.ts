/**
 * 行情数据。
 * 类型用途：单标的实时行情快照，作为 getQuotes 返回值、策略与风控的行情入参。
 * 数据来源：Longbridge 行情推送或 getQuotes。
 * 使用范围：行情客户端、策略、风控、订单监控等；全项目可引用。
 */
export type Quote = {
  /** 标的代码 */
  readonly symbol: string;

  /** 标的名称 */
  readonly name: string | null;

  /** 当前价格 */
  readonly price: number;

  /** 前收盘价 */
  readonly prevClose: number;

  /** 行情时间戳 */
  readonly timestamp: number;

  /** 每手股数 */
  readonly lotSize?: number;
};
