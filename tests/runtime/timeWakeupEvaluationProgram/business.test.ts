import type { TradingCalendarState, TradingDayInfo } from '../../../src/types/tradingCalendar.js';
import type { RuntimeStateFixtures } from '../../helpers/types.js';

/**
 * timeWakeupEvaluationProgram 业务测试
 *
 * 覆盖单次时间唤醒评估的门禁状态、生命周期顺序与系统级唤醒候选输出。
 */
import { describe, expect, it } from 'bun:test';
import { TRADING } from '../../../src/constants/index.js';
import { createDoomsdayClearanceWorkflow } from '../../../src/application/doomsdayClearance/index.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { Position } from '../../../src/types/account.js';
import { timeWakeupEvaluationProgram } from '../../../src/runtime/timeWakeupEvaluationProgram/index.js';
import { createTradeMutationUnknownError } from '../../../src/application/orderExecution/tradeMutationErrors.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { TimeWakeupEvaluationContext } from '../../../src/runtime/timeWakeupEvaluationProgram/types.js';
import type { TradingConfig } from '../../../src/types/config.js';
import type {
  AutoSearchAuthorizationChangedEvent,
  DayLifecycleTickResult,
  LifecycleRuntimeFlags,
} from '../../../src/types/timeControlPlane.js';
import type {
  DoomsdayEvaluationContext,
  DoomsdayClearanceResult,
  DoomsdayClearanceWorkflow,
} from '../../../src/application/doomsdayClearance/types.js';

