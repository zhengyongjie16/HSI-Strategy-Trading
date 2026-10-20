/** SDK pending/snapshot 准入回归：订单入口共用原验证规则，未知元数据不进入内部订单模型。 */
import { describe, expect, it } from 'bun:test';
import { createBrokerIngressFixture } from './brokerIngressFixture.js';

const nowMs = Date.parse('2026-10-07T02:00:00Z');
const frame = {
  orderId: 'OLD',
  symbol: 'BULL.HK',
  stockName: 'HSI RC',
  remark: '|PL',
  side: 'SELL' as const,
  status: 'New' as const,
  orderType: 'ELO' as const,
  quantity: '1500',
  executedQuantity: '0',
  submittedPrice: '0.90000000000000001',
  executedPrice: '0',
  submittedAtMs: nowMs,
  updatedAtMs: nowMs,
};
const usOddLotFrame = {
  ...frame,
  orderId: 'US-ODD',
  symbol: 'AAPL.US',
  stockName: 'APPLE',
  quantity: '1.5',
  submittedPrice: '100',
};

async function createFixture() {
  const native = await createBrokerIngressFixture(frame);
  native.setOrderSnapshotReplies([], [frame]);
  return native;
}

describe('SDK order ingress validation', () => {
  it('pending 保真金融文本与中性枚举；snapshot 保留原 protective remark', async () => {
    const native = await createFixture();
    expect(await native.ports.createPendingOrdersReader().todayOrders()).toMatchObject([
      {
        orderId: 'OLD',
        side: 'SELL',
        status: 'WORKING',
        orderType: 'ELO',
        submittedPrice: '0.90000000000000001',
      },
    ]);
    const reader = native.ports.createOrderSnapshotReadPort({
      rateLimiter: { throttle: async () => {} },
    });
    const snapshots = await reader.fetchSnapshots();
    expect(snapshots.todayOrders).toMatchObject([{ remark: '|PL', executionPhase: 'OPEN' }]);
  });

  it('混合HK+US碎股：非HK订单在严格数量映射前被过滤，不进入管理', async () => {
    const native = await createBrokerIngressFixture(frame);
    native.setOrderSnapshotReplies([usOddLotFrame], [usOddLotFrame, frame]);

    expect(await native.ports.createPendingOrdersReader().todayOrders()).toMatchObject([
      { orderId: 'OLD', symbol: 'BULL.HK' },
    ]);
    const snapshots = await native.ports
      .createOrderSnapshotReadPort({ rateLimiter: { throttle: async () => {} } })
      .fetchSnapshots();
    expect(snapshots.historyOrders).toEqual([]);
    expect(snapshots.todayOrders.map((order) => order.orderId)).toEqual(['OLD']);
  });

  it('坏 symbol 结构不当作非HK静默忽略', async () => {
    const native = await createBrokerIngressFixture(frame);
    native.setOrderSnapshotReplies([], [{ ...frame, orderId: 'BROKEN', symbol: 'AAPL' }]);

    let rejection: unknown = null;
    try {
      await native.ports.createPendingOrdersReader().todayOrders();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(TypeError);
    expect(rejection instanceof Error ? rejection.message : null).toMatch(/symbol structure/);
  });

  for (const field of ['side', 'status', 'orderType'] as const) {
    for (const kind of ['UNKNOWN', 'NON_MEMBER', 'MISSING'] as const) {
      it(`pending 拒绝 ${field}/${kind}，不依赖已删除的公共 SDK 验证出口`, async () => {
        const native = await createFixture();
        native.setPendingOrderMetadataInvalid('OLD', field, kind);
        let rejection: unknown = null;
        try {
          await native.ports.createPendingOrdersReader().todayOrders();
        } catch (error) {
          rejection = error;
        }

        expect(rejection).toBeInstanceOf(TypeError);
        expect(rejection instanceof Error ? rejection.message : null).toMatch(/unknown SDK/);
      });
    }
  }
});
