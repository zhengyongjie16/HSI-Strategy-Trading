/** 真实策略 definition 的单次准备与实例生命周期：静态配置不被冻结，创建时不登记 timer。 */
import { describe, expect, test } from 'bun:test';
import strategyConfig from '../../../src/strategies/intradayRegression/config.json';
import { strategyDefinition } from '../../../src/strategies/intradayRegression/definition.js';
import { createHarness } from './runtimeFixtures.js';

describe('intraday regression definition', () => {
  test('prepare 编译独立配置，create 只创建实例，同一实例可 reset 后 destroy', () => {
    const prepared = strategyDefinition.prepare();
    const harness = createHarness();
    const instance = prepared.create(harness.deps);
    expect(instance.strategyId).toBe('intraday-regression');
    expect(harness.events).toEqual([]);
    expect(harness.timers).toHaveLength(0);
    expect(Object.isFrozen(strategyConfig)).toBe(false);
    expect(Object.isFrozen(strategyConfig.verification.buy.indicators)).toBe(false);
    instance.resetForTradingDay();
    instance.destroy();
    instance.destroy();
    expect(harness.errors).toEqual([]);
  });
});
