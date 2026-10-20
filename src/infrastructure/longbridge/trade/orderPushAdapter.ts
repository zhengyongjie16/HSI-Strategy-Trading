/** 原唯一 SDK context 的推送与订退订边界，callback DTO 不出基础设施；不持有监控/经济账。 */
import { TopicType, type TradeContext } from 'longbridge';
import type { OrderPushPort } from '../../../types/orderPushPorts.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { mapBrokerOrderPush } from './orderMapper.js';

/**
 * 装配 SDK 注册能力；提供同步延迟 decode，让 Monitor 先检查生命周期 guard，再执行映射与错误处理。
 * push 不做 execution IO；合法非HK订单解码为 null，坏 symbol 结构抛出原错误。
 * @param context 原 context 的 callback 与订退订能力，订退订仅在原 Monitor 阶段调用
 * @returns 中性解码callback port（有行为，不归pure conversion/data资格）
 */
export function createOrderPushAdapter(context: unknown): OrderPushPort {
  if (!isRecord(context) || typeof context['setOnOrderChanged'] !== 'function') {
    throw new TypeError('[OrderPushAdapter] missing injected SDK callback capability');
  }

  const ctx = context as Pick<TradeContext, 'setOnOrderChanged' | 'subscribe' | 'unsubscribe'>;
  return {
    subscribePrivate: () => ctx.subscribe([TopicType.Private]),
    unsubscribePrivate: () => ctx.unsubscribe([TopicType.Private]),
    setOnOrderChanged: (consumer) => {
      ctx.setOnOrderChanged((error, event) => {
        consumer(error, { decode: () => mapBrokerOrderPush(event) });
      });
    },
  };
}
