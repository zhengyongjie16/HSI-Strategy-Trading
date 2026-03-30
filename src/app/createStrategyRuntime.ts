/**
 * app 单实例策略运行时装配模块
 *
 * 职责：
 * - 创建唯一的 StrategyRuntime
 * - 在装配边界内聚合策略、风控、订单记录等依赖
 * - 为当前趋势策略路径创建最小指标画像
 */
import type { DisplayIndicatorItem, IndicatorDisplayProfile } from '../types/indicatorProfile.js';
import type { StrategyRuntime } from '../types/state.js';
import { resolveStrategyRuntimeSnapshot } from '../utils/utils.js';
import type { StrategyRuntimeFactoryDeps } from './types.js';

/**
 * 创建趋势策略路径使用的最小展示画像。
 *
 * 该画像只保留展示层所需的 displayPlan，策略与确认链路已经迁移到 factor runtime。
 *
 * @returns 趋势策略路径的最小展示画像
 */
function createTrendIndicatorDisplayProfile(): IndicatorDisplayProfile {
  const displayPlan: ReadonlyArray<DisplayIndicatorItem> = ['price', 'changePercent'];
  return {
    displayPlan,
  };
}

/**
 * 创建单实例策略运行时，从注册表读取席位状态与版本号，从行情 Map 提取标的名称，
 * 并预编译指标画像，避免主循环每 tick 重复解析。
 *
 * @param deps 工厂依赖（config、state、symbolRegistry、quotesMap、strategy、riskChecker 等）
 * @returns 单实例 StrategyRuntime 实例
 */
export function createStrategyRuntime(deps: StrategyRuntimeFactoryDeps): StrategyRuntime {
  const {
    config,
    state,
    symbolRegistry,
    quotesMap,
    strategy,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    autoSymbolManager,
  } = deps;
  const runtimeSnapshot = resolveStrategyRuntimeSnapshot(
    config.baseInstrumentSymbol,
    symbolRegistry,
    quotesMap,
  );
  const indicatorProfile = createTrendIndicatorDisplayProfile();
  state.displayPlan = indicatorProfile.displayPlan;
  state.lastDisplaySignature = null;

  return {
    config,
    state,
    symbolRegistry,
    seatState: runtimeSnapshot.seatState,
    seatVersion: runtimeSnapshot.seatVersion,
    autoSymbolManager,
    strategy,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    longSymbolName: runtimeSnapshot.longSymbolName,
    shortSymbolName: runtimeSnapshot.shortSymbolName,
    baseInstrumentName: runtimeSnapshot.baseInstrumentName,
    normalizedBaseInstrumentSymbol: config.baseInstrumentSymbol,
    indicatorProfile,
  };
}
