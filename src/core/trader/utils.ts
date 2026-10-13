import { isRecord } from '../../utils/helpers/index.js';

/**
 * 从中性订单提交响应提取真实 ID，缺失时立即暴露契约错误。
 * @param response 提交 adapter 返回值
 * @returns 真实订单 ID
 */
export function extractOrderId(response: unknown): string {
  if (
    isRecord(response) &&
    typeof response['orderId'] === 'string' &&
    response['orderId'].length > 0
  ) {
    return response['orderId'];
  }

  if (typeof response === 'string' && response.length > 0) {
    return response;
  }

  throw new Error('submitOrder response missing valid orderId');
}
