/**
 * factor runtime 信号构造模块
 *
 * 职责：
 * - 将因子决策动作转换为策略引擎信号对象
 * - 屏蔽对象池创建细节
 */
import { acquireSignal } from '../../../utils/objectPool/index.js';
import type { Signal } from '../../../types/signal.js';
import type { FactorDecisionAction } from '../../../types/factor.js';

/**
 * 把因子决策转换为策略引擎可消费的信号对象。
 *
 * @param decision 因子决策动作
 * @returns 对象池信号对象
 */
export function createSignalFromFactorDecision(decision: FactorDecisionAction): Signal {
  const signal = acquireSignal();
  signal.symbol = decision.symbol;
  signal.symbolName = null;
  signal.action = decision.action;
  signal.reason = decision.reason;
  signal.orderTypeOverride = null;
  signal.isProtectiveLiquidation = null;
  signal.price = null;
  signal.lotSize = null;
  signal.quantity = null;
  signal.triggerTime = new Date();
  signal.seatVersion = null;
  signal.indicators1 = null;
  signal.verificationHistory = null;
  signal.relatedBuyOrderIds = null;
  return signal;
}
