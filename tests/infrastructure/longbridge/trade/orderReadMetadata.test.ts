/** 从 P1Native/trade/orderReadMetadata 分离的纯 mapper oracle；不装配或导入 core lifecycle owner。 */
import { expect, test } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  mapBrokerOrderSide,
  mapBrokerOrderStatus,
  mapBrokerOrderType,
} from '../../../../src/infrastructure/longbridge/trade/orderMapper.js';
import type { OrderReadType } from '../../../../src/types/orderReadMetadata.js';

test('native metadata preserves side identity and rejects unknown native side/status before classification', () => {
  expect(mapBrokerOrderSide(OrderSide.Buy)).toBe('BUY');
  expect(mapBrokerOrderSide(OrderSide.Sell)).toBe('SELL');
  expect(() => mapBrokerOrderSide(OrderSide.Unknown)).toThrow();
  expect(() => mapBrokerOrderStatus(OrderStatus.Unknown)).toThrow();
});

test('every native order kind retains its real neutral identity; no market/limit default or financial change', () => {
  const kinds: ReadonlyArray<readonly [OrderType, OrderReadType]> = [
    [OrderType.LO, 'LO'],
    [OrderType.ELO, 'ELO'],
    [OrderType.MO, 'MO'],
    [OrderType.AO, 'AO'],
    [OrderType.ALO, 'ALO'],
    [OrderType.ODD, 'ODD'],
    [OrderType.LIT, 'LIT'],
    [OrderType.MIT, 'MIT'],
    [OrderType.TSLPAMT, 'TSLPAMT'],
    [OrderType.TSLPPCT, 'TSLPPCT'],
    [OrderType.TSMAMT, 'TSMAMT'],
    [OrderType.TSMPCT, 'TSMPCT'],
    [OrderType.SLO, 'SLO'],
  ];
  for (const [kind, expected] of kinds) {
    expect(mapBrokerOrderType(kind)).toBe(expected);
  }

  expect(mapBrokerOrderType(OrderType.Unknown)).toBe('UNSPECIFIED');
});
