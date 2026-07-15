import type { OrderStatus } from 'longbridge';

/**
 * 批量信号执行结果。
 * 类型用途：以唯一订单 ID 列表表达真正发生的提交或 broker 已确认改单，避免数量与 ID 双真相分叉。
 * 数据来源：OrderExecutor 对每个信号的 SUBMITTED/REPLACED 动作结果汇总。
 * 使用范围：Trader.executeSignals 及清仓、换标等消费者。
 */
export type ExecuteSignalsResult = {
  readonly executedOrderIds: ReadonlyArray<string>;
};

/**
 * 末日清仓执行结果。
 * 类型用途：在通用订单执行结果之外显式暴露仍等待权威订单终态的标的，
 * 让末日保护安排系统级一次性重评估而不是将其压缩为普通跳过。
 * 数据来源：OrderExecutor 的末日清仓专用入口。
 * 使用范围：DoomsdayProtection、Trader 与系统级时间唤醒链路。
 */
export type DoomsdayClearanceExecutionResult = ExecuteSignalsResult & {
  readonly awaitingAuthoritativeTerminalSymbols: ReadonlyArray<string>;

  /** 最终 mutation permit 内行情缺失的标的，由末日窗口 owner 使用既有重评估机制处理。 */
  readonly unresolvedQuoteSymbols: ReadonlyArray<string>;
};

/**
 * 订单关闭原因。
 * 类型用途：统一表示订单终态关闭语义，供撤单结果、订单监控与终态结算共享。
 * 数据来源：撤单 API 返回、WebSocket 终态事件、单订单权威状态确认结果。
 * 使用范围：Trader、OrderMonitor、清仓冷却日志恢复等跨模块场景；全项目可引用。
 */
export type OrderClosedReason = 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * 单订单权威状态确认结果。
 * 类型用途：表达撤单/改单 API 业务失败后，单订单状态查询的标准化结果。
 * 数据来源：orderStatusQuery.checkOrderState。
 * 使用范围：orderMonitor 内部（orderOps 与调用链）。
 */
export type OrderStateCheckResult =
  | {
      readonly kind: 'TERMINAL';
      readonly closedReason: OrderClosedReason;
      readonly executedPrice: number | null;
      readonly executedQuantity: number | null;
      readonly submittedQuantity: number | null;

      /**
       * SDK `updatedAt`（Last updated）映射的经纪商观察/revision 时间；累计成交量增加时才可派生为本地执行账务时间，
       * 绝不能解释为交易所成交时间。
       */
      readonly orderUpdatedAtMs: number | null;
      readonly status: OrderStatus;
    }
  | {
      readonly kind: 'OPEN';
      readonly status: OrderStatus;
      readonly executedPrice: number | null;
      readonly executedQuantity: number | null;

      /**
       * SDK `updatedAt`（Last updated）映射的经纪商观察/revision 时间；累计成交量增加时才可派生为本地执行账务时间，
       * 绝不能解释为交易所成交时间。
       */
      readonly updatedAtMs: number | null;
    }
  | {
      readonly kind: 'QUERY_FAILED';
      readonly reason: 'NOT_FOUND';
      readonly errorCode: string | null;
      readonly message: string;
    };

/**
 * 已确认终态订单的数量事实。
 * 类型用途：把权威终态的原始委托数量与单调合并后的累计成交数量成对交给后续重规划，禁止由过期 pending 快照补全。
 * 数据来源：orderDetail 终态查询与 orderMonitor 已知订单事实合并结果。
 * 使用范围：CancelOrderOutcome 的 ALREADY_CLOSED 分支及其调用方。
 */
type TerminalOrderExecutionFact = {
  readonly submittedQuantity: number | null;
  readonly executedQuantity: number | null;
};

/**
 * 撤单结果（语义化 outcome）。
 * 类型用途：替代 boolean 语义，区分确认撤销、已关闭、可重试失败与未知失败。
 * 注意：
 * - 对外的 trader/orderMonitor.cancelOrder() 会在确认 tracked order 已终态时先完成本地结算，再返回结果。
 * - relatedBuyOrderIds 表示卖单终态结算后仍需由后续卖单继续关联的买单 ID；无法确定时为 null。
 * - ALREADY_CLOSED 必须携带终态数量事实；调用方在数量不可信时必须 fail-closed，不能回退到撤单前 pending 快照。
 * 数据来源：OrderMonitor.cancelOrder 返回值。
 * 使用范围：Trader、OrderMonitor、订单执行与恢复链路；全项目可引用。
 */
