import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/** 共享执行隔离检查：初次/最终身份复核、可信终态后新鲜卖量重规划及非 protective 新提交。 */
import { describe, expect, it } from 'bun:test';
import { createOrderExecutor } from '../../../src/application/orderExecution/index.js';
import type { OrderExecutionTrackingPort } from '../../../src/application/orderExecution/types.js';
import type {
  PendingSellOrderSnapshot,
  TrackOrderParams,
} from '../../../src/domain/order/types.js';
import type { CancelOrderOutcome } from '../../../src/types/orderCancellation.js';
import type { TradeSubmitCommand } from '../../../src/types/tradeMutationPorts.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';

const nowMs = Date.parse('2026-10-07T02:00:00Z');
const oldOrder: PendingSellOrderSnapshot = {
  orderId: 'PROTECTIVE-OLD',
  symbol: 'BULL.HK',
  side: 'SELL',
  status: 'PARTIALLY_FILLED',
  orderType: 'ELO',
  isProtectiveLiquidation: true,
  submittedPrice: '0.9',
  submittedQuantity: 1500,
  executedQuantity: 500,
  submittedAt: nowMs - 1000,
};

/** broker 与 tracking 事实边界独立注入；本文件不声称覆盖静态入口或完整恢复。 */
function createHarness(params: {
  readonly cancelOutcome: CancelOrderOutcome;
  readonly pending?: PendingSellOrderSnapshot;
  readonly freshAvailable?: number;
  readonly onQuote?: (
    setPending: (orders: ReadonlyArray<PendingSellOrderSnapshot>) => void,
  ) => void;
  readonly onReplace?: (
    setPending: (orders: ReadonlyArray<PendingSellOrderSnapshot>) => void,
  ) => void;
}) {
  let pending: ReadonlyArray<PendingSellOrderSnapshot> = [params.pending ?? oldOrder];
  const submitted: TradeSubmitCommand[] = [];
  const tracked: TrackOrderParams[] = [];
  const calls: string[] = [];
  let reads = 0;
  let replaceCalls = 0;
  const monitor: OrderExecutionTrackingPort = {
    getPendingSellOrders: () => pending,
    trackOrder: (order) => {
      tracked.push(order);
    },
    cancelOrder: async (orderId) => {
      calls.push('cancel:' + orderId);
      if (params.cancelOutcome.kind === 'ALREADY_CLOSED') pending = [];

      return params.cancelOutcome;
    },
    replaceOrderPriceWithPermit: async (_id, _price, request) => {
      params.onReplace?.((orders) => {
        pending = orders;
      });

      if (request.kind === 'SIGNAL_AUTHORIZED' && !request.authorize('replaceOrder.beforeApi')) {
        return { kind: 'NOT_EXECUTED' };
      }

      replaceCalls++;
      return { kind: 'BROKER_CONFIRMED' };
    },
  };
  const executor = createOrderExecutor({
    diagnostics: createDiagnosticObserverDouble(),
    logger: createLoggerDouble(),
    readSellPositions: async () => {
      reads++;
      calls.push(`positions:${reads}`);
      const available = reads === 1 ? 1000 : (params.freshAvailable ?? 2000);
      return [
        createPositionDouble({
          symbol: 'BULL.HK',
          quantity: available,
          availableQuantity: available,
        }),
      ];
    },
    tradeMutationPort: {
      cancelOrder: async () => {
        throw new Error('cancel belongs to tracking');
      },
      replaceOrder: async () => {
        throw new Error('replace belongs to tracking');
      },
      submitOrder: async (command, onRemoteIssued) => {
        onRemoteIssued();
        calls.push('submit');
        submitted.push(command);
        return {
          kind: 'ACCEPTED' as const,
          operation: 'TradeContext.submitOrder' as const,
          requestAttempted: true as const,
          orderId: 'NON-PROTECTIVE-NEW',
        };
      },
    },
    rateLimiter: createRateLimiterDouble(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async () => {
        calls.push('quote');
        params.onQuote?.((orders) => {
          pending = orders;
        });
        return new Map([['BULL.HK', createQuoteDouble('BULL.HK', '0.91', 100)]]);
      },
    }),
    cacheManager: { clearCache: () => {} },
    orderMonitor: monitor,
    orderRecorder: createOrderRecorderDouble(),
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    tradingConfig: createTradingConfig({
      global: { ...createTradingConfig().global, tradingOrderType: 'ELO' },
    }),
    symbolRegistry: createSymbolRegistryDouble(),
    isExecutionAllowed: () => true,
    isContinuousTradingAllowed: () => true,
    now: () => new Date(nowMs),
    readCurrentTradingDayInfo: () => ({
      dateKey: '2026-10-07',
      info: { isTradingDay: true, isHalfDay: false },
    }),
  });
  const signal = {
    ...createSignal({ symbol: 'BULL.HK', action: 'SELLCALL', triggerTimeMs: nowMs }),
    quantity: 1000,
    orderTypeOverride: 'ELO' as const,
    isProtectiveLiquidation: false as const,
  };
  return {
    executor,
    signal,
    submitted,
    tracked,
    calls,
    reads: () => reads,
    replaceCalls: () => replaceCalls,
  };
}

