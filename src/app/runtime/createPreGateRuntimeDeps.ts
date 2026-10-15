/** 生产 pre-gate 默认依赖；测试只替换本私有装配模块。 */
import { createLongbridgeClientFactory } from '../../infrastructure/longbridge/trade/clientFactory/index.js';

export const DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS = {
  createLongbridgeClientFactory,
} as const;
