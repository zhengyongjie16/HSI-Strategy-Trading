/** API 覆盖不替代保护性 durable/episode/S：真实 mapper、O/Daily、repository 与 completion/cooldown 连接回归。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from '../core/orderRecorder/executionFixture.js';
import { createEventFlow } from '../../src/core/trader/orderMonitor/eventFlow.js';
import { createMixedTradeLogRepository } from '../../src/services/mixedTradeLogRepository/index.js';
import { createLiquidationCooldownTracker } from '../../src/services/liquidationCooldown/index.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../src/types/risk.js';
import {
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

const T = Date.parse('2026-10-07T02:00:00.000Z');
const day = '2026-10-07';
const monitorConfig = createMonitorConfigDouble({
  monitorSymbol: 'HSI.HK',
  orderOwnershipMapping: ['HSI'],
  liquidationTriggerLimit: 1,
  liquidationCooldown: { mode: 'minutes', minutes: 5 },
});
function sellFrame(time = T, revision = T + 20) {
  return {
    orderId: 'protective-sell',
    tradeId: 'sell-fill',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '|PL',
    side: 'SELL' as const,
    status: 'Filled' as const,
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '0.9',
    executedPrice: '0.9',
    submittedAtMs: T - 2000,
    executionTimeMs: time,
    updatedAtMs: revision,
  };
}

async function flush() {
  for (let count = 0; count < 100; count++) await Promise.resolve();
}

/** 全量订单由真实 API adapter/ledger 映射；O/Daily 本地基线同段提交，不冒充在线成交。 */
async function harness(
  root: string,
  onPersist?: (p: ProtectiveLiquidationExecutionProgressInput) => void,
) {
  const native = await createBrokerIngressFixture(sellFrame());
  const buy = {
    ...sellFrame(T - 1000, T - 500),
    orderId: 'buy',
    tradeId: 'buy-fill',
    side: 'BUY' as const,
    remark: '',
    submittedPrice: '1',
    executedPrice: '1',
  };
  native.setOrderSnapshotReplies([], [buy, sellFrame()]);
  native.setExecutionReplies([
    {
      orderId: 'buy',
      tradeId: 'buy-fill',
      symbol: 'BULL.HK',
      quantity: '100',
      price: '1',
      tradeDoneAtMs: T - 1000,
    },
    {
      orderId: 'protective-sell',
      tradeId: 'sell-fill',
      symbol: 'BULL.HK',
      quantity: '100',
      price: '0.9',
      tradeDoneAtMs: T,
    },
  ]);
  const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
  const persisted: ProtectiveLiquidationExecutionProgressInput[] = [];
  const persist = (p: ProtectiveLiquidationExecutionProgressInput) => {
    persisted.push(p);
    onPersist?.(p);
    repository.appendExecutionProgressIdempotent(p);
  };
  const trader = createTraderDouble();
  const f = createExecutionFixture({
    nowMs: T,
    createRecorder: native.createRecorder,
    persistProgress: persist,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
    getTrader: () => trader,
    onPositionsCommitted: async () => {},
  });
  const cooldownOwner = createLiquidationCooldownTracker({ nowMs: () => T });
  let cooldownCommits = 0;
  const cooldown = {
    ...cooldownOwner,
    recordLiquidationTrigger: (
      ...args: Parameters<typeof cooldownOwner.recordLiquidationTrigger>
    ) => {
      cooldownCommits++;
      cooldownOwner.recordLiquidationTrigger(...args);
    },
  };
  f.sink.bindBusinessDeps({
    monitorContext: createMonitorContextDouble({
      config: monitorConfig,
      orderRecorder: f.recorder,
      dailyLossTracker: f.daily,
    }),
    dailyLossTracker: f.daily,
    protectiveLiquidationEpisodeTracker: f.episode,
    liquidationCooldownTracker: cooldown,
    mixedTradeLogRepository: repository,
  });
  const orders = await f.recorder.fetchAllOrdersFromAPI();
  const prepared = f.daily.prepareRecalculationFromAllOrders(orders, monitorConfig, new Date(T));
  const token = f.snapshot.getView().token;
  expect(
    f.recorder.commitRebuildSnapshot(
      [{ symbol: 'BULL.HK', isLongSymbol: true }],
      orders,
      () => f.snapshot.getView().token === token && prepared.isCurrent(),
      'ACTIVATION',
    ).status,
  ).toBe('COMMITTED');
  f.daily.publishRecalculation(prepared);
  const sell = orders.find((o) => o.orderId === 'protective-sell');
  if (sell === undefined) throw new Error('real API must include protective sell');

  return {
    f,
    native,
    repository,
    persisted,
    persist,
    orders,
    sell,
    cooldown,
    cooldownCommits: () => cooldownCommits,
  };
}

