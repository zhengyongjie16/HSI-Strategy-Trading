import { nowMonotonicMs, wait } from '../../../../src/infrastructure/time/index.js';

import { createLoggerDouble } from '../../../helpers/testDoubles.js';
import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';
import { createRateLimiter } from '../../../../src/application/orderExecution/rateLimiter.js';

const frame = {
  orderId: 'A',
  tradeId: 'TA',
  symbol: 'OLD_BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'New' as const,
  quantity: '100',
  executedQuantity: '0',
  submittedPrice: '1',
  executedPrice: '0',
  submittedAtMs: 1700000000000,
  executionTimeMs: null,
  updatedAtMs: 1700000000200,
};

test('explicit samectx account/positions replies flow through production account adapter/service without defaults', async () => {
  const f = await createBrokerIngressFixture(frame);
  const account = f.createAccountService({
    rateLimiter: createRateLimiter({
      wait: wait,
      nowMonotonicMs: nowMonotonicMs,
      logger: createLoggerDouble(),
    }),
  });
  const missing = await account
    .getStockPositions({ retryConfig: { retries: 0, delayMs: 0 } })
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(Error);
  expect(String(missing)).toContain('unconfigured native SDK method');

  f.setStockPositions([
    {
      symbol: 'OLD_BULL.HK',
      symbolName: 'Old bull',
      accountChannel: 'cash',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: '100',
      costPrice: '2.000000000000000001',
    },
  ]);

  f.setAccountBalance({
    currency: 'HKD',
    totalCash: '5000',
    netAssets: '5200.0000000000000001',
    availableCash: '4999.9',
  });

  expect(await account.getStockPositions({ symbols: ['OLD_BULL.HK'] })).toEqual([
    {
      symbol: 'OLD_BULL.HK',
      symbolName: 'Old bull',
      accountChannel: 'cash',
      currency: 'HKD',
      quantity: 100,
      availableQuantity: 100,
      costPrice: '2.000000000000000001',
    },
  ]);

  expect(await account.getAccountSnapshot()).toMatchObject({
    totalCash: '5000',
    netAssets: '5200.0000000000000001',
    positionValue: '200.0000000000000001',
    cashInfos: [{ currency: 'HKD', availableCash: '4999.9' }],
  });
  expect(f.accountReadCounts()).toEqual({ positions: 2, balance: 1 });
});

test('explicit per-id native detail sequences map independent ledger T; unknown or exhausted requests fail', async () => {
  const f = await createBrokerIngressFixture(frame);
  f.setOrderDetailReplies([
    {
      ...frame,
      orderId: 'B',
      tradeId: 'TB',
      symbol: 'NEW_BULL.HK',
      status: 'PartialFilled',
      executedQuantity: '10',
      executedPrice: '1.2',
    },
    {
      ...frame,
      orderId: 'B',
      symbol: 'NEW_BULL.HK',
      status: 'Canceled',
      executedQuantity: '10',
      executedPrice: '1.2',
    },
  ]);

  f.setExecutionReplies([
    {
      orderId: 'B',
      tradeId: 'TB',
      symbol: 'NEW_BULL.HK',
      quantity: '10',
      price: '1.2',
      tradeDoneAtMs: 1700000000100,
    },
  ]);
  const read = f.createQueryOrdersReader('B');
  const first = await read();
  expect(first[0]).toMatchObject({
    orderId: 'B',
    executionPhase: 'OPEN',
    executedAmount: '12',
    executionTimeMs: 1700000000100,
  });

  const second = await read();
  expect(second[0]).toMatchObject({
    orderId: 'B',
    executionPhase: 'TERMINAL',
    executedAmount: '12',
    executionTimeMs: 1700000000100,
  });
  const exhausted = await read().catch((error: unknown) => error);
  const unknown = await f
    .createQueryOrdersReader('UNCONFIGURED')()
    .catch((error: unknown) => error);
  expect(exhausted).toBeInstanceOf(Error);
  expect(String(exhausted)).toContain('unconfigured native SDK method');
  expect(unknown).toBeInstanceOf(Error);
  expect(String(unknown)).toContain('unconfigured native SDK method');
  expect(f.nativeReadCounts()).toEqual({ cancel: 0, detail: 4 });
  expect(f.readCounts()).toEqual({ today: 3, history: 0 });
});
