/**
 * ordinarySignalGuard 业务测试
 *
 * 功能：验证普通信号入队门禁只复用生命周期、连续交易与末日保护接管语义。
 */
import { describe, expect, it } from 'bun:test';

import { ordinarySignalGuard } from '../../../src/domain/strategy/ordinarySignalGuard.js';

describe('ordinarySignalGuard minimal gate', () => {
  it('allows ordinary signal admission when lifecycle and continuous trading gates are open', () => {
    const allowed = ordinarySignalGuard({
      tradingTimeState: { canTrade: true, isHalfDay: false },
      lifecycleState: { isTradingEnabled: true },
      now: new Date('2026-02-16T01:31:00.000Z'),
      doomsdayProtectionEnabled: false,
    });

    expect(allowed).toBe(true);
  });

  it.each([
    { isHalfDay: false, before: '2026-02-16T07:54:59.000Z', takeover: '2026-02-16T07:55:00.000Z' },
    { isHalfDay: true, before: '2026-02-16T03:54:59.000Z', takeover: '2026-02-16T03:55:00.000Z' },
  ])(
    '只复用正常/半日清仓接管起点，不把开盘保护并入共享 gate %j',
    ({ isHalfDay, before, takeover }) => {
      const params = {
        tradingTimeState: { canTrade: true, isHalfDay },
        lifecycleState: { isTradingEnabled: true },
        tradingCalendarState: {},
        quoteSubscriptionState: {},
        doomsdayProtectionEnabled: true,
      };
      expect(ordinarySignalGuard({ ...params, now: new Date(before) })).toBe(true);
      expect(ordinarySignalGuard({ ...params, now: new Date(takeover) })).toBe(false);
      expect(
        ordinarySignalGuard({
          ...params,
          now: new Date(takeover),
          doomsdayProtectionEnabled: false,
        }),
      ).toBe(true);
    },
  );

  it('still rejects when lifecycle or continuous trading gate is closed', () => {
    expect(
      ordinarySignalGuard({
        tradingTimeState: { canTrade: true, isHalfDay: false },
        lifecycleState: { isTradingEnabled: false },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);

    expect(
      ordinarySignalGuard({
        tradingTimeState: { canTrade: false, isHalfDay: false },
        lifecycleState: { isTradingEnabled: true },
        now: new Date('2026-02-16T01:31:00.000Z'),
        doomsdayProtectionEnabled: false,
      }),
    ).toBe(false);
  });
});
