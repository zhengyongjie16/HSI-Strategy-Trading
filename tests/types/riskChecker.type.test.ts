/**
 * RiskChecker 买入风控类型边界测试
 *
 * 验证基础买入风控只接受已路由的买入信号，不能被卖出、HOLD 或空信号调用。
 */
import { describe, expect, it } from 'bun:test';
import type { RiskChecker } from '../../src/types/services.js';
import type { OrdinarySignal, SellSignal } from '../../src/types/signal.js';

const sellSignal: SellSignal = {
  symbol: 'BULL.HK',
  symbolName: null,
  action: 'SELLCALL',
  seatVersion: 1,
};

const holdSignal: OrdinarySignal<'HOLD'> & { readonly seatVersion: number } = {
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
    orderNotional: 0,
  });

  riskChecker.checkBeforeOrder({
    account: null,
    positions: null,
    // @ts-expect-error HOLD 不提交订单，不能进入买入风控。
    signal: holdSignal,
    orderNotional: 0,
  });

  riskChecker.checkBeforeOrder({
    account: null,
    positions: null,
    // @ts-expect-error 空信号不是可执行买入，不能被静默放行。
    signal: null,
    orderNotional: 0,
  });
}

void rejectNonBuySignalsAtCompileTime;

describe('RiskChecker buy-risk type contract', () => {
  it('keeps the compile-time boundary assertion helper available', () => {
    expect(typeof rejectNonBuySignalsAtCompileTime).toBe('function');
  });
});
