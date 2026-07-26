/**
 * timeWakeupEvaluationProgram 业务测试
 *
 * 覆盖单次时间唤醒评估的门禁状态、生命周期顺序与系统级唤醒候选输出。
 */
import { describe, expect, it } from 'bun:test';
import { TRADING } from '../../../src/constants/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/main/timeWakeupEvaluationProgram/index.js';
import type { AutoSearchAuthorizationChangedEvent } from '../../../src/main/tradingGateEventRuntime/types.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import type { TimeWakeupEvaluationContext } from '../../../src/main/timeWakeupEvaluationProgram/types.js';
import type { LastState } from '../../../src/types/state.js';
import type { TradingConfig } from '../../../src/types/config.js';
import type {
  DayLifecycleTickResult,
  LifecycleRuntimeFlags,
} from '../../../src/main/lifecycle/types.js';
import type {
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
  DoomsdayClearanceResult,
} from '../../../src/core/doomsdayProtection/types.js';
import type { DelayedSignalVerifierPort } from '../../../src/types/monitorContextPorts.js';
import type { TradingDayInfo } from '../../../src/types/services.js';
import {
  createAccountSnapshotDouble,
  createDelayedSignalVerifierDouble,
  createDoomsdayProtectionDouble,
  createMarketDataClientDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteSubscriptionRuntimeDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

type TimeWakeupEvaluationHarnessOptions = Readonly<{
  now: Date;
  getNow?: () => Date;
  initialCanTrade?: boolean | null;
  morningProtectionMinutes?: number | null;
  afternoonProtectionMinutes?: number | null;
  verifier?: DelayedSignalVerifierPort;
  lifecycleTick?: (now: Date, runtime: LifecycleRuntimeFlags) => Promise<DayLifecycleTickResult>;
  emitGateStateChanged?: () => void;
  emitAutoSearchAuthorizationChanged?: (event: AutoSearchAuthorizationChangedEvent) => void;
  doomsdayClearanceResult?: DoomsdayClearanceResult;
  cancelPendingBuyOrdersResult?: CancelPendingBuyOrdersResult;
  onCancelPendingBuyOrders?: (context: CancelPendingBuyOrdersContext) => void | Promise<void>;
  onExecuteClearance?: () => void;
  onPositionsCommitted?: () => void;
  reconcilePositionHoldError?: Error;
  executeClearanceError?: Error;
  traderOverrides?: Parameters<typeof createTraderDouble>[0];
  cachedTradingDayInfo?: LastState['cachedTradingDayInfo'];
  isTradingDay?: (date: Date) => Promise<TradingDayInfo>;
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

function createLastState(
  options: Pick<TimeWakeupEvaluationHarnessOptions, 'initialCanTrade' | 'cachedTradingDayInfo'>,
): LastState {
  return {
    canTrade: options.initialCanTrade ?? false,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-29',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: createAccountSnapshotDouble(100_000),
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: options.cachedTradingDayInfo ?? {
      dateKey: '2026-04-29',
      info: {
        isTradingDay: true,
        isHalfDay: false,
      },
    },
    tradingCalendarSnapshot: new Map([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]),
    monitorState: {
      monitorSymbol: '700.HK',
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    allTradingSymbols: new Set(),
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

function createTimeWakeupEvaluationHarness(
  options: TimeWakeupEvaluationHarnessOptions,
): TimeWakeupEvaluationContext {
  const lastState = createLastState(options);
  const monitorConfig = createMonitorConfigDouble({ monitorSymbol: '700.HK' });
  const monitorContext = createMonitorContextDouble({
    config: monitorConfig,
    ...(options.verifier ? { delayedSignalVerifier: options.verifier } : {}),
  });
  return {
    logger: options.logger ?? createLoggerDouble(),
    marketDataClient: createMarketDataClientDouble({
      isTradingDay:
        options.isTradingDay ?? (async () => ({ isTradingDay: true, isHalfDay: false })),
    }),
    trader: createTraderDouble(options.traderOverrides),
    lastState,
    doomsdayProtection: createDoomsdayProtectionDouble({
      cancelPendingBuyOrders: async (context) => {
        await options.onCancelPendingBuyOrders?.(context);
        return (
          options.cancelPendingBuyOrdersResult ?? {
            executed: false,
            cancelRequestAcceptedCount: 0,
            nextRetryAtMs: null,
          }
        );
      },
      executeClearance: async (clearanceContext) => {
        options.onExecuteClearance?.();
        if (options.executeClearanceError !== undefined) {
          throw options.executeClearanceError;
        }

        await clearanceContext.onPositionsCommitted?.();
        return (
          options.doomsdayClearanceResult ?? {
            executed: false,
            nextRetryAtMs: null,
          }
        );
      },
    }),
    tradingConfig: createTradingConfig(
      options.morningProtectionMinutes ?? null,
      options.afternoonProtectionMinutes ?? null,
    ),
    monitorContext,
    tradingGateEventRuntime: {
      emitGateStateChanged: options.emitGateStateChanged ?? (() => {}),
      emitAutoSearchAuthorizationChanged: options.emitAutoSearchAuthorizationChanged ?? (() => {}),
    },
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble({
      reconcilePositionHoldFromCurrentTruth: async () => {
        options.onPositionsCommitted?.();
        if (options.reconcilePositionHoldError !== undefined) {
          throw options.reconcilePositionHoldError;
        }
      },
    }),
    dayLifecycleManager: {
      tick:
        options.lifecycleTick ??
        (async () => ({
          nextRetryAtMs: null,
          pendingOpenRebuild: false,
        })),
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
      const context = createTimeWakeupEvaluationHarness({
        now: injectedNow,
        initialCanTrade: false,
        cachedTradingDayInfo: null,
        isTradingDay: async (date) => {
          observedTradingDayTimes.push(date.getTime());
          return { isTradingDay: true, isHalfDay: false };
        },
      });
      context.lastState.cachedTradingDayInfo = null;

      await timeWakeupEvaluationProgram(context);

      expect(observedTradingDayTimes).toEqual([injectedNow.getTime()]);
      expect(context.lastState.canTrade).toBe(true);
      expect(injectedNow.getTime()).not.toBe(Date.now());
    } finally {
      Date.now = originalNow;
    }
  });

  it('异步末日动作的 isLive 重新读取注入时间而不读取系统时间', async () => {
    let injectedNow = new Date('2026-04-29T15:50:00.000+08:00');
    const originalNow = Date.now;
    Date.now = () => new Date('2026-04-29T15:50:00.000+08:00').getTime();
    const observedIsLiveValues: boolean[] = [];

    try {
      const context = createTimeWakeupEvaluationHarness({
        now: injectedNow,
        getNow: () => injectedNow,
        initialCanTrade: true,
        onCancelPendingBuyOrders: async ({ isLive }) => {
          await Promise.resolve();
          injectedNow = new Date('2026-04-29T16:01:00.000+08:00');
          observedIsLiveValues.push(isLive());
        },
      });

      await timeWakeupEvaluationProgram(context);

      expect(observedIsLiveValues).toEqual([false]);
      expect(Date.now()).toBe(new Date('2026-04-29T15:50:00.000+08:00').getTime());
    } finally {
      Date.now = originalNow;
    }
  });

  it('交易日 API 失败时只安排 API_RETRY 且不更新交易门禁事实', async () => {
    let gateEmitted = false;
    let lifecycleCalled = false;
    const context = createTimeWakeupEvaluationHarness({
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
    context.lastState.cachedTradingDayInfo = null;

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.hasWork).toBe(true);
    expect(result.plan.nextWakeupAtMs).toBe(
      new Date('2026-04-29T09:30:00.000+08:00').getTime() + TRADING.INTERVAL_MS,
    );
    expect(context.lastState.cachedTradingDayInfo).toBeNull();
    expect(context.lastState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
    expect(lifecycleCalled).toBe(false);
  });

  it('交易日非 API 错误保持 fail-fast', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:30:00.000+08:00'),
      cachedTradingDayInfo: null,
      isTradingDay: async () => {
        throw new TypeError('calendar contract broken');
      },
    });
    context.lastState.cachedTradingDayInfo = null;

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /calendar contract broken/,
    );
  });

  it('生命周期 API 失败时只安排 API_RETRY 且不提前提交交易门禁变化', async () => {
    let gateEmitted = false;
    const context = createTimeWakeupEvaluationHarness({
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
    expect(context.lastState.canTrade).toBe(false);
    expect(gateEmitted).toBe(false);
  });

  it('在 lifecycle tick 后发布 gate event', async () => {
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
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
    const normalDayContext = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:55:00.000+08:00'),
      initialCanTrade: true,
      emitAutoSearchAuthorizationChanged: (event) => {
        normalDayEvents.push(event);
      },
    });
    const halfDayEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const halfDayContext = createTimeWakeupEvaluationHarness({
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
    let lifecycleState: LastState | null = null;
    let shouldEnableTrading = false;
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T10:00:00.000+08:00'),
      initialCanTrade: true,
      lifecycleTick: async () => {
        if (lifecycleState === null) {
          throw new Error('lifecycle state is unavailable');
        }

        lifecycleState.isTradingEnabled = shouldEnableTrading;
        return { nextRetryAtMs: null, pendingOpenRebuild: !shouldEnableTrading };
      },
      emitGateStateChanged: () => {
        gateCalls.push('gate');
      },
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });
    lifecycleState = context.lastState;

    await timeWakeupEvaluationProgram(context);
    shouldEnableTrading = true;
    await timeWakeupEvaluationProgram(context);

    expect(gateCalls).toEqual([]);
    expect(authorizationEvents).toEqual([
      { previousAuthorized: null, nextAuthorized: false },
      { previousAuthorized: false, nextAuthorized: true },
    ]);
  });

  it('自动寻标授权消费方的内部错误保持 fail-fast', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T10:00:00.000+08:00'),
      emitAutoSearchAuthorizationChanged: () => {
        throw new TypeError('auto-search authorization listener contract broken');
      },
    });

    await expectPromiseRejectsWithMessage(
      timeWakeupEvaluationProgram(context),
      /auto-search authorization listener contract broken/,
    );
  });

  it('开盘保护保持 canTrade 为 true 且只标记 openProtectionActive', async () => {
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.openProtectionActive).toBe(true);
    expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: true }]);
  });

  it('12:00 关闭连续交易门禁并取消普通延迟验证', async () => {
    let cancelAllCalls = 0;
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const verifier = createDelayedSignalVerifierDouble({
      getPendingCount: () => 2,
      cancelAll: () => {
        cancelAllCalls += 1;
        return 2;
      },
    });
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
      initialCanTrade: true,
      verifier,
      emitAutoSearchAuthorizationChanged: (event) => {
        authorizationEvents.push(event);
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(false);
    expect(cancelAllCalls).toBe(1);
    expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: false }]);
  });

  it('午休结束后在连续交易恢复时发布自动寻标授权恢复', async () => {
    let currentTime = new Date('2026-04-29T12:00:00.000+08:00');
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    const context = createTimeWakeupEvaluationHarness({
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

    expect(context.lastState.canTrade).toBe(true);
    expect(authorizationEvents).toEqual([
      { previousAuthorized: null, nextAuthorized: false },
      { previousAuthorized: false, nextAuthorized: true },
    ]);
  });

  it('多个 retry 中选择最早的 lifecycle retry', async () => {
    const now = new Date('2026-04-29T15:56:00.000+08:00');
    const context = createTimeWakeupEvaluationHarness({
      now,
      lifecycleTick: async () => ({
        nextRetryAtMs: now.getTime() + 30_000,
        pendingOpenRebuild: false,
      }),
      doomsdayClearanceResult: {
        executed: false,
        nextRetryAtMs: now.getTime() + 45_000,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(now.getTime() + 30_000);
  });

  it('不复用非当前 HK 日期的交易日缓存', async () => {
    const queriedDates: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
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
    expect(context.lastState.cachedTradingDayInfo).toEqual({
      dateKey: '2026-04-29',
      info: { isTradingDay: true, isHalfDay: false },
    });
    expect(context.lastState.canTrade).toBe(true);
  });

  it('交易日查询失败时向上抛出且不制造系统级 recovery 候选', async () => {
    const staleTradingDayInfo = {
      dateKey: '2026-04-28',
      info: { isTradingDay: false, isHalfDay: false },
    };
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = createTimeWakeupEvaluationHarness({
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
    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.cachedTradingDayInfo).toEqual(staleTradingDayInfo);
    expect(lifecycleRuntimeFlags).toEqual([]);
  });

  it('非交易日关闭连续交易门禁且不生成盘中边界候选', async () => {
    const lifecycleRuntimeFlags: LifecycleRuntimeFlags[] = [];
    const context = createTimeWakeupEvaluationHarness({
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

    expect(context.lastState.canTrade).toBe(false);
    expect(lifecycleRuntimeFlags).toEqual([
      {
        dayKey: '2026-04-29',
        canTradeNow: false,
        isTradingDay: false,
      },
    ]);
  });

  it('在开盘前返回交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:29:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T09:30:00.000+08:00').getTime());
  });

  it('正常日上午返回 12:00 午休交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:35:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T12:00:00.000+08:00').getTime());
  });

  it('正常日午休返回 13:00 午后交易门禁边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T12:00:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T13:00:00.000+08:00').getTime());
  });

  it('半日市上午返回 12:00 收盘交易门禁边界候选且无 13:00 候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
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
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T09:31:00.000+08:00'),
      morningProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T09:35:00.000+08:00').getTime());
  });

  it('正常日午盘开盘保护只标记保护状态并返回保护结束候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.lastState.canTrade).toBe(true);
    expect(context.lastState.openProtectionActive).toBe(true);
    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T13:05:00.000+08:00').getTime());
  });

  it('半日市不生成午盘开盘保护候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:01:00.000+08:00'),
      afternoonProtectionMinutes: 5,
      cachedTradingDayInfo: {
        dateKey: '2026-04-29',
        info: { isTradingDay: true, isHalfDay: true },
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(context.lastState.openProtectionActive).toBe(false);
    expect(result.plan.nextWakeupAtMs).not.toBe(
      new Date('2026-04-29T13:05:00.000+08:00').getTime(),
    );
  });

  it('在收盘前返回市场收盘边界候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:59:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T16:00:00.000+08:00').getTime());
  });

  it('正常日下午 13:05 返回末日保护买入截止入口候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T13:05:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T15:45:00.000+08:00').getTime());
  });

  it('末日买入截止窗口内调用买单撤单 action', async () => {
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:46:00.000+08:00'),
      onCancelPendingBuyOrders: () => {
        calls.push('cancelPendingBuyOrders');
      },
      cancelPendingBuyOrdersResult: {
        executed: true,
        cancelRequestAcceptedCount: 1,
        nextRetryAtMs: null,
      },
    });

    await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['cancelPendingBuyOrders']);
  });

  it('正常日 15:50 返回末日保护清仓接管入口候选', async () => {
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:50:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-29T15:55:00.000+08:00').getTime());
  });

  it('末日清仓接管窗口内执行清仓 action 并按返回值规划 retry', async () => {
    const calls: string[] = [];
    const retryAtMs = new Date('2026-04-29T15:57:00.000+08:00').getTime();
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T15:56:00.000+08:00'),
      onExecuteClearance: () => {
        calls.push('executeClearance');
      },
      onPositionsCommitted: () => {
        calls.push('reconcilePositionHold');
      },
      doomsdayClearanceResult: {
        executed: false,
        nextRetryAtMs: retryAtMs,
      },
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(calls).toEqual(['executeClearance', 'reconcilePositionHold']);
    expect(result.plan.nextWakeupAtMs).toBe(retryAtMs);
  });

  it('末日清仓 submitOrder 结果未知后刷新持仓事实并拒绝系统级重复提交', async () => {
    const currentTime = new Date('2026-04-29T15:56:00.000+08:00');
    const refreshedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 0, availableQuantity: 0 }),
    ];
    const calls: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      now: currentTime,
      executeClearanceError: await createExternalApiRequestError({
        operation: 'TradeContext.submitOrder',
        attempts: 1,
        cause: new Error('submit outcome unknown'),
      }),
      traderOverrides: {
        getStockPositions: async () => {
          calls.push('getStockPositions');
          return refreshedPositions;
        },
      },
      onPositionsCommitted: () => {
        calls.push('reconcilePositionHold');
      },
    });
    context.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    context.lastState.positionCache.update(context.lastState.cachedPositions);

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(currentTime.getTime() + TRADING.INTERVAL_MS);
    expect(calls).toEqual(['getStockPositions', 'reconcilePositionHold']);
    expect(context.lastState.cachedPositions).toEqual(refreshedPositions);
    expect(context.lastState.positionCache.get('BULL.HK')).toEqual(refreshedPositions[0] ?? null);
  });

  it('末日清仓结果未知且持仓订阅协调失败时保留已刷新的持仓事实并安排重试', async () => {
    const currentTime = new Date('2026-04-29T15:56:00.000+08:00');
    const refreshedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 0, availableQuantity: 0 }),
    ];
    const calls: string[] = [];
    const subscriptionError = await createExternalApiRequestError({
      operation: 'MarketDataClient.subscribeSymbols',
      attempts: 1,
      cause: new Error('subscription unavailable'),
    });
    const timeWakeupWarnings: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      logger: {
        info: () => {},
        warn: (message) => {
          if (message.includes('[TimeWakeupEvaluation]')) {
            timeWakeupWarnings.push(message);
          }
        },
      },
      now: currentTime,
      executeClearanceError: await createExternalApiRequestError({
        operation: 'TradeContext.submitOrder',
        attempts: 1,
        cause: new Error('submit outcome unknown'),
      }),
      traderOverrides: {
        getStockPositions: async () => {
          calls.push('getStockPositions');
          return refreshedPositions;
        },
      },
      onPositionsCommitted: () => {
        calls.push('reconcilePositionHold');
      },
      reconcilePositionHoldError: subscriptionError,
    });
    context.lastState.cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    context.lastState.positionCache.update(context.lastState.cachedPositions);

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(currentTime.getTime() + TRADING.INTERVAL_MS);
    expect(calls).toEqual(['getStockPositions', 'reconcilePositionHold']);
    expect(context.lastState.cachedPositions).toEqual(refreshedPositions);
    expect(context.lastState.positionCache.get('BULL.HK')).toEqual(refreshedPositions[0] ?? null);
    expect(timeWakeupWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('持仓事实已刷新，但持仓订阅协调失败'),
        expect.stringContaining('已刷新持仓事实，但持仓订阅协调尚未完成'),
      ]),
    );
  });

  it('末日清仓结果未知且持仓 API 失败时保留旧缓存并安排重试', async () => {
    const currentTime = new Date('2026-04-29T15:56:00.000+08:00');
    const cachedPositions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    ];
    let reconcileCalls = 0;
    const positionError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('positions unavailable'),
    });
    const timeWakeupWarnings: string[] = [];
    const context = createTimeWakeupEvaluationHarness({
      logger: {
        info: () => {},
        warn: (message) => {
          if (message.includes('[TimeWakeupEvaluation]')) {
            timeWakeupWarnings.push(message);
          }
        },
      },
      now: currentTime,
      executeClearanceError: await createExternalApiRequestError({
        operation: 'TradeContext.submitOrder',
        attempts: 1,
        cause: new Error('submit outcome unknown'),
      }),
      traderOverrides: {
        getStockPositions: async () => {
          throw positionError;
        },
      },
      onPositionsCommitted: () => {
        reconcileCalls += 1;
      },
    });
    context.lastState.cachedPositions = cachedPositions;
    context.lastState.positionCache.update(cachedPositions);

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(currentTime.getTime() + TRADING.INTERVAL_MS);
    expect(context.lastState.cachedPositions).toEqual(cachedPositions);
    expect(context.lastState.positionCache.get('BULL.HK')).toEqual(cachedPositions[0] ?? null);
    expect(reconcileCalls).toBe(0);
    expect(timeWakeupWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('持仓事实刷新失败'),
        expect.stringContaining('持仓事实尚未刷新'),
      ]),
    );
  });

  for (const scenario of [
    { label: '持仓查询', failureStage: 'POSITION_FACTS', expectedReconcileCalls: 0 },
    { label: '持仓订阅协调', failureStage: 'POSITION_SUBSCRIPTION', expectedReconcileCalls: 1 },
  ] as const) {
    it(`末日清仓结果未知后的${scenario.label}普通错误保持 fail-fast`, async () => {
      const ordinaryError = new Error(`${scenario.failureStage} contract violated`);
      const refreshedPositions = [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 0, availableQuantity: 0 }),
      ];
      let reconcileCalls = 0;
      const context = createTimeWakeupEvaluationHarness({
        now: new Date('2026-04-29T15:56:00.000+08:00'),
        executeClearanceError: await createExternalApiRequestError({
          operation: 'TradeContext.submitOrder',
          attempts: 1,
          cause: new Error('submit outcome unknown'),
        }),
        traderOverrides: {
          getStockPositions: async () => {
            if (scenario.failureStage === 'POSITION_FACTS') {
              throw ordinaryError;
            }

            return refreshedPositions;
          },
        },
        onPositionsCommitted: () => {
          reconcileCalls += 1;
        },
        ...(scenario.failureStage === 'POSITION_SUBSCRIPTION'
          ? { reconcilePositionHoldError: ordinaryError }
          : {}),
      });

      await expectPromiseRejectsWithMessage(
        timeWakeupEvaluationProgram(context),
        /contract violated/,
      );
      expect(reconcileCalls).toBe(scenario.expectedReconcileCalls);
    });
  }

  it('半日市 11:40 返回 11:45 买入截止窗口入口', async () => {
    const context = createTimeWakeupEvaluationHarness({
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
    const context = createTimeWakeupEvaluationHarness({
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
    const context = createTimeWakeupEvaluationHarness({
      now: new Date('2026-04-29T16:01:00.000+08:00'),
    });

    const result = await timeWakeupEvaluationProgram(context);

    expect(result.plan.nextWakeupAtMs).toBe(new Date('2026-04-30T00:00:00.000+08:00').getTime());
  });

  it('同日交易日缓存命中时不调用 marketDataClient.isTradingDay', async () => {
    let queryCount = 0;
    const context = createTimeWakeupEvaluationHarness({
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
