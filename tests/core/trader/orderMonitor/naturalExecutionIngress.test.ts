/** 已注册SDK WS→同context native ledger→真实Monitor→O/Daily/durable→同H/S；不声明NAPI Order/network能力。 */
import { expect, test } from 'bun:test';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createSymbolRegistryDouble,
} from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../../orderRecorder/executionFixture.js';
import type { OrderStateChangedEvent } from '../../../../src/types/services.js';

const executionTimeMs = Date.parse('2026-10-07T02:00:00.000Z');
const updatedAtMs = executionTimeMs + 30_000;
const price = '1.2345678901234567890123456789';
async function flush() {
  for (let count = 0; count < 100; count++) await Promise.resolve();
}

async function setup(protective: boolean, persistProgress: () => void) {
  const ingress = await createBrokerIngressFixture({
    orderId: 'buy',
    tradeId: 'execution',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: protective ? 'SELL' : 'BUY',
    status: 'Filled',
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1',
    executedPrice: price,
    submittedAtMs: executionTimeMs - 60_000,
    executionTimeMs,
    updatedAtMs,
  });
  const f = createExecutionFixture({ nowMs: executionTimeMs, persistProgress });
  const closed: OrderStateChangedEvent[] = [];
  const monitor = ingress.createMonitor({
    rateLimiter: f.rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    marketDataClient: createMarketDataClientDouble(),
    orderRecorder: f.recorder,
    dailyLossTracker: f.daily,
    orderHoldRegistry: f.holds,
    protectiveLiquidationEpisodeTracker: f.episode,
    persistProtectiveLiquidationExecutionProgress: persistProgress,
    postTradeConsistencyRuntime: f.sink,
    tradingConfig: createTradingConfig(),
    symbolRegistry: createSymbolRegistryDouble(),
    isContinuousTradingAllowed: () => false,
    termination: f.termination,
    now: () => new Date(executionTimeMs),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  monitor.onOrderStateChanged((event) => {
    closed.push(event);
  });
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  monitor.trackOrder({
    orderId: 'buy',
    symbol: 'BULL.HK',
    side: ingress.queryObservation.executionSide,
    executionSide: ingress.queryObservation.executionSide,
    price: '1',
    initialSubmittedPrice: '1',
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: protective,
    orderType: ingress.queryObservation.orderType,
  });

  if (protective)
    f.recorder.submitSellOrder('buy', 'BULL.HK', 'LONG', 100, [], true, executionTimeMs - 1000);

  return { f, ingress, monitor, closed };
}

test('natural SDK terminal uses exact economics and T≠revision, duplicate after resources close remains economic no-op', async () => {
  const owner = await setup(false, () => {
    throw new Error('ordinary BUY must not persist protection');
  });
  const generation = owner.f.snapshot.getView().token.snapshotGeneration;
  owner.ingress.emitOrderChanged();
  await flush();
  expect(owner.f.termination.getFatalState()).toEqual({ hasFatalError: false });
  expect(owner.f.recorder.getCostBasis('BULL.HK', true)).toEqual({
    costAmount: '123.45678901234567890123456789',
    quantity: 100,
  });

  expect(owner.f.daily.getExecutionTimeEvidence()[0]).toMatchObject({
    lastExecutionTimeMs: executionTimeMs,
    orderRevisionMs: updatedAtMs,
    phase: 'TERMINAL',
  });
  expect(owner.closed).toHaveLength(1);
  expect(owner.closed[0]?.executedTimeMs).toBe(executionTimeMs);
  expect(owner.f.snapshot.getView().token.snapshotGeneration).toBe(generation + 1);
  const counts = owner.ingress.readCounts();
  expect(counts.today).toBeGreaterThan(1);
  expect(counts.history).toBeGreaterThan(0);
  owner.ingress.emitOrderChanged();
  await flush();
  expect(owner.closed).toHaveLength(1);
  expect(owner.f.snapshot.getView().token.snapshotGeneration).toBe(generation + 1);
  expect(owner.f.termination.getFatalState()).toEqual({ hasFatalError: false });
  await owner.monitor.stopRuntimeAndDrain();
  await owner.monitor.teardown();
});

test('natural protective durable failure preserves original identity and leaves O/daily/pending resources uncommitted', async () => {
  const fault = new Error('natural durable failure');
  const owner = await setup(true, () => {
    throw fault;
  });
  const generation = owner.f.snapshot.getView().token.snapshotGeneration;
  owner.ingress.emitOrderChanged();
  await flush();
  const fatal = owner.f.termination.getFatalState();
  expect(fatal.hasFatalError).toBe(true);
  if (!fatal.hasFatalError)
    throw new Error('durable failure must reach the original termination owner');

  expect(fatal.error).toBe(fault);
  expect(owner.f.recorder.getExecutionFact('buy')).toBeNull();
  expect(owner.f.daily.getExecutionTimeEvidence()).toEqual([]);
  expect(owner.closed).toEqual([]);
  expect(owner.f.snapshot.getView().token.snapshotGeneration).toBe(generation);
  expect(owner.f.recorder.getPendingSellSnapshot()).toHaveLength(1);
  await owner.monitor.stopRuntimeAndDrain();
  await owner.monitor.teardown();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
test('stop invalidates late ingress but awaits both truly issued ledger reads before drain', async () => {
  const today = deferred(),
    history = deferred();
  const owner = await setup(false, () => {
    throw new Error('ordinary ingress must never persist protection');
  });
  const before = owner.ingress.readCounts();
  owner.ingress.setExecutionReadBarriers({ today: today.promise, history: history.promise });
  owner.ingress.emitOrderChanged();
  await flush();
  const issued = owner.ingress.readCounts();
  expect(issued.today - before.today).toBe(1);
  expect(issued.history - before.history).toBe(1);
  let drained = false;
  const drain = owner.monitor.stopRuntimeAndDrain();
  void drain.then(() => {
    drained = true;
  });
  await flush();
  expect(drained).toBe(false);
  today.resolve();
  await flush();
  expect(drained).toBe(false);
  expect(owner.f.recorder.getExecutionFact('buy')).toBeNull();
  history.resolve();
  await drain;
  expect(drained).toBe(true);
  expect(owner.f.recorder.getExecutionFact('buy')).toBeNull();
  expect(owner.f.daily.getExecutionTimeEvidence()).toEqual([]);
  expect(owner.closed).toEqual([]);
  expect(owner.ingress.readCounts()).toEqual(issued);
  await owner.monitor.teardown();
});

test('issued native ledger failure waits for the other actual read and retains original program-error identity after stop', async () => {
  let rejectToday!: (error: unknown) => void;
  const today = new Promise<void>((_resolve, reject) => {
    rejectToday = reject;
  });
  const history = deferred();
  const fault = new TypeError('native today ledger contract failure');
  const owner = await setup(false, () => {
    throw new Error('ordinary BUY must not persist protection');
  });
  const initialGeneration = owner.f.snapshot.getView().token.snapshotGeneration;
  const before = owner.ingress.readCounts();
  owner.ingress.setExecutionReadBarriers({ today, history: history.promise });
  owner.ingress.emitOrderChanged();
  await flush();
  const issued = owner.ingress.readCounts();
  expect(issued.today - before.today).toBe(1);
  expect(issued.history - before.history).toBe(1);
  let drained = false;
  const drain = owner.monitor.stopRuntimeAndDrain();
  void drain.then(() => {
    drained = true;
  });
  rejectToday(fault);
  await flush();
  expect(drained).toBe(false);
  const issuedFatal = owner.f.termination.getFatalState();
  expect(issuedFatal.hasFatalError).toBe(true);
  if (!issuedFatal.hasFatalError)
    throw new Error('issued native program error must be reported immediately');

  expect(issuedFatal.error).toBe(fault);
  expect(owner.f.recorder.getExecutionFact('buy')).toBeNull();
  history.resolve();
  await drain;
  expect(drained).toBe(true);
  const fatal = owner.f.termination.getFatalState();
  expect(fatal.hasFatalError).toBe(true);
  if (!fatal.hasFatalError) throw new Error('issued native error must not be erased by stop');

  expect(fatal.error).toBe(fault);
  expect(owner.f.recorder.getExecutionFact('buy')).toBeNull();
  expect(owner.f.daily.getExecutionTimeEvidence()).toEqual([]);
  expect(owner.closed).toEqual([]);
  expect(owner.f.snapshot.getView().token.snapshotGeneration).toBe(initialGeneration);
  expect(owner.ingress.readCounts()).toEqual(issued);
  await owner.monitor.teardown();
});
