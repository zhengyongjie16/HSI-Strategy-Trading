/**
 * 交易日重建的启动快照分支协同模块。
 * 仅 loader 的真实 captured COMMITTED 可以 READY；同日 supersession 由本 owner 本地重新加载。
 * 原 epoch 失效或停止返回 ABORTED，外部 API 错误仍进入原 pendingOpenRebuild 分支。
 */
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type { LoadStartupSnapshotParams, StartupSnapshotResult } from './types.js';

/**
 * 执行启动快照加载，不把 supersession 计入外部 retry，也不替旧输入换上当前 token。
 * @param params 原 startup owner 的 H、终止授权与加载依赖
 * @returns captured READY、原外部 API_RETRY_PENDING 或无事实 ABORTED
 */
export async function loadStartupSnapshot(
  params: LoadStartupSnapshotParams,
): Promise<StartupSnapshotResult> {
  const {
    now,
    lifecycleState,
    termination,
    snapshot,
    loadTradingDayRuntimeSnapshot,
    applyStartupSnapshotFailureState,
    logger,
    formatError,
  } = params;
  const originDayEpoch = snapshot.getStatus().token.dayEpoch;
  const isOriginLive = (): boolean => {
    const status = snapshot.getStatus();
    return (
      !termination.isTerminated() &&
      status.admission !== 'CLOSED' &&
      status.token.dayEpoch === originDayEpoch
    );
  };

  while (isOriginLive()) {
    try {
      const startupSnapshot = await loadTradingDayRuntimeSnapshot({
        now,
        requireTradingDay: false,
        resetRuntimeSubscriptions: false,
        hydrateCooldownFromTradeLog: true,
        source: 'STARTUP',
      });
      if (!isOriginLive()) return { kind: 'ABORTED' };

      switch (startupSnapshot.status) {
        case 'SUPERSEDED': {
          continue;
        }

        case 'ABORTED': {
          return { kind: 'ABORTED' };
        }

        case 'COMMITTED': {
          if (startupSnapshot.snapshotToken.dayEpoch !== originDayEpoch) {
            throw new TypeError('[StartupSnapshot] loader returned a foreign dayEpoch token');
          }

          if (
            !snapshot.isCurrent(startupSnapshot.snapshotToken, {
              account: true,
              positions: true,
              paired: true,
            })
          ) {
            continue;
          }

          return {
            kind: 'READY',
            snapshotToken: startupSnapshot.snapshotToken,
            allOrders: startupSnapshot.allOrders,
            quotesMap: startupSnapshot.quotesMap,
            now,
          };
        }

        default: {
          throw new TypeError('[StartupSnapshot] loader returned an invalid public result');
        }
      }
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      if (!isOriginLive()) return { kind: 'ABORTED' };

      applyStartupSnapshotFailureState(lifecycleState);
      logger.error('启动快照 API 请求失败：已阻断交易并切换为开盘重建重试模式', formatError(error));
      return { kind: 'API_RETRY_PENDING' };
    }
  }

  return { kind: 'ABORTED' };
}
