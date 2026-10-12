import type { BullBearWarrantType, MarketQuoteContext } from '../../types/services.js';
import type { MarketWarrantExpiryRange } from '../../types/marketPorts.js';
import type { AutoSearchConfig, DecimalRange } from '../../types/config.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * 方向化自动寻标策略。
 * 类型用途：统一表达某一方向自动寻标的主条件阈值、降级区间、换标区间与成交额要求，作为自动寻标三条入口共享的策略对象。
 * 数据来源：由 policyResolver 基于 AutoSearchConfig 构造并校验。
 * 使用范围：autoSymbolFinder、autoSymbolManager、recovery/seatPreparation 等自动寻标链路使用。
 */
export type DirectionalAutoSearchPolicy = {
  /** 寻标方向（LONG=牛证，SHORT=熊证） */
  readonly direction: 'LONG' | 'SHORT';

  /** 主条件阈值（内部百分比值，0.35 表示 0.35%） */
  readonly primaryThreshold: string;

  /** 分均成交额阈值 */
  readonly minTurnoverPerMinute: string;

  /** 主条件失败后允许尝试的降级区间（内部百分比值，开区间，比较时不含边界） */
  readonly degradedRange: DecimalRange;

  /** 距回收价触发换标的完整区间（内部百分比值，含边界触发） */
  readonly switchDistanceRange: DecimalRange;
};

/**
 * 构造方向化自动寻标策略的入参。
 * 类型用途：为 policyResolver 提供方向、配置、日志与错误上下文，统一生成共享策略对象。
 * 数据来源：由 recovery/seatPreparation、autoSymbolManager 等调用方组装。
 * 使用范围：自动寻标策略构造边界使用。
 */
export type ResolveDirectionalAutoSearchPolicyInput = {
  readonly direction: 'LONG' | 'SHORT';
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly logPrefix: string;
  readonly logger: Logger;
};

/**
 * 基于共享策略构造 findBestWarrant 入参的参数。
 * 类型用途：将共享策略、轮证查询上下文与交易分钟数解析器组装为最终 Finder 输入，避免调用方重复拼装。
 * 数据来源：由 recovery/seatPreparation、thresholdResolver 等调用方组装。
 * 使用范围：autoSymbolFinder 与自动寻标入口之间的共享边界。
 */
export type BuildFindBestWarrantInputFromPolicyParams = {
  readonly ctx: MarketQuoteContext;
  readonly monitorSymbol: string;
  readonly currentTime: Date;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly expiryMinMonths: number;
  readonly logger: Logger;
  readonly getTradingMinutesSinceOpen: (currentTime: Date) => number;
  readonly cacheConfig?: WarrantListCacheConfig;
};

/**
 * 寻找最佳牛熊证的入参。
 * 类型用途：包含轮证查询上下文、方向化寻标策略与缓存配置，由 findBestWarrant 消费。
 * 数据来源：由 policyResolver 或 autoSymbolManager 的输入构造器统一生成。
 * 使用范围：autoSymbolFinder 与 autoSymbolManager 模块使用。
 */
export type FindBestWarrantInput = {
  readonly ctx: MarketQuoteContext;
  readonly monitorSymbol: string;
  readonly tradingMinutes: number;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly expiryMinMonths: number;
  readonly logger: Logger;
  readonly cacheConfig?: WarrantListCacheConfig;
};

/**
 * 牛熊证列表单项数据。
 * 类型用途：表示单只牛熊证的行情与属性，供 selectBestWarrant 等筛选使用。
 * 数据来源：Longbridge warrantList API 返回值结构映射。
 * 使用范围：仅 autoSymbolFinder 模块内部使用；其中 toCallPrice 保留外部 API 原始小数比值口径。
 */
export type WarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;

  /** Longbridge warrantList 原始小数比值；0.0036 表示 0.36% */
  readonly toCallPrice?: string | null;
  readonly callPrice?: string | null;
  readonly turnover?: string | null;

  /** SDK adapter按原正常状态过滤语义映射，筛选规则不消费厂商枚举。 */
  readonly status?: 'NORMAL' | 'NON_NORMAL' | null | undefined;
};

/**
 * 牛熊证列表缓存条目。
 * 类型用途：记录获取时间与数据，用于 TTL 过期判断。
 * 数据来源：由 fetchWarrantsWithCache 写入缓存。
 * 使用范围：autoSymbolFinder 缓存实现、app/runtime 装配层与相关测试共享使用。
 */
export type WarrantListCacheEntry = {
  readonly fetchedAt: number;
  readonly warrants: ReadonlyArray<WarrantListItem>;
};

/**
 * 牛熊证列表缓存接口。
 * 类型用途：支持 TTL 缓存与请求去重（inFlight），供 findBestWarrant 复用列表请求。
 * 数据来源：由 createWarrantListCache 工厂函数实现并注入。
 * 使用范围：autoSymbolFinder、autoSymbolManager、app/runtime 装配层、lifecycle cache domain 与相关测试共享使用。
 */
