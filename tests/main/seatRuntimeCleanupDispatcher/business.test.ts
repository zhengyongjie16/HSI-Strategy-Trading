/**
 * SeatRuntimeCleanupDispatcher 业务测试
 *
 * 覆盖：seat state event 驱动的 ACTIVE 退场清理边界。
 */
import { describe, expect, it } from 'bun:test';
import { createSeatRuntimeCleanupDispatcher } from '../../../src/main/seatRuntimeCleanupDispatcher/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { SeatState } from '../../../src/types/seat.js';
import {
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createDelayedSignalVerifierDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

function createEmptySeatState(overrides: Partial<SeatState> = {}): SeatState {
  return {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
    ...overrides,
  };
}

function createActiveSeatState(symbol: string): SeatState {
  return {
    symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: 100,
    callPrice: 20_000,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

describe('SeatRuntimeCleanupDispatcher business flow', () => {
  it('在 LONG 席位从 ACTIVE 退场时清理方向运行态并保留 SEAT_REFRESH', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeatState('BULL.HK'),
      shortSeat: createActiveSeatState('BEAR.HK'),
    });
    let clearLongCalls = 0;
    let delayedCancelled = 0;
    const riskChecker = createRiskCheckerDouble({
      clearLongWarrantInfo: () => {
        clearLongCalls += 1;
      },
    });
    const delayedSignalVerifier = createDelayedSignalVerifierDouble({
      cancelAllForDirection: (direction) => {
        if (direction !== 'LONG') {
          return 0;
        }

        delayedCancelled += 2;
        return 2;
      },
    });
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({ monitorSymbol }),
      symbolRegistry,
      riskChecker,
      delayedSignalVerifier,
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

    for (const task of [
      {
        type: 'IMMEDIATE_BUY',
        data: createSignalDouble('BUYCALL', 'BULL.HK'),
      },
      {
        type: 'IMMEDIATE_BUY',
        data: createSignalDouble('BUYPUT', 'BEAR.HK'),
      },
    ] as const) {
      buyTaskQueue.push(task);
    }

    sellTaskQueue.push({
      type: 'IMMEDIATE_SELL',
      data: createSignalDouble('SELLCALL', 'BULL.HK'),
    });

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
      data: {
        direction: 'LONG',
        seatVersion: 1,
        symbol: 'BULL.HK',
        lastSeatActivatedAt: 12_000,
        currentTimeMs: 123,
      },
    });

    monitorTaskQueue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'SEAT_REFRESH:LONG',
      data: {
        direction: 'LONG',
        seatVersion: 1,
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: 20_000,
        symbolName: 'BULL.HK',
      },
    });

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:SHORT',
      data: {
        direction: 'SHORT',
        seatVersion: 1,
        symbol: 'BEAR.HK',
        lastSeatActivatedAt: 12_000,
        currentTimeMs: 123,
      },
    });

    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });

    dispatcher.start();
    symbolRegistry.updateSeatStateWithVersionBump('LONG', createEmptySeatState());
    dispatcher.stop();

    expect(clearLongCalls).toBe(1);
    expect(delayedCancelled).toBe(2);
    expect(buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();

    const remainingSeatRefreshTask = monitorTaskQueue.pop();
    expect(remainingSeatRefreshTask?.type).toBe('SEAT_REFRESH');
    expect(remainingSeatRefreshTask?.data).toMatchObject({
      direction: 'LONG',
      nextSymbol: 'BULL.HK',
    });

    const remainingShortTask = monitorTaskQueue.pop();
    expect(remainingShortTask?.type).toBe('AUTO_SYMBOL_TICK');
    expect(remainingShortTask?.data).toMatchObject({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
    });
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('在 SHORT 席位从 ACTIVE 退场时清理做空方向运行态', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeatState('BULL.HK'),
      shortSeat: createActiveSeatState('BEAR.HK'),
    });
    let clearShortCalls = 0;
    let delayedCancelled = 0;
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({ monitorSymbol }),
      symbolRegistry,
      riskChecker: createRiskCheckerDouble({
        clearShortWarrantInfo: () => {
          clearShortCalls += 1;
        },
      }),
      delayedSignalVerifier: createDelayedSignalVerifierDouble({
        cancelAllForDirection: (direction) => {
          if (direction !== 'SHORT') {
            return 0;
          }

          delayedCancelled += 1;
          return 1;
        },
      }),
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

    buyTaskQueue.push({
      type: 'IMMEDIATE_BUY',
      data: createSignalDouble('BUYPUT', 'BEAR.HK'),
    });

    sellTaskQueue.push({
      type: 'IMMEDIATE_SELL',
      data: createSignalDouble('SELLPUT', 'BEAR.HK'),
    });

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:SHORT',
      data: {
        direction: 'SHORT',
        seatVersion: 1,
        symbol: 'BEAR.HK',
        lastSeatActivatedAt: 12_000,
        currentTimeMs: 123,
      },
    });

    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });

    dispatcher.start();
    symbolRegistry.updateSeatStateWithVersionBump('SHORT', createEmptySeatState());
    dispatcher.stop();

    expect(clearShortCalls).toBe(1);
    expect(delayedCancelled).toBe(1);
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
    expect(monitorTaskQueue.isEmpty()).toBeTrue();
  });

  it('只在 ACTIVE 退场事件触发清理', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createEmptySeatState(),
    });
    let clearLongCalls = 0;
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({ monitorSymbol }),
      symbolRegistry,
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongCalls += 1;
        },
      }),
      delayedSignalVerifier: createDelayedSignalVerifierDouble(),
    });
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });

    dispatcher.start();
    symbolRegistry.updateSeatState('LONG', {
      ...createEmptySeatState({ symbol: 'BULL.HK' }),
      status: 'SEARCHING',
    });

    symbolRegistry.updateSeatState('LONG', {
      ...createEmptySeatState({ symbol: 'BULL.HK', callPrice: 20_000 }),
      status: 'ACTIVATING',
    });
    symbolRegistry.updateSeatState('LONG', createActiveSeatState('BULL.HK'));
    symbolRegistry.updateSeatState('LONG', createActiveSeatState('BULL.HK'));
    symbolRegistry.updateSeatState('LONG', {
      ...createEmptySeatState({ symbol: 'BULL.HK' }),
      status: 'SWITCHING',
    });
    dispatcher.stop();

    expect(clearLongCalls).toBe(1);
  });

  it('seat truth 事件只按方向处理，不再要求 monitorSymbol fail-fast', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeatState('BULL.HK'),
    });
    const monitorContext = createMonitorContextDouble({ symbolRegistry });
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });

    dispatcher.start();
    expect(() => {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', createEmptySeatState());
    }).not.toThrow();
    dispatcher.stop();

    expect(symbolRegistry.getSeatStateListenerErrors()).toHaveLength(0);
    expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(0);
  });

  it('席位状态 listener 失败后仍执行后续 listener 并向写入方暴露错误', () => {
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeatState('BULL.HK'),
    });
    let observedBySecondListener = false;
    const unsubscribeFailing = symbolRegistry.onSeatStateChanged(() => {
      throw new Error('first listener failed');
    });
    const unsubscribeSecond = symbolRegistry.onSeatStateChanged(() => {
      observedBySecondListener = true;
    });

    let caught: unknown = null;
    try {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', createEmptySeatState());
    } catch (err) {
      caught = err;
    } finally {
      unsubscribeFailing();
      unsubscribeSecond();
    }

    expect(observedBySecondListener).toBeTrue();
    expect(caught).toBeInstanceOf(AggregateError);
    expect(symbolRegistry.getSeatStateListenerErrors()).toHaveLength(1);
  });

  it('start 和 stop 保持幂等且 stop 后不再消费事件', () => {
    const monitorSymbol = 'HSI.HK';
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: createActiveSeatState('BULL.HK'),
    });
    let clearLongCalls = 0;
    const monitorContext = createMonitorContextDouble({
      config: createMonitorConfigDouble({ monitorSymbol }),
      symbolRegistry,
      riskChecker: createRiskCheckerDouble({
        clearLongWarrantInfo: () => {
          clearLongCalls += 1;
        },
      }),
      delayedSignalVerifier: createDelayedSignalVerifierDouble(),
    });
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContext,
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });

    dispatcher.start();
    dispatcher.start();
    expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(1);
    dispatcher.stop();
    dispatcher.stop();
    expect(symbolRegistry.getSeatStateChangedListenerCount()).toBe(0);

    symbolRegistry.updateSeatStateWithVersionBump('LONG', createEmptySeatState());

    expect(clearLongCalls).toBe(0);
  });
});
