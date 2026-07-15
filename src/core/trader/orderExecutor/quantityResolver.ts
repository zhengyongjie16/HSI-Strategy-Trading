/**
 * 订单数量解析模块
 *
 * 职责：
 * - 解析买入数量来源（显式数量/按目标金额换算）
 * - 校验显式数量整手约束
 * - 计算卖出可提交数量（按可用持仓裁剪）
 */
import { Decimal, type TradeContext } from 'longbridge';
import { logger } from '../../../utils/logger/index.js';
import { wrapExternalApiRequest } from '../../../utils/apiFailure/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { isDefined } from '../../utils.js';
import type { Signal } from '../../../types/signal.js';
import type { QuantityResolver, SellQuantityResolution } from './types.js';
import {
  calculateLotQuantityByNotional,
  decimalToNumberValue,
  isLotMultiple,
} from '../../../utils/numeric/index.js';
import { toDecimal } from '../utils.js';
import type { RateLimiter } from '../../../types/services.js';

const HIGH_FRESHNESS_API_RETRY_CONFIG = {
  retries: 0,
  delayMs: 0,
} as const;

/**
 * 解析买入数量来源并执行显式数量校验。
 *
 * @param finalPrice mutation permit 内读取的最终价格
 * @param finalLotSize mutation permit 内读取的最终每手股数
 * @returns 数量来源判定结果
 */
function resolveBuyQuantitySource(
  signal: Signal,
  finalLotSize: number | undefined,
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

  const lotSize = finalLotSize;
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
  finalPrice: number,
  finalLotSize: number | undefined,
  isShortSymbol: boolean,
  targetNotional: number,
): Decimal {
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
    logger.warn(`[跳过订单] 无法获取有效价格，无法按金额计算买入数量，price=${finalPrice}`);
    return Decimal.ZERO();
  }

  if (!isValidPositiveNumber(targetNotional)) {
    throw new TypeError(
      `[订单提交] targetNotional 无效(${String(targetNotional)})，这不应该发生，请检查配置装配链路`,
    );
  }

  const notional = targetNotional;
  const lotSize: number = finalLotSize ?? 0;
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    logger.error(`[跳过订单] lotSize 无效(${lotSize})，这不应该发生，请检查配置验证逻辑`);
    return Decimal.ZERO();
  }

  const alignedQuantity = calculateLotQuantityByNotional({
    notional,
    price: finalPrice,
    lotSize,
  });
  if (!alignedQuantity) {
    logger.warn(
      `[跳过订单] 目标金额(${notional}) 相对于价格(${finalPrice}) 太小，按每手 ${lotSize} 股无法凑整手，跳过提交订单`,
    );
    return Decimal.ZERO();
  }

  const rawQty = decimalToNumberValue(alignedQuantity);
  const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
  logger.debug(
    `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${finalPrice}`,
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
  finalPrice: number,
  finalLotSize: number | undefined,
): Decimal {
  const buyQuantitySource = resolveBuyQuantitySource(signal, finalLotSize);
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

  return calculateBuyQuantity(finalPrice, finalLotSize, isShortSymbol, targetNotional);
}

/**
 * 创建数量解析器。
 *
 * @param deps 数量解析依赖
 * @returns 数量解析器实例
 */
export function createQuantityResolver(deps: {
  readonly rateLimiter: RateLimiter;
}): QuantityResolver {
  const { rateLimiter } = deps;

  /**
   * 读取当前标的的权威可用卖出数量。
   * 普通卖出与末日清仓共用同一份新鲜仓位事实，二者仅在后续是否允许信号数量裁剪上分叉。
   *
   * @param ctx TradeContext
   * @param symbol 交易标的
   * @returns 当前可用卖出数量；无可用持仓时返回 0
   */
  async function readFreshAvailableSellQuantity(
    ctx: TradeContext,
    symbol: string,
  ): Promise<number> {
    await rateLimiter.throttle();
    const resp = await wrapExternalApiRequest({
      operation: 'TradeContext.stockPositions.quantityResolver',
      request: () => ctx.stockPositions([symbol]),
      retryConfig: HIGH_FRESHNESS_API_RETRY_CONFIG,
    });
    const channels = resp.channels;
    let totalAvailable = 0;
    for (const ch of channels) {
      const positions = Array.isArray(ch.positions) ? ch.positions : [];
      for (const pos of positions) {
        if (pos.symbol !== symbol) {
          continue;
        }

        const qty = decimalToNumber(pos.availableQuantity);
        if (isValidPositiveNumber(qty)) {
          totalAvailable += qty;
        }
      }
    }

    if (!Number.isFinite(totalAvailable) || totalAvailable <= 0) {
      logger.warn(
        `[跳过订单] 当前无可用持仓，无需平仓。symbol=${symbol}, available=${totalAvailable}`,
      );
      return 0;
    }

    return totalAvailable;
  }

  /**
   * 计算普通卖出数量（基于新鲜可用持仓并支持信号显式 quantity 限制）。
   *
   * @param ctx TradeContext
   * @param symbol 交易标的
   * @param signal 交易信号
   * @returns Promise<SellQuantityResolution>，包含实时可用持仓与按有效 signal.quantity 限制后的提交数量
   */
  async function calculateSellQuantity(
    ctx: TradeContext,
    symbol: string,
    signal: Signal,
  ): Promise<SellQuantityResolution> {
    const totalAvailable = await readFreshAvailableSellQuantity(ctx, symbol);
    if (totalAvailable <= 0) {
      return {
        availableQuantity: 0,
        submittedQuantity: Decimal.ZERO(),
      };
    }

    let targetQuantity: number | null = null;
    if (isDefined(signal.quantity)) {
      const signalQty = signal.quantity;
      if (isValidPositiveNumber(signalQty)) {
        targetQuantity = signalQty;
      }
    }

    if (targetQuantity === null) {
      return {
        availableQuantity: totalAvailable,
        submittedQuantity: toDecimal(totalAvailable),
      };
    }

    const actualQty = Math.min(targetQuantity, totalAvailable);
    logger.debug(
      `[部分卖出] 信号指定卖出数量=${targetQuantity}，可用数量=${totalAvailable}，实际卖出=${actualQty}`,
    );
    return {
      availableQuantity: totalAvailable,
      submittedQuantity: toDecimal(actualQty),
    };
  }

  /**
   * 解析末日清仓数量。
   * 末日专用命令不携带普通 signal.quantity，因此必须直接使用本轮权威可用持仓全量清仓。
   *
   * @param ctx TradeContext
   * @param symbol 交易标的
   * @returns 当前新鲜可用持仓数量；无可用持仓时返回 Decimal.ZERO()
   */
  async function resolveDoomsdayClearanceQuantity(
    ctx: TradeContext,
    symbol: string,
  ): Promise<Decimal> {
    return toDecimal(await readFreshAvailableSellQuantity(ctx, symbol));
  }

  return {
    calculateSellQuantity,
    resolveDoomsdayClearanceQuantity,
    resolveBuyQuantity,
  };
}
