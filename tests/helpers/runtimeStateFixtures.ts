/** 四份独立稳定运行态的测试装配；每份状态仅创建一次，消费者共享原引用。 */
import type { LifecycleMutableState } from '../../src/types/lifecycle.js';
import type { QuoteSubscriptionState } from '../../src/types/quoteSubscription.js';
import type { TradingTimeState } from '../../src/types/timeControlPlane.js';
import type { TradingCalendarState } from '../../src/types/tradingCalendar.js';
import type { RuntimeStateFixtures, RuntimeStateOverrides } from './types.js';

/** 按真实职责创建四个测试状态实例，不提供扁平门面或状态镜像。 */
export function createRuntimeStateFixtures(
  overrides: RuntimeStateOverrides = {},
): RuntimeStateFixtures {
  const tradingTimeState: TradingTimeState = {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    ...overrides.tradingTimeState,
  };
  const lifecycleState: LifecycleMutableState = {
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    ...overrides.lifecycleState,
  };
  const tradingCalendarState: TradingCalendarState = {
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    ...overrides.tradingCalendarState,
  };
  const quoteSubscriptionState: QuoteSubscriptionState = {
    allTradingSymbols: new Set(),
    ...overrides.quoteSubscriptionState,
  };
  return { tradingTimeState, lifecycleState, tradingCalendarState, quoteSubscriptionState };
}
