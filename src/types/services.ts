import type {
  Market,
  OrderSide,
  OrderStatus,
  OrderType,
  QuoteContext,
  Candlestick,
  Decimal,
  Period,
  TradeSessions,
} from 'longbridge';
import type { SignalType, Signal } from './signal.js';
import type { Quote, IndicatorSnapshot } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { DecimalLikeValue } from './common.js';
import type { StrategyRuntimeConfig } from './config.js';
import type { CancelOrderOutcome } from './trader.js';
import type { CandleData } from './data.js';

/**
 * 交易日查询结果。
 * 类型用途：封装交易日 API 的返回结构，作为 isTradingDay / 交易日查询的返回值或中间数据。
 * 数据来源：Longbridge 交易日 API（如 trading_days）。
 * 使用范围：行情客户端、生命周期、门禁等；全项目可引用。
 */
export type TradingDaysResult = {
  /** 完整交易日列表 */
  readonly tradingDays: ReadonlyArray<string>;

  /** 半日交易日列表 */
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 交易日信息。
 * 类型用途：表示某日是否为交易日及是否为半日市，作为 isTradingDay 返回值、门禁与跨日逻辑的入参。
 * 数据来源：Longbridge 交易日 API（如 trading_days）或行情客户端 isTradingDay。
 * 使用范围：行情客户端、生命周期、门禁等；全项目可引用。
 */
export type TradingDayInfo = {
  /** 是否为交易日 */
  readonly isTradingDay: boolean;

  /** 是否为半日市（如节假日前一天） */
  readonly isHalfDay: boolean;
};

/**
 * 本地 K 线缓存快照。
 * 类型用途：主循环消费的应用层 K 线缓存结构，包含版本、最后一根 bar 状态与初始化标记。
 * 数据来源：quoteClient 在 subscribe seed 与 setOnCandlestick push 更新后维护。
 * 使用范围：MarketDataClient.getCandlestickSnapshot 与主循环指标流水线使用。
 */
export type CandlestickCacheSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly candles: ReadonlyArray<CandleData>;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly initialized: boolean;
};

/**
 * 行情数据客户端接口。
 * 类型用途：依赖注入用接口，封装 Longbridge 行情 API，提供行情获取、订阅、K 线、交易日查询及运行期缓存重置。
 * 数据来源：由 quoteClient 等实现，对接 Longbridge QuoteContext。
 * 使用范围：主程序、生命周期、processMonitor、行情订阅与 K 线消费方等；全项目可引用。
 */
export interface MarketDataClient {
  /** 获取底层 QuoteContext（内部使用） */
  getQuoteContext: () => Promise<QuoteContext>;

  /**
   * 批量获取多个标的的最新行情
   * @param symbols 标的代码可迭代对象
   * @returns 标的代码到行情数据的 Map
   */
  getQuotes: (symbols: Iterable<string>) => Promise<Map<string, Quote | null>>;

  /** 动态订阅行情标的（报价推送） */
  subscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;

  /** 取消订阅行情标的（报价推送） */
  unsubscribeSymbols: (symbols: ReadonlyArray<string>) => Promise<void>;

  /**
   * 订阅指定标的的 K 线推送
   *
   * 订阅后客户端会用返回值 seed 应用层本地 K 线缓存，并通过 push 事件持续更新。
   * getRealtimeCandlesticks 仍保留为 SDK 内部缓存读取能力（非主循环主路径）。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param tradeSessions 交易时段（默认 All）
   * @returns 初始 K 线数据
   */
  subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<Candlestick>>;

  /**
   * 获取实时 K 线数据（从 SDK 内部缓存读取，无 HTTP 请求）
   *
   * 需先调用 subscribeCandlesticks 订阅，否则返回空数据。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @param count 获取数量
   */
  getRealtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<Candlestick>>;

  /**
   * 获取应用层本地 K 线缓存快照（由 subscribe seed + push 更新维护）。
   *
   * @param symbol 标的代码
   * @param period K 线周期
   * @returns 本地缓存快照，不存在时返回 null
   */
  getCandlestickSnapshot: (symbol: string, period: Period) => CandlestickCacheSnapshot | null;

  /** 判断指定日期是否为交易日 */
  isTradingDay: (date: Date, market?: Market) => Promise<TradingDayInfo>;

  /** 批量获取交易日历区间（可选实现） */
  getTradingDays?: (startDate: Date, endDate: Date, market?: Market) => Promise<TradingDaysResult>;

