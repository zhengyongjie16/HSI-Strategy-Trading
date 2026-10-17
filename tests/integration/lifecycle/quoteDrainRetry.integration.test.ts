import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';

/**
 * Quote 午夜排空重试集成测试。
 * 使用真实 Quote owner 与 dayLifecycle manager，验证外部失败不会永久锁住午夜清理。
 */
import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/index.js';
import { createDayLifecycleManager } from '../../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createExternalApiAggregateRequestError } from '../../../src/utils/apiFailure/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createLoggerDouble, createMonitorConfigDouble } from '../../helpers/testDoubles.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

describe('Quote drain 午夜重试', () => {
  it.each([false, true])(
    '首次失败后下一 tick 真正退订；内部错误 fatal=%s',
    async (internalFailure) => {
      const monitor = createMonitorConfigDouble();
      const state: RuntimeStateFixtures = createRuntimeStateFixtures({
        tradingTimeState: { canTrade: false, isHalfDay: false, openProtectionActive: false },
        lifecycleState: {
          currentDayKey: '2026-04-10',
          lifecycleState: 'ACTIVE',
          pendingOpenRebuild: false,
          isTradingEnabled: true,
        },
        tradingCalendarState: { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() },
        quoteSubscriptionState: { allTradingSymbols: new Set(['OLD.HK']) },
      });
      const failure = internalFailure
        ? new Error('internal invariant')
        : createExternalApiAggregateRequestError({
            operation: 'unsubscribeSymbols',
            attempts: 1,
            causes: [
              await createExternalApiRequestError({
                operation: 'unsubscribe',
                attempts: 1,
                cause: new Error('network unavailable'),
              }),
            ],
          });
      let attempts = 0;
      let terminated = false;
      const fatalErrors: unknown[] = [];
      const termination = {
        isTerminated: () => terminated,
        reportFatalError: (error: unknown) => {
          fatalErrors.push(error);
          terminated = true;
        },
      };
      const snapshot = await createSnapshotFixture({ positions: [] });
      const quote = createQuoteSubscriptionRuntime({
        snapshot,
        logger: createLoggerDouble(),
        tradingConfig: createTradingConfig({ monitor }),
        symbolRegistry: createSymbolRegistry(monitor),
        ...state,
        termination,
        orderHoldRegistry: {
          getHoldSymbols: () => new Set(),
          onOrderHoldSymbolsChanged: () => () => {},
        },
        marketDataClient: {
          subscribeSymbols: async () => {
            throw new Error('午夜不得重新订阅');
          },
          unsubscribeSymbols: async () => {
            attempts += 1;
            if (attempts === 1) throw failure;
          },
        },
      });
      const completedDomains: string[] = [];
      const manager = createDayLifecycleManager({
        diagnostics: createDiagnosticObserverDouble(),
        snapshot,
        mutableState: state.lifecycleState,
        termination,
        logger: createLoggerDouble(),
        rebuildRetryDelayMs: 100,
        cacheDomains: [
          {
            midnightClear: () => quote.stopAndDrain(),
            openRebuild: async () => {
              throw new Error('Midnight retry must not enter open rebuild');
            },
          },
          {
            midnightClear: () => {
              completedDomains.push('dependent');
            },
            openRebuild: () => {
              throw new Error('Midnight retry must not enter dependent open rebuild');
            },
          },
        ],
      });
      const runtime = { dayKey: '2026-04-11', isTradingDay: true, canTradeNow: false };
      const firstTick = manager.tick(new Date(0), runtime);
      if (internalFailure) {
        expect(await firstTick.catch((error: unknown) => error)).toBe(failure);
        expect(fatalErrors).toEqual([failure]);
      } else {
        const firstResult = await firstTick;
        expect(firstResult.nextRetryAtMs).toBe(100);
        expect(fatalErrors).toEqual([]);
      }

      expect(attempts).toBe(1);
      expect(completedDomains).toEqual([]);
      expect(state.lifecycleState.lifecycleState).toBe('MIDNIGHT_CLEANING');
      expect(state.lifecycleState.isTradingEnabled).toBe(false);
      expect(state.quoteSubscriptionState.allTradingSymbols).toEqual(new Set(['OLD.HK']));
      await manager.tick(new Date(99), runtime);
      expect(attempts).toBe(1);
      const retry = await manager.tick(new Date(100), runtime);
      if (internalFailure) {
        expect(attempts).toBe(1);
        expect(completedDomains).toEqual([]);
        expect(state.lifecycleState.lifecycleState).toBe('MIDNIGHT_CLEANING');
      } else {
        expect(state.lifecycleState.lifecycleState).toBe('MIDNIGHT_CLEANED');
        expect(attempts).toBe(2);
        expect(completedDomains).toEqual(['dependent']);
        expect(state.quoteSubscriptionState.allTradingSymbols).toEqual(new Set());
        expect(retry.nextRetryAtMs).toBeNull();
        expect(state.lifecycleState.pendingOpenRebuild).toBe(true);
      }

      expect(state.lifecycleState.isTradingEnabled).toBe(false);
    },
  );
});
