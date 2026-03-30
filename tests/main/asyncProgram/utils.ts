/**
 * asyncProgram 业务测试共用工具
 *
 * 供 sellProcessor、buyProcessor、monitorTaskProcessor 等测试使用。
 * 场景函数命名：run* / assert*；工厂用 create 前缀。
 */
import type { LastState, StrategyRuntime } from '../../../src/types/state.js';
import {
  createStrategyRuntimeConfigDouble,
  createIndicatorDisplayProfileDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/**
 * 轮询直到条件为 true 或超时。默认行为：超时抛错。
 *
 * @param predicate 条件函数
 * @param timeoutMs 超时毫秒数
 * @returns 无返回值，超时抛出 Error
 */
export async function waitUntil(predicate: () => boolean, timeoutMs: number = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }

    await Bun.sleep(10);
  }
}

/**
 * runProcessorFlow 入参。
 * 类型用途：测试中启动处理器、推送任务、等待条件并排空的参数聚合。
 * 使用范围：仅 tests/main/asyncProgram 使用。
 */
type RunProcessorFlowParams = {
  readonly processor: { start: () => void; stopAndDrain: () => Promise<void> };
  readonly pushTask: () => void;
  readonly waitCondition: () => boolean;
  readonly timeoutMs?: number;
};

/**
 * 启动处理器、推送任务、等待条件满足后 stopAndDrain。用于测试异步队列消费流程。
 *
 * @param params.processor 处理器实例（start、stopAndDrain）
 * @param params.pushTask 推送任务的函数
 * @param params.waitCondition 满足即认为任务已处理的条件
 * @param params.timeoutMs 可选超时毫秒数，默认 800
 * @returns 无返回值，超时由 waitUntil 抛错
 */
export async function runProcessorFlow(params: RunProcessorFlowParams): Promise<void> {
  const { processor, pushTask, waitCondition, timeoutMs = 800 } = params;
  processor.start();
  pushTask();
  await waitUntil(waitCondition, timeoutMs);
  await processor.stopAndDrain();
}

/**
 * 构造 LastState 测试数据。默认行为：未传字段使用可交易、非半日市等默认值。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 LastState
 */
export function createLastState(overrides: Partial<LastState> = {}): LastState {
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
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorState: {
      baseInstrumentSymbol: 'HSI.HK',
      monitorPrice: null,
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      lastCandlestickCacheVersion: null,
    },
    allTradingSymbols: new Set(),
    ...overrides,
  };
}

type StrategyRuntimeBaseOptions = Readonly<{
  state: StrategyRuntime['state'];
  baseInstrumentName: string;
}>;

/**
 * 组装 StrategyRuntime 的公共基线字段，并合并调用方覆盖项。
 *
 * @param options 基线行情与状态选项
 * @param overrides 额外覆盖字段
 * @returns 合并后的 StrategyRuntime
 */
function buildStrategyRuntimeBase(
  options: StrategyRuntimeBaseOptions,
  overrides: Partial<StrategyRuntime>,
): StrategyRuntime {
  const { state, baseInstrumentName } = options;
  const symbolRegistry = createSymbolRegistryDouble({
    baseInstrumentSymbol: 'HSI.HK',
    longVersion: 2,
    shortVersion: 3,
  });
  return {
    config: createStrategyRuntimeConfigDouble(),
    state,
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState('LONG'),
      short: symbolRegistry.getSeatState('SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion('LONG'),
      short: symbolRegistry.getSeatVersion('SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnInterval: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateSignals: () => [],
    },
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    baseInstrumentName,
    normalizedBaseInstrumentSymbol: 'HSI.HK',
    indicatorProfile: createIndicatorDisplayProfileDouble(),
    ...overrides,
  } as unknown as StrategyRuntime;
}

/**
 * 构造带默认行情与席位的 StrategyRuntime，供 buyProcessor/sellProcessor 测试使用。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 StrategyRuntime
 */
export function createStrategyRuntime(overrides: Partial<StrategyRuntime> = {}): StrategyRuntime {
  return buildStrategyRuntimeBase(
    {
      state: {
        baseInstrumentSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        longPrice: 1.1,
        shortPrice: 0.9,
        signal: null,
        pendingSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: null,
        lastCandlestickCacheVersion: null,
      },
      baseInstrumentName: 'HSI.HK',
    },
    overrides,
  );
}

/**
 * 构造带 BULL.HK/BEAR.HK 持仓的 LastState，供卖出流程等测试使用。
 *
 * @returns 含 positionCache 与 cachedPositions 的 LastState
 */
export function createLastStateWithPositions(): LastState {
  const positions = [
    createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
  ];
  return createLastState({
    cachedPositions: positions,
    positionCache: createPositionCacheDouble(positions),
  });
}

/**
 * 构造无行情、无席位的 StrategyRuntime，供 monitorTaskProcessor 等测试使用。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于监控任务测试的 StrategyRuntime
 */
export function createMonitorTaskContext(
  overrides: Partial<StrategyRuntime> = {},
): StrategyRuntime {
  return buildStrategyRuntimeBase(
    {
      state: {
        baseInstrumentSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: null,
        lastCandlestickCacheVersion: null,
      },
      baseInstrumentName: 'HSI',
    },
    overrides,
  );
}
