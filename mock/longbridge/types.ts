import type {
  AccountBalance,
  Decimal,
  Execution,
  GetHistoryOrdersOptions,
  GetTodayExecutionsOptions,
  GetTodayOrdersOptions,
  Market,
  Order,
  OrderDetail,
  OrderSide,
  OrderStatus,
  OrderType,
  Period,
  PushCandlestickEvent,
  PushOrderChanged,
  PushQuoteEvent,
  ReplaceOrderOptions,
  SortOrderType,
  StockPositionsResponse,
  SubType,
  SubmitOrderOptions,
  SubmitOrderResponse,
  TopicType,
  TradeSessions,
  WarrantInfo,
  WarrantQuote,
  WarrantStatus,
  WarrantSortBy,
  WarrantType,
} from 'longbridge';

/**
 * Longbridge mock 可识别的方法名集合。
 * 类型用途：约束调用记录与失败注入中的方法名字段，避免字符串漂移。
 * 数据来源：QuoteContext / TradeContext mock 实现能力定义。
 * 使用范围：mock/longbridge 模块内部及其测试使用。
 */
export type MockMethodName =
  | 'quote'
  | 'staticInfo'
  | 'subscribe'
  | 'unsubscribe'
  | 'realtimeQuote'
  | 'subscribeCandlesticks'
  | 'unsubscribeCandlesticks'
  | 'realtimeCandlesticks'
  | 'tradingDays'
  | 'warrantQuote'
  | 'warrantList'
  | 'submitOrder'
  | 'cancelOrder'
  | 'orderDetail'
  | 'replaceOrder'
  | 'todayOrders'
  | 'historyOrders'
  | 'todayExecutions'
  | 'accountBalance'
  | 'stockPositions'
  | 'tradeSubscribe'
  | 'tradeUnsubscribe';

/**
 * Longbridge mock 单次调用记录结构。
 * 类型用途：保存方法调用参数、结果和错误，供测试断言调用链路。
 * 数据来源：mock 调用包装器 withMockCall 运行时记录。
 * 使用范围：mock/longbridge 模块内部及对外 getCalls 返回值。
 */
export type MockCallRecord = {
  readonly method: MockMethodName;
  readonly callIndex: number;
  readonly calledAtMs: number;
  readonly args: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly error: Error | null;
};

/**
 * Longbridge mock 失败注入规则。
 * 类型用途：控制按次数、按谓词或按上限触发失败，验证重试和容错逻辑。
 * 数据来源：测试代码通过 setFailureRule 注入。
 * 使用范围：mock/longbridge 模块内部及外部测试配置入口。
 */
export type MockFailureRule = {
  readonly failAtCalls?: ReadonlyArray<number>;
  readonly failEveryCalls?: number;
  readonly maxFailures?: number;
  readonly predicate?: (args: ReadonlyArray<unknown>) => boolean;
  readonly errorMessage?: string;
};

/**
 * Longbridge mock 失败注入运行时状态。
 * 类型用途：管理方法调用次数、失败次数和规则映射，支撑失败注入判定。
 * 数据来源：createFailureState 在运行期初始化。
 * 使用范围：mock/longbridge/utils.ts 及上下文 mock 内部使用。
 */
export type MockFailureState = {
  readonly callsByMethod: Map<MockMethodName, number>;
  readonly failedCountByMethod: Map<MockMethodName, number>;
  readonly rules: Map<MockMethodName, MockFailureRule>;
};

/**
 * Longbridge mock Decimal 输入联合类型。
 * 类型用途：统一描述 decimal 工具函数可接收的输入值形态。
 * 数据来源：测试数据工厂与 mock 事件构造参数。
 * 使用范围：mock/longbridge/decimal.ts 使用。
 */
export type MockDecimalInput = string | number | Decimal;

/**
 * Mock 轮证列表项。
 * 类型用途：为 quoteContextMock.seedWarrantList 提供最小必需字段集合，只覆盖自动寻标测试实际消费的字段。
 * 数据来源：测试用例构造的 mock 轮证数据。
 * 使用范围：mock/longbridge/quoteContextMock.ts 与相关业务测试使用。
 */
