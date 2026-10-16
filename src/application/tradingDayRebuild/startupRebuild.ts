/**
 * 启动初次重建用例。
 * 独占 captured 输入的重建、订阅对账、S baseline/fresh 完成条件与同日失效后的本地重载。
 * 保留启动外部 API 失败转 pendingOpenRebuild 的策略，不执行普通 runtime 的启停接线。
 */
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type { ExecuteStartupRebuildParams, StartupRebuildResult } from './types.js';

/**
 * 完成启动初次重建；同日 supersession 或未 ready 在本 owner 内重新加载，不消费外部 retry。
 * @param params 启动已加载结果、原 now、重建与事实读取能力，以及既有验证和名称同步调用
 * @returns captured COMMITTED、API_RETRY_PENDING 或无成功事实的 ABORTED
 */
export async function executeStartupRebuild(
  params: ExecuteStartupRebuildParams,
): Promise<StartupRebuildResult> {
  const {
    now,
    termination,
    snapshot,
    lifecycleState,
    rebuildTradingDayState,
    loadStartupSnapshot,
    loadTradingDayRuntimeSnapshot,
    postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
    applyStartupSnapshotFailureState,
    validateRuntimeSymbols,
    syncMonitorContextSymbolNames,
    logger,
    formatError,
  } = params;
  let startupSnapshot = params.startupSnapshot;
  if (startupSnapshot.kind === 'ABORTED') return { status: 'ABORTED' };

  if (startupSnapshot.kind === 'API_RETRY_PENDING') {
    logger.warn('启动阶段跳过初次重建，保持静止并等待生命周期重建任务自动恢复');
    return { status: 'API_RETRY_PENDING' };
  }

  try {
    while (startupSnapshot.kind === 'READY' && !termination.isTerminated()) {
      const capturedToken = startupSnapshot.snapshotToken;
      const rebuilt = await rebuildTradingDayState({
        snapshotToken: capturedToken,
        allOrders: startupSnapshot.allOrders,
        quotesMap: startupSnapshot.quotesMap,
        now: startupSnapshot.now,
      });
      if (rebuilt.status === 'ABORTED' || termination.isTerminated()) {
        return { status: 'ABORTED' };
      }

      if (rebuilt.status === 'COMMITTED') {
        if (
          Object.keys(capturedToken).some(
            (key) =>
              capturedToken[key as keyof typeof capturedToken] !==
              rebuilt.snapshotToken[key as keyof typeof capturedToken],
          )
        ) {
          throw new TypeError('[runApp] rebuild changed the captured input token');
        }

        await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
        if (termination.isTerminated()) return { status: 'ABORTED' };

        postTradeConsistencyRuntime.resetAbort();
        postTradeConsistencyRuntime.start();
        const baselineReady =
          snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }) &&
          (await postTradeConsistencyRuntime.completeRebuildBaseline());
        if (termination.isTerminated()) return { status: 'ABORTED' };

        const fresh = baselineReady ? await postTradeConsistencyRuntime.waitForFresh() : null;
        if (termination.isTerminated()) return { status: 'ABORTED' };

        if (
          fresh !== null &&
          snapshot.isCurrent(capturedToken, { account: true, positions: true, paired: true }) &&
          postTradeConsistencyRuntime.isCurrent(fresh) &&
          Object.keys(capturedToken).every(
            (key) =>
              capturedToken[key as keyof typeof capturedToken] ===
              fresh.snapshotToken[key as keyof typeof capturedToken],
          )
        ) {
          return { status: 'COMMITTED', snapshotToken: capturedToken };
        }
      }

      // 保留 S need/dirty，但撤销普通 timer，避免本地重载与普通读基线竞争。
      postTradeConsistencyRuntime.stopScheduling();
      startupSnapshot = await loadStartupSnapshot({
        now,
        termination,
        snapshot,
        lifecycleState,
        loadTradingDayRuntimeSnapshot,
        applyStartupSnapshotFailureState,
        logger,
        formatError,
      });

      if (startupSnapshot.kind === 'ABORTED') return { status: 'ABORTED' };

      if (startupSnapshot.kind === 'READY') {
        const validation = validateRuntimeSymbols({
          positions: snapshot.getView().positions,
          quotesMap: startupSnapshot.quotesMap,
        });
        if (!validation.valid) throw new Error('运行时标的验证失败，启动已中止');

        syncMonitorContextSymbolNames({ quotesMap: startupSnapshot.quotesMap });
      }
    }
  } catch (error) {
    if (!isExternalApiRequestError(error)) throw error;

    postTradeConsistencyRuntime.stopScheduling();
    applyStartupSnapshotFailureState(lifecycleState);
    logger.error(
      '启动初始重建 API 请求失败：已阻断交易并切换为开盘重建重试模式',
      formatError(error),
    );
  }

  return termination.isTerminated() ? { status: 'ABORTED' } : { status: 'API_RETRY_PENDING' };
}
