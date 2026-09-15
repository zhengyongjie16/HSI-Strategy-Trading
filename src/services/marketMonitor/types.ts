import type { StrategyDisplayItem } from '../../core/strategy/types.js';
import type { Quote } from '../../types/quote.js';
import type {
  QuoteUpdatedEvent,
  UnrealizedLossMetrics,
  WarrantDistanceInfo,
} from '../../types/services.js';

/**
 * 交易标的价格显示附加信息。
 * 类型用途：承载 trading quote 显示所需的距回收价、浮亏与订单数信息。
 * 数据来源：由 tradingRiskEventRuntime 路由链路按当前 route 组装。
 * 使用范围：仅 marketMonitor 交易标的显示链路使用。
 */
export type PriceDisplayInfo = {
  readonly warrantDistanceInfo: WarrantDistanceInfo | null;
  readonly unrealizedLossMetrics: UnrealizedLossMetrics | null;
  readonly orderCount: number | null;
};

/**
 * monitor indicator 渲染参数。
 * 类型用途：封装纯渲染 monitor indicators 所需的 策略中性显示投影、quote与 K 线时间。
 * 数据来源：由 monitorDisplayRuntime 在补齐 monitor quote 后组装。
 * 使用范围：仅 marketMonitor.renderMonitorIndicators 使用。
 */
export type RenderMonitorIndicatorsParams = Readonly<{
  readonly items: ReadonlyArray<StrategyDisplayItem>;
  readonly monitorQuote: Quote | null;
  readonly monitorSymbol: string;
  readonly klineTimestamp: number | null;
}>;

/**
 * trading quote 渲染参数。
 * 类型用途：封装纯渲染交易标的行情所需的 quote 事件、route 信息与附加展示信息。
 * 数据来源：由 tradingQuoteDisplayRuntime 在 route 校验与补齐 monitor quote 后组装。
 * 使用范围：仅 marketMonitor.renderTradingQuote 使用。
 */
export type RenderTradingQuoteParams = Readonly<{
  readonly event: QuoteUpdatedEvent;
  readonly tradingSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly displayInfo: PriceDisplayInfo | null;
}>;

/**
 * 终端显示纯渲染器契约。
 * 类型用途：统一 monitor indicators 与 trading quote 的纯输出端口。
 * 数据来源：由 createMarketMonitor 创建。
 * 使用范围：显示 runtime 与 app 组装链路使用。
 */
export interface MarketMonitor {
  readonly renderTradingQuote: (params: RenderTradingQuoteParams) => void;
  readonly renderMonitorIndicators: (params: RenderMonitorIndicatorsParams) => void;
}
