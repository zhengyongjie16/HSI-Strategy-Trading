/**
 * buyProcessor 业务测试
 *
 * 功能：
 * - 验证买入处理器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createBuyTaskQueue } from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createBuyProcessor } from '../../../../src/main/asyncProgram/buyProcessor/index.js';
import { createSignalProcessor } from '../../../../src/core/signalProcessor/index.js';
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';
import { createTradingConfig } from '../../../../mock/factories/configFactory.js';

import type { BuySignal, Signal } from '../../../../src/types/signal.js';

import {
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createMonitorContext, runProcessorFlow } from '../utils.js';

async function runBuyRiskQuoteScenario(riskQuotePrice: number): Promise<{
  readonly executeCalls: number;
  readonly quoteRequests: ReadonlyArray<ReadonlyArray<string>>;
}> {
  const queue = createBuyTaskQueue();
  const tradingConfig = createTradingConfig();
  const orderRecorder = createOrderRecorderDouble({
    getLatestBuyOrderPrice: () => 1,
  });
  const monitorContext = createMonitorContext({
    config: tradingConfig.monitor,
    orderRecorder,
    riskChecker: createRiskCheckerDouble(),
  });
  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
  });
  let executeCalls = 0;
  const trader = createTraderDouble({
    executeSignals: async () => {
      executeCalls += 1;
      return { executedOrderIds: ['EXECUTED-ORDER-1'] };
    },
  });
  const quoteRequests: string[][] = [];
  const processor = createBuyProcessor({
    taskQueue: queue,
    monitorContext,
    signalProcessor,
    trader,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        return new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
          ['BULL.HK', createQuoteDouble('BULL.HK', riskQuotePrice, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]);
      },
    }),
    doomsdayProtection: createDoomsdayProtectionDouble({
      isBuyCutoffWindowActive: () => false,
    }),
    getIsHalfDay: () => false,
    getCanProcessTask: () => true,
  });
  let signal = createSignalDouble('BUYCALL', 'BULL.HK');
  signal = { ...signal, seatVersion: 2 };

  await runProcessorFlow({
    processor,
    pushTask: () => {
      queue.push({ type: 'IMMEDIATE_BUY', data: signal });
    },
    waitCondition: () => queue.isEmpty(),
  });

  return {
    executeCalls,
    quoteRequests,
  };
}

describe('buyProcessor business flow', () => {
  it('rejects a risk-time buy quote that reaches the latest buy price', async () => {
    const result = await runBuyRiskQuoteScenario(1.01);

    expect(result.quoteRequests).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(result.executeCalls).toBe(0);
  });

  it('submits a risk-approved buy signal without a second processor quote read', async () => {
    const result = await runBuyRiskQuoteScenario(0.99);

    expect(result.quoteRequests).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(result.executeCalls).toBe(1);
  });

  it('runs the risk pipeline then delegates the buy order after one risk-time quote read', async () => {
    const queue = createBuyTaskQueue();
    const monitorContext = createMonitorContext();

    let riskCheckCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: ReadonlyArray<BuySignal>) => {
        riskCheckCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executed = 0;
    const trader = createTraderDouble({
      executeSignals: async (_signals: ReadonlyArray<Signal>) => {
        executed += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const quoteRequests: string[][] = [];
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteRequests.push([...symbols]);
        return new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
          ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
        ]);
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient,
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'IMMEDIATE_BUY',
          data: signal,
        });
      },
      waitCondition: () => executed === 1,
    });

    expect(riskCheckCalls).toBe(1);
    expect(quoteRequests).toHaveLength(1);
    expect(quoteRequests[0]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
  });

  it('drops buy signal when the risk-time trade quote is missing', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', data: signal });
      },
      waitCondition: () => queue.isEmpty(),
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(riskCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('treats risk rejection as successful handling and does not submit order', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', data: signal });
      },
      waitCondition: () => riskCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('drops stale-seat-version buy signal before risk checks', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    let staleSignal = createSignalDouble('BUYCALL', 'BULL.HK');
    staleSignal = { ...staleSignal, seatVersion: 1 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('drops buy signal when seat version changes after risk checks and before execution', async () => {
    const queue = createBuyTaskQueue();
    const monitorContext = createMonitorContext();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: ReadonlyArray<BuySignal>) => {
        riskCalls += 1;
        const currentSeat = monitorContext.symbolRegistry.getSeatState('LONG');
        if (currentSeat.status !== 'ACTIVE' || currentSeat.lastSeatActivatedAt === null) {
          throw new Error('expected runtime ACTIVE LONG seat');
        }

        monitorContext.symbolRegistry.updateSeatStateWithVersionBump('LONG', currentSeat);
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
    });

    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'IMMEDIATE_BUY', data: signal });
      },
      waitCondition: () => riskCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(riskCalls).toBe(1);
    expect(executeCalls).toBe(0);
  });

  it('sends submitOrder API failure to fatal channel', async () => {
    const queue = createBuyTaskQueue();
    const submitError = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: ReadonlyArray<BuySignal>) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          throw submitError;
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('BUYCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2 };
        queue.push({ type: 'IMMEDIATE_BUY', data: signal });
      },
      waitCondition: () => fatalErrors.length === 1,
    });

    expect(fatalErrors).toEqual([submitError]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('consumes non-submit external API failures without fatal channel escalation', async () => {
    const queue = createBuyTaskQueue();
    const quoteError = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    let executeCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async (signals: ReadonlyArray<BuySignal>) => signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          throw quoteError;
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => true,
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('BUYCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2 };
        queue.push({ type: 'IMMEDIATE_BUY', data: signal });
      },
      waitCondition: () => executeCalls === 1,
    });

    expect(fatalErrors).toEqual([]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('base gate blocks task before processTask when lifecycle gate is closed', async () => {
    const queue = createBuyTaskQueue();

    let riskCalls = 0;
    const signalProcessor = {
      processSellSignals: () => [],
      applyRiskChecks: async () => {
        riskCalls += 1;
        return [];
      },
      resetRiskCheckCooldown: () => {},
    };

    const processor = createBuyProcessor({
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', 20_000, 1)],
            ['BULL.HK', createQuoteDouble('BULL.HK', 1.1, 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9, 100)],
          ]),
      }),
      doomsdayProtection: createDoomsdayProtectionDouble(),
      getIsHalfDay: () => false,
      getCanProcessTask: () => false,
    });

    let signal = createSignalDouble('BUYCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2 };

    processor.start();
    queue.push({ type: 'IMMEDIATE_BUY', data: signal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(riskCalls).toBe(0);
  });
});
