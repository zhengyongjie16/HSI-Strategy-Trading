/**
 * monitorTaskProcessor 业务测试
 *
 * 覆盖：
 * - LIQUIDATION_DISTANCE_CHECK 使用 positionCache/实时行情触发清仓
 * - UNREALIZED_LOSS_CHECK 在无 orderRecorder 情况下仍可委托 unrealizedLossMonitor
 */
import { describe, expect, it } from 'bun:test';
import { createMonitorTaskProcessor } from '../../../../src/main/asyncProgram/monitorTaskProcessor/index.js';
import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createRefreshGate } from '../../../../src/utils/refreshGate/index.js';
import { isRuntimeExecutionAllowed } from '../../../../src/app/runtime/executionGate.js';
import type { OrderTypeConfig } from '../../../../src/types/signal.js';
import {
  createMarketDataClientDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createLastState, createMonitorTaskContext, runProcessorFlow } from '../utils.js';

describe('monitorTaskProcessor business flow', () => {
  it('processes LIQUIDATION_DISTANCE_CHECK using current position cache and realtime quote', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState();
    lastState.positionCache.update([
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 200,
      }),
    ]);

    const executedSignals: Array<{
      readonly action: string;
      readonly symbol: string;
      readonly quantity: number | null | undefined;
      readonly orderTypeOverride: OrderTypeConfig | null | undefined;
    }> = [];
    const liquidationOrderType: OrderTypeConfig = 'LO';
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      monitorContext: createMonitorTaskContext({
        riskChecker: createRiskCheckerDouble({
          checkWarrantDistanceLiquidation: (_symbol, isLongSymbol) => {
            return isLongSymbol
              ? { shouldLiquidate: true, reason: '触发清仓阈值' }
              : { shouldLiquidate: false };
          },
        }),
      }),
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          for (const signal of signals) {
            executedSignals.push({
              action: signal.action,
              symbol: signal.symbol,
              quantity: signal.quantity,
              orderTypeOverride: signal.orderTypeOverride,
            });
          }

          return {
            submittedCount: signals.length,
            submittedOrderIds: signals.map((_, index) => `ORDER-${index + 1}`),
          };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) =>
          new Map(
            [...symbols].map((symbol) => [
              symbol,
              createQuoteDouble(symbol, symbol === 'HSI.HK' ? 20_000 : 1.1),
            ]),
          ),
      }),
      lastState,
      monitorConfig: createMonitorTaskContext().config,
      liquidationOrderType,
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'LIQUIDATION_DISTANCE_CHECK',
          dedupeKey: 'LIQUIDATION_DISTANCE_CHECK',
          data: {
            monitorPrice: 20_000,
            long: {
              seatVersion: 2,
              symbol: 'BULL.HK',
              symbolName: 'BULL.HK',
            },
            short: {
              seatVersion: 3,
              symbol: null,
              symbolName: null,
            },
          },
        });
      },
      waitCondition: () => executedSignals.length === 1,
    });

    expect(executedSignals).toEqual([
      {
        action: 'SELLCALL',
        symbol: 'BULL.HK',
        quantity: 200,
        orderTypeOverride: liquidationOrderType,
      },
    ]);
  });

  it('processes UNREALIZED_LOSS_CHECK by delegating ready symbols to unrealizedLossMonitor', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const monitorCalls: Array<{
      readonly longSymbol: string;
      readonly shortSymbol: string;
      readonly longQuantity: number | null;
    }> = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      monitorContext: createMonitorTaskContext({
        unrealizedLossMonitor: {
          monitorUnrealizedLoss: async (params) => {
            monitorCalls.push({
              longSymbol: params.longSymbol,
              shortSymbol: params.shortSymbol,
              longQuantity: params.longPosition?.quantity ?? null,
            });
          },
        },
      }),
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble({
        getStockPositions: async () => [
          createPositionDouble({
            symbol: 'BULL.HK',
            quantity: 150,
            availableQuantity: 150,
          }),
        ],
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.05)]]),
      }),
      lastState: createLastState(),
      monitorConfig: createMonitorTaskContext().config,
      liquidationOrderType: 'ELO',
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'UNREALIZED_LOSS_CHECK',
          dedupeKey: 'UNREALIZED_LOSS_CHECK',
          data: {
            long: {
              seatVersion: 2,
              symbol: 'BULL.HK',
            },
            short: {
              seatVersion: 3,
              symbol: null,
            },
          },
        });
      },
      waitCondition: () => monitorCalls.length === 1,
    });

    expect(monitorCalls).toEqual([
      {
        longSymbol: 'BULL.HK',
        shortSymbol: '',
        longQuantity: 150,
      },
    ]);
  });

  it('reports error when task processing throws unexpectedly', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const reportedErrors: unknown[] = [];

    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      monitorContext: createMonitorTaskContext(),
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          throw new Error('quotes failed');
        },
      }),
      lastState: createLastState(),
      monitorConfig: createMonitorTaskContext().config,
      liquidationOrderType: 'ELO',
      onError: (error) => {
        reportedErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'LIQUIDATION_DISTANCE_CHECK',
          dedupeKey: 'LIQUIDATION_DISTANCE_CHECK',
          data: {
            monitorPrice: 20_000,
            long: {
              seatVersion: 2,
              symbol: 'BULL.HK',
              symbolName: 'BULL.HK',
            },
            short: {
              seatVersion: 3,
              symbol: null,
              symbolName: null,
            },
          },
        });
      },
      waitCondition: () => reportedErrors.length === 1,
    });

    expect(reportedErrors[0]).toBeInstanceOf(Error);
    expect((reportedErrors[0] as Error).message).toContain('等待下一轮重试');
  });

  it('skips AUTO_SYMBOL_TICK when lifecycle gate is open but continuous-session execution gate is closed', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    let autoSymbolTickCalls = 0;
    const lastState = createLastState({
      isTradingEnabled: true,
      canTrade: false,
    });
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      monitorContext: createMonitorTaskContext({
        autoSymbolManager: {
          maybeSearchOnTick: async () => {
            autoSymbolTickCalls += 1;
          },
          maybeSwitchOnInterval: async () => {
            autoSymbolTickCalls += 1;
          },
          maybeSwitchOnDistance: async () => {},
          hasPendingSwitch: () => false,
          resetAllState: () => {},
        },
      }),
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble(),
      lastState,
      monitorConfig: createMonitorTaskContext().config,
      liquidationOrderType: 'ELO',
      getCanProcessTask: () =>
        isRuntimeExecutionAllowed({
          isTradingEnabled: lastState.isTradingEnabled,
          canTrade: lastState.canTrade,
        }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'AUTO_SYMBOL_TICK',
          dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            symbol: 'BULL.HK',
            currentTimeMs: Date.now(),
            canTradeNow: true,
            openProtectionActive: false,
          },
        });
      },
      waitCondition: () => queue.isEmpty(),
    });

    expect(autoSymbolTickCalls).toBe(0);
  });

  it('processes SEAT_REFRESH even when continuous-session execution gate is closed', async () => {
    const queue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const lastState = createLastState({
      isTradingEnabled: true,
      canTrade: false,
    });
    const monitorContext = createMonitorTaskContext({
      symbolRegistry: createSymbolRegistryDouble({
        longSeat: {
          symbol: 'BULL.HK',
          status: 'ACTIVATING',
          callPrice: 21000,
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        longVersion: 2,
      }),
    });
    const processor = createMonitorTaskProcessor({
      monitorTaskQueue: queue,
      refreshGate: createRefreshGate(),
      monitorContext,
      clearMonitorDirectionQueues: () => {},
      trader: createTraderDouble({
        getAccountSnapshot: async () => null,
        getStockPositions: async () => [],
      }),
      marketDataClient: createMarketDataClientDouble({
        subscribeSymbols: async () => {},
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)]]),
      }),
      lastState,
      monitorConfig: createMonitorTaskContext().config,
      liquidationOrderType: 'ELO',
      getCanProcessTask: () =>
        isRuntimeExecutionAllowed({
          isTradingEnabled: lastState.isTradingEnabled,
          canTrade: lastState.canTrade,
        }),
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.scheduleLatest({
          type: 'SEAT_REFRESH',
          dedupeKey: 'SEAT_REFRESH:LONG',
          data: {
            direction: 'LONG',
            seatVersion: 2,
            previousSymbol: 'OLD_BULL.HK',
            nextSymbol: 'BULL.HK',
            callPrice: 21000,
            symbolName: 'BULL.HK',
          },
        });
      },
      waitCondition: () => monitorContext.symbolRegistry.getSeatState('LONG').status === 'ACTIVE',
    });

    expect(queue.isEmpty()).toBeTrue();
    expect(monitorContext.symbolRegistry.getSeatState('LONG').status).toBe('ACTIVE');
  });
});