function terminal(order: RawOrderFromAPI) {
  return {
    orderId: order.orderId,
    closedReason: 'FILLED' as const,
    source: 'WS' as const,
    symbol: order.symbol,
    side: order.executionSide,
    monitorSymbol: 'HSI.HK',
    isLongSymbol: true,
    isProtectiveLiquidation: true,
    executedPrice: order.executedPrice,
    executedAmount: order.executedAmount,
    executedQuantity: order.executedQuantity,
    executedTimeMs: order.executionTimeMs,
    orderUpdatedAtMs: order.updatedAtMs,
  };
}

function track(h: Awaited<ReturnType<typeof harness>>, timeout: boolean) {
  const { f, native } = h;
  const ops = native.createOperations({
    runtime: f.runtime,
    monitorConfig,
    now: () => new Date(T),
    orderRecorder: f.recorder,
    orderHoldRegistry: f.holds,
    termination: f.termination,
    rateLimiter: f.rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    getExecutionTimeEvidence: f.daily.getExecutionTimeEvidence,
    triggerRoute: () => {},
    captureWorkGuard: () => () => !f.termination.isTerminated(),
    recordCumulativeExecution: (p) => {
      f.flow.recordCumulativeExecution(p);
    },
  });
  f.runtime.runtimeState = 'ACTIVE';
  ops.trackOrder({
    orderId: h.sell.orderId,
    symbol: h.sell.symbol,
    side: 'SELL',
    executionSide: 'SELL',
    orderType: 'LO',
    price: '0.9',
    initialSubmittedPrice: '0.9',
    quantity: 100,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
  });
  const tracked = f.runtime.trackedOrders.get(h.sell.orderId);
  if (tracked === undefined) throw new Error('real OrderOps did not track sell');

  tracked.timeoutMarketConversionPending = timeout;
  f.recorder.submitSellOrder(h.sell.orderId, h.sell.symbol, 'LONG', 100, [], true, T - 2000);
  f.holds.trackOrder(h.sell.orderId, h.sell.symbol);
  return tracked;
}

function eventFlow(f: ReturnType<typeof createExecutionFixture>) {
  return createEventFlow({
    runtime: f.runtime,
    monitorConfig,
    now: () => new Date(T),
    orderRecorder: f.recorder,
    recordCumulativeExecution: (p) => {
      f.flow.recordCumulativeExecution(p);
    },
    prepareProtectiveTerminalExecution: f.flow.prepareProtectiveTerminalExecution,
    settleOrder: f.flow.settleOrder,
    cacheBootstrappingEvent: () => {
      throw new Error('not bootstrapping');
    },
    triggerRoute: () => {},
  });
}

async function complete(h: Awaited<ReturnType<typeof harness>>, time: number) {
  h.f.sink.start();
  await h.f.sink.waitForFresh();
  expect(h.f.episode.getInProgressEpisodes()).toEqual([]);
  expect(h.f.daily.getLossOffset('LONG')).toBe('0');
  expect(h.repository.loadCompletionRecords(day)).toMatchObject([{ boundaryExecutedTimeMs: time }]);
  expect(h.cooldownCommits()).toBe(1);
  expect(
    h.cooldown.getRemainingMs({
      direction: 'LONG',
      cooldownConfig: monitorConfig.liquidationCooldown,
    }),
  ).toBe(300_000 + time - T);
}

