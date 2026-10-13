/**
 * 末日窗口领域规则
 *
 * 职责：保持正常日/半日市的拒买与清仓接管边界，裁剪窗口内允许的下一次重评估；不读取行情或持有 timer。
 */
import { DOOMSDAY, TIME } from '../../../constants/index.js';
import {
  getHKDateKey,
  getRequiredHKDateKey,
  getHKTime,
  resolveHKDayStartUtcMs,
} from '../../../utils/time/index.js';

/**
 * 计算末日业务允许的下一次重评估时刻，所有等待都必须严格早于当日收盘。
 * @param currentTime 本次决策时间
 * @param isHalfDay 是否为半日市
 * @param candidateRetryAtMs 候选重评估时刻
 * @returns 有效的未来且收盘前时刻；无效或越界时返回 null
 */
export function resolveDoomsdayRetryAtMs(
  currentTime: Date,
  isHalfDay: boolean,
  candidateRetryAtMs: number | null,
): number | null {
  const currentMs = currentTime.getTime();
  if (
    !Number.isFinite(currentMs) ||
    candidateRetryAtMs === null ||
    !Number.isFinite(candidateRetryAtMs) ||
    candidateRetryAtMs <= currentMs
  ) {
    return null;
  }

  const dayKey = getHKDateKey(currentTime);
  if (dayKey === null) {
    return null;
  }

  const dayStartMs = resolveHKDayStartUtcMs(dayKey);
  if (dayStartMs === null) {
    return null;
  }

  const closeMinuteOfDay = isHalfDay ? 12 * 60 : 16 * 60;
  const closeMs = dayStartMs + closeMinuteOfDay * TIME.MILLISECONDS_PER_MINUTE;
  return candidateRetryAtMs < closeMs ? candidateRetryAtMs : null;
}

/**
 * 计算当日拒买与清仓接管入口，供系统级 planner 安排具名时间唤醒。
 * @param date 当前权威评估时间
 * @param isHalfDay 是否为半日市
 * @returns 按拒买、接管顺序排列的当日窗口入口
 */
export function resolveDoomsdayWindowEntryMs(
  date: Date,
  isHalfDay: boolean,
): ReadonlyArray<number> {
  const dayStartMs = resolveHKDayStartUtcMs(getRequiredHKDateKey(date));
  if (dayStartMs === null) {
    return [];
  }

  const closeMinuteOfDay = isHalfDay ? 12 * 60 : 16 * 60;
  return [
    dayStartMs +
      (closeMinuteOfDay - DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE) * TIME.MILLISECONDS_PER_MINUTE,
    dayStartMs +
      (closeMinuteOfDay - DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE) *
        TIME.MILLISECONDS_PER_MINUTE,
  ];
}

/**
 * 判断是否处于末日保护的买入截止窗口。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 处于买入截止窗口时返回 true，否则返回 false
 */
export function isWithinDoomsdayBuyCutoffWindow(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 判断香港当日是否已经达到末日保护买入截止起点。
 * 与撤单窗口不同，本判定一旦达到截止起点便持续到香港日期结束，专供最终 broker mutation 前拒买授权使用。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日
 * @returns 已达到正常日 15:45 或半日市 11:45 时返回 true
 */
export function hasReachedDoomsdayBuyCutoff(
  date: Date | null | undefined,
  isHalfDay: boolean,
): boolean {
  if (!date) {
    return false;
  }

  const hkTime = getHKTime(date);
  if (!hkTime) {
    return false;
  }

  const closeHour = isHalfDay ? 12 : 16;
  const cutoffMinutes = closeHour * 60 - DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE;
  const currentMinutes = hkTime.hkHour * 60 + hkTime.hkMinute;
  return currentMinutes >= cutoffMinutes;
}

/**
 * 判断是否处于末日保护的清仓接管窗口。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 处于清仓接管窗口时返回 true，否则返回 false
 */
export function isWithinDoomsdayClearanceTakeoverWindow(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 获取买入截止窗口的人类可读时间范围字符串。默认行为：半日市按 12:00 收盘计算，正常日按 16:00 收盘计算。
 *
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:45-16:00` / `11:45-12:00`
 */
export function getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay: boolean): string {
  return formatBeforeCloseWindowRange(DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 获取清仓接管窗口的人类可读时间范围字符串。默认行为：半日市按 12:00 收盘计算，正常日按 16:00 收盘计算。
 *
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:55-16:00` / `11:55-12:00`
 */
export function getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay: boolean): string {
  return formatBeforeCloseWindowRange(DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 判断是否在当日收盘前指定分钟数内（用于末日保护等）。半日市按 12:00 收盘，正常日按 16:00。
 *
 * @param date 时间对象（UTC）
 * @param minutes 距离收盘的分钟数（正数）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前该分钟数窗口内返回 true，否则返回 false
 */
function isBeforeCloseMinutes(
  date: Date | null | undefined,
  minutes: number,
  isHalfDay: boolean = false,
): boolean {
  if (!date || !Number.isFinite(minutes) || minutes <= 0) {
    return false;
  }

  const hkTime = getHKTime(date);
  if (!hkTime) {
    return false;
  }

  const closeHour = isHalfDay ? 12 : 16;
  const closeMinutes = closeHour * 60;
  const currentMinutes = hkTime.hkHour * 60 + hkTime.hkMinute;

  return currentMinutes >= closeMinutes - minutes && currentMinutes < closeMinutes;
}

/**
 * 将“距收盘前 N 分钟”的窗口格式化为人类可读时间范围。默认行为：minutes 非正数时返回收盘时刻范围。
 *
 * @param minutes 距离收盘的分钟数（正数）
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:45-16:00`
 */
function formatBeforeCloseWindowRange(minutes: number, isHalfDay: boolean): string {
  const closeHour = isHalfDay ? 12 : 16;
  const closeTotalMinutes = closeHour * 60;
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  const startTotalMinutes = closeTotalMinutes - safeMinutes;
  return `${formatHourMinute(startTotalMinutes)}-${formatHourMinute(closeTotalMinutes)}`;
}

/**
 * 将分钟数格式化为 `HH:mm` 字符串。
 *
 * @param totalMinutes 自午夜以来的分钟数
 * @returns 固定两位小时与分钟的时间字符串
 */
function formatHourMinute(totalMinutes: number): string {
  const normalizedTotalMinutes = Math.max(0, Math.trunc(totalMinutes));
  const hour = Math.floor(normalizedTotalMinutes / 60);
  const minute = normalizedTotalMinutes % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}
