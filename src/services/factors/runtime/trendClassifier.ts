/**
 * factor runtime 趋势分类模块
 *
 * 职责：
 * - 计算多窗口动量、z 分数与趋势评分
 * - 为多周期 candle snapshot 提供统一的趋势分类逻辑
 */
import type {
  MomentumSnapshot,
  StrategyThresholdConfig,
  TrendClassification,
} from '../../../types/factor.js';
import type { NormalizedBar } from './types.js';
import {
  computeMomentum,
  computeRealizedVolatility,
  computeReturns,
  sliceBarsFromEnd,
} from './utils';

/**
 * 计算 bar 级趋势动量与评分。
 *
 * @param params bars、策略配置与 bar 粒度
 * @returns 动量与趋势分数
 */
export function computeMomentumSnapshot(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly strategyConfig: StrategyThresholdConfig;
  readonly barMinutes: number;
}): {
  readonly momentum: MomentumSnapshot;
  readonly trendScore: number | null;
} {
  if (params.barMinutes <= 0) {
    return {
      momentum: {
        mom15: null,
        mom30: null,
        mom60: null,
        zMom15: null,
        zMom30: null,
        zMom60: null,
        sameSignCount: 0,
      },
      trendScore: null,
    };
  }

  const lookback15 = 15 / params.barMinutes;
  const lookback30 = 30 / params.barMinutes;
  const lookback60 = 60 / params.barMinutes;
  const mom15 = Number.isInteger(lookback15) ? computeMomentum(params.bars, lookback15) : null;
  const mom30 = Number.isInteger(lookback30) ? computeMomentum(params.bars, lookback30) : null;
  const mom60 = Number.isInteger(lookback60) ? computeMomentum(params.bars, lookback60) : null;
  const rv15 =
    Number.isInteger(lookback15) && lookback15 > 0
      ? computeRealizedVolatility(computeReturns(sliceBarsFromEnd(params.bars, lookback15 + 1)))
      : null;
  const rv30 =
    Number.isInteger(lookback30) && lookback30 > 0
      ? computeRealizedVolatility(computeReturns(sliceBarsFromEnd(params.bars, lookback30 + 1)))
      : null;
  const rv60 =
    Number.isInteger(lookback60) && lookback60 > 0
      ? computeRealizedVolatility(computeReturns(sliceBarsFromEnd(params.bars, lookback60 + 1)))
      : null;
  const zMom15 = mom15 === null || rv15 === null ? null : mom15 / (rv15 + Number.EPSILON);
  const zMom30 = mom30 === null || rv30 === null ? null : mom30 / (rv30 + Number.EPSILON);
  const zMom60 = mom60 === null || rv60 === null ? null : mom60 / (rv60 + Number.EPSILON);
  const signedValues = [mom15, mom30, mom60].filter((value): value is number => value !== null);
  let positiveCount = 0;
  let negativeCount = 0;
  for (const value of signedValues) {
    if (value > 0) {
      positiveCount += 1;
    } else if (value < 0) {
      negativeCount += 1;
    }
  }

  const sameSignCount = Math.max(positiveCount, negativeCount);
  const trendScore =
    zMom15 === null || zMom30 === null || zMom60 === null
      ? null
      : params.strategyConfig.trendScoreThresholds.w15 * zMom15 +
        params.strategyConfig.trendScoreThresholds.w30 * zMom30 +
        params.strategyConfig.trendScoreThresholds.w60 * zMom60;

  return {
    momentum: {
      mom15,
      mom30,
      mom60,
      zMom15,
      zMom30,
      zMom60,
      sameSignCount,
    },
    trendScore,
  };
}

/**
 * 计算基础趋势分类。
 *
 * @param params 动量、趋势评分与阈值
 * @returns 基础趋势分类
 */
export function computeTrendClassification(params: {
  readonly momentum: MomentumSnapshot;
  readonly trendScore: number | null;
  readonly threshold: number;
}): TrendClassification | null {
  const { momentum, trendScore, threshold } = params;
  if (trendScore === null) {
    return null;
  }

  if (momentum.sameSignCount < 2 || Math.abs(trendScore) < threshold) {
    return 'range';
  }

  return trendScore > 0 ? 'trend_up' : 'trend_down';
}

/**
 * 把 base trend 与高周期趋势一致性合并。
 *
 * @param params base classification 与高周期评分
 * @returns 最终趋势分类
 */
export function applyMultiTimeframeTrendConsistency(params: {
  readonly baseClassification: TrendClassification | null;
  readonly classificationThreshold: number;
  readonly trendScore5m: number | null;
  readonly trendScore15m: number | null;
}): TrendClassification | null {
  if (params.baseClassification === null || params.baseClassification === 'range') {
    return params.baseClassification;
  }

  const expectedDirection = params.baseClassification === 'trend_up' ? 1 : -1;
  const requiredMagnitude = Math.max(0, params.classificationThreshold);
  const higherTimeframeScores = [params.trendScore5m, params.trendScore15m];
  for (const score of higherTimeframeScores) {
    if (score === null) {
      continue;
    }

    if (Math.abs(score) < requiredMagnitude) {
      continue;
    }

    if (score * expectedDirection < 0) {
      return 'range';
    }
  }

  return params.baseClassification;
}
