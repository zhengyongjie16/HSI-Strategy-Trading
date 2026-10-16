import { wrapExternalApiRequest } from '../../externalApi/index.js';

/**
 * SELL执行前权威可卖量读取SDK边界，使用唯一注入的context，金融字段通过既有mapper保真。
 * caller已持真实授权并完成限流；本窄读不另排队或重试，避免在授权等待之后启动旧请求。
 */
import type { TradeContext } from 'longbridge';
import type { Position } from '../../../types/account.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapStockPositions } from './accountMapper.js';

/**
 * 为实际数量owner装配直接权威读，不提交canonical事实或登记Sstale。
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
    return mapStockPositions(response);
  };
}
