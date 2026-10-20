import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createLoggerDouble } from '../../helpers/testDoubles.js';

/**
 * P1 账户等待期间同一订单 owner 的中性事实重放。
 * 真实 snapshot/recorder/risk 共享事实；这里只调用已稳定的事实入口，
 * 不冒充尚未接通的 activation 或 SDK push/settlement 自然事件链。
 */

import { expect, it } from 'bun:test';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import type { AccountSnapshot, Position } from '../../../src/types/account.js';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createOfflineBrokerPort } from './offlinePorts.js';

it('does not double a projected BUY during a real account wait and preserves total-positive available-zero truth', async () => {
  const io = createOfflineBrokerPort();
  const recorder = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: io.broker,
    settlementRefreshNeedRecorder: io.settlementRefreshNeedRecorder,
  });
  const risk = createUnrealizedLossChecker({
    maxUnrealizedLossPerSymbol: null,
    onMissingData: () => {},
  });
  const buy: BrokerOrderExecutionFact = {
    brokerOrderId: 'ACCOUNT-AWAIT-BUY',
    symbol: 'WAIT.HK',
    side: 'BUY',
    cumulativeQuantity: 100,
    cumulativeAmount: '100.0000000000000001',
    executionTimeMs: 1000,
    updatedAtMs: 1030,
    phase: 'TERMINAL',
  };
  const query: OrderFact = {
    orderId: buy.brokerOrderId,
    symbol: buy.symbol,
    stockName: 'await',
    executionSide: 'BUY',
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    price: null,
    quantity: 100,
    executedPrice: null,
    executedQuantity: 100,
    executedAmount: buy.cumulativeAmount,
    executionTimeMs: buy.executionTimeMs,
    updatedAtMs: buy.updatedAtMs,
    submittedAt: new Date(1),
    updatedAt: new Date(1030),
  };
  const account = Promise.withResolvers<AccountSnapshot>();
  let issuedReads = 0;
  const positions: ReadonlyArray<Position> = [
    {
      accountChannel: 'cash',
      symbol: 'WAIT.HK',
      symbolName: 'await',
      quantity: 100,
      availableQuantity: 0,
      currency: 'HKD',
      costPrice: '1.000000000000000001',
    },
  ];
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: () => {
        issuedReads += 1;
        return account.promise;
      },
      getStockPositions: async () => {
        issuedReads += 1;
        return positions;
      },
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  expect(
    recorder.commitRebuildSnapshot(
      [{ symbol: 'WAIT.HK', isLongSymbol: true }],
      [query],
      () => true,
      'ACTIVATION',
    ).status,
  ).toBe('COMMITTED');
  const refreshCountAfterBaseline = io.refreshNeeds.length;
  const handle = snapshot.requestRefresh({
    source: 'SEAT_ACTIVATION',
    dayEpoch: 1,
    refreshAccount: true,
    refreshPositions: true,
  });
  let completed = false;
  void handle.result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  // 前置条件：账户与持仓两个读取都已发出且均未完成，确实处在真实账户等待中。
  expect(issuedReads).toBe(2);
  for (let replay = 0; replay < 2; replay += 1) {
    recorder.commitExecutionFact(buy, true, [], () => 'DUPLICATE');
  }

  expect(completed).toBe(false);
  expect(io.refreshNeeds).toHaveLength(refreshCountAfterBaseline);
  expect(recorder.getBuyOrdersForSymbol('WAIT.HK', true)).toHaveLength(1);
  expect(recorder.getCostBasis('WAIT.HK', true)).toEqual({
    costAmount: '100.0000000000000001',
    quantity: 100,
  });

  account.resolve({
    currency: 'HKD',
    totalCash: '1000',
    netAssets: '1100.0000000000000001',
    positionValue: '100.0000000000000001',
    cashInfos: [{ currency: 'HKD', availableCash: '1000' }],
  });
  const receipt = await handle.result;
  expect(receipt.status).toBe('COMMITTED');
  expect(snapshot.getView().positions[0]?.quantity).toBe(100);
  expect(snapshot.getView().positions[0]?.availableQuantity).toBe(0);
  expect(snapshot.getAvailablePosition('WAIT.HK')).toBeNull();
  risk.publish(risk.prepare(recorder, 'WAIT.HK', true, '0'));
  expect(risk.getUnrealizedLossData('WAIT.HK')).toEqual({ r1: '100.0000000000000001', n1: 100 });
  expect(io.calls).toEqual([]);
});
