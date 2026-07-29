/**
 * createPostGateRuntime 交易日志持久化测试
 *
 * 功能：
 * - 验证订单状态事件可落盘为 trade log
 * - 验证保护性 FILLED 订单不会提前写入 episode 完成语义
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import { buildTradeLogPath } from '../../../src/utils/trading/tradeLogPath.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createPositionDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import type { CreatePostGateRuntimeParams, PostGateRuntime } from '../../../src/app/types.js';
import type { TraderDeps } from '../../../src/core/trader/types.js';
import type { OrderStateChangedEvent } from '../../../src/types/services.js';

const TEST_LOG_ROOT_DIR = path.join(process.cwd(), 'tests', 'logs', 'post-gate-runtime');
const FATAL_DRAIN_TIMEOUT_MS = 100;
let capturedOrderStateChangedListener: ((event: OrderStateChangedEvent) => void) | null = null;

type CreateTraderForTest = (deps: TraderDeps) => Promise<ReturnType<typeof createTraderDouble>>;

const { createMonitorContext: productionCreateMonitorContext } =
  await import('../../../src/app/context/createMonitorContext.js');
type CreateMonitorContextForTest = typeof productionCreateMonitorContext;

let createTraderForTest: CreateTraderForTest = async (_deps) => createTraderDouble();
let createMonitorContextForTest: CreateMonitorContextForTest = productionCreateMonitorContext;

mock.module('../../../src/app/runtime/createPostGateRuntimeDeps.js', () => ({
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: {
    createTrader: (deps: TraderDeps) => createTraderForTest(deps),
    createMonitorContext: (params: Parameters<typeof productionCreateMonitorContext>[0]) =>
      createMonitorContextForTest(params),
  },
}));

const { createPostGateRuntime } = await import('../../../src/app/runtime/createPostGateRuntime.js');

async function waitForFatalError(runtime: PostGateRuntime): Promise<Error> {
  const fatalError = await Promise.race([
    runtime.drainFatalError().catch((error: unknown) => error),
    Bun.sleep(FATAL_DRAIN_TIMEOUT_MS).then(() => null),
  ]);
  if (!(fatalError instanceof Error)) {
    throw new Error('expected delayed verifier failure to reject post-gate fatal drain');
  }

  return fatalError;
}

function createTestEnv(): NodeJS.ProcessEnv {
  return {
    APP_RUNTIME_PROFILE: 'test',
    APP_LOG_ROOT_DIR: TEST_LOG_ROOT_DIR,
  };
}

function createRuntimeParams(
  params: {
    readonly marketDataClient?: CreatePostGateRuntimeParams['preGateRuntime']['marketDataClient'];
  } = {},
): CreatePostGateRuntimeParams {
  const warrantListCache = createWarrantListCache();
  const monitorConfig = createMonitorConfig({ monitorSymbol: 'HSI.HK' });
  return {
    logger: createLoggerDouble(),
    env: createTestEnv(),
    now: new Date('2026-03-13T09:30:00+08:00'),
    clock: { now: () => new Date('2026-03-13T09:30:00+08:00') },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
    cleanup: createCleanup(),
    preGateRuntime: {
      config: createSdkConfigDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCacheConfig: {
        cache: warrantListCache,
        ttlMs: 60_000,
        nowMs: () => 0,
      },
      marketDataClient: params.marketDataClient ?? createMarketDataClientDouble(),
      startupTradingDayInfo: {
        dateKey: '2026-03-13',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
    },
  };
}

function configurePostGateRuntimeTrader(): void {
  createTraderForTest = async () =>
    createTraderDouble({
      onOrderStateChanged: (listener) => {
        capturedOrderStateChangedListener = listener;
        return () => {
          if (capturedOrderStateChangedListener === listener) {
            capturedOrderStateChangedListener = null;
          }
        };
      },
    });
}

function configurePostGateRuntimeTraderWithPositionRefresh(): void {
  createTraderForTest = async () =>
    createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(88_000),
      getStockPositions: async () => [
        createPositionDouble({
          symbol: 'POS.HK',
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
      onOrderStateChanged: (listener) => {
        capturedOrderStateChangedListener = listener;
        return () => {
          if (capturedOrderStateChangedListener === listener) {
            capturedOrderStateChangedListener = null;
          }
        };
      },
    });
}

function requireCapturedOrderStateChangedListener(): (event: OrderStateChangedEvent) => void {
  if (capturedOrderStateChangedListener === null) {
    throw new Error('expected createPostGateRuntime to register order state changed listener');
  }

  return capturedOrderStateChangedListener;
}

async function emitOrderStateChangedThroughPostGateRuntime(
  event: OrderStateChangedEvent,
): Promise<void> {
  configurePostGateRuntimeTrader();
  await createPostGateRuntime(createRuntimeParams());
  requireCapturedOrderStateChangedListener()(event);
}

describe('createPostGateRuntime trade log persistence', () => {
  beforeEach(() => {
    fs.rmSync(TEST_LOG_ROOT_DIR, { recursive: true, force: true });
    capturedOrderStateChangedListener = null;
    createTraderForTest = async (_deps) => createTraderDouble();
    createMonitorContextForTest = productionCreateMonitorContext;
  });

  it('wires positions committed hook to quote subscription runtime', async () => {
    const subscribed: string[][] = [];
    const marketDataClient = createMarketDataClientDouble({
      subscribeSymbols: async (symbols) => {
        subscribed.push([...symbols]);
      },
    });
    configurePostGateRuntimeTraderWithPositionRefresh();
    const runtime = await createPostGateRuntime(createRuntimeParams({ marketDataClient }));

    runtime.postTradeConsistencyRuntime.recordSettlementRefreshNeed({
      refreshAccount: true,
      refreshPositions: true,
    });
    runtime.postTradeConsistencyRuntime.start();
    await runtime.postTradeConsistencyRuntime.waitForFresh();
    await runtime.postTradeConsistencyRuntime.stopAndDrain();

    expect(subscribed).toEqual([['POS.HK']]);
    expect(runtime.lastState.allTradingSymbols).toEqual(new Set(['POS.HK']));
  });

  it('injects a continuous-trading authorization that requires lifecycle and canTrade', async () => {
    const captured: {
      continuousTradingAuthorization: TraderDeps['isContinuousTradingAllowed'] | null;
    } = {
      continuousTradingAuthorization: null,
    };
    createTraderForTest = async (deps) => {
      captured.continuousTradingAuthorization = deps.isContinuousTradingAllowed;
      return createTraderDouble();
    };
    const runtime = await createPostGateRuntime(createRuntimeParams());

    expect(captured.continuousTradingAuthorization).toBeTypeOf('function');
    if (captured.continuousTradingAuthorization === null) {
      throw new Error('expected createPostGateRuntime to inject continuous trading authorization');
    }

    const continuousTradingAuthorization = captured.continuousTradingAuthorization;

    runtime.lastState.isTradingEnabled = true;
    runtime.lastState.canTrade = false;
    expect(continuousTradingAuthorization()).toBe(false);

    runtime.lastState.canTrade = true;
    expect(continuousTradingAuthorization()).toBe(true);

    runtime.lastState.isTradingEnabled = false;
    expect(continuousTradingAuthorization()).toBe(false);

    runtime.lastState.canTrade = null;
    expect(continuousTradingAuthorization()).toBe(false);
  });

  it('constructs Trader and MonitorContext with the same unrealized-loss checker instance', async () => {
    let capturedUnrealizedLossBuyGate: unknown = null;
    createTraderForTest = async (deps) => {
      capturedUnrealizedLossBuyGate = Reflect.get(deps, 'unrealizedLossBuyGate');
      return createTraderDouble();
    };

    const runtime = await createPostGateRuntime(createRuntimeParams());

    expect(capturedUnrealizedLossBuyGate).toBe(runtime.monitorContext.riskChecker);
  });

  it('registers trader listener disposal before a later post-gate factory failure', async () => {
    let unsubscribeCount = 0;
    const cleanup = createCleanup();
    createTraderForTest = async () =>
      createTraderDouble({
        onOrderStateChanged: () => () => {
          unsubscribeCount += 1;
        },
      });

    createMonitorContextForTest = (_params) => {
      throw new Error('monitor context wiring failed');
    };

    let caught: unknown = null;
    try {
      await createPostGateRuntime({
        ...createRuntimeParams(),
        cleanup,
      });
    } catch (error: unknown) {
      caught = error;
    }

    if (!(caught instanceof Error)) {
      throw new Error('expected createPostGateRuntime to reject with Error');
    }

    expect(caught.message).toBe('monitor context wiring failed');
    await cleanup.execute();
    await cleanup.execute();
    expect(unsubscribeCount).toBe(1);
  });

  it('persists FILLED buy order state event into daily trade log', async () => {
    const executedTimeMs = Date.parse('2026-03-13T09:35:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1.23,
      executedQuantity: 100,
      executedTimeMs,
    };

    await emitOrderStateChangedThroughPostGateRuntime(event);

    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    expect(fs.existsSync(logFile)).toBe(true);

    const records = JSON.parse(fs.readFileSync(logFile, 'utf8')) as ReadonlyArray<{
      readonly action: string | null;
      readonly side: string | null;
      readonly status: string | null;
      readonly reason: string | null;
      readonly executedAtMs: number | null;
      readonly isProtectiveClearance: boolean | null;
    }>;

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'BUYCALL',
      side: 'BUY',
      status: 'FILLED',
      reason: null,
      executedAtMs: executedTimeMs,
      isProtectiveClearance: false,
    });
  });

  it('fails fast and preserves the existing trade log when daily trade log JSON is invalid', async () => {
    const executedTimeMs = Date.parse('2026-03-13T09:40:00+08:00');
    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '{invalid json', 'utf8');

    configurePostGateRuntimeTrader();
    const runtime = await createPostGateRuntime(createRuntimeParams());
    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);
    const listener = requireCapturedOrderStateChangedListener();
    const event: OrderStateChangedEvent = {
      orderId: 'BUY-BROKEN-LOG',
      symbol: 'BULL.HK',
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1.23,
      executedQuantity: 100,
      executedTimeMs,
    };

    expect(() => {
      listener(event);
    }).toThrow(SyntaxError);
    const fatalError = await fatalErrorPromise;
    expect(fatalError).toBeInstanceOf(SyntaxError);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('{invalid json');
  });

  it('fails fast and preserves the existing trade log when daily trade log root is not an array', async () => {
    const executedTimeMs = Date.parse('2026-03-13T09:45:00+08:00');
    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '{}', 'utf8');

    configurePostGateRuntimeTrader();
    const runtime = await createPostGateRuntime(createRuntimeParams());
    const fatalErrorPromise = runtime.drainFatalError().catch((error: unknown) => error);
    const listener = requireCapturedOrderStateChangedListener();
    const event: OrderStateChangedEvent = {
      orderId: 'BUY-NON-ARRAY-LOG',
      symbol: 'BULL.HK',
      side: 'BUY',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: 1.23,
      executedQuantity: 100,
      executedTimeMs,
    };

    expect(() => {
      listener(event);
    }).toThrow(TypeError);
    const fatalError = await fatalErrorPromise;
    expect(fatalError).toBeInstanceOf(TypeError);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('{}');
  });

  it('does not mark a protective FILLED order as a completed liquidation episode', async () => {
    const executedTimeMs = Date.parse('2026-03-13T10:00:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'PL-001',
      symbol: 'BULL.HK',
      side: 'SELL',
      source: 'WS',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: 1.01,
      executedQuantity: 200,
      executedTimeMs,
    };

    await emitOrderStateChangedThroughPostGateRuntime(event);

    const logFile = buildTradeLogPath(TEST_LOG_ROOT_DIR, new Date(executedTimeMs));
    const records = JSON.parse(fs.readFileSync(logFile, 'utf8')) as ReadonlyArray<{
      readonly reason: string | null;
      readonly action: string | null;
    }>;
    expect(records[0]).toMatchObject({
      reason: null,
      action: 'SELLCALL',
    });
  });

  it('drains a delayed verifier indicator-cache exception as a post-gate fatal error', async () => {
    const params = createRuntimeParams();
    const runtime = await createPostGateRuntime(params);
    const originalGetClosest = runtime.indicatorCache.getClosest;
    runtime.indicatorCache.getClosest = () => {
      throw new TypeError('indicator cache invariant broken');
    };

    try {
      runtime.monitorContext.delayedSignalVerifier.addSignal({
        signal: createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now() - 11_000,
          indicators1: { K: 10 },
        }),
        verificationIndicators: ['K'],
      });

      const fatalError = await waitForFatalError(runtime);

      expect(fatalError).toBeInstanceOf(TypeError);
      expect(fatalError.message).toBe('indicator cache invariant broken');
    } finally {
      runtime.indicatorCache.getClosest = originalGetClosest;
      await params.cleanup.execute();
    }
  });
});
