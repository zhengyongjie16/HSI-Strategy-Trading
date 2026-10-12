/**
 * 订单数量解析模块
 *
 * 职责：
 * - 解析买入数量来源（显式数量/按目标金额换算）
 * - 校验显式数量整手约束
 * - 计算卖出可提交数量（按可用持仓裁剪）
 */
import { logger } from '../../../utils/logger/index.js';
import { isDefined } from '../../utils.js';
import type { Position } from '../../../types/account.js';
import type { SignalCallerAuthorization } from '../../../types/trader.js';
import type { Signal } from '../../../types/signal.js';
import {
  exactCompare,
  safeQuantityNumber,
  sumSafeQuantities,
  wholeLotQuantity,
} from '../../../utils/numeric/exact.js';
import type { RateLimiter } from '../../../types/services.js';

/**
 * 解析买入数量来源并执行显式数量校验。
 *
 * @param signal 交易信号，显式数量只接受安全整数 number
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

  if (!Number.isSafeInteger(quantity)) {
    return {
      source: 'INVALID',
      reason: `quantity 无效(${quantity})，必须为安全整数`,
    };
  }

  const lotSize = finalLotSize;
  if (
    typeof lotSize !== 'number' ||
    !Number.isFinite(lotSize) ||
    lotSize <= 0 ||
    !Number.isSafeInteger(lotSize)
  ) {
    return {
      source: 'INVALID',
      reason: `lotSize 无效(${String(lotSize)})，无法校验整手约束`,
    };
  }

  if (quantity % lotSize !== 0) {
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
 * @param finalPrice mutation permit 内读取的最终金融价格文本
 * @param finalLotSize mutation permit 内读取的最终每手股数
 * @param isShortSymbol 是否为空头方向标的
 * @param targetNotional 目标金额文本
 * @returns 先精确计算整手数量，再证明并投影为安全整数 number
 */
function calculateBuyQuantity(
  finalPrice: string,
  finalLotSize: number | undefined,
  isShortSymbol: boolean,
  targetNotional: string,
): number {
  if (exactCompare(finalPrice, '0') <= 0) {
    logger.warn(`[跳过订单] 无法获取有效价格，无法按金额计算买入数量，price=${finalPrice}`);
    return 0;
  }

  if (exactCompare(targetNotional, '0') <= 0) {
    throw new TypeError(
      `[订单提交] targetNotional 无效(${targetNotional})，这不应该发生，请检查配置装配链路`,
    );
  }

  const lotSize = finalLotSize;
  if (typeof lotSize !== 'number' || !Number.isSafeInteger(lotSize) || lotSize <= 0) {
    logger.error(`[跳过订单] lotSize 无效(${String(lotSize)})，这不应该发生，请检查配置验证逻辑`);
    return 0;
  }

  const quantity = safeQuantityNumber(
    wholeLotQuantity(targetNotional, finalPrice, String(lotSize)),
  );
  if (quantity === 0) {
    logger.warn(
      `[跳过订单] 目标金额(${targetNotional}) 相对于价格(${finalPrice}) 太小，按每手 ${lotSize} 股无法凑整手，跳过提交订单`,
    );
    return 0;
  }

  const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
  logger.debug(
    `[仓位计算] 按目标金额 ${targetNotional} 计算得到${actionType}数量=${quantity} 股（${lotSize} 股一手），单价=${finalPrice}`,
  );
  return quantity;
}

/**
 * 解析买入数量（显式数量优先，未提供时按金额换算）。
 *
 * @param signal 交易信号
 * @param isShortSymbol 是否为空头方向标的
 * @param targetNotional 目标金额文本
 * @param finalPrice mutation permit 内读取的最终金融价格文本
 * @param finalLotSize mutation permit 内读取的最终每手股数
 * @returns 安全整数买入数量；业务无效返回 0，内部金融文本契约错误直接上抛
 */
function resolveBuyQuantity(
  signal: Signal,
  isShortSymbol: boolean,
  targetNotional: string,
  finalPrice: string,
  finalLotSize: number | undefined,
): number {
  const buyQuantitySource = resolveBuyQuantitySource(signal, finalLotSize);
  if (buyQuantitySource.source === 'INVALID') {
    logger.warn(
      `[跳过订单] 显式买入数量校验失败: ${buyQuantitySource.reason}, symbol=${signal.symbol}`,
    );
    return 0;
  }

  if (buyQuantitySource.source === 'EXPLICIT') {
    const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
    logger.debug(
      `[仓位计算] 按显式数量提交${actionType}数量=${buyQuantitySource.quantity} 股（${buyQuantitySource.lotSize} 股一手）`,
    );
    return buyQuantitySource.quantity;
  }

  return calculateBuyQuantity(finalPrice, finalLotSize, isShortSymbol, targetNotional);
}

