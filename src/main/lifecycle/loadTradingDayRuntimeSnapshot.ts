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
import type { CandleData } from '../../types/data.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';
import {
  collectHistoricalSessionRv30Series,
  getHongKongParts,
  getSessionPhase,
  normalizeFactorRuntimeBars,
} from '../../services/factors/runtime/utils.js';

const FULL_TRADING_DAY_MIN1_BAR_COUNT = 330;

function getRequiredHistoricalBaselineDays(rvQuantileWindowDays: number): number {
  return Math.max(1, Math.floor(rvQuantileWindowDays));
}

function isAscendingAndDeduplicatedCandles(candles: ReadonlyArray<CandleData>): boolean {
  for (let index = 1; index < candles.length; index += 1) {
    const previousTimestamp = candles[index - 1]?.timestamp;
    const currentTimestamp = candles[index]?.timestamp;
    if (
      typeof previousTimestamp !== 'number' ||
      !Number.isFinite(previousTimestamp) ||
      typeof currentTimestamp !== 'number' ||
      !Number.isFinite(currentTimestamp)
    ) {
      return false;
    }

    if (previousTimestamp >= currentTimestamp) {
      return false;
    }
  }

  return true;
}

function collectTradingDayKeysFromCandles(
  candles: ReadonlyArray<CandleData>,
): ReadonlyArray<string> {
  const dayKeys = new Set<string>();
  for (const candle of candles) {
    const timestamp = candle.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      continue;
    }

    dayKeys.add(getHKDateKey(new Date(timestamp)));
  }

  return [...dayKeys];
}

function hasCurrentDayBars(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
}): boolean {
  return params.candles.some((candle) => {
    const timestamp = candle.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return false;
    }

    return getHKDateKey(new Date(timestamp)) === params.currentDayKey;
  });
}

function countHistoricalMin1Bars(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
}): number {
  let count = 0;
  for (const candle of params.candles) {
    const timestamp = candle.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      continue;
    }

    if (getHKDateKey(new Date(timestamp)) !== params.currentDayKey) {
      count += 1;
    }
  }

  return count;
}

function countHistoricalTradingDays(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
}): number {
  return collectTradingDayKeysFromCandles(params.candles).filter(
    (dayKey) => dayKey !== params.currentDayKey,
  ).length;
}

function hasRequiredHistoricalSeedCoverage(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
  readonly requiredHistoricalBaselineDays: number;
}): boolean {
  const historicalDayCount = countHistoricalTradingDays(params);
  if (historicalDayCount < params.requiredHistoricalBaselineDays) {
    return false;
  }

  return (
    countHistoricalMin1Bars({
      candles: params.candles,
      currentDayKey: params.currentDayKey,
    }) >=
    params.requiredHistoricalBaselineDays * FULL_TRADING_DAY_MIN1_BAR_COUNT
  );
}

function getLatestCurrentDayBarTimestamp(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
}): number | null {
  for (let index = params.candles.length - 1; index >= 0; index -= 1) {
    const candle = params.candles[index];
    const timestamp = candle?.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      continue;
    }

    if (getHKDateKey(new Date(timestamp)) === params.currentDayKey) {
      return timestamp;
    }
  }

  return null;
}

function hasRequiredHistoricalSessionBaseline(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
  readonly requiredHistoricalBaselineDays: number;
}): boolean {
  return countHistoricalSessionBaselineSamples(params) >= params.requiredHistoricalBaselineDays;
}

function countHistoricalSessionBaselineSamples(params: {
  readonly candles: ReadonlyArray<CandleData>;
  readonly currentDayKey: string;
  readonly requiredHistoricalBaselineDays: number;
}): number {
  const latestCurrentDayTimestamp = getLatestCurrentDayBarTimestamp(params);
  if (latestCurrentDayTimestamp === null) {
    return 0;
  }

  const { minuteOfDay } = getHongKongParts(latestCurrentDayTimestamp);
  const session = getSessionPhase(minuteOfDay);
  if (session === 'closed') {
    return 0;
  }

  const bars = normalizeFactorRuntimeBars({
    candles: params.candles,
  });
  return collectHistoricalSessionRv30Series({
    bars,
    currentDayKey: params.currentDayKey,
    session,
    cutoffMinuteOfDay: minuteOfDay,
    rvQuantileWindowDays: params.requiredHistoricalBaselineDays,
  }).length;
}

function assertCurrentDaySnapshotReady(params: {
  readonly marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  readonly symbol: string;
  readonly period: (typeof TRADING.CANDLE_PERIODS)[number];
  readonly currentDayKey: string;
}): void {
  const snapshot = params.marketDataClient.getCandlestickSnapshot(params.symbol, params.period);
  if (snapshot === null || !snapshot.initialized || snapshot.candles.length === 0) {
    throw new Error(`[K线预热] ${params.symbol} 周期 ${String(params.period)} 本地缓存未初始化`);
  }

  if (
    !hasCurrentDayBars({
      candles: snapshot.candles,
      currentDayKey: params.currentDayKey,
    })
  ) {
    throw new Error(
      `[K线预热] ${params.symbol} 周期 ${String(params.period)} 缺少当前交易日样本，禁止进入指标流水线`,
    );
  }
}

