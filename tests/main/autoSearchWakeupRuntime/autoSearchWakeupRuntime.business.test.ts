/**
 * AutoSearchWakeupRuntime 业务测试
 *
 * 覆盖：runtime start seed 与自动寻标授权恢复事件唤醒 EMPTY seat，不依赖 AUTO_SYMBOL_TICK。
 */
import { describe, expect, it } from 'bun:test';
import { AUTO_SYMBOL_SEARCH_COOLDOWN_MS, TIME } from '../../../src/constants/index.js';
import { createAutoSearchWakeupRuntime } from '../../../src/main/autoSearchWakeupRuntime/index.js';
import { createTradingGateEventRuntime as createProductionTradingGateEventRuntime } from '../../../src/main/tradingGateEventRuntime/index.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { SearchOnEventParams } from '../../../src/services/autoSymbolManager/types.js';
import {
  createAutoSymbolManagerDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
} from '../../helpers/testDoubles.js';

function createTradingGateEventRuntime() {
  return createProductionTradingGateEventRuntime({ logger: createLoggerDouble() });
}

function createAutoSearchEnabledMonitorConfig(
  params: { readonly autoSearchOpenDelayMinutes?: number } = {},
) {
  const baseConfig = createMonitorConfigDouble();
  return createMonitorConfigDouble({
    autoSearchConfig: {
      ...baseConfig.autoSearchConfig,
      autoSearchEnabled: true,
      autoSearchOpenDelayMinutes: params.autoSearchOpenDelayMinutes ?? 0,
    },
  });
}

type TimerHandle = ReturnType<typeof setTimeout>;

function createTimerHarness(initialNowMs: number) {
  let currentNowMs = initialNowMs;
  const timers = new Map<TimerHandle, { readonly atMs: number; readonly callback: () => void }>();

  return {
    now: () => new Date(currentNowMs),
    setNow: (nextNowMs: number) => {
      currentNowMs = nextNowMs;
    },
    scheduleTimer: (callback: () => void, delayMs: number) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      timers.set(handle, {
        atMs: currentNowMs + delayMs,
        callback,
      });
      return handle;
    },
    clearTimer: (handle: TimerHandle) => {
      clearTimeout(handle);
      timers.delete(handle);
    },
    fireNext: () => {
      const next = [...timers.entries()].sort(([, left], [, right]) => left.atMs - right.atMs)[0];
      if (next === undefined) {
        return;
      }

      const [handle, timer] = next;
      clearTimeout(handle);
      timers.delete(handle);
      timer.callback();
    },
    getPendingTimerAts: () => [...timers.values()].map((timer) => timer.atMs),
  };
}

