/** 已明确 broker 业务拒绝的日志记录；不拥有 submit 重试、UNKNOWN 收口或交易目的判定。 */
import { logger } from '../../utils/logger/index.js';
import type { Signal } from '../../types/signal.js';
import type { ErrorTypeIdentifier } from './types.js';
import type { TradeSubmitCommand } from '../../types/tradeMutationPorts.js';
import { formatError } from '../../utils/error/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { getActionDescription } from '../../domain/order/executionPolicy.js';

/**
 * 识别错误类型（通过错误消息关键词匹配）。
 *
 * @param errorMessage 错误消息原文（将转为小写后匹配关键词）
 * @returns 错误类型标识对象，各布尔字段表示是否匹配对应类型
 */
function identifyErrorType(errorMessage: string): ErrorTypeIdentifier {
  const lowerMsg = errorMessage.toLowerCase();
  return {
    isShortSellingNotSupported:
      lowerMsg.includes('does not support short selling') ||
      lowerMsg.includes('不支持做空') ||
      lowerMsg.includes('short selling') ||
      lowerMsg.includes('做空'),
    isInsufficientFunds:
      lowerMsg.includes('insufficient') ||
      lowerMsg.includes('资金不足') ||
      lowerMsg.includes('余额不足'),
    isNetworkError:
      lowerMsg.includes('network') ||
      lowerMsg.includes('网络') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时'),
    isRateLimited:
      lowerMsg.includes('rate limit') || lowerMsg.includes('频率') || lowerMsg.includes('too many'),
  };
}

/**
 * 分类记录订单提交错误日志。
 *
 * @param err 原始错误对象
 * @param signal 交易信号
 * @param orderPayload 订单提交载荷
 * @returns 无返回值
 */
export function handleSubmitError(
  err: unknown,
  signal: Signal,
  orderPayload: TradeSubmitCommand,
): void {
  const actionDesc = getActionDescription(signal.action);
  const errorMessage = formatError(err);
  const errorType = identifyErrorType(errorMessage);
  const symbolDisplayForError = formatSymbolDisplay(orderPayload.symbol, signal.symbolName ?? null);
  if (errorType.isShortSellingNotSupported) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：该标的不支持做空交易`,
      errorMessage,
    );

    logger.warn(
      `[做空错误提示] 标的 ${symbolDisplayForError} 不支持做空交易。可能的原因：\n` +
        '  1. 该标的在港股市场不支持做空\n' +
        '  2. 账户没有做空权限\n' +
        '  3. 需要更换其他支持做空的标的\n' +
        '  建议：检查配置中的 SHORT_SYMBOL 环境变量，或联系券商确认账户做空权限',
    );
  } else if (errorType.isInsufficientFunds) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：账户资金不足`,
      errorMessage,
    );
  } else if (errorType.isNetworkError) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：网络异常，请检查连接`,
      errorMessage,
    );
  } else if (errorType.isRateLimited) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：API 调用频率超限`,
      errorMessage,
    );
  } else {
    logger.error(`[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：`, errorMessage);
  }
}
