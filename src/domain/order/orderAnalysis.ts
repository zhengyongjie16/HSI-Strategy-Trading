/** 日损益回算的纯订单分析能力组合；不创建或持有订单事实 owner。 */

import { applyFilteringAlgorithm } from './orderFilteringEngine.js';
import { resolveOrderOwnership } from './orderOwnership.js';
import { classifyAndConvertOrders } from './orderRecordPolicy.js';
import type { OrderDailyLossAnalysisDeps } from './types.js';

/** 日损益使用相同归属和整笔过滤纯规则，不引入第二订单事实 owner。 */
export const orderAnalysis: OrderDailyLossAnalysisDeps = {
  filteringEngine: { applyFilteringAlgorithm },
  resolveOrderOwnership,
  classifyAndConvertOrders,
};
