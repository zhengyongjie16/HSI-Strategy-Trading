/**
 * periodicSwitch 业务测试
 *
 * 覆盖周期换标 pending 的当前语义：
 * - 本地阻塞来自 positionCache / orderHold
 * - 阻塞解除后才能真正进入 SWITCHING
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longbridge';
import { createSeatStateManager } from '../../../src/services/autoSymbolManager/seatStateManager.js';
import { createSwitchStateMachine } from '../../../src/services/autoSymbolManager/switchStateMachine.js';
import {
  calculateBuyQuantityByNotional,
  createSignalBuilder,
  resolveDirectionSymbols,
} from '../../../src/services/autoSymbolManager/signalBuilder.js';
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

function createPeriodicMachine(params?: {
  readonly positionCache?: ReturnType<typeof createPositionCacheDouble>;
  readonly trader?: ReturnType<typeof createTraderDouble>;
}) {
  const nowMs = Date.parse('2026-02-16T01:31:00.000Z');
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
    riskChecker: createRiskCheckerDouble(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => new Map(),
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
    positionCache: params?.positionCache ?? createPositionCacheDouble(),
  };
}

describe('autoSymbolManager periodic switch', () => {
  it('keeps periodic pending until position blocker clears, then starts switching', async () => {
    const positionCache = createPositionCacheDouble([
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    ]);
    const { machine, periodicSwitchPending } = createPeriodicMachine({
      positionCache,
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:31:00.000Z'),
      canTradeNow: true,
      openProtectionActive: false,
    });

    expect(periodicSwitchPending.get('LONG')?.blockedBy).toBe('POSITION');
    expect(machine.hasPendingSwitch('LONG')).toBeFalse();

    positionCache.update([]);
    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:32:00.000Z'),
      canTradeNow: true,
      openProtectionActive: false,
    });

    expect(periodicSwitchPending.has('LONG')).toBeFalse();
    expect(machine.hasPendingSwitch('LONG')).toBeTrue();
  });

  it('updates periodic pending blocker to local pending order when local exposure source changes', async () => {
    const positionCache = createPositionCacheDouble([
      createPositionDouble({
        symbol: 'OLD_BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    ]);
    const trader = createTraderDouble({
      getOrderHoldSymbols: () => new Set(['OLD_BULL.HK']),
    });
    const { machine, periodicSwitchPending } = createPeriodicMachine({
      positionCache,
      trader,
    });

    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:31:00.000Z'),
      canTradeNow: true,
      openProtectionActive: false,
    });
    expect(periodicSwitchPending.get('LONG')?.blockedBy).toBe('POSITION');

    positionCache.update([]);
    await machine.maybeSwitchOnInterval({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:32:00.000Z'),
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
});
