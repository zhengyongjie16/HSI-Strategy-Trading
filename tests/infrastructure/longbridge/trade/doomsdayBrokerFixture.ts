/**
 * 末日集成测试的离线 broker fixture
 *
 * 内聚同一个 SDK mock context、原生持仓 DTO 与实际 adapter 装配；业务测试只控制中性持仓输入、
 * 读取真实中性 ports、调用计数和已发送的中性化下单观察，不接触 SDK DTO/context。
 */
import {
  Decimal,
  Market,
  OrderSide,
  OrderType,
  TimeInForceType,
  type StockPositionsResponse,
} from 'longbridge';
import { createTradeContextMock } from '../../../../mock/longbridge/tradeContextMock.js';
import { createAccountReadAdapter } from '../../../../src/infrastructure/longbridge/trade/accountReadAdapter.js';
import { createExecutionLedgerAdapter } from '../../../../src/infrastructure/longbridge/trade/executionLedgerAdapter.js';
import { createOrderDetailReadAdapter } from '../../../../src/infrastructure/longbridge/trade/orderDetailReadAdapter.js';
import { createOrderPushAdapter } from '../../../../src/infrastructure/longbridge/trade/orderPushAdapter.js';
import { createOrderSnapshotReadAdapter } from '../../../../src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.js';
import { createPendingOrdersAdapter } from '../../../../src/infrastructure/longbridge/trade/pendingOrdersAdapter.js';
import { createSellPositionReadAdapter } from '../../../../src/infrastructure/longbridge/trade/sellPositionReadAdapter.js';
import { createTradeMutationAdapter } from '../../../../src/infrastructure/longbridge/trade/tradeMutationAdapter.js';
import { orderEconomics } from '../../../../src/domain/order/orderEconomics.js';
import type { BrokerAccess } from '../../../../src/types/brokerAccessPorts.js';
import type { NativeSubmitObservation } from './brokerIngressFixture.js';

/**
 * 创建末日链路实际使用的离线 broker；原持仓默认口径在私有 SDK producer 中保持不变。
 * @param positions 明确指定的安全整数持仓与可卖量，空数组表示无持仓
 * @returns 同一 context 的中性 ports、下单观察和调用计数
 */
export function createDoomsdayBrokerFixture(
  positions: ReadonlyArray<{
    readonly symbol: string;
    readonly quantity: number;
    readonly availableQuantity: number;
  }>,
): Readonly<{
  ports: BrokerAccess;
  brokerAccess: () => BrokerAccess;
  getSubmissions: () => ReadonlyArray<NativeSubmitObservation>;
  getCallCounts: () => Readonly<{
    stockPositions: number;
    submitOrder: number;
    replaceOrder: number;
  }>;
}> {
  const context = createTradeContextMock();
  const response: StockPositionsResponse = {
    channels: [
      {
        accountChannel: 'lb_papertrading',
        positions: positions.map((position) => ({
          symbol: position.symbol,
          symbolName: position.symbol,
          quantity: new Decimal(String(position.quantity)),
          availableQuantity: new Decimal(String(position.availableQuantity)),
          currency: 'HKD',
          costPrice: new Decimal('1'),
          market: Market.HK,
          initQuantity: new Decimal(String(position.quantity)),
          toString: () => position.symbol,
          toJSON: () => ({}),
        })),
        toString: () => 'lb_papertrading',
        toJSON: () => ({}),
      },
    ],
    toString: () => 'offline doomsday positions',
    toJSON: () => ({}),
  };
  context.seedStockPositions(response);
  // 本场景真实没有 execution 流水；两个读取能力仍绑定同一个 context，而非另建 broker。
  Object.defineProperties(context, {
    todayExecutions: { value: async () => [] },
    historyExecutions: { value: async () => [] },
  });
  const ports: BrokerAccess = {
    createTradeMutationPort: () => createTradeMutationAdapter(context),
    createSellPositionReader: () => createSellPositionReadAdapter(context),
    createPendingOrdersReader: () => createPendingOrdersAdapter(context),
    createExecutionLedgerPort: () => createExecutionLedgerAdapter(context),
    createOrderPushPort: () => createOrderPushAdapter(context, orderEconomics),
    createAccountReadPort: () => createAccountReadAdapter(context),
    createOrderSnapshotReadPort: (deps) =>
      createOrderSnapshotReadAdapter(context, deps, orderEconomics),
    createOrderDetailReadPort: () => createOrderDetailReadAdapter(context, orderEconomics),
  };
  const submissions: NativeSubmitObservation[] = [];
  const originalSubmit = context.submitOrder;
  context.submitOrder = async (options) => {
    const side = new Map<number, NativeSubmitObservation['side']>([
      [OrderSide.Buy, 'BUY'],
      [OrderSide.Sell, 'SELL'],
    ]).get(options.side);
    const orderType = new Map<number, NativeSubmitObservation['orderType']>([
      [OrderType.LO, 'LO'],
      [OrderType.ELO, 'ELO'],
      [OrderType.MO, 'MO'],
    ]).get(options.orderType);
    if (
      side === undefined ||
      orderType === undefined ||
      options.timeInForce !== TimeInForceType.Day
    ) {
      throw new TypeError('[DoomsdayBrokerFixture] unsupported native submit observation');
    }

    submissions.push({
      symbol: options.symbol,
      side,
      orderType,
      quantity: options.submittedQuantity.toString(),
      price: options.submittedPrice?.toString() ?? null,
      remark: options.remark,
      timeInForce: 'DAY',
    });
    return originalSubmit(options);
  };

  return {
    ports,
    brokerAccess: (): BrokerAccess => ports,
    getSubmissions: (): ReadonlyArray<NativeSubmitObservation> => [...submissions],
    getCallCounts: () => ({
      stockPositions: context.getCalls('stockPositions').length,
      submitOrder: context.getCalls('submitOrder').length,
      replaceOrder: context.getCalls('replaceOrder').length,
    }),
  };
}
