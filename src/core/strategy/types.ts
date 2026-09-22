import type { Period } from 'longbridge';
import type { NormalizedCandle } from '../../types/data.js';
import type { Logger } from '../../utils/logger/types.js';
import type { RuntimeClock, RuntimeScheduler } from '../../types/runtime.js';
import type { SignalType } from '../../types/signal.js';

/**
 * 策略行情 K 线快照。
 * 类型用途：向策略提供单次行情事件对应的不可变 K 线事实与缓存版本。
 * 数据来源：由宿主从行情缓存投影得到，复用缓存已冻结 candle 并冻结元数据与数组，不包含行情客户端或 Broker 能力。
 * 使用范围：StrategyMarketContext 与策略实例。
 */
export type StrategyCandlestickSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly initialized: boolean;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly candles: ReadonlyArray<NormalizedCandle>;
};

/**
 * 策略可见的席位事实。
 * 类型用途：向一次 onCandlestick 初始评估提供当前 ACTIVE 席位的方向、标的和已成交买单事实。
 * 数据来源：由宿主在创建本次行情上下文及其私有 origin 时，从 SymbolRegistry 与 OrderRecorder 当前事实投影得到；列表只包含 ACTIVE route。
 * 使用范围：StrategyMarketContext.seats、普通候选生成与 SELL 初始授权。
 * 语义约束：这是观察时点的快照，不是后续执行时的持仓保证；延迟验证保存的 emitter 使用 origin 中的初始买单事实。
 */
export type StrategySeatFact = {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;

  /** 首次评估时该方向标的存在已成交买单；这是 SELL 候选的初始必要条件，不在延迟 emit 时重新查询。 */
  readonly hasFilledBuyOrders: boolean;
};

/**
 * 策略行情事件上下文。
 * 类型用途：约束策略只能读取不可变行情、席位和普通新评估门禁事实。
 * 数据来源：由宿主在行情事件监听与路由时创建，并为本次 onCandlestick 调用冻结。
 * 使用范围：TradingSignalStrategy.onCandlestick。
 * 语义约束：上下文与其中席位均为观察时点快照；不得把它当作延迟 emit 时的实时授权。allowNewEvaluation 为 false 时不得开始新的条件评估、立即输出或登记延迟验证，但仍应按策略需要推进现有行情状态与显示。
 */
export type StrategyMarketContext = {
  readonly candlesticks: StrategyCandlestickSnapshot;

  /** 行情事件被监听到的时间，供策略采样使用；不是处理完成时间或 emit 时的门禁时间。 */
  readonly observedAtMs: number;

  /** 宿主计算出的普通新评估门禁；为 false 时本次 emitter 没有初始 origin，策略不得调用它。 */
  readonly allowNewEvaluation: boolean;

  /** 本次事件创建 origin 时的 ACTIVE route 快照；只用于本次初始评估，不随席位事实变化回写。 */
  readonly seats: ReadonlyArray<StrategySeatFact>;
};

/**
 * 策略输出的普通交易决策。
 * 类型用途：表达策略产生的普通买卖意图，不携带标的选择、数量、委托类型或清仓授权。
 * 数据来源：由策略实例根据 StrategyMarketContext 计算得到；延迟候选仍保存首次评估产生的 decision。
 * 使用范围：策略 emitter 与宿主普通信号适配器。
 * 语义约束：action 只能是四种普通买卖动作，triggerTimeMs 是可无损映射 Date 的整数毫秒（立即动作的触发时刻或延迟验证目标），不是执行授权；SELL 的初始买单条件来自上下文及 origin，而不由 decision 携带。
 * 运行时边界：宿主适配器会按自身字段白名单重新校验并复制该对象；字段形状或值违反契约属于 fatal，而非普通无信号。
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
 * 类型用途：由宿主为每次 onCandlestick 调用创建，接收策略产生的逐动作普通意图。
 * 数据来源：由行情事件宿主依据本次新评估门禁创建私有 origin；可由策略延迟验证状态保存。
 * 使用范围：TradingSignalStrategy.onCandlestick 与策略私有验证链路。
 * 初始授权：origin 锁存创建时的交易日，以及当时 ACTIVE route 的方向、标的、seatVersion 和 SELL 所需的 hasFilledBuyOrders。allowNewEvaluation 为 false 时 origin 为空，策略不得调用该 emitter。
 * 保存语义：延迟验证可以在 onCandlestick 返回后继续调用同一个 emitter；它保留初始 origin，不重新查询 SELL 买单，但每次调用仍检查当前交易日、普通门禁、ACTIVE 席位、标的和 seatVersion。
 * 消费与失效：在 decision 通过形状和初始 origin/action 授权后，同一 emitter 对每个 action 只消费一次，并在实时门禁检查前记为已消费；当前门禁或席位已失效时静默丢弃，但仍算已消费，再次调用同 action 属于 fatal。非法 decision、缺少初始授权/route、SELL 初始无买单或其他内部契约失败报告 fatal；已终止时则在校验前静默丢弃。
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
 * 生命周期约束：onCandlestick 必须同步消费一次宿主 latestOnly 选出的权威快照；策略可以保存 emit 供私有延迟验证稍后使用，但不得把异步 Promise 作为返回值或把宿主交易能力带入策略。
 */
export interface TradingSignalStrategy {
  readonly strategyId: string;

  /**
   * 同步处理包含未确认活动柱更新的权威快照并返回中性显示投影。
   * `allowNewEvaluation` 为 false 时不得产生新的立即决策或登记新的延迟验证；已有 pending 可继续使用其保存的 emitter。
   * 内部契约或状态错误必须同步按 fatal 处理；正常门禁失效由 emitter 丢弃，不应转化为策略异常。
   */
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
