/**
 * 末日窗口领域测试
 *
 * 覆盖正常日/半日市拒买、接管及严格收盘前重评估边界，不改变授权和时间归属语义。
 */
import { describe, expect, it } from 'bun:test';
import {
  getDoomsdayBuyCutoffWindowRangeLabel,
  getDoomsdayClearanceTakeoverWindowRangeLabel,
  hasReachedDoomsdayBuyCutoff,
  isWithinDoomsdayBuyCutoffWindow,
  isWithinDoomsdayClearanceTakeoverWindow,
  resolveDoomsdayRetryAtMs,
  resolveDoomsdayWindowEntryMs,
} from '../../../../src/domain/liquidation/doomsday/index.js';

describe('末日窗口领域规则', () => {
  it('正常日与半日市共用收盘前 15/5 分钟规则，收盘后只保留最终拒买判定', () => {
    for (const { isHalfDay, hour } of [
      { isHalfDay: false, hour: 16 },
      { isHalfDay: true, hour: 12 },
    ]) {
      const close = new Date(`2026-04-29T${hour}:00:00.000+08:00`);
      const cutoff = new Date(close.getTime() - 15 * 60_000);
      const takeover = new Date(close.getTime() - 5 * 60_000);
      expect(resolveDoomsdayWindowEntryMs(cutoff, isHalfDay)).toEqual([
        cutoff.getTime(),
        takeover.getTime(),
      ]);

      expect(isWithinDoomsdayBuyCutoffWindow(new Date(cutoff.getTime() - 1), isHalfDay)).toBe(
        false,
      );
      expect(isWithinDoomsdayBuyCutoffWindow(cutoff, isHalfDay)).toBe(true);
      expect(
        isWithinDoomsdayClearanceTakeoverWindow(new Date(takeover.getTime() - 1), isHalfDay),
      ).toBe(false);
      expect(isWithinDoomsdayClearanceTakeoverWindow(takeover, isHalfDay)).toBe(true);
      expect(isWithinDoomsdayBuyCutoffWindow(close, isHalfDay)).toBe(false);
      expect(isWithinDoomsdayClearanceTakeoverWindow(close, isHalfDay)).toBe(false);
      expect(hasReachedDoomsdayBuyCutoff(close, isHalfDay)).toBe(true);
      expect(getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay)).toBe(`${hour - 1}:45-${hour}:00`);
      expect(getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay)).toBe(
        `${hour - 1}:55-${hour}:00`,
      );
    }
  });

  it('重评估必须在未来且严格早于收盘，无效时刻不产生候选', () => {
    for (const { isHalfDay, hour } of [
      { isHalfDay: false, hour: 16 },
      { isHalfDay: true, hour: 12 },
    ]) {
      const close = new Date(`2026-04-29T${hour}:00:00.000+08:00`).getTime();
      const now = new Date(close - 200);
      expect(resolveDoomsdayRetryAtMs(now, isHalfDay, close - 1)).toBe(close - 1);
      expect(resolveDoomsdayRetryAtMs(now, isHalfDay, close)).toBeNull();
      expect(resolveDoomsdayRetryAtMs(now, isHalfDay, now.getTime())).toBeNull();
      expect(resolveDoomsdayRetryAtMs(now, isHalfDay, Number.NaN)).toBeNull();
    }

    expect(isWithinDoomsdayBuyCutoffWindow(new Date(Number.NaN))).toBe(false);
    expect(isWithinDoomsdayClearanceTakeoverWindow(null)).toBe(false);
    expect(resolveDoomsdayRetryAtMs(new Date(Number.NaN), false, 1)).toBeNull();
  });
});