async function prewarmHistoricalMin1Candles(params: {
  readonly marketDataClient: LoadTradingDayRuntimeSnapshotDeps['marketDataClient'];
  readonly symbol: string;
  readonly currentDayKey: string;
  readonly requireCurrentDayBars: boolean;
  readonly requiredHistoricalBaselineDays: number;
}): Promise<void> {
  const batchSize = 1_000;
  let fetchedCount = 0;
  let beforeTime: Date | null = null;

  while (fetchedCount < TRADING.CANDLE_COUNT) {
    const historyBatch = await params.marketDataClient.fetchHistoricalCandlesticksByOffset(
      params.symbol,
      TRADING.FACTOR_CANDLE_PERIOD,
      beforeTime,
      Math.min(batchSize, TRADING.CANDLE_COUNT - fetchedCount),
    );
    if (historyBatch.length === 0) {
      break;
    }

    fetchedCount += historyBatch.length;
    const snapshot = params.marketDataClient.backfillCandlesticks(
      params.symbol,
      TRADING.FACTOR_CANDLE_PERIOD,
      historyBatch,
    );
    if (!isAscendingAndDeduplicatedCandles(snapshot.candles)) {
      throw new Error(`[K线预热] ${params.symbol} 1m 历史回填后未保持升序去重`);
    }

    const currentDayReady = hasCurrentDayBars({
      candles: snapshot.candles,
      currentDayKey: params.currentDayKey,
    });
    const prewarmReady = params.requireCurrentDayBars
      ? currentDayReady &&
        hasRequiredHistoricalSessionBaseline({
          candles: snapshot.candles,
          currentDayKey: params.currentDayKey,
          requiredHistoricalBaselineDays: params.requiredHistoricalBaselineDays,
        })
      : hasRequiredHistoricalSeedCoverage({
          candles: snapshot.candles,
          currentDayKey: params.currentDayKey,
          requiredHistoricalBaselineDays: params.requiredHistoricalBaselineDays,
        });
    if (prewarmReady) {
      return;
    }

    const earliestTimestamp = snapshot.candles[0]?.timestamp;
    if (typeof earliestTimestamp !== 'number' || !Number.isFinite(earliestTimestamp)) {
      break;
    }

    beforeTime = new Date(earliestTimestamp - 1);
  }

  const finalSnapshot = params.marketDataClient.getCandlestickSnapshot(
    params.symbol,
    TRADING.FACTOR_CANDLE_PERIOD,
  );
  if (finalSnapshot === null || !finalSnapshot.initialized || finalSnapshot.candles.length === 0) {
    throw new Error(`[K线预热] ${params.symbol} 1m 历史预热失败，未获得可用缓存`);
  }

  if (!isAscendingAndDeduplicatedCandles(finalSnapshot.candles)) {
    throw new Error(`[K线预热] ${params.symbol} 1m 历史预热后未保持升序去重`);
  }

  const finalHistoricalDayCount = countHistoricalTradingDays({
    candles: finalSnapshot.candles,
    currentDayKey: params.currentDayKey,
  });
  if (
    !params.requireCurrentDayBars &&
    finalHistoricalDayCount < params.requiredHistoricalBaselineDays
  ) {
    throw new Error(
      `[K线预热] ${params.symbol} 1m 历史交易日覆盖不足：${finalHistoricalDayCount}/${params.requiredHistoricalBaselineDays}`,
    );
  }

  const finalHistoricalBarCount = countHistoricalMin1Bars({
    candles: finalSnapshot.candles,
    currentDayKey: params.currentDayKey,
  });
  if (
    !params.requireCurrentDayBars &&
    finalHistoricalBarCount <
      params.requiredHistoricalBaselineDays * FULL_TRADING_DAY_MIN1_BAR_COUNT
  ) {
    throw new Error(
      `[K线预热] ${params.symbol} 1m 历史样本不足：${finalHistoricalBarCount}/${params.requiredHistoricalBaselineDays * FULL_TRADING_DAY_MIN1_BAR_COUNT}`,
    );
  }

  if (
    params.requireCurrentDayBars &&
    !hasCurrentDayBars({ candles: finalSnapshot.candles, currentDayKey: params.currentDayKey })
  ) {
    throw new Error(`[K线预热] ${params.symbol} 1m 缺少当前交易日样本，禁止进入指标流水线`);
  }

  if (
    params.requireCurrentDayBars &&
    !hasRequiredHistoricalSessionBaseline({
      candles: finalSnapshot.candles,
      currentDayKey: params.currentDayKey,
      requiredHistoricalBaselineDays: params.requiredHistoricalBaselineDays,
    })
  ) {
    const historicalSessionSampleCount = countHistoricalSessionBaselineSamples({
      candles: finalSnapshot.candles,
      currentDayKey: params.currentDayKey,
      requiredHistoricalBaselineDays: params.requiredHistoricalBaselineDays,
    });
    throw new Error(
      `[K线预热] ${params.symbol} 1m 同 session 历史样本不足：${historicalSessionSampleCount}/${params.requiredHistoricalBaselineDays}`,
    );
  }
}

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
   * 加载交易日运行时快照，并返回重建所需的订单与行情数据。
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
      monitorConfig: monitorConfig,
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
      monitorConfig,
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

    const requiredHistoricalBaselineDays = getRequiredHistoricalBaselineDays(
      monitorConfig.strategyConfig.regimeThresholds.rvQuantileWindowDays,
    );
    const requireCurrentDayBars = getTradingMinutesSinceOpen(now) > 0;
    await prewarmHistoricalMin1Candles({
      marketDataClient,
      symbol: monitorConfig.baseInstrumentSymbol,
      currentDayKey,
      requireCurrentDayBars,
      requiredHistoricalBaselineDays,
    });

    if (requireCurrentDayBars) {
      for (const period of TRADING.CANDLE_PERIODS.filter(
        (candlePeriod) => candlePeriod !== TRADING.FACTOR_CANDLE_PERIOD,
      )) {
        assertCurrentDaySnapshotReady({
          marketDataClient,
          symbol: monitorConfig.baseInstrumentSymbol,
          period,
          currentDayKey,
        });
      }
    }

    const quotesMap = await marketDataClient.getQuotes(allTradingSymbols);
    return {
      allOrders,
      quotesMap,
    };
  };
}