  /** 重置运行期订阅与缓存（跨日午夜清理） */
  resetRuntimeSubscriptionsAndCaches: () => Promise<void>;
}

/**
 * 待处理订单。
 * 类型用途：表示尚未完全成交的订单，用于 getPendingOrders 返回值、订单监控与撤单逻辑。
 * 数据来源：Trader/订单 API 查询结果转换。
 * 使用范围：trader、orderMonitor、主循环等；全项目可引用。
 */
export type PendingOrder = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly submittedPrice: number;
  readonly quantity: number;
  readonly executedQuantity: number;
  readonly status: OrderStatus;
  readonly orderType: RawOrderFromAPI['orderType'];

  /** 订单原始响应（仅用于问题排查与调试日志） */
  readonly _rawOrder?: unknown;
};

/**
 * API 返回的原始订单类型。
 * 类型用途：从 Longbridge 订单 API 接收订单数据时的类型安全结构，作为 fetchAllOrdersFromAPI、启动恢复与当日亏损回算等入参或元素类型。
 * 数据来源：Longbridge 订单 API 返回。
 * 使用范围：Trader、dailyLossTracker、启动恢复等需要订单 API 结果的模块；全项目可引用。
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly orderType: OrderType;
  readonly remark?: string | null;
  readonly price: DecimalLikeValue;
  readonly quantity: DecimalLikeValue;
  readonly executedPrice: DecimalLikeValue;
  readonly executedQuantity: DecimalLikeValue;
  readonly submittedAt?: Date | null;
  readonly updatedAt?: Date | null;
};

/**
 * 已成交订单记录。
 * 类型用途：表示单笔已成交订单，用于当日亏损回算等需要统一成交结构的场景。
 * 数据来源：由 RawOrderFromAPI 转换得到。
 * 使用范围：DailyLossTracker 等跨模块成交计算场景；全项目可引用。
 */
export type OrderRecord = {
  /** 订单 ID */
  readonly orderId: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 成交价格 */
  readonly executedPrice: number;

  /** 成交数量 */
  readonly executedQuantity: number;

  /** 成交时间戳 */
  readonly executedTime: number;

  /** 下单时间 */
  readonly submittedAt: Date | undefined;

  /** 更新时间 */
  readonly updatedAt: Date | undefined;
};

/**
 * 最近成交订单摘要。
 * 类型用途：在不保留订单记录模块的前提下，为自动换标等链路提供最近成交金额读取能力。
 * 数据来源：订单监控终态结算后写入运行态缓存。
 * 使用范围：Trader、自动换标等需要按 orderId 读取成交摘要的场景。
 */
export type RecentFilledOrderSummary = {
  /** 订单 ID */
  readonly orderId: string;

  /** 标的代码 */
  readonly symbol: string;

  /** 买卖方向 */
  readonly side: OrderSide;

  /** 成交价格 */
  readonly executedPrice: number;

  /** 成交数量 */
  readonly executedQuantity: number;

  /** 成交时间戳 */
  readonly executedTimeMs: number;
};

/**
 * 交易检查结果。
 * 类型用途：表示当前是否可执行交易及原因，作为 canTradeNow 等频率检查调用的返回值。
 * 数据来源：Trader 内部根据频率限制、门禁等计算。
 * 使用范围：主循环、买卖处理器等；全项目可引用。
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;

  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;

  /** 交易方向 */
  readonly direction?: 'LONG' | 'SHORT';

  /** 不可交易原因 */
  readonly reason?: string;
};

/**
 * API 频率限制器接口。
 * 类型用途：依赖注入用接口，在交易/行情等 API 调用前等待限流通过。
 * 数据来源：如适用；实现由调用方提供。
 * 使用范围：Trader、行情客户端等限流场景；见调用方。
 */
export interface RateLimiter {
  /** 等待限流通过 */
  throttle: () => Promise<void>;
}

/**
 * 交易器接口。
 * 类型用途：依赖注入用接口，封装 Longbridge 交易 API，提供账户/持仓、订单执行、订单监控与信号执行等。
 * 数据来源：实现层对接 Longbridge TradeContext；账户与订单数据来自 API。
 * 使用范围：主循环、StrategyRuntime、信号处理、门禁等；全项目可引用。
 */
export interface Trader {
  // ========== 账户相关 ==========

  /** 获取账户快照 */
  getAccountSnapshot: () => Promise<AccountSnapshot | null>;

