/** 席位激活首次内部错误先同步关门；真实行情串行退订与 worker 排空不得延后 fatal 或遗失 retain。 */
import { describe, expect, it, spyOn } from 'bun:test';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createMonitorTaskProcessor } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/index.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createQuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/index.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskProcessor,
} from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createMonitorContext } from '../../helpers/asyncProgram.js';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
} from '../../helpers/testDoubles.js';
import { createBrokerIngressFixture } from '../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createSeatActivationFixture } from './fixtures.js';

describe('SeatActivationWorkflow immediate fatal', () => {
  it('真实 history 正量零价首次失败时，在 release 等待串行退订期间关闭双 gate，随后完整排空并保留原错', async () => {
    const nowMs = Date.parse('2026-03-13T03:00:00.000Z');
    const input = {
      orderId: 'F03-ACTIVATION',
      symbol: 'BULL.HK',
      stockName: 'HSI RC',
      remark: '',
      side: 'BUY' as const,
      status: 'New' as const,
      quantity: '10',
      executedQuantity: '0',
      submittedPrice: '1',
      executedPrice: '0',
      submittedAtMs: nowMs - 2_000,
      updatedAtMs: nowMs - 1_000,
    };
    const native = await createBrokerIngressFixture(input);
    native.setOrderSnapshotReplies(
      [{ ...input, status: 'Canceled', executedQuantity: '10' }],
      [],
    );
    const port = native.ports.createOrderSnapshotReadPort({
      rateLimiter: { throttle: async () => {} },
    });
    const historyEntered = Promise.withResolvers<undefined>();
    const historyResponse = Promise.withResolvers<undefined>();
    let mapperFailure: unknown;
    const recorder = createOrderRecorder({
      logger: createLoggerDouble(),
      orderSnapshotReadPort: {
        fetchSnapshots: async () => {
          historyEntered.resolve();
          await historyResponse.promise;
          try {
            return await port.fetchSnapshots();
          } catch (error) {
            mapperFailure = error;
            throw error;
          }
        },
      },
      settlementRefreshNeedRecorder: { recordSettlementRefreshNeed: () => {} },
    });
    recorder.commitExecutionFact(
      {
        brokerOrderId: input.orderId,
        symbol: input.symbol,
        side: 'BUY',
        cumulativeQuantity: 10,
        cumulativeAmount: '10',
        executionTimeMs: nowMs - 1_000,
        updatedAtMs: nowMs - 1_000,
        phase: 'TERMINAL',
      },
      true,
      [],
      () => 'ADMITTED',
    );
    const known = recorder.getExecutionFact(input.orderId);
    const config = createMonitorConfigDouble();
    const symbolRegistry = createSymbolRegistry(config);
    symbolRegistry.updateSeatState('LONG', {
      ...symbolRegistry.getSeatState('LONG'),
      symbol: 'BULL.HK',
      status: 'ACTIVATING',
      callPrice: '20000',
    });
    const context = createMonitorContext({ config, symbolRegistry, orderRecorder: recorder });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const closedGates: string[] = [];
    const secondaryErrors: unknown[] = [];
    let processor: MonitorTaskProcessor | null = null;
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      clock: { now: () => new Date(nowMs) },
      diagnostics: createDiagnosticObserverDouble(),
    });
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        closedGates.push('trading');
      },
      closeProducerAdmission: () => {
        closedGates.push('producer');
        queue.close();
      },
      stopProducers: [() => processor?.stop()],
      onSecondaryError: (error) => {
        secondaryErrors.push(error);
      },
    });
    const unsubscribeEntered = Promise.withResolvers<undefined>();
    const unsubscribeResponse = Promise.withResolvers<undefined>();
    const actualSubscriptions = new Set<string>();
    const quoteSubscriptionState = { allTradingSymbols: new Set<string>() };
    const market = createMarketDataClientDouble({
      getQuotes: async () => new Map(),
      subscribeSymbols: async (symbols) => {
        for (const symbol of symbols) actualSubscriptions.add(symbol);
      },
      unsubscribeSymbols: async (symbols) => {
        if (symbols.includes('TEMP.HK')) {
          unsubscribeEntered.resolve();
          await unsubscribeResponse.promise;
        }

        for (const symbol of symbols) actualSubscriptions.delete(symbol);
      },
    });
    const subscriptions = createQuoteSubscriptionRuntime({
      logger: createLoggerDouble(),
      tradingConfig: createTradingConfig({ monitor: config }),
      symbolRegistry,
      marketDataClient: market,
      orderHoldRegistry: {
        getHoldSymbols: () => new Set(),
        onOrderHoldSymbolsChanged: () => () => {},
      },
      quoteSubscriptionState,
      snapshot,
      termination,
    });
    await subscriptions.reconcileFromCurrentTruth();
    subscriptions.start();
    const temporaryOwner = { ownerKey: 'pending-release', reason: 'SEAT_REFRESH_WAIT' as const };
    await subscriptions.retainSymbols({ ...temporaryOwner, symbols: ['TEMP.HK'] });
    const activationReleaseEntered = Promise.withResolvers<undefined>();
    let activationReleased = false;
    const releaseRetain = subscriptions.releaseRetain;
    spyOn(subscriptions, 'releaseRetain').mockImplementation(async (owner) => {
      if (owner.ownerKey !== temporaryOwner.ownerKey) activationReleaseEntered.resolve();

      await releaseRetain(owner);
      if (owner.ownerKey !== temporaryOwner.ownerKey) activationReleased = true;
    });
    const activation = createSeatActivationFixture({
      termination,
      clock: { now: () => new Date(nowMs) },
      monitorContext: context,
      snapshot,
      marketDataClient: market,
      quoteSubscriptionRuntime: subscriptions,
    });
    let retryCount = 0;
    processor = createMonitorTaskProcessor({
      scheduler: {
        scheduleTimer: (callback, delayMs) => {
          retryCount++;
          return setTimeout(callback, delayMs);
        },
        clearTimer: clearTimeout,
      },
      monitorTaskQueue: queue,
      seatActivation: activation,
      handlePeriodicSwitchTask: async () => 'skipped',
      onPeriodicSwitchTaskResult: () => {},
      logger: createLoggerDouble(),
      termination,
    });
    processor.start();
    queue.scheduleLatest({
      type: 'SEAT_REFRESH',
      dedupeKey: 'F03-ACTIVATION',
      data: {
        dayEpoch: snapshot.getView().token.dayEpoch,
        direction: 'LONG',
        seatVersion: symbolRegistry.getSeatVersion('LONG'),
        previousSymbol: 'OLD_BULL.HK',
        nextSymbol: 'BULL.HK',
        callPrice: '20000',
        symbolName: null,
      },
    });
    await historyEntered.promise;
    // 真实 release 命令的退订先占住串行链，激活 finally 的 release 必须等它完成。
    const precedingRelease = subscriptions.releaseRetain(temporaryOwner);
    await unsubscribeEntered.promise;
    historyResponse.resolve();
    await activationReleaseEntered.promise;
    let drained = false;
    const draining = processor.stopAndDrain().then(() => {
      drained = true;
    });
    await Bun.sleep(0);
    const fatalState = termination.getFatalState();
    try {
      expect(mapperFailure).toBeInstanceOf(TypeError);
      expect(fatalState.hasFatalError).toBeTrue();
      if (fatalState.hasFatalError) expect(fatalState.error).toBe(mapperFailure);

      expect(termination.isTerminated()).toBeTrue();
      expect(closedGates).toEqual(['trading', 'producer']);
      expect(activationReleased).toBeFalse();
      expect(drained).toBeFalse();
      expect(actualSubscriptions.has('TEMP.HK')).toBeTrue();
      expect(retryCount).toBe(0);
      expect(native.orderSnapshotReadCounts()).toEqual({ history: 1, today: 0 });
      expect(recorder.getExecutionFact(input.orderId)).toBe(known);
    } finally {
      unsubscribeResponse.resolve();
      await precedingRelease;
      await draining;
      await subscriptions.stopAndDrain();
      await snapshot.waitForIssuedDrain();
    }

    expect(activationReleased).toBeTrue();
    expect(drained).toBeTrue();
    expect(actualSubscriptions).toEqual(new Set());
    expect(quoteSubscriptionState.allTradingSymbols).toEqual(new Set());
    expect(termination.getFatalState()).toBe(fatalState);
    expect(secondaryErrors).toEqual([]);
    expect(closedGates).toEqual(['trading', 'producer']);
    expect(retryCount).toBe(0);
    expect(symbolRegistry.getSeatState('LONG').status).toBe('ACTIVATING');
  });
});