describe('shared execution protective identity', () => {
  it('取得旧单可信终态后重读卖量，保留旧累计实绩并提交新非 protective orderId/remark', async () => {
    const f = createHarness({
      cancelOutcome: {
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: { submittedQuantity: 1500, executedQuantity: 700 },
      },
      freshAvailable: 1600,
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: ['NON-PROTECTIVE-NEW'],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(0);
    expect(f.calls).toEqual([
      'positions:1',
      'cancel:PROTECTIVE-OLD',
      'positions:2',
      'quote',
      'submit',
    ]);
    expect(f.submitted).toMatchObject([{ submittedQuantity: 1600, orderType: 'ELO' }]);
    expect(f.submitted[0]?.remark).not.toEndWith('|PL');
    expect(f.tracked).toMatchObject([
      { orderId: 'NON-PROTECTIVE-NEW', isProtectiveLiquidation: false },
    ]);
  });

  it('撤单窗口新增成交从旧需求扣除，不用初始 pending 数量重复卖出', async () => {
    const f = createHarness({
      cancelOutcome: {
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: { submittedQuantity: 1500, executedQuantity: 700 },
      },
      freshAvailable: 2500,
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: ['NON-PROTECTIVE-NEW'],
      quoteFailures: [],
    });
    expect(f.submitted).toMatchObject([{ submittedQuantity: 1800 }]);
    expect(f.replaceCalls()).toBe(0);
  });

  it.each<CancelOrderOutcome>([
    { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: null },
    { kind: 'UNKNOWN_FAILURE', errorCode: null },
    {
      kind: 'ALREADY_CLOSED',
      closedReason: 'FILLED',
      relatedBuyOrderIds: null,
      terminalExecution: { submittedQuantity: 1500, executedQuantity: 1500 },
    },
    {
      kind: 'ALREADY_CLOSED',
      closedReason: 'CANCELED',
      relatedBuyOrderIds: null,
      terminalExecution: { submittedQuantity: null, executedQuantity: 500 },
    },
    {
      kind: 'ALREADY_CLOSED',
      closedReason: 'CANCELED',
      relatedBuyOrderIds: null,
      terminalExecution: { submittedQuantity: 1500, executedQuantity: null },
    },
  ])('ACK/OPEN或终态数量不可信均不改旧单、不提交新单：%j', async (cancelOutcome) => {
    const f = createHarness({ cancelOutcome });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(0);
    expect(f.submitted).toEqual([]);
    expect(f.tracked).toEqual([]);
  });

  it('普通非 protective 同类型单张旧单保留合法 REPLACE', async () => {
    const f = createHarness({
      pending: { ...oldOrder, isProtectiveLiquidation: false },
      cancelOutcome: { kind: 'UNKNOWN_FAILURE', errorCode: null },
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: ['PROTECTIVE-OLD'],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(1);
    expect(f.submitted).toEqual([]);
  });

  it('最晚 broker attempt 的授权也复核身份，不只依赖首次规划及报价后复核', async () => {
    const f = createHarness({
      pending: { ...oldOrder, isProtectiveLiquidation: false },
      cancelOutcome: { kind: 'UNKNOWN_FAILURE', errorCode: null },
      onReplace: (setPending) => {
        setPending([oldOrder]);
      },
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(0);
    expect(f.submitted).toEqual([]);
  });

  it('撤单已结算但报价等待时出现另一 protective 旧单，不另行盲目提交', async () => {
    const f = createHarness({
      cancelOutcome: {
        kind: 'ALREADY_CLOSED',
        closedReason: 'CANCELED',
        relatedBuyOrderIds: null,
        terminalExecution: { submittedQuantity: 1500, executedQuantity: 500 },
      },
      onQuote: (setPending) => {
        setPending([{ ...oldOrder, orderId: 'LATER-PROTECTIVE' }]);
      },
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(0);
    expect(f.submitted).toEqual([]);
  });

  it('等待最终行情时旧身份变成 protective，拒绝沿用过期 REPLACE', async () => {
    const f = createHarness({
      pending: { ...oldOrder, isProtectiveLiquidation: false },
      cancelOutcome: { kind: 'UNKNOWN_FAILURE', errorCode: null },
      onQuote: (setPending) => {
        setPending([oldOrder]);
      },
    });
    expect(await f.executor.executeSignals([f.signal], () => true)).toEqual({
      executedOrderIds: [],
      quoteFailures: [],
    });
    expect(f.replaceCalls()).toBe(0);
    expect(f.submitted).toEqual([]);
  });
});
