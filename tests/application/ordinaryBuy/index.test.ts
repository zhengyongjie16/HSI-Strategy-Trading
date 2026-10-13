/** 普通 BUY owner：真实风险顺序/实时双读、旧席位失效、有限外部失败与 UNKNOWN fatal 语义。 */
import { logger } from '../../../src/utils/logger/index.js';
import { describe, expect, it } from 'bun:test';
import { createOrdinaryBuyWorkflow } from '../../../src/application/ordinaryBuy/index.js';
import { createBuyProcessor } from '../../../src/runtime/asyncProgram/buyProcessor/index.js';
import { createBuyTaskQueue } from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createSnapshotFixture } from '../../main/fixtures/accountPositionSnapshot.js';
import { createMonitorContext, runProcessorFlow } from '../../main/asyncProgram/utils.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createLiquidationCooldownTrackerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import type { OrdinaryBuyWorkflowDeps } from '../../../src/application/ordinaryBuy/types.js';

/** 通过真实 H 发布基线，窄能力直接创建完整 owner，不经过 SignalProcessor 或旧处理器。 */
async function createWorkflow(overrides: Partial<OrdinaryBuyWorkflowDeps> = {}) {
  const context = createMonitorContext();
  const config = createTradingConfig();
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const deps: OrdinaryBuyWorkflowDeps = {
    logger,
    config: config.monitor,
    doomsdayProtection: config.global.doomsdayProtection,
    symbolRegistry: context.symbolRegistry,
    orderRecorder: createOrderRecorderDouble(),
    riskChecker: createRiskCheckerDouble(),
    trader: createTraderDouble(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
          ['BULL.HK', createQuoteDouble('BULL.HK', '0.999', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
        ]),
    }),
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    snapshot,
    getIsHalfDay: () => false,
    now: () => new Date('2026-02-16T02:00:00Z'),
    getCanProcessTask: () => true,
    termination: {
      isTerminated: () => false,
      reportFatalError: (error) => {
        throw error;
      },
    },
    ...overrides,
  };
  return { workflow: createOrdinaryBuyWorkflow(deps), deps, snapshot };
}

function buySignal() {
  return { ...createSignalDouble('BUYCALL', 'BULL.HK'), seatVersion: 2 };
}

