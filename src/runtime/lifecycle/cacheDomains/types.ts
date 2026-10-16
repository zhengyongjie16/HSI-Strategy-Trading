import type { OrderExecutor } from '../../../types/orderExecutionPorts.js';
import type {
  OrderMonitor,
  OrderHoldRegistry,
  OrderCacheManager,
} from '../../../application/orderTracking/types.js';

import type { OrderRecorder } from '../../../types/orderRecorder.js';
import type { OrderTrackingLifecycle } from '../../../types/orderTracking.js';
import type { RiskChecker } from '../../../types/riskCheck.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { TradingSignalStrategy } from '../../../types/strategy.js';
import type { QuoteSubscriptionState } from '../../../types/quoteSubscription.js';
import type { TradingCalendarState } from '../../../types/tradingCalendar.js';
import type { TradingTimeState } from '../../../types/timeControlPlane.js';
import type { RuntimeTermination } from '../../../types/runtime.js';
import type { AccountPositionSnapshot } from '../../../types/accountPosition.js';
import type { TradingDayOpenRebuildResult } from '../../../application/tradingDayRebuild/types.js';
import type { SymbolRegistry } from '../../../types/seat.js';
import type { MarketDataClient, WarrantListCacheClearer } from '../../../types/marketPorts.js';
import type { SeatSwitchWorkflow } from '../../../types/seatSwitch.js';
import type { Processor } from '../../asyncProgram/types.js';
import type {
  TaskQueue,
  BuyTaskType,
  SellTaskType,
} from '../../asyncProgram/tradeTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../../asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../../asyncProgram/monitorTaskQueue/types.js';
import type { TradingRiskEventRuntime } from '../../tradingRiskEventRuntime/types.js';
import type { BusinessEventProgram } from '../../businessEventProgram/types.js';
import type {
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../../monitorQuoteEventRuntime/types.js';
import type { MonitorDisplayRuntime } from '../../monitorDisplayRuntime/types.js';
import type { TradingQuoteDisplayRuntime } from '../../tradingQuoteDisplayRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../periodicSwitchWakeupRuntime/types.js';
import type { QuoteSubscriptionRuntime } from '../../quoteSubscriptionRuntime/types.js';
import type { AutoSearchWakeupRuntime } from '../../autoSearchWakeupRuntime/types.js';
import type { SeatActivationDispatcher } from '../../seatActivationDispatcher/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../../seatRuntimeCleanupDispatcher/types.js';
import type { OrdinaryBuyWorkflow } from '../../../application/ordinaryBuy/types.js';
import type { DailyLossTracker } from '../../../types/risk.js';
import type { LiquidationCooldownTracker } from '../../../domain/liquidation/cooldown/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../../domain/liquidation/episode/types.js';
import type { Logger } from '../../../types/logger.js';

/**
 * lifecycle 持有的成交后一致性 runtime 最小契约。
 * 类型用途：约束 signalRuntimeDomain 在生命周期切换时对 runtime 的启停与 baseline 推进能力。
 * 数据来源：由 app 层注入 PostTradeConsistencyRuntime 实例。
 * 使用范围：仅 lifecycle signalRuntimeDomain 使用。
 */
interface SignalRuntimePostTradeConsistencyRuntime {
  readonly abortWaiting: () => void;
  readonly resetAbort: () => void;
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly midnightClear: () => void;
  readonly completeRebuildBaseline: () => Promise<boolean>;
}

/**
 * 信号运行时域依赖。
 * 类型用途：createSignalRuntimeDomain 的入参，提供监控上下文、订单监控 runtime、买卖/监控处理器、runtime 所有权与队列等。
 * 数据来源：由 lifecycle 或主程序在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface SignalRuntimeDomainDeps {
  readonly termination: Pick<RuntimeTermination, 'isTerminated'>;
  readonly logger: Pick<Logger, 'debug'>;
  readonly monitorContext: { readonly strategy: Pick<TradingSignalStrategy, 'resetForTradingDay'> };
  readonly buyProcessor: Processor;
  readonly sellProcessor: Processor;
  readonly monitorTaskProcessor: MonitorTaskProcessor;
  readonly businessEventProgram: Pick<BusinessEventProgram, 'start' | 'stopAndDrain'>;
  readonly tradingRiskEventRuntime: Pick<TradingRiskEventRuntime, 'start' | 'stopAndDrain'>;
  readonly monitorQuoteEventRuntime: MonitorQuoteEventRuntime;
  readonly monitorDisplayRuntime: Pick<MonitorDisplayRuntime, 'start' | 'stopAndDrain'>;
  readonly tradingQuoteDisplayRuntime: Pick<TradingQuoteDisplayRuntime, 'start' | 'stopAndDrain'>;
  readonly switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'start' | 'stopAndDrain'>;
  readonly periodicSwitchWakeupRuntime: Pick<PeriodicSwitchWakeupRuntime, 'start' | 'stopAndDrain'>;
  readonly quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'reconcileFromCurrentTruth' | 'start' | 'stopAndDrain'
  >;
  readonly autoSearchWakeupRuntime: Pick<AutoSearchWakeupRuntime, 'start' | 'stopAndDrain'>;
  readonly seatActivationDispatcher: Pick<SeatActivationDispatcher, 'start' | 'stop'>;
  readonly seatRuntimeCleanupDispatcher: Pick<SeatRuntimeCleanupDispatcher, 'start' | 'stop'>;
  readonly orderMonitor: Pick<OrderTrackingLifecycle, 'startRuntime' | 'stopRuntimeAndDrain'>;
  readonly postTradeConsistencyRuntime: SignalRuntimePostTradeConsistencyRuntime;
  readonly buyTaskQueue: TaskQueue<BuyTaskType>;
  readonly sellTaskQueue: TaskQueue<SellTaskType>;
  readonly monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}

/**
 * 席位域依赖。
 * 类型用途：createSeatDomain 的入参，只提供午夜席位清理实际需要的 symbolRegistry、自动换标状态重置与轮证缓存清理能力。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface SeatDomainDeps {
  readonly logger: Pick<Logger, 'debug'>;
  readonly symbolRegistry: SymbolRegistry;
  readonly seatSwitch: Pick<SeatSwitchWorkflow, 'resetAllState'>;
  readonly warrantListCache: WarrantListCacheClearer;
}

/**
 * 订单域依赖。
 * 类型用途：createOrderDomain 的入参，提供 trader.resetRuntimeState 用于午夜清理时重置运行时状态。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface OrderDomainDeps {
  readonly logger: Pick<Logger, 'debug'>;
  readonly orderRecorder: Pick<OrderRecorder, 'resetAll'>;
  readonly cacheManager: Pick<OrderCacheManager, 'clearCache'>;
  readonly orderHoldRegistry: Pick<OrderHoldRegistry, 'clear'>;
  readonly orderMonitor: Pick<OrderMonitor, 'clearTrackedOrders'>;
  readonly orderExecutor: Pick<OrderExecutor, 'resetBuyThrottle'>;
}

/**
 * 风险域依赖。
 * 类型用途：createRiskDomain 的入参，提供普通 BUY 冷却清理、dailyLossTracker、monitorContext、liquidationCooldownTracker。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时组装传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface RiskDomainDeps {
  readonly logger: Pick<Logger, 'debug'>;
  readonly ordinaryBuy: Pick<OrdinaryBuyWorkflow, 'resetRiskCheckCooldown'>;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly monitorContext: { readonly config: MonitorConfig; readonly riskChecker: RiskChecker };
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
}

/**
 * 行情数据域依赖。
 * 类型用途：createMarketDataDomain 的入参，提供 marketDataClient 用于午夜清理时重置订阅与缓存。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface MarketDataDomainDeps {
  readonly logger: Pick<Logger, 'debug'>;
  readonly marketDataClient: MarketDataClient;
}

/**
 * 全局状态域依赖。
 * 类型用途：createGlobalStateDomain 的入参，提供 lastState 与 runTradingDayOpenRebuild 用于午夜清理与开盘重建。
 * 数据来源：由 lifecycle 在注册 cacheDomains 时传入。
 * 使用范围：仅 lifecycle 模块使用。
 */
export interface GlobalStateDomainDeps {
  readonly snapshot: Pick<AccountPositionSnapshot, 'getStatus' | 'requestClear' | 'isCurrent'>;
  readonly logger: Pick<Logger, 'debug'>;
  readonly tradingTimeState: TradingTimeState;
  readonly tradingCalendarState: TradingCalendarState;
  readonly quoteSubscriptionState: QuoteSubscriptionState;
  readonly runTradingDayOpenRebuild: (now: Date) => Promise<TradingDayOpenRebuildResult>;
}
