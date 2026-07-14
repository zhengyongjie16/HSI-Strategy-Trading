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
import { getHKDateKey } from '../../../utils/time/index.js';
import { hasReachedDoomsdayBuyCutoff } from '../../doomsdayProtection/utils.js';
import type { ExecutableSignal, Signal } from '../../../types/signal.js';
import type { ExecuteSignalsResult } from '../../../types/trader.js';
import type { OrderActionAuthorization, OrderExecutor, OrderExecutorDeps } from '../types.js';
import type { ExecutableOrderCommand } from './types.js';
import { createSubmitTargetOrder } from './submitFlow.js';
import { createBuyThrottle } from './buyThrottle.js';
import { getActionDescription, isLiquidationSignal, isStaleCrossDaySignal } from './utils.js';

/**
 * 校验信号携带的席位版本是否与执行时席位版本一致。
 * 信号必须携带有限 seatVersion，缺失或版本不匹配均拒绝执行。
 *
 * @param signal 信号对象
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
 * 将可执行信号动作解析为其唯一允许的席位方向。
 * 最终下单边界必须独立校验该方向，避免上游已失效或被错误构造的信号污染另一方向的订单与风控状态。
 *
 * @param action 已通过执行入口类型约束的买卖信号动作
 * @returns 信号应归属的 LONG 或 SHORT 席位方向
 */
function resolveExecutableOrderCommand(signal: ExecutableSignal): ExecutableOrderCommand {
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
      };
    }

    case 'BUYPUT': {
      return {
        kind: 'BUY',
        signal: { ...signal, action: 'BUYPUT' },
        direction: 'SHORT',
        side: OrderSide.Buy,
      };
    }

    case 'SELLCALL': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLCALL' },
        direction: 'LONG',
        side: OrderSide.Sell,
      };
    }

    case 'SELLPUT': {
      return {
        kind: 'SELL',
        signal: { ...signal, action: 'SELLPUT' },
        direction: 'SHORT',
        side: OrderSide.Sell,
      };
    }

    default: {
      const invalidSignal: Signal = signal;
      throw new Error(`[订单执行] 非法可执行信号动作: action=${invalidSignal.action}`);
    }
  }
}

/**
 * 创建订单执行器（核心业务流程：信号执行与订单提交）。
 *
 * @param deps 依赖注入（ctx、rateLimiter、cacheManager、orderMonitor、orderRecorder、tradingConfig、symbolRegistry、isExecutionAllowed）
 * @returns OrderExecutor 接口实例
 */
export function createOrderExecutor(deps: OrderExecutorDeps): OrderExecutor {
  const {
    ctx,
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
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
   * 为单个信号创建贯穿 submit/replace/cancel 的席位绑定授权器。
   * 每次授权都重新读取生命周期门禁与 SymbolRegistry 当前事实，阻断异步等待期间失效的旧信号副作用。
   *
   * @param signal 已绑定 seatVersion 的可执行信号
   * @returns 可在最终 SDK API 前重复调用的授权器
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

      if (
        stage === 'submitOrder.beforeApi' &&
        command.kind === 'BUY' &&
        global.doomsdayProtection
      ) {
        const currentTime = now();
        const currentDateKey = getHKDateKey(currentTime);
        const currentTradingDayInfo = readCurrentTradingDayInfo();
        if (
          currentDateKey === null ||
          currentTradingDayInfo?.dateKey !== currentDateKey ||
          !currentTradingDayInfo.info.isTradingDay
        ) {
          logger.warn(
            `[执行门禁] ${stage} 无法确认当日交易日事实，拒绝买入: symbol=${signal.symbol} action=${signal.action} currentDateKey=${currentDateKey ?? 'null'} calendarDateKey=${currentTradingDayInfo?.dateKey ?? 'null'}`,
          );
          return false;
        }

        if (hasReachedDoomsdayBuyCutoff(currentTime, currentTradingDayInfo.info.isHalfDay)) {
          logger.info(
            `[执行门禁] ${stage} 已进入末日保护买入截止窗口，拒绝买入: symbol=${signal.symbol} action=${signal.action}`,
          );
          return false;
        }
      }

      return validateSignalSeatVersionAtExecution(
        signal,
        signal.seatVersion,
        currentSeat.seatVersion,
      );
    };
  }

  const buyThrottle = createBuyThrottle(monitor.buyIntervalSeconds);

  const submitTargetOrder = createSubmitTargetOrder({
    ctx,
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    globalConfig: global,
    monitorConfig: monitor,
    canExecuteSignal,
    recordBuyAttempt: buyThrottle.recordBuyAttempt,
  });

  /**
   * 执行交易信号，返回真正新提交或 broker 已确认改单的唯一订单 ID 列表。
   *
   * @param signals 待执行信号
   * @returns 已执行订单 ID
   */
  async function executeSignals(
    signals: ReadonlyArray<ExecutableSignal>,
  ): Promise<ExecuteSignalsResult> {
    if (!isExecutionAllowed()) {
      logger.debug('[执行门禁] 门禁关闭，跳过本次下单，不提交任何订单');
      return { executedOrderIds: [] };
    }

    const executedOrderIds: string[] = [];

    for (const signal of signals) {
      const command = resolveExecutableOrderCommand(signal);

      const signalSymbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);

      if (!isLiquidationSignal(signal) && isStaleCrossDaySignal(signal, new Date())) {
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
      if (actionResult.kind !== 'SKIPPED') {
        executedOrderIds.push(actionResult.orderId);
      }
    }

    return { executedOrderIds };
  }

  return {
    canTradeNow: buyThrottle.canTradeNow,
    executeSignals,
    resetBuyThrottle: buyThrottle.resetBuyThrottle,
  };
}
