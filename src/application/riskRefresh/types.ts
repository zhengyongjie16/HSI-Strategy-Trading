import type { MarketDataClient } from '../../types/marketPorts.js';
import type { WarrantRefreshResult } from '../../types/warrantRisk.js';
import type { WarrantRiskChecker } from '../../domain/risk/types.js';
import type { Logger } from '../../types/logger.js';

/**
 * 单方向 warrant 刷新结果。
 * INVALIDATED 只表示原 captured 授权失效且未发布，由 rebuild 原 owner 判定 ABORTED/SUPERSEDED；
 * 不表示查询失败、非牛熊证或需要增加 API 重试，其他结果保持原业务语义。
 */
export type WarrantRiskRefreshResult = WarrantRefreshResult | { readonly status: 'INVALIDATED' };

/**
 * 交易日重建使用的异步牛熊证事实刷新能力。
 * 完整读取校验后以调用方原 captured 授权同步发布，不拥有席位激活、浮亏刷新或保护性完成条件。
 */
export interface WarrantRiskRefresh {
  readonly refreshWarrantInfoForSymbol: (
    symbol: string,
    isLongSymbol: boolean,
    isCurrent: () => boolean,
    symbolName?: string | null,
  ) => Promise<WarrantRiskRefreshResult>;
}

/**
 * 牛熊证刷新用例依赖。
 * market 只提供中性查询，publisher 指向同步风险检查使用的同一状态，logger 由装配层注入。
 */
export interface WarrantRiskRefreshDeps {
  readonly marketDataClient: Pick<MarketDataClient, 'getQuoteContext'>;
  readonly warrantRiskChecker: Pick<WarrantRiskChecker, 'publishWarrantInfo'>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}
