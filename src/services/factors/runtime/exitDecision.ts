/**
 * factor runtime 离场判定模块
 *
 * 职责：
 * - 封装多空退出所需的 session VWAP、趋势衰减与反向失效判断
 * - 输出可直接被 signal planner 消费的退出布尔决策与原因
 */
import type { FactorSnapshot, StrategyThresholdConfig } from '../../../types/factor.js';

/**
 * 评估多头退出。
 *
 * @param params 因子快照与策略阈值
 * @returns 是否退出与原因
 */
export function evaluateLongExit(params: {
  readonly factorSnapshot: FactorSnapshot;
  readonly strategyConfig: StrategyThresholdConfig;
}): { readonly exit: boolean; readonly reason: string } {
  const { factorSnapshot, strategyConfig } = params;
  if (!factorSnapshot.readiness.overallReady) {
    return {
      exit: false,
      reason: factorSnapshot.readiness.reasons.join(', ') || 'factor not ready',
    };
  }

  if (!factorSnapshot.confirmation.vwapAlignedLong) {
    return {
      exit: true,
      reason: 'lost session VWAP support',
    };
  }

  if (
    factorSnapshot.trendScore !== null &&
    factorSnapshot.trendScore < strategyConfig.trendScoreThresholds.exitThreshold
  ) {
    return {
      exit: true,
      reason: 'trend score decayed',
    };
  }

  if (
    factorSnapshot.trendScore !== null &&
    factorSnapshot.trendScore <= -strategyConfig.trendScoreThresholds.reverseInvalidationThreshold
  ) {
    return {
      exit: true,
      reason: 'reverse trend invalidation',
    };
  }

  if (
    factorSnapshot.er15 !== null &&
    factorSnapshot.er15 < strategyConfig.erThresholds.er15ExitMax
  ) {
    return {
      exit: true,
      reason: 'ER15 decayed',
    };
  }

  if (
    factorSnapshot.er30 !== null &&
    factorSnapshot.er30 < strategyConfig.erThresholds.er30ExitMax
  ) {
    return {
      exit: true,
      reason: 'ER30 decayed',
    };
  }

  if (factorSnapshot.openingStructure.failedBreakout) {
    return {
      exit: true,
      reason: 'structure invalidated',
    };
  }

  return {
    exit: false,
    reason: 'long trend intact',
  };
}

/**
 * 评估空头退出。
 *
 * @param params 因子快照与策略阈值
 * @returns 是否退出与原因
 */
export function evaluateShortExit(params: {
  readonly factorSnapshot: FactorSnapshot;
  readonly strategyConfig: StrategyThresholdConfig;
}): { readonly exit: boolean; readonly reason: string } {
  const { factorSnapshot, strategyConfig } = params;
  if (!factorSnapshot.readiness.overallReady) {
    return {
      exit: false,
      reason: factorSnapshot.readiness.reasons.join(', ') || 'factor not ready',
    };
  }

  if (!factorSnapshot.confirmation.vwapAlignedShort) {
    return {
      exit: true,
      reason: 'lost session VWAP support',
    };
  }

  if (
    factorSnapshot.trendScore !== null &&
    Math.abs(factorSnapshot.trendScore) < strategyConfig.trendScoreThresholds.exitThreshold
  ) {
    return {
      exit: true,
      reason: 'trend score decayed',
    };
  }

  if (
    factorSnapshot.trendScore !== null &&
    factorSnapshot.trendScore >= strategyConfig.trendScoreThresholds.reverseInvalidationThreshold
  ) {
    return {
      exit: true,
      reason: 'reverse trend invalidation',
    };
  }

  if (
    factorSnapshot.er15 !== null &&
    factorSnapshot.er15 < strategyConfig.erThresholds.er15ExitMax
  ) {
    return {
      exit: true,
      reason: 'ER15 decayed',
    };
  }

  if (
    factorSnapshot.er30 !== null &&
    factorSnapshot.er30 < strategyConfig.erThresholds.er30ExitMax
  ) {
    return {
      exit: true,
      reason: 'ER30 decayed',
    };
  }

  if (factorSnapshot.openingStructure.failedBreakout) {
    return {
      exit: true,
      reason: 'structure invalidated',
    };
  }

  return {
    exit: false,
    reason: 'short trend intact',
  };
}
