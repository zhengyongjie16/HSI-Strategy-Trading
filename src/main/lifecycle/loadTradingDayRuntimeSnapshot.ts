/**
 * 交易日运行时快照加载模块
 *
 * 核心职责：
 * - 加载交易日所需的完整运行时快照，为开盘重建提供数据基础
 *
 * 加载流程（按顺序执行）：
 * 1. 验证交易日信息（可选）
 * 2. 初始化订单监控订阅（进入 BOOTSTRAPPING）
 * 3. 刷新账户和持仓数据
 * 4. 获取全量订单并解析席位绑定（prepareSeatsForRuntime）
 * 5. 从交易日志水合冷却状态，并基于订单/持仓恢复保护性清仓边界（可选）
 * 6. 基于保护性清仓边界回算日内亏损追踪
 * 7. 重置行情订阅（可选）
 * 8. 收集并订阅所有交易标的的行情和 K 线
 * 9. 返回全量订单和行情快照，供后续重建使用
 *
 * 使用场景：
 * - 程序启动时的首次初始化
 * - 开盘重建流程中由 globalStateDomain 调用
 */
import { OrderSide } from 'longbridge';
import { PENDING_ORDER_STATUSES, TRADING } from '../../constants/index.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isWithinMorningOpenProtection,
} from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsForRuntime } from '../recovery/seatPreparation.js';
import { collectRuntimeQuoteSymbols, refreshAccountAndPositions } from '../utils.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveOrderOwnershipForMonitor } from '../../core/riskController/orderOwnership.js';
import { hasProtectiveLiquidationRemark } from '../../core/trader/utils.js';
import { hasSeatSymbol } from '../../utils/seat/guards.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';

function isDirectionFlatAtSnapshot(
  symbolRegistry: LoadTradingDayRuntimeSnapshotDeps['symbolRegistry'],
  lastState: LoadTradingDayRuntimeSnapshotDeps['lastState'],
  direction: ProtectiveLiquidationDirection,
): boolean {
  const seatState = symbolRegistry.getSeatState(direction);
  if (!hasSeatSymbol(seatState)) {
    return true;
  }

  const position = lastState.positionCache.get(seatState.symbol);
  return position === null || position.quantity <= 0;
}

function restoreCompletedBoundary(params: {
  readonly protectiveLiquidationEpisodeTracker: LoadTradingDayRuntimeSnapshotDeps['protectiveLiquidationEpisodeTracker'];
  readonly restoredBoundaryByDirection: Map<ProtectiveLiquidationDirection, number>;
  readonly direction: ProtectiveLiquidationDirection;
  readonly boundaryExecutedTimeMs: number;
}): void {
  const {
    protectiveLiquidationEpisodeTracker,
    restoredBoundaryByDirection,
    direction,
    boundaryExecutedTimeMs,
  } = params;

  protectiveLiquidationEpisodeTracker.restoreCompletedBoundary({
    direction,
    boundaryExecutedTimeMs,
  });
  restoredBoundaryByDirection.set(direction, boundaryExecutedTimeMs);
}

/**
 * 创建交易日运行时快照加载函数（工厂）。
 * 注入依赖后返回 loadTradingDayRuntimeSnapshot，用于启动初始化与开盘重建时加载账户、持仓、订单、席位与行情快照。
 *
 * @param deps 依赖注入（marketDataClient、trader、lastState、monitorConfig、symbolRegistry、dailyLossTracker、tradeLogHydrator、warrantListCacheConfig）
 * @returns 接收 LoadTradingDayRuntimeSnapshotParams 的异步函数，返回全量订单与行情快照供重建使用
 */