export type MockWarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone?: MockDecimalInput | null;

  /** Longbridge warrantList 原始小数比值；0.0036 表示 0.36% */
  readonly toCallPrice?: MockDecimalInput | null;
  readonly callPrice?: MockDecimalInput | null;
  readonly turnover?: MockDecimalInput | null;
  readonly warrantType?: WarrantType | number | string | null;
  readonly status?: WarrantStatus | number | string | null;
};

/**
 * Mock 调用日志能力契约。
 * 类型用途：规范 getCalls / clearCalls 两个日志接口的签名。
 * 数据来源：Longbridge mock 上下文公共能力抽象。
 * 使用范围：仅本文件内部组合 Quote/Trade 合同接口。
 */
interface MockInvocationLog {
  getCalls: (method?: MockMethodName) => ReadonlyArray<MockCallRecord>;
  clearCalls: () => void;
}

/**
 * Mock 失败注入控制能力契约。
 * 类型用途：规范 setFailureRule / clearFailureRules 两个控制接口签名。
 * 数据来源：Longbridge mock 上下文公共能力抽象。
 * 使用范围：仅本文件内部组合 Quote/Trade 合同接口。
 */
interface MockFailureController {
  setFailureRule: (method: MockMethodName, rule: MockFailureRule | null) => void;
  clearFailureRules: () => void;
}

/**
 * QuoteContext mock 合同接口。
 * 类型用途：定义行情 mock 需暴露的查询、订阅、失败注入和调用日志能力。
 * 数据来源：Longbridge QuoteContext API 能力映射。
 * 使用范围：mock/longbridge/quoteContextMock.ts 导出对象契约。
 */
export interface QuoteContextContract extends MockInvocationLog, MockFailureController {
  quote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<unknown>>;
  staticInfo: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<unknown>>;
  realtimeQuote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<unknown>>;
  subscribe: (symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>) => Promise<void>;
  unsubscribe: (symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>) => Promise<void>;
  subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<unknown>>;
  unsubscribeCandlesticks: (symbol: string, period: Period) => Promise<void>;
  realtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<unknown>>;
  tradingDays: (
    market: Market,
    begin: unknown,
    end: unknown,
  ) => Promise<{
    readonly tradingDays: ReadonlyArray<unknown>;
    readonly halfTradingDays: ReadonlyArray<unknown>;
  }>;
  warrantQuote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<WarrantQuote>>;
  warrantList: (
    symbol: string,
    sortBy: WarrantSortBy,
    sortOrder: SortOrderType,
    types: ReadonlyArray<WarrantType>,
  ) => Promise<ReadonlyArray<WarrantInfo>>;
  setOnQuote: (callback: (err: Error | null, event: PushQuoteEvent) => void) => void;
  setOnCandlestick: (callback: (err: Error | null, event: PushCandlestickEvent) => void) => void;
}

/**
 * TradeContext mock 合同接口。
 * 类型用途：定义交易 mock 需暴露的下单、查询、推送订阅、失败注入和调用日志能力。
 * 数据来源：Longbridge TradeContext API 能力映射。
 * 使用范围：mock/longbridge/tradeContextMock.ts 导出对象契约。
 */
export interface TradeContextContract extends MockInvocationLog, MockFailureController {
  submitOrder: (options: SubmitOrderOptions) => Promise<SubmitOrderResponse>;
  cancelOrder: (orderId: string) => Promise<void>;
  orderDetail: (orderId: string) => Promise<OrderDetail>;
  replaceOrder: (options: ReplaceOrderOptions) => Promise<void>;
  todayOrders: (options?: GetTodayOrdersOptions) => Promise<ReadonlyArray<Order>>;
  historyOrders: (options?: GetHistoryOrdersOptions) => Promise<ReadonlyArray<Order>>;
  todayExecutions: (options?: GetTodayExecutionsOptions) => Promise<ReadonlyArray<Execution>>;
  accountBalance: (currency?: string) => Promise<ReadonlyArray<AccountBalance>>;
  stockPositions: (symbols?: ReadonlyArray<string>) => Promise<StockPositionsResponse>;
  setOnOrderChanged: (callback: (err: Error | null, event: PushOrderChanged) => void) => void;
  subscribe: (topics: ReadonlyArray<TopicType>) => Promise<void>;
  unsubscribe: (topics: ReadonlyArray<TopicType>) => Promise<void>;
}

