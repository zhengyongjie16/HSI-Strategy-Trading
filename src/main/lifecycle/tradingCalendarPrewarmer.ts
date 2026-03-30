/**
 * 交易日历预热器模块
 *
 * 核心职责：
 * - 在重建阶段基于 fallback lookback 窗口预热交易日历快照
 * - 仅补齐快照缺失日期，避免重复查询
 * - 按自然月分块调用交易日接口，严格遵守单次查询区间约束
 */
import { LIFECYCLE, TIME } from '../../constants/index.js';
import type { MarketDataClient, TradingDayInfo } from '../../types/services.js';
import { listHKDateKeysBetween } from './utils.js';
import { getHKDateKey, resolveHKDayStartUtcMs } from '../../utils/time/index.js';
import type {
  DateRangeChunk,
  PrewarmTradingCalendarSnapshotParams,
  TradingCalendarPrewarmError,
  TradingCalendarPrewarmErrorParams,
} from './types.js';

function createTradingCalendarPrewarmError(
  params: TradingCalendarPrewarmErrorParams,
): TradingCalendarPrewarmError {
  const error = new Error(params.message);
  error.name = 'TradingCalendarPrewarmError';
  return Object.assign(error, {
    code: params.code,
    details: params.details,
  });
}

export async function prewarmTradingCalendarSnapshotForRebuild(
  params: PrewarmTradingCalendarSnapshotParams,
): Promise<void> {
  const { marketDataClient, lastState, now } = params;
  const nowMs = now.getTime();
  const fallbackStartMs =
    nowMs - LIFECYCLE.CALENDAR_PREWARM_FALLBACK_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY;
  const demandStartMs = fallbackStartMs;
  const demandEndMs = nowMs + LIFECYCLE.CALENDAR_PREWARM_LOOKAHEAD_DAYS * TIME.MILLISECONDS_PER_DAY;
  assertCalendarLookbackRange(demandStartMs, nowMs);
  const demandDateKeys = listHKDateKeysBetween(demandStartMs, demandEndMs);
  if (demandDateKeys.length === 0) {
    return;
  }

  const nextSnapshot = new Map<string, TradingDayInfo>(lastState.tradingCalendarSnapshot ?? []);
  const missingDateKeys = demandDateKeys.filter((dateKey) => !nextSnapshot.has(dateKey));
  if (missingDateKeys.length > 0) {
    await (marketDataClient.getTradingDays
      ? hydrateSnapshotByMonthlyTradingDays({
          marketDataClient,
          dateKeys: missingDateKeys,
          nextSnapshot,
        })
      : hydrateSnapshotByDailyTradingDay({
          marketDataClient,
          dateKeys: missingDateKeys,
          nextSnapshot,
        }));
  }

  const nowDateKey = getHKDateKey(now);
  if (nowDateKey && lastState.cachedTradingDayInfo) {
    nextSnapshot.set(nowDateKey, lastState.cachedTradingDayInfo);
  }

  lastState.tradingCalendarSnapshot = nextSnapshot;
}

function assertCalendarLookbackRange(demandStartMs: number, nowMs: number): void {
  const earliestAllowedMs =
    nowMs - LIFECYCLE.CALENDAR_API_MAX_LOOKBACK_DAYS * TIME.MILLISECONDS_PER_DAY;
  if (demandStartMs >= earliestAllowedMs) {
    return;
  }

  throw createTradingCalendarPrewarmError({
    code: 'TRADING_CALENDAR_LOOKBACK_EXCEEDED',
    message: '[交易日历快照] 预热窗口超出接口最近一年限制，重建已阻断',
    details: {
      demandStartDateKey: getHKDateKey(new Date(demandStartMs)),
      earliestAllowedDateKey: getHKDateKey(new Date(earliestAllowedMs)),
      nowDateKey: getHKDateKey(new Date(nowMs)),
      maxLookbackDays: LIFECYCLE.CALENDAR_API_MAX_LOOKBACK_DAYS,
    },
  });
}

