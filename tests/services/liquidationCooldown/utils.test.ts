/**
 * liquidationCooldown utils 业务测试
 *
 * 功能：
 * - 验证保护性清仓触发周期模拟算法。
 */
import { describe, expect, it } from 'bun:test';

import type { CooldownCandidate } from '../../../src/services/liquidationCooldown/types.js';
import { simulateTriggerCycle } from '../../../src/services/liquidationCooldown/utils.js';

function createCandidate(executedAtMs: number): CooldownCandidate {
  return {
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    executedAtMs,
  };
}

describe('liquidationCooldown utils', () => {
  it('simulateTriggerCycle returns zero for empty records', () => {
    const result = simulateTriggerCycle({
      records: [],
      triggerLimit: 3,
      cooldownConfig: { mode: 'minutes', minutes: 30 },
    });

    expect(result).toEqual({
      currentCount: 0,
      cooldownExecutedTimeMs: null,
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
    });
  });
});
