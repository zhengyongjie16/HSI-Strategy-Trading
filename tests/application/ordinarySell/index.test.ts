import {
  createOrderRecorderDouble,
  createMarketDataClientDouble,
  createPositionDouble,
  createQuoteDouble,
  createSignalDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

/** 普通 SELL 用例镜像：真实 readiness/reselect、授权失效、报价重试和 accepted ID 不重提。 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { ORDER_QUOTE_RETRY } from '../../../src/constants/index.js';
import { createSellHarness } from './fixture.js';

import { createTradeMutationUnknownError } from '../../../src/application/orderExecution/tradeMutationErrors.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type {
  SellExecutionAttempt,
  SellExecutionOutcome,
} from '../../../src/application/ordinarySell/types.js';
import type { SettlementReadinessReceipt } from '../../../src/types/settlement.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const currentAttempt: SellExecutionAttempt = { isActive: () => true, retry: null };
function sellSignal() {
  return {
    ...createSignalDouble('SELLCALL', 'BULL.HK'),
    seatVersion: 2,
    triggerTime: new Date('2026-02-16T02:00:00Z'),
  };
}

async function harness(overrides: Parameters<typeof createSellHarness>[0] = {}) {
  const result = await createSellHarness(overrides);
  cleanups.push(result.settlement.stopAndDrain);
  return result;
}

function requireRetry(outcome: SellExecutionOutcome) {
  if (outcome.status !== 'RETRY') throw new Error('expected quote retry');

  return outcome.retry;
}

describe('ordinarySell owner', () => {
  it('waits for genuine S readiness before quote and quantity selection', async () => {
    const deferred: { release?: (receipt: SettlementReadinessReceipt) => void } = {};
    let reads = 0;
    let submits = 0;
    const waiting = new Promise<SettlementReadinessReceipt>((resolve) => {
      deferred.release = resolve;
    });
    const tradeInstances6 = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals, authorization) => {
          expect(authorization()).toBeTrue();
          expect(signals[0]?.quantity).toBe(500);
          submits += 1;
          return { executedOrderIds: ['SELL'], quoteFailures: [] };
        },
      },
    });
    const h = await harness({
      settlement: {
        waitForFresh: () => waiting,
        isCurrent: (receipt) => h.settlement.isCurrent(receipt),
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          reads += 1;
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]);
        },
      }),
      orderRecorder: tradeInstances6.orderRecorder,
      orderExecutor: tradeInstances6.orderExecutor,
    });
    const pending = h.workflow.execute(sellSignal(), currentAttempt);
    await Bun.sleep(1);
    expect(reads).toBe(0);
    if (deferred.release === undefined) throw new Error('readiness release not installed');

    deferred.release(await h.settlement.waitForFresh());
    expect(await pending).toEqual({ status: 'COMPLETED' });
    expect(submits).toBe(1);
  });

  it('reselects positions after quote-await and final execution invalidation without requesting timer retry', async () => {
    let quoteCalls = 0;
    const submitted: number[] = [];

    const tradeInstances7 = createTradeRuntimeDouble();
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          if (quoteCalls === 1) {
            h.setPositions([
              createPositionDouble({ symbol: 'BULL.HK', quantity: 200, availableQuantity: 200 }),
            ]);
            await h.publishPositions();
          }

          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1')]]);
        },
      }),
      orderRecorder: tradeInstances7.orderRecorder,
      orderExecutor: tradeInstances7.orderExecutor,
    });
    spyOn(tradeInstances7.orderExecutor, 'executeSignals').mockImplementation(
      async (signals, authorize) => {
        const quantity = signals[0]?.quantity;
        if (quantity === undefined || quantity === null) throw new Error('quantity missing');

        expect(authorize()).toBeTrue();
        submitted.push(quantity);
        if (submitted.length === 1) {
          h.setPositions([
            createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
          ]);
          await h.publishPositions();
          expect(authorize()).toBeFalse();
          return { executedOrderIds: [], quoteFailures: [] };
        }

        return { executedOrderIds: ['CURRENT-100'], quoteFailures: [] };
      },
    );
    expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({ status: 'COMPLETED' });
    expect(quoteCalls).toBe(3);
    expect(submitted).toEqual([200, 100]);
  });

  it('never resubmits an accepted ID when the receipt becomes obsolete during execution', async () => {
    let submits = 0;

    const tradeInstances8 = createTradeRuntimeDouble();
    const h = await harness({
      orderRecorder: tradeInstances8.orderRecorder,
      orderExecutor: tradeInstances8.orderExecutor,
    });
    spyOn(tradeInstances8.orderExecutor, 'executeSignals').mockImplementation(
      async (_signals, authorize) => {
        submits += 1;
        expect(authorize()).toBeTrue();
        h.setPositions([]);
        await h.publishPositions();
        expect(authorize()).toBeFalse();
        return { executedOrderIds: ['ACCEPTED'], quoteFailures: [] };
      },
    );
    expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({ status: 'COMPLETED' });
    expect(submits).toBe(1);
  });

  it('uses the same bounded retry budget for initial missing quote and explicit final missing quote, reselecting from the original signal', async () => {
    let reads = 0;
    const tradeInstances9 = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals, authorize) => {
          expect(authorize()).toBeTrue();
          const selected = signals[0];
          if (selected === undefined) throw new Error('expected selected input');

          expect(selected.quantity).toBe(500);
          return {
            executedOrderIds: [],
            quoteFailures: [{ signal: selected, kind: 'QUOTE_MISSING' }],
          };
        },
      },
    });
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          reads += 1;
          return reads === 1
            ? new Map()
            : new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1')]]);
        },
      }),
      orderRecorder: tradeInstances9.orderRecorder,
      orderExecutor: tradeInstances9.orderExecutor,
    });
    const first = requireRetry(await h.workflow.execute(sellSignal(), currentAttempt));
    const second = requireRetry(
      await h.workflow.execute(first.signal, { isActive: () => true, retry: first }),
    );
    expect(second.attempts).toBe(2);
    expect(second.dayEpoch).toBe(first.dayEpoch);
    expect(second.signal.quantity).toBeUndefined();
    const exhausted = await h.workflow.execute(second.signal, {
      isActive: () => true,
      retry: { ...second, attempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS },
    });
    expect(exhausted).toEqual({ status: 'COMPLETED' });
  });

  it.each(['INVALID', 'OTHER_SKIP', 'ACCEPTED', 'STALE_EPOCH'] as const)(
    '%s never turns the result into a quote retry',
    async (scenario) => {
      const tradeInstances10 = createTradeRuntimeDouble();
      const h = await harness({
        orderRecorder: tradeInstances10.orderRecorder,
        orderExecutor: tradeInstances10.orderExecutor,
      });
      spyOn(tradeInstances10.orderExecutor, 'executeSignals').mockImplementation(
        async (signals) => {
          const selected = signals[0];
          if (selected === undefined) throw new Error('expected selected input');

          if (scenario === 'STALE_EPOCH')
            await h.snapshot.requestClear({
              reason: 'DAY_CUT',
              dayEpoch: h.snapshot.getView().token.dayEpoch + 1,
            });

          return {
            executedOrderIds: scenario === 'ACCEPTED' ? ['ACCEPTED'] : [],
            quoteFailures:
              scenario === 'OTHER_SKIP'
                ? []
                : [
                    {
                      signal: selected,
                      kind: scenario === 'INVALID' ? 'QUOTE_INVALID' : 'QUOTE_MISSING',
                    },
                  ],
          };
        },
      );

      expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({
        status: 'COMPLETED',
      });
    },
  );

  it('keeps unavailable-but-held facts intact and turns quantity zero into HOLD', async () => {
    let submits = 0;
    const tradeInstances11 = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async () => {
          submits += 1;
          return { executedOrderIds: ['INVALID'], quoteFailures: [] };
        },
      },
    });
    const h = await harness({
      orderRecorder: tradeInstances11.orderRecorder,
      orderExecutor: tradeInstances11.orderExecutor,
    });
    h.setPositions([
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 0 }),
    ]);
    await h.publishPositions();
    const original = h.snapshot.getView();
    expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({ status: 'COMPLETED' });
    expect(submits).toBe(0);
    expect(h.snapshot.getView()).toBe(original);
    expect(original.positions[0]?.quantity).toBe(500);
  });

  it('blocks the original day epoch after day cut while a quote read is pending', async () => {
    let submits = 0;
    const tradeInstances12 = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async () => {
          submits += 1;
          return { executedOrderIds: ['INVALID'], quoteFailures: [] };
        },
      },
    });
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          await h.snapshot.requestClear({
            reason: 'DAY_CUT',
            dayEpoch: h.snapshot.getView().token.dayEpoch + 1,
          });
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]);
        },
      }),
      orderRecorder: tradeInstances12.orderRecorder,
      orderExecutor: tradeInstances12.orderExecutor,
    });
    expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({ status: 'COMPLETED' });
    expect(submits).toBe(0);
  });

  it('passes original trading calendar and remaining cap into timeout selection, without BUY risk calls', async () => {
    const calendar = new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]);
    let selections = 0;
    const tradeInstances13 = createTradeRuntimeDouble({
      orderExecutor: {
        canTradeNow: () => {
          throw new Error('SELL must not enter BUY checks');
        },
        executeSignals: async () => {
          throw new Error('HOLD must not execute');
        },
      },
    });
    const h = await harness({
      config: { smartCloseEnabled: true, smartCloseTimeoutMinutes: 30 },
      getTradingCalendar: () => ({ isHalfDay: false, tradingCalendarSnapshot: calendar }),

      orderRecorder: createOrderRecorderDouble({
        getCostBasis: () => ({ costAmount: '1000', quantity: 500 }),
        selectSellableOrders: (params) => {
          selections += 1;
          if (params.strategy === 'TIMEOUT_ONLY') {
            expect(params.calendarSnapshot).toBe(calendar);
            expect(params.maxSellQuantity).toBe(500);
            expect(params.timeoutMinutes).toBe(30);
          }

          return { orders: [], totalQuantity: 0 };
        },
      }),
      orderExecutor: tradeInstances13.orderExecutor,
    });
    expect(await h.workflow.execute(sellSignal(), currentAttempt)).toEqual({ status: 'COMPLETED' });
    expect(selections).toBe(2);
  });

  it('issues bounded retries only for missing quote, detaches signal and keeps original identity', async () => {
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
    });
    const ids = ['BUY-1'];
    const original = { ...sellSignal(), relatedBuyOrderIds: ids };
    const retry = requireRetry(await h.workflow.execute(original, currentAttempt));
    expect(retry.attempts).toBe(1);
    expect(retry.dayEpoch).toBe(h.snapshot.getView().token.dayEpoch);
    expect(retry.signal.triggerTime).not.toBe(original.triggerTime);
    expect(retry.signal.relatedBuyOrderIds).not.toBe(ids);
    const second = requireRetry(
      await h.workflow.execute(retry.signal, { isActive: () => true, retry }),
    );
    expect(second.attempts).toBe(2);
    h.context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: 12000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    expect(second.isCurrent()).toBeFalse();
  });

  it('exhausts only the application quote retry budget and treats S stop-and-drain as a completed abort', async () => {
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
    });
    const first = requireRetry(await h.workflow.execute(sellSignal(), currentAttempt));
    const exhausted = await h.workflow.execute(first.signal, {
      isActive: () => true,
      retry: { ...first, attempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS },
    });
    expect(exhausted).toEqual({ status: 'COMPLETED' });
    const stopped = await harness();
    stopped.settlement.abortWaiting();
    expect(await stopped.workflow.execute(sellSignal(), currentAttempt)).toEqual({
      status: 'COMPLETED',
    });
  });

  it('surfaces UNKNOWN submission from SELL without retrying or converting it to a normal read failure', async () => {
    const unknown = createTradeMutationUnknownError({
      kind: 'UNKNOWN',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
      cause: new Error('network'),
    });
    let calls = 0;
    const tradeInstances14 = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async () => {
          calls += 1;
          throw unknown;
        },
      },
    });
    const h = await harness({
      orderRecorder: tradeInstances14.orderRecorder,
      orderExecutor: tradeInstances14.orderExecutor,
    });
    await rejects(h.workflow.execute(sellSignal(), currentAttempt), (error) => error === unknown);
    expect(calls).toBe(1);
  });

  it('does not request retry after stop while awaiting quote, or for a nonpositive quote', async () => {
    let active = true;
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          active = false;
          return new Map();
        },
      }),
    });
    expect(await h.workflow.execute(sellSignal(), { isActive: () => active, retry: null })).toEqual(
      { status: 'COMPLETED' },
    );
    const invalid = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0')]]),
      }),
    });
    expect(await invalid.workflow.execute(sellSignal(), currentAttempt)).toEqual({
      status: 'COMPLETED',
    });
  });

  it('retains internal quote error even after the lifecycle closes, and consumes classified external read failure', async () => {
    let active = true;
    const internal = new TypeError('invalid market fact');
    const h = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          active = false;
          throw internal;
        },
      }),
    });
    await rejects(
      h.workflow.execute(sellSignal(), { isActive: () => active, retry: null }),
      (error) => error === internal,
    );
    const external = await createExternalApiRequestError({
      operation: 'QuoteContext.quote',
      attempts: 1,
      cause: new Error('network'),
    });
    const failed = await harness({
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          throw external;
        },
      }),
    });
    expect(await failed.workflow.execute(sellSignal(), currentAttempt)).toEqual({
      status: 'COMPLETED',
    });
  });
});
