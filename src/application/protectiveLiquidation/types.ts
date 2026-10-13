import type { AccountPositionSnapshotReader } from '../../types/accountPosition.js';
import type { TradingConfig } from '../../types/config.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type {
  PostTradeSettlementStatus,
  SettlementFreshnessReader,
} from '../../types/settlement.js';
import type { MonitorContext, LastState } from '../../types/state.js';
import type { Trader } from '../../types/services.js';
import type { QuoteUpdatedEvent } from '../../types/marketPorts.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MixedTradeLogRepository } from '../../types/tradeLog.js';
import type { LiquidationCooldownTracker } from '../../domain/liquidation/cooldown/types.js';
import type { Logger } from '../../utils/logger/types.js';

/** 当前 ACTIVE 方向的保护性清仓执行身份；runtime 路由缓存由席位 truth 事件重建。 */
export type ProtectiveLiquidationRoute = {
  readonly direction: 'LONG' | 'SHORT';
  readonly tradingSymbol: string;
  readonly seatVersion: number;
};

/** 行情入队时捕获的交易日、席位身份和报价；迟到工作不得改用当前 epoch 授权。 */
export type ProtectiveLiquidationTrigger = {
  readonly route: ProtectiveLiquidationRoute;
  readonly event: QuoteUpdatedEvent;
  readonly dayEpoch: number;
};

/** owner 对未提交工作的调度结论；不表达持仓 flat、episode 完成或业务 ready。 */
export type ProtectiveLiquidationAttemptResult = 'COMPLETE' | 'RETRY_LATEST' | 'WAIT_FOR_FRESHNESS';

/** 同一 single-flight 队列的调用能力；latest 读取与停止信号由 runtime 提供。 */
export interface ProtectiveLiquidationAttempt {
  readonly trigger: ProtectiveLiquidationTrigger;
  readonly getLatestTrigger: () => ProtectiveLiquidationTrigger | null;
  readonly isExecutionActive: () => boolean;

  /** 同步通知 runtime 等待原 readiness 事件，避免结论返回前发生的唤醒被遗漏。 */
  readonly onFreshnessBlocked: () => void;
}

/** 原 settlement owner 的只读就绪能力；protective 不签发 readiness 或制造 settlement stale。 */
export interface ProtectiveLiquidationConsistencyPort extends Pick<
  SettlementFreshnessReader,
  'waitForFresh' | 'isCurrent'
> {
  readonly getStatus: () => PostTradeSettlementStatus;
}

/** protective 真正业务 owner 的协作者；不接 completion 持久化或 episode/cooldown 提交能力。 */
export interface ProtectiveLiquidationWorkflowDeps {
  readonly logger: Pick<Logger, 'error'>;
  readonly trader: Pick<Trader, 'executeSignals'>;
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly monitorContext: Pick<
    MonitorContext,
    'riskChecker' | 'orderRecorder' | 'dailyLossTracker' | 'unrealizedLossMonitor'
  >;
  readonly lastState: Pick<LastState, 'canTrade' | 'isTradingEnabled' | 'isHalfDay'>;
  readonly postTradeConsistencyRuntime: ProtectiveLiquidationConsistencyPort;
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView' | 'isCurrent'>;
  readonly doomsdayProtectionEnabled: boolean;
  readonly now: () => Date;
  readonly termination: Pick<RuntimeTermination, 'isTerminated'>;
}

/** protective trigger、执行前授权、风险发布和执行入口；完成事务只属于 settlement。 */
export interface ProtectiveLiquidationWorkflow {
  readonly captureTrigger: (
    route: ProtectiveLiquidationRoute | null,
    event: QuoteUpdatedEvent,
  ) => ProtectiveLiquidationTrigger | null;
  readonly execute: (
    attempt: ProtectiveLiquidationAttempt,
  ) => Promise<ProtectiveLiquidationAttemptResult>;
}

/** 单方向浮亏执行器配置；日志由 composition 注入，application 不持有隐式全局 IO。 */
export interface UnrealizedLossMonitorDeps {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控。 */
  readonly maxUnrealizedLossPerSymbol: string;
  readonly logger: Pick<Logger, 'error'>;
}

/** 冷却恢复依赖；只读取 durable completion，不能在此复制 completion 判定或提交事务。 */
export interface TradeLogHydratorDeps {
  readonly nowMs: () => number;
  readonly logger: Logger;
  readonly tradingConfig: TradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly mixedTradeLogRepository: Pick<MixedTradeLogRepository, 'loadCompletionRecords'>;
}

/** 启动时从已持久化 completion 恢复当前周期冷却，不以日志中的普通成交推测完成。 */
export interface TradeLogHydrator {
  readonly hydrate: () => void;
}
