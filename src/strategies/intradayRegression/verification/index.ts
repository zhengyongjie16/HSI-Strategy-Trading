/** 日内回归验证纯规则：按显式目标时刻取最近三点，严格比较初值，不持有 timer 或 emitter。 */
import type { DelayedCandidate, VerificationSampleStore } from './types.js';
import { VERIFICATION_OFFSETS_MS } from '../constants.js';

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
