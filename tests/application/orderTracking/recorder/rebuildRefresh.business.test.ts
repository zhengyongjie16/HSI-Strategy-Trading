import { spyOn, describe, expect, it } from 'bun:test';

/** 重建经济回归：实际 issued H token → Daily prepare → O batch → Daily publish，与真实在线结算比较。 */

import { classifyOrdersForRebuild } from '../../../../src/domain/order/orderRecordPolicy.js';
import type { SnapshotToken } from '../../../../src/types/accountPosition.js';
import type { OrderRecord } from '../../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../../src/types/trade.js';
import {
  createMonitorConfigDouble,
  createRateLimiterDouble,
} from '../../../helpers/testDoubles.js';
import type { BrokerIngressInput } from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import { createBrokerIngressFixture } from '../../../integration/architectureRefactoringP1Native/trade/brokerIngressFixture.js';
import { createExecutionFixture } from './executionFixture.js';

const BASE_TIME_MS = Date.parse('2026-03-02T01:30:00.000Z');
const unknownSideRefreshCases: ReadonlyArray<{
  readonly label: string;
  readonly status: BrokerIngressInput['status'];
  readonly executedPrice: string;
  readonly executedAmount: string;
  readonly executedQuantity: number;
}> = [
  {
    label: 'Filled with positive execution',
    status: 'Filled',
    executedPrice: '1',
    executedAmount: '100',
    executedQuantity: 100,
  },
  {
    label: 'PartialWithdrawal with positive execution',
    status: 'PartialWithdrawal',
    executedPrice: '1',
    executedAmount: '100',
    executedQuantity: 100,
  },
  {
    label: 'PartialFilled with positive execution',
    status: 'PartialFilled',
    executedPrice: '1',
    executedAmount: '100',
    executedQuantity: 100,
  },
  {
    label: 'PartialFilled with zero execution',
    status: 'PartialFilled',
    executedPrice: '0',
    executedAmount: '0',
    executedQuantity: 0,
  },
];

async function createRebuildFixture(): Promise<
  ReturnType<typeof createExecutionFixture> & { readonly snapshotToken: SnapshotToken }
> {
  const native = await createBrokerIngressFixture({
    orderId: 'REBUILD-PORT',
    tradeId: 'REBUILD-PORT-trade',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'New',
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '0',
    submittedPrice: '1',
    executedPrice: '0',
    submittedAtMs: BASE_TIME_MS,
    executionTimeMs: null,
    updatedAtMs: BASE_TIME_MS,
  });
  native.setAccountBalance({
    currency: 'HKD',
    totalCash: '10000',
    netAssets: '10000',
    availableCash: '10000',
  });
  native.setStockPositions([]);
  const readPort = native.createAccountService({ rateLimiter: createRateLimiterDouble() });
  const f = createExecutionFixture({
    nowMs: BASE_TIME_MS,
    readPort,
    createRecorder: native.createRecorder,
  });
  const issued = f.snapshot.requestRefresh({
    source: 'ORDER_REBUILD_TEST',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  });
  const receipt = await issued.result;
  if (receipt.status !== 'COMMITTED') throw new Error('real paired snapshot refresh aborted');

  expect(
    f.snapshot.isCurrent(receipt.snapshotToken, { account: true, positions: true, paired: true }),
  ).toBe(true);
  return { ...f, snapshotToken: receipt.snapshotToken };
}

/** 只迁真实 batch 协议；捕获原 token，回调不得换成当下 token 或默认 true。 */
function publishSnapshot(
  f: Awaited<ReturnType<typeof createRebuildFixture>>,
  symbol: string,
  isLongSymbol: boolean,
  allOrders: ReadonlyArray<OrderFact>,
) {
  f.recorder.validateRebuildSnapshot(symbol, allOrders);
  const scopedOrders = allOrders.filter((order) => order.symbol === symbol);
  const prepared = f.daily.prepareRecalculationFromAllOrders(
    scopedOrders,
    createMonitorConfigDouble({ monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] }),
    new Date(BASE_TIME_MS + 10_000),
  );
  const result = f.recorder.commitRebuildSnapshot(
    [{ symbol, isLongSymbol }],
    scopedOrders,
    () =>
      f.snapshot.isCurrent(f.snapshotToken, { account: true, positions: true, paired: true }) &&
      prepared.isCurrent(),
    'REBUILD',
  );
  if (result.status === 'COMMITTED') f.daily.publishRecalculation(prepared);

  return result;
}

