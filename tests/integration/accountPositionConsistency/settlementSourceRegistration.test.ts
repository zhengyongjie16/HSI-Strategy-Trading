import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createLoggerDouble } from '../../helpers/testDoubles.js';

/**
 * P1 订单事实来源与真实 settlement 刷新水位。
 * 真实 O/snapshot/settlement sink 检查基线不造 stale、在线事实同步登记；
 * 只验证登记和事务屏障，不启动消费，不宣称完整 readiness 或 push 自然链路。
 */

import { expect, it } from 'bun:test';
import { createPostTradeConsistencyRuntime } from '../../../src/app/runtime/createPostTradeConsistencyRuntime.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createAccountPositionSnapshot } from '../../../src/application/accountPositionSnapshot/index.js';
import { createOrderRecorder } from '../../../src/application/orderTracking/recorder/index.js';
import type { BrokerOrderExecutionFact } from '../../../src/types/orderRecorder.js';
import type { OrderFact } from '../../../src/types/trade.js';
import { createOfflineBrokerPort } from './offlinePorts.js';

it('distinguishes initial controlled coverage from online changed facts at the real global stale sink', () => {
  const io = createOfflineBrokerPort();
  const snapshot = createAccountPositionSnapshot({
    clock: { now: () => new Date() },
    diagnostics: createDiagnosticObserverDouble(),
    dayEpoch: 1,
    scheduler: { schedule: queueMicrotask },
    readPort: {
      getAccountSnapshot: async () => {
        throw new Error('registration-only case must not read account');
      },
      getStockPositions: async () => {
        throw new Error('registration-only case must not read positions');
      },
    },
    reportFatalError: (error) => {
      throw error;
    },
  });
  const termination = createTerminationRuntime({
    closeTradingGate: () => {},
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
  const settlement = createPostTradeConsistencyRuntime({
    diagnostics: createDiagnosticObserverDouble(),
    clock: { now: () => new Date() },
    logger: createLoggerDouble(),
    snapshot,
    termination,
    getProtectiveOrderReader: () => {
      throw new Error('registration-only case must not consume business refresh');
    },
    onPositionsCommitted: async () => {
      throw new Error('registration-only case must not publish subscription');
    },
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  });
  const owner = createOrderRecorder({
    logger: createLoggerDouble(),
    orderSnapshotReadPort: io.broker,
    settlementRefreshNeedRecorder: settlement,
  });
  const baseline: OrderFact = {
    orderId: 'BASELINE-BUY',
    symbol: 'SOURCE.HK',
    stockName: 'source',
    executionSide: 'BUY',
    executionStatus: 'FILLED',
    executionPhase: 'TERMINAL',
    status: 'FILLED',
    orderType: 'ELO',
    price: '1',
    quantity: 100,
    executedPrice: '1',
    executedQuantity: 100,
    executedAmount: '100',
    executionTimeMs: 1000,
    updatedAtMs: 1030,
    submittedAt: new Date(1),
    updatedAt: new Date(1030),
  };
  const targets = [{ symbol: 'SOURCE.HK', isLongSymbol: true }];
  expect(owner.commitRebuildSnapshot(targets, [baseline], () => true, 'ACTIVATION').status).toBe(
    'COMMITTED',
  );
  expect(settlement.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 0 });
  expect(snapshot.getView().token.snapshotGeneration).toBe(0);
  const secondBaseline = {
    ...baseline,
    orderId: 'REBUILD-BUY',
    executedAmount: '200',
    executedPrice: '2',
  };
  expect(
    owner.commitRebuildSnapshot(targets, [baseline, secondBaseline], () => true, 'REBUILD').status,
  ).toBe('COMMITTED');
  expect(settlement.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 0 });
  expect(snapshot.getView().token.snapshotGeneration).toBe(0);
  const original: BrokerOrderExecutionFact = {
    brokerOrderId: baseline.orderId,
    symbol: baseline.symbol,
    side: 'BUY',
    cumulativeQuantity: 100,
    cumulativeAmount: '100',
    executionTimeMs: 1000,
    updatedAtMs: 1030,
    phase: 'TERMINAL',
  };
  owner.commitExecutionFact(original, true, [], () => 'DUPLICATE');
  expect(owner.getExecutionFact(original.brokerOrderId)).toEqual(original);
  expect(settlement.getStatus().staleVersion).toBe(0);
  const correction = { ...original, cumulativeAmount: '100.0000000000000001', updatedAtMs: 1040 };
  const appendFailure = new Error('offline durable append rejected');
  expect(() => {
    owner.commitExecutionFact(correction, true, [], () => {
      throw appendFailure;
    });
  }).toThrow(appendFailure);
  expect(owner.getExecutionFact(original.brokerOrderId)).toEqual(original);
  expect(owner.getCostBasis('SOURCE.HK', true)).toEqual({ costAmount: '300', quantity: 200 });
  expect(settlement.getStatus().staleVersion).toBe(0);
  expect(snapshot.getView().token.snapshotGeneration).toBe(0);
  let durableAccepted = false;
  owner.commitExecutionFact(correction, true, [], () => {
    expect(owner.getExecutionFact(original.brokerOrderId)).toEqual(original);
    expect(settlement.getStatus().staleVersion).toBe(0);
    durableAccepted = true;
    return 'ADMITTED';
  });
  expect(durableAccepted).toBe(true);
  // 同量合法金额修订只推进金额；数量与阶段未变。
  expect(owner.getExecutionFact(baseline.orderId)).toEqual(correction);
  expect(settlement.getStatus()).toMatchObject({ currentVersion: 0, staleVersion: 1 });
  expect(snapshot.getView().token.snapshotGeneration).toBe(1);
  expect(owner.getCostBasis('SOURCE.HK', true)).toEqual({
    costAmount: '300.0000000000000001',
    quantity: 200,
  });

  owner.commitExecutionFact(correction, true, [], () => 'DUPLICATE');
  expect(owner.getExecutionFact(baseline.orderId)).toEqual(correction);
  expect(settlement.getStatus().staleVersion).toBe(1);
  const advance = {
    ...correction,
    cumulativeQuantity: 200,
    cumulativeAmount: '200.0000000000000002',
    executionTimeMs: 1050,
    updatedAtMs: 1050,
  };
  owner.commitExecutionFact(advance, true, [], () => 'ADMITTED');
  expect(owner.getExecutionFact(baseline.orderId)?.cumulativeQuantity).toBe(200);
  expect(settlement.getStatus().staleVersion).toBe(2);
  expect(snapshot.getView().token.snapshotGeneration).toBe(2);
  owner.commitExecutionFact(advance, true, [], () => 'DUPLICATE');
  expect(owner.getExecutionFact(baseline.orderId)).toEqual(advance);
  expect(settlement.getStatus().staleVersion).toBe(2);
  const partial: BrokerOrderExecutionFact = {
    brokerOrderId: 'ONLINE-PARTIAL',
    symbol: 'SOURCE.HK',
    side: 'BUY',
    cumulativeQuantity: 50,
    cumulativeAmount: '50',
    executionTimeMs: 1100,
    updatedAtMs: 1100,
    phase: 'OPEN',
  };
  const projectedBeforePartial = owner.getCostBasis('SOURCE.HK', true);
  owner.commitExecutionFact(partial, true, [], () => 'ADMITTED');
  // OPEN partial 只记权威事实，不推进经济投影。
  expect(owner.getExecutionFact('ONLINE-PARTIAL')).toEqual(partial);
  expect(owner.getCostBasis('SOURCE.HK', true)).toEqual(projectedBeforePartial);
  expect(settlement.getStatus().staleVersion).toBe(3);
  const terminal = { ...partial, phase: 'TERMINAL' as const, updatedAtMs: 1110 };
  owner.commitExecutionFact(terminal, true, [], () => 'ADMITTED');
  expect(owner.getExecutionFact('ONLINE-PARTIAL')?.cumulativeQuantity).toBe(50);
  expect(owner.getCostBasis('SOURCE.HK', true)).toEqual({
    costAmount: '450.0000000000000002',
    quantity: 350,
  });
  expect(settlement.getStatus().staleVersion).toBe(4);
  expect(snapshot.getView().token.snapshotGeneration).toBe(4);
  owner.commitExecutionFact(terminal, true, [], () => 'DUPLICATE');
  expect(settlement.getStatus().staleVersion).toBe(4);
  expect(io.calls).toEqual([]);
});
