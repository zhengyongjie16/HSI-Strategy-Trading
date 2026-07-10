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
import type { MonitorContext } from '../../types/state.js';
import type { TradingRiskRoute, TradingRiskRouteKey, TradingRiskRoutingIndex } from './types.js';

/**
 * 构建 routeKey。
 *
 * @param direction 席位方向
 * @returns 方向级唯一 routeKey
 */
function createRouteKey(direction: 'LONG' | 'SHORT'): TradingRiskRouteKey {
  return direction;
}

/**
 * 将单条路由写入索引，并在检测到同一 tradingSymbol 重复归属时立即抛错。
 *
 * @param params 路由写入参数
 * @returns void
 */
function registerRoute(params: {
  readonly routesBySymbol: Map<string, TradingRiskRoute>;
  readonly routesByKey: Map<TradingRiskRouteKey, TradingRiskRoute>;
  readonly monitorContext: MonitorContext;
  readonly direction: 'LONG' | 'SHORT';
  readonly tradingSymbol: string;
  readonly seatVersion: number;
}): void {
  const { routesBySymbol, routesByKey, monitorContext, direction, tradingSymbol, seatVersion } =
    params;
  if (tradingSymbol.length === 0) {
    return;
  }

  const routeKey = createRouteKey(direction);
  const nextRoute: TradingRiskRoute = {
    routeKey,
    direction,
    tradingSymbol,
    seatVersion,
    monitorContext,
  };

  const existingRoute = routesBySymbol.get(tradingSymbol);
  if (existingRoute) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    throw new Error(
      `[TradingRiskEventRuntime] 标的重复归属: ${formatSymbolDisplay(tradingSymbol)} 同时归属 ${existingRoute.monitorContext.config.monitorSymbol}:${existingRoute.direction} 与 ${monitorSymbol}:${direction}`,
    );
  }

  routesBySymbol.set(tradingSymbol, nextRoute);
  routesByKey.set(routeKey, nextRoute);
}

/**
 * 基于 symbolRegistry 的权威快照构建风险路由索引。
 *
 * @param monitorContext 单一监控上下文
 * @param symbolRegistry 席位注册表
 * @returns tradingSymbol -> route 的唯一索引
 */
export function buildTradingRiskRoutingIndex(params: {
  readonly monitorContext: MonitorContext;
  readonly symbolRegistry: SymbolRegistry;
}): TradingRiskRoutingIndex {
  const routesBySymbol = new Map<string, TradingRiskRoute>();
  const routesByKey = new Map<TradingRiskRouteKey, TradingRiskRoute>();
  const { monitorContext, symbolRegistry } = params;

  const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
  if (seatSnapshot.longSymbol !== null) {
    registerRoute({
      routesBySymbol,
      routesByKey,
      monitorContext,
      direction: 'LONG',
      tradingSymbol: seatSnapshot.longSymbol,
      seatVersion: seatSnapshot.seatVersion.long,
    });
  }

  if (seatSnapshot.shortSymbol !== null) {
    registerRoute({
      routesBySymbol,
      routesByKey,
      monitorContext,
      direction: 'SHORT',
      tradingSymbol: seatSnapshot.shortSymbol,
      seatVersion: seatSnapshot.seatVersion.short,
    });
  }

  return {
    routesBySymbol,
    routesByKey,
  };
}
