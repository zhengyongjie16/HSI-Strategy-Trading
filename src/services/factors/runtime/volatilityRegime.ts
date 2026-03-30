/**
 * factor runtime 波动率状态模块
 *
 * 职责：
 * - 识别 candle snapshot 路径下的波动率 regime
 * - 将 regime 判定从主编排逻辑中拆出，降低 snapshot 构造复杂度
 */
import type { StrategyThresholdConfig, VolatilityRegime } from '../../../types/factor.js';

/**
 * 基于波动扩张与分位数的 regime 分类。
 *
 * @param params 波动扩张、分位数与阈值
 * @returns 波动率 regime；样本不足时返回 null
 */
export function classifyRegime(params: {
  readonly volExpansion: number | null;
  readonly volQuantile: number | null;
  readonly thresholds: StrategyThresholdConfig['regimeThresholds'];
}): VolatilityRegime | null {
  const { volExpansion, volQuantile, thresholds } = params;
  if (volExpansion === null || volQuantile === null) {
    return null;
  }

  if (
    volExpansion >= thresholds.extremeVolExpansion ||
    volQuantile >= thresholds.extremeVolQuantile
  ) {
    return 'extreme';
  }

  if (
    volExpansion < thresholds.trendOffVolExpansion &&
    volQuantile < thresholds.trendOffVolQuantile
  ) {
    return 'contracting';
  }

  if (
    volExpansion > thresholds.trendOnVolExpansion &&
    volQuantile > thresholds.trendOnVolQuantile
  ) {
    return 'expanding';
  }

  return 'normal';
}
