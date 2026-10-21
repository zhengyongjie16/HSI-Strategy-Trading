/**
 * 离线SDK入站producer：真实Decimal，完整静态SDK Order/Push DTO契约。
 * 不构造TradeContext或不可公开构造的NAPI Order/Push实例；无双重assert、网络或第二订单模型。
 * 业务测试仅接收实际mapper产出的订单事实和neutral broker ports。
 */
import type { BrokerAccess } from '../../../../src/types/brokerAccessPorts.js';
import { createBrokerAccessAdapter } from '../../../../src/infrastructure/longbridge/trade/brokerAccessAdapter.js';
import {
  Decimal,
  OrderSide,
  OrderStatus,
  OrderType,
  OrderTag,
  TimeInForceType,
  CommissionFreeStatus,
  DeductionStatus,
  type OrderDetail,
  type PushOrderChanged,
  type TradeContext,
  TopicType,
  type StockPositionsResponse,
  type AccountBalance,
  Market,
} from 'longbridge';
import {
  mapBrokerOrder,
  mapBrokerOrderPush,
} from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';
import {
  isValidatedOrderSide,
  isValidatedOrderStatus,
  isValidatedOrderType,
} from '../../../../src/infrastructure/longbridge/trade/orderValidation.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { isRecord } from '../../../../src/utils/helpers/index.js';
import { canonicalDecimal, safeQuantityNumber } from '../../../../src/utils/numeric/exact.js';

/** frozen V1的金融文本保持原文；只检查字段结构，不建立新domain schema。 */
function frozenV1Text(value: Record<string, unknown>, key: string, allowEmpty = false): string {
  const text = value[key];
  if (typeof text !== 'string' || (!allowEmpty && text.length === 0))
    throw new TypeError('[BrokerIngressFixture] frozen V1 invalid field: ' + key);

  return text;
}

/** 原JSON日期仅生成SDK Date，不从revision推执行T。 */
function frozenV1Date(value: Record<string, unknown>, key: string): Date {
  const text = frozenV1Text(value, key);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0)
    throw new TypeError('[BrokerIngressFixture] frozen V1 invalid date: ' + key);

  return date;
}

/** SDK订阅参数只在私有边界解码，不向caller泄漏enum。 */
function neutralSubscriptionTopic(value: unknown): 'PRIVATE' {
  if (value !== TopicType.Private)
    throw new TypeError('[BrokerIngressFixture] unsupported subscription topic');

  return 'PRIVATE';
}

/**
 * 创建实际SDK金融字段，经真实query/push mapper得到中性事实。
 * @param input 本case明确指定的原始SDK字段文本和时间，字段不承担经济oracle
 * @returns 仅业务事实、neutral port及读取次数，原生DTO不出基础设施测试边界
 */
export type BrokerIngressInput = Readonly<{
  orderId: string;
  symbol: string;
  stockName: string;
  remark: string;
  side: 'BUY' | 'SELL';

  /** 未指定时保持现有 LO frame；ELO/MO 仅在私有 SDK producer 映射。 */
  orderType?: 'ELO' | 'LO' | 'MO' | 'SLO';
  status:
    | 'New'
    | 'NotReported'
    | 'ReplacedNotReported'
    | 'ProtectedNotReported'
    | 'VarietiesNotReported'
    | 'Filled'
    | 'PartialFilled'
    | 'Canceled'
    | 'Expired'
    | 'Rejected'
    | 'WaitToCancel'
    | 'PendingCancel'
    | 'WaitToReplace'
    | 'PendingReplace'
    | 'Replaced'
    | 'PartialWithdrawal';
  quantity: string;
  executedQuantity: string;
  submittedPrice: string;
  executedPrice: string;
  submittedAtMs: number;
  updatedAtMs: number;
}>;

/** 只读实际native entry参数观察，SDK枚举/Decimal不出fixture边。 */
export type NativeSubmitObservation = Readonly<{
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'ELO' | 'LO' | 'MO';
  quantity: string;
  price: string | null;
  remark: string | undefined;
  timeInForce: 'DAY';
}>;

/** fixture 的 push 样本固定为HK：非HK或坏结构显式失败，不静默产出 null。 */
function requirePushObservation(push: PushOrderChanged): OrderFact {
  const observation = mapBrokerOrderPush(push);
  if (observation === null)
    throw new TypeError('[BrokerIngressFixture] push sample must be HK order');

  return observation;
}

