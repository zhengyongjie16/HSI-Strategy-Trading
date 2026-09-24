/** 生产 post-gate 默认依赖；测试只替换本私有装配模块。 */
import { createTrader } from '../../core/trader/index.js';
import { createMonitorContext } from '../context/createMonitorContext.js';
import { createMixedTradeLogRepository } from '../../services/mixedTradeLogRepository/index.js';

export const DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS = {
  createTrader,
  createMonitorContext,
  createMixedTradeLogRepository,
} as const;
