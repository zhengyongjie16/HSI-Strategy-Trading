import type { RuntimeTermination } from '../../types/runtime.js';
import type { SettlementFreshnessReader } from '../../types/settlement.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { Logger } from '../../types/logger.js';
import type {
  ProtectiveLiquidationRoute,
  ProtectiveLiquidationTrigger,
  ProtectiveLiquidationWorkflow,
} from '../../application/protectiveLiquidation/types.js';

/** 席位 truth 事件重建的行情路由缓存；业务最终授权由 application 重新读取当前席位。 */
export type TradingRiskRoutingIndex = {
  readonly routesBySymbol: ReadonlyMap<string, ProtectiveLiquidationRoute>;
  readonly activeRouteKeys: ReadonlySet<'LONG' | 'SHORT'>;
};

/** runtime 私有方向队列；可变字段仅用于 single-flight、latest-only 及原 readiness 事件唤醒。 */
export type RouteExecutionState = {
  inFlight: boolean;
  dirty: boolean;
  latestTrigger: ProtectiveLiquidationTrigger | null;
  blockedOnFreshness: boolean;
};

/** 风险 runtime 的事件/调度端口，不读取交易门禁、ready 版本或发布风险缓存。 */
export interface TradingRiskEventRuntimeDeps {
  readonly logger: Pick<Logger, 'error'>;
  readonly marketDataClient: Pick<MarketDataClient, 'onQuoteUpdated'>;
  readonly symbolRegistry: Pick<
    SymbolRegistry,
    'getSeatState' | 'getSeatVersion' | 'onSeatTruthChanged'
  >;
  readonly postTradeConsistencyRuntime: Pick<SettlementFreshnessReader, 'onFreshReached'>;
  readonly workflow: ProtectiveLiquidationWorkflow;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
}

/** 行情路由、latest-only 队列及停止排空能力；freshness 等待由原 settlement owner 中止。 */
export interface TradingRiskEventRuntime {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
}
