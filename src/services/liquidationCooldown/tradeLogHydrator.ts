/**
 * 交易日志冷却恢复模块
 *
 * 功能：
 * - 启动时读取当日成交日志
 * - 按唯一监控标的方向收集保护性清仓完成事件并模拟触发周期
 * - 恢复触发计数器与仍有效的清仓冷却缓存
 */
import type { TradeLogHydrator, TradeLogHydratorDeps, RawRecord } from './types.js';
import type { TradeRecord } from '../../types/trader.js';
import { TRADING } from '../../constants/index.js';
import { isRecord } from '../../utils/helpers/index.js';
import { buildTradeLogPath } from '../../utils/trading/tradeLogPath.js';
import {
  buildCooldownKey,
  resolveCooldownEndMs,
  resolveRemainingCooldownMs,
  simulateTriggerCycle,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from './utils.js';

/**
 * 将 JSON 解析结果规范化为 TradeRecord，对每个字段做类型安全转换；清仓冷却仅依赖结构键值，局部信任 JSON 解析结果。
 * @param raw - 单条日志解析后的未知类型
 * @returns 规范化后的 TradeRecord，无效时 null
 */
function normalizeTradeRecord(raw: unknown): TradeRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawRecord: RawRecord = raw;
  const record: TradeRecord = {
    orderId: toStringOrNull(rawRecord['orderId']),
    symbol: toStringOrNull(rawRecord['symbol']),
    symbolName: toStringOrNull(rawRecord['symbolName']),
    monitorSymbol: toStringOrNull(rawRecord['monitorSymbol']),
    action: toStringOrNull(rawRecord['action']),
    side: toStringOrNull(rawRecord['side']),
    quantity: toStringOrNull(rawRecord['quantity']),
    price: toStringOrNull(rawRecord['price']),
    orderType: toStringOrNull(rawRecord['orderType']),
    status: toStringOrNull(rawRecord['status']),
    error: toStringOrNull(rawRecord['error']),
    reason: toStringOrNull(rawRecord['reason']),
    signalTriggerTime: toStringOrNull(rawRecord['signalTriggerTime']),
    executedAt: toStringOrNull(rawRecord['executedAt']),
    executedAtMs: toNumberOrNull(rawRecord['executedAtMs']),
    timestamp: toStringOrNull(rawRecord['timestamp']),
    isProtectiveClearance: toBooleanOrNull(rawRecord['isProtectiveClearance']),
  };

  return record;
}

function isValidIsoTimestamp(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function resolveProtectiveDirection(action: string | null): 'LONG' | 'SHORT' {
  if (action === 'SELLCALL') {
    return 'LONG';
  }

  if (action === 'SELLPUT') {
    return 'SHORT';
  }

  throw new Error(`[清仓冷却] 保护性清仓完成记录 action 无法解析方向: ${String(action)}`);
}

function assertProtectiveCompletionRecord(
  record: TradeRecord,
  expectedMonitorSymbol: string,
): {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedAtMs: number;
} {
  if (record.monitorSymbol !== expectedMonitorSymbol) {
    throw new Error(
      `[清仓冷却] 保护性清仓完成记录 monitorSymbol 不匹配唯一配置: ` +
        `${String(record.monitorSymbol)} !== ${expectedMonitorSymbol}`,
    );
  }

  if (!isValidIsoTimestamp(record.executedAt)) {
    throw new Error('[清仓冷却] 保护性清仓完成记录 executedAt 无效');
  }

  if (record.executedAtMs === null || !Number.isFinite(record.executedAtMs)) {
    throw new Error('[清仓冷却] 保护性清仓完成记录 executedAtMs 无效');
  }

  return {
    monitorSymbol: record.monitorSymbol,
    direction: resolveProtectiveDirection(record.action),
    executedAtMs: record.executedAtMs,
  };
}

function collectStrictProtectiveRecords(params: {
  readonly tradeRecords: ReadonlyArray<TradeRecord>;
  readonly expectedMonitorSymbol: string;
}): ReadonlyMap<
  string,
  ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly executedAtMs: number;
  }>
> {
  const grouped = new Map<
    string,
    Array<{
      readonly monitorSymbol: string;
      readonly direction: 'LONG' | 'SHORT';
      readonly executedAtMs: number;
    }>
  >();

  for (const record of params.tradeRecords) {
    if (record.reason !== TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON) {
      continue;
    }

    const protectiveRecord = assertProtectiveCompletionRecord(record, params.expectedMonitorSymbol);
    const key = buildCooldownKey(protectiveRecord.monitorSymbol, protectiveRecord.direction);
    const existing = grouped.get(key);
    if (existing !== undefined) {
      existing.push(protectiveRecord);
      continue;
    }

    grouped.set(key, [protectiveRecord]);
  }

  for (const records of grouped.values()) {
    records.sort((left, right) => left.executedAtMs - right.executedAtMs);
  }

  return grouped;
}

