import type { AutoSearchConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/marketPorts.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { Logger } from '../../types/logger.js';

/**
 * 候选搜索的真实装配依赖。
 * 数据来源：app 注入同一 market reader 和监控方向配置；SDK IO/cache/retry 留在 reader 对应 adapter。
 * 使用范围：三个寻标入口共享的候选查询编排，不包含席位或搜索失败状态。
 */
export type WarrantCandidateSearchDeps = Readonly<{
  monitorSymbol: string;
  autoSearchConfig: AutoSearchConfig;
  marketDataClient: Pick<MarketDataClient, 'getQuoteContext'>;
  logger: Logger;
  getTradingMinutesSinceOpen: (currentTime: Date) => number;
}>;

/** 当前候选查询命令；每个异步边界后重读调用方授权，过期结果不能被入口计入候选或失败。 */
export type FindWarrantCandidateParams = Readonly<{
  direction: 'LONG' | 'SHORT';
  currentTime: Date;
  canContinue: () => boolean;
}>;

/** 候选查询交付给补席和换标的最小金融事实；筛选排序和日志明细留在候选查询内部。 */
export type AutoSearchCandidate = Readonly<{
  symbol: string;
  callPrice: string;
}>;

/**
 * 三条入口共享的窄候选能力。
 * 数据来源：createWarrantCandidateSearch 使用 domain policy 与同一 market reader 实现。
 * 使用范围：运行期空席位、启动补席和换标预寻标；仅交付 symbol/callPrice。
 * resolveDistanceRange 返回 null 时入口应在建立搜索 owner 前跳过，不记失败；该接口不写席位或计数。
 */
export interface WarrantCandidateSearch {
  readonly resolveDistanceRange: (
    direction: 'LONG' | 'SHORT',
  ) => Readonly<{ min: string; max: string }> | null;
  readonly findCandidate: (
    params: FindWarrantCandidateParams,
  ) => Promise<AutoSearchCandidate | null>;
}

/** 运行期搜索命令，调用方授权包含当前生命周期/交易时段及必要的交易日身份。 */
export type SearchOnEventParams = Readonly<{
  direction: 'LONG' | 'SHORT';
  currentTime: Date;
  canContinue: () => boolean;
}>;

/**
 * 运行期空席位搜索依赖。
 * 数据来源：app 注入 registry、候选能力与配置，不持有 switch 状态或另建缓存。
 * 使用范围：createAutoSearch 的独立失败/冻结 owner；启动和换标不调用其运行期失败政策。
 */
export type AutoSearchDeps = Readonly<{
  monitorSymbol: string;
  autoSearchConfig: Pick<AutoSearchConfig, 'autoSearchEnabled' | 'autoSearchOpenDelayMinutes'>;
  symbolRegistry: SymbolRegistry;
  candidateSearch: WarrantCandidateSearch;
  logger: Logger;
}>;

/** 搜索取消命令；必须绑定 runtime 原本持有的方向和版本，不能取消后继 owner。 */
export type CancelSearchParams = Readonly<{
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
}>;

/** 运行期空席位补齐用例，拥有搜索和取消的状态迁移，不拥有 timer、switch 或 activation 完成。 */
export interface AutoSearchWorkflow {
  readonly maybeSearchOnEvent: (params: SearchOnEventParams) => Promise<void>;
  readonly cancelSearch: (params: CancelSearchParams) => void;
}

/** 启动补席搜索依赖；历史标的恢复与启动门禁由 recovery 调用方管理。 */
export type StartupSeatSearchDeps = Pick<
  AutoSearchDeps,
  'monitorSymbol' | 'symbolRegistry' | 'candidateSearch' | 'logger'
>;

/** 启动补席用例；无候选计数，异常复原 EMPTY 但不计数并原样抛出，供恢复 owner 重试。 */
export interface StartupSeatSearch {
  readonly searchSeat: (params: SearchOnEventParams) => Promise<string | null>;
}
