/**
 * app 重建接线模块
 *
 * 职责：
 * - 创建带按日缓存的交易日信息解析器
 * - 执行统一的开盘重建接线（load snapshot -> rebuild state）
 */
import type {
  CachedTradingDayInfo,
  RunTradingDayOpenRebuildParams,
  TradingDayOpenRebuildResult,
  TradingDayInfoResolver,
  TradingDayInfoResolverDeps,
} from '../types.js';
import type { SnapshotToken } from '../../types/accountPosition.js';

/**
 * 创建带按日缓存的交易日信息解析函数。
 * 默认行为：同日命中缓存直接返回；接口异常时回调 onResolveError 并抛出原始错误。
 *
 * @param deps 依赖注入，包含交易日接口、日期键函数与错误回调
 * @returns 可直接用于启动状态初始化与运行期交易日状态更新的 resolveTradingDayInfo 函数
 */
export function createTradingDayInfoResolver(
  deps: TradingDayInfoResolverDeps,
): TradingDayInfoResolver {
  const { marketDataClient, getHKDateKey: resolveDateKey, onResolveError } = deps;
  let cachedTradingDayInfo: CachedTradingDayInfo | null = null;

  return async function resolveTradingDayInfo(currentTime: Date) {
    const dateStr = resolveDateKey(currentTime) ?? currentTime.toISOString().slice(0, 10);
    if (cachedTradingDayInfo?.dateStr === dateStr) {
      return cachedTradingDayInfo.info;
    }

    try {
      const info = await marketDataClient.isTradingDay(currentTime);
      cachedTradingDayInfo = { dateStr, info };
      return info;
    } catch (err) {
      onResolveError(err);
      throw err;
    }
  };
}

/** 两个 receipt 必须属于同一 captured 输入，不接受更新 token 为旧事实重新授权。 */
function hasSameCapturedToken(left: SnapshotToken, right: SnapshotToken): boolean {
  return (
    left.dayEpoch === right.dayEpoch &&
    left.snapshotGeneration === right.snapshotGeneration &&
    left.commitRevision === right.commitRevision &&
    left.accountRevision === right.accountRevision &&
    left.positionRevision === right.positionRevision &&
    left.pairedRevision === right.pairedRevision
  );
}

/**
 * 原 open owner 整轮 load→prepare/rebuild→订阅对账→S 业务 ready；同日失效只在本地重新加载。
 * 固定使用原 requireTradingDay/resetRuntimeSubscriptions/hydrateCooldown 参数，不消费外部 retry。
 * 不开启 H admission 或交易预算；ABORTED 必须由 lifecycle consumer 阻断后续域与 ACTIVE。
 * @param params 同一 H/S、终止授权与本轮真实依赖
 * @returns 最终 captured COMMITTED 或无事实 ABORTED；内部/外部错误保留原异常通道
 */
export async function executeTradingDayOpenRebuild(
  params: RunTradingDayOpenRebuildParams,
): Promise<TradingDayOpenRebuildResult> {
  const {
    now,
    termination,
    snapshot,
    loadTradingDayRuntimeSnapshot,
    rebuildTradingDayState,
    postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
  } = params;
  // 整轮受控重载由本 owner 推进；上轮 failed/false 留下的普通 S 调度不得与本轮读基线竞争。
  postTradeConsistencyRuntime.stopScheduling();
  const originDayEpoch = snapshot.getStatus().token.dayEpoch;
  const isOriginLive = (): boolean => {
    const status = snapshot.getStatus();
    return (
      !termination.isTerminated() &&
      status.admission !== 'CLOSED' &&
      status.token.dayEpoch === originDayEpoch
    );
  };
  const isCapturedCurrent = (token: SnapshotToken): boolean =>
    isOriginLive() && snapshot.isCurrent(token, { account: true, positions: true, paired: true });

  while (isOriginLive()) {
    const loaded = await loadTradingDayRuntimeSnapshot({
      now,
      requireTradingDay: true,
      resetRuntimeSubscriptions: true,
      hydrateCooldownFromTradeLog: true,
      source: 'OPEN_REBUILD',
    });
    if (!isOriginLive()) return { status: 'ABORTED' };

    switch (loaded.status) {
      case 'ABORTED': {
        return loaded;
      }

      case 'SUPERSEDED': {
        continue;
      }

      case 'COMMITTED': {
        break;
      }

      default: {
        throw new TypeError('[OpenRebuild] loader returned an invalid public result');
      }
    }

    const capturedToken = loaded.snapshotToken;
    if (capturedToken.dayEpoch !== originDayEpoch) {
      throw new TypeError('[OpenRebuild] loader returned a foreign dayEpoch token');
    }

    if (!isCapturedCurrent(capturedToken)) continue;

    const rebuilt = await rebuildTradingDayState({
      snapshotToken: capturedToken,
      allOrders: loaded.allOrders,
      quotesMap: loaded.quotesMap,
      now,
    });
    if (!isOriginLive()) return { status: 'ABORTED' };

    switch (rebuilt.status) {
      case 'ABORTED': {
        return rebuilt;
      }

      case 'SUPERSEDED': {
        continue;
      }

      case 'COMMITTED': {
        break;
      }

      default: {
        throw new TypeError('[OpenRebuild] rebuild returned an invalid public result');
      }
    }

    if (!hasSameCapturedToken(capturedToken, rebuilt.snapshotToken)) {
      throw new TypeError('[OpenRebuild] rebuild changed the captured input token');
    }

    if (!isCapturedCurrent(capturedToken)) continue;

    // 完整订阅先于 S ready；REBUILD 中普通 S 不发读，积压成交由当前真实 paired 基线收口。
    await quoteSubscriptionRuntime.reconcileFromCurrentTruth();
    if (!isOriginLive()) return { status: 'ABORTED' };

    if (!isCapturedCurrent(capturedToken)) continue;

    postTradeConsistencyRuntime.resetAbort();
    postTradeConsistencyRuntime.start();
    const baselineReady = await postTradeConsistencyRuntime.completeRebuildBaseline();
    if (!isOriginLive()) return { status: 'ABORTED' };

    if (!baselineReady || !isCapturedCurrent(capturedToken)) continue;

    const fresh = await postTradeConsistencyRuntime.waitForFresh();
    if (!isOriginLive()) return { status: 'ABORTED' };

    if (
      isCapturedCurrent(capturedToken) &&
      hasSameCapturedToken(capturedToken, fresh.snapshotToken) &&
      postTradeConsistencyRuntime.isCurrent(fresh)
    ) {
      return { status: 'COMMITTED', snapshotToken: capturedToken };
    }
  }

  return { status: 'ABORTED' };
}
