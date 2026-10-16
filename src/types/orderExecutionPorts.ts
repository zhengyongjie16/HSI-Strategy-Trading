import type { DoomsdayClearanceCommand, ExecutableSignal, SignalType } from './signal.js';

/**
 * PUBLIC caller 保存的原工作授权：闭包捕获真实入队 epoch、readiness、席位及持仓基线。
 * executor 每次 await 后及最终 broker 副作用前复核；不得替换为当下新票或默认放行。
 * 数据来源：普通买卖、风险、静态清仓及换标的实际业务入口。
 */
export type SignalCallerAuthorization = () => boolean;

/**
 * 最终执行报价失败事实。
 * 数据来源：共享执行器逐个命令记录，并按准确输入索引映射回原始 ExecutableSignal 对象。
 * 使用范围：普通 SELL 用例的有限缺失报价重试；INVALID 不重试，不能按 symbol 重建身份。
 */
export type ExecutionQuoteFailure = {
  readonly signal: ExecutableSignal;
  readonly kind: 'QUOTE_MISSING' | 'QUOTE_INVALID';
};

/**
 * 批量信号执行结果。
 * 类型用途：唯一订单 ID 表达真实 accepted 动作，报价失败事实单独保留原输入身份。
 * 数据来源：共享执行器对每个信号的动作与最终行情准入结果汇总；无报价失败时显式返回空数组。
 * 使用范围：SignalExecutor.executeSignals 及清仓、换标等消费者；其他空 ID 结果不赋予重试语义。
 */
export type ExecuteSignalsResult = {
  readonly executedOrderIds: ReadonlyArray<string>;
  readonly quoteFailures: ReadonlyArray<ExecutionQuoteFailure>;
};

/**
 * 末日清仓执行结果。
 * 类型用途：末日专用结果独立保留 accepted ID、权威订单终态等待与缺价标的事实，
 * 让末日保护安排系统级一次性重评估而不是将其压缩为普通跳过。
 * 数据来源：OrderExecutor 的末日清仓专用入口。
 * 使用范围：末日清仓用例 与系统级时间唤醒链路。
 */
export type DoomsdayClearanceExecutionResult = {
  readonly executedOrderIds: ReadonlyArray<string>;
  readonly awaitingAuthoritativeTerminalSymbols: ReadonlyArray<string>;

  /** 最终 mutation permit 内行情缺失的标的，由末日窗口 owner 使用既有重评估机制处理。 */
  readonly unresolvedQuoteSymbols: ReadonlyArray<string>;
};

/**
 * 交易检查结果。
 * 类型用途：表示当前是否可执行交易及原因，作为 canTradeNow 等频率检查调用的返回值。
 * 数据来源：共享 executor 内部根据频率限制、门禁等计算。
 * 使用范围：交易门禁、买卖处理器等；全项目可引用。
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;

  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;
};

/** 普通买入频率检查；读取唯一 executor 的节流事实，不获得订单提交或账户能力。 */
export interface TradeFrequencyReader {
  readonly canTradeNow: (signalAction: SignalType) => TradeCheckResult;
}

/** 普通、保护性、静态清仓和换标共享的真实信号提交能力；原授权直达 broker 边界。 */
export interface SignalExecutor {
  readonly executeSignals: (
    signals: ReadonlyArray<ExecutableSignal>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<ExecuteSignalsResult>;
}

/** 末日清仓专用执行能力；不向普通信号消费者授予末日目的。 */
export interface DoomsdaySignalExecutor {
  readonly executeDoomsdayClearanceSignals: (
    commands: ReadonlyArray<DoomsdayClearanceCommand>,
    callerAuthorization: SignalCallerAuthorization,
  ) => Promise<DoomsdayClearanceExecutionResult>;
}

/** 唯一 application executor 的工厂产物；app 按真实消费者拆分注入上述能力。 */
export interface OrderExecutor
  extends TradeFrequencyReader, SignalExecutor, DoomsdaySignalExecutor {
  readonly resetBuyThrottle: () => void;
}
