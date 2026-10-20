/** 单 owner 测试重算：完整 prepare 成功后才 publish，生产启动/席位仍分别协调两阶段提交。 */
import type { DailyLossTracker } from '../../src/types/risk.js';

/** 保留既有测试的重算输入与断言，不向生产接口添加即时提交能力。 */
export function recalculateDailyLoss(
  owner: DailyLossTracker,
  ...args: Parameters<DailyLossTracker['prepareRecalculationFromAllOrders']>
): void {
  owner.publishRecalculation(owner.prepareRecalculationFromAllOrders(...args));
}
