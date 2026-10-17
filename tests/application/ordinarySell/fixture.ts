import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createPositionDouble,
  createQuoteDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';

/** 普通 SELL 镜像装配：真实 canonical H 和真实 settlement S 发行当前 receipt，外部边界显式替身。 */
import { logger } from '../../../src/infrastructure/logger/index.js';
import { createOrdinarySellWorkflow } from '../../../src/application/ordinarySell/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createSnapshotFixture } from '../../helpers/accountPositionSnapshot.js';
import { createSettlementRuntimeFixture } from '../../helpers/settlementRuntime.js';
import { createMonitorContext } from '../../helpers/asyncProgram.js';

import type { OrdinarySellWorkflowDeps } from '../../../src/application/ordinarySell/types.js';
import type { SellHarness } from './types.js';
import type { Position } from '../../../src/types/account.js';

/** 构造当前 ACTIVE 双方向、成对快照与可显式推进的业务 readiness，不伪造 isCurrent=true。 */
export async function createSellHarness(
  overrides: Partial<OrdinarySellWorkflowDeps> = {},
): Promise<SellHarness> {
  let positions: ReadonlyArray<Position> = [
    createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 500,
      availableQuantity: 500,
      costPrice: '1',
    }),
  ];
  const snapshot = await createSnapshotFixture({
    account: createAccountSnapshotDouble('100000'),
    positions,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
      getStockPositions: async () => positions,
    },
  });
  const context = createMonitorContext();
  const tradeRuntime = createTradeRuntimeDouble({
    accountService: { getStockPositions: async () => positions },
    orderExecutor: { executeSignals: async () => ({ executedOrderIds: [], quoteFailures: [] }) },
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: () => {},
  });
  const settlement = createSettlementRuntimeFixture({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination,
    monitorContext: context,
    getProtectiveOrderReader: () => tradeRuntime.orderMonitor,
    onPositionsCommitted: async (token) => {
      if (!snapshot.isCurrent(token, { account: true, positions: true, paired: true }))
        throw new Error('fixture stale paired commit');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  settlement.start();
  if (!(await settlement.completeRebuildBaseline()))
    throw new Error('SELL fixture baseline not complete');

  const deps: OrdinarySellWorkflowDeps = {
    logger,
    config: { smartCloseEnabled: false, smartCloseTimeoutMinutes: null },
    symbolRegistry: context.symbolRegistry,

    orderRecorder: tradeRuntime.orderRecorder,
    orderExecutor: tradeRuntime.orderExecutor,
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () =>
        new Map([
          ['BULL.HK', createQuoteDouble('BULL.HK', '1.1', 100)],
          ['BEAR.HK', createQuoteDouble('BEAR.HK', '1', 100)],
        ]),
    }),
    snapshot,
    settlement,
    getTradingCalendar: () => ({ isHalfDay: false, tradingCalendarSnapshot: new Map() }),
    clock: { now: () => new Date('2026-02-16T02:00:00Z') },
    getCanProcessTask: () => true,
    termination,
    ...overrides,
  };
  return {
    workflow: createOrdinarySellWorkflow(deps),
    deps,
    snapshot,
    settlement,
    context,
    setPositions: (next: ReadonlyArray<Position>) => {
      positions = next;
    },
    publishPositions: async () => {
      const receipt = await snapshot.requestRefresh({
        source: 'TEST_RESELECT',
        dayEpoch: snapshot.getView().token.dayEpoch,
        refreshAccount: false,
        refreshPositions: true,
      }).result;
      if (receipt.status !== 'COMMITTED') throw new Error('fixture position update aborted');
    },
  };
}
