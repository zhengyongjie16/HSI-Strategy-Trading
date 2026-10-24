import type { OrderCancellation } from '../../types/orderCancellation.js';
import type { OrderHoldReader } from '../../types/orderHold.js';
import type { OrderCacheManager, OrderMonitor } from '../orderTracking/types.js';
import type { SignalExecutor } from '../../types/orderExecutionPorts.js';
import type {
  SeatSwitchWorkflow,
  AdvancePendingSwitchResult,
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
} from '../../types/seatSwitch.js';
import type {
  PeriodicSwitchTaskData,
  PeriodicSwitchTaskAuthorization,
} from '../../types/periodicSwitch.js';
import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { AutoSearchConfig, MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { BuySignal, SellSignal, Signal } from '../../types/signal.js';
import type { RuntimeWritableSeatState, SeatStatus, SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient, QuoteUpdatedEvent } from '../../types/marketPorts.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { PendingOrder } from '../../types/orderReadMetadata.js';
import type { RiskChecker } from '../../types/riskCheck.js';
import type { Logger } from '../../types/logger.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';
import type { RuntimeClock } from '../../types/runtime.js';

import type {
  PeriodicSwitchPendingMap,
  SwitchStateMap,
  SwitchSuppressionMap,
  SwitchSuppression,
  SuppressibleSwitchTriggerKind,
  SwitchTriggerKind,
} from '../../domain/seat/types.js';

/**
 * 席位换标用例的依赖注入参数。
 * 类型用途：包含监控配置、席位注册表与各服务实例，由 createSeatSwitchWorkflow 工厂函数消费。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export interface SeatSwitchWorkflowDeps {
  readonly monitorConfig: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly marketDataClient: MarketDataClient;
  readonly orderExecutor: SignalExecutor;
  readonly cacheManager: Pick<OrderCacheManager, 'getPendingOrders'>;
  readonly orderHoldRegistry: OrderHoldReader;
  readonly orderMonitor: OrderCancellation &
    Pick<
      OrderMonitor,
      | 'getSellOperationOrderIds'
      | 'getUnsettledSellOrderIds'
      | 'getKnownSellOrderIds'
      | 'getSellOperationState'
      | 'captureSellAvailabilityGuard'
    >;

  /** 结算后的临时权威核仓；不提交 canonical snapshot 或改变 settlement readiness。 */
  readonly readSwitchPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly candidateSearch: SeatSwitchCandidateSearch;
  readonly logger: Logger;
  readonly getTradingCalendarSnapshot: () => TradingCalendarSnapshot;
  readonly clock: RuntimeClock;
}

/**
 * 距回收价换标启动入参。
 * 类型用途：表达距离触发的首次启动检查所需最小上下文。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type StartSwitchOnDistanceParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly monitorPrice: string | null;
  readonly positions: ReadonlyArray<Position>;

  /** 每个异步边界后都必须重新读取的普通交易授权。 */
  readonly canContinue: () => boolean;
};

/**
 * 距回收价换标推进入参。
 * 类型用途：表达存在 pending switch 时继续推进状态机所需的最小上下文。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type AdvancePendingSwitchParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly positions: ReadonlyArray<Position>;

  /** 每个异步边界后都必须重新读取的普通交易授权。 */
  readonly canContinue: () => boolean;
};

/**
 * 换标状态机推进入参。
 * 类型用途：收口 processSwitchState 真正消费的最小上下文，避免把距离换标首帧输入错误传播到后续推进链。
 * 数据来源：由 startSwitchFlow 与 advancePendingSwitch 在状态机推进前组装。
 * 使用范围：仅 seatSwitch 的 switchStateMachine 内部使用。
 */
export type SwitchProcessParams = Readonly<{
  readonly direction: 'LONG' | 'SHORT';
  readonly positions: ReadonlyArray<Position>;

  /** 当前 pending switch 继续推进前必须重新读取的普通交易授权。 */
  readonly canContinue: () => boolean;
}>;

/**
 * 周期换标触发检查入参。
 * 类型用途：包含方向、当前时间与交易时段状态，由 switchStateMachine.evaluatePeriodicSwitchDue 消费。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type PeriodicSwitchDueParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly currentTime: Date;

  /** 每个异步边界后都必须重新读取的普通交易授权。 */
  readonly canContinue: () => boolean;
};

