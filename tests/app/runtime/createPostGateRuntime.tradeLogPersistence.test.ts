import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';

/**
 * createPostGateRuntime 交易日志持久化测试
 *
 * 功能：
 * - 验证固定生产目录接线，普通成交、保护性进度与完成记录仅落盘至隔离测试目录
 * - 验证旧格式与损坏日文件会在创建 Trader 前拒绝
 * - 验证保护性 FILLED 订单不会提前写入 episode 完成语义
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTradingConfig, createMonitorConfig } from '../../../mock/factories/configFactory.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createWarrantListCache } from '../../../src/infrastructure/longbridge/market/warrantListCache/index.js';
import { createMixedTradeLogRepository } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import type { MixedTradeLogRepositoryDeps } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/types.js';
import { buildTradeLogPath } from '../../../src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.js';
import {
  createAccountSnapshotDouble,
  createMonitorContextDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createPositionDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import type { CreatePostGateRuntimeParams, PostGateRuntime } from '../../../src/app/types.js';
import { createBrokerClientFactoryDouble } from '../../helpers/brokerClientFactoryDouble.js';
import type { CreateTradeRuntimeDeps } from '../../../src/app/runtime/types.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';

const TEST_TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'post-gate-runtime-'));
const TEST_LOG_ROOT_DIR = path.join(TEST_TEMP_DIR, 'logs');
const TEST_TRADES_DIR = path.join(TEST_TEMP_DIR, 'data', 'trades');
let capturedTradesDir: string | undefined;
let activeTermination: RuntimeTermination;
let capturedOrderStateChangedListener: ((event: OrderStateChangedEvent) => void) | null = null;

type CreateTraderForTest = (
  deps: CreateTradeRuntimeDeps,
) => Promise<ReturnType<typeof createTradeRuntimeDouble>>;

const { createMonitorContext: productionCreateMonitorContext } =
  await import('../../../src/app/context/createMonitorContext.js');
type CreateMonitorContextForTest = typeof productionCreateMonitorContext;

let createTradeRuntimeForTest: CreateTraderForTest = async (_deps) => createTradeRuntimeDouble();
let createMonitorContextForTest: CreateMonitorContextForTest = productionCreateMonitorContext;

mock.module('../../../src/app/runtime/createPostGateRuntimeDeps.js', () => ({
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: {
    createTradeRuntime: (deps: CreateTradeRuntimeDeps) => createTradeRuntimeForTest(deps),
    createMonitorContext: (params: Parameters<typeof productionCreateMonitorContext>[0]) =>
      createMonitorContextForTest(params),
    createMixedTradeLogRepository: (deps: MixedTradeLogRepositoryDeps) => {
      capturedTradesDir = deps.tradesDir;
      return createMixedTradeLogRepository({ tradesDir: TEST_TRADES_DIR });
    },
  },
}));

const { createPostGateRuntime: buildPostGateRuntime } =
  await import('../../../src/app/runtime/createPostGateRuntime.js');
async function createPostGateRuntime(
  params: CreatePostGateRuntimeParams,
): Promise<PostGateRuntime> {
  const runtime = await buildPostGateRuntime(params);
  if (runtime === null) throw new Error('unexpected terminated runtime');

  return runtime;
}

async function waitForFatalError(): Promise<unknown> {
  await activeTermination.waitForTermination();
  const fatalState = activeTermination.getFatalState();
  if (!fatalState.hasFatalError) throw new Error('expected fatal');

  return fatalState.error;
}

function createRuntimeParams(
  params: {
    readonly marketDataClient?: CreatePostGateRuntimeParams['preGateRuntime']['marketDataClient'];
  } = {},
): CreatePostGateRuntimeParams {
  const warrantListCache = createWarrantListCache();
  const monitorConfig = createMonitorConfig({ monitorSymbol: 'HSI.HK' });
  activeTermination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  return {
    logger: createLoggerDouble(),
    termination: activeTermination,
    resources: {},
    strategy: createMonitorContextDouble().strategy,
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
      diagnostics: createDiagnosticObserverDouble(),
      brokerClientFactory: createBrokerClientFactoryDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache: warrantListCache,
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
  createTradeRuntimeForTest = async () =>
    createTradeRuntimeDouble({
      orderMonitor: {
        onOrderStateChanged: (listener) => {
          capturedOrderStateChangedListener = listener;
          return () => {
            if (capturedOrderStateChangedListener === listener) {
              capturedOrderStateChangedListener = null;
            }
          };
        },
      },
    });
}

function configurePostGateRuntimeTraderWithPositionRefresh(): void {
  createTradeRuntimeForTest = async () =>
    createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('88000'),
        getStockPositions: async () => [
          createPositionDouble({
            symbol: 'POS.HK',
            quantity: 100,
            availableQuantity: 100,
          }),
        ],
      },
      orderMonitor: {
        onOrderStateChanged: (listener) => {
          capturedOrderStateChangedListener = listener;
          return () => {
            if (capturedOrderStateChangedListener === listener) {
              capturedOrderStateChangedListener = null;
            }
          };
        },
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
  afterAll(() => {
    fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_LOG_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(TEST_TRADES_DIR, { recursive: true, force: true });
    capturedTradesDir = undefined;
    capturedOrderStateChangedListener = null;
    createTradeRuntimeForTest = async (_deps) => createTradeRuntimeDouble();
    createMonitorContextForTest = productionCreateMonitorContext;
  });

  it('retains six real instance identities and four independent stable state objects through composition and cleanup', async () => {
    const instances = createTradeRuntimeDouble();
    createTradeRuntimeForTest = async () => instances;
    const params = createRuntimeParams();
    let calendar:
      | Parameters<
          typeof productionCreateMonitorContext
        >[0]['postGateRuntime']['tradingCalendarState']
      | undefined;
    createMonitorContextForTest = (contextParams) => {
      calendar = contextParams.postGateRuntime.tradingCalendarState;
      return productionCreateMonitorContext(contextParams);
    };
    const runtime = await createPostGateRuntime(params);
    const states = [
      runtime.tradingTimeState,
      runtime.lifecycleState,
      runtime.tradingCalendarState,
      runtime.quoteSubscriptionState,
    ] as const;
    expect(new Set(states).size).toBe(4);
    expect(runtime.tradingTimeState).toEqual({
      canTrade: null,
      isHalfDay: null,
      openProtectionActive: null,
    });

    expect(runtime.lifecycleState).toEqual({
      currentDayKey: '2026-03-13',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
    });
    expect(runtime.quoteSubscriptionState.allTradingSymbols).toEqual(new Set());
    expect(runtime.tradingCalendarState.cachedTradingDayInfo?.dateKey).toBe('2026-03-13');
    expect(runtime.tradingCalendarState.tradingCalendarSnapshot.size).toBe(1);
    expect(calendar).toBe(runtime.tradingCalendarState);
    expect(params.resources.lifecycleState).toBe(runtime.lifecycleState);
    for (const name of [
      'accountService',
      'cacheManager',
      'orderRecorder',
      'orderHoldRegistry',
      'orderMonitor',
      'orderExecutor',
    ] as const)
      expect(runtime.tradeRuntime[name]).toBe(instances[name]);

    expect(runtime.monitorContext.orderRecorder).toBe(instances.orderRecorder);
    await params.cleanup.execute();
    expect(runtime.lifecycleState.isTradingEnabled).toBeFalse();
    expect(runtime.tradingTimeState).toBe(states[0]);
    expect(runtime.lifecycleState).toBe(states[1]);
    expect(runtime.tradingCalendarState).toBe(states[2]);
    expect(runtime.quoteSubscriptionState).toBe(states[3]);
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
    expect(runtime.quoteSubscriptionState.allTradingSymbols).toEqual(new Set(['POS.HK']));
  });

  it('injects a continuous-trading authorization that requires lifecycle and canTrade', async () => {
    const captured: {
      continuousTradingAuthorization: CreateTradeRuntimeDeps['isContinuousTradingAllowed'] | null;
    } = {
      continuousTradingAuthorization: null,
    };
    createTradeRuntimeForTest = async (deps) => {
      captured.continuousTradingAuthorization = deps.isContinuousTradingAllowed;
      return createTradeRuntimeDouble();
    };
    const runtime = await createPostGateRuntime(createRuntimeParams());

    expect(captured.continuousTradingAuthorization).toBeTypeOf('function');
    if (captured.continuousTradingAuthorization === null) {
      throw new Error('expected createPostGateRuntime to inject continuous trading authorization');
    }

    const continuousTradingAuthorization = captured.continuousTradingAuthorization;

    runtime.lifecycleState.isTradingEnabled = true;
    runtime.tradingTimeState.canTrade = false;
    expect(continuousTradingAuthorization()).toBe(false);

    runtime.tradingTimeState.canTrade = true;
    expect(continuousTradingAuthorization()).toBe(true);

    runtime.lifecycleState.isTradingEnabled = false;
    expect(continuousTradingAuthorization()).toBe(false);

    runtime.tradingTimeState.canTrade = null;
    expect(continuousTradingAuthorization()).toBe(false);
  });

  it('constructs Trader and MonitorContextAssembly with the same unrealized-loss checker instance', async () => {
    let capturedUnrealizedLossBuyGate: unknown = null;
    createTradeRuntimeForTest = async (deps) => {
      capturedUnrealizedLossBuyGate = Reflect.get(deps, 'unrealizedLossBuyGate');
      return createTradeRuntimeDouble();
    };

    const runtime = await createPostGateRuntime(createRuntimeParams());

    expect(capturedUnrealizedLossBuyGate).toBe(runtime.monitorContext.riskChecker);
  });

  it('registers tradeRuntime listener disposal before a later post-gate factory failure', async () => {
    let unsubscribeCount = 0;
    const cleanup = createCleanup();
    createTradeRuntimeForTest = async () =>
      createTradeRuntimeDouble({
        orderMonitor: {
          onOrderStateChanged: () => () => {
            unsubscribeCount += 1;
          },
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

  it('persists all three record types in isolation with fixed production wiring', async () => {
    const executedTimeMs = Date.parse('2026-03-13T09:35:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'BUY-001',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: false,
      executedPrice: '1.23',
      executedQuantity: 100,
      executedTimeMs,
    };
    configurePostGateRuntimeTrader();
    const buildTrader = createTradeRuntimeForTest;
    let capturedDeps: CreateTradeRuntimeDeps | undefined;
    createTradeRuntimeForTest = async (deps) => {
      capturedDeps = deps;
      return buildTrader(deps);
    };
    const params = createRuntimeParams();
    const runtime = await createPostGateRuntime(params);

    try {
      if (capturedDeps === undefined) {
        throw new Error('expected createPostGateRuntime to inject trade runtime dependencies');
      }

      expect(capturedTradesDir).toBe(path.join(process.cwd(), 'data', 'trades'));
      const tradeDeps = capturedDeps;
      requireCapturedOrderStateChangedListener()(event);
      const protectiveExecutedTimeMs = executedTimeMs + 60_000;
      runtime.dailyLossTracker.resetAll(params.now);
      // Trader 替身驱动正式注入的 progress 端口，完成记录仍由真实刷新事务提交。
      runtime.dailyLossTracker.recordCumulativeExecution(
        {
          direction: 'LONG',
          symbol: 'BULL.HK',
          orderId: 'PL-DATA-001',
          side: 'SELL',
          factStage: 'TERMINAL',
          executedPrice: '1.01',
          executedQuantity: 100,
          executedTimeMs: protectiveExecutedTimeMs,
          orderUpdatedAtMs: protectiveExecutedTimeMs,
        },
        (snapshot) => {
          tradeDeps.persistProtectiveLiquidationExecutionProgress({
            ...snapshot,
            monitorSymbol: 'HSI.HK',
            direction: 'LONG',
            symbol: 'BULL.HK',
            orderId: 'PL-DATA-001',
          });
        },
      );

      runtime.protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress({
        direction: 'LONG',
        symbol: 'BULL.HK',
        executedTimeMs: protectiveExecutedTimeMs,
      });

      runtime.postTradeConsistencyRuntime.recordSettlementRefreshNeed({
        refreshAccount: true,
        refreshPositions: true,
      });
      runtime.postTradeConsistencyRuntime.start();
      await runtime.postTradeConsistencyRuntime.waitForFresh();
      await runtime.postTradeConsistencyRuntime.stopAndDrain();

      const logFile = buildTradeLogPath(TEST_TRADES_DIR, new Date(executedTimeMs));
      expect(fs.existsSync(logFile)).toBe(true);
      const records = fs
        .readFileSync(logFile, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        action: 'BUYCALL',
        side: 'BUY',
        status: 'FILLED',
        reason: null,
        executedAtMs: executedTimeMs,
        isProtectiveClearance: false,
      });

      expect(records[1]).toMatchObject({
        recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS',
        orderId: 'PL-DATA-001',
        cumulativeQuantity: '100',
        cumulativeAmount: '101',
        lastExecutionTimeMs: protectiveExecutedTimeMs,
      });

      expect(records[2]).toMatchObject({
        recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
        monitorSymbol: 'HSI.HK',
        direction: 'LONG',
        boundaryExecutedTimeMs: protectiveExecutedTimeMs,
        orderBaselines: [
          {
            orderId: 'PL-DATA-001',
            cumulativeQuantity: '100',
            cumulativeAmount: '101',
          },
        ],
      });
      expect(fs.existsSync(path.join(TEST_LOG_ROOT_DIR, 'trades'))).toBe(false);
    } finally {
      await params.cleanup.execute();
    }
  });

  it('rejects malformed JSONL before constructing Trader and preserves the damaged file', async () => {
    const executedTimeMs = Date.parse('2026-03-13T09:40:00+08:00');
    const logFile = buildTradeLogPath(TEST_TRADES_DIR, new Date(executedTimeMs));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '{invalid json}\n', 'utf8');
    let traderCreated = false;
    createTradeRuntimeForTest = async () => {
      traderCreated = true;
      return createTradeRuntimeDouble();
    };

    let startupError: unknown;
    try {
      await createPostGateRuntime(createRuntimeParams());
    } catch (error: unknown) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(SyntaxError);
    expect(traderCreated).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8')).toBe('{invalid json}\n');
  });

  it('rejects legacy JSON before constructing Trader without migrating or deleting it', async () => {
    const logFile = buildTradeLogPath(TEST_TRADES_DIR, new Date('2026-03-13T09:45:00+08:00'));
    const legacyFile = logFile.replace(/\.jsonl$/, '.json');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(legacyFile, '[{}]', 'utf8');
    let traderCreated = false;
    createTradeRuntimeForTest = async () => {
      traderCreated = true;
      return createTradeRuntimeDouble();
    };

    let startupError: unknown;
    try {
      await createPostGateRuntime(createRuntimeParams());
    } catch (error: unknown) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toMatch(
      /legacy JSON trade log requires manual reconciliation/,
    );
    expect(traderCreated).toBe(false);
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe('[{}]');
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('does not mark a protective FILLED order as a completed liquidation episode', async () => {
    const executedTimeMs = Date.parse('2026-03-13T10:00:00+08:00');
    const event: OrderStateChangedEvent = {
      orderId: 'PL-001',
      symbol: 'BULL.HK',
      side: 'SELL',
      status: 'FILLED',
      monitorSymbol: 'HSI.HK',
      isLongSymbol: true,
      isProtectiveLiquidation: true,
      executedPrice: '1.01',
      executedQuantity: 200,
      executedTimeMs,
    };

    await emitOrderStateChangedThroughPostGateRuntime(event);

    const logFile = buildTradeLogPath(TEST_TRADES_DIR, new Date(executedTimeMs));
    const records = fs
      .readFileSync(logFile, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown) as ReadonlyArray<{
      readonly reason: string | null;
      readonly action: string | null;
    }>;
    expect(records[0]).toMatchObject({
      reason: null,
      action: 'SELLCALL',
    });
  });

  it('passes one termination owner into Trader and blocks reopen after termination', async () => {
    const params = createRuntimeParams();
    let captured: CreateTradeRuntimeDeps | undefined;
    createTradeRuntimeForTest = async (deps) => {
      captured = deps;
      return createTradeRuntimeDouble();
    };
    const runtime = await createPostGateRuntime(params);
    expect(captured?.termination).toBe(params.termination);
    runtime.lifecycleState.isTradingEnabled = true;
    runtime.tradingTimeState.canTrade = true;
    params.termination.requestShutdown();
    expect(captured?.isExecutionAllowed()).toBeFalse();
    expect(captured?.isContinuousTradingAllowed()).toBeFalse();
    await params.cleanup.execute();
  });

  it('wires lifecycle refresh fatal observation into the shared termination owner', async () => {
    const internalError = new TypeError('TradeContext.accountBalance contract broken');
    createTradeRuntimeForTest = async () =>
      createTradeRuntimeDouble({
        accountService: {
          getAccountSnapshot: async () => {
            throw internalError;
          },
        },
      });
    const runtime = await createPostGateRuntime(createRuntimeParams());

    let caught: unknown = null;
    try {
      await runtime.loadTradingDayRuntimeSnapshot({
        now: new Date('2026-03-13T09:30:00+08:00'),
        requireTradingDay: false,
        resetRuntimeSubscriptions: false,
        source: 'STARTUP',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(internalError);
    const fatalError = await waitForFatalError();
    expect(fatalError).toBe(internalError);
  });
});
