/**
 * QuoteSubscriptionRuntime
 *
 * 职责：
 * - 作为稳态运行期 quote 订阅集合唯一 owner
 * - 以 retain reason 汇总 monitor、seat、position、order 与临时等待需求
 * - 串行执行 subscribe/unsubscribe mutation，并在每个 SDK 阶段成功后立即更新 committed set 与 lastState.allTradingSymbols
 *
 * 准入纪律：
 * - 基础事实通知仅标 dirty；串行命令及每次 broker await 后只重投影所属入口的 truth。
 *   退订仍受全部当前事实保护；普通事件不能代替 awaited POSITION_HOLD 或 activation retain 准入。
 * - 未准入的 ACTIVATING 新标的不进入 SEAT_BOUND；首次 admission 只由 awaited activation retain 发起，
 *   席位进入 ACTIVE 后才由 SEAT_BOUND 接棒；已准入的标的保持订阅，避免启动与换标期间的订阅抖动。
 * - 事件驱动的普通 seat/order 变化没有恢复 owner，mutation 失败仍进入 fatal 通道；
 *   activation retain 的 mutation 失败会回滚本次注册，把原错误交还 awaited 调用方，由 owner 决定有限重试。
 */
import type { Position } from '../../types/account.js';
import type { SnapshotToken } from '../../types/accountPosition.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { Unsubscribe } from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import type {
  MutableQuoteSubscriptionRetainStore,
  QuoteSubscriptionRetainParams,
  QuoteSubscriptionRetainOwner,
  QuoteSubscriptionRuntime,
  QuoteSubscriptionRuntimeDeps,
  QuoteSubscriptionTruthProjection,
} from './types.js';

function buildOwnerStoreKey(owner: QuoteSubscriptionRetainOwner): string {
  return `${owner.reason}:${owner.ownerKey}`;
}

function normalizeSymbols(symbols: Iterable<string>): ReadonlyArray<string> {
  return [...new Set([...symbols].filter((symbol) => symbol.length > 0))];
}

function collectPositionSymbols(positions: ReadonlyArray<Position>): ReadonlyArray<string> {
  return normalizeSymbols(positions.map((position) => position.symbol));
}

function collectSeatSymbols(event: SeatStateChangedEvent): ReadonlyArray<string> {
  return normalizeSymbols([event.previousState.symbol ?? '', event.nextState.symbol ?? '']);
}

function hasRetainForSymbol(
  retainsByOwner: ReadonlyMap<string, ReadonlySet<string>>,
  symbol: string,
): boolean {
  for (const symbols of retainsByOwner.values()) {
    if (symbols.has(symbol)) {
      return true;
    }
  }

  return false;
}

/**
 * 创建 quote 订阅 runtime。
 * runtime 不复制业务事实，只在命令执行时从权威状态重投影对应 retain reason。
 *
 * @param deps 运行期依赖
 * @returns QuoteSubscriptionRuntime 实例
 */
