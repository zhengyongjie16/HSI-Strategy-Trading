/**
 * 交易日信息解析器：同一港股日期内复用成功结果，错误回调后保留原始异常。
 * 只解析事实，不执行 startup/open 重建或改变运行时门禁。
 */
import type {
  CachedTradingDayInfo,
  TradingDayInfoResolver,
  TradingDayInfoResolverDeps,
} from './types.js';

/**
 * 创建带按日缓存的交易日信息解析函数。
 * 默认行为：同日命中缓存直接返回；接口异常时回调 onResolveError 并抛出原始错误。
 *
 * @param deps 依赖注入，包含交易日接口、日期键函数与错误回调
 * @returns 可直接用于启动状态初始化与运行期交易日状态更新的 resolveTradingDayInfo 函数
 */
export function createTradingDayInfoResolver(
  deps: TradingDayInfoResolverDeps,
): TradingDayInfoResolver {
  const { marketDataClient, getHKDateKey: resolveDateKey, onResolveError } = deps;
  let cachedTradingDayInfo: CachedTradingDayInfo | null = null;

  return async function resolveTradingDayInfo(currentTime: Date) {
    const dateStr = resolveDateKey(currentTime) ?? currentTime.toISOString().slice(0, 10);
    if (cachedTradingDayInfo?.dateStr === dateStr) {
      return cachedTradingDayInfo.info;
    }

    try {
      const info = await marketDataClient.isTradingDay(currentTime);
      cachedTradingDayInfo = { dateStr, info };
      return info;
    } catch (err) {
      onResolveError(err);
      throw err;
    }
  };
}
