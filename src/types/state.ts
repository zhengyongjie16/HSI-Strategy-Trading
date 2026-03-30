import type { SignalType, Signal } from './signal.js';
import type { MonitorValues } from './data.js';
import type { IndicatorSnapshot } from './quote.js';
import type { AccountSnapshot, Position } from './account.js';
import type { StrategyRuntimeConfig } from './config.js';
import type { SeatState, SymbolRegistry, LifecycleState } from './seat.js';
import type { PositionCache, RiskChecker, TradingDayInfo } from './services.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from './risk.js';
import type { DisplayIndicatorItem, IndicatorDisplayProfile } from './indicatorProfile.js';
import type { AutoSymbolManagerPort } from './strategyRuntimePorts.js';
import type { TradingSignalStrategy } from '../core/strategy/types.js';

/**
 * 单实例策略状态。
 * 类型用途：承载基础对象价格、双席位价格、当前信号与指标快照等运行态数据，在主循环中持续更新。
 * 数据来源：主循环/processMonitor 根据行情与策略输出更新。
 * 使用范围：LastState、StrategyRuntime、主循环、pipeline 等；全项目可引用。
 */
export type StrategyState = {
  /** 监控标的代码 */
  readonly baseInstrumentSymbol: string;

  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - monitorPrice/longPrice/shortPrice/signal/pendingSignals/monitorValues
   * - lastMonitorSnapshot/lastCandlestickCacheVersion/displayPlan
   */
  /** 监控标的当前价格 */
  monitorPrice: number | null;

  /** 做多标的当前价格 */
  longPrice: number | null;

  /** 做空标的当前价格 */
  shortPrice: number | null;

  /** 当前信号 */
  signal: SignalType | null;

  /** 待处理的信号缓冲（单实例路径当前仅用于状态收敛与生命周期清理） */
  pendingSignals: ReadonlyArray<Signal>;

  /** 监控指标值 */
  monitorValues: MonitorValues | null;

  /** 最新指标快照 */
  lastMonitorSnapshot: IndicatorSnapshot | null;

  /** 最新已消费的 K 线缓存版本（用于 pipeline 主短路） */
  lastCandlestickCacheVersion: number | null;

  /** 最近一次对外展示的签名（用于 factor 展示变化检测） */
  lastDisplaySignature?: string | null;

  /** 展示层使用的指标展示计划 */
  displayPlan?: ReadonlyArray<DisplayIndicatorItem>;
};

/**
 * 系统全局状态。
 * 类型用途：主循环中的共享状态，聚合可交易标志、半日市、账户/持仓缓存与单实例监控状态，供 processMonitor、门禁、买卖流程等使用。
 * 数据来源：主循环与各子模块（gate、refresh、策略等）共同维护。
 * 使用范围：主循环、StrategyRuntime、RiskCheckContext、买卖处理器等；全项目可引用。
 */
export type LastState = {
  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - canTrade/isHalfDay/openProtectionActive/cachedAccount/cachedPositions/cachedTradingDayInfo/allTradingSymbols
   */
  /** 当前是否可交易 */
  canTrade: boolean | null;

  /** 是否为半日市 */
  isHalfDay: boolean | null;

  /** 开盘保护是否生效中 */
  openProtectionActive: boolean | null;

  /** 当前港股日期键（用于跨日检测） */
  currentDayKey: string | null;

  /** 生命周期状态 */
  lifecycleState: LifecycleState;

  /** 是否待开盘重建 */
  pendingOpenRebuild: boolean;

  /** 目标交易日键（待重建） */
  targetTradingDayKey: string | null;

  /** 生命周期交易门禁（仅 ACTIVE 为 true） */
  isTradingEnabled: boolean;

  /** 账户快照缓存 */
  cachedAccount: AccountSnapshot | null;

  /** 持仓列表缓存 */
  cachedPositions: ReadonlyArray<Position>;

  /** 持仓缓存（O(1) 查找） */
  readonly positionCache: PositionCache;

  /** 交易日信息缓存 */
  cachedTradingDayInfo: TradingDayInfo | null;

  /** 交易日历快照（YYYY-MM-DD -> 是否交易日/半日市） */
  tradingCalendarSnapshot?: ReadonlyMap<string, TradingDayInfo>;

  /** 单实例监控状态 */
  readonly monitorState: StrategyState;

  /** 订阅标的集合（运行时动态维护） */
  allTradingSymbols: ReadonlySet<string>;
};

/**
 * 单实例策略运行时上下文。
 * 类型用途：聚合配置、运行时状态、席位注册表、策略、风控与名称缓存等，作为单实例处理流程的入参。
 * 数据来源：主程序/startup 根据配置与 LastState 组装；运行中字段由主循环更新。
 * 使用范围：processMonitor、主循环、买卖处理器、策略等；全项目可引用。
 */
export type StrategyRuntime = {
  /** 监控标的配置 */
  readonly config: StrategyRuntimeConfig;

  /** 运行时状态 */
  readonly state: StrategyState;

  /** 标的注册表 */
  readonly symbolRegistry: SymbolRegistry;

  /**
   * 运行中会更新的席位缓存（保持可变，避免频繁重建上下文）
   */
  /** 席位状态缓存 */
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };

  /** 席位版本缓存 */
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };

  /** 自动换标管理器 */
  readonly autoSymbolManager: AutoSymbolManagerPort;

  /** 策略实例 */
  readonly strategy: TradingSignalStrategy;

  /** 当日亏损跟踪器 */
  readonly dailyLossTracker: DailyLossTracker;

  /** 风险检查器 */
  readonly riskChecker: RiskChecker;

  /** 浮亏监控器 */
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;

  /** 做多标的名称缓存 */
  longSymbolName: string;

  /** 做空标的名称缓存 */
  shortSymbolName: string;

  /** 监控标的名称缓存 */
  baseInstrumentName: string;

  /** 已校验的监控标的代码 */
  readonly normalizedBaseInstrumentSymbol: string;

  /** 监控标的展示画像（启动编译，运行期只读） */
  readonly indicatorProfile: IndicatorDisplayProfile;
};
