import type { SettlementReadinessReceipt } from './settlement.js';

/** 周期换标原route身份；来自真实席位和原canonical交易日，不包含当下补发的授权票。 */
export type PeriodicSwitchRouteBaseline = Readonly<{
  direction: 'LONG' | 'SHORT';
  symbol: string;
  seatVersion: number;
  lastSeatActivatedAt: number;
  dayEpoch: number;
}>;

/** 周期任务保存的原Sreceipt与route/work闭包，跨quote/broker await原样传递。 */
export type PeriodicSwitchTaskAuthorization = PeriodicSwitchRouteBaseline &
  Readonly<{
    readinessReceipt: SettlementReadinessReceipt;
    canContinue: () => boolean;
    isRouteCurrent: () => boolean;
  }>;

/** 入队周期任务数据；currentTimeMs为原派发时间，不在迟到执行时改成当前票。 */
export type PeriodicSwitchTaskData = PeriodicSwitchTaskAuthorization &
  Readonly<{
    currentTimeMs: number;
  }>;
