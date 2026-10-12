/** Actual same-context query/ledger adapters; SDK DTOs stay in the approved private producer. */
import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import { createExecutionFixture } from '../../orderRecorder/executionFixture.js';
import type { OrderExecutionTimeEvidence } from '../../../../src/types/orderRecorder.js';

const amount = '123.45678901234567890123456789';
const input = {
  orderId: 'query',
  tradeId: 'execution',
  symbol: 'A.HK',
  stockName: 'A',
  remark: '',
  side: 'SELL' as const,
  status: 'Canceled' as const,
  quantity: '200',
  executedQuantity: '100',
  submittedPrice: '1.02',
  executedPrice: '1.2345678901234567890123456789',
  submittedAtMs: 100,
  updatedAtMs: 4000,
};

/** Query-unit work lifetime, not account readiness/mutation authorization. */
function captureQueryWork(native: Awaited<ReturnType<typeof createBrokerIngressFixture>>) {
  const owner = createExecutionFixture({ createRecorder: native.createRecorder });
  owner.runtime.runtimeState = 'ACTIVE';
  const token = owner.snapshot.getView().token;
  return () =>
    owner.snapshot.getView().token === token &&
    owner.runtime.runtimeState === 'ACTIVE' &&
    !owner.termination.isTerminated();
}

async function evidence(): Promise<OrderExecutionTimeEvidence> {
  const known = await createBrokerIngressFixture({
    ...input,
    status: 'PartialFilled',
    executionTimeMs: 1000,
    updatedAtMs: 3000,
  });
  const observation = known.queryObservation;
  if (observation.executionTimeMs === null)
    throw new Error('native prior execution requires its ledger time');

  return {
    brokerOrderId: observation.orderId,
    symbol: observation.symbol,
    side: observation.executionSide,
    cumulativeQuantity: observation.executedQuantity,
    cumulativeAmount: observation.executedAmount,
    lastExecutionTimeMs: observation.executionTimeMs,
    orderRevisionMs: observation.updatedAtMs,
    phase: observation.executionPhase,
  };
}

test('query terminal gets exact amount and earlier real execution T from actual mocked ledger', async () => {
  const native = await createBrokerIngressFixture({ ...input, executionTimeMs: 1000 });
  const query = native.createStateQuery({
    rateLimiter: createRateLimiterDouble(),
    getExecutionTimeEvidence: () => [],
  });
  const result = await query.checkOrderState('query', captureQueryWork(native));
  expect(result.kind).toBe('TERMINAL');
  if (result.kind === 'TERMINAL') {
    expect(result.executedAmount).toBe(amount);
    expect(result.executionTimeMs).toBe(1000);
    expect(result.orderUpdatedAtMs).toBe(4000);
  }
});

test('query amount revision keeps matched durable T; no evidence leaves explicit unknown execution time', async () => {
  // This broker observation genuinely has no execution rows: it does not clear an issued positive history.
  const native = await createBrokerIngressFixture({ ...input, executionTimeMs: null });
  const prior = await evidence();
  const isWorkCurrent = captureQueryWork(native);
  const recovered = await native
    .createStateQuery({
      rateLimiter: createRateLimiterDouble(),
      getExecutionTimeEvidence: () => [prior],
    })
    .checkOrderState('query', isWorkCurrent);
  const unknown = await native
    .createStateQuery({
      rateLimiter: createRateLimiterDouble(),
      getExecutionTimeEvidence: () => [],
    })
    .checkOrderState('query', isWorkCurrent);
  expect(recovered.kind).toBe('TERMINAL');
  expect(unknown.kind).toBe('TERMINAL');
  if (recovered.kind === 'TERMINAL' && unknown.kind === 'TERMINAL') {
    expect(recovered.executionTimeMs).toBe(1000);
    expect(recovered.orderUpdatedAtMs).toBe(4000);
    expect(unknown.executionTimeMs).toBeNull();
  }
});
