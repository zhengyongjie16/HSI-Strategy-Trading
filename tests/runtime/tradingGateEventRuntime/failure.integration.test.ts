/**
 * 交易门禁失败集成测试
 *
 * 验证真实 gate → 唯一 termination → time/autoSearch stop 链路：gate 失败阻断 autoAuth，
 * 同步撤销 SEARCHING owner，晚到候选不得激活；系统时间不得继续安排 timer 或 dirty 重入。
 */
import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createAutoSearch } from '../../../src/application/autoSearch/index.js';
import type { AutoSearchCandidate } from '../../../src/application/autoSearch/types.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';
import { createAutoSearchWakeupRuntime } from '../../../src/runtime/autoSearchWakeupRuntime/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSeatActivationDispatcher } from '../../../src/runtime/seatActivationDispatcher/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/runtime/timeWakeupEvaluationProgram/index.js';
import { createTimeWakeupRuntime } from '../../../src/runtime/timeWakeupRuntime/index.js';
import { createTradingGateEventRuntime } from '../../../src/runtime/tradingGateEventRuntime/index.js';
import type { AutoSearchAuthorizationChangedEvent } from '../../../src/types/timeControlPlane.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import {
  createDirectionalAutoSearchPolicy,
  createWarrantCandidate,
  getDefaultAutoSearchConfig,
} from '../../helpers/seatTestUtils.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayClearanceWorkflowDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

