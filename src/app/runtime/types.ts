import type { RateLimiterConfig } from '../../application/orderExecution/types.js';
import type { ContinuousTradingOrderAuthorization } from '../../application/orderTracking/types.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../domain/liquidation/episode/types.js';
import type { BrokerAccess } from '../../types/brokerAccessPorts.js';
import type { TradingConfig } from '../../types/config.js';
import type { MarketDataClient, TradingDayInfo } from '../../types/marketPorts.js';
import type {
  DailyLossTracker,
  ProtectiveLiquidationExecutionProgressInput,
} from '../../types/risk.js';
import type { RuntimeTermination } from '../../types/runtime.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { RiskChecker } from '../../types/services.js';
import type { SettlementRefreshNeedRecorder } from '../../types/settlement.js';

/**
 * 运行时执行门禁。
 * 类型用途：无参函数，返回当前是否允许下单；门禁关闭时 OrderExecutor 仅记录日志并跳过，不下单。
 * 数据来源：由主程序/启动层注入，单一状态源，执行层统一判定。
 * 使用范围：Trader、OrderMonitor、OrderExecutor 依赖注入使用。
 */
type IsExecutionAllowed = () => boolean;

/**
 * 最终下单授权读取的当日交易日事实。
 * 类型用途：把权威 TradingDayInfo 与其香港日期键绑定，防止跨日误用旧日历状态。
 * 数据来源：app runtime 的 LastState.cachedTradingDayInfo。
 * 使用范围：Trader 与 OrderExecutor 的末日保护最终买入授权。
 */
type CurrentTradingDayInfo = Readonly<{
  dateKey: string;
  info: TradingDayInfo;
}>;

/**
 * 最终下单授权的实时交易日事实读取器。
 * 类型用途：在 broker mutation 前同步读取当前权威交易日状态。
 * 数据来源：由 app runtime 注入。
 * 使用范围：Trader 与 OrderExecutor。
 */
type CurrentTradingDayInfoReader = () => CurrentTradingDayInfo | null;

/**
 * 交易器依赖。
 * 类型用途：用于创建顶层 Trader 实例时的依赖注入。
 * 数据来源：如适用。
 * 使用范围：见调用方（启动层等）。
 */
export type TraderDeps = {
  /** 同步延迟创建唯一 broker 访问能力；错误仍由 createTrader 捕获为 rejected Promise。 */
  readonly brokerAccess: () => BrokerAccess;
  readonly tradingConfig: TradingConfig;
  readonly marketDataClient: MarketDataClient;

  /** 与 MonitorContext 共用的浮亏买入门禁，保证读取同一 R1/N1 与当日亏损偏移缓存。 */
  readonly unrealizedLossBuyGate: Pick<RiskChecker, 'checkUnrealizedLoss'>;
  readonly rateLimiterConfig?: RateLimiterConfig;

  /** 标的注册表（用于动态标的映射） */
  readonly symbolRegistry: SymbolRegistry;
  readonly dailyLossTracker: DailyLossTracker;
  readonly protectiveLiquidationEpisodeTracker: ProtectiveLiquidationEpisodeTracker;
  readonly persistProtectiveLiquidationExecutionProgress: (
    input: ProtectiveLiquidationExecutionProgressInput,
  ) => void;

  /** 成交后一致性运行时（负责收口成交后的最小补刷需求） */
  readonly postTradeConsistencyRuntime: SettlementRefreshNeedRecorder;

  /** 运行时执行门禁（单一状态源注入，执行层统一判定） */
  readonly isExecutionAllowed: IsExecutionAllowed;

  /** 连续交易授权（仅由 OrderMonitor 派生新订单与自动改单使用） */
  readonly isContinuousTradingAllowed: ContinuousTradingOrderAuthorization;

  /** 最终订单授权、买入节流与订单 route 共用的实时钟。 */
  readonly now: () => Date;

  /** 订单 route 共用的 timer scheduler。 */
  readonly scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  /** 最终订单授权使用的权威当日交易日事实读取器。 */
  readonly readCurrentTradingDayInfo: CurrentTradingDayInfoReader;

  /** 运行期异步错误的统一 fatal 通道。 */
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
};
