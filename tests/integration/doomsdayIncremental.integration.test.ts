/**
 * 末日增量清仓回归：真实 tracking owner、离线 broker adapter 与统一成交投影共同验证
 * 旧 SELL 保留、读仓计划跨等待防重、超时跟进交接与提交不清本地买入记录。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createOrderExecutor } from '../../src/application/orderExecution/index.js';
import { createDoomsdayClearanceWorkflow } from '../../src/application/doomsdayClearance/index.js';
import { scheduleBoundedOneShotAt } from '../../src/runtime/timer/index.js';
import { timeWakeupEvaluationProgram } from '../../src/runtime/timeWakeupEvaluationProgram/index.js';
import type { TimeWakeupEvaluationContext } from '../../src/runtime/timeWakeupEvaluationProgram/types.js';
import { createRuntimeStateFixtures } from '../helpers/runtimeStateFixtures.js';
import { wrapExternalApiRequest } from '../../src/infrastructure/externalApi/index.js';
import { wait } from '../../src/infrastructure/time/index.js';
import type { TrackOrderParams } from '../../src/domain/order/types.js';
import type { TradeMutationPort } from '../../src/types/tradeMutationPorts.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import { createExecutionFixture } from '../application/orderTracking/recorder/executionFixture.js';
import { createBrokerIngressFixture } from './architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createDiagnosticObserverDouble } from '../helpers/diagnostics.js';
import { createSnapshotFixture } from '../helpers/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../helpers/testDoubles.js';

const NOW = Date.parse('2026-07-10T07:56:00.000Z');

/** 等待真实异步 owner 到达明确事实，不用睡眠推测订单已完成。 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;

    await Promise.resolve();
  }

  throw new Error('离线 owner 未到达预期事实');
}

async function createHarness(
  options: {
    readonly available?: number;
    readonly quote?: () => Promise<ReturnType<typeof createQuoteDouble> | null>;
    readonly readPositions?: () => Promise<void>;
    readonly rateLimiter?: ReturnType<typeof createRateLimiterDouble>;
    readonly mutationPort?: (port: TradeMutationPort) => TradeMutationPort;
  } = {},
) {
  const frame = {
    orderId: 'OLD',
    tradeId: 'OLD-T',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'SELL' as const,
    orderType: 'ELO' as const,
    status: 'New' as const,
    quantity: '60',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: NOW - 1_000,
    executionTimeMs: null,
    updatedAtMs: NOW,
  };
  const native = await createBrokerIngressFixture(frame);
  native.setStockPositions([
    {
      symbol: 'BULL.HK',
      symbolName: 'BULL',
      accountChannel: 'HK',
      currency: 'HKD',
      quantity: '100',
      availableQuantity: String(options.available ?? 40),
      costPrice: '1',
    },
  ]);
  const economic = createExecutionFixture({ nowMs: NOW });
  const rateLimiter = options.rateLimiter ?? createRateLimiterDouble();
  const marketDataClient = createMarketDataClientDouble({
    getQuotes: async (symbols) =>
      new Map([...symbols].map((symbol) => [symbol, createQuoteDouble(symbol, '1', 100)])),
  });
  const config = createTradingConfig();
  const registry = createSymbolRegistryDouble();
  const monitor = native.createMonitor({
    logger: createLoggerDouble(),
    diagnostics: createDiagnosticObserverDouble(),
    wait,
    scheduleBoundedOneShotAt,
    requestExternalApi: wrapExternalApiRequest,
    rateLimiter,
    cacheManager: { clearCache: () => {}, getPendingOrders: async () => [] },
    marketDataClient,
    orderRecorder: economic.recorder,
    dailyLossTracker: economic.daily,
    orderHoldRegistry: economic.holds,
    protectiveLiquidationEpisodeTracker: economic.episode,
    persistProtectiveLiquidationExecutionProgress: () => {},
    postTradeConsistencyRuntime: economic.sink,
    tradingConfig: config,
    symbolRegistry: registry,
    termination: economic.termination,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(NOW),
    scheduleTimer: setTimeout,
    clearTimer: clearTimeout,
  });
  await monitor.initialize();
  await monitor.recoverOrderTrackingFromSnapshot([]);
  const tracked = (orderId: string, quantity = 60, symbol = 'BULL.HK'): TrackOrderParams => ({
    orderId,
    symbol,
    side: 'SELL',
    executionSide: 'SELL',
    price: '1',
    initialSubmittedPrice: '1',
    quantity,
    submittedAtMs: NOW - 1_000,
    isLongSymbol: true,
    monitorSymbol: 'HSI.HK',
    isProtectiveLiquidation: false,
    orderType: 'ELO',
  });
  const positionReader = native.ports.createSellPositionReader();
  const mutationPort = native.ports.createTradeMutationPort();
  let authorized = true;
  let reads = 0;
  const quote = options.quote;
  const executor = createOrderExecutor({
    logger: createLoggerDouble(),
    diagnostics: createDiagnosticObserverDouble(),
    readSellPositions: async (symbol) => {
      reads += 1;
      const positions = await positionReader(symbol);
      await options.readPositions?.();
      return positions;
    },
    tradeMutationPort: options.mutationPort?.(mutationPort) ?? mutationPort,
    rateLimiter,
    marketDataClient:
      quote === undefined
        ? marketDataClient
        : createMarketDataClientDouble({
            getQuotes: async () => new Map([['BULL.HK', await quote()]]),
          }),
    cacheManager: { clearCache: () => {} },
    orderMonitor: monitor,
    orderRecorder: economic.recorder,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: config,
    symbolRegistry: registry,
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(NOW),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-07-10',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  const command = {
    symbol: 'BULL.HK',
    symbolName: 'BULL',
    action: 'SELLCALL' as const,
    triggerTime: new Date(NOW),
    seatVersion: 1,
  };
  const execute = () => executor.executeDoomsdayClearanceSignals([command], () => authorized);
  function emitExecution(
    orderId: string,
    quantity: number,
    executedQuantity: number,
    status: 'PartialFilled' | 'Filled' | 'Canceled',
    side: 'BUY' | 'SELL' = 'SELL',
    offsetMs = 100,
  ): void {
    native.setExecutionReplies(
      executedQuantity > 0
        ? [
            {
              orderId,
              tradeId: `${orderId}-fill-${executedQuantity}`,
              symbol: 'BULL.HK',
              quantity: String(executedQuantity),
              price: '1',
              tradeDoneAtMs: NOW + offsetMs,
            },
          ]
        : [],
    );

    native.emitOrderChangedFrame({
      ...frame,
      orderId,
      side,
      quantity: String(quantity),
      executedQuantity: String(executedQuantity),
      status,
      executedPrice: executedQuantity > 0 ? '1' : '0',
      executionTimeMs: executedQuantity > 0 ? NOW + offsetMs : null,
      updatedAtMs: NOW + offsetMs,
    });
  }

  async function close(orderId: string, quantity: number, filled: boolean): Promise<void> {
    let terminal = false;
    const off = monitor.onOrderStateChanged((event) => {
      if (event.orderId === orderId) terminal = true;
    });
    emitExecution(orderId, quantity, filled ? quantity : 0, filled ? 'Filled' : 'Canceled');
    await until(() => terminal);
    off();
  }
  return {
    native,
    economic,
    monitor,
    executor,
    config,
    registry,
    marketDataClient,
    tracked,
    command,
    execute,
    close,
    emitExecution,
    reads: () => reads,
    revoke: () => {
      authorized = false;
    },
  };
}

describe('末日增量清仓的原 owner 有效性证明', () => {
  it('同一可卖量的并发请求只接受一单；新增后立即零成交终态仍使旧证明失效', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let quoteReads = 0;
    const f = await createHarness({
      quote: async () => {
        quoteReads += 1;
        if (quoteReads === 1) await blocked;

        return createQuoteDouble('BULL.HK', '1', 100);
      },
    });
    const first = f.execute();
    await until(() => quoteReads === 1);
    const second = f.execute();
    // 第二次读仓正在排队；先让其进入相同的读仓计划，再接受第一张单。
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.executedOrderIds).toHaveLength(1);
    expect(b).toEqual({
      executedOrderIds: [],
      reevaluationSymbols: ['BULL.HK'],
      unresolvedQuoteSymbols: [],
    });
    expect(f.native.nativeSubmitObservations().map((order) => order.quantity)).toEqual(['40']);
    const proof = f.monitor.captureSellAvailabilityGuard('BULL.HK');
    const pendingBefore = f.monitor.getPendingSellOrders('BULL.HK');
    f.monitor.trackOrder(f.tracked('ABA', 40));
    await f.close('ABA', 40, false);
    expect(f.monitor.getPendingSellOrders('BULL.HK')).toEqual(pendingBefore);
    expect(proof()).toBe(false);
    await f.monitor.teardown();
  });

  it('原证明按标的隔离；其他标的追踪不会无谓阻塞，当前标的挂单变化会失效', async () => {
    const f = await createHarness();
    f.monitor.trackOrder(f.tracked('OLD'));
    const proof = f.monitor.captureSellAvailabilityGuard('BULL.HK');
    f.monitor.trackOrder(f.tracked('OTHER', 10, 'BEAR.HK'));
    expect(proof()).toBe(true);
    f.monitor.trackOrder(f.tracked('NEW', 10));
    expect(proof()).toBe(false);
    await f.monitor.teardown();
  });

  it('读仓后或最终行情等待中发生同标的变化，旧数量不提交；原授权失效不重评估', async () => {
    for (const phase of ['READ', 'QUOTE', 'AUTHORIZATION'] as const) {
      let change: () => void = () => {};
      const f = await createHarness({
        readPositions: async () => {
          if (phase === 'READ') change();
        },
        quote: async () => {
          if (phase !== 'READ') change();

          return createQuoteDouble('BULL.HK', '1', 100);
        },
      });
      change =
        phase === 'AUTHORIZATION'
          ? f.revoke
          : () => {
              f.monitor.trackOrder(f.tracked('ADDED', 10));
            };
      const result = await f.execute();
      expect(result.executedOrderIds).toEqual([]);
      expect(result.reevaluationSymbols).toEqual(phase === 'AUTHORIZATION' ? [] : ['BULL.HK']);
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      await f.monitor.teardown();
    }
  });

  it('同标的 BUY 在读仓后或最终报价等待中真实成交，使旧计划失效并在重评估时重读', async () => {
    for (const phase of ['READ', 'QUOTE']) {
      let fillBuy = async () => {};
      const f = await createHarness({
        readPositions: async () => {
          if (phase === 'READ') await fillBuy();
        },
        quote: async () => {
          if (phase === 'QUOTE') await fillBuy();

          return createQuoteDouble('BULL.HK', '1', 100);
        },
      });
      f.monitor.trackOrder(f.tracked('OLD'));
      f.monitor.trackOrder({ ...f.tracked('LATE-BUY', 20), side: 'BUY', executionSide: 'BUY' });
      const buyStatuses: string[] = [];
      const off = f.monitor.onOrderStateChanged((event) => {
        if (event.orderId === 'LATE-BUY') buyStatuses.push(event.status);
      });
      fillBuy = async () => {
        fillBuy = async () => {};
        // 最终报价持有 mutation FIFO，推送流水读取须在 permit 释放后完成，不能在这里等待它。
        f.emitExecution('LATE-BUY', 20, 20, 'Filled', 'BUY');
        if (phase === 'READ') await until(() => buyStatuses.includes('FILLED'));

        f.native.setStockPositions([
          {
            symbol: 'BULL.HK',
            symbolName: 'BULL',
            accountChannel: 'HK',
            currency: 'HKD',
            quantity: '120',
            availableQuantity: '60',
            costPrice: '1',
          },
        ]);
      };
      let currentTime = new Date(NOW);
      const canonical = await createSnapshotFixture({
        account: createAccountSnapshotDouble('1000'),
        positions: [
          createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 40 }),
        ],
      });
      const workflow = createDoomsdayClearanceWorkflow({
        now: () => currentTime,
        logger: createLoggerDouble(),
        quoteRetryIntervalMs: 200,
      });
      const monitorContext = {
        config: f.config.monitor,
        symbolRegistry: f.registry,
        seatSwitch: { hasPendingSwitch: () => false },
      };
      const executeClearance = () =>
        workflow.executeClearance({
          currentTime,
          isHalfDay: false,
          isLive: () => true,
          positions: canonical.getView().positions,
          snapshot: canonical,
          lifecycleState: { isTradingEnabled: true },
          monitorContext,
          orderExecutor: f.executor,
          marketDataClient: f.marketDataClient,
        });
      const firstClearance = await executeClearance();
      await until(() => buyStatuses.includes('FILLED'));
      expect(firstClearance).toEqual({ executed: false, nextRetryAtMs: NOW + 200 });
      expect(f.native.nativeSubmitObservations()).toEqual([]);
      expect(buyStatuses).toEqual(['FILLED']);
      expect(f.economic.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toMatchObject([
        { orderId: 'LATE-BUY', executedQuantity: 20 },
      ]);
      // 自然成交沿 BUY 结算，不产生末日撤单成功。
      const cancelResult = await workflow.cancelPendingBuyOrders({
        currentTime,
        isHalfDay: false,
        isLive: () => true,
        monitorContext,
        cacheManager: { getPendingOrders: async () => [] },
        orderMonitor: f.monitor,
      });
      expect(cancelResult.cancelRequestAcceptedCount).toBe(0);
      expect(f.native.nativeReadCounts().cancel).toBe(0);
      currentTime = new Date(NOW + 200);
      expect(await executeClearance()).toEqual({ executed: true, nextRetryAtMs: null });
      expect(f.reads()).toBe(2);
      expect(f.native.nativeSubmitObservations().map((order) => order.quantity)).toEqual(['60']);
      off();
      await f.monitor.teardown();
    }
  });

  it('adapter entry 前新增并立即终态仍拒绝旧数量并请求重评估', async () => {
    let invalidate: () => Promise<void> = async () => {};
    const f = await createHarness({
      mutationPort: (port) => ({
        ...port,
        submitOrder: async (command, onIssued) => {
          await invalidate();
          return port.submitOrder(command, onIssued);
        },
      }),
    });
    invalidate = async () => {
      f.monitor.trackOrder(f.tracked('ENTRY-ABA', 10));
      await f.close('ENTRY-ABA', 10, false);
    };

    expect(await f.execute()).toEqual({
      executedOrderIds: [],
      reevaluationSymbols: ['BULL.HK'],
      unresolvedQuoteSymbols: [],
    });
    expect(f.native.nativeSubmitObservations()).toEqual([]);
    await f.monitor.teardown();
  });

  it('真实系统时间唤醒重新执行已失效计划，重读变化后的可卖量而非复用旧40', async () => {
    let change = () => {};
    const f = await createHarness({
      readPositions: async () => {
        change();
      },
    });
    f.monitor.trackOrder(f.tracked('OLD'));
    change = () => {
      change = () => {};
      f.monitor.trackOrder(f.tracked('ADDED', 10));
      f.native.setStockPositions([
        {
          symbol: 'BULL.HK',
          symbolName: 'BULL',
          accountChannel: 'HK',
          currency: 'HKD',
          quantity: '100',
          availableQuantity: '30',
          costPrice: '1',
        },
      ]);
    };
    let currentTime = new Date(NOW);
    const states = createRuntimeStateFixtures({
      tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
      lifecycleState: {
        currentDayKey: '2026-07-10',
        lifecycleState: 'ACTIVE',
        pendingOpenRebuild: false,
        isTradingEnabled: true,
      },
      tradingCalendarState: {},
      quoteSubscriptionState: {},
    });
    const canonical = await createSnapshotFixture({
      account: createAccountSnapshotDouble('1000'),
      positions: [
        createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 40 }),
      ],
    });
    const context: TimeWakeupEvaluationContext = {
      logger: createLoggerDouble(),
      marketDataClient: f.marketDataClient,
      cacheManager: { getPendingOrders: async () => [] },
      orderMonitor: f.monitor,
      orderExecutor: f.executor,
      ...states,
      snapshot: canonical,
      doomsdayClearanceWorkflow: createDoomsdayClearanceWorkflow({
        logger: createLoggerDouble(),
        now: () => currentTime,
        quoteRetryIntervalMs: 200,
      }),
      tradingConfig: f.config,
      monitorContext: createMonitorContextDouble({
        config: f.config.monitor,
        symbolRegistry: f.registry,
        orderRecorder: f.economic.recorder,
      }),
      tradingGateEventRuntime: {
        emitGateStateChanged: () => {},
        emitAutoSearchAuthorizationChanged: () => {},
      },
      dayLifecycleManager: {
        tick: async () => ({ nextRetryAtMs: null, pendingOpenRebuild: false }),
      },
      now: () => currentTime,
    };
    const evaluationResult = await timeWakeupEvaluationProgram(context);
    expect(evaluationResult.plan.nextWakeupAtMs).toBe(NOW + 200);
    expect(f.native.nativeSubmitObservations()).toEqual([]);
    currentTime = new Date(NOW + 200);
    await timeWakeupEvaluationProgram(context);
    expect(f.reads()).toBe(2);
    expect(f.native.nativeSubmitObservations().map((order) => order.quantity)).toEqual(['30']);
    expect(f.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
    await f.monitor.teardown();
  });

  it('缺最终行情保留缺价事实，submit UNKNOWN 直接 fatal 不查询或重提', async () => {
    const missing = await createHarness({ quote: async () => null });
    expect(await missing.execute()).toEqual({
      executedOrderIds: [],
      reevaluationSymbols: [],
      unresolvedQuoteSymbols: ['BULL.HK'],
    });
    expect(missing.native.nativeSubmitObservations()).toEqual([]);
    await missing.monitor.teardown();
    const unknown = await createHarness();
    unknown.native.setSubmitBehavior(async () => {
      throw new Error('network timeout');
    });
    await rejects(unknown.execute(), { name: 'TradeMutationUnknownError' });
    expect(unknown.native.nativeSubmitObservations()).toHaveLength(1);
    expect(unknown.reads()).toBe(1);
    expect(unknown.native.nativeReadCounts()).toEqual({ cancel: 0, detail: 0 });
    await unknown.monitor.teardown();
  });

  it('超时撤旧的 tracked 标记和终态后的 follow-up 占用均阻止末日争抢 broker 已释放量', async () => {
    let release!: () => void;
    let permitCount = 0;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await createHarness({
      available: 100,
      rateLimiter: createRateLimiterDouble({
        onMutationPermitAcquired: async () => {
          permitCount += 1;
          if (permitCount === 2) await block;
        },
      }),
    });
    // 原单已超时；ACK 后仍等原 owner 的 WebSocket 终态，不由末日撤单。
    f.monitor.trackOrder({ ...f.tracked('OLD', 100), submittedAtMs: NOW - 600_000 });
    f.economic.recorder.submitSellOrder('OLD', 'BULL.HK', 'LONG', 100, [], false, NOW - 600_000);
    f.native.setCancelBeforeReply(async () => {});
    f.monitor.startRuntime();
    await until(() => f.native.nativeReadCounts().cancel === 1);
    const cancelPendingResult = await f.execute();
    expect(cancelPendingResult.reevaluationSymbols).toEqual(['BULL.HK']);
    await f.close('OLD', 100, false);
    await until(() => permitCount === 2);
    expect(f.monitor.getPendingSellOrders('BULL.HK')).toEqual([]);
    expect(f.economic.recorder.getPendingSellSnapshot()).toMatchObject([
      { orderId: 'OLD', submittedQuantity: 100 },
    ]);
    const followupPendingResult = await f.execute();
    expect(followupPendingResult.reevaluationSymbols).toEqual(['BULL.HK']);
    expect(f.reads()).toBe(0);
    release();
    await until(() => f.native.nativeSubmitObservations().length === 1);
    expect(f.native.nativeSubmitObservations()).toMatchObject([
      { orderType: 'MO', quantity: '100' },
    ]);
    await f.monitor.teardown();
  });

  it('旧关联 SELL 先部分再全成交，新末日 SELL 后部分成交终止，保留原整单抵扣而不强求仓位量相等', async () => {
    const f = await createHarness();
    f.economic.commit('BUY-LOW', 'BUY', '1', '20', 20, -300, 'BULL.HK');
    f.economic.commit('BUY-MID', 'BUY', '2', '80', 40, -200, 'BULL.HK');
    f.economic.commit('BUY-HIGH', 'BUY', '3', '120', 40, -100, 'BULL.HK');
    const buys = () =>
      f.economic.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId);
    f.monitor.trackOrder(f.tracked('OLD'));
    f.economic.recorder.submitSellOrder(
      'OLD',
      'BULL.HK',
      'LONG',
      60,
      ['BUY-LOW', 'BUY-MID'],
      false,
      NOW - 1_000,
    );
    const result = await f.execute();
    const newId = result.executedOrderIds[0];
    if (newId === undefined) throw new Error('missing incremental doomsday SELL');

    f.emitExecution('OLD', 60, 20, 'PartialFilled');
    await until(() =>
      f.monitor
        .getPendingSellOrders('BULL.HK')
        .some((order) => order.orderId === 'OLD' && order.executedQuantity === 20),
    );
    expect(buys()).toEqual(['BUY-LOW', 'BUY-MID', 'BUY-HIGH']);
    await f.close('OLD', 60, true);
    expect(buys()).toEqual(['BUY-HIGH']);
    f.emitExecution(newId, 40, 20, 'PartialFilled', 'SELL', 200);
    await until(() =>
      f.monitor
        .getPendingSellOrders('BULL.HK')
        .some((order) => order.orderId === newId && order.executedQuantity === 20),
    );
    expect(buys()).toEqual(['BUY-HIGH']);
    let newTerminal = false;
    const off = f.monitor.onOrderStateChanged((event) => {
      if (event.orderId === newId)
        newTerminal = event.status === 'CANCELED' && event.executedQuantity === 30;
    });
    f.emitExecution(newId, 40, 30, 'Canceled', 'SELL', 300);
    await until(() => newTerminal);
    // 新单实成交 30 不足以整笔抵扣剩余的 40；不拆单，也不补记为额外全清。
    expect(buys()).toEqual(['BUY-HIGH']);
    expect(f.economic.recorder.getBuyOrdersForSymbol('BULL.HK', true)[0]?.executedQuantity).toBe(
      40,
    );

    f.native.setStockPositions([
      {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        accountChannel: 'HK',
        currency: 'HKD',
        quantity: '10',
        availableQuantity: '10',
        costPrice: '1',
      },
    ]);
    const positions = await f.native.ports.createSellPositionReader()('BULL.HK');
    expect(positions[0]?.quantity).toBe(10);
    expect(f.native.nativeSubmitObservations().map((order) => order.quantity)).toEqual(['40']);
    off();
    await f.monitor.teardown();
  });

  it('新40 accepted 和零成交终态不清买单；旧关联与新无关联成交仍按原整单规则更新', async () => {
    for (const newSellFills of [false, true]) {
      const f = await createHarness();
      f.economic.commit('BUY-LOW', 'BUY', '1', '20', 20, -300, 'BULL.HK');
      f.economic.commit('BUY-MID', 'BUY', '2', '80', 40, -200, 'BULL.HK');
      f.economic.commit('BUY-HIGH', 'BUY', '3', '120', 40, -100, 'BULL.HK');
      const buys = () =>
        f.economic.recorder.getBuyOrdersForSymbol('BULL.HK', true).map((order) => order.orderId);
      f.monitor.trackOrder(f.tracked('OLD'));
      f.economic.recorder.submitSellOrder(
        'OLD',
        'BULL.HK',
        'LONG',
        60,
        ['BUY-LOW', 'BUY-MID'],
        false,
        NOW - 1_000,
      );
      const originalBuys = buys();
      // workflow 使用真实持仓 snapshot；提交只失效账户，不改变买单或权威持仓。
      const canonical = await createSnapshotFixture({
        account: createAccountSnapshotDouble('1000'),
        positions: [
          createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 40 }),
        ],
      });
      const before = canonical.getView();
      const workflow = createDoomsdayClearanceWorkflow({
        now: () => new Date(NOW),
        logger: createLoggerDouble(),
      });
      expect(
        await workflow.executeClearance({
          currentTime: new Date(NOW),
          isHalfDay: false,
          isLive: () => true,
          positions: before.positions,
          snapshot: canonical,
          lifecycleState: { isTradingEnabled: true },
          monitorContext: {
            config: f.config.monitor,
            symbolRegistry: f.registry,
            seatSwitch: { hasPendingSwitch: () => false },
          },
          orderExecutor: f.executor,
          marketDataClient: f.marketDataClient,
        }),
      ).toEqual({ executed: true, nextRetryAtMs: null });
      expect(buys()).toEqual(originalBuys);
      expect(canonical.getView().positions).toBe(before.positions);
      expect(canonical.getView().accountValid).toBe(false);
      const newId = f.monitor
        .getPendingSellOrders('BULL.HK')
        .find((order) => order.orderId !== 'OLD')?.orderId;
      if (newId === undefined) throw new Error('missing new doomsday SELL');

      await f.close(newId, 40, newSellFills);
      expect(buys()).toEqual(newSellFills ? ['BUY-MID', 'BUY-HIGH'] : originalBuys);
      await f.close('OLD', 60, true);
      // 无关联 40 先消除低价 20，余量不足以拆 40；后续关联单仍沿原规则，不强求本地量等于 broker 仓位。
      expect(buys()).toEqual(['BUY-HIGH']);
      await f.monitor.teardown();
    }
  });
});
