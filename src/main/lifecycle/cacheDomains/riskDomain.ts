/**
 * 风控缓存域（CacheDomain: risk）
 *
 * 午夜清理：
 * - 重置风控检查冷却（signalProcessor.resetRiskCheckCooldown）
 * - 重置日内亏损追踪器（dailyLossTracker.resetAll）
 * - 清除跨日模式的清仓冷却键（保留分钟模式的冷却）
 * - 重置保护性清仓触发计数器
 * - 清空唯一监控标的的浮亏数据和牛熊证风险信息缓存
 *
 * 开盘重建：
 * - 风控数据在统一 rebuildTradingDayState 中按当日数据重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/state.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { RiskDomainDeps } from './types.js';

/**
 * 清空唯一监控标的的浮亏数据和牛熊证风险信息缓存。
 *
 * @param monitorContext 监控上下文
 */
function clearRiskCaches(monitorContext: MonitorContext): void {
  monitorContext.riskChecker.clearUnrealizedLossData();
  monitorContext.riskChecker.clearLongWarrantInfo();
  monitorContext.riskChecker.clearShortWarrantInfo();
}

/**
 * 收集需要在午夜清除的清仓冷却方向，仅包含跨日模式（非 minutes 模式）。
 *
 * @param monitorContext 监控上下文
 * @returns 待清除的冷却方向集合
 */
function collectMidnightEligibleCooldownDirections(
  monitorContext: MonitorContext,
): Set<'LONG' | 'SHORT'> {
  const directionsToClear = new Set<'LONG' | 'SHORT'>();
  const cfg = monitorContext.config.liquidationCooldown;
  if (!cfg || cfg.mode === 'minutes') {
    return directionsToClear;
  }

  directionsToClear.add('LONG');
  directionsToClear.add('SHORT');
  return directionsToClear;
}

/**
 * 执行风控域午夜清理：重置风控冷却、日内亏损追踪、清仓冷却键及唯一 monitor 风险缓存。
 *
 * @param deps 风控域依赖
 * @param ctx 生命周期上下文
 */
function runMidnightRiskClear(deps: RiskDomainDeps, ctx: LifecycleContext): void {
  const {
    signalProcessor,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    monitorContext,
    liquidationCooldownTracker,
  } = deps;

  signalProcessor.resetRiskCheckCooldown();
  dailyLossTracker.resetAll(ctx.now);
  protectiveLiquidationEpisodeTracker.resetAll();
  const directionsToClear = collectMidnightEligibleCooldownDirections(monitorContext);
  liquidationCooldownTracker.clearMidnightEligible({ directionsToClear });
  liquidationCooldownTracker.resetAllTriggerCounts();
  clearRiskCaches(monitorContext);
  logger.debug('[Lifecycle][risk] 午夜清理完成: monitor=1');
}

/**
 * 创建风控缓存域。
 * 午夜清理时重置风控冷却、日内亏损追踪、清仓冷却键及唯一监控标的风险缓存；开盘重建由统一 rebuildTradingDayState 负责，本域为空操作。
 *
 * @param deps 依赖注入，包含 signalProcessor、dailyLossTracker、monitorContext、liquidationCooldownTracker
 * @returns 实现 CacheDomain 的风控域实例
 */
export function createRiskDomain(deps: RiskDomainDeps): CacheDomain {
  return {
    midnightClear(ctx): void {
      runMidnightRiskClear(deps, ctx);
    },
    openRebuild(): void {
      // 风控数据在统一 rebuildTradingDayState 中按当日数据重建
    },
  };
}
