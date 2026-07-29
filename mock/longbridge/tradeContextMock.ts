/**
 * 交易上下文 Mock
 *
 * 功能：
 * - 模拟 TradeContext 的下单链路、查询接口、失败注入与事件推送
 */
import {
  Decimal,
  OrderStatus,
  type AccountBalance,
  type Execution,
  type GetHistoryOrdersOptions,
  type GetTodayExecutionsOptions,
  type GetTodayOrdersOptions,
  type Order,
  type OrderDetail,
  type OrderType,
  type OrderSide,
  type PushOrderChanged,
  type ReplaceOrderOptions,
  type StockPositionsResponse,
  type SubmitOrderOptions,
  type SubmitOrderResponse,
  type TopicType,
} from 'longbridge';
import { createLongportEventBus, type EventPublishOptions } from './eventBus.js';
import type {
  MockCallRecord,
  MockFailureRule,
  MockMethodName,
  TradeContextContract,
} from './types.js';
import {
  applyMockFailureRule,
  createFailureState,
  readMockCalls,
  resetMockFailureRules,
  withMockCall,
} from './utils.js';

const TRADE_METHODS: ReadonlySet<MockMethodName> = new Set([
  'submitOrder',
  'cancelOrder',
  'orderDetail',
  'replaceOrder',
  'todayOrders',
  'historyOrders',
  'todayExecutions',
  'accountBalance',
  'stockPositions',
  'tradeSubscribe',
  'tradeUnsubscribe',
]);

type TradeContextMockOptions = {
  readonly now?: () => number;
};

type MinimalOrder = {
  orderId: string;
  status: OrderStatus;
  stockName: string;
  quantity: Decimal;
  // 外部 SDK 可能在终态详情中缺失累计成交数量；mock 必须保留该原始事实。
  executedQuantity: Decimal | null;
  price: Decimal;
  executedPrice: Decimal;
  submittedAt: Date;
  side: OrderSide;
  symbol: string;
  orderType: OrderType;
  updatedAt: Date;
};

/**
 * 将 submitOrder 入参转换为内部最小订单结构。
 *
 * 统一初始状态字段，确保后续改单/撤单流程操作同一数据模型。
 */
function createOrderFromSubmit(
  orderId: string,
  options: SubmitOrderOptions,
  submittedAt: Date,
): MinimalOrder {
  const quantity = options.submittedQuantity;
  const price = options.submittedPrice ?? Decimal.ZERO();

  return {
    orderId,
    status: OrderStatus.New,
    stockName: options.symbol,
    quantity,
    executedQuantity: Decimal.ZERO(),
    price,
    executedPrice: Decimal.ZERO(),
    submittedAt,
    side: options.side,
    symbol: options.symbol,
    orderType: options.orderType,
    updatedAt: submittedAt,
  };
}

/**
 * 深拷贝内部订单对象。
 *
 * 避免 Decimal 与 Date 引用被共享，防止测试间状态串扰。
 */
function cloneOrder(order: MinimalOrder): MinimalOrder {
  return {
    ...order,
    quantity: new Decimal(order.quantity.toString()),
    executedQuantity:
      order.executedQuantity === null ? null : new Decimal(order.executedQuantity.toString()),
    price: new Decimal(order.price.toString()),
    executedPrice: new Decimal(order.executedPrice.toString()),
    submittedAt: new Date(order.submittedAt),
    updatedAt: new Date(order.updatedAt),
  };
}

type DataPropertyDescriptorWithUnknownValue = Omit<PropertyDescriptor, 'value'> & {
  readonly value: unknown;
};

type ExecutionFieldKey = 'orderId' | 'tradeId' | 'symbol' | 'tradeDoneAt' | 'quantity' | 'price';

const EXECUTION_FIELD_KEYS: ReadonlyArray<ExecutionFieldKey> = [
  'orderId',
  'tradeId',
  'symbol',
  'tradeDoneAt',
  'quantity',
  'price',
];

const EXECUTION_FIELD_READERS: Readonly<
  Record<ExecutionFieldKey, (execution: Execution) => unknown>
> = {
  orderId: (execution) => execution.orderId,
  tradeId: (execution) => execution.tradeId,
  symbol: (execution) => execution.symbol,
  tradeDoneAt: (execution) => execution.tradeDoneAt,
  quantity: (execution) => execution.quantity,
  price: (execution) => execution.price,
};

function createCloneObject(source: object): object {
  return Object.create(Reflect.getPrototypeOf(source)) as object;
}

