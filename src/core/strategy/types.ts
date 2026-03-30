/**
 * 策略类型模块
 *
 * 职责：
 * - 定义策略调用侧最小依赖端口（仅 generateSignals）
 * - 定义按趋势策略阈值创建策略实例的工厂契约
 */
import type { FactorSnapshot, StrategyThresholdConfig } from '../../types/factor.js';
import type { OrderRecorder } from '../../types/services.js';
import type { Signal } from '../../types/signal.js';

/**
 * 交易信号策略端口。
 * 类型用途：约束调用侧仅依赖 generateSignals 能力，避免装配层绑定具体策略实现命名。
 * 数据来源：由具体策略实现提供。
 * 使用范围：StrategyRuntime、buildStrategyRuntime、signalPipeline 等调用链路使用。
 */
export interface TradingSignalStrategy {
  generateSignals: (
    state: FactorSnapshot | null,
    longSymbol: string,
    shortSymbol: string,
    orderRecorder: OrderRecorder,
  ) => ReadonlyArray<Signal>;
}

/**
 * 交易信号策略工厂。
 * 类型用途：按策略配置创建策略实例，供 app 组装层注入默认或自定义策略实现。
 * 数据来源：由 strategy 模块实现或测试注入。
 * 使用范围：buildStrategyRuntime 及相关测试使用。
 */
export type TradingSignalStrategyFactory = (
  strategyConfig: StrategyThresholdConfig,
) => TradingSignalStrategy;
