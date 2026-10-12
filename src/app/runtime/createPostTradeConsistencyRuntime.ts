/**
 * 成交后一致性运行时工厂模块
 *
 * 职责：
 * - 统一拥有成交后 freshness gate 与账户/持仓刷新内核
 * - 在运行时未启动前先收口 stale 需求，启动后再消费积压刷新
 * - 统一执行成交后的关键业务收尾：保护性清仓完成判定、daily loss episode 推进、liquidation cooldown 推进与 R1/N1 刷新
 * - 暴露 lifecycle 可调用的 baseline 推进、停止排空与跨日清理能力
 */
import { API } from '../../constants/index.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { MonitorContext } from '../../types/state.js';
import type { Trader } from '../../types/services.js';
import type {
  AccountPositionSnapshotView,
  SnapshotRefreshHandle,
  SnapshotToken,
} from '../../types/accountPosition.js';
import type { SettlementRefreshNeed, SettlementReadinessReceipt } from '../../types/settlement.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { logger } from '../../utils/logger/index.js';
import { createSettlementReadinessGate } from '../../application/postTradeSettlement/readinessGate.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import type {
  PostTradeConsistencyRuntime,
  PostTradeConsistencyRuntimeBusinessDeps,
  PostTradeConsistencyRuntimeDeps,
  PostTradeConsistencyRuntimeStatus,
} from '../types.js';

/**
 * 合并两次成交后刷新需求。
 *
 * @param current 当前积压的刷新需求
 * @param incoming 新进入的刷新需求
 * @returns 合并后的刷新需求
 */
function mergeRefreshNeed(
  current: SettlementRefreshNeed,
  incoming: SettlementRefreshNeed,
): SettlementRefreshNeed {
  return {
    refreshAccount: current.refreshAccount || incoming.refreshAccount,
    refreshPositions: current.refreshPositions || incoming.refreshPositions,
  };
}

/**
 * 创建空的刷新需求初始值。
 *
 * @returns 不要求刷新账户也不要求刷新持仓的空需求
 */
function createEmptyRefreshNeed(): SettlementRefreshNeed {
  return {
    refreshAccount: false,
    refreshPositions: false,
  };
}

/**
 * 判断当前是否还存在待处理刷新需求。
 *
 * @param need 待判断的刷新需求
 * @returns 只要账户或持仓任一维度需要刷新即返回 true
 */
function hasRefreshNeed(need: SettlementRefreshNeed): boolean {
  return need.refreshAccount || need.refreshPositions;
}

/**
 * 选取需要保留的刷新版本。
 *
 * 在刷新失败且期间又收到更新 stale 版本时，必须保留更大的版本号，
 * 避免把更新版本回退成旧批次版本。
 *
 * @param currentPendingVersion 当前已积压的版本号
 * @param minimumRetainedVersion 本批次至少要保留的版本号
 * @returns 下一次重试应追上的目标版本
 */
function mergePendingVersion(
  currentPendingVersion: number | null,
  minimumRetainedVersion: number,
): number {
  if (currentPendingVersion === null) {
    return minimumRetainedVersion;
  }

  return Math.max(currentPendingVersion, minimumRetainedVersion);
}

/**
 * 判断指定交易标的在最新持仓缓存下是否已空仓。
 *
 * @param symbol 需要判定的原始保护性清仓标的
 * @param getQuantityBySymbol 从 snapshot 读取数量的函数
 * @returns 对应标的无持仓或数量小于等于 0 时返回 true
 */
function isSymbolFlatBySnapshot(
  symbol: string,
  getQuantityBySymbol: (symbol: string) => { quantity: number } | null,
): boolean {
  const position = getQuantityBySymbol(symbol);
  if (position === null) {
    return true;
  }

  return position.quantity <= 0;
}

/**
 * 记录交易标的方向归属，并在检测到 LONG/SHORT 重复归属时立即失败。
 *
 * @param attributedDirections 当前已记录的 symbol -> direction 映射
 * @param attributedSymbols 当前已收集的可归属交易标的
 * @param symbol 待归属的交易标的
 * @param direction 当前席位方向
 */
