/**
 * app 顶层组装入口模块
 *
 * 职责：
 * - 收口 pre-gate / post-gate runtime 创建
 * - 保持启动快照失败后阻断交易并切换到开盘重建重试的语义不变
 * - 在唯一装配入口中复用 monitorContext，并组装 async runtime、lifecycle 与 cleanup
 */
import { timeWakeupEvaluationProgram } from '../main/timeWakeupEvaluationProgram/index.js';
import { createTerminationRuntime } from './runtime/createTerminationRuntime.js';
import { createSelectedStrategy } from './startup/createSelectedStrategy.js';
import { isExternalApiRequestError } from '../utils/apiFailure/index.js';
import { syncMonitorContextSymbolNames } from './context/createMonitorContext.js';
import { DEFAULT_RUN_APP_DEPS } from './runAppDeps.js';
import type { AppEnvironmentParams, RunAppDeps, RuntimeAssemblyResources } from './types.js';
import type { RuntimeClock, RuntimeScheduler } from '../types/runtime.js';

const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => new Date(),
};

const SYSTEM_RUNTIME_SCHEDULER: RuntimeScheduler = {
  scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle);
  },
};

/**
 * 构造 app 运行期统一环境快照。
 * 默认行为：以进程环境为基线，允许调用方显式覆盖同名键。
 *
 * @param env 调用方传入的环境变量对象
 * @returns 完整环境变量快照
 */
function buildAppRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
  };
}

/**
 * 创建 app 主入口。
 *
 * @param deps app 组装链路依赖
 * @returns runApp 函数
 */
