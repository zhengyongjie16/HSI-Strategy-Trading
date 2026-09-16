/**
 * 账户与持仓专用双读取模块
 *
 * 职责：
 * - 同时发起账户快照与持仓读取，并保证两个请求都会被观察、排空
 * - 任一非外部 API 失败（内部契约/不变量错误）在该请求失败点立即经 reportFatalError 上报原始错误
 * - 两个请求都落定后按“内部错误优先”抛出原始 rejection；纯外部失败保持原样交由上层恢复策略
 * - 只有两个请求都成功才返回可提交数据，避免半提交
 */
import { isExternalApiRequestError } from '../apiFailure/index.js';
import type { AccountPositionsReadParams, AccountPositionsReadResult } from './types.js';

/**
 * 启动单个读取请求并挂载失败观察。
 *
 * 通过异步 IIFE 调用把同步 throw 归一为 rejection，保证先发起请求同步抛错时仍然继续发起并排空兄弟请求；
 * 任一非外部 API 失败在失败点立即上报 fatal，随后原样向下传递 rejection（含 null/undefined）。
 *
 * @param start 发起单个读取请求的同步函数
 * @param reportFatalError 运行时 fatal 上报入口
 * @returns 携带失败观察的读取 Promise
 */
function startObservedRequest<T>(
  start: () => Promise<T>,
  reportFatalError: (error: unknown) => void,
): Promise<T> {
  return (async () => start())().catch((error: unknown) => {
    if (!isExternalApiRequestError(error)) {
      reportFatalError(error);
    }

    throw error;
  });
}

/**
 * 专用双读取账户与持仓。
 *
 * 固定行为：两个请求都会发起并持有到全部落定；失败选择按“内部错误优先、外部失败其次（账户先于持仓）”；
 * 只有全部成功才返回结果。内部错误由观察点在失败当下上报 fatal，不等待兄弟请求结束。
 *
 * @param params 双读取参数（trader、可选 retryConfig、必需 reportFatalError）
 * @returns 两个请求都成功时的账户快照与持仓列表
 * @throws 任一请求失败时抛出原始 rejection 值（含 null/undefined），内部错误优先于外部失败
 */
export async function readAccountAndPositionsBothSettled(
  params: AccountPositionsReadParams,
): Promise<AccountPositionsReadResult> {
  const { trader, retryConfig, reportFatalError } = params;
  const requestParams = retryConfig === undefined ? undefined : { retryConfig };
  const accountRequest = startObservedRequest(
    () => trader.getAccountSnapshot(requestParams),
    reportFatalError,
  );
  const positionsRequest = startObservedRequest(
    () => trader.getStockPositions(requestParams),
    reportFatalError,
  );

  // 持有并排空所有已开始请求：任一失败都不能提前返回，否则另一请求的失败事实会丢失。
  const [accountResult, positionsResult] = await Promise.allSettled([
    accountRequest,
    positionsRequest,
  ]);

  // 内部错误优先于外部失败，且必须原样抛出 rejection 值（显式按 status 判别，不能依赖真值判断）。
  if (accountResult.status === 'rejected' && !isExternalApiRequestError(accountResult.reason)) {
    throw accountResult.reason;
  }

  if (positionsResult.status === 'rejected' && !isExternalApiRequestError(positionsResult.reason)) {
    throw positionsResult.reason;
  }

  if (accountResult.status === 'rejected') {
    throw accountResult.reason;
  }

  if (positionsResult.status === 'rejected') {
    throw positionsResult.reason;
  }

  return {
    account: accountResult.value,
    positions: positionsResult.value,
  };
}
