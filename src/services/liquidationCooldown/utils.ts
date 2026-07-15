import { TIME } from '../../constants/index.js';
import { getHKTime } from '../../utils/time/index.js';
import type { LiquidationCooldownConfig } from '../../types/config.js';
import type { CooldownCandidate } from './types.js';

/**
 * 将分钟转换为毫秒，非正数返回 0。
 *
 * @param minutes 分钟数
 * @returns 对应的毫秒数，非正数时返回 0
 */
function convertMinutesToMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }

  return Math.floor(minutes * 60_000);
}

/**
 * 基于香港时区日期计算目标时间的 UTC 毫秒。
 *
 * @param params.baseTimestampMs 基准时间戳（UTC 毫秒）
 * @param params.hour 目标香港时间小时
 * @param params.minute 目标香港时间分钟
 * @param params.dayOffset 日期偏移天数，默认为 0
 * @returns 目标时间的 UTC 毫秒，baseTimestampMs 无效时返回 null
 */
function resolveHongKongTimeMs({
  baseTimestampMs,
  hour,
  minute,
  dayOffset = 0,
}: {
  readonly baseTimestampMs: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOffset?: number;
}): number | null {
  if (!Number.isFinite(baseTimestampMs)) {
    return null;
  }

  const offsetMs = TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  const hkDate = new Date(baseTimestampMs + offsetMs);
  const year = hkDate.getUTCFullYear();
  const month = hkDate.getUTCMonth();
  const day = hkDate.getUTCDate() + dayOffset;
  const targetHkMs = Date.UTC(year, month, day, hour, minute, 0, 0);
  return targetHkMs - offsetMs;
}

/**
 * 根据清仓成交时间与冷却模式计算冷却结束时间戳。
 * 默认行为：cooldownConfig 为 null 或 executedTimeMs 无效时返回 null。
 * 按 mode 行为：minutes 按配置分钟数在成交时间上叠加；one-day 为下一自然日 00:00（香港时间）；half-day 为上午清仓冷却到当日 13:00、下午清仓冷却到次日 00:00（香港时间）。
 *
 * @param executedTimeMs 保护性清仓成交时间戳（毫秒）
 * @param cooldownConfig 冷却配置，null 时返回 null
 * @returns 冷却结束时间戳（毫秒），无效时 null
 */
export function resolveCooldownEndMs(
  executedTimeMs: number,
  cooldownConfig: LiquidationCooldownConfig | null,
): number | null {
  if (!Number.isFinite(executedTimeMs) || !cooldownConfig) {
    return null;
  }

  if (cooldownConfig.mode === 'minutes') {
    const cooldownMs = convertMinutesToMs(cooldownConfig.minutes);
    if (cooldownMs <= 0) {
      return null;
    }

    return executedTimeMs + cooldownMs;
  }

  if (cooldownConfig.mode === 'one-day') {
    return resolveHongKongTimeMs({
      baseTimestampMs: executedTimeMs,
      hour: 0,
      minute: 0,
      dayOffset: 1,
    });
  }

  const hkTime = getHKTime(new Date(executedTimeMs));
  if (!hkTime) {
    return null;
  }

  if (hkTime.hkHour < 12) {
    return resolveHongKongTimeMs({
      baseTimestampMs: executedTimeMs,
      hour: 13,
      minute: 0,
      dayOffset: 0,
    });
  }

  return resolveHongKongTimeMs({
    baseTimestampMs: executedTimeMs,
    hour: 0,
    minute: 0,
    dayOffset: 1,
  });
}

/**
 * 模拟触发-冷却周期，计算当前周期计数与当前周期冷却激活时间。
 * 当记录时间跨过冷却结束时间时，视为进入新周期并重置计数。
 *
 * @param params.records 按时间升序排列的保护性清仓记录
 * @param params.triggerLimit 触发上限
 * @param params.cooldownConfig 冷却配置
 * @returns 当前周期快照：
 * - currentCount: 当前周期触发计数；
 * - cooldownExecutedTimeMs: 当前周期最后一次冷却激活时间（null 表示当前周期未激活冷却）
 */
export function simulateTriggerCycle({
  records,
  triggerLimit,
  cooldownConfig,
}: {
  readonly records: ReadonlyArray<CooldownCandidate>;
  readonly triggerLimit: number;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
}): {
  readonly currentCount: number;
  readonly cooldownExecutedTimeMs: number | null;
} {
  if (records.length === 0 || triggerLimit <= 0) {
    return {
      currentCount: 0,
      cooldownExecutedTimeMs: null,
    };
  }

  let count = 0;
  let cooldownEndMs = 0;
  let lastCooldownTimeMs: number | null = null;

  for (const record of records) {
    if (cooldownEndMs > 0 && record.executedAtMs >= cooldownEndMs) {
      count = 0;
      cooldownEndMs = 0;
      lastCooldownTimeMs = null;
    }

    if (cooldownEndMs > 0 && record.executedAtMs < cooldownEndMs) {
      continue;
    }

    count += 1;

    if (count < triggerLimit) {
      continue;
    }

    const endMs = resolveCooldownEndMs(record.executedAtMs, cooldownConfig);
    if (endMs === null || !Number.isFinite(endMs)) {
      cooldownEndMs = 0;
      lastCooldownTimeMs = null;
      continue;
    }

    cooldownEndMs = endMs;
    lastCooldownTimeMs = record.executedAtMs;
  }

  return {
    currentCount: count,
    cooldownExecutedTimeMs: lastCooldownTimeMs,
  };
}

/**
 * 根据冷却结束时间与当前时间计算剩余冷却毫秒数。
 *
 * @param cooldownEndMs 冷却结束时间戳
 * @param currentTimeMs 当前时间戳
 * @returns 剩余毫秒数；已过期或无效时返回 0
 */
export function resolveRemainingCooldownMs(
  cooldownEndMs: number | null,
  currentTimeMs: number,
): number {
  if (cooldownEndMs === null || !Number.isFinite(cooldownEndMs)) {
    return 0;
  }

  const remainingMs = cooldownEndMs - currentTimeMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return 0;
  }

  return remainingMs;
}
