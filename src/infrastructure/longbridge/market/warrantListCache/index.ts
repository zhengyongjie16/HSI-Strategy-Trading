/**
 * 牛熊证列表读取缓存。
 * 职责：仅保存真实 adapter 的中性事实和在途请求；TTL/读取由 warrantListReadAdapter 独占执行。
 * clear 同时清除在途 owner，使旧请求不再有资格写回缓存或删除新请求。
 */
import type { MarketWarrantListItem } from '../../../../types/marketPorts.js';
import type { WarrantListCache, WarrantListCacheEntry } from './types.js';

/** 创建装配层共享的唯一轮证列表缓存，不复制 SDK query 或业务失败/冻结政策。 */
export function createWarrantListCache(): WarrantListCache {
  const entries = new Map<string, WarrantListCacheEntry>();
  const inFlight = new Map<string, Promise<ReadonlyArray<MarketWarrantListItem>>>();
  return {
    getEntry: (key) => entries.get(key),
    setEntry: (key, entry) => {
      entries.set(key, entry);
    },
    getInFlight: (key) => inFlight.get(key),
    setInFlight: (key, request) => {
      inFlight.set(key, request);
    },
    deleteInFlight: (key) => {
      inFlight.delete(key);
    },
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
  };
}
