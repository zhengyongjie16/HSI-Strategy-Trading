/** 自动寻标策略构造：阈值文本先验证再精确比较；内部金融契约错误不降级为无候选。 */
import { canonicalDecimal, exactCompare, formatDecimal } from '../../utils/numeric/exact.js';
import type {
  BuildFindBestWarrantInputFromPolicyParams,
  DirectionalAutoSearchPolicy,
  FindBestWarrantInput,
  ResolveDirectionalAutoSearchPolicyInput,
} from './types.js';

/** 主阈值必须严格落在安全区间；合法但不满足业务区间的配置返回原有显式失败。 */
function validatePolicyInvariants(policy: DirectionalAutoSearchPolicy): string | null {
  const range = policy.switchDistanceRange;
  const degraded = policy.degradedRange;
  if (exactCompare(policy.minTurnoverPerMinute, '0') < 0) return '分均成交额阈值不能小于 0';

  if (exactCompare(degraded.min, degraded.max) >= 0)
    return `降级区间无效，要求 min < max，当前值为 ${formatDecimal(degraded.min, 4, 'unsigned')},${formatDecimal(degraded.max, 4, 'unsigned')}`;

  if (exactCompare(range.min, range.max) > 0)
    return `换标区间无效，要求 min <= max，当前值为 ${formatDecimal(range.min, 4, 'unsigned')},${formatDecimal(range.max, 4, 'unsigned')}`;

  if (
    exactCompare(range.min, policy.primaryThreshold) >= 0 ||
    exactCompare(policy.primaryThreshold, range.max) >= 0
  )
    return '主阈值未严格落在换标安全区间内部，要求 switchDistanceRange.min < primaryThreshold < switchDistanceRange.max';

  return null;
}

/** 缺少/业务无效配置明确拒绝；非法文本由纯金融层抛出，不吞内部损坏。 */
export function resolveDirectionalAutoSearchPolicy(
  input: ResolveDirectionalAutoSearchPolicyInput,
): DirectionalAutoSearchPolicy | null {
  const long = input.direction === 'LONG';
  const threshold = long
    ? input.autoSearchConfig.autoSearchMinDistancePctBull
    : input.autoSearchConfig.autoSearchMinDistancePctBear;
  const turnover = long
    ? input.autoSearchConfig.autoSearchMinTurnoverPerMinuteBull
    : input.autoSearchConfig.autoSearchMinTurnoverPerMinuteBear;
  const range = long
    ? input.autoSearchConfig.switchDistanceRangeBull
    : input.autoSearchConfig.switchDistanceRangeBear;
  if (threshold === null || turnover === null || range === null) {
    input.logger.error(
      `${input.logPrefix}: ${input.monitorSymbol} ${input.direction} 缺少自动寻标阈值或换标区间配置`,
    );
    return null;
  }

  const primaryThreshold = canonicalDecimal(threshold);
  const switchDistanceRange = Object.freeze({
    min: canonicalDecimal(range.min),
    max: canonicalDecimal(range.max),
  });
  const policy: DirectionalAutoSearchPolicy = Object.freeze({
    direction: input.direction,
    primaryThreshold,
    minTurnoverPerMinute: canonicalDecimal(turnover),
    switchDistanceRange,
    degradedRange: Object.freeze(
      long
        ? { min: switchDistanceRange.min, max: primaryThreshold }
        : { min: primaryThreshold, max: switchDistanceRange.max },
    ),
  });
  const error = validatePolicyInvariants(policy);
  if (error !== null) {
    input.logger.error(`${input.logPrefix}: ${input.monitorSymbol} ${input.direction} ${error}`);
    return null;
  }

  return policy;
}

/** 只装配中性 query 与技术分钟数，不请求或缓存账户/持仓。 */
export function buildFindBestWarrantInputFromPolicy(
  params: BuildFindBestWarrantInputFromPolicyParams,
): FindBestWarrantInput {
  return {
    ctx: params.ctx,
    monitorSymbol: params.monitorSymbol,
    tradingMinutes: params.getTradingMinutesSinceOpen(params.currentTime),
    policy: params.policy,
    expiryMinMonths: params.expiryMinMonths,
    logger: params.logger,
    ...(params.cacheConfig ? { cacheConfig: params.cacheConfig } : {}),
  };
}
