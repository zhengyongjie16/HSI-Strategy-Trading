import type { RuntimeTermination } from '../../types/runtime.js';
import type { AccountPositionSnapshot, SnapshotToken } from '../../types/accountPosition.js';
import type { Logger } from '../../types/logger.js';
import type { LifecycleMutableState } from '../../types/lifecycle.js';
import type { LifecycleRuntimeFlags } from '../../types/timeControlPlane.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';

/**
 * 传递给各 CacheDomain 回调的上下文（midnightClear / openRebuild 的入参）。
 * 类型用途：供各缓存域在午夜清理与开盘重建时使用，包含当前时间与运行时标志。
 * 数据来源：由 DayLifecycleManager 在调用 cacheDomain.midnightClear/openRebuild 时组装传入。
 * 使用范围：仅 lifecycle 与各 cacheDomains 使用，内部使用。
 */
export type LifecycleContext = Readonly<{
  now: Date;
  runtime: LifecycleRuntimeFlags;
  invalidateSeatActivationCarryover?: boolean;
}>;

/**
 * 单次开盘域调用的原 owner 授权。
 * 由 manager 在首个 await 前固定 dayEpoch 与 owner 身份；下游只读取，不重新绑定当前输入。
 */
export type OpenRebuildContext = LifecycleContext & {
  readonly dayEpoch: number;
  readonly snapshotToken: SnapshotToken;
  readonly isCurrent: () => boolean;
};

/**
 * 开盘域回调结果。COMMITTED 仅在域内实际工作完成后返回，ABORTED 阻断后续域与 ACTIVE。
 * 不把旧 void/undefined 回调当成功，内部与外部失败继续抛原异常。
 */
export type CacheDomainOpenRebuildResult =
  | { readonly status: 'COMMITTED'; readonly snapshotToken: SnapshotToken }
  | { readonly status: 'ABORTED' };

/**
 * 缓存域接口，每个域负责自身数据的午夜清理与开盘重建。
 * 类型用途：依赖注入给 DayLifecycleManager，在跨日与开盘时被调用；midnightClear 按注册顺序、openRebuild 按逆序执行。
 * 数据来源：由主程序注册各 CacheDomain 实现（如 globalStateDomain、orderDomain 等）。
 * 使用范围：仅 lifecycle 模块及 cacheDomains 实现使用。
 */
export interface CacheDomain {
  readonly midnightClear: (ctx: LifecycleContext) => Promise<void> | void;
  readonly openRebuild: (
    ctx: OpenRebuildContext,
  ) => Promise<CacheDomainOpenRebuildResult> | CacheDomainOpenRebuildResult;
}

/**
 * 交易日生命周期管理器依赖（创建 DayLifecycleManager 时的参数）。
 * 类型用途：createDayLifecycleManager 的依赖注入，包含可变状态、缓存域列表、日志与重试间隔等。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 lifecycle 及启动流程使用，内部使用。
 */
export interface DayLifecycleManagerDeps {
  readonly diagnostics: DiagnosticObserver;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
  readonly mutableState: LifecycleMutableState;
  readonly cacheDomains: ReadonlyArray<CacheDomain>;
  readonly snapshot: Pick<
    AccountPositionSnapshot,
    'getStatus' | 'requestClear' | 'beginRebuild' | 'openAdmission' | 'isCurrent'
  >;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly rebuildRetryDelayMs?: number;
}
