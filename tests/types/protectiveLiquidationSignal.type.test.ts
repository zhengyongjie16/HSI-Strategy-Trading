/**
 * 保护性清仓信号类型契约测试
 *
 * 验证普通 BUY/SELL 均不能携带保护性清仓语义，且保护性分支只能是 SELL + true。
 */
import { describe, expect, it } from 'bun:test';
import type {
  BuySignal,
  ExecutableSignal,
  ProtectiveLiquidationSellSignal,
  SellSignal,
} from '../../src/types/signal.js';

const ordinaryBuy: BuySignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'BUYCALL',
  seatVersion: 1,
  isProtectiveLiquidation: false,
};
void ordinaryBuy;

const illegalProtectiveBuy: BuySignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'BUYCALL',
  seatVersion: 1,
  // @ts-expect-error BUY 不得携带保护性清仓语义。
  isProtectiveLiquidation: true,
};
void illegalProtectiveBuy;

const ordinarySell: SellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  isProtectiveLiquidation: false,
};
void ordinarySell;

const ordinarySellWithNullProtectiveMarker: SellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  isProtectiveLiquidation: null,
};
void ordinarySellWithNullProtectiveMarker;

const illegalProtectiveOrdinarySell: SellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  // @ts-expect-error 普通 SELL 不得携带保护性清仓语义。
  isProtectiveLiquidation: true,
};
void illegalProtectiveOrdinarySell;

const protectiveSell: ProtectiveLiquidationSellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  isProtectiveLiquidation: true,
};
void protectiveSell;

const illegalProtectiveSellAction: ProtectiveLiquidationSellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  // @ts-expect-error 保护性清仓只能使用 SELL 动作。
  action: 'BUYCALL',
  seatVersion: 1,
  isProtectiveLiquidation: true,
};
void illegalProtectiveSellAction;

const illegalProtectiveSellMarker: ProtectiveLiquidationSellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  // @ts-expect-error 保护性清仓必须携带真值标记。
  isProtectiveLiquidation: false,
};
void illegalProtectiveSellMarker;

// @ts-expect-error 保护性清仓必须显式携带真值标记。
const illegalProtectiveSellWithoutMarker: ProtectiveLiquidationSellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
};
void illegalProtectiveSellWithoutMarker;

const illegalProtectiveSellWithNullMarker: ProtectiveLiquidationSellSignal = {
  symbol: 'BULL.HK',
  symbolName: 'BULL.HK',
  action: 'SELLCALL',
  seatVersion: 1,
  // @ts-expect-error 保护性清仓标记不能为 null。
  isProtectiveLiquidation: null,
};
void illegalProtectiveSellWithNullMarker;

const executableProtectiveSell: ExecutableSignal = protectiveSell;
void executableProtectiveSell;

describe('protective liquidation signal type contract', () => {
  it('keeps compile-time contract declarations available to TypeScript', () => {
    expect(true).toBeTrue();
  });
});
