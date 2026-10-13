import { createSnapshotFixture } from '../../../main/fixtures/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../../main/fixtures/settlementRuntime.js';

/**
 * monitorRecovery 集成测试
 *
 * 功能：
 * - 使用真实 MonitorTaskProcessor 与真实 PeriodicSwitchWakeupRuntime 验证午休门禁恢复链路
 * - 覆盖 waiting-empty 占用在午休 blocked 结果回写后解除，门禁恢复时 route 能重新 plan
 */
import { describe, expect, it } from 'bun:test';
import { createMonitorTaskRuntimeFixture as createMonitorTaskProcessor } from './fixtures.js';
import { createMonitorTaskQueue } from '../../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../../../../src/runtime/periodicSwitchWakeupRuntime/index.js';
import { createTradingGateEventRuntime } from '../../../../src/main/tradingGateEventRuntime/index.js';
import type { MonitorTaskDataMap } from '../../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { PeriodicSwitchWakeupRuntime } from '../../../../src/runtime/periodicSwitchWakeupRuntime/types.js';
import {
  createSeatSwitchWorkflowDouble,
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createQuoteSubscriptionRuntimeDouble,
  createSymbolRegistryDouble,
  createTerminationDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';
import { createMonitorContext, waitUntil } from '../../../main/asyncProgram/utils.js';

const READY_MS = Date.parse('2026-02-16T01:30:00.000Z');

/**
 * 构造带真实周期换标 runtime 的午休恢复集成装置。
 * 观察 wrapper 只记录经过 processor 的 mark/replan 调用，行为仍委托真实 runtime。
 */
async function createLunchBreakHarness(): Promise<
  Readonly<{
    readonly monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
    readonly processor: ReturnType<typeof createMonitorTaskProcessor>;
    readonly periodicRuntime: PeriodicSwitchWakeupRuntime;
    readonly runtimeRecords: Array<string>;
    readonly evaluationCalls: Array<number>;
    readonly fatalErrors: Array<unknown>;
    readonly symbolRegistry: ReturnType<typeof createSymbolRegistryDouble>;
    readonly setCanTradeNow: (value: boolean) => void;
    readonly setPeriodicPending: (value: boolean) => void;
    readonly emitFreshReached: () => Promise<void>;
    readonly stopSettlement: () => Promise<void>;
    readonly emitGateOpened: () => void;
  }>
> {
  let nowMs = READY_MS + 120_000;
  let canTradeNow = true;
  let periodicPending = true;
  const evaluationCalls: Array<number> = [];
  const runtimeRecords: Array<string> = [];
  const fatalErrors: Array<unknown> = [];

  const monitorConfig = createMonitorConfigDouble({
    monitorSymbol: 'HSI.HK',
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinDistancePctBull: '0.35',
      autoSearchMinDistancePctBear: '-0.35',
      autoSearchMinTurnoverPerMinuteBull: '100000',
      autoSearchMinTurnoverPerMinuteBear: '100000',
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: 1,
      switchDistanceRangeBull: { min: '0.2', max: '1.5' },
      switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
    },
  });
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'OLD_BULL.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: READY_MS,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    shortSeat: {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
    longVersion: 1,
    shortVersion: 1,
  });
  const seatSwitch = createSeatSwitchWorkflowDouble({
    evaluatePeriodicSwitchDue: async (params) => {
      evaluationCalls.push(params.currentTime.getTime());
      return { kind: 'NOOP' };
    },
    getPeriodicSwitchPendingState: () => ({ pending: periodicPending }),
  });
  const monitorContext = createMonitorContext({
    config: monitorConfig,
    symbolRegistry,
    seatSwitch,
  });
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
  const tradingGateEventRuntime = createTradingGateEventRuntime({ logger: createLoggerDouble() });
  const trader = createTraderDouble();

  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const termination = createTerminationDouble({
    reportFatalError: (error) => {
      fatalErrors.push(error);
    },
  });
  const settlement = createSettlementRuntimeFixture({
    snapshot,
    monitorContext,
    termination,
    getTrader: () => trader,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('Unexpected stale commit');
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
  });
  settlement.start();
  expect(await settlement.completeRebuildBaseline()).toBeTrue();
  const originalReceipt = await settlement.waitForFresh();
  expect(originalReceipt.snapshotToken).toBe(snapshot.getView().token);

  const realPeriodicRuntime = createPeriodicSwitchWakeupRuntime({
    termination,
    snapshot,
    getCanTradeNow: () => canTradeNow,
    monitorContext,
    symbolRegistry,
    monitorTaskQueue,
    trader,
    postTradeConsistencyRuntime: settlement,
    tradingGateEventRuntime,
    calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
      startMs + switchIntervalMinutes * 60_000,
    now: () => new Date(nowMs),
    scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
  });
  const periodicRuntime: PeriodicSwitchWakeupRuntime = {
    ...realPeriodicRuntime,
    markWaitingEmpty: (baseline) => {
      runtimeRecords.push('mark');
      realPeriodicRuntime.markWaitingEmpty(baseline);
    },
    replanRouteAfterTask: (params) => {
      runtimeRecords.push(`replan:${params.status}`);
      realPeriodicRuntime.replanRouteAfterTask(params);
    },
  };

  const processor = createMonitorTaskProcessor({
    clock: { now: () => new Date(nowMs) },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
    monitorTaskQueue,
    monitorContext,
    trader,
    marketDataClient: createMarketDataClientDouble(),
    quoteSubscriptionRuntime: createQuoteSubscriptionRuntimeDouble(),
    switchWakeupRuntime: { handoffPendingSwitch: () => {} },
    periodicSwitchWakeupRuntime: periodicRuntime,
    getCanTradeNow: () => canTradeNow,
    termination,
    snapshot,
  });

  return {
    monitorTaskQueue,
    processor,
    periodicRuntime,
    runtimeRecords,
    evaluationCalls,
    fatalErrors,
    symbolRegistry,
    setCanTradeNow: (value) => {
      canTradeNow = value;
    },
    setPeriodicPending: (value) => {
      periodicPending = value;
    },
    emitFreshReached: async () => {
      settlement.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      await settlement.waitForFresh();
    },
    stopSettlement: settlement.stopAndDrain,
    emitGateOpened: () => {
      nowMs += 120_000;
      tradingGateEventRuntime.emitGateStateChanged({
        previousCanTrade: false,
        nextCanTrade: true,
      });
    },
  };
}

