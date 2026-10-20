/** 中性push解码能力：原SDK DTO只留adapter闭包，domain不注册/读取SDK类字段。 */
import type { OrderFact } from './trade.js';

/**
 * 延迟原始事实转换：monitor 在 error/termination guard 之后解码一次。
 * 合法非HK返回 null（不进入管理）；坏 symbol 结构或非法订单结构抛原生错误。
 * push 不做任何 execution/ledger IO。
 */
export interface OrderPushDecoder {
  readonly decode: () => OrderFact | null;
}

/** 原 context 的 callback 与 Private 订退订；时序、限流及经济发布仍归原 Monitor。 */
export interface OrderPushPort {
  readonly subscribePrivate: () => Promise<void>;
  readonly unsubscribePrivate: () => Promise<void>;
  readonly setOnOrderChanged: (
    consumer: (error: Error | null, decoder: OrderPushDecoder) => void,
  ) => void;
}
