/**
 * RiskChecker 买入风控类型边界测试
 *
 * 验证基础买入风控只接受已路由的买入信号，不能被卖出、HOLD 或空信号调用。
 */
import { describe, expect, it } from 'bun:test';
import type { OrderRecorder, OrderCostBasis } from '../../src/types/orderRecorder.js';
import type { RiskChecker } from '../../src/types/riskCheck.js';

import type { SellSignal, Signal } from '../../src/types/signal.js';

const sellSignal: SellSignal = {
  symbol: 'BULL.HK',
  symbolName: null,
  action: 'SELLCALL',
  seatVersion: 1,
};

const holdSignal: Signal & { readonly action: 'HOLD'; readonly seatVersion: number } = {
  symbol: 'BULL.HK',
  symbolName: null,
  action: 'HOLD',
  seatVersion: 1,
};

function rejectNonBuySignalsAtCompileTime(riskChecker: RiskChecker): void {
  riskChecker.checkBeforeOrder({
    account: null,
    positions: null,
    // @ts-expect-error 卖出绝不进入买入现金或持仓风控。
    signal: sellSignal,
    orderNotional: '0',
  });

  riskChecker.checkBeforeOrder({
    account: null,
    positions: null,
    // @ts-expect-error HOLD 不提交订单，不能进入买入风控。
    signal: holdSignal,
    orderNotional: '0',
  });

  riskChecker.checkBeforeOrder({
    account: null,
    positions: null,
    // @ts-expect-error 空信号不是可执行买入，不能被静默放行。
    signal: null,
    orderNotional: '0',
  });
}

void rejectNonBuySignalsAtCompileTime;

function verifyExactReadonlyCostBasis(recorder: OrderRecorder, riskChecker: RiskChecker): void {
  const basis: OrderCostBasis | null = recorder.getCostBasis('BULL.HK', true);
  if (basis !== null) {
    const amount: string = basis.costAmount;
    const quantity: number = basis.quantity;
    // @ts-expect-error 财务成本必须是文本，不接受number投影。
    const roundedAmount: number = basis.costAmount;
    // @ts-expect-error 只读事实不得被consumer写回。
    basis.quantity = quantity;
    void amount;
    void roundedAmount;
  }

  const metrics = riskChecker.getUnrealizedLossMetrics('BULL.HK', '1.25');
  if (metrics !== null) {
    const pnl: string = metrics.unrealizedPnL;
    const marketValue: string = metrics.r2;
    void pnl;
    void marketValue;
  }
}

void verifyExactReadonlyCostBasis;

describe('RiskChecker buy-risk type contract', () => {
  it('keeps the compile-time boundary assertion helper available', () => {
    expect(typeof rejectNonBuySignalsAtCompileTime).toBe('function');
  });
});
