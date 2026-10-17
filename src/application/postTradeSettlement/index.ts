/**
 * 成交后业务结算 workflow
 *
 * 唯一拥有刷新 need/重试 pump、订阅确认、保护性 completion 同步事务、R1/N1 与 readiness。
 * snapshot owner 独立提交 canonical 事实；本模块只消费中性窄能力，不拥有 broker 或订单账本。
 * 生命周期受控 baseline 和 crash-gap 恢复共用完成事务，保留停止排空与 late binding 约束。
 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import type { DiagnosticObserver } from '../../types/diagnostics.js';
import type {
  AccountPositionSnapshotView,
  SnapshotRefreshHandle,
  SnapshotToken,
} from '../../types/accountPosition.js';
import type {
  PostTradeSettlementStatus,
  SettlementProtectionRecoveryRequest,
  SettlementRefreshNeed,
  SettlementReadinessReceipt,
} from '../../types/settlement.js';
import { formatError } from '../../utils/error/index.js';
import { createSettlementReadinessGate } from './readinessGate.js';
import type {
  PostTradeSettlementBusinessDeps,
  PostTradeSettlementWorkflow,
  PostTradeSettlementWorkflowDeps,
  SettlementAttributedSymbol,
  SettlementSeats,
} from './types.js';

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

/** 按 canonical 安全整数数量合并同 symbol 持仓，不读取有歧义的席位新 symbol。 */
function isSymbolFlatBySnapshot(symbol: string, view: AccountPositionSnapshotView): boolean {
  let quantity = 0;
  for (const position of view.positions) {
    if (position.symbol !== symbol) continue;

    quantity += position.quantity;
    if (!Number.isSafeInteger(quantity))
      throw new RangeError('[settlement] position quantity overflow');
  }

  return quantity <= 0;
}

/** 仅刷新当前 ACTIVE 席位，并在双方向争用同 symbol 时立即阻断交易一致性。 */
function buildAttributedSeatSymbols(
  seats: SettlementSeats,
): ReadonlyArray<SettlementAttributedSymbol> {
  const result = (['LONG', 'SHORT'] as const).flatMap((direction) => {
    const seat = seats.getSeatState(direction);
    if (seat.status !== 'ACTIVE') return [];

    if (seat.symbol === null || seat.symbol.length === 0)
      throw new Error('[PostTradeSettlementWorkflow] ACTIVE 席位缺少 symbol');

    return [{ symbol: seat.symbol, direction }];
  });
  if (result.length === 2 && result[0]?.symbol === result[1]?.symbol)
    throw new Error(
      `[PostTradeSettlementWorkflow] 标的重复归属: ${result[0]?.symbol} 同时归属 LONG 与 SHORT`,
    );

  return result;
}

/**
 * 唯一保护性完成事务：最终资格/身份校验 → 同步 append → boundary → cooldown/episode。
 * recovery 也调用此事务，只将 cooldown 投影留给随后的 durable log hydrate；全段不插入 await。
 */
