/** broker context 私有装配边界：同步延迟创建唯一 context，adapter 按 Trader 原顺序逐个创建。 */
import { TradeContext, type Config } from 'longbridge';
import type { BrokerAccess } from '../../../types/brokerAccessPorts.js';
import type { OrderEconomics } from '../../../types/orderEconomics.js';
import { createAccountReadAdapter } from './accountReadAdapter.js';
import { createExecutionLedgerAdapter } from './executionLedgerAdapter.js';
import { createOrderDetailReadAdapter } from './orderDetailReadAdapter.js';
import { createOrderPushAdapter } from './orderPushAdapter.js';
import { createOrderSnapshotReadAdapter } from './orderSnapshotReadAdapter.js';
import { createPendingOrdersAdapter } from './pendingOrdersAdapter.js';
import { createSellPositionReadAdapter } from './sellPositionReadAdapter.js';
import { createTradeMutationAdapter } from './tradeMutationAdapter.js';

/** 捕获已存在的私有 context，只返回延迟 adapter 工厂，不提前构造 adapter。 */
export function createBrokerAccessAdapter(
  context: TradeContext,
  economics: OrderEconomics,
): BrokerAccess {
  return {
    createTradeMutationPort: () => createTradeMutationAdapter(context),
    createPendingOrdersReader: () => createPendingOrdersAdapter(context),
    createAccountReadPort: () => createAccountReadAdapter(context),
    createExecutionLedgerPort: () => createExecutionLedgerAdapter(context),
    createOrderPushPort: () => createOrderPushAdapter(context, economics),
    createOrderDetailReadPort: () => createOrderDetailReadAdapter(context, economics),
    createOrderSnapshotReadPort: (deps) => createOrderSnapshotReadAdapter(context, deps, economics),
    createSellPositionReader: () => createSellPositionReadAdapter(context),
  };
}

/** 捕获配置但不创建资源；由 createTrader 在原 try 内同步调用返回的 factory。 */
export function createBrokerAccessFactory(
  config: Config,
): (economics: OrderEconomics) => BrokerAccess {
  return (economics) => createBrokerAccessAdapter(TradeContext.new(config), economics);
}