import {
  createAccountSnapshotDouble,
  createPositionDouble,
  createQuoteDouble,
  createMarketDataClientDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

type TimeWakeupEvaluationHarnessOptions = Readonly<{
  now: Date;
  getNow?: () => Date;
  initialCanTrade?: boolean | null;
  morningProtectionMinutes?: number | null;
  afternoonProtectionMinutes?: number | null;
  invalidateStrategy?: () => void;
  lifecycleTick?: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<DayLifecycleTickResult>;
  emitGateStateChanged?: () => void;
  emitAutoSearchAuthorizationChanged?: (event: AutoSearchAuthorizationChangedEvent) => void;
  doomsdayResult?: DoomsdayClearanceResult;
  onDoomsdayEvaluate?: (context: DoomsdayEvaluationContext) => void | Promise<void>;
  positions?: ReadonlyArray<Position>;
  doomsdayClearanceWorkflow?: Pick<DoomsdayClearanceWorkflow, 'evaluate'>;
  tradeRuntimeOverrides?: Parameters<typeof createTradeRuntimeDouble>[0];
  cachedTradingDayInfo?: TradingCalendarState['cachedTradingDayInfo'];
  isTradingDay?: (date: Date) => Promise<TradingDayInfo>;
  getQuotes?: TimeWakeupEvaluationContext['marketDataClient']['getQuotes'];
  logger?: TimeWakeupEvaluationContext['logger'];
}>;

async function expectPromiseRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

function createRuntimeStates(
  options: Pick<TimeWakeupEvaluationHarnessOptions, 'initialCanTrade' | 'cachedTradingDayInfo'>,
): RuntimeStateFixtures {
  return {
    tradingTimeState: {
      canTrade: options.initialCanTrade ?? false,
      isHalfDay: false,
      openProtectionActive: false,
    },
    lifecycleState: {
      currentDayKey: '2026-04-29',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    },
    tradingCalendarState: {
      cachedTradingDayInfo: options.cachedTradingDayInfo ?? {
        dateKey: '2026-04-29',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
      tradingCalendarSnapshot: new Map([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    },
    quoteSubscriptionState: { allTradingSymbols: new Set() },
  };
}

function createTradingConfig(
  morningProtectionMinutes: number | null,
  afternoonProtectionMinutes: number | null,
): TradingConfig {
  return {
    monitor: createMonitorConfigDouble({ monitorSymbol: '700.HK' }),
    global: {
      doomsdayProtection: true,
      openProtection: {
        morning: { enabled: morningProtectionMinutes !== null, minutes: morningProtectionMinutes },
        afternoon: {
          enabled: afternoonProtectionMinutes !== null,
          minutes: afternoonProtectionMinutes,
        },
      },
      orderMonitorPriceUpdateInterval: 1,
      allowBuyOrderTrackingAboveInitialPrice: false,
      tradingOrderType: 'ELO',
      liquidationOrderType: 'ELO',
      buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
      sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
    },
  };
}

async function createTimeWakeupEvaluationHarness(
  options: TimeWakeupEvaluationHarnessOptions,
): Promise<
  TimeWakeupEvaluationContext &
    RuntimeStateFixtures &
    Readonly<{ snapshot: AccountPositionSnapshot; stageCalls: string[] }>
> {
  const stateFixtures = createRuntimeStates(options);
  const stageCalls: string[] = [];
  let initialized = false;
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: options.positions ?? [],
    readPort: {
      getAccountSnapshot: async () => {
        if (initialized) {
          stageCalls.push('account-read');
          return (
            options.tradeRuntimeOverrides?.accountService?.getAccountSnapshot?.() ??
            createAccountSnapshotDouble('100000')
          );
        }

        return createAccountSnapshotDouble('100000');
      },
      getStockPositions: async () => {
        if (initialized) {
          stageCalls.push('position-read');
          return (
            options.tradeRuntimeOverrides?.accountService?.getStockPositions?.() ??
            options.positions ??
            []
          );
        }

        return options.positions ?? [];
      },
    },
  });
  initialized = true;
  const originToken = snapshot.getView().token;
  expect(snapshot.isCurrent(originToken, { account: true, positions: true, paired: true })).toBe(
    true,
  );
  const monitorConfig = createMonitorConfigDouble({ monitorSymbol: '700.HK' });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    ...(options.invalidateStrategy
      ? {
          strategy: {
            ...createMonitorContextDouble().strategy,
            invalidateAll: options.invalidateStrategy,
          },
        }
      : {}),
  });
  const { cacheManager, orderMonitor, orderExecutor } = createTradeRuntimeDouble(
    options.tradeRuntimeOverrides,
  );
  return {
    logger: createLoggerDouble(),
    marketDataClient: createMarketDataClientDouble({
      ...(options.getQuotes ? { getQuotes: options.getQuotes } : {}),
      isTradingDay: async (date) => {
        stageCalls.push('calendar');
        return options.isTradingDay?.(date) ?? { isTradingDay: true, isHalfDay: false };
      },
    }),
    cacheManager,
    orderMonitor,
    orderExecutor,
    ...stateFixtures,
    snapshot,
    stageCalls,
    doomsdayClearanceWorkflow: options.doomsdayClearanceWorkflow ?? {
      evaluate: async (context) => {
        stageCalls.push('doomsday-evaluate');
        expect(context.snapshot).toBe(snapshot);
        expect(context.dayEpoch).toBe(originToken.dayEpoch);
        await options.onDoomsdayEvaluate?.(context);
        return options.doomsdayResult ?? { executed: false, nextRetryAtMs: null };
      },
    },
    tradingConfig: createTradingConfig(
      options.morningProtectionMinutes ?? null,
      options.afternoonProtectionMinutes ?? null,
    ),
    monitorContext,
    tradingGateEventRuntime: {
      emitGateStateChanged: () => {
        stageCalls.push('gate');
        options.emitGateStateChanged?.();
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        stageCalls.push('authorization');
        options.emitAutoSearchAuthorizationChanged?.(event);
      },
    },
    dayLifecycleManager: {
      tick: async (date, runtime) => {
        stageCalls.push('lifecycle');
        return (
          options.lifecycleTick?.(date, runtime) ?? {
            nextRetryAtMs: null,
            pendingOpenRebuild: false,
          }
        );
      },
    },
    now: options.getNow ?? (() => options.now),
  };
}

