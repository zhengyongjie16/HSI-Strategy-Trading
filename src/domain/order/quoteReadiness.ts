/**
 * 订单动作的行情就绪分类规则。
 * 只证明动作所需价格与手数，不查询行情、改写 quote 或签发交易/readiness 授权。
 */
import { canonicalDecimal, exactCompare } from '../../utils/numeric/exact.js';
import type { IsQuoteReadyForRequirementParams, QuoteReadinessStatus } from './types.js';

/**
 * 解析 quote 是否满足指定订单动作的就绪要求。
 * 非正价格保留原业务分类，内部格式或类型错误直接拒绝，不伪装成可重试行情。
 * @param params quote 与动作所需字段
 * @returns 就绪、缺失或字段无效的分类
 */
export function resolveQuoteReadinessForRequirement(
  params: IsQuoteReadyForRequirementParams,
): QuoteReadinessStatus {
  const { quote, requirement } = params;
  if (!quote) {
    return 'MISSING';
  }

  const price = canonicalDecimal(quote.price);
  if (exactCompare(price, '0') <= 0) {
    return 'INVALID_PRICE';
  }

  if (requirement === 'PRICE') {
    return 'READY';
  }

  const lotSize = quote.lotSize;
  if (lotSize === undefined) {
    return 'MISSING_LOT_SIZE';
  }

  if (!Number.isSafeInteger(lotSize) || lotSize <= 0) {
    return 'INVALID_LOT_SIZE';
  }

  return 'READY';
}
