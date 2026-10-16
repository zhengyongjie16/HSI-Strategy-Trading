import type { LifecycleMutableState } from '../../types/lifecycle.js';

/**
 * 交易日生命周期管理器
 *
 * 核心职责：
 * - 检测跨日（dayKey 变化），触发午夜清理流程
 * - 在交易日开盘时，触发开盘重建流程
 * - 管理交易门禁（isTradingEnabled），在生命周期切换期间禁止交易
 *
 * 生命周期状态流转：
 * ACTIVE → MIDNIGHT_CLEANING → MIDNIGHT_CLEANED → OPEN_REBUILDING → ACTIVE
 *                ↓ 失败重试                              ↓ 失败重试
 *          MIDNIGHT_CLEANING                     OPEN_REBUILD_FAILED
 *
 * 执行机制：
 * - 由时间唤醒评估按交易日与交易门禁边界推进 tick()
 * - 午夜清理：按注册顺序依次执行各 CacheDomain 的 midnightClear
 * - 开盘重建：按注册逆序依次执行各 CacheDomain 的 openRebuild
 * - 失败自动重试：指数退避策略，不吞错
 */
import type { RuntimeTermination } from '../../types/runtime.js';
import type { SnapshotToken } from '../../types/accountPosition.js';
import { LIFECYCLE } from '../../constants/index.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type {
  CacheDomain,
  CacheDomainOpenRebuildResult,
  OpenRebuildContext,
  DayLifecycleManagerDeps,
  LifecycleContext,
} from './types.js';
import type {
  DayLifecycleManager,
  DayLifecycleTickResult,
  LifecycleRuntimeFlags,
} from '../../types/timeControlPlane.js';

/** 判断是否需要触发午夜清理：dayKey 存在且与当前记录的日期不同 */
function shouldRunMidnightClear(
  runtime: LifecycleRuntimeFlags,
  mutableState: LifecycleMutableState,
): boolean {
  if (!runtime.dayKey) {
    return false;
  }

  return runtime.dayKey !== mutableState.currentDayKey;
}

/** 构造传递给各 CacheDomain 的生命周期上下文 */
function buildLifecycleContext(
  now: Date,
  runtime: LifecycleRuntimeFlags,
  invalidateSeatActivationCarryover: boolean = false,
): LifecycleContext {
  return {
    now,
    runtime,
    invalidateSeatActivationCarryover,
  };
}

/** 不吞错：任一路径失败即抛出，由 tick 负责失败重试。 */
async function runMidnightClearForDomains(
  domains: ReadonlyArray<CacheDomain>,
  ctx: LifecycleContext,
  termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>,
): Promise<void> {
  for (const domain of domains) {
    if (termination.isTerminated()) return;

    await domain.midnightClear(ctx);
  }
}

/** 按逆序执行实际开盘工作；取消阻断后续域，旧 void/非法结果与异常绝不当成功。 */
async function runOpenRebuildForDomains(
  domains: ReadonlyArray<CacheDomain>,
  ctx: OpenRebuildContext,
  isCapturedCurrent: (token: SnapshotToken) => boolean,
): Promise<CacheDomainOpenRebuildResult> {
  let committedToken: SnapshotToken | null = null;
  for (let idx = domains.length - 1; idx >= 0; idx -= 1) {
    const domain = domains[idx];
    if (!domain) {
      continue;
    }

    if (!ctx.isCurrent()) return { status: 'ABORTED' };

    const result = await domain.openRebuild({
      ...ctx,
      snapshotToken: committedToken ?? ctx.snapshotToken,
    });
    const resultInput: unknown = result;
    if (typeof resultInput !== 'object' || resultInput === null || !('status' in resultInput)) {
      throw new TypeError('[Lifecycle] 开盘域必须返回 COMMITTED 或 ABORTED');
    }

    if (resultInput.status !== 'COMMITTED' && resultInput.status !== 'ABORTED') {
      throw new TypeError('[Lifecycle] 开盘域必须返回 COMMITTED 或 ABORTED');
    }

    if (result.status === 'ABORTED') return result;

    const tokenInput: unknown = result.snapshotToken;
    if (typeof tokenInput !== 'object' || tokenInput === null) {
      throw new TypeError('[Lifecycle] COMMITTED 开盘域必须携带原 captured snapshotToken');
    }

    for (const component of [
      'dayEpoch',
      'snapshotGeneration',
      'commitRevision',
      'accountRevision',
      'positionRevision',
      'pairedRevision',
    ] as const) {
      const revision = result.snapshotToken[component];
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError(`[Lifecycle] 开盘域 captured token.${component} 必须是非负安全整数`);
      }

      if (committedToken !== null && committedToken[component] !== revision) {
        throw new TypeError('[Lifecycle] 下游开盘域不得替换原 captured snapshotToken');
      }
    }

    if (result.snapshotToken.dayEpoch !== ctx.dayEpoch) {
      throw new TypeError('[Lifecycle] 开盘域返回外来 dayEpoch token');
    }

    if (!ctx.isCurrent() || !isCapturedCurrent(result.snapshotToken)) return { status: 'ABORTED' };

    committedToken = result.snapshotToken;
  }

  return committedToken !== null && ctx.isCurrent() && isCapturedCurrent(committedToken)
    ? { status: 'COMMITTED', snapshotToken: committedToken }
    : { status: 'ABORTED' };
}

