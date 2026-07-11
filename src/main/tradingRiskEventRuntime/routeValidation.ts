/**
 * TradingRiskEventRuntime 路由校验。
 *
 * 职责：
 * - 以 tradingSymbol 为入口校验当前应执行的 route 是否仍然有效
 * - 校验方向与 seatVersion 是否与最新索引一致
 */
import type { TradingRiskRoute, TradingRiskRoutingIndex } from './types.js';

/**
 * 按 tradingSymbol 解析当前路由。
 *
 * @param routingIndex 当前路由索引
 * @param tradingSymbol 行情标的代码
 * @returns 当前路由条目，未命中时返回 null
 */
export function resolveTradingRiskRoute(
  routingIndex: TradingRiskRoutingIndex,
  tradingSymbol: string,
): TradingRiskRoute | null {
  return routingIndex.routesBySymbol.get(tradingSymbol) ?? null;
}

/**
 * 判断当前路由是否仍然与事件到达时的 route 一致。
 *
 * @param expectedRoute 事件到达时的路由快照
 * @param routingIndex 当前基于 symbolRegistry 重建的路由索引
 * @returns 方向与 seatVersion 同时匹配时返回 true
 */
export function isTradingRiskRouteCurrent(
  expectedRoute: TradingRiskRoute,
  routingIndex: TradingRiskRoutingIndex,
): boolean {
  const currentRoute = resolveTradingRiskRoute(routingIndex, expectedRoute.tradingSymbol);
  if (!currentRoute) {
    return false;
  }

  return (
    currentRoute.direction === expectedRoute.direction &&
    currentRoute.seatVersion === expectedRoute.seatVersion
  );
}
