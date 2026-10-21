/** 激活失败策略属于 application：不经 worker/timer 即可裁决一次重试、耗尽 EMPTY 和方向隔离。 */
import { describe, expect, it } from 'bun:test';
import { createSeatActivationFixture } from './fixtures.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createMonitorContext } from '../../helpers/asyncProgram.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createQuoteSubscriptionRuntimeDouble,
} from '../../helpers/testDoubles.js';

describe('SeatActivationWorkflow 失败策略', () => {
  it('独立决定一次外部 retry 和耗尽 EMPTY；不改 SHORT ACTIVE 或全局 generation', async () => {
    const context = createMonitorContext();
    context.symbolRegistry.updateSeatState('LONG', {
      ...context.symbolRegistry.getSeatState('LONG'),
      status: 'ACTIVATING',
      symbol: 'BULL.HK',
      callPrice: '20000',
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const originalGeneration = snapshot.getView().token.snapshotGeneration;
    const shortSeat = context.symbolRegistry.getSeatState('SHORT');
    let calls = 0;
    let releases = 0;
    const error = await createExternalApiRequestError({
      operation: 'getQuotes',
      attempts: 1,
      cause: new Error('network'),
    });
    const closedGates: string[] = [];
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        closedGates.push('trading');
      },
      closeProducerAdmission: () => {
        closedGates.push('producer');
      },
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const workflow = createSeatActivationFixture({
      termination,
      clock: { now: () => new Date('2026-03-13T03:00:00.000Z') },
      monitorContext: context,
      snapshot,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          calls++;
          throw error;
        },
      }),
      quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
        releaseRetain: async () => {
          releases++;
        },
      }),
    });
    const request = {
      dayEpoch: snapshot.getView().token.dayEpoch,
      direction: 'LONG' as const,
      seatVersion: 2,
      previousSymbol: 'OLD_BULL.HK',
      nextSymbol: 'BULL.HK',
      callPrice: '20000',
      symbolName: null,
    };
    const first = await workflow.activate(request, () => true);
    if (first.status !== 'retry') throw new Error('application 必须发行一次 retry 指令');

    expect(first.request).toEqual({ ...request, apiRetryAttempt: 1 });
    expect(first.delayMs).toBeGreaterThan(0);
    expect(first.error).toBe(error);
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
    expect(await workflow.activate(first.request, () => true)).toEqual({ status: 'failed', error });
    expect(context.symbolRegistry.getSeatState('LONG').status).toBe('EMPTY');
    expect(context.symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(context.symbolRegistry.getSeatState('SHORT')).toBe(shortSeat);
    expect(snapshot.getView().token.snapshotGeneration).toBe(originalGeneration);
    expect(calls).toBe(2);
    expect(releases).toBe(2);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
    expect(termination.isTerminated()).toBeFalse();
    expect(closedGates).toEqual([]);
  });
});
