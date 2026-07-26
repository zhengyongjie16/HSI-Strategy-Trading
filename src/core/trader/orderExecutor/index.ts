/**
 * 订单执行模块
 *
 * 职责：
 * - 执行交易信号（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * - 管理同方向买入频率限制（防止重复开仓）
 * - 协调订单提交流程与追踪登记
 */
import { logger } from '../../../utils/logger/index.js';
import { OrderSide } from 'longbridge';
import { LOG_COLORS } from '../../../constants/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import { isSeatVersionMatch } from '../../../utils/seat/guards.js';
import { getHKDateKey, isInContinuousHKSession } from '../../../utils/time/index.js';
import {
  hasReachedDoomsdayBuyCutoff,
  isWithinDoomsdayClearanceTakeoverWindow,
} from '../../doomsdayProtection/utils.js';
import type {
  DoomsdayClearanceCommand,
  ExecutableSignal,
  SellSignal,
  Signal,
} from '../../../types/signal.js';
import type {
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
} from '../../../types/trader.js';
import type { OrderActionAuthorization, OrderExecutor, OrderExecutorDeps } from '../types.js';
import type { ExecutableOrderCommand } from './types.js';
import { createSubmitTargetOrder } from './submitFlow.js';
import { createBuyThrottle } from './buyThrottle.js';
import { getActionDescription, isLiquidationSignal, isStaleCrossDaySignal } from './utils.js';

/**
 * 校验信号携带的席位版本是否与执行时席位版本一致。
 * 信号必须携带有限 seatVersion，缺失或版本不匹配均拒绝执行。
 *
 * @param signal 待执行信号
 * @param boundSeatVersion 信号绑定时的席位版本号
 * @param currentSeatVersion 当前席位版本号
 * @returns true 表示通过校验，false 表示应跳过
 */
function validateSignalSeatVersionAtExecution(
  signal: ExecutableSignal,
  boundSeatVersion: number,
  currentSeatVersion: number,
): boolean {
  if (!Number.isFinite(boundSeatVersion)) {
    logger.debug(
      `[执行门禁] 信号缺少有效席位版本，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
    );
    return false;
  }

  if (!isSeatVersionMatch(boundSeatVersion, currentSeatVersion)) {
    logger.debug(
      `[执行门禁] 席位版本不匹配，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
    );
    return false;
  }

  return true;
}

/**
 * 将末日清仓命令转换为仅供执行器内部使用的卖出信号。
 * 此处固定末日原因文本，避免自由文本决定执行目的；数量与关联买单由末日提交流程独立决定。
 *
 * @param command 末日保护链路构造的末日清仓命令
 * @returns 绑定末日清仓固定语义的内部卖出信号
 */
function createDoomsdayClearanceSellSignal(command: DoomsdayClearanceCommand): SellSignal {
  const positionLabel = command.action === 'SELLPUT' ? '做空标的' : '做多标的';
  return {
    symbol: command.symbol,
    symbolName: command.symbolName,
    action: command.action,
    reason: `末日保护程序：清仓接管窗口自动清仓（${positionLabel}持仓）`,
    triggerTime: command.triggerTime,
    seatVersion: command.seatVersion,
  };
}

/**
 * 校验保护性清仓语义只归属于 SELL。
 * 类型系统覆盖正常调用方；该校验覆盖强制断言、JavaScript 调用或受损内部载荷，
 * 必须在限流、行情、提交、追踪和本地账本副作用前运行。
 *
 * @param signal 待解析的交易信号
 * @returns 无返回值；非法保护性 BUY 直接抛出内部契约错误
 */
function assertProtectiveLiquidationSellContract(signal: Signal): void {
  if (signal.isProtectiveLiquidation !== true) {
    return;
  }

  const runtimeAction: unknown = signal.action;
  if (runtimeAction === 'SELLCALL' || runtimeAction === 'SELLPUT') {
    return;
  }

  throw new Error(
    `[订单执行] 保护性清仓只能使用 SELLCALL 或 SELLPUT: action=${String(runtimeAction)} symbol=${signal.symbol}`,
  );
}

