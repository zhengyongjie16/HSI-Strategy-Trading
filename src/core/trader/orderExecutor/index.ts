/**
 * 订单执行模块
 *
 * 职责：
 * - 执行交易信号（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * - 管理同方向买入频率限制（防止重复开仓）
 * - 协调订单提交流程与追踪登记
 */
import { logger } from '../../../utils/logger/index.js';
import { LOG_COLORS } from '../../../constants/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import { isSeatVersionMatch } from '../../../utils/seat/guards.js';
import type { ExecutableSignal, Signal } from '../../../types/signal.js';
import type { OrderActionAuthorization, OrderExecutor, OrderExecutorDeps } from '../types.js';
import { createSubmitTargetOrder } from './submitFlow.js';
import { createBuyThrottle } from './buyThrottle.js';
import {
  getActionDescription,
  isLiquidationSignal,
  isStaleCrossDaySignal,
  resolveOrderSide,
} from './utils.js';

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
function resolveSignalDirection(action: ExecutableSignal['action']): 'LONG' | 'SHORT' {
  switch (action) {
    case 'BUYCALL':
    case 'SELLCALL': {
      return 'LONG';
    }

    case 'BUYPUT':
    case 'SELLPUT': {
      return 'SHORT';
    }

    default: {
      throw new Error(`[订单执行] 无法解析信号动作方向: action=${String(action)}`);
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
  function createSignalOrderAuthorization(signal: ExecutableSignal): OrderActionAuthorization {
    const binding = {
      action: signal.action,
      direction: resolveSignalDirection(signal.action),
      symbol: signal.symbol,
      seatVersion: signal.seatVersion,
    } as const;

    return (stage) => {
      if (!canExecuteSignal(signal, stage)) {
        return false;
      }

      const currentSeat = symbolRegistry.resolveSeatBySymbol(binding.symbol);
      if (!currentSeat) {
        logger.debug(
          `[执行门禁] ${stage} 信号标的已不属于当前席位，跳过信号: ${binding.symbol} ${binding.action}`,
        );
        return false;
      }

      if (currentSeat.direction !== binding.direction) {
        if (stage === 'executeSignals') {
          throw new Error(
            `[订单执行] 信号动作与席位方向不一致: action=${binding.action} expected=${binding.direction} actual=${currentSeat.direction} symbol=${binding.symbol}`,
          );
        }

        logger.debug(
          `[执行门禁] ${stage} 信号方向已失效，跳过信号: ${binding.symbol} ${binding.action}`,
        );
        return false;
      }

      return validateSignalSeatVersionAtExecution(
        signal,
        binding.seatVersion,
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
   * 执行交易信号，返回实际提交数量与订单 ID 列表。
   *
   * @param signals 待执行信号
   * @returns 提交统计
   */
  async function executeSignals(
    signals: ReadonlyArray<ExecutableSignal>,
  ): Promise<{ submittedCount: number; submittedOrderIds: ReadonlyArray<string> }> {
    if (!isExecutionAllowed()) {
      logger.debug('[执行门禁] 门禁关闭，跳过本次下单，不提交任何订单');
      return { submittedCount: 0, submittedOrderIds: [] };
    }

    let submittedCount = 0;
    const submittedOrderIds: string[] = [];

    for (const signal of signals) {
      if (!signal.symbol || typeof signal.symbol !== 'string') {
        logger.warn(`[跳过信号] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`);
        continue;
      }

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

      const side = resolveOrderSide(signal.action);
      if (!side) {
        logger.warn(`[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${signalSymbolDisplay}`);
        continue;
      }

      const authorizeOrderAction = createSignalOrderAuthorization(signal);
      if (!authorizeOrderAction('executeSignals')) {
        continue;
      }

      const isShortSymbol = resolveSignalDirection(signal.action) === 'SHORT';

      const actualAction = getActionDescription(signal.action);
      const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName);
      const planReason =
        signal.reason === null || signal.reason === undefined || signal.reason === ''
          ? '策略信号'
          : signal.reason;
      logger.info(
        `${LOG_COLORS.green}[交易计划] ${actualAction} ${symbolDisplay} - ${planReason}${LOG_COLORS.reset}`,
      );

      const submittedOrderId = await submitTargetOrder(
        signal,
        signal.symbol,
        isShortSymbol,
        authorizeOrderAction,
      );
      if (submittedOrderId !== null) {
        submittedCount += 1;
        submittedOrderIds.push(submittedOrderId);
      }
    }

    return { submittedCount, submittedOrderIds };
  }

  return {
    canTradeNow: buyThrottle.canTradeNow,
    executeSignals,
    resetBuyThrottle: buyThrottle.resetBuyThrottle,
  };
}
