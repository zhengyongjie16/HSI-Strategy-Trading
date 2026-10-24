/**
 * 成交后 settlement composition 工厂
 *
 * 只把已存在的 Trader/MonitorContext 协作者映射为中性窄能力，交给唯一 application workflow。
 * 保留启动前 single-assignment 绑定来解决构造环；不持有业务状态、刷新 pump 或 completion 事务。
 */
import { createPostTradeSettlementWorkflow } from '../../application/postTradeSettlement/index.js';
import { API } from '../../constants/common.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type { PostTradeConsistencyRuntime, PostTradeConsistencyRuntimeDeps } from './types.js';

/** 创建真实 application owner，仅装配事实能力与配置绑定，不包裹逐方法业务委托。 */
export function createPostTradeConsistencyRuntime(
  deps: PostTradeConsistencyRuntimeDeps,
): PostTradeConsistencyRuntime {
  const workflow = createPostTradeSettlementWorkflow({
    snapshot: deps.snapshot,
    scheduler: deps.scheduler,
    termination: deps.termination,
    logger: deps.logger,
    diagnostics: deps.diagnostics,
    clock: deps.clock,
    retryDelayMs: API.DEFAULT_RETRY_DELAY_MS,
    isExternalFailure: isExternalApiRequestError,
    onPositionsCommitted: deps.onPositionsCommitted,
    hasPendingProtectiveOrders: (direction) =>
      deps.getProtectiveOrderReader().hasPendingProtectiveLiquidationOrders(direction),
  });

  return {
    ...workflow,
    bindBusinessDeps: (businessDeps) => {
      const { monitorContext, dailyLossTracker, liquidationCooldownTracker } = businessDeps;
      workflow.bindBusinessDeps({
        monitorSymbol: monitorContext.config.monitorSymbol,
        seats: {
          getSeatState: monitorContext.symbolRegistry.getSeatState,
          getSeatVersion: monitorContext.symbolRegistry.getSeatVersion,
        },
        episodes: businessDeps.protectiveLiquidationEpisodeTracker,
        completionPersistence: businessDeps.mixedTradeLogRepository,
        lossBoundaries: {
          prepareProtectionBoundary: dailyLossTracker.prepareProtectionBoundary,
          commitProtectionBoundary: dailyLossTracker.commitProtectionBoundary,
          getLossOffset: monitorContext.dailyLossTracker.getLossOffset,
        },
        cooldownTriggers: {
          recordLiquidationTrigger: (params) => {
            liquidationCooldownTracker.recordLiquidationTrigger({
              ...params,
              triggerLimit: monitorContext.config.liquidationTriggerLimit,
              cooldownConfig: monitorContext.config.liquidationCooldown,
            });
          },
        },
        riskProjection: {
          prepare: (symbol, direction, dailyLossOffset) =>
            monitorContext.riskChecker.prepareUnrealizedLossData(
              monitorContext.orderRecorder,
              symbol,
              direction === 'LONG',
              dailyLossOffset,
            ),
          publish: monitorContext.riskChecker.publishUnrealizedLossData,
        },
      });
    },
  };
}
