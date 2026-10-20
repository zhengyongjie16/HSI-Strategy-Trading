import type { AccountReadPort } from './accountReadPorts.js';
import type { Position } from './account.js';
import type { OrderDetailReadPort } from './orderDetailReadPorts.js';
import type { OrderPushPort } from './orderPushPorts.js';
import type { OrderSnapshotReadPort } from './orderSnapshotReadPorts.js';
import type { PendingOrder } from './orderReadMetadata.js';
import type { RateLimiter } from './rateLimit.js';
import type { TradeMutationPort } from './tradeMutationPorts.js';

/** 同一 broker context 的延迟中性装配能力；各 adapter 仍在原 caller 顺序创建。 */
export interface BrokerAccess {
  readonly createTradeMutationPort: () => TradeMutationPort;
  readonly createPendingOrdersReader: () => {
    readonly todayOrders: () => Promise<ReadonlyArray<PendingOrder>>;
  };
  readonly createAccountReadPort: () => AccountReadPort;
  readonly createOrderPushPort: () => OrderPushPort;
  readonly createOrderDetailReadPort: () => OrderDetailReadPort;
  readonly createOrderSnapshotReadPort: (
    deps: Readonly<{ rateLimiter: Pick<RateLimiter, 'throttle'> }>,
  ) => OrderSnapshotReadPort;
  readonly createSellPositionReader: () => (symbol: string) => Promise<ReadonlyArray<Position>>;
}
