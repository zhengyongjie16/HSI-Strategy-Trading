/**
 * businessEventProgram 模块
 *
 * 职责：
 * - 监听 monitor symbol 的 K 线更新事件
 * - 以单 route single-flight + latest-only collapse 推进普通 latest snapshot
 * - 在事件路径中直接生成普通 immediate / delayed signals
 * - 在普通指标推进成功后立即写入 indicatorCache 延迟验证样本
 * - 不负责生命周期时间唤醒、末日保护和周期换标 due 事件
 */
import { TRADING } from '../../constants/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatError, toError } from '../../utils/error/index.js';
import { projectVerificationSampleValues } from '../asyncProgram/indicatorCache/utils.js';
import { runIndicatorPipeline } from './indicatorPipeline.js';
import { runSignalPipeline } from './signalPipeline.js';
import type {
  BusinessEventProgram,
  BusinessEventProgramDeps,
  BusinessEventRouteState,
} from './types.js';

/**
 * 创建普通 K 线业务主程序。
 *
 * @param deps 共享依赖
 * @returns businessEventProgram 实例
 */
export function createBusinessEventProgram(deps: BusinessEventProgramDeps): BusinessEventProgram {
  const {
    marketDataClient,
    monitorContext,
    lastState,
    tradingConfig,
    buyTaskQueue,
    sellTaskQueue,
    indicatorCache,
    monitorDisplayRuntime,
  } = deps;
  const pipelineContext = {
    marketDataClient,
    lastState,
    tradingConfig,
    buyTaskQueue,
    sellTaskQueue,
  };
  const monitorSymbol = monitorContext.config.monitorSymbol;
  let routeState: BusinessEventRouteState = {
    inFlight: false,
    dirty: false,
  };
  const activePromises = new Set<Promise<void>>();
  const fatalRejectors = new Set<(error: Error) => void>();
  let fatalError: Error | null = null;
  let running = false;
  let unsubscribeCandlestickUpdated: (() => void) | null = null;

  function handleFatalError(error: unknown): void {
    if (fatalError !== null) {
      return;
    }

    fatalError = toError(error);
    running = false;
    unsubscribeCandlestickUpdated?.();
    unsubscribeCandlestickUpdated = null;
    routeState = {
      inFlight: false,
      dirty: false,
    };

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

  /**
   * 启动并跟踪唯一 monitor route 的异步调度任务。
   *
   * @param failureMessage 失败日志前缀
   */
  function startMonitorRouteProcessing(failureMessage: string): void {
    const processingPromise = Promise.resolve()
      .then(() => {
        processBusinessEventRoute();
      })
      .catch((error: unknown) => {
        logger.error(
          `[businessEventProgram] ${failureMessage} monitorSymbol=${monitorSymbol}`,
          formatError(error),
        );
        handleFatalError(error);
      });
    activePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activePromises.delete(processingPromise);
    });
  }

  /**
   * 处理唯一 monitor 的 K 线业务链路。
   */
  function processBusinessEventRoute(): void {
    try {
      while (running) {
        if (!routeState.dirty) {
          return;
        }

        const observedAtMs = routeState.pendingObservedAtMs;
        routeState = {
          inFlight: routeState.inFlight,
          dirty: false,
        };

        const monitorSnapshot = runIndicatorPipeline({
          monitorContext,
          mainContext: pipelineContext,
        });
        if (monitorSnapshot === null) {
          continue;
        }

        const verificationIndicators = new Set([
          ...monitorContext.indicatorProfile.verificationIndicatorsBySide.buy,
          ...monitorContext.indicatorProfile.verificationIndicatorsBySide.sell,
        ]);
        indicatorCache.push(
          projectVerificationSampleValues(monitorSnapshot, [...verificationIndicators]),
          observedAtMs,
        );

        monitorDisplayRuntime.requestRender({
          monitorSnapshot,
        });

        runSignalPipeline({
          monitorContext,
          mainContext: pipelineContext,
          runtimeFlags: {
            currentTime: new Date(),
            openProtectionActive: lastState.openProtectionActive === true,
          },
          monitorSnapshot,
        });
      }
    } finally {
      const idleRouteState: BusinessEventRouteState = routeState.dirty
        ? {
            inFlight: false,
            dirty: true,
            pendingObservedAtMs: routeState.pendingObservedAtMs,
          }
        : {
            inFlight: false,
            dirty: false,
          };
      routeState = idleRouteState;
      if (running && idleRouteState.dirty) {
        routeState = {
          inFlight: true,
          dirty: true,
          pendingObservedAtMs: idleRouteState.pendingObservedAtMs,
        };
        startMonitorRouteProcessing('monitor route 重入失败');
      }
    }
  }

  /**
   * 统一触发唯一 monitor 业务路由。
   *
   * @param observedAtMs 本次 K 线事件被监听到的时间戳
   */
  function triggerMonitorRoute(observedAtMs: number): void {
    routeState = {
      ...routeState,
      dirty: true,
      pendingObservedAtMs: observedAtMs,
    };

    if (routeState.inFlight || !running) {
      return;
    }

    routeState = {
      ...routeState,
      inFlight: true,
    };
    startMonitorRouteProcessing('monitor route 执行失败');
  }

  function start(): void {
    if (running) {
      return;
    }

    fatalError = null;
    running = true;
    unsubscribeCandlestickUpdated = marketDataClient.onCandlestickUpdated((event) => {
      if (event.period !== TRADING.CANDLE_PERIOD) {
        return;
      }

      if (event.symbol !== monitorSymbol) {
        return;
      }

      triggerMonitorRoute(Date.now());
    });
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeCandlestickUpdated?.();
    unsubscribeCandlestickUpdated = null;

    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }

    routeState = {
      inFlight: false,
      dirty: false,
    };
  }

  return {
    start,
    stopAndDrain,
    drainFatalError,
  };
}
