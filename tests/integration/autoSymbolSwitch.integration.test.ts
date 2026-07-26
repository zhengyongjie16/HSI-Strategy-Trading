/**
 * auto-symbol-switch 集成测试
 *
 * 功能：
 * - 验证自动换标端到端场景与业务期望。
 */
import { describe, expect, it, setSystemTime } from 'bun:test';
import { OrderSide } from 'longbridge';

import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';
import { createOrderExecutor as createOrderExecutorCore } from '../../src/core/trader/orderExecutor/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';
import { createStockPositionsResponse } from '../../mock/factories/tradeFactory.js';

import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTradeContextDouble,
  createTraderDouble,
  createWarrantDistanceInfoDouble,
} from '../helpers/testDoubles.js';
import { createWarrantCandidateWithOverrides } from '../services/autoSymbolManager/utils.js';
import type { OrderExecutorDeps } from '../../src/core/trader/types.js';

type OrderExecutorTestDeps = Omit<OrderExecutorDeps, 'unrealizedLossBuyGate'> &
  Partial<Pick<OrderExecutorDeps, 'unrealizedLossBuyGate'>>;

function createOrderExecutor(deps: OrderExecutorTestDeps) {
  return createOrderExecutorCore({
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    ...deps,
  });
}

let candidateQueue: Array<ReturnType<typeof createWarrantCandidateWithOverrides> | null> = [];

async function runDistanceSwitch(
  manager: ReturnType<typeof createAutoSymbolManager>,
  params: Omit<
    Parameters<ReturnType<typeof createAutoSymbolManager>['startSwitchOnDistance']>[0],
    'canContinue'
  >,
): Promise<void> {
  const switchParams = { ...params, canContinue: () => true };
  if (manager.hasPendingSwitch(params.direction)) {
    await manager.advancePendingSwitch(switchParams);
    return;
  }

  const startResult = await manager.startSwitchOnDistance(switchParams);
  if (startResult.started) {
    await manager.advancePendingSwitch(switchParams);
  }
}

