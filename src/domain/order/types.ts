import type { OrderRecord } from '../../types/services.js';

/**
 * 订单过滤算法的中间状态类型。
 * 类型用途：OrderFilteringEngine 过滤算法中的中间结构（m0Orders 保留，candidateOrders 待过滤）。
 * 数据来源：模块内部在 applyFilteringAlgorithm 中构造。
 * 使用范围：仅 domain/order 过滤算法内部使用。
 */
export type FilteringState = {
  readonly m0Orders: ReadonlyArray<OrderRecord>;
  readonly candidateOrders: ReadonlyArray<OrderRecord>;
};
