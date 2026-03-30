/**
 * 保护性清仓事件跟踪器
 *
 * 功能/职责：按 direction 维护保护性清仓进行中事件与已完成边界，保证单次事件只完成一次。
 * 执行流程：settlementFlow 在保护性成交时记录进度；postTradeRefresher 在持仓刷新后判定完成并推进边界。
 */
import type {
  InProgressProtectiveEpisode,
  ProtectiveLiquidationCompletedEvent,
  ProtectiveLiquidationEpisodeTracker,
} from './types.js';

/**
 * 创建保护性清仓事件跟踪器。
 *
 * @returns ProtectiveLiquidationEpisodeTracker
 */
export function createProtectiveLiquidationEpisodeTracker(): ProtectiveLiquidationEpisodeTracker {
  const latestProtectionBoundaryByDirection = new Map<'LONG' | 'SHORT', number>();
  const inProgressByDirection = new Map<'LONG' | 'SHORT', InProgressProtectiveEpisode>();

  function recordProtectiveFillProgress(params: {
    direction: 'LONG' | 'SHORT';
    executedTimeMs: number;
  }): void {
    const { direction, executedTimeMs } = params;
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }

    const existingBoundary = latestProtectionBoundaryByDirection.get(direction);
    if (existingBoundary !== undefined && executedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(direction);
    if (!existing) {
      inProgressByDirection.set(direction, {
        direction,
        latestExecutedTimeMs: executedTimeMs,
      });
      return;
    }

    if (executedTimeMs > existing.latestExecutedTimeMs) {
      inProgressByDirection.set(direction, {
        direction,
        latestExecutedTimeMs: executedTimeMs,
      });
    }
  }

  function completeIfEligible(params: {
    direction: 'LONG' | 'SHORT';
    isDirectionFlat: boolean;
    hasPendingProtectiveOrders: boolean;
  }): ProtectiveLiquidationCompletedEvent | null {
    const { direction, isDirectionFlat, hasPendingProtectiveOrders } = params;
    if (!isDirectionFlat || hasPendingProtectiveOrders) {
      return null;
    }

    const inProgress = inProgressByDirection.get(direction);
    if (!inProgress) {
      return null;
    }

    inProgressByDirection.delete(direction);
    const previousBoundary = latestProtectionBoundaryByDirection.get(direction);
    if (previousBoundary !== undefined && inProgress.latestExecutedTimeMs <= previousBoundary) {
      return null;
    }

    latestProtectionBoundaryByDirection.set(direction, inProgress.latestExecutedTimeMs);
    return {
      direction,
      boundaryExecutedTimeMs: inProgress.latestExecutedTimeMs,
    };
  }

  function restoreCompletedBoundary(params: {
    direction: 'LONG' | 'SHORT';
    boundaryExecutedTimeMs: number;
  }): void {
    const { direction, boundaryExecutedTimeMs } = params;
    if (!Number.isFinite(boundaryExecutedTimeMs) || boundaryExecutedTimeMs <= 0) {
      return;
    }

    const existingBoundary = latestProtectionBoundaryByDirection.get(direction);
    if (existingBoundary !== undefined && boundaryExecutedTimeMs <= existingBoundary) {
      return;
    }

    latestProtectionBoundaryByDirection.set(direction, boundaryExecutedTimeMs);
    inProgressByDirection.delete(direction);
  }

  function restoreInProgressEpisode(params: {
    direction: 'LONG' | 'SHORT';
    latestExecutedTimeMs: number;
  }): void {
    const { direction, latestExecutedTimeMs } = params;
    if (!Number.isFinite(latestExecutedTimeMs) || latestExecutedTimeMs <= 0) {
      return;
    }

    const existingBoundary = latestProtectionBoundaryByDirection.get(direction);
    if (existingBoundary !== undefined && latestExecutedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(direction);
    if (existing && latestExecutedTimeMs <= existing.latestExecutedTimeMs) {
      return;
    }

    inProgressByDirection.set(direction, {
      direction,
      latestExecutedTimeMs,
    });
  }

  function getLatestProtectionBoundaryByDirection(): ReadonlyMap<'LONG' | 'SHORT', number> {
    return new Map(latestProtectionBoundaryByDirection);
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
    completeIfEligible,
    restoreCompletedBoundary,
    restoreInProgressEpisode,
    getLatestProtectionBoundaryByDirection,
    getInProgressEpisodes,
    resetAll,
  };
}
