/**
 * 金融配置文本业务测试。
 * 验证金额配置的 10+3 边界、非金融 number 保留及金融阈值不经浮点投影。
 */
import { describe, expect, it } from 'bun:test';
import { createTradingConfig } from '../../src/config/trading/index.js';

function parse(overrides: Readonly<Record<string, string>> = {}) {
  return createTradingConfig({ env: { MONITOR_SYMBOL: 'HSI.HK', ...overrides } }).monitor;
}

describe('金融配置文本边界', () => {
  it('直接保留配置金融文本，时间配置保持 number', () => {
    const config = parse({
      TARGET_NOTIONAL: ' 9999999999.999 ',
      MAX_POSITION_NOTIONAL: '100000.001',
      MAX_UNREALIZED_LOSS_PER_SYMBOL: '0.001',
      AUTO_SEARCH_MIN_DISTANCE_PCT_BULL: '0.35000000000000000001',
      SWITCH_DISTANCE_RANGE_BULL: '0.2,0.35000000000000000002',
    });
    expect(config.targetNotional).toBe('9999999999.999');
    expect(config.maxPositionNotional).toBe('100000.001');
    expect(config.maxUnrealizedLossPerSymbol).toBe('0.001');
    expect(config.autoSearchConfig.autoSearchMinDistancePctBull).toBe('0.35000000000000000001');
    expect(config.autoSearchConfig.switchDistanceRangeBull).toEqual({
      min: '0.2',
      max: '0.35000000000000000002',
    });
    expect(config.buyIntervalSeconds).toBe(60);
  });

  it('超位、指数、非法金额均拒绝而不量化', () => {
    for (const key of [
      'TARGET_NOTIONAL',
      'MAX_POSITION_NOTIONAL',
      'MAX_UNREALIZED_LOSS_PER_SYMBOL',
    ]) {
      for (const value of ['10000000000', '1.0001', '1e3', 'NaN', '-1']) {
        expect(() => parse({ [key]: value })).toThrow(new RegExp(key));
      }
    }

    expect(() => parse({ AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL: '1.0001' })).toThrow(
      /AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL/,
    );
  });

  it('保留原金额下界和缺省规则', () => {
    expect(parse().targetNotional).toBe('10000');
    expect(parse().maxPositionNotional).toBe('100000');
    expect(parse().maxUnrealizedLossPerSymbol).toBe('0');
    expect(() => parse({ TARGET_NOTIONAL: '0.999' })).toThrow(/TARGET_NOTIONAL/);
    expect(parse({ MAX_UNREALIZED_LOSS_PER_SYMBOL: '0.000' }).maxUnrealizedLossPerSymbol).toBe('0');
  });
});
