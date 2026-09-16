import type { AccountSnapshot, Position } from '../../types/account.js';
import type { Trader } from '../../types/services.js';
import type { ExternalApiRetryConfig } from '../apiFailure/types.js';

/**
 * 账户与持仓专用双读取参数。
 * 类型用途：约束 readAccountAndPositionsBothSettled 的调用形状，确保 fatal 上报入口必须显式注入而不能默认 no-op。
 * 数据来源：由刷新链路或买入风控链路按当前读取场景组装，retryConfig 决定单次读取的重试策略。
 * 使用范围：仅账户与持仓双读取工具及其直接调用方使用。
 */
export type AccountPositionsReadParams = Readonly<{
  /** 交易器实例，用于发起账户快照与持仓两个读取请求 */
  trader: Trader;

  /** 外部 API 重试配置；不传时沿用 Trader 默认重试策略 */
  retryConfig?: ExternalApiRetryConfig;

  /** 运行时 fatal 上报入口，用于在观察点上报非外部 API 的原始错误 */
  reportFatalError: (error: unknown) => void;
}>;

/**
 * 账户与持仓专用双读取结果。
 * 类型用途：仅在账户快照与持仓列表两个请求都成功时携带可提交数据，避免半提交。
 * 数据来源：由 readAccountAndPositionsBothSettled 在两个请求都 fulfilled 后构造。
 * 使用范围：仅账户与持仓双读取工具及其直接调用方使用。
 */
export type AccountPositionsReadResult = Readonly<{
  /** 本次读取成功的账户快照 */
  account: AccountSnapshot;

  /** 本次读取成功的持仓列表 */
  positions: ReadonlyArray<Position>;
}>;
