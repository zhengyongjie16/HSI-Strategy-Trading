/**
 * 买入处理器模块
 *
 * 功能：
 * - 消费 BuyTaskQueue 中的买入任务
 * - 使用 setImmediate 异步执行，不阻塞事件调度
 * - 执行风险检查和订单提交
 * - 统一管理买入任务的处理流程
 *
 * 注意：卖出信号由独立的 SellProcessor 处理，以避免被买入风险检查阻塞
 *
 * 执行顺序：
 * 1. 从任务队列获取任务
 * 2. 获取监控上下文与风险阶段 realtime 行情
 * 3. 执行风险检查（买入信号需要 API 调用）
 * 4. 委托 Trader 执行；最终执行行情由 OrderExecutor 在下单边界读取
 */
import {
  createBaseProcessor,
  executeSignalsWithLifecycleGate,
  logProcessorTaskFailure,
} from '../utils.js';
import { logger } from '../../../utils/logger/index.js';
import {
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../../utils/apiFailure/index.js';
import { isSeatActive } from '../../../utils/seat/guards.js';
import {
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../../services/autoSymbolManager/utils.js';
import type { Processor } from '../types.js';
import type { BuyProcessorDeps } from './types.js';
import type { Task, BuyTaskType } from '../tradeTaskQueue/types.js';
import type { BuyRiskCheckContext } from '../../../types/services.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';

/**
 * 创建买入处理器。
 * 消费 BuyTaskQueue 中的买入任务，执行风险检查后提交订单；与卖出处理器分离，避免买入侧 API 风险检查阻塞卖出执行。
 * 信号处理语义：
 * - 非买入信号（配置或调用错误）仅记录告警并视为已处理，不影响队列
 * - 席位未就绪、席位版本不匹配或席位标的已切换时，仅记录信息日志并安全丢弃信号
 * - 风险检查拦截或风险阶段行情缺失时，会记录原因并跳过下单，同样视为"正常完成但不下单"，调用方无需重试
 *
 * @param deps 依赖注入（任务队列、业务服务、生命周期门禁与 fatal 上报入口）
 * @returns 实现 Processor 接口的买入处理器实例（start/stop/stopAndDrain/restart）
 */
export function createBuyProcessor(deps: BuyProcessorDeps): Processor {
  const {
    taskQueue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient,
    doomsdayProtection,
    getIsHalfDay,
    now,
    getCanProcessTask,
    onFatalError,
  } = deps;

  /**
   * 处理单个买入任务
   * 注意：卖出信号由 SellProcessor 处理，此处只处理买入信号
   */
  async function processTask(task: Task<BuyTaskType>): Promise<void> {
    const signal = task.data;
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
    try {
      const ctx = monitorContext;
      const { config, state, orderRecorder, riskChecker } = ctx;
      const isLongSignal = signal.action === 'BUYCALL';
      const seatValidation = validateSignalSeat({
        signal,
        symbolRegistry: ctx.symbolRegistry,
      });
      if (!seatValidation.valid) {
        logger.debug(
          `[BuyProcessor] ${describeSignalSeatValidationFailure(seatValidation)}，跳过信号: ${symbolDisplay} ${signal.action}`,
        );
        return;
      }

      const isHalfDay = getIsHalfDay();

      // 买入信号：执行风险检查（需要 API 调用获取最新账户和持仓）
      // 构建风险检查上下文
      const longSeatState = ctx.symbolRegistry.getSeatState('LONG');
      const shortSeatState = ctx.symbolRegistry.getSeatState('SHORT');
      const longSymbol = isSeatActive(longSeatState) ? longSeatState.symbol : '';
      const shortSymbol = isSeatActive(shortSeatState) ? shortSeatState.symbol : '';
      const quoteSymbols = [monitorSymbol];
      if (longSymbol) {
        quoteSymbols.push(longSymbol);
      }

      if (shortSymbol && shortSymbol !== longSymbol) {
        quoteSymbols.push(shortSymbol);
      }

      const riskQuotes = await marketDataClient.getQuotes(quoteSymbols);
      const longQuote = longSymbol ? (riskQuotes.get(longSymbol) ?? null) : null;
      const shortQuote = shortSymbol ? (riskQuotes.get(shortSymbol) ?? null) : null;
      const monitorQuote = riskQuotes.get(monitorSymbol) ?? null;
      const requiredTradeQuote = isLongSignal ? longQuote : shortQuote;
      if (!requiredTradeQuote) {
        logger.warn(`[BuyProcessor] 买入标的行情缺失，跳过: ${symbolDisplay}`);
        return;
      }

      if (!monitorQuote || !Number.isFinite(monitorQuote.price) || monitorQuote.price <= 0) {
        logger.warn(
          `[BuyProcessor] 监控标的行情缺失或价格无效，跳过: ${formatSymbolDisplay(monitorSymbol, ctx.monitorSymbolName)}`,
        );
        return;
      }

      const riskCheckContext: BuyRiskCheckContext = {
        trader,
        riskChecker,
        orderRecorder,
        longQuote,
        shortQuote,
        monitorQuote,
        monitorSnapshot: state.lastMonitorSnapshot,
        longSymbol,
        shortSymbol,
        longSymbolName: ctx.longSymbolName,
        shortSymbolName: ctx.shortSymbolName,
        currentTime: now(),
        isHalfDay,
        doomsdayProtection,
        config,
      };
      const checkedSignals = await signalProcessor.applyRiskChecks([signal], riskCheckContext);

      // 如果信号被风险检查拦截，跳过执行
      if (checkedSignals.length === 0) {
        const rejectReason = signal.reason?.trim();
        const reasonSuffix = rejectReason ? ` - ${rejectReason}` : '';
        logger.debug(
          `[BuyProcessor] 买入信号被风险检查拦截: ${symbolDisplay} ${signal.action}${reasonSuffix}`,
        );
        return; // 处理成功（虽然被拦截了）
      }

      const executionSeatValidation = validateSignalSeat({
        signal,
        symbolRegistry: ctx.symbolRegistry,
      });
      if (!executionSeatValidation.valid) {
        logger.debug(
          `[BuyProcessor] ${describeSignalSeatValidationFailure(executionSeatValidation)}，执行前复核失败，跳过信号: ${symbolDisplay} ${signal.action}`,
        );
        return;
      }

      await executeSignalsWithLifecycleGate({
        getCanProcessTask,
        trader,
        signal,
        symbolDisplay,
        loggerPrefix: 'BuyProcessor',
        successMessage: '买入订单执行完成',
      });
      return;
    } catch (err) {
      if (!isExternalApiRequestError(err)) {
        throw err;
      }

      if (isUnconfirmedOrderSubmissionError(err)) {
        throw err;
      }

      logProcessorTaskFailure('BuyProcessor', symbolDisplay, signal.action, err);
      return;
    }
  }
  return createBaseProcessor({
    loggerPrefix: 'BuyProcessor',
    taskQueue,
    processTask,
    ...(getCanProcessTask ? { getCanProcessTask } : {}),
    onFatalError,
  });
}