function createRunApp(deps: RunAppDeps): (params: AppEnvironmentParams) => Promise<void> {
  const {
    createPreGateRuntime: buildPreGateRuntime,
    createPostGateRuntime: buildPostGateRuntime,
    loadStartupSnapshot: loadStartupRuntimeSnapshot,
    collectRuntimeValidationSymbols: buildRuntimeValidationCollector,
    createRebuildTradingDayState: buildRebuildTradingDayState,
    displayAccountAndPositions: renderAccountAndPositions,
    prepareStrategy: prepareSelectedStrategy,
    subscribeShutdownSignal,
    createBusinessEventProgram: buildBusinessEventProgram,
    createAsyncRuntime: buildAsyncRuntime,
    createLifecycleRuntime: buildLifecycleRuntime,
    createCleanup: buildCleanup,
    createTimeWakeupRuntime: buildTimeWakeupRuntime,
    logger: appLogger,
    formatError: formatAppError,
    validateRuntimeSymbolsFromQuotesMap: validateRuntimeSymbols,
    applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
  } = deps;

  return async function runApp(params: AppEnvironmentParams): Promise<void> {
    const runtimeEnv = buildAppRuntimeEnv(params.env);
    const cleanup = buildCleanup();
    const resources: RuntimeAssemblyResources = {};
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        if (resources.lastState !== undefined) resources.lastState.isTradingEnabled = false;
      },
      closeProducerAdmission: () => {
        resources.buyTaskQueue?.close();
        resources.sellTaskQueue?.close();
        resources.monitorTaskQueue?.close();
      },
      stopProducers: [
        () => resources.strategy?.invalidateAll(),
        () => resources.timeWakeupRuntime?.stop(),
        () => resources.businessEventProgram?.stop(),
        () => resources.postTradeConsistencyRuntime?.abortWaiting(),
        () => resources.postTradeConsistencyRuntime?.stopScheduling(),
        () => resources.tradingRiskEventRuntime?.stop(),
        () => resources.monitorQuoteEventRuntime?.stop(),
        () => resources.tradingQuoteDisplayRuntime?.stop(),
        () => resources.switchWakeupRuntime?.stop(),
        () => resources.periodicSwitchWakeupRuntime?.stop(),
        () => resources.autoSearchWakeupRuntime?.stop(),
        () => resources.seatActivationDispatcher?.stop(),
        () => resources.seatRuntimeCleanupDispatcher?.stop(),
        () => resources.monitorTaskProcessor?.stop(),
        () => resources.buyProcessor?.stop(),
        () => resources.sellProcessor?.stop(),
      ],
      onSecondaryError: (error) => {
        appLogger.error('[runApp] 次要终止错误', formatAppError(error));
      },
    });

    async function assembleAndRun(): Promise<void> {
      const unsubscribeShutdown = subscribeShutdownSignal(termination.requestShutdown);
      cleanup.register({
        phase: 'UNSUBSCRIBE_SHUTDOWN_SIGNAL',
        step: '取消退出信号监听',
        handler: unsubscribeShutdown,
      });

      if (termination.isTerminated()) return;

      const selection = await prepareSelectedStrategy({ env: runtimeEnv });
      if (termination.isTerminated()) return;

      const strategy = createSelectedStrategy(
        selection,
        {
          clock: SYSTEM_RUNTIME_CLOCK,
          scheduler: SYSTEM_RUNTIME_SCHEDULER,
          logger: appLogger,
          onFatalError: termination.reportFatalError,
        },
        cleanup,
      );
      resources.strategy = strategy;
      if (termination.isTerminated()) return;

      const preGateRuntime = await buildPreGateRuntime({ env: runtimeEnv, cleanup, termination });
      if (preGateRuntime === null || termination.isTerminated()) return;

      const startupNow = SYSTEM_RUNTIME_CLOCK.now();
      const postGateRuntime = await buildPostGateRuntime({
        env: runtimeEnv,
        preGateRuntime,
        now: startupNow,
        clock: SYSTEM_RUNTIME_CLOCK,
        scheduler: SYSTEM_RUNTIME_SCHEDULER,
        cleanup,
        logger: appLogger,
        termination,
        resources,
        strategy,
      });
      if (postGateRuntime === null || termination.isTerminated()) return;

      const startupSnapshot = await loadStartupRuntimeSnapshot({
        now: startupNow,
        lastState: postGateRuntime.lastState,
        loadTradingDayRuntimeSnapshot: postGateRuntime.loadTradingDayRuntimeSnapshot,
        applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
        logger: appLogger,
        formatError: formatAppError,
      });
      if (termination.isTerminated()) return;

      const runtimeValidationCollector = buildRuntimeValidationCollector({
        tradingConfig: preGateRuntime.tradingConfig,
        symbolRegistry: preGateRuntime.symbolRegistry,
        positions: postGateRuntime.lastState.cachedPositions,
      });

      if (startupSnapshot.kind === 'API_RETRY_PENDING') {
        appLogger.warn('启动快照 API 请求失败，跳过运行时标的验证，等待生命周期重建恢复');
      } else {
        const runtimeValidationResult = validateRuntimeSymbols({
          inputs: runtimeValidationCollector.runtimeValidationInputs,
          quotesMap: startupSnapshot.quotesMap,
        });
        if (runtimeValidationResult.warnings.length > 0) {
          appLogger.warn('标的验证出现警告：');
          for (const [index, warning] of runtimeValidationResult.warnings.entries()) {
            appLogger.warn(`${index + 1}. ${warning}`);
          }
        }

        if (!runtimeValidationResult.valid) {
          appLogger.error('标的验证失败！');
          appLogger.error('='.repeat(60));
          for (const [index, error] of runtimeValidationResult.errors.entries()) {
            appLogger.error(`${index + 1}. ${error}`);
          }

          appLogger.error('='.repeat(60));
          const startupAbortError = new Error('运行时标的验证失败，启动已中止');
          startupAbortError.name = 'AppStartupAbortError';
          throw startupAbortError;
        }
      }

      const monitorContext = postGateRuntime.monitorContext;
      if (startupSnapshot.kind === 'READY') {
        syncMonitorContextSymbolNames({
          monitorContext,
          quotesMap: startupSnapshot.quotesMap,
        });
      }

      const rebuildTradingDayState = buildRebuildTradingDayState({
        termination,
        marketDataClient: preGateRuntime.marketDataClient,
        trader: postGateRuntime.trader,
        lastState: postGateRuntime.lastState,
        symbolRegistry: preGateRuntime.symbolRegistry,
        monitorContext,
        dailyLossTracker: postGateRuntime.dailyLossTracker,
        displayAccountAndPositions: renderAccountAndPositions,
      });

      const asyncRuntime = buildAsyncRuntime({
        preGateRuntime,
        postGateRuntime,
        clock: SYSTEM_RUNTIME_CLOCK,
        scheduler: SYSTEM_RUNTIME_SCHEDULER,
        termination,
        resources,
        cleanup,
      });
      if (asyncRuntime === null || termination.isTerminated()) return;

      const businessEventProgram = buildBusinessEventProgram({
        clock: SYSTEM_RUNTIME_CLOCK,
        marketDataClient: preGateRuntime.marketDataClient,
        monitorContext,
        lastState: postGateRuntime.lastState,
        tradingConfig: preGateRuntime.tradingConfig,
        buyTaskQueue: postGateRuntime.buyTaskQueue,
        sellTaskQueue: postGateRuntime.sellTaskQueue,
        termination,
        monitorDisplayRuntime: postGateRuntime.monitorDisplayRuntime,
      });
      resources.businessEventProgram = businessEventProgram;
      cleanup.register({
        phase: 'STOP_BUSINESS_EVENT_PROGRAM',
        step: '停止 BusinessEventProgram',
        handler: () => businessEventProgram.stopAndDrain(),
      });

      if (termination.isTerminated()) return;

      const dayLifecycleManager = buildLifecycleRuntime({
        termination,
        logger: appLogger,
        preGateRuntime,
        postGateRuntime,
        asyncRuntime,
        businessEventProgram,
        rebuildTradingDayState,
      });

      const timeWakeupRuntime = buildTimeWakeupRuntime({
        termination,
        evaluate: () =>
          timeWakeupEvaluationProgram({
            logger: appLogger,
            marketDataClient: preGateRuntime.marketDataClient,
            trader: postGateRuntime.trader,
            lastState: postGateRuntime.lastState,
            doomsdayProtection: postGateRuntime.doomsdayProtection,
            tradingConfig: preGateRuntime.tradingConfig,
            monitorContext,
            tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
            quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
            dayLifecycleManager,
            now: SYSTEM_RUNTIME_CLOCK.now,
          }),
        now: SYSTEM_RUNTIME_CLOCK.now,
        scheduleTimer: SYSTEM_RUNTIME_SCHEDULER.scheduleTimer,
        clearTimer: SYSTEM_RUNTIME_SCHEDULER.clearTimer,
        logger: appLogger,
      });
      resources.timeWakeupRuntime = timeWakeupRuntime;
      cleanup.register({
        phase: 'STOP_TIME_WAKEUP_RUNTIME',
        step: '停止 TimeWakeupRuntime',
        handler: () => timeWakeupRuntime.stopAndDrain(),
      });

      if (termination.isTerminated()) return;

      let initialRebuildSucceeded = false;
      if (startupSnapshot.kind === 'API_RETRY_PENDING') {
        appLogger.warn('启动阶段跳过初次重建，保持静止并等待生命周期重建任务自动恢复');
      } else {
        try {
          await rebuildTradingDayState({
            allOrders: startupSnapshot.allOrders,
            quotesMap: startupSnapshot.quotesMap,
            now: startupSnapshot.now,
          });
          initialRebuildSucceeded = true;
        } catch (err) {
          if (!isExternalApiRequestError(err)) {
            throw err;
          }

          applyStartupSnapshotFailure(postGateRuntime.lastState);
          appLogger.error(
            '启动初始重建 API 请求失败：已阻断交易并切换为开盘重建重试模式',
            formatAppError(err),
          );
        }
      }

      if (termination.isTerminated()) return;

      if (initialRebuildSucceeded) {
        postGateRuntime.postTradeConsistencyRuntime.start();
        postGateRuntime.postTradeConsistencyRuntime.completeRebuildBaseline();
        await postGateRuntime.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
        if (termination.isTerminated()) return;

        postGateRuntime.tradingQuoteDisplayRuntime.start();
        postGateRuntime.quoteSubscriptionRuntime.start();
        postGateRuntime.seatRuntimeCleanupDispatcher.start();
        postGateRuntime.seatActivationDispatcher.start();
        postGateRuntime.autoSearchWakeupRuntime.start();
        postGateRuntime.periodicSwitchWakeupRuntime.start();
        postGateRuntime.monitorDisplayRuntime.start();
        postGateRuntime.tradingRiskEventRuntime.start();
        postGateRuntime.monitorQuoteEventRuntime.start();
        postGateRuntime.switchWakeupRuntime.start();
        asyncRuntime.monitorTaskProcessor.start();
        asyncRuntime.buyProcessor.start();
        asyncRuntime.sellProcessor.start();
        postGateRuntime.trader.startOrderMonitorRuntime();
      }

      await timeWakeupRuntime.start();
      if (termination.isTerminated()) return;

      if (initialRebuildSucceeded) businessEventProgram.start();

      appLogger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');
      await termination.waitForTermination();
    }

    try {
      await assembleAndRun();
    } catch (error) {
      termination.reportFatalError(error);
    }

    termination.requestShutdown();
    try {
      await cleanup.execute();
    } catch (cleanupError) {
      const fatalState = termination.getFatalState();
      if (!fatalState.hasFatalError) throw cleanupError;

      appLogger.error('[runApp] cleanup 失败，保留原始错误', formatAppError(cleanupError));
    }

    const fatalState = termination.getFatalState();
    if (fatalState.hasFatalError) throw fatalState.error;

    appLogger.debug('[App] 运行与清理完成，即将正常返回');
  };
}

/** 运行唯一 app 装配，待当前资源创建落定后统一排空，保留首个原始 fatal。 */
export const runApp = createRunApp(DEFAULT_RUN_APP_DEPS);
