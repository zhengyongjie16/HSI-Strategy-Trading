/**
 * monitorDisplayRuntime 模块
 *
 * 职责：
 * - 接收 businessEventProgram 提交后的 策略中性显示投影渲染请求
 * - 对唯一 monitor 执行 single-flight + latest-only collapse
 * - 在 runtime gate 打开时异步读取当前 monitor quote 并交给纯渲染器输出
 */
import { TRADING } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/error/index.js';
import type {
  MonitorDisplayRouteState,
  MonitorDisplayRuntime,
  MonitorDisplayRuntimeDeps,
} from './types.js';

function isRenderAllowed(
  lastState: MonitorDisplayRuntimeDeps['lastState'],
  running: boolean,
): boolean {
  return running && lastState.isTradingEnabled && lastState.canTrade === true;
}

/**
 * 创建唯一监控标的的异步显示 runtime。
 *
 * runtime 只在交易门禁开启时补取当前行情，并用 single-flight + latest-only 合并积压请求，
 * 避免旧显示投影在异步行情返回后覆盖新输出。单次读取或渲染失败仅记录告警；停止时先关闭
 * 新请求入口并清除待显示投影，再等待全部在途读取收口。
 *
 * @param deps 行情读取、监控上下文、交易门禁与纯渲染端口
 * @returns 可启动、提交渲染请求并停止排空的显示 runtime
 */
export function createMonitorDisplayRuntime(
  deps: MonitorDisplayRuntimeDeps,
): MonitorDisplayRuntime {
  const routeState: MonitorDisplayRouteState = {
    inFlight: false,
    dirty: false,
    latestItems: null,
  };
  const activePromises = new Set<Promise<void>>();
  let running = false;

  function trackPromise(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
  }

  async function processRoute(): Promise<void> {
    const monitorSymbol = deps.monitorContext.config.monitorSymbol;

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;
        const items = routeState.latestItems;
        if (items === null) {
          return;
        }

        if (!isRenderAllowed(deps.lastState, running)) {
          return;
        }

        try {
          const quotesMap = await deps.marketDataClient.getQuotes([monitorSymbol]);
          if (!isRenderAllowed(deps.lastState, running)) {
            return;
          }

          const latestItems = routeState.latestItems;
          if (latestItems === null) {
            return;
          }

          routeState.dirty = false;
          const candlestickSnapshot = deps.marketDataClient.getCandlestickSnapshot(
            monitorSymbol,
            TRADING.CANDLE_PERIOD,
          );
          deps.marketMonitor.renderMonitorIndicators({
            monitorSymbol,
            items: latestItems,
            monitorQuote: quotesMap.get(monitorSymbol) ?? null,
            klineTimestamp: candlestickSnapshot?.lastBarTimestamp ?? null,
          });
        } catch (error) {
          logger.warn(
            `[monitorDisplayRuntime] render failed monitorSymbol=${monitorSymbol}`,
            formatError(error),
          );
        }
      }
    } finally {
      routeState.inFlight = false;
      if (routeState.dirty && running) {
        routeState.inFlight = true;
        trackPromise(processRoute());
      }
    }
  }

  function start(): void {
    running = true;
  }

  /** 接收策略中性投影，并将积压请求合并为最新一次显示。 */
  function requestRender(params: Parameters<MonitorDisplayRuntime['requestRender']>[0]): void {
    if (!running) {
      return;
    }

    routeState.latestItems = params.items;
    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    trackPromise(processRoute());
  }

  /** 同步关闭显示入口并丢弃待显示投影，随后等待在途行情读取结束。 */
  async function stopAndDrain(): Promise<void> {
    running = false;
    routeState.dirty = false;
    routeState.latestItems = null;
    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }
  }

  return {
    start,
    requestRender,
    stopAndDrain,
  };
}
