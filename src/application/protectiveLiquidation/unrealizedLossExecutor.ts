/**
 * 浮亏监控模块
 *
 * 消费单方向最新事件价格与调用方捕获的 epoch/seat/ready/position 授权。
 * 超阈值时沿原保护性卖出执行入口提交；远端确认后的本地清理与风险发布仍须授权有效。
 * 实际订单、保护性 purpose、跟踪及完成条件由原 executor/tracker/settlement owner 管理。
 */
import { exactCompare } from '../../utils/numeric/exact.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { formatError } from '../../utils/error/index.js';
import {
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../utils/apiFailure/index.js';
import type {
  DirectionalUnrealizedLossMonitorContext,
  UnrealizedLossMonitor,
} from '../../types/unrealizedLoss.js';
import type { ProtectiveLiquidationSellSignal } from '../../types/signal.js';
import type { UnrealizedLossMonitorDeps } from './types.js';

/**
 * 创建浮亏监控器；阈值只使用精确文本，不建立重试、freshness 或订单事实 owner。
 * @param deps 最大浮亏金额文本（<=0 表示禁用）
 * @returns 单方向浮亏监控能力
 */
export const createUnrealizedLossMonitor = (
  deps: UnrealizedLossMonitorDeps,
): UnrealizedLossMonitor => {
  const { maxUnrealizedLossPerSymbol, logger } = deps;

  /**
   * 检查浮亏并沿原执行路径提交保护性清仓。
   * 真实确认订单不能因调用方随后失效而被否认；失效仅阻断旧授权的本地副作用。
   * @param context 已捕获风险授权、事件报价及业务协作者
   * @returns broker 已确认提交订单时返回 true，不代表持仓已 flat 或保护事件已完成
   */
  const monitorDirectionalUnrealizedLoss = async (
    context: DirectionalUnrealizedLossMonitorContext,
  ): Promise<boolean> => {
    const {
      symbol,
      isLong,
      seatVersion,
      riskChecker,
      orderExecutor,
      orderRecorder,
      dailyLossTracker,
      quote,
    } = context;
    if (exactCompare(maxUnrealizedLossPerSymbol, '0') <= 0 || exactCompare(quote.price, '0') <= 0)
      return false;

    if (!context.isCurrent()) return false;

    const lossCheck = riskChecker.checkUnrealizedLoss(symbol, quote.price, isLong);
    if (!lossCheck.shouldLiquidate) return false;

    const liquidationSignal: ProtectiveLiquidationSellSignal = {
      symbol,
      symbolName: quote.name ?? null,
      action: isLong ? 'SELLCALL' : 'SELLPUT',
      reason: lossCheck.reason ?? '',
      isProtectiveLiquidation: true,
      quantity: lossCheck.quantity ?? null,
      seatVersion,
    };

    // 最终同步授权检查在提交调用前；executor 仍独占 broker 命令的执行门禁与 purpose。
    if (!context.isCurrent()) return false;

    const liquidationReason =
      lossCheck.reason === undefined || lossCheck.reason === ''
        ? '浮亏超过阈值，执行保护性清仓'
        : lossCheck.reason;
    logger.error(liquidationReason);

    let executedOrderCount: number;
    try {
      // 将同一captured epoch/receipt/seat/position授权直通executor最终broker边界。
      const executionResult = await orderExecutor.executeSignals(
        [liquidationSignal],
        context.isCurrent,
      );
      executedOrderCount = executionResult.executedOrderIds.length;
    } catch (error) {
      // UNKNOWN submit 与内部错误即使旧授权已失效也必须穿透，不假定远端未发生。
      if (!isExternalApiRequestError(error) || isUnconfirmedOrderSubmissionError(error))
        throw error;

      const direction = isLong ? '做多标的' : '做空标的';
      logger.error(
        `[保护性清仓失败] ${direction} ${formatSymbolDisplay(symbol, quote.name ?? null)}`,
        formatError(error),
      );
      return false;
    }

    if (executedOrderCount === 0) return false;

    // 已确认 orderId 属于原 tracker；失效不取消/重提，不让旧工作清买单或发布风险/episode。
    if (!context.isCurrent()) return true;

    orderRecorder.clearBuyOrders(symbol, isLong, quote);
    const prepared = riskChecker.prepareUnrealizedLossData(
      orderRecorder,
      symbol,
      isLong,
      dailyLossTracker.getLossOffset(isLong ? 'LONG' : 'SHORT'),
    );
    // prepare 无缓存发布；同一同步段最终授权校验后才发布，不用旧 refresh 异步写入。
    if (!context.isCurrent()) return true;

    riskChecker.publishUnrealizedLossData(prepared);
    return true;
  };

  return { monitorDirectionalUnrealizedLoss };
};
