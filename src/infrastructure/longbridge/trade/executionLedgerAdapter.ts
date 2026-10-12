/** 同一交易context的execution流水IO边界，不持有消费账、canonical状态或业务重试。 */
import type { TradeContext } from 'longbridge';
import type { OrderExecutionLedgerPort } from '../../../types/orderExecutionLedger.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapBrokerExecutions } from './orderMapper.js';

/**
 * 创建只产中性原始execution事实的读取能力。
 * @param context 唯一注入context的实际execution能力
 * @returns 原调用owner按原授权、限流和错误策略使用的读port
 */
export function createExecutionLedgerAdapter(context: unknown): OrderExecutionLedgerPort {
  if (
    !isRecord(context) ||
    typeof context['todayExecutions'] !== 'function' ||
    typeof context['historyExecutions'] !== 'function'
  ) {
    throw new TypeError('[ExecutionLedgerAdapter] missing injected SDK executions capability');
  }

  const ctx = context as Pick<TradeContext, 'todayExecutions' | 'historyExecutions'>;
  return {
    todayExecutions: async (params) => mapBrokerExecutions(await ctx.todayExecutions(params)),
    historyExecutions: async (params) => mapBrokerExecutions(await ctx.historyExecutions(params)),
  };
}
