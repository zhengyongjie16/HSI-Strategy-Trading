/** 距离换仓独立卖出集成：真实 executor/monitor/settlement，旧单只参与等待，新操作独占回补预算。 */
import { describe, expect, it } from 'bun:test';
import { ORDER_QUOTE_RETRY } from '../../src/constants/common.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { createSwitchWakeupRuntime } from '../../src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createTerminationRuntime } from '../../src/runtime/lifecycle/terminationRuntime.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { waitUntil } from '../helpers/asyncProgram.js';
import {
  captureSwitchSeatAuthorization,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../helpers/seatTestUtils.js';
import {
  createLiquidationCooldownTrackerDouble,
  createMonitorContextDouble,
  createTradeRuntimeDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createPositionDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createHarness } from '../strategies/intradayRegression/runtimeFixtures.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExternalApiRequestError } from '../helpers/createExternalApiRequestError.js';

const T = Date.parse('2026-02-16T02:00:00.000Z');

async function fixture(available = 40) {
  const h = createHarness();
  h.setNow(T);
  const original = {
    orderId: 'OLD',
    symbol: 'OLD_BULL.HK',
    stockName: 'HSI RC',
    remark: 'HSI',
    side: 'SELL' as const,
    orderType: 'ELO' as const,
    status: 'New' as const,
    quantity: String(100 - available),
    executedQuantity: '0',
    submittedPrice: '2',
    executedPrice: '0',
    submittedAtMs: T,
    updatedAtMs: T,
  };
  const native = await createBrokerIngressFixture(original);
  native.setOrderSnapshotReplies([], []);
  const setPositions = (quantity: number, free: number) => {
    native.setStockPositions(
      quantity === 0
        ? []
        : [
            {
              symbol: original.symbol,
              symbolName: 'HSI RC',
              accountChannel: 'HK',
              currency: 'HKD',
              quantity: String(quantity),
              availableQuantity: String(free),
              costPrice: '1',
            },
          ],
    );
  };
  setPositions(100, available);
  let mutationHook: (() => Promise<void>) | null = null;
  const rateLimiter = createRateLimiterDouble({
    onMutationPermitAcquired: async () => {
      await mutationHook?.();
    },
  });
  const account = native.createAccountService({ rateLimiter });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '100000',
    netAssets: '100100',
    availableCash: '100000',
  });
  let gateOpen = true;
  const termination = createTerminationRuntime({
    closeTradingGate: () => {
      gateOpen = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  let assembledMonitor: ReturnType<typeof native.createMonitor> | null = null;
  const f = createExecutionFixture({
    nowMs: T,
    rateLimiter,
    createRecorder: native.createRecorder,
    termination,
    readPort: account,
    getTradeRuntime: () => {
      if (assembledMonitor === null) throw new Error('monitor not assembled');

      return createTradeRuntimeDouble({ orderMonitor: assembledMonitor });
    },
    onPositionsCommitted: async () => {},
  });
  const config = createMonitorConfigDouble({
    autoSearchConfig: getDefaultAutoSearchConfig(),
    orderOwnershipMapping: ['HSI'],
  });
  const base = createTradingConfig({ monitor: config });
  const tradingConfig = createTradingConfig({
    monitor: config,
    global: { ...base.global, sellOrderTimeout: { enabled: true, timeoutSeconds: 1 } },
  });
  const registry = createSymbolRegistry(config);
  registry.updateSeatState('LONG', {
    symbol: original.symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: T - 1000,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
    callPrice: '21000',
  });
  let quoteRead: (() => Promise<'VALID' | 'MISSING' | 'INVALID'>) | null = null;
  let candidateBarrier: (() => Promise<void>) | null = null;
  let pendingBarrier: (() => Promise<void>) | null = null;
  const market = createMarketDataClientDouble({
    getQuotes: async (symbols) => {
      const result = (await quoteRead?.()) ?? 'VALID';
      if (result === 'MISSING') return new Map();

      const oldPrice = result === 'INVALID' ? '0' : '2';
      const newPrice = result === 'INVALID' ? '0' : '1';

      return new Map(
        [...symbols].map((symbol) => [
          symbol,
          createQuoteDouble(symbol, symbol === original.symbol ? oldPrice : newPrice, 1),
        ]),
      );
    },
  });
  const risk = createRiskCheckerDouble({
    getWarrantDistanceInfo: () =>
      createWarrantDistanceInfoDouble({
        distanceNumerator: '0.1',
        distanceDenominator: '100',
      }),
  });
  const cache = native.createCacheManager({
    logger: createLoggerDouble(),
    requestExternalApi: wrapExternalApiRequest,
    rateLimiter,
    now: h.deps.clock.now,
  });
  const monitor = native.createMonitor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait,
    requestExternalApi: wrapExternalApiRequest,
    scheduleBoundedOneShotAt,
    now: h.deps.clock.now,
    ...h.deps.scheduler,
    rateLimiter,
    cacheManager: cache,
    marketDataClient: market,
    orderRecorder: f.recorder,
    dailyLossTracker: f.daily,
    orderHoldRegistry: f.holds,
    protectiveLiquidationEpisodeTracker: f.episode,
    persistProtectiveLiquidationExecutionProgress: () => {
      throw new Error('not protective');
    },
    postTradeConsistencyRuntime: f.sink,
    tradingConfig,
    symbolRegistry: registry,
    isContinuousTradingAllowed: () => gateOpen,
    termination,
  });
  assembledMonitor = monitor;
  const executor = native.createExecutor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    rateLimiter,
    cacheManager: cache,
    marketDataClient: market,
    orderRecorder: f.recorder,
    orderMonitor: monitor,
    unrealizedLossBuyGate: risk,
    tradingConfig,
    symbolRegistry: registry,
    isExecutionAllowed: () => gateOpen,
    isContinuousTradingAllowed: () => gateOpen,
    now: h.deps.clock.now,
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-02-16',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  let finalRead: (() => Promise<void>) | null = null;
  let reads = 0;
  const workflow = createSeatSwitchWorkflow({
    logger: createLoggerDouble(),
    monitorConfig: config,
    symbolRegistry: registry,
    marketDataClient: market,
    cacheManager: {
      getPendingOrders: async (symbols, forceRefresh) => {
        await pendingBarrier?.();
        return cache.getPendingOrders(symbols, forceRefresh);
      },
    },
    orderHoldRegistry: f.holds,
    orderMonitor: monitor,
    orderExecutor: executor,
    orderRecorder: f.recorder,
    riskChecker: risk,
    readSwitchPositions: async (symbol) => {
      reads++;
      await finalRead?.();
      return account.getStockPositions({ symbols: [symbol] });
    },
    candidateSearch: {
      resolveDistanceRange: () => config.autoSearchConfig.switchDistanceRangeBull,
      findCandidate: async () => {
        await candidateBarrier?.();
        return createWarrantCandidate('NEW_BULL.HK');
      },
    },
    clock: h.deps.clock,
    getTradingCalendarSnapshot: () =>
      new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
  });
  f.sink.bindBusinessDeps({
    monitorContext: createMonitorContextDouble({
      config,
      symbolRegistry: registry,
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
      riskChecker: risk,
    }),
    dailyLossTracker: f.daily,
    protectiveLiquidationEpisodeTracker: f.episode,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    mixedTradeLogRepository: {
      appendCompletionIdempotent: () => {
        throw new Error('not protective');
      },
    },
  });
  let submits = 0;
  native.setSubmitBehavior(async () => `NEW-${++submits}`);
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  f.commit(
    'BUY-OLD',
    'BUY',
    '1',
    String(100 - available),
    100 - available,
    -2000,
    original.symbol,
    true,
  );

  if (available > 0)
    f.commit('BUY-NEW', 'BUY', '1', String(available), available, -1000, original.symbol, true);

  monitor.trackOrder({
    orderId: 'OLD',
    symbol: original.symbol,
    side: 'SELL',
    executionSide: 'SELL',
    price: '2',
    initialSubmittedPrice: '2',
    quantity: 100 - available,
    submittedAtMs: T,
    isLongSymbol: true,
    monitorSymbol: config.monitorSymbol,
    isProtectiveLiquidation: false,
    orderType: 'ELO',
  });

  f.recorder.submitSellOrder('OLD', original.symbol, 'LONG', 100 - available, ['BUY-OLD'], T);
  const advance = () =>
    workflow.advancePendingSwitch({
      direction: 'LONG',
      positions: [
        createPositionDouble({
          symbol: original.symbol,
          quantity: 100,
          availableQuantity: available,
        }),
      ],
      canContinue: captureSwitchSeatAuthorization(registry, 'LONG'),
    });
  const start = async () => {
    await workflow.startSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [
        createPositionDouble({
          symbol: original.symbol,
          quantity: 100,
          availableQuantity: available,
        }),
      ],
      canContinue: captureSwitchSeatAuthorization(registry, 'LONG'),
    });
    return advance();
  };
  let revision = 0;
  const settle = async (
    id: string,
    quantity: number,
    fill: number,
    status: 'Filled' | 'Canceled' | 'Rejected',
    price = '2',
  ) => {
    const at = T + 100 + ++revision;

    native.emitOrderChangedFrame({
      ...original,
      orderId: id,
      quantity: String(quantity),
      status,
      executedQuantity: String(fill),
      executedPrice: fill === 0 ? '0' : price,
      updatedAtMs: at,
    });
    await waitUntil(() => monitor.getSellOperationState(id) !== 'PENDING');
  };
  return {
    h,
    native,
    original,
    monitor,
    workflow,
    registry,
    f,
    executor,
    termination,
    market,
    setPositions,
    start,
    advance,
    settle,
    getReads: () => reads,
    setQuoteRead: (read: (() => Promise<'VALID' | 'MISSING' | 'INVALID'>) | null) => {
      quoteRead = read;
    },
    setCandidateBarrier: (barrier: (() => Promise<void>) | null) => {
      candidateBarrier = barrier;
    },
    setPendingBarrier: (barrier: (() => Promise<void>) | null) => {
      pendingBarrier = barrier;
    },
    setMutationHook: (hook: (() => Promise<void>) | null) => {
      mutationHook = hook;
    },
    setFinalRead: (read: (() => Promise<void>) | null) => {
      finalRead = read;
    },
    isGateOpen: () => gateOpen,
    close: async () => {
      await monitor.stopRuntimeAndDrain();
      await monitor.teardown();
      await f.sink.stopAndDrain();
    },
  };
}

