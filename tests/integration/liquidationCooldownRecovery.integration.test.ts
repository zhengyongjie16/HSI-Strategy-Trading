/**
 * liquidation-cooldown-recovery 集成测试
 *
 * 功能：
 * - 验证启动日志恢复后，单方向冷却会对同监控标的双方向买入生效。
 */
import { describe, expect, it } from 'bun:test';
import { createBuyRiskChecks } from '../../src/application/ordinaryBuy/riskChecks.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createTradeLogHydrator } from '../../src/application/protectiveLiquidation/tradeLogHydrator.js';
import type { BuyRiskCheckContext } from '../../src/application/ordinaryBuy/types.js';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

function createCompletedRecord(params: {
  readonly monitorSymbol: string;
  readonly action: 'SELLCALL' | 'SELLPUT';
  readonly executedAtMs: number;
}) {
  const direction: 'LONG' | 'SHORT' = params.action === 'SELLCALL' ? 'LONG' : 'SHORT';
  const tradingDayKey = '2026-03-13';
  const symbol = direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK';
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION' as const,
    schemaVersion: 1 as const,
    completionId: `v1:${tradingDayKey}:${params.monitorSymbol}:${direction}:${String(params.executedAtMs)}`,
    tradingDayKey,
    monitorSymbol: params.monitorSymbol,
    direction,
    boundaryExecutedTimeMs: params.executedAtMs,
    orderBaselines: [
      {
        orderId: `PROTECTIVE-${direction}-${String(params.executedAtMs)}`,
        symbol,
        side: 'SELL' as const,
        cumulativeQuantity: '100',
        cumulativeAmount: '500',
        lastExecutionTimeMs: params.executedAtMs,
        orderRevisionMs: params.executedAtMs,
      },
    ],
  };
}

function createRiskContext(params: {
  readonly tradeRuntime: ReturnType<typeof createTradeRuntimeDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
  readonly monitorConfig: ReturnType<typeof createMonitorConfig>;
}): BuyRiskCheckContext {
  return {
    accountService: params.tradeRuntime.accountService,
    tradeFrequencyReader: params.tradeRuntime.orderExecutor,

    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble(params.monitorConfig.longSymbol, '5', 100),
    shortQuote: createQuoteDouble(params.monitorConfig.shortSymbol, '5', 100),
    monitorQuote: createQuoteDouble(params.monitorConfig.monitorSymbol, '20000'),

    longSymbol: params.monitorConfig.longSymbol,
    shortSymbol: params.monitorConfig.shortSymbol,
    longSymbolName: params.monitorConfig.longSymbol,
    shortSymbolName: params.monitorConfig.shortSymbol,
    currentTime: new Date('2026-03-13T10:00:00+08:00'),
    isHalfDay: false,

    config: params.monitorConfig,
  };
}

async function assertDualDirectionBuyBlockedAfterHydration(params: {
  readonly nowMs: number;
  readonly recordAction: 'SELLCALL' | 'SELLPUT';
  readonly expectedBoundaryKey: 'LONG' | 'SHORT';
}): Promise<void> {
  const monitorConfig = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    liquidationTriggerLimit: 1,
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({
    monitor: monitorConfig,
  });
  const tracker = createLiquidationCooldownTracker();
  const executedAtMs = params.nowMs - 30_000;
  const hydrator = createTradeLogHydrator({
    mixedTradeLogRepository: {
      loadCompletionRecords: () => [
        createCompletedRecord({
          monitorSymbol: 'HSI.HK',
          action: params.recordAction,
          executedAtMs,
        }),
      ],
    },
    nowMs: () => params.nowMs,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    tradingConfig,
    liquidationCooldownTracker: tracker,
  });

  hydrator.hydrate();
  expect(
    tracker.getRemainingMs({
      direction: params.expectedBoundaryKey,
      cooldownConfig: { mode: 'minutes', minutes: 5 },
      currentTimeMs: params.nowMs,
    }),
  ).toBeGreaterThan(0);

  const tradeRuntime = createTradeRuntimeDouble({
    accountService: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => [],
    },
    orderExecutor: { canTradeNow: () => ({ canTrade: true }) },
  });
  const checkRisk = createBuyRiskChecks({
    logger: createLoggerDouble(),
    doomsdayProtection: tradingConfig.global.doomsdayProtection,
    liquidationCooldownTracker: tracker,
    lastRiskCheckTime: new Map(),
    reportFatalError: () => {},
  });
  const context = createRiskContext({
    tradeRuntime,
    riskChecker: createRiskCheckerDouble(),
    orderRecorder: createOrderRecorderDouble(),
    monitorConfig,
  });
  const buyCallSignal = createSignal({
    symbol: 'BULL.HK',
    action: 'BUYCALL',
    triggerTimeMs: params.nowMs,
    reason: 'recovery-cooldown-buycall',
  });
  const buyPutSignal = createSignal({
    symbol: 'BEAR.HK',
    action: 'BUYPUT',
    triggerTimeMs: params.nowMs,
    reason: 'recovery-cooldown-buyput',
  });

  const buyCallResult = await checkRisk([buyCallSignal], {
    ...context,
    currentTime: new Date(params.nowMs),
  });
  const buyPutResult = await checkRisk([buyPutSignal], {
    ...context,
    currentTime: new Date(params.nowMs + 10),
  });

  expect(buyCallResult).toHaveLength(0);
  expect(buyPutResult).toHaveLength(0);
  expect(buyCallSignal.reason).toBe('recovery-cooldown-buycall');
  expect(buyPutSignal.reason).toBe('recovery-cooldown-buyput');
}

