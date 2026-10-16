import type { TradeRuntime } from '../../src/app/runtime/types.js';

/**
 * Trader 执行结果类型约束测试
 *
 * 验证执行结果只有订单 ID 单一真相，不允许重新构造 count + ids 双字段。
 */
import { describe, expect, it } from 'bun:test';
import type {
  ExecuteSignalsResult,
  SignalCallerAuthorization,
} from '../../src/types/orderExecutionPorts.js';
import type { BuySignal } from '../../src/types/signal.js';
import type { ExecutableOrderCommand } from '../../src/application/orderExecution/types.js';

describe('ExecuteSignalsResult type contract', () => {
  it('keeps the single executedOrderIds truth constructible', () => {
    const result: ExecuteSignalsResult = { executedOrderIds: ['ORDER-1'], quoteFailures: [] };
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
  side: 'BUY',
  executionPurpose: 'ORDINARY',
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
  side: 'BUY',
  executionPurpose: 'ORDINARY',
};
void symmetricMismatchedCommand;

const duplicatedSymbolIdentity: ExecutableOrderCommand = {
  kind: 'BUY',
  signal: longBuySignal,
  // @ts-expect-error 命令不得再声明独立 symbol 身份，必须读取窄 signal.symbol。
  symbol: 'OTHER.HK',
  direction: 'LONG',
  side: 'BUY',
  executionPurpose: 'ORDINARY',
};
void duplicatedSymbolIdentity;

/** 仅编译期验证实际Trader入口，未调用，不伪造SDK或默认授权。 */
function assertTraderAuthorizationContract(
  tradeRuntime: TradeRuntime,
  originalAuthorization: SignalCallerAuthorization,
): void {
  const result: Promise<ExecuteSignalsResult> = tradeRuntime.orderExecutor.executeSignals(
    [longBuySignal],
    originalAuthorization,
  );
  void result;
  // @ts-expect-error 实际Trader入口必须携带原始工作授权，不能省略。
  void tradeRuntime.orderExecutor.executeSignals([longBuySignal]);
  // @ts-expect-error 布尔值不能代替可在await后重新核验的原始授权闭包。
  void tradeRuntime.orderExecutor.executeSignals([longBuySignal], true);
}
void assertTraderAuthorizationContract;