export function createQuoteSubscriptionRuntime(
  deps: QuoteSubscriptionRuntimeDeps,
): QuoteSubscriptionRuntime {
  const { logger } = deps;
  let running = false;
  let accepting = true;
  let drainPromise: Promise<void> | null = null;
  let drainFailed = false;
  let mutationChain: Promise<void> = Promise.resolve();
  let unsubscribeSeatStateChanged: Unsubscribe | null = null;
  let unsubscribeOrderHoldChanged: Unsubscribe | null = null;
  const retainsByOwner: MutableQuoteSubscriptionRetainStore = new Map();
  let monitorTruthEnabled = false;
  let seatTruthEnabled = false;
  let positionTruthEnabled = false;
  let orderTruthEnabled = false;
  let truthDirty = false;

  function isAccepting(): boolean {
    return accepting;
  }

  function readCommittedSymbolsFromLastState(): Set<string> {
    return new Set(deps.lastState.allTradingSymbols);
  }

  function setOwnerSymbols(owner: QuoteSubscriptionRetainOwner, symbols: Iterable<string>): void {
    const normalized = normalizeSymbols(symbols);
    const ownerStoreKey = buildOwnerStoreKey(owner);
    if (normalized.length === 0) {
      retainsByOwner.delete(ownerStoreKey);
      return;
    }

    retainsByOwner.set(ownerStoreKey, new Set(normalized));
  }

  function removeOwner(owner: QuoteSubscriptionRetainOwner): void {
    retainsByOwner.delete(buildOwnerStoreKey(owner));
  }

  function collectDesiredSymbols(): Set<string> {
    const desired = new Set<string>();
    for (const symbols of retainsByOwner.values()) {
      for (const symbol of symbols) {
        desired.add(symbol);
      }
    }

    return desired;
  }

  /**
   * 把当前已确认的 SDK 订阅事实写回 lastState，供后续投影与命令读取。
   *
   * @param committedSymbols 已确认在 SDK 生效的 symbol 集合
   */
  function writeCommittedSymbols(committedSymbols: ReadonlySet<string>): void {
    deps.lastState.allTradingSymbols = new Set(committedSymbols);
  }

  /** 只在命令所属入口重投影，避免旧命令消费后来 awaited owner 的首次准入或释放。 */
  function projectCurrentTruth(projection: QuoteSubscriptionTruthProjection): SnapshotToken | null {
    if (!accepting) return null;

    if (projection === 'ALL' || projection === 'ORDINARY') {
      if (monitorTruthEnabled) projectMonitorBase();

      if (seatTruthEnabled) projectAllSeatBound();

      if (orderTruthEnabled) projectOrderHold();
    }

    truthDirty = false;
    return positionTruthEnabled && (projection === 'ALL' || projection === 'POSITION_HOLD')
      ? projectPositionHold()
      : null;
  }

  /** 按命令责任挑选准入，失败的 POSITION_HOLD 不由后继普通事件或临时 retain 偷重试。 */
  function collectAdmissionSymbols(projection: QuoteSubscriptionTruthProjection): Set<string> {
    const symbols = new Set<string>();
    for (const [ownerStoreKey, retainedSymbols] of retainsByOwner) {
      const isPosition = ownerStoreKey.startsWith('POSITION_HOLD:');
      const isOrdinary =
        ownerStoreKey.startsWith('MONITOR_BASE:') ||
        ownerStoreKey.startsWith('SEAT_BOUND:') ||
        ownerStoreKey.startsWith('ORDER_HOLD:');
      const canAdmit =
        projection === 'ALL' ||
        (projection === 'POSITION_HOLD' && isPosition) ||
        (projection === 'ORDINARY' && isOrdinary) ||
        (projection === 'NONE' && !isPosition && !isOrdinary);
      if (canAdmit) for (const symbol of retainedSymbols) symbols.add(symbol);
    }

    return symbols;
  }

  /** 未轮到所属命令的新事实只保护已订阅标的，不授予当前命令首次准入权限。 */
  function collectProtectedCurrentTruthSymbols(): Set<string> {
    const protectedSymbols = new Set<string>();
    if (monitorTruthEnabled) protectedSymbols.add(deps.tradingConfig.monitor.monitorSymbol);

    if (seatTruthEnabled) for (const symbol of readSeatBoundSymbols()) protectedSymbols.add(symbol);

    if (orderTruthEnabled)
      for (const symbol of deps.trader.getOrderHoldSymbols()) protectedSymbols.add(symbol);

    if (positionTruthEnabled)
      for (const symbol of collectPositionSymbols(deps.snapshot.getView().positions))
        protectedSymbols.add(symbol);

    return protectedSymbols;
  }

  /**
   * 单条串行链逐阶段收敛所属投影；broker ack 只登记实际订阅事实，再重读当前 truth。
   * removed 不跨 await 使用，全部当前事实保护退订；新持仓 mutation 仍归 awaited owner。
   * 部分阶段成功立即登记；失败只留下已准入的释放责任，不由无关命令偷重试。
   */
  async function applyMutation(projection: QuoteSubscriptionTruthProjection): Promise<void> {
    const positionOwner = { reason: 'POSITION_HOLD', ownerKey: 'canonical-snapshot' } as const;
    const projectsPositions = projection === 'ALL' || projection === 'POSITION_HOLD';
    // 仅记录本命令承担过的持仓订阅责任；期待事实始终从 canonical view 重读。
    const positionMutationSymbols = new Set(
      projectsPositions ? retainsByOwner.get(buildOwnerStoreKey(positionOwner)) : [],
    );
    try {
      for (;;) {
        if (accepting && deps.termination.isTerminated()) return;

        const positionToken = projectCurrentTruth(projection);
        if (projectsPositions)
          for (const symbol of retainsByOwner.get(buildOwnerStoreKey(positionOwner)) ?? [])
            positionMutationSymbols.add(symbol);

        const desired = collectDesiredSymbols();
        const committedSymbols = readCommittedSymbolsFromLastState();
        const added = [...collectAdmissionSymbols(projection)].filter(
          (symbol) => !committedSymbols.has(symbol),
        );
        if (added.length > 0) {
          await deps.marketDataClient.subscribeSymbols(added);
          for (const symbol of added) committedSymbols.add(symbol);

          writeCommittedSymbols(committedSymbols);
          if (
            positionToken !== null &&
            !deps.snapshot.isCurrent(positionToken, { account: false, positions: true })
          )
            truthDirty = true;

          // 远端 ack 是已生效事实；后续差集必须重新读取当前 truth。
          continue;
        }

        const protectedSymbols = accepting ? collectProtectedCurrentTruthSymbols() : new Set();
        const removed = [...committedSymbols].filter(
          (symbol) => !desired.has(symbol) && !protectedSymbols.has(symbol),
        );
        if (removed.length > 0) {
          await deps.marketDataClient.unsubscribeSymbols(removed);
          for (const symbol of removed) committedSymbols.delete(symbol);

          writeCommittedSymbols(committedSymbols);
          if (
            positionToken !== null &&
            !deps.snapshot.isCurrent(positionToken, { account: false, positions: true })
          )
            truthDirty = true;

          continue;
        }

        if (
          accepting &&
          (truthDirty ||
            (positionToken !== null &&
              deps.snapshot.getView().positionsValid &&
              !deps.snapshot.isCurrent(positionToken, { account: false, positions: true })))
        )
          continue;

        // invalid 不等于 flat；此处仅确认所属命令收敛，不签发业务 ready。
        return;
      }
    } catch (error: unknown) {
      if (projectsPositions) {
        const committedSymbols = readCommittedSymbolsFromLastState();
        // 已成功阶段仍是既成事实；失败准入不留期待，失败退订留待 awaited owner 再对账。
        setOwnerSymbols(
          positionOwner,
          [...positionMutationSymbols].filter((symbol) => committedSymbols.has(symbol)),
        );
      }

      throw error;
    }
  }

  /**
   * 把 desired state 更新与对应 SDK mutation 作为同一条串行命令入队。
   *
   * 为什么：更新必须在自己的命令执行时才生效；若在入队前同步改写 store，
   * 排队中的旧命令会读到后来注册的 retain，代替其 owner 执行首次 admission。
   *
   * @param projection 本条命令有权推进的基础事实投影
   * @param update 本条命令执行时需要先应用的 desired state 更新；省略时仅按当前 store 收口
   * @returns 本条命令的完成 Promise；失败原样拒绝调用方，后续命令仍继续串行执行
   */
  function enqueueSubscriptionSync(
    projection: QuoteSubscriptionTruthProjection,
    update?: () => void,
  ): Promise<void> {
    const runCommand = async (): Promise<void> => {
      update?.();
      await applyMutation(projection);
    };
    mutationChain = mutationChain.then(runCommand, runCommand);
    return mutationChain;
  }

  function projectMonitorBase(): void {
    setOwnerSymbols(
      { reason: 'MONITOR_BASE', ownerKey: deps.tradingConfig.monitor.monitorSymbol },
      [deps.tradingConfig.monitor.monitorSymbol],
    );
  }

  /**
   * 投影两个方向席位的 SEAT_BOUND 标的。
   * 未准入的 ACTIVATING 新标的不在此处订阅：其首次 admission 由 awaited activation retain 完成；
   * 已准入的标的继续保留，避免启动快照与换标推进期间的退订抖动。ACTIVE 席位始终由本投影接管。
   */
  function readSeatBoundSymbols(): ReadonlyArray<string> {
    const committedSymbols = deps.lastState.allTradingSymbols;
    const seatSymbols: string[] = [];
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = deps.symbolRegistry.getSeatState(direction);
      if (seatState.status === 'EMPTY' || seatState.status === 'SEARCHING') {
        continue;
      }

      if (seatState.status === 'ACTIVATING' && !committedSymbols.has(seatState.symbol)) {
        continue;
      }

      seatSymbols.push(seatState.symbol);
    }

    return seatSymbols;
  }

  function projectAllSeatBound(): void {
    setOwnerSymbols({ reason: 'SEAT_BOUND', ownerKey: 'all-seats' }, readSeatBoundSymbols());
  }

  function projectOrderHold(): void {
    setOwnerSymbols(
      { reason: 'ORDER_HOLD', ownerKey: 'trader' },
      deps.trader.getOrderHoldSymbols(),
    );
  }

  function projectPositionHold(): SnapshotToken {
    const view = deps.snapshot.getView();
    setOwnerSymbols(
      { reason: 'POSITION_HOLD', ownerKey: 'canonical-snapshot' },
      collectPositionSymbols(view.positions),
    );
    return view.token;
  }

  function handleSeatChanged(event: SeatStateChangedEvent): void {
    if (!running || deps.termination.isTerminated()) return;

    const symbols = collectSeatSymbols(event);
    seatTruthEnabled = true;
    truthDirty = true;
    void enqueueSubscriptionSync('ORDINARY').catch((error: unknown) => {
      logger.error(
        `[QuoteSubscriptionRuntime] 处理席位订阅变化失败 symbols=${symbols.join(',')}`,
        formatError(error),
      );
      deps.termination.reportFatalError(error);
    });
  }

  function handleOrderHoldChanged(): void {
    if (!running || deps.termination.isTerminated()) return;

    orderTruthEnabled = true;
    truthDirty = true;
    void enqueueSubscriptionSync('ORDINARY').catch((error: unknown) => {
      logger.error('[QuoteSubscriptionRuntime] 处理订单保留订阅变化失败', formatError(error));
      deps.termination.reportFatalError(error);
    });
  }

  async function reconcileFromCurrentTruth(): Promise<void> {
    if (deps.termination.isTerminated()) return;

    if (drainPromise !== null) await drainPromise;

    if (deps.termination.isTerminated()) return;

    accepting = true;
    drainPromise = null;
    await enqueueSubscriptionSync('ALL', () => {
      monitorTruthEnabled = true;
      seatTruthEnabled = true;
      positionTruthEnabled = true;
      orderTruthEnabled = true;
      truthDirty = true;
    });
  }

  /**
   * 真实 commit 通知只触发当前事实对账；迟到 token 不成为期待集合或全局 ready 凭据。
   * 调用方 await 返回后仍须复核自己捕获的 receipt/席位/交易授权。
   */
  async function reconcilePositionHoldFromCurrentTruth(_token: SnapshotToken): Promise<void> {
    if (!accepting) return;

    // 通知 token 不授予旧投影或排队前准入权限；由自己的串行命令读取当前 canonical view。
    positionTruthEnabled = true;
    truthDirty = true;
    await enqueueSubscriptionSync('POSITION_HOLD');
  }

  function start(): void {
    if (running || deps.termination.isTerminated() || !accepting) {
      return;
    }

    running = true;
    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatChanged);
    unsubscribeOrderHoldChanged = deps.trader.onOrderHoldSymbolsChanged(handleOrderHoldChanged);
  }

  /** 仅停止事件生产，保留在途 PostTrade/retain 调用方完成订阅收口的能力。 */
  function stop(): void {
    running = false;
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
    unsubscribeOrderHoldChanged?.();
    unsubscribeOrderHoldChanged = null;
  }

  /**
   * 在全部调用方排空后关闭准入，同一在途排空共享 Promise。
   * 本轮失败原样交还所有等待方；只有后续显式 drain 才重试最终退订，
   * reconcile 仍须等待最近一轮成功，不能借失败重新打开准入。
   */
  function stopAndDrain(): Promise<void> {
    if (drainPromise !== null && !drainFailed) return drainPromise;

    stop();
    accepting = false;
    // 首轮必须暴露已有 mutation 的失败；后续 drain 已观察该失败，才允许重新收口。
    const pendingMutation = drainFailed ? Promise.resolve() : mutationChain;
    drainFailed = false;
    drainPromise = pendingMutation
      .then(() =>
        enqueueSubscriptionSync('NONE', () => {
          retainsByOwner.clear();
          truthDirty = false;
        }),
      )
      .catch((error: unknown) => {
        drainFailed = true;
        throw error;
      });
    return drainPromise;
  }

  /**
   * 注册临时 retain，并等待包含本次注册的 admission mutation。
   *
   * 为什么失败回滚：admission 失败后若继续保留 desired，后续无关命令会读到该 retain
   * 并代替本 owner 重复尝试首次 admission，既偷走 owner 的有限重试，
   * 也会把外部失败送进没有恢复 owner 的 fatal 通道；重试统一由 awaited 调用方重新注册。
   */
  async function retainSymbols(params: QuoteSubscriptionRetainParams): Promise<void> {
    if (!accepting) return;

    const owner: QuoteSubscriptionRetainOwner = {
      reason: params.reason,
      ownerKey: params.ownerKey,
    };
    try {
      await enqueueSubscriptionSync('NONE', () => {
        setOwnerSymbols(owner, params.symbols);
      });
    } catch (error: unknown) {
      removeOwner(owner);
      throw error;
    }
  }

  async function releaseRetain(
    params: Pick<QuoteSubscriptionRetainParams, 'ownerKey' | 'reason'>,
  ): Promise<void> {
    if (!accepting) return;

    await enqueueSubscriptionSync('NONE', () => {
      removeOwner(params);
    });
  }

  async function waitForAdmission(symbols: ReadonlyArray<string>): Promise<void> {
    if (!accepting) return;

    await mutationChain;
    if (!isAccepting()) return;

    const committedSymbols = readCommittedSymbolsFromLastState();
    const missing = normalizeSymbols(symbols).filter(
      (symbol) => !committedSymbols.has(symbol) && hasRetainForSymbol(retainsByOwner, symbol),
    );
    if (missing.length > 0) {
      await enqueueSubscriptionSync('NONE');
    }
  }

  return {
    reconcileFromCurrentTruth,
    reconcilePositionHoldFromCurrentTruth,
    start,
    stopAndDrain,
    retainSymbols,
    releaseRetain,
    waitForAdmission,
  };
}
