/**
 * 订单数量解析模块
 *
 * 职责：
 * - 解析买入数量来源（显式数量/按目标金额换算）
 * - 校验显式数量整手约束
 * - 解析卖出可提交数量（仅消费上游信号已计算的数量）
 */
import { Decimal } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { isDefined } from '../../utils.js';
import type { Signal } from '../../../types/signal.js';
import type { QuantityResolver } from './types.js';
import {
  calculateLotQuantityByNotional,
  decimalToNumberValue,
  isLotMultiple,
} from '../../../utils/numeric/index.js';
import { toDecimal } from '../utils.js';

/**
 * 解析买入数量来源并执行显式数量校验。
 *
 * @param signal 交易信号
 * @returns 数量来源判定结果
 */
function resolveBuyQuantitySource(
  signal: Signal,
):
  | { readonly source: 'NOTIONAL' }
  | { readonly source: 'EXPLICIT'; readonly quantity: number; readonly lotSize: number }
  | { readonly source: 'INVALID'; readonly reason: string } {
  if (!isDefined(signal.quantity)) {
    return { source: 'NOTIONAL' };
  }

  const quantity = signal.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      source: 'INVALID',
      reason: `quantity 无效(${String(quantity)})，必须为大于 0 的有限数`,
    };
  }

  if (!Number.isInteger(quantity)) {
    return {
      source: 'INVALID',
      reason: `quantity 无效(${quantity})，必须为整数`,
    };
  }

  const lotSize = signal.lotSize;
  if (
    typeof lotSize !== 'number' ||
    !Number.isFinite(lotSize) ||
    lotSize <= 0 ||
    !Number.isInteger(lotSize)
  ) {
    return {
      source: 'INVALID',
      reason: `lotSize 无效(${String(lotSize)})，无法校验整手约束`,
    };
  }

  if (!isLotMultiple(quantity, lotSize)) {
    return {
      source: 'INVALID',
      reason: `quantity=${quantity} 不满足整手约束，lotSize=${lotSize}`,
    };
  }

  return {
    source: 'EXPLICIT',
    quantity,
    lotSize,
  };
}

/**
 * 按目标金额与每手股数计算买入数量。
 *
 * @param signal 交易信号
 * @param isShortSymbol 是否为空头方向标的
 * @param targetNotional 目标金额
 * @returns 计算后的买入数量（Decimal）
 */
function calculateBuyQuantity(
  signal: Signal,
  isShortSymbol: boolean,
  targetNotional: number,
): Decimal {
  const priceNum = Number(signal.price ?? null);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    logger.warn(`[跳过订单] 无法获取有效价格，无法按金额计算买入数量，price=${priceNum}`);
    return Decimal.ZERO();
  }

  if (!isValidPositiveNumber(targetNotional)) {
    logger.error(
      `[跳过订单] targetNotional 无效(${String(targetNotional)})，拒绝使用非配置化默认金额下单`,
    );
    return Decimal.ZERO();
  }

  const notional = targetNotional;
  const lotSize: number = signal.lotSize ?? 0;
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    logger.error(`[跳过订单] lotSize 无效(${lotSize})，这不应该发生，请检查配置验证逻辑`);
    return Decimal.ZERO();
  }

  const alignedQuantity = calculateLotQuantityByNotional({
    notional,
    price: priceNum,
    lotSize,
  });
  if (!alignedQuantity) {
    logger.warn(
      `[跳过订单] 目标金额(${notional}) 相对于价格(${priceNum}) 太小，按每手 ${lotSize} 股无法凑整手，跳过提交订单`,
    );
    return Decimal.ZERO();
  }

  const rawQty = decimalToNumberValue(alignedQuantity);
  const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
  logger.debug(
    `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${priceNum}`,
  );
  return alignedQuantity;
}

/**
 * 解析买入数量（显式数量优先，未提供时按金额换算）。
 *
 * @param signal 交易信号
 * @param isShortSymbol 是否为空头方向标的
 * @param targetNotional 目标金额
 * @returns 买入数量（Decimal），无效返回 Decimal.ZERO()
 */
function resolveBuyQuantity(
  signal: Signal,
  isShortSymbol: boolean,
  targetNotional: number,
): Decimal {
  const buyQuantitySource = resolveBuyQuantitySource(signal);
  if (buyQuantitySource.source === 'INVALID') {
    logger.warn(
      `[跳过订单] 显式买入数量校验失败: ${buyQuantitySource.reason}, symbol=${signal.symbol}`,
    );
    return Decimal.ZERO();
  }

  if (buyQuantitySource.source === 'EXPLICIT') {
    const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
    logger.debug(
      `[仓位计算] 按显式数量提交${actionType}数量=${buyQuantitySource.quantity} 股（${buyQuantitySource.lotSize} 股一手）`,
    );
    return toDecimal(buyQuantitySource.quantity);
  }

  return calculateBuyQuantity(signal, isShortSymbol, targetNotional);
}

/**
 * 创建数量解析器。
 *
 * @returns 数量解析器实例
 */
export function createQuantityResolver(): QuantityResolver {
  /**
   * 解析卖出数量（仅消费上游信号已计算的 quantity）。
   *
   * @param signal 交易信号
   * @returns 卖出数量（Decimal）
   */
  function calculateSellQuantity(signal: Signal): Decimal {
    if (!isDefined(signal.quantity)) {
      logger.warn(`[跳过订单] 卖出信号缺少数量，无法提交。symbol=${signal.symbol}`);
      return Decimal.ZERO();
    }

    const sellQuantity = signal.quantity;
    if (!isValidPositiveNumber(sellQuantity)) {
      logger.warn(
        `[跳过订单] 卖出信号数量无效，无法提交。symbol=${signal.symbol}, quantity=${String(sellQuantity)}`,
      );
      return Decimal.ZERO();
    }

    return toDecimal(sellQuantity);
  }

  return {
    calculateSellQuantity,
    resolveBuyQuantity,
  };
}
