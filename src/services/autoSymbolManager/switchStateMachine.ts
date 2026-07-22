/**
 * 自动换标模块：换标状态机
 *
 * 功能：管理从撤单到回补买入的完整换标流程。
 * 职责：统一处理距离换标与周期换标的启动入口，推进换标状态机（撤单/卖出/绑定/等待行情/回补/完成），处理周期换标到期后的空仓等待与触发。
 * 执行流程：startSwitchOnDistance/advancePendingSwitch/evaluatePeriodicSwitchDue 触发 → startSwitchFlow 预寻标与入口判定；周期换标在无候选时直接业务收口，其余需要换标的路径写入 switchStates 并由 processSwitchState 推进到完成或失败。
 */
import { ORDER_QUOTE_RETRY } from '../../constants/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DecimalInput } from '../../utils/numeric/types.js';
import {
  resolveNextQuoteRetry,
  resolveQuoteReadinessForRequirement,
} from '../../utils/quoteRetry/index.js';
import type { QuoteReadinessStatus } from '../../utils/quoteRetry/types.js';
import { decimalGte, decimalLte } from '../../utils/numeric/index.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { PendingOrder } from '../../types/services.js';
import type { CancelOrderOutcome } from '../../types/trader.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import {
  formatCancelOutcomeTag,
  isCancelAcceptedOrTerminalNonFilledClose,
} from '../../utils/trading/orderStatus.js';
import type {
  AdvancePendingSwitchParams,
  PeriodicSeatBlockSource,
  StartSwitchFlowParams,
  StartSwitchOnDistanceParams,
  SwitchProcessParams,
  PeriodicSwitchDueParams,
  PeriodicSwitchInternalPendingState,
  SwitchState,
  SwitchStateMachine,
  SwitchStateMachineDeps,
} from './types.js';
import type {
  AdvancePendingSwitchResult,
  PeriodicSeatBlockingReason,
  StartSwitchOnDistanceResult,
  SwitchDriveResult,
  SwitchWakeupRequirement,
} from '../../types/monitorContextPorts.js';
import { resolveNextSearchFailureState } from './utils.js';
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

/**
 * 判断周期 pending 是否应因席位重新进入 ACTIVE 而失效。
 * 仅当 lastSeatActivatedAt 晚于 pendingSinceMs 时失效，表示周期基线已重置。
 */
function shouldResetPeriodicPendingBySeatActivatedAt(params: {
  readonly pendingSinceMs: number | null;
  readonly lastSeatActivatedAt: number | null;
}): boolean {
  if (params.pendingSinceMs === null || params.lastSeatActivatedAt === null) {
    return false;
  }

  return params.lastSeatActivatedAt > params.pendingSinceMs;
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
  readonly trader: SwitchStateMachineDeps['trader'];
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly brokerPendingOrders?: ReadonlyArray<PendingOrder>;
}): PeriodicSeatBlockSource {
  const { orderRecorder, trader, symbol, direction, brokerPendingOrders } = params;
  if (brokerPendingOrders?.some((order) => order.symbol === symbol)) {
    return 'BROKER_PENDING_ORDER';
  }

  const buyOrders = orderRecorder.getBuyOrdersForSymbol(symbol, direction === 'LONG');
  if (buyOrders.length > 0) {
    return 'ORDER_RECORDER';
  }

  if (trader.getOrderHoldSymbols().has(symbol)) {
    return 'LOCAL_PENDING_ORDER';
  }

  return 'EMPTY';
}

function resolveDistanceTriggerSide(params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly distancePercent: DecimalInput;
  readonly range: { readonly min: DecimalInput; readonly max: DecimalInput };
}): 'SAFE' | 'DANGER' | null {
  const { direction, distancePercent, range } = params;
  if (direction === 'LONG') {
    if (decimalLte(distancePercent, range.min)) {
      return 'DANGER';
    }

    if (decimalGte(distancePercent, range.max)) {
      return 'SAFE';
    }

    return null;
  }

  if (decimalGte(distancePercent, range.max)) {
    return 'DANGER';
  }

  if (decimalLte(distancePercent, range.min)) {
    return 'SAFE';
  }

  return null;
}

/**
 * 创建换标状态机，管理从撤单到回补买入的完整换标流程，并提供周期换标触发能力。
 * @param deps - 依赖（trader、orderRecorder、riskChecker、switchStates、buildOrderSignal 等）
 * @returns SwitchStateMachine 实例（evaluatePeriodicSwitchDue、startSwitchOnDistance、advancePendingSwitch、hasPendingSwitch）
 */