function settleProtectiveLiquidationEpisodes(
  businessDeps: PostTradeSettlementBusinessDeps,
  view: AccountPositionSnapshotView,
  hasPendingProtectiveOrders: (direction: 'LONG' | 'SHORT') => boolean,
  isCurrent: () => boolean,
  cooldownProjection: 'LIVE_TRIGGER' | 'LOG_HYDRATION',
  diagnostics: DiagnosticObserver,
  settlementVersion: number,
): boolean {
  for (const episode of businessDeps.episodes.getInProgressEpisodes()) {
    if (!isCurrent()) return false;

    const isDirectionFlat = isSymbolFlatBySnapshot(episode.symbol, view);
    const hasPendingOrders = hasPendingProtectiveOrders(episode.direction);
    const preparedEpisode = businessDeps.episodes.prepareCompletion({
      direction: episode.direction,
      isDirectionFlat,
      hasPendingProtectiveOrders: hasPendingOrders,
    });
    if (preparedEpisode === null) {
      if (cooldownProjection === 'LOG_HYDRATION' && isDirectionFlat && !hasPendingOrders)
        throw new Error(
          `[PostTradeSettlementWorkflow] crash-gap episode 无法冻结: ${episode.symbol}`,
        );

      continue;
    }

    if (
      !isDirectionFlat ||
      hasPendingOrders ||
      preparedEpisode.direction !== episode.direction ||
      preparedEpisode.boundaryExecutedTimeMs !== episode.latestExecutedTimeMs
    )
      throw new Error('[PostTradeSettlementWorkflow] prepared episode 与权威完成事实不匹配');

    const preparedDailyLoss =
      businessDeps.lossBoundaries.prepareProtectionBoundary(preparedEpisode);
    if (
      preparedDailyLoss.direction !== preparedEpisode.direction ||
      preparedDailyLoss.boundaryExecutedTimeMs !== preparedEpisode.boundaryExecutedTimeMs
    )
      throw new Error('[PostTradeSettlementWorkflow] prepared boundary 与 episode 不匹配');

    const latestEpisode = businessDeps.episodes
      .getInProgressEpisodes()
      .find((candidate) => candidate.direction === episode.direction);
    if (
      !isCurrent() ||
      latestEpisode?.symbol !== episode.symbol ||
      latestEpisode.latestExecutedTimeMs !== episode.latestExecutedTimeMs ||
      !isSymbolFlatBySnapshot(episode.symbol, view) ||
      hasPendingProtectiveOrders(episode.direction)
    )
      return false;

    businessDeps.completionPersistence.appendCompletionIdempotent({
      monitorSymbol: businessDeps.monitorSymbol,
      direction: preparedEpisode.direction,
      boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
      orderBaselines: preparedDailyLoss.orderBaselines,
    });
    businessDeps.lossBoundaries.commitProtectionBoundary(preparedDailyLoss);
    if (cooldownProjection === 'LIVE_TRIGGER')
      businessDeps.cooldownTriggers.recordLiquidationTrigger({
        direction: preparedEpisode.direction,
        executedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
      });

    businessDeps.episodes.commitCompletion(preparedEpisode);
    // committed 仅指本同步事务的全部投影成功；恢复冷却仍由随后 durable log hydration 负责。
    try {
      diagnostics.record(DIAGNOSTIC_OPERATIONS.LIQUIDATION_COMPLETION_COMMITTED, {
        source: 'POST_TRADE_SETTLEMENT',
        monitorSymbol: businessDeps.monitorSymbol,
        symbol: episode.symbol,
        seatDirection: preparedEpisode.direction,
        boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
        cooldownProjection,
        settlementVersion,
        dayEpoch: view.token.dayEpoch,
        snapshotGeneration: view.token.snapshotGeneration,
        snapshotCommitRevision: view.token.commitRevision,
        accountRevision: view.token.accountRevision,
        positionRevision: view.token.positionRevision,
        pairedCommitRevision: view.token.pairedRevision,
      });
    } catch {
      // 诊断失败不回滚已提交事务，也不覆盖随后可能发生的业务 fatal。
    }
  }

  return isCurrent();
}

/** 全部 R1/N1 prepare 成功后再次授权，再同步发布整批，避免只发布其中一半。 */
function refreshAttributedUnrealizedLossData(
  businessDeps: PostTradeSettlementBusinessDeps,
  isCurrent: () => boolean,
): boolean {
  const prepared = buildAttributedSeatSymbols(businessDeps.seats).map(({ symbol, direction }) =>
    businessDeps.riskProjection.prepare(
      symbol,
      direction,
      businessDeps.lossBoundaries.getLossOffset(direction),
    ),
  );
  if (!isCurrent()) return false;

  for (const result of prepared) businessDeps.riskProjection.publish(result);

  return isCurrent();
}

