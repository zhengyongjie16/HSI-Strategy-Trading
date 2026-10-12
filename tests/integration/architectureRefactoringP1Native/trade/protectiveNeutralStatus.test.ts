import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';
import { assertProtectiveSellRawObservationFactsReady } from '../../../../src/core/trader/orderMonitor/orderFactMerge.js';
import { withTrustedOrderExecutionTimes } from '../../../../src/domain/order/executionFact.js';
import type { OrderExecutionTimeObservation } from '../../../../src/types/orderRecorder.js';

const input = {
  orderId: 'STATUS',
  tradeId: 'T',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'Filled' as const,
  quantity: '100',
  executedQuantity: '0',
  submittedPrice: '1',
  executedPrice: '0',
  submittedAtMs: 1700000000000,
  executionTimeMs: null,
  updatedAtMs: 1700000000200,
};

test('actual mapper FILLED/PARTIAL zero-execution denial stays strict without reading legacy SDK status', async () => {
  for (const status of ['Filled', 'PartialFilled'] as const) {
    const f = await createBrokerIngressFixture({ ...input, status });
    const event = f.pushObservation;
    const observation = {
      executionPhase: event.executionPhase,
      executionStatus: event.executionStatus,
      status: event.status,
      executedQuantity: event.executedQuantity,
      executedAmount: event.executedAmount,
      executedPrice: event.executedPrice,
      executedTimeMs: event.executionTimeMs,
      updatedAtMs: event.updatedAtMs,
    };
    Object.defineProperty(observation, 'status', {
      get: () => {
        throw new Error('SDK metadata must not be read by new economic check');
      },
    });

    expect(() => {
      assertProtectiveSellRawObservationFactsReady(
        {
          orderId: event.orderId,
          executionSide: event.executionSide,
          isProtectiveLiquidation: true,
          executedQuantity: 0,
          lastOrderUpdateAtMs: null,
        },
        observation,
      );
    }).toThrow('原始观察否认执行事实');
  }
});

test('SDK-free minimal trusted-time input preserves extra fields and never synthesizes T from revision', () => {
  const observation: OrderExecutionTimeObservation & Readonly<{ independent: string }> = {
    orderId: 'T',
    symbol: 'BULL.HK',
    executionSide: 'SELL',
    executedQuantity: 10,
    executedAmount: '12',
    executionTimeMs: null,
    updatedAtMs: 1700000000200,
    executionPhase: 'TERMINAL',
    independent: 'kept',
  };
  expect(withTrustedOrderExecutionTimes([observation], [])[0]).toBe(observation);
  const proven = withTrustedOrderExecutionTimes(
    [observation],
    [
      {
        brokerOrderId: 'T',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: 10,
        cumulativeAmount: '12',
        lastExecutionTimeMs: 1700000000100,
        orderRevisionMs: 1700000000200,
        phase: 'TERMINAL',
      },
    ],
  )[0];
  expect(proven).toEqual({ ...observation, executionTimeMs: 1700000000100 });
  expect(observation.executionTimeMs).toBeNull();
  expect(proven?.independent).toBe('kept');
});
