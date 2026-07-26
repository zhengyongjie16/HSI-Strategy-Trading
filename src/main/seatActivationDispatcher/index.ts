/**
 * SeatActivationDispatcher
 *
 * 职责：
 * - 在 runtime 阶段监听 seat 进入 ACTIVATING
 * - 立即调度 SEAT_REFRESH，保留现有激活屏障语义
 * - 仅缓存 SWITCHING -> ACTIVATING 之间所需的旧标的，不持有 seat 真相
 */
import { logger } from '../../utils/logger/index.js';
import type { SeatState, SeatStateChangedEvent } from '../../types/seat.js';
import type {
  PendingSeatActivation,
  SeatActivationDispatcher,
  SeatActivationDispatcherDeps,
  SeatActivationRouteKey,
} from './types.js';

function buildSeatActivationRouteKey(params: {
  readonly direction: 'LONG' | 'SHORT';
}): SeatActivationRouteKey {
  return params.direction;
}

function resolveNextSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'ACTIVATING' || !seatState.symbol) {
    return null;
  }

  return seatState.symbol;
}

function dispatchCurrentActivatingSeat(params: {
  readonly deps: SeatActivationDispatcherDeps;
  readonly direction: 'LONG' | 'SHORT';
}): void {
  const nextState = params.deps.symbolRegistry.getSeatState(params.direction);
  if (nextState.status !== 'ACTIVATING') {
    return;
  }

  scheduleSeatRefresh({
    deps: params.deps,
    direction: params.direction,
    seatVersion: params.deps.symbolRegistry.getSeatVersion(params.direction),
    previousSymbol: null,
    nextState,
  });
}

/**
 * 为进入 ACTIVATING 的席位提交 latest-only 刷新任务。
 *
 * 按方向复用固定 dedupe key，使较新的 seatVersion 替换尚未消费的旧刷新；任务保留旧标的，
 * 供激活屏障完成订阅、订单归属和风险缓存切换。ACTIVATING 缺少标的是内部状态错误，
 * 必须在入队前立即暴露。
 *
 * @param params 当前方向的席位版本、切换前后标的及任务队列依赖
 * @returns 无返回值
 * @throws nextState 不是带有效标的的 ACTIVATING 状态时抛出
 */
function scheduleSeatRefresh(params: {
  readonly deps: SeatActivationDispatcherDeps;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
  readonly previousSymbol: string | null;
  readonly nextState: SeatState;
}): void {
  const nextSymbol = resolveNextSymbol(params.nextState);
  if (nextSymbol === null) {
    throw new Error(
      `[SeatActivationDispatcher] ACTIVATING 席位缺少标的: direction=${params.direction} seatVersion=${params.seatVersion}`,
    );
  }

  const dedupeKey = `SEAT_REFRESH:${params.direction}`;
  params.deps.monitorTaskQueue.scheduleLatest({
    type: 'SEAT_REFRESH',
    dedupeKey,
    data: {
      direction: params.direction,
      seatVersion: params.seatVersion,
      previousSymbol: params.previousSymbol,
      nextSymbol,
      callPrice: params.nextState.callPrice ?? null,
      symbolName: null,
    },
  });

  logger.debug(
    `[SEAT_REFRESH scheduled] direction=${params.direction} seatVersion=${params.seatVersion} previousSymbol=${params.previousSymbol ?? 'null'} nextSymbol=${nextSymbol} dedupeKey=${dedupeKey}`,
  );
}

/**
 * 创建席位激活调度器。
 *
 * @param deps 调度依赖
 * @returns SeatActivationDispatcher 实例
 */
export function createSeatActivationDispatcher(
  deps: SeatActivationDispatcherDeps,
): SeatActivationDispatcher {
  let running = false;
  let unsubscribeSeatStateChanged: (() => void) | null = null;
  const pendingActivations = new Map<SeatActivationRouteKey, PendingSeatActivation>();

  function clearPendingActivation(direction: 'LONG' | 'SHORT'): void {
    pendingActivations.delete(buildSeatActivationRouteKey({ direction }));
  }

  function rememberPendingActivation(event: SeatStateChangedEvent): void {
    const routeKey = buildSeatActivationRouteKey({
      direction: event.direction,
    });

    pendingActivations.set(routeKey, {
      seatVersion: event.nextVersion,
      oldSymbol: event.previousState.symbol ?? null,
    });
  }

  function resolvePreviousSymbol(event: SeatStateChangedEvent): string | null {
    const routeKey = buildSeatActivationRouteKey({
      direction: event.direction,
    });
    const pendingActivation = pendingActivations.get(routeKey);
    if (pendingActivation?.seatVersion === event.nextVersion) {
      return pendingActivation.oldSymbol;
    }

    return event.previousState.symbol ?? null;
  }

  function handleSeatStateChanged(event: SeatStateChangedEvent): void {
    if (event.nextState.status === 'SWITCHING') {
      rememberPendingActivation(event);
      return;
    }

    if (event.nextState.status !== 'ACTIVATING') {
      clearPendingActivation(event.direction);
      return;
    }

    const previousSymbol = resolvePreviousSymbol(event);
    clearPendingActivation(event.direction);

    scheduleSeatRefresh({
      deps,
      direction: event.direction,
      seatVersion: event.nextVersion,
      previousSymbol,
      nextState: event.nextState,
    });
  }

  function dispatchCurrentActivatingSeats(): void {
    if (running) {
      return;
    }

    dispatchCurrentActivatingSeat({
      deps,
      direction: 'LONG',
    });

    dispatchCurrentActivatingSeat({
      deps,
      direction: 'SHORT',
    });
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    pendingActivations.clear();
    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatStateChanged);
  }

  function stop(): void {
    running = false;
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
    pendingActivations.clear();
  }

  return {
    start,
    stop,
    dispatchCurrentActivatingSeats,
  };
}
