/**
 * 浮亏检查模块
 *
 * 监控执行标的浮亏，超过阈值时触发保护性清仓：
 * - R1 = 开仓成本（持仓成本价 × 持仓数量）
 * - N1 = 持仓数量
 * - R2 = 当前市值（当前价格 × N1）
 * - 浮亏 = R2 - R1（负值表示亏损）
 */
import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  formatSymbolDisplayFromQuote,
  getLongDirectionName,
  getShortDirectionName,
} from '../utils.js';
import {
  decimalLt,
  decimalMul,
  decimalNeg,
  decimalSub,
  decimalToNumberValue,
  formatDecimal,
} from '../../utils/numeric/index.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { UnrealizedLossData, UnrealizedLossCheckResult } from '../../types/services.js';
import type { UnrealizedLossChecker, UnrealizedLossCheckerDeps } from './types.js';

/**
 * 创建浮亏检查器。
 * 维护标的级浮亏缓存（R1/N1），提供 refresh 与 check；check 时计算 R2 - R1，超过 maxUnrealizedLossPerSymbol 则返回 shouldLiquidate。
 * 买入前、行情展示与主循环浮亏监控共用同一套 R1/N1 缓存，避免重复计算。
 * @param deps 依赖，含 maxUnrealizedLossPerSymbol（null 或 ≤0 表示禁用浮亏清仓阈值检查）
 * @returns 实现 UnrealizedLossChecker 接口的实例（含 refresh/check/clearUnrealizedLossData）
 */
export const createUnrealizedLossChecker = (
  deps: UnrealizedLossCheckerDeps,
): UnrealizedLossChecker => {
  const maxUnrealizedLossPerSymbol = deps.maxUnrealizedLossPerSymbol;

  // 闭包捕获的私有状态
  const unrealizedLossData = new Map<string, UnrealizedLossData>();

  /** 获取指定标的的浮亏数据 */
  const getUnrealizedLossData = (symbol: string): UnrealizedLossData | undefined => {
    return unrealizedLossData.get(symbol);
  };

  /** 清空浮亏数据，symbol 为空时清空全部 */
  const clearUnrealizedLossData = (symbol?: string | null): void => {
    if (symbol === null || symbol === undefined || symbol === '') {
      unrealizedLossData.clear();
    } else {
      unrealizedLossData.delete(symbol);
    }
  };

  /** 检查浮亏清仓阈值是否启用 */
  const isLiquidationEnabled = (): boolean => {
    return (
      maxUnrealizedLossPerSymbol !== null &&
      Number.isFinite(maxUnrealizedLossPerSymbol) &&
      maxUnrealizedLossPerSymbol > 0
    );
  };

  /**
   * 刷新指定标的的浮亏数据并写入缓存。
   * 启动初始化、成交后刷新或保护性清仓后调用，以确保后续检查与展示使用最新的 R1/N1。
   * dailyLossOffset 仅记录亏损偏移（<=0）；调整后 R1 按 baseR1 - dailyLossOffset 计算。
   */
  const refresh = (
    symbol: string,
    position: Position | null,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null> => {
    try {
      const quantity = position?.quantity ?? 0;
      const costPrice = position?.costPrice ?? 0;
      const normalizedQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
      const normalizedCostPrice = Number.isFinite(costPrice) && costPrice > 0 ? costPrice : 0;
      const baseR1 = decimalToNumberValue(decimalMul(normalizedCostPrice, normalizedQuantity));
      const n1 = normalizedQuantity;
      const rawOffset =
        dailyLossOffset !== undefined && Number.isFinite(dailyLossOffset) ? dailyLossOffset : 0;
      const normalizedOffset = Math.min(rawOffset, 0);

      // 调整后R1 = 基础R1 - 当日偏移
      // 当日偏移仅记录亏损（<=0）：盈利偏移统一按 0，不减少 R1
      // 亏损偏移为负数时，减去负数使 R1 增大，从而更容易触发浮亏保护
      const adjustedR1 = decimalToNumberValue(decimalSub(baseR1, normalizedOffset));

      // 更新缓存
      unrealizedLossData.set(symbol, {
        r1: adjustedR1,
        n1,
        baseR1,
        dailyLossOffset: normalizedOffset,
        lastUpdateTime: Date.now(),
      });

      const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();

      // 使用 formatSymbolDisplayFromQuote 格式化标的显示
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);

      logger.info(
        `[浮亏监控] ${positionType} ${symbolDisplay}: ` +
          `R1(开仓成本)=${formatDecimal(baseR1, 2)} HKD, ` +
          `当日偏移=${formatDecimal(normalizedOffset, 2)} HKD, ` +
          `调整后R1(开仓成本)=${formatDecimal(adjustedR1, 2)} HKD, ` +
          `N1(持仓数量)=${n1}, 持仓成本价=${formatDecimal(normalizedCostPrice, 4)}`,
      );

      return Promise.resolve({ r1: adjustedR1, n1 });
    } catch (error) {
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[浮亏监控] 刷新标的 ${symbolDisplay} 的浮亏数据失败`, errorMessage);
      return Promise.resolve(null);
    }
  };

  /**
   * 检查指定标的的浮亏是否超过 maxUnrealizedLossPerSymbol 阈值。
   * 超过时返回清仓信号（shouldLiquidate=true），由 UnrealizedLossMonitor 触发保护性清仓。
   * 依赖 refresh 写入的缓存数据，缓存未初始化时跳过检查并告警。
   */
  const check = (
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult => {
    // 如果未启用浮亏保护，跳过
    if (!isLiquidationEnabled()) {
      return { shouldLiquidate: false };
    }

    // 验证当前价格有效性
    if (!isValidPositiveNumber(currentPrice)) {
      return { shouldLiquidate: false };
    }

    // 获取缓存的浮亏数据
    const lossData = unrealizedLossData.get(symbol);
    if (!lossData) {
      logger.warn(
        `[浮亏监控] ${symbol} 浮亏数据未初始化，跳过检查（可能是订单获取失败或数据尚未刷新）`,
      );
      return { shouldLiquidate: false };
    }

    const { r1, n1 } = lossData;

    // 如果剩余数量为0或负数，无需清仓
    if (!Number.isFinite(n1) || n1 <= 0) {
      return { shouldLiquidate: false };
    }

    const threshold = Number(maxUnrealizedLossPerSymbol);

    // 计算当前持仓市值R2和浮亏
    const r2 = decimalMul(currentPrice, n1);
    const unrealizedLoss = decimalSub(r2, r1);

    // 检查浮亏是否超过阈值（浮亏为负数表示亏损）
    if (decimalLt(unrealizedLoss, decimalNeg(threshold))) {
      const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();
      const reason = `[保护性清仓] ${positionType} ${symbol} 浮亏=${formatDecimal(
        unrealizedLoss,
        2,
      )} HKD 超过阈值 ${formatDecimal(threshold, 2)} HKD (R1=${formatDecimal(
        r1,
        2,
      )}, R2=${formatDecimal(r2, 2)}, N1=${n1})，执行保护性清仓`;

      return {
        shouldLiquidate: true,
        reason,
        quantity: n1,
      };
    }

    return { shouldLiquidate: false };
  };

  return {
    getUnrealizedLossData,
    clearUnrealizedLossData,
    refresh,
    check,
  };
};
