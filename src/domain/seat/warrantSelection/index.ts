/**
 * 牛熊证候选筛选 policy。
 * 职责：纯策略构造、到期范围选择、基础准入、两层严格边界和精确选优；不请求 IO、缓存或记录失败。
 * 三条寻标入口共用此规则，SDK 距离小数比值仅在此换算为内部百分比文本。
 */
import type { MarketWarrantExpiryRange } from '../../../types/marketPorts.js';
import { EXPIRY_DATE_FILTERS } from '../../../constants/common.js';
import { isHongKongSymbol } from '../../../utils/marketScope.js';
import {
  canonicalDecimal,
  compareRatios,
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatRatio,
} from '../../../utils/numeric/exact.js';
import type {
  DirectionalAutoSearchPolicy,
  EvaluatedWarrantCandidate,
  RankedWarrantCandidate,
  ResolveWarrantSelectionPolicyInput,
  SelectBestWarrantInput,
  WarrantCandidate,
  WarrantSelectionPolicyResult,
  WarrantSelectionResult,
  WarrantSelectionStage,
} from './types.js';

/** 主阈值必须严格位于安全区间内；降级带沿原危险侧开区间，不放宽任何边界。 */
function validatePolicyInvariants(policy: DirectionalAutoSearchPolicy): string | null {
  const range = policy.switchDistanceRange;
  const degraded = policy.degradedRange;
  if (exactCompare(policy.minTurnoverPerMinute, '0') < 0) return '分均成交额阈值不能小于 0';

  if (exactCompare(degraded.min, degraded.max) >= 0)
    return `降级区间无效，要求 min < max，当前值为 ${degraded.min},${degraded.max}`;

  if (exactCompare(range.min, range.max) > 0)
    return `换标区间无效，要求 min <= max，当前值为 ${range.min},${range.max}`;

  if (
    exactCompare(range.min, policy.primaryThreshold) >= 0 ||
    exactCompare(policy.primaryThreshold, range.max) >= 0
  )
    return '主阈值未严格落在换标安全区间内部，要求 switchDistanceRange.min < primaryThreshold < switchDistanceRange.max';

  const expectedMin = policy.direction === 'LONG' ? range.min : policy.primaryThreshold;
  const expectedMax = policy.direction === 'LONG' ? policy.primaryThreshold : range.max;
  if (
    exactCompare(degraded.min, expectedMin) !== 0 ||
    exactCompare(degraded.max, expectedMax) !== 0
  )
    throw new TypeError('Degraded range must match the primary threshold and danger-side boundary');

  return null;
}

/**
 * 构造方向化策略；合法但不满足业务区间的配置显式拒绝，非法金融文本直接失败。
 * 不持有配置、logger 或时间，从而让三条入口只共享筛选而不共享失败/冻结政策。
 */
export function resolveWarrantSelectionPolicy({
  direction,
  primaryThreshold,
  minTurnoverPerMinute,
  switchDistanceRange,
}: ResolveWarrantSelectionPolicyInput): WarrantSelectionPolicyResult {
  if (primaryThreshold === null || minTurnoverPerMinute === null || switchDistanceRange === null)
    return { success: false, reason: '缺少自动寻标阈值或换标区间配置' };

  const threshold = canonicalDecimal(primaryThreshold);
  const range = Object.freeze({
    min: canonicalDecimal(switchDistanceRange.min),
    max: canonicalDecimal(switchDistanceRange.max),
  });
  const policy: DirectionalAutoSearchPolicy = Object.freeze({
    direction,
    primaryThreshold: threshold,
    minTurnoverPerMinute: canonicalDecimal(minTurnoverPerMinute),
    switchDistanceRange: range,
    degradedRange: Object.freeze(
      direction === 'LONG'
        ? { min: range.min, max: threshold }
        : { min: threshold, max: range.max },
    ),
  });
  const reason = validatePolicyInvariants(policy);
  return reason === null ? { success: true, policy } : { success: false, reason };
}

/** 期限配置保持原月数分组；它是时间筛选，不是金融金额或比例。 */
export function buildExpiryDateFilters(
  expiryMinMonths: number,
): ReadonlyArray<MarketWarrantExpiryRange> {
  if (!Number.isFinite(expiryMinMonths) || expiryMinMonths <= 3) return EXPIRY_DATE_FILTERS;

  return expiryMinMonths <= 6 ? EXPIRY_DATE_FILTERS.slice(1) : EXPIRY_DATE_FILTERS.slice(2);
}

