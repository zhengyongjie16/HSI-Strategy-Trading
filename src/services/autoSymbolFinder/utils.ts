/** 自动寻标精确筛选：金融事实只接收普通文本，阈值和流动性判断不使用显示舍入。 */
import type { MarketWarrantExpiryRange } from '../../types/marketPorts.js';
import { EXPIRY_DATE_FILTERS } from '../../constants/index.js';
import {
  canonicalDecimal,
  compareRatios,
  exactCompare,
  exactMultiply,
  exactSubtract,
  formatRatio,
} from '../../utils/numeric/exact.js';
import type {
  DirectionalAutoSearchPolicy,
  EvaluatedWarrantCandidate,
  RankedWarrantCandidate,
  SelectBestWarrantInput,
  WarrantCandidate,
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
  WarrantSelectionResult,
  WarrantSelectionStage,
} from './types.js';

/** 解析中性金融事实；空缺可过滤，非法内部文本直接失败。 */
function resolveEvaluatedWarrantCandidate(
  warrant: WarrantListItem,
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
    name: warrant.name ?? null,
    callPrice,
    distancePct,
    turnover,
    tradingMinutes: hasMinutes ? minutes : '0',
  };
}

/** 主带/降级带均按精确文本严格比较，保留旧开区间政策。 */
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

/** 先比精确距离差，再以原成交额/分钟数比率选优；完全相同时保持列表顺序。 */
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

/** 分均成交额仅在对外日志投影处按既有零位政策舍入；不回流筛选和排序。 */
function toWarrantCandidate(candidate: RankedWarrantCandidate): WarrantCandidate {
  return {
    symbol: candidate.symbol,
    name: candidate.name,
    callPrice: candidate.callPrice,
    distancePct: candidate.distancePct,
    turnover: candidate.turnover,
    turnoverPerMinute:
      candidate.tradingMinutes === '0'
        ? '0'
        : formatRatio(candidate.turnover, candidate.tradingMinutes, 0, 'unsigned'),
    selectionStage: candidate.selectionStage,
    distanceDeltaToThreshold: candidate.distanceDeltaToThreshold,
  };
}

/** 创建仅保存事实和在途查询的单缓存，clear 同时取消旧缓存可见性。 */
export function createWarrantListCache(): WarrantListCache {
  const entries = new Map<string, WarrantListCacheEntry>();
  const inFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();
  return {
    getEntry: (key) => entries.get(key),
    setEntry: (key, entry) => {
      entries.set(key, entry);
    },
    getInFlight: (key) => inFlight.get(key),
    setInFlight: (key, request) => {
      inFlight.set(key, request);
    },
    deleteInFlight: (key) => {
      inFlight.delete(key);
    },
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
  };
}

/** 最小到期月数沿用旧技术整数分组，不把期限配置当金融金额。 */
export function buildExpiryDateFilters(
  expiryMinMonths: number,
): ReadonlyArray<MarketWarrantExpiryRange> {
  if (!Number.isFinite(expiryMinMonths) || expiryMinMonths <= 3) return EXPIRY_DATE_FILTERS;

  return expiryMinMonths <= 6 ? EXPIRY_DATE_FILTERS.slice(1) : EXPIRY_DATE_FILTERS.slice(2);
}

/** 精确主带优先、降级带次之；不在判断前计算近似商或显示舍入。 */
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  policy,
}: SelectBestWarrantInput): WarrantSelectionResult {
  if (!Number.isFinite(tradingMinutes)) throw new TypeError('Trading minutes must be finite');

  if (exactCompare(policy.minTurnoverPerMinute, '0') < 0)
    throw new RangeError('Minimum turnover must be nonnegative');

  let bestPrimary: RankedWarrantCandidate | null = null;
  let bestDegraded: RankedWarrantCandidate | null = null;
  let primaryCandidateCount = 0;
  let degradedCandidateCount = 0;
  for (const warrant of warrants) {
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
