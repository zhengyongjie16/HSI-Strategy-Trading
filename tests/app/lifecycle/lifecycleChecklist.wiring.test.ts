/**
 * 生命周期清单接线验证。
 * 从实际 factory 取得 cleanup phase/创建资源，从真实日切域取得 trace；不另抄一份执行清单。
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LIFECYCLE_CHECKLIST } from '../../../src/app/lifecycle/lifecycleChecklist.js';
import { validateLifecycleChecklist } from '../../../src/app/lifecycle/lifecycleChecklistValidation.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import { createSelectedStrategy } from '../../../src/app/startup/createSelectedStrategy.js';
import { createAsyncRuntime } from '../../../src/app/runtime/createAsyncRuntime.js';
import { createSignalRuntimeDomain } from '../../../src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { createMarketDataDomain } from '../../../src/runtime/lifecycle/cacheDomains/marketDataDomain.js';
import { createGlobalStateDomain } from '../../../src/runtime/lifecycle/cacheDomains/globalStateDomain.js';
import { createDayLifecycleManager } from '../../../src/runtime/lifecycle/dayLifecycleManager.js';
import { createTimeWakeupRuntime } from '../../../src/runtime/timeWakeupRuntime/index.js';
import { timeWakeupEvaluationProgram } from '../../../src/runtime/timeWakeupEvaluationProgram/index.js';
import { createTradingGateEventRuntime } from '../../../src/runtime/tradingGateEventRuntime/index.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { executeTradingDayOpenRebuild } from '../../../src/application/tradingDayRebuild/openRebuild.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/runtime/asyncProgram/monitorTaskQueue/index.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createRuntimeStates } from '../shutdown/utils.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayClearanceWorkflowDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createQuoteSubscriptionRuntimeDouble,
  createStrategyDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import type { RuntimeAssemblyResources } from '../../../src/app/types.js';
import type { CleanupPhase } from '../../../src/types/cleanup.js';
import type { LifecycleChecklistObservation } from '../../../src/app/lifecycle/types.js';
import type { MonitorTaskDataMap } from '../../../src/runtime/asyncProgram/monitorTaskProcessor/types.js';

/** 仅读取指定接线文件的 AST；不建 symbol graph，也不执行源码。 */
function sourceNodes(file: string): ReadonlyArray<ts.Node> {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../../../src/${file}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node): void {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return nodes;
}

/** 保留真实 disposer 的资源名.动作名；仅显式对应现有闭包和已发出的 drain，不建立 symbol graph。 */
function cleanupOperation(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) {
    switch (node.text) {
      case 'closeSnapshotAdmission': {
        return 'snapshot.closeSnapshotAdmission';
      }

      case 'unsubscribeOrderTradeAudit': {
        return 'orderTradeAuditListener.unsubscribeOrderTradeAudit';
      }

      case 'unsubscribeShutdown': {
        return 'shutdownSignal.unsubscribeShutdown';
      }

      default: {
        return undefined;
      }
    }
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.right.kind === ts.SyntaxKind.FalseKeyword &&
    node.left.getText().endsWith('lifecycleState.isTradingEnabled')
  )
    return 'lifecycleState.isTradingEnabled=false';

  if (
    ts.isAwaitExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'snapshotDrain'
  )
    return 'snapshot.await snapshotDrain';

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (node.expression.getText() === 'destroy.call' && node.arguments[0]?.getText() === 'value')
      return 'strategy.destroy';

    return node.expression.getText().replace('tradeRuntime.orderMonitor.', 'orderMonitor.');
  }

  return ts.forEachChild(node, cleanupOperation);
}

/** 测试记录器只包裹对象上实际存在的方法，不给资源补造 start/stop/drain。 */
function recorded<T extends object>(resource: string, port: T, trace: string[]): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        const operation = String(property);
        if (
          /^(start|restart|stop|abort|reset|invalidate|destroy|clearAll|close|midnightClear|completeRebuildBaseline|waitForFresh|reconcileFromCurrentTruth|requestClear|beginRebuild|openAdmission)/.test(
            operation,
          )
        ) {
          trace.push(`${resource}.${operation}`);
        }

        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}

