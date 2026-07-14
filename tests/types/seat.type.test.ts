/**
 * SeatState 类型约束测试
 *
 * 验证席位生命周期状态、标的归属与 ACTIVE 激活时间形成不可拆分的判别联合。
 */
import { describe, expect, it } from 'bun:test';
import type { SeatState, SymbolRegistry } from '../../src/types/seat.js';

const emptySeat: SeatState = {
  symbol: null,
  status: 'EMPTY',
  lastSwitchAt: 100,
  lastSearchAt: 200,
  lastSeatActivatedAt: 300,
  callPrice: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};
void emptySeat;

const staticBootstrapSeat: SeatState = {
  symbol: 'BULL.HK',
  status: 'ACTIVE',
  lastSwitchAt: null,
  lastSearchAt: null,
  lastSeatActivatedAt: null,
  callPrice: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};
void staticBootstrapSeat;

function assertPublicMutationRejectsStaticBootstrap(symbolRegistry: SymbolRegistry): void {
  // @ts-expect-error 静态 bootstrap ACTIVE/null 只能由注册表构造期写入，不能进入 public mutation。
  symbolRegistry.updateSeatState('LONG', staticBootstrapSeat);
}
void assertPublicMutationRejectsStaticBootstrap;

describe('SeatState type contracts', () => {
  it('keeps the narrow static bootstrap member constructible', () => {
    expect(staticBootstrapSeat.status).toBe('ACTIVE');
    expect(staticBootstrapSeat.lastSeatActivatedAt).toBeNull();
  });
});

// @ts-expect-error EMPTY 不得携带席位归属标的。
const emptySeatWithSymbol: SeatState = {
  ...emptySeat,
  symbol: 'BAD.HK',
};
void emptySeatWithSymbol;

// @ts-expect-error SEARCHING 不得携带席位归属标的。
const searchingSeatWithSymbol: SeatState = {
  ...emptySeat,
  status: 'SEARCHING',
  symbol: 'BAD.HK',
};
void searchingSeatWithSymbol;

// @ts-expect-error SWITCHING 必须保留被替换席位的标的归属。
const switchingSeatWithoutSymbol: SeatState = {
  ...emptySeat,
  status: 'SWITCHING',
  symbol: null,
};
void switchingSeatWithoutSymbol;

// @ts-expect-error ACTIVATING 必须绑定等待准入的新标的。
const activatingSeatWithoutSymbol: SeatState = {
  ...emptySeat,
  status: 'ACTIVATING',
  symbol: null,
};
void activatingSeatWithoutSymbol;

// @ts-expect-error 只有无历史运行态的静态 bootstrap ACTIVE 才允许激活时间为 null。
const historicalActiveSeatWithoutActivationTime: SeatState = {
  symbol: 'BAD.HK',
  status: 'ACTIVE',
  lastSwitchAt: 100,
  lastSearchAt: null,
  lastSeatActivatedAt: null,
  callPrice: null,
  searchFailCountToday: 0,
  frozenTradingDayKey: null,
};
void historicalActiveSeatWithoutActivationTime;