  /** 获取持仓列表 */
  getStockPositions: (symbols?: ReadonlyArray<string> | null) => Promise<ReadonlyArray<Position>>;

  // ========== 订单缓存 ==========

  /** 获取待处理订单 */
  getPendingOrders: (
    symbols?: ReadonlyArray<string> | null,
    forceRefresh?: boolean,
  ) => Promise<ReadonlyArray<PendingOrder>>;

  /** 启动阶段种子化订单订阅保留集 */
  seedOrderHoldSymbols: (orders: ReadonlyArray<RawOrderFromAPI>) => void;

  /** 获取订单订阅保留标的集合 */
  getOrderHoldSymbols: () => ReadonlySet<string>;

  /** 是否存在指定标的的未完成卖单链路 */
  hasPendingSellOrders: (symbol: string) => boolean;

  // ========== 订单监控 ==========

  /** 撤销订单 */
  cancelOrder: (orderId: string) => Promise<CancelOrderOutcome>;

  /** 监控和管理待处理订单 */
  monitorAndManageOrders: () => Promise<void>;

  /** 获取并清空待刷新标的列表 */
  getAndClearPendingRefreshSymbols: () => ReadonlyArray<PendingRefreshSymbol>;

  /** 是否存在指定监控标的方向的未完成保护性清仓卖单链路 */
  hasPendingProtectiveLiquidationOrders: (
    baseInstrumentSymbol: string,
    direction: 'LONG' | 'SHORT',
  ) => boolean;

  /** 初始化订单监控（WebSocket 订阅） */
  initializeOrderMonitor: () => Promise<void>;

  // ========== 订单执行 ==========

  /** 检查当前是否可交易 */
  canTradeNow: (
    signalAction: SignalType,
    monitorConfig?: StrategyRuntimeConfig | null,
  ) => TradeCheckResult;

  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI: (forceRefresh?: boolean) => Promise<ReadonlyArray<RawOrderFromAPI>>;

  /** 生命周期午夜清理：重置订单运行态缓存 */
  resetRuntimeState: () => void;

  /** 生命周期开盘重建：基于快照恢复订单追踪 */
  recoverOrderTrackingFromSnapshot: (allOrders: ReadonlyArray<RawOrderFromAPI>) => Promise<void>;

  /** 读取最近成交订单摘要 */
  getRecentFilledOrder: (orderId: string) => RecentFilledOrderSummary | null;

  /** 执行交易信号；返回实际提交数量与订单 ID 列表（保护性清仓等仅在真正提交后才更新缓存） */
  executeSignals: (
    signals: Signal[],
  ) => Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }>;
}

/**
 * 待刷新数据的标的信息。
 * 类型用途：订单成交后标记需要刷新的标的及要刷新的数据类型（账户/持仓），用于 getAndClearPendingRefreshSymbols 等。
 * 数据来源：Trader/订单监控在成交回调中写入。
 * 使用范围：postTradeRefresher、主循环等；全项目可引用。
 */
export type PendingRefreshSymbol = {
  /** 标的代码 */
  readonly symbol: string;

  /** 是否为做多标的 */
  readonly isLongSymbol: boolean;

  /** 是否刷新账户数据 */
  readonly refreshAccount: boolean;

  /** 是否刷新持仓数据 */
  readonly refreshPositions: boolean;
};

/**
 * 牛熊证类型。
 * 类型用途：区分牛证（做多）与熊证（做空），用于 RiskCheckResult、WarrantDistanceInfo 等字段。
 * 数据来源：Longbridge 行情静态信息或 RiskChecker 解析。
 * 使用范围：RiskChecker、UI/监控展示等；全项目可引用。
 */
export type BullBearWarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息。
 * 类型用途：表示某标的距离回收价的百分比，用于实时展示与风控判断。
 * 数据来源：RiskChecker 根据行情与回收价计算。
 * 使用范围：RiskChecker、UI/监控展示；全项目可引用。
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: BullBearWarrantType;

  /** 距离回收价百分比（运行时保持 Decimal 精度，展示时再格式化） */
  readonly distanceToStrikePercent: Decimal | null;
};

