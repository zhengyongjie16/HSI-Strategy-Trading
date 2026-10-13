import type { StrategyEmitter } from '../../../types/strategy.js';
import type { RuntimeScheduler } from '../../../types/runtime.js';
import type { DelayedCandidate } from '../../../domain/strategy/intradayRegression/verification/types.js';

/** 当前 pending 的唯一授权；来自本实例登记，旧回调必须同时命中 entry 与 token。 */
export type PendingEntry = {
  readonly candidate: DelayedCandidate;
  readonly token: object;
  readonly emit: StrategyEmitter;
  readonly timer: ReturnType<RuntimeScheduler['scheduleTimer']>;
};

/** 私有 pending 生命周期端口；仅策略实例拥有登记、取消与销毁能力。 */
export interface PendingVerification {
  readonly register: (candidate: DelayedCandidate, emit: StrategyEmitter) => void;
  readonly invalidate: (direction?: 'LONG' | 'SHORT') => void;
  readonly destroy: () => void;
}
