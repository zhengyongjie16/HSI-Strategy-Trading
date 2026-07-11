/**
 * TradingRiskEventRuntime 路由索引。
 *
 * 职责：
 * - 基于 symbolRegistry 的权威席位快照重建 tradingSymbol -> route 的唯一映射
 * - 对重复归属执行 fail-fast，避免同一标的同时占用 LONG/SHORT 两条路由
 */
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { resolveMonitorContextSeatSnapshot } from '../../utils/seat/snapshots.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { TradingRiskRoute, TradingRiskRoutingIndex } from './types.js';

/**
 * 将单条路由写入索引，并在检测到同一 tradingSymbol 重复归属时立即抛错。
 *
 * @param params 路由写入参数
 * @returns void
 */
function registerRoute(params: {
  readonly routesBySymbol: Map<string, TradingRiskRoute>;
  readonly activeRouteKeys: Set<'LONG' | 'SHORT'>;
  readonly direction: 'LONG' | 'SHORT';
  readonly tradingSymbol: string;
  readonly seatVersion: number;
}): void {
  const { routesBySymbol, activeRouteKeys, direction, tradingSymbol, seatVersion } = params;
  if (tradingSymbol.length === 0) {
    return;
  }

  const nextRoute: TradingRiskRoute = {
    direction,
    tradingSymbol,
    seatVersion,
  };

  const existingRoute = routesBySymbol.get(tradingSymbol);
  if (existingRoute) {
    throw new Error(
      `[TradingRiskEventRuntime] 标的重复归属: symbol=${formatSymbolDisplay(tradingSymbol)} directions=${existingRoute.direction}/${direction}`,
    );
  }

  routesBySymbol.set(tradingSymbol, nextRoute);
  activeRouteKeys.add(direction);
}

/**
 * 基于 symbolRegistry 的权威快照构建风险路由索引。
 *
 * @param symbolRegistry 席位注册表
 * @returns tradingSymbol -> route 的唯一索引
 */
export function buildTradingRiskRoutingIndex(params: {
  readonly symbolRegistry: SymbolRegistry;
}): TradingRiskRoutingIndex {
  const routesBySymbol = new Map<string, TradingRiskRoute>();
  const activeRouteKeys = new Set<'LONG' | 'SHORT'>();
  const { symbolRegistry } = params;

  const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
  if (seatSnapshot.longSymbol !== null) {
    registerRoute({
      routesBySymbol,
      activeRouteKeys,
      direction: 'LONG',
      tradingSymbol: seatSnapshot.longSymbol,
      seatVersion: seatSnapshot.seatVersion.long,
    });
  }

  if (seatSnapshot.shortSymbol !== null) {
    registerRoute({
      routesBySymbol,
      activeRouteKeys,
      direction: 'SHORT',
      tradingSymbol: seatSnapshot.shortSymbol,
      seatVersion: seatSnapshot.seatVersion.short,
    });
  }

  return {
    routesBySymbol,
    activeRouteKeys,
  };
}