export type CancelOrderOutcome =
  | {
      readonly kind: 'CANCEL_CONFIRMED';
      readonly closedReason: 'CANCELED' | 'REJECTED';
      readonly source: 'API' | 'WS';
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: 'ALREADY_CLOSED';
      readonly closedReason: OrderClosedReason;
      readonly source: 'API_ERROR';
      readonly relatedBuyOrderIds: ReadonlyArray<string> | null;
      readonly terminalExecution: TerminalOrderExecutionFact;
    }
  | {
      readonly kind: 'RETRYABLE_FAILURE';
      readonly errorCode: string | null;
      readonly message: string;
    }
  | {
      readonly kind: 'UNKNOWN_FAILURE';
      readonly errorCode: string | null;
      readonly message: string;
    };

/**
 * 末日保护撤单的 permit 内授权请求。
 * 类型用途：要求末日保护在真正调用 broker 前重新确认其清仓窗口与生命周期门禁仍有效。
 * 数据来源：DoomsdayProtection.cancelPendingBuyOrders 的实时 isLive 门禁。
 * 使用范围：仅 Trader.cancelDoomsdayOrder 的末日保护调用。
 */
export type DoomsdayCancelOrderRequest = {
  readonly kind: 'DOOMSDAY_WINDOW';
  readonly beforeBrokerCancel: () => boolean;
};

/**
 * 撤单尚未开始结果。
 * 类型用途：明确表示 permit 内前置授权已失效，broker 未收到撤单请求。
 * 数据来源：OrderOps 在调用 TradeContext.cancelOrder 前的授权复核。
 * 使用范围：末日保护与 route owner 的撤单结果分流。
 */
export type CancelOrderNotStartedOutcome = {
  readonly kind: 'CANCEL_NOT_STARTED';
};

/**
 * 末日保护撤单结果。
 * 类型用途：除常规撤单结果外，保留 permit 内门禁关闭且未调用 broker 的事实。
 * 数据来源：Trader.cancelDoomsdayOrder 的 DOOMSDAY_WINDOW 请求。
 * 使用范围：DoomsdayProtection.cancelPendingBuyOrders。
 */
export type DoomsdayCancelOrderOutcome = CancelOrderOutcome | CancelOrderNotStartedOutcome;

/**
 * 交易记录。
 * 类型用途：用于交易日志持久化（JSON 文件），描述单条成交或订单状态变更。
 * 数据来源：由 TradeLogger、OrderMonitor 等根据订单与信号构造。
 * 使用范围：仅作为 PersistableTradeRecord 的模块内部基础类型使用。
 */
type TradeRecord = {
  readonly orderId: string | null;

  /** 交易标的代码（如 55131.HK） */
  readonly symbol: string | null;

  /** 交易标的名称（如 阿里摩通六甲牛G） */
  readonly symbolName: string | null;

  /** 监控标的代码（如 HSI.HK） */
  readonly monitorSymbol: string | null;

  /** 信号动作（BUYCALL/SELLCALL/BUYPUT/SELLPUT） */
  readonly action: string | null;

  /** 订单方向（BUY/SELL） */
  readonly side: string | null;

  /** 成交数量 */
  readonly quantity: string | null;

  /** 成交价格 */
  readonly price: string | null;

  /** 订单类型（可为空） */
  readonly orderType: string | null;

  /** 订单状态（成交日志仅记录 FILLED） */
  readonly status: string | null;

  /** 错误信息（成交日志默认 null） */
  readonly error: string | null;

  /** 信号原因 */
  readonly reason: string | null;

  /** 信号触发时间（香港时间字符串） */
  readonly signalTriggerTime: string | null;

  /** 成交时间（香港时间字符串） */
  readonly executedAt: string | null;

  /** 成交时间（毫秒时间戳） */
  readonly executedAtMs: number | null;

  /** 日志记录时间（香港时间字符串） */
  readonly timestamp: string | null;

  /** 是否为保护性清仓（浮亏超阈值触发） */
  readonly isProtectiveClearance: boolean | null;
};

/**
 * 可持久化交易记录。
 * 类型用途：在标准 TradeRecord 上补充执行时间戳，用于按香港交易日切分 mixed trade log。
 * 数据来源：订单状态变化事件中的成交字段。
 * 使用范围：订单事件持久化与 MixedTradeLogRepository。
 */
export type PersistableTradeRecord = TradeRecord & {
  readonly executedAtMs: number;
};
