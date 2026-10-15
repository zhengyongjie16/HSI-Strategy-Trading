/** 下单分阶段故障的离线 SDK 边界：保留真实序列化与 native issued 计数，仅公开中性能力。 */
import type { SubmitOrderOptions } from 'longbridge';
import type { Position } from '../../../../src/types/account.js';
import type { TradeMutationPort } from '../../../../src/types/tradeMutationPorts.js';
import { createTradeMutationAdapter } from '../../../../src/infrastructure/longbridge/trade/tradeMutationAdapter.js';
import { createSellPositionReadAdapter } from '../../../../src/infrastructure/longbridge/trade/sellPositionReadAdapter.js';
import { createStockPositionsResponse } from '../../../../mock/factories/tradeFactory.js';

/** 在真实 adapter 发起 native submit 后调用无参数行为 hook，不向 core 泄漏 SDK 参数。 */
export function createSubmitFlowFailureFixture(
  submitOrder?: () => Promise<{ readonly orderId: string }>,
): Readonly<{
  tradeMutationPort: TradeMutationPort;
  readSellPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
  submitCallCount: () => number;
}> {
  let submitCallCount = 0;
  const context = {
    submitOrder: async (_options: SubmitOrderOptions): Promise<{ readonly orderId: string }> => {
      submitCallCount += 1;
      return submitOrder ? submitOrder() : { orderId: 'ORDER-1' };
    },
    stockPositions: async () =>
      createStockPositionsResponse({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
    replaceOrder: async () => {},
  };
  return {
    tradeMutationPort: createTradeMutationAdapter(context),
    readSellPositions: createSellPositionReadAdapter(context),
    submitCallCount: () => submitCallCount,
  };
}
