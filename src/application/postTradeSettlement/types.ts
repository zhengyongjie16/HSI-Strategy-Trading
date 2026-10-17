import type {
  AccountPositionSnapshot,
  AccountPositionSnapshotReader,
  SnapshotToken,
} from '../../types/accountPosition.js';
import type {
  PostTradeSettlementStatus,
  SettlementFreshnessReader,
  SettlementProtectionRecovery,
  SettlementReadinessAbortReason,
  SettlementReadinessReceipt,
  SettlementRefreshNeedRecorder,
} from '../../types/settlement.js';
import type { RuntimeClock, RuntimeScheduler, RuntimeTermination } from '../../types/runtime.js';
import type { Logger } from '../../types/logger.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';

/** settlement owner 私有等待者；只在当前 snapshot 与水位共同有效时签发凭据。 */
export type ReadinessWaiter = {
  readonly resolve: (receipt: SettlementReadinessReceipt) => void;
  readonly reject: (error: Error) => void;
};

/** 业务完成后发布 readiness 水位；消费 snapshot 另行授权，不把凭据视作未来事实租约。 */
export interface SettlementReadinessGate {
  readonly markStale: () => number;
  readonly markFresh: (version: number, token: SnapshotToken) => boolean;
  readonly waitForFresh: () => Promise<SettlementReadinessReceipt>;
  readonly isCurrent: (receipt: SettlementReadinessReceipt) => boolean;
  readonly abortWaiting: (reason: SettlementReadinessAbortReason) => void;
  readonly resetAbort: () => void;
  readonly getStatus: () => {
    readonly currentVersion: number;
    readonly staleVersion: number;
    readonly abortReason: SettlementReadinessAbortReason | null;
    readonly ready: boolean;
  };
}

/** gate 仅读取 canonical owner；时钟与 observer 仅用于真实水位迁移的旁路诊断。 */
export type SettlementReadinessGateDeps = {
  readonly snapshot: Pick<AccountPositionSnapshotReader, 'getView' | 'isCurrent'>;
  readonly clock: Pick<RuntimeClock, 'now'>;
  readonly diagnostics: DiagnosticObserver;
};

/** 首次真实 stale 推进开启的连续未就绪区间；采样失败保留空时间，不另起或伪造耗时。 */
export type SettlementReadinessSpan = {
  readonly firstSettlementVersion: number;
  readonly startedAtMs: number | null;
};

/** tracking 提供的进行中保护性事实；symbol 保留实际成交归属，不随席位换标改写。 */
export type SettlementProtectionEpisode = {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly latestExecutedTimeMs: number;
};

/** 经原 episode 规则冻结的完成边界；最终校验与提交只属于 settlement owner。 */
export type SettlementPreparedProtectionCompletion = {
  readonly direction: 'LONG' | 'SHORT';
  readonly boundaryExecutedTimeMs: number;
};

/** completion 冻结的逐订单精确财务基线；金额/数量文本不经 number 量化。 */
export type SettlementProtectionOrderBaseline = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly cumulativeQuantity: string;
  readonly cumulativeAmount: string;
  readonly lastExecutionTimeMs: number;
  readonly orderRevisionMs: number;
};

/** daily-loss owner 准备的完整边界；durable append 成功前不得提交此投影。 */
export type SettlementPreparedLossBoundary = {
  readonly direction: 'LONG' | 'SHORT';
  readonly boundaryExecutedTimeMs: number;
  readonly orderBaselines: ReadonlyArray<SettlementProtectionOrderBaseline>;
};

/** 仓储接受的中性 completion 事实；协议版本、canonical ID 与同步追加由仓储负责。 */
export type SettlementProtectionCompletion = SettlementPreparedLossBoundary & {
  readonly monitorSymbol: string;
};

/** 原 tracking 的纯资格准备与内存 episode 提交能力，不包含最终持久化业务事务。 */
export interface SettlementProtectionEpisodes {
  readonly getInProgressEpisodes: () => ReadonlyArray<SettlementProtectionEpisode>;
  readonly prepareCompletion: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly isDirectionFlat: boolean;
    readonly hasPendingProtectiveOrders: boolean;
  }) => SettlementPreparedProtectionCompletion | null;
  readonly commitCompletion: (prepared: SettlementPreparedProtectionCompletion) => void;
}