/**
 * 校验末日清仓命令只归属于 SELL。
 * 类型系统覆盖正常调用方；该校验覆盖 JavaScript 调用、强制断言或受损内部载荷，
 * 必须在专用入口构造内部信号前完成整批预检，避免前序合法命令已产生订单副作用后才暴露非法 action。
 *
 * @param command 待解析的末日清仓命令
 * @returns 无返回值；非法 action 直接抛出内部契约错误
 */
function assertDoomsdayClearanceSellContract(command: DoomsdayClearanceCommand): void {
  const runtimeAction: unknown = command.action;
  if (runtimeAction === 'SELLCALL' || runtimeAction === 'SELLPUT') {
    return;
  }

  throw new Error(
    `[订单执行] 末日清仓只能使用 SELLCALL 或 SELLPUT: action=${String(runtimeAction)} symbol=${command.symbol}`,
  );
}

/**
 * 将末日清仓内部卖出信号解析为其唯一允许的席位方向。
 * 末日命令已在专用入口转换为非保护性 SellSignal；最终下单边界仍独立校验方向，避免失效席位污染订单与风控状态。
 *
 * @param signal 末日清仓内部卖出信号
 * @returns DoomsdayClearanceOrderCommand，包含唯一的卖出方向、SDK side 与末日执行目的
 */
function resolveDoomsdayClearanceOrderCommand(signal: SellSignal): ExecutableOrderCommand {
  const runtimeAction: unknown = signal.action;

  if (typeof signal.symbol !== 'string' || signal.symbol.length === 0) {
    throw new Error(`[订单执行] 信号缺少有效标的代码: action=${signal.action}`);
  }

  switch (signal.action) {
    case 'SELLCALL': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLCALL' },
        direction: 'LONG',
        side: OrderSide.Sell,
        executionPurpose: 'DOOMSDAY_CLEARANCE',
      };
    }

    case 'SELLPUT': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLPUT' },
        direction: 'SHORT',
        side: OrderSide.Sell,
        executionPurpose: 'DOOMSDAY_CLEARANCE',
      };
    }

    default: {
      throw new Error(`[订单执行] 非法末日清仓动作: action=${String(runtimeAction)}`);
    }
  }
}

/**
 * 将普通可执行信号动作解析为其唯一允许的席位方向。
 * 最终下单边界必须独立校验该方向，避免上游已失效或被错误构造的信号污染另一方向的订单与风控状态。
 *
 * @param signal 已通过执行入口类型约束的普通交易信号
 * @returns ExecutableOrderCommand，包含唯一的订单类型、席位方向、SDK side 与普通执行目的
 */
function resolveOrdinaryOrderCommand(signal: ExecutableSignal): ExecutableOrderCommand {
  const runtimeAction: unknown = signal.action;

  if (typeof signal.symbol !== 'string' || signal.symbol.length === 0) {
    throw new Error(`[订单执行] 信号缺少有效标的代码: action=${signal.action}`);
  }

  switch (signal.action) {
    case 'BUYCALL': {
      return {
        kind: 'BUY',
        signal: { ...signal, action: 'BUYCALL' },
        direction: 'LONG',
        side: OrderSide.Buy,
        executionPurpose: 'ORDINARY',
      };
    }

    case 'BUYPUT': {
      return {
        kind: 'BUY',
        signal: { ...signal, action: 'BUYPUT' },
        direction: 'SHORT',
        side: OrderSide.Buy,
        executionPurpose: 'ORDINARY',
      };
    }

    case 'SELLCALL': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLCALL' },
        direction: 'LONG',
        side: OrderSide.Sell,
        executionPurpose: 'ORDINARY',
      };
    }

    case 'SELLPUT': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLPUT' },
        direction: 'SHORT',
        side: OrderSide.Sell,
        executionPurpose: 'ORDINARY',
      };
    }

    default: {
      throw new Error(`[订单执行] 非法可执行信号动作: action=${String(runtimeAction)}`);
    }
  }
}

