/** 订单类型选择规则：信号覆盖优先，protective 使用清仓配置，其余使用常规配置。 */
import type { OrderTypeConfig, Signal } from '../../types/signal.js';
import type { OrderTypeResolutionConfig } from './types.js';

/** 保留原信号级覆盖 → 保护性清仓类型 → 全局交易类型优先级。 */
export function resolveOrderTypeConfig(
  signal: Pick<Signal, 'orderTypeOverride' | 'isProtectiveLiquidation'>,
  config: OrderTypeResolutionConfig,
): OrderTypeConfig {
  if (signal.orderTypeOverride !== null && signal.orderTypeOverride !== undefined) {
    return signal.orderTypeOverride;
  }

  return signal.isProtectiveLiquidation === true
    ? config.liquidationOrderType
    : config.tradingOrderType;
}
