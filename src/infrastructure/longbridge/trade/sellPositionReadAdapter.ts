import { wrapExternalApiRequest } from '../../externalApi/index.js';

/**
 * SELL执行前权威可卖量读取SDK边界，使用唯一注入的context，金融字段通过既有mapper保真。
 * caller已持真实授权并完成限流；本窄读不另排队或重试，避免在授权等待之后启动旧请求。
 */
import type { TradeContext } from 'longbridge';
import type { Position } from '../../../types/account.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { safeQuantityNumber } from '../../../utils/numeric/exact.js';
import { mapStockPositions } from './accountMapper.js';

/**
 * 为实际数量owner装配直接权威读，不提交canonical事实或登记Sstale。
 * 账户读取允许小数，但卖出目标必须是原始文本可证明的非负安全整数：
 * number 投影会把 99.99999999999999999 变成 100，不能在卖出边界沿用该近似。
 * 非目标持仓及名称为空的结算残留不参与本次严格校验，避免阻断港股卖出。
 * @param context 同一真实交易context的stockPositions能力
 * @returns 只返回中性持仓事实的单次读取能力
 */
export function createSellPositionReadAdapter(
  context: unknown,
): (symbol: string) => Promise<ReadonlyArray<Position>> {
  if (!isRecord(context) || typeof context['stockPositions'] !== 'function') {
    throw new TypeError('[SellPositionReadAdapter] missing injected SDK positions capability');
  }

  const ctx = context as Pick<TradeContext, 'stockPositions'>;
  return async (symbol) => {
    const response = await wrapExternalApiRequest({
      operation: 'TradeContext.stockPositions',
      request: () => ctx.stockPositions([symbol]),
      retryConfig: { retries: 0, delayMs: 0 },
    });

    for (const channel of response.channels) {
      for (const position of channel.positions) {
        if (position.symbol !== symbol || position.symbolName === '') continue;

        safeQuantityNumber(position.quantity.toString());
        safeQuantityNumber(position.availableQuantity.toString());
      }
    }

    return mapStockPositions(response);
  };
}