/**
 * 创建订单执行器（核心业务流程：信号执行与订单提交）。
 *
 * @param deps 依赖注入（ctx、rateLimiter、cacheManager、orderMonitor、orderRecorder、unrealizedLossBuyGate、tradingConfig、symbolRegistry、生命周期与连续交易门禁）
 * @returns OrderExecutor 接口实例
 */
export function createOrderExecutor(deps: OrderExecutorDeps): OrderExecutor {
  const {
    ctx,
    rateLimiter,
    marketDataClient,
    cacheManager,
    orderMonitor,
    orderRecorder,
    unrealizedLossBuyGate,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
    isContinuousTradingAllowed,
    now,
    readCurrentTradingDayInfo,
  } = deps;
  const { global, monitor } = tradingConfig;

  /**
   * 检查执行门禁。
   *
   * @param signal 信号
   * @param stage 阶段标识
   * @returns true 表示允许继续执行
   */
  function canExecuteSignal(signal: Signal, stage: string): boolean {
    if (isExecutionAllowed()) {
      return true;
    }

    logger.debug(
      `[执行门禁] ${stage} 门禁关闭，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
    );
    return false;
  }

  /**
   * 在每个最终订单副作用前以当前事实授权执行目的。
   * 生命周期与连续时段状态不能替代实时钟：异步限流、撤单和改单等待期间可能已经跨越午休、接管或收盘边界。
   *
   * @param command 已绑定动作、席位方向与执行目的的订单命令
   * @param stage 当前授权阶段
   * @returns 当前交易日、连续时段与执行目的均允许时返回 true
   */
  function isCurrentOrderPurposeAuthorized(
    command: ExecutableOrderCommand,
    stage: string,
  ): boolean {
    const { signal } = command;
    const currentTime = now();
    const currentDateKey = getHKDateKey(currentTime);
    const currentTradingDayInfo = readCurrentTradingDayInfo();
    if (
      currentDateKey === null ||
      currentTradingDayInfo?.dateKey !== currentDateKey ||
      !currentTradingDayInfo.info.isTradingDay
    ) {
      logger.warn(
        `[执行门禁] ${stage} 无法确认当日交易日事实，拒绝订单副作用: symbol=${signal.symbol} action=${signal.action} currentDateKey=${currentDateKey ?? 'null'} calendarDateKey=${currentTradingDayInfo?.dateKey ?? 'null'}`,
      );
      return false;
    }

    const { isHalfDay } = currentTradingDayInfo.info;
    if (!isContinuousTradingAllowed()) {
      logger.debug(
        `[执行门禁] ${stage} 连续交易门禁关闭，拒绝订单副作用: symbol=${signal.symbol} action=${signal.action}`,
      );
      return false;
    }

    if (!isInContinuousHKSession(currentTime, isHalfDay)) {
      logger.debug(
        `[执行门禁] ${stage} 当前不在连续交易时段，拒绝订单副作用: symbol=${signal.symbol} action=${signal.action}`,
      );
      return false;
    }

    const inDoomsdayTakeover = isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDay);
    if (command.executionPurpose === 'DOOMSDAY_CLEARANCE') {
      if (!global.doomsdayProtection) {
        logger.warn(
          `[执行门禁] ${stage} 末日保护未启用，拒绝末日清仓命令: symbol=${signal.symbol} action=${signal.action}`,
        );
        return false;
      }

      if (!inDoomsdayTakeover) {
        logger.debug(
          `[执行门禁] ${stage} 不在末日清仓接管窗口，拒绝末日清仓命令: symbol=${signal.symbol} action=${signal.action}`,
        );
        return false;
      }

      if (isStaleCrossDaySignal(signal, currentTime)) {
        logger.debug(
          `[执行门禁] ${stage} 末日清仓命令跨日或触发时间无效，拒绝订单副作用: symbol=${signal.symbol} action=${signal.action}`,
        );
        return false;
      }

      return true;
    }

    if (global.doomsdayProtection && inDoomsdayTakeover) {
      logger.debug(
        `[执行门禁] ${stage} 已进入末日清仓接管窗口，拒绝普通信号: symbol=${signal.symbol} action=${signal.action}`,
      );
      return false;
    }

    if (
      command.kind === 'BUY' &&
      global.doomsdayProtection &&
      hasReachedDoomsdayBuyCutoff(currentTime, isHalfDay)
    ) {
      logger.info(
        `[执行门禁] ${stage} 已进入末日保护买入截止窗口，拒绝买入: symbol=${signal.symbol} action=${signal.action}`,
      );
      return false;
    }

    return true;
  }

  /**
   * 为单个信号创建贯穿 submit/replace/cancel 的席位绑定授权器。
   * 每次授权都重新读取生命周期、连续时段、交易日、末日目的与 SymbolRegistry 当前事实，阻断异步等待期间失效的旧信号副作用。
   *
   * @param command 已绑定动作、席位方向与执行目的的订单命令
   * @returns OrderActionAuthorization，可在最终 SDK API 前重复调用
   */
  function createSignalOrderAuthorization(
    command: ExecutableOrderCommand,
  ): OrderActionAuthorization {
    const { signal } = command;

    return (stage) => {
      if (!canExecuteSignal(signal, stage)) {
        return false;
      }

      const currentSeat = symbolRegistry.resolveSeatBySymbol(signal.symbol);
      if (!currentSeat) {
        logger.debug(
          `[执行门禁] ${stage} 信号标的已不属于当前席位，跳过信号: ${signal.symbol} ${signal.action}`,
        );
        return false;
      }

      if (currentSeat.direction !== command.direction) {
        if (stage === 'executeSignals') {
          throw new Error(
            `[订单执行] 信号动作与席位方向不一致: action=${signal.action} expected=${command.direction} actual=${currentSeat.direction} symbol=${signal.symbol}`,
          );
        }

        logger.debug(
          `[执行门禁] ${stage} 信号方向已失效，跳过信号: ${signal.symbol} ${signal.action}`,
        );
        return false;
      }

      if (!isCurrentOrderPurposeAuthorized(command, stage)) {
        return false;
      }

      return validateSignalSeatVersionAtExecution(
        signal,
        signal.seatVersion,
        currentSeat.seatVersion,
      );
    };
  }

  const buyThrottle = createBuyThrottle({
    buyIntervalSeconds: monitor.buyIntervalSeconds,
    clock: { now },
  });

  const submitTargetOrder = createSubmitTargetOrder({
    ctx,
    rateLimiter,
    marketDataClient,
    cacheManager,
    orderMonitor,
    orderRecorder,
    globalConfig: global,
    monitorConfig: monitor,
    unrealizedLossBuyGate,
    canExecuteSignal,
    canTradeNow: buyThrottle.canTradeNow,
    recordBuyAttempt: buyThrottle.recordBuyAttempt,
  });

  /**
   * 执行已解析且已绑定执行目的的订单命令，并收集末日清仓 owner 所需的终态等待与缺行情事实。
   *
   * @param commands 普通或末日清仓入口已完成载荷校验与身份解析的订单命令
   * @returns Promise<DoomsdayClearanceExecutionResult>，包含新提交或 broker 已确认改单的订单 ID、等待权威终态标的及最终行情缺失标的
   */
  async function executeSignalsForPurpose(
    commands: ReadonlyArray<ExecutableOrderCommand>,
  ): Promise<DoomsdayClearanceExecutionResult> {
    if (!isExecutionAllowed()) {
      logger.debug('[执行门禁] 门禁关闭，跳过本次下单，不提交任何订单');
      return {
        executedOrderIds: [],
        awaitingAuthoritativeTerminalSymbols: [],
        unresolvedQuoteSymbols: [],
      };
    }

    const executedOrderIds: string[] = [];
    const awaitingAuthoritativeTerminalSymbols = new Set<string>();
    const unresolvedQuoteSymbols = new Set<string>();

    for (const command of commands) {
      const { signal } = command;

      const signalSymbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

      if (
        command.executionPurpose === 'ORDINARY' &&
        !isLiquidationSignal(signal) &&
        isStaleCrossDaySignal(signal, now())
      ) {
        logger.debug(
          `[执行门禁] 跨日或触发时间无效信号，跳过执行: ${signalSymbolDisplay} ${signal.action}`,
        );
        continue;
      }

      if (!isExecutionAllowed()) {
        logger.debug(`[执行门禁] 门禁已关闭，跳过信号: ${signalSymbolDisplay} ${signal.action}`);
        continue;
      }

      const authorizeOrderAction = createSignalOrderAuthorization(command);
      if (!authorizeOrderAction('executeSignals')) {
        continue;
      }

      const actualAction = getActionDescription(signal.action);
      const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName);
      const planReason =
        signal.reason === null || signal.reason === undefined || signal.reason === ''
          ? '策略信号'
          : signal.reason;
      logger.info(
        `${LOG_COLORS.green}[交易计划] ${actualAction} ${symbolDisplay} - ${planReason}${LOG_COLORS.reset}`,
      );

      const actionResult = await submitTargetOrder(command, authorizeOrderAction);
      if (actionResult.kind === 'SUBMITTED' || actionResult.kind === 'REPLACED') {
        executedOrderIds.push(actionResult.orderId);
      } else if (actionResult.kind === 'WAITING_FOR_AUTHORITATIVE_TERMINAL') {
        awaitingAuthoritativeTerminalSymbols.add(actionResult.symbol);
      } else if (actionResult.kind === 'QUOTE_UNAVAILABLE') {
        unresolvedQuoteSymbols.add(actionResult.symbol);
      }
    }

    return {
      executedOrderIds,
      awaitingAuthoritativeTerminalSymbols: [...awaitingAuthoritativeTerminalSymbols],
      unresolvedQuoteSymbols: [...unresolvedQuoteSymbols],
    };
  }

  /** 执行普通信号；末日接管窗口内会在最终订单副作用边界被拒绝。 */
  async function executeSignals(
    signals: ReadonlyArray<ExecutableSignal>,
  ): Promise<ExecuteSignalsResult> {
    // 批量预检必须先于任何解析、门禁和执行步骤，禁止后续非法载荷让前序信号产生副作用。
    for (const signal of signals) {
      assertProtectiveLiquidationSellContract(signal);
    }

    const commands = signals.map(resolveOrdinaryOrderCommand);
    const result = await executeSignalsForPurpose(commands);
    return { executedOrderIds: result.executedOrderIds };
  }

  /** 执行末日清仓信号；仅在当前末日清仓接管窗口内允许最终订单副作用。 */
  function executeDoomsdayClearanceSignals(
    commands: ReadonlyArray<DoomsdayClearanceCommand>,
  ): Promise<DoomsdayClearanceExecutionResult> {
    // 批量预检必须先于任何内部信号构造与执行步骤，禁止受损 action 让前序命令产生副作用。
    for (const command of commands) {
      assertDoomsdayClearanceSellContract(command);
    }

    const signals = commands.map(createDoomsdayClearanceSellSignal);
    const doomsdayCommands = signals.map(resolveDoomsdayClearanceOrderCommand);
    return executeSignalsForPurpose(doomsdayCommands);
  }

  return {
    canTradeNow: buyThrottle.canTradeNow,
    executeSignals,
    executeDoomsdayClearanceSignals,
    resetBuyThrottle: buyThrottle.resetBuyThrottle,
  };
}
