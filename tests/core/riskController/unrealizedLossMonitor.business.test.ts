/**
 * unrealizedLossMonitor 业务测试
 *
 * 覆盖：
 * - 同标的存在未完成卖单时，不重复触发保护性清仓
 * - 无未完成卖单时，触发保护性清仓并刷新浮亏缓存
 */
import { describe, expect, it } from 'bun:test';
import { createUnrealizedLossMonitor } from '../../../src/core/riskController/unrealizedLossMonitor.js';
import {
  createDailyLossTrackerDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

describe('unrealizedLossMonitor business flow', () => {
  it('skips duplicate liquidation when pending sell already exists for the symbol', async () => {
    let executeCount = 0;
    let refreshCount = 0;

    const trader = createTraderDouble({
      hasPendingSellOrders: () => true,
      executeSignals: async () => {
        executeCount += 1;
        return { submittedCount: 1, submittedOrderIds: ['SELL-1'] };
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'loss-limit',
        quantity: 100,
      }),
      refreshUnrealizedLossData: async () => {
        refreshCount += 1;
        return { r1: 100, n1: 100 };
      },
    });

    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 500,
    });

    await monitor.monitorUnrealizedLoss({
      longQuote: createQuoteDouble('BULL.HK', 1),
      shortQuote: null,
      longSymbol: 'BULL.HK',
      shortSymbol: '',
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
      shortPosition: null,
      baseInstrumentSymbol: 'HSI.HK',
      riskChecker,
      trader,
      dailyLossTracker: createDailyLossTrackerDouble(),
    });

    expect(executeCount).toBe(0);
    expect(refreshCount).toBe(0);
  });

  it('submits liquidation and refreshes unrealized-loss cache when no pending sell exists', async () => {
    let executeCount = 0;
    let refreshCount = 0;

    const trader = createTraderDouble({
      hasPendingSellOrders: () => false,
      executeSignals: async () => {
        executeCount += 1;
        return { submittedCount: 1, submittedOrderIds: ['SELL-2'] };
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkUnrealizedLoss: () => ({
        shouldLiquidate: true,
        reason: 'loss-limit',
        quantity: 100,
      }),
      refreshUnrealizedLossData: async () => {
        refreshCount += 1;
        return { r1: 100, n1: 100 };
      },
    });

    const monitor = createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: 500,
    });

    await monitor.monitorUnrealizedLoss({
      longQuote: createQuoteDouble('BULL.HK', 1),
      shortQuote: null,
      longSymbol: 'BULL.HK',
      shortSymbol: '',
      longPosition: createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 100,
        availableQuantity: 100,
      }),
      shortPosition: null,
      baseInstrumentSymbol: 'HSI.HK',
      riskChecker,
      trader,
      dailyLossTracker: createDailyLossTrackerDouble(),
    });

    expect(executeCount).toBe(1);
    expect(refreshCount).toBe(1);
  });
});