/**
 * 交易时段累计时长计算函数（内部类型）。
 * 类型用途：计算两个时间戳之间的交易时长（毫秒）。
 * 使用范围：仅 seatSwitch 模块内部使用。
 */
type TradingDurationCalculator = (params: {
  readonly startMs: number;
  readonly endMs: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
}) => number;

/**
 * 交易日历快照提供函数（内部类型）。
 * 类型用途：获取当前交易日历快照。
 * 使用范围：仅 seatSwitch 模块内部使用。
 */
type TradingCalendarSnapshotProvider = () => TradingCalendarSnapshot;

/**
 * 香港日期键解析函数（内部类型）。
 * 类型用途：用于跨日冻结判断。
 * 使用范围：仅 seatSwitch 模块内部使用。
 */
type HKDateKeyResolver = (date: Date) => string;

/**
 * 构建订单信号的入参，包含动作、标的、行情、原因与席位版本。
 * 由 signalBuilder.buildOrderSignal 消费。
 * 类型用途：用于 BuildOrderSignalParams 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export type BuildOrderSignalParams = {
  readonly action: BuySignal['action'] | SellSignal['action'];
  readonly symbol: string;
  readonly quote: Quote | null;
  readonly reason: string;
  readonly executionOrigin?: 'SWITCH_MOVE' | 'SWITCH_REBUY';
  readonly orderTypeOverride: Signal['orderTypeOverride'];
  readonly quantity: number | null;
  readonly seatVersion: number;
};

/**
 * 订单信号联合类型。
 * 类型用途：统一表达自动寻标与换标链路中生成的买入/卖出订单信号。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type OrderSignal = BuySignal | SellSignal;

/**
 * 订单信号构建函数类型。
 * 类型用途：根据 BuildOrderSignalParams 构造 OrderSignal，由 createSignalBuilder 实现并注入，供换标状态机消费。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type OrderSignalBuilder = (params: BuildOrderSignalParams) => OrderSignal;

/**
 * 席位状态更新函数类型。
 * 类型用途：负责写入注册表并按需递增版本号；bumpOnSymbolChange 为 true 时标的变更会触发版本号递增。由 createSeatStateManager 实现，供寻标与换标流程调用。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export type SeatStateUpdater = (
  direction: 'LONG' | 'SHORT',
  nextState: RuntimeWritableSeatState,
  bumpOnSymbolChange: boolean,
) => void;

/**
 * 席位状态管理器的依赖注入参数。
 * 类型用途：包含注册表、抑制事实与日志能力，由 createSeatStateManager 工厂函数消费。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export interface SeatStateManagerDeps {
  readonly symbolRegistry: SymbolRegistry;
  readonly switchSuppressions: SwitchSuppressionMap;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly getHKDateKey: HKDateKeyResolver;
}

/**
 * 席位状态管理器接口。
 * 类型用途：提供席位构建、更新、抑制与进入换标中状态的操作，由 createSeatStateManager 实现，供 autoSearch 与 switchStateMachine 消费。
 * 使用范围：seatSwitch 模块及其调用方使用。
 */
export interface SeatStateManager {
  updateSeatState: SeatStateUpdater;
  resolveSuppression: (
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ) => SwitchSuppression | null;
  markSuppression: (
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ) => void;
  enterSwitchingSeat: (params: { direction: 'LONG' | 'SHORT'; reason: string }) => number;
}

/**
 * 启动换标流程的入参。
 * 类型用途：供 switchStateMachine.startSwitchFlow 统一接收距离换标/周期换标请求，并用判别联合表达触发语义。
 * 数据来源：由 startSwitchOnDistance / evaluatePeriodicSwitchDue 组装后传入。
 * 使用范围：仅 seatSwitch 模块内部使用。
 */
export type StartSwitchFlowParams =
  | {
      readonly direction: 'LONG' | 'SHORT';
      readonly reason: string;
      readonly triggerKind: Extract<SwitchTriggerKind, 'PERIODIC'>;

      /** 每个异步边界后都必须重新读取的普通交易授权。 */
      readonly canContinue: () => boolean;
    }
  | {
      readonly reason: string;
      readonly triggerKind: Exclude<SwitchTriggerKind, 'PERIODIC'>;
      readonly distanceContext: StartSwitchOnDistanceParams;

      /** 每个异步边界后都必须重新读取的普通交易授权。 */
      readonly canContinue: () => boolean;
    };