/**
 * 牛熊证信息刷新结果。
 * 类型用途：表示刷新牛熊证信息的结果（ok/notWarrant/error/skipped），作为 setWarrantInfoFromCallPrice、refreshWarrantInfoForSymbol 返回值。
 * 数据来源：RiskChecker 根据 API 或透传回收价得出。
 * 使用范围：RiskChecker、调用方与 UI；全项目可引用。
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok'; readonly isWarrant: true }
  | { readonly status: 'notWarrant'; readonly isWarrant: false }
  | { readonly status: 'error'; readonly isWarrant: false; readonly reason: string }
  | { readonly status: 'skipped'; readonly isWarrant: false };

/**
 * 牛熊证距回收价清仓判定结果。
 * 类型用途：表示是否应因距回收价过近而清仓及原因，作为 checkWarrantDistanceLiquidation 返回值。
 * 数据来源：RiskChecker 根据当前价与回收价计算。
 * 使用范围：RiskChecker、信号处理/卖出逻辑；全项目可引用。
 */
export type WarrantDistanceLiquidationResult = {
  /** 是否触发清仓 */
  readonly shouldLiquidate: boolean;

  /** 牛熊证类型 */
  readonly warrantType?: BullBearWarrantType;

  /** 距离回收价百分比 */
  readonly distancePercent?: number | null;

  /** 判定原因 */
  readonly reason?: string;
};

/**
 * 风险检查结果。
 * 类型用途：订单前/牛熊证风险检查的返回值，表示是否允许交易、原因及牛熊证风险信息。
 * 数据来源：RiskChecker.checkBeforeOrder、checkWarrantRisk 等。
 * 使用范围：信号处理、买卖流程、主循环；全项目可引用。
 */
export type RiskCheckResult = {
  /** 是否允许交易 */
  readonly allowed: boolean;

  /** 不允许原因 */
  readonly reason?: string;

  /** 牛熊证风险信息 */
  readonly warrantInfo?: {
    /** 是否为牛熊证 */
    readonly isWarrant: boolean;

    /** 牛熊证类型 */
    readonly warrantType: BullBearWarrantType;

    /** 距离回收价百分比 */
    readonly distanceToStrikePercent: number;
  };
};

/**
 * 浮亏数据。
 * 类型用途：存储执行标的累计买入金额/数量等，用于计算浮动亏损与强平判定。
 * 数据来源：Position.costPrice/quantity 与 RiskChecker 刷新计算。
 * 使用范围：RiskChecker、UnrealizedLossMonitor 等；全项目可引用。
 */
export type UnrealizedLossData = {
  /** r1: 累计买入金额 */
  readonly r1: number;

  /** n1: 累计买入数量 */
  readonly n1: number;

  /** baseR1: 未调整的开仓成本 */
  readonly baseR1?: number;

  /** dailyLossOffset: 当日亏损偏移（仅记录亏损，<=0） */
  readonly dailyLossOffset?: number;

  /** 最后更新时间戳 */
  readonly lastUpdateTime: number;
};

/**
 * 浮亏实时指标。
 * 类型用途：基于浮亏缓存和当前价格计算的实时持仓指标，供行情展示等非清仓场景使用。
 * 数据来源：RiskChecker 读取 UnrealizedLossData 并结合最新价格计算得到。
 * 使用范围：marketMonitor、processMonitor 风险任务等；全项目可引用。
 */
export type UnrealizedLossMetrics = {
  /** r1: 调整后的开仓成本 */
  readonly r1: number;

  /** n1: 持仓数量 */
  readonly n1: number;

  /** r2: 当前持仓市值 */
  readonly r2: number;

  /** 持仓盈亏（r2 - r1） */
  readonly unrealizedPnL: number;
};

/**
 * 浮亏检查结果。
 * 类型用途：执行标的浮亏检查返回值，表示是否应强制平仓、原因及建议平仓数量。
 * 数据来源：RiskChecker.checkUnrealizedLoss。
 * 使用范围：信号处理、卖出逻辑；全项目可引用。
 */
export type UnrealizedLossCheckResult = {
  /** 是否应该强制平仓 */
  readonly shouldLiquidate: boolean;

  /** 平仓原因 */
  readonly reason?: string;

  /** 平仓数量 */
  readonly quantity?: number;
};

/**
 * 持仓缓存接口。
 * 类型用途：依赖注入用接口，提供基于标的代码的 O(1) 持仓查找，作为 LastState.positionCache、RiskCheckContext 等类型。
 * 数据来源：由主循环/刷新流程根据 getStockPositions 结果调用 update 维护。
 * 使用范围：LastState、RiskChecker、主循环等；全项目可引用。
 */
export interface PositionCache {
  /** 更新持仓缓存 */
  update: (positions: ReadonlyArray<Position>) => void;

