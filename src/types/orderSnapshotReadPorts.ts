/** 已验证broker订单快照读取行为；原SDK实例/金融对象留在infra，非pure-data资格。 */
import type { RawOrderFromAPI } from './services.js';

export interface OrderSnapshotReadPort {
  readonly fetchSnapshots: () => Promise<
    Readonly<{
      historyOrders: ReadonlyArray<RawOrderFromAPI>;
      todayOrders: ReadonlyArray<RawOrderFromAPI>;
    }>
  >;
}
