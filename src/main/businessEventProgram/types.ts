import type { TradingConfig } from '../../types/config.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MarketDataClient, OrderRecorder } from '../../types/services.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { RuntimeClock, RuntimeTermination } from '../../types/runtime.js';
import type { StrategyDisplayItem, TradingSignalStrategy } from '../../core/strategy/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';

/** 普通行情 owner 的启停端口；fatal 由共享 termination 独占。 */
export interface BusinessEventProgram {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndDrain: () => Promise<void>;
}

/** 宿主使用的最小监控事实；策略只获得其冻结的行情和席位投影。 */
type BusinessEventMonitorContext = {
  readonly config: Pick<MonitorContext['config'], 'monitorSymbol'>;
  readonly strategy: TradingSignalStrategy;
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly orderRecorder: Pick<OrderRecorder, 'getBuyOrdersForSymbol'>;
  readonly longSymbolName: string;
  readonly shortSymbolName: string;
};

/** 中性显示端口；不向宿主泄露策略指标实现。 */
interface BusinessEventMonitorDisplayRuntime {
  readonly requestRender: (params: { readonly items: ReadonlyArray<StrategyDisplayItem> }) => void;
}

/** composition root 注入的行情、普通授权、输出与终态端口。 */
export type BusinessEventProgramDeps = {
  readonly clock: RuntimeClock;
  readonly marketDataClient: Pick<
    MarketDataClient,
    'getCandlestickSnapshot' | 'onCandlestickUpdated'
  >;
  readonly monitorContext: BusinessEventMonitorContext;
  readonly lastState: Pick<
    LastState,
    'isTradingEnabled' | 'canTrade' | 'isHalfDay' | 'currentDayKey' | 'openProtectionActive'
  >;
  readonly tradingConfig: { readonly global: Pick<TradingConfig['global'], 'doomsdayProtection'> };
  readonly buyTaskQueue: Pick<TaskQueue<BuyTaskType>, 'push'>;
  readonly sellTaskQueue: Pick<TaskQueue<SellTaskType>, 'push'>;
  readonly monitorDisplayRuntime: BusinessEventMonitorDisplayRuntime;
  readonly termination: Pick<RuntimeTermination, 'isTerminated' | 'reportFatalError'>;
};

/** 宿主私有 origin route；不把版本或订单记录传给策略。 */
export type StrategyOriginRoute = {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly seatVersion: number;
  readonly hasFilledBuyOrders: boolean;
};

/** 新评估获准时保存的不可变授权；不随当前 gate/席位变化回写。 */
export type StrategyOrigin = {
  readonly dayKey: string;
  readonly routes: ReadonlyArray<StrategyOriginRoute>;
};
