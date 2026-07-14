/**
 * SignalProcessor 买入风控类型边界测试
 *
 * 验证卖出信号无法调用仅属于买入链路的风险检查接口。
 */
import { describe, expect, it } from 'bun:test';
import type { SignalProcessor } from '../../src/core/signalProcessor/types.js';
import type { BuyRiskCheckContext } from '../../src/types/services.js';
import type { SellSignal } from '../../src/types/signal.js';

function rejectSellSignalAtCompileTime(
  signalProcessor: SignalProcessor,
  sellSignal: SellSignal,
  context: BuyRiskCheckContext,
): void {
  // @ts-expect-error 卖出不走买入风控，SellSignal 不得调用 applyRiskChecks。
  void signalProcessor.applyRiskChecks([sellSignal], context);
}

void rejectSellSignalAtCompileTime;

describe('SignalProcessor buy-risk type contract', () => {
  it('keeps the compile-time assertion helper available to TypeScript', () => {
    expect(typeof rejectSellSignalAtCompileTime).toBe('function');
  });
});
