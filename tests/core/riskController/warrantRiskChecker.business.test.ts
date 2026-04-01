/**
 * warrantRiskChecker 业务测试
 *
 * 功能：
 * - 验证牛熊证距离阈值、回收价与清算边界的场景意图与业务期望。
 */
import { describe, expect, it } from 'bun:test';
import {
  BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BEAR_WARRANT_MAX_DISTANCE_PERCENT,
  BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT,
  BULL_WARRANT_MIN_DISTANCE_PERCENT,
  MIN_MONITOR_PRICE_THRESHOLD,
} from '../../../src/constants/index.js';
import { createWarrantRiskChecker } from '../../../src/core/riskController/warrantRiskChecker.js';
import type { StrategyRuntimeConfig } from '../../../src/types/config.js';
import { createStrategyRuntimeConfigDouble } from '../../helpers/testDoubles.js';

describe('warrantRiskChecker business boundaries', () => {
  it('accepts and rejects bull distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    const config = createStrategyRuntimeConfigDouble();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');

    const passMonitorPrice = 20000 * (1 + BULL_WARRANT_MIN_DISTANCE_PERCENT / 100);
    const failMonitorPrice = passMonitorPrice - 0.01;

    const pass = checker.checkRisk('BULL.HK', 'BUYCALL', passMonitorPrice, config);
    const fail = checker.checkRisk('BULL.HK', 'BUYCALL', failMonitorPrice, config);

    expect(pass.allowed).toBe(true);
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toContain('牛证距离回收价百分比');
  });

  it('accepts and rejects bear distance exactly at threshold boundaries', () => {
    const checker = createWarrantRiskChecker();
    const config = createStrategyRuntimeConfigDouble();
    checker.setWarrantInfoFromCallPrice('BEAR.HK', 20000, false, 'BEAR.HK');

    const passMonitorPrice = 20000 * (1 + BEAR_WARRANT_MAX_DISTANCE_PERCENT / 100);
    const failMonitorPrice = passMonitorPrice + 0.01;

    const pass = checker.checkRisk('BEAR.HK', 'BUYPUT', passMonitorPrice, config);
    const fail = checker.checkRisk('BEAR.HK', 'BUYPUT', failMonitorPrice, config);

    expect(pass.allowed).toBe(true);
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toContain('熊证距离回收价百分比');
  });

  it('rejects invalid monitor price', () => {
    const checker = createWarrantRiskChecker();
    const config = createStrategyRuntimeConfigDouble();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');

    const invalidMonitor = checker.checkRisk(
      'BULL.HK',
      'BUYCALL',
      MIN_MONITOR_PRICE_THRESHOLD - 0.01,
      config,
    );

    expect(invalidMonitor.allowed).toBe(false);
    expect(invalidMonitor.reason).toContain('监控标的价格异常');
  });

  it('triggers liquidation around bull/bear liquidation thresholds', () => {
    const checker = createWarrantRiskChecker();
    const config = createStrategyRuntimeConfigDouble();
    checker.setWarrantInfoFromCallPrice('BULL.HK', 20000, true, 'BULL.HK');
    checker.setWarrantInfoFromCallPrice('BEAR.HK', 20000, false, 'BEAR.HK');

    const bullTriggerPrice = 20000 * (1 + BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT / 100);
    const bearTriggerPrice = 20000 * (1 + BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT / 100);

    const bullResult = checker.checkWarrantDistanceLiquidation(
      'BULL.HK',
      true,
      bullTriggerPrice,
      config,
    );
    const bearResult = checker.checkWarrantDistanceLiquidation(
      'BEAR.HK',
      false,
      bearTriggerPrice,
      config,
    );

    expect(bullResult.shouldLiquidate).toBe(true);
    expect(bearResult.shouldLiquidate).toBe(true);
  });

  it('keeps precise distance judgment without pre-rounding prices before threshold comparison', () => {
    const checker = createWarrantRiskChecker();
    const config = createStrategyRuntimeConfigDouble();
    checker.setWarrantInfoFromCallPrice('PRECISION-BULL.HK', 100.774702, true, 'PRECISION-BULL.HK');

    const result = checker.checkRisk('PRECISION-BULL.HK', 'BUYCALL', 101.12749074212671, config);

    expect(result.allowed).toBe(true);
  });

  it('honors non-default runtime buy thresholds in auto seat mode', () => {
    const checker = createWarrantRiskChecker();
    const baseConfig = createStrategyRuntimeConfigDouble();
    const config: StrategyRuntimeConfig = {
      ...baseConfig,
      seatMode: 'auto',
      strategyConfig: {
        ...baseConfig.strategyConfig,
        instrumentAdaptationRules: {
          ...baseConfig.strategyConfig.instrumentAdaptationRules,
          autoSearchPrimaryDistanceBull: 1.5,
          autoSearchPrimaryDistanceBear: -1.5,
          bullBuyMinDistancePct: 0.15,
          bearBuyMaxDistancePct: -0.15,
          bullLiquidationDistancePct: 0.75,
          bearLiquidationDistancePct: -0.75,
        },
      },
    };

    checker.setWarrantInfoFromCallPrice('BULL.AUTO.HK', 100, true, 'BULL.AUTO.HK');
    checker.setWarrantInfoFromCallPrice('BEAR.AUTO.HK', 100, false, 'BEAR.AUTO.HK');

    const bullAllowed = checker.checkRisk('BULL.AUTO.HK', 'BUYCALL', 101.5, config);
    const bullRejected = checker.checkRisk('BULL.AUTO.HK', 'BUYCALL', 101.4, config);
    const bearAllowed = checker.checkRisk('BEAR.AUTO.HK', 'BUYPUT', 98.5, config);
    const bearRejected = checker.checkRisk('BEAR.AUTO.HK', 'BUYPUT', 98.6, config);

    expect(bullAllowed.allowed).toBe(true);
    expect(bullRejected.allowed).toBe(false);
    expect(bullRejected.reason).toContain('1.50%阈值');
    expect(bearAllowed.allowed).toBe(true);
    expect(bearRejected.allowed).toBe(false);
    expect(bearRejected.reason).toContain('-1.50%阈值');
  });

  it('honors non-default runtime liquidation thresholds', () => {
    const checker = createWarrantRiskChecker();
    const baseConfig = createStrategyRuntimeConfigDouble();
    const config: StrategyRuntimeConfig = {
      ...baseConfig,
      strategyConfig: {
        ...baseConfig.strategyConfig,
        instrumentAdaptationRules: {
          ...baseConfig.strategyConfig.instrumentAdaptationRules,
          bullLiquidationDistancePct: 0.75,
          bearLiquidationDistancePct: -0.75,
        },
      },
    };

    checker.setWarrantInfoFromCallPrice('BULL.LIQ.HK', 100, true, 'BULL.LIQ.HK');
    checker.setWarrantInfoFromCallPrice('BEAR.LIQ.HK', 100, false, 'BEAR.LIQ.HK');

    const bullLiquidate = checker.checkWarrantDistanceLiquidation(
      'BULL.LIQ.HK',
      true,
      100.75,
      config,
    );
    const bullHold = checker.checkWarrantDistanceLiquidation('BULL.LIQ.HK', true, 100.76, config);
    const bearLiquidate = checker.checkWarrantDistanceLiquidation(
      'BEAR.LIQ.HK',
      false,
      99.25,
      config,
    );
    const bearHold = checker.checkWarrantDistanceLiquidation('BEAR.LIQ.HK', false, 99.24, config);

    expect(bullLiquidate.shouldLiquidate).toBe(true);
    expect(bullHold.shouldLiquidate).toBe(false);
    expect(bearLiquidate.shouldLiquidate).toBe(true);
    expect(bearHold.shouldLiquidate).toBe(false);
  });
});
