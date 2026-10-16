import type { AccountPositionSnapshot, SnapshotToken } from '../../types/accountPosition.js';
import type {
  OrderFactBatchCommitResult,
  OrderProjectionTarget,
} from '../../types/orderRecorder.js';
import type { Quote } from '../../types/quote.js';
import type { DailyLossMonitorScope, DailyLossTracker } from '../../types/risk.js';
import type { RuntimeClock } from '../../types/runtime.js';
import type { SeatState, SymbolRegistry } from '../../types/seat.js';
import type { PreparedUnrealizedLossData } from '../../types/unrealizedLoss.js';
import type { WarrantRefreshResult } from '../../types/warrantRisk.js';
import type { OrderFact } from '../../types/trade.js';
import type { Logger } from '../../types/logger.js';

/** 入队时固定的激活身份；重试保留 epoch、方向、版本与真实 previousSymbol，不改用当前身份。 */
export type SeatActivationRequest = Readonly<{
  dayEpoch: number;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: string | null;
  symbolName: string | null;
  apiRetryAttempt?: number;
}>;

/** 激活结果；RETRY 是 application 决定的唯一一次外部失败延迟指令，不授权 runtime 自行增加次数。 */
export type SeatActivationResult =
  | { readonly status: 'processed' | 'skipped' }
  | { readonly status: 'failed'; readonly error: unknown }
  | {
      readonly status: 'retry';
      readonly error: unknown;
      readonly request: SeatActivationRequest;
      readonly delayMs: number;
    };

/** 临时行情保留 owner，仅供激活 await/release，不参与全局订阅完成判断。 */
export type SeatActivationRetainOwner = Readonly<{
  ownerKey: string;
  reason: 'SEAT_REFRESH_WAIT';
}>;

/** 激活所需的订阅能力；永久席位投影由 registry 同步事件先进入同一订阅串行链。 */
export interface SeatActivationSubscriptions {
  readonly retainSymbols: (
    params: SeatActivationRetainOwner & { readonly symbols: Iterable<string> },
  ) => Promise<void>;
  readonly releaseRetain: (owner: SeatActivationRetainOwner) => Promise<void>;
  readonly waitForAdmission: (symbols: ReadonlyArray<string>) => Promise<void>;
  readonly reconcilePositionHoldFromCurrentTruth: (token: SnapshotToken) => Promise<void>;
}

/** 同一真实订单 owner 的窄读取/预检/消费覆盖提交能力，activation 不维护第二账本。 */
export interface SeatActivationOrders {
  readonly fetchAllOrdersFromAPI: () => Promise<ReadonlyArray<OrderFact>>;
  readonly validateRebuildSnapshot: (symbol: string, orders: ReadonlyArray<OrderFact>) => void;
  readonly commitRebuildSnapshot: (
    targets: ReadonlyArray<OrderProjectionTarget>,
    orders: ReadonlyArray<OrderFact>,
    isCurrent: () => boolean,
    mode: 'ACTIVATION',
  ) => OrderFactBatchCommitResult;
  readonly clearBuyOrders: (symbol: string, isLong: boolean) => void;
}

/** 已在装配层绑定同一订单 owner 的风险能力；prepare 无写入，订阅成功后才 publish。 */
export interface SeatActivationRisk {
  readonly prepareUnrealizedLossData: (
    symbol: string,
    isLong: boolean,
    lossOffset: string,
  ) => PreparedUnrealizedLossData;
  readonly publishUnrealizedLossData: (prepared: PreparedUnrealizedLossData) => void;
  readonly setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: string,
    isLong: boolean,
    name: string | null,
  ) => WarrantRefreshResult;
}

/** 激活用例的窄依赖；调度、停止和致命错误上报由实际 runtime 持有。 */
export interface SeatActivationWorkflowDeps {
  readonly clock: RuntimeClock;
  readonly config: DailyLossMonitorScope;
  readonly symbolRegistry: SymbolRegistry;
  readonly orders: SeatActivationOrders;
  readonly dailyLoss: Pick<
    DailyLossTracker,
    'prepareRecalculationFromAllOrders' | 'publishRecalculation' | 'getLossOffset'
  >;
  readonly risk: SeatActivationRisk;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getView' | 'isCurrent' | 'requestRefresh'>;
  readonly subscriptions: SeatActivationSubscriptions;
  readonly getQuotes: (
    symbols: ReadonlyArray<string>,
  ) => Promise<ReadonlyMap<string, Quote | null>>;
  readonly setDirectionSymbolName: (direction: 'LONG' | 'SHORT', name: string) => void;
  readonly logger: Pick<Logger, 'debug' | 'error'>;
}

/** 唯一运行期 ACTIVATING→ACTIVE owner，同时拥有外部失败一次重试和耗尽 EMPTY 决定。 */
export interface SeatActivationWorkflow {
  readonly activate: (
    request: SeatActivationRequest,
    canContinue: () => boolean,
  ) => Promise<SeatActivationResult>;
  readonly isCurrent: (request: SeatActivationRequest) => boolean;
}

/** 受控启动/开盘重建发布所需窄能力；开门状态不得调用。 */
export interface RebuiltSeatActivationDeps {
  readonly symbolRegistry: SymbolRegistry;
  readonly snapshot: Pick<AccountPositionSnapshot, 'isCurrent'>;
  readonly getIsTradingEnabled: () => boolean;
  readonly isTerminated: () => boolean;
}

/** 完整重建完成后提供的原 captured 双方向基线；时间由既有 carryover 规则决定。 */
export type RebuiltSeatActivationInput = Readonly<{
  snapshotToken: SnapshotToken;
  seats: ReadonlyArray<
    Readonly<{
      direction: 'LONG' | 'SHORT';
      symbol: string;
      status: SeatState['status'];
      seatVersion: number;
      lastSeatActivatedAt: number;
    }>
  >;
}>;
