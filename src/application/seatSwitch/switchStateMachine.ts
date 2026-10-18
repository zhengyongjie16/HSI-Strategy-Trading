/**
 * 自动换标模块：换标状态机
 *
 * 功能：管理从撤单到回补买入的完整换标流程。
 * 职责：统一处理距离换标与周期换标的启动入口，推进换标状态机（撤单/卖出/绑定/等待行情/回补/完成），处理周期换标到期后的空仓等待与触发。
 * 执行流程：startSwitchOnDistance/advancePendingSwitch/evaluatePeriodicSwitchDue 触发 → startSwitchFlow 预寻标与入口判定；周期换标在无候选时直接业务收口，其余需要换标的路径写入 switchStates 并由 processSwitchState 推进到完成或失败。
 */
import type {
  PeriodicSeatBlockSource,
  PeriodicSwitchInternalPendingState,
  SwitchState,
} from '../../domain/seat/types.js';
import { ORDER_QUOTE_RETRY } from '../../constants/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { exactAdd, exactCompare } from '../../utils/numeric/exact.js';
import {
  resolveSeatSwitchPolicy,
  resolveDistanceTriggerSide,
  shouldResetPeriodicPendingBySeatActivatedAt,
} from '../../domain/seat/switchPolicy.js';
import { initialSwitchState } from '../../domain/seat/switchState.js';
import { resolveNextQuoteRetry } from '../quoteRetry.js';
import { resolveQuoteReadinessForRequirement } from '../../domain/order/quoteReadiness.js';
import type { QuoteReadinessStatus } from '../../domain/order/types.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { PendingOrder } from '../../types/orderReadMetadata.js';
import type { CancelOrderOutcome } from '../../types/orderCancellation.js';
import { isSeatActive, resolveNextSearchFailureState } from '../../domain/seat/seatPolicy.js';
import {
  formatCancelOutcomeTag,
  isCancelAcceptedOrTerminalNonFilledClose,
} from '../../domain/order/cancelOutcomePolicy.js';
import type {
  AdvancePendingSwitchParams,
  StartSwitchFlowParams,
  StartSwitchOnDistanceParams,
  SwitchProcessParams,
  PeriodicSwitchDueParams,
  SwitchStateMachine,
  SwitchStateMachineDeps,
} from './types.js';
import type {
  AdvancePendingSwitchResult,
  PeriodicSeatBlockingReason,
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
  SwitchWakeupRequirement,
} from '../../types/seatSwitch.js';

import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';

/**
 * 从持仓列表中提取指定标的的持仓信息。
 * @param positions - 持仓列表
 * @param symbol - 标的代码
 * @returns 匹配的持仓，无则 null
 */
function extractPosition(positions: ReadonlyArray<Position>, symbol: string): Position | null {
  if (!symbol) {
    return null;
  }

  return positions.find((pos) => pos.symbol === symbol) ?? null;
}

function hasQuoteRetryElapsed(state: SwitchState, nowMs: number): boolean {
  return state.quoteRetryNextAt === null || nowMs >= state.quoteRetryNextAt;
}

function resetQuoteRetryState(state: SwitchState): void {
  state.quoteRetryAttempts = 0;
  state.quoteRetryNextAt = null;
  state.quoteRetryExhausted = false;
}

function advanceQuoteRetryState(state: SwitchState, nowMs: number): void {
  const nextRetry = resolveNextQuoteRetry({
    attempts: state.quoteRetryAttempts,
    nowMs,
    intervalMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
    maxAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
  });
  state.quoteRetryAttempts = nextRetry.nextAttempts;
  state.quoteRetryNextAt = nextRetry.nextRetryAt;
  state.quoteRetryExhausted = nextRetry.exhausted;
}

function resolveRebuyQuoteReadiness(quote: Quote | null | undefined): QuoteReadinessStatus {
  return resolveQuoteReadinessForRequirement({ quote, requirement: 'PRICE_AND_LOT_SIZE' });
}

function isRebuyQuoteReady(quote: Quote | null | undefined): quote is Quote & { lotSize: number } {
  return (
    resolveRebuyQuoteReadiness(quote) === 'READY' &&
    quote !== null &&
    quote !== undefined &&
    isValidPositiveNumber(quote.lotSize)
  );
}

/**
 * 构造无需动作的 switch drive 结果。
 *
 * @returns 表示当前无需注册任何唤醒源的 NOOP 结果
 */
function createNoopDriveResult(): Extract<SwitchDriveResult, { kind: 'NOOP' }> {
  return { kind: 'NOOP' };
}

function createNoopAdvanceResult(direction: 'LONG' | 'SHORT'): AdvancePendingSwitchResult {
  return {
    advanced: false,
    direction,
    stillPending: false,
    driveResult: createNoopDriveResult(),
  };
}

/**
 * 构造等待外部事件的 switch drive 结果。
 *
 * @param wakeups 下一次允许推进状态机的显式唤醒源
 * @returns WAIT 结果
 */
function createWaitDriveResult(
  wakeups: readonly [SwitchWakeupRequirement, ...SwitchWakeupRequirement[]],
): Extract<SwitchDriveResult, { kind: 'WAIT' }> {
  return {
    kind: 'WAIT',
    wakeups,
  };
}

function createOrderAndFreshnessWait(symbol: string): Extract<SwitchDriveResult, { kind: 'WAIT' }> {
  return createWaitDriveResult([{ kind: 'ORDER_EVENT', symbols: [symbol] }, { kind: 'FRESHNESS' }]);
}

async function fetchRealtimeQuote(
  marketDataClient: SwitchStateMachineDeps['marketDataClient'],
  symbol: string,
): Promise<Quote | null> {
  const quotes = await marketDataClient.getQuotes([symbol]);
  return quotes.get(symbol) ?? null;
}

function isFilledCloseOutcome(outcome: CancelOrderOutcome): boolean {
  return outcome.kind === 'ALREADY_CLOSED' && outcome.closedReason === 'FILLED';
}

function hasOpenBuyExposure(params: {
  readonly orderRecorder: SwitchStateMachineDeps['orderRecorder'];
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly positions: ReadonlyArray<Position>;
}): boolean {
  const { orderRecorder, symbol, direction, positions } = params;
  const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, direction === 'LONG');
  if (buyOrders.length > 0) {
    return true;
  }

  const position = extractPosition(positions, symbol);
  return (position?.quantity ?? 0) > 0;
}

/**
 * 统一判定周期换标是否仍被席位占用阻塞。
 * 周期换标必须同时检查订单归属、本地在途链路与本轮读取到的 broker pending orders。
 */
function resolvePeriodicSeatBlockSource(params: {
  readonly orderRecorder: SwitchStateMachineDeps['orderRecorder'];
  readonly orderHoldRegistry: SwitchStateMachineDeps['orderHoldRegistry'];
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly brokerPendingOrders?: ReadonlyArray<PendingOrder>;
}): PeriodicSeatBlockSource {
  const { orderRecorder, orderHoldRegistry, symbol, direction, brokerPendingOrders } = params;
  if (brokerPendingOrders?.some((order) => order.symbol === symbol)) {
    return 'BROKER_PENDING_ORDER';
  }

  const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, direction === 'LONG');
  if (buyOrders.length > 0) {
    return 'ORDER_RECORDER';
  }

  if (orderHoldRegistry.getHoldSymbols().has(symbol)) {
    return 'LOCAL_PENDING_ORDER';
  }

  return 'EMPTY';
}

/**
 * 创建换标状态机，管理从撤单到回补买入的完整换标流程，并提供周期换标触发能力。
 * @param deps - 依赖（trader、orderRecorder、riskChecker、switchStates、buildOrderSignal 等）
 * @returns SwitchStateMachine 实例（evaluatePeriodicSwitchDue、startSwitchOnDistance、advancePendingSwitch、hasPendingSwitch）
 */
