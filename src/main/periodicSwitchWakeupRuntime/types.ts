import type { RuntimeTermination } from '../../types/runtime.js';
import type { BoundedOneShotTimerController } from '../../utils/timer/types.js';
import type { MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { Trader } from '../../types/services.js';
import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { SettlementFreshnessReader } from '../../types/settlement.js';
import type {
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchTaskAuthorization,
} from '../../types/periodicSwitch.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../asyncProgram/monitorTaskProcessor/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';

/** 业务就绪observer/reader；仅观察和等待，不授权本消费者登记新的成交刷新需求。 */
interface PeriodicSwitchConsistencyPort extends SettlementFreshnessReader {
  getStatus: () => Readonly<{ started: boolean; currentVersion: number; staleVersion: number }>;
}

/**
 * 周期换标到期时间计算参数。
 * 类型用途：把 seat ACTIVE 起点与配置间隔传入纯计算依赖。
 * 数据来源：PeriodicSwitchWakeupRuntime 从当前 baseline 与 monitor config 组装。
 * 使用范围：PeriodicSwitchWakeupRuntimeDeps.calculateDueAtMs。
 */
type PeriodicSwitchDueCalculationParams = Readonly<{
  /** ACTIVE 起点时间戳 */
  startMs: number;

  /** 周期换标间隔分钟数 */
  switchIntervalMinutes: number;
}>;

/**
 * 周期换标单 route 运行态。
 * 类型用途：记录当前 baseline、one-shot timer、waiting-empty 与外部失败重评估边界。
 * 数据来源：PeriodicSwitchWakeupRuntime 按 route key 维护。
 * 使用范围：PeriodicSwitchWakeupRuntime 内部状态表。
 */
export type PeriodicSwitchRouteState = {
  /** 当前权威 baseline */
  baseline: PeriodicSwitchRouteBaseline | null;

  /** 当前 one-shot timer 句柄 */
  timerHandle: BoundedOneShotTimerController | null;

  /** 当前 waiting-empty baseline */
  waitingEmpty: PeriodicSwitchRouteBaseline | null;

  /** 当前 baseline 的外部失败未来重评估边界；null 表示未等待 */
  failureReevaluationAtMs: number | null;

  /** 待派发的最新需求，不是持仓或receipt替代缓存。 */
  dispatchBaseline: PeriodicSwitchRouteBaseline | null;
  inFlight: boolean;
  dirty: boolean;
  blockedOnFreshness: boolean;

  /** 原连续交易门禁暂停的需求，恢复后仍由本route重驱。 */
  blockedOnGate: boolean;

  /** 最后派发任务的真实closure身份；旧回调不能覆盖较新任务的计划。 */
  dispatchedCanContinue: (() => boolean) | null;
};

/**
 * 周期换标 runtime 依赖。
 * 类型用途：创建周期换标 due timer owner 所需的状态读取、事件源、任务队列与 timer 能力。
 * 数据来源：app runtime 装配层。
 * 使用范围：createPeriodicSwitchWakeupRuntime 工厂。
 */
export type PeriodicSwitchWakeupRuntimeDeps = Readonly<{
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;

  /** 当前唯一 monitorContext */
  monitorContext: Pick<MonitorContext, 'config'>;

  /** 权威席位注册表 */
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion' | 'onSeatTruthChanged'>;

  /** 监控任务队列 */
  monitorTaskQueue: Pick<MonitorTaskQueue<MonitorTaskDataMap>, 'scheduleLatest'>;

  /** 订单事件源 */
  trader: Pick<Trader, 'onOrderStateChanged'>;

  /** 同一canonical owner的最窄事实身份/组件读取能力，不读取或缓存positions数组。 */
  snapshot: Pick<AccountPositionSnapshotReader, 'getView' | 'isCurrent'>;

  /** 实际执行门禁，由原交易门禁owner提供，暂停不抹除已有WAIT。 */
  getCanTradeNow: () => boolean;

  /** 成交后一致性业务就绪reader及原事件observer。 */
  postTradeConsistencyRuntime: PeriodicSwitchConsistencyPort;

  /** 交易门禁事件源 */
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;

  /** 周期换标到期时间计算 */
  calculateDueAtMs: (params: PeriodicSwitchDueCalculationParams) => number | null;

  /** 当前时间 */
  now: () => Date;

  /** 注册 one-shot timer */
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  /** 清理 timer */
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * 周期换标 wakeup runtime。
 * 类型用途：运行期周期换标 due timer 与 waiting-empty 重派发的唯一 owner。
 * 数据来源：由 createPeriodicSwitchWakeupRuntime 创建。
 * 使用范围：app 装配、AUTO_SYMBOL_TICK 任务结果回写与 lifecycle cleanup。
 */
export interface PeriodicSwitchWakeupRuntime {
  /** 启动事件订阅并 seed 当前配置路线 */
  readonly start: () => void;

  /** 停止订阅、清理 timer 与 waiting-empty 状态 */
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;

  /** 标记当前 baseline 进入 waiting-empty 等待 */
  readonly markWaitingEmpty: (authorization: PeriodicSwitchTaskAuthorization) => void;

  /** 清理当前 baseline 的 waiting-empty 等待 */
  readonly clearWaitingEmpty: (authorization: PeriodicSwitchTaskAuthorization) => void;

  /** AUTO_SYMBOL_TICK 结束后按当前 baseline 与处理结果重排 route */
  readonly replanRouteAfterTask: (
    params: PeriodicSwitchTaskAuthorization &
      Readonly<{
        taskTimeMs: number;
        status: MonitorTaskStatus;
      }>,
  ) => void;
}
