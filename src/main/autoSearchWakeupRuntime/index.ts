/**
 * AutoSearchWakeupRuntime
 *
 * 职责：
 * - 接管运行期 EMPTY seat 的自动寻标推进
 * - 消费 seat/gate/timer 显式唤醒源
 * - 每次唤醒重新读取权威状态，不维护 seat 事实副本
 */
import { AUTO_SYMBOL_SEARCH_COOLDOWN_MS, TIME } from '../../constants/index.js';
import { toError } from '../../utils/error/index.js';
import { scheduleBoundedOneShotAt } from '../../utils/timer/index.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { BoundedOneShotTimerController } from '../../utils/timer/types.js';
import {
  getRequiredHKDateKey,
  resolveHKDayStartUtcMs,
  isWithinMorningOpenWindow,
} from '../../utils/time/index.js';
import type { TradingGateStateChangedEvent } from '../tradingGateEventRuntime/types.js';
import type {
  AutoSearchRouteKey,
  AutoSearchWakeupRuntime,
  AutoSearchWakeupRuntimeDeps,
} from './types.js';
import { isSeatFrozenToday } from '../../services/autoSymbolManager/utils.js';

const AUTO_SEARCH_DIRECTIONS: ReadonlyArray<'LONG' | 'SHORT'> = ['LONG', 'SHORT'];

function buildRouteKey(params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
}): AutoSearchRouteKey {
  return `${params.direction}:${params.seatVersion}`;
}

function resolveOpenDelayEndMs(currentTime: Date, delayMinutes: number): number | null {
  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
    return null;
  }

  const dayStartMs = resolveHKDayStartUtcMs(getRequiredHKDateKey(currentTime));
  if (dayStartMs === null) {
    return null;
  }

  return dayStartMs + (9 * 60 + 30 + delayMinutes) * TIME.MILLISECONDS_PER_MINUTE;
}

/**
 * 创建自动寻标事件 runtime。
 *
 * @param deps runtime 依赖
 * @returns AutoSearchWakeupRuntime 实例
 */
