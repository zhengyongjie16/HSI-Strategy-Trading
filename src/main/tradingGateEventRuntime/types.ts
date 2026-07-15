import type { Unsubscribe } from '../../types/services.js';

/**
 * 连续交易门禁变化事件。
 * 类型用途：把现有时间控制平面的 canTrade 状态变化显式事件化，供周期换标与换标唤醒 runtime 消费。
 * 数据来源：timeWakeupEvaluationProgram 在计算并写入 lastState.canTrade 后发布。
 * 使用范围：PeriodicSwitchWakeupRuntime、SwitchWakeupRuntime 与 app runtime 接线。
 */
export type TradingGateStateChangedEvent = Readonly<{
  previousCanTrade: boolean | null;
  nextCanTrade: boolean;
}>;

/**
 * 自动寻标授权状态变化事件。
 * 类型用途：传递自动寻标是否可推进的完整授权状态，不把生命周期或末日清仓接管判断复制到消费方。
 * 数据来源：timeWakeupEvaluationProgram 在完成生命周期推进、连续交易门禁与末日接管判定后发布。
 * 使用范围：AutoSearchWakeupRuntime 取消失效 SEARCHING owner，并在授权恢复时重启 EMPTY seat。
 */
export type AutoSearchAuthorizationChangedEvent = Readonly<{
  previousAuthorized: boolean | null;
  nextAuthorized: boolean;
}>;

/**
 * 交易控制平面事件端口。
 * 类型用途：分别提供连续交易门禁与自动寻标授权状态变化的订阅、发布能力。
 * 数据来源：由 createTradingGateEventRuntime 创建。
 * 使用范围：app runtime 装配、timeWakeupEvaluationProgram、AutoSearchWakeupRuntime 与 PeriodicSwitchWakeupRuntime。
 */
export interface TradingGateEventRuntime {
  readonly emitGateStateChanged: (event: TradingGateStateChangedEvent) => void;
  readonly onGateStateChanged: (
    listener: (event: TradingGateStateChangedEvent) => void,
  ) => Unsubscribe;
  readonly emitAutoSearchAuthorizationChanged: (event: AutoSearchAuthorizationChangedEvent) => void;
  readonly onAutoSearchAuthorizationChanged: (
    listener: (event: AutoSearchAuthorizationChangedEvent) => void,
  ) => Unsubscribe;
}
