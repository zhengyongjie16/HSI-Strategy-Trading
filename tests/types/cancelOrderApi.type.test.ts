import type { TradeRuntime } from '../../src/app/runtime/types.js';

/**
 * 撤单 API 类型边界测试
 *
 * 普通撤单和末日窗口撤单具有不同的授权与结果语义：
 * 普通路径不能构造未开始结果，末日路径必须显式携带 permit 内门禁。
 */

import { describe, expect, it } from 'bun:test';
import type { OrderMonitor } from '../../src/application/orderTracking/types.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
} from '../../src/types/orderCancellation.js';

const doomsdayRequest: DoomsdayCancelOrderRequest = {
  kind: 'DOOMSDAY_WINDOW',
  beforeBrokerCancel: () => true,
};

function assertTraderCancelApiBoundary(tradeRuntime: TradeRuntime): void {
  const normalOutcome: Promise<CancelOrderOutcome> = tradeRuntime.orderMonitor.cancelOrder(
    'ORDER-FACT',
    {
      kind: 'ORDER_FACT',
    },
  );
  void normalOutcome;

  const businessOutcome: Promise<CancelOrderOutcome> = tradeRuntime.orderMonitor.cancelOrder(
    'SWITCH-ORDER',
    {
      kind: 'SIGNAL_AUTHORIZED',
      authorize: () => true,
    },
  );
  void businessOutcome;

  // @ts-expect-error 公共撤单必须显式区分事实请求与业务原票，不能默认授权。
  void tradeRuntime.orderMonitor.cancelOrder('MISSING-AUTHORIZATION');

  const doomsdayOutcome: Promise<DoomsdayCancelOrderOutcome> =
    tradeRuntime.orderMonitor.cancelDoomsdayOrder('DOOMSDAY-ORDER', doomsdayRequest);
  void doomsdayOutcome;

  // @ts-expect-error 普通公开撤单不能携带末日 permit，因此不能产生 CANCEL_NOT_STARTED。
  void tradeRuntime.orderMonitor.cancelOrder('DOOMSDAY-ORDER', doomsdayRequest);
}

function assertOrderMonitorCancelApiBoundary(orderMonitor: OrderMonitor): void {
  const normalOutcome: Promise<CancelOrderOutcome> = orderMonitor.cancelOrder('ORDER-FACT', {
    kind: 'ORDER_FACT',
  });
  void normalOutcome;

  const doomsdayOutcome: Promise<DoomsdayCancelOrderOutcome> = orderMonitor.cancelDoomsdayOrder(
    'DOOMSDAY-ORDER',
    doomsdayRequest,
  );
  void doomsdayOutcome;

  // @ts-expect-error OrderMonitor 普通撤单只接受普通 mutation request。
  void orderMonitor.cancelOrder('DOOMSDAY-ORDER', doomsdayRequest);
}

void assertTraderCancelApiBoundary;
void assertOrderMonitorCancelApiBoundary;

describe('cancel order API type contract', () => {
  it('keeps normal and doomsday cancellation entry points distinct', () => {
    expect(true).toBeTrue();
  });
});
