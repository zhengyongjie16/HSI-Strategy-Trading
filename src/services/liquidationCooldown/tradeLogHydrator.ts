/**
 * 保护性清仓完成记录水化器
 *
 * 职责：严格读取 V1 completion records，恢复当日触发计数与仍有效冷却。
 */
import { getHKDateKey } from '../../utils/time/index.js';
import type { ProtectiveLiquidationCompletionRecordV1 } from '../mixedTradeLogRepository/types.js';
import type { TradeLogHydrator, TradeLogHydratorDeps } from './types.js';
import { resolveCooldownEndMs, resolveRemainingCooldownMs, simulateTriggerCycle } from './utils.js';

/** 创建仅接受 V1 completion records 的冷却恢复器。 */
export function createTradeLogHydrator(deps: TradeLogHydratorDeps): TradeLogHydrator {
  const { nowMs, logger, tradingConfig, liquidationCooldownTracker, mixedTradeLogRepository } =
    deps;
  const monitorConfig = tradingConfig.monitor;

  function loadCompletionRecords(): ReadonlyArray<ProtectiveLiquidationCompletionRecordV1> {
    const currentTimeMs = nowMs();
    const tradingDayKey = getHKDateKey(new Date(currentTimeMs));
    if (tradingDayKey === null) {
      throw new Error('[清仓冷却] 当前交易日键无法解析');
    }

    return mixedTradeLogRepository.loadCompletionRecords(tradingDayKey);
  }

  function hydrate(): ReadonlyMap<'LONG' | 'SHORT', number> {
    const currentTimeMs = nowMs();
    const records = loadCompletionRecords();
    const latestBoundaryByDirection = new Map<'LONG' | 'SHORT', number>();
    const grouped = new Map<'LONG' | 'SHORT', ProtectiveLiquidationCompletionRecordV1[]>();
    for (const record of records) {
      if (record.monitorSymbol !== monitorConfig.monitorSymbol) {
        throw new Error(
          `[清仓冷却] completion monitorSymbol mismatch: ${record.monitorSymbol} !== ${monitorConfig.monitorSymbol}`,
        );
      }

      const previousBoundary = latestBoundaryByDirection.get(record.direction);
      if (previousBoundary === undefined || record.boundaryExecutedTimeMs > previousBoundary) {
        latestBoundaryByDirection.set(record.direction, record.boundaryExecutedTimeMs);
      }

      const group = grouped.get(record.direction);
      if (group === undefined) {
        grouped.set(record.direction, [record]);
      } else {
        group.push(record);
      }
    }

    let restoredCooldownCount = 0;
    for (const [direction, group] of grouped) {
      group.sort((left, right) => left.boundaryExecutedTimeMs - right.boundaryExecutedTimeMs);
      const cooldownConfig = monitorConfig.liquidationCooldown;
      if (cooldownConfig === null) {
        continue;
      }

      const cycleResult = simulateTriggerCycle({
        records: group.map((record) => ({
          direction,
          executedAtMs: record.boundaryExecutedTimeMs,
          monitorSymbol: record.monitorSymbol,
        })),
        triggerLimit: monitorConfig.liquidationTriggerLimit,
        cooldownConfig,
      });
      if (cycleResult.currentCount > 0) {
        liquidationCooldownTracker.restoreTriggerCount({
          direction,
          count: cycleResult.currentCount,
        });
      }

      if (cycleResult.cooldownExecutedTimeMs === null) {
        continue;
      }

      const cooldownEndMs = resolveCooldownEndMs(
        cycleResult.cooldownExecutedTimeMs,
        cooldownConfig,
      );
      if (resolveRemainingCooldownMs(cooldownEndMs, currentTimeMs) <= 0) {
        continue;
      }

      liquidationCooldownTracker.recordCooldown({
        direction,
        executedTimeMs: cycleResult.cooldownExecutedTimeMs,
      });
      restoredCooldownCount += 1;
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCooldownCount}`);
    return latestBoundaryByDirection;
  }

  return {
    hydrate,
  };
}
