/**
 * 席位被动诊断 runtime。
 * 最早订阅 registry 的真实 state/version 事件，记录首次失效与完整 ACTIVATING→ACTIVE/退出耗时；
 * 不读取订单、不推进激活、不启动业务 cleanup dispatcher，停止时显式注销订阅。
 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { Unsubscribe } from '../../types/events.js';
import type { DiagnosticFields } from '../../types/diagnostics.js';
import type {
  SeatActivationObservation,
  SeatDiagnosticRuntime,
  SeatDiagnosticRuntimeDeps,
} from './types.js';

/** 创建纯旁路订阅；重复 start/stop 幂等，不扫描或伪造启动前未观测到的历史周期。 */
export function createSeatDiagnosticRuntime(
  deps: SeatDiagnosticRuntimeDeps,
): SeatDiagnosticRuntime {
  let unsubscribe: Unsubscribe | null = null;
  const activations = new Map<'LONG' | 'SHORT', SeatActivationObservation>();

  /** 诊断时钟失败只损失耗时，不向 registry listener 聚合业务异常。 */
  function sampleDiagnosticTime(): number | null {
    try {
      const nowMs = deps.clock.now().getTime();
      return Number.isFinite(nowMs) ? nowMs : null;
    } catch {
      return null;
    }
  }

  /** 即使注入 observer 抛错，也不能中断其他真实 registry 订阅者。 */
  function recordDiagnostic(operation: string, fields: DiagnosticFields): void {
    try {
      deps.diagnostics.record(operation, fields);
    } catch {
      // 不重报、不重试、不参与 fatal；丢弃当前诊断即可。
    }
  }

  /** 先完成观测状态收口再发日志；同身份 ACTIVATING 写入保留原起点，重试等待自然计入总耗时。 */
  function handleSeatStateChanged(event: SeatStateChangedEvent): void {
    const nowMs = sampleDiagnosticTime();
    const activation = activations.get(event.direction);
    const sameIdentity =
      activation?.seatVersion === event.nextVersion && activation.symbol === event.nextState.symbol;
    const activationCompleted =
      activation !== undefined && (!sameIdentity || event.nextState.status !== 'ACTIVATING');
    if (activationCompleted) activations.delete(event.direction);

    if (
      event.nextState.status === 'ACTIVATING' &&
      (event.previousState.status !== 'ACTIVATING' ||
        event.previousVersion !== event.nextVersion ||
        event.previousState.symbol !== event.nextState.symbol)
    ) {
      activations.set(event.direction, {
        symbol: event.nextState.symbol,
        seatVersion: event.nextVersion,
        startedAtMs: nowMs,
      });
    }

    if (event.previousVersion !== event.nextVersion) {
      recordDiagnostic(DIAGNOSTIC_OPERATIONS.SEAT_VERSION_INVALIDATED, {
        source: 'SYMBOL_REGISTRY',
        seatDirection: event.direction,
        previousSeatVersion: event.previousVersion,
        seatVersion: event.nextVersion,
        previousSymbol: event.previousState.symbol,
        symbol: event.nextState.symbol,
        previousStatus: event.previousState.status,
        status: event.nextState.status,
      });
    }

    if (activationCompleted) {
      recordDiagnostic(DIAGNOSTIC_OPERATIONS.SEAT_ACTIVATION_COMPLETED, {
        source: 'SYMBOL_REGISTRY',
        seatDirection: event.direction,
        seatVersion: activation.seatVersion,
        symbol: activation.symbol,
        outcome: sameIdentity && event.nextState.status === 'ACTIVE' ? 'ACTIVE' : 'EXITED',
        exitStatus: event.nextState.status,
        nextSeatVersion: event.nextVersion,
        durationMs:
          nowMs === null || activation.startedAtMs === null
            ? null
            : Math.max(0, nowMs - activation.startedAtMs),
      });
    }
  }

  return {
    start: () => {
      if (unsubscribe !== null) return;

      unsubscribe = deps.symbolRegistry.onSeatStateChanged(handleSeatStateChanged);
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
      activations.clear();
    },
  };
}
