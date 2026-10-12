import type { MonitorContext, LastState } from '../../../types/state.js';
import type { MarketDataClient, Trader } from '../../../types/services.js';
import type { AccountPositionSnapshotReader } from '../../../types/accountPosition.js';
import type { SettlementFreshnessReader } from '../../../types/settlement.js';
import type { ExecutableSellSignal } from '../../../types/signal.js';
import type { TaskQueue, SellTaskType } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { RuntimeClock, RuntimeScheduler, RuntimeTermination } from '../../../types/runtime.js';

/**
 * 卖出 quote retry 状态。
 * 类型用途：记录单个卖出信号的重试定时器、待重入队信号副本与已重试次数。
 * 数据来源：由 sellProcessor 在行情不足时创建并维护。
 * 使用范围：仅 sellProcessor 模块内部使用。
 */
export type SellRetryState = {
  handle: ReturnType<typeof setTimeout> | null;
  retrySignal: ExecutableSellSignal | null;
  attempts: number;

  /** 原 SELL owner 的交易日；延迟 quote retry 不以新日 token 洗白旧信号。 */
  readonly dayEpoch: number;
};

/**
 * 卖出处理器依赖类型（创建 SellProcessor 时的参数）。
 * 类型用途：创建 SellProcessor 时的依赖注入对象，包含任务队列、唯一监控上下文、信号处理器、交易执行器等。
 * 数据来源：由主程序/启动流程在创建 SellProcessor 时组装并传入工厂。
 * 使用范围：仅 sellProcessor 及启动流程使用，内部使用。
 */
export type SellProcessorDeps = {
  readonly clock: RuntimeClock;
  readonly scheduler: RuntimeScheduler;

  /** 卖出任务队列 */
  readonly taskQueue: TaskQueue<SellTaskType>;

  /** 唯一监控上下文 */
  readonly monitorContext: MonitorContext;

  /** 信号处理器（计算卖出数量） */
  readonly signalProcessor: SignalProcessor;

  /** 交易执行器 */
  readonly trader: Trader;

  /** 行情客户端 */
  readonly marketDataClient: MarketDataClient;

  /** 只读取日历与交易时段标志，不再承载账户或持仓事实。 */
  readonly getLastState: () => Pick<LastState, 'isHalfDay' | 'tradingCalendarSnapshot'>;

  /** 同一 canonical owner 的只读持仓事实与版本授权。 */
  readonly snapshot: Pick<
    AccountPositionSnapshotReader,
    'getView' | 'getAvailablePosition' | 'isCurrent'
  >;

  /** 真实成交后 readiness receipt 等待与复核，不以 Promise<void> 冒充就绪。 */
  readonly postTradeConsistencyRuntime: Pick<
    SettlementFreshnessReader,
    'waitForFresh' | 'isCurrent'
  >;

  /** 生命周期门禁：false 时跳过任务执行 */
  readonly getCanProcessTask: () => boolean;

  /** 非 API 程序错误进入 fatal 通道 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
};
