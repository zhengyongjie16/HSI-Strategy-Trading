/** 当前日内回归策略固定入口；静态导入配置对象，准备与实例创建分离。 */
import type { StrategyDefinition, StrategyDeps } from '../types.js';
import strategyConfig from './config.json';
import { parseStrategyConfig } from './config.js';
import { createIntradayRegressionStrategy } from './index.js';

export const strategyDefinition: StrategyDefinition = Object.freeze({
  id: 'intraday-regression',
  prepare() {
    const config = parseStrategyConfig(strategyConfig);
    return Object.freeze({
      create: (deps: StrategyDeps) => createIntradayRegressionStrategy(config, deps),
    });
  },
});
