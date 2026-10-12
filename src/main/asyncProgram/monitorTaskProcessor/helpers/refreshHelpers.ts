/**
 * 席位刷新事实获取助手
 *
 * 获取每个 activation 使用的订单事实，并向唯一账户持仓 owner 登记受控成对读取。
 * 不写 LastState 缓存；请求 receipt 与席位身份的最终授权由 activation owner 验证。
 */
import type {
  AccountPositionSnapshot,
  SnapshotRefreshHandle,
} from '../../../../types/accountPosition.js';
import type { OrderRecorder, RawOrderFromAPI } from '../../../../types/services.js';

/**
 * 创建刷新助手，每个任务独立读取订单，canonical 请求保留调用者 captured dayEpoch。
 * @param deps trader 与唯一 snapshot owner
 * @returns 订单读取与成对 snapshot 请求能力，不发布风险或 ACTIVE
 */
export function createRefreshHelpers({
  trader,
  snapshot,
}: {
  readonly trader: Readonly<{
    orderRecorder: Pick<OrderRecorder, 'fetchAllOrdersFromAPI'>;
  }>;
  readonly snapshot: Pick<AccountPositionSnapshot, 'requestRefresh'>;
}): Readonly<{
  ensureAllOrders: () => Promise<ReadonlyArray<RawOrderFromAPI>>;
  requestAccountPositionRefresh: (dayEpoch: number) => SnapshotRefreshHandle;
}> {
  /** 当前 activation 的独立订单读取；不跨任务复用。 */
  async function ensureAllOrders(): Promise<ReadonlyArray<RawOrderFromAPI>> {
    return trader.orderRecorder.fetchAllOrdersFromAPI();
  }

  /** 使用原 captured epoch 请求 canonical 成对事实；不重取新 epoch 洗白旧任务。 */
  function requestAccountPositionRefresh(dayEpoch: number): SnapshotRefreshHandle {
    return snapshot.requestRefresh({
      source: 'SEAT_ACTIVATION',
      dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    });
  }

  return { ensureAllOrders, requestAccountPositionRefresh };
}