/**
 * Longbridge mock 事件主题。
 * 类型用途：约束内部事件总线的 topic 字段与订阅入口。
 * 数据来源：mock 行情/交易事件通道定义。
 * 使用范围：mock/longbridge/eventBus.ts 与上下文 mock。
 */
export type LongportEventTopic = 'quote' | 'candlestick' | 'orderChanged';

/**
 * Longbridge mock 事件主题到 payload 的映射。
 * 类型用途：为 publish/subscribe 提供 topic 到 payload 的强类型关联。
 * 数据来源：Longbridge 推送事件类型（quote/candlestick/orderChanged）。
 * 使用范围：mock/longbridge/eventBus.ts。
 */
export type LongportEventPayloadMap = Readonly<{
  quote: PushQuoteEvent;
  candlestick: PushCandlestickEvent;
  orderChanged: PushOrderChanged;
}>;

/**
 * Longbridge mock 事件订阅回调签名。
 * 类型用途：表达不同 topic 下回调 payload 的对应关系。
 * 数据来源：LongportEventPayloadMap 派生。
 * 使用范围：mock/longbridge/eventBus.ts。
 */
export type Subscriber<TTopic extends LongportEventTopic> = (
  payload: LongportEventPayloadMap[TTopic],
) => void;

/**
 * Longbridge mock 事件队列条目。
 * 类型用途：承载排队待投递事件的排序字段与 payload。
 * 数据来源：eventBus.publish 入队时构建。
 * 使用范围：mock/longbridge/eventBus.ts。
 */
export type QueueEvent<TTopic extends LongportEventTopic> = Readonly<{
  topic: TTopic;
  payload: LongportEventPayloadMap[TTopic];
  deliverAtMs: number;
  sequence: number;
  insertedAt: number;
}>;

/**
 * Longbridge mock 事件队列联合类型。
 * 类型用途：统一表达三类 topic 的队列事件，便于排序与分发。
 * 数据来源：QueueEvent + LongportEventTopic 映射。
 * 使用范围：mock/longbridge/eventBus.ts。
 */
export type QueueEventUnion = {
  [K in LongportEventTopic]: QueueEvent<K>;
}[LongportEventTopic];

/**
 * Longbridge mock 事件发布参数。
 * 类型用途：配置延迟投递时间与顺序序号。
 * 数据来源：测试或 mock 调用方 publish 时传入。
 * 使用范围：mock/longbridge/eventBus.ts、quoteContextMock、tradeContextMock。
 */
export type EventPublishOptions = Readonly<{
  deliverAtMs?: number;
  sequence?: number;
}>;

/**
 * Longbridge mock 事件总线契约。
 * 类型用途：定义订阅、发布、flush 与队列查询能力。
 * 数据来源：createLongportEventBus 返回对象。
 * 使用范围：mock/longbridge/eventBus.ts、quoteContextMock、tradeContextMock。
 */
export interface LongportEventBus {
  subscribe: <TTopic extends LongportEventTopic>(
    topic: TTopic,
    subscriber: Subscriber<TTopic>,
  ) => () => void;
  publish: <TTopic extends LongportEventTopic>(
    topic: TTopic,
    payload: LongportEventPayloadMap[TTopic],
    options?: EventPublishOptions,
  ) => void;
  flushDue: (nowMs?: number) => number;
  flushAll: () => number;
  getQueueSize: () => number;
}

/**
 * QuoteContext mock 创建参数。
 * 类型用途：注入事件总线和时间函数，控制推送调度行为。
 * 数据来源：createQuoteContextMock 调用方传入。
 * 使用范围：mock/longbridge/quoteContextMock.ts。
 */
