/** detail 读取边界：身份/市场范围在映射前校验，原错误码与重试证据保持归调用方。 */
import { expect, test } from 'bun:test';
import { Decimal, OrderSide, OrderStatus, OrderType, type OrderDetail } from 'longbridge';
import { createOrderDetailReadAdapter } from '../../../../src/infrastructure/longbridge/trade/orderDetailReadAdapter.js';

function detail(overrides: Readonly<Record<string, unknown>> = {}): OrderDetail {
  return {
    orderId: 'WANTED',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: OrderSide.Buy,
    status: OrderStatus.New,
    orderType: OrderType.ELO,
    price: new Decimal('1.01'),
    quantity: new Decimal('100'),
    executedPrice: null,
    executedQuantity: new Decimal('0'),
    submittedAt: new Date(1700000000000),
    updatedAt: new Date(1700000000200),
    ...overrides,
  } as unknown as OrderDetail;
}

/** 捕获拒绝值，避免在断言表达式里 await 非 Promise 类型。 */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function adapterReturning(value: unknown) {
  return createOrderDetailReadAdapter({ orderDetail: async () => value as OrderDetail });
}

test('HK order matching the requested id maps to a neutral fact', async () => {
  const fact = await adapterReturning(detail()).read('WANTED');
  expect(fact).toMatchObject({
    orderId: 'WANTED',
    symbol: 'BULL.HK',
    executionSide: 'BUY',
    executionPhase: 'OPEN',
    executedQuantity: 0,
    executedAmount: '0',
    executionTimeMs: null,
    updatedAtMs: 1700000000200,
  });
});

test('wrong orderId is rejected before mapping', async () => {
  const adapter = adapterReturning(detail({ orderId: 'OTHER' }));
  const error = await rejection(() => adapter.read('WANTED'));
  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).toContain('order detail identity mismatch');
});

test('non-HK detail is rejected instead of being managed across markets', async () => {
  const adapter = adapterReturning(detail({ symbol: 'AAPL.US' }));
  const error = await rejection(() => adapter.read('WANTED'));
  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).toContain('non-HK order detail rejected');
});

test('broken symbol structure is rejected, never treated as ordinary non-HK', async () => {
  const adapter = adapterReturning(detail({ symbol: 'BULL' }));
  const error = await rejection(() => adapter.read('WANTED'));
  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).toContain('symbol structure');
});

test('broker error code and retry evidence stay available to the query owner', () => {
  const port = adapterReturning(detail());
  expect(port.getErrorCode(new Error('order detail failed code=603001'))).toBe('603001');
  expect(port.getErrorCode(new Error('plain failure'))).toBeNull();
  expect(typeof port.isRetryableError).toBe('function');
});
