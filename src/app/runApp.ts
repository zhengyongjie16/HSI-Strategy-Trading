/**
 * app 顶层组装入口模块
 *
 * 职责：
 * - 收口 pre-gate / post-gate runtime 创建
 * - 保持启动快照失败后阻断交易并切换到开盘重建重试的语义不变
 * - 在唯一装配入口中复用 monitorContext，并组装 async runtime、lifecycle 与 cleanup
 */
import { timeWakeupEvaluationProgram } from '../runtime/timeWakeupEvaluationProgram/index.js';
import { createTerminationRuntime } from '../runtime/lifecycle/terminationRuntime.js';
import { startRuntimeAfterStartupRebuild } from '../runtime/lifecycle/startupRuntime.js';
import { createSelectedStrategy } from './startup/createSelectedStrategy.js';
import { createDiagnosticObserver } from '../infrastructure/diagnostics/index.js';
import { syncMonitorContextSymbolNames } from './context/createMonitorContext.js';
import { DEFAULT_RUN_APP_DEPS } from './runAppDeps.js';
import { SYSTEM_RUNTIME_CLOCK, SYSTEM_RUNTIME_SCHEDULER } from '../infrastructure/time/index.js';
import type { AppEnvironmentParams, RunAppDeps, RuntimeAssemblyResources } from './types.js';

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
    executeStartupRebuild: runStartupRebuild,
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
    const diagnostics = createDiagnosticObserver({ logger: appLogger });
    const cleanup = buildCleanup();
    const resources: RuntimeAssemblyResources = {};
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        if (resources.lifecycleState !== undefined)
          resources.lifecycleState.isTradingEnabled = false;
      },
      closeProducerAdmission: () => {
        resources.closeSnapshotAdmission?.();
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

      const preGateRuntime = await buildPreGateRuntime({
        env: runtimeEnv,
        cleanup,
        termination,
        diagnostics,
        clock: SYSTEM_RUNTIME_CLOCK,
      });
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

      const startupTradingEnabled = postGateRuntime.lifecycleState.isTradingEnabled;
      postGateRuntime.lifecycleState.isTradingEnabled = false;
      const startupSnapshot = await loadStartupRuntimeSnapshot({
        now: startupNow,
        termination,
        snapshot: postGateRuntime.snapshot,
        lifecycleState: postGateRuntime.lifecycleState,
        loadTradingDayRuntimeSnapshot: postGateRuntime.loadTradingDayRuntimeSnapshot,
        applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
        logger: appLogger,
        formatError: formatAppError,
      });
      if (termination.isTerminated() || startupSnapshot.kind === 'ABORTED') return;

      const runtimeValidationCollector = buildRuntimeValidationCollector({
        tradingConfig: preGateRuntime.tradingConfig,
        symbolRegistry: preGateRuntime.symbolRegistry,
        positions: postGateRuntime.snapshot.getView().positions,
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
        warrantRiskRefresh: postGateRuntime.warrantRiskRefresh,
        orderMonitor: postGateRuntime.tradeRuntime.orderMonitor,
        lifecycleState: postGateRuntime.lifecycleState,
        tradingCalendarState: postGateRuntime.tradingCalendarState,
        snapshot: postGateRuntime.snapshot,
        symbolRegistry: preGateRuntime.symbolRegistry,
        monitorContext,
        dailyLossTracker: postGateRuntime.dailyLossTracker,
        displayAccountAndPositions: renderAccountAndPositions,
      });

      const asyncRuntime = buildAsyncRuntime({
        logger: appLogger,
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
        tradingTimeState: postGateRuntime.tradingTimeState,
        lifecycleState: postGateRuntime.lifecycleState,
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
            cacheManager: postGateRuntime.tradeRuntime.cacheManager,
            orderMonitor: postGateRuntime.tradeRuntime.orderMonitor,
            orderExecutor: postGateRuntime.tradeRuntime.orderExecutor,
            tradingTimeState: postGateRuntime.tradingTimeState,
            lifecycleState: postGateRuntime.lifecycleState,
            tradingCalendarState: postGateRuntime.tradingCalendarState,
            snapshot: postGateRuntime.snapshot,
            doomsdayClearanceWorkflow: postGateRuntime.doomsdayClearanceWorkflow,
            tradingConfig: preGateRuntime.tradingConfig,
            monitorContext,
            tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
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

      const startupRebuild = await runStartupRebuild({
        now: startupNow,
        diagnostics,
        startupSnapshot,
        termination,
        snapshot: postGateRuntime.snapshot,
        lifecycleState: postGateRuntime.lifecycleState,
        loadStartupSnapshot: loadStartupRuntimeSnapshot,
        loadTradingDayRuntimeSnapshot: postGateRuntime.loadTradingDayRuntimeSnapshot,
        rebuildTradingDayState,
        postTradeConsistencyRuntime: postGateRuntime.postTradeConsistencyRuntime,
        quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
        applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
        validateRuntimeSymbols: ({ positions, quotesMap }) =>
          validateRuntimeSymbols({
            inputs: buildRuntimeValidationCollector({
              tradingConfig: preGateRuntime.tradingConfig,
              symbolRegistry: preGateRuntime.symbolRegistry,
              positions,
            }).runtimeValidationInputs,
            quotesMap,
          }),
        syncMonitorContextSymbolNames: ({ quotesMap }) => {
          syncMonitorContextSymbolNames({ monitorContext, quotesMap });
        },
        logger: appLogger,
        formatError: formatAppError,
      });
      if (termination.isTerminated() || startupRebuild.status === 'ABORTED') return;

      await startRuntimeAfterStartupRebuild({
        termination,
        initialRebuildSucceeded: startupRebuild.status === 'COMMITTED',
        startupTradingEnabled,
        lifecycleState: postGateRuntime.lifecycleState,
        tradingQuoteDisplayRuntime: postGateRuntime.tradingQuoteDisplayRuntime,
        quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
        seatRuntimeCleanupDispatcher: postGateRuntime.seatRuntimeCleanupDispatcher,
        seatActivationDispatcher: postGateRuntime.seatActivationDispatcher,
        autoSearchWakeupRuntime: postGateRuntime.autoSearchWakeupRuntime,
        periodicSwitchWakeupRuntime: postGateRuntime.periodicSwitchWakeupRuntime,
        monitorDisplayRuntime: postGateRuntime.monitorDisplayRuntime,
        tradingRiskEventRuntime: postGateRuntime.tradingRiskEventRuntime,
        monitorQuoteEventRuntime: postGateRuntime.monitorQuoteEventRuntime,
        switchWakeupRuntime: postGateRuntime.switchWakeupRuntime,
        monitorTaskProcessor: asyncRuntime.monitorTaskProcessor,
        buyProcessor: asyncRuntime.buyProcessor,
        sellProcessor: asyncRuntime.sellProcessor,
        orderMonitor: postGateRuntime.tradeRuntime.orderMonitor,
        timeWakeupRuntime,
        businessEventProgram,
      });

      if (termination.isTerminated()) return;

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