/** 只归一化 composition root 的固定容器前缀，保留真实资源和方法名称。 */
function rootOperation(node: ts.Node): string | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.right.kind === ts.SyntaxKind.FalseKeyword &&
    node.left.getText().endsWith('lifecycleState.isTradingEnabled')
  )
    return 'lifecycleState.isTradingEnabled=false';

  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
    return undefined;

  const expression = node.expression
    .getText()
    .replaceAll('?', '')
    .replace(/^(resources|postGateRuntime|asyncRuntime|params)\./, '');
  return expression === 'closeSnapshotAdmission' ? 'snapshot.closeSnapshotAdmission' : expression;
}

/** 真实 manager + 三个具名域，外部事实使用既有真实 H/S fixture，不复制生命周期实现。 */
async function dayHarness() {
  const trace: string[] = [];
  const logger = createLoggerDouble();
  const cleanup = createCleanup();
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const strategy = createSelectedStrategy(
    {
      strategyId: 'test-strategy',
      prepared: { create: () => recorded('strategy', createStrategyDouble(), trace) },
    },
    {
      clock: { now: () => new Date('2026-05-01T00:00:00+08:00') },
      scheduler: {
        scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: clearTimeout,
      },
      logger,
      onFatalError: termination.reportFatalError,
    },
    cleanup,
  );
  const monitorContext = createMonitorContextDouble({ strategy });
  const snapshot = recorded(
    'snapshot',
    await createSnapshotFixture({ account: createAccountSnapshotDouble('100000'), positions: [] }),
    trace,
  );
  const instances = createTradeRuntimeDouble();
  const tradeRuntime = {
    ...instances,
    orderMonitor: recorded('orderMonitor', instances.orderMonitor, trace),
  };
  const marketDataClient = recorded('marketDataClient', createMarketDataClientDouble(), trace);
  const settlement = createSettlementRuntimeFixture({
    logger: createLoggerDouble(),
    snapshot,
    monitorContext,
    termination,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: async () => {},
    scheduler: {
      scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: clearTimeout,
    },
  });
  const postTradeConsistencyRuntime = recorded('postTradeConsistencyRuntime', settlement, trace);
  const quoteSubscriptionRuntime = recorded(
    'quoteSubscriptionRuntime',
    createQuoteSubscriptionRuntimeDouble(),
    trace,
  );
  const owner = {
    start: () => {},
    stop: () => {},
    stopAndDrain: async () => {},
    restart: () => {},
  };
  const signalDomain = createSignalRuntimeDomain({
    termination,
    logger,
    monitorContext,
    businessEventProgram: recorded('businessEventProgram', owner, trace),
    tradingRiskEventRuntime: recorded('tradingRiskEventRuntime', owner, trace),
    monitorQuoteEventRuntime: recorded('monitorQuoteEventRuntime', owner, trace),
    monitorDisplayRuntime: recorded(
      'monitorDisplayRuntime',
      { start: owner.start, stopAndDrain: owner.stopAndDrain },
      trace,
    ),
    tradingQuoteDisplayRuntime: recorded('tradingQuoteDisplayRuntime', owner, trace),
    switchWakeupRuntime: recorded('switchWakeupRuntime', owner, trace),
    periodicSwitchWakeupRuntime: recorded('periodicSwitchWakeupRuntime', owner, trace),
    autoSearchWakeupRuntime: recorded('autoSearchWakeupRuntime', owner, trace),
    seatActivationDispatcher: recorded(
      'seatActivationDispatcher',
      { start: owner.start, stop: owner.stop },
      trace,
    ),
    seatRuntimeCleanupDispatcher: recorded(
      'seatRuntimeCleanupDispatcher',
      { start: owner.start, stop: owner.stop },
      trace,
    ),
    buyProcessor: recorded('buyProcessor', owner, trace),
    sellProcessor: recorded('sellProcessor', owner, trace),
    monitorTaskProcessor: recorded('monitorTaskProcessor', owner, trace),
    orderMonitor: tradeRuntime.orderMonitor,
    postTradeConsistencyRuntime,
    quoteSubscriptionRuntime,
    buyTaskQueue: recorded('buyTaskQueue', createBuyTaskQueue(), trace),
    sellTaskQueue: recorded('sellTaskQueue', createSellTaskQueue(), trace),
    monitorTaskQueue: recorded(
      'monitorTaskQueue',
      createMonitorTaskQueue<MonitorTaskDataMap>(createLoggerDouble()),
      trace,
    ),
  });
  const stateFixtures = createRuntimeStates();
  let tradingEnabled = stateFixtures.lifecycleState.isTradingEnabled;
  Object.defineProperty(stateFixtures.lifecycleState, 'isTradingEnabled', {
    get: () => tradingEnabled,
    set: (value: boolean) => {
      tradingEnabled = value;
      trace.push(`lifecycleState.isTradingEnabled=${value}`);
    },
  });
  stateFixtures.lifecycleState.currentDayKey = '2026-04-30';
  const manager = createDayLifecycleManager({
    termination,
    logger,
    mutableState: stateFixtures.lifecycleState,
    snapshot,
    cacheDomains: [
      signalDomain,
      createMarketDataDomain({ logger, marketDataClient }),
      createGlobalStateDomain({
        logger,
        ...stateFixtures,
        snapshot,
        runTradingDayOpenRebuild: (now) =>
          executeTradingDayOpenRebuild({
            now,
            termination,
            snapshot,
            postTradeConsistencyRuntime,
            quoteSubscriptionRuntime,
            loadTradingDayRuntimeSnapshot: async () => {
              const receipt = await snapshot.requestRefresh({
                source: 'LIFECYCLE_REBUILD',
                dayEpoch: snapshot.getView().token.dayEpoch,
                refreshAccount: true,
                refreshPositions: true,
              }).result;
              if (receipt.status !== 'COMMITTED') return { status: 'ABORTED' };

              return {
                status: 'COMMITTED',
                snapshotToken: receipt.snapshotToken,
                allOrders: [],
                quotesMap: new Map(),
              };
            },
            rebuildTradingDayState: async ({ snapshotToken }) => ({
              status: 'COMMITTED',
              snapshotToken,
            }),
          }),
      }),
    ],
  });
  return {
    trace,
    manager,
    cleanup,
    strategy,
    monitorContext,
    settlement,
    ...stateFixtures,
    snapshot,
    tradeRuntime,
    marketDataClient,
    termination,
    logger,
  };
}

