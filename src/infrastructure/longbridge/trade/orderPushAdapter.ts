/** 原唯一 SDK context 的推送与订退订边界，callback DTO 不出基础设施；不持有监控/经济账。 */
import { TopicType, type TradeContext } from 'longbridge';
import type { OrderPushPort } from '../../../types/orderPushPorts.js';
import type { OrderEconomics } from '../../../types/orderEconomics.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { inspectBrokerOrderPush, mapBrokerOrderPush } from './orderMapper.js';

/**
 * 装配原SDK注册能力，延迟mapper保留原Monitor generation/错误/drain执行阶段。
 * @param context 原 context 的 callback 与订退订能力，订退订仅在原 Monitor 阶段调用
 * @param economics app 注入的纯订单经济规则，adapter 不创建默认域实例
 * @returns 中性解码callback port（有行为，不归pure conversion/data资格）
 */
export function createOrderPushAdapter(context: unknown, economics: OrderEconomics): OrderPushPort {
  if (!isRecord(context) || typeof context['setOnOrderChanged'] !== 'function') {
    throw new TypeError('[OrderPushAdapter] missing injected SDK callback capability');
  }

  const ctx = context as Pick<TradeContext, 'setOnOrderChanged' | 'subscribe' | 'unsubscribe'>;
  return {
    subscribePrivate: () => ctx.subscribe([TopicType.Private]),
    unsubscribePrivate: () => ctx.unsubscribe([TopicType.Private]),
    setOnOrderChanged: (consumer) => {
      ctx.setOnOrderChanged((error, event) => {
        consumer(error, {
          inspect: () => inspectBrokerOrderPush(event),
          decode: (executions, confirmed) =>
            mapBrokerOrderPush(event, executions, economics, confirmed),
        });
      });
    },
  };
}
