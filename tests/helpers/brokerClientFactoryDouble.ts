/**
 * app 客户端工厂测试替身。
 * 职责：为 pre/post-gate 测试提供不含 SDK Config 的中性客户端能力。
 */
import type { BrokerClientFactory } from '../../src/types/brokerClientFactory.js';
import { createMarketDataClientDouble } from './testDoubles.js';

/**
 * 创建 app 使用的客户端工厂替身。
 * @param overrides 用例提供的中性客户端能力覆盖项
 * @returns 不暴露 SDK Config 的客户端工厂
 */
export function createBrokerClientFactoryDouble(
  overrides: Partial<BrokerClientFactory> = {},
): BrokerClientFactory {
  return {
    createMarketDataClient: async () => createMarketDataClientDouble(),
    createBrokerAccess: () => {
      throw new Error('broker client double requires an injected createBrokerAccess');
    },
    ...overrides,
  };
}