async function hydrateSnapshotByMonthlyTradingDays({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: MarketDataClient;
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  const getTradingDays = marketDataClient.getTradingDays;
  if (!getTradingDays || dateKeys.length === 0) {
    return;
  }

  const chunks = splitMissingDateKeysByMonth(dateKeys);
  for (const chunk of chunks) {
    const startDate = resolveDateFromHKDateKey(chunk.startKey);
    const endDate = resolveDateFromHKDateKey(chunk.endKey);
    const result = await getTradingDays(startDate, endDate);
    const tradingSet = new Set(result.tradingDays);
    const halfDaySet = new Set(result.halfTradingDays);
    for (const dateKey of chunk.dateKeys) {
      const isHalfDay = halfDaySet.has(dateKey);
      const isTradingDay = isHalfDay || tradingSet.has(dateKey);
      nextSnapshot.set(dateKey, { isTradingDay, isHalfDay });
    }
  }
}

async function hydrateSnapshotByDailyTradingDay({
  marketDataClient,
  dateKeys,
  nextSnapshot,
}: {
  marketDataClient: MarketDataClient;
  dateKeys: ReadonlyArray<string>;
  nextSnapshot: Map<string, TradingDayInfo>;
}): Promise<void> {
  for (const dateKey of dateKeys) {
    const date = resolveDateFromHKDateKey(dateKey);
    const dayInfo = await marketDataClient.isTradingDay(date);
    nextSnapshot.set(dateKey, dayInfo);
  }
}

function splitMissingDateKeysByMonth(
  dateKeys: ReadonlyArray<string>,
): ReadonlyArray<DateRangeChunk> {
  if (dateKeys.length === 0) {
    return [];
  }

  const firstDateKey = dateKeys[0];
  if (!firstDateKey) {
    return [];
  }

  const chunks: DateRangeChunk[] = [];
  let chunkStartKey = firstDateKey;
  let previousKey = firstDateKey;
  let chunkDateKeys: string[] = [chunkStartKey];
  for (let index = 1; index < dateKeys.length; index += 1) {
    const currentKey = dateKeys[index];
    if (!currentKey) {
      continue;
    }

    const sameMonth = resolveMonthKey(chunkStartKey) === resolveMonthKey(currentKey);
    const consecutiveDay = isConsecutiveDateKey(previousKey, currentKey);
    if (sameMonth && consecutiveDay) {
      chunkDateKeys.push(currentKey);
      previousKey = currentKey;
      continue;
    }

    chunks.push({
      startKey: chunkStartKey,
      endKey: previousKey,
      dateKeys: chunkDateKeys,
    });
    chunkStartKey = currentKey;
    previousKey = currentKey;
    chunkDateKeys = [currentKey];
  }

  chunks.push({
    startKey: chunkStartKey,
    endKey: previousKey,
    dateKeys: chunkDateKeys,
  });
  return chunks;
}

function isConsecutiveDateKey(previousKey: string, currentKey: string): boolean {
  const previousDayStartMs = resolveHKDayStartUtcMs(previousKey);
  const currentDayStartMs = resolveHKDayStartUtcMs(currentKey);
  if (previousDayStartMs === null || currentDayStartMs === null) {
    return false;
  }

  return currentDayStartMs - previousDayStartMs === TIME.MILLISECONDS_PER_DAY;
}

function resolveMonthKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

function resolveDateFromHKDateKey(dayKey: string): Date {
  const dayStartUtcMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartUtcMs === null) {
    throw createTradingCalendarPrewarmError({
      code: 'TRADING_CALENDAR_INVALID_DATE_KEY',
      message: `[交易日历快照] 无法解析日期键: ${dayKey}`,
      details: { dateKey: dayKey },
    });
  }

  return new Date(dayStartUtcMs);
}
