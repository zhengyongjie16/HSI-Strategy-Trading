import type { DailyLossOrderSnapshot } from '../../types/risk.js';
import type { Position } from '../../types/account.js';
import type { BuySignal, SignalType } from '../../types/signal.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type {
  BullBearWarrantType,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../../types/warrantRisk.js';
import type { RiskCheckResult } from '../../types/riskCheck.js';
import type {
  UnrealizedLossData,
  PreparedUnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/unrealizedLoss.js';

// ==================== 当日亏损追踪 ====================

/**
 * 单监控标的单方向的当日亏损状态。
 * 类型用途：DailyLossTracker 内部的 LONG/SHORT 分方向状态。
 * 数据来源：由 DailyLossTracker 内部维护（买入/卖出订单与偏移）。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossState = {
  /** 当日偏移仅记录亏损，盈利按 0 处理，因此该值始终 <= 0 */
  readonly dailyLossOffset: string;
};

/**
 * 当日亏损方向键。
 * 类型用途：DailyLossTracker 内部用于索引唯一 monitor 的 LONG/SHORT 分段状态。
 * 数据来源：订单归属解析、成交回报与保护性清仓边界。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossDirection = 'LONG' | 'SHORT';

/**
 * 预校验后可参与当日亏损重算的归属成交订单。
 * 类型用途：把无副作用信任边界已确认的 RawOrder 与方向一起传给 DailyLossTracker 的状态重建阶段。
 * 数据来源：DailyLossTracker 的订单归属与更新时间预校验。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossOwnedInDayExecution = {
  readonly order: DailyLossOrderSnapshot;
  readonly direction: DailyLossDirection;
};

/**
 * 单笔订单的一次累计成交推进快照。
 * 类型用途：在保护边界晚于后续成交到达时，恢复该订单在边界时的累计数量与金额。
 * 数据来源：全量订单快照或运行期新增成交 revision。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossExecutionSnapshot = {
  readonly factStage: 'OPEN' | 'TERMINAL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderUpdatedAtMs: number;
};

/**
 * 恢复历史中的一次累计成交快照（progress/baseline/final API 统一中性形态）。
 * phase null 仅表示 V1 baseline 未持久化阶段；校验不得据此授权 OPEN→TERMINAL。
 * 使用范围：仅 domain/risk 与启动恢复的完整历史校验。
 */
export type ExecutionHistorySnapshot = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly factStage: 'OPEN' | 'TERMINAL' | null;
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number | null;
  readonly orderUpdatedAtMs: number;
};

/**
 * 单笔订单的累计权威成交事实。
 * 类型用途：DailyLossTracker 按 orderId 与 revision 幂等合并恢复快照和运行期累计成交回报。
 * 数据来源：全量订单重算或 OrderMonitor 终态结算。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossOrderFact = {
  readonly orderId: string;
  readonly direction: DailyLossDirection;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';

  /** 原始 API submittedAt 的可信毫秒值；null 表示不能证明订单在保护边界后才创建。 */
  readonly submittedAtMs: number | null;
  readonly factStage: 'OPEN' | 'TERMINAL';
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderUpdatedAtMs: number;
  readonly executionSnapshots: ReadonlyArray<DailyLossExecutionSnapshot>;
  readonly historyCompleteFromZero: boolean;
};

/**
 * 单笔订单在保护性清仓边界时的累计基线。
 * 类型用途：当前累计事实减去该基线后得到新保护周期应计入的数量与金额。
 * 数据来源：prepareProtectionBoundary 从订单执行快照中按边界选择。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossOrderBaseline = {
  readonly cumulativeQuantity: number;
  readonly cumulativeAmount: string;
};

/**
 * 唯一 monitor 的双方向当日亏损状态集合。
 * 类型用途：DailyLossTracker 内部保存 LONG/SHORT 两个方向的当前分段状态。
 * 数据来源：prepareRecalculationFromAllOrders/publishRecalculation 全量重算或 recordCumulativeExecution 增量更新。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type DailyLossDirectionStates = Readonly<{
  long: DailyLossState;
  short: DailyLossState;
}>;

/**
 * 未归属订单诊断样例，用于日志输出。
 * 类型用途：订单归属诊断结果中的单条样例。
 * 数据来源：collectOrderOwnershipDiagnostics 内部构造。
 * 使用范围：仅 domain/risk 模块内部使用（诊断与日志）。
 */
