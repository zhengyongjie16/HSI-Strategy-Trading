import type { LastState, MonitorContext } from '../../../src/types/state.js';

/**
 * cleanup 测试 disposer 覆盖项。
 * 类型用途：为完整 cleanup 顺序 helper 注入需要单独观察的状态与 handler。
 * 数据来源：由 createCleanup 业务测试按场景提供。
 * 使用范围：仅 tests/app/shutdown 测试使用。
 */
export type CleanupTestOverrides = Readonly<{
  lastState?: LastState;
  monitorContext?: MonitorContext;
  abortWaiting?: () => void;
  stopBuyProcessorAndDrain?: () => Promise<void>;
}>;
