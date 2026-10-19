import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createRiskCheckerDouble,
  createTradeRuntimeDouble,
  createTerminationDouble,
} from '../../helpers/testDoubles.js';

/**
 * 周期换标真实任务回调测试。
 * 从生产 periodic runtime 获取原 epoch/receipt/baseline 任务，再消费真实 workflow，覆盖发布 WAIT 后关门与失效结果丢弃。
 */
import { describe, expect, it } from 'bun:test';
import { createSeatSwitchWorkflow } from '../../../src/application/seatSwitch/index.js';
import { createPeriodicSwitchTaskHandler } from '../../../src/application/seatSwitch/periodicSwitchTask.js';
import { createPeriodicSwitchWakeupRuntime } from '../../../src/runtime/periodicSwitchWakeupRuntime/index.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createMonitorTaskProcessor } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/index.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { TRADING } from '../../../src/constants/index.js';

import { createLoggerStub, getDefaultAutoSearchConfig } from '../../helpers/seatTestUtils.js';
import type { MonitorTaskInput } from '../../../src/runtime/asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import type { SwitchWakeupHandoffParams } from '../../../src/runtime/monitorQuoteEventRuntime/types.js';
import type { OrderStateChangedEvent } from '../../../src/types/orderTracking.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';

const nowMs = Date.parse('2026-02-16T10:00:00+08:00');