export function createSwitchStateMachine(deps: SwitchStateMachineDeps): SwitchStateMachine {
  const {
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    trader,
    orderRecorder,
    riskChecker,
    marketDataClient,
    now,
    switchStates,
    periodicSwitchPending,
    resolveSuppression,
    markSuppression,
    enterSwitchingSeat,
    updateSeatState,
    resolveDirectionalAutoSearchPolicy,
    buildFindBestWarrantInput,
    findBestWarrant,
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
  ): Promise<Awaited<ReturnType<SwitchStateMachineDeps['trader']['executeSignals']>> | null> {
    if (!canContinue()) {
      return null;
    }

    const executionResult = await trader.executeSignals([signal]);

    if (!canContinue()) {
      return null;
    }

    if (executionResult.executedOrderIds.length === 0) {
      logger.warn(submitFailedMessage);
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

    if (!clearPeriodicPending(direction, canContinue)) {
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
  ): Promise<{ symbol: string; callPrice: number } | null> {
    if (!canContinue()) {
      return null;
    }

    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动换标] 缺少阈值配置，无法预寻标',
    });
    if (policy === null) {
      return null;
    }

    const input = await buildFindBestWarrantInput({
      currentTime: now(),
      policy,
    });
    if (!canContinue()) {
      return null;
    }

    const best = await findBestWarrant(input);
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

    const seatVersionAtStart = symbolRegistry.getSeatVersion(direction);
    const seatSymbol = seatState.symbol;
    if (
      suppressionTriggerKind !== null &&
      resolveSuppression(direction, seatSymbol, suppressionTriggerKind)
    ) {
      return createNoopDriveResult();
    }

    const next = await findSwitchCandidate(direction, canContinue);
    if (!canContinue()) {
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

    const brokerPendingOrders = await trader.getPendingOrders([latestSeatState.symbol]);
    if (!canContinue()) {
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

    if (switchMode === 'PERIODIC') {
      const periodicBlockSource = resolvePeriodicSeatBlockSource({
        orderRecorder,
        trader,
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

    if (switchMode === 'PERIODIC' && next === null) {
      if (!clearSeatOnPeriodicNoCandidate(direction, canContinue)) {
        return createNoopDriveResult();
      }

      return createNoopDriveResult();
    }

    if (!clearPeriodicPending(direction, canContinue)) {
      return createNoopDriveResult();
    }

    if (!canContinue()) {
      return createNoopDriveResult();
    }

    const seatVersion = enterSwitchingSeat({ direction, reason });

    let shouldRebuy = false;
    if (distanceContext !== null) {
      const position = extractPosition(distanceContext.positions, latestSeatState.symbol);
      shouldRebuy = (position?.quantity ?? 0) > 0;
    }

    if (!canContinue()) {
      return createNoopDriveResult();
    }

    switchStates.set(direction, {
      direction,
      switchMode,
      seatVersion,
      stage: 'CANCEL_PENDING',
      oldSymbol: admittedSeatState.symbol,
      nextSymbol: next?.symbol ?? null,
      nextCallPrice: next?.callPrice ?? null,
      sellSubmitted: false,
      sellOrderId: null,
      sellNotional: null,
      shouldRebuy,
      quoteRetryAttempts: 0,
      quoteRetryNextAt: null,
      quoteRetryExhausted: false,
      cancelRequestSubmitted: false,
    });

    return createWaitDriveResult([{ kind: 'RETRY_TIMER', atMs: now().getTime() }]);
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
    const { sellAction, buyAction } = resolveDirectionSymbols(direction);
    const seatVersion = symbolRegistry.getSeatVersion(direction);
    let cachedNextQuote: Quote | null | undefined;

    function stopIfSwitchInvalid(): SwitchDriveResult | null {
      if (!canContinue()) {
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

          const cancelOutcome = await trader.cancelOrder(cancelTarget.orderId);
          const invalidResultAfterCancel = stopIfSwitchInvalid();
          if (invalidResultAfterCancel !== null) {
            return invalidResultAfterCancel;
          }

          cancelOutcomes.push(cancelOutcome);
        }

        const sawFilledOutcome = cancelOutcomes.some(isFilledCloseOutcome);
        if (sawFilledOutcome && state.switchMode === 'DISTANCE') {
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
      if (state.switchMode === 'PERIODIC' && openBuyExposure) {
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      if (state.switchMode === 'DISTANCE' && openBuyExposure) {
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

      state.stage = state.switchMode === 'PERIODIC' ? 'BIND_NEW' : 'SELL_OUT';
    }

    if (state.stage === 'SELL_OUT') {
      const position = extractPosition(positions, state.oldSymbol);
      const totalQuantity = position?.quantity ?? 0;
      const availableQuantity = position?.availableQuantity ?? 0;

      if (isValidPositiveNumber(totalQuantity) && availableQuantity === 0) {
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      if (isValidPositiveNumber(availableQuantity)) {
        if (state.sellSubmitted) {
          return createOrderAndFreshnessWait(state.oldSymbol);
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
            return failAndClear('QUOTE_RETRY_EXHAUSTED:SELL_OUT');
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
            return failAndClear('INVALID_QUOTE:SELL_OUT');
          }

          if (!canContinue()) {
            return createNoopDriveResult();
          }

          advanceQuoteRetryState(state, nowMs);
          if (state.quoteRetryExhausted) {
            return failAndClear('QUOTE_RETRY_EXHAUSTED:SELL_OUT');
          }

          return createQuoteRetryWait(state.oldSymbol);
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        resetQuoteRetryState(state);

        const signal = buildOrderSignal({
          action: sellAction,
          symbol: state.oldSymbol,
          quote,
          reason: '自动换标-移仓卖出',
          orderTypeOverride: 'ELO',
          quantity: availableQuantity,
          seatVersion,
        });

        const invalidResultBeforeSellSubmit = stopIfSwitchInvalid();
        if (invalidResultBeforeSellSubmit !== null) {
          return invalidResultBeforeSellSubmit;
        }

        const executionResult = await executeSwitchSignal(
          signal,
          `[自动换标] 移仓卖出未提交成功，等待重试: monitorSymbol=${monitorSymbol} direction=${direction} symbol=${state.oldSymbol}`,
          canContinue,
        );
        const invalidResultAfterSellSubmit = stopIfSwitchInvalid();
        if (invalidResultAfterSellSubmit !== null) {
          return invalidResultAfterSellSubmit;
        }

        if (executionResult === null) {
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          advanceQuoteRetryState(state, now().getTime());
          if (state.quoteRetryExhausted) {
            return failAndClear('QUOTE_RETRY_EXHAUSTED:SELL_OUT_SUBMIT');
          }

          return createQuoteRetryWait(state.oldSymbol);
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.sellSubmitted = true;
        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.sellOrderId = executionResult.executedOrderIds[0] ?? null;
        return createOrderAndFreshnessWait(state.oldSymbol);
      }

      if (state.shouldRebuy && !state.sellSubmitted && !isValidPositiveNumber(totalQuantity)) {
        const openBuyExposure = hasOpenBuyExposure({
          orderRecorder,
          symbol: state.oldSymbol,
          direction,
          positions,
        });
        if (openBuyExposure) {
          return createOrderAndFreshnessWait(state.oldSymbol);
        }

        if (!canContinue()) {
          return createNoopDriveResult();
        }

        state.shouldRebuy = false;
      }

      if (state.sellOrderId !== null) {
        const sellRecord = orderRecorder.getSellRecordByOrderId(state.sellOrderId);
        const actualNotional = sellRecord
          ? sellRecord.executedPrice * sellRecord.executedQuantity
          : Number.NaN;
        if (isValidPositiveNumber(actualNotional)) {
          if (!canContinue()) {
            return createNoopDriveResult();
          }

          state.sellNotional = actualNotional;
        }
      }

      if (!canContinue()) {
        return createNoopDriveResult();
      }

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

      state.stage = state.shouldRebuy ? 'WAIT_QUOTE' : 'COMPLETE';
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

      resetQuoteRetryState(state);

      const buyNotional = state.sellNotional;
      if (!isValidPositiveNumber(buyNotional)) {
        return failAndClear('MISSING_REBUY_NOTIONAL');
      }

      const buyQuantity = calculateBuyQuantityByNotional(buyNotional, quote.price, quote.lotSize);

      if (buyQuantity !== null && isValidPositiveNumber(buyQuantity)) {
        const signal = buildOrderSignal({
          action: buyAction,
          symbol: nextSymbol,
          quote,
          reason: '自动换标-移仓买入',
          orderTypeOverride: 'ELO',
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
          canContinue,
        );
        const invalidResultAfterRebuySubmit = stopIfSwitchInvalid();
        if (invalidResultAfterRebuySubmit !== null) {
          return invalidResultAfterRebuySubmit;
        }

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

      if (!canContinue()) {
        return createNoopDriveResult();
      }

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
        trader,
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
      trader,
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
    const distancePercent = distanceInfo?.distanceToStrikePercent ?? null;
    const policy = resolveDirectionalAutoSearchPolicy({
      direction,
      logPrefix: '[自动换标] 缺少阈值配置，无法检查换标区间',
    });
    if (distancePercent === null || policy === null) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

    const range = policy.switchDistanceRange;
    const distanceTriggerSide = resolveDistanceTriggerSide({
      direction,
      distancePercent,
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

    if (!canContinue()) {
      return {
        started: false,
        direction,
        driveResult: createNoopDriveResult(),
      };
    }

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

    let pendingOrdersForOldSymbol: ReadonlyArray<PendingOrder>;
    try {
      pendingOrdersForOldSymbol = await trader.getPendingOrders([pendingSwitch.oldSymbol]);
    } catch (error) {
      if (!canContinue()) {
        return createNoopAdvanceResult(direction);
      }

      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      return {
        advanced: true,
        direction,
        stillPending: true,
        driveResult: createWaitDriveResult([
          { kind: 'RETRY_TIMER', atMs: now().getTime() + ORDER_QUOTE_RETRY.INTERVAL_MS },
        ]),
      };
    }

    if (!canContinue()) {
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

    if (!canContinue()) {
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
