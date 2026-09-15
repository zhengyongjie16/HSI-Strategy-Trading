/**
 * Quote 午夜排空重试集成测试。
 * 使用真实 Quote owner 与 dayLifecycle manager，验证外部失败不会永久锁住午夜清理。
 */
import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createDayLifecycleManager } from '../../../src/main/lifecycle/dayLifecycleManager.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import { createExternalApiAggregateRequestError } from '../../../src/utils/apiFailure/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createLoggerDouble,
  createMonitorConfigDouble,
  createPositionCacheDouble,
} from '../../helpers/testDoubles.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { LastState } from '../../../src/types/state.js';

describe('Quote drain 午夜重试', () => {
  it.each([false, true])(
    '首次失败后下一 tick 真正退订；内部错误 fatal=%s',
    async (internalFailure) => {
      const monitor = createMonitorConfigDouble();
      const state: LastState = {
        canTrade: false,
        isHalfDay: false,
        openProtectionActive: false,
        currentDayKey: '2026-04-10',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        isTradingEnabled: true,
        cachedAccount: null,
        cachedPositions: [],
        positionCache: createPositionCacheDouble(),
        cachedTradingDayInfo: null,
        tradingCalendarSnapshot: new Map(),
        allTradingSymbols: new Set(['OLD.HK']),
      };
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
      const quote = createQuoteSubscriptionRuntime({
        logger: createLoggerDouble(),
        tradingConfig: createTradingConfig({ monitor }),
        symbolRegistry: createSymbolRegistry(monitor),
        lastState: state,
        termination,
        trader: { getOrderHoldSymbols: () => new Set(), onOrderHoldSymbolsChanged: () => () => {} },
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
        mutableState: state,
        termination,
        logger: createLoggerDouble(),
        rebuildRetryDelayMs: 100,
        cacheDomains: [
          {
            midnightClear: () => quote.stopAndDrain(),
            openRebuild: () => quote.reconcileFromCurrentTruth(),
          },
          {
            midnightClear: () => {
              completedDomains.push('dependent');
            },
            openRebuild: () => {},
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
      expect(state.lifecycleState).toBe('MIDNIGHT_CLEANING');
      expect(state.isTradingEnabled).toBe(false);
      expect(state.allTradingSymbols).toEqual(new Set(['OLD.HK']));
      await manager.tick(new Date(99), runtime);
      expect(attempts).toBe(1);
      const retry = await manager.tick(new Date(100), runtime);
      if (internalFailure) {
        expect(attempts).toBe(1);
        expect(completedDomains).toEqual([]);
        expect(state.lifecycleState).toBe('MIDNIGHT_CLEANING');
      } else {
        expect(state.lifecycleState).toBe('MIDNIGHT_CLEANED');
        expect(attempts).toBe(2);
        expect(completedDomains).toEqual(['dependent']);
        expect(state.allTradingSymbols).toEqual(new Set());
        expect(retry.nextRetryAtMs).toBeNull();
        expect(state.pendingOpenRebuild).toBe(true);
      }

      expect(state.isTradingEnabled).toBe(false);
    },
  );
});
