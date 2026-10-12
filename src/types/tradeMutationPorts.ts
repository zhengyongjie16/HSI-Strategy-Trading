import type { OrderTypeConfig } from './signal.js';

/**
 * 窄下单命令：来自原最终报价与授权后的提交段，仅包含当前实际使用的字段。
 * 价格保持金融文本；数量由调用方证明为正安全整数，IO 边界再次校验。
 * LO/ELO 必须携带 submittedPrice，MO 必须省略；不添加渠道、目的或订单类型默认值。
 * 使用范围：orderExecutor、orderMonitor 与 Longbridge mutation adapter。
 */
export type TradeSubmitCommand = Readonly<{
  symbol: string;
  side: 'BUY' | 'SELL';
  timeInForce: 'DAY';
  submittedQuantity: number;
  remark?: string;
}> &
  (
    | Readonly<{
        orderType: Exclude<OrderTypeConfig, 'MO'>;
        submittedPrice: string;
      }>
    | Readonly<{
        orderType: 'MO';
        submittedPrice?: never;
      }>
  );

/**
 * 窄改单命令：来自原 OrderOps 的最终同步授权段，不承载 SDK 对象。
 * 数量为已证明的正安全整数；价格为精确文本，不提供金融 number 兼容入口。
 * 使用范围：orderMonitor 与 Longbridge mutation adapter。
 */
export type TradeReplaceCommand = Readonly<{
  orderId: string;
  quantity: number;
  price: string;
}>;

/**
 * broker 返回的真实下单身份，不暴露 SDK response 或金融对象。
 * 数据来源：TradeContext.submitOrder 的 orderId，禁止伪造或默认身份。
 * 使用范围：原提交成功、追踪与本地同步链路。
 */
export type TradeSubmitResult = Readonly<{
  orderId: string;
}>;

/**
 * 下单/改单/撤单窄 IO 能力，使用与原查询、推送相同的 TradeContext。
 * 序列化与容量校验发生在远程调用前；内部/SDK 错误原样传播，不自行重试。
 * 不拥有交易授权、mutation permit 或 query，也不创建 SDK context。
 * 使用范围：app 装配、trader 依赖注入及原 mutation 调用链。
 */
export interface TradeMutationPort {
  readonly cancelOrder: (orderId: string) => Promise<void>;
  readonly submitOrder: (
    command: TradeSubmitCommand,
    onRemoteIssued: () => void,
  ) => Promise<TradeSubmitResult>;
  readonly replaceOrder: (
    command: TradeReplaceCommand,
    onRemoteIssued: () => void,
  ) => Promise<void>;
}
