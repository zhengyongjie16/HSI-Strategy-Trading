import type { MonitorContext, LastState } from '../../types/state.js';
import type { SellSignal } from '../../types/signal.js';
import type {
  MarketDataClient,
  PostTradeConsistencyFreshnessPort,
  QuoteUpdatedEvent,
  Trader,
} from '../../types/services.js';
import type {
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
} from '../../types/monitorContextPorts.js';
import type { SeatStatus, SymbolRegistry } from '../../types/seat.js';
import type { QuoteSubscriptionRuntime } from '../quoteSubscriptionRuntime/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';
import type { BoundedOneShotTimerController } from '../../utils/timer/types.js';

/**
 * Monitor quote freshness 状态快照。
 * 类型用途：描述 runtime 判断 baseline 与 freshness 门禁所需的最小状态。
 * 数据来源：由 postTradeConsistencyRuntime.getStatus 返回。
 * 使用范围：monitorQuoteEventRuntime 模块内部依赖与相关测试使用。
 */
type MonitorQuoteFreshnessStatus = Readonly<{
  /** freshness runtime 是否已经启动 */
  started: boolean;

  /** 当前已追平版本 */
  currentVersion: number;

  /** 当前待追平版本 */
  staleVersion: number;
}>;

/**
 * Monitor quote freshness 依赖。
 * 类型用途：收口 monitor quote runtime 与 switch wakeup runtime 共用的 freshness 等待依赖。
 * 数据来源：由 app 层 postTradeConsistencyRuntime 实现并注入。
 * 使用范围：monitorQuoteEventRuntime 模块内部依赖与相关测试使用。
 */
type MonitorQuoteFreshnessDeps = Readonly<{
  /** 等待 freshness 追平 */
  waitForFresh: PostTradeConsistencyFreshnessPort['waitForFresh'];

  /** 读取 freshness 状态快照 */
  getStatus: () => MonitorQuoteFreshnessStatus;

  /** 订阅 freshness 追平事件；monitor quote runtime 可不订阅 */
  onFreshReached?: PostTradeConsistencyFreshnessPort['onFreshReached'];
}>;

/**
 * Monitor quote 事件执行器。
 * 类型用途：封装 monitor quote route 中静态清仓执行动作。
 * 数据来源：默认静态清仓执行器或测试注入替身。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type MonitorQuoteEventExecutor = (params: {
  readonly monitorContext: MonitorContext;
  readonly event: QuoteUpdatedEvent;
  readonly retryAttempts: number;
  readonly excludedDirections: ReadonlySet<'LONG' | 'SHORT'>;
  readonly canContinue: () => boolean;
  readonly onDirectionSubmitted: (direction: 'LONG' | 'SHORT') => void;
}) => Promise<StaticLiquidationRuntimeResult>;

/**
 * 距离换标启动执行器。
 * 类型用途：封装 monitor quote route 中距离换标启动动作。
 * 数据来源：默认距离换标执行器或测试注入替身。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type StartDistanceSwitchExecutor = (params: {
  readonly monitorContext: MonitorContext;
  readonly event: QuoteUpdatedEvent;
  readonly canContinue: () => boolean;
}) => Promise<ReadonlyArray<StartSwitchOnDistanceResult>>;

/**
 * Monitor quote event runtime 创建依赖。
 * 类型用途：收口内部工厂所需的 quote 事件源、执行动作、freshness 与 quote retain 端口。
 * 数据来源：默认组装入口或测试代码注入。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type CreateMonitorQuoteEventRuntimeDeps = Readonly<{
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;
  readonly monitorContext: MonitorContext;
  readonly executeStaticLiquidation?: MonitorQuoteEventExecutor;
  readonly startDistanceSwitch?: StartDistanceSwitchExecutor;
  readonly handoffPendingSwitch?: Pick<
    SwitchWakeupRuntime,
    'handoffPendingSwitch'
  >['handoffPendingSwitch'];
  readonly lastState?: Pick<LastState, 'isTradingEnabled' | 'canTrade' | 'isHalfDay'>;
  readonly postTradeConsistencyRuntime?: MonitorQuoteFreshnessDeps;
  readonly doomsdayProtectionEnabled?: boolean;
  readonly now?: () => Date;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly quoteSubscriptionRuntime?: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'releaseRetain'
  >;

  /** route 内部错误可观测通道 */
  readonly onFatalError?: (error: unknown) => void;
}>;

