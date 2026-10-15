/** 已明确 broker 拒绝的日志记录；只消费中性 result，不匹配 SDK 文本或决定 retry/UNKNOWN 行为。 */
import { logger } from '../../utils/logger/index.js';
import type { Signal } from '../../types/signal.js';
import type { TradeSubmitCommand, TradeSubmitResult } from '../../types/tradeMutationPorts.js';
import { formatError } from '../../utils/error/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { getActionDescription } from '../../domain/order/executionPolicy.js';

/** 记录 adapter 已证明的业务拒绝，原 cause 仅作诊断内容，不参与业务分支。 */
export function handleSubmitError(
  result: Extract<TradeSubmitResult, { readonly kind: 'REJECTED' }>,
  signal: Signal,
  orderPayload: TradeSubmitCommand,
): void {
  const action = getActionDescription(signal.action);
  const symbol = formatSymbolDisplay(orderPayload.symbol, signal.symbolName ?? null);
  logger.error(
    `[订单提交失败] ${action} ${symbol} broker 拒绝，code=${result.code ?? 'null'} purpose=${orderPayload.purpose}`,
    formatError(result.cause),
  );
}
