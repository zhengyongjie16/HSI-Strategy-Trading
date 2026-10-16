import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type {
  TradingTimeState,
  AutoSearchAuthorizationChangedEvent,
} from '../../types/timeControlPlane.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { AutoSearchConfig } from '../../types/config.js';
import type { AutoSearchWorkflow } from '../../application/autoSearch/types.js';
import type { SymbolRegistry } from '../../types/seat.js';

/** 自动寻标授权的窄订阅能力，由 app 注入真实时间门禁事件源，不传播旧 main runtime 类型。 */
export interface AutoSearchAuthorizationSource {
  readonly onAutoSearchAuthorizationChanged: (
    listener: (event: AutoSearchAuthorizationChangedEvent) => void,
  ) => () => void;
}

/**
 * 自动寻标 route key。
 * 类型用途：以 direction + seatVersion 唯一标识一条空席位寻标唤醒链。
 * 数据来源：由 AutoSearchWakeupRuntime 在安排 one-shot timer 时构造。
 * 使用范围：仅 AutoSearchWakeupRuntime 模块内部使用。
 */
export type AutoSearchRouteKey = `${'LONG' | 'SHORT'}:${number}`;

/**
 * 自动寻标 runtime 依赖。
 * 类型用途：创建运行时空席位自动寻标事件 owner 所需的权威状态与 timer 能力。
 * 数据来源：app runtime 装配层。
 * 使用范围：AutoSearchWakeupRuntime 工厂。
 */
export type AutoSearchWakeupRuntimeDeps = Readonly<{
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  symbolRegistry: SymbolRegistry;
  autoSearch: AutoSearchWorkflow;
  autoSearchConfig: Pick<AutoSearchConfig, 'autoSearchEnabled' | 'autoSearchOpenDelayMinutes'>;
  readonly tradingTimeState: Readonly<Pick<TradingTimeState, 'canTrade' | 'isHalfDay'>>;
  readonly lifecycleState: Readonly<Pick<LifecycleMutableState, 'isTradingEnabled'>>;
  tradingGateEventRuntime: AutoSearchAuthorizationSource;

  /** 是否启用末日保护清仓接管门禁。 */
  doomsdayProtectionEnabled: boolean;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * 自动寻标 wakeup runtime。
 * 类型用途：运行期空席位自动寻标的唯一事件 owner。
 * 数据来源：由 createAutoSearchWakeupRuntime 创建。
 * 使用范围：app 装配、lifecycle 与 cleanup。
 */
export interface AutoSearchWakeupRuntime {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly stop: () => void;
}
