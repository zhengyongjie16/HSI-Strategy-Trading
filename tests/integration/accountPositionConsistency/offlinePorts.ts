/**
 * 中性 integration 离线 broker/限流边界。
 * 不创建 SDK DTO、Decimal 或 context；任何意外 IO 都立即拒绝并可供断言。
 */

import type { OrderRecorderFactoryDeps } from '../../../src/application/orderTracking/recorder/types.js';
import type { SettlementRefreshNeed } from '../../../src/types/settlement.js';
import type { OfflineBrokerPort } from './types.js';

/** 创建只有 IO 外壳的 broker port；domain/recorder 均使用真实实现。 */
export function createOfflineBrokerPort(): OfflineBrokerPort {
  const calls: string[] = [];
  const refreshNeeds: SettlementRefreshNeed[] = [];
  function rejectIO(): Promise<never> {
    calls.push('UNAUTHORIZED_BROKER_IO');
    return Promise.reject(new Error('neutral integration does not authorize broker IO'));
  }
  const broker: OrderRecorderFactoryDeps['orderSnapshotReadPort'] = { fetchAllOrders: rejectIO };
  return {
    broker,
    calls,
    refreshNeeds,
    settlementRefreshNeedRecorder: {
      recordSettlementRefreshNeed: (need) => {
        refreshNeeds.push(need);
      },
    },
  };
}