/**
 * 创建数量解析器。
 *
 * @param deps 数量解析依赖
 * @returns 使用金融文本输入与安全整数数量输出的数量解析器实例
 */
export function createQuantityResolver(deps: {
  readonly rateLimiter: RateLimiter;
  readonly readSellPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
}): {
  readonly calculateSellQuantity: (
    symbol: string,
    signal: Signal,
    authorizeOrderAction: SignalCallerAuthorization,
  ) => Promise<{ readonly availableQuantity: number; readonly submittedQuantity: number }>;
  readonly resolveDoomsdayClearanceQuantity: (
    symbol: string,
    authorizeOrderAction: SignalCallerAuthorization,
  ) => Promise<number>;
  readonly resolveBuyQuantity: typeof resolveBuyQuantity;
} {
  const { rateLimiter, readSellPositions } = deps;

  /**
   * 读取当前标的的权威可用卖出数量。
   * 普通卖出与末日清仓共用同一份新鲜仓位事实，二者仅在后续是否允许信号数量裁剪上分叉。
   *
   * @param symbol 交易标的
   * @param authorizeOrderAction 原 caller 授权，限流/外部读取后复核
   * @returns 当前可用卖出数量；无可用持仓时返回 0
   */
  async function readFreshAvailableSellQuantity(
    symbol: string,
    authorizeOrderAction: SignalCallerAuthorization,
  ): Promise<number> {
    if (!authorizeOrderAction()) return 0;

    await rateLimiter.throttle();
    if (!authorizeOrderAction()) return 0;

    const positions = await readSellPositions(symbol);
    // 映射后的结构数量仍必须先验证，旧授权不能吞掉内部事实错误。
    for (const position of positions) {
      if (
        !Number.isSafeInteger(position.quantity) ||
        position.quantity < 0 ||
        !Number.isSafeInteger(position.availableQuantity) ||
        position.availableQuantity < 0
      ) {
        throw new RangeError('权威可卖数量必须为非负安全整数');
      }
    }

    if (!authorizeOrderAction()) return 0;

    const totalAvailable = sumSafeQuantities(
      positions
        .filter((position) => position.symbol === symbol)
        .map((position) => String(position.availableQuantity)),
    );

    if (totalAvailable === 0) {
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
   * @param symbol 交易标的
   * @param authorizeOrderAction 原 caller 授权，限流/外部读取后复核
   * @param signal 交易信号
   * @returns 实时可用持仓与按有效 signal.quantity 限制后的安全整数提交数量
   */
  async function calculateSellQuantity(
    symbol: string,
    signal: Signal,
    authorizeOrderAction: SignalCallerAuthorization,
  ): Promise<{
    readonly availableQuantity: number;
    readonly submittedQuantity: number;
  }> {
    const totalAvailable = await readFreshAvailableSellQuantity(symbol, authorizeOrderAction);
    if (totalAvailable === 0) {
      return {
        availableQuantity: 0,
        submittedQuantity: 0,
      };
    }

    let targetQuantity: number | null = null;
    if (isDefined(signal.quantity)) {
      const signalQty = signal.quantity;
      if (typeof signalQty !== 'number') {
        throw new TypeError('[订单提交] signal.quantity 必须是安全整数 number');
      }

      if (Number.isFinite(signalQty) && signalQty > 0) {
        targetQuantity = safeQuantityNumber(String(signalQty));
      }
    }

    if (targetQuantity === null) {
      return {
        availableQuantity: totalAvailable,
        submittedQuantity: totalAvailable,
      };
    }

    const actualQty = Math.min(targetQuantity, totalAvailable);
    logger.debug(
      `[部分卖出] 信号指定卖出数量=${targetQuantity}，可用数量=${totalAvailable}，实际卖出=${actualQty}`,
    );
    return {
      availableQuantity: totalAvailable,
      submittedQuantity: actualQty,
    };
  }

  /**
   * 解析末日清仓数量。
   * 末日专用命令不携带普通 signal.quantity，因此必须直接使用本轮权威可用持仓全量清仓。
   *
   * @param symbol 交易标的
   * @param authorizeOrderAction 原 caller 授权，限流/外部读取后复核
   * @returns 当前新鲜可用持仓的安全整数数量；无可用持仓时返回 0
   */
  async function resolveDoomsdayClearanceQuantity(
    symbol: string,
    authorizeOrderAction: SignalCallerAuthorization,
  ): Promise<number> {
    return readFreshAvailableSellQuantity(symbol, authorizeOrderAction);
  }

  return {
    calculateSellQuantity,
    resolveDoomsdayClearanceQuantity,
    resolveBuyQuantity,
  };
}