export async function createBrokerIngressFixture(
  input: BrokerIngressInput,
): Promise<
  Readonly<{
    queryObservation: OrderFact;
    pushObservation: OrderFact;
    setOrderDetailReplies: (frames: ReadonlyArray<BrokerIngressInput>) => void;
    setOrderSnapshotReplies: (
      history: ReadonlyArray<BrokerIngressInput>,
      today: ReadonlyArray<BrokerIngressInput>,
    ) => void;
    orderSnapshotReadCounts: () => Readonly<{ history: number; today: number }>;
    setOrderSnapshotRepliesFromFrozenV1: (orders: unknown) => void;
    setOrderSnapshotNonArray: (source: 'history' | 'today') => void;
    setOrderSnapshotOrderIdMissing: (source: 'history' | 'today') => void;
    setOrderSnapshotSymbolEmpty: (source: 'history' | 'today') => void;
    setOrderSnapshotSideInvalid: (source: 'history' | 'today') => void;
    setOrderSnapshotQuantitiesMissing: (source: 'history' | 'today') => void;
    setOrderSnapshotOrderTypeUnknown: (source: 'history' | 'today') => void;
    setOrderSnapshotUpdatedAtInvalid: (source: 'history' | 'today') => void;
    setOrderSnapshotSubmittedPriceNull: (orderId: string) => void;
    setOrderSnapshotPriceMalformed: (orderId: string) => void;
    setPendingOrderMetadataInvalid: (
      orderId: string,
      field: 'side' | 'status' | 'orderType',
      kind: 'UNKNOWN' | 'NON_MEMBER' | 'MISSING',
    ) => void;
    setOrderSnapshotUpdatedAtAbsent: (
      source: 'history' | 'today',
      mode: 'NULL' | 'OMITTED',
    ) => void;
    setStockPositions: (
      positions: ReadonlyArray<
        Readonly<{
          symbol: string;
          symbolName: string;
          accountChannel: string;
          currency: string;
          quantity: string;
          availableQuantity: string;
          costPrice: string;
        }>
      >,
    ) => void;
    setStockPositionsFailure: (error: Error | null) => void;
    setAccountBalanceEmpty: () => void;
    setAccountBalanceFailure: (error: Error | null) => void;
    setContextCreationFailure: (error: Error | null) => void;
    setSubscribeBehavior: (hook: (topics: ReadonlyArray<'PRIVATE'>) => Promise<void>) => void;
    subscribeReadCount: () => number;
    subscribeObservations: () => ReadonlyArray<ReadonlyArray<'PRIVATE'>>;
    setUnsubscribeBehavior: (hook: (topics: ReadonlyArray<'PRIVATE'>) => Promise<void>) => void;
    unsubscribeReadCount: () => number;
    unsubscribeObservations: () => ReadonlyArray<ReadonlyArray<'PRIVATE'>>;
    subscriptionMembership: () => ReadonlyArray<'PRIVATE'>;
    contextCreationCount: () => number;
    positionReadSymbols: () => ReadonlyArray<ReadonlyArray<string> | null | undefined>;
    brokerAccess: () => BrokerAccess;
    ports: BrokerAccess;
    accountReadCounts: () => Readonly<{ positions: number; balance: number }>;
    setAccountBalance: (
      input: Readonly<{
        currency: string;
        totalCash: string;
        netAssets: string;
        availableCash: string;
      }>,
    ) => void;

    /** 只能发给真实Monitor已注册的SDK callback，不接收业务neutral event冒充payload。 */
    emitOrderChanged: () => void;
    emitOrderChangedFrame: (
      frame: Omit<BrokerIngressInput, 'executedPrice'> & Readonly<{ executedPrice: string | null }>,
    ) => void;
    setPushExecutedPriceMissing: () => void;
    setPushExecutedPriceText: (exact: string) => void;
    setPushExecutedQuantityMissing: () => void;
    setPushExecutedQuantityText: (exact: string) => void;
    setPushSideUnknown: () => void;
    setPushUpdatedAtMs: (value: number) => void;
    setPushExecutedQuantityGetterFailure: (error: Error) => void;
    failReplace: (error: Error) => void;
    setCancelFailure: (error: Error) => void;
    setCancelBeforeReply: (hook: () => Promise<void>) => void;
    setQueryUpdatedAtMs: (value: number) => void;
    setQueryUpdatedAt: (value: unknown) => void;
    setOrderDetailBeforeReply: (hook: (orderId: string) => Promise<void>) => void;

    /** 合法SDK Unknown enum，仅在lazy native detail读取阶段进入mapper并拒绝。 */
    setQuerySideUnknown: () => void;
    setQueryGetterFailure: (error: Error) => void;
    setQueryQuantityMissing: () => void;
    setQueryExecutedQuantityMissing: () => void;
    nativeReadCounts: () => Readonly<{ cancel: number; detail: number }>;
    nativeCancelOrderIds: () => ReadonlyArray<string>;

    /** 原生entry记issued后才调用hook；DTO留本模块，hook可defer/reject/返回真实ACK identity。 */
    setSubmitBehavior: (
      hook: (
        payload: Readonly<{
          symbol: string;
          quantity: string;
          price: string | null;
          market: boolean;
          day: boolean;
        }>,
      ) => Promise<string>,
    ) => void;
    setReplaceBeforeReply: (hook: () => Promise<void>) => void;
    nativeSubmitObservations: () => ReadonlyArray<NativeSubmitObservation>;
    nativeMutations: () => ReadonlyArray<
      Readonly<{
        kind: 'SUBMIT' | 'REPLACE';
        orderId: string | null;
        symbol: string | null;
        price: string | null;
        quantity: string;
        market: boolean;
        day: boolean;
      }>
    >;
  }>