describe('trading gate failure integration', () => {
  it('gate 失败不发布 autoAuth，同步 stop SEARCHING owner，晚到候选不能激活且 time 不再 arm timer', async () => {
    let nowMs = Date.parse('2026-04-10T11:59:00.000+08:00');
    const now = () => new Date(nowMs);
    const monitorConfig = createMonitorConfigDouble({
      autoSearchConfig: getDefaultAutoSearchConfig(),
    });
    const symbolRegistry = createSymbolRegistry(monitorConfig);
    symbolRegistry.updateSeatState('LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 2,
      frozenTradingDayKey: null,
    });

    symbolRegistry.updateSeatState('SHORT', {
      symbol: 'BEAR.HK',
      status: 'ACTIVE',
      lastSwitchAt: null,
      lastSearchAt: null,
      lastSeatActivatedAt: nowMs,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    const states = createRuntimeStateFixtures({
      lifecycleState: { currentDayKey: '2026-04-10' },
      tradingCalendarState: {
        cachedTradingDayInfo: {
          dateKey: '2026-04-10',
          info: { isTradingDay: true, isHalfDay: false },
        },
      },
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>({
      logger: createLoggerDouble(),
      diagnostics: createDiagnosticObserverDouble(),
      clock: { now },
    });
    const stopProducers: Array<() => void> = [];
    const secondaryErrors: unknown[] = [];
    const termination = createTerminationRuntime({
      closeTradingGate: () => {
        states.lifecycleState.isTradingEnabled = false;
      },
      closeProducerAdmission: monitorTaskQueue.close,
      stopProducers,
      onSecondaryError: (error) => {
        secondaryErrors.push(error);
      },
    });
    const gate = createTradingGateEventRuntime({ termination });
    const finderStarted = Promise.withResolvers<null>();
    const candidate = Promise.withResolvers<AutoSearchCandidate | null>();
    const autoSearch = createAutoSearch({
      monitorSymbol: monitorConfig.monitorSymbol,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      symbolRegistry,
      candidateSearch: {
        resolveDistanceRange: () => createDirectionalAutoSearchPolicy('LONG').switchDistanceRange,
        findCandidate: async () => {
          finderStarted.resolve(null);
          return candidate.promise;
        },
      },
      logger: createLoggerDouble(),
    });
    const autoSearchRuntime = createAutoSearchWakeupRuntime({
      termination,
      symbolRegistry,
      autoSearch,
      autoSearchConfig: monitorConfig.autoSearchConfig,
      ...states,
      tradingGateEventRuntime: gate,
      doomsdayProtectionEnabled: false,
      now,
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: clearTimeout,
    });
    const activationDispatcher = createSeatActivationDispatcher({
      logger: createLoggerDouble(),
      termination,
      symbolRegistry,
      snapshot,
      monitorTaskQueue,
    });
    const monitorContext = createMonitorContextDouble({ config: monitorConfig, symbolRegistry });
    const tradingConfig = createTradingConfig({ monitor: monitorConfig });
    const authorizationEvents: AutoSearchAuthorizationChangedEvent[] = [];
    gate.onAutoSearchAuthorizationChanged((event) => {
      authorizationEvents.push(event);
    });
    let activatingTransitions = 0;
    const unsubscribeSeat = symbolRegistry.onSeatStateChanged((event) => {
      if (event.nextState.status === 'ACTIVATING') activatingTransitions += 1;
    });
    const timers = new Map<number, () => void>();
    let scheduledTimers = 0;
    let evaluations = 0;
    const timeRuntime = createTimeWakeupRuntime({
      termination,
      evaluate: () => {
        evaluations += 1;
        return timeWakeupEvaluationProgram({
          logger: createLoggerDouble(),
          marketDataClient: createMarketDataClientDouble(),
          ...createTradeRuntimeDouble(),
          ...states,
          snapshot,
          monitorContext,
          tradingConfig,
          tradingGateEventRuntime: gate,
          doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflowDouble(),
          dayLifecycleManager: { tick: async () => ({ nextRetryAtMs: null }) },
          now,
        });
      },
      now,
      scheduleTimer: (callback) => {
        const handle = ++scheduledTimers;
        timers.set(handle, callback);
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
      logger: createLoggerDouble(),
    });
    stopProducers.push(timeRuntime.stop, autoSearchRuntime.stop, activationDispatcher.stop);
    const gateError = new Error('gate listener failed');
    let microtaskObservedClosed = false;
    gate.onGateStateChanged(() => {
      queueMicrotask(() => {
        microtaskObservedClosed =
          termination.isTerminated() &&
          !states.lifecycleState.isTradingEnabled &&
          symbolRegistry.getSeatState('LONG').status === 'EMPTY';
      });
      throw gateError;
    });
    let laterListenerObservedStopped = false;
    gate.onGateStateChanged(() => {
      laterListenerObservedStopped =
        termination.isTerminated() && symbolRegistry.getSeatState('LONG').status === 'EMPTY';
    });

    try {
      activationDispatcher.start();
      autoSearchRuntime.start();
      await finderStarted.promise;
      const searchVersion = symbolRegistry.getSeatVersion('LONG');
      expect(symbolRegistry.getSeatState('LONG').status).toBe('SEARCHING');
      await timeRuntime.start();
      expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: true }]);
      expect(scheduledTimers).toBe(1);
      const noonTimer = timers.get(1);
      if (noonTimer === undefined) throw new Error('expected noon timer');

      nowMs = Date.parse('2026-04-10T12:00:00.000+08:00');
      timers.delete(1);
      noonTimer();
      await timeRuntime.start();

      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: gateError });
      expect(laterListenerObservedStopped).toBeTrue();
      expect(microtaskObservedClosed).toBeTrue();
      expect(symbolRegistry.getSeatVersion('LONG')).toBe(searchVersion + 1);
      expect(symbolRegistry.getSeatState('LONG')).toMatchObject({
        status: 'EMPTY',
        symbol: null,
        lastSearchAt: Date.parse('2026-04-10T11:59:00.000+08:00'),
        searchFailCountToday: 2,
      });
      // 第二次评估在 gate 失败处退出，不能依赖稍后的 autoAuth 关闭通知来清理 owner。
      expect(authorizationEvents).toEqual([{ previousAuthorized: null, nextAuthorized: true }]);
      candidate.resolve(createWarrantCandidate('STALE_BULL.HK'));
      await autoSearchRuntime.stopAndDrain();
      await timeRuntime.start();
      noonTimer();
      await Promise.resolve();
      expect(evaluations).toBe(2);
      expect(scheduledTimers).toBe(1);
      expect(timers.size).toBe(0);
      expect(activatingTransitions).toBe(0);
      expect(monitorTaskQueue.isEmpty()).toBeTrue();
      expect(secondaryErrors).toEqual([]);
    } finally {
      candidate.resolve(null);
      await timeRuntime.stopAndDrain();
      await autoSearchRuntime.stopAndDrain();
      activationDispatcher.stop();
      unsubscribeSeat();
    }
  });

  it('dirty 补评估中的 gate 失败原值进入 fatal，不再 dirty 重入或安排 timer', async () => {
    const stopProducers: Array<() => void> = [];
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers,
      onSecondaryError: () => {},
    });
    const gate = createTradingGateEventRuntime({ termination });
    const gateError = new Error('dirty gate listener failed');
    gate.onGateStateChanged(() => {
      throw gateError;
    });
    let evaluations = 0;
    let scheduledTimers = 0;
    const runtime = createTimeWakeupRuntime({
      termination,
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 2) {
          gate.emitGateStateChanged({ previousCanTrade: false, nextCanTrade: true });
        }

        return { plan: { hasWork: true, nextWakeupAtMs: 1_000 } };
      },
      now: () => new Date(1_000),
      scheduleTimer: () => ++scheduledTimers,
      clearTimer: () => {},
      logger: createLoggerDouble(),
    });
    stopProducers.push(runtime.stop);

    await runtime.start();
    await runtime.start();
    await runtime.stopAndDrain();
    expect(evaluations).toBe(2);
    expect(scheduledTimers).toBe(0);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: gateError });
  });
});