export type QuoteContextMockOptions = Readonly<{
  eventBus?: LongportEventBus;
  now?: () => number;
}>;

/**
 * QuoteContext mock 完整接口。
 * 类型用途：在 QuoteContextContract 基础上补充 seed/emit/flush 等测试专用能力。
 * 数据来源：createQuoteContextMock 返回对象。
 * 使用范围：mock/longbridge/quoteContextMock.ts 及其测试调用方。
 */
export interface QuoteContextMock extends QuoteContextContract {
  seedQuotes: (quotes: ReadonlyArray<{ readonly symbol: string; readonly quote: unknown }>) => void;
  seedRealtimeQuotes: (
    quotes: ReadonlyArray<{ readonly symbol: string; readonly quote: unknown }>,
  ) => void;
  seedStaticInfo: (
    staticInfos: ReadonlyArray<{ readonly symbol: string; readonly info: unknown }>,
  ) => void;
  seedCandlesticks: (symbol: string, period: Period, candles: ReadonlyArray<unknown>) => void;
  seedTradingDays: (
    key: string,
    value: {
      readonly tradingDays: ReadonlyArray<unknown>;
      readonly halfTradingDays: ReadonlyArray<unknown>;
    },
  ) => void;
  seedWarrantQuotes: (quotes: ReadonlyArray<WarrantQuote>) => void;
  seedWarrantList: (symbol: string, list: ReadonlyArray<MockWarrantListItem>) => void;
  emitQuote: (event: PushQuoteEvent, options?: EventPublishOptions) => void;
  emitCandlestick: (event: PushCandlestickEvent, options?: EventPublishOptions) => void;
  flushEvents: (nowMs?: number) => number;
  flushAllEvents: () => number;
  getSubscribedSymbols: () => ReadonlySet<string>;
  getSubscribedCandlestickKeys: () => ReadonlySet<string>;
}

/**
 * TradeContext mock 创建参数。
 * 类型用途：注入事件总线和时间函数，控制下单事件回放语义。
 * 数据来源：createTradeContextMock 调用方传入。
 * 使用范围：mock/longbridge/tradeContextMock.ts。
 */
export type TradeContextMockOptions = Readonly<{
  eventBus?: LongportEventBus;
  now?: () => number;
}>;

/**
 * TradeContext mock 最小订单结构。
 * 类型用途：作为交易 mock 的内部状态模型，统一下单/改单/撤单流程字段。
 * 数据来源：submitOrder 入参映射与 seedTodayOrders/seedHistoryOrders。
 * 使用范围：mock/longbridge/tradeContextMock.ts。
 */
export type MinimalOrder = Readonly<{
  orderId: string;
  status: OrderStatus;
  stockName: string;
  quantity: Decimal;
  executedQuantity: Decimal;
  price: Decimal;
  executedPrice: Decimal;
  submittedAt: Date;
  side: OrderSide;
  symbol: string;
  orderType: OrderType;
  updatedAt: Date;
}>;

/**
 * TradeContext mock 完整接口。
 * 类型用途：在 TradeContextContract 基础上补充 seed/emit/flush 等测试专用能力。
 * 数据来源：createTradeContextMock 返回对象。
 * 使用范围：mock/longbridge/tradeContextMock.ts 及其测试调用方。
 */
export interface TradeContextMock extends TradeContextContract {
  seedTodayOrders: (orders: ReadonlyArray<Order>) => void;
  seedHistoryOrders: (orders: ReadonlyArray<Order>) => void;
  seedTodayExecutions: (executions: ReadonlyArray<Execution>) => void;
  seedAccountBalances: (balances: ReadonlyArray<AccountBalance>) => void;
  seedStockPositions: (response: StockPositionsResponse) => void;
  emitOrderChanged: (event: PushOrderChanged | MinimalOrder, options?: EventPublishOptions) => void;
  flushEvents: (nowMs?: number) => number;
  flushAllEvents: () => number;
  getSubscribedTopics: () => ReadonlySet<TopicType>;
}
