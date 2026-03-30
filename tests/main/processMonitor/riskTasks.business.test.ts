/**
 * riskTasks 业务测试
 *
 * 覆盖：
 * - monitor price 变化时同时调度 liquidation-distance 与 unrealized-loss 检查
 * - 展示信息完全来自 riskChecker 缓存
 */
import { describe, expect, it } from 'bun:test';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import { scheduleRiskTasks } from '../../../src/main/processMonitor/riskTasks.js';
import type { SeatSyncResult } from '../../../src/main/processMonitor/types.js';
import type { MainProgramContext } from '../../../src/main/mainProgram/types.js';
import type { PriceDisplayInfo } from '../../../src/services/marketMonitor/types.js';
import type { Quote } from '../../../src/types/quote.js';
import type { StrategyRuntime } from '../../../src/types/state.js';
import {
  createQuoteDouble,
  createRiskCheckerDouble,
  createStrategyRuntimeDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';

function createSeatInfo(): SeatSyncResult {
  return {
    longSeatState: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeatState: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longSeatVersion: 3,
    shortSeatVersion: 4,
    longSeatActive: true,
    shortSeatActive: true,
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longQuote: createQuoteDouble('BULL.HK', 1.1),
    shortQuote: createQuoteDouble('BEAR.HK', 0.8),
  };
}

describe('riskTasks business scheduling', () => {
  it('schedules liquidation-distance and unrealized-loss checks in one tick', () => {
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const capturedDisplayInfo: {
      long: PriceDisplayInfo | null | undefined;
      short: PriceDisplayInfo | null | undefined;
    } = {
      long: null,
      short: null,
    };
    const monitorContext = createStrategyRuntimeDouble({
      riskChecker: createRiskCheckerDouble({
        getWarrantDistanceInfo: (isLongSymbol) =>
          createWarrantDistanceInfoDouble({
            warrantType: isLongSymbol ? 'BULL' : 'BEAR',
            distanceToStrikePercent: isLongSymbol ? 0.7 : -0.8,
          }),
        getUnrealizedLossMetrics: (symbol, currentPrice) => {
          if (symbol === 'BULL.HK' && currentPrice === 1.1) {
            return {
              r1: 100,
              n1: 100,
              r2: 110,
              unrealizedPnL: 10,
            };
          }

          if (symbol === 'BEAR.HK' && currentPrice === 0.8) {
            return {
              r1: 90,
              n1: 100,
              r2: 80,
              unrealizedPnL: -10,
            };
          }

          return null;
        },
      }),
    });
    const mainContext = {
      marketMonitor: {
        monitorPriceChanges: (
          _longQuote: Quote | null,
          _shortQuote: Quote | null,
          _longSymbol: string,
          _shortSymbol: string,
          _state: StrategyRuntime['state'],
          longDisplayInfo: PriceDisplayInfo | null | undefined,
          shortDisplayInfo: PriceDisplayInfo | null | undefined,
        ) => {
          capturedDisplayInfo.long = longDisplayInfo;
          capturedDisplayInfo.short = shortDisplayInfo;
          return true;
        },
      },
      monitorTaskQueue,
    } as unknown as MainProgramContext;

    scheduleRiskTasks({
      baseInstrumentSymbol: 'HSI.HK',
      monitorContext,
      mainContext,
      seatInfo: createSeatInfo(),
      autoSearchEnabled: false,
      monitorPriceChanged: true,
      resolvedMonitorPrice: 20_000,
      monitorCurrentPrice: 20_000,
    });

    const first = monitorTaskQueue.pop();
    const second = monitorTaskQueue.pop();

    expect(first?.type).toBe('LIQUIDATION_DISTANCE_CHECK');
    expect(second?.type).toBe('UNREALIZED_LOSS_CHECK');
    expect(capturedDisplayInfo.long?.positionCount).toBe(1);
    expect(capturedDisplayInfo.short?.positionCount).toBe(1);
    expect(capturedDisplayInfo.long?.warrantDistanceInfo?.warrantType).toBe('BULL');
    expect(capturedDisplayInfo.short?.warrantDistanceInfo?.warrantType).toBe('BEAR');
  });
});
