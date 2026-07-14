/**
 * createPostGateRuntime 交易日志持久化测试
 *
 * 功能：
 * - 验证订单状态事件可落盘为 trade log
 * - 验证保护性 FILLED 订单不会提前写入 episode 完成语义
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createPostGateRuntimeFactory } from '../../../src/app/runtime/createPostGateRuntime.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createMonitorContext } from '../../../src/app/context/createMonitorContext.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import { buildTradeLogPath } from '../../../src/utils/trading/tradeLogPath.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createPositionDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import type { CreatePostGateRuntimeParams } from '../../../src/app/types.js';
import type { OrderStateChangedEvent } from '../../../src/types/services.js';

const TEST_LOG_ROOT_DIR = path.join(process.cwd(), 'tests', 'logs', 'post-gate-runtime');
let capturedOrderStateChangedListener: ((event: OrderStateChangedEvent) => void) | null = null;

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
    env: createTestEnv(),
    now: new Date('2026-03-13T09:30:00+08:00'),
    cleanup: createCleanup(),
    preGateRuntime: {
      config: createSdkConfigDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache,
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

function createPostGateRuntimeForTest() {
  return createPostGateRuntimeFactory({
    createMonitorContext,
    createTrader: async () =>
      createTraderDouble({
        onOrderStateChanged: (listener) => {
          capturedOrderStateChangedListener = listener;
          return () => {
            if (capturedOrderStateChangedListener === listener) {
              capturedOrderStateChangedListener = null;
            }
          };
        },
      }),
  });
}

function createPostGateRuntimeWithPositionRefreshForTest() {
  return createPostGateRuntimeFactory({
    createMonitorContext,
    createTrader: async () =>
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
      }),
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
  const createPostGateRuntime = createPostGateRuntimeForTest();
  await createPostGateRuntime(createRuntimeParams());
  requireCapturedOrderStateChangedListener()(event);
}

describe('createPostGateRuntime trade log persistence', () => {
  beforeEach(() => {
    fs.rmSync(TEST_LOG_ROOT_DIR, { recursive: true, force: true });
    capturedOrderStateChangedListener = null;
  });

  it('wires positions committed hook to quote subscription runtime', async () => {
    const subscribed: string[][] = [];
    const marketDataClient = createMarketDataClientDouble({
      subscribeSymbols: async (symbols) => {
        subscribed.push([...symbols]);
      },
    });
    const createPostGateRuntime = createPostGateRuntimeWithPositionRefreshForTest();
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

  it('registers trader listener disposal before a later post-gate factory failure', async () => {
    let unsubscribeCount = 0;
    const cleanup = createCleanup();
    const createPostGateRuntime = createPostGateRuntimeFactory({
      createTrader: async () =>
        createTraderDouble({
          onOrderStateChanged: () => () => {
            unsubscribeCount += 1;
          },
        }),
      createMonitorContext: () => {
        throw new Error('monitor context wiring failed');
      },
    });

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

    const createPostGateRuntime = createPostGateRuntimeForTest();
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

    const createPostGateRuntime = createPostGateRuntimeForTest();
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
});