/** 精确 daily-loss 分段能力；workflow 不拥有订单累计账本或重算实现。 */
export interface SettlementLossBoundaries {
  readonly prepareProtectionBoundary: (
    params: SettlementPreparedProtectionCompletion,
  ) => SettlementPreparedLossBoundary;
  readonly commitProtectionBoundary: (prepared: SettlementPreparedLossBoundary) => void;
  readonly getLossOffset: (direction: 'LONG' | 'SHORT') => string;
}

/** 同步 durable completion 追加能力；异常必须阻断 boundary/cooldown/episode/ready。 */
export interface SettlementCompletionPersistence {
  readonly appendCompletionIdempotent: (completion: SettlementProtectionCompletion) => void;
}

/** 配置已在 composition 固定的单次清仓触发能力；是否调用及其事务顺序由 workflow 决定。 */
export interface SettlementCooldownTriggers {
  readonly recordLiquidationTrigger: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly executedTimeMs: number;
  }) => void;
}

/** 席位 owner 的最小事实投影；ACTIVE 归属选择与冲突检查由 settlement 负责。 */
export type SettlementSeatFact = {
  readonly status: 'EMPTY' | 'SEARCHING' | 'SWITCHING' | 'ACTIVATING' | 'ACTIVE';
  readonly symbol: string | null;
};

/** 双方向身份读取能力；每次异步订阅返回后重新验证版本，拒绝迟到投影。 */
export interface SettlementSeats {
  readonly getSeatState: (direction: 'LONG' | 'SHORT') => SettlementSeatFact;
  readonly getSeatVersion: (direction: 'LONG' | 'SHORT') => number;
}

/** 当前仍可归属的激活 symbol；用于全批 prepare 后同步发布 R1/N1。 */
export type SettlementAttributedSymbol = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
};

/** 精确未发布 R1/N1；来源是风险 owner，workflow 只按身份与水位授权发布。 */
export type SettlementPreparedRiskData = {
  readonly symbol: string;
  readonly data: {
    readonly r1: string;
    readonly n1: number;
  };
};

/** 已在 composition 绑定订单成本读取的窄风险能力，不泄漏 OrderRecorder/Trader 或 SDK。 */
export interface SettlementRiskProjection {
  readonly prepare: (
    symbol: string,
    direction: 'LONG' | 'SHORT',
    dailyLossOffset: string,
  ) => SettlementPreparedRiskData;
  readonly publish: (prepared: SettlementPreparedRiskData) => void;
}

/** 构造环收口后的中性业务协作者；只能在 start 前单次绑定，缺失或重复绑定立即失败。 */
export interface PostTradeSettlementBusinessDeps {
  readonly monitorSymbol: string;
  readonly seats: SettlementSeats;
  readonly episodes: SettlementProtectionEpisodes;
  readonly lossBoundaries: SettlementLossBoundaries;
  readonly completionPersistence: SettlementCompletionPersistence;
  readonly cooldownTriggers: SettlementCooldownTriggers;
  readonly riskProjection: SettlementRiskProjection;
}

/** workflow 的窄事实/调度依赖；既有 snapshot owner 负责 broker IO，不 self-await readiness。 */
export interface PostTradeSettlementWorkflowDeps {
  readonly snapshot: Pick<
    AccountPositionSnapshot,
    'getView' | 'isCurrent' | 'getStatus' | 'requestRefresh' | 'invalidate' | 'waitForIssuedDrain'
  >;
  readonly hasPendingProtectiveOrders: (direction: 'LONG' | 'SHORT') => boolean;
  readonly onPositionsCommitted: (token: SnapshotToken) => Promise<void>;
  readonly scheduler: RuntimeScheduler;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly clock: Pick<RuntimeClock, 'now'>;
  readonly diagnostics: DiagnosticObserver;
  readonly retryDelayMs: number;
  readonly isExternalFailure: (error: unknown) => boolean;
}

/** 唯一成交后业务 owner；内聚刷新 pump、completion 事务、baseline、排空和 readiness。 */
export interface PostTradeSettlementWorkflow
  extends SettlementFreshnessReader, SettlementRefreshNeedRecorder, SettlementProtectionRecovery {
  readonly bindBusinessDeps: (deps: PostTradeSettlementBusinessDeps) => void;
  readonly getStatus: () => PostTradeSettlementStatus;
  readonly abortWaiting: () => void;
  readonly resetAbort: () => void;
  readonly start: () => void;
  readonly stopScheduling: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly midnightClear: () => void;
  readonly completeRebuildBaseline: () => Promise<boolean>;
}
