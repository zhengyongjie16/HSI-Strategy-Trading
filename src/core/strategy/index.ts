/**
 * 趋势延续策略模块
 *
 * 职责：
 * - 将策略入口收敛到 factor planner，避免运行时与测试链路漂移
 * - 仅负责把 planner 决策动作转换为可执行信号
 */
import {
  createSignalFromFactorDecision,
  planFactorSignals,
} from '../../services/factors/runtime/index.js';
import type { StrategyThresholdConfig } from '../../types/factor.js';
import type { TradingSignalStrategy } from './types.js';

/**
 * 创建趋势延续策略。
 *
 * @param strategyConfig 趋势延续策略阈值配置
 * @returns 只输出立即信号的交易策略
 */
export function createTrendContinuationStrategy(
  strategyConfig: StrategyThresholdConfig,
): TradingSignalStrategy {
  return {
    generateSignals(state, longSymbol, shortSymbol, positionCache) {
      if (state === null) {
        return [];
      }

      const decisionSnapshot = planFactorSignals({
        factorSnapshot: state,
        strategyConfig,
        longSymbol,
        shortSymbol,
        positionCache,
      });
      return decisionSnapshot.actions.map(createSignalFromFactorDecision);
    },
  };
}
