/**
 * 趋势因子类型模块
 *
 * 职责：
 * - 定义趋势策略运行时使用的因子快照与阈值配置
 * - 统一表达 readiness、regime、trend、structure、confirmation 与 instrument adaptation 结果
 */
import type { SignalType } from './signal.js';

/**
 * 波动率状态。
 * 类型用途：表达当前基础对象所处的波动率 regime。
 * 数据来源：由 factor runtime 根据 ATR / RV / 分位比较计算得到。
 * 使用范围：趋势策略、日志与调试输出。
 */
export type VolatilityRegime = 'contracting' | 'normal' | 'expanding' | 'extreme';

/**
 * 趋势分类。
 * 类型用途：表达当前基础对象的趋势方向分类。
 * 数据来源：由 factor runtime 根据多窗口 momentum 与 trend score 计算得到。
 * 使用范围：趋势策略与日志输出。
 */
export type TrendClassification = 'trend_up' | 'trend_down' | 'range';

/**
 * 当前交易 session。
 * 类型用途：表达基础对象当前处于上午、下午或非连续交易时段。
 * 数据来源：由 factor runtime 根据 bar 时间与香港交易时段推导。
 * 使用范围：VWAP、午后延续与噪音窗口门禁。
 */
export type TradingSessionPhase = 'am' | 'pm' | 'closed';

/**
 * 因子 readiness。
 * 类型用途：统一表达单个快照是否已满足策略运行的最小样本要求。
 * 数据来源：由 factor runtime 在构建快照时逐项判定。
 * 使用范围：策略门禁、日志与调试输出。
 */
export type FactorReadiness = {
  readonly regimeReady: boolean;
  readonly trendReady: boolean;
  readonly structureReady: boolean;
  readonly confirmationReady: boolean;
  readonly overallReady: boolean;
  readonly reasons: ReadonlyArray<string>;
};

/**
 * 动量快照。
 * 类型用途：承载趋势分类所需的多窗口 momentum 与标准化分值。
 * 数据来源：factor runtime。
 * 使用范围：趋势分类、日志与调试输出。
 */
export type MomentumSnapshot = {
  readonly mom15: number | null;
  readonly mom30: number | null;
  readonly mom60: number | null;
  readonly zMom15: number | null;
  readonly zMom30: number | null;
  readonly zMom60: number | null;
  readonly sameSignCount: number;
};

/**
 * VWAP 快照。
 * 类型用途：承载 session-aware VWAP 及其确认所需的派生值。
 * 数据来源：factor runtime。
 * 使用范围：确认层、趋势退出与调试输出。
 */
export type VwapSnapshot = {
  readonly amVwap: number | null;
  readonly pmVwap: number | null;
  readonly dayVwap: number | null;
  readonly activeSessionVwap: number | null;
  readonly activeSessionVwapSlope: number | null;
  readonly crossCountLast10m: number;
  readonly distanceFromActiveVwap: number | null;
};

/**
 * 开盘结构快照。
 * 类型用途：承载开盘区间与结构持续性判断结果。
 * 数据来源：factor runtime。
 * 使用范围：结构层判定与策略退出。
 */
export type OpeningStructureSnapshot = {
  readonly orHigh: number | null;
  readonly orLow: number | null;
  readonly breakoutUp: boolean;
  readonly breakoutDown: boolean;
  readonly outsidePersistenceUp: number | null;
  readonly outsidePersistenceDown: number | null;
  readonly retestHoldUp: boolean;
  readonly retestHoldDown: boolean;
  readonly failedBreakout: boolean;
};

/**
 * 午后延续快照。
 * 类型用途：承载午后第二段趋势延续判定结果。
 * 数据来源：factor runtime。
 * 使用范围：结构层与开仓门禁。
 */
export type PmContinuationSnapshot = {
  readonly amQualified: boolean;
  readonly middayHold: boolean;
  readonly pmConfirmed: boolean;
};

/**
 * 确认层快照。
 * 类型用途：承载 VWAP、EMA、MACD 等确认层输出。
 * 数据来源：factor runtime。
 * 使用范围：开仓确认与退出判定。
 */
export type ConfirmationSnapshot = {
  readonly longAllowed: boolean;
  readonly shortAllowed: boolean;
  readonly emaAlignedLong: boolean;
  readonly emaAlignedShort: boolean;
  readonly macdAlignedLong: boolean;
  readonly macdAlignedShort: boolean;
  readonly vwapAlignedLong: boolean;
  readonly vwapAlignedShort: boolean;
};

/**
 * 趋势策略单次因子快照。
 * 类型用途：承载趋势延续策略需要的全部上层因子输出。
 * 数据来源：factor runtime。
 * 使用范围：策略、日志、测试。
 */
export type FactorSnapshot = {
  readonly session: TradingSessionPhase;
  readonly timestamp: number | null;
  readonly benchmarkPrice: number;
  readonly readiness: FactorReadiness;
  readonly volatilityRegime: VolatilityRegime | null;
  readonly trendClassification: TrendClassification | null;
  readonly trendScore: number | null;
  readonly reverseTrendScore: number | null;
  readonly er15: number | null;
  readonly er30: number | null;
  readonly momentum: MomentumSnapshot;
  readonly vwap: VwapSnapshot;
  readonly openingStructure: OpeningStructureSnapshot;
  readonly pmContinuation: PmContinuationSnapshot;
  readonly confirmation: ConfirmationSnapshot;
  readonly blockedByNoiseWindow: boolean;
};

