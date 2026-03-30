/**
 * app 单实例策略运行时装配入口
 *
 * 职责：
 * - 为单实例运行时配置创建风险检查器、策略、自动寻标管理器与 StrategyRuntime
 * - 固化 strategyState 与 tradingConfig 的单实例装配不变量
 * - 统一写回 post-gate runtime 持有的 strategyRuntime
 */
import { createTrendContinuationStrategy } from '../core/strategy/index.js';
import { createPositionLimitChecker } from '../core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../core/riskController/index.js';
import { createUnrealizedLossChecker } from '../core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../core/riskController/unrealizedLossMonitor.js';
import { createWarrantRiskChecker } from '../core/riskController/warrantRiskChecker.js';
import { createAutoSymbolManager } from '../services/autoSymbolManager/index.js';
import { createStrategyRuntime } from './createStrategyRuntime.js';
import type { BuildStrategyRuntimeParams } from './types.js';

/**
 * 创建单实例策略运行时。
 * 默认行为：若 strategyState 与单实例运行时配置不一致，则视为装配不变量被破坏并直接抛错。
 *
 * @param params 运行时装配所需的 pre/post gate 对象与 quotesMap
 * @returns 无返回值；直接填充 postGateRuntime.monitorContext（单实例 runtime 句柄）
 */
export function buildStrategyRuntime(params: BuildStrategyRuntimeParams): void {
  const {
    preGateRuntime,
    postGateRuntime,
    quotesMap,
    strategyFactory = createTrendContinuationStrategy,
  } = params;

  const { monitorConfig } = preGateRuntime;
  const monitorState = postGateRuntime.lastState.monitorState;
  if (monitorState.baseInstrumentSymbol !== monitorConfig.baseInstrumentSymbol) {
    throw new Error(`监控状态与单实例配置不一致: ${monitorConfig.baseInstrumentSymbol}`);
  }

  const riskChecker = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker(),
    positionLimitChecker: createPositionLimitChecker({
      maxPositionNotional: monitorConfig.maxPositionNotional,
    }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
    }),
    options: {
      maxPositionNotional: monitorConfig.maxPositionNotional,
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
    },
  });
  const autoSymbolManager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry: preGateRuntime.symbolRegistry,
    marketDataClient: preGateRuntime.marketDataClient,
    trader: postGateRuntime.trader,
    orderRecorder: postGateRuntime.trader.orderRecorder,
    riskChecker,
    warrantListCacheConfig: preGateRuntime.warrantListCacheConfig,
    getTradingCalendarSnapshot: () =>
      postGateRuntime.lastState.tradingCalendarSnapshot ?? new Map(),
  });
  const strategy = strategyFactory(monitorConfig.strategyConfig);
  const context = createStrategyRuntime({
    config: monitorConfig,
    state: monitorState,
    symbolRegistry: preGateRuntime.symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder: postGateRuntime.trader.orderRecorder,
    dailyLossTracker: postGateRuntime.dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor: createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
    }),
    autoSymbolManager,
  });

  postGateRuntime.monitorContext = context;
}
