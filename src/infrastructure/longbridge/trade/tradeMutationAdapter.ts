/**
 * Longbridge 下单/改单/撤单窄 IO adapter。
 * 将中性命令的金融文本和已证明数量在真实 SDK 调用前序列化；
 * 用独立 exact 文本比较拒绝 SDK Decimal 的容量截尾/下溢，不回传 SDK 金融对象。
 * 仅使用注入的同一 TradeContext，不建 context、不缓存配置、不增设授权或重试政策。
 */
import {
  Decimal,
  OrderSide,
  OrderType,
  TimeInForceType,
  type SubmitOrderOptions,
  type TradeContext,
} from 'longbridge';
import type {
  TradeMutationPort,
  TradeReplaceCommand,
  TradeSubmitCommand,
  TradeSubmitResult,
} from '../../../types/tradeMutationPorts.js';
import { canonicalDecimal, exactCompare } from '../../../utils/numeric/exact.js';
import { isRecord } from '../../../utils/helpers/index.js';

/** 验证原动作所需的正价格文本；内部格式错误不转换成 broker 业务拒绝。 */
function positivePriceText(text: string): string {
  const canonical = canonicalDecimal(text);
  if (exactCompare(canonical, '0') <= 0) {
    throw new RangeError('[TradeMutationAdapter] price must be positive');
  }

  return canonical;
}

/** 数量只有在正安全整数证明后才进入结构整数文本出口，不接受金融 number。 */
function quantityText(quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError('[TradeMutationAdapter] quantity must be a positive safe integer');
  }

  return String(quantity);
}

/**
 * 仅在 adapter 内构造 SDK Decimal；比较原精确文本与实际序列化结果，不用 SDK.eq 自证。
 * SDK 构造及 toString 的原始错误直接透传；入站构造之前已丢失的尾数不在此恢复。
 */
function serializeBrokerDecimal(text: string): Decimal {
  const decimal = new Decimal(text);
  if (exactCompare(text, decimal.toString()) !== 0) {
    throw new RangeError('[TradeMutationAdapter] SDK Decimal capacity would change the value');
  }

  return decimal;
}

/** 将中性方向映射为真实 SDK enum，不接纳 UNKNOWN 或隐式默认方向。 */
function brokerSide(side: TradeSubmitCommand['side']): OrderSide {
  switch (side) {
    case 'BUY': {
      return OrderSide.Buy;
    }

    case 'SELL': {
      return OrderSide.Sell;
    }

    default: {
      throw new TypeError('[TradeMutationAdapter] unsupported order side');
    }
  }
}

/** 只映射当前配置及超时转单实际使用的三种订单类型，不增设其他订单政策。 */
function brokerOrderType(orderType: TradeSubmitCommand['orderType']): OrderType {
  switch (orderType) {
    case 'LO': {
      return OrderType.LO;
    }

    case 'ELO': {
      return OrderType.ELO;
    }

    case 'MO': {
      return OrderType.MO;
    }

    default: {
      throw new TypeError('[TradeMutationAdapter] unsupported order type');
    }
  }
}

/** 只映射实际使用的 DAY，不接受运行时损坏后的其他 timeInForce。 */
function brokerTimeInForce(timeInForce: string): TimeInForceType {
  if (timeInForce !== 'DAY') {
    throw new TypeError('[TradeMutationAdapter] unsupported time in force');
  }

  return TimeInForceType.Day;
}

/** 市价命令不得在运行时携带限价字段，即使静态类型已禁止该组合。 */
function requireMarketPriceOmitted(price: unknown): void {
  if (price !== undefined) {
    throw new TypeError('[TradeMutationAdapter] market order must omit submittedPrice');
  }
}

/** 校验身份但不改写拼写或补默认值，保留原 broker 标的/订单身份。 */
function requireIdentity(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('[TradeMutationAdapter] missing mutation identity');
  }
}

/**
 * 装配原 submit/replace/cancel IO 的最窄中性能力。
 * 原 caller 仍负责 PRE_SUBMIT 校验、最终授权、callback permit、限流及 broker failure 分类。
 * @param context 同一真实 TradeContext 的 mutation 方法，不构造或复制 SDK context
 * @returns 仅返回中性订单身份/void 的 IO port
 */
export function createTradeMutationAdapter(context: unknown): TradeMutationPort {
  if (
    !isRecord(context) ||
    typeof context['submitOrder'] !== 'function' ||
    typeof context['replaceOrder'] !== 'function'
  ) {
    throw new TypeError('[TradeMutationAdapter] missing injected SDK mutation capabilities');
  }

  const ctx = context as Pick<TradeContext, 'submitOrder' | 'replaceOrder' | 'cancelOrder'>;
  async function submitOrder(
    command: TradeSubmitCommand,
    onRemoteIssued: () => void,
  ): Promise<TradeSubmitResult> {
    requireIdentity(command.symbol);
    const quantity = quantityText(command.submittedQuantity);
    const side = brokerSide(command.side);
    const orderType = brokerOrderType(command.orderType);
    const timeInForce = brokerTimeInForce(command.timeInForce);

    if (command.remark !== undefined && typeof command.remark !== 'string') {
      throw new TypeError('[TradeMutationAdapter] remark must be text');
    }

    let price: string | undefined;
    if (command.orderType === 'MO') {
      requireMarketPriceOmitted(command.submittedPrice);
    } else {
      price = positivePriceText(command.submittedPrice);
    }

    const nativeCommand: SubmitOrderOptions = {
      symbol: command.symbol,
      side,
      orderType,
      timeInForce,
      submittedQuantity: serializeBrokerDecimal(quantity),
      ...(price === undefined ? {} : { submittedPrice: serializeBrokerDecimal(price) }),
      ...(command.remark === undefined ? {} : { remark: command.remark }),
    };
    onRemoteIssued();
    const response = await ctx.submitOrder(nativeCommand);
    const orderId = response.orderId;
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error('submitOrder response missing valid orderId');
    }

    return Object.freeze({ orderId });
  }

  async function replaceOrder(
    command: TradeReplaceCommand,
    onRemoteIssued: () => void,
  ): Promise<void> {
    requireIdentity(command.orderId);
    const quantity = quantityText(command.quantity);
    const price = positivePriceText(command.price);
    const nativeCommand = {
      orderId: command.orderId,
      quantity: serializeBrokerDecimal(quantity),
      price: serializeBrokerDecimal(price),
    };
    onRemoteIssued();
    await ctx.replaceOrder(nativeCommand);
  }

  return { submitOrder, replaceOrder, cancelOrder: (orderId) => ctx.cancelOrder(orderId) };
}
