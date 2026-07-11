/**
 * app 监控上下文装配模块
 *
 * 职责：
 * - 创建单 monitor 的 MonitorContext
 * - 以 SymbolRegistry 作为席位真相，仅根据启动 quotesMap 派生标的名称缓存
 * - 将唯一 monitor 配置装配为纯返回值，由调用方持有唯一上下文
 * - 固化 monitorState 与 tradingConfig.monitor 的一一对应装配不变量
 */
import { createMultiIndicatorTradingStrategy } from '../../core/strategy/index.js';
import { createPositionLimitChecker } from '../../core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../../core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../../core/riskController/unrealizedLossMonitor.js';
import { createWarrantRiskChecker } from '../../core/riskController/warrantRiskChecker.js';
import { createDelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/index.js';
import { createAutoSymbolManager } from '../../services/autoSymbolManager/index.js';
import { compileIndicatorUsageProfile } from '../../services/indicators/profile/index.js';
import type { MonitorContext } from '../../types/state.js';
import { resolveMonitorContextSymbolNames } from '../../utils/seat/snapshots.js';
import type { CreateMonitorContextParams, MonitorContextFactoryDeps } from '../types.js';

const DEFAULT_STRATEGY_FACTORY = createMultiIndicatorTradingStrategy;

function applySymbolNamesToMonitorContext(
  monitorContext: MonitorContext,
  symbolNames: ReturnType<typeof resolveMonitorContextSymbolNames>,
): void {
  monitorContext.longSymbolName = symbolNames.longSymbolName;
  monitorContext.shortSymbolName = symbolNames.shortSymbolName;
  monitorContext.monitorSymbolName = symbolNames.monitorSymbolName;
}

/**
 * 创建监控标的运行时上下文，直接持有 SymbolRegistry 作为席位真相，从行情 Map 提取标的名称，
 * 并预编译指标画像，避免运行期重复解析。
 *
 * @param deps 工厂依赖（config、state、symbolRegistry、quotesMap、strategy、orderRecorder 等）
 * @returns 该监控标的的 MonitorContext 实例
 */
function buildMonitorContext(deps: MonitorContextFactoryDeps): MonitorContext {
  const {
    config,
    state,
    symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    autoSymbolManager,
  } = deps;
  const symbolNames = resolveMonitorContextSymbolNames({
    symbolRegistry,
    monitorSymbol: config.monitorSymbol,
    quotesMap: quotesMap ?? new Map<string, null>(),
  });
  const indicatorProfile = compileIndicatorUsageProfile({
    signalConfig: config.signalConfig,
    verificationConfig: config.verificationConfig,
  });

  return {
    config,
    state,
    symbolRegistry,
    autoSymbolManager,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    longSymbolName: symbolNames.longSymbolName,
    shortSymbolName: symbolNames.shortSymbolName,
    monitorSymbolName: symbolNames.monitorSymbolName,
    indicatorProfile,
  };
}

/**
 * 刷新唯一 monitorContext 的标的名称缓存。
 * 默认行为：名称从唯一配置与当前席位真相直接派生，不重建上下文本体。
 *
 * @param params 需要刷新的 monitorContext 与最新 quotesMap
 * @returns 无返回值
 */
export function syncMonitorContextSymbolNames(params: {
  readonly monitorContext: MonitorContext;
  readonly quotesMap: MonitorContextFactoryDeps['quotesMap'];
}): void {
  const symbolNames = resolveMonitorContextSymbolNames({
    symbolRegistry: params.monitorContext.symbolRegistry,
    monitorSymbol: params.monitorContext.config.monitorSymbol,
    quotesMap: params.quotesMap ?? new Map<string, null>(),
  });
  applySymbolNamesToMonitorContext(params.monitorContext, symbolNames);
}

/**
 * 创建唯一监控上下文。
 * 默认行为：唯一 monitor 直接绑定 lastState.monitorState，若状态标的与配置不一致则直接抛错。
 *
 * @param params 监控上下文装配所需的 pre/post gate 运行时对象与 quotesMap
 * @returns 唯一 MonitorContext
 */
export function createMonitorContext(params: CreateMonitorContextParams): MonitorContext {
  const {
    preGateRuntime,
    postGateRuntime,
    quotesMap,
    strategyFactory = DEFAULT_STRATEGY_FACTORY,
  } = params;

  const monitorConfig = preGateRuntime.tradingConfig.monitor;
  const monitorState = postGateRuntime.lastState.monitorState;
  if (monitorState.monitorSymbol !== monitorConfig.monitorSymbol) {
    throw new Error(
      `监控状态与配置标的不一致: state=${monitorState.monitorSymbol}, config=${monitorConfig.monitorSymbol}`,
    );
  }

  const riskChecker = createRiskChecker({
    warrantRiskChecker: createWarrantRiskChecker(),
    positionLimitChecker: createPositionLimitChecker({
      maxPositionNotional: monitorConfig.maxPositionNotional,
    }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
    }),
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
  const strategy = strategyFactory({
    signalConfig: monitorConfig.signalConfig,
    verificationConfig: monitorConfig.verificationConfig,
  });
  return buildMonitorContext({
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
    delayedSignalVerifier: createDelayedSignalVerifier({
      indicatorCache: postGateRuntime.indicatorCache,
    }),
    autoSymbolManager,
  });
}
