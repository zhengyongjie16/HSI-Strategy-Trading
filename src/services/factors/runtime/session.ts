/**
 * factor runtime session 辅助模块
 *
 * 职责：
 * - 统一处理香港交易时段、session 分段与噪音窗口判定
 * - 为趋势、VWAP 与结构层提供一致的时间轴切片逻辑
 */
import type { NormalizedBar } from './types.js';
import type { TradingSessionPhase } from '../../../types/factor.js';

const HONG_KONG_TIMEZONE = 'Asia/Hong_Kong';
export const MORNING_SESSION_START = 9 * 60 + 30;
export const MORNING_SESSION_END = 12 * 60;
export const AFTERNOON_SESSION_START = 13 * 60;
export const AFTERNOON_SESSION_END = 16 * 60;

/**
 * 香港时间拆分结果。
 * 类型用途：承载 dayKey 与 minuteOfDay，供 session 判定与分时切片使用。
 * 数据来源：由 Intl.DateTimeFormat 按香港时区格式化得到。
 * 使用范围：factor runtime 内部 helper。
 */
type HongKongParts = {
  readonly dayKey: string;
  readonly minuteOfDay: number;
};

/**
 * 读取香港时区日期和分钟数。
 *
 * @param timestamp 时间戳
 * @returns 香港日期键与日内分钟数
 */
export function getHongKongParts(timestamp: number): HongKongParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: HONG_KONG_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  let year = '';
  let month = '';
  let day = '';
  let hour = '';
  let minute = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
      continue;
    }

    if (part.type === 'month') {
      month = part.value;
      continue;
    }

    if (part.type === 'day') {
      day = part.value;
      continue;
    }

    if (part.type === 'hour') {
      hour = part.value;
      continue;
    }

    if (part.type === 'minute') {
      minute = part.value;
    }
  }

  return {
    dayKey: `${year}-${month}-${day}`,
    minuteOfDay: Number(hour) * 60 + Number(minute),
  };
}

/**
 * 将分钟数映射到交易 session。
 *
 * @param minuteOfDay 香港时间分钟数
 * @returns session 标识
 */
export function getSessionPhase(minuteOfDay: number): TradingSessionPhase {
  if (minuteOfDay >= MORNING_SESSION_START && minuteOfDay < MORNING_SESSION_END) {
    return 'am';
  }

  if (minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay < AFTERNOON_SESSION_END) {
    return 'pm';
  }

  return 'closed';
}

/**
 * 按香港日期键过滤 bars。
 *
 * @param bars 归一化后的 K 线集合
 * @param dayKey 香港日期键
 * @returns 指定交易日的 bars
 */
export function filterBarsByDayKey(
  bars: ReadonlyArray<NormalizedBar>,
  dayKey: string,
): ReadonlyArray<NormalizedBar> {
  return bars.filter((bar) => getHongKongParts(bar.timestamp).dayKey === dayKey);
}

/**
 * 按 session 过滤 bars。
 *
 * @param bars 归一化后的 K 线集合
 * @param session 交易 session
 * @returns 指定 session 的 bars
 */
export function filterBarsBySession(
  bars: ReadonlyArray<NormalizedBar>,
  session: Exclude<TradingSessionPhase, 'closed'>,
): ReadonlyArray<NormalizedBar> {
  return bars.filter((bar) => {
    const { minuteOfDay } = getHongKongParts(bar.timestamp);
    return getSessionPhase(minuteOfDay) === session;
  });
}

/**
 * 收集历史交易日键。
 *
 * @param params bars/currentDayKey/lookbackDays
 * @returns 历史交易日键数组
 */
export function collectRecentTradingDayKeys(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly currentDayKey: string;
  readonly lookbackDays: number;
}): ReadonlyArray<string> {
  const maxDays = Math.max(0, Math.floor(params.lookbackDays));
  if (maxDays === 0) {
    return [];
  }

  const dayKeys: string[] = [];
  const seen = new Set<string>();
  for (let index = params.bars.length - 1; index >= 0; index -= 1) {
    const bar = params.bars[index];
    if (!bar) {
      continue;
    }

    const { dayKey } = getHongKongParts(bar.timestamp);
    if (dayKey === params.currentDayKey || seen.has(dayKey)) {
      continue;
    }

    seen.add(dayKey);
    dayKeys.push(dayKey);
    if (dayKeys.length >= maxDays) {
      break;
    }
  }

  return dayKeys;
}

/**
 * 提取指定交易日、指定 session、截至某分钟的 bars。
 *
 * @param params bars/dayKey/session/cutoffMinuteOfDay
 * @returns 过滤后的 bars
 */
export function sliceSessionBarsForDay(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly dayKey: string;
  readonly session: Exclude<TradingSessionPhase, 'closed'>;
  readonly cutoffMinuteOfDay: number;
}): ReadonlyArray<NormalizedBar> {
  return params.bars.filter((bar) => {
    const { dayKey, minuteOfDay } = getHongKongParts(bar.timestamp);
    if (dayKey !== params.dayKey) {
      return false;
    }

    if (params.session === 'am') {
      return minuteOfDay >= MORNING_SESSION_START && minuteOfDay <= params.cutoffMinuteOfDay;
    }

    return minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay <= params.cutoffMinuteOfDay;
  });
}

/**
 * 判定是否处于策略噪音窗口。
 *
 * @param params 时间戳与开盘结构规则
 * @returns 是否被噪音窗口拦截
 */
export function isBlockedByNoiseWindow(params: {
  readonly timestamp: number | null;
  readonly rules: {
    readonly morningNoiseWindowMinutes: number;
    readonly afternoonNoiseWindowMinutes: number;
  };
}): boolean {
  if (params.timestamp === null) {
    return true;
  }

  const { minuteOfDay } = getHongKongParts(params.timestamp);
  const amNoiseEnd = MORNING_SESSION_START + params.rules.morningNoiseWindowMinutes;
  const pmNoiseEnd = AFTERNOON_SESSION_START + params.rules.afternoonNoiseWindowMinutes;
  return (
    (minuteOfDay >= MORNING_SESSION_START && minuteOfDay < amNoiseEnd) ||
    (minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay < pmNoiseEnd)
  );
}
