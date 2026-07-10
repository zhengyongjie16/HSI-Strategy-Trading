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
import { OrderSide, TradeSessions } from 'longbridge';
import { PENDING_ORDER_STATUSES, TRADING } from '../../constants/index.js';
import {
  getHKDateKey,
  getTradingMinutesSinceOpen,
  isInContinuousHKSession,
  isWithinMorningOpenWindow,
} from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsForRuntime } from '../recovery/seatPreparation.js';
import { collectRuntimeQuoteSymbols, refreshAccountAndPositions } from '../utils.js';
import { decimalToNumber, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveOrderOwnership } from '../../core/orderRecorder/index.js';
import { hasProtectiveLiquidationRemark } from '../../core/trader/utils.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';

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
 * @param deps 依赖注入（marketDataClient、trader、lastState、tradingConfig、symbolRegistry、dailyLossTracker、tradeLogHydrator、warrantListCacheConfig）
 * @returns 接收 LoadTradingDayRuntimeSnapshotParams 的异步函数，返回全量订单与行情快照供重建使用
 */
export function createLoadTradingDayRuntimeSnapshot(
  deps: LoadTradingDayRuntimeSnapshotDeps,
): (params: LoadTradingDayRuntimeSnapshotParams) => Promise<LoadTradingDayRuntimeSnapshotResult> {
  const {
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
    seatActivationDispatcher,
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
      resetRuntimeSubscriptions,
      hydrateCooldownFromTradeLog,
      forceOrderRefresh,
    } = params;
    const expectedMonitorSymbol = tradingConfig.monitor.monitorSymbol;
    if (requireTradingDay) {
      const tradingDayInfo = await marketDataClient.isTradingDay(now);
      if (!tradingDayInfo.isTradingDay) {
        throw new Error('重建触发时交易日信息无效');
      }

      lastState.cachedTradingDayInfo = {
        dateKey: getHKDateKey(now) ?? '',
        info: tradingDayInfo,
      };
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
    const allOrders = await trader.fetchAllOrdersFromAPI(forceOrderRefresh);

    trader.seedOrderHoldSymbols(allOrders);
    await prepareSeatsForRuntime({
      tradingConfig,
      symbolRegistry,
      positions: lastState.cachedPositions,
      orders: allOrders,
      marketDataClient,
      now: () => now,
      logger,
      getTradingMinutesSinceOpen,
      resolveCanAutoSearchNow: ({ currentTime, openDelayMinutes }) => {
        const tradingDayInfo = lastState.cachedTradingDayInfo?.info ?? null;
        if (tradingDayInfo?.isTradingDay !== true) {
          return false;
        }

        if (!isInContinuousHKSession(currentTime, tradingDayInfo.isHalfDay)) {
          return false;
        }

        return !isWithinMorningOpenWindow(currentTime, openDelayMinutes);
      },
      warrantListCacheConfig,
    });
    seatActivationDispatcher.dispatchCurrentActivatingSeats();
    protectiveLiquidationEpisodeTracker.resetAll();
    const completedBoundaryByDirection = hydrateCooldownFromTradeLog
      ? tradeLogHydrator.hydrate()
      : new Map<ProtectiveLiquidationDirection, number>();

    const currentDayKey = getHKDateKey(now);
    const protectiveLatestFillByDirection = new Map<
      ProtectiveLiquidationDirection,
      Readonly<{ latestExecutedTimeMs: number; symbol: string }>
    >();
    const pendingProtectiveLatestFillByDirection = new Map<
      ProtectiveLiquidationDirection,
      Readonly<{ latestExecutedTimeMs: number; symbol: string }>
    >();
    const pendingProtectiveDirectionKeys = new Set<ProtectiveLiquidationDirection>();
    for (const order of allOrders) {
      if (!hasProtectiveLiquidationRemark(order.remark)) {
        continue;
      }

      if (!(order.updatedAt instanceof Date) || !isValidPositiveNumber(order.updatedAt.getTime())) {
        throw new Error('[loadTradingDayRuntimeSnapshot] 保护性清仓订单缺少有效更新时间');
      }

      if (getHKDateKey(order.updatedAt) !== currentDayKey) {
        continue;
      }

      const ownership = resolveOrderOwnership(order, tradingConfig.monitor);
      if (!ownership) {
        throw new Error('[loadTradingDayRuntimeSnapshot] 保护性清仓订单无法归属到唯一监控标的');
      }

      if (ownership.monitorSymbol !== expectedMonitorSymbol) {
        throw new Error(
          `[loadTradingDayRuntimeSnapshot] 保护性清仓订单 monitorSymbol 不匹配唯一配置: ` +
            `${ownership.monitorSymbol} !== ${expectedMonitorSymbol}`,
        );
      }

      const direction = ownership.direction;
      const executedTimeMs = order.updatedAt.getTime();
      const executedQuantity = decimalToNumber(order.executedQuantity);
      const hasProtectiveExecution =
        order.side === OrderSide.Sell &&
        isValidPositiveNumber(executedTimeMs) &&
        isValidPositiveNumber(executedQuantity);
      if (hasProtectiveExecution) {
        const existing = protectiveLatestFillByDirection.get(direction);
        if (existing === undefined || executedTimeMs > existing.latestExecutedTimeMs) {
          protectiveLatestFillByDirection.set(direction, {
            latestExecutedTimeMs: executedTimeMs,
            symbol: order.symbol,
          });
        }
      }

      if (PENDING_ORDER_STATUSES.has(order.status)) {
        pendingProtectiveDirectionKeys.add(direction);
        if (hasProtectiveExecution) {
          const existingPending = pendingProtectiveLatestFillByDirection.get(direction);
          if (
            existingPending === undefined ||
            executedTimeMs > existingPending.latestExecutedTimeMs
          ) {
            pendingProtectiveLatestFillByDirection.set(direction, {
              latestExecutedTimeMs: executedTimeMs,
              symbol: order.symbol,
            });
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

    for (const [direction, protectiveFill] of protectiveLatestFillByDirection) {
      if (
        restoredBoundaryByDirection.has(direction) ||
        pendingProtectiveDirectionKeys.has(direction)
      ) {
        continue;
      }

      const position = lastState.positionCache.get(protectiveFill.symbol);
      const isDirectionFlat = position === null || position.quantity <= 0;
      if (!isDirectionFlat) {
        continue;
      }

      restoreCompletedBoundary({
        protectiveLiquidationEpisodeTracker,
        restoredBoundaryByDirection,
        direction,
        boundaryExecutedTimeMs: protectiveFill.latestExecutedTimeMs,
      });
    }

    for (const [direction, protectiveFill] of protectiveLatestFillByDirection) {
      const boundaryExecutedTimeMs = restoredBoundaryByDirection.get(direction);
      const hasPendingProtective = pendingProtectiveDirectionKeys.has(direction);
      if (hasPendingProtective) {
        const pendingLatestExecutedTimeMs = pendingProtectiveLatestFillByDirection.get(direction);
        if (
          pendingLatestExecutedTimeMs !== undefined &&
          (boundaryExecutedTimeMs === undefined ||
            pendingLatestExecutedTimeMs.latestExecutedTimeMs > boundaryExecutedTimeMs)
        ) {
          protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
            direction,
            symbol: pendingLatestExecutedTimeMs.symbol,
            latestExecutedTimeMs: pendingLatestExecutedTimeMs.latestExecutedTimeMs,
          });
        }

        continue;
      }

      if (
        boundaryExecutedTimeMs !== undefined &&
        protectiveFill.latestExecutedTimeMs <= boundaryExecutedTimeMs
      ) {
        continue;
      }

      const position = lastState.positionCache.get(protectiveFill.symbol);
      const isDirectionFlat = position === null || position.quantity <= 0;
      if (isDirectionFlat) {
        restoreCompletedBoundary({
          protectiveLiquidationEpisodeTracker,
          restoredBoundaryByDirection,
          direction,
          boundaryExecutedTimeMs: protectiveFill.latestExecutedTimeMs,
        });
        continue;
      }

      protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
        direction,
        symbol: protectiveFill.symbol,
        latestExecutedTimeMs: protectiveFill.latestExecutedTimeMs,
      });
    }

    const orderHoldSymbols = trader.getOrderHoldSymbols();
    const allTradingSymbols = collectRuntimeQuoteSymbols(
      tradingConfig.monitor,
      symbolRegistry,
      lastState.cachedPositions,
      orderHoldSymbols,
    );
    const relatedTradingSymbols = new Set(allTradingSymbols);
    relatedTradingSymbols.delete(tradingConfig.monitor.monitorSymbol);
    const protectionBoundaryByDirection =
      protectiveLiquidationEpisodeTracker.getLatestProtectionBoundaryByDirection();
    dailyLossTracker.recalculateFromAllOrders(
      allOrders,
      tradingConfig.monitor,
      now,
      protectionBoundaryByDirection,
      relatedTradingSymbols,
    );

    if (resetRuntimeSubscriptions) {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
    }

    lastState.allTradingSymbols = allTradingSymbols;
    if (allTradingSymbols.size > 0) {
      await marketDataClient.subscribeSymbols([...allTradingSymbols]);
    }

    await marketDataClient.subscribeCandlesticks(
      tradingConfig.monitor.monitorSymbol,
      TRADING.CANDLE_PERIOD,
      TradeSessions.Intraday,
    );

    const quotesMap = await marketDataClient.getQuotes(allTradingSymbols);
    return {
      allOrders,
      quotesMap,
    };
  };
}
