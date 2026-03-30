/**
 * factor runtime 入场判定模块
 *
 * 职责：
 * - 封装多空入场所需的结构、趋势、确认与 session 约束
 * - 输出可直接被 signal planner 消费的布尔决策与原因
 */
import type { FactorSnapshot, StrategyThresholdConfig } from '../../../types/factor.js';

/**
 * 判断多头开仓结构是否成立。
 *
 * @param factorSnapshot 因子快照
 * @returns 是否成立
 */
function hasLongEntryStructure(factorSnapshot: FactorSnapshot): boolean {
  return (
    factorSnapshot.openingStructure.breakoutUp ||
    factorSnapshot.openingStructure.retestHoldUp ||
    factorSnapshot.pmContinuation.pmConfirmed
  );
}

/**
 * 判断空头开仓结构是否成立。
 *
 * @param factorSnapshot 因子快照
 * @returns 是否成立
 */
function hasShortEntryStructure(factorSnapshot: FactorSnapshot): boolean {
  return (
    factorSnapshot.openingStructure.breakoutDown ||
    factorSnapshot.openingStructure.retestHoldDown ||
    factorSnapshot.pmContinuation.pmConfirmed
  );
}

/**
 * 评估多头开仓。
 *
 * @param params 因子快照与策略阈值
 * @returns 开仓是否允许与原因
 */
export function evaluateLongEntry(params: {
  readonly factorSnapshot: FactorSnapshot;
  readonly strategyConfig: StrategyThresholdConfig;
}): { readonly allowed: boolean; readonly reason: string } {
  const { factorSnapshot, strategyConfig } = params;
  if (!factorSnapshot.readiness.overallReady) {
    return {
      allowed: false,
      reason: factorSnapshot.readiness.reasons.join(', ') || 'factor not ready',
    };
  }

  if (factorSnapshot.blockedByNoiseWindow) {
    return {
      allowed: false,
      reason: 'noise window',
    };
  }

  if (
    factorSnapshot.volatilityRegime !== 'normal' &&
    factorSnapshot.volatilityRegime !== 'expanding'
  ) {
    return {
      allowed: false,
      reason: `regime=${String(factorSnapshot.volatilityRegime)}`,
    };
  }

  if (factorSnapshot.trendClassification !== 'trend_up') {
    return {
      allowed: false,
      reason: `trend=${String(factorSnapshot.trendClassification)}`,
    };
  }

  if (
    factorSnapshot.trendScore === null ||
    factorSnapshot.trendScore < strategyConfig.trendScoreThresholds.entryThreshold
  ) {
    return {
      allowed: false,
      reason: 'trend score below entry threshold',
    };
  }

  if (
    factorSnapshot.er15 === null ||
    factorSnapshot.er30 === null ||
    factorSnapshot.er15 < strategyConfig.erThresholds.er15EntryMin ||
    factorSnapshot.er30 < strategyConfig.erThresholds.er30EntryMin
  ) {
    return {
      allowed: false,
      reason: 'ER below entry threshold',
    };
  }

  if (factorSnapshot.openingStructure.failedBreakout) {
    return {
      allowed: false,
      reason: 'failed breakout',
    };
  }

  if (!hasLongEntryStructure(factorSnapshot)) {
    return {
      allowed: false,
      reason: 'structure not confirmed',
    };
  }

  if (!factorSnapshot.confirmation.longAllowed) {
    return {
      allowed: false,
      reason: 'confirmation rejected long entry',
    };
  }

  if (factorSnapshot.session === 'pm' && !factorSnapshot.pmContinuation.pmConfirmed) {
    return {
      allowed: false,
      reason: 'pm continuation not confirmed',
    };
  }

  return {
    allowed: true,
    reason:
      factorSnapshot.session === 'pm'
        ? 'trend up / pm continuation confirmed'
        : 'trend up / confirmation passed',
  };
}

/**
 * 评估空头开仓。
 *
 * @param params 因子快照与策略阈值
 * @returns 开仓是否允许与原因
 */
export function evaluateShortEntry(params: {
  readonly factorSnapshot: FactorSnapshot;
  readonly strategyConfig: StrategyThresholdConfig;
}): { readonly allowed: boolean; readonly reason: string } {
  const { factorSnapshot, strategyConfig } = params;
  if (!factorSnapshot.readiness.overallReady) {
    return {
      allowed: false,
      reason: factorSnapshot.readiness.reasons.join(', ') || 'factor not ready',
    };
  }

  if (factorSnapshot.blockedByNoiseWindow) {
    return {
      allowed: false,
      reason: 'noise window',
    };
  }

  if (
    factorSnapshot.volatilityRegime !== 'normal' &&
    factorSnapshot.volatilityRegime !== 'expanding'
  ) {
    return {
      allowed: false,
      reason: `regime=${String(factorSnapshot.volatilityRegime)}`,
    };
  }

  if (factorSnapshot.trendClassification !== 'trend_down') {
    return {
      allowed: false,
      reason: `trend=${String(factorSnapshot.trendClassification)}`,
    };
  }

  if (
    factorSnapshot.trendScore === null ||
    Math.abs(factorSnapshot.trendScore) < strategyConfig.trendScoreThresholds.entryThreshold
  ) {
    return {
      allowed: false,
      reason: 'trend score below entry threshold',
    };
  }

  if (
    factorSnapshot.er15 === null ||
    factorSnapshot.er30 === null ||
    factorSnapshot.er15 < strategyConfig.erThresholds.er15EntryMin ||
    factorSnapshot.er30 < strategyConfig.erThresholds.er30EntryMin
  ) {
    return {
      allowed: false,
      reason: 'ER below entry threshold',
    };
  }

  if (factorSnapshot.openingStructure.failedBreakout) {
    return {
      allowed: false,
      reason: 'failed breakout',
    };
  }

  if (!hasShortEntryStructure(factorSnapshot)) {
    return {
      allowed: false,
      reason: 'structure not confirmed',
    };
  }

  if (!factorSnapshot.confirmation.shortAllowed) {
    return {
      allowed: false,
      reason: 'confirmation rejected short entry',
    };
  }

  if (factorSnapshot.session === 'pm' && !factorSnapshot.pmContinuation.pmConfirmed) {
    return {
      allowed: false,
      reason: 'pm continuation not confirmed',
    };
  }

  return {
    allowed: true,
    reason:
      factorSnapshot.session === 'pm'
        ? 'trend down / pm continuation confirmed'
        : 'trend down / confirmation passed',
  };
}