function registerAttributedSeatSymbolOrThrow(
  attributedDirections: Map<string, ProtectiveLiquidationDirection>,
  attributedSymbols: Array<
    Readonly<{
      readonly symbol: string;
      readonly direction: ProtectiveLiquidationDirection;
    }>
  >,
  symbol: string,
  direction: ProtectiveLiquidationDirection,
): void {
  const existingDirection = attributedDirections.get(symbol);
  if (existingDirection !== undefined) {
    throw new Error(
      `[PostTradeConsistencyRuntime] 标的重复归属: ${symbol} 同时归属 ${existingDirection} 与 ${direction}`,
    );
  }

  attributedDirections.set(symbol, direction);
  attributedSymbols.push({ symbol, direction });
}

/**
 * 构建当前激活交易标的的方向归属列表。
 *
 * 仅收集唯一 monitor 当前激活席位，确保成交后 R1/N1 刷新只触达仍可归属的 symbol。
 *
 * @param monitorContext 唯一监控上下文
 * @returns 可归属交易标的及其方向
 */
function buildAttributedSeatSymbols(monitorContext: MonitorContext): ReadonlyArray<
  Readonly<{
    readonly symbol: string;
    readonly direction: ProtectiveLiquidationDirection;
  }>
> {
  const attributedDirections = new Map<string, ProtectiveLiquidationDirection>();
  const attributedSymbols: Array<
    Readonly<{
      readonly symbol: string;
      readonly direction: ProtectiveLiquidationDirection;
    }>
  > = [];
  const longSeatState = monitorContext.symbolRegistry.getSeatState('LONG');
  const shortSeatState = monitorContext.symbolRegistry.getSeatState('SHORT');

  if (isSeatActive(longSeatState)) {
    registerAttributedSeatSymbolOrThrow(
      attributedDirections,
      attributedSymbols,
      longSeatState.symbol,
      'LONG',
    );
  }

  if (isSeatActive(shortSeatState)) {
    registerAttributedSeatSymbolOrThrow(
      attributedDirections,
      attributedSymbols,
      shortSeatState.symbol,
      'SHORT',
    );
  }

  return attributedSymbols;
}

/**
 * 推进所有满足条件的保护性清仓事件。
 *
 * 业务顺序固定为：prepare episode -> prepare daily -> persist -> commit daily -> cooldown -> commit episode。
 *
 * @param trader Trader 实例，用于判定是否仍有未完成保护性卖单
 * @param businessDeps 已绑定的业务协作者
 * @param getQuantityBySymbol 从最新 snapshot 读取数量的函数
 */
function settleProtectiveLiquidationEpisodes(
  trader: Trader,
  businessDeps: PostTradeConsistencyRuntimeBusinessDeps,
  getQuantityBySymbol: (symbol: string) => { quantity: number } | null,
  isCurrent: () => boolean,
): void {
  for (const episode of businessDeps.protectiveLiquidationEpisodeTracker.getInProgressEpisodes()) {
    const monitorContext = businessDeps.monitorContext;
    const isDirectionFlat = isSymbolFlatBySnapshot(episode.symbol, getQuantityBySymbol);
    const hasPendingProtectiveOrders = trader.hasPendingProtectiveLiquidationOrders(
      episode.direction,
    );
    const preparedEpisode = businessDeps.protectiveLiquidationEpisodeTracker.prepareCompletion({
      direction: episode.direction,
      isDirectionFlat,
      hasPendingProtectiveOrders,
    });
    if (preparedEpisode === null) {
      continue;
    }

    const preparedDailyLoss = businessDeps.dailyLossTracker.prepareProtectionBoundary({
      direction: preparedEpisode.direction,
      boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
    });
    const monitorSymbol = monitorContext.config.monitorSymbol;
    // 无 await 的最后事实验证→同步 durable append→内存边界/冷却/episode 提交。
    if (!isCurrent()) return;

    businessDeps.mixedTradeLogRepository.appendCompletionIdempotent({
      monitorSymbol,
      direction: preparedEpisode.direction,
      boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
      orderBaselines: preparedDailyLoss.orderBaselines,
    });

    businessDeps.dailyLossTracker.commitProtectionBoundary(preparedDailyLoss);

    businessDeps.liquidationCooldownTracker.recordLiquidationTrigger({
      direction: preparedEpisode.direction,
      executedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
      triggerLimit: monitorContext.config.liquidationTriggerLimit,
      cooldownConfig: monitorContext.config.liquidationCooldown,
    });
    businessDeps.protectiveLiquidationEpisodeTracker.commitCompletion(preparedEpisode);
  }
}