export function createLoadTradingDayRuntimeSnapshot(
  deps: LoadTradingDayRuntimeSnapshotDeps,
): (params: LoadTradingDayRuntimeSnapshotParams) => Promise<LoadTradingDayRuntimeSnapshotResult> {
  const {
    marketDataClient,
    trader,
    lastState,
    monitorConfig,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  } = deps;

  /**
   * 加载交易日完整运行时快照：验证交易日 → 刷新账户持仓 → 获取全量订单
   * → 解析席位 → 水合冷却状态并恢复保护性清仓边界 → 回算日内亏损追踪
   * → 重置行情订阅 → 订阅标的行情和 K 线 → 返回快照。
   */
  return async function loadTradingDayRuntimeSnapshot(
    params: LoadTradingDayRuntimeSnapshotParams,
  ): Promise<LoadTradingDayRuntimeSnapshotResult> {
    const {
      now,
      requireTradingDay,
      failOnOrderFetchError,
      resetRuntimeSubscriptions,
      hydrateCooldownFromTradeLog,
      forceOrderRefresh,
    } = params;
    if (requireTradingDay) {
      const tradingDayInfo = await marketDataClient.isTradingDay(now);
      if (!tradingDayInfo.isTradingDay) {
        throw new Error('重建触发时交易日信息无效');
      }

      lastState.cachedTradingDayInfo = tradingDayInfo;
      lastState.isHalfDay = tradingDayInfo.isHalfDay;
    }

    await trader.initializeOrderMonitor();
    await refreshAccountAndPositions(trader, lastState);
    if (!lastState.cachedAccount) {
      throw new Error('无法获取账户信息');
    }

    if (!Array.isArray(lastState.cachedPositions)) {
      throw new TypeError('无法获取持仓信息');
    }

    logger.debug('账户和持仓信息获取成功，开始解析席位');
    let allOrders: ReadonlyArray<RawOrderFromAPI> = [];
    try {
      allOrders = await trader.fetchAllOrdersFromAPI(forceOrderRefresh);
    } catch (err) {
      if (failOnOrderFetchError) {
        throw new Error(`[全量订单获取失败] ${formatError(err)}`, { cause: err });
      }

      logger.warn('[全量订单获取失败] 将按空订单继续初始化', formatError(err));
    }

    trader.seedOrderHoldSymbols(allOrders);
    await prepareSeatsForRuntime({
      monitorConfig,
      symbolRegistry,
      positions: lastState.cachedPositions,
      orders: allOrders,
      marketDataClient,
      now: () => now,
      logger,
      getTradingMinutesSinceOpen,
      isWithinMorningOpenProtection,
      warrantListCacheConfig,
    });
    protectiveLiquidationEpisodeTracker.resetAll();
    const completedBoundaryByDirection: ReadonlyMap<ProtectiveLiquidationDirection, number> =
      hydrateCooldownFromTradeLog
        ? tradeLogHydrator.hydrate()
        : new Map<ProtectiveLiquidationDirection, number>();

    const currentDayKey = getHKDateKey(now);
    const protectiveLatestFillByDirection = new Map<ProtectiveLiquidationDirection, number>();
    const pendingProtectiveLatestFillByDirection = new Map<
      ProtectiveLiquidationDirection,
      number
    >();
    const pendingProtectiveDirectionKeys = new Set<ProtectiveLiquidationDirection>();
    for (const order of allOrders) {
      if (!hasProtectiveLiquidationRemark(order.remark)) {
        continue;
      }

      if (!(order.updatedAt instanceof Date)) {
        continue;
      }

      if (getHKDateKey(order.updatedAt) !== currentDayKey) {
        continue;
      }

      const ownership = resolveOrderOwnershipForMonitor(order, monitorConfig);
      if (!ownership) {
        continue;
      }

      const executedTimeMs = order.updatedAt.getTime();
      const executedQuantity = decimalToNumber(order.executedQuantity);
      const hasProtectiveExecution =
        order.side === OrderSide.Sell &&
        isValidPositiveNumber(executedTimeMs) &&
        isValidPositiveNumber(executedQuantity);
      if (hasProtectiveExecution) {
        const existing = protectiveLatestFillByDirection.get(ownership.direction);
        if (existing === undefined || executedTimeMs > existing) {
          protectiveLatestFillByDirection.set(ownership.direction, executedTimeMs);
        }
      }

      if (PENDING_ORDER_STATUSES.has(order.status)) {
        pendingProtectiveDirectionKeys.add(ownership.direction);
        if (hasProtectiveExecution) {
          const existingPending = pendingProtectiveLatestFillByDirection.get(ownership.direction);
          if (existingPending === undefined || executedTimeMs > existingPending) {
            pendingProtectiveLatestFillByDirection.set(ownership.direction, executedTimeMs);
          }
        }
      }
    }

    const restoredBoundaryByDirection = new Map<ProtectiveLiquidationDirection, number>();
    for (const [direction, boundaryExecutedTimeMs] of completedBoundaryByDirection) {
      restoreCompletedBoundary({
        protectiveLiquidationEpisodeTracker,
        restoredBoundaryByDirection,
        direction,
        boundaryExecutedTimeMs,
      });
    }

    for (const [direction, latestExecutedTimeMs] of protectiveLatestFillByDirection) {
      if (
        restoredBoundaryByDirection.has(direction) ||
        pendingProtectiveDirectionKeys.has(direction)
      ) {
        continue;
      }

      const isDirectionFlat = isDirectionFlatAtSnapshot(symbolRegistry, lastState, direction);
      if (!isDirectionFlat) {
        continue;
      }

      restoreCompletedBoundary({
        protectiveLiquidationEpisodeTracker,
        restoredBoundaryByDirection,
        direction,
        boundaryExecutedTimeMs: latestExecutedTimeMs,
      });
    }

    for (const [direction, latestExecutedTimeMs] of protectiveLatestFillByDirection) {
      const boundaryExecutedTimeMs = restoredBoundaryByDirection.get(direction);
      const hasPendingProtective = pendingProtectiveDirectionKeys.has(direction);
      if (hasPendingProtective) {
        const pendingLatestExecutedTimeMs = pendingProtectiveLatestFillByDirection.get(direction);
        if (
          pendingLatestExecutedTimeMs !== undefined &&
          (boundaryExecutedTimeMs === undefined ||
            pendingLatestExecutedTimeMs > boundaryExecutedTimeMs)
        ) {
          protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
            direction,
            latestExecutedTimeMs: pendingLatestExecutedTimeMs,
          });
        }

        continue;
      }

      if (boundaryExecutedTimeMs !== undefined && latestExecutedTimeMs <= boundaryExecutedTimeMs) {
        continue;
      }

      const isDirectionFlat = isDirectionFlatAtSnapshot(symbolRegistry, lastState, direction);
      if (isDirectionFlat) {
        restoreCompletedBoundary({
          protectiveLiquidationEpisodeTracker,
          restoredBoundaryByDirection,
          direction,
          boundaryExecutedTimeMs: latestExecutedTimeMs,
        });
        continue;
      }

      protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
        direction,
        latestExecutedTimeMs,
      });
    }

    const protectionBoundaryByDirection =
      protectiveLiquidationEpisodeTracker.getLatestProtectionBoundaryByDirection();
    dailyLossTracker.recalculateFromAllOrders(
      allOrders,
      monitorConfig,
      now,
      protectionBoundaryByDirection,
    );

    if (resetRuntimeSubscriptions) {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
    }

    const orderHoldSymbols = trader.getOrderHoldSymbols();
    const allTradingSymbols = collectRuntimeQuoteSymbols(
      [monitorConfig],
      symbolRegistry,
      lastState.cachedPositions,
      orderHoldSymbols,
    );
    lastState.allTradingSymbols = allTradingSymbols;
    if (allTradingSymbols.size > 0) {
      await marketDataClient.subscribeSymbols([...allTradingSymbols]);
    }

    for (const period of TRADING.CANDLE_PERIODS) {
      await marketDataClient.subscribeCandlesticks(monitorConfig.baseInstrumentSymbol, period);
    }

    const quotesMap = await marketDataClient.getQuotes(allTradingSymbols);
    return {
      allOrders,
      quotesMap,
    };
  };
}
