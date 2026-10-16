import type { Unsubscribe } from '../../types/events.js';
import type { Logger } from '../../types/logger.js';
import type {
  AutoSearchAuthorizationChangedEvent,
  TradingGatePublisher,
  TradingGateStateChangedEvent,
} from '../../types/timeControlPlane.js';

/**
 * 交易门禁事件端口依赖。
 * 类型用途：为事件 listener 的同步异常提供统一日志归属。
 * 数据来源：由 app 顶层装配注入日志能力。
 * 使用范围：仅 createTradingGateEventRuntime 与相关测试使用。
 */
export interface TradingGateEventRuntimeDeps {
  readonly logger: Pick<Logger, 'error'>;
}

/**
 * 交易控制平面事件端口。
 * 类型用途：分别提供连续交易门禁与自动寻标授权状态变化的订阅、发布能力。
 * 数据来源：由 createTradingGateEventRuntime 创建。
 * 使用范围：app runtime 装配、timeWakeupEvaluationProgram、AutoSearchWakeupRuntime 与 PeriodicSwitchWakeupRuntime。
 */
export interface TradingGateEventRuntime extends TradingGatePublisher {
  readonly onGateStateChanged: (
    listener: (event: TradingGateStateChangedEvent) => void,
  ) => Unsubscribe;
  readonly onAutoSearchAuthorizationChanged: (
    listener: (event: AutoSearchAuthorizationChangedEvent) => void,
  ) => Unsubscribe;
}
