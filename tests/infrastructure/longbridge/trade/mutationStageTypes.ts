import type { TradeMutationPort } from '../../../../src/types/tradeMutationPorts.js';

/** 离线 SDK entry 捕获的提交字段，SDK 实例和枚举不向 integration 传播。 */
export type NativeSubmitObservation = {
  readonly orderType: 'LO' | 'ELO' | 'OTHER';
  readonly submittedPrice: string | null;
  readonly submittedQuantity: string;
};

/** 真实 mutation adapter 及其离线 SDK 入口观察。 */
export type NativeSubmitFixture = {
  readonly port: TradeMutationPort;
  readonly calls: ReadonlyArray<NativeSubmitObservation>;
};
