import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';

/**
 * DoomsdayClearanceWorkflow 业务测试
 *
 * 验证唯一 owner 的撤买→清仓顺序、提交不清买单、失败分类与 fatal/正常排空，不构造 broker SDK 事实。
 */
import { describe, expect, it } from 'bun:test';
import { createDoomsdayClearanceWorkflow } from '../../../src/application/doomsdayClearance/index.js';
import type { DoomsdayEvaluationContext } from '../../../src/application/doomsdayClearance/types.js';
import { createTimeWakeupRuntime } from '../../../src/runtime/timeWakeupRuntime/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createTradeMutationUnknownError } from '../../../src/application/orderExecution/tradeMutationErrors.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { TRADING } from '../../../src/constants/index.js';
import type { Position } from '../../../src/types/account.js';
import type { Logger } from '../../../src/types/logger.js';

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 用真实 snapshot owner 及中性端口装配末日实例，记录所有允许的业务副作用。 */
async function createHarness() {
  const currentTime = new Date('2026-04-29T07:56:00.000Z');
  const positions: ReadonlyArray<Position> = ['BULL.HK', 'BEAR.HK'].map((symbol) => ({
    accountChannel: 'lb',
    symbol,
    symbolName: symbol,
    quantity: 100,
    availableQuantity: 100,
    currency: 'HKD',
    costPrice: '1',
  }));
  const calls: string[] = [];
  const snapshot = await createSnapshotFixture({
    account: {
      currency: 'HKD',
      totalCash: '100000',
      netAssets: '100200',
      positionValue: '200',
      cashInfos: [{ currency: 'HKD', availableCash: '100000' }],
    },
    positions,
  });
  const stateFixtures = createRuntimeStateFixtures({
    tradingTimeState: {},
    lifecycleState: { isTradingEnabled: true },
    tradingCalendarState: {},
    quoteSubscriptionState: {},
  });
  const context: DoomsdayEvaluationContext = {
    currentTime,
    isHalfDay: false,
    dayEpoch: snapshot.getView().token.dayEpoch,
    snapshot,
    ...stateFixtures,
    monitorContext: {
      config: { monitorSymbol: 'HSI.HK' },
      symbolRegistry: {
        getSeatState: (direction) => ({
          symbol: direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        }),
        getSeatVersion: () => 1,
      },
      seatSwitch: { hasPendingSwitch: () => false },
    },
    marketDataClient: {
      getQuotes: async (symbols) => {
        calls.push('quotes');
        return new Map(
          [...symbols].map((symbol) => [
            symbol,
            {
              symbol,
              name: symbol,
              price: '1',
              prevClose: '1',
              timestamp: currentTime.getTime(),
            },
          ]),
        );
      },
    },
    cacheManager: {
      getPendingOrders: async () => {
        calls.push('pending-buys');
        return [];
      },
    },
    orderMonitor: {
      cancelDoomsdayOrder: async () => {
        throw new Error('此场景没有买单，不得撤单');
      },
    },
    orderExecutor: {
      executeDoomsdayClearanceSignals: async (commands, isLive) => {
        expect(isLive()).toBe(true);
        calls.push('submit');
        return {
          executedOrderIds: commands.map((command) => `ACCEPTED:${command.symbol}`),
          reevaluationSymbols: [],
          unresolvedQuoteSymbols: [],
        };
      },
    },
  };
  return {
    context,
    snapshot,
    calls,
    stateFixtures,
    workflow: createDoomsdayClearanceWorkflow({ now: () => currentTime, logger }),
  };
}

