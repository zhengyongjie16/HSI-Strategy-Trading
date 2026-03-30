/**
 * factor runtime 信号规划模块
 *
 * 职责：
 * - 基于因子快照与当前持仓状态规划最终交易动作
 * - 将开仓、退出与 hold 逻辑从因子构建流程中分离
 */
import type { OrderRecorder } from '../../../types/services.js';
import type {
  DecisionSnapshot,
  FactorDecisionAction,
  FactorSnapshot,
  StrategyThresholdConfig,
} from '../../../types/factor.js';
import { evaluateLongEntry, evaluateShortEntry } from './entryDecision.js';
import { evaluateLongExit, evaluateShortExit } from './exitDecision.js';

/**
 * 构建因子决策动作。
 *
 * @param params action/symbol/priority/score/reason
 * @returns 因子决策动作
 */
function buildFactorDecisionAction(params: {
  readonly action: FactorDecisionAction['action'];
  readonly symbol: string;
  readonly priority: 'entry' | 'exit';
  readonly score: number;
  readonly reason: string;
}): FactorDecisionAction {
  return {
    action: params.action,
    symbol: params.symbol,
    priority: params.priority,
    score: params.score,
    reason: params.reason,
  };
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
  readonly orderRecorder: OrderRecorder;
}): DecisionSnapshot {
  const { factorSnapshot, strategyConfig, longSymbol, shortSymbol, orderRecorder } = params;
  const holdReasons: string[] = [];
  const actions: FactorDecisionAction[] = [];

  /**
   * 判断是否存在已提交的买入委托。
   *
   * @param symbol 席位标的
   * @param isLongSymbol 是否为做多标的
   * @returns 是否存在未完成买单
   */
  function hasOpenBuyOrders(symbol: string, isLongSymbol: boolean): boolean {
    return orderRecorder.getBuyOrdersForSymbol(symbol, isLongSymbol).length > 0;
  }

  if (!factorSnapshot.readiness.overallReady) {
    holdReasons.push(...factorSnapshot.readiness.reasons);
  }

  if (longSymbol) {
    if (hasOpenBuyOrders(longSymbol, true)) {
      const longExitDecision = evaluateLongExit({
        factorSnapshot,
        strategyConfig,
      });
      if (longExitDecision.exit) {
        actions.push(
          buildFactorDecisionAction({
            action: 'SELLCALL',
            symbol: longSymbol,
            priority: 'exit',
            score: factorSnapshot.trendScore ?? 0,
            reason: `[trend_exit] ${longExitDecision.reason}`,
          }),
        );
      } else {
        holdReasons.push(`[long] ${longExitDecision.reason}`);
      }
    } else {
      const longEntryDecision = evaluateLongEntry({
        factorSnapshot,
        strategyConfig,
      });
      if (longEntryDecision.allowed) {
        actions.push(
          buildFactorDecisionAction({
            action: 'BUYCALL',
            symbol: longSymbol,
            priority: 'entry',
            score: factorSnapshot.trendScore ?? 0,
            reason: `[trend_entry] ${longEntryDecision.reason}`,
          }),
        );
      } else {
        holdReasons.push(`[long] ${longEntryDecision.reason}`);
      }
    }
  }

  if (shortSymbol) {
    if (hasOpenBuyOrders(shortSymbol, false)) {
      const shortExitDecision = evaluateShortExit({
        factorSnapshot,
        strategyConfig,
      });
      if (shortExitDecision.exit) {
        actions.push(
          buildFactorDecisionAction({
            action: 'SELLPUT',
            symbol: shortSymbol,
            priority: 'exit',
            score: factorSnapshot.trendScore ?? 0,
            reason: `[trend_exit] ${shortExitDecision.reason}`,
          }),
        );
      } else {
        holdReasons.push(`[short] ${shortExitDecision.reason}`);
      }
    } else {
      const shortEntryDecision = evaluateShortEntry({
        factorSnapshot,
        strategyConfig,
      });
      if (shortEntryDecision.allowed) {
        actions.push(
          buildFactorDecisionAction({
            action: 'BUYPUT',
            symbol: shortSymbol,
            priority: 'entry',
            score: factorSnapshot.trendScore ?? 0,
            reason: `[trend_entry] ${shortEntryDecision.reason}`,
          }),
        );
      } else {
        holdReasons.push(`[short] ${shortEntryDecision.reason}`);
      }
    }
  }

  if (actions.length === 0 && holdReasons.length === 0) {
    holdReasons.push(
      `趋势方向: ${factorSnapshot.trendClassification}`,
      `波动状态: ${factorSnapshot.volatilityRegime ?? 'unknown'}`,
    );
  }

  return {
    ready: factorSnapshot.readiness,
    actions,
    holdReasons,
  };
}
