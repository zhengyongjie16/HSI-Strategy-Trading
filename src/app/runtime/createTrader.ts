/** Trader 装配工厂：依原顺序创建同一 broker、限流器、recorder、tracking 与 execution；不拥有业务推进。 */

import { createAccountService } from '../../application/accountQuery/index.js';
import { createOrderExecutor } from '../../application/orderExecution/index.js';
import { createRateLimiter } from '../../application/orderExecution/rateLimiter.js';
import { createOrderCacheManager } from '../../application/orderTracking/orderCacheManager.js';
import { createOrderHoldRegistry } from '../../application/orderTracking/orderHoldRegistry.js';
import { createOrderMonitor } from '../../application/orderTracking/orderMonitor/index.js';
import { createOrderRecorder } from '../../application/orderTracking/recorder/index.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { PendingOrder, Trader } from '../../types/services.js';
import type { DoomsdayClearanceCommand, ExecutableSignal } from '../../types/signal.js';
import type { OrderFact } from '../../types/trade.js';
import type {
  CancelOrderOutcome,
  DoomsdayCancelOrderOutcome,
  DoomsdayCancelOrderRequest,
  DoomsdayClearanceExecutionResult,
  ExecuteSignalsResult,
  SignalCallerAuthorization,
  TraderCancelOrderRequest,
} from '../../types/trader.js';
import type { ExternalApiRetryConfig } from '../../utils/apiFailure/types.js';
import type { TraderDeps } from './types.js';

/**
 * 装配既有交易能力，业务 owner 分别位于 application。
 * 按固定顺序创建 rateLimiter、accountService、orderCacheManager、orderRecorder、orderMonitor，直接创建共享执行能力并组装 Trader。
 * createTrader 仅负责依赖装配，不执行运行期副作用（如 WebSocket 初始化、订单恢复），由上层显式调用。
 * 按原初始化顺序直接绑定共享能力，保证 orderMonitor 依赖 orderRecorder、orderExecutor 依赖 orderMonitor 等约束。
 * @param deps 依赖（brokerAccess、tradingConfig、unrealizedLossBuyGate、symbolRegistry、dailyLossTracker、postTradeConsistencyRuntime、isExecutionAllowed 等）
 * @returns 实现 Trader 接口的实例（含 canTradeNow、executeSignals、getPendingOrders 等）
 */
