/**
 * 账户查询应用服务模块
 *
 * 职责：
 * - 查询账户余额、净资产与持仓市值等财务信息
 * - 查询股票持仓（支持按标的过滤）
 *
 * 依赖：accountReadPort（中性账户读取能力）、rateLimiter（频率限制）
 */
import { exactSubtract } from '../../utils/numeric/exact.js';
import type { ExternalApiRetryConfig } from '../../utils/apiFailure/types.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { AccountService, AccountServiceDeps } from '../../types/accountReadPorts.js';

/**
 * 创建账户服务
 * @param deps 依赖注入
 * @returns AccountService 接口实例
 */
export const createAccountService = (deps: AccountServiceDeps): AccountService => {
  const { accountReadPort, rateLimiter } = deps;

  /**
   * 获取账户快照（余额、净资产、持仓市值与现金详情）。
   * 供下单前风控与资金校验使用；若返回结果不含主账户则按内部契约错误 fail-fast。
   *
   * @returns 账户快照
   */
  const getAccountSnapshot = async (params?: {
    readonly retryConfig?: ExternalApiRetryConfig;
  }): Promise<AccountSnapshot> => {
    await rateLimiter.throttle();
    const account = await accountReadPort.readPrimaryAccount(params);
    return {
      ...account,
      positionValue: exactSubtract(account.netAssets, account.totalCash),
    };
  };

  /**
   * 获取股票持仓，支持按标的过滤。
   *
   * @param symbols 标的代码数组，null 或未传时获取所有持仓
   * @returns 持仓列表（含 accountChannel、symbol、availableQuantity 等）
   */
  const getStockPositions = async (params?: {
    readonly symbols?: ReadonlyArray<string> | null;
    readonly retryConfig?: ExternalApiRetryConfig;
  }): Promise<ReadonlyArray<Position>> => {
    await rateLimiter.throttle();
    return accountReadPort.readStockPositions(params);
  };

  return {
    getAccountSnapshot,
    getStockPositions,
  };
};
