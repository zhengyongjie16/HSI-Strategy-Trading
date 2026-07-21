/** 生产 pre-gate 默认依赖；测试只替换本私有装配模块。 */
import { createSdkConfigFromAuth } from '../../config/auth/index.js';
import { createMarketDataClient } from '../../services/quoteClient/index.js';

export const DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS = {
  createSdkConfigFromAuth,
  createMarketDataClient,
} as const;
