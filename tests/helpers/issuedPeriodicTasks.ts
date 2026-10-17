import { createDiagnosticObserverDouble } from './diagnostics.js';
import { createLoggerDouble } from './testDoubles.js';
import type { TradeRuntime, PostTradeConsistencyRuntime } from '../../src/app/runtime/types.js';
import { createPeriodicSwitchWakeupRuntime } from '../../src/runtime/periodicSwitchWakeupRuntime/index.js';
import { createSettlementRuntimeFixture } from './settlementRuntime.js';
import type { AccountPositionSnapshot } from '../../src/types/accountPosition.js';
import type { MonitorContextAssembly } from '../../src/app/context/types.js';
import type { RuntimeTermination } from '../../src/types/runtime.js';
import type { PeriodicSwitchTaskData } from '../../src/types/periodicSwitch.js';

/** Actual producer-issued task identities; lifetime extends through the consumer's drain. */
export async function createIssuedPeriodicTasksFixture(
  params: Readonly<{
    snapshot: AccountPositionSnapshot;
    monitorContext: MonitorContextAssembly;
    tradeRuntime: TradeRuntime;
    termination: RuntimeTermination;
    getCanTradeNow: () => boolean;
    nowMs: number;
  }>,
): Promise<
  Readonly<{
    settlement: PostTradeConsistencyRuntime;
    getTask: (direction: 'LONG' | 'SHORT') => PeriodicSwitchTaskData;
    stopAndDrain: () => Promise<void>;
  }>
> {
  const tasks = new Map<'LONG' | 'SHORT', PeriodicSwitchTaskData>();
  const scheduler = {
    scheduleTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle);
    },
  };
  const settlement = createSettlementRuntimeFixture({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot: params.snapshot,
    termination: params.termination,
    monitorContext: params.monitorContext,
    getProtectiveOrderReader: () => params.tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!params.snapshot.isCurrent(token, { account: true, positions: true, paired: true })) {
        throw new Error('Unexpected stale positions commit in periodic task fixture');
      }
    },
    scheduler,
  });
  settlement.start();
  if (!(await settlement.completeRebuildBaseline()))
    throw new Error('Periodic task paired settlement baseline incomplete');

  const receipt = await settlement.waitForFresh();
  if (receipt.snapshotToken !== params.snapshot.getView().token) {
    throw new Error('Settlement did not certify the original canonical snapshot');
  }

  const runtime = createPeriodicSwitchWakeupRuntime({
    snapshot: params.snapshot,
    termination: params.termination,
    monitorContext: params.monitorContext,
    symbolRegistry: params.monitorContext.symbolRegistry,
    orderMonitor: params.tradeRuntime.orderMonitor,
    getCanTradeNow: params.getCanTradeNow,
    postTradeConsistencyRuntime: settlement,
    monitorTaskQueue: {
      scheduleLatest: (task) => {
        if (task.type === 'AUTO_SYMBOL_TICK') tasks.set(task.data.direction, task.data);

        return true;
      },
    },
    tradingGateEventRuntime: { onGateStateChanged: () => () => {} },
    calculateDueAtMs: () => params.nowMs,
    now: () => new Date(params.nowMs),
    ...scheduler,
  });
  runtime.start();
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();

  return {
    settlement,
    getTask: (direction: 'LONG' | 'SHORT'): PeriodicSwitchTaskData => {
      const task = tasks.get(direction);
      if (task === undefined) throw new Error(`Periodic producer did not issue ${direction}`);

      return task;
    },
    stopAndDrain: async () => {
      await runtime.stopAndDrain();
      await settlement.stopAndDrain();
    },
  };
}
