/** 共享执行被动诊断测试：身份只报告已取得的事实，字段构造与 observer 异常均不向业务传播。 */
import { describe, expect, it } from 'bun:test';
import { recordOrderExecutionOutcome } from '../../../src/application/orderExecution/diagnostics.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { Signal } from '../../../src/types/signal.js';

const signal: Signal = { symbol: 'BULL.HK', symbolName: null, action: 'BUYCALL' };

describe('order execution passive diagnostic fields', () => {
  it('omits unavailable identity fields and does not substitute null for invalid dates or versions', () => {
    const records: DiagnosticFields[] = [];
    const diagnostics = {
      record: (_operation: string, fields: DiagnosticFields) => records.push(fields),
    };
    for (const candidate of [
      signal,
      { ...signal, triggerTime: new Date(Number.NaN), seatVersion: Number.NaN },
    ]) {
      recordOrderExecutionOutcome(
        diagnostics,
        candidate,
        'executeSignals',
        'BLOCKED',
        'EXECUTION_GATE_CLOSED',
      );
    }

    expect(records).toEqual([
      {
        stage: 'executeSignals',
        outcome: 'BLOCKED',
        reasonCode: 'EXECUTION_GATE_CLOSED',
        symbol: 'BULL.HK',
        action: 'BUYCALL',
      },
      {
        stage: 'executeSignals',
        outcome: 'BLOCKED',
        reasonCode: 'EXECUTION_GATE_CLOSED',
        symbol: 'BULL.HK',
        action: 'BUYCALL',
      },
    ]);
  });

  it('preserves exact financial text and existing signal identity', () => {
    const records: Array<{ readonly operation: string; readonly fields: DiagnosticFields }> = [];
    const diagnostics = {
      record: (operation: string, fields: DiagnosticFields) => records.push({ operation, fields }),
    };
    const price = '0.12345678901234567890123456789';
    recordOrderExecutionOutcome(
      diagnostics,
      { ...signal, seatVersion: 7, triggerTime: new Date(1_781_234_567_890) },
      'submitOrder.brokerResult',
      'BROKER_ACCEPTED',
      'BROKER_ACCEPTED',
      () => ({ mutation: 'SUBMIT', price, orderId: 'BROKER-1', requestAttempted: true }),
    );

    expect(records).toEqual([
      {
        operation: DIAGNOSTIC_OPERATIONS.ORDER_EXECUTION_OUTCOME,
        fields: {
          stage: 'submitOrder.brokerResult',
          outcome: 'BROKER_ACCEPTED',
          reasonCode: 'BROKER_ACCEPTED',
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          seatVersion: 7,
          triggerTimeMs: 1_781_234_567_890,
          mutation: 'SUBMIT',
          price,
          orderId: 'BROKER-1',
          requestAttempted: true,
        },
      },
    ]);
  });

  it('isolates field builders, identity accessors and observer accessors as well as record calls', () => {
    let recorded = 0;
    const diagnostics = {
      record: () => {
        recorded += 1;
      },
    };
    expect(() => {
      recordOrderExecutionOutcome(
        diagnostics,
        signal,
        'submitOrder',
        'SKIPPED',
        'NO_SUBMITTABLE_QUANTITY',
        () => {
          throw new Error('field formatting failed');
        },
      );
    }).not.toThrow();
    const damagedSignal = {
      ...signal,
      get seatVersion(): number {
        throw new Error('identity read failed');
      },
    };
    expect(() => {
      recordOrderExecutionOutcome(
        diagnostics,
        damagedSignal,
        'executeSignals',
        'BLOCKED',
        'EXECUTION_GATE_CLOSED',
      );
    }).not.toThrow();
    expect(recorded).toBe(0);

    for (const observer of [
      {
        record: () => {
          throw new Error('observer failed');
        },
      },
      {
        get record(): () => void {
          throw new Error('observer accessor failed');
        },
      },
    ]) {
      expect(() => {
        recordOrderExecutionOutcome(
          observer,
          signal,
          'executeSignals',
          'BLOCKED',
          'EXECUTION_GATE_CLOSED',
        );
      }).not.toThrow();
    }
  });
});
