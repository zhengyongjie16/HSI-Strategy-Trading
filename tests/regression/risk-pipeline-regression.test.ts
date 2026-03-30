/**
 * risk-pipeline 回归测试
 *
 * 功能：
 * - 回归验证风险检查阶段不会占用买入频率槽位
 * - 回归验证混合批次中买卖路径的数据来源不会串扰
 */
import { describe, expect, it } from 'bun:test';
import type { RiskCheckContext } from '../../src/types/services.js';
import { createRiskCheckPipeline } from '../../src/core/signalProcessor/riskCheckPipeline.js';
import { createGlobalConfig } from '../../mock/factories/configFactory.js';
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
} from '../helpers/testDoubles.js';
import { createBuyThrottle } from '../../src/core/trader/orderExecutor/buyThrottle.js';

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
    longQuote: createQuoteDouble('BULL.HK', 1),
    shortQuote: createQuoteDouble('BEAR.HK', 1),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000),
    monitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL',
    shortSymbolName: 'BEAR',
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

describe('risk pipeline regression', () => {
  it('does not consume same-direction buy throttle during risk check stage', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    const buyThrottle = createBuyThrottle();
    const trader = createTraderDouble({
      canTradeNow: buyThrottle.canTradeNow,
      getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });
    const context = createContext({
      trader,
      riskChecker: createRiskCheckerDouble(),
    });

    const firstBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const firstResult = await withMockedNow(100_000, async () => pipeline([firstBuy], context));
    expect(firstResult).toHaveLength(1);

    const secondBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const secondResult = await withMockedNow(110_001, async () => pipeline([secondBuy], context));
    expect(secondResult).toHaveLength(1);

    const buyTradeCheck = await withMockedNow(110_001, async () =>
      buyThrottle.canTradeNow('BUYCALL', context.config),
    );
    expect(buyTradeCheck.canTrade).toBe(true);
  });

  it('keeps mixed-batch sell checks on cached context when buy realtime fetch fails', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    const cachedAccount = createAccountSnapshotDouble(88_888);
    const cachedPositions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 100,
      }),
    ];

    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        throw new Error('buy api down');
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      globalConfig: createGlobalConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => 0,
      }),
      lastRiskCheckTime,
    });

    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');

    const result = await withMockedNow(300_000, async () =>
      pipeline(
        [buySignal, sellSignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({ allowed: true }),
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
    expect(buySignal.reason).toContain('获取实时账户和持仓信息失败');
  });
});