/**
 * 默认 Monitor quote event runtime 创建依赖。
 * 类型用途：为真实运行时组装静态清仓与距离换标默认执行器提供完整依赖。
 * 数据来源：app post-gate runtime 组装层。
 * 使用范围：createDefaultMonitorQuoteEventRuntime 使用。
 */
export type CreateDefaultMonitorQuoteEventRuntimeDeps = Readonly<{
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated' | 'getQuotes'>;
  readonly monitorContext: MonitorContext;
  readonly trader: Pick<Trader, 'executeSignals'>;
  readonly lastState: Pick<
    LastState,
    'positionCache' | 'cachedPositions' | 'isTradingEnabled' | 'canTrade' | 'isHalfDay'
  >;
  readonly postTradeConsistencyRuntime: MonitorQuoteFreshnessDeps;
  readonly doomsdayProtectionEnabled: boolean;
  readonly now: () => Date;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly quoteSubscriptionRuntime?: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'releaseRetain'
  >;
  readonly handoffPendingSwitch?: Pick<
    SwitchWakeupRuntime,
    'handoffPendingSwitch'
  >['handoffPendingSwitch'];

  /** route 内部错误可观测通道 */
  readonly onFatalError?: (error: unknown) => void;
}>;

/**
 * Monitor quote route 模式。
 * 类型用途：区分同一 monitor quote route 当前由静态清仓还是距离换标接管。
 * 数据来源：monitor 配置中的 autoSearchEnabled。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type MonitorQuoteRouteMode = 'STATIC_LIQUIDATION' | 'DISTANCE_SWITCH';

/**
 * 距离换标预检快照。
 * 类型用途：记录调用 startSwitchOnDistance 前两侧席位与 pending switch 的权威事实，
 * 用于证明外部错误发生时尚未创建 switch state，才允许由 monitor quote route 重试。
 * 数据来源：MonitorQuoteEventRuntime 从 SymbolRegistry 与 AutoSymbolManager 实时读取。
 * 使用范围：仅 monitorQuoteEventRuntime 的距离换标预检错误边界使用。
 */
export type DistanceSwitchPrecheckSnapshot = ReadonlyArray<
  Readonly<{
    /** 席位方向 */
    direction: 'LONG' | 'SHORT';

    /** 预检前席位状态 */
    seatStatus: SeatStatus;

    /** 预检前席位标的 */
    seatSymbol: string | null;

    /** 预检前席位版本 */
    seatVersion: number;

    /** 预检前是否已有状态机 owner */
    hasPendingSwitch: boolean;
  }>
>;

/**
 * Monitor quote route 状态。
 * 类型用途：维护单 monitor route 的 latest-only collapse、静态清仓 WAIT 唤醒，以及按 quote generation 限定的距离换标预检 retry。
 * 数据来源：monitorQuoteEventRuntime 在 quote event 与 WAIT 结果到达时写入。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type MonitorQuoteRouteState = {
  generation: number;
  monitorQuoteGeneration: number;
  latestEvent: QuoteUpdatedEvent | null;
  wakeupSymbols: ReadonlySet<string>;
  retainedQuoteSymbols: ReadonlySet<string>;
  retainNeedsRetry: boolean;
  mode: MonitorQuoteRouteMode;
  inFlight: boolean;
  dirty: boolean;
  retryAttempts: number;
  retryTimerHandle: ReturnType<typeof setTimeout> | null;
  distanceSwitchPrecheckRetryTimer: BoundedOneShotTimerController | null;
  distanceSwitchPrecheckRetryConsumed: boolean;
  submittedLiquidationDirections: Set<'LONG' | 'SHORT'>;
};

/**
 * Switch wakeup freshness 依赖。
 * 类型用途：收口 switch wakeup runtime 所需的 freshness 等待与事件订阅依赖。
 * 数据来源：由 app 层 postTradeConsistencyRuntime 实现并注入。
 * 使用范围：switchWakeupRuntime 模块内部依赖使用。
 */
