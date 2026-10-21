/** SDK mapper 已拒绝 FILLED 零量；PARTIAL 零量仍须通过保护 SELL 自身的原始成交准入。 */
import { expect, test } from 'bun:test';
import { assertProtectiveSellRawObservationFactsReady } from '../../../../src/domain/order/orderFactMerge.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const input = {
  orderId: 'STATUS',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'PartialFilled' as const,
  quantity: '100',
  executedQuantity: '0',
  submittedPrice: '1',
  executedPrice: '0',
  submittedAtMs: 1700000000000,
  updatedAtMs: 1700000000200,
};

test('actual mapper PARTIAL zero-execution denial stays strict without reading legacy SDK status', async () => {
  const f = await createBrokerIngressFixture(input);
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
  }).toThrow('保护性 SELL');
});
