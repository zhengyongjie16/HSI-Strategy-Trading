/** 将中性 mutation UNKNOWN 保留为 fatal 错误，不解析 SDK 原因或赋予重评估语义。 */
import type {
  TradeMutationUnknownError,
  TradeReplaceResult,
  TradeSubmitResult,
  TradeCancelResult,
  AcceptedOrderLocalSyncError,
} from '../../types/tradeMutationPorts.js';
import { formatError } from '../error/index.js';

/**
 * 保留已接受订单身份和本地失败原因，阻止同一命令被视为未提交而重新发起。
 * @param orderId broker 已接受的订单 ID
 * @param cause 本地 tracking/记录同步失败原因
 * @returns 带 orderId 与请求证据的致命错误
 */
export function createAcceptedOrderLocalSyncError(
  orderId: string,
  cause: unknown,
): AcceptedOrderLocalSyncError {
  return Object.assign(new Error(`order submitted but local sync failed: ${orderId}`, { cause }), {
    name: 'AcceptedOrderLocalSyncError' as const,
    operation: 'TradeContext.submitOrder' as const,
    requestAttempted: true as const,
    orderId,
    cause,
  });
}

/**
 * 保留已发出 mutation 的 UNKNOWN 原始证据并构造 fatal 错误。
 * @param result adapter 返回的 UNKNOWN 中性结果
 * @returns 带 operation、requestAttempted、code 与 cause 的致命错误
 */
export function createTradeMutationUnknownError(
  result:
    | Extract<TradeSubmitResult, { readonly kind: 'UNKNOWN' }>
    | Extract<TradeReplaceResult, { readonly kind: 'UNKNOWN' }>
    | Extract<TradeCancelResult, { readonly kind: 'UNKNOWN' }>,
): TradeMutationUnknownError {
  const causeMessage = formatError(result.cause);
  const operationPrefix =
    result.operation === 'TradeContext.cancelOrder'
      ? '[撤单失败/终态未确认]'
      : '[交易请求结果不可确认]';
  return Object.assign(
    new Error(`${operationPrefix} operation=${result.operation}: ${causeMessage}`, {
      cause: result.cause,
    }),
    {
      name: 'TradeMutationUnknownError' as const,
      operation: result.operation,
      requestAttempted: result.requestAttempted,
      code: result.code,
      cause: result.cause,
    },
  );
}
