/** 普通 SELL 被动诊断：保留原 action、HOLD 原因、延期请求与耗尽，失效事实不增加门禁检查。 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createSellHarness } from './fixture.js';
import { ORDER_QUOTE_RETRY } from '../../../src/constants/common.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createQuoteDouble,
  createSignalDouble,
} from '../../helpers/testDoubles.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { SellHarness } from './types.js';
import type {
  OrdinarySellWorkflowDeps,
  SellExecutionOutcome,
} from '../../../src/application/ordinarySell/types.js';

const harnesses: SellHarness[] = [];

async function harness(overrides: Partial<OrdinarySellWorkflowDeps> = {}): Promise<SellHarness> {
  const result = await createSellHarness({ logger: createLoggerDouble(), ...overrides });
  harnesses.push(result);
  return result;
}

function signal() {
  return {
    ...createSignalDouble('SELLCALL', 'BULL.HK'),
    seatVersion: 2,
    triggerTime: new Date('2026-02-16T02:00:00Z'),
    reason: '原始 SELL 原因',
  };
}

function requireRetry(outcome: SellExecutionOutcome) {
  if (outcome.status !== 'RETRY') throw new Error('expected retry request');

  return outcome.retry;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.settlement.abortWaiting();
    await h.settlement.stopAndDrain();
  }
});

describe.each([false, true])('ordinarySell diagnostics observer throws=%s', (observerThrows) => {
  it('records quantity HOLD with original SELL action and untouched quantity reason', async () => {
    const events: DiagnosticFields[] = [];
    let clockReads = 0;
    let executions = 0;
    const h = await harness({
      diagnostics: {
        record: (operation, fields) => {
          expect(operation).toBe(DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME);
          events.push(fields);
          if (observerThrows) throw new Error('observer failed');
        },
      },
      orderExecutor: {
        executeSignals: async () => {
          executions += 1;
          return { executedOrderIds: [], quoteFailures: [] };
        },
      },
      clock: {
        now: () => {
          clockReads += 1;
          return new Date('2026-02-16T02:00:00Z');
        },
      },
    });
    h.setPositions([]);
    await h.publishPositions();
    const original = signal();
    const outcome = await h.workflow.execute(original, { isActive: () => true, retry: null });
    expect(outcome).toEqual({ status: 'COMPLETED' });
    expect(executions).toBe(0);
    expect(clockReads).toBe(1);
    expect(original.action).toBe('SELLCALL');
    expect(original.reason).toBe('原始 SELL 原因');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'SELL_QUANTITY',
      outcome: 'SKIPPED',
      reasonCode: 'SELL_QUANTITY_HOLD',
      action: 'SELLCALL',
      processedAction: 'HOLD',
      detail: '原始 SELL 原因，持仓或行情数据无效',
      seatVersion: 2,
      triggerTimeMs: original.triggerTime.getTime(),
    });
  });

  it.each([false, true])(
    'requests bounded retry for missing final quote=%s, but does not claim a timer exists',
    async (finalQuoteMissing) => {
      const events: DiagnosticFields[] = [];
      let executions = 0;
      let clockReads = 0;
      const h = await harness({
        diagnostics: {
          record: (_operation, fields) => {
            events.push(fields);
            if (observerThrows) throw new Error('observer failed');
          },
        },
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () =>
            finalQuoteMissing
              ? new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.000000000000000001')]])
              : new Map(),
        }),
        orderExecutor: {
          executeSignals: async (signals) => {
            executions += 1;
            const selected = signals[0];
            if (!selected) throw new Error('expected selected SELL');

            return {
              executedOrderIds: [],
              quoteFailures: [{ signal: selected, kind: 'QUOTE_MISSING' }],
            };
          },
        },
        clock: {
          now: () => {
            clockReads += 1;
            return new Date('2026-02-16T02:00:00Z');
          },
        },
      });
      const original = signal();
      const originDayEpoch = h.snapshot.getView().token.dayEpoch;
      const retry = requireRetry(
        await h.workflow.execute(original, { isActive: () => true, retry: null }),
      );
      expect(retry.attempts).toBe(1);
      expect(retry.delayMs).toBe(ORDER_QUOTE_RETRY.INTERVAL_MS);
      expect(retry.dayEpoch).toBe(originDayEpoch);
      expect(retry.signal).not.toBe(original);
      expect(executions).toBe(finalQuoteMissing ? 1 : 0);
      expect(clockReads).toBe(finalQuoteMissing ? 2 : 1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stage: finalQuoteMissing ? 'SELL_EXECUTION' : 'SELL_QUOTE_ADMISSION',
        outcome: 'DEFERRED',
        reasonCode: 'QUOTE_MISSING',
        action: 'SELLCALL',
        retryAttempts: 1,
        retryDelayMs: ORDER_QUOTE_RETRY.INTERVAL_MS,
        originDayEpoch,
      });
      expect(events[0]).not.toHaveProperty('timerScheduled');

      const exhausted = await h.workflow.execute(retry.signal, {
        isActive: () => true,
        retry: { ...retry, attempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS },
      });
      expect(exhausted).toEqual({ status: 'COMPLETED' });
      expect(clockReads).toBe(finalQuoteMissing ? 4 : 2);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        outcome: 'REJECTED',
        reasonCode: 'QUOTE_RETRY_EXHAUSTED',
        retryAttempts: ORDER_QUOTE_RETRY.MAX_ATTEMPTS,
      });
      expect(original.reason).toBe('原始 SELL 原因');
    },
  );

  it.each([
    'RUN_GENERATION_INVALIDATED',
    'TRADING_DAY_INVALIDATED',
    'SEAT_VERSION_MISMATCH',
    'TRADING_GATE_CLOSED',
  ])(
    'retains the existing post-quote invalidation %s without clock or execution calls',
    async (reasonCode) => {
      const events: DiagnosticFields[] = [];
      let active = true;
      let gateOpen = true;
      let clockReads = 0;
      let executions = 0;
      const h = await harness({
        diagnostics: {
          record: (_operation, fields) => {
            events.push(fields);
            if (observerThrows) throw new Error('observer failed');
          },
        },
        getCanProcessTask: () => gateOpen,
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => {
            if (reasonCode === 'RUN_GENERATION_INVALIDATED') active = false;

            if (reasonCode === 'TRADING_GATE_CLOSED') gateOpen = false;

            if (reasonCode === 'TRADING_DAY_INVALIDATED')
              await h.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 7 });

            if (reasonCode === 'SEAT_VERSION_MISMATCH') {
              h.context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
                symbol: 'BULL.HK',
                status: 'ACTIVE',
                lastSwitchAt: null,
                lastSearchAt: null,
                lastSeatActivatedAt: 12000,
                searchFailCountToday: 0,
                frozenTradingDayKey: null,
              });
            }

            return new Map();
          },
        }),
        orderExecutor: {
          executeSignals: async () => {
            executions += 1;
            return { executedOrderIds: [], quoteFailures: [] };
          },
        },
        clock: {
          now: () => {
            clockReads += 1;
            return new Date('2026-02-16T02:00:00Z');
          },
        },
      });
      const originDayEpoch = h.snapshot.getView().token.dayEpoch;
      expect(await h.workflow.execute(signal(), { isActive: () => active, retry: null })).toEqual({
        status: 'COMPLETED',
      });
      expect(clockReads).toBe(0);
      expect(executions).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stage: 'SELL_AUTHORIZATION',
        outcome: 'ABORTED',
        reasonCode,
        originDayEpoch,
      });

      if (reasonCode === 'TRADING_DAY_INVALIDATED') expect(events[0]?.['currentDayEpoch']).toBe(7);

      if (reasonCode !== 'TRADING_DAY_INVALIDATED')
        expect(events[0]).not.toHaveProperty('currentDayEpoch');
    },
  );

  it.each([
    'RUN_GENERATION_INVALIDATED',
    'TRADING_DAY_INVALIDATED',
    'SEAT_VERSION_MISMATCH',
    'SIGNAL_TRADING_DAY_STALE',
  ])('keeps retry isCurrent short-circuit semantics for %s', async (reasonCode) => {
    const events: DiagnosticFields[] = [];
    let active = true;
    let clockReads = 0;
    let currentTime = new Date('2026-02-16T02:00:00Z');
    const h = await harness({
      diagnostics: {
        record: (_operation, fields) => {
          events.push(fields);
          if (observerThrows) throw new Error('observer failed');
        },
      },
      marketDataClient: createMarketDataClientDouble({ getQuotes: async () => new Map() }),
      clock: {
        now: () => {
          clockReads += 1;
          return currentTime;
        },
      },
    });
    const retry = requireRetry(
      await h.workflow.execute(signal(), { isActive: () => active, retry: null }),
    );
    expect(retry.isCurrent()).toBeTrue();
    expect(events).toHaveLength(1);
    expect(clockReads).toBe(2);

    if (reasonCode === 'RUN_GENERATION_INVALIDATED') active = false;

    if (reasonCode === 'TRADING_DAY_INVALIDATED')
      await h.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: 7 });

    if (reasonCode === 'SEAT_VERSION_MISMATCH') {
      h.context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: 12000,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      });
    }

    if (reasonCode === 'SIGNAL_TRADING_DAY_STALE') currentTime = new Date('2026-02-17T02:00:00Z');

    expect(retry.isCurrent()).toBeFalse();
    expect(clockReads).toBe(reasonCode === 'SIGNAL_TRADING_DAY_STALE' ? 3 : 2);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ outcome: 'ABORTED', reasonCode });
  });

  it('records stop-and-drain cancellation at the existing settlement wait boundary', async () => {
    const events: DiagnosticFields[] = [];
    const h = await harness({
      diagnostics: {
        record: (_operation, fields) => {
          events.push(fields);
          if (observerThrows) throw new Error('observer failed');
        },
      },
    });
    h.settlement.abortWaiting();
    expect(await h.workflow.execute(signal(), { isActive: () => true, retry: null })).toEqual({
      status: 'COMPLETED',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: 'SELL_SETTLEMENT_WAIT',
      outcome: 'ABORTED',
      reasonCode: 'SETTLEMENT_WAIT_ABORTED',
    });
  });
});

it('isolates HOLD diagnostic field construction without changing the quantity decision', async () => {
  let recorded = 0;
  const h = await harness({
    diagnostics: {
      record: () => {
        recorded += 1;
      },
    },
  });
  h.setPositions([]);
  await h.publishPositions();
  const triggerTime = new Date('2026-02-16T02:00:00Z');
  triggerTime.getTime = () => {
    throw new Error('diagnostic field construction');
  };

  expect(
    await h.workflow.execute({ ...signal(), triggerTime }, { isActive: () => true, retry: null }),
  ).toEqual({ status: 'COMPLETED' });
  expect(recorded).toBe(0);
});
