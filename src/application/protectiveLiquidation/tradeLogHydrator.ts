/**
 * 保护性清仓完成记录水化器
 *
 * 职责：严格读取 V1 completion records，恢复当日触发计数与仍有效冷却。
 */
import { getHKDateKey } from '../../utils/time/index.js';
import type { ProtectiveLiquidationCompletionRecordV1 } from '../../types/tradeLog.js';
import type { TradeLogHydrator, TradeLogHydratorDeps } from './types.js';
import {
  resolveCooldownEndMs,
  resolveRemainingCooldownMs,
  simulateTriggerCycle,
} from '../../domain/liquidation/cooldown/rules.js';

/** 创建仅接受 V1 completion records 的冷却恢复器。 */
export function createTradeLogHydrator(deps: TradeLogHydratorDeps): TradeLogHydrator {
  const { nowMs, logger, tradingConfig, liquidationCooldownTracker, mixedTradeLogRepository } =
    deps;
  const monitorConfig = tradingConfig.monitor;

  function loadCompletionRecords(
    currentTimeMs: number,
  ): ReadonlyArray<ProtectiveLiquidationCompletionRecordV1> {
    const tradingDayKey = getHKDateKey(new Date(currentTimeMs));
    if (tradingDayKey === null) {
      throw new Error('[清仓冷却] 当前交易日键无法解析');
    }

    return mixedTradeLogRepository.loadCompletionRecords(tradingDayKey);
  }

  function hydrate(): void {
    const currentTimeMs = nowMs();
    const records = loadCompletionRecords(currentTimeMs);
    const grouped = new Map<'LONG' | 'SHORT', ProtectiveLiquidationCompletionRecordV1[]>();
    for (const record of records) {
      if (record.monitorSymbol !== monitorConfig.monitorSymbol) {
        throw new Error(
          `[清仓冷却] completion monitorSymbol mismatch: ${record.monitorSymbol} !== ${monitorConfig.monitorSymbol}`,
        );
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
          executedAtMs: record.boundaryExecutedTimeMs,
        })),
        triggerLimit: monitorConfig.liquidationTriggerLimit,
        cooldownConfig,
      });
      // 已结束的冷却周期不恢复起点或旧计数；尚未达到上限的新周期计数仍须保留。
      if (
        cycleResult.cooldownExecutedTimeMs !== null &&
        resolveRemainingCooldownMs(
          resolveCooldownEndMs(cycleResult.cooldownExecutedTimeMs, cooldownConfig),
          currentTimeMs,
        ) <= 0
      ) {
        continue;
      }

      if (cycleResult.currentCount > 0) {
        liquidationCooldownTracker.restoreTriggerCount({
          direction,
          count: cycleResult.currentCount,
        });
      }

      if (cycleResult.cooldownExecutedTimeMs === null) {
        continue;
      }

      liquidationCooldownTracker.recordCooldown({
        direction,
        executedTimeMs: cycleResult.cooldownExecutedTimeMs,
      });
      restoredCooldownCount += 1;
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCooldownCount}`);
  }

  return {
    hydrate,
  };
}