describe('auto-symbol-switch integration', () => {
  it('runs empty-seat search then distance-triggered switch with sell->rebuy flow', async () => {
    candidateQueue = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
      createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const executedActions: Array<{
      action: string | null | undefined;
      symbol: string | null | undefined;
      quantity: number | null | undefined;
    }> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        executedActions.push({
          action: signal?.action,
          symbol: signal?.symbol,
          quantity: signal?.quantity,
        });

        if (signal?.action === 'SELLCALL') {
          return { executedOrderIds: ['SELL-ORDER-1'] };
        }

        return { executedOrderIds: ['BUY-ORDER-1'] };
      },
      getPendingOrders: async () => [],
      cancelOrder: async () => ({
        kind: 'CANCEL_CONFIRMED',
        relatedBuyOrderIds: null,
      }),
    });

    const orderRecorder = createOrderRecorderDouble({
      getSellRecordByOrderId: (orderId) =>
        orderId === 'SELL-ORDER-1'
          ? {
              orderId: 'SELL-ORDER-1',
              symbol: 'OLD_BULL.HK',
              executedPrice: 2,
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
          distanceToStrikePercent: 0.1,
        });
      },
    });

    const manager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
      trader,
      orderRecorder,
      riskChecker,
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await manager.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canContinue: () => true,
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

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
        },
      ],
    });

    expect(manager.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]?.action).toBe('SELLCALL');

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedActions).toHaveLength(1);
    expect(manager.hasPendingSwitch('LONG')).toBeTrue();

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);

    const finalSeat = symbolRegistry.getSeatState('LONG');
    expect(finalSeat.status).toBe('ACTIVATING');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(finalSeat.callPrice).toBe(21_000);
    expect(symbolRegistry.getSeatVersion('LONG')).toBe(3);
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();
  });

  it('keeps switch signals on the injected trading day through the real orderExecutor chain', async () => {
    const fixedNowMs = Date.parse('2026-02-16T02:00:00.000Z');
    const hostNowMs = Date.parse('2031-09-20T02:00:00.000Z');
    setSystemTime(hostNowMs);
    try {
      candidateQueue = [
        createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
        createWarrantCandidateWithOverrides('NEW_BULL.HK', { callPrice: 21_000 }),
      ];

      const monitorConfig = createMonitorConfigDouble({
        targetNotional: 5_000,
        autoSearchConfig: {
          autoSearchEnabled: true,
          autoSearchMinDistancePctBull: 0.35,
          autoSearchMinDistancePctBear: -0.35,
          autoSearchMinTurnoverPerMinuteBull: 100_000,
          autoSearchMinTurnoverPerMinuteBear: 100_000,
          autoSearchExpiryMinMonths: 3,
          autoSearchOpenDelayMinutes: 0,
          switchIntervalMinutes: 0,
          switchDistanceRangeBull: { min: 0.2, max: 1.5 },
          switchDistanceRangeBear: { min: -1.5, max: -0.2 },
        },
      });

      const symbolRegistry = createSymbolRegistryDouble({
        longSeat: {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        longVersion: 1,
        shortVersion: 1,
      });

      const tradeCtx = createTradeContextMock();
      tradeCtx.seedStockPositions(
        createStockPositionsResponse({
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      );

      const tradingConfig = createTradingConfig({
        monitor: monitorConfig,
      });

      const orderRecorder = createOrderRecorderDouble({
        getSellRecordByOrderId: (orderId) =>
          orderId === 'MOCK-000001'
            ? {
                orderId: 'MOCK-000001',
                symbol: 'OLD_BULL.HK',
                executedPrice: 2,
                executedQuantity: 100,
                executedTime: 9_999_999_999_999,
                submittedAt: undefined,
                updatedAt: undefined,
              }
            : null,
      });
      const marketDataClient = createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      });
      let rebuyLossGateCalls = 0;
      const riskChecker = createRiskCheckerDouble({
        checkUnrealizedLoss: (symbol, price, isLongSymbol) => {
          rebuyLossGateCalls += 1;
          expect(symbol).toBe('NEW_BULL.HK');
          expect(price).toBe(1);
          expect(isLongSymbol).toBeTrue();
          return { shouldLiquidate: false };
        },
        getWarrantDistanceInfo: (isLongSymbol) => {
          if (!isLongSymbol) {
            return null;
          }

          return createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          });
        },
      });

      const trackedOrders: Array<{ orderId: string; side: OrderSide; quantity: number }> = [];
      const orderExecutor = createOrderExecutor({
        ctx: createTradeContextDouble(tradeCtx),
        rateLimiter: createRateLimiterDouble(),
        marketDataClient,
        cacheManager: {
          clearCache: () => {},
          getPendingOrders: async () => [],
        },
        orderMonitor: createOrderMonitorDouble({
          trackOrder: ({ orderId, side, quantity }) => {
            trackedOrders.push({ orderId, side, quantity });
          },
        }),
        orderRecorder,
        unrealizedLossBuyGate: riskChecker,
        tradingConfig,
        symbolRegistry,
        isExecutionAllowed: () => true,
        isContinuousTradingAllowed: () => true,
        now: () => new Date(fixedNowMs),
        readCurrentTradingDayInfo: () => ({
          dateKey: '2026-02-16',
          info: { isTradingDay: true, isHalfDay: false },
        }),
      });

      const generatedTriggerTimes: number[] = [];
      const trader = createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            if (!signal.triggerTime) {
              throw new Error('自动换标信号必须包含 triggerTime');
            }

            generatedTriggerTimes.push(signal.triggerTime.getTime());
          }

          return orderExecutor.executeSignals(signals);
        },
        getPendingOrders: async () => [],
        cancelOrder: async () => ({
          kind: 'CANCEL_CONFIRMED',
          relatedBuyOrderIds: null,
        }),
      });

      const manager = createAutoSymbolManager({
        monitorConfig,
        symbolRegistry,
        marketDataClient,
        trader,
        orderRecorder,
        riskChecker,
        findBestWarrant: async () => candidateQueue.shift() ?? null,
        clock: { now: () => new Date(fixedNowMs) },
        getTradingCalendarSnapshot: () =>
          new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
      });

      await manager.maybeSearchOnEvent({
        direction: 'LONG',
        currentTime: new Date(fixedNowMs),
        canContinue: () => true,
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

      await runDistanceSwitch(manager, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [
          {
            symbol: 'OLD_BULL.HK',
            quantity: 100,
            availableQuantity: 100,
            symbolName: 'OLD_BULL',
            accountChannel: 'lb_papertrading',
            currency: 'HKD',
            costPrice: 1,
          },
        ],
      });

      await runDistanceSwitch(manager, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });

      expect(tradeCtx.getCalls('submitOrder')).toHaveLength(1);

      await runDistanceSwitch(manager, {
        direction: 'LONG',
        monitorPrice: 20_000,
        positions: [],
      });

      const submitCalls = tradeCtx.getCalls('submitOrder');
      expect(submitCalls).toHaveLength(2);
      expect(trackedOrders).toHaveLength(2);
      expect(trackedOrders[0]?.side).toBe(OrderSide.Sell);
      expect(trackedOrders[1]?.side).toBe(OrderSide.Buy);
      expect(rebuyLossGateCalls).toBe(1);
      expect(generatedTriggerTimes).toEqual([fixedNowMs, fixedNowMs]);

      const sellPayload = submitCalls[0]?.args[0] as {
        readonly submittedQuantity: { readonly toString: () => string };
      };
      const rebuyPayload = submitCalls[1]?.args[0] as {
        readonly submittedQuantity: { readonly toString: () => string };
      };

      expect(Number(sellPayload.submittedQuantity.toString())).toBe(100);
      expect(Number(rebuyPayload.submittedQuantity.toString())).toBe(200);

      const finalSeat = symbolRegistry.getSeatState('LONG');
      expect(finalSeat.status).toBe('ACTIVATING');
      expect(finalSeat.symbol).toBe('NEW_BULL.HK');
      expect(manager.hasPendingSwitch('LONG')).toBeFalse();
    } finally {
      setSystemTime();
    }
  });

  it('re-enters distance presearch on danger-side after safe-side same-symbol suppression', async () => {
    candidateQueue = [
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
    ];
    let findBestCalls = 0;
    let distanceToStrikePercent = 2;

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const manager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent,
          }),
      }),
      findBestWarrant: async () => {
        findBestCalls += 1;
        return candidateQueue.shift() ?? null;
      },
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    expect(findBestCalls).toBe(1);

    distanceToStrikePercent = 0.1;
    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
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
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
      createWarrantCandidateWithOverrides('OLD_BULL.HK', { callPrice: 20_000 }),
    ];
    let findBestCalls = 0;
    let distanceToStrikePercent = 0.1;

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const manager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent,
          }),
      }),
      findBestWarrant: async () => {
        findBestCalls += 1;
        return candidateQueue.shift() ?? null;
      },
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    distanceToStrikePercent = 2;
    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
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
      createWarrantCandidateWithOverrides('RECOVER_BULL.HK', { callPrice: 22_000 }),
    ];

    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });
    const symbolRegistry = createSymbolRegistryDouble({
      longSeat: {
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: Date.parse('2026-02-16T01:00:00.000Z'),
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });

    const manager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, 1, 100)])),
      }),
      trader: createTraderDouble({
        getPendingOrders: async () => [],
      }),
      orderRecorder: createOrderRecorderDouble(),
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: () =>
          createWarrantDistanceInfoDouble({
            warrantType: 'BULL',
            distanceToStrikePercent: 0.1,
          }),
      }),
      findBestWarrant: async () => candidateQueue.shift() ?? null,
      clock: { now: () => new Date('2026-02-16T01:00:00.000Z') },
      getTradingCalendarSnapshot: () =>
        new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    });

    await runDistanceSwitch(manager, {
      direction: 'LONG',
      monitorPrice: 20_000,
      positions: [],
    });

    const emptySeat = symbolRegistry.getSeatState('LONG');
    expect(emptySeat.status).toBe('EMPTY');
    expect(emptySeat.symbol).toBeNull();
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();

    await manager.maybeSearchOnEvent({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:11:00.000Z'),
      canContinue: () => true,
    });

    const recoveredSeat = symbolRegistry.getSeatState('LONG');
    expect(recoveredSeat.status).toBe('ACTIVATING');
    expect(recoveredSeat.symbol).toBe('RECOVER_BULL.HK');
  });
});
