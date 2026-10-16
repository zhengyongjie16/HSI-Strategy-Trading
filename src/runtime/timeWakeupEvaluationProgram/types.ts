import type { DoomsdayOrderCancellation } from '../../types/orderCancellation.js';
import type { OrderCacheManager } from '../../application/orderTracking/types.js';
import type { DoomsdaySignalExecutor } from '../../types/orderExecutionPorts.js';
import type { TradingSignalStrategy } from '../../types/strategy.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { SeatSwitchWorkflow } from '../../types/seatSwitch.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MonitorConfig, TradingConfig } from '../../types/config.js';
import type { TradingCalendarState } from '../../types/tradingCalendar.js';
import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type {
  TradingTimeState,
  DayLifecycleManager,
  TradingGatePublisher,
} from '../../types/timeControlPlane.js';
import type { DoomsdayClearanceWorkflow } from '../../application/doomsdayClearance/types.js';
import type { AccountPositionSnapshot } from '../../types/accountPosition.js';

import type { MarketDataClient } from '../../types/marketPorts.js';

import type { TimeWakeupPlan } from '../timeWakeupPlanner/types.js';
import type { Logger } from '../../types/logger.js';

/**
 * 单次时间唤醒评估结果。
 * 类型用途：向 TimeWakeupRuntime 暴露下一次系统级 one-shot 唤醒计划。
 * 数据来源：timeWakeupEvaluationProgram 汇总生命周期、末日保护与交易边界候选后生成。
 * 使用范围：TimeWakeupRuntime 调度下一次时间评估。
 */
export type TimeWakeupEvaluationResult = Readonly<{
  plan: TimeWakeupPlan;
}>;

/**
 * 单次时间唤醒评估上下文。
 * 类型用途：承载 timeWakeupEvaluationProgram 运行所需的全部依赖。
 * 数据来源：app 装配层在启动时组装并注入。
 * 使用范围：仅 timeWakeupEvaluationProgram 及 TimeWakeupRuntime 调用链内部使用。
 */
export type TimeWakeupEvaluationContext = Readonly<{
  logger: Pick<Logger, 'info' | 'warn'>;
  marketDataClient: MarketDataClient;
  readonly orderExecutor: DoomsdaySignalExecutor;
  readonly cacheManager: Pick<OrderCacheManager, 'getPendingOrders'>;
  readonly orderMonitor: DoomsdayOrderCancellation;
  readonly tradingTimeState: TradingTimeState;
  readonly lifecycleState: LifecycleMutableState;
  readonly tradingCalendarState: TradingCalendarState;

  /** 唯一 canonical owner；持仓只读，账户失效由 doomsday 原 all-success/live 分支授权。 */
  snapshot: Pick<AccountPositionSnapshot, 'getView' | 'invalidateAccount'>;
  doomsdayClearanceWorkflow: Pick<DoomsdayClearanceWorkflow, 'evaluate'>;
  tradingConfig: TradingConfig;
  monitorContext: {
    readonly config: MonitorConfig;
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly seatSwitch: SeatSwitchWorkflow;
    readonly orderRecorder: OrderRecorder;
    readonly strategy: Pick<TradingSignalStrategy, 'invalidateAll'>;
  };
  tradingGateEventRuntime: TradingGatePublisher;
  dayLifecycleManager: DayLifecycleManager;
  now: () => Date;
}>;
