/**
 * 席位换标用例
 *
 * 功能：以周期替换与距离移仓独立 policy 推进换标。
 * 职责：支持「距离换标 + 周期换标」统一状态机推进，并处理撤单/卖出/买入完整链路。
 * 执行流程：application 周期任务调用 evaluatePeriodicSwitchDue，行情距离事件调用 startSwitchOnDistance，switch wakeup 继续 advancePendingSwitch；完成后交付 ACTIVATING。
 */
import {
  ORDER_READ_STATUS_VALUES,
  isOpenOrderReadStatus,
} from '../../constants/orderReadMetadata.js';
import { calculateTradingDurationMsBetween } from '../../domain/tradingSession/index.js';
import { getHKDateKey } from '../../utils/time/index.js';
import { AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY } from '../../constants/index.js';
import type { SeatSwitchWorkflowDeps } from './types.js';
import type { SeatSwitchWorkflow } from '../../types/seatSwitch.js';
import type {
  PeriodicSwitchInternalPendingState,
  SwitchState,
  SwitchSuppression,
} from '../../domain/seat/types.js';
import { calculateBuyQuantityByNotional } from '../../domain/seat/switchPolicy.js';
import { createSignalBuilder, resolveDirectionSymbols } from './signalBuilder.js';
import { createSeatStateManager } from './seatStateManager.js';
import { createSwitchStateMachine } from './switchStateMachine.js';

/**
 * 创建席位换标用例。通过距离阈值触发换标并执行撤单/卖出/买入链路。
 *
 * @param deps 依赖（监控配置、席位注册表、行情客户端、交易器、风控、订单记录等）
 * @returns 唯一 SeatSwitchWorkflow
 */
export function createSeatSwitchWorkflow(deps: SeatSwitchWorkflowDeps): SeatSwitchWorkflow {
  const {
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    cacheManager,
    orderHoldRegistry,
    orderMonitor,
    orderExecutor,
    riskChecker,
    orderRecorder,
    candidateSearch,
    logger,
    getTradingCalendarSnapshot,
    clock,
  } = deps;
  const { now } = clock;
  const monitorSymbol = monitorConfig.monitorSymbol;
  const autoSearchConfig = monitorConfig.autoSearchConfig;
  const switchStates = new Map<'LONG' | 'SHORT', SwitchState>();
  const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();
  const periodicSwitchPending = new Map<'LONG' | 'SHORT', PeriodicSwitchInternalPendingState>();
  const signalBuilder = createSignalBuilder(clock);
  const seatStateManager = createSeatStateManager({
    symbolRegistry,
    switchSuppressions,
    now,
    logger,
    getHKDateKey,
  });
  const switchStateMachine = createSwitchStateMachine({
    autoSearchConfig,
    monitorSymbol,
    symbolRegistry,
    cacheManager,
    orderHoldRegistry,
    orderMonitor,
    orderExecutor,
    orderRecorder,
    riskChecker,
    marketDataClient,
    now,
    switchStates,
    periodicSwitchPending,
    resolveSuppression: seatStateManager.resolveSuppression,
    markSuppression: seatStateManager.markSuppression,
    enterSwitchingSeat: seatStateManager.enterSwitchingSeat,
    updateSeatState: seatStateManager.updateSeatState,
    candidateSearch,
    resolveDirectionSymbols,
    calculateBuyQuantityByNotional,
    buildOrderSignal: signalBuilder.buildOrderSignal,
    pendingOrderStatuses: new Set([...ORDER_READ_STATUS_VALUES].filter(isOpenOrderReadStatus)),
    buySide: 'BUY',
    logger,
    maxSearchFailuresPerDay: AUTO_SYMBOL_MAX_SEARCH_FAILURES_PER_DAY,
    getHKDateKey,
    calculateTradingDurationMsBetween,
    getTradingCalendarSnapshot,
  });

  /** 清空换标状态与日内抑制记录，用于交易日切换或重新初始化。 */
  function resetAllState(): void {
    switchStates.clear();
    switchSuppressions.clear();
    periodicSwitchPending.clear();
  }
  return {
    evaluatePeriodicSwitchDue: switchStateMachine.evaluatePeriodicSwitchDue,
    startSwitchOnDistance: switchStateMachine.startSwitchOnDistance,
    advancePendingSwitch: switchStateMachine.advancePendingSwitch,
    hasPendingSwitch: switchStateMachine.hasPendingSwitch,
    getPeriodicSwitchPendingState: (direction) => ({
      pending: periodicSwitchPending.get(direction)?.pending ?? false,
    }),
    resetAllState,
  };
}
