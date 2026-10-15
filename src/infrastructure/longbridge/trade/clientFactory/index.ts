/**
 * Longbridge 客户端装配工厂。
 * 私有持有唯一 SDK Config，只向 app 返回中性创建能力；不在认证阶段创建行情或交易 context。
 * 行情仍由 pre-gate 创建，交易 context 仍在 createTrader 原 try 内同步延迟创建。
 */
import { createMarketDataClient } from '../../market/quoteClient.js';
import { createBrokerAccessFactory } from '../brokerAccessAdapter.js';
import { createSdkConfigFromAuth } from './sdkConfigFactory.js';
import type { BrokerClientFactory } from '../../../../types/brokerClientFactory.js';
import type { CreateLongbridgeClientFactoryParams } from './types.js';

/** 创建一次认证配置，保留资源获取前的 app termination 检查边界。 */
export async function createLongbridgeClientFactory(
  params: CreateLongbridgeClientFactoryParams,
): Promise<BrokerClientFactory> {
  const config = await createSdkConfigFromAuth(params);
  const { warrantListCacheConfig } = params;

  return {
    createMarketDataClient: () =>
      createMarketDataClient({
        config,
        ...(warrantListCacheConfig === undefined ? {} : { warrantListCacheConfig }),
      }),
    createBrokerAccess: createBrokerAccessFactory(config),
  };
}
