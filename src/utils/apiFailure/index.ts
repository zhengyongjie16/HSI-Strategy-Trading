import { formatError } from '../error/index.js';
import type { ExternalApiRequestError } from '../../types/apiFailure.js';

const externalApiRequestErrors = new WeakSet<Error>();

/**
 * 创建外部 API 请求失败错误。
 *
 * @param params 外部 API 请求失败错误构造参数
 * @returns 携带 operation 与 attempts 的 Error 对象
 */
export function createExternalApiRequestError(
  params: Readonly<{
    operation: string;
    attempts: number;
    cause: unknown;
  }>,
): ExternalApiRequestError {
  const error = new Error(`[外部 API 请求失败] ${params.operation}: ${formatError(params.cause)}`, {
    cause: params.cause,
  });
  const externalApiError = Object.assign(error, {
    name: 'ExternalApiRequestError' as const,
    operation: params.operation,
    attempts: params.attempts,
  });
  externalApiRequestErrors.add(externalApiError);
  return externalApiError;
}

/**
 * 创建外部 API 聚合请求失败错误。
 *
 * @param params 外部 API 聚合请求失败错误构造参数
 * @returns 同时保留 AggregateError causes 与 ExternalApiRequestError 分类的错误对象
 */
export function createExternalApiAggregateRequestError(
  params: Readonly<{
    operation: string;
    attempts: number;
    causes: ReadonlyArray<ExternalApiRequestError>;
  }>,
): ExternalApiRequestError {
  const error = new AggregateError(
    params.causes,
    `[外部 API 请求失败] ${params.operation}: ${params.causes.length} 个请求失败`,
  );
  const externalApiError = Object.assign(error, {
    name: 'ExternalApiRequestError' as const,
    operation: params.operation,
    attempts: params.attempts,
  });
  externalApiRequestErrors.add(externalApiError);
  return externalApiError;
}

/**
 * 判断错误是否为外部 API 请求失败。
 *
 * @param error 待判断错误对象
 * @returns true 表示错误来自真实外部 API 请求失败边界
 */
export function isExternalApiRequestError(error: unknown): error is ExternalApiRequestError {
  return (
    error instanceof Error &&
    externalApiRequestErrors.has(error) &&
    error.name === 'ExternalApiRequestError' &&
    'operation' in error &&
    typeof error.operation === 'string' &&
    error.operation.length > 0 &&
    'attempts' in error &&
    typeof error.attempts === 'number' &&
    Number.isInteger(error.attempts) &&
    error.attempts > 0
  );
}

/**
 * 判断错误列表是否全部为外部 API 请求失败。
 *
 * @param errors 待判断错误列表
 * @returns true 表示列表非空且所有错误均为 ExternalApiRequestError
 */
export function isAllExternalApiRequestErrors(
  errors: ReadonlyArray<unknown>,
): errors is ReadonlyArray<ExternalApiRequestError> {
  return errors.length > 0 && errors.every(isExternalApiRequestError);
}

/**
 * 判断错误是否属于程序内部契约/不变量错误。
 *
 * 这类错误必须 fail-fast，不能降级为外部 API 失败重试或业务拒绝分支。
 *
 * @param error 待判断错误对象
 * @returns true 表示原生程序契约错误（含数值/引用/语法错误）、ContractError 或 InvariantError
 */
export function isProgramError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof EvalError ||
    error instanceof URIError ||
    (error instanceof Error && (error.name === 'ContractError' || error.name === 'InvariantError'))
  );
}
