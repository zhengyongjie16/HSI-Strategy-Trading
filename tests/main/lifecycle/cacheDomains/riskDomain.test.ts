/**
 * 风控缓存域单元测试
 *
 * 覆盖：midnightClear 调用 resetRiskCheckCooldown、dailyLossTracker.resetAll、
 * clearMidnightEligible（仅非 minutes 模式）、clearRiskCaches；openRebuild 为空操作
 */
import { describe, it, expect } from 'bun:test';
import { createRiskDomain } from '../../../../src/main/lifecycle/cacheDomains/riskDomain.js';
import type { DailyLossTracker } from '../../../../src/types/risk.js';
import type { SignalProcessor } from '../../../../src/core/signalProcessor/types.js';
import type { LiquidationCooldownTracker } from '../../../../src/services/liquidationCooldown/types.js';
import {
  createMonitorContextDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from '../../../helpers/testDoubles.js';

describe('createRiskDomain', () => {
  it('midnightClear 调用 signalProcessor.resetRiskCheckCooldown、dailyLossTracker.resetAll、clearMidnightEligible、各 riskChecker 清理', async () => {
    let resetRiskCheckCooldownCalled = false;
    let resetAllCalled = false;
    let resetAllNow: Date | null = null as Date | null;
    let resetAllTriggerCountsCalled = false;
    let clearMidnightEligibleDirections: Set<'LONG' | 'SHORT'> | null = null as Set<
      'LONG' | 'SHORT'
    > | null;
    let clearUnrealizedCount = 0;
    let clearLongCount = 0;
    let clearShortCount = 0;

    const monitorContext = createMonitorContextDouble({
      config: {
        monitorSymbol: 'HSI.HK',
        liquidationCooldown: { mode: 'half-day' },
      } as never,
      riskChecker: {
        clearUnrealizedLossData: () => {
          clearUnrealizedCount += 1;
        },
        clearLongWarrantInfo: () => {
          clearLongCount += 1;
        },
        clearShortWarrantInfo: () => {
          clearShortCount += 1;
        },
      } as never,
    });
    const signalProcessor: SignalProcessor = {
      resetRiskCheckCooldown: () => {
        resetRiskCheckCooldownCalled = true;
      },
    } as unknown as SignalProcessor;
    const dailyLossTracker: DailyLossTracker = {
      resetAll: (now: Date) => {
        resetAllCalled = true;
        resetAllNow = now;
      },
      prepareProtectionBoundary: () => ({
        direction: 'LONG',
        boundaryExecutedTimeMs: 1,
        orderBaselines: [],
      }),
      commitProtectionBoundary: () => {},
      restoreProtectionBoundary: () => {},
    } as unknown as DailyLossTracker;
    const liquidationCooldownTracker: LiquidationCooldownTracker = {
      recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
      recordCooldown: () => {},
      restoreTriggerCount: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: (params) => {
        clearMidnightEligibleDirections = new Set(params.directionsToClear);
      },
      resetAllTriggerCounts: () => {
        resetAllTriggerCountsCalled = true;
      },
    };

    const domain = createRiskDomain({
      signalProcessor,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContext,
      liquidationCooldownTracker,
    });
    const now = new Date('2025-02-15T00:00:00Z');
    await domain.midnightClear({
      now,
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(resetRiskCheckCooldownCalled).toBe(true);
    expect(resetAllCalled).toBe(true);
    expect(resetAllNow?.getTime()).toBe(now.getTime());
    expect(resetAllTriggerCountsCalled).toBe(true);
    expect(clearMidnightEligibleDirections).not.toBe(null);
    expect(clearMidnightEligibleDirections?.has('LONG')).toBe(true);
    expect(clearMidnightEligibleDirections?.has('SHORT')).toBe(true);
    expect(clearUnrealizedCount).toBe(1);
    expect(clearLongCount).toBe(1);
    expect(clearShortCount).toBe(1);
  });

  it('liquidationCooldown 为 minutes 模式时不向 directionsToClear 添加方向', async () => {
    let clearMidnightEligibleDirections: Set<'LONG' | 'SHORT'> | null = null as Set<
      'LONG' | 'SHORT'
    > | null;
    const monitorContext = createMonitorContextDouble({
      config: {
        monitorSymbol: 'HSI.HK',
        liquidationCooldown: { mode: 'minutes' },
      } as never,
      riskChecker: {
        clearUnrealizedLossData: () => {},
        clearLongWarrantInfo: () => {},
        clearShortWarrantInfo: () => {},
      } as never,
    });
    const liquidationCooldownTracker: LiquidationCooldownTracker = {
      recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
      recordCooldown: () => {},
      restoreTriggerCount: () => {},
      getRemainingMs: () => 0,
      clearMidnightEligible: (params) => {
        clearMidnightEligibleDirections = new Set(params.directionsToClear);
      },
      resetAllTriggerCounts: () => {},
    };

    const domain = createRiskDomain({
      signalProcessor: { resetRiskCheckCooldown: () => {} } as unknown as SignalProcessor,
      dailyLossTracker: {
        resetAll: () => {},
        prepareProtectionBoundary: () => ({
          direction: 'LONG',
          boundaryExecutedTimeMs: 1,
          orderBaselines: [],
        }),
        commitProtectionBoundary: () => {},
        restoreProtectionBoundary: () => {},
      } as unknown as DailyLossTracker,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContext,
      liquidationCooldownTracker,
    });
    await domain.midnightClear({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });

    expect(
      clearMidnightEligibleDirections === null ? 0 : clearMidnightEligibleDirections.size,
    ).toBe(0);
  });

  it('openRebuild 为空操作，不抛错', async () => {
    const domain = createRiskDomain({
      signalProcessor: { resetRiskCheckCooldown: () => {} } as unknown as SignalProcessor,
      dailyLossTracker: {
        resetAll: () => {},
        prepareProtectionBoundary: () => ({
          direction: 'LONG',
          boundaryExecutedTimeMs: 1,
          orderBaselines: [],
        }),
        commitProtectionBoundary: () => {},
        restoreProtectionBoundary: () => {},
      } as unknown as DailyLossTracker,
      protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
      monitorContext: createMonitorContextDouble(),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => ({ currentCount: 0, cooldownActivated: false }),
        recordCooldown: () => {},
        restoreTriggerCount: () => {},
        getRemainingMs: () => 0,
        clearMidnightEligible: () => {},
        resetAllTriggerCounts: () => {},
      },
    });
    await domain.openRebuild({
      now: new Date(),
      runtime: { dayKey: '2025-02-15', canTradeNow: true, isTradingDay: true },
    });
  });
});