for (const mode of ['direct', 'timeout'] as const)
  test(`C2 API-covered ${mode} terminal completes durable/episode/S/cooldown once`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-covered-'));
    const h = await harness(root);
    const { f, native, sell } = h;
    let monitor: ReturnType<typeof native.createMonitor> | undefined;
    try {
      expect(f.daily.getLossOffset('LONG')).toBe('-10');
      expect(f.recorder.getCostBasis(sell.symbol, true)).toBeNull();
      const before = {
        fact: f.recorder.getExecutionFact(sell.orderId),
        evidence: f.daily.getExecutionTimeEvidence(),
        token: f.snapshot.getView().token,
      };
      const closed: string[] = [];
      if (mode === 'direct') {
        monitor = native.createMonitor({
          now: () => new Date(T),
          scheduleTimer: setTimeout,
          clearTimer: clearTimeout,
          rateLimiter: f.rateLimiter,
          cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
          marketDataClient: createMarketDataClientDouble(),
          orderRecorder: f.recorder,
          dailyLossTracker: f.daily,
          orderHoldRegistry: f.holds,
          protectiveLiquidationEpisodeTracker: f.episode,
          persistProtectiveLiquidationExecutionProgress: h.persist,
          postTradeConsistencyRuntime: f.sink,
          tradingConfig: createTradingConfig({ monitor: monitorConfig }),
          symbolRegistry: createSymbolRegistryDouble(),
          isContinuousTradingAllowed: () => false,
          termination: f.termination,
        });
        let notifyClosed!: () => void;
        const firstClose = new Promise<void>((resolve) => {
          notifyClosed = resolve;
        });
        monitor.onOrderStateChanged((e) => {
          closed.push(e.orderId);
          notifyClosed();
        });
        await monitor.initialize();
        await monitor.recoverOrderTrackingFromSnapshot([]);
        monitor.trackOrder({
          orderId: sell.orderId,
          symbol: sell.symbol,
          side: 'SELL',
          executionSide: 'SELL',
          orderType: sell.orderType,
          price: '0.9',
          initialSubmittedPrice: '0.9',
          quantity: 100,
          isLongSymbol: true,
          monitorSymbol: 'HSI.HK',
          isProtectiveLiquidation: true,
        });
        f.recorder.submitSellOrder(sell.orderId, sell.symbol, 'LONG', 100, [], true, T - 2000);
        f.holds.trackOrder(sell.orderId, sell.symbol);
        native.emitOrderChanged();
        await Promise.race([
          firstClose,
          f.termination.waitForTermination().then(() => {
            const fatal = f.termination.getFatalState();
            if (fatal.hasFatalError) throw fatal.error;

            throw new Error('monitor stopped without terminal');
          }),
        ]);
        expect(f.termination.getFatalState()).toEqual({ hasFatalError: false });
        expect(monitor.getPendingSellOrders(sell.symbol)).toEqual([]);
      } else {
        const tracked = track(h, true);
        eventFlow(f).handleOrderChanged(sell);
        expect(f.episode.getInProgressEpisodes()).toEqual([]);
        expect(f.sink.getStatus().staleVersion).toBe(0);
        expect(f.recorder.getPendingSellSnapshot()).toHaveLength(1);
        const prepared =
          tracked.timeoutMarketConversionTerminalState?.preparedProtectiveTerminalExecution;
        if (prepared === undefined) throw new Error('timeout durable preparation missing');

        expect(prepared.executionAdvanced).toBe(false);
        expect(
          f.flow.settleOrder({ ...terminal(sell), preparedProtectiveTerminalExecution: prepared })
            .handled,
        ).toBe(true);
        expect(f.runtime.trackedOrders.has(sell.orderId)).toBe(false);
        expect(f.runtime.trackedOrderIdsBySymbol.has(sell.symbol)).toBe(false);
      }

      expect(f.recorder.getExecutionFact(sell.orderId)).toBe(before.fact);
      expect(f.daily.getExecutionTimeEvidence()).toEqual(before.evidence);
      expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
      expect(f.holds.getHoldSymbols()).toEqual(new Set());
      expect(f.episode.getInProgressEpisodes()).toEqual([
        { direction: 'LONG', symbol: sell.symbol, latestExecutedTimeMs: T },
      ]);
      expect(f.sink.getStatus().staleVersion).toBe(1);
      expect(f.snapshot.getView().token.snapshotGeneration).toBe(
        before.token.snapshotGeneration + 1,
      );
      expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(1);
      await complete(h, T);
      const after = {
        token: f.snapshot.getView().token,
        status: f.sink.getStatus(),
        evidence: f.daily.getExecutionTimeEvidence(),
        durableCalls: h.persisted.length,
      };
      if (monitor === undefined) expect(f.flow.settleOrder(terminal(sell)).handled).toBe(false);
      else {
        native.emitOrderChanged();
        await flush();
        expect(closed).toHaveLength(1);
      }

      expect(f.episode.getInProgressEpisodes()).toEqual([]);
      expect(f.snapshot.getView().token).toEqual(after.token);
      expect(f.sink.getStatus()).toEqual(after.status);
      expect(f.daily.getExecutionTimeEvidence()).toEqual(after.evidence);
      expect(h.persisted).toHaveLength(after.durableCalls);
      expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(1);
      expect(h.repository.loadCompletionRecords(day)).toHaveLength(1);
      expect(h.cooldownCommits()).toBe(1);
    } finally {
      if (monitor !== undefined) {
        await monitor.stopRuntimeAndDrain();
        await monitor.teardown();
      }

      await f.sink.stopAndDrain();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('C2 duplicate baseline durable fault preserves O/Daily/H/S/pending/tracking and retries the same terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-fault-'));
  const fault = new Error('covered protective progress write failed');
  let fail = true;
  const h = await harness(root, () => {
    if (fail) throw fault;
  });
  const { f, sell } = h;
  try {
    track(h, true);
    const before = {
      fact: f.recorder.getExecutionFact(sell.orderId),
      evidence: f.daily.getExecutionTimeEvidence(),
      pending: f.recorder.getPendingSellSnapshot(),
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
    };
    expect(() => f.flow.prepareProtectiveTerminalExecution(terminal(sell))).toThrow(fault);
    expect(() => f.flow.settleOrder(terminal(sell))).toThrow(fault);
    expect(f.recorder.getExecutionFact(sell.orderId)).toBe(before.fact);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(before.evidence);
    expect(f.recorder.getPendingSellSnapshot()).toEqual(before.pending);
    expect(f.snapshot.getView().token).toEqual(before.token);
    expect(f.sink.getStatus()).toEqual(before.status);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.runtime.trackedOrders.has(sell.orderId)).toBe(true);
    expect(f.runtime.closedOrderIds.has(sell.orderId)).toBe(false);
    expect(f.holds.getHoldSymbols()).toEqual(new Set([sell.symbol]));
    expect(h.repository.loadExecutionProgressRecords(day)).toEqual([]);
    fail = false;
    expect(f.flow.settleOrder(terminal(sell)).handled).toBe(true);
    expect(f.sink.getStatus().staleVersion).toBe(1);
    expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C2 delayed old terminal uses adjudicated durable T2 and sealed duplicate only closes resources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-trusted-'));
  const h = await harness(root);
  const { f, sell } = h;
  try {
    const tracked = track(h, false);
    const newer = {
      ...sell,
      executionTimeMs: T + 50,
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    };
    const prepared = f.daily.prepareRecalculationFromAllOrders(
      [...h.orders.filter((o) => o.orderId !== sell.orderId), newer],
      monitorConfig,
      new Date(T),
    );
    f.recorder.commitRebuildSnapshot(
      [{ symbol: sell.symbol, isLongSymbol: true }],
      [newer],
      prepared.isCurrent,
      'ACTIVATION',
    );
    f.daily.publishRecalculation(prepared);
    // tracked 是旧 OPEN；R1/T1 比 tracked 新却比 API R2/T2 旧，真实 EventFlow 只能补 T2。
    eventFlow(f).handleOrderChanged(sell);
    expect(f.runtime.closedOrderIds.has(sell.orderId)).toBe(true);
    expect(f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T + 50 }]);
    expect(h.repository.loadExecutionProgressRecords(day)).toMatchObject([
      { lastExecutionTimeMs: T + 50, orderRevisionMs: T + 100 },
    ]);
    await complete(h, T + 50);
    const before = {
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
      evidence: f.daily.getExecutionTimeEvidence(),
      progress: h.persisted.length,
    };
    // 明确模拟已恢复 completed boundary、但同订单终态资源还需补关的组合状态。
    f.runtime.closedOrderIds.delete(sell.orderId);
    f.runtime.trackedOrders.set(sell.orderId, tracked);
    f.recorder.submitSellOrder(sell.orderId, sell.symbol, 'LONG', 100, [], true, T - 2000);
    f.holds.trackOrder(sell.orderId, sell.symbol);
    expect(f.flow.settleOrder(terminal(newer)).handled).toBe(true);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.holds.getHoldSymbols()).toEqual(new Set());
    expect(f.snapshot.getView().token).toEqual(before.token);
    expect(f.sink.getStatus()).toEqual(before.status);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(before.evidence);
    expect(h.persisted).toHaveLength(before.progress);
    expect(h.repository.loadCompletionRecords(day)).toHaveLength(1);
    expect(h.cooldownCommits()).toBe(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C2 closed high-revision execution-time correction advances only existing episode after durable success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-time-correction-'));
  const fault = new Error('time correction durable failure');
  let failCorrection = false;
  const h = await harness(root, (p) => {
    if (failCorrection && p.orderRevisionMs > T + 20) throw fault;
  });
  const { f, sell } = h;
  try {
    track(h, false);
    const events = eventFlow(f);
    events.handleOrderChanged(sell);
    expect(f.events).toHaveLength(1);
    const corrected = {
      ...sell,
      executionTimeMs: T + 50,
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    };
    const before = {
      fact: f.recorder.getExecutionFact(sell.orderId),
      evidence: f.daily.getExecutionTimeEvidence(),
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
      episode: f.episode.getInProgressEpisodes(),
    };
    failCorrection = true;
    expect(() => {
      events.handleOrderChanged(corrected);
    }).toThrow(fault);
    expect(f.recorder.getExecutionFact(sell.orderId)).toBe(before.fact);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(before.evidence);
    expect(f.snapshot.getView().token).toEqual(before.token);
    expect(f.sink.getStatus()).toEqual(before.status);
    expect(f.episode.getInProgressEpisodes()).toEqual(before.episode);
    failCorrection = false;
    events.handleOrderChanged(corrected);
    expect(f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T + 50 }]);
    expect(f.sink.getStatus().staleVersion).toBe(2);
    expect(f.events).toHaveLength(1);
    expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(2);
    await complete(h, T + 50);
    // 完成后即使后来合法新 T 可准入，也不能由同量 closed 修订重新建立 episode。
    const later = {
      ...sell,
      executionTimeMs: T + 200,
      updatedAtMs: T + 300,
      updatedAt: new Date(T + 300),
    };
    events.handleOrderChanged(later);
    await f.sink.waitForFresh();
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(h.repository.loadCompletionRecords(day)).toHaveLength(1);
    expect(h.cooldownCommits()).toBe(1);
    expect(f.events).toHaveLength(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
