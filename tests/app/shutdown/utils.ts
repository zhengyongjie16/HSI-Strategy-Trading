import type { CleanupController } from '../../../src/app/types.js';
import type { LastState, MonitorState } from '../../../src/types/state.js';
import { createMonitorContextDouble } from '../../helpers/testDoubles.js';
import type { CleanupTestOverrides } from './types.js';

/**
 * 构造单监控标的的 MonitorState，含默认指标快照，供 cleanup 测试使用。
 *
 * @param monitorSymbol 监控标的代码
 * @returns 用于测试的 MonitorState
 */
export function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    lastMonitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    incrementalIndicatorRuntime: null,
  };
}

/**
 * 构造 LastState，仅填充 monitorState 与基础字段，其余为测试用占位，供 cleanup 测试使用。
 *
 * @param monitorState 唯一监控状态
 * @returns 用于测试的 LastState
 */
export function createLastState(monitorState: MonitorState): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorState,
    allTradingSymbols: new Set(),
  };
}

/**
 * 按生产阶段直接向真实 cleanup owner 登记测试 disposer。
 *
 * @param cleanup 真实 cleanup owner
 * @param steps 步骤记录数组
 * @param overrides 需要观察的测试 disposer 覆盖
 */
export function registerCleanupSteps(
  cleanup: CleanupController,
  steps: string[],
  overrides: CleanupTestOverrides = {},
): void {
  const lastState = overrides.lastState ?? createLastState(createMonitorState('HSI.HK'));
  const monitorContext = overrides.monitorContext ?? createMonitorContextDouble();
  const registerStep = (
    phase: Parameters<CleanupController['register']>[0]['phase'],
    step: string,
    handler: () => Promise<void> | void,
  ): void => {
    cleanup.register({ phase, step, handler });
  };

  registerStep('CLOSE_TRADING_GATE', '关闭交易门禁', () => {
    lastState.isTradingEnabled = false;
  });

  registerStep('ABORT_FRESHNESS_WAITING', '终止 Freshness 等待', () => {
    if (overrides.abortWaiting !== undefined) {
      overrides.abortWaiting();
      return;
    }

    steps.push('abortWaiting');
  });

  registerStep('STOP_TIME_WAKEUP_RUNTIME', '停止 TimeWakeupRuntime', () => {
    steps.push('timeWakeupRuntime');
  });

  registerStep('STOP_BUSINESS_EVENT_PROGRAM', '停止 BusinessEventProgram', () => {
    steps.push('businessEventProgram');
  });

  registerStep('STOP_TRADING_RISK_EVENT_RUNTIME', '停止 TradingRiskEventRuntime', () => {
    steps.push('tradingRiskEventRuntime');
  });

  registerStep('STOP_MONITOR_QUOTE_EVENT_RUNTIME', '停止 MonitorQuoteEventRuntime', () => {
    steps.push('monitorQuoteEventRuntime');
  });

  registerStep('STOP_MONITOR_DISPLAY_RUNTIME', '停止 MonitorDisplayRuntime', () => {
    steps.push('monitorDisplayRuntime');
  });

  registerStep('STOP_TRADING_QUOTE_DISPLAY_RUNTIME', '停止 TradingQuoteDisplayRuntime', () => {
    steps.push('tradingQuoteDisplayRuntime');
  });

  registerStep('STOP_SWITCH_WAKEUP_RUNTIME', '停止 SwitchWakeupRuntime', () => {
    steps.push('switchWakeupRuntime');
  });

  registerStep('STOP_PERIODIC_SWITCH_WAKEUP_RUNTIME', '停止 PeriodicSwitchWakeupRuntime', () => {
    steps.push('periodicSwitchWakeupRuntime');
  });

  registerStep('STOP_AUTO_SEARCH_WAKEUP_RUNTIME', '停止 AutoSearchWakeupRuntime', () => {
    steps.push('autoSearchWakeupRuntime');
  });

  registerStep('STOP_SEAT_ACTIVATION_DISPATCHER', '停止 SeatActivationDispatcher', () => {
    steps.push('seatActivationDispatcher');
  });

  registerStep('STOP_MONITOR_TASK_PROCESSOR', '停止 MonitorTaskProcessor', () => {
    steps.push('monitorTask');
  });

  registerStep('STOP_SEAT_RUNTIME_CLEANUP_DISPATCHER', '停止 SeatRuntimeCleanupDispatcher', () => {
    steps.push('seatRuntimeCleanupDispatcher');
  });

  registerStep('STOP_BUY_PROCESSOR', '停止 BuyProcessor', async () => {
    if (overrides.stopBuyProcessorAndDrain !== undefined) {
      await overrides.stopBuyProcessorAndDrain();
      return;
    }

    steps.push('buy');
  });

  registerStep('STOP_SELL_PROCESSOR', '停止 SellProcessor', () => {
    steps.push('sell');
  });

  registerStep('STOP_ORDER_MONITOR_RUNTIME', '停止订单监控 runtime', () => {
    steps.push('stopOrderMonitorRuntimeAndDrain');
  });

  registerStep('UNSUBSCRIBE_TRADER_LISTENER', '取消 Trader 订单状态监听', () => {
    steps.push('unsubscribeTraderListener');
  });

  registerStep('STOP_QUOTE_SUBSCRIPTION_RUNTIME', '停止 QuoteSubscriptionRuntime', () => {
    steps.push('quoteSubscriptionRuntime');
  });

  registerStep('STOP_POST_TRADE_CONSISTENCY_RUNTIME', '停止 PostTradeConsistencyRuntime', () => {
    steps.push('postTradeConsistencyRuntime');
  });

  registerStep(
    'DESTROY_DELAYED_SIGNAL_VERIFIER',
    `销毁延迟验证器 ${monitorContext.config.monitorSymbol}`,
    () => {
      monitorContext.delayedSignalVerifier.destroy();
    },
  );

  registerStep('CLEAR_INDICATOR_CACHE', '清空指标缓存', () => {
    steps.push('clearIndicatorCache');
  });

  registerStep('CLEAR_MONITOR_SNAPSHOT', '清空监控快照引用', () => {
    lastState.monitorState.lastMonitorSnapshot = null;
  });

  registerStep('RESET_MARKET_DATA_RUNTIME', '重置行情运行态订阅与缓存', () => {
    steps.push('resetMarketData');
  });
}
