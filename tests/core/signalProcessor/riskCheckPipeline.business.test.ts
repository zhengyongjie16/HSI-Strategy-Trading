/**
 * riskCheckPipeline 业务测试
 *
 * 功能：
 * - 验证风险检查管道相关场景意图、边界条件与业务期望。
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { BuyRiskCheckContext } from '../../../src/types/services.js';
import { createRiskCheckPipeline } from '../../../src/core/signalProcessor/riskCheckPipeline.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createBuyThrottle } from '../../../src/core/trader/orderExecutor/buyThrottle.js';
import { createExternalApiRequestError } from '../../../src/utils/apiFailure/index.js';
import type { BuySignal } from '../../../src/types/signal.js';

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
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
  readonly doomsdayProtection?: ReturnType<typeof createDoomsdayProtectionDouble>;
}): BuyRiskCheckContext {
  const monitorConfig = createMonitorConfigDouble();

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble('BULL.HK', 10),
    shortQuote: createQuoteDouble('BEAR.HK', 10),
    monitorQuote: createQuoteDouble('HSI.HK', 20000),
    monitorSnapshot: {
      price: 20000,
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
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    currentTime: new Date('2026-02-16T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: params.doomsdayProtection ?? createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('riskCheckPipeline business flow', () => {
  let lastRiskCheckTime: Map<string, number>;

  beforeEach(() => {
    lastRiskCheckTime = new Map();
  });

  it('blocks risk-check cooldown before the entire buy light-check chain', async () => {
    let canTradeNowCount = 0;
    let getRemainingMsCount = 0;
    let latestBuyOrderPriceCount = 0;
    let buyCutoffCheckCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => {
        canTradeNowCount += 1;
        return { canTrade: true };
      },
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          getRemainingMsCount += 1;
          return 0;
        },
      }),
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
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => {
              latestBuyOrderPriceCount += 1;
              return null;
            },
          }),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => {
              buyCutoffCheckCount += 1;
              return false;
            },
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(canTradeNowCount).toBe(0);
    expect(getRemainingMsCount).toBe(0);
    expect(latestBuyOrderPriceCount).toBe(0);
    expect(buyCutoffCheckCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('runs buy light checks before both realtime fetch calls and before base risk check', async () => {
    const steps: string[] = [];

    const trader = createTraderDouble({
      canTradeNow: () => {
        steps.push('canTradeNow');
        return { canTrade: true };
      },
      getAccountSnapshot: async () => {
        steps.push('getAccountSnapshot');
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        steps.push('getStockPositions');
        return [];
      },
    });

    const orderRecorder = createOrderRecorderDouble({
      getLatestBuyOrderPrice: () => {
        steps.push('getLatestBuyOrderPrice');
        return null;
      },
    });

    const riskChecker = createRiskCheckerDouble({
      checkWarrantRisk: () => {
        steps.push('checkWarrantRisk');
        return { allowed: true };
      },
      checkBeforeOrder: () => {
        steps.push('checkBeforeOrder');
        return { allowed: true };
      },
    });

    const doomsdayProtection = createDoomsdayProtectionDouble({
      isBuyCutoffWindowActive: () => {
        steps.push('isBuyCutoffWindowActive');
        return false;
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          steps.push('getRemainingMs');
          return 0;
        },
      }),
      lastRiskCheckTime,
    });

    const result = await withMockedNow(30_000, async () =>
      pipeline(
        [createSignalDouble('BUYCALL', 'BULL.HK')],
        createContext({
          trader,
          riskChecker,
          orderRecorder,
          doomsdayProtection,
        }),
      ),
    );

    expect(result).toHaveLength(1);

    const tradeFrequencyIndex = steps.indexOf('canTradeNow');
    const liquidationCooldownIndex = steps.indexOf('getRemainingMs');
    const priceLimitIndex = steps.indexOf('getLatestBuyOrderPrice');
    const doomsdayIndex = steps.indexOf('isBuyCutoffWindowActive');
    const warrantRiskIndex = steps.indexOf('checkWarrantRisk');
    const accountFetchIndex = steps.indexOf('getAccountSnapshot');
    const positionsFetchIndex = steps.indexOf('getStockPositions');
    const baseRiskIndex = steps.indexOf('checkBeforeOrder');

    expect(tradeFrequencyIndex).toBeGreaterThan(-1);
    expect(liquidationCooldownIndex).toBeGreaterThan(tradeFrequencyIndex);
    expect(priceLimitIndex).toBeGreaterThan(liquidationCooldownIndex);
    expect(doomsdayIndex).toBeGreaterThan(priceLimitIndex);
    expect(warrantRiskIndex).toBeGreaterThan(doomsdayIndex);
    expect(accountFetchIndex).toBeGreaterThan(warrantRiskIndex);
    expect(positionsFetchIndex).toBeGreaterThan(warrantRiskIndex);
    expect(baseRiskIndex).toBeGreaterThan(accountFetchIndex);
    expect(baseRiskIndex).toBeGreaterThan(positionsFetchIndex);
  });

  it('does not preempt same-direction buy slot in risk check stage', async () => {
    const monitorConfig = createMonitorConfigDouble();
    const buyThrottle = createBuyThrottle(monitorConfig.buyIntervalSeconds);
    const trader = createTraderDouble({
      canTradeNow: buyThrottle.canTradeNow,
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const firstBuySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const secondBuySignal = createSignalDouble('BUYCALL', 'BULL.HK');

    const firstResult = await withMockedNow(40_000, async () =>
      pipeline(
        [firstBuySignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble(),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );
    expect(firstResult).toHaveLength(1);

    const secondResult = await withMockedNow(50_001, async () =>
      pipeline(
        [secondBuySignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble(),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(secondResult).toHaveLength(1);
    expect(secondBuySignal.reason).toBeUndefined();

    const buyTradeCheck = await withMockedNow(50_001, async () =>
      buyThrottle.canTradeNow('BUYCALL'),
    );
    expect(buyTradeCheck.canTrade).toBe(true);
  });

  it('uses realtime account and positions for buy base risk check', async () => {
    const realtimeAccount = createAccountSnapshotDouble(90_000);
    const realtimePositions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 300,
        availableQuantity: 200,
      }),
    ];
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => realtimeAccount,
      getStockPositions: async () => realtimePositions,
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const result = await withMockedNow(45_000, async () =>
      pipeline(
        [signal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({ allowed: true }),
            checkBeforeOrder: ({ account, positions }) => ({
              allowed: account === realtimeAccount && positions === realtimePositions,
              reason: 'buy base risk check should use realtime account and positions',
            }),
          }),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(result).toHaveLength(1);
  });

  it('throws plain account fetch errors and does not turn them into business rejection or enter base risk check', async () => {
    let baseRiskCheckCount = 0;
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        throw new Error('unexpected parser failure');
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    let caught: unknown = null;
    try {
      await withMockedNow(47_000, async () =>
        pipeline(
          [signal],
          createContext({
            trader,
            riskChecker: createRiskCheckerDouble({
              checkWarrantRisk: () => ({ allowed: true }),
              checkBeforeOrder: () => {
                baseRiskCheckCount += 1;
                return { allowed: true };
              },
            }),
            orderRecorder: createOrderRecorderDouble(),
          }),
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('unexpected parser failure');
    expect(signal.reason).toBeUndefined();
    expect(lastRiskCheckTime.has('BULL.HK_BUY')).toBe(true);
    expect(baseRiskCheckCount).toBe(0);
  });

  it('throws TypeError from realtime account fetch and keeps cooldown occupied without entering base risk check', async () => {
    let baseRiskCheckCount = 0;
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        throw new TypeError('TradeContext.accountBalance returned no primary account');
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    let caught: unknown = null;
    try {
      await withMockedNow(47_500, async () =>
        pipeline(
          [signal],
          createContext({
            trader,
            riskChecker: createRiskCheckerDouble({
              checkWarrantRisk: () => ({ allowed: true }),
              checkBeforeOrder: () => {
                baseRiskCheckCount += 1;
                return { allowed: true };
              },
            }),
            orderRecorder: createOrderRecorderDouble(),
          }),
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(
      'TradeContext.accountBalance returned no primary account',
    );
    expect(signal.reason).toBeUndefined();
    expect(lastRiskCheckTime.has('BULL.HK_BUY')).toBe(true);
    expect(baseRiskCheckCount).toBe(0);
  });

  it('does not refresh buy throttle when base risk check rejects after realtime fetch', async () => {
    const monitorConfig = createMonitorConfigDouble();
    const buyThrottle = createBuyThrottle(monitorConfig.buyIntervalSeconds);
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const trader = createTraderDouble({
      canTradeNow: buyThrottle.canTradeNow,
      getAccountSnapshot: async () => createAccountSnapshotDouble(100000),
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const result = await withMockedNow(48_000, async () =>
      pipeline(
        [signal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({ allowed: true }),
            checkBeforeOrder: () => ({
              allowed: false,
              reason: 'base risk blocked',
            }),
          }),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();

    const buyTradeCheck = await withMockedNow(48_000, async () =>
      buyThrottle.canTradeNow('BUYCALL'),
    );
    expect(buyTradeCheck.canTrade).toBe(true);
  });

  it('short-circuits the remaining buy checks when trade frequency check fails', async () => {
    let getRemainingMsCount = 0;
    let latestBuyOrderPriceCount = 0;
    let buyCutoffCheckCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: false, waitSeconds: 30 }),
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          getRemainingMsCount += 1;
          return 0;
        },
      }),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const result = await withMockedNow(50_000, async () =>
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
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => {
              latestBuyOrderPriceCount += 1;
              return null;
            },
          }),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => {
              buyCutoffCheckCount += 1;
              return false;
            },
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(getRemainingMsCount).toBe(0);
    expect(latestBuyOrderPriceCount).toBe(0);
    expect(buyCutoffCheckCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('short-circuits later buy checks when liquidation cooldown check fails', async () => {
    let latestBuyOrderPriceCount = 0;
    let buyCutoffCheckCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: (params) => {
          if (params.direction === 'LONG') {
            return 5_000;
          }

          return 0;
        },
      }),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYPUT', 'BEAR.HK');
    const result = await withMockedNow(60_000, async () =>
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
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => {
              latestBuyOrderPriceCount += 1;
              return null;
            },
          }),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => {
              buyCutoffCheckCount += 1;
              return false;
            },
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(latestBuyOrderPriceCount).toBe(0);
    expect(buyCutoffCheckCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('short-circuits later buy checks when buy price limit check fails', async () => {
    let buyCutoffCheckCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const result = await withMockedNow(70_000, async () =>
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
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => 10,
          }),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => {
              buyCutoffCheckCount += 1;
              return false;
            },
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(buyCutoffCheckCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('short-circuits later buy checks when doomsday protection rejects buy', async () => {
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const result = await withMockedNow(80_000, async () =>
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
          orderRecorder: createOrderRecorderDouble(),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => true,
          }),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('short-circuits base risk check when warrant risk check fails', async () => {
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYPUT', 'BEAR.HK');
    const result = await withMockedNow(90_000, async () =>
      pipeline(
        [signal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({
              allowed: false,
              reason: 'warrant blocked',
            }),
            checkBeforeOrder: () => {
              baseRiskCheckCount += 1;
              return { allowed: true };
            },
          }),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toBeUndefined();
    expect(baseRiskCheckCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
  });

  it('uses no-retry realtime account and position reads and rethrows ExternalApiRequestError after one call each while keeping cooldown occupied', async () => {
    const steps: string[] = [];
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');

    const trader = createTraderDouble({
      canTradeNow: () => {
        steps.push('canTradeNow');
        return { canTrade: true };
      },
      getAccountSnapshot: async (params) => {
        accountCallCount += 1;
        steps.push('getAccountSnapshot');
        expect(params?.retryConfig).toEqual({ retries: 0, delayMs: 0 });
        throw createExternalApiRequestError({
          operation: 'TradeContext.accountBalance',
          attempts: 1,
          cause: new Error('temporary'),
        });
      },
      getStockPositions: async (params) => {
        positionCallCount += 1;
        steps.push('getStockPositions');
        expect(params?.retryConfig).toEqual({ retries: 0, delayMs: 0 });
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          steps.push('getRemainingMs');
          return 0;
        },
      }),
      lastRiskCheckTime,
    });

    let caught: unknown = null;
    try {
      await withMockedNow(100_000, async () =>
        pipeline(
          [buySignal],
          createContext({
            trader,
            riskChecker: createRiskCheckerDouble({
              checkWarrantRisk: () => {
                steps.push('checkWarrantRisk');
                return { allowed: true };
              },
              checkBeforeOrder: () => {
                baseRiskCheckCount += 1;
                return { allowed: true };
              },
            }),
            orderRecorder: createOrderRecorderDouble({
              getLatestBuyOrderPrice: () => {
                steps.push('getLatestBuyOrderPrice');
                return null;
              },
            }),
            doomsdayProtection: createDoomsdayProtectionDouble({
              isBuyCutoffWindowActive: () => {
                steps.push('isBuyCutoffWindowActive');
                return false;
              },
            }),
          }),
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.accountBalance',
      attempts: 1,
    });
    expect(accountCallCount).toBe(1);
    expect(positionCallCount).toBe(1);
    expect(buySignal.reason).toBeUndefined();
    expect(lastRiskCheckTime.has('BULL.HK_BUY')).toBe(true);
    expect(baseRiskCheckCount).toBe(0);

    const tradeFrequencyIndex = steps.indexOf('canTradeNow');
    const liquidationCooldownIndex = steps.indexOf('getRemainingMs');
    const priceLimitIndex = steps.indexOf('getLatestBuyOrderPrice');
    const doomsdayIndex = steps.indexOf('isBuyCutoffWindowActive');
    const warrantRiskIndex = steps.indexOf('checkWarrantRisk');
    const accountFetchIndex = steps.indexOf('getAccountSnapshot');
    const positionsFetchIndex = steps.indexOf('getStockPositions');

    expect(tradeFrequencyIndex).toBeGreaterThan(-1);
    expect(liquidationCooldownIndex).toBeGreaterThan(tradeFrequencyIndex);
    expect(priceLimitIndex).toBeGreaterThan(liquidationCooldownIndex);
    expect(doomsdayIndex).toBeGreaterThan(priceLimitIndex);
    expect(warrantRiskIndex).toBeGreaterThan(doomsdayIndex);
    expect(accountFetchIndex).toBeGreaterThan(warrantRiskIndex);
    expect(positionsFetchIndex).toBeGreaterThan(warrantRiskIndex);
  });

  it('throws ExternalApiRequestError on positions fetch failure after light checks and keeps cooldown occupied', async () => {
    const steps: string[] = [];
    let baseRiskCheckCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    const signal = createSignalDouble('BUYCALL', 'BULL.HK');

    const trader = createTraderDouble({
      canTradeNow: () => {
        steps.push('canTradeNow');
        return { canTrade: true };
      },
      getAccountSnapshot: async (params) => {
        accountCallCount += 1;
        steps.push('getAccountSnapshot');
        expect(params?.retryConfig).toEqual({ retries: 0, delayMs: 0 });
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async (params) => {
        positionCallCount += 1;
        steps.push('getStockPositions');
        expect(params?.retryConfig).toEqual({ retries: 0, delayMs: 0 });
        throw createExternalApiRequestError({
          operation: 'TradeContext.stockPositions',
          attempts: 1,
          cause: new Error('positions api down'),
        });
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          steps.push('getRemainingMs');
          return 0;
        },
      }),
      lastRiskCheckTime,
    });

    let caught: unknown = null;
    try {
      await withMockedNow(110_000, async () =>
        pipeline(
          [signal],
          createContext({
            trader,
            riskChecker: createRiskCheckerDouble({
              checkWarrantRisk: () => {
                steps.push('checkWarrantRisk');
                return { allowed: true };
              },
              checkBeforeOrder: () => {
                baseRiskCheckCount += 1;
                return { allowed: true };
              },
            }),
            orderRecorder: createOrderRecorderDouble({
              getLatestBuyOrderPrice: () => {
                steps.push('getLatestBuyOrderPrice');
                return null;
              },
            }),
            doomsdayProtection: createDoomsdayProtectionDouble({
              isBuyCutoffWindowActive: () => {
                steps.push('isBuyCutoffWindowActive');
                return false;
              },
            }),
          }),
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('ExternalApiRequestError');
    expect((caught as Error & { operation?: string }).operation).toBe(
      'TradeContext.stockPositions',
    );
    expect((caught as Error & { attempts?: number }).attempts).toBe(1);
    expect(accountCallCount).toBe(1);
    expect(positionCallCount).toBe(1);
    expect(signal.reason).toBeUndefined();
    expect(lastRiskCheckTime.has('BULL.HK_BUY')).toBe(true);
    expect(baseRiskCheckCount).toBe(0);

    const warrantRiskIndex = steps.indexOf('checkWarrantRisk');
    const accountFetchIndex = steps.indexOf('getAccountSnapshot');
    const positionsFetchIndex = steps.indexOf('getStockPositions');

    expect(warrantRiskIndex).toBeGreaterThan(-1);
    expect(accountFetchIndex).toBeGreaterThan(warrantRiskIndex);
    expect(positionsFetchIndex).toBeGreaterThan(warrantRiskIndex);
  });

  it('fails fast for a forced sell signal before any buy-risk side effect', async () => {
    let canTradeNowCount = 0;
    let accountCallCount = 0;
    let positionCallCount = 0;
    let liquidationCooldownCount = 0;
    let latestBuyOrderPriceCount = 0;
    let buyCutoffCheckCount = 0;
    let warrantRiskCheckCount = 0;
    let baseRiskCheckCount = 0;
    const trader = createTraderDouble({
      canTradeNow: () => {
        canTradeNowCount += 1;
        return { canTrade: true };
      },
      getAccountSnapshot: async () => {
        accountCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        positionCallCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => {
          liquidationCooldownCount += 1;
          return 0;
        },
      }),
      lastRiskCheckTime,
    });
    const forcedSellSignal = createSignalDouble('SELLCALL', 'BULL.HK') as unknown as BuySignal;
    let caught: unknown = null;
    try {
      await pipeline(
        [forcedSellSignal],
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
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => {
              latestBuyOrderPriceCount += 1;
              return null;
            },
          }),
          doomsdayProtection: createDoomsdayProtectionDouble({
            isBuyCutoffWindowActive: () => {
              buyCutoffCheckCount += 1;
              return false;
            },
          }),
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('买入风控只接受 BUYCALL 或 BUYPUT');
    expect(lastRiskCheckTime.size).toBe(0);
    expect(canTradeNowCount).toBe(0);
    expect(accountCallCount).toBe(0);
    expect(positionCallCount).toBe(0);
    expect(liquidationCooldownCount).toBe(0);
    expect(latestBuyOrderPriceCount).toBe(0);
    expect(buyCutoffCheckCount).toBe(0);
    expect(warrantRiskCheckCount).toBe(0);
    expect(baseRiskCheckCount).toBe(0);
  });
});