describe('ordinaryBuy owner', () => {
  it('fetches one risk quote set, then uses realtime reads without modifying canonical facts', async () => {
    const steps: string[] = [];
    const account = createAccountSnapshotDouble('77777');
    const { workflow, snapshot } = await createWorkflow({
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          steps.push('account');
          return account;
        },
        getStockPositions: async () => {
          steps.push('positions');
          return [];
        },
        executeSignals: async (signals, authorize) => {
          expect(authorize()).toBeTrue();
          expect(signals[0]?.quantity).toBeUndefined();
          steps.push('execute');
          return { executedOrderIds: ['BUY'], quoteFailures: [] };
        },
      }),
      riskChecker: createRiskCheckerDouble({
        checkBeforeOrder: (params) => {
          expect(params.account).toBe(account);
          steps.push('baseRisk');
          return { allowed: true };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async (symbols) => {
          steps.push('quotes');
          expect([...symbols]).toEqual(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
          return new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
            ['BULL.HK', createQuoteDouble('BULL.HK', '0.999', 100)],
          ]);
        },
      }),
    });
    const original = snapshot.getView();
    await workflow.execute(buySignal());
    expect(steps).toEqual(['quotes', 'account', 'positions', 'baseRisk', 'execute']);
    expect(snapshot.getView()).toBe(original);
  });

  it('rejects equality to original cost before realtime reads, and cooldown reset belongs only to BUY', async () => {
    let reads = 0;
    let checks = 0;
    let price = '1';
    const { workflow } = await createWorkflow({
      orderRecorder: createOrderRecorderDouble({
        getLatestBuyOrderCost: () => ({ costAmount: '1000', quantity: 1000 }),
      }),
      trader: createTraderDouble({
        canTradeNow: () => {
          checks += 1;
          return { canTrade: true };
        },
        getAccountSnapshot: async () => {
          reads += 1;
          return createAccountSnapshotDouble('100000');
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
            ['BULL.HK', createQuoteDouble('BULL.HK', price, 100)],
          ]),
      }),
    });
    await workflow.execute(buySignal());
    price = '0.999';
    await workflow.execute(buySignal());
    expect(reads).toBe(0);
    expect(checks).toBe(1);
    workflow.resetRiskCheckCooldown();
    await workflow.execute(buySignal());
    expect(reads).toBe(1);
  });

  it('does not submit after seat identity changes during the realtime account read', async () => {
    let submits = 0;
    const context = createMonitorContext();
    const { workflow } = await createWorkflow({
      symbolRegistry: context.symbolRegistry,
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          context.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
            symbol: 'BULL.HK',
            status: 'ACTIVE',
            lastSwitchAt: null,
            lastSearchAt: null,
            lastSeatActivatedAt: 12000,
            searchFailCountToday: 0,
            frozenTradingDayKey: null,
          });
          return createAccountSnapshotDouble('100000');
        },
        executeSignals: async () => {
          submits += 1;
          return { executedOrderIds: ['INVALID'], quoteFailures: [] };
        },
      }),
    });
    await workflow.execute(buySignal());
    expect(submits).toBe(0);
  });

  it('drops missing risk-time quote and stale-seat signal before realtime reads', async () => {
    let reads = 0;
    const { workflow } = await createWorkflow({
      trader: createTraderDouble({
        getAccountSnapshot: async () => {
          reads += 1;
          return createAccountSnapshotDouble('100000');
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', '20000')]]),
      }),
    });
    await workflow.execute({ ...buySignal(), seatVersion: 1 });
    await workflow.execute(buySignal());
    expect(reads).toBe(0);
  });

  it.each(['getQuotes', 'submitOrder'])(
    'keeps %s failure at the owning business/fatal boundary',
    async (operation) => {
      const failure = await createExternalApiRequestError({
        operation: operation === 'submitOrder' ? 'TradeContext.submitOrder' : 'QuoteContext.quote',
        attempts: 1,
        cause: new Error('network'),
      });
      const queue = createBuyTaskQueue();
      const termination = createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: queue.close,
        stopProducers: [],
        onSecondaryError: () => {},
      });
      let executions = 0;
      const { workflow } = await createWorkflow({
        termination,
        trader: createTraderDouble({
          executeSignals: async () => {
            executions += 1;
            if (operation === 'submitOrder') throw failure;

            return { executedOrderIds: [], quoteFailures: [] };
          },
        }),
        marketDataClient: createMarketDataClientDouble({
          getQuotes: async () => {
            if (operation === 'getQuotes') throw failure;

            return new Map([
              ['HSI.HK', createQuoteDouble('HSI.HK', '20000')],
              ['BULL.HK', createQuoteDouble('BULL.HK', '0.9', 100)],
            ]);
          },
        }),
      });
      const processor = createBuyProcessor({
        taskQueue: queue,
        workflow,
        getCanProcessTask: () => true,
        termination,
      });
      await runProcessorFlow({
        processor,
        pushTask: () => {
          for (const data of [buySignal(), buySignal()]) queue.push({ type: 'STRATEGY_BUY', data });
        },
        waitCondition: () =>
          operation === 'submitOrder' ? termination.isTerminated() : queue.isEmpty(),
      });
      expect(termination.isTerminated()).toBe(operation === 'submitOrder');
      expect(executions).toBe(operation === 'submitOrder' ? 1 : 0);
      if (operation === 'submitOrder') {
        expect(queue.isEmpty()).toBeFalse();
        expect(queue.pop()?.data.action).toBe('BUYCALL');
        expect(queue.isEmpty()).toBeTrue();
      }
    },
  );
});