  /** 获取指定标的的持仓 */
  get: (symbol: string) => Position | null;
}

/**
 * 末日保护买入门禁最小契约。
 * 类型用途：仅约束风险检查链路对末日保护的依赖行为，避免类型层反向依赖业务实现。
 * 数据来源：由 doomsdayProtection 模块实现并注入。
 * 使用范围：RiskCheckContext 与买入风险检查链路使用。
 */
interface DoomsdayBuyGuard {
  /** 检查是否应该拒绝买入（收盘前15分钟） */
  shouldRejectBuy: (currentTime: Date, isHalfDay: boolean) => boolean;
}

/**
 * 风险检查上下文。
 * 类型用途：执行信号处理与风控时的完整上下文（交易器、风控器、行情、账户、配置等），作为 processSignal、风控检查的入参。
 * 数据来源：由主循环/processMonitor 根据 StrategyRuntime 与 LastState 组装传入。
 * 使用范围：信号处理、风控检查等；全项目可引用。
 */
export type RiskCheckContext = {
  /** 交易器 */
  readonly trader: Trader;

  /** 风险检查器 */
  readonly riskChecker: RiskChecker;

  /** 做多标的行情 */
  readonly longQuote: Quote | null;

  /** 做空标的行情 */
  readonly shortQuote: Quote | null;

  /** 监控标的行情 */
  readonly monitorQuote: Quote | null;

  /** 监控标的指标快照 */
  readonly monitorSnapshot: IndicatorSnapshot | null;

  /** 做多标的代码 */
  readonly longSymbol: string;

  /** 做空标的代码 */
  readonly shortSymbol: string;

  /** 做多标的名称 */
  readonly longSymbolName: string | null;

  /** 做空标的名称 */
  readonly shortSymbolName: string | null;

  /** 账户缓存（卖出基础风险检查与日志共用） */
  readonly account: AccountSnapshot | null;

  /** 持仓缓存（卖出基础风险检查与日志共用） */
  readonly positions: ReadonlyArray<Position>;

  /** 全局状态引用 */
  readonly lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: ReadonlyArray<Position>;
    positionCache: PositionCache;
  };

  /** 当前时间 */
  readonly currentTime: Date;

  /** 是否为半日市 */
  readonly isHalfDay: boolean;

  /** 末日保护实例 */
  readonly doomsdayProtection: DoomsdayBuyGuard;

  /** 监控配置 */
  readonly config: StrategyRuntimeConfig;
};

/**
 * 风险检查器接口。
 * 类型用途：依赖注入用接口，门面模式协调牛熊证风险、持仓限制与浮亏检查，供信号处理与买卖流程调用。
 * 数据来源：实现层对接行情与持仓缓存；牛熊证/浮亏数据由内部缓存与 API 维护。
 * 使用范围：StrategyRuntime、信号处理、主循环等；全项目可引用。
 */
export interface RiskChecker {
  /** 从透传的回收价设置牛熊证信息（不调用 API） */
  setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: number,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;

  /** 刷新单个标的的牛熊证信息 */
  refreshWarrantInfoForSymbol: (
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => Promise<WarrantRefreshResult>;

  /** 订单前风险检查（持仓限制） */
  checkBeforeOrder: (params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: Signal | null;
    readonly orderNotional: number;
    readonly currentPrice?: number | null;
  }) => RiskCheckResult;

  /** 牛熊证风险检查（距离回收价阈值） */
  checkWarrantRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
  ) => RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ) => WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ) => WarrantDistanceInfo | null;

  /** 清空做多标的牛熊证信息缓存（换标时调用） */
  clearLongWarrantInfo: () => void;

  /** 清空做空标的牛熊证信息缓存（换标时调用） */
  clearShortWarrantInfo: () => void;

  /** 刷新浮亏数据 */
  refreshUnrealizedLossData: (
    symbol: string,
    position: Position | null,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ) => Promise<{ r1: number; n1: number } | null>;

  /** 浮亏检查（是否触发强平） */
  checkUnrealizedLoss: (
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ) => UnrealizedLossCheckResult;

  /** 获取实时浮亏指标（用于展示持仓市值与持仓盈亏） */
  getUnrealizedLossMetrics: (
    symbol: string,
    currentPrice: number | null,
  ) => UnrealizedLossMetrics | null;

  /** 清空浮亏缓存（symbol 为空时清空全部） */
  clearUnrealizedLossData: (symbol?: string | null) => void;
}
