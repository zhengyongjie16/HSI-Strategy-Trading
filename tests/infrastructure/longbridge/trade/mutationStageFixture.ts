/** 原生 mutation 测试边界：SDK 参数与序列化拦截留在 infra，跨 owner 场景只观察中性结果。 */
import { expect } from 'bun:test';
import { Decimal, OrderType, type SubmitOrderOptions, type SubmitOrderResponse } from 'longbridge';
import { createTradeMutationAdapter } from '../../../../src/infrastructure/longbridge/trade/tradeMutationAdapter.js';
import type { NativeSubmitFixture, NativeSubmitObservation } from './mutationStageTypes.js';

/** 捕获真实 adapter 到离线 SDK entry 的提交，不建立联网 context。 */
export function createNativeSubmitFixture(remoteFault?: Error): NativeSubmitFixture {
  const calls: NativeSubmitObservation[] = [];
  const context = {
    async submitOrder(options: SubmitOrderOptions): Promise<SubmitOrderResponse> {
      expect(this).toBe(context);
      let orderType: NativeSubmitObservation['orderType'] = 'OTHER';
      if (options.orderType === OrderType.LO) orderType = 'LO';
      else if (options.orderType === OrderType.ELO) orderType = 'ELO';

      calls.push({
        orderType,
        submittedPrice: options.submittedPrice?.toString() ?? null,
        submittedQuantity: options.submittedQuantity.toString(),
      });

      if (remoteFault) throw remoteFault;

      return {
        orderId: 'NATIVE-ACK',
        toString: () => 'NATIVE-ACK',
        toJSON: () => ({ orderId: 'NATIVE-ACK' }),
      };
    },
    replaceOrder: async () => {
      throw new Error('submit fixture does not expect replace');
    },
    cancelOrder: async () => {
      throw new Error('submit fixture does not expect cancel');
    },
  };
  return {
    port: createTradeMutationAdapter(context),
    calls,
  };
}

/** 在真实 Decimal 文本序列化后触发原调用方失效，并由场景 finally 恢复。 */
export function interceptNativeDecimalSerialization(afterSerialization: () => void): () => void {
  const original = Decimal.prototype.toString;
  Decimal.prototype.toString = function () {
    const text = original.call(this);
    afterSerialization();
    return text;
  };

  return () => {
    Decimal.prototype.toString = original;
  };
}
