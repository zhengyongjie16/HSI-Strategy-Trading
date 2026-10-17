import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type { RuntimeClock } from '../../types/runtime.js';
import type { SymbolRegistry } from '../../types/seat.js';

/** 最早装配的席位被动观测依赖；仅订阅 registry 的真实事件，不持有业务写入或调度能力。 */
export interface SeatDiagnosticRuntimeDeps {
  readonly symbolRegistry: Pick<SymbolRegistry, 'onSeatStateChanged'>;
  readonly clock: RuntimeClock;
  readonly diagnostics: DiagnosticObserver;
}

/** 显式订阅生命周期；start 必须早于启动首次席位 mutation，stop 注销并释放私有计时。 */
export interface SeatDiagnosticRuntime {
  readonly start: () => void;
  readonly stop: () => void;
}

/** 正在观测的完整 ACTIVATING 周期；重试等待不重置开始时间，ACTIVE 后的 retain release 不属于此周期。 */
export type SeatActivationObservation = {
  readonly symbol: string;
  readonly seatVersion: number;
  readonly startedAtMs: number | null;
};