describe('monitor recovery integration', () => {
  it('午休 blocked 结果解除 waiting-empty 占用后，门禁恢复能重新推进周期换标', async () => {
    const harness = await createLunchBreakHarness();
    harness.processor.start();
    harness.periodicRuntime.start();

    try {
      // 1) 首个 due tick：周期换标 pending，route 进入 waiting-empty。
      await waitUntil(() => harness.runtimeRecords.includes('mark'));
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
      });

      // 2) 午休：门禁关闭；pending 已解除，订单变化重派发 waiting-empty route。
      await harness.processor.stopAndDrain();
      harness.setPeriodicPending(false);
      await harness.emitFreshReached();
      await waitUntil(() => !harness.monitorTaskQueue.isEmpty());
      harness.setCanTradeNow(false);
      harness.processor.start();
      await waitUntil(() => harness.runtimeRecords.includes('replan:blocked'));

      // blocked 结果已交回 runtime：waiting-empty 占用解除，但仍在午休不推进实际换标。
      expect(harness.evaluationCalls).toHaveLength(1);
      expect(harness.fatalErrors).toEqual([]);

      // 3) 午休结束：门禁恢复事件应重新 plan route 并再次触发 due 检查。
      harness.setCanTradeNow(true);
      harness.emitGateOpened();
      await waitUntil(() => harness.evaluationCalls.length === 2);

      expect(harness.runtimeRecords).toEqual([
        'mark',
        'replan:processed',
        'replan:blocked',
        'replan:processed',
      ]);
      expect(harness.fatalErrors).toEqual([]);
      expect(harness.symbolRegistry.getSeatState('LONG')).toMatchObject({
        symbol: 'OLD_BULL.HK',
        status: 'ACTIVE',
      });
      expect(harness.symbolRegistry.getSeatVersion('LONG')).toBe(1);
    } finally {
      await harness.processor.stopAndDrain();
      await harness.periodicRuntime.stopAndDrain();
      await harness.stopSettlement();
    }
  });

  it('门禁关闭期间的 blocked 回写不绕过门禁执行实际换标检查', async () => {
    const harness = await createLunchBreakHarness();
    harness.processor.start();
    harness.periodicRuntime.start();

    try {
      await waitUntil(() => harness.runtimeRecords.includes('mark'));

      await harness.processor.stopAndDrain();
      harness.setPeriodicPending(false);
      await harness.emitFreshReached();
      await waitUntil(() => !harness.monitorTaskQueue.isEmpty());
      harness.setCanTradeNow(false);
      harness.processor.start();
      await waitUntil(() => harness.runtimeRecords.includes('replan:blocked'));

      // 午休中再次触发订单变化：waiting-empty 已解除，不得派发新 tick 或执行策略评估。
      await harness.emitFreshReached();
      await Bun.sleep(50);

      expect(harness.evaluationCalls).toHaveLength(1);
      expect(harness.runtimeRecords).toEqual(['mark', 'replan:processed', 'replan:blocked']);
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      await harness.processor.stopAndDrain();
      await harness.periodicRuntime.stopAndDrain();
      await harness.stopSettlement();
    }
  });
});