/**
 * 换标状态机的依赖注入参数，包含交易器、风控、席位管理与信号构建等完整依赖。
 * 由 createSwitchStateMachine 工厂函数消费。
 * 类型用途：用于 SwitchStateMachineDeps 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export interface SwitchStateMachineDeps {
  readonly autoSearchConfig: AutoSearchConfig;
  readonly monitorSymbol: string;
  readonly symbolRegistry: SymbolRegistry;
  readonly orderExecutor: SignalExecutor;
  readonly cacheManager: Pick<OrderCacheManager, 'getPendingOrders'>;
  readonly orderHoldRegistry: OrderHoldReader;
  readonly orderMonitor: OrderCancellation &
    Pick<
      OrderMonitor,
      | 'getSellOperationOrderIds'
      | 'getUnsettledSellOrderIds'
      | 'getKnownSellOrderIds'
      | 'getSellOperationState'
      | 'captureSellAvailabilityGuard'
    >;

  /** 结算后的临时权威核仓；不提交 canonical snapshot 或改变 settlement readiness。 */
  readonly readSwitchPositions: (symbol: string) => Promise<ReadonlyArray<Position>>;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly marketDataClient: MarketDataClient;
  readonly now: () => Date;
  readonly switchStates: SwitchStateMap;
  readonly periodicSwitchPending: PeriodicSwitchPendingMap;
  readonly resolveSuppression: (
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ) => SwitchSuppression | null;
  readonly markSuppression: (
    direction: 'LONG' | 'SHORT',
    seatSymbol: string,
    triggerKind: SuppressibleSwitchTriggerKind,
  ) => void;
  readonly enterSwitchingSeat: (params: { direction: 'LONG' | 'SHORT'; reason: string }) => number;
  readonly updateSeatState: SeatStateUpdater;
  readonly candidateSearch: SeatSwitchCandidateSearch;
  readonly resolveDirectionSymbols: (direction: 'LONG' | 'SHORT') => {
    readonly buyAction: 'BUYCALL' | 'BUYPUT';
    readonly sellAction: 'SELLCALL' | 'SELLPUT';
  };
  readonly calculateBuyQuantityByNotional: (
    notional: string,
    price: string,
    lotSize: number,
  ) => number | null;
  readonly buildOrderSignal: OrderSignalBuilder;
  readonly pendingOrderStatuses: ReadonlySet<PendingOrder['status']>;
  readonly buySide: PendingOrder['side'];
  readonly logger: Logger;
  readonly maxSearchFailuresPerDay: number;
  readonly getHKDateKey: HKDateKeyResolver;
  readonly calculateTradingDurationMsBetween: TradingDurationCalculator;
  readonly getTradingCalendarSnapshot: TradingCalendarSnapshotProvider;
}

/**
 * 换标状态机接口，提供距离阈值触发换标与挂起状态查询方法。
 * 由 createSwitchStateMachine 实现，供 seatSwitch 消费。
 * 类型用途：用于 SwitchStateMachine 的类型约束与语义表达。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 * 使用范围：仅在当前模块及其直接依赖方使用。
 */
export interface SwitchStateMachine {
  evaluatePeriodicSwitchDue: (params: PeriodicSwitchDueParams) => Promise<SwitchDriveResult>;
  startSwitchOnDistance: (
    params: StartSwitchOnDistanceParams,
  ) => Promise<StartSwitchOnDistanceResult>;
  advancePendingSwitch: (params: AdvancePendingSwitchParams) => Promise<AdvancePendingSwitchResult>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
}

/** 周期任务 use case 的注入边界；不创建队列、timer、订单或账户 owner。 */
export interface PeriodicSwitchTaskHandlerDeps {
  readonly monitorContext: {
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly seatSwitch: SeatSwitchWorkflow;
  };
  readonly switchWakeupRuntime: SeatSwitchWakeupPort;
  readonly periodicSwitchWakeupRuntime: PeriodicSwitchPlanPort;
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView'>;
  readonly getCanTradeNow: () => boolean;
  readonly logger: Pick<Logger, 'error'>;
  readonly now: () => Date;
}

