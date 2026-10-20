import type { BrokerAccess } from './brokerAccessPorts.js';
import type { MarketDataClient } from './marketPorts.js';

/**
 * 券商客户端的中性创建能力。
 * 数据来源：infrastructure 工厂私有捕获同一份认证配置，行情与交易资源仍由各自阶段创建。
 * 使用范围：app pre/post-gate 装配；不暴露 SDK Config、context 或认证句柄。
 */
export interface BrokerClientFactory {
  readonly createMarketDataClient: () => Promise<MarketDataClient>;
  readonly createBrokerAccess: () => BrokerAccess;
}
