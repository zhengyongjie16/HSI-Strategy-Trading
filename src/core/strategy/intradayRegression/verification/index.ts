/** 策略私有 pending、一次性 timer 与验证；token 失效先于取消，异常进入同步 fatal。 */
import type { StrategyDeps, StrategyEmitter } from '../../types.js';
import type {
  DelayedCandidate,
  PendingEntry,
  PendingVerification,
  VerificationSampleStore,
} from './types.js';
import { VERIFICATION_OFFSETS_MS, VERIFICATION_READY_MS } from '../constants.js';

/** 验证保留窗口内最近三点；等值不通过，ADX 不论动作均要求下降。 */
export function passesVerification(
  samples: VerificationSampleStore,
  candidate: DelayedCandidate,
): boolean {
  if (candidate.indicators.length === 0) return false;

  const up = candidate.decision.action === 'BUYCALL' || candidate.decision.action === 'SELLPUT';
  return VERIFICATION_OFFSETS_MS.every((offset) => {
    const sample = samples.getClosest(candidate.decision.triggerTimeMs + offset);
    if (sample === null) return false;

    return candidate.indicators.every((name) => {
      const initial = candidate.initial[name];
      const point = sample.values[name];
      if (
        initial === undefined ||
        !Number.isFinite(initial) ||
        point?.kind !== 'value' ||
        !Number.isFinite(point.value)
      )
        return false;

      return name === 'ADX' || !up ? point.value < initial : point.value > initial;
    });
  });
}

/** 检查毫秒时间可精确表示为 Date；异常不是行情未就绪。 */
export function assertValidTime(value: number): void {
  if (!Number.isFinite(value) || new Date(value).getTime() !== value)
    throw new Error('策略时间无效');
}

/** 私有 pending owner：终态化再执行验证/emit，不公开样本或注册能力给宿主。 */
export function createPendingVerification(
  samples: VerificationSampleStore,
  deps: StrategyDeps,
): PendingVerification {
  const pending = new Map<string, PendingEntry>();
  let destroyed = false;

  /** 先撤销全部选中授权，再逐个取消，单次取消异常不能保留其他输出授权。 */
  function invalidate(direction?: 'LONG' | 'SHORT'): void {
    const entries: PendingEntry[] = [];
    for (const [key, entry] of pending) {
      if (direction !== undefined && entry.candidate.direction !== direction) continue;

      pending.delete(key);
      entries.push(entry);
    }

    let failed = false;
    let firstError: unknown;
    for (const entry of entries) {
      try {
        deps.scheduler.clearTimer(entry.timer);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }

    if (failed) {
      deps.onFatalError(firstError);
      throw firstError;
    }
  }

  /** 保留去重身份及登记 clock 的原位置；scheduler 采用异步 callback 契约。 */
  function register(candidate: DelayedCandidate, emit: StrategyEmitter): void {
    if (destroyed) return;

    const key = `${candidate.symbol}:${candidate.decision.action}:${candidate.decision.triggerTimeMs}`;
    if (pending.has(key)) return;

    const readyAt = candidate.decision.triggerTimeMs + VERIFICATION_READY_MS;
    assertValidTime(readyAt);
    const now = deps.clock.now().getTime();
    assertValidTime(now);
    const delay = Math.max(0, readyAt - now);
    if (!Number.isSafeInteger(delay) || delay > 2_147_483_647)
      throw new Error('策略相对 timer 时间无效');

    const token = {};
    const timer = deps.scheduler.scheduleTimer(() => {
      if (destroyed) return;

      const entry = pending.get(key);
      if (entry?.token !== token) return;

      pending.delete(key);
      try {
        if (passesVerification(samples, entry.candidate)) entry.emit(entry.candidate.decision);
      } catch (error) {
        deps.onFatalError(error);
      }
    }, delay);
    pending.set(key, { candidate, emit, token, timer });
  }

  return {
    register,
    invalidate(direction) {
      if (!destroyed) invalidate(direction);
    },
    destroy() {
      if (destroyed) return;

      destroyed = true;
      invalidate();
    },
  };
}
