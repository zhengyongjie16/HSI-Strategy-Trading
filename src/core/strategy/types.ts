import type { Period } from 'longbridge';
import type { Logger } from '../../utils/logger/types.js';
import type { RuntimeClock, RuntimeScheduler } from '../../types/runtime.js';
import type { SignalType } from '../../types/signal.js';

/**
 * 策略可接收的单根 K 线字段值。
 * 类型用途：表达行情缓存标准化后仍可能存在的缺失值，不把缺失值伪造成有效价格。
 * 数据来源：由行情缓存标准化后投影到策略输入。
 * 使用范围：StrategyCandle 与 StrategyCandlestickSnapshot。
 */
type StrategyCandleValue = number | string | null | undefined;

/**
 * 策略可接收的单根 K 线快照。
 * 类型用途：承载策略指标计算所需的 OHLCV 只读事实。
 * 数据来源：由宿主从已标准化的本地 K 线缓存创建并冻结。
 * 使用范围：StrategyCandlestickSnapshot 与具体策略实例。
 */
type StrategyCandle = {
  readonly timestamp?: number;
  readonly open: StrategyCandleValue;
  readonly high: StrategyCandleValue;
  readonly low: StrategyCandleValue;
  readonly close: StrategyCandleValue;
  readonly volume: StrategyCandleValue;
};

/**
 * 策略行情 K 线快照。
 * 类型用途：向策略提供单次行情事件对应的不可变 K 线事实与缓存版本。
 * 数据来源：由宿主从行情缓存投影得到，不包含行情客户端或 Broker 能力。
 * 使用范围：StrategyMarketContext 与策略实例。
 */
export type StrategyCandlestickSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly initialized: boolean;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly candles: ReadonlyArray<StrategyCandle>;
};

/**
 * 策略可见的席位事实。
 * 类型用途：向策略提供当前 ACTIVE 席位的方向、标的和已成交买单事实。
 * 数据来源：由宿主从 SymbolRegistry 与 OrderRecorder 当前事实投影得到。
 * 使用范围：StrategyMarketContext 与普通卖出候选生成。
 */
export type StrategySeatFact = {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly hasFilledBuyOrders: boolean;
};

/**
 * 策略行情事件上下文。
 * 类型用途：约束策略只能读取不可变行情、席位和普通新评估门禁事实。
 * 数据来源：由宿主在行情事件监听与路由时创建。
 * 使用范围：TradingSignalStrategy.onCandlestick。
 */
export type StrategyMarketContext = {
  readonly candlesticks: StrategyCandlestickSnapshot;

  /** 行情事件被监听到的时间，不是处理完成或动作判断时间。 */
  readonly observedAtMs: number;
  readonly allowNewEvaluation: boolean;
  readonly seats: ReadonlyArray<StrategySeatFact>;
};

/**
 * 策略输出的普通交易决策。
 * 类型用途：表达策略产生的普通买卖意图，不携带标的选择、数量、委托类型或清仓授权。
 * 数据来源：由策略实例根据 StrategyMarketContext 计算得到。
 * 使用范围：策略 emitter 与宿主普通信号适配器。
 */
export type StrategyDecision = {
  readonly action: Exclude<SignalType, 'HOLD'>;
  readonly triggerTimeMs: number;
  readonly reason?: string;
};

/**
 * 策略显示投影项。
 * 类型用途：表达策略指标或配置状态的中性文本展示，不参与交易授权。
 * 数据来源：由策略实例根据当前指标快照生成。
 * 使用范围：策略输出与宿主显示 runtime。
 */
export type StrategyDisplayItem = {
  readonly label: string;
  readonly valueText: string;
};

/**
 * 策略决策输出器。
 * 类型用途：由宿主创建并传给策略，接收策略产生的逐动作普通意图。
 * 数据来源：由行情事件宿主路由创建，并可由策略延迟验证状态保存。
 * 使用范围：TradingSignalStrategy.onCandlestick 与策略私有验证链路。
 */
export type StrategyEmitter = (decision: StrategyDecision) => void;

/**
 * 策略实例基础依赖。
 * 类型用途：向策略注入统一时间、定时器、日志和 fatal 错误入口，不注入任何宿主交易能力。
 * 数据来源：由 composition root 创建并注入。
 * 使用范围：PreparedStrategy.create 与具体策略实例。
 */
export type StrategyDeps = {
  readonly clock: RuntimeClock;
  readonly scheduler: RuntimeScheduler;
  readonly logger: Logger;
  readonly onFatalError: (error: unknown) => void;
};

/**
 * 交易信号策略运行端口。
 * 类型用途：为宿主提供与具体策略无关的行情处理、普通意图输出和生命周期清理能力。
 * 数据来源：由具体策略 definition 的 PreparedStrategy.create 创建。
 * 使用范围：MonitorContext、businessEventProgram、生命周期与 cleanup。
 */
export interface TradingSignalStrategy {
  readonly strategyId: string;

  /** 同步处理宿主 latestOnly 消费的权威快照，包含未确认活动柱更新；返回中性显示投影。 */
  readonly onCandlestick: (
    context: StrategyMarketContext,
    emit: StrategyEmitter,
  ) => ReadonlyArray<StrategyDisplayItem> | null;
  readonly invalidateDirection: (direction: 'LONG' | 'SHORT') => void;
  readonly invalidateAll: () => void;
  readonly resetForTradingDay: () => void;
  readonly destroy: () => void;
}

/**
 * 已准备的策略。
 * 类型用途：封装已校验、已编译的策略配置，并只暴露创建统一策略端口的能力。
 * 数据来源：由 StrategyDefinition.prepare 从静态 JSON 对象同步校验、编译生成。
 * 使用范围：composition root，在选中策略实例化时使用。
 */
export interface PreparedStrategy {
  readonly create: (deps: StrategyDeps) => TradingSignalStrategy;
}

/**
 * 策略入口定义。
 * 类型用途：约束免注册动态加载的固定入口导出、身份和配置准备能力。
 * 数据来源：由具体策略目录的 definition.ts/definition.js 导出。
 * 使用范围：启动加载器与具体策略入口。
 */
export interface StrategyDefinition {
  readonly id: string;
  readonly prepare: () => PreparedStrategy;
}
