import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** settlementFlow 专属 recorder 工厂：真实累计事实/经济 owner，显式同步准入与刷新 sink，不模拟 LOCAL 经济。 */

import { createOrderRecorder } from '../../../../src/application/orderTracking/recorder/index.js';
import type {
  BrokerOrderExecutionFact,
  OrderRecorder,
} from '../../../../src/types/orderRecorder.js';

import type { SettlementRefreshNeedRecorder } from '../../../../src/types/settlement.js';

/** 注入真实 recorder，资源观察可覆盖；经济 commit 总是经真实 owner 与 beforeCommit。 */
export function createSettlementRecorder(
  settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder,
  overrides: Partial<OrderRecorder> = {},
  onCommitted?: (fact: BrokerOrderExecutionFact, relatedBuyOrderIds: ReadonlyArray<string>) => void,
): OrderRecorder {
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: {
      fetchAllOrders: async () => {
        throw new Error('unconfigured settlement recorder snapshot IO');
      },
    },
    settlementRefreshNeedRecorder,
  });
  return {
    ...recorder,
    ...overrides,
    commitExecutionFact: (fact, isLong, relatedBuyOrderIds, beforeCommit) => {
      const previous = recorder.getExecutionFact(fact.brokerOrderId);
      recorder.commitExecutionFact(fact, isLong, relatedBuyOrderIds, beforeCommit);
      // 提交回执已收敛为 void；权威累计事实是否推进以 owner 可观察事实对象的替换为准。
      if (recorder.getExecutionFact(fact.brokerOrderId) !== previous)
        onCommitted?.(fact, relatedBuyOrderIds);
    },
  };
}
