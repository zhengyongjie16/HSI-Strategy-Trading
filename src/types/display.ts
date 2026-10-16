import type { AccountPositionSnapshotReader } from './accountPosition.js';
import type { QuoteUpdatedEvent } from './marketPorts.js';
import type { Quote } from './quote.js';
import type { UnrealizedLossMetrics } from './unrealizedLoss.js';
import type { WarrantDistanceInfo } from './warrantRisk.js';
import type { StrategyDisplayItem } from './strategy.js';

/**
 * 账户与持仓展示函数入参。
 * 类型用途：作为 displayAccountAndPositions 的对象参数类型，避免调用方重复内联定义。
 * 数据来源：由启动重建与成交后刷新链路组装传入。
 * 使用范围：账户显示 adapter 及 app 组装链路使用。
 */
export type DisplayAccountAndPositionsParams = Readonly<{
  snapshot: AccountPositionSnapshotReader;
  quotesMap?: ReadonlyMap<string, Quote | null> | null;
}>;

/**
 * 交易标的价格显示附加信息。
 * 类型用途：承载 trading quote 显示所需的距回收价、浮亏与订单数信息。
 * 数据来源：由 app 在 tradingQuoteDisplayRuntime 的渲染回调中按当前 route 组装。
 * 使用范围：app 组装与 marketMonitor 显示 adapter 使用。
 */
export type PriceDisplayInfo = {
  readonly warrantDistanceInfo: WarrantDistanceInfo | null;
  readonly unrealizedLossMetrics: UnrealizedLossMetrics | null;
  readonly orderCount: number | null;
};

/**
 * monitor indicator 渲染参数。
 * 类型用途：封装纯渲染 monitor indicators 所需的策略中性显示投影、quote 与 K 线时间。
 * 数据来源：由 monitorDisplayRuntime 在补齐 monitor quote 后组装。
 * 使用范围：显示 runtime 与 marketMonitor 显示 adapter 使用。
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
 * 数据来源：由 app 在 tradingQuoteDisplayRuntime 完成 route 校验与补齐行情后组装。
 * 使用范围：app 组装与 marketMonitor 显示 adapter 使用。
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
 * 使用范围：显示 runtime、app 组装与显示 adapter 使用。
 */
export interface MarketMonitor {
  readonly renderTradingQuote: (params: RenderTradingQuoteParams) => void;
  readonly renderMonitorIndicators: (params: RenderMonitorIndicatorsParams) => void;
}
