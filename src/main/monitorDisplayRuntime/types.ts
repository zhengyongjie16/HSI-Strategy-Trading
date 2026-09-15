import type { StrategyDisplayItem } from '../../core/strategy/types.js';
import type { MonitorConfig } from '../../types/config.js';
import type { LastState } from '../../types/state.js';
import type { MarketDataClient } from '../../types/services.js';
import type { MarketMonitor } from '../../services/marketMonitor/types.js';

/**
 * monitor 显示 route 状态。
 * 类型用途：维护单 monitor route 的 single-flight、dirty collapse 与最新中性显示投影。
 * 数据来源：由 monitorDisplayRuntime.requestRender 写入。
 * 使用范围：仅 monitorDisplayRuntime 模块内部使用。
 */
export type MonitorDisplayRouteState = {
  inFlight: boolean;
  dirty: boolean;
  latestItems: ReadonlyArray<StrategyDisplayItem> | null;
};

/**
 * monitor 显示 runtime 契约。
 * 类型用途：统一显示 owner 的启停与中性投影渲染请求能力。
 * 数据来源：由 createMonitorDisplayRuntime 创建。
 * 使用范围：app 装配、lifecycle、cleanup 与 businessEventProgram 使用。
 */
export interface MonitorDisplayRuntime {
  readonly start: () => void;
  readonly requestRender: (params: { readonly items: ReadonlyArray<StrategyDisplayItem> }) => void;
  readonly stopAndDrain: () => Promise<void>;
}

/**
 * monitor 显示 runtime 依赖。
 * 类型用途：封装行情读取、监控标的身份、门禁与纯渲染端口，不读取策略私有状态。
 * 数据来源：由 app 顶层装配注入；上下文只需提供原有 config.monitorSymbol。
 * 使用范围：仅 monitorDisplayRuntime 模块使用。
 */
export type MonitorDisplayRuntimeDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'getQuotes' | 'getCandlestickSnapshot'>;
  monitorContext: { readonly config: Pick<MonitorConfig, 'monitorSymbol'> };
  lastState: Pick<LastState, 'isTradingEnabled' | 'canTrade'>;
  marketMonitor: Pick<MarketMonitor, 'renderMonitorIndicators'>;
}>;
