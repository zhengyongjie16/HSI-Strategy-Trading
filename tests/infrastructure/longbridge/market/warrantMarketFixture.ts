/** 轮证请求的真实默认行情入口 fixture：SDK Config/client 装配私有，仅输出中性 port 与原生请求 controller。 */
import { createMarketDataClient } from '../../../../src/infrastructure/longbridge/market/quoteClient.js';
import type { MarketQuoteContext } from '../../../../src/types/marketPorts.js';
import { installNativeWarrantRequestFixture } from './warrantRequestFixture.js';

/** 默认 SDK factory 与真实 client 在同一 infra 边界闭合；装配失败也恢复原离线 SDK 基线。 */
export async function createNativeWarrantMarketFixture(): Promise<{
  readonly port: MarketQuoteContext;
  readonly controller: ReturnType<typeof installNativeWarrantRequestFixture>;
}> {
  const controller = installNativeWarrantRequestFixture();
  try {
    const client = await createMarketDataClient({
      config: {
        refreshAccessToken: () => {
          throw new Error('offline warrant fixture cannot refresh SDK credentials');
        },
      },
    });
    const port = await client.getQuoteContext();
    return { port, controller };
  } catch (error) {
    controller.restore();
    throw error;
  }
}
