import type { OrderTypeConfig } from './signal.js';

/** 新订单命令的执行目的；只描述本次需求，不能覆盖被修改旧单的 protective 身份。 */
export type OrderCommandPurpose =
  | 'ORDINARY_BUY'
  | 'ORDINARY_SELL'
  | 'SWITCH_MOVE'
  | 'SWITCH_REBUY'
  | 'PROTECTIVE_LIQUIDATION'
  | 'STATIC_DISTANCE_LIQUIDATION'
  | 'DOOMSDAY_CLEARANCE';

/**
 * 最终授权后的中性下单命令。价格保持精确金融文本，数量须为正安全整数。
 * LO/ELO 必须携带 submittedPrice，MO 必须省略；purpose 不参与 broker 金融序列化。
 */
export type TradeSubmitCommand = Readonly<{
  symbol: string;
  side: 'BUY' | 'SELL';
  purpose: OrderCommandPurpose;
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

/** 最终授权后的中性改单命令；不改变旧 orderId 的归属、remark 或 protective 身份。 */
export type TradeReplaceCommand = Readonly<{
  orderId: string;
  quantity: number;
  price: string;
}>;

/** adapter 单次远程请求的事实元数据；operation 保留真实 SDK method 名。 */
export type TradeMutationOperation =
  'TradeContext.submitOrder' | 'TradeContext.replaceOrder' | 'TradeContext.cancelOrder';

/** adapter 单次远程请求的事实元数据；未发出的 preflight 不进入此协议。 */
type TradeMutationObservation<TOperation extends TradeMutationOperation> = {
  readonly operation: TOperation;
  readonly requestAttempted: true;
};

/** 单次请求失败的原始证据；SDK 文本/字段只由 adapter 解析，业务方只读取标签。 */
type TradeMutationFailure = {
  readonly code: string | null;
  readonly cause: unknown;
};

/** 下单结果；UNKNOWN 即使带网络原因也不允许重提，ACCEPTED 保留真实 broker orderId。 */
export type TradeSubmitResult = TradeMutationObservation<'TradeContext.submitOrder'> &
  (
    | { readonly kind: 'ACCEPTED'; readonly orderId: string }
    | ({ readonly kind: 'REJECTED' } & TradeMutationFailure)
    | ({ readonly kind: 'UNKNOWN' } & TradeMutationFailure)
  );

/**
 * 改单单次请求结果。602012/602013 为明确拒绝的中性原因；退避与权威查询仍由 tracking owner 推进。
 * ORDER_ALREADY_CLOSED 只是 broker 响应，不能当成已结算权威终态。
 */
export type TradeReplaceResult = TradeMutationObservation<'TradeContext.replaceOrder'> &
  (
    | { readonly kind: 'ACKNOWLEDGED' }
    | ({
        readonly kind: 'REJECTED';
        readonly reason: 'UNSUPPORTED_BY_TYPE' | 'TEMP_BLOCKED_BY_STATUS';
      } & TradeMutationFailure)
    | ({ readonly kind: 'ORDER_ALREADY_CLOSED' } & TradeMutationFailure)
    | ({ readonly kind: 'RETRYABLE_EXTERNAL_ERROR' } & TradeMutationFailure)
    | ({ readonly kind: 'UNKNOWN' } & TradeMutationFailure)
  );

/**
 * 撤单单次请求结果。ACKNOWLEDGED 不等于 canceled；错误码只能要求原 tracking 查询，不能伪造终态 fact。
 * ALREADY_CLOSED(权威事实) 与 CANCEL_NOT_STARTED 分别由 tracking 查询/结算及 preflight owner 返回。
 */
export type TradeCancelResult = TradeMutationObservation<'TradeContext.cancelOrder'> &
  (
    | { readonly kind: 'ACKNOWLEDGED' }
    | ({ readonly kind: 'STATE_CONFIRMATION_REQUIRED' } & TradeMutationFailure)
    | ({ readonly kind: 'RETRYABLE_EXTERNAL_ERROR' } & TradeMutationFailure)
    | ({ readonly kind: 'UNKNOWN' } & TradeMutationFailure)
  );

/** 未确认 mutation 的致命错误；非 ExternalApiRequestError，保留原请求证据且不触发外部重评估。 */
export type TradeMutationUnknownError = Error & {
  readonly name: 'TradeMutationUnknownError';
  readonly operation: TradeMutationOperation;
  readonly requestAttempted: true;
  readonly code: string | null;
  readonly cause: unknown;
};

/** broker 已接受后的本地同步失败；保留 orderId 与 cause，禁止把同一命令当作未提交重提。 */
export type AcceptedOrderLocalSyncError = Error & {
  readonly name: 'AcceptedOrderLocalSyncError';
  readonly operation: 'TradeContext.submitOrder';
  readonly requestAttempted: true;
  readonly orderId: string;
  readonly cause: unknown;
};

/**
 * submit/replace/cancel 的单次中性 IO 能力。adapter 负责序列化和 SDK 错误分类，不拥有授权、query 或 retry。
 * 预提交内部契约/序列化与 onRemoteIssued 错误原样抛出；只有实际请求发出后才返回 result。
 */
export interface TradeMutationPort {
  readonly cancelOrder: (orderId: string) => Promise<TradeCancelResult>;
  readonly submitOrder: (
    command: TradeSubmitCommand,
    onRemoteIssued: () => void,
  ) => Promise<TradeSubmitResult>;
  readonly replaceOrder: (
    command: TradeReplaceCommand,
    onRemoteIssued: () => void,
  ) => Promise<TradeReplaceResult>;
}