describe('DoomsdayClearanceWorkflow', () => {
  it('撤买后清仓，全部 accepted 只失效账户，不清本地买单或修改 canonical 持仓', async () => {
    const { workflow, context, snapshot, calls } = await createHarness();
    const before = snapshot.getView();
    expect(await workflow.evaluate(context)).toEqual({ executed: true, nextRetryAtMs: null });
    expect(calls).toEqual(['pending-buys', 'quotes', 'submit']);
    const after = snapshot.getView();
    expect(after.positions).toBe(before.positions);
    expect(after.account).toBe(before.account);
    expect(after.accountValid).toBe(false);
    expect(after.positionsValid).toBe(true);
    expect(after.token.snapshotGeneration).toBe(before.token.snapshotGeneration + 1);
    expect(after.token.positionRevision).toBe(before.token.positionRevision);
  });

  it('SWITCHING 无有效 pending 或 ACTIVATING 新席位不能承接旧持仓归属', async () => {
    for (const status of ['SWITCHING', 'ACTIVATING'] as const) {
      const { workflow, context, calls } = await createHarness();
      const result = await workflow
        .evaluate({
          ...context,
          monitorContext: {
            ...context.monitorContext,
            symbolRegistry: {
              ...context.monitorContext.symbolRegistry,
              getSeatState: (direction) =>
                direction === 'LONG'
                  ? {
                      symbol: 'BULL.HK',
                      status,
                      lastSwitchAt: null,
                      lastSearchAt: null,
                      lastSeatActivatedAt: null,
                      searchFailCountToday: 0,
                      frozenTradingDayKey: null,
                    }
                  : context.monitorContext.symbolRegistry.getSeatState(direction),
            },
            seatSwitch: { hasPendingSwitch: () => status === 'ACTIVATING' },
          },
        })
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(result instanceof Error && result.message).toContain('无法安全自动清仓');
      expect(calls).toEqual(['pending-buys']);
    }
  });

  it('部分 accepted 不扩大账户失效条件', async () => {
    const { workflow, context, snapshot, calls } = await createHarness();
    const before = snapshot.getView();
    const result = await workflow.evaluate({
      ...context,
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => ({
          executedOrderIds: ['ACCEPTED:BULL.HK'],
          reevaluationSymbols: [],
          unresolvedQuoteSymbols: [],
        }),
      },
    });
    expect(result).toEqual({ executed: true, nextRetryAtMs: null });
    expect(snapshot.getView()).toEqual(before);
    expect(calls).toEqual(['pending-buys', 'quotes']);
  });

  it('可卖计划反复失效不消耗缺行情预算；两类标的同时等待时分别保留并按窗口调度', async () => {
    const { context } = await createHarness();
    let currentTime = context.currentTime;
    let round = 0;
    const workflow = createDoomsdayClearanceWorkflow({
      now: () => currentTime,
      logger,
      quoteRetryIntervalMs: 200,
      quoteRetryMaxAttempts: 1,
    });
    const requested: string[][] = [];
    const orderExecutor = {
      executeDoomsdayClearanceSignals: async (
        commands: Parameters<typeof context.orderExecutor.executeDoomsdayClearanceSignals>[0],
      ) => {
        requested.push(commands.map((command) => command.symbol));
        round += 1;
        return {
          executedOrderIds: [],
          reevaluationSymbols: round < 3 ? ['BULL.HK'] : [],
          unresolvedQuoteSymbols: round < 3 ? ['BEAR.HK'] : ['BULL.HK'],
        };
      },
    };
    const first = await workflow.evaluate({ ...context, currentTime, orderExecutor });
    expect(first.nextRetryAtMs).toBe(currentTime.getTime() + 200);
    currentTime = new Date(first.nextRetryAtMs!);
    const second = await workflow.evaluate({ ...context, currentTime, orderExecutor });
    expect(second.nextRetryAtMs).toBe(currentTime.getTime() + 200);
    currentTime = new Date(second.nextRetryAtMs!);
    const third = await workflow.evaluate({ ...context, currentTime, orderExecutor });
    // BEAR 缺价已耗尽，BULL 此前只有事实失效，第一次缺价仍有完整预算。
    expect(third.nextRetryAtMs).toBe(currentTime.getTime() + 200);
    expect(requested).toEqual([['BULL.HK', 'BEAR.HK'], ['BULL.HK', 'BEAR.HK'], ['BULL.HK']]);
  });

  it('明确行情读取失败保留系统级重评估，不把内部契约错误转换为重试', async () => {
    const { workflow, context, calls } = await createHarness();
    const externalError = await createExternalApiRequestError({
      operation: 'QuoteContext.quote',
      attempts: 1,
      cause: new Error('network timeout'),
    });
    const errorContext: DoomsdayEvaluationContext = {
      ...context,
      marketDataClient: {
        getQuotes: async () => {
          throw externalError;
        },
      },
    };
    expect(await workflow.evaluate(errorContext)).toEqual({
      executed: false,
      nextRetryAtMs: context.currentTime.getTime() + TRADING.INTERVAL_MS,
    });
    const internalError = new TypeError('invalid broker quote fact');
    const caught = await workflow
      .evaluate({
        ...context,
        marketDataClient: {
          getQuotes: async () => {
            throw internalError;
          },
        },
      })
      .catch((error: unknown) => error);
    expect(caught).toBe(internalError);
    expect(calls).toEqual(['pending-buys']);
  });

  it('撤买 await 中日切，旧 origin epoch 不继续清仓或修改新代次事实', async () => {
    const { workflow, context, snapshot, calls } = await createHarness();
    const result = await workflow.evaluate({
      ...context,
      cacheManager: {
        getPendingOrders: async () => {
          await snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: context.dayEpoch + 1 });
          return [];
        },
      },
    });
    expect(result).toEqual({ executed: false, nextRetryAtMs: null });
    expect(calls).toEqual([]);
    expect(snapshot.getView().token.dayEpoch).toBe(context.dayEpoch + 1);
  });

  it('submit UNKNOWN 原错关闭准入，由既有 runtime/fatal 及正常 cleanup 排空；不查询、不重提', async () => {
    const { workflow, context, snapshot, calls, stateFixtures } = await createHarness();
    const unknownError = createTradeMutationUnknownError({
      kind: 'UNKNOWN',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
      cause: new Error('submit outcome unknown'),
    });
    let evaluations = 0;
    const contextWithUnknown: DoomsdayEvaluationContext = {
      ...context,
      orderExecutor: {
        executeDoomsdayClearanceSignals: async () => {
          calls.push('submit');
          throw unknownError;
        },
      },
    };
    const before = snapshot.getView();
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        stateFixtures.lifecycleState.isTradingEnabled = false;
        calls.push('gate-closed');
      },
      closeProducerAdmission: () => {
        calls.push('admission-closed');
      },
      stopProducers: [],
      onSecondaryError: (error) => {
        throw error;
      },
    });
    const runtime = createTimeWakeupRuntime({
      termination,
      now: () => context.currentTime,
      logger,
      evaluate: async () => {
        evaluations += 1;
        const result = await workflow.evaluate(contextWithUnknown);
        return {
          plan:
            result.nextRetryAtMs === null
              ? { hasWork: false, nextWakeupAtMs: null }
              : { hasWork: true, nextWakeupAtMs: result.nextRetryAtMs },
        };
      },
      scheduleTimer: () => {
        throw new Error('UNKNOWN 不得安排专属重评估');
      },
      clearTimer: () => {},
    });
    await runtime.start();
    const fatalState = termination.getFatalState();
    expect(fatalState.hasFatalError && fatalState.error).toBe(unknownError);
    expect(stateFixtures.lifecycleState.isTradingEnabled).toBe(false);
    expect(snapshot.getView()).toEqual(before);
    expect(calls).toEqual(['pending-buys', 'quotes', 'submit', 'gate-closed', 'admission-closed']);
    await termination.waitForTermination();
    await runtime.stopAndDrain();
    await runtime.start();
    expect(evaluations).toBe(1);
  });
});