describe('timeWakeupEvaluationProgram', () => {
  it('初始评估使用注入时间而不读取不同的系统时间', async () => {
    const injectedNow = new Date('2026-04-29T09:30:00.000+08:00');
    const originalNow = Date.now;
    Date.now = () => new Date('2035-01-02T02:00:00.000Z').getTime();
    const observedTradingDayTimes: number[] = [];

    try {
      const context = await createTimeWakeupEvaluationHarness({
        now: injectedNow,
        initialCanTrade: false,
        cachedTradingDayInfo: null,
        isTradingDay: async (date) => {
          observedTradingDayTimes.push(date.getTime());
          return { isTradingDay: true, isHalfDay: false };
        },
      });
      context.tradingCalendarState.cachedTradingDayInfo = null;

      await timeWakeupEvaluationProgram(context);

      expect(observedTradingDayTimes).toEqual([injectedNow.getTime()]);
      expect(context.tradingTimeState.canTrade).toBe(true);
      expect(injectedNow.getTime()).not.toBe(Date.now());
    } finally {
      Date.now = originalNow;
    }
  });

  it('异步末日用例复核注入时间而不读取不同的系统时间', async () => {
    let injectedNow = new Date('2026-04-29T15:50:00.000+08:00');
    const originalNow = Date.now;
    Date.now = () => new Date('2026-04-29T15:50:00.000+08:00').getTime();
    const observedIsLiveValues: boolean[] = [];

    try {
      const context = await createTimeWakeupEvaluationHarness({
        now: injectedNow,
        getNow: () => injectedNow,
        initialCanTrade: true,
        doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
          now: () => injectedNow,
          logger: createLoggerDouble(),
        }),
        tradeRuntimeOverrides: {
          cacheManager: {
            getPendingOrders: async () => {
              await Promise.resolve();
              injectedNow = new Date('2026-04-29T16:01:00.000+08:00');
              return [];
            },
          },
          orderExecutor: {
            executeDoomsdayClearanceSignals: async () => {
              observedIsLiveValues.push(true);
              throw new Error('注入时钟已离开窗口，不得清仓');
            },
          },
        },
      });

      await timeWakeupEvaluationProgram(context);

      expect(observedIsLiveValues).toEqual([]);
      expect(Date.now()).toBe(new Date('2026-04-29T15:50:00.000+08:00').getTime());
    } finally {
      Date.now = originalNow;
    }
  });

  it('交易日 API 失败时只安排 API_RETRY 且不更新交易门禁事实', async () => {
    let gateEmitted = false;
    let lifecycleCalled = false;
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      cachedTradingDayInfo: null,
      isTradingDay: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.isTradingDay',
          attempts: 1,
          cause: new Error('calendar unavailable'),
        });
      },
      lifecycleTick: async () => {
        lifecycleCalled = true;
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
      emitGateStateChanged: () => {
        gateEmitted = true;
      },
    });
    context.tradingCalendarState.cachedTradingDayInfo = null;

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.hasWork).toBe(true);
    expect(result.plan.nextWakeupAtMs).toBe(
      new Date('2026-04-29T09:30:00.000+08:00').getTime() + TRADING.INTERVAL_MS,
    );
    expect(context.tradingCalendarState.cachedTradingDayInfo).toBeNull();
    expect(context.tradingTimeState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
    expect(lifecycleCalled).toBe(false);
  });

  it('交易日非 API 错误保持 fail-fast', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: null,
      isTradingDay: async () => {
        throw new TypeError('calendar contract broken');
      },
    });
    context.tradingCalendarState.cachedTradingDayInfo = null;

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /calendar contract broken/,
    );
    expect(context.stageCalls).toContain('calendar');
    expect(context.stageCalls).not.toContain('doomsday-evaluate');
  });

  it('生命周期 API 失败时只安排 API_RETRY 且不提前提交交易门禁变化', async () => {
    let gateEmitted = false;
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      lifecycleTick: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.lifecycle',
          attempts: 1,
          cause: new Error('rebuild unavailable'),
        });
      },
      emitGateStateChanged: () => {
        gateEmitted = true;
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.hasWork).toBe(true);
    expect(result.plan.nextWakeupAtMs).toBe(
      new Date('2026-04-29T09:30:00.000+08:00').getTime() + TRADING.INTERVAL_MS,
    );
    expect(context.tradingTimeState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
  });

  it('在 lifecycle tick 后发布 gate event', async () => {
    const calls: string[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: false,
      lifecycleTick: async () => {
        calls.push('lifecycle');
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
      emitGateStateChanged: () => {
        calls.push('gate');
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['lifecycle', 'gate']);
  });

  it('正常日与半日末日清仓接管都会发布自动寻标授权关闭', async () => {
    const normalDayEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const normalDayContext = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:55:00.000+08:00'),
      initialCanTrade: true,
      emitAutoSearchAuthorizationChanged: (event) => {
        normalDayEvents.push(event);
      },
    });
    const halfDayEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const halfDayContext = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:55:00.000+08:00'),
      initialCanTrade: true,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        halfDayEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(normalDayContext);
    await timeWakeupEvaluationProgram(halfDayContext);

    expect(normalDayEvents).toEqual([{ previousAuthorized: null, nextAuthorized: false }]);
    expect(halfDayEvents).toEqual([{ previousAuthorized: null, nextAuthorized: false }]);
  });

  it('lifecycle 禁用与开盘重建恢复即使连续交易门禁不变也发布自动寻标授权转换', async () => {
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const gateCalls: string[] = [];
    let lifecycleState: RuntimeStateFixtures | null = null;
    let shouldEnableTrading = false;
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T10:00:00.000+08:00'),
      initialCanTrade: true,
      lifecycleTick: async () => {
        if (lifecycleState === null) {
          throw new Error('lifecycle state is unavailable');
        }

        lifecycleState.lifecycleState.isTradingEnabled = shouldEnableTrading;
        return { nextRetryAtMs: null, pendingOpenRebuild: !shouldEnableTrading };
      },
      emitGateStateChanged: () => {
        gateCalls.push('gate');
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });
    lifecycleState = context;

    await timeWakeupEvaluationProgram(context);
    shouldEnableTrading = true;
    await timeWakeupEvaluationProgram(context);

    expect(gateCalls).toEqual([]);
    expect(authorizationEvents).toEqual([
      { previousAuthorized: null, nextAuthorized: false },
      { previousAuthorized: false, nextAuthorized: true },
    ]);
  });

  it('keys both transition memories by the stable trading-time reference, not each evaluation envelope', async () => {
    const events: AutoSearchAuthorizationChangedEvent[] = [];
    let invalidations = 0;
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:55:00.000+08:00'),
      initialCanTrade: true,
      invalidateStrategy: () => {
        invalidations += 1;
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        events.push(event);
      },
    });
    const states = {
      tradingTimeState: context.tradingTimeState,
      lifecycleState: context.lifecycleState,
      tradingCalendarState: context.tradingCalendarState,
      quoteSubscriptionState: context.quoteSubscriptionState,
    };
    await timeWakeupEvaluationProgram(context);
    await timeWakeupEvaluationProgram({ ...context });
    expect(invalidations).toBe(1);
    expect(events).toEqual([{ previousAuthorized: null, nextAuthorized: false }]);
    for (const name of [
      'tradingTimeState',
      'lifecycleState',
      'tradingCalendarState',
      'quoteSubscriptionState',
    ] as const)
      expect(context[name]).toBe(states[name]);

    const independent = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:55:00.000+08:00'),
      initialCanTrade: true,
      invalidateStrategy: () => {
        invalidations += 1;
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        events.push(event);
      },
    });
    expect(independent.tradingTimeState).not.toBe(states.tradingTimeState);
    await timeWakeupEvaluationProgram(independent);
    expect(invalidations).toBe(2);
    expect(events).toHaveLength(2);
  });

  it('自动寻标授权消费方的内部错误保持 fail-fast', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T10:00:00.000+08:00'),
      emitAutoSearchAuthorizationChanged: () => {
        throw new TypeError('auto-search authorization listener contract broken');
      },
    });

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /auto-search authorization listener contract broken/,
    );
    expect(context.stageCalls).toContain('authorization');
    expect(context.stageCalls).not.toContain('doomsday-evaluate');
  });

  it('开盘保护保持 canTrade 为 true 且只标记 openProtectionActive', async () => {
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.canTrade).toBe(true);
    expect(context.tradingTimeState.openProtectionActive).toBe(true);
    expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: true }]);
  });

  it('12:00 关闭连续交易门禁并取消普通延迟验证', async () => {
    let cancelAllCalls = 0;
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
      initialCanTrade: true,
      invalidateStrategy: () => {
        cancelAllCalls += 1;
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.canTrade).toBe(false);
    expect(cancelAllCalls).toBe(1);
    expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: false }]);
  });

  it('午休结束后在连续交易恢复时发布自动寻标授权恢复', async () => {
    let currentTime = new Date('2026-04-29T12:00:00.000+08:00');
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: currentTime,
      getNow: () => currentTime,
      initialCanTrade: true,
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(context);
    currentTime = new Date('2026-04-29T13:00:00.000+08:00');
    await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.canTrade).toBe(true);
    expect(authorizationEvents).toEqual([
      { previousAuthorized: null, nextAuthorized: false },
      { previousAuthorized: false, nextAuthorized: true },
    ]);
  });

  it('多个 retry 中选择最早的 lifecycle retry', async () => {
    const now = new Date('2026-04-29T15:56:00.000+08:00');
    const context = await createTimeWakeupEvaluationHarness({
      now,
      lifecycleTick: async () => ({
        nextRetryAtMs: now.getTime() + 30_000,
        pendingOpenRebuild: false,
      }),
      doomsdayResult: {
        executed: false,
        nextRetryAtMs: now.getTime() + 45_000,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(now.getTime() + 30_000);
  });

  it('不复用非当前 HK 日期的交易日缓存', async () => {
    const queriedDates: string[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-28',
        info: { isTradingDay: false, isHalfDay: false },
      },
      isTradingDay: async (date) => {
        queriedDates.push(date.toISOString());
        return { isTradingDay: true, isHalfDay: false };
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(queriedDates).toHaveLength(1);
    expect(context.tradingCalendarState.cachedTradingDayInfo).toEqual({
      dateKey: '2026-04-29',
      info: { isTradingDay: true, isHalfDay: false },
    });
    expect(context.tradingTimeState.canTrade).toBe(true);
  });

  it('交易日查询失败时向上抛出且不制造系统级 recovery 候选', async () => {
    const staleTradingDayInfo = {
      dateKey: '2026-04-28',
      info: { isTradingDay: false, isHalfDay: false },
    };
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: true,
      cachedTradingDayInfo: staleTradingDayInfo,
      isTradingDay: async () => {
        throw new Error('trading day unavailable');
      },
      lifecycleTick: async (_now, runtime) => {
        lifecycleRuntimeFlags.push(runtime);
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
    });

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /trading day unavailable/,
    );
    expect(context.tradingTimeState.canTrade).toBe(true);
    expect(context.tradingCalendarState.cachedTradingDayInfo).toEqual(staleTradingDayInfo);
    expect(lifecycleRuntimeFlags).toEqual([]);
    expect(context.stageCalls).toContain('calendar');
    expect(context.stageCalls).not.toContain('doomsday-evaluate');
  });

  it('非交易日关闭连续交易门禁且不生成盘中边界候选', async () => {
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      initialCanTrade: true,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: false, isHalfDay: false },
      },
      lifecycleTick: async (_now, runtime) => {
        lifecycleRuntimeFlags.push(runtime);
        return { nextRetryAtMs: null, pendingOpenRebuild: false };
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.canTrade).toBe(false);
    expect(lifecycleRuntimeFlags).toEqual([
      {
        dayKey: '2026-04-29',
        canTradeNow: false,
        isTradingDay: false,
      },
    ]);
  });

  it('在开盘前返回交易门禁边界候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:29:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T09:30:00.000+08:00').getTime());
  });

  it('正常日上午返回 12:00 午休交易门禁边界候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:35:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T12:00:00.000+08:00').getTime());
  });

  it('正常日午休返回 13:00 午后交易门禁边界候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T13:00:00.000+08:00').getTime());
  });

  it('半日市上午返回 12:00 收盘交易门禁边界候选且无 13:00 候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:59:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T12:00:00.000+08:00').getTime());
  });

  it('在开盘保护窗口内返回保护结束候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T09:35:00.000+08:00').getTime());
  });

  it('正常日午盘开盘保护只标记保护状态并返回保护结束候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.canTrade).toBe(true);
    expect(context.tradingTimeState.openProtectionActive).toBe(true);
    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T13:05:00.000+08:00').getTime());
  });

  it('半日市不生成午盘开盘保护候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.tradingTimeState.openProtectionActive).toBe(false);
    expect(result.plan.nextWakeupAtMs).not.toBe(
      new Date('2026-04-29T13:05:00.000+08:00').getTime(),
    );
  });

  it('在收盘前返回市场收盘边界候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:59:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T16:00:00.000+08:00').getTime());
  });

  it('正常日下午 13:05 返回末日保护买入截止入口候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:05:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T15:45:00.000+08:00').getTime());
  });

  it('末日买入截止窗口内向末日 owner 交付评估事实', async () => {
    const calls: string[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:46:00.000+08:00'),
      onDoomsdayEvaluate: ({ currentTime, isHalfDay }) => {
        calls.push('doomsday-evaluate');
        expect(currentTime.toISOString()).toBe('2026-04-29T07:46:00.000Z');
        expect(isHalfDay).toBe(false);
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['doomsday-evaluate']);
  });

  it('正常日 15:50 返回末日保护清仓接管入口候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:50:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T15:55:00.000+08:00').getTime());
  });

  it('末日清仓接管窗口内触发用例并按返回值规划 retry', async () => {
    const calls: string[] = [];
    const retryAtMs = new Date('2026-04-29T15:57:00.000+08:00').getTime();
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      onDoomsdayEvaluate: () => {
        calls.push('doomsday-evaluate');
      },
      doomsdayResult: {
        executed: false,
        nextRetryAtMs: retryAtMs,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['doomsday-evaluate']);
    expect(context.stageCalls).toContain('doomsday-evaluate');
    expect(result.plan.nextWakeupAtMs).toBe(retryAtMs);
  });

  it('末日 all-success accepted 只失效账户，持仓保持 canonical 直到真实成对刷新', async () => {
    const actionTime = new Date('2026-04-29T15:56:00.000+08:00');
    let submitCalls = 0;
    let quoteReads = 0;
    const context = await createTimeWakeupEvaluationHarness({
      now: actionTime,
      positions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      ],
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
        now: () => actionTime,
        logger: createLoggerDouble(),
      }),
      getQuotes: async () => {
        quoteReads += 1;
        const quote = createQuoteDouble('BULL.HK', '1');
        expect(quote.price).toBe('1');
        return new Map([['BULL.HK', quote]]);
      },
      tradeRuntimeOverrides: {
        orderExecutor: {
          executeDoomsdayClearanceSignals: async (commands) => {
            submitCalls += 1;
            expect(commands).toHaveLength(1);
            expect(commands[0]?.symbol).toBe('BULL.HK');
            expect(commands[0]?.action).toBe('SELLCALL');
            expect(commands[0]?.seatVersion).toBe(
              context.monitorContext.symbolRegistry.getSeatVersion('LONG'),
            );
            return {
              executedOrderIds: ['ACCEPTED-1'],
              reevaluationSymbols: [],
              unresolvedQuoteSymbols: [],
            };
          },
        },
      },
    });
    const originView = context.snapshot.getView();
    await timeWakeupEvaluationProgram(context);
    const afterAccepted = context.snapshot.getView();
    expect(quoteReads).toBe(1);
    expect(submitCalls).toBe(1);
    expect(afterAccepted.positions).toBe(originView.positions);
    expect(afterAccepted.positions[0]?.quantity).toBe(500);
    expect(afterAccepted.account).toBe(originView.account);
    expect(afterAccepted.accountInitialized).toBe(true);
    expect(afterAccepted.accountValid).toBe(false);
    expect(afterAccepted.positionsValid).toBe(true);
    expect(afterAccepted.token.dayEpoch).toBe(originView.token.dayEpoch);
    expect(afterAccepted.token.snapshotGeneration).toBe(originView.token.snapshotGeneration + 1);
    expect(afterAccepted.token.positionRevision).toBe(originView.token.positionRevision);
    expect(afterAccepted.token.accountRevision).toBe(originView.token.accountRevision);
    expect(context.stageCalls).not.toContain('account-read');
    expect(context.stageCalls).not.toContain('position-read');
    const receipt = await context.snapshot.requestRefresh({
      source: 'TEST_OBSERVE_CANONICAL',
      dayEpoch: originView.token.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    }).result;
    if (receipt.status !== 'COMMITTED') throw new Error('真实 H refresh 必须提交成对事实');

    expect(
      context.snapshot.isCurrent(receipt.snapshotToken, {
        account: true,
        positions: true,
        paired: true,
      }),
    ).toBe(true);
    expect(context.snapshot.getView().positions[0]?.quantity).toBe(500);
    expect(context.stageCalls.slice(-2)).toEqual(['account-read', 'position-read']);
  });

  it('撤单 await 中日切使旧 origin epoch 的清仓失效，不借新 view 继续提交', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
        now: () => new Date('2026-04-29T15:56:00.000+08:00'),
        logger: createLoggerDouble(),
      }),
      tradeRuntimeOverrides: {
        cacheManager: {
          getPendingOrders: async () => {
            const nextEpoch = context.snapshot.getView().token.dayEpoch + 1;
            await context.snapshot.requestClear({ reason: 'DAY_CUT', dayEpoch: nextEpoch });
            return [];
          },
        },
        orderExecutor: {
          executeDoomsdayClearanceSignals: async () => {
            throw new Error('旧 origin epoch 不得继续提交');
          },
        },
      },
    });
    await timeWakeupEvaluationProgram(context);
    expect(context.stageCalls).not.toContain('doomsday-evaluate');
    expect(context.stageCalls).not.toContain('account-read');
    expect(context.stageCalls).not.toContain('position-read');
  });

  it('末日清仓 UNKNOWN 原错误直接上抛，不刷新持仓、不协调订阅、不返回重评估计划', async () => {
    const submissionError = createTradeMutationUnknownError({
      kind: 'UNKNOWN',
      operation: 'TradeContext.submitOrder',
      requestAttempted: true,
      code: null,
      cause: new Error('submit outcome unknown'),
    });
    const calls: string[] = [];
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      positions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
      ],
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
        now: () => new Date('2026-04-29T15:56:00.000+08:00'),
        logger: createLoggerDouble(),
      }),
      getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', '1')]]),
      tradeRuntimeOverrides: {
        orderExecutor: {
          executeDoomsdayClearanceSignals: async () => {
            calls.push('submit');
            throw submissionError;
          },
        },
        accountService: {
          getStockPositions: async () => {
            calls.push('getStockPositions');
            throw new Error('UNKNOWN 不允许启动额外持仓请求');
          },
        },
      },
    });

    const originToken = context.snapshot.getView().token;
    const originPositions = context.snapshot.getView().positions;
    const caught = await timeWakeupEvaluationProgram(context).catch((error: unknown) => error);
    expect(caught).toBe(submissionError);
    expect(context.stageCalls).toEqual(['lifecycle', 'gate', 'authorization']);
    expect(context.snapshot.getView().token).toEqual(originToken);
    expect(context.snapshot.getView().positions).toBe(originPositions);
    expect(calls).toEqual(['submit']);
  });

  it('半日市 11:40 返回 11:45 买入截止窗口入口', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:40:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T11:45:00.000+08:00').getTime());
  });

  it('半日市 11:46 返回 11:55 清仓接管窗口入口', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T11:46:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T11:55:00.000+08:00').getTime());
  });

  it('收盘后仍返回下一 HK day boundary 候选', async () => {
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T16:01:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-30T00:00:00.000+08:00').getTime());
  });

  it('同日交易日缓存命中时不调用 marketDataClient.isTradingDay', async () => {
    let queryCount = 0;
    const context = await createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: false },
      },
      isTradingDay: async () => {
        queryCount += 1;
        return { isTradingDay: true, isHalfDay: false };
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(queryCount).toBe(0);
  });
});
