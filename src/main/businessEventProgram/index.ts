/**
 * 普通行情事件宿主：single-flight/latest-only 读取权威缓存，冻结中性输入，调用策略一次。
 * 策略独占指标/采样/pending；宿主独占交易日、席位授权、普通 Signal 与 queue admission。
 */
import { TRADING } from '../../constants/index.js';
import { ordinarySignalGuard } from '../ordinarySignalGuard/index.js';
import { createStrategyEmitter } from './emissionAdapter.js';
import { isValidDayKey, isValidTimeMs, projectCandlesticks } from './utils.js';
import type { StrategyMarketContext } from '../../core/strategy/types.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
  StrategyOriginRoute,
} from './types.js';

/** 创建单 monitor 行情 owner；同步 stop 不触发异步 drain，最终终态不可重启。 */
export function createBusinessEventProgram(deps: BusinessEventProgramDeps): BusinessEventProgram {
  const { monitorContext, marketDataClient, clock, termination } = deps;
  const monitorSymbol = monitorContext.config.monitorSymbol;
  let running = false;
  let pendingObservedAtMs: number | null = null;
  let processing: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** 停止接收和待处理事件；不作不可逆 close，午休/跨日后可正常恢复。 */
  function stop(): void {
    running = false;
    unsubscribe?.();
    unsubscribe = null;
    pendingObservedAtMs = null;
  }

  /** 捕获当前授权与输入；策略同步异常须在其调用边界报告 fatal。 */
  function processEvent(observedAtMs: number): void {
    const now = clock.now();
    if (!isValidTimeMs(observedAtMs) || !isValidTimeMs(now.getTime())) {
      throw new Error('普通行情 observed/gate 时间非法');
    }

    const snapshot = marketDataClient.getCandlestickSnapshot(monitorSymbol, TRADING.CANDLE_PERIOD);
    if (snapshot === null) {
      return;
    }

    const dayKey = deps.lastState.currentDayKey;
    const allowNewEvaluation =
      isValidDayKey(dayKey) &&
      deps.lastState.openProtectionActive !== true &&
      ordinarySignalGuard({
        lastState: deps.lastState,
        now,
        doomsdayProtectionEnabled: deps.tradingConfig.global.doomsdayProtection,
      });
    const routes: ReadonlyArray<StrategyOriginRoute> = Object.freeze(
      (['LONG', 'SHORT'] as const).flatMap((direction) => {
        const seat = monitorContext.symbolRegistry.getSeatState(direction);
        if (seat.status !== 'ACTIVE') {
          return [];
        }

        const seatVersion = monitorContext.symbolRegistry.getSeatVersion(direction);
        if (seat.symbol.length === 0 || !Number.isInteger(seatVersion) || seatVersion < 0) {
          throw new Error('普通行情 ACTIVE route 不完整');
        }

        return [
          Object.freeze({
            direction,
            symbol: seat.symbol,
            seatVersion,
            hasFilledBuyOrders:
              monitorContext.orderRecorder.getBuyOrdersForSymbol(seat.symbol, direction === 'LONG')
                .length > 0,
          }),
        ];
      }),
    );
    const context: StrategyMarketContext = Object.freeze({
      candlesticks: projectCandlesticks(snapshot),
      observedAtMs,
      allowNewEvaluation,
      seats: Object.freeze(
        routes.map(({ direction, symbol, hasFilledBuyOrders }) =>
          Object.freeze({ direction, symbol, hasFilledBuyOrders }),
        ),
      ),
    });
    const origin = allowNewEvaluation ? Object.freeze({ dayKey, routes }) : null;
    const emit = createStrategyEmitter(deps, origin);
    let items;
    try {
      items = monitorContext.strategy.onCandlestick(context, emit);
    } catch (error) {
      termination.reportFatalError(error);
      throw error;
    }

    if (items !== null && running && !termination.isTerminated()) {
      deps.monitorDisplayRuntime.requestRender({ items });
    }
  }

  /** 同一调用链只保留最新观测时间；不按缓存版本丢弃采样。 */
  function scheduleProcessing(): void {
    if (processing !== null) {
      return;
    }

    processing = Promise.resolve().then(() => {
      try {
        while (running && !termination.isTerminated() && pendingObservedAtMs !== null) {
          const observedAtMs = pendingObservedAtMs;
          pendingObservedAtMs = null;
          processEvent(observedAtMs);
        }
      } catch (error) {
        termination.reportFatalError(error);
        stop();
      } finally {
        processing = null;
      }
    });
  }

  function start(): void {
    if (running || termination.isTerminated()) {
      return;
    }

    running = true;
    unsubscribe = marketDataClient.onCandlestickUpdated((event) => {
      if (
        !running ||
        termination.isTerminated() ||
        event.period !== TRADING.CANDLE_PERIOD ||
        event.symbol !== monitorSymbol
      ) {
        return;
      }

      try {
        const observedAtMs = clock.now().getTime();
        if (!isValidTimeMs(observedAtMs)) {
          throw new Error('普通行情监听时间非法');
        }

        pendingObservedAtMs = observedAtMs;
        scheduleProcessing();
      } catch (error) {
        termination.reportFatalError(error);
        stop();
        throw error;
      }
    });
  }

  async function stopAndDrain(): Promise<void> {
    stop();
    await processing;
  }

  return { start, stop, stopAndDrain };
}
