/**
 * warrantRiskChecker 业务测试
 *
 * 功能：验证金融文本回收价的精确阈值、清算边界与查询失败后的缓存保留。
 * 查询替身只提供内部 market port，不在业务镜像中构造 SDK fixture。
 */
import { describe, expect, it } from 'bun:test';
import { createWarrantRiskChecker } from '../../../src/core/riskController/warrantRiskChecker.js';
import { exactAdd, exactSubtract } from '../../../src/utils/numeric/exact.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMarketDataClientDouble } from '../../helpers/testDoubles.js';

describe('warrantRiskChecker business boundaries', () => {
  it('accepts and rejects bull distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    // 独立十进制目标：20000 × (1 + 0.35 / 100)，不从旧 number 阈值回转。
    const passMonitorPrice = '20070';
    const pass = checker.checkRisk('BULL.HK', 'BUYCALL', passMonitorPrice);
    const fail = checker.checkRisk('BULL.HK', 'BUYCALL', exactSubtract(passMonitorPrice, '0.01'));
    expect(pass.allowed).toBeTrue();
    expect(pass.warrantInfo?.distanceToStrikePercent).toBe('0.35');
    expect(fail.allowed).toBeFalse();
    expect(fail.reason).toContain('牛证距离回收价百分比');
  });

  it('accepts and rejects bear distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BEAR.HK', '20000', false, 'BEAR.HK');
    const passMonitorPrice = '19930';
    const pass = checker.checkRisk('BEAR.HK', 'BUYPUT', passMonitorPrice);
    const fail = checker.checkRisk('BEAR.HK', 'BUYPUT', exactAdd(passMonitorPrice, '0.01'));
    expect(pass.allowed).toBeTrue();
    expect(pass.warrantInfo?.distanceToStrikePercent).toBe('-0.35');
    expect(fail.allowed).toBeFalse();
    expect(fail.reason).toContain('熊证距离回收价百分比');
  });

  it('rejects invalid monitor price', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    const result = checker.checkRisk('BULL.HK', 'BUYCALL', '0.99');
    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('监控标的价格异常');
  });

  it('triggers liquidation around bull/bear liquidation thresholds', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    checker.setWarrantInfoFromCallPrice('BEAR.HK', '20000', false, 'BEAR.HK');
    expect(checker.checkWarrantDistanceLiquidation('BULL.HK', true, '20060')).toMatchObject({
      shouldLiquidate: true,
      distancePercent: '0.30',
    });

    expect(checker.checkWarrantDistanceLiquidation('BEAR.HK', false, '19940')).toMatchObject({
      shouldLiquidate: true,
      distancePercent: '-0.30',
    });

    expect(
      checker.checkWarrantDistanceLiquidation('BULL.HK', true, '20060.01').shouldLiquidate,
    ).toBeFalse();

    expect(
      checker.checkWarrantDistanceLiquidation('BEAR.HK', false, '19939.99').shouldLiquidate,
    ).toBeFalse();
  });

  it('keeps precise distance judgment without pre-rounding prices before threshold comparison', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice(
      'PRECISION-BULL.HK',
      '100.774702',
      true,
      'PRECISION-BULL.HK',
    );

    expect(
      checker.checkRisk('PRECISION-BULL.HK', 'BUYCALL', '101.12749074212671').allowed,
    ).toBeTrue();
  });

  it('keeps the previous warrant fact after the read port exhausts retries, then refreshes on the next call', async () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    const cause = new Error('network unavailable');
    const exhausted = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantQuote',
      attempts: 3,
      cause,
    });
    let queryCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => ({
        warrantList: async () => [],
        warrantQuote: async () => {
          queryCalls += 1;
          if (queryCalls === 1) throw exhausted;

          return [{ symbol: 'BULL.HK', callPrice: '19000', category: 3 }];
        },
      }),
    });
    let caught: unknown = null;
    try {
      await checker.refreshWarrantInfoForSymbol(marketDataClient, 'BULL.HK', true, 'BULL.HK');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(exhausted);
    expect(exhausted.cause).toBe(cause);
    expect(queryCalls).toBe(1);
    const before = checker.checkRisk('BULL.HK', 'BUYCALL', '20000');
    expect(before.allowed).toBeFalse();
    expect(before.reason).toContain('牛证距离回收价百分比');
    expect(
      await checker.refreshWarrantInfoForSymbol(marketDataClient, 'BULL.HK', true, 'BULL.HK'),
    ).toEqual({ status: 'ok', isWarrant: true });
    expect(queryCalls).toBe(2);
    expect(checker.checkRisk('BULL.HK', 'BUYCALL', '20000').allowed).toBeTrue();
  });

  it('keeps original distance basis for repeating ratios and represents unknown with two null fields', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '300', true);
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '301')).toEqual({
      warrantType: 'BULL',
      distanceNumerator: '1',
      distanceDenominator: '300',
    });
    checker.setWarrantInfoFromCallPrice('BEAR.HK', '300', false);
    expect(checker.getWarrantDistanceInfo(false, 'BEAR.HK', '299')).toEqual({
      warrantType: 'BEAR',
      distanceNumerator: '-1',
      distanceDenominator: '300',
    });

    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', null)).toEqual({
      warrantType: 'BULL',
      distanceNumerator: null,
      distanceDenominator: null,
    });
    expect(checker.getWarrantDistanceInfo(true, 'OTHER.HK', '301')).toBeNull();
  });

  it('keeps sub-number precision in the raw price difference without percentage scaling', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000.000000000000000001', true);
    checker.setWarrantInfoFromCallPrice('BEAR.HK', '20000.000000000000000001', false);
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000.000000000000000002')).toEqual({
      warrantType: 'BULL',
      distanceNumerator: '0.000000000000000001',
      distanceDenominator: '20000.000000000000000001',
    });

    expect(checker.getWarrantDistanceInfo(false, 'BEAR.HK', '20000')).toEqual({
      warrantType: 'BEAR',
      distanceNumerator: '-0.000000000000000001',
      distanceDenominator: '20000.000000000000000001',
    });
  });

  it('does not turn displayed bear threshold equality into permission or liquidation', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BEAR.HK', '20000', false);
    const above = checker.checkRisk('BEAR.HK', 'BUYPUT', '19930.000000000000000001');
    expect(above.allowed).toBeFalse();
    expect(above.warrantInfo?.distanceToStrikePercent).toBe('-0.35');
    expect(checker.checkRisk('BEAR.HK', 'BUYPUT', '19930').allowed).toBeTrue();
    expect(
      checker.checkWarrantDistanceLiquidation('BEAR.HK', false, '19939.999999999999999999')
        .shouldLiquidate,
    ).toBeFalse();

    expect(
      checker.checkWarrantDistanceLiquidation('BEAR.HK', false, '19940').shouldLiquidate,
    ).toBeTrue();
  });

  it('does not turn displayed threshold equality into permission for a price below the exact threshold', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    const below = checker.checkRisk('BULL.HK', 'BUYCALL', '20069.999999999999999999');
    expect(below.allowed).toBeFalse();
    expect(below.warrantInfo?.distanceToStrikePercent).toBe('0.35');
    expect(checker.checkRisk('BULL.HK', 'BUYCALL', '20070').allowed).toBeTrue();
    expect(
      checker.checkWarrantDistanceLiquidation('BULL.HK', true, '20060.000000000000000001')
        .shouldLiquidate,
    ).toBeFalse();

    expect(
      checker.checkWarrantDistanceLiquidation('BULL.HK', true, '20060').shouldLiquidate,
    ).toBeTrue();
  });

  it('fails fast for malformed internal financial text without publishing a replacement warrant fact', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    expect(() => checker.setWarrantInfoFromCallPrice('BULL.HK', 'NaN', true)).toThrow(TypeError);
    expect(() => checker.checkRisk('BULL.HK', 'BUYCALL', '2e4')).toThrow(TypeError);
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toEqual({
      warrantType: 'BULL',
      distanceNumerator: '0',
      distanceDenominator: '20000',
    });
  });

  it('retains a recognized warrant with an unknown raw call price without inventing a zero price', async () => {
    const checker = createWarrantRiskChecker();
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => ({
        warrantList: async () => [],
        warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'BULL', callPrice: null }],
      }),
    });
    expect(
      await checker.refreshWarrantInfoForSymbol(marketDataClient, 'BULL.HK', true, 'BULL.HK'),
    ).toEqual({ status: 'ok', isWarrant: true });

    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toEqual({
      warrantType: 'BULL',
      distanceNumerator: null,
      distanceDenominator: null,
    });
    const result = checker.checkRisk('BULL.HK', 'BUYCALL', '20000');

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('回收价无效（null）');
  });

  it('returns status error on invalid call price input and keeps previous warrant fact', () => {
    const checker = createWarrantRiskChecker();
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    expect(checker.setWarrantInfoFromCallPrice('BULL.HK', '0', true, 'BULL.HK')).toEqual({
      status: 'error',
      isWarrant: false,
      reason: '回收价无效（0），无法设置牛熊证信息',
    });
    const result = checker.checkRisk('BULL.HK', 'BUYCALL', '20000');
    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('牛证距离回收价百分比');
  });
});
