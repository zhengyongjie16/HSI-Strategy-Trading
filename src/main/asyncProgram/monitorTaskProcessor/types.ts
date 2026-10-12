import type { PeriodicSwitchTaskData } from '../../../types/periodicSwitch.js';
import type { PeriodicSwitchWakeupRuntime } from '../../periodicSwitchWakeupRuntime/types.js';
import type { SwitchWakeupRuntime } from '../../monitorQuoteEventRuntime/types.js';
import type { MonitorTaskQueue } from '../monitorTaskQueue/types.js';
import type { MonitorContext } from '../../../types/state.js';
import type {
  AccountPositionSnapshot,
  SnapshotRefreshHandle,
} from '../../../types/accountPosition.js';
import type { RawOrderFromAPI, Trader, MarketDataClient } from '../../../types/services.js';
import type { QuoteSubscriptionRuntime } from '../../quoteSubscriptionRuntime/types.js';
import type { RuntimeClock, RuntimeScheduler, RuntimeTermination } from '../../../types/runtime.js';

/**
 * 席位快照（任务创建时点的席位状态）。
 * 类型用途：任务创建时记录席位版本号、标的代码与激活基线，处理时用于校验席位是否已变更，避免执行过期任务。
 * 数据来源：由任务 owner 在调度任务时从 symbolRegistry 等获取并写入任务数据。
 * 使用范围：仅 monitorTaskProcessor 与各任务 owner 内部使用。
 */
export type SeatSnapshot = Readonly<{
  seatVersion: number;
  symbol: string;
  lastSeatActivatedAt: number;
}>;

/**
 * 席位刷新任务数据。
 * 类型用途：seat 进入 ACTIVATING 后触发的激活屏障任务数据，固定入队 dayEpoch 与席位身份；行情统一在执行时获取。
 * 数据来源：由 SeatActivationDispatcher 在 seat 进入 ACTIVATING 时组装并入队。
 * 使用范围：仅 monitorTaskProcessor、SeatActivationDispatcher 内部使用。
 */
export type SeatRefreshTaskData = Readonly<{
  dayEpoch: number;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: string | null;
  symbolName: string | null;
  apiRetryAttempt?: number;
}>;

/**
 * SEAT_REFRESH API 失败延迟重试 timer。
 * 类型用途：记录单个 dedupeKey 下已安排的延迟重试及其席位快照，避免旧席位 timer 覆盖新席位任务。
 * 数据来源：MonitorTaskProcessor 在 SEAT_REFRESH 外部 API 失败后创建。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 */
export type SeatRefreshRetryTimer = Readonly<{
  handle: ReturnType<typeof setTimeout>;
  dayEpoch: number;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  nextSymbol: string;
}>;

/**
 * 监控任务类型到 payload 的映射。
 * 类型用途：表达 task.type 与 task.data 的一一对应关系，确保队列与处理器形成判别联合。
 * 数据来源：由各调度点组装的具体任务数据入队时确定。
 * 使用范围：monitorTaskProcessor、monitorTaskQueue、各任务 owner、app/runtime 装配层与相关测试共享使用。
 */
export type MonitorTaskDataMap = Readonly<{
  AUTO_SYMBOL_TICK: PeriodicSwitchTaskData;
  SEAT_REFRESH: SeatRefreshTaskData;
}>;

/**
 * SEAT_REFRESH 外部 API 失败后的重试去向。
 * 类型用途：区分取消（停止/终止/生命周期门禁关闭）与重试次数真正耗尽，只有耗尽才允许把 ACTIVATING 席位回落 EMPTY。
 * 数据来源：MonitorTaskProcessor 根据当前运行态与任务 apiRetryAttempt 判定。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 */
export type SeatRefreshRetryOutcome = 'scheduled' | 'canceled' | 'exhausted';

/**
 * 监控任务处理状态（任务处理结果）。
 * 类型用途：任务处理完成后的结果状态。
 * 数据来源：由 MonitorTaskProcessor 在处理单任务后根据执行结果设置。
 * 使用范围：仅 monitorTaskProcessor 内部使用。
 * 语义说明：blocked 表示任务本身仍有效，但被当前门禁阻断，后续 owner 仍需继续推进。
 */
export type MonitorTaskStatus = 'processed' | 'skipped' | 'failed' | 'blocked';

/**
 * 刷新辅助函数集合（席位刷新任务用工具）。
 * 类型用途：提供独立订单读取与使用 captured dayEpoch 的 canonical 成对请求，保留 receipt/cancel；不写 LastState 缓存。
 * 数据来源：由 MonitorTaskProcessor 实现模块注入或闭包提供。
 * 使用范围：仅 MonitorTaskProcessor 内部使用。
 */
export type RefreshHelpers = Readonly<{
  ensureAllOrders: () => Promise<ReadonlyArray<RawOrderFromAPI>>;
  requestAccountPositionRefresh: (dayEpoch: number) => SnapshotRefreshHandle;
}>;

/**
 * MonitorTaskProcessor 依赖注入配置（创建监控任务处理器时的参数）。
 * 类型用途：创建 MonitorTaskProcessor 所需的全部外部依赖（队列、唯一 monitorContext、trader 等）。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 monitorTaskProcessor 及启动流程使用，内部使用。
 */
export type MonitorTaskProcessorDeps = Readonly<{
  clock: RuntimeClock;
  scheduler: RuntimeScheduler;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
  monitorContext: MonitorContext;
  trader: Trader;
  marketDataClient: MarketDataClient;

  /** 同一 canonical owner 的最小读取与受控刷新能力；不授权本消费者 invalidate。 */
  snapshot: Pick<AccountPositionSnapshot, 'getView' | 'isCurrent' | 'requestRefresh'>;
  quoteSubscriptionRuntime: Pick<
    QuoteSubscriptionRuntime,
    'retainSymbols' | 'releaseRetain' | 'waitForAdmission' | 'reconcilePositionHoldFromCurrentTruth'
  >;
  switchWakeupRuntime: Pick<SwitchWakeupRuntime, 'handoffPendingSwitch'>;
  periodicSwitchWakeupRuntime: Pick<
    PeriodicSwitchWakeupRuntime,
    'markWaitingEmpty' | 'clearWaitingEmpty' | 'replanRouteAfterTask'
  >;

  /** 生命周期门禁：false 时任务直接跳过 */
  getCanProcessTask?: () => boolean;

  /** 周期换标消费期普通交易门禁 */
  getCanTradeNow: () => boolean;

  /** 非 API 程序错误进入 fatal 通道 */
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}>;

/**
 * MonitorTaskProcessor 行为契约。
 * 类型用途：监控任务处理器的公开接口（start/stopAndDrain/restart），供主程序/ lifecycle 调度。
 * 数据来源：主程序通过工厂创建并持有，任务由各任务 owner 经 monitorTaskQueue 入队。
 * 使用范围：app runtime、lifecycle 与任务 owner 等，仅内部使用。
 */
export interface MonitorTaskProcessor {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly restart: () => void;
}
