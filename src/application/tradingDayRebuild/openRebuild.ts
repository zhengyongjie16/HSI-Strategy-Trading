/**
 * 开盘整轮重建用例：保留原 captured 授权，串行加载、重建、订阅对账与 S readiness。
 * 同日失效只在本 owner 本地重载；不负责 lifecycle 状态迁移或开启交易预算。
 */
import type { SnapshotToken } from '../../types/accountPosition.js';
import type { RunTradingDayOpenRebuildParams, TradingDayOpenRebuildResult } from './types.js';

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
 * 固定要求交易日并重置订阅，由 loader 完成持久化保护状态与冷却恢复；不消费外部 retry。
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
