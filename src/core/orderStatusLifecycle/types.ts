/**
 * 订单在本地系统中的生命周期大类。
 * 数据来源：Longbridge SDK OrderStatus 的穷尽分类结果。
 * 使用范围：订单记录、缓存、恢复与监控链路。
 */
export type OrderStatusLifecycle = 'OPEN' | 'TERMINAL';
