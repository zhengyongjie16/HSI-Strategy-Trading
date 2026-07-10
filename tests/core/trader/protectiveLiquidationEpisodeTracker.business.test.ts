/**
 * protectiveLiquidationEpisodeTracker 业务测试
 *
 * 功能：
 * - 验证保护性清仓进行中 episode 的记录与恢复必须保留原始 symbol，不允许同 direction 静默覆盖。
 */
import { describe, expect, it } from 'bun:test';
import { createProtectiveLiquidationEpisodeTracker } from '../../../src/core/trader/protectiveLiquidationEpisodeTracker/index.js';

describe('protectiveLiquidationEpisodeTracker business flow', () => {
  it('fails fast when record path sees a different symbol for the same in-progress direction', () => {
    const tracker = createProtectiveLiquidationEpisodeTracker();
    tracker.recordProtectiveFillProgress({
      direction: 'LONG',
      symbol: 'BULL.OLD.HK',
      executedTimeMs: 1_000,
    });

    expect(() => {
      tracker.recordProtectiveFillProgress({
        direction: 'LONG',
        symbol: 'BULL.NEW.HK',
        executedTimeMs: 2_000,
      });
    }).toThrow(/LONG.*BULL\.OLD\.HK.*BULL\.NEW\.HK/);

    expect(tracker.getInProgressEpisodes()).toEqual([
      {
        direction: 'LONG',
        symbol: 'BULL.OLD.HK',
        latestExecutedTimeMs: 1_000,
      },
    ]);
  });

  it('fails fast when restore path sees a different symbol for the same in-progress direction', () => {
    const tracker = createProtectiveLiquidationEpisodeTracker();
    tracker.restoreInProgressEpisode({
      direction: 'SHORT',
      symbol: 'BEAR.OLD.HK',
      latestExecutedTimeMs: 1_000,
    });

    expect(() => {
      tracker.restoreInProgressEpisode({
        direction: 'SHORT',
        symbol: 'BEAR.NEW.HK',
        latestExecutedTimeMs: 2_000,
      });
    }).toThrow(/SHORT.*BEAR\.OLD\.HK.*BEAR\.NEW\.HK/);

    expect(tracker.getInProgressEpisodes()).toEqual([
      {
        direction: 'SHORT',
        symbol: 'BEAR.OLD.HK',
        latestExecutedTimeMs: 1_000,
      },
    ]);
  });
});