export function createSwitchStateMachine(deps: SwitchStateMachineDeps): SwitchStateMachine {
  // 仅关联原issued stage的broker ID；远端事实仍由O持有，不给后继route重新授权。
  const rebuyOrderIds = new WeakMap<SwitchState, ReadonlyArray<string>>();
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    cacheManager,
    orderHoldRegistry,
    orderMonitor,
    orderExecutor,
    orderRecorder,
    readSwitchPositions,
    riskChecker,
    marketDataClient,
    now,
    switchStates,
    periodicSwitchPending,
    resolveSuppression,
    markSuppression,
    enterSwitchingSeat,
    updateSeatState,
    candidateSearch,
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal,
    pendingOrderStatuses,
    buySide,
    logger,
    maxSearchFailuresPerDay,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot,
  } = deps;

  /** 本次等待身份及入场后新生 SELL 均由原 lifecycle owner 判定，异步窗口不重新签发卖出资格。 */
  function hasSettledSellRemainder(state: SwitchState): boolean {
    const ids = new Set([
      ...state.sellWaitOrderIds,
      ...orderMonitor
        .getKnownSellOrderIds(state.oldSymbol)
        .filter((id) => !state.sellOrderIdsAtAdmission.includes(id)),
    ]);
    return [...ids].some(
      (id) => orderMonitor.getSellOperationState(id) === 'SETTLED_WITH_REMAINDER',
    );
  }

  /** 判断订单是否为指定标的的可撤销买入挂单 */
  function isCancelableBuyOrder(order: PendingOrder, symbol: string): boolean {
    return (
      order.symbol === symbol && order.side === buySide && pendingOrderStatuses.has(order.status)
    );
  }

  async function executeSwitchSignal(
    signal: ReturnType<SwitchStateMachineDeps['buildOrderSignal']>,
    submitFailedMessage: string,
    canContinue: () => boolean,
  ): Promise<Awaited<
    ReturnType<SwitchStateMachineDeps['orderExecutor']['executeSignals']>
  > | null> {
    if (!canContinue()) {
      return null;
    }

    // 原调用方票与原route身份直通executor；其内部quote/permit/position await后仍使用同一授权。
    const executionResult = await orderExecutor.executeSignals([signal], canContinue);

    // 真实ack是O/执行owner事实，旧业务授权失效不能把已返回ID变成未提交。
    if (executionResult.executedOrderIds.length === 0) {
      if (canContinue()) logger.warn(submitFailedMessage);

      return null;
    }

    return executionResult;
  }

  /** 清除某方向的周期换标 pending 状态。 */
  function clearPeriodicPending(direction: 'LONG' | 'SHORT', canContinue: () => boolean): boolean {
    if (!canContinue()) {
      return false;
    }

    periodicSwitchPending.delete(direction);
    return true;
  }

  /** 标记某方向已进入周期换标 pending（等待空仓）。 */
  function markPeriodicPending(
    direction: 'LONG' | 'SHORT',
    pendingSinceMs: number,
    blockedBy: PeriodicSeatBlockingReason,
    canContinue: () => boolean,
  ): boolean {
    if (!canContinue()) {
      return false;
    }

    periodicSwitchPending.set(direction, {
      pending: true,
      pendingSinceMs,
      blockedBy,
    });
    return true;
  }

  /** 读取某方向的周期换标 pending 状态。 */
  function resolvePeriodicPending(direction: 'LONG' | 'SHORT'): PeriodicSwitchInternalPendingState {
    const state = periodicSwitchPending.get(direction);
    if (!state) {
      return {
        pending: false,
        pendingSinceMs: null,
      };
    }

    return state;
  }

  function clearSeatWithSearchFailure(params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentSeat: ReturnType<typeof symbolRegistry.getSeatState>;
    readonly nowDate: Date;
    readonly lastSwitchAt: number | null;
    readonly bumpVersion: boolean;
  }): boolean {
    const { direction, currentSeat, nowDate, lastSwitchAt, bumpVersion } = params;
    const nowMs = nowDate.getTime();
    const hkDateKey = getHKDateKey(nowDate);
    const { nextFailCount, frozenTradingDayKey, shouldFreeze } = resolveNextSearchFailureState({
      currentSeat,
      hkDateKey,
      maxSearchFailuresPerDay,
    });

    const nextState = {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt,
      lastSearchAt: nowMs,
      lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
      callPrice: null,
      searchFailCountToday: nextFailCount,
      frozenTradingDayKey,
    } as const;

    if (bumpVersion) {
      symbolRegistry.updateSeatStateWithVersionBump(direction, nextState);
    } else {
      updateSeatState(direction, nextState, false);
    }

    if (shouldFreeze) {
      logger.warn(
        `[自动换标] ${monitorSymbol} ${direction} 当日寻标失败达 ${nextFailCount} 次，席位冻结`,
      );
    }

    return true;
  }

  /**
   * 周期换标预寻标无候选时，按正常业务分支直接清空席位并复用失败计数/冻结模型。
   * 该分支不是状态机失败，因此不会进入 SWITCHING 或写入 switchStates。
   */
  function clearSeatOnPeriodicNoCandidate(
    direction: 'LONG' | 'SHORT',
    canContinue: () => boolean,
  ): boolean {
    if (!canContinue()) {
      return false;
    }

    const nowDate = now();
    const nowMs = nowDate.getTime();
    const currentSeat = symbolRegistry.getSeatState(direction);

    // 原票有效时先关闭原周期等待；EMPTY/version bump后不能用旧ACTIVE票自否认已提交收口。
    if (!clearPeriodicPending(direction, canContinue)) return false;

    if (
      !clearSeatWithSearchFailure({
        direction,
        currentSeat,
        nowDate,
        lastSwitchAt: nowMs,
        bumpVersion: true,
      })
    ) {
      return false;
    }

    logger.info(
      `[自动换标] ${monitorSymbol} ${direction} 周期换标无候选，清空席位 oldSymbol=${currentSeat.symbol ?? 'null'}`,
    );
    return true;
  }

  /** 判断指定方向是否存在有效的进行中换标流程 */
  function hasPendingSwitch(direction: 'LONG' | 'SHORT'): boolean {
    const switchState = switchStates.get(direction);
    if (!switchState) {
      return false;
    }

    const currentVersion = symbolRegistry.getSeatVersion(direction);
    if (currentVersion !== switchState.seatVersion) {
      switchStates.delete(direction);
      return false;
    }

    const seatState = symbolRegistry.getSeatState(direction);
    const symbolMatches =
      seatState.symbol === switchState.oldSymbol || seatState.symbol === switchState.nextSymbol;
    if (seatState.status !== 'SWITCHING' || !symbolMatches) {
      switchStates.delete(direction);
      return false;
    }

    if (switchState.stage === 'COMPLETE' || switchState.stage === 'FAILED') {
      switchStates.delete(direction);
      return false;
    }

    return true;
  }

  /**
   * 复核当前推进中的 switch state 是否仍归属于当前席位。
   * 只要 seatVersion、seat 状态或 registry 中的当前 state 任一失配，就立即停止旧流程，避免过期流程继续提交信号或覆盖新席位。
   */
  function isCurrentSwitchStateValid(state: SwitchState): boolean {
    const currentState = switchStates.get(state.direction);
    if (currentState !== state) {
      return false;
    }

    const currentVersion = symbolRegistry.getSeatVersion(state.direction);
    if (currentVersion !== state.seatVersion) {
      if (currentState === state) {
        switchStates.delete(state.direction);
      }

      return false;
    }

    const seatState = symbolRegistry.getSeatState(state.direction);
    const symbolMatches =
      seatState.symbol === state.oldSymbol || seatState.symbol === state.nextSymbol;
    if (seatState.status !== 'SWITCHING' || !symbolMatches) {
      if (currentState === state) {
        switchStates.delete(state.direction);
      }

      return false;
    }

    // 终态仅能由已通过前置 gate 与席位身份校验的同一同步调用收口，
    // 后续普通有效性检查不得再次授权终态 state 写入。
    if (state.stage === 'COMPLETE' || state.stage === 'FAILED') {
      if (currentState === state) {
        switchStates.delete(state.direction);
      }

      return false;
    }

    return true;
  }

  /** 预寻标：在触发换标前查找候选标的，无合适标的时返回 null */
  async function findSwitchCandidate(
    direction: 'LONG' | 'SHORT',
    canContinue: () => boolean,
  ): Promise<{ readonly symbol: string; readonly callPrice: string } | null> {
    if (!canContinue()) {
      return null;
    }

    const best = await candidateSearch.findCandidate({
      direction,
      currentTime: now(),
      canContinue,
    });
    if (!canContinue()) {
      return null;
    }

    if (!best) {
      return null;
    }

    return { symbol: best.symbol, callPrice: best.callPrice };
  }

  /**
   * 统一换标启动入口：
   * - 预寻标
   * - 同标的抑制
   * - 周期换标在无候选时直接业务收口，不进入状态机
   * - 其余需要换标的路径将席位切换为 SWITCHING 并写入 switchStates
   * - 按需决定是否立即推进状态机（仅距离换标）
   */
  async function startSwitchFlow(params: StartSwitchFlowParams): Promise<SwitchDriveResult> {
    const { canContinue } = params;
    if (!canContinue()) {
      return createNoopDriveResult();
    }

    const isPeriodicTrigger = params.triggerKind === 'PERIODIC';
    const direction = isPeriodicTrigger ? params.direction : params.distanceContext.direction;
    const reason = params.reason;
    const switchMode = isPeriodicTrigger ? 'PERIODIC' : 'DISTANCE';
    const switchPolicy = resolveSeatSwitchPolicy(switchMode);
    const suppressionTriggerKind =
      params.triggerKind === 'DISTANCE_DANGER_SIDE' ? null : params.triggerKind;
    const distanceContext = isPeriodicTrigger ? null : params.distanceContext;

    if (hasPendingSwitch(direction)) {
      return createNoopDriveResult();
    }

    const seatState = symbolRegistry.getSeatState(direction);
    if (!isSeatActive(seatState)) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    const sellOrderIdsAtAdmission =
      switchMode === 'DISTANCE' ? orderMonitor.getKnownSellOrderIds(seatState.symbol) : [];
    const admissionSellOrderIds =
      switchMode === 'DISTANCE' ? orderMonitor.getUnsettledSellOrderIds(seatState.symbol) : [];
    const seatVersionAtStart = symbolRegistry.getSeatVersion(direction);
    const seatSymbol = seatState.symbol;
    // 原closure携带调用方captured epoch/receipt/gate/position组件；仅叠加原ACTIVE身份，不换票。
    const canAdmit = (): boolean => {
      const currentSeat = symbolRegistry.getSeatState(direction);
      return (
        canContinue() &&
        symbolRegistry.getSeatVersion(direction) === seatVersionAtStart &&
        isSeatActive(currentSeat) &&
        currentSeat.symbol === seatSymbol
      );
    };

    if (
      suppressionTriggerKind !== null &&
      resolveSuppression(direction, seatSymbol, suppressionTriggerKind)
    ) {
      return createNoopDriveResult();
    }

    const next = await findSwitchCandidate(direction, canAdmit);
    if (!canAdmit()) {
      return createNoopDriveResult();
    }

    const latestSeatState = symbolRegistry.getSeatState(direction);
    const latestSeatVersion = symbolRegistry.getSeatVersion(direction);
    if (!isSeatActive(latestSeatState)) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    if (latestSeatVersion !== seatVersionAtStart || latestSeatState.symbol !== seatSymbol) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    const brokerPendingOrders = await cacheManager.getPendingOrders([latestSeatState.symbol]);
    if (!canAdmit()) {
      return createNoopDriveResult();
    }

    const admittedSeatState = symbolRegistry.getSeatState(direction);
    const admittedSeatVersion = symbolRegistry.getSeatVersion(direction);
    if (
      !isSeatActive(admittedSeatState) ||
      admittedSeatVersion !== seatVersionAtStart ||
      admittedSeatState.symbol !== seatSymbol
    ) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    if (switchPolicy.oldSeatHandling === 'REQUIRE_EMPTY') {
      const periodicBlockSource = resolvePeriodicSeatBlockSource({
        orderRecorder,
        orderHoldRegistry,
        symbol: admittedSeatState.symbol,
        direction,
        brokerPendingOrders,
      });
      if (periodicBlockSource !== 'EMPTY') {
        if (!markPeriodicPending(direction, now().getTime(), periodicBlockSource, canContinue)) {
          return createNoopDriveResult();
        }

        logger.warn(
          `[自动换标] ${monitorSymbol} ${direction} 周期换标触发前复核发现本地占用，继续等待 blockedBy=${periodicBlockSource}`,
        );
        return createNoopDriveResult();
      }
    }

    if (next?.symbol === admittedSeatState.symbol) {
      if (suppressionTriggerKind !== null) {
        if (!canContinue()) {
          return createNoopDriveResult();
        }

        markSuppression(direction, admittedSeatState.symbol, suppressionTriggerKind);
        logger.info(`[自动换标] ${monitorSymbol} ${direction} 预寻标命中同标的，记录当日抑制`);
      }

      return createNoopDriveResult();
    }

    if (switchPolicy.noCandidate === 'CLEAR_AND_COUNT_FAILURE' && next === null) {
      if (!clearSeatOnPeriodicNoCandidate(direction, canContinue)) {
        return createNoopDriveResult();
      }

      return createNoopDriveResult();
    }

    // 在原票仍有效时准备初始计划；进入SWITCHING后不再用旧ACTIVE授权自否认已提交的route。
    const position =
      distanceContext === null
        ? null
        : extractPosition(distanceContext.positions, admittedSeatState.symbol);
    const shouldRebuy =
      switchPolicy.rebuy === 'ACTUAL_SELL_AMOUNT_IN_SWITCHING' && (position?.quantity ?? 0) > 0;
    if (!clearPeriodicPending(direction, canAdmit) || !canAdmit()) return createNoopDriveResult();

    const seatVersion = enterSwitchingSeat({ direction, reason });
    const committedSeat = symbolRegistry.getSeatState(direction);
    if (
      symbolRegistry.getSeatVersion(direction) !== seatVersion ||
      committedSeat.status !== 'SWITCHING' ||
      committedSeat.symbol !== seatSymbol
    )
      return createNoopDriveResult();

    // 该同步段只发布真实新route及其WAIT owner；后续mutation须由下一次原route授权推进。
    const publishedState = initialSwitchState({
      direction,
      switchMode,
      seatVersion,
      oldSymbol: admittedSeatState.symbol,
      nextSymbol: next?.symbol ?? null,
      nextCallPrice: next?.callPrice ?? null,
      shouldRebuy,
    });
    publishedState.sellOrderIdsAtAdmission = sellOrderIdsAtAdmission;
    if (switchMode === 'DISTANCE')
      publishedState.sellWaitOrderIds = [
        ...new Set([
          ...admissionSellOrderIds,
          ...orderMonitor
            .getKnownSellOrderIds(publishedState.oldSymbol)
            .filter((id) => !sellOrderIdsAtAdmission.includes(id)),
          ...orderMonitor.getUnsettledSellOrderIds(publishedState.oldSymbol),
        ]),
      ];

    switchStates.set(direction, publishedState);

    // 只证明本次已发布的WAIT事实，不是交易授权；原receipt/position/canContinue不能被此票替换。
    // state identity同时排除同方向后继pending；version+symbol+status排除已替换席位。
    const publishedRoute = {
      direction,
      symbol: seatSymbol,
      seatVersion,
      isCurrent: (): boolean => {
        const currentSeat = symbolRegistry.getSeatState(direction);
        return (
          switchStates.get(direction) === publishedState &&
          symbolRegistry.getSeatVersion(direction) === seatVersion &&
          currentSeat.status === 'SWITCHING' &&
          currentSeat.symbol === seatSymbol
        );
      },
    };
    const initialWait = {
      ...createWaitDriveResult([{ kind: 'RETRY_TIMER', atMs: now().getTime() }]),
      publishedRoute,
    };
    return initialWait;
  }

  /**
   * 推进换标状态机，按阶段顺序执行撤单→卖出→绑定新标→等待行情→回补买入→完成。
   * 每次调用都返回显式 drive 结果，声明下一次只能由哪些事件继续推进。
   */
  async function processSwitchState(
    params: SwitchProcessParams,
    state: SwitchState,
    pendingOrders: ReadonlyArray<PendingOrder>,
  ): Promise<SwitchDriveResult> {
    const { direction, positions, canContinue } = params;
    const switchPolicy = resolveSeatSwitchPolicy(state.switchMode);
    if (
      switchPolicy.kind === 'PERIODIC_REPLACE' &&
      (state.stage === 'SELL_OUT' || state.stage === 'WAIT_QUOTE' || state.stage === 'REBUY')
    )
      throw new TypeError('周期替换不能进入距离移仓卖出或回补阶段');

    const { sellAction, buyAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(direction);
    let cachedNextQuote: Quote | null | undefined;

    function stopIfSwitchInvalid(): SwitchDriveResult | null {
      if (!canContinue()) {
        if (
          state.stage === 'REBUY' &&
          state.nextSymbol !== null &&
          rebuyOrderIds.has(state) &&
          isCurrentSwitchStateValid(state)
        )
          return createOrderAndFreshnessWait(state.nextSymbol);

        return createNoopDriveResult();
      }

      if (isCurrentSwitchStateValid(state)) {
        return null;
      }

      return createNoopDriveResult();
    }

    async function getNextQuote(): Promise<Quote | null> {
      if (cachedNextQuote !== undefined) {
        return cachedNextQuote;
      }

      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        return null;
      }

      const nextQuote = await fetchRealtimeQuote(marketDataClient, nextSymbol);
      if (!canContinue()) {
        return null;
      }

      cachedNextQuote = nextQuote;
      return cachedNextQuote;
    }

    const invalidResultAtEntry = stopIfSwitchInvalid();
    if (invalidResultAtEntry !== null) {
      return invalidResultAtEntry;
    }

    function createQuoteRetryWait(symbol: string): Extract<SwitchDriveResult, { kind: 'WAIT' }> {
      if (state.quoteRetryNextAt === null) {
        return createWaitDriveResult([{ kind: 'SYMBOL_QUOTE', symbol }]);
      }

      return createWaitDriveResult([
        { kind: 'SYMBOL_QUOTE', symbol },
        { kind: 'RETRY_TIMER', atMs: state.quoteRetryNextAt },
      ]);
    }

    function failAndClear(reason: string): SwitchDriveResult {
      const invalidResultBeforeFailure = stopIfSwitchInvalid();
      if (invalidResultBeforeFailure !== null) {
        return invalidResultBeforeFailure;
      }

      logger.error(
        `[自动换标] 状态机失败并清席位 ` +
          `monitorSymbol=${monitorSymbol} direction=${direction} oldSymbol=${state.oldSymbol} ` +
          `nextSymbol=${state.nextSymbol ?? 'null'} stage=${state.stage} reason=${reason}`,
      );

      const currentSeat = symbolRegistry.getSeatState(direction);
      const nowDate = now();
      const nowMs = nowDate.getTime();
      state.stage = 'FAILED';
      if (state.nextSymbol === null) {
        clearSeatWithSearchFailure({
          direction,
          currentSeat,
          nowDate,
          lastSwitchAt: currentSeat.lastSwitchAt,
          bumpVersion: false,
        });
      } else {
        updateSeatState(
          direction,
          {
            symbol: null,
            status: 'EMPTY',
            lastSwitchAt: currentSeat.lastSwitchAt,
            lastSearchAt: nowMs,
            lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
            callPrice: null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          false,
        );
      }

      switchStates.delete(direction);
      return {
        kind: 'FAILED',
        reason,
      };
    }

    if (state.stage === 'CANCEL_PENDING') {
      const cancelTargets = pendingOrders.filter((order) =>
        isCancelableBuyOrder(order, state.oldSymbol),
      );

      if (cancelTargets.length > 0 && !state.cancelRequestSubmitted) {
        const cancelOutcomes: CancelOrderOutcome[] = [];
        for (const cancelTarget of cancelTargets) {
          const invalidResultBeforeCancel = stopIfSwitchInvalid();
          if (invalidResultBeforeCancel !== null) {
            return invalidResultBeforeCancel;
          }

          // 同一业务票必须穿过 FIFO/重试等待到 broker 边界，不能借订单事实授权继续旧换标。
          const cancelOutcome = await orderMonitor.cancelOrder(cancelTarget.orderId, {
            kind: 'SIGNAL_AUTHORIZED',
            authorize: () => canContinue() && isCurrentSwitchStateValid(state),
          });
          const invalidResultAfterCancel = stopIfSwitchInvalid();
          if (invalidResultAfterCancel !== null) {
            return invalidResultAfterCancel;
          }

          cancelOutcomes.push(cancelOutcome);
        }

        const sawFilledOutcome = cancelOutcomes.some(isFilledCloseOutcome);
        if (sawFilledOutcome && switchPolicy.rebuy === 'ACTUAL_SELL_AMOUNT_IN_SWITCHING') {
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          state.shouldRebuy = true;
        }

        const unconfirmedOutcome = cancelOutcomes.find(
          (outcome) =>
            !isCancelAcceptedOrTerminalNonFilledClose(outcome) && !isFilledCloseOutcome(outcome),
        );
        if (unconfirmedOutcome) {
          return failAndClear(
            `CANCEL_PENDING_FAILED:${formatCancelOutcomeTag(unconfirmedOutcome)}`,
          );
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.cancelRequestSubmitted = true;
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      if (cancelTargets.length > 0) {
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      const openBuyExposure = hasOpenBuyExposure({
        orderRecorder,
        symbol: state.oldSymbol,
        direction,
        positions,
      });
      if (switchPolicy.oldSeatHandling === 'REQUIRE_EMPTY' && openBuyExposure) {
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      if (switchPolicy.rebuy === 'ACTUAL_SELL_AMOUNT_IN_SWITCHING' && openBuyExposure) {
        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.shouldRebuy = true;
      }

      if (!canContinue()) {
        return createNoopDriveResult();
      }

      state.cancelRequestSubmitted = false;
      if (!canContinue()) {
        return createNoopDriveResult();
      }

      resetQuoteRetryState(state);
      if (!canContinue()) {
        return createNoopDriveResult();
      }

      state.stage = switchPolicy.stageAfterCancellation;
    }

    if (state.stage === 'SELL_OUT') {
      state.sellWaitOrderIds = [
        ...new Set([
          ...state.sellWaitOrderIds,
          ...orderMonitor
            .getKnownSellOrderIds(state.oldSymbol)
            .filter((id) => !state.sellOrderIdsAtAdmission.includes(id)),
          ...orderMonitor.getUnsettledSellOrderIds(state.oldSymbol),
        ]),
      ];

      // 入场或异步等候期间旧操作已带余量结束：释放的数量不是新增机会，不得补卖。
      if (!state.sellSubmissionResolved && hasSettledSellRemainder(state))
        state.sellSubmissionResolved = true;

      // 快照只能决定是否需要无报价读仓，不能证明空仓或占用量；决定不发单也必须读取 broker。
      if (
        !state.sellSubmissionResolved &&
        !isValidPositiveNumber(extractPosition(positions, state.oldSymbol)?.availableQuantity)
      ) {
        const isAvailabilityCurrent = orderMonitor.captureSellAvailabilityGuard(state.oldSymbol);
        if (!isAvailabilityCurrent()) return createOrderAndFreshnessWait(state.oldSymbol);

        let currentPositions: ReadonlyArray<Position>;
        try {
          currentPositions = await readSwitchPositions(state.oldSymbol);
        } catch (error) {
          if (!isExternalApiRequestError(error)) throw error;

          if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();

          return createWaitDriveResult([
            { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
          ]);
        }

        if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();

        if (!isAvailabilityCurrent())
          return createWaitDriveResult([
            { kind: 'ORDER_EVENT', symbols: [state.oldSymbol] },
            { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
          ]);

        for (const position of currentPositions) {
          if (!Number.isSafeInteger(position.availableQuantity) || position.availableQuantity < 0)
            throw new RangeError('[自动换标] 权威可卖持仓必须为非负安全整数');
        }

        if (
          !currentPositions.some(
            (position) => position.symbol === state.oldSymbol && position.availableQuantity > 0,
          )
        )
          state.sellSubmissionResolved = true;
      }

      // 唯一一次卖出决策使用 executor 提交时的实时 available，不从 runtime 缓存推断是否发单。
      async function decideIndependentSell(): Promise<SwitchDriveResult | null> {
        /** 报价失败只结束本次新增决策；仍必须等原操作结算、真实核仓，不能释放席位归属。 */
        function finishWithoutNewSell(reason: string): SwitchDriveResult | null {
          if (state.switchMode !== 'DISTANCE') return failAndClear(reason);

          state.sellSubmissionResolved = true;
          resetQuoteRetryState(state);
          logger.warn(
            `[自动换标] 新增卖出决策结束，保留旧标等待核仓: monitor=${monitorSymbol} direction=${direction} symbol=${state.oldSymbol} reason=${reason}`,
          );
          return null;
        }
        const nowMs = now().getTime();
        if (!hasQuoteRetryElapsed(state, nowMs)) {
          return createQuoteRetryWait(state.oldSymbol);
        }

        const invalidResultBeforeSellQuote = stopIfSwitchInvalid();
        if (invalidResultBeforeSellQuote !== null) {
          return invalidResultBeforeSellQuote;
        }

        let quote: Quote | null;
        try {
          quote = await fetchRealtimeQuote(marketDataClient, state.oldSymbol);
        } catch (error) {
          if (!isExternalApiRequestError(error)) {
            throw error;
          }

          const invalidResultAfterSellQuoteFailure = stopIfSwitchInvalid();
          if (invalidResultAfterSellQuoteFailure !== null) {
            return invalidResultAfterSellQuoteFailure;
          }

          // 行情读取未产生不可逆副作用，必须交接新的 owner，避免已消费 timer 后永久挂起。
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          advanceQuoteRetryState(state, nowMs);
          if (state.quoteRetryExhausted) {
            return finishWithoutNewSell('QUOTE_RETRY_EXHAUSTED:SELL_OUT');
          }

          return createQuoteRetryWait(state.oldSymbol);
        }

        const invalidResultAfterSellQuote = stopIfSwitchInvalid();
        if (invalidResultAfterSellQuote !== null) {
          return invalidResultAfterSellQuote;
        }

        const sellQuoteReadiness = resolveQuoteReadinessForRequirement({
          quote,
          requirement: 'PRICE',
        });
        if (sellQuoteReadiness !== 'READY') {
          if (sellQuoteReadiness !== 'MISSING') {
            return finishWithoutNewSell('INVALID_QUOTE:SELL_OUT');
          }

          if (!canContinue()) {
            return createNoopDriveResult();
          }

          advanceQuoteRetryState(state, nowMs);
          if (state.quoteRetryExhausted) {
            return finishWithoutNewSell('QUOTE_RETRY_EXHAUSTED:SELL_OUT');
          }

          return createQuoteRetryWait(state.oldSymbol);
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        // 有效报价不代表提交成功；同阶段的空执行结果仍共用有限重试预算。
        const signal = buildOrderSignal({
          action: sellAction,
          symbol: state.oldSymbol,
          quote,
          reason: '自动换标-移仓卖出',
          executionOrigin: 'SWITCH_MOVE',
          orderTypeOverride: switchPolicy.orderTypeOverride,
          quantity: null,
          seatVersion,
        });

        const invalidResultBeforeSellSubmit = stopIfSwitchInvalid();
        if (invalidResultBeforeSellSubmit !== null) {
          return invalidResultBeforeSellSubmit;
        }

        const executionResult = await orderExecutor.executeSignals(
          [signal],
          () =>
            canContinue() && isCurrentSwitchStateValid(state) && !hasSettledSellRemainder(state),
        );
        const orderId = executionResult.executedOrderIds[0];
        const decision = executionResult.sellDecisionResults?.find(
          (result) => result.signal === signal,
        );
        if (orderId !== undefined) {
          if (typeof orderId !== 'string' || orderId.length === 0)
            throw new TypeError('Switch sell acknowledgement must contain a nonempty order ID');

          // ACK 归属原 issued state，即使授权变化也不得再次提交。
          state.sellSubmissionResolved = true;
          state.sellOrderId = orderId;
          state.sellWaitOrderIds = [...new Set([...state.sellWaitOrderIds, orderId])];
          if (!isCurrentSwitchStateValid(state)) return createNoopDriveResult();

          resetQuoteRetryState(state);
          return createOrderAndFreshnessWait(state.oldSymbol);
        }

        if (decision?.kind === 'REJECTED' || decision?.kind === 'NO_AVAILABLE_QUANTITY') {
          // 明确拒绝或没有可卖量都是一次性决策的结束，不是可重复提交的“空结果”。
          state.sellSubmissionResolved = true;
          resetQuoteRetryState(state);
        }

        if (!state.sellSubmissionResolved && hasSettledSellRemainder(state))
          state.sellSubmissionResolved = true;

        const invalidResultAfterSellSubmit = stopIfSwitchInvalid();
        if (invalidResultAfterSellSubmit !== null) return invalidResultAfterSellSubmit;

        if (!canContinue()) return createNoopDriveResult();

        if (!state.sellSubmissionResolved) {
          if (
            executionResult.quoteFailures.some(
              (failure) => failure.signal === signal && failure.kind === 'QUOTE_INVALID',
            )
          )
            return finishWithoutNewSell('INVALID_QUOTE:SELL_OUT_SUBMIT');

          if (decision?.kind === 'SELL_AVAILABILITY_CHANGED')
            return createWaitDriveResult([
              { kind: 'ORDER_EVENT', symbols: [state.oldSymbol] },
              { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
            ]);

          advanceQuoteRetryState(state, now().getTime());
          if (state.quoteRetryExhausted)
            return finishWithoutNewSell('QUOTE_RETRY_EXHAUSTED:SELL_OUT_SUBMIT');

          return createQuoteRetryWait(state.oldSymbol);
        }

        return null;
      }

      if (!state.sellSubmissionResolved) {
        const decisionResult = await decideIndependentSell();
        if (decisionResult !== null) return decisionResult;

        if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();
      }

      // 原有卖单、本次新单、原单已结算但 MO 尚未 ACK 的 placeholder 都归唯一订单 owner。
      if (
        orderMonitor.getUnsettledSellOrderIds(state.oldSymbol).length > 0 ||
        !state.sellWaitOrderIds.every((id) => orderMonitor.getSellOperationState(id) !== 'PENDING')
      )
        return createOrderAndFreshnessWait(state.oldSymbol);

      const isSellFactsCurrent = orderMonitor.captureSellAvailabilityGuard(state.oldSymbol);
      if (!isSellFactsCurrent()) return createOrderAndFreshnessWait(state.oldSymbol);

      let finalPositions: ReadonlyArray<Position>;
      let finalPendingOrders: ReadonlyArray<PendingOrder>;
      try {
        // waitForFresh 只证明经济结算水位，零成交撤销/拒绝不会推进水位；因此必须重新读取。
        finalPositions = await readSwitchPositions(state.oldSymbol);
        if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();

        if (!isSellFactsCurrent())
          return createWaitDriveResult([
            { kind: 'ORDER_EVENT', symbols: [state.oldSymbol] },
            { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
          ]);

        finalPendingOrders = await cacheManager.getPendingOrders([state.oldSymbol], true);
      } catch (error) {
        if (!isExternalApiRequestError(error)) throw error;

        if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();

        return createWaitDriveResult([
          { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ]);
      }

      if (!canContinue() || !isCurrentSwitchStateValid(state)) return createNoopDriveResult();

      if (
        !isSellFactsCurrent() ||
        orderMonitor.getUnsettledSellOrderIds(state.oldSymbol).length > 0 ||
        !state.sellWaitOrderIds.every(
          (id) => orderMonitor.getSellOperationState(id) !== 'PENDING',
        ) ||
        finalPendingOrders.some(
          (order) => order.symbol === state.oldSymbol && pendingOrderStatuses.has(order.status),
        )
      ) {
        return createWaitDriveResult([
          { kind: 'ORDER_EVENT', symbols: [state.oldSymbol] },
          { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ]);
      }

      let totalQuantity = 0;
      for (const position of finalPositions) {
        if (position.symbol !== state.oldSymbol) continue;

        if (!Number.isSafeInteger(position.quantity) || position.quantity < 0)
          throw new RangeError('[自动换标] 权威总持仓必须为非负安全整数');

        totalQuantity += position.quantity;
        if (!Number.isSafeInteger(totalQuantity)) throw new RangeError('[自动换标] 权威总持仓溢出');
      }

      if (totalQuantity > 0) {
        throw new Error(
          `[自动换标] 卖出操作全部结算后仍有旧标持仓，禁止补卖或绑定新标，等待人工处理: monitor=${monitorSymbol} direction=${direction} seatVersion=${seatVersion} old=${state.oldSymbol} next=${state.nextSymbol} quantity=${totalQuantity} operations=${JSON.stringify(state.sellWaitOrderIds)}`,
        );
      }

      // 预算只来自本次新操作；旧单独自清空或本次零成交都正常换标、跳过回补。
      let sellNotional = '0';
      if (state.sellOrderId !== null) {
        for (const id of orderMonitor.getSellOperationOrderIds(state.sellOrderId)) {
          sellNotional = exactAdd(
            sellNotional,
            orderRecorder.getSellRecordByOrderId(id)?.costAmount ?? '0',
          );
        }
      }

      state.shouldRebuy = exactCompare(sellNotional, '0') > 0;
      state.stage = 'BIND_NEW';
    }

    if (state.stage === 'BIND_NEW') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        return failAndClear('MISSING_NEXT_SYMBOL_ON_BIND');
      }

      const invalidResultBeforeBind = stopIfSwitchInvalid();
      if (invalidResultBeforeBind !== null) {
        return invalidResultBeforeBind;
      }

      const bindNowMs = now().getTime();
      const currentSeat = symbolRegistry.getSeatState(direction);
      updateSeatState(
        direction,
        {
          symbol: nextSymbol,
          status: 'SWITCHING',
          lastSwitchAt: bindNowMs,
          lastSearchAt: bindNowMs,
          lastSeatActivatedAt: currentSeat.lastSeatActivatedAt,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        false,
      );

      if (!canContinue()) {
        return createNoopDriveResult();
      }

      resetQuoteRetryState(state);
      if (!canContinue()) {
        return createNoopDriveResult();
      }

      state.stage =
        switchPolicy.rebuy === 'ACTUAL_SELL_AMOUNT_IN_SWITCHING' && state.shouldRebuy
          ? 'WAIT_QUOTE'
          : 'COMPLETE';

      if (state.stage === 'WAIT_QUOTE') {
        return createWaitDriveResult([{ kind: 'SYMBOL_QUOTE', symbol: nextSymbol }]);
      }
    }

    if (state.stage === 'WAIT_QUOTE') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        return failAndClear('MISSING_NEXT_SYMBOL_ON_WAIT_QUOTE');
      }

      if (!hasQuoteRetryElapsed(state, now().getTime())) {
        return createQuoteRetryWait(nextSymbol);
      }

      let quote: Quote | null;
      try {
        quote = await getNextQuote();
      } catch (error) {
        if (!isExternalApiRequestError(error)) {
          throw error;
        }

        const invalidResultAfterWaitQuoteFailure = stopIfSwitchInvalid();
        if (invalidResultAfterWaitQuoteFailure !== null) {
          return invalidResultAfterWaitQuoteFailure;
        }

        advanceQuoteRetryState(state, now().getTime());
        if (state.quoteRetryExhausted) {
          return failAndClear('QUOTE_RETRY_EXHAUSTED:WAIT_QUOTE');
        }

        return createQuoteRetryWait(nextSymbol);
      }

      const invalidResultAfterWaitQuoteFetch = stopIfSwitchInvalid();
      if (invalidResultAfterWaitQuoteFetch !== null) {
        return invalidResultAfterWaitQuoteFetch;
      }

      const waitQuoteReadiness = resolveRebuyQuoteReadiness(quote);
      if (waitQuoteReadiness !== 'READY') {
        if (waitQuoteReadiness !== 'MISSING') {
          return failAndClear('INVALID_QUOTE:WAIT_QUOTE');
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        advanceQuoteRetryState(state, now().getTime());
        if (state.quoteRetryExhausted) {
          return failAndClear('QUOTE_RETRY_EXHAUSTED:WAIT_QUOTE');
        }

        return createQuoteRetryWait(nextSymbol);
      }

      if (!canContinue()) {
        return createNoopDriveResult();
      }

      state.stage = 'REBUY';
    }

    // 已确认回补只按新的原route授权完成本地收尾，不再取价、重算预算或提交第二次BUY。
    if (state.stage === 'REBUY' && rebuyOrderIds.has(state)) {
      const invalidResultBeforeRebuyCompletion = stopIfSwitchInvalid();
      if (invalidResultBeforeRebuyCompletion !== null) return invalidResultBeforeRebuyCompletion;

      state.stage = 'COMPLETE';
    }

    if (state.stage === 'REBUY') {
      const nextSymbol = state.nextSymbol;
      if (!nextSymbol) {
        return failAndClear('MISSING_NEXT_SYMBOL_ON_REBUY');
      }

      const nowMs = now().getTime();
      const quote = await getNextQuote();
      const invalidResultAfterRebuyQuoteFetch = stopIfSwitchInvalid();
      if (invalidResultAfterRebuyQuoteFetch !== null) {
        return invalidResultAfterRebuyQuoteFetch;
      }

      const rebuyQuoteReadiness = resolveRebuyQuoteReadiness(quote);
      if (rebuyQuoteReadiness !== 'READY') {
        if (rebuyQuoteReadiness !== 'MISSING') {
          return failAndClear('INVALID_QUOTE:REBUY');
        }

        if (!hasQuoteRetryElapsed(state, nowMs)) {
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          state.stage = 'WAIT_QUOTE';
          return createQuoteRetryWait(nextSymbol);
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        advanceQuoteRetryState(state, nowMs);
        if (state.quoteRetryExhausted) {
          return failAndClear('QUOTE_RETRY_EXHAUSTED:REBUY');
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.stage = 'WAIT_QUOTE';
        return createQuoteRetryWait(nextSymbol);
      }

      if (!isRebuyQuoteReady(quote)) {
        return failAndClear('INVALID_QUOTE:REBUY');
      }

      if (!canContinue()) {
        return createNoopDriveResult();
      }

      // 在本次新标报价 await 后取样：关闭订单仍可合法修订金额，等待/重试不能消费旧预算。
      // 只按本次原卖单与已 accepted MO 后继读取当前权威累计记录；零成交成员贡献零，不估算或按标的汇总。
      let buyNotional = '0';
      if (state.sellOrderId !== null) {
        for (const orderId of orderMonitor.getSellOperationOrderIds(state.sellOrderId)) {
          buyNotional = exactAdd(
            buyNotional,
            orderRecorder.getSellRecordByOrderId(orderId)?.costAmount ?? '0',
          );
        }
      }

      if (exactCompare(buyNotional, '0') <= 0) {
        return failAndClear('MISSING_REBUY_NOTIONAL');
      }

      const buyQuantity = calculateBuyQuantityByNotional(buyNotional, quote.price, quote.lotSize);
      if (buyQuantity !== null && (!Number.isSafeInteger(buyQuantity) || buyQuantity < 0))
        throw new RangeError('Switch buy quantity must be a nonnegative safe integer');

      if (buyQuantity !== null && buyQuantity > 0) {
        const signal = buildOrderSignal({
          action: buyAction,
          symbol: nextSymbol,
          quote,
          reason: '自动换标-移仓买入',
          executionOrigin: 'SWITCH_REBUY',
          orderTypeOverride: switchPolicy.orderTypeOverride,
          quantity: buyQuantity,
          seatVersion,
        });

        const invalidResultBeforeRebuySubmit = stopIfSwitchInvalid();
        if (invalidResultBeforeRebuySubmit !== null) {
          return invalidResultBeforeRebuySubmit;
        }

        const executionResult = await executeSwitchSignal(
          signal,
          `[自动换标] 回补买入未提交成功，等待重试: monitorSymbol=${monitorSymbol} direction=${direction} symbol=${nextSymbol}`,
          () => canContinue() && isCurrentSwitchStateValid(state),
        );
        if (executionResult !== null) {
          const orderIds = executionResult.executedOrderIds;
          if (!orderIds.every((orderId) => typeof orderId === 'string' && orderId.length > 0))
            throw new TypeError('Switch rebuy acknowledgement must contain nonempty order IDs');

          rebuyOrderIds.set(state, [...orderIds]);
          if (!isCurrentSwitchStateValid(state)) return createNoopDriveResult();

          resetQuoteRetryState(state);
          // ack独立于旧票；暂停只交原订单/就绪事件，不发布ACTIVATING或否认已发BUY。
          if (!canContinue()) return createOrderAndFreshnessWait(nextSymbol);
        }

        const invalidResultAfterRebuySubmit = stopIfSwitchInvalid();
        if (invalidResultAfterRebuySubmit !== null) return invalidResultAfterRebuySubmit;

        if (executionResult === null) {
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          advanceQuoteRetryState(state, now().getTime());
          if (state.quoteRetryExhausted) {
            return failAndClear('QUOTE_RETRY_EXHAUSTED:REBUY_SUBMIT');
          }

          if (!canContinue()) {
            return createNoopDriveResult();
          }

          state.stage = 'WAIT_QUOTE';
          return createQuoteRetryWait(nextSymbol);
        }
      } else {
        logger.info(
          `[自动换标] 回补买入数量无效或过小，跳过回补: ${nextSymbol}, buyQuantity=${String(buyQuantity)}`,
        );
      }

      const invalidResultBeforeRebuyCompletion = stopIfSwitchInvalid();
      if (invalidResultBeforeRebuyCompletion !== null) return invalidResultBeforeRebuyCompletion;

      state.stage = 'COMPLETE';
    }

    if (state.stage === 'COMPLETE') {
      const nextSymbol = state.nextSymbol;
      if (nextSymbol) {
        const completeNowMs = now().getTime();
        updateSeatState(
          direction,
          {
            symbol: nextSymbol,
            status: 'ACTIVATING',
            lastSwitchAt: completeNowMs,
            lastSearchAt: completeNowMs,
            lastSeatActivatedAt: null,
            callPrice: state.nextCallPrice ?? null,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          },
          false,
        );
      }

      // COMPLETE 仅由前置同步 gate 与席位身份检查授权；此后 public pending 查询会按职责清理终态，
      // 因而不得再次经 canContinue 重新授权本次收尾。
      switchStates.delete(direction);
      return { kind: 'COMPLETED' };
    }

    return createNoopDriveResult();
  }

  /**
   * 在周期换标 due 事件到达时检查是否满足触发条件。
   * 到期后若当前席位标的仍被本地订单链路占用，则进入 pending 等待；仅当本地未平仓买单记录与本地 pending order 都清空后才触发周期换标。
   */
  async function evaluatePeriodicSwitchDue({
    direction,
    currentTime,
    canContinue,
  }: PeriodicSwitchDueParams): Promise<SwitchDriveResult> {
    if (!canContinue()) {
      return createNoopDriveResult();
    }

    if (!autoSearchConfig.autoSearchEnabled || autoSearchConfig.switchIntervalMinutes <= 0) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    if (hasPendingSwitch(direction)) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    const seatState = symbolRegistry.getSeatState(direction);
    if (!isSeatActive(seatState)) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    const periodicPendingState = resolvePeriodicPending(direction);
    if (
      periodicPendingState.pending &&
      shouldResetPeriodicPendingBySeatActivatedAt({
        pendingSinceMs: periodicPendingState.pendingSinceMs,
        lastSeatActivatedAt: seatState.lastSeatActivatedAt,
      }) &&
      !clearPeriodicPending(direction, canContinue)
    ) {
      return createNoopDriveResult();
    }

    const pendingStateAfterReset = resolvePeriodicPending(direction);
    if (pendingStateAfterReset.pending) {
      if (!canContinue()) {
        return createNoopDriveResult();
      }

      const blockSource = resolvePeriodicSeatBlockSource({
        orderRecorder,
        orderHoldRegistry,
        symbol: seatState.symbol,
        direction,
      });
      if (blockSource !== 'EMPTY') {
        if (pendingStateAfterReset.blockedBy !== blockSource) {
          logger.warn(
            `[自动换标] ${monitorSymbol} ${direction} 周期换标继续等待，blockedBy=${blockSource}`,
          );
        }

        if (
          !markPeriodicPending(
            direction,
            pendingStateAfterReset.pendingSinceMs ?? currentTime.getTime(),
            blockSource,
            canContinue,
          )
        ) {
          return createNoopDriveResult();
        }

        return createNoopDriveResult();
      }

      logger.info(
        `[自动换标] ${monitorSymbol} ${direction} 周期换标等待结束，检测到本地空仓开始换标`,
      );

      if (!clearPeriodicPending(direction, canContinue)) {
        return createNoopDriveResult();
      }

      const driveResult = await startSwitchFlow({
        direction,
        reason: '周期换标触发',
        triggerKind: 'PERIODIC',
        canContinue,
      });
      // 已创建WAIT交原wakeup owner，不因旧ACTIVE closure/receipt失效丢注册需求。
      if (driveResult.kind === 'WAIT') return driveResult;

      return canContinue() ? driveResult : createNoopDriveResult();
    }

    if (!canContinue()) {
      return createNoopDriveResult();
    }

    if (seatState.lastSeatActivatedAt === null) {
      clearPeriodicPending(direction, canContinue);
      return createNoopDriveResult();
    }

    const elapsedTradingMs = calculateTradingDurationMsBetween({
      startMs: seatState.lastSeatActivatedAt,
      endMs: currentTime.getTime(),
      calendarSnapshot: getTradingCalendarSnapshot(),
    });
    const intervalMs = autoSearchConfig.switchIntervalMinutes * 60_000;
    if (elapsedTradingMs < intervalMs) {
      return createNoopDriveResult();
    }

    const blockSource = resolvePeriodicSeatBlockSource({
      orderRecorder,
      orderHoldRegistry,
      symbol: seatState.symbol,
      direction,
    });
    if (blockSource !== 'EMPTY') {
      const pendingState = resolvePeriodicPending(direction);
      if (!pendingState.pending || pendingState.blockedBy !== blockSource) {
        if (!markPeriodicPending(direction, currentTime.getTime(), blockSource, canContinue)) {
          return createNoopDriveResult();
        }

        logger.warn(
          `[自动换标] ${monitorSymbol} ${direction} 周期换标到期但本地仍被占用，进入等待空仓状态 blockedBy=${blockSource}`,
        );
      }

      return createNoopDriveResult();
    }

    const pendingState = resolvePeriodicPending(direction);
    if (pendingState.pending) {
      logger.info(
        `[自动换标] ${monitorSymbol} ${direction} 周期换标等待结束，检测到本地空仓开始换标`,
      );
    }

    if (!clearPeriodicPending(direction, canContinue)) {
      return createNoopDriveResult();
    }

    const driveResult = await startSwitchFlow({
      direction,
      reason: '周期换标触发',
      triggerKind: 'PERIODIC',
      canContinue,
    });
    // 已创建WAIT交原wakeup owner，不因旧ACTIVE closure/receipt失效丢注册需求。
    if (driveResult.kind === 'WAIT') return driveResult;

    return canContinue() ? driveResult : createNoopDriveResult();
  }

  /**
   * 启动一次距离换标检查。
   *
   * 仅负责新建距离换标状态；若已存在 pending switch，本轮不会重复启动。
   */
  async function startSwitchOnDistance({
    direction,
    monitorPrice,
    positions,
    canContinue,
  }: StartSwitchOnDistanceParams): Promise<StartSwitchOnDistanceResult> {
    if (!canContinue()) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    if (!autoSearchConfig.autoSearchEnabled) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    if (hasPendingSwitch(direction)) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    if (monitorPrice === null) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    const seatState = symbolRegistry.getSeatState(direction);
    if (!isSeatActive(seatState)) {
      clearPeriodicPending(direction, canContinue);
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    const distanceInfo = riskChecker.getWarrantDistanceInfo(
      direction === 'LONG',
      seatState.symbol,
      monitorPrice,
    );
    const range = candidateSearch.resolveDistanceRange(direction);
    if (
      distanceInfo === null ||
      range === null ||
      (distanceInfo.distanceNumerator === null && distanceInfo.distanceDenominator === null)
    ) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    const { distanceNumerator, distanceDenominator } = distanceInfo;
    if (distanceNumerator === null || distanceDenominator === null)
      throw new TypeError('Warrant distance basis must be jointly known or unknown');

    const distanceTriggerSide = resolveDistanceTriggerSide({
      direction,
      distanceNumerator,
      distanceDenominator,
      range,
    });
    if (distanceTriggerSide === null) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    const driveResult = await startSwitchFlow({
      reason: '距回收价阈值越界',
      triggerKind: distanceTriggerSide === 'SAFE' ? 'DISTANCE_SAFE_SIDE' : 'DISTANCE_DANGER_SIDE',
      distanceContext: { direction, monitorPrice, positions, canContinue },
      canContinue,
    });

    // WAIT证明实际状态提交已完成；旧ACTIVE closure只取消未提交工作，不撤销已生成route。
    if (driveResult.kind === 'NOOP') {
      return {
        started: false,
        direction,
        driveResult,
      };
    }

    if (driveResult.kind !== 'WAIT') {
      throw new Error('[自动换标] distance switch 启动后必须返回 WAIT owner');
    }

    return {
      started: true,
      direction,
      driveResult,
    };
  }

  /**
   * 推进已存在的 pending switch。
   */
  async function advancePendingSwitch({
    direction,
    positions,
    canContinue,
  }: AdvancePendingSwitchParams): Promise<AdvancePendingSwitchResult> {
    if (!canContinue()) {
      return createNoopAdvanceResult(direction);
    }

    if (!autoSearchConfig.autoSearchEnabled || !hasPendingSwitch(direction)) {
      return createNoopAdvanceResult(direction);
    }

    const pendingSwitch = switchStates.get(direction);
    if (!pendingSwitch) {
      return createNoopAdvanceResult(direction);
    }

    if (
      pendingSwitch.switchMode === 'DISTANCE' &&
      (pendingSwitch.stage === 'CANCEL_PENDING' || pendingSwitch.stage === 'SELL_OUT')
    ) {
      pendingSwitch.sellWaitOrderIds = [
        ...new Set([
          ...pendingSwitch.sellWaitOrderIds,
          ...orderMonitor
            .getKnownSellOrderIds(pendingSwitch.oldSymbol)
            .filter((id) => !pendingSwitch.sellOrderIdsAtAdmission.includes(id)),
          ...orderMonitor.getUnsettledSellOrderIds(pendingSwitch.oldSymbol),
        ]),
      ];
    }

    // 已提交/明确结束的新增决策只等 owner，不在 handoff 的 mutation permit 后再排一次无关读单。
    if (
      pendingSwitch.stage === 'SELL_OUT' &&
      pendingSwitch.sellSubmissionResolved &&
      (orderMonitor.getUnsettledSellOrderIds(pendingSwitch.oldSymbol).length > 0 ||
        pendingSwitch.sellWaitOrderIds.some(
          (id) => orderMonitor.getSellOperationState(id) === 'PENDING',
        ))
    ) {
      return {
        advanced: true,
        direction,
        stillPending: true,
        driveResult: createOrderAndFreshnessWait(pendingSwitch.oldSymbol),
      };
    }

    let pendingOrdersForOldSymbol: ReadonlyArray<PendingOrder>;
    try {
      pendingOrdersForOldSymbol = await cacheManager.getPendingOrders([pendingSwitch.oldSymbol]);
    } catch (error) {
      // 内部事实/配置/状态损坏与授权取消独立；只有明确外部读取失败才走原重试owner。
      if (!isExternalApiRequestError(error)) throw error;

      if (!canContinue() || !isCurrentSwitchStateValid(pendingSwitch))
        return createNoopAdvanceResult(direction);

      return {
        advanced: true,
        direction,
        stillPending: true,
        driveResult: createWaitDriveResult([
          { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ]),
      };
    }

    if (!canContinue() || !isCurrentSwitchStateValid(pendingSwitch)) {
      return createNoopAdvanceResult(direction);
    }

    const driveResult = await processSwitchState(
      { direction, positions, canContinue },
      pendingSwitch,
      pendingOrdersForOldSymbol,
    );
    if (driveResult.kind === 'COMPLETED' || driveResult.kind === 'FAILED') {
      return {
        advanced: true,
        direction,
        stillPending: false,
        driveResult,
      };
    }

    // SELL真实ack只交接原route的订单/就绪唤醒；后续mutation仍需下一次原epoch/receipt授权。
    if (
      driveResult.kind === 'WAIT' &&
      pendingSwitch.stage === 'SELL_OUT' &&
      pendingSwitch.sellSubmissionResolved &&
      pendingSwitch.sellOrderId !== null
    ) {
      if (!isCurrentSwitchStateValid(pendingSwitch)) return createNoopAdvanceResult(direction);

      return { advanced: true, direction, stillPending: true, driveResult };
    }

    if (
      driveResult.kind === 'WAIT' &&
      pendingSwitch.stage === 'REBUY' &&
      rebuyOrderIds.has(pendingSwitch)
    ) {
      if (!isCurrentSwitchStateValid(pendingSwitch)) return createNoopAdvanceResult(direction);

      return { advanced: true, direction, stillPending: true, driveResult };
    }

    // 原issued流程被新map route替代时，不能借新pending事实判定旧结果或索要旧WAIT。
    if (!canContinue() || !isCurrentSwitchStateValid(pendingSwitch)) {
      return createNoopAdvanceResult(direction);
    }

    if (hasPendingSwitch(direction)) {
      if (driveResult.kind !== 'WAIT') {
        throw new Error('[自动换标] pending switch 推进后必须返回 WAIT owner');
      }

      return {
        advanced: true,
        direction,
        stillPending: true,
        driveResult,
      };
    }

    if (driveResult.kind === 'WAIT') {
      throw new Error('[自动换标] 已完成 switch 不得返回 WAIT owner');
    }

    return {
      advanced: true,
      direction,
      stillPending: false,
      driveResult,
    };
  }

  return {
    evaluatePeriodicSwitchDue,
    startSwitchOnDistance,
    advancePendingSwitch,
    hasPendingSwitch,
  };
}