export interface WarrantListCache {
  getEntry: (key: string) => WarrantListCacheEntry | undefined;
  setEntry: (key: string, entry: WarrantListCacheEntry) => void;
  getInFlight: (key: string) => Promise<ReadonlyArray<WarrantListItem>> | undefined;
  setInFlight: (key: string, request: Promise<ReadonlyArray<WarrantListItem>>) => void;
  deleteInFlight: (key: string) => void;
  clear: () => void;
}

/**
 * 牛熊证列表缓存配置。
 * 类型用途：包含缓存实例、TTL 时长与当前时间获取函数，供 findBestWarrant 可选使用。
 * 数据来源：由 autoSymbolManager 的 createThresholdResolver 等构造并传入。
 * 使用范围：autoSymbolFinder 与 autoSymbolManager 模块使用。
 */
export type WarrantListCacheConfig = {
  readonly cache: WarrantListCache;
  readonly ttlMs: number;
  readonly nowMs: () => number;
};

/**
 * selectBestWarrant 的入参。
 * 类型用途：包含候选列表与方向化寻标策略，由 selectBestWarrant 消费。
 * 数据来源：由 findBestWarrant 内根据 API 返回列表与 FindBestWarrantInput 组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type SelectBestWarrantInput = {
  readonly warrants: ReadonlyArray<WarrantListItem>;
  readonly tradingMinutes: number;
  readonly policy: DirectionalAutoSearchPolicy;
};

/**
 * 寻标命中阶段。
 * 类型用途：标记候选命中主条件还是降级条件，便于日志、测试和排障显式区分。
 * 数据来源：由 selectBestWarrant 内的双层候选带筛选结果生成。
 * 使用范围：autoSymbolFinder 返回值与测试断言使用。
 */
export type WarrantSelectionStage = 'PRIMARY' | 'DEGRADED';

/**
 * 通过基础校验后的候选快照（内部高精度结构）。
 * 类型用途：缓存精确文本回收价、距离、成交额及原始分钟数；不缓存近似除法结果。
 * 数据来源：由 autoSymbolFinder/utils.ts 在筛选前解析 warrantList 返回值后生成。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type EvaluatedWarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly callPrice: string;
  readonly distancePct: string;
  readonly turnover: string;
  readonly tradingMinutes: string;
};

/**
 * 已归类到候选带的候选快照（内部高精度结构）。
 * 类型用途：保留原始精确文本及命中阶段，按阈值差值和成交额比率选优。
 * 数据来源：由 selectBestWarrant 在候选通过区间判定后生成。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type RankedWarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly callPrice: string;
  readonly distancePct: string;
  readonly turnover: string;
  readonly tradingMinutes: string;
  readonly selectionStage: WarrantSelectionStage;
  readonly distanceDeltaToThreshold: string;
};

/**
 * 自动寻标筛选结果。
 * 类型用途：包含最佳候选标的的代码、回收价、距离信息与命中阶段，供换标/寻标流程绑定席位或下单使用。
 * 数据来源：由 findBestWarrant 内 selectBestWarrant 返回并封装；distancePct 为内部百分比值口径。
 * 使用范围：autoSymbolFinder 返回，autoSymbolManager 消费。
 */
export type WarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly callPrice: string;

  /** 精确百分比文本，0.36 表示 0.36%；排序不得消费显示舍入。 */
  readonly distancePct: string;
  readonly turnover: string;

  /** 分均成交额的整数展示投影；筛选/排序使用原始成交额与分钟数 cross-product。 */
  readonly turnoverPerMinute: string;
  readonly selectionStage: WarrantSelectionStage;
  readonly distanceDeltaToThreshold: string;
};

/**
 * 双层候选带筛选结果。
 * 类型用途：返回最佳候选以及主层/降级层命中数量，供日志与测试精确判断筛选路径。
 * 数据来源：由 selectBestWarrant 生成。
 * 使用范围：findBestWarrant 与 autoSymbolFinder 测试使用。
 */
export type WarrantSelectionResult = {
  readonly candidate: WarrantCandidate | null;
  readonly primaryCandidateCount: number;
  readonly degradedCandidateCount: number;
};

/**
 * 请求牛熊证列表的入参（带缓存配置）。
 * 类型用途：由 fetchWarrantsWithCache 消费，用于带缓存的 warrantList 请求。
 * 数据来源：由 findBestWarrant 内根据 FindBestWarrantInput 组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type WarrantListFetchParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: BullBearWarrantType;
  readonly expiryFilters: ReadonlyArray<MarketWarrantExpiryRange>;
  readonly cacheConfig: WarrantListCacheConfig;
};

/**
 * 请求牛熊证列表的入参（无缓存）。
 * 类型用途：调用中性 MarketQuoteContext.warrantList 时的入参；SDK枚举映射只属于infra adapter。
 * 数据来源：由 fetchWarrantsWithCache 或调用方组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type WarrantListRequestParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: BullBearWarrantType;
  readonly expiryFilters: ReadonlyArray<MarketWarrantExpiryRange>;
};
