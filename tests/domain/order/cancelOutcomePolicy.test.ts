/** 撤单结果规则测试：请求接受不等于非成交终态，FILLED 不允许当作撤单成功。 */
import { describe, expect, it } from 'bun:test';
import type { CancelOrderOutcome } from '../../../src/types/orderCancellation.js';
import {
  formatCancelOutcomeTag,
  isCancelAcceptedOrTerminalNonFilledClose,
  isTerminalNonFilledCloseConfirmed,
} from '../../../src/domain/order/cancelOutcomePolicy.js';

describe('cancel outcome policy', () => {
  it('区分撤单接受、非成交关闭与成交关闭', () => {
    const accepted: CancelOrderOutcome = {
      kind: 'CANCEL_CONFIRMED',
      relatedBuyOrderIds: null,
    };
    expect(isCancelAcceptedOrTerminalNonFilledClose(accepted)).toBeTrue();
    expect(isTerminalNonFilledCloseConfirmed(accepted)).toBeFalse();
    expect(formatCancelOutcomeTag(accepted)).toBe('CANCEL_CONFIRMED');

    for (const closedReason of ['CANCELED', 'REJECTED', 'FILLED'] as const) {
      const closed: CancelOrderOutcome = {
        kind: 'ALREADY_CLOSED',
        closedReason,
        relatedBuyOrderIds: null,
        terminalExecution: { submittedQuantity: 100, executedQuantity: 0 },
      };
      expect(isCancelAcceptedOrTerminalNonFilledClose(closed)).toBe(closedReason !== 'FILLED');
      expect(isTerminalNonFilledCloseConfirmed(closed)).toBe(closedReason !== 'FILLED');
      expect(formatCancelOutcomeTag(closed)).toBe(`ALREADY_CLOSED:${closedReason}`);
    }
  });

  it('失败保留原 errorCode，只有 null 才输出 UNKNOWN', () => {
    for (const kind of ['RETRYABLE_FAILURE', 'UNKNOWN_FAILURE'] as const) {
      for (const errorCode of [null, '', 'NETWORK']) {
        const outcome: CancelOrderOutcome = { kind, errorCode };
        expect(isCancelAcceptedOrTerminalNonFilledClose(outcome)).toBeFalse();
        expect(isTerminalNonFilledCloseConfirmed(outcome)).toBeFalse();
        expect(formatCancelOutcomeTag(outcome)).toBe(`${kind}:${errorCode ?? 'UNKNOWN'}`);
      }
    }
  });
});
