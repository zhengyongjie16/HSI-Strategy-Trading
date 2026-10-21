/** Broker业务订单状态：保留提交/改单/撤单在途的真实语义，不含SDK数值枚举。 */
export type OrderReadStatus =
  | 'UNCONFIRMED'
  | 'UNREPORTED'
  | 'REPLACEMENT_UNREPORTED'
  | 'PROTECTION_UNREPORTED'
  | 'CONDITIONAL_UNREPORTED'
  | 'FILLED'
  | 'SUBMISSION_PENDING'
  | 'WORKING'
  | 'REPLACEMENT_REQUESTED'
  | 'REPLACEMENT_PENDING'
  | 'REPLACED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLATION_PENDING'
  | 'REJECTED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PARTIALLY_CANCELED';

/** 读取所有真实broker订单种类；不把不明/特殊单伪造为LO或MO。 */
export type OrderReadType =
  | 'UNSPECIFIED'
  | 'LO'
  | 'ELO'
  | 'MO'
  | 'AO'
  | 'ALO'
  | 'ODD'
  | 'LIT'
  | 'MIT'
  | 'TSLPAMT'
  | 'TSLPPCT'
  | 'TSMAMT'
  | 'TSMPCT'
  | 'SLO';

/**
 * 待处理订单。
 * 类型用途：表示尚未完全成交的订单，用于 getPendingOrders 返回值、订单监控与撤单逻辑。
 * 数据来源：订单缓存/订单 API 查询结果转换。
 * 使用范围：订单缓存、orderMonitor、异步处理器等；全项目可引用。
 */
export type PendingOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';

  /** SDK 对市价单等合法订单可返回 null；不得伪造为零价格。 */
  readonly submittedPrice: string | null;
  readonly quantity: number;
  readonly status: OrderReadStatus;
  readonly orderType: OrderReadType;
};

/**
 * 订单关闭原因。
 * 类型用途：统一表示订单终态关闭语义，供撤单结果、订单监控与终态结算共享。
 * 数据来源：撤单 API 返回、WebSocket 终态事件、单订单权威状态确认结果。
 * 使用范围：订单监控与取消调用方、清仓冷却日志恢复等跨模块场景；全项目可引用。
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
      readonly executionStatus: 'NONE' | 'PARTIAL' | 'FILLED';
      readonly closedReason: OrderClosedReason;
      readonly executedPrice: string | null;
      readonly executedQuantity: number | null;

      /** 本次精确累计成交金额；正成交必须为正，不能从 known 补全。 */
      readonly executedAmount: string | null;
      readonly executionTimeMs: number | null;
      readonly submittedQuantity: number | null;

      /** 独立 broker revision；正成交时是订单驱动执行时间 T 的唯一来源。 */
      readonly orderUpdatedAtMs: number | null;
      readonly status: OrderReadStatus;
    }
  | {
      readonly kind: 'OPEN';
      readonly executionStatus: 'NONE' | 'PARTIAL' | 'FILLED';
      readonly status: OrderReadStatus;
      readonly executedPrice: string | null;
      readonly executedQuantity: number | null;

      /** 本次精确累计成交金额；正成交必须为正，不能从 known 补全。 */
      readonly executedAmount: string | null;
      readonly executionTimeMs: number | null;

      /** 独立 broker revision；正成交时是订单驱动执行时间 T 的唯一来源。 */
      readonly updatedAtMs: number | null;
    }
  | {
      readonly kind: 'QUERY_FAILED';
      readonly errorCode: string | null;
    };
