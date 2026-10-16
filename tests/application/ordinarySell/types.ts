import type {
  OrdinarySellWorkflow,
  OrdinarySellWorkflowDeps,
} from '../../../src/application/ordinarySell/types.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { Position } from '../../../src/types/account.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { PostTradeConsistencyRuntime } from '../../../src/app/runtime/types.js';

/** 真实 H/S 已初始化的 SELL 镜像装配结果；只为本切面测试提供显式发布与清理。 */
export type SellHarness = {
  readonly workflow: OrdinarySellWorkflow;
  readonly deps: OrdinarySellWorkflowDeps;
  readonly snapshot: AccountPositionSnapshot;
  readonly settlement: PostTradeConsistencyRuntime;
  readonly context: MonitorContextAssembly;
  readonly setPositions: (positions: ReadonlyArray<Position>) => void;
  readonly publishPositions: () => Promise<void>;
};
