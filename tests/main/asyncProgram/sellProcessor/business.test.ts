import { createIssuedPeriodicTasksFixture } from '../../fixtures/issuedPeriodicTasks.js';
import { createSettlementRuntimeFixture } from '../../fixtures/settlementRuntime.js';
import { getDefaultAutoSearchConfig } from '../../../services/autoSymbolManager/utils.js';
import { createTerminationRuntime } from '../../../../src/app/runtime/createTerminationRuntime.js';
import {
  createEmptySnapshotFixture,
  createSnapshotFixture,
} from '../../fixtures/accountPositionSnapshot.js';
import type { AccountPositionSnapshot } from '../../../../src/types/accountPosition.js';
import type { SellProcessorDeps } from '../../../../src/main/asyncProgram/sellProcessor/types.js';
import type { Processor } from '../../../../src/main/asyncProgram/types.js';
import type { PostTradeConsistencyRuntime } from '../../../../src/app/types.js';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createSellProcessor } from '../../../../src/main/asyncProgram/sellProcessor/index.js';
import { createMonitorTaskQueue } from '../../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import { clearMonitorDirectionQueues } from '../../../../src/main/seatRuntimeCleanupDispatcher/queueCleanup.js';
import { createPostTradeConsistencyRuntime } from '../../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createExternalApiRequestError } from '../../../helpers/createExternalApiRequestError.js';
import type { MonitorTaskDataMap } from '../../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { ExecutableSellSignal, Signal } from '../../../../src/types/signal.js';
import {
  createAccountSnapshotDouble,
  createDailyLossTrackerDouble,
  createPositionDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import {
  createLastState,
  createMonitorContext,
  rethrowFatalError,
  runProcessorFlow,
  waitUntil,
} from '../utils.js';

/**
 * sellProcessor 业务测试
 *
 * 功能：
 * - 验证卖出处理器相关场景意图、边界条件与业务期望。
 */

function requireSignal(signal: Signal | null): Signal {
  if (signal === null) {
    throw new Error('executed signal should exist');
  }

  return signal;
}

const issuedTaskFixtures: Awaited<ReturnType<typeof createIssuedPeriodicTasksFixture>>[] = [];
const baselineOwners: PostTradeConsistencyRuntime[] = [];
afterEach(async () => {
  for (const fixture of issuedTaskFixtures.splice(0)) await fixture.stopAndDrain();

  for (const baseline of baselineOwners.splice(0)) await baseline.stopAndDrain();
});

const SELL_PROCESSOR_NOW_MS = Date.parse('2026-02-16T01:31:00.000Z');
const SELL_PROCESSOR_RUNTIME = {
  clock: {
    now: () => new Date(SELL_PROCESSOR_NOW_MS),
  },
  scheduler: {
    scheduleTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    },
  },
};

/** 由同一真实 H 初始化事实，并由真实 S 完成 paired 基线业务收尾后取得 receipt。 */
async function createSellProcessorHarness(
  params: Omit<SellProcessorDeps, 'snapshot' | 'postTradeConsistencyRuntime'> & {
    readonly snapshot?: AccountPositionSnapshot;
    readonly postTradeConsistencyRuntime?: SellProcessorDeps['postTradeConsistencyRuntime'];
    readonly onWaitForFresh?: () => void;
    readonly abortBeforeWait?: 'STOP_AND_DRAIN';
  },
): Promise<
  Processor & {
    readonly snapshot: AccountPositionSnapshot;
    readonly baseline: PostTradeConsistencyRuntime | null;
  }
