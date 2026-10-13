import type { Logger } from '../../utils/logger/types.js';
import type { Position } from '../../types/account.js';
import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { MonitorConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { ExecutableSellSignal } from '../../types/signal.js';
import type { OrderRecorder, Trader } from '../../types/services.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { SettlementFreshnessReader } from '../../types/settlement.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { RuntimeClock, RuntimeTermination } from '../../types/runtime.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

/** 持仓/行情准入结果；不可卖等业务情况明确转 HOLD，非法内部数量仍 fail-fast。 */
export type SellContextValidationResult =
  | { readonly valid: true; readonly availableQuantity: number; readonly currentPrice: string }
  | { readonly valid: false; readonly reason: string };

/** 计算后明确不执行的卖出信号，保留原路由身份但删除保护性执行权限。 */
type HeldSellSignal = Omit<ExecutableSellSignal, 'action' | 'isProtectiveLiquidation'> & {
  readonly action: 'HOLD';
  readonly isProtectiveLiquidation: false;
};

/** 真实卖量计算的结果；普通 reason 不能赋予任何清仓权限。 */
export type ProcessedSellSignal = ExecutableSellSignal | HeldSellSignal;

/** 数量用例只读取原成本和可卖订单事实，不拥有订单记录或占用状态。 */
export type ProcessSellSignalsParams = {
  readonly signals: ReadonlyArray<ExecutableSellSignal>;
  readonly longPosition: Position | null;
  readonly shortPosition: Position | null;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly orderRecorder: Pick<OrderRecorder, 'getCostBasis' | 'selectSellableOrders'>;
  readonly smartCloseEnabled: boolean;
  readonly smartCloseTimeoutMinutes: number | null;
  readonly nowMs: number;
  readonly isHalfDay: boolean;
  readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
};

/** application 签发的限次报价重试；runtime 只保存和调度，不决定是否继续业务。 */
export type SellQuoteRetry = {
  readonly signal: ExecutableSellSignal;
  readonly attempts: number;
  readonly dayEpoch: number;
  readonly delayMs: number;
  readonly isCurrent: () => boolean;
};

/** 本轮 SELL 完成（含安全拒绝）或等待报价；supersession 在 application 内重选，不消耗报价重试。 */
export type SellExecutionOutcome =
  { readonly status: 'COMPLETED' } | { readonly status: 'RETRY'; readonly retry: SellQuoteRetry };

/** FIFO worker 的运行代次授权及此前由同一 application 签发的报价重试。 */
export type SellExecutionAttempt = {
  readonly isActive: () => boolean;
  readonly retry: SellQuoteRetry | null;
};

/** 完整普通 SELL 的窄能力；不依赖 BUY 风控、总 MonitorContext 或旧 SignalProcessor。 */
export interface OrdinarySellWorkflowDeps {
  readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  readonly config: Pick<MonitorConfig, 'smartCloseEnabled' | 'smartCloseTimeoutMinutes'>;
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly orderRecorder: ProcessSellSignalsParams['orderRecorder'];
  readonly trader: Pick<Trader, 'executeSignals'>;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly snapshot: Pick<
    AccountPositionSnapshotReader,
    'getView' | 'getAvailablePosition' | 'isCurrent'
  >;
  readonly settlement: Pick<SettlementFreshnessReader, 'waitForFresh' | 'isCurrent'>;
  readonly getTradingCalendar: () => {
    readonly isHalfDay: boolean;
    readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
  };
  readonly clock: RuntimeClock;
  readonly getCanProcessTask: () => boolean;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}

/** ordinarySell 唯一业务入口；scheduler、queue、start/stop/drain 均不属于此 owner。 */
export interface OrdinarySellWorkflow {
  readonly execute: (
    signal: ExecutableSellSignal,
    attempt: SellExecutionAttempt,
  ) => Promise<SellExecutionOutcome>;
}
