/** 中性 integration 的离线 IO 边界和只读调用观测，不包含业务 owner 替身。 */

import type { OrderRecorderFactoryDeps } from '../../../src/application/orderTracking/recorder/types.js';
import type {
  SettlementRefreshNeed,
  SettlementRefreshNeedRecorder,
} from '../../../src/types/settlement.js';

export type OfflineBrokerPort = {
  readonly broker: OrderRecorderFactoryDeps['orderSnapshotReadPort'];
  readonly calls: ReadonlyArray<string>;
  readonly refreshNeeds: ReadonlyArray<SettlementRefreshNeed>;
  readonly settlementRefreshNeedRecorder: SettlementRefreshNeedRecorder;
};