export function createAutoSearchWakeupRuntime(
  deps: AutoSearchWakeupRuntimeDeps,
): AutoSearchWakeupRuntime {
  let running = false;
  let unsubscribeSeatStateChanged: (() => void) | null = null;
  let unsubscribeGateStateChanged: (() => void) | null = null;
  const timers = new Map<AutoSearchRouteKey, BoundedOneShotTimerController>();
  const activeRouteKeys = new Set<AutoSearchRouteKey>();
  const activePromises = new Set<Promise<void>>();
  const fatalRejectors = new Set<(error: Error) => void>();
  let fatalError: Error | null = null;

  function clearRouteTimer(routeKey: AutoSearchRouteKey): void {
    const timer = timers.get(routeKey);
    if (timer === undefined) {
      return;
    }

    timer.cancel();
    timers.delete(routeKey);
  }

  function scheduleRouteTimer(params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly seatVersion: number;
    readonly atMs: number;
  }): void {
    const routeKey = buildRouteKey(params);
    clearRouteTimer(routeKey);
    const timer = scheduleBoundedOneShotAt({
      atMs: params.atMs,
      now: deps.now,
      scheduleTimer: deps.scheduleTimer,
      clearTimer: deps.clearTimer,
      onDue: () => {
        timers.delete(routeKey);
        triggerSeat(params.direction, params.seatVersion);
      },
    });
    timers.set(routeKey, timer);
  }

  function handleFatalError(error: unknown): void {
    if (fatalError !== null) {
      return;
    }

    fatalError = toError(error);
    for (const reject of fatalRejectors) {
      reject(fatalError);
    }

    fatalRejectors.clear();
  }

  function drainFatalError(): Promise<never> {
    if (fatalError !== null) {
      return Promise.reject(fatalError);
    }

    return new Promise<never>((_, reject) => {
      fatalRejectors.add(reject);
    });
  }

  function registerActivePromise(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.catch(handleFatalError).finally(() => {
      activePromises.delete(promise);
    });
  }

  function triggerSeat(direction: 'LONG' | 'SHORT', expectedSeatVersion?: number): void {
    if (!running) {
      return;
    }

    const routeKey = buildRouteKey({
      direction,
      seatVersion: expectedSeatVersion ?? deps.symbolRegistry.getSeatVersion(direction),
    });
    if (activeRouteKeys.has(routeKey)) {
      return;
    }

    activeRouteKeys.add(routeKey);
    const promise = processSeat(direction, expectedSeatVersion, routeKey);
    registerActivePromise(promise);
  }

  /** 基于一次真实寻标完成后的权威席位事实，交接唯一 cooldown owner。 */
  function handoffAuthoritativeCooldownOwner(direction: 'LONG' | 'SHORT'): void {
    if (
      !running ||
      !deps.lastState.isTradingEnabled ||
      deps.lastState.canTrade !== true ||
      !deps.monitorContext.config.autoSearchConfig.autoSearchEnabled
    ) {
      return;
    }

    const seatState = deps.symbolRegistry.getSeatState(direction);
    if (seatState.status !== 'EMPTY' || isSeatFrozenToday(seatState)) {
      return;
    }

    if (seatState.lastSearchAt === null) {
      return;
    }

    const seatVersion = deps.symbolRegistry.getSeatVersion(direction);
    const cooldownEndMs = seatState.lastSearchAt + AUTO_SYMBOL_SEARCH_COOLDOWN_MS;
    if (cooldownEndMs <= deps.now().getTime()) {
      triggerSeat(direction, seatVersion);
      return;
    }

    scheduleRouteTimer({
      direction,
      seatVersion,
      atMs: cooldownEndMs,
    });
  }

  /**
   * 对单个 EMPTY seat 做一次权威重评估。
   * 冷却或开盘延迟未到时只登记下一次 one-shot timer，不在 runtime 内轮询。
   */
  async function processSeat(
    direction: 'LONG' | 'SHORT',
    expectedSeatVersion: number | undefined,
    activeRouteKey: AutoSearchRouteKey,
  ): Promise<void> {
    let shouldHandoffCooldownOwner = false;
    try {
      if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
        return;
      }

      const monitorContext = deps.monitorContext;

      if (!monitorContext.config.autoSearchConfig.autoSearchEnabled) {
        return;
      }

      const seatState = deps.symbolRegistry.getSeatState(direction);
      const seatVersion = deps.symbolRegistry.getSeatVersion(direction);
      const routeKey = buildRouteKey({ direction, seatVersion });
      if (expectedSeatVersion !== undefined && expectedSeatVersion !== seatVersion) {
        return;
      }

      if (seatState.status !== 'EMPTY') {
        clearRouteTimer(routeKey);
        return;
      }

      const now = deps.now();
      const nowMs = now.getTime();
      const lastSearchAt = seatState.lastSearchAt ?? 0;
      const cooldownEndMs = lastSearchAt + AUTO_SYMBOL_SEARCH_COOLDOWN_MS;
      if (nowMs < cooldownEndMs) {
        scheduleRouteTimer({
          direction,
          seatVersion,
          atMs: cooldownEndMs,
        });
        return;
      }

      const openDelayMinutes = monitorContext.config.autoSearchConfig.autoSearchOpenDelayMinutes;
      if (openDelayMinutes > 0 && isWithinMorningOpenWindow(now, openDelayMinutes)) {
        const openDelayEndMs = resolveOpenDelayEndMs(now, openDelayMinutes);
        if (openDelayEndMs !== null) {
          scheduleRouteTimer({
            direction,
            seatVersion,
            atMs: openDelayEndMs,
          });
        }

        return;
      }

      await monitorContext.autoSymbolManager.maybeSearchOnEvent({
        direction,
        currentTime: now,
        canTradeNow: deps.lastState.canTrade,
      });
      shouldHandoffCooldownOwner = true;
    } finally {
      activeRouteKeys.delete(activeRouteKey);
      if (shouldHandoffCooldownOwner) {
        handoffAuthoritativeCooldownOwner(direction);
      }
    }
  }

  function handleSeatStateChanged(event: SeatStateChangedEvent): void {
    if (event.nextState.status !== 'EMPTY') {
      return;
    }

    if (!deps.monitorContext.config.autoSearchConfig.autoSearchEnabled) {
      return;
    }

    const routeKey = buildRouteKey({
      direction: event.direction,
      seatVersion: event.nextVersion,
    });
    if (activeRouteKeys.has(routeKey)) {
      return;
    }

    triggerSeat(event.direction);
  }

  function handleGateStateChanged(event: TradingGateStateChangedEvent): void {
    if (!event.nextCanTrade || event.previousCanTrade) {
      return;
    }

    for (const direction of AUTO_SEARCH_DIRECTIONS) {
      if (!deps.monitorContext.config.autoSearchConfig.autoSearchEnabled) {
        continue;
      }

      const seatState = deps.symbolRegistry.getSeatState(direction);
      if (seatState.status === 'EMPTY') {
        triggerSeat(direction);
      }
    }
  }

  function seedEmptySeats(): void {
    for (const direction of AUTO_SEARCH_DIRECTIONS) {
      if (!deps.monitorContext.config.autoSearchConfig.autoSearchEnabled) {
        continue;
      }

      const seatState = deps.symbolRegistry.getSeatState(direction);
      if (seatState.status === 'EMPTY') {
        triggerSeat(direction);
      }
    }
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatStateChanged);
    unsubscribeGateStateChanged =
      deps.tradingGateEventRuntime.onGateStateChanged(handleGateStateChanged);
    seedEmptySeats();
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
    unsubscribeGateStateChanged?.();
    unsubscribeGateStateChanged = null;
    for (const routeKey of timers.keys()) {
      clearRouteTimer(routeKey);
    }

    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }
  }

  return {
    start,
    stopAndDrain,
    drainFatalError,
  };
}
