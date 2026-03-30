import type { CleanupContext } from '../../src/app/types.js';
import type { MonitorTaskProcessor } from '../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { MarketDataClient } from '../../src/types/services.js';
import type { LastState, StrategyState } from '../../src/types/state.js';
import { createStrategyRuntimeDouble } from '../helpers/testDoubles.js';

/**
 * 构造单监控标的的 StrategyState，含默认指标快照，供 cleanup 测试使用。
 *
 * @param baseInstrumentSymbol 监控标的代码
 * @returns 用于测试的 StrategyState
 */
export function createStrategyState(baseInstrumentSymbol: string): StrategyState {
  return {
    baseInstrumentSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingSignals: [],
    monitorValues: {
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
    lastMonitorSnapshot: {
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
    lastCandlestickCacheVersion: null,
  };
}

/**
 * 构造 LastState，仅填充 monitorState 与基础字段，其余为测试用占位，供 cleanup 测试使用。
 *
 * @param monitorState 单实例监控状态
 * @returns 用于测试的 LastState
 */
export function createLastState(monitorState: StrategyState): LastState {
  return {
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
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorState,
    allTradingSymbols: new Set(),
  };
}

/**
 * 构造 cleanup 测试依赖的默认实现，并将每个清理步骤写入 steps。
 *
 * @param steps 步骤记录数组
 * @returns 默认 CleanupContext
 */
function defaultDeps(steps: string[]): CleanupContext {
  const monitorTaskProcessor: MonitorTaskProcessor = {
    start: () => {},
    stop: () => {},
    stopAndDrain: async () => {
      steps.push('monitorTask');
    },
    restart: () => {},
  };
  const marketDataClient: MarketDataClient = {
    getQuoteContext: async () => {
      throw new Error('cleanup test should not request quote context');
    },
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    subscribeCandlesticks: async () => [],
    getRealtimeCandlesticks: async () => [],
    getCandlestickSnapshot: () => null,
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    resetRuntimeSubscriptionsAndCaches: async () => {
      steps.push('resetMarketData');
    },
  };

  return {
    buyProcessor: {
      start: () => {},
      stop: () => {},
      stopAndDrain: async () => {
        steps.push('buy');
      },
      restart: () => {},
    },
    sellProcessor: {
      start: () => {},
      stop: () => {},
      stopAndDrain: async () => {
        steps.push('sell');
      },
      restart: () => {},
    },
    monitorTaskProcessor,
    orderMonitorWorker: {
      start: () => {},
      schedule: () => {},
      stopAndDrain: async () => {
        steps.push('orderMonitorWorker');
      },
    },
    postTradeRefresher: {
      start: () => {},
      enqueue: () => {},
      stopAndDrain: async () => {
        steps.push('postTradeRefresher');
      },
      clearPending: () => {},
    },
    marketDataClient,
    monitorContext: createStrategyRuntimeDouble(),
    lastState: createLastState(createStrategyState('HSI.HK')),
  };
}

/**
 * 构建 createCleanup 的入参，默认各步骤向 steps 数组 push 名称；可传 overrides 覆盖 monitorContext、lastState 或任意处理器。
 *
 * @param steps 记录执行步骤顺序的数组
 * @param overrides 对默认依赖的覆盖项
 * @returns 供 createCleanup 使用的 CleanupContext
 */
export function createCleanupDeps(
  steps: string[],
  overrides: Partial<CleanupContext> = {},
): CleanupContext {
  return { ...defaultDeps(steps), ...overrides };
}