/** 基础准入过滤缺失事实；非法中性金融文本暴露内部错误，不伪装成无候选。 */
function resolveEvaluatedWarrantCandidate(
  warrant: SelectBestWarrantInput['warrants'][number],
  tradingMinutes: number,
  minimum: string,
): EvaluatedWarrantCandidate | null {
  if (
    !warrant.symbol ||
    warrant.status !== 'NORMAL' ||
    warrant.callPrice === null ||
    warrant.callPrice === undefined ||
    warrant.toCallPrice === null ||
    warrant.toCallPrice === undefined ||
    warrant.turnover === null ||
    warrant.turnover === undefined
  )
    return null;

  const callPrice = canonicalDecimal(warrant.callPrice);
  const turnover = canonicalDecimal(warrant.turnover);
  const distancePct = exactMultiply(warrant.toCallPrice, '100');
  if (exactCompare(callPrice, '0') <= 0 || exactCompare(turnover, '0') <= 0) return null;

  const minutes = canonicalDecimal(String(tradingMinutes));
  const hasMinutes = exactCompare(minutes, '0') > 0;
  if (!hasMinutes && exactCompare(minimum, '0') > 0) return null;

  if (hasMinutes && exactCompare(turnover, exactMultiply(minimum, minutes)) < 0) return null;

  return {
    symbol: warrant.symbol,
    callPrice,
    distancePct,
    turnover,
    tradingMinutes: hasMinutes ? minutes : '0',
  };
}

/** 主带/降级带均按精确文本严格比较，保留主层没有安全侧上限的既有政策。 */
function resolveSelectionStage(
  distance: string,
  policy: DirectionalAutoSearchPolicy,
): WarrantSelectionStage | null {
  const primary = exactCompare(distance, policy.primaryThreshold);
  if (policy.direction === 'LONG' ? primary > 0 : primary < 0) return 'PRIMARY';

  return exactCompare(distance, policy.degradedRange.min) > 0 &&
    exactCompare(distance, policy.degradedRange.max) < 0
    ? 'DEGRADED'
    : null;
}

/** 先比精确距离差，再按原成交额/分钟数交叉相乘；完全相同保持输入列表顺序。 */
function shouldReplaceBestCandidate(
  best: RankedWarrantCandidate | null,
  next: RankedWarrantCandidate,
): boolean {
  if (best === null) return true;

  const comparison = exactCompare(next.distanceDeltaToThreshold, best.distanceDeltaToThreshold);
  if (comparison !== 0) return comparison < 0;

  if (next.tradingMinutes === '0' || best.tradingMinutes === '0') return false;

  return compareRatios(next.turnover, next.tradingMinutes, best.turnover, best.tradingMinutes) > 0;
}

/** 分均成交额只在最终日志投影处一次 half-even 到零位；不回流筛选与排序。 */
function toWarrantCandidate(candidate: RankedWarrantCandidate): WarrantCandidate {
  return {
    symbol: candidate.symbol,
    callPrice: candidate.callPrice,
    distancePct: candidate.distancePct,
    turnoverPerMinute:
      candidate.tradingMinutes === '0'
        ? '0'
        : formatRatio(candidate.turnover, candidate.tradingMinutes, 0, 'unsigned'),
    selectionStage: candidate.selectionStage,
    distanceDeltaToThreshold: candidate.distanceDeltaToThreshold,
  };
}

/** 精确主带优先、降级带次之；流动性下限相等可入选，两个距离带边界相等均不入选。 */
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  policy,
}: SelectBestWarrantInput): WarrantSelectionResult {
  if (!Number.isFinite(tradingMinutes)) throw new TypeError('Trading minutes must be finite');

  const invalidPolicy = validatePolicyInvariants(policy);
  if (invalidPolicy !== null) throw new RangeError(invalidPolicy);

  let bestPrimary: RankedWarrantCandidate | null = null;
  let bestDegraded: RankedWarrantCandidate | null = null;
  let primaryCandidateCount = 0;
  let degradedCandidateCount = 0;
  for (const warrant of warrants) {
    // 缺代码事实按既有规则丢弃；其余标的只允许港股进入席位与换标决策。
    if (warrant.symbol.length === 0) continue;

    if (!isHongKongSymbol(warrant.symbol)) continue;

    const candidate = resolveEvaluatedWarrantCandidate(
      warrant,
      tradingMinutes,
      policy.minTurnoverPerMinute,
    );
    if (candidate === null) continue;

    const stage = resolveSelectionStage(candidate.distancePct, policy);
    if (stage === null) continue;

    const delta = exactSubtract(candidate.distancePct, policy.primaryThreshold);
    const ranked: RankedWarrantCandidate = {
      ...candidate,
      selectionStage: stage,
      distanceDeltaToThreshold: exactCompare(delta, '0') < 0 ? exactSubtract('0', delta) : delta,
    };
    if (stage === 'PRIMARY') {
      primaryCandidateCount += 1;
      if (shouldReplaceBestCandidate(bestPrimary, ranked)) bestPrimary = ranked;
    } else {
      degradedCandidateCount += 1;
      if (shouldReplaceBestCandidate(bestDegraded, ranked)) bestDegraded = ranked;
    }
  }

  const selected = bestPrimary ?? bestDegraded;
  return {
    candidate: selected === null ? null : toWarrantCandidate(selected),
    primaryCandidateCount,
    degradedCandidateCount,
  };
}
