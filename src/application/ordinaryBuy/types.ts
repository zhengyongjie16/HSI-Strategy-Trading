import type { Logger } from '../../types/logger.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { AccountService } from '../../types/accountReadPorts.js';
import type { ExternalApiRetryConfig } from '../../types/apiFailure.js';
import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { MonitorConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { BuySignal } from '../../types/signal.js';
import type { TradeFrequencyReader, SignalExecutor } from '../../types/orderExecutionPorts.js';
import type { OrderRecorder } from '../../types/orderRecorder.js';
import type { RiskChecker } from '../../types/riskCheck.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { RuntimeClock, RuntimeTermination } from '../../types/runtime.js';
import type { LiquidationCooldownTracker } from '../../domain/liquidation/cooldown/types.js';

/** 单次买入检查事实；实时账户/持仓读取不提交 canonical snapshot 或 settlement ready。 */
export type BuyRiskCheckContext = {
  readonly accountService: AccountService;
  readonly tradeFrequencyReader: TradeFrequencyReader;
  readonly riskChecker: Pick<
    RiskChecker,
    'checkBeforeOrder' | 'checkWarrantRisk' | 'checkUnrealizedLoss'
  >;
  readonly orderRecorder: Pick<OrderRecorder, 'getLatestBuyOrderCost'>;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly monitorQuote: Quote;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSymbolName: string | null;
  readonly shortSymbolName: string | null;
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly config: Pick<
    MonitorConfig,
    'buyIntervalSeconds' | 'liquidationCooldown' | 'targetNotional'
  >;
};

/** 风险检查实现参数；冷却 Map 只由 ordinaryBuy owner 持有，失败后不回滚。 */
export interface BuyRiskCheckDeps {
  readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  readonly doomsdayProtection: boolean;
  readonly liquidationCooldownTracker: Pick<LiquidationCooldownTracker, 'getRemainingMs'>;
  readonly lastRiskCheckTime: Map<string, number>;
  readonly reportFatalError: (error: unknown) => void;
}

/** 普通买入用例的窄能力；由 app 注入同一席位、同步风险状态及真实订单执行入口。 */
export interface OrdinaryBuyWorkflowDeps {
  readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  readonly config: BuyRiskCheckContext['config'] & Pick<MonitorConfig, 'monitorSymbol'>;
  readonly doomsdayProtection: boolean;
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly orderRecorder: BuyRiskCheckContext['orderRecorder'];
  readonly riskChecker: BuyRiskCheckContext['riskChecker'];
  readonly accountService: AccountService;
  readonly tradeFrequencyReader: TradeFrequencyReader;
  readonly orderExecutor: SignalExecutor;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly liquidationCooldownTracker: BuyRiskCheckDeps['liquidationCooldownTracker'];
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView'>;
  readonly getIsHalfDay: () => boolean;
  readonly now: RuntimeClock['now'];
  readonly getCanProcessTask: () => boolean;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}

/** 普通 BUY 唯一入口及跨日冷却清理；不包含 SELL 业务或队列生命周期。 */
export interface OrdinaryBuyWorkflow {
  readonly execute: (signal: BuySignal) => Promise<void>;
  readonly resetRiskCheckCooldown: () => void;
}

/** 普通买入风控的临时双读取能力；fatal 必须显式注入，不持有快照 writer 或 readiness。 */
export interface AccountPositionsReadParams {
  readonly accountService: AccountService;
  readonly retryConfig?: ExternalApiRetryConfig;
  readonly reportFatalError: RuntimeTermination['reportFatalError'];
}

/** 两个临时读取均成功后的风控事实，仅供当前买入检查使用，不构成 canonical commit。 */
export type AccountPositionsReadResult = {
  readonly account: AccountSnapshot;
  readonly positions: ReadonlyArray<Position>;
};