describe('liquidation-cooldown-recovery integration', () => {
  it('fails fast when hydration log contains cooldown records from a non-configured monitor symbol', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const monitorConfig = createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'A-BULL.HK',
      shortSymbol: 'A-BEAR.HK',
      liquidationTriggerLimit: 1,
      liquidationCooldown: { mode: 'minutes', minutes: 5 },
    });
    const tradingConfig = createTradingConfig({
      monitor: monitorConfig,
    });
    const tracker = createLiquidationCooldownTracker();
    const hydrator = createTradeLogHydrator({
      mixedTradeLogRepository: {
        loadCompletionRecords: () => [
          createCompletedRecord({
            monitorSymbol: monitorConfig.monitorSymbol,
            action: 'SELLCALL',
            executedAtMs: nowMs - 30_000,
          }),
          createCompletedRecord({
            monitorSymbol: 'HSCEI.HK',
            action: 'SELLCALL',
            executedAtMs: nowMs - 20_000,
          }),
        ],
      },
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    expect(() => {
      hydrator.hydrate();
    }).toThrow('monitorSymbol mismatch');
  });

  it('blocks BUYCALL and BUYPUT after hydrating only LONG cooldown records', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    await assertDualDirectionBuyBlockedAfterHydration({
      nowMs,
      recordAction: 'SELLCALL',
      expectedBoundaryKey: 'LONG',
    });
  });

  it('blocks BUYCALL and BUYPUT after hydrating only SHORT cooldown records', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    await assertDualDirectionBuyBlockedAfterHydration({
      nowMs,
      recordAction: 'SELLPUT',
      expectedBoundaryKey: 'SHORT',
    });
  });

  it('does not block BUYCALL and BUYPUT when hydrated cooldown record is already expired', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const monitorConfig = createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      liquidationTriggerLimit: 1,
      liquidationCooldown: { mode: 'minutes', minutes: 5 },
    });
    const tradingConfig = createTradingConfig({
      monitor: monitorConfig,
    });
    const tracker = createLiquidationCooldownTracker();
    const executedAtMs = nowMs - 6 * 60_000;
    const hydrator = createTradeLogHydrator({
      mixedTradeLogRepository: {
        loadCompletionRecords: () => [
          createCompletedRecord({
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs,
          }),
        ],
      },
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    hydrator.hydrate();

    const tradeRuntime = createTradeRuntimeDouble({
      accountService: {
        getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
        getStockPositions: async () => [],
      },
      orderExecutor: { canTradeNow: () => ({ canTrade: true }) },
    });
    const checkRisk = createBuyRiskChecks({
      logger: createLoggerDouble(),
      doomsdayProtection: tradingConfig.global.doomsdayProtection,
      liquidationCooldownTracker: tracker,
      lastRiskCheckTime: new Map(),
      reportFatalError: () => {},
    });
    const context = createRiskContext({
      tradeRuntime,
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
      monitorConfig,
    });
    const buyCallSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: nowMs,
      reason: 'recovery-expired-buycall',
    });
    const buyPutSignal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: nowMs,
      reason: 'recovery-expired-buyput',
    });

    const buyCallResult = await checkRisk([buyCallSignal], {
      ...context,
      currentTime: new Date(nowMs),
    });
    const buyPutResult = await checkRisk([buyPutSignal], {
      ...context,
      currentTime: new Date(nowMs + 10),
    });

    expect(buyCallResult).toHaveLength(1);
    expect(buyPutResult).toHaveLength(1);
    expect(buyCallSignal.reason).not.toContain('清仓冷却期内');
    expect(buyPutSignal.reason).not.toContain('清仓冷却期内');
  });
});
