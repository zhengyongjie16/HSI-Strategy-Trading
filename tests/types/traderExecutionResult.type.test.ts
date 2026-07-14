/**
 * Trader 执行结果类型约束测试
 *
 * 验证执行结果只有订单 ID 单一真相，不允许重新构造 count + ids 双字段。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longbridge';
import type { ExecuteSignalsResult } from '../../src/types/trader.js';
import type { BuySignal } from '../../src/types/signal.js';
import type { ExecutableOrderCommand } from '../../src/core/trader/orderExecutor/types.js';

describe('ExecuteSignalsResult type contract', () => {
  it('keeps the single executedOrderIds truth constructible', () => {
    const result: ExecuteSignalsResult = { executedOrderIds: ['ORDER-1'] };
    expect(result.executedOrderIds).toEqual(['ORDER-1']);
  });
});

// @ts-expect-error 旧 count + ids 双真相结果不得继续构造。
const legacyResult: ExecuteSignalsResult = { submittedCount: 1, submittedOrderIds: [] };
void legacyResult;

const longBuySignal: BuySignal & { readonly action: 'BUYCALL' } = {
  symbol: 'BULL.HK',
  symbolName: null,
  action: 'BUYCALL',
  seatVersion: 1,
};

// @ts-expect-error BUYCALL 命令只能绑定 LONG，不得构造为 SHORT 身份。
const mismatchedCommand: ExecutableOrderCommand = {
  kind: 'BUY',
  signal: longBuySignal,
  direction: 'SHORT',
  side: OrderSide.Buy,
};
void mismatchedCommand;

const shortBuySignal: BuySignal & { readonly action: 'BUYPUT' } = {
  symbol: 'BEAR.HK',
  symbolName: null,
  action: 'BUYPUT',
  seatVersion: 1,
};

// @ts-expect-error BUYPUT 命令只能绑定 SHORT，不得构造为 LONG 身份。
const symmetricMismatchedCommand: ExecutableOrderCommand = {
  kind: 'BUY',
  signal: shortBuySignal,
  direction: 'LONG',
  side: OrderSide.Buy,
};
void symmetricMismatchedCommand;

const duplicatedSymbolIdentity: ExecutableOrderCommand = {
  kind: 'BUY',
  signal: longBuySignal,
  // @ts-expect-error 命令不得再声明独立 symbol 身份，必须读取窄 signal.symbol。
  symbol: 'OTHER.HK',
  direction: 'LONG',
  side: OrderSide.Buy,
};
void duplicatedSymbolIdentity;