describe('distance switch independent sell operations', () => {
  it.each([true, false])(
    'leaves old 60 untouched, submits independent realtime 40; oldFirst=%s',
    async (oldFirst) => {
      const x = await fixture();
      try {
        await x.start();
        expect(x.native.nativeSubmitObservations()).toMatchObject([
          { side: 'SELL', quantity: '40', orderType: 'ELO' },
        ]);
        expect(x.native.nativeCancelOrderIds()).toHaveLength(0);
        expect(
          x.native.nativeMutations().filter((mutation) => mutation.kind === 'REPLACE'),
        ).toHaveLength(0);

        expect(
          x.monitor
            .getPendingSellOrders(x.original.symbol)
            .map((order) => [order.orderId, order.submittedQuantity]),
        ).toEqual([
          ['OLD', 60],
          ['NEW-1', 40],
        ]);
        const first = oldFirst ? 'OLD' : 'NEW-1';
        await x.settle(first, oldFirst ? 60 : 40, oldFirst ? 60 : 40, 'Filled');
        await x.advance();
        expect(x.registry.getSeatState('LONG').symbol).toBe(x.original.symbol);
        expect(x.getReads()).toBe(0);
        await x.settle(
          oldFirst ? 'NEW-1' : 'OLD',
          oldFirst ? 40 : 60,
          oldFirst ? 40 : 60,
          'Filled',
        );
        x.setPositions(0, 0);
        await x.advance();
        await x.advance();
        expect(x.native.nativeSubmitObservations()).toMatchObject([
          { side: 'SELL', quantity: '40' },
          { side: 'BUY', quantity: '80', symbol: 'NEW_BULL.HK' },
        ]);
        expect(x.registry.getSeatState('LONG').status).toBe('ACTIVATING');
      } finally {
        await x.close();
      }
    },
  );

  it('all quantity occupied: no new SELL, old-only proceeds are excluded and rebuy is skipped', async () => {
    const x = await fixture(0);
    try {
      await x.start();
      expect(x.native.nativeSubmitObservations()).toHaveLength(0);
      await x.settle('OLD', 100, 100, 'Filled');
      x.setPositions(0, 0);
      await x.advance();
      expect(x.native.nativeSubmitObservations()).toHaveLength(0);
      expect(x.registry.getSeatState('LONG')).toMatchObject({
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVATING',
      });
    } finally {
      await x.close();
    }
  });

  it.each([
    { fill: 0, status: 'Rejected' as const },
    { fill: 0, status: 'Canceled' as const },
    { fill: 10, status: 'Canceled' as const },
  ])(
    'ACK then %p with remaining position throws without reselling or binding',
    async ({ fill, status }) => {
      const x = await fixture();
      try {
        await x.start();
        await x.settle('OLD', 60, 60, 'Filled');
        await x.settle('NEW-1', 40, fill, status);
        x.setPositions(40 - fill, 40 - fill);
        expect(x.advance()).rejects.toThrow('等待人工处理');
        expect(x.advance()).rejects.toThrow('等待人工处理');
        expect(x.registry.getSeatState('LONG')).toMatchObject({
          symbol: x.original.symbol,
          status: 'SWITCHING',
        });
        expect(x.native.nativeSubmitObservations()).toHaveLength(1);
      } finally {
        await x.close();
      }
    },
  );

  it('external final read failure and facts changing during final read cannot falsely declare residual or flat', async () => {
    const x = await fixture();
    try {
      await x.start();
      await x.settle('OLD', 60, 60, 'Filled');
      await x.settle('NEW-1', 40, 40, 'Filled');
      x.setFinalRead(async () => {
        throw await createExternalApiRequestError({
          operation: 'TradeContext.stockPositions',
          attempts: 1,
          cause: new Error('offline'),
        });
      });
      {
        const result = await x.advance();
        expect(result.driveResult.kind).toBe('WAIT');
      }
      x.setFinalRead(async () => {
        x.setFinalRead(null);
        x.monitor.trackOrder({
          orderId: 'LATE',
          symbol: x.original.symbol,
          side: 'SELL',
          executionSide: 'SELL',
          price: '2',
          initialSubmittedPrice: '2',
          quantity: 1,
          submittedAtMs: T,
          isLongSymbol: true,
          monitorSymbol: 'HSI.HK',
          isProtectiveLiquidation: false,
          orderType: 'ELO',
        });
      });
      {
        const result = await x.advance();
        expect(result.driveResult.kind).toBe('WAIT');
      }
      expect(x.registry.getSeatState('LONG').symbol).toBe(x.original.symbol);
      await x.settle('LATE', 1, 0, 'Canceled');
      x.setPositions(0, 0);
      await x.advance();
      expect(x.registry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    } finally {
      await x.close();
    }
  });

  it.each([false, true])(
    'entry handoff not ACKed stays pending; rejected MO wakes switch to residual fatal, beforeStart=%s',
    async (beforeStart) => {
      const x = await fixture(0);
      const cancelIssued = Promise.withResolvers<undefined>();
      const cancelRelease = Promise.withResolvers<undefined>();
      const moIssued = Promise.withResolvers<undefined>();
      const moRelease = Promise.withResolvers<string>();
      const changed: string[] = [];
      x.monitor.onSellOperationChanged((symbol) => {
        changed.push(symbol);
      });

      try {
        if (!beforeStart) await x.start();

        x.native.setCancelBeforeReply(async () => {
          cancelIssued.resolve();
          await cancelRelease.promise;
        });

        x.native.setSubmitBehavior(async () => {
          moIssued.resolve();
          return moRelease.promise;
        });
        x.monitor.startRuntime();
        await waitUntil(() => x.h.timers.some((timer) => !timer.cleared && timer.delay === 1000));
        x.h.setNow(T + 1001);
        for (const timer of [...x.h.timers].filter(
          (entry) => !entry.cleared && entry.delay === 1000,
        ))
          timer.callback();

        await cancelIssued.promise;
        x.native.emitOrderChangedFrame({
          ...x.original,
          status: 'Canceled',
          updatedAtMs: T + 1100,
        });
        cancelRelease.resolve();
        await moIssued.promise;
        let starting: ReturnType<typeof x.start> | null = null;
        if (beforeStart) {
          starting = x.start();
          // 入场读单等待同一 FIFO permit，但已捕获的旧操作身份不能在此窗口丢失。
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
        }

        expect(x.monitor.getSellOperationState('OLD')).toBe('PENDING');
        if (!beforeStart) {
          const result = await x.advance();
          expect(result.driveResult.kind).toBe('WAIT');
        }

        expect(x.getReads()).toBe(beforeStart ? 0 : 1);
        x.setPositions(100, 100);
        moRelease.reject(Object.assign(new Error('broker rejected'), { code: 601013 }));
        if (starting !== null) expect(starting).rejects.toThrow('等待人工处理');

        await waitUntil(() => changed.length === 1);
        expect(x.monitor.getSellOperationState('OLD')).toBe('SETTLED_WITH_REMAINDER');
        x.setPositions(100, 100);
        expect(x.advance()).rejects.toThrow('等待人工处理');
        expect(x.native.nativeSubmitObservations()).toHaveLength(1);
        expect(x.registry.getSeatState('LONG').symbol).toBe(x.original.symbol);
      } finally {
        cancelRelease.resolve();
        moRelease.resolve('MO');
        await x.close();
      }
    },
  );

  it('issued submit REJECTED is final, not a second sell attempt', async () => {
    const x = await fixture();
    try {
      x.native.setSubmitBehavior(async () => {
        throw Object.assign(new Error('rejected'), { code: 601013 });
      });
      await x.start();
      await x.settle('OLD', 60, 60, 'Filled');
      x.setPositions(40, 40);
      expect(x.advance()).rejects.toThrow('等待人工处理');
      expect(x.advance()).rejects.toThrow('等待人工处理');
      expect(x.native.nativeSubmitObservations()).toHaveLength(1);
    } finally {
      await x.close();
    }
  });

  it('real switch wakeup catches residual error and synchronously closes the global trading gate', async () => {
    const x = await fixture();
    const monitorContext = { symbolRegistry: x.registry, seatSwitch: x.workflow };
    const runtime = createSwitchWakeupRuntime({
      logger: createLoggerDouble(),
      marketDataClient: x.market,
      orderMonitor: x.monitor,
      symbolRegistry: x.registry,
      monitorContext,
      tradingTimeState: { canTrade: true, isHalfDay: false },
      lifecycleState: { isTradingEnabled: true },
      snapshot: x.f.snapshot,
      postTradeConsistencyRuntime: x.f.sink,
      tradingGateEventRuntime: { onGateStateChanged: () => () => {} },
      doomsdayProtectionEnabled: false,
      now: x.h.deps.clock.now,
      ...x.h.deps.scheduler,
      termination: x.termination,
    });
    try {
      x.f.sink.start();
      await x.f.sink.waitForFresh();
      await x.start();
      await x.settle('OLD', 60, 60, 'Filled');
      await x.settle('NEW-1', 40, 0, 'Rejected');
      x.setPositions(40, 40);
      await x.f.sink.waitForFresh();
      runtime.start();
      runtime.handoffPendingSwitch({
        direction: 'LONG',
        monitorContext,
        driveResult: {
          kind: 'WAIT',
          wakeups: [{ kind: 'RETRY_TIMER', atMs: T }],
        },
      });

      for (const timer of x.h.timers.filter((entry) => !entry.cleared && entry.delay === 0))
        timer.callback();

      await waitUntil(() => x.termination.isTerminated());
      expect(x.isGateOpen()).toBeFalse();
      expect(x.registry.getSeatState('LONG')).toMatchObject({
        symbol: x.original.symbol,
        status: 'SWITCHING',
      });
      expect(x.native.nativeSubmitObservations()).toHaveLength(1);
    } finally {
      await runtime.stopAndDrain();
      await x.close();
    }
  });

  it('uses all realtime broker available rather than stale signal/snapshot quantity', async () => {
    const x = await fixture();
    try {
      x.setPositions(120, 60);
      await x.start();
      expect(x.native.nativeSubmitObservations()).toMatchObject([{ side: 'SELL', quantity: '60' }]);
      expect(x.native.nativeCancelOrderIds()).toHaveLength(0);
    } finally {
      await x.close();
    }
  });

  it.each([true, false])(
    'new operation MO successor participates in wait and budget, filled=%s',
    async (filled) => {
      const x = await fixture();
      const cancelIssued = Promise.withResolvers<undefined>();
      const cancelRelease = Promise.withResolvers<undefined>();
      const moIssued = Promise.withResolvers<undefined>();
      const moRelease = Promise.withResolvers<string>();
      try {
        await x.start();
        await x.settle('OLD', 60, 60, 'Filled');
        x.native.setCancelBeforeReply(async () => {
          cancelIssued.resolve();
          await cancelRelease.promise;
        });

        x.native.setSubmitBehavior(async () => {
          moIssued.resolve();
          return moRelease.promise;
        });
        x.monitor.startRuntime();
        await waitUntil(() => x.h.timers.some((timer) => !timer.cleared && timer.delay === 1000));
        x.h.setNow(T + 1001);
        for (const timer of x.h.timers.filter((entry) => !entry.cleared && entry.delay === 1000))
          timer.callback();

        await cancelIssued.promise;
        x.native.emitOrderChangedFrame({
          ...x.original,
          orderId: 'NEW-1',
          quantity: '40',
          status: 'Canceled',
          updatedAtMs: T + 1100,
        });
        cancelRelease.resolve();
        await moIssued.promise;
        expect(x.monitor.getSellOperationState('NEW-1')).toBe('PENDING');
        const waiting = await x.advance();
        expect(waiting.driveResult.kind).toBe('WAIT');
        expect(x.getReads()).toBe(0);
        moRelease.resolve('MO');
        await waitUntil(() =>
          x.monitor.getPendingSellOrders(x.original.symbol).some((order) => order.orderId === 'MO'),
        );
        expect(x.monitor.getSellOperationOrderIds('NEW-1')).toEqual(['NEW-1', 'MO']);
        const pendingMo = await x.advance();
        expect(pendingMo.driveResult.kind).toBe('WAIT');
        await x.settle('MO', 40, filled ? 40 : 0, filled ? 'Filled' : 'Rejected', '3');
        x.setPositions(filled ? 0 : 40, filled ? 0 : 40);
        if (filled) {
          x.native.setSubmitBehavior(async () => 'REBUY');
          await x.advance();
          await x.advance();
          expect(x.native.nativeSubmitObservations().at(-1)).toMatchObject({
            side: 'BUY',
            quantity: '120',
          });
        } else {
          expect(x.advance()).rejects.toThrow('等待人工处理');
          expect(x.native.nativeSubmitObservations()).toHaveLength(2);
        }
      } finally {
        cancelRelease.resolve();
        moRelease.resolve('MO');
        await x.close();
      }
    },
  );

  it('availability guard invalidation before mutation rereads without double-submitting or double-counting broker availability', async () => {
    const x = await fixture();
    try {
      x.setMutationHook(async () => {
        x.setMutationHook(null);
        x.monitor.trackOrder({
          orderId: 'LATE',
          symbol: x.original.symbol,
          side: 'SELL',
          executionSide: 'SELL',
          price: '2',
          initialSubmittedPrice: '2',
          quantity: 20,
          submittedAtMs: T,
          isLongSymbol: true,
          monitorSymbol: 'HSI.HK',
          isProtectiveLiquidation: false,
          orderType: 'ELO',
        });
        x.setPositions(100, 20);
      });
      await x.start();
      expect(x.native.nativeSubmitObservations()).toHaveLength(0);
      await x.advance();
      await x.advance();
      expect(x.native.nativeSubmitObservations()).toMatchObject([{ side: 'SELL', quantity: '20' }]);
      expect(x.native.nativeCancelOrderIds()).toHaveLength(0);
    } finally {
      await x.close();
    }
  });

  it('snapshot/caller authorization changing during final position read cannot turn that obsolete result into fatal or bind', async () => {
    const x = await fixture();
    try {
      await x.start();
      await x.settle('OLD', 60, 60, 'Filled');
      await x.settle('NEW-1', 40, 40, 'Filled');
      let current = true;
      const seatAuthorization = captureSwitchSeatAuthorization(x.registry, 'LONG');
      x.setFinalRead(async () => {
        current = false;
      });
      const obsolete = await x.workflow.advancePendingSwitch({
        direction: 'LONG',
        positions: [],
        canContinue: () => current && seatAuthorization(),
      });
      expect(obsolete.driveResult.kind).toBe('NOOP');
      expect(x.registry.getSeatState('LONG').symbol).toBe(x.original.symbol);
      expect(x.termination.isTerminated()).toBeFalse();
      x.setFinalRead(null);
      x.setPositions(0, 0);
      await x.advance();
      expect(x.registry.getSeatState('LONG').symbol).toBe('NEW_BULL.HK');
    } finally {
      await x.close();
    }
  });

  it.each(['INVALID', 'MISSING', 'EXTERNAL', 'EXECUTION_MISSING'] as const)(
    'SELL_OUT %s never clears an occupied old seat; exhaustion converges through settlement and residual fatal',
    async (failure) => {
      const x = await fixture();
      let quotes = 0;
      try {
        const external = await createExternalApiRequestError({
          operation: 'getQuotes',
          attempts: 1,
          cause: new Error('offline'),
        });
        x.setQuoteRead(async () => {
          quotes++;
          if (failure === 'EXTERNAL') throw external;

          if (failure === 'EXECUTION_MISSING') return quotes % 2 === 0 ? 'MISSING' : 'VALID';

          return failure;
        });
        await x.start();
        for (let i = 1; i <= ORDER_QUOTE_RETRY.MAX_ATTEMPTS; i++) {
          x.h.setNow(T + i * ORDER_QUOTE_RETRY.INTERVAL_MS);
          const result = await x.advance();
          expect(result.driveResult.kind).toBe('WAIT');
          expect(x.registry.getSeatState('LONG')).toMatchObject({
            symbol: x.original.symbol,
            status: 'SWITCHING',
          });
        }

        expect(x.monitor.getSellOperationState('OLD')).toBe('PENDING');
        expect(x.isGateOpen()).toBeTrue();
        expect(x.native.nativeSubmitObservations()).toHaveLength(0);
        x.setQuoteRead(null);
        await x.settle('OLD', 60, 60, 'Filled');
        x.setPositions(40, 40);
        expect(x.advance()).rejects.toThrow('等待人工处理');
        expect(x.advance()).rejects.toThrow('operations=["OLD"]');
        expect(x.registry.getSeatState('LONG')).toMatchObject({
          symbol: x.original.symbol,
          status: 'SWITCHING',
        });
        expect(x.native.nativeSubmitObservations()).toHaveLength(0);
      } finally {
        await x.close();
      }
    },
  );

  it.each(['CANDIDATE', 'PENDING_ORDERS'] as const)(
    'captures SELL born and authoritatively canceled/rejected entirely inside %s admission await',
    async (window) => {
      const x = await fixture();
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      try {
        // 既往已经完成的 OLD 不属于本次入场窗口，窗口内新增的 NEW-1 才是必须保留的失败证据。
        await x.settle('OLD', 60, 60, 'Filled');
        x.setPositions(40, 40);
        const barrier = async () => {
          entered.resolve();
          await release.promise;
        };

        if (window === 'CANDIDATE') x.setCandidateBarrier(barrier);
        else x.setPendingBarrier(barrier);

        const starting = x.start();
        await entered.promise;
        const signal = {
          symbol: x.original.symbol,
          symbolName: 'old',
          action: 'SELLCALL' as const,
          quantity: 40,
          triggerTime: new Date(T),
          seatVersion: x.registry.getSeatVersion('LONG'),
          reason: 'independent ordinary sell',
        };
        const ordinary = await x.executor.executeSignals(
          [signal],
          captureSwitchSeatAuthorization(x.registry, 'LONG'),
        );
        expect(ordinary.executedOrderIds).toEqual(['NEW-1']);
        await x.settle('NEW-1', 40, 0, window === 'CANDIDATE' ? 'Canceled' : 'Rejected');
        expect(x.monitor.getUnsettledSellOrderIds(x.original.symbol)).toEqual([]);
        expect(x.monitor.getSellOperationState('NEW-1')).toBe('SETTLED_WITH_REMAINDER');
        release.resolve();
        expect(starting).rejects.toThrow('等待人工处理');
        expect(x.registry.getSeatState('LONG')).toMatchObject({
          symbol: x.original.symbol,
          status: 'SWITCHING',
        });
        expect(x.native.nativeSubmitObservations()).toHaveLength(1);
        expect(x.advance()).rejects.toThrow('NEW-1');
      } finally {
        release.resolve();
        await x.close();
      }
    },
  );

  it('SELL_OUT invalid quote followed by authoritative flat completes without a sell or rebuy budget', async () => {
    const x = await fixture();
    try {
      x.setQuoteRead(async () => 'INVALID');
      const result = await x.start();
      expect(result.driveResult.kind).toBe('WAIT');
      expect(x.registry.getSeatState('LONG')).toMatchObject({
        symbol: x.original.symbol,
        status: 'SWITCHING',
      });
      await x.settle('OLD', 60, 60, 'Filled');
      x.setPositions(0, 0);
      const completed = await x.advance();
      expect(completed.driveResult.kind).toBe('COMPLETED');
      expect(x.registry.getSeatState('LONG')).toMatchObject({
        symbol: 'NEW_BULL.HK',
        status: 'ACTIVATING',
      });
      expect(x.native.nativeSubmitObservations()).toHaveLength(0);
    } finally {
      await x.close();
    }
  });

  it.each(['ZERO_CANCEL', 'HANDOFF_REJECTED'] as const)(
    'latches real %s while WAIT is returning, without another timer/event or manual advance',
    async (source) => {
      const x = await fixture();
      const waitReturned = Promise.withResolvers<undefined>();
      const installWait = Promise.withResolvers<undefined>();
      const cancelIssued = Promise.withResolvers<undefined>();
      const releaseCancel = Promise.withResolvers<undefined>();
      const releaseChanged = Promise.withResolvers<undefined>();
      let advances = 0;
      let runtimeTimers = 0;
      let firedTimers = 0;
      let orderEvents = 0;
      let releaseEvents = 0;
      let freshEvents = 0;
      x.monitor.onOrderStateChanged(() => {
        orderEvents++;
      });

      x.monitor.onSellOperationChanged(() => {
        releaseEvents++;
        releaseChanged.resolve();
      });
      const monitorContext = {
        symbolRegistry: x.registry,
        seatSwitch: {
          ...x.workflow,
          advancePendingSwitch: async (
            params: Parameters<typeof x.workflow.advancePendingSwitch>[0],
          ) => {
            advances++;
            const result = await x.workflow.advancePendingSwitch(params);
            if (advances === 1) {
              expect(result.driveResult.kind).toBe('WAIT');
              expect(x.monitor.getSellOperationState('OLD')).toBe('PENDING');
              waitReturned.resolve();
              // 只暂停生产结果回传，不制造 WAIT/订单结果；模拟嵌套 await 返回到 runtime 前的窗口。
              await installWait.promise;
            }

            return result;
          },
        },
      };
      const runtime = createSwitchWakeupRuntime({
        logger: createLoggerDouble(),
        marketDataClient: x.market,
        // handoff 用例只订阅真实 release 通道，防止先前原单终态事件替它“代唤醒”。
        orderMonitor:
          source === 'ZERO_CANCEL'
            ? x.monitor
            : {
                onOrderStateChanged: () => () => {},
                onSellOperationChanged: x.monitor.onSellOperationChanged,
              },
        symbolRegistry: x.registry,
        monitorContext,
        tradingTimeState: { canTrade: true, isHalfDay: false },
        lifecycleState: { isTradingEnabled: true },
        snapshot: x.f.snapshot,
        postTradeConsistencyRuntime: x.f.sink,
        tradingGateEventRuntime: { onGateStateChanged: () => () => {} },
        doomsdayProtectionEnabled: false,
        now: x.h.deps.clock.now,
        clearTimer: x.h.deps.scheduler.clearTimer,
        scheduleTimer: (callback, delay) => {
          runtimeTimers++;
          return x.h.deps.scheduler.scheduleTimer(() => {
            firedTimers++;
            callback();
          }, delay);
        },
        termination: x.termination,
      });
      try {
        x.f.sink.start();
        await x.f.sink.waitForFresh();
        x.f.sink.onFreshReached(() => {
          freshEvents++;
        });
        x.setQuoteRead(async () => 'INVALID');
        const started = await x.workflow.startSwitchOnDistance({
          direction: 'LONG',
          monitorPrice: '20000',
          positions: x.f.snapshot.getView().positions,
          canContinue: captureSwitchSeatAuthorization(x.registry, 'LONG'),
        });
        if (started.driveResult.kind !== 'WAIT') throw new Error('expected initial timer owner');

        expect(started.driveResult.wakeups).toEqual([{ kind: 'RETRY_TIMER', atMs: T }]);
        runtime.start();
        runtime.handoffPendingSwitch({
          direction: 'LONG',
          monitorContext,
          driveResult: started.driveResult,
        });

        for (const timer of x.h.timers.filter((entry) => !entry.cleared && entry.delay === 0))
          timer.callback();

        await waitReturned.promise;
        expect(advances).toBe(1);
        expect(x.getReads()).toBe(0);
        if (source === 'ZERO_CANCEL') {
          await x.settle('OLD', 60, 0, 'Canceled');
        } else {
          x.native.setCancelBeforeReply(async () => {
            cancelIssued.resolve();
            await releaseCancel.promise;
          });

          x.native.setSubmitBehavior(async () => {
            throw Object.assign(new Error('MO rejected'), { code: 601013 });
          });
          x.monitor.startRuntime();
          await waitUntil(() => x.h.timers.some((timer) => !timer.cleared && timer.delay === 1000));
          x.h.setNow(T + 1001);
          for (const timer of x.h.timers.filter((entry) => !entry.cleared && entry.delay === 1000))
            timer.callback();

          await cancelIssued.promise;
          x.native.emitOrderChangedFrame({
            ...x.original,
            status: 'Canceled',
            updatedAtMs: T + 1100,
          });
          releaseCancel.resolve();
          await releaseChanged.promise;
          expect(releaseEvents).toBe(1);
        }

        expect(orderEvents).toBe(1);
        expect(freshEvents).toBe(0);
        expect(x.monitor.getSellOperationState('OLD')).toBe('SETTLED_WITH_REMAINDER');
        expect(x.monitor.getUnsettledSellOrderIds(x.original.symbol)).toEqual([]);
        expect(x.getReads()).toBe(0);
        installWait.resolve();
        // 此后不再发事件、触发 timer 或调用 advance；只能由 runtime 锁存的 dirty 自动推进。
        await waitUntil(() => x.termination.isTerminated());
        expect(advances).toBe(2);
        expect(runtimeTimers).toBe(1);
        expect(firedTimers).toBe(1);
        expect(x.getReads()).toBe(1);
        expect(x.isGateOpen()).toBeFalse();
        expect(x.registry.getSeatState('LONG')).toMatchObject({
          symbol: x.original.symbol,
          status: 'SWITCHING',
        });
        const submissions = x.native.nativeSubmitObservations();
        if (source === 'ZERO_CANCEL') expect(submissions).toHaveLength(0);
        else expect(submissions).toMatchObject([{ side: 'SELL', orderType: 'MO', quantity: '60' }]);

        expect(submissions.filter((order) => order.orderType !== 'MO')).toHaveLength(0);
      } finally {
        installWait.resolve();
        releaseCancel.resolve();
        await runtime.stopAndDrain();
        await x.close();
      }
    },
  );
});