async function createRawOrder(params: {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL' | 'UNKNOWN';
  readonly status: BrokerIngressInput['status'];
  readonly submittedQuantity: number;
  readonly executedPrice: string;
  readonly executedAmount: string;
  readonly executedQuantity: number;
  readonly executedTimeOffsetSeconds: number;
}): Promise<OrderFact> {
  const executionTimeMs = BASE_TIME_MS + params.executedTimeOffsetSeconds * 1000;
  const frame: BrokerIngressInput = {
    orderId: params.orderId,
    tradeId: params.orderId + '-trade',
    symbol: params.symbol,
    stockName: params.symbol === 'BEAR.HK' ? 'HSI RP' : 'HSI RC',
    remark: '',
    side: params.side === 'UNKNOWN' ? 'SELL' : params.side,
    status: params.status,
    orderType: 'ELO',
    quantity: String(params.submittedQuantity),
    executedQuantity: String(params.executedQuantity),
    submittedPrice: '1',
    executedPrice: params.executedPrice,
    submittedAtMs: executionTimeMs,
    executionTimeMs: params.executedQuantity === 0 ? null : executionTimeMs,
    updatedAtMs: executionTimeMs,
  };
  const native = await createBrokerIngressFixture({
    ...frame,
    executedPrice:
      params.executedQuantity > 0 && params.executedPrice === '0' ? '1' : params.executedPrice,
  });
  native.setOrderDetailReplies([frame]);
  native.setExecutionReplies(
    params.executedQuantity === 0
      ? []
      : [
          {
            orderId: params.orderId,
            tradeId: frame.tradeId,
            symbol: params.symbol,
            quantity: String(params.executedQuantity),
            price: params.executedPrice,
            tradeDoneAtMs: executionTimeMs,
          },
        ],
  );

  if (params.side === 'UNKNOWN') native.setQuerySideUnknown();

  const issuedLedgerBeforeRead = native.readCounts();
  let observations: ReadonlyArray<OrderFact>;
  try {
    observations = await native.createQueryOrdersReader()();
  } catch (error) {
    expect(native.nativeReadCounts()).toEqual({ cancel: 0, detail: 1 });
    expect(native.readCounts()).toEqual(issuedLedgerBeforeRead);
    throw error;
  }

  const observation = observations[0];
  if (observation === undefined) throw new Error('Missing issued native order observation');

  expect(observation.executedAmount).toBe(params.executedAmount);
  return observation;
}

async function createRebuildSnapshot(params: {
  readonly prefix: string;
  readonly symbol: string;
  readonly settledBuyStatus: BrokerIngressInput['status'];
  readonly settledSellStatus: BrokerIngressInput['status'];
  readonly retainedBuyStatus: BrokerIngressInput['status'];
}): Promise<ReadonlyArray<OrderFact>> {
  const { prefix, symbol, settledBuyStatus, settledSellStatus, retainedBuyStatus } = params;
  return [
    await createRawOrder({
      orderId: `${prefix}-BUY-SETTLED`,
      symbol,
      side: 'BUY',
      status: settledBuyStatus,
      submittedQuantity: 100,
      executedPrice: '1',
      executedAmount: '40',
      executedQuantity: 40,
      executedTimeOffsetSeconds: 1,
    }),
    await createRawOrder({
      orderId: `${prefix}-SELL-SETTLED`,
      symbol,
      side: 'SELL',
      status: settledSellStatus,
      submittedQuantity: 100,
      executedPrice: '1.1',
      executedAmount: '44',
      executedQuantity: 40,
      executedTimeOffsetSeconds: 2,
    }),
    await createRawOrder({
      orderId: `${prefix}-BUY-RETAINED`,
      symbol,
      side: 'BUY',
      status: retainedBuyStatus,
      submittedQuantity: 100,
      executedPrice: '1.2',
      executedAmount: '48',
      executedQuantity: 40,
      executedTimeOffsetSeconds: 3,
    }),
    await createRawOrder({
      orderId: `${prefix}-SELL-OPEN-PARTIAL`,
      symbol,
      side: 'SELL',
      status: 'PartialFilled',
      submittedQuantity: 200,
      executedPrice: '1.3',
      executedAmount: '130',
      executedQuantity: 100,
      executedTimeOffsetSeconds: 4,
    }),
  ];
}

