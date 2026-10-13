/**
 * 自动寻标候选查询用例
 *
 * 功能：请求中性牛熊证事实并交共享纯规则选优。
 * 职责：入口请求参数与日志编排；SDK IO/cache/retry 归 market adapter，候选筛选归 domain/seat。
 * 执行流程：read port 获取列表 → 纯 selectBestWarrant → 日志 → 返回最佳或 null。
 */
import type { MarketWarrantListItem } from '../../types/marketPorts.js';
import { DEFAULT_PERCENT_DECIMALS, DEFAULT_PRICE_DECIMALS } from '../../constants/index.js';
import {
  buildExpiryDateFilters,
  selectBestWarrant,
  resolveWarrantSelectionPolicy,
} from '../../domain/seat/warrantSelection/index.js';
import { formatDecimal } from '../../utils/numeric/exact.js';
import type {
  DirectionalAutoSearchPolicy,
  WarrantCandidate,
} from '../../domain/seat/warrantSelection/types.js';
import type { Logger } from '../../utils/logger/types.js';
import type {
  AutoSearchCandidate,
  FindWarrantCandidateParams,
  WarrantCandidateSearch,
  WarrantCandidateSearchDeps,
} from './types.js';

/**
 * 根据共享策略方向解析 warrantList 所需的牛熊证类型。
 * @param policy 方向化自动寻标策略
 * @returns LONG 返回 BULL，SHORT 返回 BEAR
 */
function resolvePolicyWarrantType(policy: DirectionalAutoSearchPolicy): 'BULL' | 'BEAR' {
  return policy.direction === 'LONG' ? 'BULL' : 'BEAR';
}

/**
 * 读取方向中文标签，用于日志区分牛证/熊证。
 * @param policy 方向化自动寻标策略
 * @returns LONG 返回「牛」，SHORT 返回「熊」
 */
function resolvePolicyDirectionLabel(policy: DirectionalAutoSearchPolicy): '牛' | '熊' {
  return policy.direction === 'LONG' ? '牛' : '熊';
}

/**
 * 记录自动寻标命中日志，显式区分主条件与降级条件。
 * @param params 日志参数
 * @returns 无返回值
 */
function logSelectedCandidate(params: {
  readonly logger: Logger;
  readonly monitorSymbol: string;
  readonly tradingMinutes: number;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly candidate: WarrantCandidate;
  readonly primaryCandidateCount: number;
  readonly degradedCandidateCount: number;
}): void {
  const directionLabel = resolvePolicyDirectionLabel(params.policy);
  const thresholdText = formatDecimal(
    params.policy.primaryThreshold,
    DEFAULT_PERCENT_DECIMALS,
    'unsigned',
  );
  const degradedRangeText = `${formatDecimal(
    params.policy.degradedRange.min,
    DEFAULT_PERCENT_DECIMALS,
    'unsigned',
  )},${formatDecimal(params.policy.degradedRange.max, DEFAULT_PERCENT_DECIMALS, 'unsigned')}`;
  const distanceText = formatDecimal(
    params.candidate.distancePct,
    DEFAULT_PERCENT_DECIMALS,
    'unsigned',
  );
  const turnoverText = params.candidate.turnoverPerMinute;
  const distanceDeltaText = formatDecimal(
    params.candidate.distanceDeltaToThreshold,
    DEFAULT_PERCENT_DECIMALS,
    'unsigned',
  );
  const callPriceText = formatDecimal(
    params.candidate.callPrice,
    DEFAULT_PRICE_DECIMALS,
    'unsigned',
  );
  if (params.candidate.selectionStage === 'PRIMARY') {
    params.logger.info(
      `[自动寻标] 主条件命中${directionLabel}证：${params.monitorSymbol} -> ${params.candidate.symbol} ` +
        `(selectionStage=PRIMARY, distancePct=${distanceText}%, delta=${distanceDeltaText}%, ` +
        `threshold=${thresholdText}%, turnoverPerMinute=${turnoverText}, callPrice=${callPriceText}, ` +
        `primaryCandidates=${params.primaryCandidateCount}, tradingMinutes=${params.tradingMinutes})`,
    );
    return;
  }

  params.logger.info(
    `[自动寻标] 主条件无候选，降级区间命中${directionLabel}证：${params.monitorSymbol} -> ${params.candidate.symbol} ` +
      `(selectionStage=DEGRADED, distancePct=${distanceText}%, delta=${distanceDeltaText}%, ` +
      `threshold=${thresholdText}%, degradedRange=${degradedRangeText}, turnoverPerMinute=${turnoverText}, ` +
      `callPrice=${callPriceText}, degradedCandidates=${params.degradedCandidateCount}, tradingMinutes=${params.tradingMinutes})`,
  );
}

/**
 * 记录自动寻标失败日志，显式说明主条件与降级条件均未命中。
 * @param params 日志参数
 * @returns 无返回值
 */
