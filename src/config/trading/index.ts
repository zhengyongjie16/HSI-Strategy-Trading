/**
 * trading 配置装配模块。
 *
 * 负责把环境变量装配为单实例 TradingConfig，固定基础对象 preset，
 * 并把全局配置与趋势策略配置拆分到独立解析器中。
 */
import type { TradingConfig } from '../../types/config.js';
import { STRATEGY } from '../../constants/index.js';
import { parseGlobalConfig, parseStrategyConfig } from './utils.js';

/**
 * 解析单实例交易配置根对象。
 *
 * @param options.env 进程环境变量对象
 * @returns 单实例交易配置
 */
export function createTradingConfig({ env }: { readonly env: NodeJS.ProcessEnv }): TradingConfig {
  return {
    baseInstrument: STRATEGY.BASE_INSTRUMENT_SYMBOL,
    global: parseGlobalConfig(env),
    strategy: parseStrategyConfig(env),
  };
}
