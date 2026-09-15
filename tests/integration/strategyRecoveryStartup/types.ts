import type { LastState } from '../../../src/types/state.js';
import type { PostGateRuntime } from '../../../src/app/types.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';
import type { OrderMonitorRuntimeStore } from '../../../src/core/trader/orderMonitor/types.js';
import type { OrderRecorder, OrderStateChangedEvent } from '../../../src/types/services.js';
import type { OrderHoldRegistry } from '../../../src/core/trader/types.js';
import type { createTradeContextMock } from '../../../mock/longbridge/tradeContextMock.js';

/** 启动装配中注入真实恢复入口，供独立 T28 集成使用。 */
export type StartupRecoveryHarnessParams = {
  readonly recover: () => Promise<void>;
};

/** 四种 broker/启动快照输入，仅用于离线恢复验收。 */
export type RecoveryScenario = 'accepted' | 'zero' | 'conflict' | 'external';

/** 实际 app 状态与外围 owner 观察端口。 */
export type StartupRecoveryHarness = {
  readonly starts: string[];
  readonly lastState: LastState;
  readonly post: PostGateRuntime;
  readonly classifiedErrors: unknown[];
  readonly timeStarted: Promise<undefined>;
  readonly shutdown: () => void;
  readonly fatalState: () => ReturnType<RuntimeTermination['getFatalState']> | undefined;
  readonly run: () => Promise<void>;
};

/** 真实恢复子流程共用的运行态与可控 broker 请求边界。 */
export type RecoveryHarness = {
  readonly runtime: OrderMonitorRuntimeStore;
  readonly broker: ReturnType<typeof createTradeContextMock>;
  readonly orderRecorder: OrderRecorder;
  readonly orderHoldRegistry: OrderHoldRegistry;
  readonly events: OrderStateChangedEvent[];
  readonly steps: string[];
  readonly entered: Promise<undefined>;
  readonly complete: () => void;
  readonly useTrustedZero: () => void;
  readonly error: () => unknown;
  readonly recover: () => Promise<void>;
};