/**
 * 创建交易日志冷却恢复器，绑定文件读取、冷却追踪器等依赖，对外暴露 hydrate 方法。
 * @param deps - 依赖（日志目录解析、liquidationCooldownTracker 等）
 * @returns TradeLogHydrator 实例（hydrate 方法用于启动时恢复冷却状态）
 */
export function createTradeLogHydrator(deps: TradeLogHydratorDeps): TradeLogHydrator {
  const {
    readFileSync,
    existsSync,
    resolveLogRootDir,
    nowMs,
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  } = deps;
  const monitorConfig = tradingConfig.monitor;

  /**
   * 读取当日成交日志，按唯一监控标的方向模拟触发-冷却周期并恢复当前状态。
   * 启动时调用一次，用于跨进程重启后恢复触发计数器和未到期冷却。
   */
  function hydrate(): ReadonlyMap<string, number> {
    const latestCompletedBoundaryByDirection = new Map<string, number>();
    const currentTimeMs = nowMs();
    const logFile = buildTradeLogPath(resolveLogRootDir(), new Date(currentTimeMs));
    if (!existsSync(logFile)) {
      logger.info(`[清仓冷却] 当日成交日志不存在，跳过冷却恢复: ${logFile}`);
      return latestCompletedBoundaryByDirection;
    }

    let parsed: unknown;
    try {
      const content = readFileSync(logFile, 'utf8');
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`[清仓冷却] 成交日志解析失败: ${String(error)}`, { cause: error });
    }

    if (!Array.isArray(parsed)) {
      throw new TypeError('[清仓冷却] 成交日志根节点必须为数组');
    }

    const records: TradeRecord[] = [];
    for (const [index, item] of parsed.entries()) {
      const normalized = normalizeTradeRecord(item);
      if (!normalized) {
        throw new TypeError(`[清仓冷却] 第 ${index + 1} 条成交日志记录结构非法`);
      }

      records.push(normalized);
    }

    let restoredCooldownCount = 0;
    const groupedRecords = collectStrictProtectiveRecords({
      tradeRecords: records,
      expectedMonitorSymbol: monitorConfig.monitorSymbol,
    });

    for (const recordGroup of groupedRecords.values()) {
      const firstRecord = recordGroup[0];
      if (!firstRecord) {
        continue;
      }

      const latestRecord = recordGroup.at(-1) ?? null;
      if (latestRecord) {
        latestCompletedBoundaryByDirection.set(
          buildCooldownKey(firstRecord.monitorSymbol, firstRecord.direction),
          latestRecord.executedAtMs,
        );
      }

      const cooldownConfig = monitorConfig.liquidationCooldown;
      if (!cooldownConfig) {
        continue;
      }

      const triggerLimit = monitorConfig.liquidationTriggerLimit;
      const cycleResult = simulateTriggerCycle({
        records: recordGroup,
        triggerLimit,
        cooldownConfig,
      });

      if (cycleResult.cooldownExecutedTimeMs === null) {
        if (cycleResult.currentCount > 0) {
          liquidationCooldownTracker.restoreTriggerCount({
            symbol: firstRecord.monitorSymbol,
            direction: firstRecord.direction,
            count: cycleResult.currentCount,
          });
        }

        continue;
      }

      const cooldownEndMs = resolveCooldownEndMs(
        cycleResult.cooldownExecutedTimeMs,
        cooldownConfig,
      );
      const remainingMs = resolveRemainingCooldownMs(cooldownEndMs, currentTimeMs);
      if (remainingMs > 0) {
        if (cycleResult.currentCount > 0) {
          liquidationCooldownTracker.restoreTriggerCount({
            symbol: firstRecord.monitorSymbol,
            direction: firstRecord.direction,
            count: cycleResult.currentCount,
          });
        }

        liquidationCooldownTracker.recordCooldown({
          symbol: firstRecord.monitorSymbol,
          direction: firstRecord.direction,
          executedTimeMs: cycleResult.cooldownExecutedTimeMs,
        });
        restoredCooldownCount += 1;
        logger.info(
          `[清仓冷却] 恢复 ${firstRecord.monitorSymbol}:${firstRecord.direction} 冷却，` +
            `当前周期触发 ${cycleResult.currentCount}/${triggerLimit}，` +
            `剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        );
      }
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCooldownCount}`);
    return latestCompletedBoundaryByDirection;
  }

  return {
    hydrate,
  };
}