function applyOnlineSettlement(
  f: ReturnType<typeof createExecutionFixture>,
  symbol: string,
  isLong: boolean,
): void {
  f.commit(`${symbol}-BUY-1`, 'BUY', '1', '40', 40, 1000, symbol, isLong);
  f.commit(`${symbol}-SELL-1`, 'SELL', '1.1', '44', 40, 2000, symbol, isLong);
  f.commit(`${symbol}-BUY-2`, 'BUY', '1.2', '48', 40, 3000, symbol, isLong);
}

function summarizeOrders(orders: ReadonlyArray<OrderRecord>) {
  return orders.map((order) => ({
    costAmount: order.costAmount,
    executedQuantity: order.executedQuantity,
    executedTime: order.executedTime,
  }));
}

async function validBuy(symbol: string): Promise<OrderFact> {
  return await createRawOrder({
    orderId: 'VALID-BUY',
    symbol,
    side: 'BUY',
    status: 'Filled',
    submittedQuantity: 100,
    executedPrice: '1',
    executedAmount: '100',
    executedQuantity: 100,
    executedTimeOffsetSeconds: 1,
  });
}

describe('OrderRecorder rebuild refresh', () => {
  it('rebuilds terminal partial executions like online settlement and keeps OPEN partial sells pending', async () => {
    const rebuilt = await createRebuildFixture();
    const online = createExecutionFixture({ nowMs: BASE_TIME_MS });
    const longSnapshot = await createRebuildSnapshot({
      prefix: 'LONG',
      symbol: 'BULL.HK',
      settledBuyStatus: 'PartialWithdrawal',
      settledSellStatus: 'Canceled',
      retainedBuyStatus: 'Canceled',
    });
    const shortSnapshot = await createRebuildSnapshot({
      prefix: 'SHORT',
      symbol: 'BEAR.HK',
      settledBuyStatus: 'Canceled',
      settledSellStatus: 'PartialWithdrawal',
      retainedBuyStatus: 'PartialWithdrawal',
    });
    expect(publishSnapshot(rebuilt, 'BULL.HK', true, longSnapshot).status).toBe('COMMITTED');
    expect(publishSnapshot(rebuilt, 'BEAR.HK', false, shortSnapshot).status).toBe('COMMITTED');
    applyOnlineSettlement(online, 'BULL.HK', true);
    applyOnlineSettlement(online, 'BEAR.HK', false);
    const longRebuilt = rebuilt.recorder.getBuyOrdersForSymbol('BULL.HK', true);
    const shortRebuilt = rebuilt.recorder.getBuyOrdersForSymbol('BEAR.HK', false);
    expect(longRebuilt.map((order) => order.orderId)).toEqual(['LONG-BUY-RETAINED']);
    expect(shortRebuilt.map((order) => order.orderId)).toEqual(['SHORT-BUY-RETAINED']);
    expect(summarizeOrders(longRebuilt)).toEqual(
      summarizeOrders(online.recorder.getBuyOrdersForSymbol('BULL.HK', true)),
    );

    expect(summarizeOrders(shortRebuilt)).toEqual(
      summarizeOrders(online.recorder.getBuyOrdersForSymbol('BEAR.HK', false)),
    );

    expect(rebuilt.recorder.getCostBasis('BULL.HK', true)).toEqual({
      costAmount: '48',
      quantity: 40,
    });

    expect(rebuilt.recorder.getCostBasis('BEAR.HK', false)).toEqual({
      costAmount: '48',
      quantity: 40,
    });

    expect(
      classifyOrdersForRebuild([...longSnapshot, ...shortSnapshot]).pendingSellOrders.map(
        (order) => ({
          orderId: order.orderId,
          submittedQuantity: order.quantity,
          executedQuantity: order.executedQuantity,
        }),
      ),
    ).toEqual([
      { orderId: 'LONG-SELL-OPEN-PARTIAL', submittedQuantity: 200, executedQuantity: 100 },
      { orderId: 'SHORT-SELL-OPEN-PARTIAL', submittedQuantity: 200, executedQuantity: 100 },
    ]);
    expect(rebuilt.sink.getStatus().staleVersion).toBe(0);
    expect(
      rebuilt.snapshot.isCurrent(rebuilt.snapshotToken, {
        account: true,
        positions: true,
        paired: true,
      }),
    ).toBe(true);
    expect(rebuilt.io.calls).toEqual([]);
  });

  it('rejects a malformed positive execution before replacing existing records', async () => {
    const f = await createRebuildFixture();
    publishSnapshot(f, 'BULL.HK', true, [await validBuy('BULL.HK')]);
    const before = summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true));
    const beforeDaily = f.daily.getExecutionTimeEvidence();
    const malformed = createRawOrder({
      orderId: 'INVALID-BUY',
      symbol: 'BULL.HK',
      side: 'BUY',
      status: 'Filled',
      submittedQuantity: 100,
      executedPrice: '0',
      executedAmount: '0',
      executedQuantity: 100,
      executedTimeOffsetSeconds: 2,
    });
    let ingressError: unknown;
    try {
      await malformed;
    } catch (error) {
      ingressError = error;
    }

    expect(ingressError).toBeInstanceOf(TypeError);
    expect(ingressError).toHaveProperty(
      'message',
      '[orderMapper] invalid cumulative execution quantity/price',
    );
    expect(summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true))).toEqual(before);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
    expect(
      f.snapshot.isCurrent(f.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBeTrue();
    expect(f.sink.getStatus().staleVersion).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.io.calls).toEqual([]);
  });

  it('rejects a malformed nonzero Unknown-side execution before clearing records', async () => {
    const f = await createRebuildFixture();
    publishSnapshot(f, 'BULL.HK', true, [await validBuy('BULL.HK')]);
    const before = summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true));
    const beforeDaily = f.daily.getExecutionTimeEvidence();
    const malformed = createRawOrder({
      orderId: 'INVALID-UNKNOWN-SIDE',
      symbol: 'BULL.HK',
      side: 'UNKNOWN',
      status: 'Filled',
      submittedQuantity: 100,
      executedPrice: '0',
      executedAmount: '0',
      executedQuantity: 100,
      executedTimeOffsetSeconds: 2,
    });
    let ingressError: unknown;
    try {
      await malformed;
    } catch (error) {
      ingressError = error;
    }

    expect(ingressError).toBeInstanceOf(TypeError);
    expect(ingressError).toHaveProperty('message', '[orderMapper] unknown SDK execution side');
    expect(summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true))).toEqual(before);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
    expect(
      f.snapshot.isCurrent(f.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBeTrue();
    expect(f.sink.getStatus().staleVersion).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.io.calls).toEqual([]);
  });

  for (const unknown of unknownSideRefreshCases) {
    it(`rejects Unknown-side ${unknown.label} before clearing records`, async () => {
      const f = await createRebuildFixture();
      publishSnapshot(f, 'BULL.HK', true, [await validBuy('BULL.HK')]);
      const before = summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true));
      const beforeDaily = f.daily.getExecutionTimeEvidence();
      const malformed = createRawOrder({
        orderId: `UNKNOWN-SIDE-${unknown.label}`,
        symbol: 'BULL.HK',
        side: 'UNKNOWN',
        status: unknown.status,
        submittedQuantity: 100,
        executedPrice: unknown.executedPrice,
        executedAmount: unknown.executedAmount,
        executedQuantity: unknown.executedQuantity,
        executedTimeOffsetSeconds: 2,
      });
      let ingressError: unknown;
      try {
        await malformed;
      } catch (error) {
        ingressError = error;
      }

      expect(ingressError).toBeInstanceOf(TypeError);
      expect(ingressError).toHaveProperty('message', '[orderMapper] unknown SDK execution side');
      expect(summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true))).toEqual(before);
      expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
      expect(
        f.snapshot.isCurrent(f.snapshotToken, { account: true, positions: true, paired: true }),
      ).toBeTrue();
      expect(f.sink.getStatus().staleVersion).toBe(0);
      expect(f.events).toEqual([]);
      expect(f.io.calls).toEqual([]);
    });
  }

  it('uses the same symbol-scoped classifier failure for preflight and batch', async () => {
    const f = await createRebuildFixture();
    const beforeDaily = f.daily.getExecutionTimeEvidence();
    const beforeO = summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true));
    let preflightCalls = 0;
    let commitCalls = 0;
    const validate = f.recorder.validateRebuildSnapshot;
    const commit = f.recorder.commitRebuildSnapshot;
    spyOn(f.recorder, 'validateRebuildSnapshot').mockImplementation((...args) => {
      preflightCalls++;
      validate(...args);
    });

    spyOn(f.recorder, 'commitRebuildSnapshot').mockImplementation((...args) => {
      commitCalls++;
      return commit(...args);
    });
    const targetObservation = createRawOrder({
      orderId: 'UNKNOWN-PREFLIGHT-TARGET',
      symbol: 'BULL.HK',
      side: 'UNKNOWN',
      status: 'Filled',
      submittedQuantity: 100,
      executedPrice: '1',
      executedAmount: '100',
      executedQuantity: 100,
      executedTimeOffsetSeconds: 1,
    });
    const otherObservation = await validBuy('OTHER.HK');
    let preflightError: unknown;
    let refreshError: unknown;
    try {
      f.recorder.validateRebuildSnapshot('BULL.HK', [await targetObservation, otherObservation]);
    } catch (error) {
      preflightError = error;
    }

    try {
      publishSnapshot(f, 'BULL.HK', true, [await targetObservation, otherObservation]);
    } catch (error) {
      refreshError = error;
    }

    expect(preflightCalls).toBe(0);
    expect(commitCalls).toBe(0);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
    expect(summarizeOrders(f.recorder.getBuyOrdersForSymbol('BULL.HK', true))).toEqual(beforeO);
    expect(
      f.snapshot.isCurrent(f.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBeTrue();
    expect(f.sink.getStatus().staleVersion).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.io.calls).toEqual([]);
    expect(preflightError).toBe(refreshError);
    expect(preflightError).toBeInstanceOf(TypeError);
    expect(refreshError).toBeInstanceOf(TypeError);
    expect(preflightError instanceof Error ? preflightError.message : null).toBe(
      refreshError instanceof Error ? refreshError.message : null,
    );

    expect(preflightError instanceof Error ? preflightError.message : null).toContain(
      '[orderMapper] unknown SDK execution side',
    );
  });

  it('a real invalidated captured token aborts the whole batch without publishing Daily or O candidates', async () => {
    const f = await createRebuildFixture();
    const beforeDaily = f.daily.getExecutionTimeEvidence();
    f.snapshot.invalidate();
    expect(publishSnapshot(f, 'BULL.HK', true, [await validBuy('BULL.HK')])).toEqual({
      status: 'ABORTED',
    });
    expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)).toEqual([]);
    expect(f.daily.getExecutionTimeEvidence()).toEqual(beforeDaily);
    expect(f.sink.getStatus().staleVersion).toBe(0);
  });
});