function cloneDescriptor(
  descriptor: PropertyDescriptor,
  seen: Map<object, unknown>,
): PropertyDescriptor {
  if (!('value' in descriptor)) {
    return descriptor;
  }

  const dataDescriptor = descriptor as DataPropertyDescriptorWithUnknownValue;
  return { ...descriptor, value: cloneMutableValue(dataDescriptor.value, seen) };
}

function defineClonedOwnProperties(
  source: object,
  clone: object,
  seen: Map<object, unknown>,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      continue;
    }

    Object.defineProperty(clone, key, cloneDescriptor(descriptor, seen));
  }
}

function getExecutionFieldValue(execution: Execution, key: ExecutionFieldKey): unknown {
  return EXECUTION_FIELD_READERS[key](execution);
}

function defineMissingExecutionField(
  clone: object,
  execution: Execution,
  key: ExecutionFieldKey,
  seen: Map<object, unknown>,
): void {
  if (Object.hasOwn(clone, key)) {
    return;
  }

  Object.defineProperty(clone, key, {
    configurable: true,
    enumerable: true,
    value: cloneMutableValue(getExecutionFieldValue(execution, key), seen),
    writable: true,
  });
}

/**
 * 递归克隆可变值，同时保留原型和访问器描述符。
 *
 * 通过 seen 记录处理循环引用；函数和访问器描述符保留原引用，避免改变 SDK 方法语义。
 */
function cloneMutableValue(
  value: unknown,
  seen: Map<object, unknown> = new Map<object, unknown>(),
): unknown {
  if (!(typeof value === 'object' && value !== null)) {
    return value;
  }

  const source = value;
  if (seen.has(source)) {
    return seen.get(source);
  }

  if (source instanceof Date) {
    const clone = new Date(source);
    seen.set(source, clone);
    return clone;
  }

  if (source instanceof Decimal) {
    const clone = new Decimal(source.toString());
    seen.set(source, clone);
    return clone;
  }

  const clone: object = Array.isArray(source) ? [] : createCloneObject(source);
  seen.set(source, clone);

  defineClonedOwnProperties(source, clone, seen);

  return clone;
}

/**
 * 深拷贝 SDK Execution 的公开与附加可变字段。
 *
 * 保留原型、访问器和未知自有描述符；Date、Decimal 与嵌套数据属性通过
 * 同一递归上下文克隆，避免注入方或读取方修改同一份可变数据。
 */
function cloneExecution(execution: Execution): Execution {
  const seen = new Map<object, unknown>();
  const clone = createCloneObject(execution);
  seen.set(execution, clone);
  defineClonedOwnProperties(execution, clone, seen);

  for (const key of EXECUTION_FIELD_KEYS) {
    defineMissingExecutionField(clone, execution, key, seen);
  }

  // 信任边界：SDK 未暴露 Execution 构造器；已按其公开字段和原型重建实例。
  return clone as Execution;
}

/**
 * 在信任边界将内部订单转为 SDK Order 类型。
 *
 * mock 仅维护测试依赖字段，类型断言用于缩小样板代码。
 */
function asOrder(order: MinimalOrder): Order {
  // 信任边界：mock 按 Order 的核心字段构建，测试用例只依赖这些字段
  return order as unknown as Order;
}

/**
 * 在信任边界将内部订单转为 SDK OrderDetail 类型。
 *
 * mock 仅维护测试依赖字段，类型断言用于缩小样板代码。
 */
function asOrderDetail(order: MinimalOrder): OrderDetail {
  return order as unknown as OrderDetail;
}

/**
 * 将内部订单或外部推送统一转换为 PushOrderChanged 事件。
 *
 * 复用同一推送路径，确保手动 emit 与真实回放行为一致。
 */
function asPushEvent(event: PushOrderChanged | MinimalOrder): PushOrderChanged {
  if ('submittedQuantity' in event) {
    return event;
  }

  const converted = {
    orderId: event.orderId,
    symbol: event.symbol,
    stockName: event.stockName,
    side: event.side,
    orderType: event.orderType,
    submittedQuantity: event.quantity,
    submittedPrice: event.price,
    executedQuantity: event.executedQuantity,
    executedPrice: event.executedPrice,
    status: event.status,
    submittedAt: event.submittedAt,
    updatedAt: event.updatedAt,
    currency: 'HKD',
  };

  return converted as unknown as PushOrderChanged;
}

