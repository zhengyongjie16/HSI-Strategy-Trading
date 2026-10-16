import { lstat, readdir, realpath } from 'node:fs/promises';

/**
 * runApp 生产默认依赖。
 *
 * 此模块是 app 顶层运行期协作者的唯一生产组装点；测试仅替换本模块，
 * 不得 mock 这些协作者各自的共享模块。
 */
import { validateRuntimeSymbolsFromQuotesMap } from '../config/validator/index.js';
import { createBusinessEventProgram } from '../runtime/businessEventProgram/index.js';
import { createRebuildTradingDayState } from '../application/tradingDayRebuild/rebuildTradingDayState.js';
import { executeStartupRebuild } from '../application/tradingDayRebuild/startupRebuild.js';
import { createTimeWakeupRuntime } from '../runtime/timeWakeupRuntime/index.js';
import { displayAccountAndPositions } from '../infrastructure/display/accountDisplay/index.js';
import { logger } from '../infrastructure/logger/index.js';
import { formatError } from '../utils/error/index.js';
import { createLifecycleRuntime } from './lifecycle/createLifecycleRuntime.js';
import { createAsyncRuntime } from './runtime/createAsyncRuntime.js';
import { createPostGateRuntime } from './runtime/createPostGateRuntime.js';
import { createPreGateRuntime } from './runtime/createPreGateRuntime.js';
import { createCleanup } from './shutdown/createCleanup.js';
import { loadStartupSnapshot } from '../application/tradingDayRebuild/startupSnapshot.js';
import { collectRuntimeValidationSymbols } from './startup/runtimeValidation.js';
import { prepareStrategy } from './startup/prepareStrategy.js';
import { applyStartupSnapshotFailureState } from '../application/tradingDayRebuild/startupFailureState.js';
import type { RunAppDeps } from './types.js';

/** 在首次资源创建前订阅退出；回调同步关闭交易，清理由 root 等待装配落定后执行。 */
function subscribeShutdownSignal(onShutdown: () => void): () => void {
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);
  return () => {
    process.off('SIGINT', onShutdown);
    process.off('SIGTERM', onShutdown);
  };
}

export const DEFAULT_RUN_APP_DEPS: RunAppDeps = {
  createPreGateRuntime,
  createPostGateRuntime,
  loadStartupSnapshot,
  executeStartupRebuild,
  collectRuntimeValidationSymbols,
  createRebuildTradingDayState,
  displayAccountAndPositions,
  prepareStrategy: (params) =>
    prepareStrategy(params, {
      readDirectory: readdir,
      lstat,
      realpath,
      importModule: (href): Promise<unknown> => import(href),
    }),
  createBusinessEventProgram,
  createAsyncRuntime,
  createLifecycleRuntime,
  createCleanup,
  createTimeWakeupRuntime,
  subscribeShutdownSignal,
  logger,
  formatError,
  validateRuntimeSymbolsFromQuotesMap: (params) =>
    validateRuntimeSymbolsFromQuotesMap({ ...params, logger }),
  applyStartupSnapshotFailureState,
};
