/**
 * 订单 mutation 不可重试错误事实回归。
 * 验证 UNKNOWN 不会退化为外部请求失败，已接受订单的本地同步失败保留身份与原始 cause。
 */
import { describe, expect, it } from 'bun:test';
import {
  createAcceptedOrderLocalSyncError,
  createTradeMutationUnknownError,
} from '../../../src/application/orderExecution/tradeMutationErrors.js';
import {
  createExternalApiRequestError,
  isExternalApiRequestError,
} from '../../../src/utils/apiFailure/index.js';

describe('trade mutation fatal error facts', () => {
  it.each([
    { operation: 'TradeContext.submitOrder' as const },
    { operation: 'TradeContext.replaceOrder' as const },
    { operation: 'TradeContext.cancelOrder' as const },
  ])(
    'preserves UNKNOWN request evidence for $operation without external retry classification',
    ({ operation }) => {
      const cause = createExternalApiRequestError({
        operation,
        attempts: 1,
        cause: new Error('response lost after request issued'),
      });
      const error = createTradeMutationUnknownError({
        kind: 'UNKNOWN',
        operation,
        requestAttempted: true,
        code: 'UNKNOWN_CODE',
        cause,
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TradeMutationUnknownError');
      expect(error.operation).toBe(operation);
      expect(error.requestAttempted).toBe(true);
      expect(error.code).toBe('UNKNOWN_CODE');
      expect(error.cause).toBe(cause);
      expect(isExternalApiRequestError(error)).toBe(false);
      expect(error.message).toContain(
        operation === 'TradeContext.cancelOrder'
          ? '[撤单失败/终态未确认]'
          : '[交易请求结果不可确认]',
      );
    },
  );

  it.each([{ cause: null }, { cause: undefined }])(
    'preserves nullish UNKNOWN cause and code without a fallback',
    ({ cause }) => {
      const error = createTradeMutationUnknownError({
        kind: 'UNKNOWN',
        operation: 'TradeContext.submitOrder',
        requestAttempted: true,
        code: null,
        cause,
      });

      expect(error.cause).toBe(cause);
      expect(error.code).toBeNull();
      expect(isExternalApiRequestError(error)).toBe(false);
    },
  );

  it('preserves broker acceptance identity instead of inviting another submit', () => {
    const cause = new TypeError('local tracking invariant broken');
    const error = createAcceptedOrderLocalSyncError('ACCEPTED-001', cause);

    expect(error.name).toBe('AcceptedOrderLocalSyncError');
    expect(error.operation).toBe('TradeContext.submitOrder');
    expect(error.requestAttempted).toBe(true);
    expect(error.orderId).toBe('ACCEPTED-001');
    expect(error.cause).toBe(cause);
    expect(isExternalApiRequestError(error)).toBe(false);
  });
});