export type OrderOwnershipDiagnosticSample = {
  readonly symbol: string;
  readonly stockName: string;
};

/**
 * 订单归属诊断结果，记录当日成交订单中未能归属到任何监控标的的统计信息。
 * 类型用途：DailyLossTracker 启动时日志告警的返回结构。
 * 数据来源：由 collectOrderOwnershipDiagnostics 返回。
 * 使用范围：仅 domain/risk 模块内部使用。
 */
export type OrderOwnershipDiagnostics = {
  readonly inDayFilled: number;
  readonly unmatchedFilled: number;
  readonly unmatchedSamples: ReadonlyArray<OrderOwnershipDiagnosticSample>;
};

/**
 * 中性牛熊证风险事实。
 * 数据来源：riskRefresh 消费 market 报价后解析，或 activation/rebuild 提供已知回收价。
 * 使用范围：domain/risk 的双方向缓存及 application/riskRefresh 的同步发布边界。
 */
export type WarrantInfo =
  | { readonly isWarrant: false }
  | {
      readonly isWarrant: true;
      readonly warrantType: BullBearWarrantType;
      readonly callPrice: string | null;
      readonly symbol: string;
    };

/** 牛熊证事实的唯一状态及同步规则能力；外部读取不属于此 domain owner。 */
export interface WarrantRiskChecker {
  readonly publishWarrantInfo: (info: WarrantInfo, isLongSymbol: boolean) => void;
  readonly setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;
  readonly checkRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: string,
  ) => RiskCheckResult;
  readonly checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: string,
  ) => WarrantDistanceLiquidationResult;
  readonly getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: string | null,
  ) => WarrantDistanceInfo | null;
  readonly clearLongWarrantInfo: () => void;
  readonly clearShortWarrantInfo: () => void;
}

/** 只观测风险事实异常和已知回收价发布；具体日志输出由 composition root 注入。 */
export interface WarrantRiskCheckerDeps {
  readonly onInvalidCallPrice: (symbol: string, callPrice: string | null) => void;
  readonly onWarrantInfoSet: (
    symbol: string,
    callPrice: string,
    isLongSymbol: boolean,
    symbolName: string | null,
  ) => void;
}

/** 买入前单标的持仓市值限制；数据来自实时持仓及计划金额。 */
export interface PositionLimitChecker {
  readonly checkLimit: (
    signal: BuySignal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: string,
  ) => RiskCheckResult;
}

/** 浮亏事实的唯一缓存能力；prepare 无副作用，publish 由调用方最终同步授权。 */
export interface UnrealizedLossChecker {
  readonly getUnrealizedLossData: (symbol: string) => UnrealizedLossData | undefined;
  readonly clearUnrealizedLossData: (symbol?: string | null) => void;
  readonly prepare: (
    orderRecorder: Pick<OrderRecorder, 'getCostBasis'>,
    symbol: string,
    isLongSymbol: boolean,
    dailyLossOffset: string,
  ) => PreparedUnrealizedLossData;
  readonly publish: (prepared: PreparedUnrealizedLossData) => void;
  readonly check: (
    symbol: string,
    currentPrice: string,
    isLongSymbol: boolean,
  ) => UnrealizedLossCheckResult;
}

/** 持仓限制规则配置；金额从配置边界以保真十进制文本注入。 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: string | null;
};

/** 浮亏阈值与未初始化事实观测；domain 不持有 logger 或外部读取能力。 */
export interface UnrealizedLossCheckerDeps {
  readonly maxUnrealizedLossPerSymbol: string | null;
  readonly onMissingData: (symbol: string) => void;
}

/** 同步风险规则组合的协作能力；装配层只创建一次并向所有消费者注入相同缓存。 */
export interface RiskCheckerDeps {
  readonly warrantRiskChecker: WarrantRiskChecker;
  readonly positionLimitChecker: PositionLimitChecker;
  readonly unrealizedLossChecker: UnrealizedLossChecker;
}
