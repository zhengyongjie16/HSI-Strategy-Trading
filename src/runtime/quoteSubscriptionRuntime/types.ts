import type { OrderHoldEvents, OrderHoldReader } from '../../types/orderHold.js';

import type { QuoteSubscriptionState } from '../../types/quoteSubscription.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { TradingConfig } from '../../types/config.js';
import type { AccountPositionSnapshotReader, SnapshotToken } from '../../types/accountPosition.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { Logger } from '../../types/logger.js';

/**
 * Quote 订阅保留原因。
 * 类型用途：表达运行期某个 symbol 当前必须保留 quote 订阅的业务来源。
 * 数据来源：monitor 配置、席位状态、持仓、订单保留集合与事件 runtime 临时 retain。
 * 使用范围：QuoteSubscriptionRuntime 内部状态与外部 retain API。
 */
type QuoteSubscriptionRetainReason =
  | 'MONITOR_BASE'
  | 'SEAT_BOUND'
  | 'POSITION_HOLD'
  | 'ORDER_HOLD'
  | 'SWITCH_WAKEUP'
  | 'STATIC_LIQUIDATION_WAIT'
  | 'SEAT_REFRESH_WAIT';

/**
 * Quote 订阅 retain 注册参数。
 * 类型用途：表达某个 owner 对一组 symbol 的临时订阅保留请求。
 * 数据来源：SwitchWakeupRuntime、MonitorQuoteEventRuntime、SEAT_REFRESH handler。
 * 使用范围：QuoteSubscriptionRuntime.retainSymbols。
 */
export type QuoteSubscriptionRetainParams = Readonly<{
  ownerKey: string;
  reason: QuoteSubscriptionRetainReason;
  symbols: Iterable<string>;
}>;

/**
 * Quote retain owner。
 * 类型用途：把 retain reason 与 ownerKey 合并为订阅保留的唯一拥有方身份。
 * 数据来源：QuoteSubscriptionRuntime 的基础投影与外部 retainSymbols 请求。
 * 使用范围：仅 QuoteSubscriptionRuntime 模块内部使用。
 */
export type QuoteSubscriptionRetainOwner = Readonly<{
  reason: QuoteSubscriptionRetainReason;
  ownerKey: string;
}>;

/**
 * 串行订阅命令可推进的基础投影范围。
 * 数据来源：启动全量对账、普通事件或 awaited 持仓对账入口；临时 retain 不代管基础投影。
 * 使用范围：仅 QuoteSubscriptionRuntime 内部，用于保持 mutation 失败归属。
 */
export type QuoteSubscriptionTruthProjection = 'ALL' | 'ORDINARY' | 'POSITION_HOLD' | 'NONE';

/**
 * 可变 retain 存储。
 * 类型用途：按 owner 记录当前需要保留订阅的 symbol 集合。
 * 数据来源：QuoteSubscriptionRuntime 在运行期从权威状态和 retain API 投影。
 * 使用范围：仅 QuoteSubscriptionRuntime 模块内部使用。
 */
export type MutableQuoteSubscriptionRetainStore = Map<string, Set<string>>;

/**
 * Quote 订阅 runtime 依赖。
 * 类型用途：创建 runtime 时注入权威状态读取、订阅 API 和事件源。
 * 数据来源：app runtime 装配层。
 * 使用范围：QuoteSubscriptionRuntime 工厂。
 */
export interface QuoteSubscriptionRuntimeDeps {
  readonly logger: Pick<Logger, 'error'>;
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly marketDataClient: Pick<MarketDataClient, 'subscribeSymbols' | 'unsubscribeSymbols'>;
  readonly orderHoldRegistry: OrderHoldReader & OrderHoldEvents;
  readonly quoteSubscriptionState: QuoteSubscriptionState;
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView' | 'isCurrent'>;

  /** 运行期订阅 mutation 失败的 fatal 通道。 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}

/**
 * Quote 订阅 runtime。
 * 类型用途：稳态运行期 quote 订阅集合唯一 owner，向其他 runtime 暴露 retain 与 admission 能力。
 * 数据来源：由 createQuoteSubscriptionRuntime 创建。
 * 使用范围：app 装配、lifecycle、monitor task handler 与事件 runtime。
 */
export interface QuoteSubscriptionRuntime {
  readonly reconcileFromCurrentTruth: () => Promise<void>;

  /** 提交通知只使当前事实对账 dirty；返回不证明传入 token 或 settlement 已 ready。 */
  readonly reconcilePositionHoldFromCurrentTruth: (token: SnapshotToken) => Promise<void>;
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly retainSymbols: (params: QuoteSubscriptionRetainParams) => Promise<void>;
  readonly releaseRetain: (
    params: Pick<QuoteSubscriptionRetainParams, 'ownerKey' | 'reason'>,
  ) => Promise<void>;
  readonly waitForAdmission: (symbols: ReadonlyArray<string>) => Promise<void>;
}
