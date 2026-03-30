/**
 * riskCheckPipeline 业务测试
 *
 * 功能：
 * - 验证买入轻检查顺序
 * - 验证买入不再依赖 latest buy price / orderRecorder
 * - 验证卖出路径继续使用缓存账户与持仓
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { RiskCheckContext } from '../../../src/types/services.js';
import { createRiskCheckPipeline } from '../../../src/core/signalProcessor/riskCheckPipeline.js';
import { createGlobalConfig } from '../../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createStrategyRuntimeConfigDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

function withMockedNow<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly account?: ReturnType<typeof createAccountSnapshotDouble>;
  readonly positions?: ReadonlyArray<RiskCheckContext['positions'][number]>;
}): RiskCheckContext {
  const monitorConfig = createStrategyRuntimeConfigDouble();
  const account = params.account ?? createAccountSnapshotDouble(100_000);
  const positions = params.positions ?? [];

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    longQuote: createQuoteDouble('BULL.HK', 10),
    shortQuote: createQuoteDouble('BEAR.HK', 10),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000),
    monitorSnapshot: {
      price: 20_000,
      changePercent: 0,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    account,
    positions,
    lastState: {
      cachedAccount: account,
      cachedPositions: positions,
      positionCache: createPositionCacheDouble(positions),
    },
    currentTime: new Date('2026-02-16T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('riskCheckPipeline business flow', () => {
  let lastRiskCheckTime: Map<string, number>;

  beforeEach(() => {
    lastRiskCheckTime = new Map();
  });

  it('blocks risk-check cooldown before entering buy light checks', async () => {
    let canTradeNowCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountFetchCount = 0;
    let positionFetchCount = 0;

    const trader = createTraderDouble({
      canTradeNow: () => {
        canTradeNowCount += 1;
        return { canTrade: true };
      },
      getAccountSnapshot: async () => {
        accountFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => {
        positionFetchCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    lastRiskCheckTime.set('BULL.HK_BUY', 10_000);

    const result = await withMockedNow(10_500, async () =>
      pipeline(
        [signal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => {
              warrantRiskCheckCount += 1;
              return { allowed: true };
            },
            checkBeforeOrder: () => {
              baseRiskCheckCount += 1;
              return { allowed: true };
            },
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toContain('风险检查冷却期内');
    expect(canTradeNowCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountFetchCount).toBe(0);
    expect(positionFetchCount).toBe(0);
  });

  it('allows buy path to pass without any latest-buy-price dependency', async () => {
    let accountFetchCount = 0;
    let positionFetchCount = 0;

    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        accountFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => {
        positionFetchCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => 0,
      }),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const result = await withMockedNow(20_000, async () =>
      pipeline(
        [signal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({ allowed: true }),
            checkBeforeOrder: () => ({ allowed: true }),
          }),
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(signal);
    expect(accountFetchCount).toBe(1);
    expect(positionFetchCount).toBe(1);
  });

  it('keeps sell path on cached account and positions', async () => {
    const cachedAccount = createAccountSnapshotDouble(88_888);
    const cachedPositions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 100,
      }),
    ];
    let realtimeFetchCount = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        realtimeFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => {
        realtimeFetchCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    const result = await withMockedNow(30_000, async () =>
      pipeline(
        [sellSignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkBeforeOrder: ({ account, positions, signal }) => ({
              allowed:
                signal?.action === 'SELLCALL' &&
                account === cachedAccount &&
                positions === cachedPositions,
            }),
          }),
          account: cachedAccount,
          positions: cachedPositions,
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sellSignal);
    expect(realtimeFetchCount).toBe(0);
  });
});
