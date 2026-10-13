/** 普通 SELL reason 不赋予清仓权限；真实三阶段计算保持输入不可变。 */
import { describe, expect, it } from 'bun:test';
import { processSellSignals } from '../../../src/application/ordinarySell/quantityResolver.js';
import {
  createOrderRecorderDouble,
  createPositionDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';
import type { SellSignal } from '../../../src/types/signal.js';

describe('ordinary sell reason authority', () => {
  it.each(['ordinary reason', '末日保护程序：无条件清仓', '策略称末日保护程序应清仓'])(
    'does not grant full clearance from %s',
    (reason) => {
      const signal: SellSignal = {
        symbol: 'BULL.HK',
        symbolName: 'BULL',
        seatVersion: 1,
        action: 'SELLCALL',
        reason,
      };
      const results = processSellSignals({
        signals: [signal],
        longPosition: createPositionDouble({
          symbol: 'BULL.HK',
          quantity: 1000,
          availableQuantity: 1000,
        }),
        shortPosition: null,
        longQuote: createQuoteDouble('BULL.HK', '1'),
        shortQuote: null,
        orderRecorder: createOrderRecorderDouble({
          getCostBasis: () => ({ costAmount: '2', quantity: 1 }),
          selectSellableOrders: () => ({ orders: [], totalQuantity: 0 }),
        }),
        smartCloseEnabled: true,
        smartCloseTimeoutMinutes: null,
        nowMs: Date.parse('2026-04-29T02:00:00Z'),
        isHalfDay: false,
        tradingCalendarSnapshot: new Map(),
      });
      expect(results[0]?.action).toBe('HOLD');
      expect(results[0]?.isProtectiveLiquidation).toBeFalse();
      expect(signal.action).toBe('SELLCALL');
    },
  );
});
