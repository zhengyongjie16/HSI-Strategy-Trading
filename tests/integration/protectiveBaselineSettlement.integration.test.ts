import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import {
  createLoggerDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createMonitorContextDouble,
  createSymbolRegistryDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';

/** API 覆盖不替代保护性 durable/episode/S：真实 mapper、O/Daily、repository 与 completion/cooldown 连接回归。 */

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createEventFlow } from '../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { createLiquidationCooldownTracker } from '../../src/domain/liquidation/cooldown/index.js';
import { createMixedTradeLogRepository } from '../../src/infrastructure/persistence/mixedTradeLogRepository/index.js';
import type {
  DailyLossOrderSnapshot,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../src/types/risk.js';
import type { OrderFact } from '../../src/types/trade.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';

import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';

/** 真实 recorder 已含完整金额；测试仅把已验证事实交给 DailyLoss 公共形态。 */
function toDailyLossSnapshot(order: OrderFact): OrderFact & DailyLossOrderSnapshot {
  if (order.executedQuantity > 0 && order.executedAmount === null)
    throw new Error('test order missing economic amount');

  return order as OrderFact & DailyLossOrderSnapshot;
}

const T = Date.parse('2026-10-07T02:00:00.000Z');
const day = '2026-10-07';
const monitorConfig = createMonitorConfigDouble({
  monitorSymbol: 'HSI.HK',
  orderOwnershipMapping: ['HSI'],
  liquidationTriggerLimit: 1,
  liquidationCooldown: { mode: 'minutes', minutes: 5 },
});
function sellFrame(revision = T) {
  return {
    orderId: 'protective-sell',
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
  quantity = 100,
) {
  const sellInput = {
    ...sellFrame(),
    quantity: String(quantity),
    executedQuantity: String(quantity),
    submittedPrice: String(90 / quantity),
    executedPrice: String(90 / quantity),
  };
  const native = await createBrokerIngressFixture(sellInput);
  const buy = {
    ...sellFrame(T - 500),
    orderId: 'buy',
    side: 'BUY' as const,
    remark: '',
    quantity: String(quantity),
    executedQuantity: String(quantity),
    submittedPrice: String(100 / quantity),
    executedPrice: String(100 / quantity),
  };
  native.setOrderSnapshotReplies([], [buy, sellInput]);
  const repository = createMixedTradeLogRepository({ resolveLogRootDir: () => root });
  const persisted: ProtectiveLiquidationExecutionProgressInput[] = [];
  const persist = (p: ProtectiveLiquidationExecutionProgressInput) => {
    onPersist?.(p);
    repository.appendExecutionProgressIdempotent(p);
    persisted.push(p);
  };
  const tradeRuntime = createTradeRuntimeDouble();
  const f = createExecutionFixture({
    nowMs: T,
    createRecorder: native.createRecorder,
    persistProgress: persist,
    readPort: {
      getAccountSnapshot: async () => createAccountSnapshotDouble('10000'),
      getStockPositions: async () => [],
    },
    getTradeRuntime: () => tradeRuntime,
    onPositionsCommitted: async () => {},
  });
  const cooldownOwner = createLiquidationCooldownTracker();
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
  const fetchedOrders = await f.recorder.fetchAllOrdersFromAPI();
  const orders = fetchedOrders.map(toDailyLossSnapshot);
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

function terminal(order: OrderFact) {
  if (order.executedAmount === null) throw new Error('terminal observation lacks amount');

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
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    wait: wait,
    runtime: f.runtime,
    monitorConfig,
    now: () => new Date(T),
    orderRecorder: f.recorder,
    orderHoldRegistry: f.holds,
    termination: f.termination,
    rateLimiter: f.rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
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
    price: h.sell.executedPrice,
    initialSubmittedPrice: h.sell.executedPrice,
    quantity: h.sell.quantity,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: true,
  });
  const tracked = f.runtime.trackedOrders.get(h.sell.orderId);
  if (tracked === undefined) throw new Error('real OrderOps did not track sell');

  tracked.timeoutMarketConversionPending = timeout;
  f.recorder.submitSellOrder(h.sell.orderId, h.sell.symbol, 'LONG', 100, [], T - 2000);
  f.holds.trackOrder(h.sell.orderId, h.sell.symbol);
  return tracked;
}

function eventFlow(f: ReturnType<typeof createExecutionFixture>) {
  return createEventFlow({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
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
      currentTimeMs: T,
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
        token: f.snapshot.getView().token,
      };
      const closed: string[] = [];
      if (mode === 'direct') {
        monitor = native.createMonitor({
          diagnostics: createDiagnosticObserverDouble(),
          logger: createLoggerDouble(),
          wait: wait,
          requestExternalApi: wrapExternalApiRequest,
          scheduleBoundedOneShotAt: scheduleBoundedOneShotAt,
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
        f.recorder.submitSellOrder(sell.orderId, sell.symbol, 'LONG', 100, [], T - 2000);
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
      pending: f.recorder.getPendingSellSnapshot(),
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
    };
    expect(() => f.flow.prepareProtectiveTerminalExecution(terminal(sell))).toThrow(fault);
    expect(() => f.flow.settleOrder(terminal(sell))).toThrow(fault);
    expect(f.recorder.getExecutionFact(sell.orderId)).toBe(before.fact);
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

test('C2 same-quantity higher revision keeps known durable T and sealed duplicate only closes resources', async () => {
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
      [...h.orders.filter((o) => o.orderId !== sell.orderId), newer].map(toDailyLossSnapshot),
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
    // 同量高 revision 只推进 revision，执行 T 保留 known durable T。
    eventFlow(f).handleOrderChanged(newer);
    expect(f.runtime.closedOrderIds.has(sell.orderId)).toBe(true);
    expect(f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T }]);
    expect(h.repository.loadExecutionProgressRecords(day)).toMatchObject([
      { lastExecutionTimeMs: T, orderRevisionMs: T + 100 },
    ]);
    await complete(h, T);
    const before = {
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
      progress: h.persisted.length,
    };
    // 明确模拟已恢复 completed boundary、但同订单终态资源还需补关的组合状态。
    f.runtime.closedOrderIds.delete(sell.orderId);
    f.runtime.trackedOrders.set(sell.orderId, tracked);
    f.recorder.submitSellOrder(sell.orderId, sell.symbol, 'LONG', 100, [], T - 2000);
    f.holds.trackOrder(sell.orderId, sell.symbol);
    expect(f.flow.settleOrder(terminal({ ...newer, executionTimeMs: T })).handled).toBe(true);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.holds.getHoldSymbols()).toEqual(new Set());
    expect(f.snapshot.getView().token).toEqual(before.token);
    expect(f.sink.getStatus()).toEqual(before.status);
    expect(h.persisted).toHaveLength(before.progress + 1);
    expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(1);
    expect(h.repository.loadCompletionRecords(day)).toHaveLength(1);
    expect(h.cooldownCommits()).toBe(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 真实 EventFlow 先完成保护性 SELL 结算；返回同一 events owner 供后续合法修订。 */
function sealProtectiveSell(h: Awaited<ReturnType<typeof harness>>) {
  track(h, false);
  const events = eventFlow(h.f);
  events.handleOrderChanged(h.sell);
  expect(h.f.events).toHaveLength(1);
  expect(h.f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T }]);
  expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(1);
  return events;
}

test('C2 sealed same-quantity same-amount higher revision advances only the revision watermark', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-sealed-watermark-'));
  const h = await harness(root);
  const { f, sell } = h;
  try {
    const events = sealProtectiveSell(h);
    const before = f.recorder.getExecutionFact(sell.orderId);
    events.handleOrderChanged({
      ...sell,
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    });
    const after = f.recorder.getExecutionFact(sell.orderId);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({
      cumulativeQuantity: 100,
      cumulativeAmount: '90',
      executionTimeMs: T,
      updatedAtMs: T + 100,
      phase: 'TERMINAL',
    });
    expect(f.daily.getLossOffset('LONG')).toBe('-10');
    expect(h.repository.loadExecutionProgressRecords(day)).toMatchObject([
      { lastExecutionTimeMs: T, orderRevisionMs: T, cumulativeAmount: '90' },
      { lastExecutionTimeMs: T, orderRevisionMs: T + 100, cumulativeAmount: '90' },
    ]);
    expect(f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T }]);
    expect(f.events).toHaveLength(1);

    await complete(h, T);
    // 完成后同量同金额 revision 仍只抬高水位，不重建 episode/completion。
    events.handleOrderChanged({
      ...sell,
      updatedAtMs: T + 200,
      updatedAt: new Date(T + 200),
    });
    await f.sink.waitForFresh();
    expect(f.recorder.getExecutionFact(sell.orderId)).toMatchObject({ updatedAtMs: T + 200 });
    expect(h.repository.loadExecutionProgressRecords(day)).toHaveLength(3);
    expect(
      f.daily
        .prepareProtectionBoundary({ direction: 'LONG', boundaryExecutedTimeMs: T + 1 })
        .orderBaselines.find((baseline) => baseline.orderId === sell.orderId)?.orderRevisionMs,
    ).toBe(T + 200);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(h.repository.loadCompletionRecords(day)).toHaveLength(1);
    expect(h.cooldownCommits()).toBe(1);
    expect(f.events).toHaveLength(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C2 sealed same-quantity legal amount revision updates recorder/economy/durable without repeated resource closure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-sealed-amount-'));
  const h = await harness(root);
  const { f, sell } = h;
  try {
    const events = sealProtectiveSell(h);
    events.handleOrderChanged({
      ...sell,
      executedPrice: '0.95',
      executedAmount: '95',
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    });

    expect(f.recorder.getExecutionFact(sell.orderId)).toMatchObject({
      cumulativeQuantity: 100,
      cumulativeAmount: '95',
      executionTimeMs: T,
      updatedAtMs: T + 100,
      phase: 'TERMINAL',
    });
    expect(f.daily.getLossOffset('LONG')).toBe('-5');
    expect(h.repository.loadExecutionProgressRecords(day)).toMatchObject([
      { lastExecutionTimeMs: T, orderRevisionMs: T, cumulativeAmount: '90' },
      { lastExecutionTimeMs: T, orderRevisionMs: T + 100, cumulativeAmount: '95' },
    ]);
    // 只更新经济/durable/revision；不重新打开 pending、hold、episode 或终态事件。
    expect(f.episode.getInProgressEpisodes()).toMatchObject([{ latestExecutedTimeMs: T }]);
    expect(f.recorder.getPendingSellSnapshot()).toEqual([]);
    expect(f.holds.getHoldSymbols()).toEqual(new Set());
    expect(f.events).toHaveLength(1);

    await complete(h, T);
    expect(
      h.repository
        .loadCompletionRecords(day)[0]
        ?.orderBaselines.find((baseline) => baseline.orderId === sell.orderId)?.cumulativeAmount,
    ).toBe('95');
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C2 sealed amount revision durable failure keeps every projection and retries exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-c2-sealed-fault-'));
  const fault = new Error('sealed amount revision durable failure');
  let failCorrection = false;
  const h = await harness(root, (progress) => {
    if (failCorrection && progress.orderRevisionMs > T) throw fault;
  });
  const { f, sell } = h;
  try {
    const events = sealProtectiveSell(h);
    await complete(h, T);
    const before = {
      token: f.snapshot.getView().token,
      status: f.sink.getStatus(),
      baseline: h.repository.loadCompletionRecords(day),
      candidate: f.daily.prepareRecalculationFromAllOrders(h.orders, monitorConfig, new Date(T)),
      fact: f.recorder.getExecutionFact(sell.orderId),
      loss: f.daily.getLossOffset('LONG'),
      progress: h.repository.loadExecutionProgressRecords(day),
      episode: f.episode.getInProgressEpisodes(),
      events: f.events.length,
    };
    const corrected = {
      ...sell,
      executedPrice: '0.95',
      executedAmount: '95',
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    };
    failCorrection = true;
    expect(() => {
      events.handleOrderChanged(corrected);
    }).toThrow(fault);
    expect(f.recorder.getExecutionFact(sell.orderId)).toBe(before.fact);
    expect(f.daily.getLossOffset('LONG')).toBe(before.loss);
    expect(h.repository.loadExecutionProgressRecords(day)).toEqual(before.progress);
    expect(f.episode.getInProgressEpisodes()).toEqual(before.episode);
    expect(f.events).toHaveLength(before.events);
    expect(f.snapshot.getView().token).toEqual(before.token);
    expect(f.sink.getStatus()).toEqual(before.status);
    expect(h.repository.loadCompletionRecords(day)).toEqual(before.baseline);
    expect(before.candidate.isCurrent()).toBe(true);

    failCorrection = false;
    events.handleOrderChanged(corrected);
    expect(f.recorder.getExecutionFact(sell.orderId)).toMatchObject({
      cumulativeAmount: '95',
      executionTimeMs: T,
      updatedAtMs: T + 100,
    });
    expect(f.daily.getLossOffset('LONG')).toBe('0');
    expect(h.repository.loadExecutionProgressRecords(day)).toMatchObject([
      { lastExecutionTimeMs: T, orderRevisionMs: T, cumulativeAmount: '90' },
      { lastExecutionTimeMs: T, orderRevisionMs: T + 100, cumulativeAmount: '95' },
    ]);
    events.handleOrderChanged(corrected);
    expect(h.persisted).toHaveLength(2);
    expect(before.candidate.isCurrent()).toBe(false);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.events).toHaveLength(before.events);
    await f.sink.waitForFresh();
    expect(h.repository.loadCompletionRecords(day)).toEqual(before.baseline);
    expect(h.cooldownCommits()).toBe(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P1 completed boundary retains 10/120 and revision-only authority, then rejects 20/110 and illegal phase/quantity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-p1-sealed-authority-'));
  const h = await harness(root, undefined, 10);
  const { f, sell } = h;
  try {
    const events = sealProtectiveSell(h);
    await complete(h, T);
    const frozen = h.repository.loadCompletionRecords(day);
    const correction = {
      ...sell,
      executedPrice: '12',
      executedAmount: '120',
      updatedAtMs: T + 100,
      updatedAt: new Date(T + 100),
    };
    events.handleOrderChanged(correction);
    const watermark = { ...correction, updatedAtMs: T + 200, updatedAt: new Date(T + 200) };
    events.handleOrderChanged(watermark);
    expect(f.recorder.getExecutionFact(sell.orderId)).toMatchObject({
      cumulativeQuantity: 10,
      cumulativeAmount: '120',
      executionTimeMs: T,
      updatedAtMs: T + 200,
    });

    expect(
      f.daily
        .prepareProtectionBoundary({ direction: 'LONG', boundaryExecutedTimeMs: T + 1 })
        .orderBaselines.find((baseline) => baseline.orderId === sell.orderId),
    ).toMatchObject({
      cumulativeQuantity: '10',
      cumulativeAmount: '120',
      orderRevisionMs: T + 200,
    });
    expect(f.daily.getLossOffset('LONG')).toBe('0');
    const progress = h.repository.loadExecutionProgressRecords(day);
    expect(progress).toHaveLength(3);
    for (const invalid of [
      {
        ...watermark,
        executedQuantity: 20,
        executedPrice: '5.5',
        executedAmount: '110',
        executionTimeMs: T + 300,
        updatedAtMs: T + 300,
      },
      {
        ...watermark,
        executedQuantity: 9,
        executedPrice: '12',
        executedAmount: '108',
        updatedAtMs: T + 300,
      },
      { ...watermark, executedAmount: '121', executedPrice: '12.1' },
      { ...watermark, executionPhase: 'OPEN' as const, updatedAtMs: T + 300 },
    ])
      expect(() => {
        events.handleOrderChanged(invalid);
      }).toThrow();

    expect(f.recorder.getExecutionFact(sell.orderId)).toMatchObject({
      cumulativeAmount: '120',
      updatedAtMs: T + 200,
    });
    expect(h.repository.loadExecutionProgressRecords(day)).toEqual(progress);
    expect(f.episode.getInProgressEpisodes()).toEqual([]);
    expect(f.events).toHaveLength(1);
    expect(f.holds.getHoldSymbols().size).toBe(0);
    await f.sink.waitForFresh();
    expect(h.repository.loadCompletionRecords(day)).toEqual(frozen);
    expect(
      frozen[0]?.orderBaselines.find((baseline) => baseline.orderId === sell.orderId)
        ?.cumulativeAmount,
    ).toBe('90');
    expect(h.cooldownCommits()).toBe(1);
  } finally {
    await f.sink.stopAndDrain();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
