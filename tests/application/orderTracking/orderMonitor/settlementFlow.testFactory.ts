import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** settlementFlow 专属 recorder 工厂：真实累计事实/经济 owner，显式同步准入与刷新 sink，不模拟 LOCAL 经济。 */

import { createOrderRecorder } from '../../../../src/application/orderTracking/recorder/index.js';
import type {
  BrokerOrderExecutionFact,
  OrderExecutionTimeEvidence,
  OrderRecorder,
} from '../../../../src/types/orderRecorder.js';

import type { SettlementRefreshNeedRecorder } from '../../../../src/types/settlement.js';

/** 注入真实 recorder，资源观察可覆盖；经济 commit 总是经真实 owner 与 beforeCommit。 */
export function createSettlementRecorder(
  settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder,
  overrides: Partial<OrderRecorder> = {},
  onCommitted?: (fact: BrokerOrderExecutionFact, relatedBuyOrderIds: ReadonlyArray<string>) => void,
  getExecutionTimeEvidence: () => ReadonlyArray<OrderExecutionTimeEvidence> = () => [],
): OrderRecorder {
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: {
      fetchSnapshots: async () => {
        throw new Error('unconfigured settlement recorder snapshot IO');
      },
    },
    getExecutionTimeEvidence,
    settlementRefreshNeedRecorder,
  });
  return {
    ...recorder,
    ...overrides,
    commitExecutionFact: (fact, isLong, relatedBuyOrderIds, beforeCommit) => {
      const receipt = recorder.commitExecutionFact(fact, isLong, relatedBuyOrderIds, beforeCommit);
      if (receipt.authoritativeFactChanged) onCommitted?.(fact, relatedBuyOrderIds);

      return receipt;
    },
  };
}