/** 计算指数退避重试延迟，失败次数越多延迟越长，上限由 MAX_RETRY_BACKOFF_FACTOR 控制 */
function resolveRetryDelayMs(baseDelayMs: number, rebuildFailureCount: number): number {
  const factor = Math.min(
    2 ** Math.max(rebuildFailureCount - 1, 0),
    LIFECYCLE.MAX_RETRY_BACKOFF_FACTOR,
  );
  return baseDelayMs * factor;
}

/**
 * 创建交易日生命周期管理器。对外暴露 tick(now, runtime)，由时间唤醒评估按边界推进；
 * 内部根据 dayKey 变化执行午夜清理（各 CacheDomain.midnightClear），再在开盘后执行开盘重建（各 CacheDomain.openRebuild），
 * 失败时指数退避重试，不吞错。用于跨日状态重置与开盘状态恢复。
 *
 * @param deps 依赖注入，包含 mutableState、cacheDomains、logger、rebuildRetryDelayMs
 * @returns DayLifecycleManager，仅含 tick 方法
 */
export function createDayLifecycleManager(deps: DayLifecycleManagerDeps): DayLifecycleManager {
  const {
    mutableState,
    termination,
    cacheDomains,
    snapshot,
    logger,
    rebuildRetryDelayMs = LIFECYCLE.DEFAULT_REBUILD_RETRY_DELAY_MS,
  } = deps;
  let rebuildFailureCount = 0;
  let nextRetryAtMs: number | null = null;
  let midnightClearFailureCount = 0;
  let nextMidnightRetryAtMs: number | null = null;
  let invalidateSeatActivationCarryoverOnMidnightClear = false;
  let invalidatedDayKey: string | null = null;
  let dayCutDrain: Promise<void> | null = null;
  let openOwner: object | null = null;

  function buildTickResult(): DayLifecycleTickResult {
    return {
      nextRetryAtMs: nextMidnightRetryAtMs ?? nextRetryAtMs,
      pendingOpenRebuild: mutableState.pendingOpenRebuild,
    };
  }

  /**
   * 由时间唤醒评估驱动的生命周期推进。
   * 按优先级依次处理：跨日午夜清理 → 等待开盘重建 → 恢复交易门禁。
   * 外部 API 失败记录错误并进入指数退避重试；内部逻辑错误直接抛出以保持 fail-fast。
   */
  async function tick(now: Date, runtime: LifecycleRuntimeFlags): Promise<DayLifecycleTickResult> {
    if (termination.isTerminated()) {
      openOwner = null;
      mutableState.isTradingEnabled = false;
      return buildTickResult();
    }

    if (shouldRunMidnightClear(runtime, mutableState)) {
      openOwner = null;
      invalidateSeatActivationCarryoverOnMidnightClear =
        invalidateSeatActivationCarryoverOnMidnightClear ||
        mutableState.lifecycleState === 'OPEN_REBUILD_FAILED';
      mutableState.isTradingEnabled = false;
      mutableState.lifecycleState = 'MIDNIGHT_CLEANING';
      // 先同步关闭 snapshot admission、失效旧 epoch 并取消 waiter，随后才 drain 消费者。
      // 同一次日切外部失败重试不能再次推进 epoch。
      if (invalidatedDayKey !== runtime.dayKey) {
        const dayEpoch = snapshot.getStatus().token.dayEpoch + 1;
        if (!Number.isSafeInteger(dayEpoch)) {
          const error = new RangeError('[Lifecycle] dayEpoch 超出安全整数范围');
          termination.reportFatalError(error);
          throw error;
        }

        invalidatedDayKey = runtime.dayKey;
        dayCutDrain = snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch });
        // 清理继续按原域顺序推进；立即观察拒绝，防止未处理 rejection 或延迟 fatal。
        void dayCutDrain.catch((error: unknown) => {
          if (!isExternalApiRequestError(error)) termination.reportFatalError(error);
        });
      }

      const nowMs = now.getTime();
      if (nextMidnightRetryAtMs !== null && nowMs < nextMidnightRetryAtMs) {
        return buildTickResult();
      }

      logger.info(
        `[Lifecycle] 检测到跨日: ${runtime.dayKey ?? 'unknown'}` +
          (midnightClearFailureCount > 0 ? `，第 ${midnightClearFailureCount + 1} 次重试` : ''),
      );
      const midnightContext = buildLifecycleContext(
        now,
        runtime,
        invalidateSeatActivationCarryoverOnMidnightClear,
      );
      try {
        await runMidnightClearForDomains(cacheDomains, midnightContext, termination);
        await dayCutDrain;
        if (termination.isTerminated()) return buildTickResult();

        mutableState.currentDayKey = runtime.dayKey ?? mutableState.currentDayKey;
        mutableState.lifecycleState = 'MIDNIGHT_CLEANED';
        mutableState.pendingOpenRebuild = true;
        midnightClearFailureCount = 0;
        nextMidnightRetryAtMs = null;
        invalidateSeatActivationCarryoverOnMidnightClear = false;
        rebuildFailureCount = 0;
        nextRetryAtMs = null;
        logger.info('[Lifecycle] 已完成午夜清理，等待开盘重建');
      } catch (err) {
        if (!isExternalApiRequestError(err)) {
          termination.reportFatalError(err);
          throw err;
        }

        midnightClearFailureCount += 1;
        const retryDelayMs = resolveRetryDelayMs(rebuildRetryDelayMs, midnightClearFailureCount);
        nextMidnightRetryAtMs = nowMs + retryDelayMs;
        logger.error(
          `[Lifecycle] 午夜清理失败，第 ${midnightClearFailureCount} 次重试将在 ${Math.round(retryDelayMs / 1000)} 秒后触发`,
          formatError(err),
        );
      }

      return buildTickResult();
    }

    if (!mutableState.pendingOpenRebuild) {
      mutableState.lifecycleState = 'ACTIVE';
      mutableState.isTradingEnabled = true;
      return buildTickResult();
    }

    mutableState.isTradingEnabled = false;
    if (!runtime.isTradingDay || !runtime.canTradeNow) {
      return buildTickResult();
    }

    const nowMs = now.getTime();
    if (nextRetryAtMs !== null && nowMs < nextRetryAtMs) {
      return buildTickResult();
    }

    const owner = {};
    openOwner = owner;
    const dayEpoch = snapshot.getStatus().token.dayEpoch;
    const dayKey = mutableState.currentDayKey;
    const isOpenOwnerCurrent = (): boolean =>
      openOwner === owner &&
      !termination.isTerminated() &&
      snapshot.getStatus().token.dayEpoch === dayEpoch &&
      snapshot.getStatus().admission !== 'CLOSED' &&
      mutableState.currentDayKey === dayKey &&
      mutableState.lifecycleState === 'OPEN_REBUILDING' &&
      mutableState.pendingOpenRebuild;
    mutableState.lifecycleState = 'OPEN_REBUILDING';
    const isCapturedCurrent = (token: SnapshotToken): boolean =>
      isOpenOwnerCurrent() &&
      snapshot.isCurrent(token, { account: true, positions: true, paired: true });
    try {
      // 仅开启生命周期重建读取；普通交易预算继续关闭，最终 current COMMITTED 才放行。
      snapshot.beginRebuild();
      logger.info('[Lifecycle] 开始执行开盘重建');
      const rebuildContext: OpenRebuildContext = {
        ...buildLifecycleContext(now, runtime),
        dayEpoch,
        snapshotToken: snapshot.getStatus().token,
        isCurrent: isOpenOwnerCurrent,
      };
      const result = await runOpenRebuildForDomains(
        cacheDomains,
        rebuildContext,
        isCapturedCurrent,
      );
      if (result.status === 'ABORTED' || !isCapturedCurrent(result.snapshotToken)) {
        // 取消不是成功或外部失败，不计重试、不新增 timer；新日由原 tick 流程接管。
        if (openOwner === owner) {
          mutableState.isTradingEnabled = false;
          mutableState.pendingOpenRebuild = true;
          mutableState.lifecycleState = 'MIDNIGHT_CLEANED';
          nextRetryAtMs = null;
          openOwner = null;
        }

        return buildTickResult();
      }

      snapshot.openAdmission();
      mutableState.pendingOpenRebuild = false;
      mutableState.lifecycleState = 'ACTIVE';
      mutableState.isTradingEnabled = true;
      rebuildFailureCount = 0;
      nextRetryAtMs = null;
      openOwner = null;
      logger.info('[Lifecycle] 开盘重建完成，交易门禁已恢复');
    } catch (err) {
      if (!isExternalApiRequestError(err)) {
        termination.reportFatalError(err);
        throw err;
      }

      if (!isOpenOwnerCurrent()) throw err;

      openOwner = null;
      rebuildFailureCount += 1;
      mutableState.lifecycleState = 'OPEN_REBUILD_FAILED';
      mutableState.isTradingEnabled = false;
      const retryDelayMs = resolveRetryDelayMs(rebuildRetryDelayMs, rebuildFailureCount);
      nextRetryAtMs = nowMs + retryDelayMs;
      logger.error(
        `[Lifecycle] 开盘重建失败，第 ${rebuildFailureCount} 次重试将在 ${Math.round(retryDelayMs / 1000)} 秒后触发`,
        formatError(err),
      );
    }

    return buildTickResult();
  }
  return {
    tick,
  };
}
