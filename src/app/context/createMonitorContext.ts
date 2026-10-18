/**
 * app 监控上下文装配模块
 *
 * 职责：
 * - 创建单 monitor 的 MonitorContextAssembly
 * - 消费 post-gate 已创建的唯一 RiskChecker，不在上下文内重复创建浮亏缓存
 * - 以 SymbolRegistry 作为席位真相，仅根据启动 quotesMap 派生标的名称缓存
 * - 将唯一 monitor 配置装配为纯返回值，由调用方持有唯一上下文
 */
import { createUnrealizedLossMonitor } from '../../application/protectiveLiquidation/unrealizedLossExecutor.js';
import { createSeatSwitchWorkflow } from '../../application/seatSwitch/index.js';
import type { TradingCalendarState } from '../../types/tradingCalendar.js';
import { resolveMonitorContextSymbolNames } from '../../domain/seat/seatSnapshot.js';
import type {
  CreateMonitorContextParams,
  MonitorContextFactoryDeps,
  MonitorContextAssembly,
} from './types.js';

/**
 * 校验跨越运行时装配边界的交易日历事实，拒绝被强制注入的非法 undefined。
 *
 * @param snapshot 待装配的交易日历快照
 * @returns 已确认存在的交易日历快照
 */
function requireTradingCalendarSnapshot(
  snapshot: TradingCalendarState['tradingCalendarSnapshot'] | undefined,
): TradingCalendarState['tradingCalendarSnapshot'] {
  if (snapshot === undefined) {
    throw new Error('监控上下文装配失败: 缺少交易日历快照');
  }

  return snapshot;
}

function applySymbolNamesToMonitorContext(
  monitorContext: MonitorContextAssembly,
  symbolNames: ReturnType<typeof resolveMonitorContextSymbolNames>,
): void {
  monitorContext.longSymbolName = symbolNames.longSymbolName;
  monitorContext.shortSymbolName = symbolNames.shortSymbolName;
  monitorContext.monitorSymbolName = symbolNames.monitorSymbolName;
}

/**
 * 创建监控标的运行时上下文，直接持有 SymbolRegistry 作为席位真相，从行情 Map 提取标的名称，
 * 并持有 composition root 创建的唯一策略实例。
 *
 * @param deps 工厂依赖（config、symbolRegistry、quotesMap、strategy、orderRecorder 等）
 * @returns 该监控标的的 MonitorContextAssembly 实例
 */
function buildMonitorContext(deps: MonitorContextFactoryDeps): MonitorContextAssembly {
  const {
    config,
    symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    seatSwitch,
  } = deps;
  const symbolNames = resolveMonitorContextSymbolNames({
    symbolRegistry,
    monitorSymbol: config.monitorSymbol,
    quotesMap: quotesMap ?? new Map<string, null>(),
  });

  return {
    config,
    symbolRegistry,
    seatSwitch,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    longSymbolName: symbolNames.longSymbolName,
    shortSymbolName: symbolNames.shortSymbolName,
    monitorSymbolName: symbolNames.monitorSymbolName,
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
  readonly monitorContext: MonitorContextAssembly;
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
 * 默认行为：仅装配宿主能力，策略状态由已注入实例独占。
 *
 * @param params 监控上下文装配所需的 pre/post gate 运行时对象与 quotesMap
 * @returns 唯一 MonitorContextAssembly
 */
export function createMonitorContext(params: CreateMonitorContextParams): MonitorContextAssembly {
  const { preGateRuntime, postGateRuntime, quotesMap, clock, strategy, logger } = params;

  const monitorConfig = preGateRuntime.tradingConfig.monitor;
  const { riskChecker } = postGateRuntime;
  requireTradingCalendarSnapshot(postGateRuntime.tradingCalendarState.tradingCalendarSnapshot);

  const seatSwitch = createSeatSwitchWorkflow({
    monitorConfig,
    symbolRegistry: preGateRuntime.symbolRegistry,
    marketDataClient: preGateRuntime.marketDataClient,
    cacheManager: postGateRuntime.tradeRuntime.cacheManager,
    orderHoldRegistry: postGateRuntime.tradeRuntime.orderHoldRegistry,
    orderMonitor: postGateRuntime.tradeRuntime.orderMonitor,
    orderExecutor: postGateRuntime.tradeRuntime.orderExecutor,
    readSwitchPositions: (symbol) =>
      postGateRuntime.tradeRuntime.accountService.getStockPositions({ symbols: [symbol] }),
    orderRecorder: postGateRuntime.tradeRuntime.orderRecorder,
    riskChecker,
    candidateSearch: postGateRuntime.candidateSearch,
    logger,
    getTradingCalendarSnapshot: () => postGateRuntime.tradingCalendarState.tradingCalendarSnapshot,
    clock,
  });
  return buildMonitorContext({
    config: monitorConfig,
    symbolRegistry: preGateRuntime.symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder: postGateRuntime.tradeRuntime.orderRecorder,
    dailyLossTracker: postGateRuntime.dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor: createUnrealizedLossMonitor({
      logger,
      maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
    }),
    seatSwitch,
  });
}
