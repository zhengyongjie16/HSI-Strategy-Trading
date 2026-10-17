/**
 * 最小诊断 adapter 测试：固定结构化字段、十进制文本保真，以及旁路 logger 异常隔离。
 */
import { describe, expect, it } from 'bun:test';
import {
  DIAGNOSTIC_LOG_MESSAGE,
  DIAGNOSTIC_OPERATIONS,
} from '../../../src/constants/diagnostics.js';
import { createDiagnosticObserver } from '../../../src/infrastructure/diagnostics/index.js';

describe('createDiagnosticObserver', () => {
  it('writes one structured event without mutating owner fields or projecting financial text', () => {
    const calls: ReadonlyArray<unknown>[] = [];
    const diagnostics = createDiagnosticObserver({
      logger: {
        info: (message, extra) => {
          calls.push([message, extra]);
        },
      },
    });
    const sources = ['BUY', 'SETTLEMENT'];
    const fields = Object.freeze({
      source: 'snapshot',
      sources,
      dayEpoch: 2,
      snapshotGeneration: 3,
      snapshotCommitRevision: 5,
      durationMs: 12.5,
      amount: '0.0000000000000000001234500',
      operation: 'cannot_override_operation',
    });

    diagnostics.record(DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED, fields);

    expect(calls).toEqual([
      [DIAGNOSTIC_LOG_MESSAGE, { ...fields, operation: DIAGNOSTIC_OPERATIONS.SNAPSHOT_COMMITTED }],
    ]);
    expect(fields.operation).toBe('cannot_override_operation');
    expect(sources).toEqual(['BUY', 'SETTLEMENT']);
  });

  it('isolates every logger failure and remains usable for the next event', () => {
    let attempts = 0;
    const diagnostics = createDiagnosticObserver({
      logger: {
        info: () => {
          attempts += 1;

          throw new Error('logger unavailable');
        },
      },
    });

    expect(() => {
      diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_SUBMIT_UNKNOWN_FATAL, {
        source: 'submitFlow',
        requestAttempted: true,
      });

      diagnostics.record(DIAGNOSTIC_OPERATIONS.ORDER_TERMINAL_CONFIRMED, {
        source: 'orderMonitor',
        orderId: 'known-order',
      });
    }).not.toThrow();
    expect(attempts).toBe(2);
  });
});