type SwitchWakeupFreshnessDeps = Readonly<{
  /** 等待 freshness 追平 */
  waitForFresh: PostTradeConsistencyFreshnessPort['waitForFresh'];

  /** 读取 freshness 状态快照 */
  getStatus: () => MonitorQuoteFreshnessStatus;

  /** 订阅 freshness 追平事件 */
  onFreshReached: PostTradeConsistencyFreshnessPort['onFreshReached'];
}>;

/**
 * Switch wakeup route key。
 * 类型用途：以 direction + seatVersion 唯一标识一条 pending switch 推进链，支撑单 monitor 下的 single-flight 与旧版本自然失效。
 * 数据来源：由 SwitchWakeupRuntime 在 handoffPendingSwitch 时构造。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRouteKey = `${'LONG' | 'SHORT'}:${number}`;

/**
 * Switch wakeup route。
 * 类型用途：描述当前 runtime 持有的一条 pending switch 权威路由身份。
 * 数据来源：由 handoffPendingSwitch 参数与单一运行时权威快照组合得到。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRoute = Readonly<{
  /** 路由键 */
  routeKey: SwitchWakeupRouteKey;

  /** 方向 */
  direction: 'LONG' | 'SHORT';

  /** 席位版本 */
  seatVersion: number;
}>;

/**
 * 单 route 的执行收敛状态。
 * 类型用途：维护 single-flight、latest-only collapse 与显式 wakeup 注册状态。
 * 数据来源：由 SwitchWakeupRuntime 在运行期维护。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRouteState = {
  /** 当前路由快照 */
  route: SwitchWakeupRoute;

  /** 是否已有推进执行在途 */
  inFlight: boolean;

  /** 是否在在途期间又收到新的 wakeup */
  dirty: boolean;

  /** 当前 route 生效中的显式 wakeups */
  wakeups: ReadonlyArray<Extract<SwitchDriveResult, { kind: 'WAIT' }>['wakeups'][number]>;

  /** 当前 route 的 retry timer 句柄 */
  retryTimerHandle: ReturnType<typeof setTimeout> | null;

  /** 当前 route 为 SYMBOL_QUOTE wakeup 显式保留的标的集合 */
  retainedQuoteSymbols: ReadonlySet<string>;

  /** 当前 route 的相同 retain 集合是否仍需重试 */
  retainNeedsRetry: boolean;
};

/**
 * SwitchWakeupRuntime handoff 参数。
 * 类型用途：把事件驱动 owner 拿到的 pending switch driveResult 交给 runtime 接管后续推进。
 * 数据来源：由 monitor quote runtime 或 AUTO_SYMBOL_TICK 等现有 owner 在拿到 driveResult 后传入。
 * 使用范围：仅 app/main 顶层事件接线与相关测试使用。
 */
export type SwitchWakeupHandoffParams = Readonly<{
  /** 方向 */
  direction: 'LONG' | 'SHORT';

  /** 发起 handoff 时的权威 monitor context */
  monitorContext: MonitorContext;

  /** 本轮单步推进结果 */
  driveResult: Extract<SwitchDriveResult, { kind: 'WAIT' }>;
}>;

/**
 * Switch wakeup runtime 依赖。
 * 类型用途：创建 runtime 所需的事件源、权威快照读取依赖与 timer 能力。
 * 数据来源：由 app post-gate runtime 统一组装并注入。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type SwitchWakeupRuntimeDeps = Readonly<{
  /** 行情事件源 */
  marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;

  /** 订单事件源 */
  trader: Pick<Trader, 'onOrderStateChanged'>;

  /** 权威席位注册表 */
  symbolRegistry: SymbolRegistry;

  /** 单一监控上下文 */
  monitorContext: MonitorContext;

  /** 全局运行时状态 */
  lastState: Pick<LastState, 'canTrade' | 'isTradingEnabled' | 'isHalfDay' | 'cachedPositions'>;

  /** 成交后一致性 freshness 端口 */
  postTradeConsistencyRuntime: SwitchWakeupFreshnessDeps;

  /** 连续交易门禁事件源；用于午休结束后重驱仍有效的 pending switch route。 */
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;

  /** quote 订阅 retain 端口 */
  quoteSubscriptionRuntime?: Pick<QuoteSubscriptionRuntime, 'retainSymbols' | 'releaseRetain'>;

  /** 是否启用末日保护清仓接管门禁 */
  doomsdayProtectionEnabled: boolean;

  /** 当前时间源 */
  now: () => Date;

  /** 安排 retry timer */
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  /** 清理 retry timer */
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  /** route 内部错误可观测通道 */
  onFatalError?: (error: unknown) => void;
}>;

