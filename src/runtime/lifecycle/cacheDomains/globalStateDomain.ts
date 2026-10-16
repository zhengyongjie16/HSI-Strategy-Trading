/**
 * 全局状态缓存域（CacheDomain: globalState）
 *
 * 午夜清理：
 * - 禁止交易（canTrade = false）
 * - 重置半日标记、开盘保护、交易日信息缓存
 * - 由 canonical snapshot owner 等待已发出的读取落定并清理账户/持仓事实
 * - 清空交易标的集合（allTradingSymbols 的权威清理位置）
 *
 * 开盘重建：
 * - 调用 runTradingDayOpenRebuild 执行完整的开盘重建流水线
 *   （加载运行时快照 → 重建交易日状态）
 */
import type { TradingTimeState } from '../../../types/timeControlPlane.js';
import type { TradingCalendarState } from '../../../types/tradingCalendar.js';
import type { QuoteSubscriptionState } from '../../../types/quoteSubscription.js';
import type { CacheDomain, CacheDomainOpenRebuildResult } from '../types.js';
import type { GlobalStateDomainDeps } from './types.js';

/**
 * 全局域午夜清理。
 * 清理 allTradingSymbols（权威位置）、交易日与门禁相关状态。
 * currentDayKey 仅由 dayLifecycleManager 在全部 clear 成功后提交，此处不写入。
 *
 * @param lastState 主程序持有的全局可变状态
 */
function runGlobalMidnightClear(
  tradingTimeState: TradingTimeState,
  tradingCalendarState: TradingCalendarState,
  quoteSubscriptionState: QuoteSubscriptionState,
): void {
  tradingTimeState.canTrade = false;
  tradingTimeState.isHalfDay = null;
  tradingTimeState.openProtectionActive = null;
  tradingCalendarState.cachedTradingDayInfo = null;
  tradingCalendarState.tradingCalendarSnapshot = new Map();
  quoteSubscriptionState.allTradingSymbols = new Set<string>();
}

/**
 * 创建全局状态缓存域。
 * 午夜清理时重置交易门禁、交易日信息、allTradingSymbols ；开盘重建时调用 runTradingDayOpenRebuild 执行完整流水线。
 *
 * @param deps 依赖注入，包含 lastState、runTradingDayOpenRebuild
 * @returns 实现 CacheDomain 的全局状态域实例
 */
export function createGlobalStateDomain(deps: GlobalStateDomainDeps): CacheDomain {
  const {
    logger,
    tradingTimeState,
    tradingCalendarState,
    quoteSubscriptionState,
    snapshot,
    runTradingDayOpenRebuild,
  } = deps;
  return {
    async midnightClear(): Promise<void> {
      await snapshot.requestClear({
        reason: 'DAY_CUT',
        dayEpoch: snapshot.getStatus().token.dayEpoch,
      });
      runGlobalMidnightClear(tradingTimeState, tradingCalendarState, quoteSubscriptionState);
      logger.debug('[Lifecycle][globalState] 午夜状态清理完成');
    },
    async openRebuild(ctx): Promise<CacheDomainOpenRebuildResult> {
      if (!ctx.isCurrent()) return { status: 'ABORTED' };

      const result = await runTradingDayOpenRebuild(ctx.now);
      switch (result.status) {
        case 'ABORTED': {
          return result;
        }

        case 'COMMITTED': {
          if (result.snapshotToken.dayEpoch !== ctx.dayEpoch) {
            throw new TypeError('[Lifecycle][globalState] 开盘重建返回外来 dayEpoch token');
          }

          if (
            !ctx.isCurrent() ||
            snapshot.getStatus().admission === 'CLOSED' ||
            !snapshot.isCurrent(result.snapshotToken, {
              account: true,
              positions: true,
              paired: true,
            })
          ) {
            return { status: 'ABORTED' };
          }

          logger.debug('[Lifecycle][globalState] 开盘重建流程执行完成');
          return result;
        }

        default: {
          throw new TypeError('[Lifecycle][globalState] 开盘重建返回无效公开结果');
        }
      }
    },
  };
}
