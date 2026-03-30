/**
 * doomsday 集成测试
 *
 * 覆盖：
 * - 收盘前 15 分钟拒绝买入
 * - 收盘前 5 分钟按当前持仓与席位生成清仓卖单
 */
import { describe, expect, it } from 'bun:test';
import { createDoomsdayProtection } from '../../src/core/doomsdayProtection/index.js';
import {
  createMarketDataClientDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createStrategyRuntimeConfigDouble,
  createStrategyRuntimeDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

describe('doomsday integration', () => {
  it('rejects buy during the last 15 minutes window', () => {
    const protection = createDoomsdayProtection();

    expect(protection.shouldRejectBuy(new Date('2026-02-16T07:46:00.000Z'), false)).toBeTrue();
    expect(protection.shouldRejectBuy(new Date('2026-02-16T07:44:00.000Z'), false)).toBeFalse();
  });

  it('executes clearance from current positions without any orderRecorder dependency', async () => {
    const executedSignals: Array<{
      readonly action: string;
      readonly symbol: string;
      readonly quantity: number | null | undefined;
    }> = [];
    const protection = createDoomsdayProtection();
    const monitorContext = createStrategyRuntimeDouble({
      config: createStrategyRuntimeConfigDouble({
        baseInstrumentSymbol: 'HSI.HK',
      }),
      symbolRegistry: createSymbolRegistryDouble({
        baseInstrumentSymbol: 'HSI.HK',
        longSeat: {
          symbol: 'BULL.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
        shortSeat: {
          symbol: 'BEAR.HK',
          status: 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          callPrice: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        },
      }),
      longSymbolName: 'BULL',
      shortSymbolName: 'BEAR',
    });
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        for (const signal of signals) {
          executedSignals.push({
            action: signal.action,
            symbol: signal.symbol,
            quantity: signal.quantity,
          });
        }

        return {
          submittedCount: signals.length,
          submittedOrderIds: signals.map((_, index) => `ORDER-${index + 1}`),
        };
      },
    });

    const result = await protection.executeClearance({
      currentTime: new Date('2026-02-16T07:56:00.000Z'),
      isHalfDay: false,
      positions: [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 300,
          availableQuantity: 300,
        }),
      ],
      monitorConfig: monitorContext.config,
      monitorContext,
      trader,
      marketDataClient: createMarketDataClientDouble({
        getQuotes: async () => new Map([['BULL.HK', createQuoteDouble('BULL.HK', 1.05, 100)]]),
      }),
      lastState: {
        canTrade: true,
        isHalfDay: false,
        openProtectionActive: false,
        currentDayKey: '2026-02-16',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        targetTradingDayKey: null,
        isTradingEnabled: true,
        cachedAccount: null,
        cachedPositions: [],
        positionCache: createPositionCacheDouble(),
        cachedTradingDayInfo: null,
        monitorState: {
          baseInstrumentSymbol: 'HSI.HK',
          monitorPrice: null,
          longPrice: null,
          shortPrice: null,
          signal: null,
          pendingSignals: [],
          lastMonitorSnapshot: null,
          lastCandlestickCacheVersion: null,
          lastDisplaySignature: null,
          displayPlan: ['price', 'changePercent'],
        },
        allTradingSymbols: new Set<string>(),
      },
    });

    expect(result).toEqual({
      executed: true,
      signalCount: 1,
    });

    expect(executedSignals).toEqual([
      {
        action: 'SELLCALL',
        symbol: 'BULL.HK',
        quantity: 300,
      },
    ]);
  });
});
