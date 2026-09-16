/**
 * QuoteSubscriptionRuntime
 *
 * 职责：
 * - 作为稳态运行期 quote 订阅集合唯一 owner
 * - 以 retain reason 汇总 monitor、seat、position、order 与临时等待需求
 * - 串行执行 subscribe/unsubscribe mutation，并在每个 SDK 阶段成功后立即更新 committed set 与 lastState.allTradingSymbols
 *
 * 准入纪律：
 * - 基础投影与 retain 注册都与其对应的 SDK mutation 在同一条串行命令内执行；
 *   排队中的旧命令只观察自己执行时已注册的 desired state，不会消费后来注册的 activation retain。
 * - 未准入的 ACTIVATING 新标的不进入 SEAT_BOUND；首次 admission 只由 awaited activation retain 发起，
 *   席位进入 ACTIVE 后才由 SEAT_BOUND 接棒；已准入的标的保持订阅，避免启动与换标期间的订阅抖动。
 * - 事件驱动的普通 seat/order 变化没有恢复 owner，mutation 失败仍进入 fatal 通道；
 *   activation retain 的 mutation 失败会回滚本次注册，把原错误交还 awaited 调用方，由 owner 决定有限重试。
 */
import type { Position } from '../../types/account.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { Unsubscribe } from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import type {
  MutableQuoteSubscriptionRetainStore,
  QuoteSubscriptionRetainParams,
  QuoteSubscriptionRetainOwner,
  QuoteSubscriptionRuntime,
  QuoteSubscriptionRuntimeDeps,
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

  /**
   * 收敛 desired 与 committed 差异，逐阶段执行 SDK mutation。
   *
   * 为什么每个阶段成功后立即写回 committed：SDK 调用成功即成为既成事实，
   * 后续阶段失败不能把前一阶段的成功一起丢掉；否则后续命令与显式 drain 会按失真的
   * committed 计算退订范围，已订阅的标的永久泄漏却假装收口成功。
   * 每个阶段只在对应 SDK 调用成功后登记确认事实，失败指令由调用方或后续命令继续收口。
   */
  async function applyMutation(): Promise<void> {
    const desired = collectDesiredSymbols();
    const committedSymbols = readCommittedSymbolsFromLastState();
    const added = [...desired].filter((symbol) => !committedSymbols.has(symbol));
    const removed = [...committedSymbols].filter((symbol) => !desired.has(symbol));

    if (added.length > 0) {
      await deps.marketDataClient.subscribeSymbols(added);
      for (const symbol of added) {
        committedSymbols.add(symbol);
      }

      writeCommittedSymbols(committedSymbols);
    }

    if (removed.length > 0) {
      await deps.marketDataClient.unsubscribeSymbols(removed);
      for (const symbol of removed) {
        committedSymbols.delete(symbol);
      }

      writeCommittedSymbols(committedSymbols);
    }
  }

  /**
   * 把 desired state 更新与对应 SDK mutation 作为同一条串行命令入队。
   *
   * 为什么：更新必须在自己的命令执行时才生效；若在入队前同步改写 store，
   * 排队中的旧命令会读到后来注册的 retain，代替其 owner 执行首次 admission。
   *
   * @param update 本条命令执行时需要先应用的 desired state 更新；省略时仅按当前 store 收口
   * @returns 本条命令的完成 Promise；失败原样拒绝调用方，后续命令仍继续串行执行
   */
  function enqueueSubscriptionSync(update?: () => void): Promise<void> {
    const runCommand = async (): Promise<void> => {
      update?.();
      await applyMutation();
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
  function projectAllSeatBound(): void {
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

    setOwnerSymbols({ reason: 'SEAT_BOUND', ownerKey: 'all-seats' }, seatSymbols);
  }

  function projectOrderHold(): void {
    setOwnerSymbols(
      { reason: 'ORDER_HOLD', ownerKey: 'trader' },
      deps.trader.getOrderHoldSymbols(),
    );
  }

  function projectPositionHold(): void {
    setOwnerSymbols(
      { reason: 'POSITION_HOLD', ownerKey: 'last-state' },
      collectPositionSymbols(deps.lastState.cachedPositions),
    );
  }

  function handleSeatChanged(event: SeatStateChangedEvent): void {
    if (!running || deps.termination.isTerminated()) return;

    const symbols = collectSeatSymbols(event);
    void enqueueSubscriptionSync(projectAllSeatBound).catch((error: unknown) => {
      logger.error(
        `[QuoteSubscriptionRuntime] 处理席位订阅变化失败 symbols=${symbols.join(',')}`,
        formatError(error),
      );
      deps.termination.reportFatalError(error);
    });
  }

  function handleOrderHoldChanged(): void {
    if (!running || deps.termination.isTerminated()) return;

    void enqueueSubscriptionSync(projectOrderHold).catch((error: unknown) => {
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
    await enqueueSubscriptionSync(() => {
      projectMonitorBase();
      projectAllSeatBound();
      projectPositionHold();
      projectOrderHold();
    });
  }

  async function reconcilePositionHoldFromCurrentTruth(): Promise<void> {
    if (!accepting) return;

    await enqueueSubscriptionSync(projectPositionHold);
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
        enqueueSubscriptionSync(() => {
          retainsByOwner.clear();
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
      await enqueueSubscriptionSync(() => {
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

    await enqueueSubscriptionSync(() => {
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
      await enqueueSubscriptionSync();
    }
  }

  return {
    reconcileFromCurrentTruth,
    reconcilePositionHoldFromCurrentTruth,
    start,
    stop,
    stopAndDrain,
    retainSymbols,
    releaseRetain,
    waitForAdmission,
  };
}
