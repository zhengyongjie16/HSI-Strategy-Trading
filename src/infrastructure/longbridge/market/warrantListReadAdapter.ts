/** 轮证列表唯一native IO边界；SDK枚举参数留在adapter，业务只接收中性请求/金融事实。 */
import type { QuoteContext } from 'longbridge';
import type { MarketQuoteContext } from '../../../types/services.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapWarrantListRequest } from './warrantRequestMapper.js';
import { mapWarrantListItem } from './quoteFinancialMapper.js';

/**
 * 组装当前唯一quote context的真实读取能力，错误重试仍由原quoteClient owner提供。
 * 这是执行IO的行为adapter，不是pure conversion/NeutralDataType资格。
 * @param context 原有唯一context的warrantList方法
 * @param executeRequest 原owner的retry执行器；内部请求校验在调用它之前完成
 * @returns 无SDK参数/返回类型泄漏的窄读取port
 */
export function createWarrantListReadAdapter(
  context: unknown,
  executeRequest: <T>(request: () => Promise<T>) => Promise<T>,
): Pick<MarketQuoteContext, 'warrantList'> {
  if (!isRecord(context) || typeof context['warrantList'] !== 'function') {
    throw new TypeError('[WarrantListReadAdapter] missing injected native capability');
  }

  const ctx = context as Pick<QuoteContext, 'warrantList'>;
  return {
    warrantList: async (request) => {
      const nativeArguments = mapWarrantListRequest(request);
      const warrants = await executeRequest(() => ctx.warrantList(...nativeArguments));
      return warrants.map(mapWarrantListItem);
    },
  };
}
