/** 保护性清仓 V1 完成记录冷却恢复测试。 */
import { describe, expect, it } from 'bun:test';
import { createTradeLogHydrator } from '../../../src/application/protectiveLiquidation/tradeLogHydrator.js';
import { createLiquidationCooldownTracker } from '../../../src/domain/liquidation/cooldown/index.js';
import type { ProtectiveLiquidationCompletionRecordV1 } from '../../../src/types/tradeLog.js';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';

function createRecord(boundaryExecutedTimeMs: number): ProtectiveLiquidationCompletionRecordV1 {
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
    schemaVersion: 1,
    completionId: `v1:2026-07-11:HSI.HK:LONG:${String(boundaryExecutedTimeMs)}`,
    tradingDayKey: '2026-07-11',
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    boundaryExecutedTimeMs,
    orderBaselines: [],
  };
}

describe('tradeLogHydrator business flow', () => {
  it('restores the current trigger cycle and active cooldown from strict V1 completion records', () => {
    const first = Date.parse('2026-07-11T02:00:00.000Z');
    const second = Date.parse('2026-07-11T02:01:00.000Z');
    const tracker = createLiquidationCooldownTracker();
    const records = [createRecord(first), createRecord(second)];
    const hydrator = createTradeLogHydrator({
      nowMs: () => second + 60_000,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfig({
          monitorSymbol: 'HSI.HK',
          liquidationTriggerLimit: 2,
          liquidationCooldown: { mode: 'minutes', minutes: 5 },
        }),
      }),
      liquidationCooldownTracker: tracker,
      mixedTradeLogRepository: {
        loadCompletionRecords: () => records,
      },
    });

    hydrator.hydrate();
    expect(
      tracker.getRemainingMs({
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
        currentTimeMs: second + 60_000,
      }),
    ).toBe(240_000);
  });

  for (const restartMinute of [7, 10]) {
    it(`does not restore an expired trigger count when restarting at 10:${String(restartMinute).padStart(2, '0')}`, () => {
      const first = Date.parse('2026-07-11T10:00:00+08:00');
      const currentTimeMs = first + restartMinute * 60_000;
      const cooldownConfig = { mode: 'minutes' as const, minutes: 5 };
      const tracker = createLiquidationCooldownTracker();
      const hydrator = createTradeLogHydrator({
        nowMs: () => currentTimeMs,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        tradingConfig: createTradingConfig({
          monitor: createMonitorConfig({
            monitorSymbol: 'HSI.HK',
            liquidationTriggerLimit: 3,
            liquidationCooldown: cooldownConfig,
          }),
        }),
        liquidationCooldownTracker: tracker,
        mixedTradeLogRepository: {
          loadCompletionRecords: () =>
            [0, 1, 2].map((minute) => createRecord(first + minute * 60_000)),
        },
      });
      // 10:07 恰好到期，10:10 已过期；两者都必须从新周期零计数启动。
      hydrator.hydrate();
      expect(tracker.getRemainingMs({ direction: 'LONG', cooldownConfig, currentTimeMs })).toBe(0);
      for (const completionNumber of [1, 2, 3]) {
        const executedTimeMs = currentTimeMs + (completionNumber - 1) * 60_000;
        tracker.recordLiquidationTrigger({
          direction: 'LONG',
          executedTimeMs,
          triggerLimit: 3,
          cooldownConfig,
        });

        expect(
          tracker.getRemainingMs({
            direction: 'LONG',
            cooldownConfig,
            currentTimeMs: executedTimeMs,
          }),
        ).toBe(completionNumber === 3 ? 300_000 : 0);
      }
    });
  }

  it('preserves a new cycle below the trigger limit after the old cooldown expired', () => {
    const first = Date.parse('2026-07-11T10:00:00+08:00');
    const currentTimeMs = first + 10 * 60_000;
    const cooldownConfig = { mode: 'minutes' as const, minutes: 5 };
    const tracker = createLiquidationCooldownTracker();
    const hydrator = createTradeLogHydrator({
      nowMs: () => currentTimeMs,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfig({
          monitorSymbol: 'HSI.HK',
          liquidationTriggerLimit: 3,
          liquidationCooldown: cooldownConfig,
        }),
      }),
      liquidationCooldownTracker: tracker,
      mixedTradeLogRepository: {
        loadCompletionRecords: () =>
          [0, 1, 2, 7, 8].map((minute) => createRecord(first + minute * 60_000)),
      },
    });
    hydrator.hydrate();
    expect(tracker.getRemainingMs({ direction: 'LONG', cooldownConfig, currentTimeMs })).toBe(0);
    // 10:07 与 10:08 属于新周期前两次完成；重启后的这一次是第三次，应立即激活。
    tracker.recordLiquidationTrigger({
      direction: 'LONG',
      executedTimeMs: currentTimeMs,
      triggerLimit: 3,
      cooldownConfig,
    });

    expect(tracker.getRemainingMs({ direction: 'LONG', cooldownConfig, currentTimeMs })).toBe(
      300_000,
    );
  });

  it('uses one captured timestamp for both the recovery day and remaining cooldown', () => {
    const boundary = Date.parse('2026-07-11T02:00:00.000Z');
    let clockReads = 0;
    const tracker = createLiquidationCooldownTracker();
    const hydrator = createTradeLogHydrator({
      nowMs: () => {
        clockReads += 1;
        return clockReads === 1 ? boundary + 60_000 : boundary + 24 * 60 * 60_000;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfig({
          monitorSymbol: 'HSI.HK',
          liquidationTriggerLimit: 1,
          liquidationCooldown: { mode: 'minutes', minutes: 5 },
        }),
      }),
      liquidationCooldownTracker: tracker,
      mixedTradeLogRepository: {
        loadCompletionRecords: (dayKey) => {
          expect(dayKey).toBe('2026-07-11');
          return [createRecord(boundary)];
        },
      },
    });
    hydrator.hydrate();
    expect(clockReads).toBe(1);
    expect(
      tracker.getRemainingMs({
        direction: 'LONG',
        cooldownConfig: { mode: 'minutes', minutes: 5 },
        currentTimeMs: boundary + 60_000,
      }),
    ).toBe(240_000);
  });

  it('rejects a completion record from another monitor', () => {
    const nowMs = Date.parse('2026-07-11T02:00:00.000Z');
    const tracker = createLiquidationCooldownTracker();
    const hydrator = createTradeLogHydrator({
      nowMs: () => nowMs,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tradingConfig: createTradingConfig({
        monitor: createMonitorConfig({ monitorSymbol: 'HSI.HK' }),
      }),
      liquidationCooldownTracker: tracker,
      mixedTradeLogRepository: {
        loadCompletionRecords: () => [{ ...createRecord(nowMs), monitorSymbol: 'MHI.HK' }],
      },
    });

    expect(() => {
      hydrator.hydrate();
    }).toThrow(/monitorSymbol mismatch/);
  });
});
