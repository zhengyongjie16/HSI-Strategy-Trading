/**
 * runApp 生产默认依赖。
 *
 * 此模块是 app 顶层运行期协作者的唯一生产组装点；测试仅替换本模块，
 * 不得 mock 这些协作者各自的共享模块。
 */
import { validateRuntimeSymbolsFromQuotesMap } from '../config/validator/index.js';
import { createBusinessEventProgram } from '../main/businessEventProgram/index.js';
import { createRebuildTradingDayState } from '../main/lifecycle/rebuildTradingDayState.js';
import { createTimeWakeupRuntime } from '../main/timeWakeupRuntime/index.js';
import { displayAccountAndPositions } from '../services/accountDisplay/index.js';
import { logger } from '../utils/logger/index.js';
import { formatError } from '../utils/error/index.js';
import { createLifecycleRuntime } from './lifecycle/createLifecycleRuntime.js';
import { createAsyncRuntime } from './runtime/createAsyncRuntime.js';
import { createPostGateRuntime } from './runtime/createPostGateRuntime.js';
import { createPreGateRuntime } from './runtime/createPreGateRuntime.js';
import { createCleanup } from './shutdown/createCleanup.js';
import { loadStartupSnapshot } from './startup/startupSnapshot.js';
import { collectRuntimeValidationSymbols } from './startup/runtimeValidation.js';
import { registerDelayedSignalHandlers } from './wiring/registerDelayedSignalHandlers.js';
import { applyStartupSnapshotFailureState } from '../main/lifecycle/startupFailureState.js';
import type { RunAppDeps } from './types.js';

/**
 * 等待 app 进程关闭信号。
 *
 * @returns 收到 SIGINT 或 SIGTERM 后完成的 Promise
 */
function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const handleShutdown = (): void => {
      process.off('SIGINT', handleShutdown);
      process.off('SIGTERM', handleShutdown);
      resolve();
    };

    process.once('SIGINT', handleShutdown);
    process.once('SIGTERM', handleShutdown);
  });
}

export const DEFAULT_RUN_APP_DEPS: RunAppDeps = {
  createPreGateRuntime,
  createPostGateRuntime,
  loadStartupSnapshot,
  collectRuntimeValidationSymbols,
  createRebuildTradingDayState,
  displayAccountAndPositions,
  registerDelayedSignalHandlers,
  createBusinessEventProgram,
  createAsyncRuntime,
  createLifecycleRuntime,
  createCleanup,
  createTimeWakeupRuntime,
  waitForShutdownSignal,
  logger,
  formatError,
  validateRuntimeSymbolsFromQuotesMap,
  applyStartupSnapshotFailureState,
};
