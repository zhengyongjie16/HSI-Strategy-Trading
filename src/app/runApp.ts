/**
 * app 顶层组装入口模块
 *
 * 职责：
 * - 收口 pre-gate / post-gate runtime 创建
 * - 保持启动快照失败后阻断交易并切换到开盘重建重试的语义不变
 * - 在唯一装配入口中复用 monitorContext，并组装 async runtime、lifecycle 与 cleanup
 */
import { timeWakeupEvaluationProgram } from '../main/timeWakeupEvaluationProgram/index.js';
import { toError } from '../utils/error/index.js';
import { isExternalApiRequestError } from '../utils/apiFailure/index.js';
import { syncMonitorContextSymbolNames } from './context/createMonitorContext.js';
import { DEFAULT_RUN_APP_DEPS } from './runAppDeps.js';
import type { AppEnvironmentParams, RunAppDeps } from './types.js';

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
    registerDelayedSignalHandlers: bindDelayedSignalHandlers,
    createBusinessEventProgram: buildBusinessEventProgram,
    createAsyncRuntime: buildAsyncRuntime,
    createLifecycleRuntime: buildLifecycleRuntime,
    createCleanup: buildCleanup,
    createTimeWakeupRuntime: buildTimeWakeupRuntime,
    waitForShutdownSignal: waitForShutdown,
    logger: appLogger,
    formatError: formatAppError,
    validateRuntimeSymbolsFromQuotesMap: validateRuntimeSymbols,
    applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
  } = deps;

  return async function runApp(params: AppEnvironmentParams): Promise<void> {
    const runtimeEnv = buildAppRuntimeEnv(params.env);
    const cleanup = buildCleanup();
    let hasPrimaryError = false;
    let primaryError: unknown;

    try {
      const preGateRuntime = await buildPreGateRuntime({ env: runtimeEnv, cleanup });
      const startupNow = new Date();
      const postGateRuntime = await buildPostGateRuntime({
        env: runtimeEnv,
        preGateRuntime,
        now: startupNow,
        cleanup,
      });
      const startupSnapshot = await loadStartupRuntimeSnapshot({
        now: startupNow,
        lastState: postGateRuntime.lastState,
        loadTradingDayRuntimeSnapshot: postGateRuntime.loadTradingDayRuntimeSnapshot,
        applyStartupSnapshotFailureState: applyStartupSnapshotFailure,
        logger: appLogger,
        formatError: formatAppError,
      });
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
      });
      cleanup.register({
        phase: 'STOP_MONITOR_TASK_PROCESSOR',
        step: '停止 MonitorTaskProcessor',
        handler: () => asyncRuntime.monitorTaskProcessor.stopAndDrain(),
      });

      cleanup.register({
        phase: 'STOP_BUY_PROCESSOR',
        step: '停止 BuyProcessor',
        handler: () => asyncRuntime.buyProcessor.stopAndDrain(),
      });

      cleanup.register({
        phase: 'STOP_SELL_PROCESSOR',
        step: '停止 SellProcessor',
        handler: () => asyncRuntime.sellProcessor.stopAndDrain(),
      });
      const businessEventProgram = buildBusinessEventProgram({
        marketDataClient: preGateRuntime.marketDataClient,
        monitorContext,
        lastState: postGateRuntime.lastState,
        tradingConfig: preGateRuntime.tradingConfig,
        buyTaskQueue: postGateRuntime.buyTaskQueue,
        sellTaskQueue: postGateRuntime.sellTaskQueue,
        indicatorCache: postGateRuntime.indicatorCache,
        monitorDisplayRuntime: postGateRuntime.monitorDisplayRuntime,
      });
      cleanup.register({
        phase: 'STOP_BUSINESS_EVENT_PROGRAM',
        step: '停止 BusinessEventProgram',
        handler: () => businessEventProgram.stopAndDrain(),
      });
      const dayLifecycleManager = buildLifecycleRuntime({
        preGateRuntime,
        postGateRuntime,
        asyncRuntime,
        businessEventProgram,
        rebuildTradingDayState,
      });

      bindDelayedSignalHandlers({
        monitorContext,
        lastState: postGateRuntime.lastState,
        buyTaskQueue: postGateRuntime.buyTaskQueue,
        sellTaskQueue: postGateRuntime.sellTaskQueue,
        logger: appLogger,
        doomsdayProtectionEnabled: preGateRuntime.tradingConfig.global.doomsdayProtection,
      });

      const timeWakeupRuntime = buildTimeWakeupRuntime({
        evaluate: () =>
          timeWakeupEvaluationProgram({
            marketDataClient: preGateRuntime.marketDataClient,
            trader: postGateRuntime.trader,
            lastState: postGateRuntime.lastState,
            doomsdayProtection: postGateRuntime.doomsdayProtection,
            tradingConfig: preGateRuntime.tradingConfig,
            monitorContext,
            tradingGateEventRuntime: postGateRuntime.tradingGateEventRuntime,
            quoteSubscriptionRuntime: postGateRuntime.quoteSubscriptionRuntime,
            dayLifecycleManager,
          }),
        now: () => new Date(Date.now()),
        scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
        logger: appLogger,
      });
      cleanup.register({
        phase: 'STOP_TIME_WAKEUP_RUNTIME',
        step: '停止 TimeWakeupRuntime',
        handler: () => timeWakeupRuntime.stopAndDrain(),
      });

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
            const rebuildError = err instanceof Error ? err : new Error(formatAppError(err));
            throw rebuildError;
          }

          applyStartupSnapshotFailure(postGateRuntime.lastState);
          appLogger.error(
            '启动初始重建 API 请求失败：已阻断交易并切换为开盘重建重试模式',
            formatAppError(err),
          );
        }
      }

      const waitForInitialTimeWakeup = (): Promise<void> =>
        Promise.race([timeWakeupRuntime.start(), timeWakeupRuntime.drainFatalError()]);

      let waitError: Error | null = null;
      try {
        if (initialRebuildSucceeded) {
          postGateRuntime.postTradeConsistencyRuntime.start();
          postGateRuntime.postTradeConsistencyRuntime.completeRebuildBaseline();
          await postGateRuntime.quoteSubscriptionRuntime.reconcileFromCurrentTruth();
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
          await waitForInitialTimeWakeup();
          businessEventProgram.start();
        } else {
          await waitForInitialTimeWakeup();
        }

        appLogger.info('程序开始运行，在交易时段将进行实时监控和交易（按 Ctrl+C 退出）');
        await Promise.race([
          waitForShutdown(),
          timeWakeupRuntime.drainFatalError(),
          businessEventProgram.drainFatalError(),
          asyncRuntime.drainFatalError(),
          postGateRuntime.drainFatalError(),
          postGateRuntime.postTradeConsistencyRuntime.drainFatalError(),
          postGateRuntime.autoSearchWakeupRuntime.drainFatalError(),
        ]);
      } catch (error) {
        waitError = toError(error);
      }

      if (waitError !== null) {
        throw waitError;
      }
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    }

    try {
      await cleanup.execute();
    } catch (cleanupError) {
      if (hasPrimaryError) {
        appLogger.error('[runApp] cleanup 失败，保留原始错误', formatAppError(cleanupError));
      } else {
        throw toError(cleanupError);
      }
    }

    if (hasPrimaryError) {
      throw primaryError;
    }
  };
}

/**
 * 运行应用主入口。
 *
 * @param params 当前环境变量
 * @returns 启动运行时后等待 shutdown；初始化失败或 cleanup 聚合错误会抛出
 */
export const runApp = createRunApp(DEFAULT_RUN_APP_DEPS);