> {
  const order: BrokerOrderSdkFields = {
    orderId: input.orderId,
    symbol: input.symbol,
    stockName: input.stockName,
    remark: input.remark,
    side: input.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell,
    status: {
      New: OrderStatus.New,
      NotReported: OrderStatus.NotReported,
      ReplacedNotReported: OrderStatus.ReplacedNotReported,
      ProtectedNotReported: OrderStatus.ProtectedNotReported,
      VarietiesNotReported: OrderStatus.VarietiesNotReported,
      Filled: OrderStatus.Filled,
      PartialFilled: OrderStatus.PartialFilled,
      Canceled: OrderStatus.Canceled,
      Expired: OrderStatus.Expired,
      Rejected: OrderStatus.Rejected,
      WaitToCancel: OrderStatus.WaitToCancel,
      PendingCancel: OrderStatus.PendingCancel,
      WaitToReplace: OrderStatus.WaitToReplace,
      PendingReplace: OrderStatus.PendingReplace,
      Replaced: OrderStatus.Replaced,
      PartialWithdrawal: OrderStatus.PartialWithdrawal,
    }[input.status],
    orderType: { ELO: OrderType.ELO, LO: OrderType.LO, MO: OrderType.MO, SLO: OrderType.SLO }[
      input.orderType ?? 'LO'
    ],
    quantity: new Decimal(input.quantity),
    executedQuantity: new Decimal(input.executedQuantity),
    price: new Decimal(input.submittedPrice),
    executedPrice: new Decimal(input.executedPrice),
    submittedAt: new Date(input.submittedAtMs),
    updatedAt: new Date(input.updatedAtMs),
  };
  let pushPriceMissing = false;
  let pushPriceText: string | null = null;
  let pushQuantityText: string | null = null;
  let pushSide = order.side;
  let pushUpdatedAtMs = input.updatedAtMs;
  let pushQuantityGetterFailure: Error | null = null;
  const push: PushOrderChanged = {
    orderId: order.orderId,
    symbol: order.symbol,
    stockName: order.stockName,
    remark: order.remark,
    get side() {
      return pushSide;
    },
    status: order.status,
    orderType: order.orderType,
    submittedQuantity: order.quantity,
    submittedPrice: new Decimal(input.submittedPrice),
    get executedQuantity() {
      if (pushQuantityGetterFailure !== null) throw pushQuantityGetterFailure;

      return pushQuantityText === null ? order.executedQuantity : new Decimal(pushQuantityText);
    },
    get executedPrice() {
      if (pushPriceMissing) return null;

      return pushPriceText === null ? order.executedPrice : new Decimal(pushPriceText);
    },
    submittedAt: order.submittedAt,
    get updatedAt() {
      return new Date(pushUpdatedAtMs);
    },
    currency: 'HKD',
    tag: OrderTag.Normal,
    accountNo: 'OFFLINE-FIXTURE',
    msg: '',
    triggerPrice: null,
    triggerStatus: null,
    triggerAt: null,
    trailingAmount: null,
    trailingPercent: null,
    limitOffset: null,
    lastShare: null,
    lastPrice: null,
    toString: () => input.orderId,
    toJSON: () => ({ orderId: input.orderId }),
  };
  let orderChangedHandler: ((error: Error | null, event: PushOrderChanged) => void) | undefined;
  const unexpected = (): never => {
    throw new Error('[BrokerIngressFixture] unconfigured native SDK method invoked');
  };
  let cancelFailure: Error | null = null;
  let cancelBeforeReply: (() => Promise<void>) | null = null;
  let cancelReadCount = 0;
  const cancelOrderIds: string[] = [];
  let detailReadCount = 0;
  let queryUpdatedAtMs = input.updatedAtMs;
  let queryRawUpdatedAtConfigured = false;
  let queryRawUpdatedAt: unknown;
  let orderDetailBeforeReply: ((orderId: string) => Promise<void>) | null = null;
  let querySideUnknown = false;
  let queryGetterFailure: Error | null = null;
  let replaceFailure: Error | null = null;
  let submitBehavior:
    | ((
        payload: Readonly<{
          symbol: string;
          quantity: string;
          price: string | null;
          market: boolean;
          day: boolean;
        }>,
      ) => Promise<string>)
    | undefined;
  let replaceBeforeReply: (() => Promise<void>) | undefined;
  const nativeSubmissions: NativeSubmitObservation[] = [];
  const nativeMutations: Array<{
    kind: 'SUBMIT' | 'REPLACE';
    orderId: string | null;
    symbol: string | null;
    price: string | null;
    quantity: string;
    market: boolean;
    day: boolean;
  }> = [];
  const detailFields = {
    ...order,
    lastDone: null,
    triggerPrice: null,
    msg: '',
    tag: OrderTag.Normal,
    timeInForce: TimeInForceType.Day,
    expireDate: null,
    triggerAt: null,
    trailingAmount: null,
    trailingPercent: null,
    limitOffset: null,
    triggerStatus: null,
    currency: 'HKD',
    outsideRth: null,
    limitDepthLevel: null,
    triggerCount: null,
    monitorPrice: null,
    freeStatus: CommissionFreeStatus.None,
    freeAmount: null,
    freeCurrency: null,
    deductionsStatus: DeductionStatus.None,
    deductionsAmount: null,
    deductionsCurrency: null,
    platformDeductedStatus: DeductionStatus.None,
    platformDeductedAmount: null,
    platformDeductedCurrency: null,
    history: [],
    chargeDetail: null,
    attachedOrders: [],
    toString: () => input.orderId,
    toJSON: () => ({ orderId: input.orderId }),
  };
  const detail: OrderDetail = {
    ...detailFields,
    get updatedAt() {
      return new Date(queryUpdatedAtMs);
    },
    get side() {
      if (queryGetterFailure !== null) throw queryGetterFailure;

      return querySideUnknown ? OrderSide.Unknown : order.side;
    },
  };
  let queryQuantityMissing = false;
  let queryExecutedQuantityMissing = false;
  let positionsReply: StockPositionsResponse | null = null;
  let accountReply: AccountBalance | null = null;
  let accountBalanceEmpty = false;
  let accountBalanceFailure: Error | null = null;
  let contextCreationFailure: Error | null = null;
  let contextCreations = 0;
  let subscribeCount = 0;
  let subscribeBehavior: ((topics: ReadonlyArray<'PRIVATE'>) => Promise<void>) | null = null;
  const subscribeTopics: Array<ReadonlyArray<'PRIVATE'>> = [];
  let unsubscribeCount = 0;
  let unsubscribeBehavior: ((topics: ReadonlyArray<'PRIVATE'>) => Promise<void>) | null = null;
  const unsubscribeTopics: Array<ReadonlyArray<'PRIVATE'>> = [];
  const subscriptionTopics = new Set<'PRIVATE'>();
  const positionsSymbols: Array<ReadonlyArray<string> | null | undefined> = [];
  let positionsFailure: Error | null = null;
  let positionsReadCount = 0;
  let balanceReadCount = 0;
  const detailReplies = new Map<string, OrderDetail[]>();
  let detailRepliesConfigured = false;
  const createDetailFrame = (frame: BrokerIngressInput): OrderDetail => ({
    ...detailFields,
    orderId: frame.orderId,
    symbol: frame.symbol,
    stockName: frame.stockName,
    remark: frame.remark,
    side: frame.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell,
    status: {
      New: OrderStatus.New,
      NotReported: OrderStatus.NotReported,
      ReplacedNotReported: OrderStatus.ReplacedNotReported,
      ProtectedNotReported: OrderStatus.ProtectedNotReported,
      VarietiesNotReported: OrderStatus.VarietiesNotReported,
      Filled: OrderStatus.Filled,
      PartialFilled: OrderStatus.PartialFilled,
      Canceled: OrderStatus.Canceled,
      Expired: OrderStatus.Expired,
      Rejected: OrderStatus.Rejected,
      WaitToCancel: OrderStatus.WaitToCancel,
      PendingCancel: OrderStatus.PendingCancel,
      WaitToReplace: OrderStatus.WaitToReplace,
      PendingReplace: OrderStatus.PendingReplace,
      Replaced: OrderStatus.Replaced,
      PartialWithdrawal: OrderStatus.PartialWithdrawal,
    }[frame.status],
    orderType: { ELO: OrderType.ELO, LO: OrderType.LO, MO: OrderType.MO, SLO: OrderType.SLO }[
      frame.orderType ?? 'LO'
    ],
    quantity: new Decimal(frame.quantity),
    executedQuantity: new Decimal(frame.executedQuantity),
    price: new Decimal(frame.submittedPrice),
    executedPrice: new Decimal(frame.executedPrice),
    submittedAt: new Date(frame.submittedAtMs),
    updatedAt: new Date(frame.updatedAtMs),
  });
  let frozenV1Configured = false;
  let frozenV1Orders: unknown;
  const parseFrozenV1Orders = (): OrderDetail[] => {
    if (!Array.isArray(frozenV1Orders))
      throw new TypeError('[BrokerIngressFixture] frozen V1 orders must be an array');

    const orders: ReadonlyArray<unknown> = frozenV1Orders;
    return orders.map((value) => {
      if (!isRecord(value))
        throw new TypeError('[BrokerIngressFixture] frozen V1 order must be an object');

      const orderId = frozenV1Text(value, 'orderId');
      const symbol = frozenV1Text(value, 'symbol');
      const stockName = frozenV1Text(value, 'stockName');
      const remark = frozenV1Text(value, 'remark', true);
      const side = value['side'];
      const status = value['status'];
      const orderType = value['orderType'];
      if (
        !isValidatedOrderSide(side) ||
        !isValidatedOrderStatus(status) ||
        !isValidatedOrderType(orderType)
      )
        throw new TypeError('[BrokerIngressFixture] frozen V1 invalid SDK metadata');

      const quantity = frozenV1Text(value, 'quantity');
      const executedQuantity = frozenV1Text(value, 'executedQuantity');
      safeQuantityNumber(quantity);
      safeQuantityNumber(executedQuantity);
      const price = frozenV1Text(value, 'price');
      const executedPrice = frozenV1Text(value, 'executedPrice');
      canonicalDecimal(price);
      canonicalDecimal(executedPrice);
      const submittedAt = frozenV1Date(value, 'submittedAt');
      const updatedAt = frozenV1Date(value, 'updatedAt');
      return {
        ...detailFields,
        orderId,
        symbol,
        stockName,
        remark,
        side,
        status,
        orderType,
        price: new Decimal(price),
        quantity: new Decimal(quantity),
        executedPrice: new Decimal(executedPrice),
        executedQuantity: new Decimal(executedQuantity),
        submittedAt,
        updatedAt,
      };
    });
  };
  let historyOrderReplies: OrderDetail[] | null = null;
  let todayOrderReplies: OrderDetail[] | null = null;
  const snapshotNullPriceOrderIds = new Set<string>();
  const snapshotMalformedPriceOrderIds = new Set<string>();
  const pendingInvalidMetadata = new Map<
    string,
    Readonly<{ field: 'side' | 'status' | 'orderType'; kind: 'UNKNOWN' | 'NON_MEMBER' | 'MISSING' }>
  >();
  const snapshotMissingId = new Set<'history' | 'today'>();
  const snapshotEmptySymbol = new Set<'history' | 'today'>();
  const snapshotInvalidSide = new Set<'history' | 'today'>();
  const snapshotMissingQuantities = new Set<'history' | 'today'>();
  const snapshotUnknownType = new Set<'history' | 'today'>();
  const snapshotInvalidUpdatedAt = new Set<'history' | 'today'>();
  const snapshotAbsentUpdatedAt = new Map<'history' | 'today', 'NULL' | 'OMITTED'>();
  // 仅实际native响应阶段改变指定字段；SDK DTO和非法primitive留在私有边界。
  const applySnapshotControls = (
    source: 'history' | 'today',
    replies: OrderDetail[],
  ): OrderDetail[] => {
    for (const reply of replies) {
      if (snapshotNullPriceOrderIds.has(reply.orderId)) Reflect.set(reply, 'price', null);

      if (snapshotMalformedPriceOrderIds.has(reply.orderId)) Reflect.set(reply, 'price', {});

      const metadata = pendingInvalidMetadata.get(reply.orderId);
      if (metadata !== undefined) {
        if (metadata.kind === 'MISSING') Reflect.deleteProperty(reply, metadata.field);
        else {
          const unknownValue = {
            side: OrderSide.Unknown,
            status: OrderStatus.Unknown,
            orderType: OrderType.Unknown,
          }[metadata.field];
          Reflect.set(reply, metadata.field, metadata.kind === 'UNKNOWN' ? unknownValue : 999);
        }
      }

      if (snapshotMissingId.has(source)) Reflect.set(reply, 'orderId', undefined);

      if (snapshotEmptySymbol.has(source)) Reflect.set(reply, 'symbol', '');

      if (snapshotInvalidSide.has(source)) Reflect.set(reply, 'side', 999);

      if (snapshotMissingQuantities.has(source)) {
        Reflect.deleteProperty(reply, 'quantity');
        Reflect.deleteProperty(reply, 'executedQuantity');
      }

      if (snapshotUnknownType.has(source)) Reflect.set(reply, 'orderType', OrderType.Unknown);

      if (snapshotInvalidUpdatedAt.has(source)) Reflect.set(reply, 'updatedAt', 'not-a-date');

      const absence = snapshotAbsentUpdatedAt.get(source);
      if (absence === 'NULL') Reflect.set(reply, 'updatedAt', null);
      else if (absence === 'OMITTED') Reflect.deleteProperty(reply, 'updatedAt');
    }

    return replies;
  };
  let historyOrderReads = 0;
  let todayOrderReads = 0;
  // 故意不提供 execution 读取能力：任何残余 ledger 调用都会在 fixture 边界失败。
  const context: Omit<TradeContext, 'todayExecutions' | 'historyExecutions'> = {
    setOnOrderChanged: (handler) => {
      orderChangedHandler = handler;
    },
    subscribe: async (topics) => {
      subscribeCount++;
      const neutralTopics = topics.map(neutralSubscriptionTopic);
      subscribeTopics.push(neutralTopics);
      if (subscribeBehavior !== null) await subscribeBehavior(neutralTopics);

      for (const topic of neutralTopics) subscriptionTopics.add(topic);
    },
    unsubscribe: async (topics) => {
      unsubscribeCount++;
      const neutralTopics = topics.map(neutralSubscriptionTopic);
      unsubscribeTopics.push(neutralTopics);
      if (unsubscribeBehavior !== null) await unsubscribeBehavior(neutralTopics);

      for (const topic of neutralTopics) subscriptionTopics.delete(topic);
    },
    historyOrders: async () => {
      historyOrderReads += 1;
      if (historyOrderReplies === null) return unexpected();

      return applySnapshotControls('history', historyOrderReplies);
    },
    todayOrders: async () => {
      todayOrderReads += 1;
      if (frozenV1Configured) return parseFrozenV1Orders();

      if (todayOrderReplies === null) return unexpected();

      return applySnapshotControls('today', todayOrderReplies);
    },
    async replaceOrder(options) {
      if (this !== context)
        throw new Error('[BrokerIngressFixture] native replace receiver changed');

      nativeMutations.push({
        kind: 'REPLACE',
        orderId: options.orderId,
        symbol: null,
        price: options.price?.toString() ?? null,
        quantity: options.quantity.toString(),
        market: false,
        day: false,
      });

      await replaceBeforeReply?.();
      if (replaceFailure !== null) throw replaceFailure;
    },
    async submitOrder(options) {
      if (this !== context)
        throw new Error('[BrokerIngressFixture] native submit receiver changed');

      const isDay = options.timeInForce === TimeInForceType.Day;
      nativeMutations.push({
        kind: 'SUBMIT',
        orderId: null,
        symbol: options.symbol,
        price: options.submittedPrice?.toString() ?? null,
        quantity: options.submittedQuantity.toString(),
        market: options.orderType === OrderType.MO,
        day: options.timeInForce === TimeInForceType.Day,
      });
      const side = new Map<number, NativeSubmitObservation['side']>([
        [OrderSide.Buy, 'BUY'],
        [OrderSide.Sell, 'SELL'],
      ]).get(options.side);
      const orderType = new Map<number, NativeSubmitObservation['orderType']>([
        [OrderType.ELO, 'ELO'],
        [OrderType.LO, 'LO'],
        [OrderType.MO, 'MO'],
      ]).get(options.orderType);
      if (
        side === undefined ||
        orderType === undefined ||
        options.timeInForce !== TimeInForceType.Day
      )
        throw new TypeError('[BrokerIngressFixture] unsupported native submit observation');

      nativeSubmissions.push(
        Object.freeze({
          symbol: options.symbol,
          side,
          orderType,
          quantity: options.submittedQuantity.toString(),
          price: options.submittedPrice?.toString() ?? null,
          remark: options.remark,
          timeInForce: 'DAY',
        }),
      );
      const orderId =
        submitBehavior === undefined
          ? 'FOLLOW-UP'
          : await submitBehavior({
              symbol: options.symbol,
              quantity: options.submittedQuantity.toString(),
              price: options.submittedPrice?.toString() ?? null,
              market: options.orderType === OrderType.MO,
              day: isDay,
            });
      return { orderId, toString: () => orderId, toJSON: () => ({ orderId }) };
    },
    cancelOrder: async (orderId) => {
      cancelReadCount++;
      cancelOrderIds.push(orderId);
      if (cancelBeforeReply !== null) await cancelBeforeReply();

      const failure = cancelFailure;
      if (failure !== null) throw failure;

      if (cancelBeforeReply === null) unexpected();
    },
    accountBalance: async () => {
      balanceReadCount++;
      if (accountBalanceFailure !== null) throw accountBalanceFailure;

      if (accountBalanceEmpty) return [];

      if (accountReply === null) return unexpected();

      return [accountReply];
    },
    cashFlow: unexpected,
    fundPositions: unexpected,
    stockPositions: async (symbols) => {
      positionsReadCount++;
      positionsSymbols.push(symbols === null || symbols === undefined ? symbols : [...symbols]);
      if (positionsFailure !== null) throw positionsFailure;

      if (positionsReply === null) return unexpected();

      if (symbols === undefined || symbols === null) return positionsReply;

      return {
        toString: () => 'offline positions',
        toJSON: () => ({}),
        channels: positionsReply.channels.map((channel) => ({
          accountChannel: channel.accountChannel,
          toString: () => channel.accountChannel,
          toJSON: () => ({}),
          positions: channel.positions.filter((position) => symbols.includes(position.symbol)),
        })),
      };
    },
    marginRatio: unexpected,
    orderDetail: async (orderId) => {
      detailReadCount++;
      if (orderDetailBeforeReply !== null) await orderDetailBeforeReply(orderId);

      const applyQueryControls = (reply: OrderDetail): OrderDetail => {
        if (queryRawUpdatedAtConfigured) {
          Object.defineProperty(reply, 'updatedAt', {
            configurable: true,
            get: () => queryRawUpdatedAt,
          });
        }

        if (querySideUnknown || queryGetterFailure !== null) {
          const originalSide = reply === detail ? order.side : reply.side;
          Object.defineProperty(reply, 'side', {
            configurable: true,
            get: () => {
              if (queryGetterFailure !== null) throw queryGetterFailure;

              return querySideUnknown ? OrderSide.Unknown : originalSide;
            },
          });
        }

        if (queryQuantityMissing) Reflect.set(reply, 'quantity', null);

        if (queryExecutedQuantityMissing) Reflect.set(reply, 'executedQuantity', null);

        return reply;
      };
      const replies = detailReplies.get(orderId);
      if (replies !== undefined) {
        const reply = replies.shift();
        if (reply === undefined) return unexpected();

        return applyQueryControls(reply);
      }

      if (detailRepliesConfigured || orderId !== input.orderId) return unexpected();

      return applyQueryControls(detail);
    },
    usQueryOrders: unexpected,
    usOrderDetail: unexpected,
    usAssetOverview: unexpected,
    usRealizedPl: unexpected,
    orderDetailAttached: unexpected,
    estimateMaxPurchaseQuantity: unexpected,
  };
  return {
    setOrderSnapshotReplies: (history, today) => {
      frozenV1Configured = false;
      historyOrderReplies = history.map(createDetailFrame);
      todayOrderReplies = today.map(createDetailFrame);
    },
    setOrderSnapshotRepliesFromFrozenV1: (orders) => {
      frozenV1Orders = orders;
      frozenV1Configured = true;
      historyOrderReplies = [];
    },
    orderSnapshotReadCounts: () => ({ history: historyOrderReads, today: todayOrderReads }),
    setOrderSnapshotNonArray: (source) => {
      const method = source === 'history' ? 'historyOrders' : 'todayOrders';
      Object.defineProperty(context, method, {
        value: async () => {
          if (source === 'history') historyOrderReads++;
          else todayOrderReads++;

          return { [Symbol.iterator]: function* () {} };
        },
      });
    },
    setOrderSnapshotOrderIdMissing: (source) => {
      snapshotMissingId.add(source);
    },
    setOrderSnapshotSymbolEmpty: (source) => {
      snapshotEmptySymbol.add(source);
    },
    setOrderSnapshotSideInvalid: (source) => {
      snapshotInvalidSide.add(source);
    },
    setOrderSnapshotQuantitiesMissing: (source) => {
      snapshotMissingQuantities.add(source);
    },
    setOrderSnapshotOrderTypeUnknown: (source) => {
      snapshotUnknownType.add(source);
    },
    setOrderSnapshotUpdatedAtInvalid: (source) => {
      snapshotInvalidUpdatedAt.add(source);
    },
    setOrderSnapshotSubmittedPriceNull: (orderId) => {
      snapshotNullPriceOrderIds.add(orderId);
    },
    setOrderSnapshotPriceMalformed: (orderId) => {
      snapshotMalformedPriceOrderIds.add(orderId);
    },
    setPendingOrderMetadataInvalid: (orderId, field, kind) => {
      pendingInvalidMetadata.set(orderId, { field, kind });
    },
    setOrderSnapshotUpdatedAtAbsent: (source, mode) => {
      snapshotAbsentUpdatedAt.set(source, mode);
    },
    setOrderDetailReplies: (frames) => {
      detailRepliesConfigured = true;
      detailReplies.clear();
      for (const frame of frames) {
        const reply = createDetailFrame(frame);
        const sequence = detailReplies.get(frame.orderId) ?? [];
        sequence.push(reply);
        detailReplies.set(frame.orderId, sequence);
      }
    },
    setStockPositions: (positions) => {
      positionsReply = {
        toString: () => 'offline positions',
        toJSON: () => ({}),
        channels: positions.map((position) => ({
          accountChannel: position.accountChannel,
          toString: () => position.accountChannel,
          toJSON: () => ({}),
          positions: [
            {
              symbol: position.symbol,
              symbolName: position.symbolName,
              currency: position.currency,
              quantity: new Decimal(position.quantity),
              availableQuantity: new Decimal(position.availableQuantity),
              costPrice: new Decimal(position.costPrice),
              market: Market.HK,
              initQuantity: null,
              toString: () => position.symbol,
              toJSON: () => ({}),
            },
          ],
        })),
      };
    },
    setStockPositionsFailure: (error) => {
      positionsFailure = error;
    },
    setAccountBalanceEmpty: () => {
      accountBalanceEmpty = true;
      accountReply = null;
    },
    setAccountBalance: (balance) => {
      accountBalanceEmpty = false;
      accountReply = {
        currency: balance.currency,
        totalCash: new Decimal(balance.totalCash),
        netAssets: new Decimal(balance.netAssets),
        cashInfos: [
          {
            currency: balance.currency,
            availableCash: new Decimal(balance.availableCash),
            get withdrawCash() {
              return unexpected();
            },
            get frozenCash() {
              return unexpected();
            },
            get settlingCash() {
              return unexpected();
            },
            toString: () => balance.currency,
            toJSON: () => ({}),
          },
        ],
        get maxFinanceAmount() {
          return unexpected();
        },
        get remainingFinanceAmount() {
          return unexpected();
        },
        get riskLevel() {
          return unexpected();
        },
        get marginCall() {
          return unexpected();
        },
        get initMargin() {
          return unexpected();
        },
        get maintenanceMargin() {
          return unexpected();
        },
        get buyPower() {
          return unexpected();
        },
        get frozenTransactionFees() {
          return unexpected();
        },
        toString: () => 'offline account',
        toJSON: () => ({}),
      };
    },
    accountReadCounts: () => ({ positions: positionsReadCount, balance: balanceReadCount }),
    setAccountBalanceFailure: (error) => {
      accountBalanceFailure = error;
    },
    setContextCreationFailure: (error) => {
      contextCreationFailure = error;
    },
    contextCreationCount: () => contextCreations,
    setSubscribeBehavior: (hook) => {
      subscribeBehavior = hook;
    },
    subscribeReadCount: () => subscribeCount,
    subscribeObservations: () => subscribeTopics.map((topics) => [...topics]),
    setUnsubscribeBehavior: (hook) => {
      unsubscribeBehavior = hook;
    },
    unsubscribeReadCount: () => unsubscribeCount,
    unsubscribeObservations: () => unsubscribeTopics.map((topics) => [...topics]),
    subscriptionMembership: () => [...subscriptionTopics],
    positionReadSymbols: () =>
      positionsSymbols.map((symbols) =>
        symbols === null || symbols === undefined ? symbols : [...symbols],
      ),
    // 与生产相同同步创建边沿；createTradeRuntime 的原 try 负责失败 Promise 化。
    brokerAccess: () => {
      contextCreations++;
      if (contextCreationFailure !== null) throw contextCreationFailure;

      return createBrokerAccessAdapter(context as TradeContext);
    },
    ports: createBrokerAccessAdapter(context as TradeContext),
    queryObservation: mapBrokerOrder(order),
    pushObservation: requirePushObservation(push),
    failReplace: (error) => {
      replaceFailure = error;
    },
    setCancelBeforeReply: (hook) => {
      cancelBeforeReply = hook;
    },
    setCancelFailure: (error) => {
      cancelFailure = error;
    },
    setQueryUpdatedAtMs: (value) => {
      queryUpdatedAtMs = value;
    },
    setQueryUpdatedAt: (value) => {
      queryRawUpdatedAtConfigured = true;
      queryRawUpdatedAt = value;
    },
    setOrderDetailBeforeReply: (hook) => {
      orderDetailBeforeReply = hook;
    },
    setQueryExecutedQuantityMissing: () => {
      queryExecutedQuantityMissing = true;
    },
    setQueryQuantityMissing: () => {
      queryQuantityMissing = true;
    },
    setQuerySideUnknown: () => {
      querySideUnknown = true;
    },
    setQueryGetterFailure: (error) => {
      queryGetterFailure = error;
    },
    nativeReadCounts: () => ({ cancel: cancelReadCount, detail: detailReadCount }),
    nativeCancelOrderIds: () => [...cancelOrderIds],
    setSubmitBehavior: (hook) => {
      submitBehavior = hook;
    },
    setReplaceBeforeReply: (hook) => {
      replaceBeforeReply = hook;
    },
    nativeSubmitObservations: () => [...nativeSubmissions],
    nativeMutations: () => [...nativeMutations],
    setPushSideUnknown: () => {
      pushSide = OrderSide.Unknown;
    },
    setPushExecutedPriceMissing: () => {
      pushPriceMissing = true;
    },
    setPushExecutedPriceText: (exact) => {
      pushPriceText = exact;
      pushPriceMissing = false;
    },
    setPushExecutedQuantityMissing: () => {
      pushQuantityGetterFailure = new TypeError(
        '[orderMapper] missing SDK cumulative execution quantity',
      );
    },
    setPushExecutedQuantityText: (exact) => {
      pushQuantityText = exact;
      pushQuantityGetterFailure = null;
    },
    setPushUpdatedAtMs: (value) => {
      pushUpdatedAtMs = value;
    },
    setPushExecutedQuantityGetterFailure: (error) => {
      pushQuantityGetterFailure = error;
    },
    emitOrderChangedFrame: (source) => {
      const frame = Object.freeze({ ...source });
      if (orderChangedHandler === undefined)
        throw new Error('[BrokerIngressFixture] Monitor SDK push callback not registered');

      const event: PushOrderChanged = {
        orderId: frame.orderId,
        symbol: frame.symbol,
        stockName: frame.stockName,
        remark: frame.remark,
        get side() {
          const side: unknown = frame.side;
          if (side === 'BUY') return OrderSide.Buy;

          if (side === 'SELL') return OrderSide.Sell;

          return OrderSide.Unknown;
        },
        get status() {
          return {
            New: OrderStatus.New,
            NotReported: OrderStatus.NotReported,
            ReplacedNotReported: OrderStatus.ReplacedNotReported,
            ProtectedNotReported: OrderStatus.ProtectedNotReported,
            VarietiesNotReported: OrderStatus.VarietiesNotReported,
            Filled: OrderStatus.Filled,
            PartialFilled: OrderStatus.PartialFilled,
            Canceled: OrderStatus.Canceled,
            Expired: OrderStatus.Expired,
            Rejected: OrderStatus.Rejected,
            WaitToCancel: OrderStatus.WaitToCancel,
            PendingCancel: OrderStatus.PendingCancel,
            WaitToReplace: OrderStatus.WaitToReplace,
            PendingReplace: OrderStatus.PendingReplace,
            Replaced: OrderStatus.Replaced,
            PartialWithdrawal: OrderStatus.PartialWithdrawal,
          }[frame.status];
        },
        orderType: { ELO: OrderType.ELO, LO: OrderType.LO, MO: OrderType.MO, SLO: OrderType.SLO }[
          frame.orderType ?? 'LO'
        ],
        get submittedQuantity() {
          return new Decimal(frame.quantity);
        },
        get submittedPrice() {
          return new Decimal(frame.submittedPrice);
        },
        get executedQuantity() {
          return new Decimal(frame.executedQuantity);
        },
        get executedPrice() {
          return frame.executedPrice === null ? null : new Decimal(frame.executedPrice);
        },
        get submittedAt() {
          return new Date(frame.submittedAtMs);
        },
        get updatedAt() {
          return new Date(frame.updatedAtMs);
        },
        currency: 'HKD',
        tag: OrderTag.Normal,
        accountNo: 'OFFLINE-FIXTURE',
        msg: '',
        triggerPrice: null,
        triggerStatus: null,
        triggerAt: null,
        trailingAmount: null,
        trailingPercent: null,
        limitOffset: null,
        lastShare: null,
        lastPrice: null,
        toString: () => frame.orderId,
        toJSON: () => ({ orderId: frame.orderId }),
      };
      orderChangedHandler(null, event);
    },
    emitOrderChanged: () => {
      if (orderChangedHandler === undefined)
        throw new Error('[BrokerIngressFixture] Monitor SDK push callback not registered');

      orderChangedHandler(null, push);
    },
  };
}
