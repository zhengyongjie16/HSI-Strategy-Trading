/**
 * refreshHelpers 业务测试。
 * 每次 activation 独立读取订单，并用原 captured epoch 向真实 H owner 请求成对事实。
 * receipt 只证明 canonical 提交，不签 settlement ready；helper 不写缓存或订阅投影。
 */
import { describe, expect, it } from 'bun:test';
import { createRefreshHelpers } from '../../../../src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.js';
import type { RawOrderFromAPI } from '../../../../src/types/services.js';
import { createSnapshotFixture } from '../../fixtures/accountPositionSnapshot.js';
import {
  createAccountSnapshotDouble,
  createOrderRecorderDouble,
  createPositionDouble,
  createTraderDouble,
} from '../../../helpers/testDoubles.js';

const ORDER_TIME_MS = Date.parse('2026-06-11T01:00:00.000Z');

describe('refreshHelpers business flow', () => {
  it('fetches a fresh all-orders snapshot for each seat refresh', async () => {
    let fetchAllOrdersCalls = 0;
    const orderRecorder = createOrderRecorderDouble({
      fetchAllOrdersFromAPI: async (): Promise<ReadonlyArray<RawOrderFromAPI>> => {
        fetchAllOrdersCalls += 1;
        return [
          {
            orderId: `ORDER-${fetchAllOrdersCalls}`,
            symbol: 'BULL.HK',
            stockName: 'HSI RC',
            executionSide: 'BUY',
            executionStatus: 'FILLED',
            executionPhase: 'TERMINAL',
            status: 'FILLED',
            orderType: 'LO',
            price: '1',
            quantity: 100,
            executedPrice: '1',
            executedQuantity: 100,
            executedAmount: '100',
            executionTimeMs: ORDER_TIME_MS + 1000,
            updatedAtMs: ORDER_TIME_MS + 30_000,
            submittedAt: new Date(ORDER_TIME_MS),
            updatedAt: new Date(ORDER_TIME_MS + 30_000),
            remark: '',
          },
        ];
      },
    });
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const originalToken = snapshot.getView().token;
    const helpers = createRefreshHelpers({
      trader: createTraderDouble({ orderRecorder }),
      snapshot,
    });
    const first = await helpers.ensureAllOrders();
    const second = await helpers.ensureAllOrders();
    expect(fetchAllOrdersCalls).toBe(2);
    expect(first[0]?.orderId).toBe('ORDER-1');
    expect(second[0]?.orderId).toBe('ORDER-2');
    expect(snapshot.getView().token).toEqual(originalToken);
  });

  it('refreshes account and position truth for each seat refresh through current receipts without reusing earlier facts', async () => {
    let taskReadsEnabled = false;
    let accountCalls = 0;
    let positionCalls = 0;
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
      readPort: {
        getAccountSnapshot: async () => {
          if (!taskReadsEnabled) return createAccountSnapshotDouble('100000');

          accountCalls += 1;
          return createAccountSnapshotDouble(accountCalls === 1 ? '10000' : '20000');
        },
        getStockPositions: async () => {
          if (!taskReadsEnabled) return [];

          positionCalls += 1;
          return [
            createPositionDouble({
              symbol: 'BULL.HK',
              quantity: positionCalls * 100,
              availableQuantity: positionCalls * 100,
            }),
          ];
        },
      },
    });
    taskReadsEnabled = true;
    const capturedToken = snapshot.getView().token;
    const helpers = createRefreshHelpers({ trader: createTraderDouble(), snapshot });
    const firstHandle = helpers.requestAccountPositionRefresh(capturedToken.dayEpoch);
    expect(typeof firstHandle.cancel).toBe('function');
    const first = await firstHandle.result;
    if (first.status !== 'COMMITTED')
      throw new Error('first refresh must commit real paired facts');

    expect(
      snapshot.isCurrent(first.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBe(true);
    expect(first.view.account?.totalCash).toBe('10000');
    expect(first.view.positions[0]?.quantity).toBe(100);
    const second = await helpers.requestAccountPositionRefresh(capturedToken.dayEpoch).result;
    if (second.status !== 'COMMITTED')
      throw new Error('second refresh must commit real paired facts');

    expect(accountCalls).toBe(2);
    expect(positionCalls).toBe(2);
    expect(second.snapshotToken.dayEpoch).toBe(capturedToken.dayEpoch);
    expect(second.snapshotToken.snapshotGeneration).toBe(capturedToken.snapshotGeneration);
    expect(
      snapshot.isCurrent(second.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBe(true);

    expect(
      snapshot.isCurrent(first.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBe(false);
    expect(snapshot.getView().account?.totalCash).toBe('20000');
    expect(snapshot.getAvailablePosition('BULL.HK')?.quantity).toBe(200);
    expect(first.view.positions[0]?.quantity).toBe(100);
  });
});