/** 创建内聚业务 owner；构造时即可登记 need，启动前必须完成协作者单次绑定。 */
export function createPostTradeSettlementWorkflow(
  deps: PostTradeSettlementWorkflowDeps,
): PostTradeSettlementWorkflow {
  const {
    hasPendingProtectiveOrders,
    snapshot,
    scheduler,
    termination,
    logger,
    isExternalFailure,
  } = deps;
  const refreshGate = createSettlementReadinessGate({
    snapshot,
    clock: deps.clock,
    diagnostics: deps.diagnostics,
  });

  let businessDeps: PostTradeSettlementBusinessDeps | null = null;
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
  function getBusinessDepsOrThrow(): PostTradeSettlementBusinessDeps {
    if (businessDeps === null) {
      throw new Error('[postTradeSettlement] businessDeps 尚未绑定，禁止启动');
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
        logger.error('[PostTradeSettlementWorkflow] 刷新调度发生未处理错误', {
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
    }, deps.retryDelayMs);
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
        const registry = resolvedBusinessDeps.seats;
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

        refreshOk =
          settleProtectiveLiquidationEpisodes(
            resolvedBusinessDeps,
            view,
            hasPendingProtectiveOrders,
            current,
            'LIVE_TRIGGER',
            deps.diagnostics,
            targetVersion,
          ) && refreshAttributedUnrealizedLossData(resolvedBusinessDeps, current);

        if (refreshOk && current()) {
          readyToken = token;
          break;
        }
      }
    } catch (error) {
      if (!isExternalFailure(error)) {
        fatalInvariantDetected = true;
        termination.reportFatalError(error);
        started = false;
        pendingNeed = createEmptyRefreshNeed();
        pendingVersion = null;
        refreshGate.abortWaiting('FATAL_INVARIANT');
        logger.error('[PostTradeSettlementWorkflow] 检测到不可恢复的一致性错误，停止运行时', {
          error: formatError(error),
        });
        throw error;
      }

      retryRequired = true;
      logger.warn('[PostTradeSettlementWorkflow] 刷新失败，准备重试', formatError(error));
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
   * 绑定唯一 monitor 的窄业务能力。
   *
   * workflow 先于协作者完成构造；启动前显式绑定且仅允许一次，重复绑定立即失败。
   *
   * @param runtimeBusinessDeps 业务依赖集合
   */
  function bindBusinessDeps(runtimeBusinessDeps: PostTradeSettlementBusinessDeps): void {
    if (businessDeps !== null) {
      throw new Error('[postTradeSettlement] businessDeps 已绑定，禁止重复绑定');
    }

    buildAttributedSeatSymbols(runtimeBusinessDeps.seats);
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
  function getStatus(): PostTradeSettlementStatus {
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
      throw new Error('[PostTradeSettlementWorkflow] 排空完成前禁止重新启动');
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
        if (!isExternalFailure(error)) throw error;
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

  /**
   * loader 恢复全部精确 progress/episode 后同步调用；最终资格仍由本 owner 从 canonical 持仓判定。
   * 不发读、不签 ready、不直接累加 cooldown；随后 hydrate 才是恢复冷却唯一投影 owner。
   */
  function completeProtectionRecovery(request: SettlementProtectionRecoveryRequest): boolean {
    const resolvedBusinessDeps = getBusinessDepsOrThrow();
    const longVersion = resolvedBusinessDeps.seats.getSeatVersion('LONG');
    const shortVersion = resolvedBusinessDeps.seats.getSeatVersion('SHORT');
    const targetVersion = refreshGate.getStatus().staleVersion;
    const current = (): boolean =>
      !termination.isTerminated() &&
      snapshot.getStatus().admission !== 'CLOSED' &&
      resolvedBusinessDeps.seats.getSeatVersion('LONG') === longVersion &&
      resolvedBusinessDeps.seats.getSeatVersion('SHORT') === shortVersion &&
      refreshGate.getStatus().staleVersion === targetVersion &&
      snapshot.isCurrent(request.snapshotToken, { account: true, positions: true, paired: true });
    if (!current()) return false;

    return settleProtectiveLiquidationEpisodes(
      resolvedBusinessDeps,
      snapshot.getView(),
      (direction) => request.pendingProtectiveDirections.has(direction),
      current,
      'LOG_HYDRATION',
      deps.diagnostics,
      targetVersion,
    );
  }

  return {
    bindBusinessDeps,
    completeProtectionRecovery,
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
