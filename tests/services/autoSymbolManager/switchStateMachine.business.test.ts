/**
 * switchStateMachine 业务测试
 *
 * 覆盖当前换标关键语义：
 * - 周期换标阻塞改为 positionCache / orderHold
 * - 回补金额改为 recent filled order 摘要
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longbridge';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import type {
  PeriodicSwitchPendingState,
  SwitchState,
  SwitchSuppression,
} from '../../../src/services/autoSymbolManager/types.js';
import { PENDING_ORDER_STATUSES } from '../../../src/constants/index.js';
import { signalObjectPool } from '../../../src/utils/objectPool/index.js';
import { calculateTradingDurationMsBetween, getHKDateKey } from '../../../src/utils/time/index.js';
import {
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';
import {
  createDirectionalAutoSearchPolicy,
  createFindBestWarrantInputDouble,
  createLoggerStub,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from './utils.js';

function createSwitchStatesMap(): Map<'LONG' | 'SHORT', SwitchState> {
  return new Map<'LONG' | 'SHORT', SwitchState>();
}

function createSwitchSuppressionsMap(): Map<'LONG' | 'SHORT', SwitchSuppression> {
  return new Map<'LONG' | 'SHORT', SwitchSuppression>();
}

function createPeriodicSwitchPendingMap(): Map<'LONG' | 'SHORT', PeriodicSwitchPendingState> {
  return new Map<'LONG' | 'SHORT', PeriodicSwitchPendingState>();
}

function createMachineContext(params?: {
  readonly nowMs?: number;
  readonly positionCache?: ReturnType<typeof createPositionCacheDouble>;
  readonly trader?: ReturnType<typeof createTraderDouble>;
}) {
  const nowMs = params?.nowMs ?? Date.parse('2026-02-16T01:31:00.000Z');
  const symbolRegistry = createSymbolRegistryDouble({
    baseInstrumentSymbol: 'HSI.HK',
    longSeat: {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: Date.parse('2026-02-16T01:00:00.000Z'),
      lastSearchAt: null,
      lastSeatActivatedAt: Date.parse('2026-02-16T00:30:00.000Z'),
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const switchStates = createSwitchStatesMap();
  const switchSuppressions = createSwitchSuppressionsMap();
  const periodicSwitchPending = createPeriodicSwitchPendingMap();
  const logger = createLoggerStub();
  const seatStateManager = createSeatStateManager({
    baseInstrumentSymbol: 'HSI.HK',
    symbolRegistry,
    switchStates,
    switchSuppressions,
    now: () => new Date(nowMs),
    logger,
    getHKDateKey,
  });

  const machine = createSwitchStateMachine({
    autoSearchConfig: {
      ...getDefaultAutoSearchConfig(),
      switchIntervalMinutes: 1,
    },
    baseInstrumentSymbol: 'HSI.HK',
    symbolRegistry,
    trader: params?.trader ?? createTraderDouble(),
    positionCache: params?.positionCache ?? createPositionCacheDouble(),
    riskChecker: createRiskCheckerDouble({
      getWarrantDistanceInfo: () =>
        createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 2,
        }),
    }),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) =>
        new Map(
          [...symbols].map((symbol) => [
            symbol,
            {
              symbol,
              name: symbol,
              price: symbol === 'NEXT_BULL.HK' ? 1.1 : 1,
              prevClose: 1,
              timestamp: nowMs,
              lotSize: 100,
            },
          ]),
        ),
    }),
    now: () => new Date(nowMs),
    switchStates,
    periodicSwitchPending,
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
    buildSeatState: seatStateManager.buildSeatState,
    updateSeatState: seatStateManager.updateSeatState,
    resolveDirectionalAutoSearchPolicy: () => createDirectionalAutoSearchPolicy('LONG'),
    buildFindBestWarrantInput: async () => createFindBestWarrantInputDouble(),
    findBestWarrant: async () => createWarrantCandidate('NEXT_BULL.HK'),
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: createSignalBuilder({ signalObjectPool }).buildOrderSignal,
    signalObjectPool,
    pendingOrderStatuses: PENDING_ORDER_STATUSES,
    buySide: OrderSide.Buy,
    logger,
    maxSearchFailuresPerDay: 3,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot: () =>
      new Map([
        ['2026-02-16', { isTradingDay: true, isHalfDay: false }],
        ['2026-02-17', { isTradingDay: true, isHalfDay: false }],
      ]),
  });

  return {
    machine,
    periodicSwitchPending,
    symbolRegistry,
  };
}

describe('autoSymbolManager switchStateMachine', () => {
  it('blocks periodic switch by cached position instead of order recorder', async () => {
    const positionCache = createPositionCacheDouble([
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    ]);
    const { machine, periodicSwitchPending } = createMachineContext({
      positionCache,
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:31:00.000Z'),
      canTradeNow: true,
      openProtectionActive: false,
    });

    expect(periodicSwitchPending.get('LONG')).toEqual({
      pending: true,
      pendingSinceMs: Date.parse('2026-02-16T01:31:00.000Z'),
      blockedBy: 'POSITION',
    });
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('blocks periodic switch by local pending order hold when position is flat', async () => {
    const trader = createTraderDouble({
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
    });
    const { machine, periodicSwitchPending } = createMachineContext({
      positionCache: createPositionCacheDouble(),
      trader,
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:31:00.000Z'),
      canTradeNow: true,
      openProtectionActive: false,
    });

    expect(periodicSwitchPending.get('LONG')).toEqual({
      pending: true,
      pendingSinceMs: Date.parse('2026-02-16T01:31:00.000Z'),
      blockedBy: 'LOCAL_PENDING_ORDER',
    });
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('uses recent filled sell summary as rebuy notional source', async () => {
    const executedSignals: Array<{
      readonly action: string;
      readonly symbol: string;
      readonly quantity: number | null;
    }> = [];
    const trader = createTraderDouble({
      getPendingOrders: async () => [],
      getRecentFilledOrder: (orderId) =>
        orderId === 'SELL-001'
          ? {
              orderId,
              symbol: 'OLD_BULL.HK',
              side: OrderSide.Sell,
              executedPrice: 1.2,
              executedQuantity: 100,
              executedTimeMs: Date.parse('2026-02-16T01:32:00.000Z'),
            }
          : null,
      executeSignals: async (signals) => {
        for (const signal of signals) {
          executedSignals.push({
            action: signal.action,
            symbol: signal.symbol,
            quantity: signal.quantity ?? null,
          });
        }

        return {
          submittedCount: signals.length,
          submittedOrderIds:
            executedSignals.length === 1 ? ['SELL-001'] : [`BUY-${executedSignals.length}`],
        };
      },
    });
    const positionCache = createPositionCacheDouble([
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    ]);
    const { machine, symbolRegistry } = createMachineContext({
      positionCache,
      trader,
    });

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        createPositionDouble({
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
    });

    positionCache.update([]);
    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    await machine.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedSignals).toEqual([
      {
        action: 'SELLCALL',
        symbol: 'OLD_BULL.HK',
        quantity: 100,
      },
      {
        action: 'BUYCALL',
        symbol: 'NEXT_BULL.HK',
        quantity: 100,
      },
    ]);
    expect(symbolRegistry.getSeatState('LONG').symbol).toBe('NEXT_BULL.HK');
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });
});