/**
 * 刷新所有可归属 symbol 的浮亏缓存。
 *
 * 仅对当前仍能归属到激活席位的 symbol 刷新 R1/N1，避免把已脱离席位归属的旧 symbol 带入本轮一致性恢复。
 *
 * @param monitorContext 唯一监控上下文
 * @returns 是否全部刷新成功
 */
function refreshAttributedUnrealizedLossData(monitorContext: MonitorContext): void {
  const prepared = buildAttributedSeatSymbols(monitorContext).map(({ symbol, direction }) =>
    monitorContext.riskChecker.prepareUnrealizedLossData(
      monitorContext.orderRecorder,
      symbol,
      direction === 'LONG',
      monitorContext.dailyLossTracker.getLossOffset(direction),
    ),
  );
  for (const result of prepared) monitorContext.riskChecker.publishUnrealizedLossData(result);
}

/**
 * 执行账户/持仓刷新成功后的业务收尾。
 *
 * @param trader Trader 实例
 * @param lastState 运行时状态，用于读取最新持仓缓存
 * @param businessDeps 已绑定的业务协作者
 * @returns 所有后置业务都成功时返回 true
 */
function runPostRefreshBusinessFlow(
  trader: Trader,
  view: AccountPositionSnapshotView,
  businessDeps: PostTradeConsistencyRuntimeBusinessDeps,
  isCurrent: () => boolean,
): boolean {
  if (!isCurrent()) return false;

  settleProtectiveLiquidationEpisodes(
    trader,
    businessDeps,
    (symbol) => {
      let quantity = 0;
      for (const position of view.positions) {
        if (position.symbol !== symbol) continue;

        const next = quantity + position.quantity;
        if (!Number.isSafeInteger(next))
          throw new RangeError('[settlement] position quantity overflow');

        quantity = next;
      }

      return { quantity };
    },
    isCurrent,
  );

  if (!isCurrent()) return false;

  refreshAttributedUnrealizedLossData(businessDeps.monitorContext);
  return true;
}

/**
 * 创建成交后一致性运行时。
 *
 * @param deps 外部依赖注入，仅包含 trader 访问器与 lastState
 * @returns 成交后一致性运行时实例
 */
