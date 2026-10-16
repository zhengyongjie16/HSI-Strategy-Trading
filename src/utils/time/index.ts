import { HK_DATE_KEY_PATTERN, TIME } from '../../constants/index.js';
import type { HKTime } from './types.js';

/**
 * 解析香港时间各组成部分，供不同格式化函数复用。
 *
 * @param date 调用方明确提供的时间对象
 * @returns 香港时间各组成部分
 */
function getHongKongDateTimeParts(date: Date): Readonly<{
  year: number;
  month: string;
  day: string;
  hours: string;
  minutes: string;
  seconds: string;
  milliseconds: string;
}> {
  const hkTime = new Date(date.getTime() + TIME.HONG_KONG_TIMEZONE_OFFSET_MS);

  return {
    year: hkTime.getUTCFullYear(),
    month: String(hkTime.getUTCMonth() + 1).padStart(2, '0'),
    day: String(hkTime.getUTCDate()).padStart(2, '0'),
    hours: String(hkTime.getUTCHours()).padStart(2, '0'),
    minutes: String(hkTime.getUTCMinutes()).padStart(2, '0'),
    seconds: String(hkTime.getUTCSeconds()).padStart(2, '0'),
    milliseconds: String(hkTime.getUTCMilliseconds()).padStart(3, '0'),
  };
}

/**
 * 将显式时间转换为香港时间（UTC+8）格式字符串，不自行读取系统时钟。
 *
 * @param date 调用方明确提供的时间对象
 * @returns 香港时间字符串 YYYY/MM/DD/HH:mm:ss
 */
export function toHongKongTimeIso(date: Date): string {
  const { year, month, day, hours, minutes, seconds } = getHongKongDateTimeParts(date);
  return `${year}/${month}/${day}/${hours}:${minutes}:${seconds}`;
}

/**
 * 将显式时间转换为香港时间（UTC+8）的日志格式字符串，不自行读取系统时钟。
 *
 * @param date 调用方明确提供的时间对象
 * @returns 香港时间字符串 YYYY-MM-DD HH:mm:ss.sss
 */
export function toHongKongTimeLog(date: Date): string {
  const { year, month, day, hours, minutes, seconds, milliseconds } =
    getHongKongDateTimeParts(date);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * 将 UTC 时间转换为香港时区（UTC+8）的小时与分钟。
 * 默认行为：date 为 null/undefined 时返回 null。
 *
 * @param date 时间对象（UTC）
 * @returns 香港时区的小时与分钟（hkHour、hkMinute），无效时返回 null
 */
export function getHKTime(date: Date | null | undefined): HKTime | null {
  if (!date) {
    return null;
  }

  const { hours, minutes } = getHongKongDateTimeParts(date);
  return {
    hkHour: Number(hours),
    hkMinute: Number(minutes),
  };
}

/**
 * 将非空时间转换为香港日历日期键。
 *
 * @param date 待转换的时间对象
 * @returns UTC+8 下 YYYY-MM-DD 格式的日期键
 */
function buildHKDateKey(date: Date): string {
  const { year, month, day } = getHongKongDateTimeParts(date);
  return `${year}-${month}-${day}`;
}

/**
 * 获取港股日期键（UTC+8，YYYY-MM-DD）。
 * 默认行为：date 为 null/undefined 时返回 null。
 *
 * @param date 时间对象
 * @returns YYYY-MM-DD 格式日期键，无效时返回 null
 */
export function getHKDateKey(date: Date | null | undefined): string | null {
  if (!date) {
    return null;
  }

  return buildHKDateKey(date);
}

/**
 * 获取非空 Date 的港股日期键（UTC+8，YYYY-MM-DD）。
 *
 * @param date 已确认非空的时间对象
 * @returns YYYY-MM-DD 格式日期键
 */
export function getRequiredHKDateKey(date: Date): string {
  return buildHKDateKey(date);
}

/**
 * 解析香港日期键并返回该日 00:00 对应的 UTC 毫秒时间戳。
 * 单一来源，供日期枚举、交易会话规则及 lifecycle 等模块使用。
 *
 * @param dayKey 港股日期键（YYYY-MM-DD）
 * @returns 对应 UTC 毫秒时间戳，非法日期键返回 null
 */
export function resolveHKDayStartUtcMs(dayKey: string): number | null {
  const match = HK_DATE_KEY_PATTERN.exec(dayKey);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const utcMs = Date.UTC(year, month - 1, day) - TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  if (!Number.isFinite(utcMs)) {
    return null;
  }

  return utcMs;
}

/**
 * 枚举起止时间区间覆盖的港股日期键列表（含首尾日期）。
 *
 * @param startMs 区间起点毫秒时间戳
 * @param endMs 区间终点毫秒时间戳
 * @returns 升序日期键数组
 */
export function listHKDateKeysBetween(startMs: number, endMs: number): ReadonlyArray<string> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }

  const startKey = getHKDateKey(new Date(startMs));
  const endKey = getHKDateKey(new Date(endMs));
  if (!startKey || !endKey) {
    return [];
  }

  const startDayStartUtcMs = resolveHKDayStartUtcMs(startKey);
  const endDayStartUtcMs = resolveHKDayStartUtcMs(endKey);
  if (startDayStartUtcMs === null || endDayStartUtcMs === null) {
    return [];
  }

  const keys: string[] = [];
  for (
    let cursorDayStartUtcMs = startDayStartUtcMs;
    cursorDayStartUtcMs <= endDayStartUtcMs;
    cursorDayStartUtcMs += TIME.MILLISECONDS_PER_DAY
  ) {
    const key = getHKDateKey(new Date(cursorDayStartUtcMs));
    if (key) {
      keys.push(key);
    }
  }

  return keys;
}
