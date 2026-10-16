import type { OrderRecorder } from './orderRecorder.js';
import type { SignalExecutor } from './orderExecutionPorts.js';
import type { Quote } from './quote.js';
import type { DailyLossTracker } from './risk.js';

/**
 * 浮亏数据。
 * 类型用途：存储单标的累计买入金额/数量等，用于计算浮动亏损与强平判定。
 * 数据来源：OrderRecorder 订单记录 + RiskChecker 刷新与计算。
 * 使用范围：RiskChecker、UnrealizedLossMonitor 等；全项目可引用。
 */
export type UnrealizedLossData = {
  /** r1: 累计买入金额 */
  readonly r1: string;

  /** n1: 累计买入数量 */
  readonly n1: number;
};

/** 异步 owner 准备的未发布风险结果；最终 token 校验通过后才能同步 publish。 */
export type PreparedUnrealizedLossData = {
  readonly symbol: string;
  readonly data: UnrealizedLossData;
};

/**
 * 浮亏实时指标。
 * 类型用途：基于浮亏缓存和当前价格计算的实时持仓指标，供行情展示等非清仓场景使用。
 * 数据来源：RiskChecker 读取 UnrealizedLossData 并结合最新价格计算得到。
 * 使用范围：行情展示、风控任务等；全项目可引用。
 */
export type UnrealizedLossMetrics = {
  /** r1: 调整后的开仓成本 */
  readonly r1: string;

  /** n1: 持仓数量 */
  readonly n1: number;

  /** r2: 当前持仓市值 */
  readonly r2: string;

  /** 持仓盈亏（r2 - r1） */
  readonly unrealizedPnL: string;
};

/**
 * 浮亏检查结果。
 * 类型用途：单标的浮亏检查返回值，表示是否应强制平仓、原因及建议平仓数量。
 * 数据来源：RiskChecker.checkUnrealizedLoss。
 * 使用范围：信号处理、卖出逻辑；全项目可引用。
 */
export type UnrealizedLossCheckResult = {
  /** 是否应该强制平仓 */
  readonly shouldLiquidate: boolean;

  /** 平仓原因 */
  readonly reason?: string;

  /** 平仓数量 */
  readonly quantity?: number;
};

/** 业务风控和行情展示读取同一 R1/N1；不持有发布权限或保护性完成条件。 */
export interface UnrealizedLossReader {
  /** 浮亏检查（是否触发强平） */
  readonly checkUnrealizedLoss: (
    symbol: string,
    currentPrice: string,
    isLongSymbol: boolean,
  ) => UnrealizedLossCheckResult;

  /** 获取实时浮亏指标（用于展示持仓市值与持仓盈亏） */
  readonly getUnrealizedLossMetrics: (
    symbol: string,
    currentPrice: string | null,
  ) => UnrealizedLossMetrics | null;
}

/** 唯一 R1/N1 的同步 prepare/publish/clear 能力；prepare 仅需要原始精确成本读取。 */
export interface UnrealizedLossProjection {
  /** 无副作用准备 R1/N1；不得在异步返回后才判断是否已经污染缓存。 */
  readonly prepareUnrealizedLossData: (
    orderRecorder: Pick<OrderRecorder, 'getCostBasis'>,
    symbol: string,
    isLongSymbol: boolean,
    dailyLossOffset: string,
  ) => PreparedUnrealizedLossData;

  /** 调用方完成最终 token/身份验证的同一同步段发布。 */
  readonly publishUnrealizedLossData: (prepared: PreparedUnrealizedLossData) => void;

  /** 清空浮亏缓存（symbol 为空时清空全部） */
  readonly clearUnrealizedLossData: (symbol?: string | null) => void;
}

/**
 * 单方向浮亏监控上下文。
 * 类型用途：ProtectiveLiquidationWorkflow 调用单方向浮亏执行器时的入参，只携带当前方向与 seatVersion。
 * 数据来源：由 protective workflow 校验行情、席位与结算事实后组装传入。
 * 使用范围：风险控制与事件驱动浮亏链路；全项目可引用。
 */
export type DirectionalUnrealizedLossMonitorContext = {
  readonly symbol: string;
  readonly isLong: boolean;
  readonly seatVersion: number;

  /** 调用方提供真实 seat/token/freshness 授权；每次 await 后和 mutation/cleanup 前复核。 */
  readonly isCurrent: () => boolean;
  readonly quote: Quote;
  readonly riskChecker: Pick<UnrealizedLossReader, 'checkUnrealizedLoss'> &
    Pick<UnrealizedLossProjection, 'prepareUnrealizedLossData' | 'publishUnrealizedLossData'>;
  readonly orderExecutor: SignalExecutor;
  readonly orderRecorder: Pick<OrderRecorder, 'clearBuyOrders' | 'getCostBasis'>;
  readonly dailyLossTracker: Pick<DailyLossTracker, 'getLossOffset'>;
};

/**
 * 浮亏监控器接口。
 * 类型用途：依赖注入，由 application protective 执行器按单方向执行保护性清仓。
 * 数据来源：由 composition root 创建并注入唯一 protective workflow。
 * 使用范围：保护性清仓用例与 app 装配；全项目可引用。
 */
export interface UnrealizedLossMonitor {
  /**
   * 监控单方向标的的浮亏。
   * @param context 单方向浮亏监控上下文
   * @returns broker 已确认订单时为 true；供原 owner 区分未提交的失效工作与不可重提的真实提交
   */
  readonly monitorDirectionalUnrealizedLoss: (
    context: DirectionalUnrealizedLossMonitorContext,
  ) => Promise<boolean>;
}
