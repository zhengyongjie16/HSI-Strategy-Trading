/**
 * app 风格显式规则注入→真实同 context snapshot/detail/push adapters→domain 经济规则的跨 owner 测试。
 * SDK 构造仅在 infra producer，交错读取不建第二 ledger；原均价金额与严格终态补价口径保持。
 */
import { describe, expect, it } from 'bun:test';
import { orderEconomics } from '../../../../src/domain/order/orderEconomics.js';
import {
  createBrokerIngressFixture,
  type BrokerIngressInput,
} from '../../../infrastructure/longbridge/trade/brokerIngressFixture.js';
import type {
  OrderPushDecoder,
  OrderExecutionPriceEvidence,
} from '../../../../src/types/orderPushPorts.js';
import type { OrderEconomics } from '../../../../src/types/orderEconomics.js';

const frame: BrokerIngressInput = {
  orderId: 'ECONOMIC',
  tradeId: 'FILL',
  symbol: 'A.HK',
  stockName: 'A',
  remark: '',
  side: 'BUY',
  status: 'PartialFilled',
  orderType: 'LO',
  quantity: '100',
  executedQuantity: '40',
  submittedPrice: '1',
  executedPrice: '1',
  submittedAtMs: 50,
  executionTimeMs: 100,
  updatedAtMs: 150,
};