export function createPostTradeConsistencyRuntime(
  deps: PostTradeConsistencyRuntimeDeps,
): PostTradeConsistencyRuntime {
  const { getTrader, snapshot, scheduler, termination } = deps;
  const refreshGate = createSettlementReadinessGate({ snapshot });

  let businessDeps: PostTradeConsistencyRuntimeBusinessDeps | null = null;
  let started = false;
  let inFlight = false;
  let pendingNeed = createEmptyRefreshNeed();
  let pendingVersion: number | null = null;
  let businessDirty = false;
  let runTimerHandle: ReturnType<typeof setTimeout> | null = null;
  let retryTimerHandle: ReturnType<typeof setTimeout> | null = null;
  let runTimerToken: symbol | null = null;
  let retryTimerToken: symbol | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let drainPromise: Promise<void> | null = null;
  const freshReachedListeners = new Set<() => void>();
  let currentRefreshHandle: SnapshotRefreshHandle | null = null;

  /**
   * 获取已绑定的业务依赖；缺失时立即失败。
   *
   * 该运行时一旦启动，就必须能完整执行成交后业务收尾，禁止静默降级为仅刷新账户/持仓。
   */
  function getBusinessDepsOrThrow(): PostTradeConsistencyRuntimeBusinessDeps {
    if (businessDeps === null) {
      throw new Error('[postTradeConsistencyRuntime] businessDeps 尚未绑定，禁止启动');
    }

    return businessDeps;
  }

  /**
   * 通过统一 scheduler 的 0ms timer 调度下一次刷新。
   *
   * 只要进入立即执行通道，就取消失败重试定时器，优先处理最新积压。
   */
  function scheduleRun(): void {
    if (
      termination.isTerminated() ||
      !started ||
      snapshot.getStatus().admission !== 'OPEN' ||
      inFlight ||
      runTimerHandle !== null ||
      (!hasRefreshNeed(pendingNeed) && !businessDirty)
    ) {
      return;
    }

    if (retryTimerHandle !== null) {
      retryTimerToken = null;
      scheduler.clearTimer(retryTimerHandle);
      retryTimerHandle = null;
    }

    const token = Symbol();
    runTimerToken = token;
    runTimerHandle = scheduler.scheduleTimer(() => {
      // 已取消或已消费的回调不能清除新 timer，更不能替换真实在途任务的 Promise。
      if (runTimerToken !== token) return;

      runTimerToken = null;
      runTimerHandle = null;
      if (
        termination.isTerminated() ||
        !started ||
        snapshot.getStatus().admission !== 'OPEN' ||
        inFlight ||
        (!hasRefreshNeed(pendingNeed) && !businessDirty)
      ) {
        return;
      }

      inFlightPromise = runRefresh();
      void inFlightPromise.catch((error: unknown) => {
        termination.reportFatalError(error);
        logger.error('[PostTradeConsistencyRuntime] 刷新调度发生未处理错误', {
          error: formatError(error),
        });
      });
    }, 0);
  }

  /**
   * 在刷新失败后按固定退避时间重试。
   */
  function scheduleRetry(): void {
    if (
      termination.isTerminated() ||
      !started ||
      snapshot.getStatus().admission !== 'OPEN' ||
      inFlight ||
      retryTimerHandle !== null ||
      (!hasRefreshNeed(pendingNeed) && !businessDirty)
    ) {
      return;
    }

    const token = Symbol();
    retryTimerToken = token;
    retryTimerHandle = scheduler.scheduleTimer(() => {
      if (retryTimerToken !== token) return;

      retryTimerToken = null;
      retryTimerHandle = null;
      scheduleRun();
    }, API.DEFAULT_RETRY_DELAY_MS);
  }

  /**
   * 执行一次成交后刷新。
   *
   * 固定顺序：账户/持仓刷新 -> canonical snapshot commit -> 保护性清仓完成判定与冷却推进 -> R1/N1 刷新 -> markFresh。
   * 外部失败保留 pending 版本并进入重试；程序内部契约/不变量错误则立即 fail-fast。
   */
  async function runRefresh(rebuildToken?: SnapshotToken): Promise<void> {
    if (
      termination.isTerminated() ||
      !started ||
      inFlight ||
      (rebuildToken === undefined &&
        (snapshot.getStatus().admission !== 'OPEN' ||
          (!hasRefreshNeed(pendingNeed) && !businessDirty))) ||
      (rebuildToken !== undefined &&
        !snapshot.isCurrent(rebuildToken, { account: true, positions: true, paired: true }))
    ) {
      return;
    }

    const need = pendingNeed;
    businessDirty = false;
    const targetVersion = pendingVersion ?? refreshGate.getStatus().staleVersion;
    pendingNeed = createEmptyRefreshNeed();
    pendingVersion = null;
    inFlight = true;
    let refreshOk = false;
    let readyToken: SnapshotToken | null = null;
    let fatalInvariantDetected = false;
    let retryRequired = false;
    const workDayEpoch = rebuildToken?.dayEpoch ?? snapshot.getView().token.dayEpoch;
    // 普通 S 只在 OPEN 推进；受控 baseline 不发读，也不得跨日/停止后继续业务发布。
    const workAdmitted = (): boolean => {
      const status = snapshot.getStatus();
      return (
        started &&
        !termination.isTerminated() &&
        status.token.dayEpoch === workDayEpoch &&
        (rebuildToken === undefined ? status.admission === 'OPEN' : status.admission !== 'CLOSED')
      );
    };

    try {
      const resolvedBusinessDeps = getBusinessDepsOrThrow();
      const trader = getTrader();
      let readRequired = rebuildToken === undefined && hasRefreshNeed(need);
      while (workAdmitted()) {
        // 受控 baseline 只消费已重建的原 paired 事实；失效交回 open owner 重载，不冒充 lifecycle 发读。
        if (
          rebuildToken !== undefined &&
          !snapshot.isCurrent(rebuildToken, { account: true, positions: true, paired: true })
        )
          return;

        let view = snapshot.getView();
        const paired = snapshot.isCurrent(view.token, {
          account: true,
          positions: true,
          paired: true,
        });
        if (readRequired || !paired) {
          if (rebuildToken !== undefined || snapshot.getStatus().admission !== 'OPEN') return;

          currentRefreshHandle = snapshot.requestRefresh({
            source: 'POST_TRADE_SETTLEMENT',
            dayEpoch: view.token.dayEpoch,
            refreshAccount: need.refreshAccount || !paired,
            refreshPositions: need.refreshPositions || !paired,
          });
          const receipt = await currentRefreshHandle.result;
          currentRefreshHandle = null;
          if (receipt.status === 'ABORTED') return;

          view = receipt.view;
          readRequired = false;
        }

        const token = view.token;
        const registry = resolvedBusinessDeps.monitorContext.symbolRegistry;
        const longVersion = registry.getSeatVersion('LONG');
        const shortVersion = registry.getSeatVersion('SHORT');
        const current = (): boolean =>
          workAdmitted() &&
          registry.getSeatVersion('LONG') === longVersion &&
          registry.getSeatVersion('SHORT') === shortVersion &&
          refreshGate.getStatus().staleVersion === targetVersion &&
          snapshot.isCurrent(token, { account: true, positions: true, paired: true });
        // 通知只让订阅 owner 在串行链按当前真相对账，绝不传迟到 view 期望集合。
        await deps.onPositionsCommitted(token);
        if (refreshGate.getStatus().staleVersion !== targetVersion || !workAdmitted()) return;

        if (!current()) {
          if (rebuildToken !== undefined) return;

          continue;
        }

        refreshOk = runPostRefreshBusinessFlow(trader, view, resolvedBusinessDeps, current);
        if (refreshOk && current()) {
          readyToken = token;
          break;
        }
      }
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        fatalInvariantDetected = true;
        termination.reportFatalError(error);
        started = false;
        pendingNeed = createEmptyRefreshNeed();
        pendingVersion = null;
        refreshGate.abortWaiting('FATAL_INVARIANT');
        logger.error('[PostTradeConsistencyRuntime] 检测到不可恢复的一致性错误，停止运行时', {
          error: formatError(error),
        });
        throw error;
      }

      retryRequired = true;
      logger.warn('[PostTradeConsistencyRuntime] 刷新失败，准备重试', formatError(error));
      // 受控开盘工作由 lifecycle 的原重试 owner 接管；普通 S 仍沿用自身退避。
      if (rebuildToken !== undefined) throw error;
    } finally {
      if (fatalInvariantDetected) {
        // fatal invariant 已在 catch 中升级为异常，这里只负责阻止重试与版本回滚。
      } else if (refreshOk) {
        const gateStatus = refreshGate.getStatus();
        if (
          !termination.isTerminated() &&
          gateStatus.abortReason !== 'STOP_AND_DRAIN' &&
          readyToken !== null &&
          refreshGate.markFresh(targetVersion, readyToken)
        )
          emitFreshReached();
      } else {
        pendingNeed = mergeRefreshNeed(need, pendingNeed);
        pendingVersion = mergePendingVersion(pendingVersion, targetVersion);
        businessDirty = true;
      }

      inFlight = false;

      if (
        rebuildToken === undefined &&
        !fatalInvariantDetected &&
        (hasRefreshNeed(pendingNeed) || businessDirty)
      ) {
        if (refreshOk || !retryRequired) {
          scheduleRun();
        } else {
          scheduleRetry();
        }
      }
    }
  }

  /**
   * 广播 fresh reached 事件。
   */
  function emitFreshReached(): void {
    for (const listener of freshReachedListeners) {
      listener();
    }
  }

  /**
   * 绑定唯一 monitorContext 与风险协作者。
   *
   * 运行时先于唯一 monitorContext 创建，因此业务依赖需要在顶层装配完成后显式绑定。
   * 业务依赖只允许绑定一次，重复绑定说明装配链路存在归属漂移风险，必须立即失败。
   *
   * @param deps 业务依赖集合
   */
  function bindBusinessDeps(runtimeBusinessDeps: PostTradeConsistencyRuntimeBusinessDeps): void {
    if (businessDeps !== null) {
      throw new Error('[postTradeConsistencyRuntime] businessDeps 已绑定，禁止重复绑定');
    }

    buildAttributedSeatSymbols(runtimeBusinessDeps.monitorContext);
    businessDeps = runtimeBusinessDeps;
  }

  /**
   * 记录一次成交后的刷新需求。
   *
   * 每次记录都会推进 staleVersion；若运行时已经启动，则会尽快消费当前积压需求。
   *
   * @param need 本次成交产生的刷新意图
   */
  function recordSettlementRefreshNeed(need: SettlementRefreshNeed): void {
    if (termination.isTerminated() || !hasRefreshNeed(need)) {
      return;
    }

    // 权威订单事实成功提交的同一同步段同时失效 canonical 代次与登记 settlement 水位。
    snapshot.invalidate();
    pendingNeed = mergeRefreshNeed(pendingNeed, need);
    pendingVersion = refreshGate.markStale();
    if (started) {
      scheduleRun();
    }
  }

  /**
   * 读取运行时当前状态。
   *
   * @returns 启动态与 freshness 版本号快照
   */
  function getStatus(): PostTradeConsistencyRuntimeStatus {
    const gateStatus = refreshGate.getStatus();

    return {
      started,
      currentVersion: gateStatus.currentVersion,
      staleVersion: gateStatus.staleVersion,
    };
  }

  /**
   * 等待当前 freshness 恢复。
   *
   * @returns 当 currentVersion 追上 staleVersion 时 resolve
   */
  function waitForFresh(): Promise<SettlementReadinessReceipt> {
    // 仅未完成/已失效的 settlement 追当前 token；普通 commit 后沿用完成水位，由消费 owner 重选持仓。
    if (!refreshGate.getStatus().ready && !inFlight) {
      businessDirty = true;
      scheduleRun();
    }

    return refreshGate.waitForFresh();
  }

  /** reader 在 await 返回后及真正发布/提交前复核的业务授权。 */
  function isCurrent(receipt: SettlementReadinessReceipt): boolean {
    return !termination.isTerminated() && refreshGate.isCurrent(receipt);
  }

  /**
   * 订阅 freshness 追平事件。
   *
   * @param listener 监听器
   * @returns 取消订阅函数
   */
  function onFreshReached(listener: () => void): () => void {
    freshReachedListeners.add(listener);
    return () => {
      freshReachedListeners.delete(listener);
    };
  }

  /**
   * 终止当前 freshness 等待轮次。
   *
   * stopAndDrain / 午夜清理前需要先打断等待方，避免继续等待本轮不再推进的 freshness。
   */
  function abortWaiting(): void {
    refreshGate.abortWaiting('STOP_AND_DRAIN');
  }

  /**
   * 清除上一轮生命周期留下的 abort 状态。
   *
   * 开盘重建会重新建立 freshness 基线，因此必须先恢复可等待状态。
   */
  function resetAbort(): void {
    if (termination.isTerminated()) return;

    refreshGate.resetAbort();
  }

  /**
   * 启动运行时并尝试消费启动前积压的刷新需求。
   */
  function start(): void {
    if (termination.isTerminated() || started) {
      return;
    }

    if (inFlight) {
      throw new Error('[PostTradeConsistencyRuntime] 排空完成前禁止重新启动');
    }

    drainPromise = null;
    inFlightPromise = null;

    getBusinessDepsOrThrow();
    started = true;
    scheduleRun();
  }

  /** 撤销普通 S 的 timer 及回调身份，受控 baseline 与 stop 共用，不取消已 issued 的 IO。 */
  function cancelScheduledTimers(): void {
    const runHandle = runTimerHandle;
    const retryHandle = retryTimerHandle;
    runTimerToken = null;
    retryTimerToken = null;
    runTimerHandle = null;
    retryTimerHandle = null;
    try {
      if (runHandle !== null) scheduler.clearTimer(runHandle);
    } finally {
      if (retryHandle !== null) scheduler.clearTimer(retryHandle);
    }
  }

  /** 同步停止后续刷新调度，不抢先启动异步排空，也不清除待处理 need/dirty。 */
  function stopScheduling(): void {
    started = false;
    cancelScheduledTimers();
  }

  /**
   * 同一停止周期复用同一 Promise，包含账户/持仓请求及订阅提交回调。
   * stop 期间已开始的事实提交继续收口；Quote 必须等待本排空成功后才能停止。
   */
  function stopAndDrain(): Promise<void> {
    if (drainPromise !== null) return drainPromise;

    abortWaiting();
    stopScheduling();
    // 撤去尚未issued的本参与者，不把已issued结果/真实提交回调提前裁成ABORTED。
    currentRefreshHandle?.cancelIfNotIssued();
    drainPromise = Promise.allSettled([
      inFlightPromise ?? Promise.resolve(),
      snapshot.waitForIssuedDrain(),
    ]).then((results) => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    return drainPromise;
  }

  /**
   * 执行跨日清理。
   *
   * 当前日内未消费的刷新需求会被丢弃，freshness 版本推进交由后续 baseline 处理。
   */
  function midnightClear(): void {
    stopScheduling();

    pendingNeed = createEmptyRefreshNeed();
    pendingVersion = null;
    businessDirty = false;
  }

  /** 读取可变运行态，受控 await 后不能沿用进入时的静态判断。 */
  function canCompleteRebuildBaseline(): boolean {
    return started && !termination.isTerminated() && snapshot.getStatus().admission !== 'CLOSED';
  }

  /**
   * 由开盘 owner 消费已完成重建的 paired 基线，真实完成订阅与所有积压/dirty 业务后才签 fresh。
   * 原 token 在 await 中失效则保留 need，返回 false 交回开盘 owner 重载；不新增读取准入。
   * 外部失败沿 lifecycle 原重试通道抛出，内部错误继续 fail-fast；停止排空持有真实在途 Promise。
   */
  async function completeRebuildBaseline(): Promise<boolean> {
    // start() 可能已为积压安排 0ms；受控 owner 接手前必须撤销，不能让 OPEN startup 出现第二个重试 owner。
    cancelScheduledTimers();
    try {
      if (!canCompleteRebuildBaseline()) {
        stopScheduling();
        return false;
      }

      const token = snapshot.getView().token;
      if (inFlight) await inFlightPromise;

      // 已在途普通批的 finally 也可能留下 timer，排空后再次收回尚未 issued 的调度。
      cancelScheduledTimers();
      if (
        !canCompleteRebuildBaseline() ||
        !snapshot.isCurrent(token, { account: true, positions: true, paired: true })
      ) {
        stopScheduling();
        return false;
      }

      const completing = runRefresh(token);
      // 外部 baseline 失败由 await 调用方进入 lifecycle 重试；真实 IO 已 settled，drain 不重复升级该已处理外错。
      // 内部错误仍保留在 drain 通道，且立即观察防止等待原 caller 收口前产生未处理拒绝。
      inFlightPromise = completing.catch((error: unknown) => {
        if (!isExternalApiRequestError(error)) throw error;
      });
      void inFlightPromise.catch(termination.reportFatalError);
      await completing;
      const ready =
        !businessDirty &&
        !hasRefreshNeed(pendingNeed) &&
        refreshGate.getStatus().ready &&
        snapshot.isCurrent(token, { account: true, positions: true, paired: true });
      if (!ready) stopScheduling();

      return ready;
    } catch (error) {
      // 失败与失效只交回原 lifecycle/startup owner；保留 need/dirty，不由普通 S 自行补签 ready。
      stopScheduling();
      throw error;
    }
  }

  return {
    bindBusinessDeps,
    recordSettlementRefreshNeed,
    getStatus,
    waitForFresh,
    isCurrent,
    onFreshReached,
    stopScheduling,
    abortWaiting,
    resetAbort,
    start,
    stopAndDrain,
    midnightClear,
    completeRebuildBaseline,
  };
}
