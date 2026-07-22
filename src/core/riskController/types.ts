import type { Position } from '../../types/account.js';
import type { OrderSide } from 'longbridge';
import type { BuySignal, SignalType } from '../../types/signal.js';
import type { Quote } from '../../types/quote.js';
import type {
  MarketDataClient,
  OrderRecorder,
  RawOrderFromAPI,
  BullBearWarrantType,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/services.js';

/**
 * 牛熊证信息。
 * 类型用途：区分非轮证（isWarrant=false）与轮证（isWarrant=true），供风险检查使用。
 * 数据来源：WarrantRiskChecker 通过 Longbridge API 查询后解析填充。
 * 使用范围：仅在 riskController 模块内部使用。
 */
export type WarrantInfo =
  | { readonly isWarrant: false }
  | {
      readonly isWarrant: true;
      readonly warrantType: BullBearWarrantType;
      readonly callPrice: number | null;
      readonly symbol: string;
    };

// ==================== 服务接口定义 ====================

/**
 * 牛熊证风险检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供牛熊证风险与距离检查。
 * 数据来源：如适用。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface WarrantRiskChecker {
  setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;
  refreshWarrantInfoForSymbol: (
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => Promise<WarrantRefreshResult>;
  checkRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
  ) => RiskCheckResult;
  checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ) => WarrantDistanceLiquidationResult;
  getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ) => WarrantDistanceInfo | null;
  clearLongWarrantInfo: () => void;
  clearShortWarrantInfo: () => void;
}

/**
 * 持仓限制检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供买入前单标的最大持仓市值限制检查。
 * 数据来源：如适用（配置中的 maxPositionNotional）。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface PositionLimitChecker {
  checkLimit: (
    signal: BuySignal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: number,
  ) => RiskCheckResult;
}

/**
 * 浮亏检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供浮亏计算与阈值检查。
 * 数据来源：如适用。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface UnrealizedLossChecker {
  getUnrealizedLossData: (symbol: string) => UnrealizedLossData | undefined;

  /** 清空浮亏数据，symbol 为空时清空全部 */
  clearUnrealizedLossData: (symbol?: string | null) => void;
  refresh: (
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ) => Promise<void>;
  check: (symbol: string, currentPrice: number, isLongSymbol: boolean) => UnrealizedLossCheckResult;
}

// ==================== 依赖类型定义 ====================

/**
 * 持仓限制检查器依赖。
 * 类型用途：用于创建 PositionLimitChecker 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxPositionNotional）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: number | null;
};

/**
 * 浮亏检查器依赖。
 * 类型用途：用于创建 UnrealizedLossChecker 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxUnrealizedLossPerSymbol）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type UnrealizedLossCheckerDeps = {
  readonly maxUnrealizedLossPerSymbol: number | null;
};

/**
 * 风险检查器依赖。
 * 类型用途：用于创建 RiskChecker 门面时的依赖注入；阈值配置由各子检查器依赖持有。
 * 数据来源：启动装配层创建的牛熊证、持仓限制与浮亏子检查器。
 * 使用范围：见调用方（如 riskDomain/启动层）。
 */
export type RiskCheckerDeps = {
  readonly warrantRiskChecker: WarrantRiskChecker;
  readonly positionLimitChecker: PositionLimitChecker;
  readonly unrealizedLossChecker: UnrealizedLossChecker;
};

// ==================== 当日亏损追踪 ====================

/**
 * 单监控标的单方向的当日亏损状态。
 * 类型用途：DailyLossTracker 内部的 LONG/SHORT 分方向状态。
 * 数据来源：由 DailyLossTracker 内部维护（买入/卖出订单与偏移）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossState = {
  /** 当日偏移仅记录亏损，盈利按 0 处理，因此该值始终 <= 0 */
  readonly dailyLossOffset: number;
};

