/**
 * factor runtime 公共入口模块
 *
 * 职责：
 * - 作为 factor runtime 的对外稳定入口
 * - 将 candle 编排、indicator 编排、信号规划与信号构造分派到独立子模块
 */
import type { PositionCache } from '../../../types/services.js';
import type { Signal } from '../../../types/signal.js';
import type {
  DecisionSnapshot,
  FactorDecisionAction,
  FactorSnapshot,
  StrategyThresholdConfig,
} from '../../../types/factor.js';
import type { MultiPeriodCandles } from './types.js';
import * as intradayMomentum from './intradayMomentum.js';
import * as signalPlanner from './signalPlanner.js';
import * as signalFactory from './signalFactory.js';

/**
 * 将当前基础对象 K 线缓存转换为趋势因子快照。
 *
 * @param params candlesByPeriod、currentPrice 与策略阈值
 * @returns 因子快照；无可用样本时返回 null
 */
export function buildTrendFactorSnapshot(params: {
  readonly candlesByPeriod: MultiPeriodCandles;
  readonly currentPrice: number;
  readonly strategyConfig: StrategyThresholdConfig;
}): FactorSnapshot | null {
  return intradayMomentum.buildTrendFactorSnapshot(params);
}

/**
 * 根据因子快照与当前订单状态规划最终交易动作。
 *
 * @param params 因子规划输入
 * @returns 决策快照
 */
export function planFactorSignals(params: {
  readonly factorSnapshot: FactorSnapshot;
  readonly strategyConfig: StrategyThresholdConfig;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly positionCache: PositionCache;
}): DecisionSnapshot {
  return signalPlanner.planFactorSignals(params);
}

/**
 * 把因子决策转换为策略引擎可消费的信号对象。
 *
 * @param decision 因子决策动作
 * @returns 对象池信号对象
 */
export function createSignalFromFactorDecision(decision: FactorDecisionAction): Signal {
  return signalFactory.createSignalFromFactorDecision(decision);
}
