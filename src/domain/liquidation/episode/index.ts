/**
 * 保护性清仓事件跟踪器
 *
 * 功能/职责：按 direction 维护保护性清仓进行中事件与已完成边界，保证单次事件只完成一次。
 * 执行流程：tracking 在保护性成交时记录进度；PostTradeSettlementWorkflow 独占完成判定与事务提交。
 * 本模块只提供事实状态与纯资格准备，不接仓储、logger 或 timer，也不自行宣告业务 ready。
 */
import type {
  InProgressProtectiveEpisode,
  ProtectiveLiquidationEpisodeTracker,
  PreparedProtectiveLiquidationCompletion,
  RecordProtectiveFillProgressParams,
  PrepareProtectiveCompletionParams,
  RestoreCompletedBoundaryParams,
  RestoreInProgressEpisodeParams,
} from './types.js';

/**
 * 校验同 direction 的进行中保护性清仓事件是否仍指向同一真实交易标的。
 *
 * 单 monitor 架构下，同一 direction 在前一事件未完成前不允许切换为另一 symbol；
 * 否则 settlement 会把旧 symbol 的完成条件静默改写到新 symbol 上。
 *
 * @param existing 已存在的进行中事件
 * @param incoming 待写入的 symbol
 */
function assertSameEpisodeSymbolOrThrow(
  existing: InProgressProtectiveEpisode,
  incoming: string,
): void {
  if (existing.symbol === incoming) {
    return;
  }

  throw new Error(
    `[ProtectiveLiquidationEpisodeTracker] ${existing.direction} direction 存在未完成保护性清仓事件，禁止从 ${existing.symbol} 静默切换到 ${incoming}`,
  );
}

/**
 * 创建保护性清仓事件跟踪器。
 *
 * @returns ProtectiveLiquidationEpisodeTracker
 */
export function createProtectiveLiquidationEpisodeTracker(): ProtectiveLiquidationEpisodeTracker {
  const latestProtectionBoundaryByDirection = new Map<'LONG' | 'SHORT', number>();
  const inProgressByDirection = new Map<'LONG' | 'SHORT', InProgressProtectiveEpisode>();

  /** tracking 已持久化真实 progress 后更新事实；已完成边界之前的重放不建立新事件。 */
  function recordProtectiveFillProgress(params: RecordProtectiveFillProgressParams): void {
    const { direction, symbol, executedTimeMs } = params;
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }

    const key = direction;
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && executedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(key);
    if (!existing) {
      inProgressByDirection.set(key, {
        direction,
        symbol,
        latestExecutedTimeMs: executedTimeMs,
      });
      return;
    }

    assertSameEpisodeSymbolOrThrow(existing, symbol);
    if (executedTimeMs > existing.latestExecutedTimeMs) {
      inProgressByDirection.set(key, {
        direction,
        symbol,
        latestExecutedTimeMs: executedTimeMs,
      });
    }
  }

  /** 纯资格准备，不提交边界；持仓与 pending 事实的最终判定由 settlement 独占。 */
  function prepareCompletion(
    params: PrepareProtectiveCompletionParams,
  ): PreparedProtectiveLiquidationCompletion | null {
    const { direction, isDirectionFlat, hasPendingProtectiveOrders } = params;
    if (!isDirectionFlat || hasPendingProtectiveOrders) {
      return null;
    }

    const key = direction;
    const inProgress = inProgressByDirection.get(key);
    if (!inProgress) {
      return null;
    }

    const previousBoundary = latestProtectionBoundaryByDirection.get(key);
    if (previousBoundary !== undefined && inProgress.latestExecutedTimeMs <= previousBoundary) {
      return null;
    }

    return {
      direction,
      boundaryExecutedTimeMs: inProgress.latestExecutedTimeMs,
    };
  }

  /** 仅在 settlement 的 durable completion 与其他投影提交成功后推进 episode 内存边界。 */
  function commitCompletion(prepared: PreparedProtectiveLiquidationCompletion): void {
    inProgressByDirection.delete(prepared.direction);
    latestProtectionBoundaryByDirection.set(prepared.direction, prepared.boundaryExecutedTimeMs);
  }

  function restoreCompletedBoundary(params: RestoreCompletedBoundaryParams): void {
    const { direction, boundaryExecutedTimeMs } = params;
    if (!Number.isFinite(boundaryExecutedTimeMs) || boundaryExecutedTimeMs <= 0) {
      return;
    }

    const key = direction;
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && boundaryExecutedTimeMs <= existingBoundary) {
      return;
    }

    latestProtectionBoundaryByDirection.set(key, boundaryExecutedTimeMs);
    inProgressByDirection.delete(key);
  }

  function restoreInProgressEpisode(params: RestoreInProgressEpisodeParams): void {
    const { direction, symbol, latestExecutedTimeMs } = params;
    if (!Number.isFinite(latestExecutedTimeMs) || latestExecutedTimeMs <= 0) {
      return;
    }

    const key = direction;
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && latestExecutedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(key);
    if (existing && latestExecutedTimeMs <= existing.latestExecutedTimeMs) {
      return;
    }

    if (existing) {
      assertSameEpisodeSymbolOrThrow(existing, symbol);
    }

    inProgressByDirection.set(key, {
      direction,
      symbol,
      latestExecutedTimeMs,
    });
  }

  function getInProgressEpisodes(): ReadonlyArray<InProgressProtectiveEpisode> {
    return [...inProgressByDirection.values()];
  }

  function resetAll(): void {
    latestProtectionBoundaryByDirection.clear();
    inProgressByDirection.clear();
  }

  return {
    recordProtectiveFillProgress,
    prepareCompletion,
    commitCompletion,
    restoreCompletedBoundary,
    restoreInProgressEpisode,
    getInProgressEpisodes,
    resetAll,
  };
}
