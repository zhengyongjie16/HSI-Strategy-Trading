import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type { DoomsdayOrderCancellation } from '../../types/orderCancellation.js';
import type { OrderCacheManager } from '../orderTracking/types.js';
import type { DoomsdaySignalExecutor } from '../../types/orderExecutionPorts.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { AccountPositionSnapshot } from '../../types/accountPosition.js';
import type { SellSignalAction } from '../../types/signal.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { SeatSwitchWorkflow } from '../../types/seatSwitch.js';
import type { Logger } from '../../types/logger.js';

/** 末日 owner 所需的席位归属与本地买单投影能力，不携带策略、风控或整个监控上下文。 */
export type DoomsdayMonitorContext = {
  readonly config: { readonly monitorSymbol: string };
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly seatSwitch: Pick<SeatSwitchWorkflow, 'hasPendingSwitch'>;
  readonly orderRecorder: Pick<OrderRecorder, 'clearBuyOrders'>;
};

/** 已验证持仓与行情构造的末日卖出身份；不保存执行价格、数量或关联买单。 */
export type ClearanceSignalParams = {
  readonly symbol: string;
  readonly symbolName: string | null;
  readonly action: SellSignalAction;
  readonly triggerTime: Date;
  readonly seatVersion: number;
};

/** 单个持仓的末日命令解析参数，由清仓流程完成归属与行情读取后组装。 */
export type PositionClearanceParams = {
  readonly position: Position;
  readonly longSymbol: string | null;
  readonly shortSymbol: string | null;
  readonly longSeatVersion: number | null;
  readonly shortSeatVersion: number | null;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly triggerTime: Date;
};

/** 末日清仓所需的中性事实与窄行为端口；accepted 只能在原 all-success/live 条件下失效账户。 */
export type DoomsdayClearanceContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly isLive: () => boolean;
  readonly positions: ReadonlyArray<Position>;
  readonly monitorContext: DoomsdayMonitorContext;
  readonly orderExecutor: DoomsdaySignalExecutor;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly lifecycleState: Readonly<Pick<LifecycleMutableState, 'isTradingEnabled'>>;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getView' | 'invalidateAccount'>;
};

/** 清仓结果，只报告已确认提交与下一次窗口内重评估，不表示成交或空仓。 */
export type DoomsdayClearanceResult = {
  readonly executed: boolean;
  readonly nextRetryAtMs: number | null;
};

/** 买入截止窗口的撤单上下文，原实时授权透传到既有 tracking 的 mutation permit。 */
export type CancelPendingBuyOrdersContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly isLive: () => boolean;
  readonly monitorContext: DoomsdayMonitorContext;
  readonly cacheManager: Pick<OrderCacheManager, 'getPendingOrders'>;
  readonly orderMonitor: DoomsdayOrderCancellation;
};

/** 买单撤单的确认计数与重评估结果；accepted 的最终终态继续由既有订单回报推进。 */
export type CancelPendingBuyOrdersResult = {
  readonly executed: boolean;
  readonly cancelRequestAcceptedCount: number;
  readonly nextRetryAtMs: number | null;
};

/** 时间控制平面一次评估所交付的末日上下文；origin epoch 在其首个 await 前固定。 */
export type DoomsdayEvaluationContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly dayEpoch: number;
  readonly monitorContext: DoomsdayMonitorContext;
  readonly orderExecutor: DoomsdaySignalExecutor;
  readonly cacheManager: Pick<OrderCacheManager, 'getPendingOrders'>;
  readonly orderMonitor: DoomsdayOrderCancellation;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly lifecycleState: Readonly<Pick<LifecycleMutableState, 'isTradingEnabled'>>;
  readonly snapshot: Pick<AccountPositionSnapshot, 'getView' | 'invalidateAccount'>;
};

/** 唯一末日用例的注入依赖；日志与时间由 app 组装，未指定重试参数时使用既有集中配置。 */
export type DoomsdayClearanceWorkflowDeps = {
  readonly now: () => Date;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn'>;
  readonly quoteRetryIntervalMs?: number;
  readonly quoteRetryMaxAttempts?: number;
};

/** 末日业务 owner：撤买、席位归属、行情等待、清仓成功副作用与失败策略集中于同一实例。 */
export interface DoomsdayClearanceWorkflow {
  /** 顺序执行撤买与清仓；submit UNKNOWN 原错上抛，明确外部读取失败按原规则重评估。 */
  readonly evaluate: (context: DoomsdayEvaluationContext) => Promise<DoomsdayClearanceResult>;

  /** 根据 canonical 持仓生成命令，数量、旧卖单终态与订单事实由既有执行/追踪 owner 负责。 */
  readonly executeClearance: (
    context: DoomsdayClearanceContext,
  ) => Promise<DoomsdayClearanceResult>;

  /** 处理当日一次买单撤销检查，不把 cancel accepted 当作最终终态。 */
  readonly cancelPendingBuyOrders: (
    context: CancelPendingBuyOrdersContext,
  ) => Promise<CancelPendingBuyOrdersResult>;
}
