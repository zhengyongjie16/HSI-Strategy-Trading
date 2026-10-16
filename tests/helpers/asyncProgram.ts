import type { RuntimeStateFixtures, RuntimeStateOverrides } from './types.js';

/**
 * asyncProgram 业务测试共用工具
 *
 * 供 sellProcessor、buyProcessor、monitorTaskProcessor 等测试使用。
 * 场景函数命名：run* / assert*；工厂用 create 前缀。
 */
import type { MonitorContextAssembly } from '../../src/app/context/types.js';
import type { AccountPositionSnapshotReader } from '../../src/types/accountPosition.js';
import { createSnapshotFixture } from './accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createAccountPositionSnapshotReaderDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createSymbolRegistryDouble,
} from './testDoubles.js';

/**
 * 将异步处理器上报的 fatal 错误重新抛出，使非 fatal 场景测试不会静默吞错。
 *
 * @param error fatal 错误
 * @returns 不返回，始终抛出输入错误
 */
export function rethrowFatalError(error: unknown): never {
  throw error;
}

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
 * 启动处理器、推送任务、等待条件满足后 stopAndDrain。用于测试异步队列消费流程。
 *
 * @param params.processor 处理器实例（start、stopAndDrain）
 * @param params.pushTask 推送任务的函数
 * @param params.waitCondition 满足即认为任务已处理的条件
 * @param params.timeoutMs 可选超时毫秒数，默认 800
 * @returns 无返回值，超时由 waitUntil 抛错
 */
export async function runProcessorFlow(params: {
  readonly processor: { start: () => void; stopAndDrain: () => Promise<void> };
  readonly pushTask: () => void;
  readonly waitCondition: () => boolean;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { processor, pushTask, waitCondition, timeoutMs = 800 } = params;
  processor.start();
  pushTask();
  await waitUntil(waitCondition, timeoutMs);
  await processor.stopAndDrain();
}

/**
 * 构造 RuntimeStateFixtures 测试数据。默认行为：未传字段使用可交易、非半日市等默认值。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 RuntimeStateFixtures
 */
export function createRuntimeStates(overrides: RuntimeStateOverrides = {}): RuntimeStateFixtures {
  return {
    tradingTimeState: {
      canTrade: true,
      isHalfDay: false,
      openProtectionActive: false,
      ...overrides.tradingTimeState,
    },
    lifecycleState: {
      currentDayKey: '2026-02-16',
      lifecycleState: 'ACTIVE',
      pendingOpenRebuild: false,
      isTradingEnabled: true,
      ...overrides.lifecycleState,
    },
    tradingCalendarState: {
      cachedTradingDayInfo: null,
      tradingCalendarSnapshot: new Map(),
      ...overrides.tradingCalendarState,
    },
    quoteSubscriptionState: { allTradingSymbols: new Set(), ...overrides.quoteSubscriptionState },
  };
}

/**
 * 组装 MonitorContextAssembly 的公共基线字段，并合并调用方覆盖项。
 *
 * @param options 基线行情与状态选项
 * @param overrides 额外覆盖字段
 * @returns 合并后的 MonitorContextAssembly
 */
function buildMonitorContextBase(
  options: Readonly<{
    monitorSymbolName: string;
  }>,
  overrides: Partial<MonitorContextAssembly>,
): MonitorContextAssembly {
  const { monitorSymbolName } = options;
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: 12_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: 13_000,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 2,
    shortVersion: 3,
  });

  return createMonitorContextDouble({
    symbolRegistry,
    monitorSymbolName,
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    ...overrides,
  });
}

/**
 * 构造带默认行情与席位的 MonitorContextAssembly，供 buyProcessor/sellProcessor 测试使用。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 MonitorContextAssembly
 */
export function createMonitorContext(
  overrides: Partial<MonitorContextAssembly> = {},
): MonitorContextAssembly {
  return buildMonitorContextBase(
    {
      monitorSymbolName: 'HSI.HK',
    },
    overrides,
  );
}

/**
 * 用真实 H owner 发布 BULL.HK/BEAR.HK 成对事实，并只暴露显式只读能力。
 * RuntimeStateFixtures 不承载金融事实；该初始化 receipt 也不签 settlement ready。
 *
 * @returns 真实已初始化事实的 reader，不提供 update、refresh 或默认 current 判定
 */
export async function createSnapshotWithPositionsFixture(): Promise<AccountPositionSnapshotReader> {
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
      createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
    ],
  });
  const reader = createAccountPositionSnapshotReaderDouble({
    getView: snapshot.getView,
    isCurrent: snapshot.isCurrent,
  });
  return {
    ...reader,
    getAvailablePosition: snapshot.getAvailablePosition,
    getStatus: snapshot.getStatus,
  };
}
