import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { SettlementFreshnessReader } from '../../types/settlement.js';
import type { MonitorContext } from '../../types/state.js';
import type { Trader } from '../../types/services.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { Quote } from '../../types/quote.js';
import type { SellSignal } from '../../types/signal.js';

/** 静态清仓只读取席位、风险和经济协作者，不持有换标、runtime 路由或保护性完成能力。 */
export type StaticLiquidationContext = Pick<
  MonitorContext,
  | 'config'
  | 'symbolRegistry'
  | 'riskChecker'
  | 'orderRecorder'
  | 'dailyLossTracker'
  | 'longSymbolName'
  | 'shortSymbolName'
>;

/** 单次业务执行的结论；WAIT 的行情重试和唤醒由 runtime 调度，不能解释成持仓 flat 或保护性完成。 */
export type StaticLiquidationExecutionResult =
  | { readonly kind: 'NOOP' }
  | { readonly kind: 'RE_EVALUATE' }
  | { readonly kind: 'COMPLETED' }
  | {
      readonly kind: 'WAIT';
      readonly wakeupSymbols: ReadonlyArray<string>;
      readonly retryAtMs: number | null;
    };

/** 静态清仓的业务协作者；所有事实读取与共享提交均由 composition 注入。 */
export interface CreateStaticLiquidationExecutorDeps {
  readonly trader: Pick<Trader, 'executeSignals'>;
  readonly marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  readonly snapshot: Pick<
    AccountPositionSnapshotReader,
    'getView' | 'getAvailablePosition' | 'isCurrent'
  >;
  readonly postTradeConsistencyRuntime: Pick<
    SettlementFreshnessReader,
    'waitForFresh' | 'isCurrent'
  >;
  readonly now: () => Date;
}

/** 一次执行保留原 route 授权及已提交方向，避免报价补齐时重提已接受的静态卖单。 */
export type StaticLiquidationExecutionParams = {
  readonly monitorContext: StaticLiquidationContext;
  readonly retryAttempts: number;
  readonly excludedDirections?: ReadonlySet<'LONG' | 'SHORT'>;
  readonly canContinue: () => boolean;
  readonly onDirectionSubmitted?: (direction: 'LONG' | 'SHORT') => void;
};

/** 已通过触发判定的非 protective 候选；quote 只用于提交成功后的静态风险发布。 */
export type StaticLiquidationCandidate = {
  readonly signal: SellSignal;
  readonly quote: Quote;
};

/** 候选准备明确区分跳过、等待行情和可执行，非法事实不降级为 WAIT。 */
export type StaticLiquidationCandidateResult =
  | { readonly kind: 'SKIP' }
  | { readonly kind: 'WAIT' }
  | { readonly kind: 'CANDIDATE'; readonly candidate: StaticLiquidationCandidate };
