import { expect, test } from 'bun:test';
import { mergeMonotonicOrderFact } from '../../../../src/domain/order/orderFactMerge.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const frame = {
  orderId: 'TERMINAL',
  tradeId: 'T',
  symbol: 'BULL.HK',
  stockName: 'SDK',
  remark: '',
  side: 'SELL' as const,
  status: 'PartialFilled' as const,
  quantity: '100',
  executedQuantity: '40',
  submittedPrice: '1',
  executedPrice: '1',
  submittedAtMs: 50,
  executionTimeMs: 100,
  updatedAtMs: 150,
};

test('actual registered SDK terminal callbacks reach samectx complete dual ledger before quote completion, retaining real T/revision and strict no-evidence denial', async () => {
  const f = await createBrokerIngressFixture(frame);
  const original = f.queryObservation;
  const confirmed = {
    brokerOrderId: original.orderId,
    symbol: original.symbol,
    side: original.executionSide,
    cumulativeQuantity: original.executedQuantity,
    cumulativeAmount: original.executedAmount,
    executionTimeMs: original.executionTimeMs,
    updatedAtMs: original.updatedAtMs,
    phase: original.executionPhase,
    executedPrice: original.executedPrice,
  };
  const results: OrderFact[] = [];
  let issued: Promise<void> = Promise.resolve();
  let callbacks = 0;
  f.createPushPort().setOnOrderChanged((_error, decoder) => {
    callbacks++;
    const read = decoder.inspect();
    expect(results).toHaveLength(callbacks - 1);
    issued = Promise.allSettled([
      f.executionLedgerPort.todayExecutions({ orderId: read.orderId }),
      f.executionLedgerPort.historyExecutions({
        symbol: read.symbol,
        endAt: new Date(read.updatedAtMs),
      }),
    ]).then((reads) => {
      if (reads[0].status !== 'fulfilled' || reads[1].status !== 'fulfilled')
        throw new Error('actual ledger failed');

      const mapped = decoder.decode([...reads[0].value, ...reads[1].value], confirmed);
      const merged = mergeMonotonicOrderFact(
        {
          orderId: original.orderId,
          symbol: original.symbol,
          side: original.executionSide,
          executionSide: original.executionSide,
          executionPhase: original.executionPhase,
          submittedQuantity: original.quantity,
          status: original.status,
          executedQuantity: original.executedQuantity,
          executedAmount: original.executedAmount,
          executedPrice: original.executedPrice,
          lastExecutedTimeMs: original.executionTimeMs,
          lastOrderUpdateAtMs: original.updatedAtMs,
        },
        {
          status: mapped.status,
          executionPhase: mapped.executionPhase,
          executedQuantity: mapped.executedQuantity,
          executedAmount: mapped.executedAmount,
          executedPrice: mapped.executedPrice,
          executedTimeMs: mapped.executionTimeMs,
          updatedAtMs: mapped.updatedAtMs,
        },
      );
      expect(merged).toMatchObject({
        executionPhase: 'TERMINAL',
        executedQuantity: 40,
        executedAmount: '40',
        executedPrice: '1',
        executedTimeMs: 100,
        updatedAtMs: 200,
      });
      results.push(mapped);
    });
  });
  f.emitOrderChangedFrame({ ...frame, status: 'Canceled', executedPrice: '0', updatedAtMs: 200 });
  await issued;
  f.emitOrderChangedFrame({ ...frame, status: 'Filled', executedPrice: '0', updatedAtMs: 200 });
  await issued;
  expect(results[1]?.executionStatus).toBe('FILLED');
  expect(callbacks).toBe(2);
  expect(results).toHaveLength(2);
  expect(f.readCounts()).toEqual({ today: 3, history: 2 });
  f.setExecutionReplies([]);
  f.emitOrderChangedFrame({ ...frame, status: 'Canceled', executedPrice: '0', updatedAtMs: 200 });
  const denied = await issued.catch((error: unknown) => error);
  expect(denied).toBeInstanceOf(TypeError);
  expect(results).toHaveLength(2);
});
