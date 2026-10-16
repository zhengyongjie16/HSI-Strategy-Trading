import type { OrderTrackingLifecycle } from '../../../types/orderTracking.js';
import type { LifecycleMutableState } from '../../../types/lifecycle.js';
import type { RuntimeTermination } from '../../../types/runtime.js';
import type { Processor } from '../../asyncProgram/types.js';
import type { MonitorTaskProcessor } from '../../asyncProgram/monitorTaskProcessor/types.js';
import type { BusinessEventProgram } from '../../businessEventProgram/types.js';
import type { TradingRiskEventRuntime } from '../../tradingRiskEventRuntime/types.js';
import type {
  MonitorQuoteEventRuntime,
  SwitchWakeupRuntime,
} from '../../monitorQuoteEventRuntime/types.js';
import type { MonitorDisplayRuntime } from '../../monitorDisplayRuntime/types.js';
import type { TradingQuoteDisplayRuntime } from '../../tradingQuoteDisplayRuntime/types.js';
import type { QuoteSubscriptionRuntime } from '../../quoteSubscriptionRuntime/types.js';
import type { SeatRuntimeCleanupDispatcher } from '../../seatRuntimeCleanupDispatcher/types.js';
import type { SeatActivationDispatcher } from '../../seatActivationDispatcher/types.js';
import type { AutoSearchWakeupRuntime } from '../../autoSearchWakeupRuntime/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../periodicSwitchWakeupRuntime/types.js';
import type { TimeWakeupRuntime } from '../../timeWakeupRuntime/types.js';

/**
 * 启动重建完成后的具体 runtime 启动能力。
 * 数据来源：composition root 注入已创建的真实 owner 与初次重建结果。
 * 使用范围：仅 startRuntimeAfterStartupRebuild；不包含重建用例、午夜 drain 或最终 cleanup。
 */
export interface StartRuntimeAfterStartupRebuildParams {
  readonly termination: Pick<RuntimeTermination, 'isTerminated'>;
  readonly initialRebuildSucceeded: boolean;
  readonly startupTradingEnabled: boolean;
  readonly lifecycleState: Pick<LifecycleMutableState, 'isTradingEnabled'>;
  readonly tradingQuoteDisplayRuntime: Pick<TradingQuoteDisplayRuntime, 'start'>;
  readonly quoteSubscriptionRuntime: Pick<QuoteSubscriptionRuntime, 'start'>;
  readonly seatRuntimeCleanupDispatcher: Pick<SeatRuntimeCleanupDispatcher, 'start'>;
  readonly seatActivationDispatcher: Pick<SeatActivationDispatcher, 'start'>;
  readonly autoSearchWakeupRuntime: Pick<AutoSearchWakeupRuntime, 'start'>;
  readonly periodicSwitchWakeupRuntime: Pick<PeriodicSwitchWakeupRuntime, 'start'>;
  readonly monitorDisplayRuntime: Pick<MonitorDisplayRuntime, 'start'>;
  readonly tradingRiskEventRuntime: Pick<TradingRiskEventRuntime, 'start'>;
  readonly monitorQuoteEventRuntime: Pick<MonitorQuoteEventRuntime, 'start'>;
  readonly switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'start'>;
  readonly monitorTaskProcessor: Pick<MonitorTaskProcessor, 'start'>;
  readonly buyProcessor: Pick<Processor, 'start'>;
  readonly sellProcessor: Pick<Processor, 'start'>;
  readonly orderMonitor: Pick<OrderTrackingLifecycle, 'startRuntime'>;
  readonly timeWakeupRuntime: Pick<TimeWakeupRuntime, 'start'>;
  readonly businessEventProgram: Pick<BusinessEventProgram, 'start'>;
}
