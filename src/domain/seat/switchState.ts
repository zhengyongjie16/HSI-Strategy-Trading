/** 换标领域初始状态：以已提交的席位身份生成完整计划，不发布注册表、订单或 timer。 */
import type { SwitchState } from './types.js';

/** 进入 SWITCHING 后保存唯一阶段计划；周期不继承旧持仓的移仓意图。 */
export function initialSwitchState(
  params: Pick<
    SwitchState,
    | 'direction'
    | 'switchMode'
    | 'seatVersion'
    | 'oldSymbol'
    | 'nextSymbol'
    | 'nextCallPrice'
    | 'shouldRebuy'
  >,
): SwitchState {
  return {
    ...params,
    shouldRebuy: params.switchMode === 'DISTANCE' && params.shouldRebuy,
    stage: 'CANCEL_PENDING',
    sellSubmissionResolved: false,
    sellOrderIdsAtAdmission: [],
    sellWaitOrderIds: [],
    sellOrderId: null,
    quoteRetryAttempts: 0,
    quoteRetryNextAt: null,
    quoteRetryExhausted: false,
    cancelRequestSubmitted: false,
  };
}
