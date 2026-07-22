/** 保护性清仓 V1 完成记录冷却恢复测试。 */
import { describe, expect, it } from 'bun:test';
import { createTradeLogHydrator } from '../../../src/services/liquidationCooldown/tradeLogHydrator.js';
import { createLiquidationCooldownTracker } from '../../../src/services/liquidationCooldown/index.js';
import type { ProtectiveLiquidationCompletionRecordV1 } from '../../../src/services/mixedTradeLogRepository/types.js';
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
  it('restores the latest boundary and active cooldown from strict V1 records', () => {
    const first = Date.parse('2026-07-11T02:00:00.000Z');
    const second = Date.parse('2026-07-11T02:01:00.000Z');
    const tracker = createLiquidationCooldownTracker({ nowMs: () => second + 60_000 });
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

  it('rejects a completion record from another monitor', () => {
    const nowMs = Date.parse('2026-07-11T02:00:00.000Z');
    const tracker = createLiquidationCooldownTracker({ nowMs: () => nowMs });
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
