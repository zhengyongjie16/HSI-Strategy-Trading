import type { TradeRuntime } from '../../src/app/runtime/types.js';
import type { LifecycleMutableState } from '../../src/types/lifecycle.js';
import type { QuoteSubscriptionState } from '../../src/types/quoteSubscription.js';
import type { TradingTimeState } from '../../src/types/timeControlPlane.js';
import type { TradingCalendarState } from '../../src/types/tradingCalendar.js';

/** 测试装配返回的四个真实状态引用，不向生产消费者提供聚合能力。 */
export type RuntimeStateFixtures = Readonly<{
  tradingTimeState: TradingTimeState;
  lifecycleState: LifecycleMutableState;
  tradingCalendarState: TradingCalendarState;
  quoteSubscriptionState: QuoteSubscriptionState;
}>;

/** 测试只覆盖所在职责的初始事实，不接受历史扁平全局状态。 */
export type RuntimeStateOverrides = Readonly<{
  tradingTimeState?: Partial<TradingTimeState>;
  lifecycleState?: Partial<LifecycleMutableState>;
  tradingCalendarState?: Partial<TradingCalendarState>;
  quoteSubscriptionState?: Partial<QuoteSubscriptionState>;
}>;

/** 测试按六个真实实例覆盖能力，不支持历史逐方法门面字段。 */
export type TradeRuntimeOverrides = {
  readonly [K in keyof TradeRuntime]?: Partial<TradeRuntime[K]>;
};