> {
  const snapshot =
    params.snapshot ??
    (await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 500,
          costPrice: '1',
        }),
        createPositionDouble({
          symbol: 'BEAR.HK',
          quantity: 300,
          availableQuantity: 300,
          costPrice: '1',
        }),
      ],
    }));
  let consistency = params.postTradeConsistencyRuntime;
  let baseline: PostTradeConsistencyRuntime | null = null;
  if (consistency === undefined) {
    baseline = createSettlementRuntimeFixture({
      monitorContext: params.monitorContext,
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      snapshot,
      getTrader: () => params.trader,
      // S 刷新唤醒与 SELL 的 quote retry timer 属于不同 owner，分别观测。
      scheduler: SELL_PROCESSOR_RUNTIME.scheduler,
      onPositionsCommitted: async (token) => {
        expect(
          snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
        ).toBeTrue();
      },
    });
    baselineOwners.push(baseline);
    baseline.start();
    expect(await baseline.completeRebuildBaseline()).toBeTrue();
    if (params.abortBeforeWait !== undefined) {
      baseline.abortWaiting();
    }

    consistency = baseline;
  }

  const reader = consistency;
  const processor = createSellProcessor({
    ...params,
    snapshot,
    postTradeConsistencyRuntime: {
      waitForFresh: async () => {
        params.onWaitForFresh?.();
        return reader.waitForFresh();
      },
      isCurrent: reader.isCurrent,
    },
  });
  return { ...processor, snapshot, baseline };
}

