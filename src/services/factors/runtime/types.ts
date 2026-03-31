/**
 * factor runtime 内部类型定义模块。
 *
 * 职责：
 * - 提供趋势、结构、确认子因子的计算输入输出类型
 * - 把 factor runtime 内部 helper 与公共类型隔离
 */
import type { CandleData } from '../../../types/data.js';

/**
 * 运行时归一化后的 K 线条目。
 * 类型用途：承载 session / momentum / structure 计算所需的 OHLCV 与香港时间拆分结果。
 * 数据来源：由 runtime 的 candle normalization 逻辑从 CandleData 规整并预计算香港时区信息得到。
 * 使用范围：factor runtime 内部 helper。
 */
export type NormalizedBar = {
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly volume: number;
  readonly timestamp: number;
  readonly dayKey: string;
  readonly minuteOfDay: number;
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

/**
 * 香港时间拆分结果。
 * 类型用途：承载交易日键与日内分钟，供 session 分段与时间窗口过滤使用。
 * 数据来源：session 工具通过 Intl.DateTimeFormat('Asia/Hong_Kong') 解析得到。
 * 使用范围：factor runtime session 工具模块内部与其调用方。
 */
export type HongKongParts = Readonly<{
  dayKey: string;
  minuteOfDay: number;
}>;
