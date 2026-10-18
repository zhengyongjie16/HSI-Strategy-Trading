import type { Logger } from '../../types/logger.js';
import type { WarrantCandidateSearch } from '../../application/autoSearch/types.js';
import type { TradingCalendarState } from '../../types/tradingCalendar.js';
import type { RuntimeClock } from '../../types/runtime.js';
import type { TradeRuntime } from '../runtime/types.js';
import type { PreGateRuntime } from '../types.js';
import type { MonitorConfig } from '../../types/config.js';
import type { MonitorSymbolNames } from '../../types/monitor.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { Quote } from '../../types/quote.js';
import type { DailyLossTracker } from '../../types/risk.js';
import type { RiskChecker } from '../../types/riskCheck.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { SeatSwitchWorkflow } from '../../types/seatSwitch.js';
import type { TradingSignalStrategy } from '../../types/strategy.js';
import type { UnrealizedLossMonitor } from '../../types/unrealizedLoss.js';

/**
 * app 内部的唯一监控装配聚合；业务与 runtime 不能导入此类型。
 * 名称字段与 MonitorSymbolNames 是同一对象，不创建镜像；消费方声明实际字段和能力的本地视图。
 */
export type MonitorContextAssembly = MonitorSymbolNames &
  Readonly<{
    config: MonitorConfig;
    symbolRegistry: SymbolRegistry;
    seatSwitch: SeatSwitchWorkflow;
    strategy: TradingSignalStrategy;
    orderRecorder: OrderRecorder;
    dailyLossTracker: DailyLossTracker;
    riskChecker: RiskChecker;
    unrealizedLossMonitor: UnrealizedLossMonitor;
  }>;

/**
 * 监控上下文工厂依赖注入参数。
 * 类型用途：供 createMonitorContext 工厂函数消费，用于构造 app 局部监控装配对象。
 * 数据来源：由 app 顶层装配链路在唯一 monitorContext 创建时传入。
 * 使用范围：仅 app createMonitorContext 使用。
 */
export type MonitorContextFactoryDeps = Readonly<{
  config: MonitorConfig;
  symbolRegistry: SymbolRegistry;
  quotesMap: ReadonlyMap<string, Quote | null> | null;
  strategy: TradingSignalStrategy;
  orderRecorder: OrderRecorder;
  dailyLossTracker: DailyLossTracker;
  riskChecker: RiskChecker;
  unrealizedLossMonitor: UnrealizedLossMonitor;
  seatSwitch: SeatSwitchWorkflow;
}>;

/**
 * 唯一监控上下文装配参数。
 * 类型用途：封装 createMonitorContext 所需的 pre/post gate 运行时对象与启动 quotesMap。
 * 数据来源：由 createPostGateRuntime 在 startup snapshot 前以 quotesMap: null 组装传入；READY 后再同步标的名称。
 * 使用范围：仅唯一 monitorContext 装配链路使用。
 */
export type CreateMonitorContextParams = Readonly<{
  logger: Logger;
  preGateRuntime: PreGateRuntime;
  postGateRuntime: MonitorContextBootstrapRuntime;
  quotesMap: ReadonlyMap<string, Quote | null> | null;
  clock: RuntimeClock;
  strategy: TradingSignalStrategy;
}>;

/**
 * monitorContext 启动装配所需的最小 post-gate 运行时切片。
 * 类型用途：允许在完整 runtime 组装完毕前先创建唯一 monitorContext，并通过工厂返回值收敛到单上下文装配链路。
 * 数据来源：由 createPostGateRuntime 在内部装配点按需组装。
 * 使用范围：仅 createMonitorContext 使用。
 */
type MonitorContextBootstrapRuntime = Readonly<{
  readonly tradeRuntime: Pick<
    TradeRuntime,
    | 'orderRecorder'
    | 'orderExecutor'
    | 'cacheManager'
    | 'orderMonitor'
    | 'orderHoldRegistry'
    | 'accountService'
  >;
  readonly dailyLossTracker: DailyLossTracker;

  /** 与真实 executor 共用的唯一风险检查器，统一持有浮亏 R1/N1 与当日亏损偏移缓存。 */
  readonly riskChecker: RiskChecker;
  readonly candidateSearch: WarrantCandidateSearch;
  readonly tradingCalendarState: Readonly<TradingCalendarState>;
}>;