/** fixture 不制造 WAIT/receipt：让生产周期 owner 派发唯一到期任务。 */
async function createHarness(
  findCandidate: () => Promise<Readonly<{ symbol: string; callPrice: string }> | null>,
  waitingEmpty = false,
) {
  let canTrade = true;
  let currentNowMs = nowMs;
  let workflowCalls = 0;
  const holdSymbols = new Set(waitingEmpty ? ['OLD.HK'] : []);
  const orderListeners = new Set<(event: OrderStateChangedEvent) => void>();
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: { ...getDefaultAutoSearchConfig(), switchIntervalMinutes: 1 },
  });
  const symbolRegistry = createSymbolRegistryDouble({
    longSeat: {
      symbol: 'OLD.HK',
      status: 'ACTIVE',
      lastSeatActivatedAt: nowMs - 120_000,
      lastSwitchAt: null,
      lastSearchAt: null,
      callPrice: '20000',
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    },
  });
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions: [],
  });
  const handoffs: SwitchWakeupHandoffParams[] = [];
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
    logger: createLoggerDouble(),
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
  });
  const tasks: Array<MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'>> = [];
  const timers: Array<{
    handle: ReturnType<typeof setTimeout>;
    delayMs: number;
    callback: () => void;
  }> = [];
  const termination = createTerminationDouble({
    reportFatalError: (error) => {
      throw error;
    },
  });
  const tradeRuntime = createTradeRuntimeDouble({
    orderHoldRegistry: { getHoldSymbols: () => holdSymbols },
    orderMonitor: {
      onOrderStateChanged: (listener) => {
        orderListeners.add(listener);
        return () => {
          orderListeners.delete(listener);
        };
      },
    },
    orderExecutor: {
      executeSignals: async () => {
        throw new Error('周期首次发布不得执行交易');
      },
    },
  });
  const seatSwitch = createSeatSwitchWorkflow({
    readSwitchPositions: async () => [],
    monitorConfig,
    symbolRegistry,
    cacheManager: tradeRuntime.cacheManager,
    orderHoldRegistry: tradeRuntime.orderHoldRegistry,
    orderMonitor: tradeRuntime.orderMonitor,
    orderExecutor: tradeRuntime.orderExecutor,
    marketDataClient: createMarketDataClientDouble(),
    orderRecorder: createOrderRecorderDouble(),
    riskChecker: createRiskCheckerDouble(),
    candidateSearch: { resolveDistanceRange: () => ({ min: '0.2', max: '1.5' }), findCandidate },
    clock: { now: () => new Date(currentNowMs) },
    logger: createLoggerStub(),
    getTradingCalendarSnapshot: () =>
      new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
  });
  const monitorContext: MonitorContextAssembly = {
    ...createMonitorContextDouble({
      orderRecorder: tradeRuntime.orderRecorder,
      config: monitorConfig,
      symbolRegistry,
    }),
    seatSwitch: {
      ...seatSwitch,
      evaluatePeriodicSwitchDue: async (params) => {
        workflowCalls += 1;
        return seatSwitch.evaluatePeriodicSwitchDue(params);
      },
    },
  };
  const settlement = createSettlementRuntimeFixture({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    monitorContext,
    termination,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('stale settlement token');
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
  const dispatched = Promise.withResolvers<null>();
  const runtime = createPeriodicSwitchWakeupRuntime({
    monitorContext,
    symbolRegistry,
    snapshot,
    orderMonitor: tradeRuntime.orderMonitor,
    termination,
    getCanTradeNow: () => canTrade,
    postTradeConsistencyRuntime: settlement,
    tradingGateEventRuntime: { onGateStateChanged: () => () => {} },
    monitorTaskQueue: {
      scheduleLatest: (task) => {
        if (task.type !== 'AUTO_SYMBOL_TICK') throw new Error('unexpected task type');

        tasks.push(task);
        dispatched.resolve(null);
        return monitorTaskQueue.scheduleLatest(task);
      },
    },
    now: () => new Date(currentNowMs),
    calculateDueAtMs: () => nowMs,
    scheduleTimer: (callback, delayMs) => {
      const handle = setTimeout(() => {}, 2_147_483_647);
      timers.push({ handle, callback, delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      clearTimeout(handle);
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index !== -1) timers.splice(index, 1);
    },
  });
  runtime.start();
  await dispatched.promise;
  const task = tasks[0];
  if (task === undefined) throw new Error('production due task required');

  const handler = createPeriodicSwitchTaskHandler({
    monitorContext,
    snapshot,
    periodicSwitchWakeupRuntime: runtime,
    switchWakeupRuntime: {
      handoffPendingSwitch: (params) => {
        handoffs.push(params);
      },
    },
    getCanTradeNow: () => canTrade,
    now: () => new Date(currentNowMs),
    logger: createLoggerStub(),
  });
  const processor = createMonitorTaskProcessor({
    monitorTaskQueue,
    ...handler,
    seatActivation: {
      activate: async () => {
        throw new Error('periodic regression does not activate seats');
      },
      isCurrent: () => false,
    },
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    },
    logger: createLoggerStub(),
    termination,
  });
  return {
    task,
    handler,
    startProcessor: processor.start,
    handoffs,
    symbolRegistry,
    timers,
    tasks,
    getWorkflowCalls: () => workflowCalls,
    releaseHolding: () => {
      holdSymbols.clear();
    },
    emitOrder: () => {
      for (const listener of orderListeners)
        listener({
          orderId: 'OLD-SELL',
          symbol: 'OLD.HK',
          side: 'SELL',
          status: 'FILLED',
          monitorSymbol: 'HSI.HK',
          isLongSymbol: true,
          isProtectiveLiquidation: false,
          executedPrice: '1',
          executedQuantity: 100,
          executedTimeMs: currentNowMs,
        });
    },
    emitFresh: async () => {
      settlement.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
      await settlement.waitForFresh();
    },
    advanceTo: (atMs: number) => {
      currentNowMs = atMs;
    },
    fireTimer: () => {
      const timer = timers.shift();
      if (timer === undefined) throw new Error('expected one production timer');

      clearTimeout(timer.handle);
      timer.callback();
    },
    closeGate: () => {
      canTrade = false;
    },
    stop: async () => {
      await processor.stopAndDrain();
      await runtime.stopAndDrain();
      await settlement.stopAndDrain();
    },
  };
}

describe('periodic switch task use case', () => {
  it('waiting-empty 查询 A 挂起时 order/fresh 只合并需求，A 外部失败后到期前只执行一次并保留单 timer', async () => {
    const entered = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const failure = await createExternalApiRequestError({
      operation: 'candidate',
      attempts: 1,
      cause: new Error('read failed'),
    });
    let queryCalls = 0;
    const h = await createHarness(async () => {
      queryCalls += 1;
      if (queryCalls === 1) {
        entered.resolve(null);
        await release.promise;
        throw failure;
      }

      return null;
    }, true);
    try {
      h.startProcessor();
      await Bun.sleep(0);
      expect(h.getWorkflowCalls()).toBe(1);
      h.releaseHolding();
      h.emitOrder();
      await entered.promise;
      const a = h.tasks[1];
      if (a === undefined) throw new Error('waiting-empty event must dispatch real task A');

      h.emitOrder();
      await Bun.sleep(0);
      expect(a.data.canContinue()).toBeTrue();
      expect(h.tasks).toHaveLength(2);
      await h.emitFresh();
      expect(h.tasks).toHaveLength(2);
      expect(h.getWorkflowCalls()).toBe(2); // 初始化空仓等待一次，A 的业务查询一次。
      release.resolve(null);
      await Bun.sleep(0);
      expect(h.timers.map((timer) => timer.delayMs)).toEqual([TRADING.INTERVAL_MS]);
      expect(a.data.canContinue()).toBeFalse();

      h.advanceTo(nowMs + TRADING.INTERVAL_MS - 1);
      h.emitOrder();
      await h.emitFresh();
      // 迟到的已排原任务不能利用新 receipt 或越过失败延迟边界。
      expect(await h.handler.handlePeriodicSwitchTask(a, () => true)).toBe('blocked');
      h.handler.onPeriodicSwitchTaskResult(a, 'blocked', () => true);
      expect(h.getWorkflowCalls()).toBe(2);
      expect(queryCalls).toBe(1);
      expect(h.tasks).toHaveLength(2);
      expect(h.timers).toHaveLength(1);

      h.advanceTo(nowMs + TRADING.INTERVAL_MS);
      h.fireTimer();
      await Bun.sleep(0);
      expect(h.getWorkflowCalls()).toBe(3);
      expect(queryCalls).toBe(2);
      expect(h.tasks).toHaveLength(3);
      expect(h.timers).toHaveLength(0);
    } finally {
      release.resolve(null);
      await h.stop();
    }
  });

  it('首次 WAIT 提交后连续时段关门，仍向 switch owner 交真实原 epoch route，不执行回补', async () => {
    const h = await createHarness(async () => ({ symbol: 'NEXT.HK', callPrice: '21000' }));
    h.symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'SWITCHING') h.closeGate();
    });

    try {
      const status = await h.handler.handlePeriodicSwitchTask(h.task, () => true);
      expect(status).toBe('processed');
      expect(h.handoffs).toHaveLength(1);
      expect(h.handoffs[0]?.originalDayEpoch).toBe(h.task.data.dayEpoch);
      expect(h.handoffs[0]?.driveResult.publishedRoute?.isCurrent()).toBeTrue();
      expect(h.symbolRegistry.getSeatState('LONG').status).toBe('SWITCHING');
    } finally {
      await h.stop();
    }
  });

  it('WAIT 发布期间席位身份被后继替换，不把旧结果借新版本挂到 switch owner', async () => {
    const h = await createHarness(async () => ({ symbol: 'NEXT.HK', callPrice: '21000' }));
    h.symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status !== 'SWITCHING') return;

      h.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
        ...event.nextState,
        symbol: 'SUCCESSOR.HK',
        status: 'ACTIVE',
        lastSeatActivatedAt: nowMs,
      });
    });

    try {
      expect(await h.handler.handlePeriodicSwitchTask(h.task, () => true)).toBe('skipped');
      expect(h.handoffs).toHaveLength(0);
      expect(h.symbolRegistry.getSeatState('LONG').symbol).toBe('SUCCESSOR.HK');
    } finally {
      await h.stop();
    }
  });

  it('明确外部失败由 application 下发一次未来重评估，关门不改为立即重派', async () => {
    const h = await createHarness(async () => {
      throw await createExternalApiRequestError({
        operation: 'candidate',
        attempts: 1,
        cause: new Error('read failed'),
      });
    });
    try {
      const task = h.task;
      const status = await h.handler.handlePeriodicSwitchTask(task, () => true);
      expect(status).toBe('failed');
      h.closeGate();
      h.handler.onPeriodicSwitchTaskResult(task, status, () => true);
      h.handler.onPeriodicSwitchTaskResult(task, status, () => true);
      expect(h.timers.map((timer) => timer.delayMs)).toEqual([TRADING.INTERVAL_MS]);
      expect(h.handoffs).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });
});