/**
 * 静态距回收价清仓执行结果。
 * 类型用途：表达 monitor quote 驱动静态清仓的一次执行结果，以及 WAIT 场景下的显式唤醒注册信息。
 * 数据来源：由 staticLiquidationExecutor 在单次执行结束时返回。
 * 使用范围：monitorQuoteEventRuntime 及相关测试使用。
 */
export type StaticLiquidationRuntimeResult =
  | Readonly<{
      kind: 'NOOP';
    }>
  | Readonly<{
      kind: 'COMPLETED';
    }>
  | Readonly<{
      kind: 'WAIT';
      wakeupSymbols: ReadonlyArray<string>;
      retryAtMs: number | null;
    }>;

/**
 * 静态清仓执行器依赖。
 * 类型用途：收口 monitor quote 驱动静态距回收价清仓所需的最小依赖。
 * 数据来源：由 app/main 顶层运行时组装并注入。
 * 使用范围：仅 staticLiquidationExecutor 模块内部使用。
 */
export type CreateStaticLiquidationExecutorDeps = Readonly<{
  readonly trader: Pick<Trader, 'executeSignals'>;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly lastState: Pick<LastState, 'positionCache'>;
  readonly now: () => Date;
}>;

/**
 * 单边静态清仓候选。
 * 类型用途：表示某一方向已通过触发判定、待执行并在成功后做缓存刷新的清仓项。
 * 数据来源：由 monitor quote 事件执行时基于当前席位、持仓与行情构造。
 * 使用范围：仅 staticLiquidationExecutor 模块内部使用。
 */
export type StaticLiquidationCandidate = Readonly<{
  readonly signal: SellSignal;
  readonly quote: QuoteUpdatedEvent['quote'];
}>;

/**
 * 单边静态清仓候选构造结果。
 * 类型用途：显式区分跳过、等待交易标的行情和生成可执行清仓候选。
 * 数据来源：staticLiquidationExecutor 对单方向席位、持仓与 quote 的判定。
 * 使用范围：仅 staticLiquidationExecutor 模块内部使用。
 */
export type StaticLiquidationCandidateResult =
  | Readonly<{
      kind: 'SKIP';
    }>
  | Readonly<{
      kind: 'WAIT';
    }>
  | Readonly<{
      kind: 'CANDIDATE';
      candidate: StaticLiquidationCandidate;
    }>;

/**
 * Monitor quote 事件运行时行为契约。
 * 类型用途：统一拥有 monitor quote 驱动执行与生命周期启停能力。
 * 数据来源：由 monitorQuoteEventRuntime 工厂创建。
 * 使用范围：app cleanup、lifecycle 与相关测试使用。
 */
export interface MonitorQuoteEventRuntime {
  /** 启动事件监听。 */
  start: () => void;

  /** 停止监听并等待所有在途执行完成。 */
  stopAndDrain: () => Promise<void>;
}

/**
 * Switch wakeup runtime 行为契约。
 * 类型用途：统一拥有 pending switch 的事件驱动推进与生命周期启停能力。
 * 数据来源：由 createSwitchWakeupRuntime 创建。
 * 使用范围：app cleanup、lifecycle、monitorTaskProcessor 与相关测试使用。
 */
export interface SwitchWakeupRuntime {
  /** 启动事件监听。 */
  start: () => void;

  /** 停止监听并等待所有在途推进完成。 */
  stopAndDrain: () => Promise<void>;

  /** 把已有 pending switch 的显式 wakeups 交给 runtime 接管。 */
  handoffPendingSwitch: (params: SwitchWakeupHandoffParams) => void;
}
