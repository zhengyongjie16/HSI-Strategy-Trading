/**
 * TradingRiskEventRuntime 的单方向浮亏执行器。
 *
 * 职责：
 * - 使用当前 route 收敛后的 latest event quote 执行浮亏检查
 * - 透传 seatVersion，确保保护性清仓信号遵守执行层版本门禁
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { DirectionalUnrealizedLossMonitorContext } from '../../types/risk.js';
import type { QuoteUpdatedEvent, Trader } from '../../types/services.js';
import type { MonitorContext } from '../../types/state.js';
import type { TradingRiskRoute } from './types.js';

/**
 * 执行单方向浮亏检查与保护性清仓。
 *
 * @param params 路由、行情事件与交易器
 */
export async function executeDirectionalUnrealizedLoss(params: {
  readonly route: TradingRiskRoute;
  readonly event: QuoteUpdatedEvent;
  readonly trader: Trader;
  readonly monitorContext: MonitorContext;
}): Promise<void> {
  const { route, event, trader, monitorContext } = params;
  if (!isValidPositiveNumber(event.quote.price)) {
    return;
  }

  const context: DirectionalUnrealizedLossMonitorContext = {
    symbol: route.tradingSymbol,
    isLong: route.direction === 'LONG',
    seatVersion: route.seatVersion,
    quote: event.quote,
    riskChecker: monitorContext.riskChecker,
    trader,
    orderRecorder: monitorContext.orderRecorder,
    dailyLossTracker: monitorContext.dailyLossTracker,
  };

  await monitorContext.unrealizedLossMonitor.monitorDirectionalUnrealizedLoss(context);
}
