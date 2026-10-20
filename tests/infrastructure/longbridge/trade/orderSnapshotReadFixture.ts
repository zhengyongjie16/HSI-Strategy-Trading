/** 订单快照离线 SDK 边界：保留精确 Decimal、原生读顺序及 getter 故障，向 owner 测试仅提供中性 port/观察。 */
import { Decimal, OrderSide, OrderStatus, OrderType } from 'longbridge';
import type { BrokerOrderSdkFields } from '../../../../src/infrastructure/longbridge/trade/types.js';
import type { OrderSnapshotReadPort } from '../../../../src/types/orderSnapshotReadPorts.js';
import { createOrderSnapshotReadAdapter } from '../../../../src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.js';

function order(id: string, revision: number): BrokerOrderSdkFields {
  return {
    orderId: id,
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    side: OrderSide.Buy,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    remark: '',
    price: new Decimal('1.000000000000000001'),
    quantity: new Decimal('100'),
    executedPrice: null,
    executedQuantity: new Decimal('0'),
    submittedAt: new Date(100),
    updatedAt: new Date(revision),
  };
}

/** 原生 context 与 adapter 留在 infra；调用方只驱动真实快照 port，不在此装配 core owner。 */
export function createNativeSnapshotReadFixture(
  historyOrderIdFault?: Error,
): {
  readonly port: OrderSnapshotReadPort;
  readonly calls: ReadonlyArray<string>;
  readonly getLaterReadCount: () => number;
} {
  const calls: string[] = [];
  let laterReads = 0;
  const badOrder = order('BAD', 200);
  if (historyOrderIdFault) {
    Object.defineProperty(badOrder, 'orderId', {
      get: () => {
        throw historyOrderIdFault;
      },
    });
  }

  const context = {
    historyOrders: async () => {
      calls.push('historyOrders');
      return historyOrderIdFault ? [badOrder] : [order('DUP', 500), order('HISTORY', 300)];
    },
    todayOrders: async () => {
      calls.push('todayOrders');
      laterReads++;
      return [order('DUP', 200), order('DUP', 250)];
    },
  };
  return {
    port: createOrderSnapshotReadAdapter(context, {
      rateLimiter: {
        throttle: async () => {
          calls.push('throttle');
        },
      },
    }),
    calls,
    getLaterReadCount: () => laterReads,
  };
}
