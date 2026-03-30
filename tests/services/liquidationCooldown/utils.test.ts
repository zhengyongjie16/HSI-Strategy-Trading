/**
 * liquidationCooldown utils 业务测试
 *
 * 功能：
 * - 验证保护性清仓记录分组与触发周期模拟算法。
 */
import { describe, expect, it } from 'bun:test';
import { TRADING } from '../../../src/constants/index.js';

import type { TradeRecord } from '../../../src/types/trader.js';
import type { CooldownCandidate } from '../../../src/services/liquidationCooldown/types.js';
import {
  collectLiquidationRecordsByDirection,
  simulateTriggerCycle,
} from '../../../src/services/liquidationCooldown/utils.js';

function createTradeRecord(params: {
  readonly baseInstrumentSymbol: string | null;
  readonly symbol: string;
  readonly action: string | null;
  readonly executedAtMs: number;
  readonly isProtectiveClearance: boolean;
  readonly reason?: string | null;
}): TradeRecord {
  return {
    orderId: 'order-id',
    symbol: params.symbol,
    symbolName: null,
    baseInstrumentSymbol: params.baseInstrumentSymbol,
    action: params.action,
    side: 'SELL',
    quantity: '1000',
    price: '1.23',
    orderType: 'ELO',
    status: 'FILLED',
    error: null,
    reason: params.reason ?? null,
    signalTriggerTime: null,
    executedAt: null,
    executedAtMs: params.executedAtMs,
    timestamp: null,
    isProtectiveClearance: params.isProtectiveClearance,
  };
}

function createCandidate(executedAtMs: number): CooldownCandidate {
  return {
    direction: 'LONG',
    executedAtMs,
  };
}

describe('liquidationCooldown utils', () => {
  it('collectLiquidationRecordsByDirection groups by baseInstrument + direction and sorts by time', () => {
    const records = [
      createTradeRecord({
        baseInstrumentSymbol: 'HSI.HK',
        symbol: 'BULL1.HK',
        action: 'SELLCALL',
        executedAtMs: 300,
        isProtectiveClearance: true,
        reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      }),
      createTradeRecord({
        baseInstrumentSymbol: 'HSI.HK',
        symbol: 'BULL2.HK',
        action: 'SELLCALL',
        executedAtMs: 100,
        isProtectiveClearance: true,
        reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      }),
      createTradeRecord({
        baseInstrumentSymbol: 'HSI.HK',
        symbol: 'BEAR1.HK',
        action: 'SELLPUT',
        executedAtMs: 200,
        isProtectiveClearance: true,
        reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      }),
      createTradeRecord({
        baseInstrumentSymbol: 'QQQ.HK',
        symbol: 'QQQ_BULL.HK',
        action: 'SELLCALL',
        executedAtMs: 50,
        isProtectiveClearance: true,
        reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      }),
      createTradeRecord({
        baseInstrumentSymbol: 'HSI.HK',
        symbol: 'BULL3.HK',
        action: 'BUYCALL',
        executedAtMs: 400,
        isProtectiveClearance: true,
        reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
      }),
    ];

    const grouped = collectLiquidationRecordsByDirection({
      baseInstrument: 'HSI.HK',
      tradeRecords: records,
    });

    const longGroup = grouped.get('LONG') ?? [];
    const shortGroup = grouped.get('SHORT') ?? [];
    expect(longGroup.map((item) => item.executedAtMs)).toEqual([100, 300]);
    expect(shortGroup.map((item) => item.executedAtMs)).toEqual([200]);
    expect(grouped.size).toBe(2);
  });

  it('collectLiquidationRecordsByDirection returns empty map for non-completion records', () => {
    const grouped = collectLiquidationRecordsByDirection({
      baseInstrument: 'HSI.HK',
      tradeRecords: [
        createTradeRecord({
          baseInstrumentSymbol: 'HSI.HK',
          symbol: 'BULL.HK',
          action: 'SELLCALL',
          executedAtMs: 100,
          isProtectiveClearance: false,
        }),
      ],
    });

    expect(grouped.size).toBe(0);
  });

  it('simulateTriggerCycle returns zero for empty records', () => {
    const result = simulateTriggerCycle({
      records: [],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 0,
      cooldownExecutedTimeMs: null,
      lastExpiredCooldownEndMs: null,
    });
  });

  it('simulateTriggerCycle activates cooldown on the third trigger', () => {
    const result = simulateTriggerCycle({
      records: [createCandidate(0), createCandidate(900_000), createCandidate(1_800_000)],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 3,
      cooldownExecutedTimeMs: 1_800_000,
      lastExpiredCooldownEndMs: null,
    });
  });

  it('simulateTriggerCycle returns only new-cycle count after previous cooldown expired', () => {
    const result = simulateTriggerCycle({
      records: [
        createCandidate(0),
        createCandidate(900_000),
        createCandidate(1_800_000),
        createCandidate(4_500_000),
        createCandidate(5_400_000),
      ],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 2,
      cooldownExecutedTimeMs: null,
      lastExpiredCooldownEndMs: 3_600_000,
    });
  });

  it('simulateTriggerCycle activates cooldown again in a new cycle when trigger limit is reached', () => {
    const result = simulateTriggerCycle({
      records: [
        createCandidate(0),
        createCandidate(900_000),
        createCandidate(1_800_000),
        createCandidate(4_500_000),
        createCandidate(5_400_000),
        createCandidate(6_300_000),
      ],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 3,
      cooldownExecutedTimeMs: 6_300_000,
      lastExpiredCooldownEndMs: 3_600_000,
    });
  });
});
