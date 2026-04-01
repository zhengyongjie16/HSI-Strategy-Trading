/**
 * app 运行时执行门禁模块
 *
 * 职责：
 * - 统一收敛“生命周期门禁”和“连续交易时段门禁”的组合判定
 * - 为异步处理器、订单执行与超时改单等真实执行点提供单一门禁来源
 */
import type { LastState } from '../../types/state.js';

/**
 * 解析当前是否允许进入真实执行链。
 * 只有生命周期门禁开启且当前连续交易时段允许交易时，才返回 true。
 *
 * @param state 运行时门禁状态
 * @returns 是否允许真实执行
 */
export function isRuntimeExecutionAllowed(state: {
  readonly isTradingEnabled: LastState['isTradingEnabled'];
  readonly canTrade: LastState['canTrade'];
}): boolean {
  return state.isTradingEnabled && state.canTrade === true;
}
