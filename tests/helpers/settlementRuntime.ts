/**
 * P1 镜像的真实 settlement producer 装配。
 * 仅隔离外部业务协作者；不自动 start、不自动签发 READY，场景须在实际 H 请求提交后推进 S。
 */
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import type {
  PostTradeConsistencyRuntime,
  PostTradeConsistencyRuntimeDeps,
} from '../../src/app/runtime/types.js';

import {
  createDailyLossTrackerDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
} from './testDoubles.js';

/** 装配真实 S；持仓提交回调与 scheduler 均由场景显式提供。 */
export function createSettlementRuntimeFixture(
  params: PostTradeConsistencyRuntimeDeps & {
    readonly monitorContext: Parameters<
      PostTradeConsistencyRuntime['bindBusinessDeps']
    >[0]['monitorContext'];
  },
): PostTradeConsistencyRuntime {
  const runtime = createPostTradeConsistencyRuntime(params);
  runtime.bindBusinessDeps({
    monitorContext: params.monitorContext,
    dailyLossTracker: createDailyLossTrackerDouble(),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('场景未配置保护性清仓完成持久化');
      },
    },
  });
  return runtime;
}