describe('sellProcessor business flow', () => {
  it('queueCleanup 在 trade task 不携带 monitorSymbol 时仍按 direction 清理 buy/sell task', async () => {
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

    const context = createMonitorContext({
      config: createMonitorConfigDouble({
        autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 1 },
      }),
    });
    for (const direction of ['LONG', 'SHORT'] as const)
      context.symbolRegistry.updateSeatState(direction, {
        ...context.symbolRegistry.getSeatState(direction),
        lastSeatActivatedAt: 12000,
      });

    const issued = await createIssuedPeriodicTasksFixture({
      snapshot: await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions: [],
      }),
      monitorContext: context,
      trader: createTraderDouble(),
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      getCanTradeNow: () => true,
      nowMs: 13000,
    });
    issuedTaskFixtures.push(issued);
    for (const task of [
      {
        type: 'STRATEGY_BUY' as const,
        data: createSignalDouble('BUYCALL', 'BULL.HK'),
      },
      {
        type: 'STRATEGY_BUY' as const,
        data: createSignalDouble('BUYPUT', 'BEAR.HK'),
      },
    ]) {
      buyTaskQueue.push(task);
    }

    for (const task of [
      {
        type: 'STRATEGY_SELL' as const,
        data: createSignalDouble('SELLCALL', 'BULL.HK'),
      },
      {
        type: 'STRATEGY_SELL' as const,
        data: createSignalDouble('SELLPUT', 'BEAR.HK'),
      },
    ]) {
      sellTaskQueue.push(task);
    }

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:LONG',
      data: issued.getTask('LONG'),
    });

    monitorTaskQueue.scheduleLatest({
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: 'AUTO_SYMBOL_TICK:SHORT',
      data: issued.getTask('SHORT'),
    });

    const result = clearMonitorDirectionQueues({
      direction: 'LONG',

      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });

    expect(result).toEqual({
      removedBuy: 1,
      removedSell: 1,
      removedMonitorTasks: 1,
    });
    expect(buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(sellTaskQueue.pop()?.data.action).toBe('SELLPUT');
    expect(monitorTaskQueue.pop()?.data).toMatchObject({
      direction: 'SHORT',
      symbol: 'BEAR.HK',
    });
  });

  it('keeps total holdings visible when available quantity is zero instead of synthesizing flat', async () => {
    const queue = createSellTaskQueue();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 0,
          costPrice: '1',
        }),
      ],
    });
    const originalPositions = snapshot.getView().positions;
    let processCalls = 0;
    let executeCalls = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      snapshot,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      getLastState: () => createLastState(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        resetRiskCheckCooldown: () => {},
        processSellSignals: ({ signals, longPosition }) => {
          processCalls += 1;
          expect(snapshot.getAvailablePosition('BULL.HK')).toBeNull();
          expect(longPosition).toBe(originalPositions[0] ?? null);
          expect(longPosition?.quantity).toBe(500);
          expect(longPosition?.availableQuantity).toBe(0);
          const signal = signals[0];
          if (signal === undefined) throw new Error('expected SELL signal at quantity stage');

          return [
            {
              ...signal,
              action: 'HOLD' as const,
              isProtectiveLiquidation: false as const,
              reason: 'no currently available quantity',
            },
          ];
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['UNEXPECTED'] };
        },
      }),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });
    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'STRATEGY_SELL',
          data: {
            ...createSignalDouble('SELLCALL', 'BULL.HK'),
            seatVersion: 2,
            triggerTime: new Date(SELL_PROCESSOR_NOW_MS),
          },
        });
      },
      waitCondition: () => processCalls === 1,
    });
    expect(executeCalls).toBe(0);
    expect(snapshot.getView().positions).toBe(originalPositions);
    expect(snapshot.getView().positions[0]?.quantity).toBe(500);
  });

  it('reselects current positions locally after quote-await supersession without a timer or old quantity submission', async () => {
    const queue = createSellTaskQueue();
    let quantity = 500;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [
          createPositionDouble({
            symbol: 'BULL.HK',
            quantity,
            availableQuantity: quantity,
            costPrice: '1',
          }),
        ],
      },
    });
    const origin = snapshot.getView().token;
    let quoteCalls = 0;
    let waitCalls = 0;
    let timerCalls = 0;
    let executeCalls = 0;
    const selectedQuantities: number[] = [];
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      snapshot,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      getLastState: () => createLastState(),
      onWaitForFresh: () => {
        waitCalls += 1;
      },
      signalProcessor: {
        applyRiskChecks: async () => [],
        resetRiskCheckCooldown: () => {},
        processSellSignals: ({ signals, longPosition }) => {
          const signal = signals[0];
          if (signal === undefined || longPosition === null)
            throw new Error('expected current quantity facts');

          selectedQuantities.push(longPosition.availableQuantity);
          return [{ ...signal, quantity: longPosition.availableQuantity }];
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          if (quoteCalls === 1) {
            quantity = 200;
            const receipt = await snapshot.requestRefresh({
              source: 'TEST_CURRENT_POSITIONS',
              dayEpoch: origin.dayEpoch,
              refreshAccount: true,
              refreshPositions: true,
            }).result;
            expect(receipt.status).toBe('COMMITTED');
            // 普通 commit 不重建 settlement；本 SELL owner 用原完成水位重选当前 position。
          }

          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      trader: createTraderDouble({
        executeSignals: async (signals, callerAuthorization) => {
          executeCalls += 1;
          expect(callerAuthorization()).toBe(true);
          if (executeCalls === 1) {
            expect(signals[0]?.quantity).toBe(200);
            quantity = 100;
            await snapshot.requestRefresh({
              source: 'SEAT_ACTIVATION',
              dayEpoch: origin.dayEpoch,
              refreshAccount: false,
              refreshPositions: true,
            }).result;
            expect(callerAuthorization()).toBe(false);
            return { executedOrderIds: [] };
          }

          expect(signals[0]?.quantity).toBe(100);
          return { executedOrderIds: ['CURRENT-100'] };
        },
      }),
      scheduler: {
        scheduleTimer: (callback, delay) => {
          timerCalls += 1;
          return setTimeout(callback, delay);
        },
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
      },
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });
    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'STRATEGY_SELL',
          data: {
            ...createSignalDouble('SELLCALL', 'BULL.HK'),
            seatVersion: 2,
            triggerTime: new Date(SELL_PROCESSOR_NOW_MS),
          },
        });
      },
      waitCondition: () => executeCalls === 2,
    });
    expect(quoteCalls).toBe(3);
    expect(waitCalls).toBe(3);
    expect(executeCalls).toBe(2);
    expect(selectedQuantities).toEqual([200, 100]);
    expect(timerCalls).toBe(0);
    expect(snapshot.getView().token.dayEpoch).toBe(origin.dayEpoch);
    expect(snapshot.getView().token.positionRevision).toBeGreaterThan(origin.positionRevision);
  });

  it('blocks the old SELL epoch after a day cut during quote await', async () => {
    const queue = createSellTaskQueue();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 500,
          costPrice: '1',
        }),
      ],
    });
    const origin = snapshot.getView().token;
    let quoteCalls = 0;
    let processCalls = 0;
    let executeCalls = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      snapshot,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      getLastState: () => createLastState(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        resetRiskCheckCooldown: () => {},
        processSellSignals: ({ signals }) => {
          processCalls += 1;
          return signals;
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => {
          quoteCalls += 1;
          await snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: origin.dayEpoch + 1 });
          return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]);
        },
      }),
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['UNEXPECTED'] };
        },
      }),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });
    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'STRATEGY_SELL',
          data: {
            ...createSignalDouble('SELLCALL', 'BULL.HK'),
            seatVersion: 2,
            triggerTime: new Date(SELL_PROCESSOR_NOW_MS),
          },
        });
      },
      waitCondition: () => quoteCalls === 1 && queue.isEmpty(),
    });
    expect(processCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(snapshot.getView().token.dayEpoch).toBe(origin.dayEpoch + 1);
  });

  it('reselects after quantity-stage invalidation and never hands the stale candidate to execution', async () => {
    const queue = createSellTaskQueue();
    let quantity = 500;
    let holdReselectionRead = false;
    const reselectionRead = Promise.withResolvers<null>();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
      readPort: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => {
          if (holdReselectionRead) await reselectionRead.promise;

          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity,
              availableQuantity: quantity,
              costPrice: '1',
            }),
          ];
        },
      },
    });
    const origin = snapshot.getView().token;
    let processCalls = 0;
    let executeCalls = 0;
    let timerCalls = 0;
    const selectedQuantities: number[] = [];
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      snapshot,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      getLastState: () => createLastState(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        resetRiskCheckCooldown: () => {},
        processSellSignals: ({ signals, longPosition }) => {
          processCalls += 1;
          const signal = signals[0];
          if (signal === undefined || longPosition === null)
            throw new Error('expected quantity stage');

          selectedQuantities.push(longPosition.availableQuantity);
          if (processCalls === 1) {
            holdReselectionRead = true;
            snapshot.invalidate();
          }

          return [{ ...signal, quantity: longPosition.availableQuantity }];
        },
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      trader: createTraderDouble({
        executeSignals: async (signals) => {
          executeCalls += 1;
          expect(signals[0]?.quantity).toBe(150);
          return { executedOrderIds: ['CURRENT-150'] };
        },
      }),
      scheduler: {
        scheduleTimer: (callback, delay) => {
          timerCalls += 1;
          return setTimeout(callback, delay);
        },
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
      },
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });
    processor.start();
    queue.push({
      type: 'STRATEGY_SELL',
      data: {
        ...createSignalDouble('SELLCALL', 'BULL.HK'),
        seatVersion: 2,
        triggerTime: new Date(SELL_PROCESSOR_NOW_MS),
      },
    });
    await waitUntil(() => processCalls === 1);
    expect(executeCalls).toBe(0);
    quantity = 150;
    holdReselectionRead = false;
    reselectionRead.resolve(null);
    const receipt = await snapshot.requestRefresh({
      source: 'TEST_RESELECT_QUANTITY',
      dayEpoch: origin.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    expect(receipt.status).toBe('COMMITTED');
    if (processor.baseline === null) throw new Error('expected real settlement baseline owner');

    expect(await processor.baseline.completeRebuildBaseline()).toBeTrue();
    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();
    expect(selectedQuantities).toEqual([500, 150]);
    expect(timerCalls).toBe(0);
  });

  it('does not deny or resubmit an accepted order when its receipt becomes obsolete during execution', async () => {
    const queue = createSellTaskQueue();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 500,
          availableQuantity: 500,
          costPrice: '1',
        }),
      ],
    });
    const originalPositions = snapshot.getView().positions;
    const origin = snapshot.getView().token;
    const accepted = { executedOrderIds: ['ACCEPTED-SELL-1'] };
    let executeCalls = 0;
    let waitCalls = 0;
    let timerCalls = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      snapshot,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      getLastState: () => createLastState(),
      onWaitForFresh: () => {
        waitCalls += 1;
      },
      signalProcessor: {
        applyRiskChecks: async () => [],
        resetRiskCheckCooldown: () => {},
        processSellSignals: ({ signals }) => signals,
      },
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)]]),
      }),
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          snapshot.invalidate();
          return accepted;
        },
        getStockPositions: async () => {
          throw new Error('unexpected position takeover');
        },
        getAccountSnapshot: async () => {
          throw new Error('unexpected account takeover');
        },
      }),
      scheduler: {
        scheduleTimer: (callback, delay) => {
          timerCalls += 1;
          return setTimeout(callback, delay);
        },
        clearTimer: (handle) => {
          clearTimeout(handle);
        },
      },
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });
    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({
          type: 'STRATEGY_SELL',
          data: {
            ...createSignalDouble('SELLCALL', 'BULL.HK'),
            seatVersion: 2,
            triggerTime: new Date(SELL_PROCESSOR_NOW_MS),
          },
        });
      },
      waitCondition: () => executeCalls === 1,
    });
    expect(accepted.executedOrderIds).toEqual(['ACCEPTED-SELL-1']);
    expect(waitCalls).toBe(1);
    expect(timerCalls).toBe(0);
    expect(snapshot.getView().positions).toBe(originalPositions);
    expect(snapshot.getView().token.snapshotGeneration).toBe(origin.snapshotGeneration + 1);
    expect(snapshot.getView().token.positionRevision).toBe(origin.positionRevision);
  });

  it('passes timeout and trading-calendar context into processSellSignals', async () => {
    const queue = createSellTaskQueue();
    const tradingCalendarSnapshot = new Map([
      ['2026-02-16', { isTradingDay: true, isHalfDay: true }],
    ]);
    const lastState = createLastState();
    lastState.isHalfDay = true;
    lastState.tradingCalendarSnapshot = tradingCalendarSnapshot;

    let capturedInput: {
      readonly signals: ReadonlyArray<ExecutableSellSignal>;
      readonly smartCloseTimeoutMinutes: number | null;
      readonly isHalfDay: boolean;
      readonly tradingCalendarSnapshot: ReadonlyMap<
        string,
        { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
      >;
      readonly nowMs: number;
    } | null = null;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: (input: unknown) => {
        const typedInput = input as {
          readonly signals: ReadonlyArray<ExecutableSellSignal>;
          readonly smartCloseTimeoutMinutes: number | null;
          readonly isHalfDay: boolean;
          readonly tradingCalendarSnapshot: ReadonlyMap<
            string,
            { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
          >;
          readonly nowMs: number;
        };
        capturedInput = typedInput;
        return [...typedInput.signals];
      },
      resetRiskCheckCooldown: () => {},
    };

    const trader = createTraderDouble({
      executeSignals: async () => ({ executedOrderIds: ['EXECUTED-ORDER-1'] }),
    });

    const monitorContext = createMonitorContext({
      config: createMonitorConfigDouble({
        smartCloseTimeoutMinutes: 45,
      }),
    });

    let quoteRequest: Iterable<string> | null = null;
    const marketDataClient = createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        quoteRequest = symbols;
        return new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
        ]);
      },
    });

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient,
      getLastState: () => lastState,
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => capturedInput !== null,
    });

    const captured = capturedInput as {
      readonly signals: ReadonlyArray<ExecutableSellSignal>;
      readonly smartCloseTimeoutMinutes: number | null;
      readonly isHalfDay: boolean;
      readonly tradingCalendarSnapshot: ReadonlyMap<
        string,
        { readonly isTradingDay: boolean; readonly isHalfDay: boolean }
      >;
      readonly nowMs: number;
    } | null;
    if (captured === null) {
      throw new Error('processSellSignals input not captured');
    }

    expect(captured.smartCloseTimeoutMinutes).toBe(45);
    expect(captured.isHalfDay).toBe(true);
    expect(captured.tradingCalendarSnapshot).toBe(tradingCalendarSnapshot);
    expect(captured.nowMs).toBe(SELL_PROCESSOR_NOW_MS);
    const requestedSymbols = [...quoteRequest!] as string[];
    expect(requestedSymbols).toHaveLength(2);
    expect(requestedSymbols[0]).toBe('BULL.HK');
    expect(requestedSymbols[1]).toBe('BEAR.HK');
  });

  it('executes the processed sell signal returned by quantity resolution', async () => {
    const queue = createSellTaskQueue();
    const processedSignalUpdates = {
      quantity: 300,
      relatedBuyOrderIds: ['buy-order-1'],
      reason: '智能平仓卖出',
    };
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        const firstSignal = signals[0];
        if (!firstSignal) {
          throw new Error('sell signal should exist');
        }

        return [
          {
            ...firstSignal,
            ...processedSignalUpdates,
          },
        ];
      },
      resetRiskCheckCooldown: () => {},
    };

    let executedSignal: Signal | null = null;
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedSignal = signals[0] ?? null;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => executedSignal !== null,
    });

    const submittedSignal = requireSignal(executedSignal);
    expect(submittedSignal.quantity).toBe(processedSignalUpdates.quantity);
    expect(submittedSignal.relatedBuyOrderIds).toEqual(processedSignalUpdates.relatedBuyOrderIds);
    expect(submittedSignal.reason).toBe(processedSignalUpdates.reason);
    expect(signal.quantity).toBeUndefined();
    expect(signal.relatedBuyOrderIds).toBeUndefined();
  });

  it('waits for postTradeConsistencyRuntime freshness before processing sell task', async () => {
    const queue = createSellTaskQueue();
    const lastState = createLastState();

    let executeCalls = 0;
    const trader = createTraderDouble({
      executeSignals: async () => {
        executeCalls += 1;
        return { executedOrderIds: ['EXECUTED-ORDER-1'] };
      },
    });

    const snapshot = createEmptySnapshotFixture({
      readPort: {
        getAccountSnapshot: () => trader.getAccountSnapshot(),
        getStockPositions: () => trader.getStockPositions(),
      },
    });
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      termination: createTerminationRuntime({
        closeTradingGate: () => {},
        closeProducerAdmission: () => {},
        stopProducers: [],
        onSecondaryError: () => {},
      }),
      getTrader: () => trader,
      snapshot,
      onPositionsCommitted: async (token) => {
        expect(
          snapshot.isCurrent(token, { account: true, positions: true, paired: true }),
        ).toBeTrue();
      },
      scheduler: SELL_PROCESSOR_RUNTIME.scheduler,
    });
    postTradeConsistencyRuntime.bindBusinessDeps({
      monitorContext: createMonitorContext({
        riskChecker: createRiskCheckerDouble(),
      }),
      dailyLossTracker: createDailyLossTrackerDouble(),
      liquidationCooldownTracker: {
        recordLiquidationTrigger: () => {},
      },
      protectiveLiquidationEpisodeTracker: {
        prepareCompletion: () => null,
        commitCompletion: () => {},
        getInProgressEpisodes: () => [],
      },
      mixedTradeLogRepository: {
        appendCompletionIdempotent: () => {},
      },
    });

    postTradeConsistencyRuntime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => lastState,
      snapshot,
      postTradeConsistencyRuntime,
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });

    await Bun.sleep(50);
    expect(processSellCalls).toBe(0);

    postTradeConsistencyRuntime.start();

    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(1);
  });

  it('treats STOP_AND_DRAIN freshness abort as normal processor shutdown', async () => {
    const queue = createSellTaskQueue();
    const fatalErrors: unknown[] = [];
    let waitForFreshCalls = 0;
    let processSellCalls = 0;
    let executeCalls = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
          processSellCalls += 1;
          return signals;
        },
        resetRiskCheckCooldown: () => {},
      },
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['EXECUTED-ORDER-1'] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      abortBeforeWait: 'STOP_AND_DRAIN',
      onWaitForFresh: () => {
        waitForFreshCalls += 1;
      },
      getCanProcessTask: () => true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => waitForFreshCalls === 1);
    await processor.stopAndDrain();

    expect(fatalErrors).toEqual([]);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('skips stale-seat-version sell signal before sell quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: () => {
        processSellCalls += 1;
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

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let staleSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    staleSignal = { ...staleSignal, seatVersion: 1 };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: staleSignal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('drops sell signal when seat version changes after quantity resolution and before execution', async () => {
    const queue = createSellTaskQueue();
    const monitorContext = createMonitorContext();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
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

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext,
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('retries sell non-blockingly when execution-time quote is missing, then executes after quote warms', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
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

    const scheduledRetries: Array<() => void> = [];
    let clearedRetryHandles = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', '1.1', 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {
          clearedRetryHandles += 1;
        },
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);

    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();
    expect(processSellCalls).toBe(1);
    expect(clearedRetryHandles).toBe(1);
  });

  it('drops sell execution when execution-time quote has invalid price instead of retrying', async () => {
    const queue = createSellTaskQueue();
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    const scheduledRetries: Array<() => void> = [];
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['EXECUTED-ORDER-1'] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '0', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {},
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(scheduledRetries).toHaveLength(0);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('cancels pending sell retry during stopAndDrain and does not re-enqueue stale signal', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
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

    const scheduledRetries: Array<() => void> = [];
    let clearedRetryHandles = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', '1.1', 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {
          clearedRetryHandles += 1;
        },
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    await processor.stopAndDrain();
    expect(clearedRetryHandles).toBe(1);

    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await Bun.sleep(30);

    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('continues scheduling sell quote retries across multiple unresolved rounds', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
        return signals;
      },
      resetRiskCheckCooldown: () => {},
    };

    let executeCalls = 0;
    let clearedRetryHandles = 0;
    const scheduledRetries: Array<() => void> = [];
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['EXECUTED-ORDER-1'] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', '1.1', 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {
          clearedRetryHandles += 1;
        },
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    const firstRetry = scheduledRetries[0];
    if (!firstRetry) {
      throw new Error('first retry callback should exist');
    }

    firstRetry();
    await waitUntil(() => scheduledRetries.length === 2);
    firstRetry();
    expect(queue.isEmpty()).toBe(true);
    expect(processSellCalls).toBe(0);

    quoteReady = true;
    const secondRetry = scheduledRetries[1];
    if (!secondRetry) {
      throw new Error('second retry callback should exist');
    }

    secondRetry();
    await waitUntil(() => executeCalls === 1);
    await processor.stopAndDrain();

    expect(processSellCalls).toBe(1);
    expect(clearedRetryHandles).toBe(1);
  });

  it('re-enqueues sell retry with detached trigger time and related buy order IDs', async () => {
    const queue = createSellTaskQueue();
    let quoteReady = false;
    let executedSignal: Signal | null = null;
    const scheduledRetries: Array<() => void> = [];
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) =>
        signals,
      resetRiskCheckCooldown: () => {},
    };
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        executedSignal = signals[0] ?? null;
        return { executedOrderIds: signals.map(() => `EXECUTED-ORDER`) };
      },
    });
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', quoteReady ? createQuoteDouble('BULL.HK', '1.1', 100) : null],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {},
      },
    });

    const relatedBuyOrderIds = ['BUY-1'];
    const triggerTime = new Date(SELL_PROCESSOR_NOW_MS);
    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };
    signal = { ...signal, relatedBuyOrderIds, triggerTime };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => scheduledRetries.length === 1);

    relatedBuyOrderIds.push('BUY-2');
    triggerTime.setTime(SELL_PROCESSOR_NOW_MS + 1);
    quoteReady = true;
    const retryCallback = scheduledRetries[0];
    if (!retryCallback) {
      throw new Error('retry callback should exist');
    }

    retryCallback();
    await waitUntil(() => executedSignal !== null);
    await processor.stopAndDrain();

    const submittedSignal = requireSignal(executedSignal);
    expect(submittedSignal.relatedBuyOrderIds).toEqual(['BUY-1']);
    expect(submittedSignal.relatedBuyOrderIds).not.toBe(relatedBuyOrderIds);
    expect(submittedSignal.triggerTime?.getTime()).toBe(SELL_PROCESSOR_NOW_MS);
    expect(submittedSignal.triggerTime).not.toBe(triggerTime);
  });

  it('does not register new sell retry after stopAndDrain begins while task is still in flight', async () => {
    const queue = createSellTaskQueue();
    let releaseQuotes:
      ((quotes: Map<string, ReturnType<typeof createQuoteDouble> | null>) => void) | null = null;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) =>
        signals,
      resetRiskCheckCooldown: () => {},
    };

    const scheduledRetries: Array<() => void> = [];
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader: createTraderDouble(),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          await new Promise<Map<string, ReturnType<typeof createQuoteDouble> | null>>((resolve) => {
            releaseQuotes = resolve;
          }),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
      scheduler: {
        scheduleTimer: (callback) => {
          scheduledRetries.push(callback);
          return setTimeout(() => {}, 0);
        },
        clearTimer: () => {},
      },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });
    await waitUntil(() => releaseQuotes !== null);

    const drainPromise = processor.stopAndDrain();
    const resolveQuotes = releaseQuotes!;

    resolveQuotes(
      new Map([
        ['BULL.HK', null],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
      ]),
    );
    await drainPromise;

    expect(scheduledRetries).toHaveLength(0);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('does not execute when processSellSignals turns signal into HOLD', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
        return signals.map((signal) => ({
          ...signal,
          action: 'HOLD' as const,
          isProtectiveLiquidation: false as const,
        }));
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

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });

  it('sends submitOrder API failure to fatal channel', async () => {
    const queue = createSellTaskQueue();
    const submitError = await createExternalApiRequestError({
      operation: 'TradeContext.submitOrder',
      attempts: 1,
      cause: new Error('submit timeout'),
    });
    const fatalErrors: unknown[] = [];
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) =>
        signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
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
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('SELLCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => fatalErrors.length === 1,
    });

    expect(fatalErrors).toEqual([submitError]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('consumes non-submit external API failures without fatal channel escalation', async () => {
    const queue = createSellTaskQueue();
    const quoteError = await createExternalApiRequestError({
      operation: 'QuoteContext.realtimeQuote',
      attempts: 1,
      cause: new Error('quote timeout'),
    });
    const fatalErrors: unknown[] = [];
    let executeCalls = 0;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) =>
        signals,
      resetRiskCheckCooldown: () => {},
    };

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
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
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: () => true,
      termination: {
        isTerminated: () => false,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      },
    });

    await runProcessorFlow({
      processor,
      pushTask: () => {
        let signal = createSignalDouble('SELLCALL', 'BULL.HK');
        signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => executeCalls === 1,
    });

    expect(fatalErrors).toEqual([]);
    expect(queue.isEmpty()).toBeTrue();
  });

  it('base gate blocks sell task before freshness wait and sell quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let waitForFreshCalls = 0;
    let processSellCalls = 0;
    let executeCalls = 0;
    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: {
        applyRiskChecks: async () => [],
        processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
          processSellCalls += 1;
          return signals;
        },
        resetRiskCheckCooldown: () => {},
      },
      trader: createTraderDouble({
        executeSignals: async () => {
          executeCalls += 1;
          return { executedOrderIds: ['EXECUTED-ORDER-1'] };
        },
      }),
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      onWaitForFresh: () => {
        waitForFreshCalls += 1;
      },
      getCanProcessTask: () => false,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    processor.start();
    queue.push({ type: 'STRATEGY_SELL', data: signal });

    await Bun.sleep(40);
    await processor.stopAndDrain();

    expect(waitForFreshCalls).toBe(0);
    expect(processSellCalls).toBe(0);
    expect(executeCalls).toBe(0);
  });

  it('blocks final execution when lifecycle gate closes after sell-quantity resolution', async () => {
    const queue = createSellTaskQueue();

    let processSellCalls = 0;
    let authorized = true;
    const signalProcessor = {
      applyRiskChecks: async () => [],
      processSellSignals: ({ signals }: { signals: ReadonlyArray<ExecutableSellSignal> }) => {
        processSellCalls += 1;
        authorized = false;
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

    const dynamicGate = () => authorized;

    const processor = await createSellProcessorHarness({
      ...SELL_PROCESSOR_RUNTIME,
      taskQueue: queue,
      monitorContext: createMonitorContext(),
      signalProcessor: signalProcessor,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () =>
          new Map([
            ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
            ['BEAR.HK', createQuoteDouble('BEAR.HK', '0.9', 100)],
          ]),
      }),
      getLastState: () => createLastState(),
      getCanProcessTask: dynamicGate,
      termination: { isTerminated: () => false, reportFatalError: rethrowFatalError },
    });

    let signal = createSignalDouble('SELLCALL', 'BULL.HK');
    signal = { ...signal, seatVersion: 2, triggerTime: new Date(SELL_PROCESSOR_NOW_MS) };

    await runProcessorFlow({
      processor,
      pushTask: () => {
        queue.push({ type: 'STRATEGY_SELL', data: signal });
      },
      waitCondition: () => processSellCalls === 1,
      timeoutMs: 800,
    });
    await Bun.sleep(20);

    expect(executeCalls).toBe(0);
  });
});
