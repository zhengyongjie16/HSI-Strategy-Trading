/**
 * 交易日信息解析器：查询一次交易日事实，错误回调后保留原始异常。
 * 只解析事实，不执行 startup/open 重建或改变运行时门禁。
 */
import type { TradingDayInfoResolver, TradingDayInfoResolverDeps } from './types.js';

/**
 * 创建交易日信息解析函数。
 * 默认行为：直接查询交易日接口；接口异常时回调 onResolveError 并抛出原始错误。
 *
 * @param deps 依赖注入，包含交易日接口与错误回调
 * @returns 供启动交易日状态初始化使用的 resolveTradingDayInfo 函数
 */
export function createTradingDayInfoResolver(
  deps: TradingDayInfoResolverDeps,
): TradingDayInfoResolver {
  const { marketDataClient, onResolveError } = deps;

  return async function resolveTradingDayInfo(currentTime: Date) {
    try {
      return await marketDataClient.isTradingDay(currentTime);
    } catch (error) {
      onResolveError(error);
      throw error;
    }
  };
}
