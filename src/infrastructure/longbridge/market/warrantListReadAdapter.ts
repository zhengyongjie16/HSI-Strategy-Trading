/**
 * 轮证列表唯一 native IO 边界。
 * 职责：校验/映射请求、复用原 retry 执行器读取 SDK、保真映射事实、TTL 缓存和并发去重。
 * 筛选与搜索失败计数不属于 adapter；clear 后晚到请求不重新写回旧缓存。
 */
import type { QuoteContext } from 'longbridge';
import type { MarketQuoteContext } from '../../../types/marketPorts.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapWarrantListRequest } from './warrantRequestMapper.js';
import { mapWarrantListItem } from './quoteFinancialMapper.js';
import type { WarrantListCacheConfig } from './warrantListCache/types.js';

/** 请求完整语义参与缓存键；未提供 issuer 与显式 null 不合并，过滤数组顺序保持原样。 */
function buildCacheKey(nativeArguments: Parameters<QuoteContext['warrantList']>): string {
  const [symbol, sortBy, sortOrder, types, issuerIds, expiryFilters, inOutBoundsTypes, status] =
    nativeArguments;
  return JSON.stringify({
    symbol,
    sortBy,
    sortOrder,
    types,
    issuerIds,
    expiryFilters,
    inOutBoundsTypes,
    status,
  });
}

/**
 * 组装当前唯一 quote context 的真实轮证读取能力，不建立第二个 query 或 retry owner。
 * @param context 原有唯一 context 的 warrantList 方法
 * @param executeRequest 原 quoteClient 的 retry 执行器；请求校验与金融映射在 retry 范围外
 * @param cacheConfig 装配层共享的缓存与技术 TTL/时钟；未启用 TTL 时直接执行原查询
 * @returns 无 SDK 参数/返回类型泄漏的窄读取 port
 */
export function createWarrantListReadAdapter(
  context: unknown,
  executeRequest: <T>(request: () => Promise<T>) => Promise<T>,
  cacheConfig?: WarrantListCacheConfig,
): Pick<MarketQuoteContext, 'warrantList'> {
  if (!isRecord(context) || typeof context['warrantList'] !== 'function') {
    throw new TypeError('[WarrantListReadAdapter] missing injected native capability');
  }

  const ctx = context as Pick<QuoteContext, 'warrantList'>;
  return {
    warrantList: async (request) => {
      const nativeArguments = mapWarrantListRequest(request);
      const readRequest = async () => {
        const warrants = await executeRequest(() => ctx.warrantList(...nativeArguments));
        return warrants.map(mapWarrantListItem);
      };
      const cacheEnabled =
        cacheConfig !== undefined && Number.isFinite(cacheConfig.ttlMs) && cacheConfig.ttlMs > 0;
      if (!cacheEnabled) return readRequest();

      const { cache, ttlMs, nowMs } = cacheConfig;
      const key = buildCacheKey(nativeArguments);
      const cached = cache.getEntry(key);
      if (cached !== undefined && nowMs() - cached.fetchedAt <= ttlMs) return cached.warrants;

      const existing = cache.getInFlight(key);
      if (existing !== undefined) return existing;

      const read = readRequest();
      cache.setInFlight(key, read);
      try {
        const warrants = await read;
        if (cache.getInFlight(key) === read) {
          cache.setEntry(key, { fetchedAt: nowMs(), warrants });
        }

        return warrants;
      } finally {
        if (cache.getInFlight(key) === read) cache.deleteInFlight(key);
      }
    },
  };
}
