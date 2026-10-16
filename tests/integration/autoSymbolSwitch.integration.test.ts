import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createDailyLossTrackerDouble,
  createTerminationDouble,
  createMonitorContextDouble,
  createLiquidationCooldownTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';

/**
 * auto-symbol-switch 集成测试
 *
 * 功能：
 * - 验证自动换标端到端场景与业务期望。
 */

import { describe, expect, it, setSystemTime } from 'bun:test';
import { createAccountPositionSnapshot } from '../../src/application/accountPositionSnapshot/index.js';
import { createPostTradeConsistencyRuntime } from '../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createAutoSearch } from '../../src/application/autoSearch/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

import {
  captureSearchSeatAuthorization,
  captureSwitchSeatAuthorization,
  createWarrantCandidateWithOverrides,
  createLoggerStub,
} from '../helpers/seatTestUtils.js';

let candidateQueue: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

async function runDistanceSwitch(
  manager: ReturnType<typeof createSeatSwitchWorkflow>,
  symbolRegistry: Parameters<typeof captureSwitchSeatAuthorization>[0],
  params: Omit<
    Parameters<ReturnType<typeof createSeatSwitchWorkflow>['startSwitchOnDistance']>[0],
    'canContinue'
  >,
): Promise<void> {
  const switchParams = {
    ...params,
    canContinue: captureSwitchSeatAuthorization(symbolRegistry, params.direction),
  };
  if (manager.hasPendingSwitch(params.direction)) {
    await manager.advancePendingSwitch(switchParams);
    return;
  }

  const startResult = await manager.startSwitchOnDistance(switchParams);
  if (startResult.started) {
    await manager.advancePendingSwitch({
      ...params,
      canContinue: captureSwitchSeatAuthorization(symbolRegistry, params.direction),
    });
  }
}