export function createTrader(deps: TraderDeps): Promise<Trader> {
  try {
    const {
      tradingConfig,
      marketDataClient,
      unrealizedLossBuyGate,
      symbolRegistry,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress,
      postTradeConsistencyRuntime,
      isExecutionAllowed: isLifecycleExecutionAllowed,
      isContinuousTradingAllowed: isLifecycleContinuousTradingAllowed,
      now,
      scheduleTimer,
      clearTimer,
      readCurrentTradingDayInfo,
      termination,
    } = deps;

    const isExecutionAllowed = (): boolean =>
      !termination.isTerminated() && isLifecycleExecutionAllowed();
    const isContinuousTradingAllowed = (): boolean =>
      !termination.isTerminated() && isLifecycleContinuousTradingAllowed();

    // ========== 1. 创建基础依赖 ==========
    const brokerAccess = deps.brokerAccess();
    const tradeMutationPort = brokerAccess.createTradeMutationPort();

    // ========== 2. 创建无依赖的基础模块 ==========
    const rateLimiter = createRateLimiter(
      deps.rateLimiterConfig === undefined ? {} : { config: deps.rateLimiterConfig },
    );

    const cacheManager = createOrderCacheManager({
      ctx: brokerAccess.createPendingOrdersReader(),
      rateLimiter,
      now,
    });

    const accountService = createAccountService({
      accountReadPort: brokerAccess.createAccountReadPort(),
      rateLimiter,
    });

    // ========== 3. 创建 orderRecorder（边界内组装内部子模块） ==========
    const executionLedgerPort = brokerAccess.createExecutionLedgerPort();
    const orderPushPort = brokerAccess.createOrderPushPort();
    const orderRecorder = createOrderRecorder({
      orderSnapshotReadPort: brokerAccess.createOrderSnapshotReadPort({
        rateLimiter,
        executionLedgerPort,
      }),
      getExecutionTimeEvidence: dailyLossTracker.getExecutionTimeEvidence,
      settlementRefreshNeedRecorder: postTradeConsistencyRuntime,
    });

    // ========== 4. 创建 orderHoldRegistry ==========
    const orderHoldRegistry = createOrderHoldRegistry();

    // ========== 5. 创建 orderMonitor（依赖 orderRecorder） ==========
    const orderMonitor = createOrderMonitor({
      orderDetailReadPort: brokerAccess.createOrderDetailReadPort(),
      executionLedgerPort,
      orderPushPort,
      tradeMutationPort,
      rateLimiter,
      marketDataClient,
      cacheManager,
      orderRecorder,
      dailyLossTracker,
      orderHoldRegistry,
      protectiveLiquidationEpisodeTracker,
      persistProtectiveLiquidationExecutionProgress,
      postTradeConsistencyRuntime,
      tradingConfig,
      symbolRegistry,
      isContinuousTradingAllowed,
      now,
      scheduleTimer,
      clearTimer,
      termination,
    });

    // 同一同步装配段创建唯一 executor，绑定上述真实 tracking/cache/recorder。
    const orderExecutor = createOrderExecutor({
      readSellPositions: brokerAccess.createSellPositionReader(),
      tradeMutationPort,
      rateLimiter,
      marketDataClient,
      cacheManager,
      orderMonitor,
      orderRecorder,
      unrealizedLossBuyGate,
      tradingConfig,
      symbolRegistry,
      isExecutionAllowed,
      isContinuousTradingAllowed,
      now,
      readCurrentTradingDayInfo,
    });

    function cancelOrder(
      orderId: string,
      request: TraderCancelOrderRequest,
    ): Promise<CancelOrderOutcome> {
      return orderMonitor.cancelOrder(orderId, request);
    }

    function cancelDoomsdayOrder(
      orderId: string,
      request: DoomsdayCancelOrderRequest,
    ): Promise<DoomsdayCancelOrderOutcome> {
      return orderMonitor.cancelDoomsdayOrder(orderId, request);
    }

    // 创建 Trader 实例
    const trader: Trader = {
      orderRecorder,

      // ==================== 账户相关方法 ====================

      getAccountSnapshot(params?: {
        readonly retryConfig?: ExternalApiRetryConfig;
      }): Promise<AccountSnapshot> {
        return accountService.getAccountSnapshot(params);
      },

      getStockPositions(params?: {
        readonly symbols?: ReadonlyArray<string> | null;
        readonly retryConfig?: ExternalApiRetryConfig;
      }): Promise<ReadonlyArray<Position>> {
        return accountService.getStockPositions(params);
      },

      // ==================== 订单缓存相关方法 ====================

      getPendingOrders(
        symbols: ReadonlyArray<string> | null = null,
        forceRefresh: boolean = false,
      ): Promise<ReadonlyArray<PendingOrder>> {
        return cacheManager.getPendingOrders(symbols, forceRefresh);
      },

      seedOrderHoldSymbols(orders: ReadonlyArray<OrderFact>): void {
        orderHoldRegistry.seedFromOrders(orders);
      },

      getOrderHoldSymbols(): ReadonlySet<string> {
        return orderHoldRegistry.getHoldSymbols();
      },

      onOrderHoldSymbolsChanged(listener) {
        return orderHoldRegistry.onOrderHoldSymbolsChanged(listener);
      },

      // ==================== 订单监控相关方法 ====================

      teardown: orderMonitor.teardown,

      cancelOrder,
      cancelDoomsdayOrder,

      startOrderMonitorRuntime(): void {
        orderMonitor.startRuntime();
      },

      stopOrderMonitorRuntimeAndDrain(): Promise<void> {
        return orderMonitor.stopRuntimeAndDrain();
      },

      hasPendingProtectiveLiquidationOrders(direction): boolean {
        return orderMonitor.hasPendingProtectiveLiquidationOrders(direction);
      },

      initializeOrderMonitor(): Promise<void> {
        return orderMonitor.initialize();
      },

      onOrderStateChanged(listener) {
        return orderMonitor.onOrderStateChanged(listener);
      },

      // ==================== 订单执行相关方法 ====================

      canTradeNow(signalAction) {
        return orderExecutor.canTradeNow(signalAction);
      },

      fetchAllOrdersFromAPI(): Promise<ReadonlyArray<OrderFact>> {
        return orderRecorder.fetchAllOrdersFromAPI();
      },

      resetRuntimeState(): void {
        orderRecorder.resetAll();
        cacheManager.clearCache();
        orderHoldRegistry.clear();
        orderMonitor.clearTrackedOrders();
        orderExecutor.resetBuyThrottle();
      },

      recoverOrderTrackingFromSnapshot(allOrders: ReadonlyArray<OrderFact>): Promise<void> {
        return orderMonitor.recoverOrderTrackingFromSnapshot(allOrders);
      },

      executeSignals(
        signals: ReadonlyArray<ExecutableSignal>,
        callerAuthorization: SignalCallerAuthorization,
      ): Promise<ExecuteSignalsResult> {
        return orderExecutor.executeSignals(signals, callerAuthorization);
      },

      executeDoomsdayClearanceSignals(
        commands: ReadonlyArray<DoomsdayClearanceCommand>,
        callerAuthorization: SignalCallerAuthorization,
      ): Promise<DoomsdayClearanceExecutionResult> {
        return orderExecutor.executeDoomsdayClearanceSignals(commands, callerAuthorization);
      },
    };

    return Promise.resolve(trader);
  } catch (error) {
    const createTraderError =
      error instanceof Error ? error : new Error(`createTrader failed: ${String(error)}`);
    return Promise.reject(createTraderError);
  }
}