describe('lifecycle checklist actual wiring', () => {
  it('covers actual factory acquisitions and cleanup registrations, including duplicate gate phases', () => {
    const registrations: NonNullable<
      LifecycleChecklistObservation['cleanupRegistrations']
    >[number][] = [];
    for (const [file, createdBy] of [
      ['app/runApp.ts', 'runApp'],
      ['app/runtime/createPreGateRuntime.ts', 'createPreGateRuntime'],
      ['app/runtime/createPostGateRuntime.ts', 'createPostGateRuntime'],
      ['app/runtime/createAsyncRuntime.ts', 'createAsyncRuntime'],
      ['app/startup/createSelectedStrategy.ts', 'createSelectedStrategy'],
    ]) {
      if (file === undefined || createdBy === undefined) throw new Error('factory source missing');

      for (const node of sourceNodes(file)) {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          ts.isCallExpression(node.initializer ?? node.name) &&
          /(?:Runtime|Processor|Dispatcher|Program|TaskQueue)$/.test(node.name.text) &&
          !/^(?:create|(?:preGate|postGate|async)Runtime$)/.test(node.name.text)
        ) {
          expect(
            LIFECYCLE_CHECKLIST.resources.some(({ resource }) => resource === node.name.getText()),
          ).toBe(true);
        }

        if (!ts.isCallExpression(node) || node.expression.getText() !== 'cleanup.register')
          continue;

        const argument = node.arguments[0];
        if (argument === undefined || !ts.isObjectLiteralExpression(argument))
          throw new Error('cleanup registration must remain static');

        const phase = argument.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'phase',
        );
        if (
          phase === undefined ||
          !ts.isPropertyAssignment(phase) ||
          !ts.isStringLiteral(phase.initializer)
        )
          throw new Error('cleanup phase must remain literal');

        const handler = argument.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'handler',
        );
        if (handler === undefined || !ts.isPropertyAssignment(handler))
          throw new Error('missing real cleanup handler');

        const phaseName = phase.initializer.text;
        const operation = cleanupOperation(handler.initializer);
        if (operation === undefined) throw new Error('missing cleanup resource/action identity');

        expect(
          LIFECYCLE_CHECKLIST.resources.some(
            (resource) =>
              resource.createdBy === createdBy &&
              resource.finalDrainAndDispose.some(
                ([cleanupPhase, action]) =>
                  cleanupPhase === phaseName && `${resource.resource}.${action}` === operation,
              ),
          ),
        ).toBe(true);
        registrations.push({ createdBy, cleanupPhase: phaseName as CleanupPhase, operation });
      }
    }

    expect(
      validateLifecycleChecklist(LIFECYCLE_CHECKLIST, { cleanupRegistrations: registrations }),
    ).toEqual([]);

    expect(
      validateLifecycleChecklist(
        {
          ...LIFECYCLE_CHECKLIST,
          resources: LIFECYCLE_CHECKLIST.resources.filter(
            ({ resource }) => resource !== 'orderTradeAuditListener',
          ),
        },
        { cleanupRegistrations: registrations },
      ),
    ).toContain(
      'unlisted cleanup registration: createPostGateRuntime:UNSUBSCRIBE_TRADER_LISTENER:orderTradeAuditListener.unsubscribeOrderTradeAudit',
    );

    const wrongReceiver = ts.createSourceFile(
      'wrongCleanupReceiver.ts',
      'const handler = () => tradingRiskEventRuntime.stopAndDrain();',
      ts.ScriptTarget.Latest,
      true,
    );
    const wrongOperation = cleanupOperation(wrongReceiver);
    expect(wrongOperation).toBe('tradingRiskEventRuntime.stopAndDrain');
    if (wrongOperation === undefined) throw new Error('missing negative fixture operation');

    const miswired = registrations.map((registration) =>
      registration.cleanupPhase === 'STOP_MONITOR_QUOTE_EVENT_RUNTIME'
        ? { ...registration, operation: wrongOperation }
        : registration,
    );
    expect(
      validateLifecycleChecklist(LIFECYCLE_CHECKLIST, { cleanupRegistrations: miswired }),
    ).toEqual([
      'unlisted cleanup registration: createPostGateRuntime:STOP_MONITOR_QUOTE_EVENT_RUNTIME:tradingRiskEventRuntime.stopAndDrain',
      'missing cleanup registration: createPostGateRuntime:STOP_MONITOR_QUOTE_EVENT_RUNTIME:monitorQuoteEventRuntime.stopAndDrain (1)',
    ]);
  });

  it('checks actual startup and synchronous termination call sites against declared actions/order', () => {
    const root = sourceNodes('app/runApp.ts');
    const startAfterRebuild = [
      ...sourceNodes('application/tradingDayRebuild/startupRebuild.ts'),
      ...sourceNodes('runtime/lifecycle/startupRuntime.ts'),
      ...root,
    ].flatMap((node) => {
      const operation = rootOperation(node);
      return operation !== undefined &&
        /\.(start|resetAbort|completeRebuildBaseline|waitForFresh|reconcileFromCurrentTruth|startRuntime)$/.test(
          operation,
        )
        ? [operation]
        : [];
    });
    expect(
      root.some(
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText() === 'startRuntimeAfterStartupRebuild',
      ),
    ).toBe(true);
    const stopConfig = root.find(
      (node) =>
        ts.isCallExpression(node) && node.expression.getText() === 'createTerminationRuntime',
    );
    if (stopConfig === undefined) throw new Error('missing real termination assembly');

    const stopAdmissionAndStopNow: string[] = [];
    function visit(node: ts.Node): void {
      const operation = rootOperation(node);
      if (
        operation !== undefined &&
        /\.(?:close|stop|abortWaiting|stopScheduling|invalidateAll|closeSnapshotAdmission)$|isTradingEnabled=false$/.test(
          operation,
        )
      )
        stopAdmissionAndStopNow.push(operation);

      ts.forEachChild(node, visit);
    }
    visit(stopConfig);
    expect(
      validateLifecycleChecklist(LIFECYCLE_CHECKLIST, {
        traces: { startAfterRebuild, stopAdmissionAndStopNow },
      }),
    ).toEqual([]);
  });

  it('records real midnight/open ordering and resets, then destroys, the same acquired strategy', async () => {
    const h = await dayHarness();
    try {
      await h.manager.tick(new Date('2026-05-01T00:00:00+08:00'), {
        dayKey: '2026-05-01',
        canTradeNow: false,
        isTradingDay: true,
      });

      expect(
        validateLifecycleChecklist(LIFECYCLE_CHECKLIST, {
          traces: { midnightStopAndDrain: h.trace },
        }),
      ).toEqual([]);
      expect(h.trace).not.toContain('strategy.destroy');
      expect(h.monitorContext.strategy).toBe(h.strategy);
      h.trace.length = 0;
      await h.manager.tick(new Date('2026-05-01T09:30:00+08:00'), {
        dayKey: '2026-05-01',
        canTradeNow: true,
        isTradingDay: true,
      });

      expect(
        validateLifecycleChecklist(LIFECYCLE_CHECKLIST, { traces: { openRebuildStart: h.trace } }),
      ).toEqual([]);
      expect(h.lifecycleState.isTradingEnabled).toBe(true);
      expect(h.monitorContext.strategy).toBe(h.strategy);
    } finally {
      await h.settlement.stopAndDrain();
      await h.cleanup.execute();
    }

    expect(h.trace.filter((operation) => operation === 'strategy.destroy')).toHaveLength(1);
  });

  it('keeps real TimeWakeup evaluations scheduling through midnight and rebuild without self-drain', async () => {
    const h = await dayHarness();
    let nowMs = Date.parse('2026-04-30T23:59:59+08:00');
    let timerSequence = 0;
    const timers = new Map<number, () => void>();
    const scheduledAtMs: number[] = [];
    let timerScheduled = Promise.withResolvers<undefined>();
    const tradingGateEventRuntime = createTradingGateEventRuntime({ logger: h.logger });
    const tradingConfig = createTradingConfig({
      monitor: h.monitorContext.config,
      global: {
        ...createTradingConfig().global,
        doomsdayProtection: false,
        openProtection: {
          morning: { enabled: false, minutes: null },
          afternoon: { enabled: false, minutes: null },
        },
      },
    });
    const doomsdayClearanceWorkflow = createDoomsdayClearanceWorkflowDouble();
    const runtime = createTimeWakeupRuntime({
      termination: h.termination,
      logger: h.logger,
      now: () => new Date(nowMs),
      evaluate: () =>
        timeWakeupEvaluationProgram({
          cacheManager: h.tradeRuntime.cacheManager,
          orderMonitor: h.tradeRuntime.orderMonitor,
          orderExecutor: h.tradeRuntime.orderExecutor,

          ...h,
          monitorContext: h.monitorContext,
          dayLifecycleManager: h.manager,
          tradingGateEventRuntime,
          tradingConfig,
          doomsdayClearanceWorkflow,
          now: () => new Date(nowMs),
        }),
      scheduleTimer: (callback, delayMs) => {
        const handle = ++timerSequence;
        const atMs = nowMs + delayMs;
        scheduledAtMs.push(atMs);
        timers.set(handle, () => {
          timers.delete(handle);
          nowMs = atMs;
          callback();
        });
        timerScheduled.resolve();
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    });
    const drain = spyOn(runtime, 'stopAndDrain');
    h.cleanup.register({
      phase: 'STOP_TIME_WAKEUP_RUNTIME',
      step: '停止真实系统时间唤醒',
      handler: () => runtime.stopAndDrain(),
    });

    try {
      await runtime.start();
      expect(scheduledAtMs.at(-1)).toBe(Date.parse('2026-05-01T00:00:00+08:00'));
      const midnight = timers.values().next().value;
      if (midnight === undefined) throw new Error('missing midnight timer');

      timerScheduled = Promise.withResolvers<undefined>();
      midnight();
      await timerScheduled.promise;
      expect(h.lifecycleState.lifecycleState).toBe('MIDNIGHT_CLEANED');
      expect(h.lifecycleState.isTradingEnabled).toBe(false);
      expect(h.trace).toContain('strategy.resetForTradingDay');
      expect(scheduledAtMs.at(-1)).toBe(Date.parse('2026-05-01T09:30:00+08:00'));
      expect(drain).not.toHaveBeenCalled();
      const open = timers.values().next().value;
      if (open === undefined) throw new Error('missing open rebuild timer');

      timerScheduled = Promise.withResolvers<undefined>();
      open();
      await timerScheduled.promise;
      expect(h.lifecycleState.lifecycleState).toBe('ACTIVE');
      expect(h.lifecycleState.isTradingEnabled).toBe(true);
      expect(h.trace).toContain('businessEventProgram.start');
      expect(h.trace).toContain('postTradeConsistencyRuntime.completeRebuildBaseline');
      expect(scheduledAtMs.at(-1)).toBe(Date.parse('2026-05-01T12:00:00+08:00'));
      expect(timers.size).toBe(1);
      expect(drain).not.toHaveBeenCalled();
      expect(h.trace).not.toContain('strategy.destroy');
    } finally {
      await h.settlement.stopAndDrain();
      await h.cleanup.execute();
    }

    expect(drain).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
    expect(h.trace.filter((operation) => operation === 'strategy.destroy')).toHaveLength(1);
    drain.mockRestore();
  });

  it('registers an acquired processor before an interrupted async factory can return', async () => {
    const cleanup = createCleanup();
    const resources: RuntimeAssemblyResources = {};
    const termination = createTerminationRuntime({
      closeTradingGate: () => {},
      closeProducerAdmission: () => {},
      stopProducers: [],
      onSecondaryError: () => {},
    });
    const phases: CleanupPhase[] = [];
    const runtime = createAsyncRuntime({
      logger: createLoggerDouble(),
      termination,
      resources,
      cleanup: {
        execute: cleanup.execute,
        register: (step) => {
          expect(resources.monitorTaskProcessor).toBeDefined();
          cleanup.register(step);
          phases.push(step.phase);
          termination.requestShutdown();
        },
      },
      // 在首个登记点中断，后续 acquisition 的依赖不会被访问。
      preGateRuntime: {
        tradingConfig: { global: { doomsdayProtection: false } },
      } as Parameters<typeof createAsyncRuntime>[0]['preGateRuntime'],
      postGateRuntime: {
        monitorContext: createMonitorContextDouble(),
        monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(createLoggerDouble()),
      } as Parameters<typeof createAsyncRuntime>[0]['postGateRuntime'],
      scheduler: {
        scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: clearTimeout,
      },
      clock: { now: () => new Date(0) },
    });
    expect(runtime).toBeNull();
    expect(resources.buyProcessor).toBeUndefined();
    const declared = LIFECYCLE_CHECKLIST.resources.filter(
      ({ resource }) => resource === 'monitorTaskProcessor',
    );
    expect(
      validateLifecycleChecklist(
        { resources: declared, order: [] },
        {
          cleanupRegistrations: phases.map((cleanupPhase) => ({
            createdBy: 'createAsyncRuntime',
            cleanupPhase,
            operation: 'monitorTaskProcessor.stopAndDrain',
          })),
        },
      ),
    ).toEqual([]);
    await cleanup.execute();
  });
});