describe('injected order economics actual adapter paths', () => {
  it('interleaves issued ledger, snapshot, lazy detail and native pushes through the same pure rules', async () => {
    const calls: string[] = [];
    const rules: OrderEconomics = {
      cumulativeAmount: (price, quantity) => {
        calls.push('amount');
        return orderEconomics.cumulativeAmount(price, quantity);
      },
      executionTime: (observation, executions) => {
        calls.push('time');
        return orderEconomics.executionTime(observation, executions);
      },
      compatibleTerminalPrice: (observation, executions, confirmed) => {
        calls.push('terminalPrice');
        return orderEconomics.compatibleTerminalPrice(observation, executions, confirmed);
      },
    };
    const native = await createBrokerIngressFixture(frame, rules);
    calls.length = 0;
    native.setOrderSnapshotReplies([frame], [frame]);
    native.setExecutionReplies([
      {
        orderId: frame.orderId,
        tradeId: 'FILL',
        symbol: frame.symbol,
        quantity: '40',
        price: '1',
        tradeDoneAtMs: 100,
      },
      {
        orderId: frame.orderId,
        tradeId: 'FILL',
        symbol: frame.symbol,
        quantity: '40',
        price: '1',
        tradeDoneAtMs: 100,
      },
    ]);
    const release = Promise.withResolvers<undefined>();
    native.setExecutionReadBarriers({ today: release.promise });
    const decoders: OrderPushDecoder[] = [];
    native.ports.createOrderPushPort().setOnOrderChanged((error, decoder) => {
      expect(error).toBeNull();
      decoders.push(decoder);
    });
    const detail = await native.ports.createOrderDetailReadPort().read(frame.orderId);
    const ledgerRead = native.executionLedgerPort.todayExecutions({ orderId: frame.orderId });
    const snapshotRead = native.ports
      .createOrderSnapshotReadPort({
        rateLimiter: { throttle: async () => {} },
        executionLedgerPort: native.executionLedgerPort,
      })
      .fetchSnapshots();
    try {
      native.emitOrderChangedFrame(frame);
      native.emitOrderChangedFrame({
        ...frame,
        status: 'Canceled',
        executedPrice: '0',
        updatedAtMs: 200,
      });
      expect(decoders).toHaveLength(2);
      expect(decoders[0]!.inspect().executedQuantity).toBe(40);
      expect(decoders[1]!.inspect().updatedAtMs).toBe(200);
      expect(native.readCounts().today).toBeGreaterThanOrEqual(2);
      expect(calls).toEqual([]);
    } finally {
      release.resolve();
    }

    const executions = await ledgerRead;
    const current = detail.decode(executions);
    const confirmed: OrderExecutionPriceEvidence = {
      brokerOrderId: current.orderId,
      symbol: current.symbol,
      side: current.executionSide,
      phase: current.executionPhase,
      cumulativeQuantity: current.executedQuantity,
      cumulativeAmount: current.executedAmount,
      executionTimeMs: current.executionTimeMs,
      updatedAtMs: current.updatedAtMs,
      executedPrice: current.executedPrice,
    };
    const open = decoders[0]!.decode(executions);
    const terminal = decoders[1]!.decode(executions, confirmed);
    const snapshots = await snapshotRead;
    for (const observation of [
      current,
      open,
      terminal,
      ...snapshots.historyOrders,
      ...snapshots.todayOrders,
    ]) {
      expect(observation.executedAmount).toBe('40');
      expect(observation.executionTimeMs).toBe(100);
    }

    expect(terminal).toMatchObject({
      executedPrice: '1',
      executionPhase: 'TERMINAL',
      updatedAtMs: 200,
    });
    expect(open.executionPhase).toBe('OPEN');
    expect(calls.filter((call) => call === 'amount')).toHaveLength(5);
    expect(calls.filter((call) => call === 'time')).toHaveLength(5);
    expect(calls.filter((call) => call === 'terminalPrice')).toHaveLength(1);
  });

  it('keeps SDK average amount authoritative when actual ledger trade price differs', async () => {
    const native = await createBrokerIngressFixture(
      {
        ...frame,
        executedPrice: '1.2345678901234567890123456789',
      },
      orderEconomics,
    );
    native.setExecutionReplies([
      {
        orderId: frame.orderId,
        tradeId: 'FILL',
        symbol: frame.symbol,
        quantity: '40',
        price: '2',
        tradeDoneAtMs: 100,
      },
    ]);
    const executions = await native.executionLedgerPort.todayExecutions({ orderId: frame.orderId });
    const detail = await native.ports.createOrderDetailReadPort().read(frame.orderId);
    const fact = detail.decode(executions);
    expect(fact.executedAmount).toBe('49.382715604938271560493827156');
    expect(fact.executionTimeMs).toBe(100);
    let decoder: OrderPushDecoder | undefined;
    native.ports.createOrderPushPort().setOnOrderChanged((_error, value) => {
      decoder = value;
    });

    native.emitOrderChangedFrame({
      ...frame,
      status: 'Canceled',
      executedPrice: '0',
      updatedAtMs: 200,
    });

    expect(() =>
      decoder!.decode(executions, {
        brokerOrderId: fact.orderId,
        symbol: fact.symbol,
        side: fact.executionSide,
        phase: fact.executionPhase,
        cumulativeQuantity: fact.executedQuantity,
        cumulativeAmount: fact.executedAmount,
        executionTimeMs: fact.executionTimeMs,
        updatedAtMs: fact.updatedAtMs,
        executedPrice: fact.executedPrice,
      }),
    ).toThrow('invalid cumulative execution quantity/price');
  });

  it.each(['Canceled', 'Filled'] as const)(
    'preserves same-quantity missing-price acceptance and refusal controls for %s',
    async (status) => {
      const native = await createBrokerIngressFixture(frame, orderEconomics);
      const executions = await native.executionLedgerPort.todayExecutions({
        orderId: frame.orderId,
      });
      const confirmed: OrderExecutionPriceEvidence = {
        brokerOrderId: frame.orderId,
        symbol: frame.symbol,
        side: 'BUY',
        phase: 'OPEN',
        cumulativeQuantity: 40,
        cumulativeAmount: '40',
        executionTimeMs: 100,
        updatedAtMs: 150,
        executedPrice: '1',
      };
      let decoder: OrderPushDecoder | undefined;
      native.ports.createOrderPushPort().setOnOrderChanged((_error, value) => {
        decoder = value;
      });

      for (const missing of [false, true]) {
        const terminalNative = await createBrokerIngressFixture(
          { ...frame, status, updatedAtMs: 200 },
          orderEconomics,
        );
        const delivered: OrderPushDecoder[] = [];
        terminalNative.ports.createOrderPushPort().setOnOrderChanged((_error, value) => {
          delivered.push(value);
        });

        if (missing) terminalNative.setPushExecutedPriceMissing();
        else terminalNative.setPushExecutedPriceText('0');

        terminalNative.emitOrderChanged();
        const terminal = delivered[0]!;
        expect(terminal.decode(executions, confirmed)).toMatchObject({
          executedQuantity: 40,
          executedPrice: '1',
          executedAmount: '40',
          executionTimeMs: 100,
          executionPhase: 'TERMINAL',
          executionStatus: status === 'Filled' ? 'FILLED' : 'PARTIAL',
        });

        expect(() => terminal.decode(executions)).toThrow(
          'invalid cumulative execution quantity/price',
        );

        expect(() => terminal.decode([], confirmed)).toThrow(
          'invalid cumulative execution quantity/price',
        );

        expect(() =>
          terminal.decode(executions, { ...confirmed, cumulativeAmount: '40.000000000000000001' }),
        ).toThrow();

        expect(() =>
          terminal.decode(executions, { ...confirmed, brokerOrderId: 'other' }),
        ).toThrow();

        expect(() =>
          terminal.decode([...executions, { ...executions[0]!, price: '2' }], confirmed),
        ).toThrow('same tradeId execution conflict');
      }

      native.emitOrderChangedFrame({
        ...frame,
        status,
        executedQuantity: '41',
        executedPrice: '0',
        updatedAtMs: 200,
      });

      expect(() => decoder!.decode(executions, confirmed)).toThrow(
        'invalid cumulative execution quantity/price',
      );
    },
  );
});