/**
 * 波动率阈值配置。
 * 类型用途：表达 regime 层所需阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime。
 */
type RegimeThresholds = {
  readonly atrShortPeriod: number;
  readonly atrLongPeriod: number;
  readonly rvQuantileWindowDays: number;
  readonly trendOnVolExpansion: number;
  readonly trendOffVolExpansion: number;
  readonly extremeVolExpansion: number;
  readonly trendOnVolQuantile: number;
  readonly trendOffVolQuantile: number;
  readonly extremeVolQuantile: number;
};

/**
 * 趋势分数阈值配置。
 * 类型用途：表达趋势分类与开平仓阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime 与策略。
 */
type TrendScoreThresholds = {
  readonly w15: number;
  readonly w30: number;
  readonly w60: number;
  readonly classificationThreshold: number;
  readonly entryThreshold: number;
  readonly exitThreshold: number;
  readonly reverseInvalidationThreshold: number;
};

/**
 * ER 阈值配置。
 * 类型用途：表达推进效率的开平仓阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime 与策略。
 */
type ErThresholds = {
  readonly er15EntryMin: number;
  readonly er30EntryMin: number;
  readonly er15ExitMax: number;
  readonly er30ExitMax: number;
  readonly strongTrendErFloor: number;
};

/**
 * VWAP 确认规则配置。
 * 类型用途：表达 session VWAP 相关门槛。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime 与信号确认。
 */
type VwapConfirmRules = {
  readonly distanceBandAtr: number;
  readonly slopeWindowBars: number;
  readonly maxCrossCountLast10m: number;
};

/**
 * 开盘结构规则配置。
 * 类型用途：表达 OR 结构层的时间窗与持续性阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime。
 */
export type OpeningStructureRules = {
  readonly openingRangeMinutes: number;
  readonly breakoutScoreMin: number;
  readonly outsidePersistenceWindowBars: number;
  readonly outsidePersistenceMin: number;
  readonly retestToleranceAtr: number;
  readonly confirmBars: number;
  readonly morningNoiseWindowMinutes: number;
  readonly afternoonNoiseWindowMinutes: number;
};

/**
 * 午后延续规则配置。
 * 类型用途：表达午后第二段趋势延续所需阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：factor runtime。
 */
export type PmContinuationRules = {
  readonly amMoveZMin: number;
  readonly middayHoldMin: number;
  readonly pmReExpansionTrendScoreMin: number;
  readonly pmReExpansionEr15Min: number;
  readonly pmConfirmCutoffMinutes: number;
};

/**
 * 交易标的适配规则配置。
 * 类型用途：表达静态模式与自动寻标模式下牛熊证风险阈值。
 * 数据来源：单实例策略配置。
 * 使用范围：signal pipeline 的 instrument adaptation gate。
 */
type InstrumentAdaptationRules = {
  readonly bullBuyMinDistancePct: number;
  readonly bearBuyMaxDistancePct: number;
  readonly bullLiquidationDistancePct: number;
  readonly bearLiquidationDistancePct: number;
  readonly autoSearchOpenDelayMinutes: number;
  readonly autoSearchPrimaryDistanceBull: number;
  readonly autoSearchPrimaryDistanceBear: number;
  readonly switchDistanceRangeBull: readonly [number, number];
  readonly switchDistanceRangeBear: readonly [number, number];
  readonly autoSearchMinTurnoverPerMinuteBull: number;
  readonly autoSearchMinTurnoverPerMinuteBear: number;
  readonly autoSearchExpiryMinMonths: number;
};

/**
 * 趋势策略阈值配置。
 * 类型用途：表达当前趋势策略所需的完整阈值集合。
 * 数据来源：单实例配置解析。
 * 使用范围：factor runtime、策略与信号闸门。
 */
export type StrategyThresholdConfig = {
  readonly regimeThresholds: RegimeThresholds;
  readonly trendScoreThresholds: TrendScoreThresholds;
  readonly erThresholds: ErThresholds;
  readonly vwapConfirmRules: VwapConfirmRules;
  readonly openingStructureRules: OpeningStructureRules;
  readonly pmContinuationRules: PmContinuationRules;
  readonly instrumentAdaptationRules: InstrumentAdaptationRules;
};

/**
 * 因子决策动作。
 * 类型用途：表达 factor runtime 规划出的最终交易动作。
 * 数据来源：因子规划器。
 * 使用范围：策略主线、测试与日志输出。
 */
export type FactorDecisionAction = {
  readonly action: SignalType;
  readonly symbol: string;
  readonly priority: 'entry' | 'exit';
  readonly score: number;
  readonly reason: string;
};

/**
 * 因子决策快照。
 * 类型用途：承载因子规划器输出的动作集合与拒绝原因。
 * 数据来源：factor runtime。
 * 使用范围：策略主线与测试。
 */
export type DecisionSnapshot = {
  readonly ready: FactorReadiness;
  readonly actions: ReadonlyArray<FactorDecisionAction>;
  readonly holdReasons: ReadonlyArray<string>;
};