/**
 * 根据 symbols 白名单过滤持仓响应。
 *
 * 用于 stockPositions 查询分支，避免在调用包装回调中形成深层函数嵌套。
 */
function filterStockPositionsBySymbols(
  stockPositions: StockPositionsResponse,
  symbols: ReadonlyArray<string>,
): StockPositionsResponse {
  const symbolSet = new Set(symbols);
  const channels = stockPositions.channels.map((channel) => {
    const filteredPositions = channel.positions.filter((position) =>
      symbolSet.has(position.symbol),
    );
    const channelObject = channel as object;
    const channelPrototype = Object.getPrototypeOf(channelObject) as object | null;
    const channelClone = Object.create(channelPrototype ?? Object.prototype) as object;
    return Object.assign(channelClone, channelObject, {
      positions: filteredPositions,
    }) as StockPositionsResponse['channels'][number];
  });
  return { channels } as StockPositionsResponse;
}

interface TradeContextMock extends TradeContextContract {
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

/**
 * 创建 TradeContext 的测试替身。
 *
 * 用于在不依赖真实交易网关的情况下，模拟下单、改单、撤单、查询与推送链路，
 * 并支持失败注入以验证重试与容错逻辑。
 */
export function createTradeContextMock(options: TradeContextMockOptions = {}): TradeContextMock {
  const now = options.now ?? (() => Date.now());
  const bus = createLongportEventBus(now);

  const failureState = createFailureState();
  const callRecords: MockCallRecord[] = [];

  let todayOrdersStore: MinimalOrder[] = [];
  let historyOrdersStore: MinimalOrder[] = [];
  let todayExecutionsStore: ReadonlyArray<Execution> = [];
  let balancesStore: ReadonlyArray<AccountBalance> = [];
  let stockPositionsStore: StockPositionsResponse = {
    channels: [],
  } as unknown as StockPositionsResponse;

  const subscribedTopics = new Set<TopicType>();
  let orderChangedDisposer: (() => void) | null = null;
  let orderCounter = 1;

  /**
   * 统一封装调用计数、失败注入与调用记录。
   *
   * 所有对外能力均经此路径，确保失败注入与调用日志语义一致，避免各方法行为漂移。
   */
  async function withCall<T>(
    method: MockMethodName,
    args: ReadonlyArray<unknown>,
    action: () => Promise<T> | T,
  ): Promise<T> {
    return withMockCall({
      state: failureState,
      callRecords,
      method,
      args,
      action,
    });
  }

  function submitOrder(optionsValue: SubmitOrderOptions): Promise<SubmitOrderResponse> {
    return withCall('submitOrder', [optionsValue], () => {
      const orderId = `MOCK-${String(orderCounter).padStart(6, '0')}`;
      orderCounter += 1;
      const createdAt = new Date(now());
      const order = createOrderFromSubmit(orderId, optionsValue, createdAt);
      todayOrdersStore.push(order);
      return { orderId } as unknown as SubmitOrderResponse;
    });
  }

  function cancelOrder(orderId: string): Promise<void> {
    return withCall('cancelOrder', [orderId], () => {
      todayOrdersStore = todayOrdersStore.map((order) => {
        if (order.orderId !== orderId) {
          return order;
        }

        return {
          ...order,
          status: OrderStatus.Canceled,
          updatedAt: new Date(now()),
        };
      });
    });
  }

  function orderDetail(orderId: string): Promise<OrderDetail> {
    return withCall('orderDetail', [orderId], () => {
      const todayOrder = todayOrdersStore.find((order) => order.orderId === orderId);
      if (todayOrder) {
        return asOrderDetail(cloneOrder(todayOrder));
      }

      const historyOrder = historyOrdersStore.find((order) => order.orderId === orderId);
      if (historyOrder) {
        return asOrderDetail(cloneOrder(historyOrder));
      }

      throw new Error(`openapi error: code=603001: Order not found, orderId=${orderId}`);
    });
  }

  function replaceOrder(optionsValue: ReplaceOrderOptions): Promise<void> {
    return withCall('replaceOrder', [optionsValue], () => {
      todayOrdersStore = todayOrdersStore.map((order) => {
        if (order.orderId !== optionsValue.orderId) {
          return order;
        }

        const nextQuantity = optionsValue.quantity;
        const nextPrice = optionsValue.price ?? order.price;

        return {
          ...order,
          quantity: nextQuantity,
          price: nextPrice,
          status: OrderStatus.New,
          updatedAt: new Date(now()),
        };
      });
    });
  }

  function todayOrders(_options?: GetTodayOrdersOptions): Promise<ReadonlyArray<Order>> {
    return withCall('todayOrders', [_options], () =>
      todayOrdersStore.map((order) => asOrder(cloneOrder(order))),
    );
  }

  function historyOrders(_options?: GetHistoryOrdersOptions): Promise<ReadonlyArray<Order>> {
    return withCall('historyOrders', [_options], () =>
      historyOrdersStore.map((order) => asOrder(cloneOrder(order))),
    );
  }

  function todayExecutions(
    _options?: GetTodayExecutionsOptions,
  ): Promise<ReadonlyArray<Execution>> {
    return withCall('todayExecutions', [_options], () =>
      todayExecutionsStore.map((execution) => cloneExecution(execution)),
    );
  }

  function accountBalance(currency?: string): Promise<ReadonlyArray<AccountBalance>> {
    return withCall('accountBalance', [currency], () => {
      if (!currency) {
        return [...balancesStore];
      }

      return balancesStore.filter((balance) => balance.currency === currency);
    });
  }

  function stockPositions(symbols?: ReadonlyArray<string>): Promise<StockPositionsResponse> {
    return withCall('stockPositions', [symbols], () => {
      if (!symbols || symbols.length === 0) {
        return stockPositionsStore;
      }

      return filterStockPositionsBySymbols(stockPositionsStore, symbols);
    });
  }

  function setOnOrderChanged(callback: (err: Error | null, event: PushOrderChanged) => void): void {
    orderChangedDisposer?.();
    orderChangedDisposer = bus.subscribe('orderChanged', (payload) => {
      callback(null, payload);
    });
  }

  function subscribe(topics: ReadonlyArray<TopicType>): Promise<void> {
    return withCall('tradeSubscribe', [topics], () => {
      for (const topic of topics) {
        subscribedTopics.add(topic);
      }
    });
  }

  function unsubscribe(topics: ReadonlyArray<TopicType>): Promise<void> {
    return withCall('tradeUnsubscribe', [topics], () => {
      for (const topic of topics) {
        subscribedTopics.delete(topic);
      }
    });
  }

  function setFailureRule(method: MockMethodName, rule: MockFailureRule | null): void {
    applyMockFailureRule({
      state: failureState,
      supportedMethods: TRADE_METHODS,
      method,
      rule,
    });
  }

  function clearFailureRules(): void {
    resetMockFailureRules(failureState);
  }

  function getCalls(method?: MockMethodName): ReadonlyArray<MockCallRecord> {
    return readMockCalls(callRecords, method);
  }

  function seedTodayOrders(orders: ReadonlyArray<Order>): void {
    todayOrdersStore = orders.map((order) => {
      const typed = order as unknown as MinimalOrder;
      return cloneOrder(typed);
    });
  }

  function seedHistoryOrders(orders: ReadonlyArray<Order>): void {
    historyOrdersStore = orders.map((order) => {
      const typed = order as unknown as MinimalOrder;
      return cloneOrder(typed);
    });
  }

  function seedTodayExecutions(executions: ReadonlyArray<Execution>): void {
    todayExecutionsStore = executions.map((execution) => cloneExecution(execution));
  }

  function seedAccountBalances(balances: ReadonlyArray<AccountBalance>): void {
    balancesStore = [...balances];
  }

  function seedStockPositions(response: StockPositionsResponse): void {
    stockPositionsStore = response;
  }

  function emitOrderChanged(
    event: PushOrderChanged | MinimalOrder,
    publishOptions: EventPublishOptions = {},
  ): void {
    bus.publish('orderChanged', asPushEvent(event), publishOptions);
  }

  function flushEvents(nowMs?: number): number {
    return bus.flushDue(nowMs);
  }

  function flushAllEvents(): number {
    return bus.flushAll();
  }

  function getSubscribedTopics(): ReadonlySet<TopicType> {
    return new Set(subscribedTopics);
  }

  return {
    submitOrder,
    cancelOrder,
    orderDetail,
    replaceOrder,
    todayOrders,
    historyOrders,
    todayExecutions,
    accountBalance,
    stockPositions,
    setOnOrderChanged,
    subscribe,
    unsubscribe,
    setFailureRule,
    clearFailureRules,
    getCalls,
    seedTodayOrders,
    seedHistoryOrders,
    seedTodayExecutions,
    seedAccountBalances,
    seedStockPositions,
    emitOrderChanged,
    flushEvents,
    flushAllEvents,
    getSubscribedTopics,
  };
}
