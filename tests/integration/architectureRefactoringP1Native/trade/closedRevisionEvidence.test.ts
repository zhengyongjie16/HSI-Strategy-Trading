import { createLoggerDouble } from '../../../helpers/testDoubles.js';

/** closed 观察仍保存权威 revision 水位；经济投影、S stale 与资源收尾单独幂等。 */

import { expect, test } from 'bun:test';
import { createMonitorConfig } from '../../../../mock/factories/configFactory.js';
import { createEventFlow } from '../../../../src/application/orderTracking/orderMonitor/eventFlow.js';
import { createExecutionFixture } from '../../../application/orderTracking/recorder/executionFixture.js';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const now = Date.parse('2026-03-13T02:00:00.000Z');
test('closed terminal pure revision stores O/Daily watermark without economic/S/resource effects; legal amount correction still admits', async () => {
  let dailyCalls = 0;
  const native = await createBrokerIngressFixture({
    orderId: 'CLOSED',
    tradeId: 'T',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'PartialWithdrawal',
    quantity: '100',
    executedQuantity: '20',
    submittedPrice: '1.01',
    executedPrice: '1.01',
    submittedAtMs: now,
    executionTimeMs: now + 100,
    updatedAtMs: now + 200,
  });
  const f = createExecutionFixture({
    nowMs: now,
    createRecorder: native.createRecorder,
    observeDaily: (owner) => ({
      ...owner,
      recordCumulativeExecution: (...args) => {
        dailyCalls++;
        return owner.recordCumulativeExecution(...args);
      },
    }),
  });
  const monitor = createMonitorConfig({ monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] });
  f.flow.settleOrder({
    orderId: 'CLOSED',
    closedReason: 'CANCELED',
    source: 'WS',
    side: 'BUY',
    symbol: 'BULL.HK',
    monitorSymbol: monitor.monitorSymbol,
    isLongSymbol: true,
    isProtectiveLiquidation: false,
    executedQuantity: 20,
    executedPrice: '1.01',
    executedAmount: '20.2',
    executedTimeMs: now + 100,
    orderUpdatedAtMs: now + 200,
  });
  expect(dailyCalls).toBe(1);
  const before = f.recorder.getExecutionFact('CLOSED');
  if (before === null) throw new Error('settled order must retain authoritative fact');

  const evidence = f.daily.getExecutionTimeEvidence();
  const record = f.recorder.getBuyOrdersForSymbol('BULL.HK', true)[0];
  const token = f.snapshot.getView().token;
  const stale = f.sink.getStatus().staleVersion;
  const events = f.events.length;
  const flow = createEventFlow({
    logger: createLoggerDouble(),
    runtime: f.runtime,
    monitorConfig: monitor,
    now: () => new Date(now + 300),
    orderRecorder: f.recorder,
    recordCumulativeExecution: (params) => {
      f.flow.recordCumulativeExecution(params);
    },
    prepareProtectiveTerminalExecution: f.flow.prepareProtectiveTerminalExecution,
    settleOrder: f.flow.settleOrder,
    cacheBootstrappingEvent: () => {
      throw new Error('unexpected bootstrap');
    },
    triggerRoute: () => {
      throw new Error('closed tail cannot wake route');
    },
  });
  const rows = await native.executionLedgerPort.todayExecutions({ orderId: 'CLOSED' });
  native.createPushPort().setOnOrderChanged((_error, decoder) => {
    flow.handleOrderChangedWhenActive(decoder.decode(rows));
  });

  native.emitOrderChangedFrame({
    orderId: 'CLOSED',
    tradeId: 'T',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'PartialWithdrawal',
    quantity: '100',
    executedQuantity: '20',
    submittedPrice: '1.01',
    executedPrice: '1.01',
    submittedAtMs: now,
    executionTimeMs: now + 100,
    updatedAtMs: now + 201,
  });
  expect(dailyCalls).toBe(2);
  expect(f.recorder.getExecutionFact('CLOSED')).toEqual({ ...before, updatedAtMs: now + 201 });
  expect(f.daily.getExecutionTimeEvidence()).toEqual(
    evidence.map((fact) => ({ ...fact, orderRevisionMs: now + 201 })),
  );
  expect(f.recorder.getBuyOrdersForSymbol('BULL.HK', true)[0]).toBe(record);
  expect(f.recorder.getCostBasis('BULL.HK', true)).toEqual({ costAmount: '20.2', quantity: 20 });
  expect(f.snapshot.getView().token).toEqual(token);
  expect(f.sink.getStatus().staleVersion).toBe(stale);
  expect(f.events).toHaveLength(events);
  native.emitOrderChangedFrame({
    orderId: 'CLOSED',
    tradeId: 'T',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: '',
    side: 'BUY',
    status: 'PartialWithdrawal',
    quantity: '100',
    executedQuantity: '20',
    submittedPrice: '1.01',
    executedPrice: '1.05',
    submittedAtMs: now,
    executionTimeMs: now + 100,
    updatedAtMs: now + 202,
  });
  expect(dailyCalls).toBe(3);
  expect(f.recorder.getExecutionFact('CLOSED')).toMatchObject({
    cumulativeAmount: '21',
    updatedAtMs: now + 202,
  });
  expect(f.sink.getStatus().staleVersion).toBe(stale + 1);
  const invalid = {
    ...native.queryObservation,
    updatedAtMs: now + 203,
    executedQuantity: 21,
    executionTimeMs: null,
  };
  expect(() => {
    flow.handleOrderChangedWhenActive(invalid);
  }).toThrow();
  expect(dailyCalls).toBe(3);
  expect(() => {
    flow.handleOrderChangedWhenActive({
      ...native.queryObservation,
      executedPrice: null,
      updatedAtMs: now + 204,
    });
  }).toThrow();
  expect(dailyCalls).toBe(3);
  expect(() => {
    flow.handleOrderChangedWhenActive({
      ...native.queryObservation,
      executedPrice: '7',
      updatedAtMs: now + 205,
    });
  }).toThrow();
  expect(dailyCalls).toBe(3);
});