/**
 * 当日亏损方向键。
 * 类型用途：DailyLossTracker 内部用于索引唯一 monitor 的 LONG/SHORT 分段状态。
 * 数据来源：订单归属解析、成交回报与保护性清仓边界。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossDirection = 'LONG' | 'SHORT';

/**
 * 预校验后可参与当日亏损重算的归属成交订单。
 * 类型用途：把无副作用信任边界已确认的 RawOrder 与方向一起传给 DailyLossTracker 的状态重建阶段。
 * 数据来源：DailyLossTracker 的订单归属与更新时间预校验。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossOwnedInDayExecution = {
  readonly order: RawOrderFromAPI;
  readonly direction: DailyLossDirection;
};

/**
 * 单笔订单的一次累计成交推进快照。
 * 类型用途：在保护边界晚于后续成交到达时，恢复该订单在边界时的累计数量与金额。
 * 数据来源：全量订单快照或运行期新增成交 revision。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossExecutionSnapshot = {
  readonly factStage: 'OPEN' | 'TERMINAL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: number;
  readonly lastExecutionTimeMs: number;
  readonly orderUpdatedAtMs: number;
};

/**
 * 单笔订单的累计权威成交事实。
 * 类型用途：DailyLossTracker 按 orderId 与 revision 幂等合并恢复快照和运行期累计成交回报。
 * 数据来源：全量订单重算或 OrderMonitor 终态结算。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossOrderFact = {
  readonly orderId: string;
  readonly direction: DailyLossDirection;
  readonly symbol: string;
  readonly side: OrderSide.Buy | OrderSide.Sell;

  /** 原始 API submittedAt 的可信毫秒值；null 表示不能证明订单在保护边界后才创建。 */
  readonly submittedAtMs: number | null;
  readonly factStage: 'OPEN' | 'TERMINAL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: number;
  readonly lastExecutionTimeMs: number;
  readonly orderUpdatedAtMs: number;
  readonly executionSnapshots: ReadonlyArray<DailyLossExecutionSnapshot>;
  readonly historyCompleteFromZero: boolean;
};

/**
 * 单笔订单在保护性清仓边界时的累计基线。
 * 类型用途：当前累计事实减去该基线后得到新保护周期应计入的数量与金额。
 * 数据来源：prepareProtectionBoundary 从订单执行快照中按边界选择。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossOrderBaseline = {
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: number;
};

/**
 * 唯一 monitor 的双方向当日亏损状态集合。
 * 类型用途：DailyLossTracker 内部保存 LONG/SHORT 两个方向的当前分段状态。
 * 数据来源：recalculateFromAllOrders 全量重算或 recordCumulativeExecution 增量更新。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type DailyLossDirectionStates = Readonly<{
  long: DailyLossState;
  short: DailyLossState;
}>;

/**
 * 未归属订单诊断样例，用于日志输出。
 * 类型用途：订单归属诊断结果中的单条样例。
 * 数据来源：collectOrderOwnershipDiagnostics 内部构造。
 * 使用范围：仅 riskController 模块内部使用（诊断与日志）。
 */
export type OrderOwnershipDiagnosticSample = {
  readonly symbol: string;
  readonly stockName: string;
};

/**
 * 订单归属诊断结果，记录当日成交订单中未能归属到任何监控标的的统计信息。
 * 类型用途：DailyLossTracker 启动时日志告警的返回结构。
 * 数据来源：由 collectOrderOwnershipDiagnostics 返回。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type OrderOwnershipDiagnostics = {
  readonly inDayFilled: number;
  readonly unmatchedFilled: number;
  readonly unmatchedSamples: ReadonlyArray<OrderOwnershipDiagnosticSample>;
};

/**
 * 浮亏监控器依赖。
 * 类型用途：用于创建 UnrealizedLossMonitor 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxUnrealizedLossPerSymbol）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type UnrealizedLossMonitorDeps = {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控 */
  readonly maxUnrealizedLossPerSymbol: number;
};