describe('auto-symbol-switch integration', () => {
  it('runs empty-seat search then distance-triggered switch with sell->rebuy flow', async () => {
    candidateQueue = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      targetNotional: '5000',
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });

    const symbolRegistry = createSymbolRegistry(monitorConfig);

    symbolRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: null,
    });

    const executedActions: Array<{
      action: string | null | undefined;
      symbol: string | null | undefined;
      quantity: number | null | undefined;
    }> = [];
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async (signals, callerAuthorization) => {
          expect(callerAuthorization()).toBeTrue();
          const signal = signals[0];
          executedActions.push({
            action: signal?.action,
            symbol: signal?.symbol,
            quantity: signal?.quantity,
          });

          if (signal?.action === 'SELLCALL') {
            return { executedOrderIds: ['SELL-ORDER-1'], quoteFailures: [] };
          }

          return { executedOrderIds: ['BUY-ORDER-1'], quoteFailures: [] };
        },
      },
      cacheManager: { getPendingOrders: async () => [] },
      orderMonitor: {
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      },
    });

    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              costAmount: '200',
              executedQuantity: 100,
              executedTime: 9_999_999_999_999,
              submittedAt: undefined,
              updatedAt: undefined,
            }
          : null,
    });

    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol) => {
        if (!isLongSymbol) {
          return null;
        }

        return createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.1',
          distanceDenominator: '100',
        });
      },
    });

    const candidateSearch = {
      resolveDistanceRange: (direction: 'LONG' | 'SHORT') =>
        monitorConfig.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => candidateQueue.shift() ?? null,
    };
    const manager = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
      cacheManager: tradeRuntime.cacheManager,
      orderHoldRegistry: tradeRuntime.orderHoldRegistry,
      orderMonitor: tradeRuntime.orderMonitor,
      orderExecutor: tradeRuntime.orderExecutor,
      orderRecorder,
      riskChecker,
      candidateSearch,
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });
    const autoSearch = createAutoSearch({
      monitorSymbol: monitorConfig.monitorSymbol,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      symbolRegistry,
      candidateSearch,
      logger: createLoggerStub(),
    });

    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canContinue: captureSearchSeatAuthorization(symbolRegistry, 'LONG'),
    });

    const searchedSeat = symbolRegistry.getSeatState('LONG');
    expect(searchedSeat.status).toBe('ACTIVATING');
    expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(2);
    if (searchedSeat.status !== 'ACTIVATING') {
      throw new Error('expected LONG seat to be ACTIVATING');
    }

    symbolRegistry.updateSeatState('LONG', {
      ...searchedSeat,
      status: 'ACTIVE',
      lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: '1',
        },
      ],
    });

    expect(manager.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]?.action).toBe('SELLCALL');

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    expect(executedActions).toHaveLength(1);
    expect(manager.hasPendingSwitch('LONG')).toBeTrue();

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);

    const finalSeat = symbolRegistry.getSeatState('LONG');
    expect(finalSeat.status).toBe('ACTIVATING');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(finalSeat.callPrice).toBe('21000');
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('keeps switch signals on the injected trading day through the real orderExecutor chain', async () => {
    const fixedNowMs = Date.parse('2026-02-16T02:00:00.000Z');
    const hostNowMs = Date.parse('2031-09-20T02:00:00.000Z');
    setSystemTime(hostNowMs);
    try {
      candidateQueue = [
        createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
        createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: '21000' }),
      ];

      const monitorConfig = createMonitorConfigDouble({
        targetNotional: '5000',
        autoSearchConfig: {
          autoSearchEnabled: true,
          autoSearchMinDistancePctBull: '0.35',
          autoSearchMinDistancePctBear: '-0.35',
          autoSearchMinTurnoverPerMinuteBull: '100000',
          autoSearchMinTurnoverPerMinuteBear: '100000',
          autoSearchExpiryMinMonths: 3,
          autoSearchOpenDelayMinutes: 0,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: { min: '0.2', max: '1.5' },
          switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
        },
      });

      const symbolRegistry = createSymbolRegistry(monitorConfig);

      symbolRegistry.updateSeatState('LONG', {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
        callPrice: null,
      });

      // 原 SELL recorder fixture 的独立成交事实为 quantity200 × price1 = amount200；
      // 不从后续 native submission100 推导或重算既有金额 oracle。
      const native = await createBrokerIngressFixture({
        orderId: 'MOCK-000001',
        tradeId: 'SWITCH-SELL-FILL',
        symbol: 'OLD_BULL.HK',
        stockName: 'OLD_BULL',
        remark: 'HSI',
        side: 'SELL',
        status: 'Filled',
        quantity: '200',
        executedQuantity: '200',
        submittedPrice: '1',
        executedPrice: '1',
        submittedAtMs: fixedNowMs - 2000,
        executionTimeMs: fixedNowMs - 1000,
        updatedAtMs: fixedNowMs - 500,
      });
      native.setStockPositions([
        {
          symbol: 'OLD_BULL.HK',
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          quantity: '100',
          availableQuantity: '100',
          costPrice: '1',
        },
      ]);

      native.setAccountBalance({
        currency: 'HKD',
        totalCash: '100000',
        netAssets: '100100',
        availableCash: '100000',
      });
      let nativeSubmits = 0;
      native.setSubmitBehavior(async () => {
        nativeSubmits += 1;
        return nativeSubmits === 1 ? 'MOCK-000001' : 'MOCK-000002';
      });
      const tradingConfig = createTradingConfig({
        monitor: monitorConfig,
      });

      const rateLimiter = createRateLimiterDouble();
      const accountService = native.createAccountService({ rateLimiter });
      const snapshot = createAccountPositionSnapshot({
        dayEpoch: 1,
        scheduler: { schedule: queueMicrotask },
        readPort: accountService,
        reportFatalError: (error) => {
          throw error;
        },
      });
      const committed = await snapshot.requestRefresh({
        source: 'switch-native-baseline',
        dayEpoch: 1,
        refreshAccount: true,
        refreshPositions: true,
      }).result;
      if (committed.status !== 'COMMITTED') throw new Error('expected canonical baseline commit');

      const dailyLossTracker = createDailyLossTrackerDouble();
      const prepared = dailyLossTracker.prepareRecalculationFromAllOrders(
        [],
        monitorConfig,
        new Date(fixedNowMs),
        undefined,
        new Set(['OLD_BULL.HK', 'NEW_BULL.HK']),
      );
      dailyLossTracker.publishRecalculation(prepared);
      let boundTrader: ReturnType<typeof createTradeRuntimeDouble> | null = null;
      const settlement = createPostTradeConsistencyRuntime({
        logger: createLoggerDouble(),
        snapshot,
        termination: createTerminationDouble(),
        getProtectiveOrderReader: () => {
          if (boundTrader === null)
            throw new Error('tradeRuntime must bind before settlement starts');

          return boundTrader.orderMonitor;
        },
        onPositionsCommitted: async (token) => {
          if (!snapshot.isCurrent(token, { account: false, positions: true }))
            throw new Error('stale subscription fact');
        },
        scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
      });
      const orderRecorder = native.createRecorder({
        logger: createLoggerDouble(),
        rateLimiter,
        getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
        settlementRefreshNeedRecorder: settlement,
      });
      const marketDataClient = createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      });
      let rebuyLossGateCalls = 0;
      const riskChecker = createRiskCheckerDouble({
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          rebuyLossGateCalls += 1;
          expect(symbol).toBe('NEW_BULL.HK');
          expect(price).toBe('1');
          expect(isLongSymbol).toBeTrue();
          return { shouldLiquidate: false };
        },
        getWarrantDistanceInfo: (isLongSymbol) => {
          if (!isLongSymbol) {
            return null;
          }

          return createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '0.1',
            distanceDenominator: '100',
          });
        },
      });

      const trackedOrders: Array<{ orderId: string; side: string; quantity: number }> = [];
      const executionGate = { open: true };
      const orderExecutor = native.createExecutor({
        logger: createLoggerDouble(),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient,
        cacheManager: { clearCache: () => {} },
        orderMonitor: createOrderMonitorDouble({
          trackOrder: ({ orderId, side, quantity }) => {
            trackedOrders.push({
              orderId,
              side: side === native.queryObservation.executionSide ? 'SELL' : 'BUY',
              quantity,
            });
          },
        }),
        orderRecorder,
        unrealizedLossBuyGate: riskChecker,
        tradingConfig,
        symbolRegistry,
        isExecutionAllowed: () => executionGate.open,
        isContinuousTradingAllowed: () => executionGate.open,
        now: () => new Date(fixedNowMs),
        readCurrentTradingDayInfo: () => ({
          dateKey: '2026-02-16',
          info: { isTradingDay: true, isHalfDay: false },
        }),
      });

      const generatedTriggerTimes: number[] = [];
      const tradeRuntime = createTradeRuntimeDouble({
        orderExecutor: {
          executeSignals: async (signals, callerAuthorization) => {
            expect(callerAuthorization()).toBeTrue();
            for (const signal of signals) {
              if (!signal.triggerTime) {
                throw new Error('自动换标信号必须包含 triggerTime');
              }

              generatedTriggerTimes.push(signal.triggerTime.getTime());
            }

            const result = await orderExecutor.executeSignals(signals, callerAuthorization);
            if (signals[0]?.action === 'SELLCALL' && result.executedOrderIds[0] === 'MOCK-000001') {
              const [observation] = await native.createQueryOrdersReader('MOCK-000001')();
              if (
                observation?.executedAmount !== '200' ||
                observation.executionTimeMs !== fixedNowMs - 1000 ||
                observation.updatedAtMs !== fixedNowMs - 500
              )
                throw new Error('expected independent SDK execution amount/time');

              native.setStockPositions([]);
              orderRecorder.commitExecutionFact(
                {
                  brokerOrderId: observation.orderId,
                  symbol: observation.symbol,
                  side: 'SELL',
                  cumulativeQuantity: observation.executedQuantity,
                  cumulativeAmount: observation.executedAmount,
                  executionTimeMs: observation.executionTimeMs,
                  updatedAtMs: observation.updatedAtMs,
                  phase: 'TERMINAL',
                },
                true,
                [],
                () =>
                  dailyLossTracker.recordCumulativeExecution({
                    factStage: 'TERMINAL',
                    direction: 'LONG',
                    symbol: observation.symbol,
                    side: 'SELL',
                    executedPrice: '1',
                    executedQuantity: 200,
                    executedTimeMs: fixedNowMs - 1000,
                    orderUpdatedAtMs: fixedNowMs - 500,
                    orderId: observation.orderId,
                  }).admission,
              );
              expect(orderRecorder.getSellRecordByOrderId('MOCK-000001')?.costAmount).toBe('200');
            }

            return result;
          },
        },
        cacheManager: { getPendingOrders: async () => [] },
        orderMonitor: {
          cancelOrder: async () => ({
            kind: 'CANCEL_CONFIRMED',
            relatedBuyOrderIds: null,
          }),
        },
      });

      boundTrader = tradeRuntime;
      const candidateSearch = {
        resolveDistanceRange: (direction: 'LONG' | 'SHORT') =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => candidateQueue.shift() ?? null,
      };
      const manager = createSeatSwitchWorkflow({
        logger: createLoggerStub(),
        monitorConfig,
        symbolRegistry,
        marketDataClient,
        cacheManager: tradeRuntime.cacheManager,
        orderHoldRegistry: tradeRuntime.orderHoldRegistry,
        orderMonitor: tradeRuntime.orderMonitor,
        orderExecutor: tradeRuntime.orderExecutor,
        orderRecorder,
        riskChecker,
        candidateSearch,
        clock: { now: () => new Date(fixedNowMs) },
        getTradingCalendarSnapshot: () =>
          new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
      });
      const autoSearch = createAutoSearch({
        monitorSymbol: monitorConfig.monitorSymbol,
        autoSearchConfig: monitorConfig.autoSearchConfig,
        symbolRegistry,
        candidateSearch,
        logger: createLoggerStub(),
      });

      const monitorContext = createMonitorContextDouble({
        config: monitorConfig,
        symbolRegistry,
        seatSwitch: manager,
        orderRecorder,
        dailyLossTracker,
        riskChecker,
      });
      settlement.bindBusinessDeps({
        monitorContext,
        dailyLossTracker,
        liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
        protectiveLiquidationEpisodeTracker: createProtectiveLiquidationEpisodeTrackerDouble(),
        mixedTradeLogRepository: {
          appendCompletionIdempotent: () => {
            throw new Error('switch is not protective completion');
          },
        },
      });
      settlement.start();
      expect(await settlement.completeRebuildBaseline()).toBeTrue();
      const originalReceipt = await settlement.waitForFresh();
      expect(originalReceipt.snapshotToken).toEqual(committed.snapshotToken);
      const runCanonicalDistance = async (
        params: Parameters<typeof runDistanceSwitch>[2],
      ): Promise<void> => {
        const receipt = await settlement.waitForFresh();
        const capturedSeat = captureSwitchSeatAuthorization(symbolRegistry, 'LONG');
        const originalOrigin = () =>
          executionGate.open &&
          settlement.isCurrent(receipt) &&
          snapshot.isCurrent(receipt.snapshotToken, { account: false, positions: true }) &&
          snapshot.getView().token.dayEpoch === receipt.snapshotToken.dayEpoch;
        if (manager.hasPendingSwitch('LONG')) {
          await manager.advancePendingSwitch({
            ...params,
            canContinue: () => originalOrigin() && capturedSeat(),
          });
          return;
        }

        const started = await manager.startSwitchOnDistance({
          ...params,
          canContinue: () => originalOrigin() && capturedSeat(),
        });
        if (started.started) {
          expect(started.driveResult.publishedRoute?.isCurrent()).toBeTrue();
          const publishedSeat = captureSwitchSeatAuthorization(symbolRegistry, 'LONG');
          await manager.advancePendingSwitch({
            ...params,
            canContinue: () => originalOrigin() && publishedSeat(),
          });
        }
      };
      await autoSearch.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime: new Date(fixedNowMs),
        canContinue: captureSearchSeatAuthorization(symbolRegistry, 'LONG'),
      });

      const searchedSeat = symbolRegistry.getSeatState('LONG');
      expect(searchedSeat.status).toBe('ACTIVATING');
      expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
      if (searchedSeat.status !== 'ACTIVATING') {
        throw new Error('expected LONG seat to be ACTIVATING');
      }

      symbolRegistry.updateSeatState('LONG', {
        ...searchedSeat,
        status: 'ACTIVE',
        lastSeatActivatedAt: fixedNowMs,
      });

      await runCanonicalDistance({
        direction: 'LONG',
        monitorPrice: '20000',
        positions: [
          {
            symbol: 'OLD_BULL.HK',
            quantity: 100,
            availableQuantity: 100,
            symbolName: 'OLD_BULL',
            accountChannel: 'lb_papertrading',
            currency: 'HKD',
            costPrice: '1',
          },
        ],
      });

      await runCanonicalDistance({
        direction: 'LONG',
        monitorPrice: '20000',
        positions: [],
      });

      expect(native.nativeMutations()).toHaveLength(1);

      await runCanonicalDistance({
        direction: 'LONG',
        monitorPrice: '20000',
        positions: [],
      });

      const submitCalls = native.nativeMutations();
      expect(submitCalls).toHaveLength(2);
      expect(trackedOrders).toHaveLength(2);
      expect(trackedOrders[0]?.side).toBe('SELL');
      expect(trackedOrders[1]?.side).toBe('BUY');
      expect(rebuyLossGateCalls).toBe(1);
      expect(generatedTriggerTimes).toEqual([fixedNowMs, fixedNowMs]);

      expect(submitCalls[0]?.quantity).toBe('100');
      expect(submitCalls[0]?.symbol).toBe('OLD_BULL.HK');
      expect(submitCalls[0]?.day).toBeTrue();
      expect(submitCalls[1]?.quantity).toBe('200');
      expect(submitCalls[1]?.symbol).toBe('NEW_BULL.HK');
      expect(submitCalls[1]?.day).toBeTrue();
      expect(native.accountReadCounts().positions).toBeGreaterThanOrEqual(2);
      expect(native.accountReadCounts().balance).toBeGreaterThanOrEqual(1);
      const finalSeat = symbolRegistry.getSeatState('LONG');
      expect(finalSeat.status).toBe('ACTIVATING');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(manager.hasPendingSwitch('LONG')).toBeFalse();
      await settlement.stopAndDrain();
      await snapshot.requestClear({ reason: 'STOP', dayEpoch: 1 });
    } finally {
      setSystemTime();
    }
  });

  it('re-enters distance presearch on danger-side after safe-side same-symbol suppression', async () => {
    candidateQueue = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
    ];
    let findBestCalls = 0;
    let distanceToStrikePercent = '2';

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    const manager = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
      ...createTradeRuntimeDouble({ cacheManager: { getPendingOrders: async () => [] } }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: distanceToStrikePercent,
            distanceDenominator: '100',
          }),
      }),
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => {
          findBestCalls += 1;
          return candidateQueue.shift() ?? null;
        },
      },
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    expect(findBestCalls).toBe(1);

    distanceToStrikePercent = '0.1';
    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    expect(findBestCalls).toBe(2);
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('does not write suppression on danger-side same-symbol, and safe-side still re-runs presearch once', async () => {
    candidateQueue = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: '20000' }),
    ];
    let findBestCalls = 0;
    let distanceToStrikePercent = '0.1';

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    const manager = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
      ...createTradeRuntimeDouble({ cacheManager: { getPendingOrders: async () => [] } }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: distanceToStrikePercent,
            distanceDenominator: '100',
          }),
      }),
      candidateSearch: {
        resolveDistanceRange: (direction) =>
          monitorConfig.autoSearchConfig[
            direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
          ],
        findCandidate: async () => {
          findBestCalls += 1;
          return candidateQueue.shift() ?? null;
        },
      },
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    distanceToStrikePercent = '2';
    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    expect(findBestCalls).toBe(2);
    const seat = symbolRegistry.getSeatState('LONG');
    expect(seat.status).toBe('ACTIVE');
    expect(seat.symbol).toBe('OLD_BULL.HK');
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('falls back to EMPTY on danger-side no-candidate and can recover via next auto-search tick', async () => {
    candidateQueue = [
      null,
      createWarrantCandidateWithOverrides('RECOVER_BULL.HK', { callPrice: '22000' }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: '0.35',
        autoSearchMinDistancePctBear: '-0.35',
        autoSearchMinTurnoverPerMinuteBull: '100000',
        autoSearchMinTurnoverPerMinuteBear: '100000',
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: '0.2', max: '1.5' },
        switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
      },
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
      callPrice: '20000',
    });

    const candidateSearch = {
      resolveDistanceRange: (direction: 'LONG' | 'SHORT') =>
        monitorConfig.autoSearchConfig[
          direction === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => candidateQueue.shift() ?? null,
    };
    const manager = createSeatSwitchWorkflow({
      logger: createLoggerStub(),
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
      }),
      ...createTradeRuntimeDouble({ cacheManager: { getPendingOrders: async () => [] } }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceNumerator: '0.1',
            distanceDenominator: '100',
          }),
      }),
      candidateSearch,
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });
    const autoSearch = createAutoSearch({
      monitorSymbol: monitorConfig.monitorSymbol,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      symbolRegistry,
      candidateSearch,
      logger: createLoggerStub(),
    });

    await runDistanceSwitch(manager, symbolRegistry, {
      direction: 'LONG',
      monitorPrice: '20000',
      positions: [],
    });

    const emptySeat = symbolRegistry.getSeatState('LONG');
    expect(emptySeat.status).toBe('EMPTY');
    expect(emptySeat.symbol).toBeNull();
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();

    await autoSearch.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:11:00.000Z'),
      canContinue: captureSearchSeatAuthorization(symbolRegistry, 'LONG'),
    });

    const recoveredSeat = symbolRegistry.getSeatState('LONG');
    expect(recoveredSeat.status).toBe('ACTIVATING');
    expect(recoveredSeat.symbol).toBe('RECOVER_BULL.HK');
  });
});
