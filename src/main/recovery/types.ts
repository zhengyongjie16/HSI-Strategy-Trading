import type { TradingConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { OrderFact } from '../../types/trade.js';
import type { StartupSeatSearch } from '../../application/autoSearch/types.js';

/**
 * prepareSeatsForRuntime() 的依赖注入对象。
 * 类型用途：统一表达交易日快照加载时恢复席位所需的配置、持仓、订单、启动寻标与同步准入判断。
 * 数据来源：由运行时快照加载链路组装传入。
 * 使用范围：仅席位恢复流程使用。
 */
export type PrepareSeatsForRuntimeDeps = {
  readonly tradingConfig: TradingConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly positions: ReadonlyArray<Position>;
  readonly orders: ReadonlyArray<OrderFact>;
  readonly startupSeatSearch: StartupSeatSearch;
  readonly canContinue: () => boolean;
  readonly now: () => Date;
  readonly resolveCanAutoSearchNow: (params: {
    readonly currentTime: Date;
    readonly openDelayMinutes: number;
  }) => boolean;
};
