/**
 * QuoteSubscriptionRuntime
 *
 * 职责：
 * - 作为稳态运行期 quote 订阅集合唯一 owner
 * - 以 retain reason 汇总 monitor、seat、position、order 与临时等待需求
 * - 串行执行 subscribe/unsubscribe mutation，并在提交成功后更新 committed set 与 lastState.allTradingSymbols
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
 * runtime 不复制业务事实，只在事件到达时从权威状态重投影对应 retain reason。
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
    }

    if (removed.length > 0) {
      await deps.marketDataClient.unsubscribeSymbols(removed);
      for (const symbol of removed) {
        committedSymbols.delete(symbol);
      }
    }

    deps.lastState.allTradingSymbols = new Set(committedSymbols);
  }

  function enqueueMutation(): Promise<void> {
    mutationChain = mutationChain.then(applyMutation, applyMutation);
    return mutationChain;
  }

  function projectMonitorBase(): void {
    setOwnerSymbols(
      { reason: 'MONITOR_BASE', ownerKey: deps.tradingConfig.monitor.monitorSymbol },
      [deps.tradingConfig.monitor.monitorSymbol],
    );
  }

  function projectAllSeatBound(): void {
    const seatSymbols: string[] = [];
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = deps.symbolRegistry.getSeatState(direction);
      if (seatState.status !== 'EMPTY' && seatState.status !== 'SEARCHING') {
        seatSymbols.push(seatState.symbol);
      }
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
    projectAllSeatBound();
    void enqueueMutation().catch((error: unknown) => {
      logger.error(
        `[QuoteSubscriptionRuntime] 处理席位订阅变化失败 symbols=${symbols.join(',')}`,
        formatError(error),
      );
      deps.termination.reportFatalError(error);
    });
  }

  function handleOrderHoldChanged(): void {
    if (!running || deps.termination.isTerminated()) return;

    projectOrderHold();
    void enqueueMutation().catch((error: unknown) => {
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
    projectMonitorBase();
    projectAllSeatBound();
    projectPositionHold();
    projectOrderHold();
    await enqueueMutation();
  }

  async function reconcilePositionHoldFromCurrentTruth(): Promise<void> {
    if (!accepting) return;

    projectPositionHold();
    await enqueueMutation();
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
      .then(async () => {
        retainsByOwner.clear();
        await enqueueMutation();
      })
      .catch((error: unknown) => {
        drainFailed = true;
        throw error;
      });
    return drainPromise;
  }

  async function retainSymbols(params: QuoteSubscriptionRetainParams): Promise<void> {
    if (!accepting) return;

    const owner: QuoteSubscriptionRetainOwner = {
      reason: params.reason,
      ownerKey: params.ownerKey,
    };
    setOwnerSymbols(owner, params.symbols);
    await enqueueMutation();
  }

  async function releaseRetain(
    params: Pick<QuoteSubscriptionRetainParams, 'ownerKey' | 'reason'>,
  ): Promise<void> {
    if (!accepting) return;

    removeOwner(params);
    await enqueueMutation();
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
      await enqueueMutation();
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
