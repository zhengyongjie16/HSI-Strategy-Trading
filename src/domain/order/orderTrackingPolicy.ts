/** 订单盯单纯规则：配置投影、时间与状态、价格和 WAIT_WS_ONLY 判定；不推进运行态。 */
import {
  DEFAULT_PRICE_DECIMALS,
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  ORDER_PRICE_DIFF_THRESHOLD,
} from '../../constants/common.js';
import type { GlobalConfig } from '../../types/config.js';
import type { OrderReadStatus, OrderClosedReason } from '../../types/orderReadMetadata.js';

import { exactCompare, exactSubtract, formatDecimal } from '../../utils/numeric/exact.js';
import { isOpenOrderReadStatus } from './orderReadLifecycle.js';
import type { OrderMonitorConfig, TrackedOrder } from './types.js';

/**
 * 构建订单监控配置（秒转毫秒）。
 *
 * @param globalConfig 全局配置
 * @returns 订单监控配置
 */
export function buildOrderMonitorConfig(globalConfig: GlobalConfig): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: globalConfig.buyOrderTimeout.enabled,
      timeoutMs: globalConfig.buyOrderTimeout.timeoutSeconds * 1000,
    },
    sellTimeout: {
      enabled: globalConfig.sellOrderTimeout.enabled,
      timeoutMs: globalConfig.sellOrderTimeout.timeoutSeconds * 1000,
    },
    priceUpdateIntervalMs: globalConfig.orderMonitorPriceUpdateInterval * 1000,
    priceDiffThreshold: ORDER_PRICE_DIFF_THRESHOLD,
    allowBuyOrderTrackingAboveInitialPrice: globalConfig.allowBuyOrderTrackingAboveInitialPrice,
  };
}

/**
 * 将 SDK 时间字段解析为毫秒时间戳。
 *
 * @param value SDK 返回的 Date 时间字段（updatedAt / submittedAt 等）
 * @returns 有效的正毫秒时间戳；无法解析或值无效时返回 null
 */
export function resolveTimeMs(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) {
    return null;
  }

  const timeMs = value.getTime();
  return Number.isFinite(timeMs) && timeMs > 0 ? timeMs : null;
}

/**
 * 从订单状态解析关闭原因。
 *
 * @param status 订单状态
 * @returns 对应的关闭原因；非关闭态返回 null
 */
export function resolveOrderClosedReasonFromStatus(
  status: OrderReadStatus,
): OrderClosedReason | null {
  if (status === 'FILLED') {
    return 'FILLED';
  }

  if (status === 'CANCELED' || status === 'EXPIRED' || status === 'PARTIALLY_CANCELED') {
    return 'CANCELED';
  }

  if (status === 'REJECTED') {
    return 'REJECTED';
  }

  return null;
}

/**
 * 判断改单能力是否处于“仅等待 WS 终态恢复”的临时模式。
 *
 * @param order 订单的改单能力与阻塞截止时间
 * @returns true 表示当前仅允许等待 WS 推进，不应主动再次发改单
 */
export function isWaitWsOnlyReplaceMode(
  order: Pick<TrackedOrder, 'replaceCapability' | 'replaceBlockedUntilAt'>,
): boolean {
  return (
    order.replaceCapability === 'TEMP_BLOCKED_BY_STATUS' &&
    order.replaceBlockedUntilAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS
  );
}

/**
 * 解析追踪订单初始状态。
 * 默认行为：缺失时使用 New；终态或未知状态属于调用契约错误。
 *
 * @param initialStatus 可选初始状态
 * @returns 追踪状态
 */
export function resolveInitialTrackedStatus(initialStatus?: OrderReadStatus): OrderReadStatus {
  if (initialStatus === undefined) {
    return 'WORKING';
  }

  if (!isOpenOrderReadStatus(initialStatus)) {
    throw new Error(`[订单监控] 初始追踪状态必须为 OPEN: ${initialStatus}`);
  }

  return initialStatus;
}

/**
 * 将价格标准化为固定小数位文本。
 *
 * @param price 原始价格
 * @returns 固定小数位文本
 */
export function normalizePriceText(price: string): string {
  return formatDecimal(price, DEFAULT_PRICE_DECIMALS, 'preserve');
}

/**
 * 计算价格差绝对值（Decimal）。
 *
 * @param currentPrice 当前价格
 * @param submittedPrice 委托价格
 * @returns 绝对价差 Decimal
 */
export function calculatePriceDifference(currentPrice: string, submittedPrice: string): string {
  const difference = exactSubtract(currentPrice, submittedPrice);
  return exactCompare(difference, '0') < 0 ? exactSubtract('0', difference) : difference;
}
