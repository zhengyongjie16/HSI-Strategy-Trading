import type {
  MarketWarrantListItem,
  WarrantListCacheClearer,
} from '../../../../types/marketPorts.js';

/** 轮证读取缓存条目，由真实 market adapter 在 IO 成功且仍属当前请求时写入。 */
export type WarrantListCacheEntry = Readonly<{
  fetchedAt: number;
  warrants: ReadonlyArray<MarketWarrantListItem>;
}>;

/**
 * 轮证读取的单缓存能力。
 * 数据来源：market adapter 缓存工厂；业务只在装配/日切时持有 clear，不参与事实读写。
 * 使用范围：warrantListReadAdapter 的 TTL、并发去重与晚到请求失效校验。
 */
export interface WarrantListCache extends WarrantListCacheClearer {
  readonly getEntry: (key: string) => WarrantListCacheEntry | undefined;
  readonly setEntry: (key: string, entry: WarrantListCacheEntry) => void;
  readonly getInFlight: (key: string) => Promise<ReadonlyArray<MarketWarrantListItem>> | undefined;
  readonly setInFlight: (
    key: string,
    request: Promise<ReadonlyArray<MarketWarrantListItem>>,
  ) => void;
  readonly deleteInFlight: (key: string) => void;
}

/** 轮证 adapter 的缓存配置；TTL 和注入时钟是技术值，金融事实保持原十进制文本。 */
export type WarrantListCacheConfig = Readonly<{
  cache: WarrantListCache;
  ttlMs: number;
  nowMs: () => number;
}>;
