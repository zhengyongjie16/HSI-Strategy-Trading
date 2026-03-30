/**
 * factor runtime 内部类型定义模块。
 *
 * 职责：
 * - 提供趋势、结构、确认子因子的计算输入输出类型
 * - 把 factor runtime 内部 helper 与公共类型隔离
 */
import type { CandleData } from '../../../types/data.js';
import type {
  FactorConfirmationState,
  FactorSnapshot,
  FactorRegimeState,
  FactorStructureState,
  FactorTrendState,
} from '../../../types/factor.js';

/**
 * 因子 planner 的输入。
 * 类型用途：在已构建 FactorSnapshot 后，叠加交易标的与当前持仓信息生成最终动作。
 * 数据来源：factor snapshot + 当前席位标的 + PositionCache。
 * 使用范围：signal planner 与 strategy 主线。
 */
export type FactorSignalPlannerInput = {
  readonly factorSnapshot: FactorSnapshot;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly positionCache: {
    readonly get: (symbol: string) => {
      readonly quantity: number;
    } | null;
  };
};

/**
 * 计算趋势评分时的中间汇总。
 * 类型用途：封装 long/short 两侧评分与原因，便于 trend runtime 统一归纳。
 * 数据来源：trend classifier 内部派生。
 * 使用范围：factor runtime 内部。
 */
export type TrendScoreSummary = {
  readonly ready: boolean;
  readonly longScore: number;
  readonly shortScore: number;
  readonly reasons: ReadonlyArray<string>;
};

/**
 * 因子分段计算结果。
 * 类型用途：在 factor runtime 各阶段间传递 regime / trend / structure / confirmation 结果。
 * 数据来源：各 runtime helper 计算。
 * 使用范围：factor runtime 内部与测试。
 */
export type FactorStageResults = {
  readonly regime: FactorRegimeState;
  readonly trend: FactorTrendState;
  readonly structure: FactorStructureState;
  readonly confirmation: FactorConfirmationState;
};

/**
 * 运行时归一化后的 K 线条目。
 * 类型用途：承载 session / momentum / structure 计算所需的最小 OHLCV 数据。
 * 数据来源：由 runtime 的 candle normalization 逻辑从 CandleData 规整得到。
 * 使用范围：factor runtime 内部 helper。
 */
export type NormalizedBar = {
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly volume: number;
  readonly timestamp: number;
};

/**
 * 趋势内核所需的多周期 K 线集合。
 * 类型用途：表达 1m / 5m / 15m 三组缓存，供 trend factor runtime 构建使用。
 * 数据来源：主循环中的本地 K 线缓存。
 * 使用范围：buildTrendFactorSnapshot 与相关测试。
 */
export type MultiPeriodCandles = {
  readonly min1: ReadonlyArray<CandleData>;
  readonly min5: ReadonlyArray<CandleData>;
  readonly min15: ReadonlyArray<CandleData>;
};
