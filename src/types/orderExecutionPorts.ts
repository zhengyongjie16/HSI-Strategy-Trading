import type { Trader } from './services.js';

/**
 * 共享订单执行的中性行为契约。
 * 数据来源：app composition 创建的唯一 application executor，与旧 tracking 绑定同一订单事实。
 * 使用范围：旧 Trader 只消费执行与节流清理能力，不导入或创建 application owner。
 */
export interface OrderExecutor extends Pick<
  Trader,
  'canTradeNow' | 'executeSignals' | 'executeDoomsdayClearanceSignals'
> {
  readonly resetBuyThrottle: () => void;
}
