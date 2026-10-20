/** 交易实例装配工厂：依原顺序创建同一 broker、限流器、recorder、tracking 与 execution；不拥有业务推进。 */

import { createAccountService } from '../../application/accountQuery/index.js';
import { createOrderExecutor } from '../../application/orderExecution/index.js';
import { createRateLimiter } from '../../application/orderExecution/rateLimiter.js';
import { createOrderCacheManager } from '../../application/orderTracking/orderCacheManager.js';
import { createOrderHoldRegistry } from '../../application/orderTracking/orderHoldRegistry.js';
import { createOrderMonitor } from '../../application/orderTracking/orderMonitor/index.js';
import { createOrderRecorder } from '../../application/orderTracking/recorder/index.js';
import type { CreateTradeRuntimeDeps, TradeRuntime } from './types.js';

/**
 * 装配既有交易能力，业务 owner 分别位于 application。
 * 按固定顺序创建 rateLimiter、accountService、orderCacheManager、orderRecorder、orderMonitor，直接创建共享执行能力并返回六个真实实例。
 * createTradeRuntime 仅负责依赖装配，不执行运行期副作用（如 WebSocket 初始化、订单恢复），由上层显式调用。
 * 按原初始化顺序直接绑定共享能力，保证 orderMonitor 依赖 orderRecorder、orderExecutor 依赖 orderMonitor 等约束。
 * @param deps 依赖（brokerAccess、tradingConfig、unrealizedLossBuyGate、symbolRegistry、dailyLossTracker、postTradeConsistencyRuntime、isExecutionAllowed 等）
 * @returns 同一账户、缓存、订单记录、订阅保留集、监控与执行实例
 */
export function createTradeRuntime(deps: CreateTradeRuntimeDeps): Promise<TradeRuntime> {
  try {
    const {
      logger,
      diagnostics,
      wait,
      nowMonotonicMs,
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
      deps.rateLimiterConfig === undefined
        ? { logger, wait, nowMonotonicMs }
        : { logger, wait, nowMonotonicMs, config: deps.rateLimiterConfig },
    );

    const cacheManager = createOrderCacheManager({
      requestExternalApi: deps.requestExternalApi,
      logger: logger,
      ctx: brokerAccess.createPendingOrdersReader(),
      rateLimiter,
      now,
    });

    const accountService = createAccountService({
      accountReadPort: brokerAccess.createAccountReadPort(),
      rateLimiter,
    });

    // ========== 3. 创建 orderRecorder（边界内组装内部子模块） ==========
    const orderPushPort = brokerAccess.createOrderPushPort();
    const orderRecorder = createOrderRecorder({
      logger: logger,
      orderSnapshotReadPort: brokerAccess.createOrderSnapshotReadPort({ rateLimiter }),
      settlementRefreshNeedRecorder: postTradeConsistencyRuntime,
    });

    // ========== 4. 创建 orderHoldRegistry ==========
    const orderHoldRegistry = createOrderHoldRegistry();

    // ========== 5. 创建 orderMonitor（依赖 orderRecorder） ==========
    const orderMonitor = createOrderMonitor({
      wait,
      scheduleBoundedOneShotAt: deps.scheduleBoundedOneShotAt,
      requestExternalApi: deps.requestExternalApi,
      logger: logger,
      diagnostics,
      orderDetailReadPort: brokerAccess.createOrderDetailReadPort(),
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
      logger: logger,
      diagnostics,
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

    return Promise.resolve({
      accountService,
      cacheManager,
      orderRecorder,
      orderHoldRegistry,
      orderMonitor,
      orderExecutor,
    });
  } catch (error) {
    const createTradeRuntimeError =
      error instanceof Error ? error : new Error(`createTradeRuntime failed: ${String(error)}`);
    return Promise.reject(createTradeRuntimeError);
  }
}