/** C worker 的两回调；周期失败、WAIT 与失效决定属于 application。 */
export interface PeriodicSwitchTaskHandler {
  readonly handlePeriodicSwitchTask: (
    task: PeriodicSwitchTask,
    canOwnTask: () => boolean,
  ) => Promise<PeriodicSwitchTaskStatus>;
  readonly onPeriodicSwitchTaskResult: (
    task: PeriodicSwitchTask,
    status: PeriodicSwitchTaskStatus,
    canOwnTask: () => boolean,
  ) => void;
}

/**
 * 距离换标启动执行器。
 * 类型用途：封装 monitor quote route 中距离换标启动动作。
 * 数据来源：默认距离换标执行器或测试注入替身。
 * 使用范围：仅 monitorQuoteEventRuntime 模块内部使用。
 */
export type StartDistanceSwitchExecutor = (params: {
  readonly monitorContext: {
    readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
    readonly seatSwitch: SeatSwitchWorkflow;
  };
  readonly event: QuoteUpdatedEvent;
  readonly canContinue: () => boolean;
  readonly retryConsumed: boolean;
  readonly isDirectionCurrent: (direction: 'LONG' | 'SHORT') => boolean;
}) => Promise<DistanceSwitchExecutionResult>;

/** 距离启动用例只读取 canonical positions；授权由原事件 route 提供。 */
export interface DistanceSwitchExecutorDeps {
  readonly now: () => Date;
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView'>;
}

/**
 * 距离换标预检快照。
 * 类型用途：记录调用 startSwitchOnDistance 前两侧席位与 pending switch 的权威事实，
 * 用于证明外部错误发生时尚未创建 switch state，才允许由 monitor quote route 重试。
 * 数据来源：MonitorQuoteEventRuntime 从 SymbolRegistry 与 SeatSwitchWorkflow 实时读取。
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

/** 距离预检结果；application 分类外部失败并下发重评估，runtime 只安排原 quote generation 的 timer。 */
export type DistanceSwitchExecutionResult =
  | Readonly<{ kind: 'RESULTS'; results: ReadonlyArray<StartSwitchOnDistanceResult> }>
  | Readonly<{ kind: 'RETRY_PRECHECK'; retryAtMs: number }>;

/** 预寻标边界：同一候选 policy 由 autoSearch owner 提供，换标不读取原生 warrant 列表或建立另一份缓存。 */
interface SeatSwitchCandidateSearch {
  readonly resolveDistanceRange: (
    direction: 'LONG' | 'SHORT',
  ) => Readonly<{ min: string; max: string }> | null;
  readonly findCandidate: (
    params: Readonly<{
      direction: 'LONG' | 'SHORT';
      currentTime: Date;
      canContinue: () => boolean;
    }>,
  ) => Promise<Readonly<{ symbol: string; callPrice: string }> | null>;
}

/** 应用层消费的周期任务业务信封；队列形态由 worker 保留，不参与换标决策。 */
export type PeriodicSwitchTask = Readonly<{
  type: 'AUTO_SYMBOL_TICK';
  dedupeKey: string;
  data: PeriodicSwitchTaskData;
}>;

/** 周期任务的真实业务结果，runtime 原样交还应用层，而不是分类失败。 */
export type PeriodicSwitchTaskStatus = 'processed' | 'skipped' | 'failed' | 'blocked';

/** 已发布 WAIT 的唯一接棒端口；仅注册后续 owner，不代替原交易授权。 */
interface SeatSwitchWakeupPort {
  readonly handoffPendingSwitch: (
    params: Readonly<{
      direction: 'LONG' | 'SHORT';
      monitorContext: {
        readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
        readonly seatSwitch: SeatSwitchWorkflow;
      };
      driveResult: Extract<SwitchDriveResult, { kind: 'WAIT' }>;
      originalDayEpoch: number;
    }>,
  ) => void;
}

/** 周期计划副作用边界；失败时刻由应用层下发，timer/暂停/清理由 runtime 实现。 */
interface PeriodicSwitchPlanPort {
  readonly markWaitingEmpty: (authorization: PeriodicSwitchTaskAuthorization) => void;
  readonly clearWaitingEmpty: (authorization: PeriodicSwitchTaskAuthorization) => void;
  readonly replanRouteAfterTask: (
    params: PeriodicSwitchTaskAuthorization &
      Readonly<{
        taskTimeMs: number;
        status: PeriodicSwitchTaskStatus;
        reevaluateAtMs?: number;
      }>,
  ) => void;
}