function logNoCandidateFound(params: {
  readonly logger: Logger;
  readonly monitorSymbol: string;
  readonly tradingMinutes: number;
  readonly warrants: ReadonlyArray<MarketWarrantListItem>;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly primaryCandidateCount: number;
  readonly degradedCandidateCount: number;
}): void {
  const directionLabel = resolvePolicyDirectionLabel(params.policy);
  params.logger.warn(
    `[自动寻标] 主条件与降级条件均未命中${directionLabel}证：${params.monitorSymbol} ` +
      `(列表条数=${params.warrants.length}, 交易分钟数=${params.tradingMinutes}, ` +
      `primaryThreshold=${formatDecimal(params.policy.primaryThreshold, DEFAULT_PERCENT_DECIMALS, 'unsigned')}%, ` +
      `degradedRange=${formatDecimal(params.policy.degradedRange.min, DEFAULT_PERCENT_DECIMALS, 'unsigned')}%,` +
      `${formatDecimal(params.policy.degradedRange.max, DEFAULT_PERCENT_DECIMALS, 'unsigned')}%, ` +
      `primaryCandidates=${params.primaryCandidateCount}, degradedCandidates=${params.degradedCandidateCount})`,
  );
}

/**
 * 创建三条入口共用的真实候选查询能力。
 * 策略配置固定后缓存纯 policy；只通过同一 market port 读取，不复制 adapter cache 或 retry。
 * 候选查询不写席位/计数：运行、启动、换标分别持有其失败政策。
 */
export function createWarrantCandidateSearch(
  deps: WarrantCandidateSearchDeps,
): WarrantCandidateSearch {
  const { monitorSymbol, autoSearchConfig, marketDataClient, logger, getTradingMinutesSinceOpen } =
    deps;
  const policies = new Map<'LONG' | 'SHORT', DirectionalAutoSearchPolicy | null>();

  /** 缺失或业务无效策略只记录一次入口拒绝；损坏文本始终作为内部错误暴露。 */
  function resolvePolicy(direction: 'LONG' | 'SHORT'): DirectionalAutoSearchPolicy | null {
    const cached = policies.get(direction);
    if (cached !== undefined) return cached;

    const long = direction === 'LONG';
    const result = resolveWarrantSelectionPolicy({
      direction,
      primaryThreshold: long
        ? autoSearchConfig.autoSearchMinDistancePctBull
        : autoSearchConfig.autoSearchMinDistancePctBear,
      minTurnoverPerMinute: long
        ? autoSearchConfig.autoSearchMinTurnoverPerMinuteBull
        : autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
      switchDistanceRange: long
        ? autoSearchConfig.switchDistanceRangeBull
        : autoSearchConfig.switchDistanceRangeBear,
    });
    if (!result.success) {
      logger.error(`[自动寻标] ${monitorSymbol} ${direction} ${result.reason}`);
      policies.set(direction, null);
      return null;
    }

    policies.set(direction, result.policy);
    return result.policy;
  }

  /** 每个异步边界重读授权；内部错误先于过期判断暴露，外部错误保留身份交各入口 owner。 */
  async function findCandidate({
    direction,
    currentTime,
    canContinue,
  }: FindWarrantCandidateParams): Promise<AutoSearchCandidate | null> {
    if (!canContinue()) return null;

    const policy = resolvePolicy(direction);
    if (policy === null) return null;

    const ctx = await marketDataClient.getQuoteContext();
    if (!canContinue()) return null;

    const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const warrants = await ctx.warrantList({
      symbol: monitorSymbol,
      sortBy: 'TURNOVER',
      sortOrder: 'DESCENDING',
      types: [resolvePolicyWarrantType(policy)],
      issuerIds: null,
      expiryFilters: [...buildExpiryDateFilters(autoSearchConfig.autoSearchExpiryMinMonths)],
      inOutBoundsTypes: ['IN'],
      status: ['NORMAL'],
    });
    // 先校验金融事实再处理过期，不能让 stale closure 隐藏内部契约损坏。
    const selectionResult = selectBestWarrant({ warrants, tradingMinutes, policy });
    if (!canContinue()) return null;

    if (selectionResult.candidate === null) {
      logNoCandidateFound({
        logger,
        monitorSymbol,
        tradingMinutes,
        warrants,
        policy,
        primaryCandidateCount: selectionResult.primaryCandidateCount,
        degradedCandidateCount: selectionResult.degradedCandidateCount,
      });
      return null;
    }

    logSelectedCandidate({
      logger,
      monitorSymbol,
      tradingMinutes,
      policy,
      candidate: selectionResult.candidate,
      primaryCandidateCount: selectionResult.primaryCandidateCount,
      degradedCandidateCount: selectionResult.degradedCandidateCount,
    });
    return {
      symbol: selectionResult.candidate.symbol,
      callPrice: selectionResult.candidate.callPrice,
    };
  }

  return {
    resolveDistanceRange: (direction) => resolvePolicy(direction)?.switchDistanceRange ?? null,
    findCandidate,
  };
}