function makeSeatEmpty(
  symbolRegistry: ReturnType<typeof createSymbolRegistry>,
  _monitorSymbol: string,
): void {
  symbolRegistry.updateSeatState('SHORT', {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: 1,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });

  symbolRegistry.updateSeatState('LONG', {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
}

describe('AutoSearchWakeupRuntime', () => {
  it('start 时 seed 当前 EMPTY seat 并调用 maybeSearchOnEvent', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(
      calls.map((call) => call.direction).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['LONG']);
    expect(calls.every((call) => typeof call.canContinue === 'function')).toBe(true);
  });

  it('同一路由 seed 搜索未完成时自动寻标授权恢复不重复启动搜索', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    let resolveSearch = (): void => {
      throw new Error('expected in-flight search resolver');
    };
    const inFlightSearch = new Promise<void>((resolve) => {
      resolveSearch = resolve;
    });
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          await inFlightSearch;
        },
      }),
    });
    const lastState = {
      canTrade: true,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    await Bun.sleep(0);
    tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
      previousAuthorized: false,
      nextAuthorized: true,
    });
    await Bun.sleep(0);

    expect(calls).toHaveLength(1);
    resolveSearch();
    await runtime.stopAndDrain();
  });

  it('自动寻标授权从关闭变为打开时唤醒已经存在的 EMPTY seat', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const lastState = {
      canTrade: false,
      isTradingEnabled: true,
      isHalfDay: false,
    };
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState,
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();
    await Bun.sleep(0);
    expect(calls).toHaveLength(0);

    lastState.canTrade = true;
    tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
      previousAuthorized: false,
      nextAuthorized: true,
    });
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(
      calls.map((call) => call.direction).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['LONG']);
  });

  it('非 API 寻标错误进入 fatal channel', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async () => {
          throw new TypeError('auto search contract broken');
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);
    runtime.start();
    const fatalError = await fatalErrorPromise;
    await runtime.stopAndDrain();

    expect(fatalError).toBeInstanceOf(TypeError);
    expect((fatalError as Error).message).toBe('auto search contract broken');
  });

  it('内部合约 fatal 即使已写回过期 EMPTY 也不交接 cooldown owner', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          const currentSeat = symbolRegistry.getSeatState('LONG');
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'SEARCHING',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });
          timers.setNow(startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS + 1);
          const searchingSeat = symbolRegistry.getSeatState('LONG');
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: searchingSeat.lastSwitchAt,
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: searchingSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: searchingSeat.searchFailCountToday + 1,
            frozenTradingDayKey: null,
          });
          throw new TypeError('auto search contract broken after seat rollback');
        },
      }),
    });
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: { canTrade: true, isTradingEnabled: true, isHalfDay: false },
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);
    runtime.start();
    const fatalError = await fatalErrorPromise;
    await Bun.sleep(0);

    expect(fatalError).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
    expect(timers.getPendingTimerAts()).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('连续受控外部失败按 cooldown 重试直到冻结且冻结后不再保留 timer', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          const currentSeat = symbolRegistry.getSeatState('LONG');
          const nextFailCount = currentSeat.searchFailCountToday + 1;
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: nextFailCount,
            frozenTradingDayKey: nextFailCount >= 3 ? '2026-04-10' : null,
          });
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(1);
    expect(timers.getPendingTimerAts()).toEqual([startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS]);

    timers.setNow(startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS);
    timers.fireNext();
    await Bun.sleep(0);
    expect(calls).toHaveLength(2);
    expect(timers.getPendingTimerAts()).toEqual([startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS * 2]);

    timers.setNow(startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS * 2);
    timers.fireNext();
    await Bun.sleep(0);
    expect(calls).toHaveLength(3);
    expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
      searchFailCountToday: 3,
      frozenTradingDayKey: '2026-04-10',
    });
    expect(timers.getPendingTimerAts()).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('真实寻标返回 EMPTY 时先释放 active route 再安排唯一 cooldown owner', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          const currentSeat = symbolRegistry.getSeatState('LONG');
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'SEARCHING',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: startMs,
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });

          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: startMs,
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(1);
    expect(timers.getPendingTimerAts()).toEqual([startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS]);

    await runtime.stopAndDrain();
  });

  it('慢速无候选已跨过 cooldown 时释放 route 后立即重触发且不并发', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    let resolveFirstSearch = (): void => {
      throw new Error('expected first search resolver');
    };
    const firstSearch = new Promise<void>((resolve) => {
      resolveFirstSearch = resolve;
    });
    let activeSearchCount = 0;
    let maxActiveSearchCount = 0;
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          activeSearchCount += 1;
          maxActiveSearchCount = Math.max(maxActiveSearchCount, activeSearchCount);
          const currentSeat = symbolRegistry.getSeatState('LONG');
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'SEARCHING',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });

          if (calls.length === 1) {
            await firstSearch;
            const searchingSeat = symbolRegistry.getSeatState('LONG');
            symbolRegistry.updateSeatState('LONG', {
              symbol: null,
              status: 'EMPTY',
              lastSwitchAt: searchingSeat.lastSwitchAt,
              lastSearchAt: params.currentTime.getTime(),
              lastSeatActivatedAt: searchingSeat.lastSeatActivatedAt,
              callPrice: null,
              searchFailCountToday: searchingSeat.searchFailCountToday + 1,
              frozenTradingDayKey: null,
            });
          } else {
            symbolRegistry.updateSeatState('LONG', {
              symbol: 'BULL.HK',
              status: 'ACTIVATING',
              lastSwitchAt: timers.now().getTime(),
              lastSearchAt: params.currentTime.getTime(),
              lastSeatActivatedAt: null,
              callPrice: 20_000,
              searchFailCountToday: 0,
              frozenTradingDayKey: null,
            });
          }

          activeSearchCount -= 1;
        },
      }),
    });
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: { canTrade: true, isTradingEnabled: true, isHalfDay: false },
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);
    expect(calls).toHaveLength(1);

    timers.setNow(startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS + 1);
    resolveFirstSearch();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(calls).toHaveLength(2);
    expect(maxActiveSearchCount).toBe(1);
    expect(timers.getPendingTimerAts()).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('慢速受控外部失败已跨过 cooldown 时释放 route 后立即重触发', async () => {
    const startMs = Date.parse('2026-04-10T02:00:00.000Z');
    const timers = createTimerHarness(startMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    let resolveExternalFailure = (): void => {
      throw new Error('expected external failure resolver');
    };
    const externalFailure = new Promise<void>((resolve) => {
      resolveExternalFailure = resolve;
    });
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
          const currentSeat = symbolRegistry.getSeatState('LONG');
          symbolRegistry.updateSeatState('LONG', {
            symbol: null,
            status: 'SEARCHING',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: currentSeat.searchFailCountToday,
            frozenTradingDayKey: currentSeat.frozenTradingDayKey,
          });

          if (calls.length === 1) {
            await externalFailure;
            const searchingSeat = symbolRegistry.getSeatState('LONG');
            symbolRegistry.updateSeatState('LONG', {
              symbol: null,
              status: 'EMPTY',
              lastSwitchAt: searchingSeat.lastSwitchAt,
              lastSearchAt: params.currentTime.getTime(),
              lastSeatActivatedAt: searchingSeat.lastSeatActivatedAt,
              callPrice: null,
              searchFailCountToday: searchingSeat.searchFailCountToday + 1,
              frozenTradingDayKey: null,
            });
            return;
          }

          symbolRegistry.updateSeatState('LONG', {
            symbol: 'BULL.HK',
            status: 'ACTIVATING',
            lastSwitchAt: timers.now().getTime(),
            lastSearchAt: params.currentTime.getTime(),
            lastSeatActivatedAt: null,
            callPrice: 20_000,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          });
        },
      }),
    });
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: { canTrade: true, isTradingEnabled: true, isHalfDay: false },
      tradingGateEventRuntime: createTradingGateEventRuntime(),
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);
    timers.setNow(startMs + AUTO_SYMBOL_SEARCH_COOLDOWN_MS + 1);
    resolveExternalFailure();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(calls).toHaveLength(2);
    expect(timers.getPendingTimerAts()).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('自动寻标开盘延迟超长时按安全分段注册，到真实延迟结束才寻标', async () => {
    const openMs = Date.parse('2026-04-10T01:30:00.000Z');
    const openDelayMinutes = Math.ceil(
      (TIME.MAX_TIMER_DELAY_MS + 5) / TIME.MILLISECONDS_PER_MINUTE,
    );
    const delayEndMs = openMs + openDelayMinutes * TIME.MILLISECONDS_PER_MINUTE;
    const timers = createTimerHarness(openMs);
    const monitorConfig = createAutoSearchEnabledMonitorConfig({
      autoSearchOpenDelayMinutes: openDelayMinutes,
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: timers.now,
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    runtime.start();
    await Bun.sleep(0);

    expect(calls).toHaveLength(0);
    expect(timers.getPendingTimerAts()).toEqual([openMs + TIME.MAX_TIMER_DELAY_MS]);

    timers.setNow(openMs + TIME.MAX_TIMER_DELAY_MS);
    timers.fireNext();
    await Bun.sleep(0);

    expect(calls).toHaveLength(0);
    expect(timers.getPendingTimerAts()).toEqual([delayEndMs]);

    timers.setNow(delayEndMs);
    timers.fireNext();
    await Bun.sleep(0);
    await runtime.stopAndDrain();

    expect(calls.map((call) => call.direction)).toEqual(['LONG']);
  });

  it('seat truth 变化只按方向重算，不再要求 monitorSymbol fail-fast', async () => {
    const monitorConfig = createAutoSearchEnabledMonitorConfig();
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    makeSeatEmpty(symbolRegistry, monitorConfig.monitorSymbol);
    const calls: SearchOnEventParams[] = [];
    const monitorContext = createMonitorContextDouble({
      config: monitorConfig,
      symbolRegistry,
      autoSymbolManager: createAutoSymbolManagerDouble({
        maybeSearchOnEvent: async (params) => {
          calls.push(params);
        },
      }),
    });
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const runtime = createAutoSearchWakeupRuntime({
      symbolRegistry,
      monitorContext,
      lastState: {
        canTrade: true,
        isTradingEnabled: true,
        isHalfDay: false,
      },
      tradingGateEventRuntime,
      doomsdayProtectionEnabled: false,
      now: () => new Date('2026-04-10T02:00:00.000Z'),
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    runtime.start();

    expect(() => {
      symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        callPrice: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    }).not.toThrow();

    await runtime.stopAndDrain();
    expect(calls.map((call) => call.direction)).toEqual(['LONG', 'LONG']);
  });
});
