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
 * 5. 收集相关交易标的，并全量重算日内亏损以预校验所有相关成交订单
 * 6. 从交易日志水合冷却状态，并基于订单/持仓恢复保护性清仓边界（可选）
 * 7. 重置行情订阅（可选）
 * 8. 收集并订阅所有交易标的的行情和 K 线
 * 9. 返回全量订单和行情快照，供后续重建使用
 *
 * 使用场景：
 * - 程序启动时的首次初始化
 * - 开盘重建流程中由 globalStateDomain 调用
 */
import { OrderSide, TradeSessions } from 'longbridge';
import { TRADING } from '../../constants/index.js';
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
import { classifyOrderStatusLifecycle } from '../../core/orderStatusLifecycle/index.js';
import { hasProtectiveLiquidationRemark } from '../../core/trader/utils.js';
import { decimalGt, toDecimalValue } from '../../utils/numeric/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../core/trader/protectiveLiquidationEpisodeTracker/types.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import type {
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
} from '../../services/mixedTradeLogRepository/types.js';

/** OPEN 必须先于 TERMINAL 恢复，终态才能覆盖同 identity 的开放态观察。 */
function compareFactStage(left: 'OPEN' | 'TERMINAL', right: 'OPEN' | 'TERMINAL'): number {
  if (left === right) {
    return 0;
  }

  return left === 'OPEN' ? -1 : 1;
}

/** 按同一订单不可变事实的自然顺序排序，确保 OPEN 先于 TERMINAL 恢复。 */
function compareExecutionProgressFacts(
  left: ProtectiveLiquidationExecutionProgressRecordV1,
  right: ProtectiveLiquidationExecutionProgressRecordV1,
): number {
  return (
    left.orderId.localeCompare(right.orderId) ||
    left.orderRevisionMs - right.orderRevisionMs ||
    toDecimalValue(left.cumulativeQuantity).comparedTo(toDecimalValue(right.cumulativeQuantity)) ||
    compareFactStage(left.factStage, right.factStage)
  );
}

/** 比较跨订单 progress 的业务新鲜度；同一事实身份下 TERMINAL 覆盖 OPEN。 */
function compareExecutionProgressRecency(
  left: ProtectiveLiquidationExecutionProgressRecordV1,
  right: ProtectiveLiquidationExecutionProgressRecordV1,
): number {
  return (
    left.lastExecutionTimeMs - right.lastExecutionTimeMs ||
    left.orderRevisionMs - right.orderRevisionMs ||
    toDecimalValue(left.cumulativeQuantity).comparedTo(toDecimalValue(right.cumulativeQuantity)) ||
    compareFactStage(left.factStage, right.factStage) ||
    left.orderId.localeCompare(right.orderId)
  );
}

/** 在任何恢复副作用前，拒绝不属于当前唯一 monitor 的 completion 事实。 */
function assertCompletionRecordsMatchExpectedMonitor(
  completionRecords: ReadonlyArray<ProtectiveLiquidationCompletionRecordV1>,
  expectedMonitorSymbol: string,
): void {
  for (const record of completionRecords) {
    if (record.monitorSymbol !== expectedMonitorSymbol) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] completion monitorSymbol 不匹配唯一配置: ` +
          `${record.monitorSymbol} !== ${expectedMonitorSymbol}`,
      );
    }
  }
}

/** 按 orderId 建立原始保护性 SELL 事实索引，供 progress 恢复前做来源校验。 */
function collectRawProtectiveSellOrdersById(
  allOrders: ReadonlyArray<RawOrderFromAPI>,
): ReadonlyMap<string, RawOrderFromAPI> {
  const rawProtectiveSellOrdersById = new Map<string, RawOrderFromAPI>();
  for (const order of allOrders) {
    if (order.side !== OrderSide.Sell || !hasProtectiveLiquidationRemark(order.remark)) {
      continue;
    }

    rawProtectiveSellOrdersById.set(order.orderId, order);
  }

  return rawProtectiveSellOrdersById;
}

/**
 * 将 progress 绑定到当前 API 快照中的真实保护性 SELL，避免日志中的伪造或错归属事实污染恢复状态。
 */
function assertExecutionProgressRecordsHaveRawProtectiveProvenance(
  progressRecords: ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>,
  rawProtectiveSellOrdersById: ReadonlyMap<string, RawOrderFromAPI>,
  monitor: LoadTradingDayRuntimeSnapshotDeps['tradingConfig']['monitor'],
  expectedMonitorSymbol: string,
): void {
  for (const progress of progressRecords) {
    if (progress.monitorSymbol !== expectedMonitorSymbol) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] progress monitorSymbol 不匹配唯一配置: ` +
          `${progress.monitorSymbol} !== ${expectedMonitorSymbol}`,
      );
    }

    const rawOrder = rawProtectiveSellOrdersById.get(progress.orderId);
    if (rawOrder?.side !== OrderSide.Sell || !hasProtectiveLiquidationRemark(rawOrder.remark)) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] progress 无法锚定到保护性清仓 SELL 原始订单: ` +
          progress.orderId,
      );
    }

    const ownership = resolveOrderOwnership(rawOrder, monitor);
    if (!ownership) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] progress 原始订单无法归属到唯一监控标的: ` +
          progress.orderId,
      );
    }

    if (ownership.monitorSymbol !== expectedMonitorSymbol) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] progress 原始订单 monitorSymbol 不匹配唯一配置: ` +
          `${ownership.monitorSymbol} !== ${expectedMonitorSymbol}`,
      );
    }

    if (progress.direction !== ownership.direction || progress.symbol !== rawOrder.symbol) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] progress 与保护性清仓原始订单归属不一致: ` +
          progress.orderId,
      );
    }
  }
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
    mixedTradeLogRepository,
    warrantListCacheConfig,
    seatActivationDispatcher,
  } = deps;

  /**
   * 加载交易日完整运行时快照：验证交易日 → 刷新账户持仓 → 获取全量订单
   * → 解析席位 → 收集相关标的并全量重算日内亏损 → 水合冷却状态并恢复保护性清仓边界
   * → 重置行情订阅 → 订阅标的行情和 K 线 → 返回快照。
   */
  return async function loadTradingDayRuntimeSnapshot(
    params: LoadTradingDayRuntimeSnapshotParams,
  ): Promise<LoadTradingDayRuntimeSnapshotResult> {
    const { now, requireTradingDay, resetRuntimeSubscriptions, hydrateCooldownFromTradeLog } =
      params;
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
    const allOrders = await trader.fetchAllOrdersFromAPI();

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
    const currentDayKey = getHKDateKey(now);
    if (hydrateCooldownFromTradeLog && currentDayKey === null) {
      throw new Error('[loadTradingDayRuntimeSnapshot] 当前交易日键无法解析');
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
    dailyLossTracker.recalculateFromAllOrders(
      allOrders,
      tradingConfig.monitor,
      now,
      new Map(),
      relatedTradingSymbols,
    );

    protectiveLiquidationEpisodeTracker.resetAll();

    const completionRecords =
      hydrateCooldownFromTradeLog && currentDayKey !== null
        ? [...mixedTradeLogRepository.loadCompletionRecords(currentDayKey)]
        : [];
    const executionProgressRecords =
      hydrateCooldownFromTradeLog && currentDayKey !== null
        ? [...mixedTradeLogRepository.loadExecutionProgressRecords(currentDayKey)]
        : [];
    assertCompletionRecordsMatchExpectedMonitor(completionRecords, expectedMonitorSymbol);
    if (executionProgressRecords.length > 0) {
      assertExecutionProgressRecordsHaveRawProtectiveProvenance(
        executionProgressRecords,
        collectRawProtectiveSellOrdersById(allOrders),
        tradingConfig.monitor,
        expectedMonitorSymbol,
      );
    }

    const completedBoundaryByDirection = new Map<ProtectiveLiquidationDirection, number>();
    for (const record of completionRecords) {
      const previous = completedBoundaryByDirection.get(record.direction);
      if (previous === undefined || record.boundaryExecutedTimeMs > previous) {
        completedBoundaryByDirection.set(record.direction, record.boundaryExecutedTimeMs);
      }
    }

    const protectiveExecutedOrders: Array<
      Readonly<{
        orderId: string;
        direction: ProtectiveLiquidationDirection;
        symbol: string;
        executedQuantity: number;
      }>
    > = [];
    const pendingProtectiveDirections = new Set<ProtectiveLiquidationDirection>();
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
      const executedQuantity = decimalToNumber(order.executedQuantity);
      const hasProtectiveExecution =
        order.side === OrderSide.Sell && isValidPositiveNumber(executedQuantity);
      if (order.side === OrderSide.Sell && classifyOrderStatusLifecycle(order.status) === 'OPEN') {
        pendingProtectiveDirections.add(direction);
      }

      if (hasProtectiveExecution) {
        protectiveExecutedOrders.push({
          orderId: order.orderId,
          direction,
          symbol: order.symbol,
          executedQuantity,
        });
      }
    }

    for (const [direction, boundaryExecutedTimeMs] of completedBoundaryByDirection) {
      protectiveLiquidationEpisodeTracker.restoreCompletedBoundary({
        direction,
        boundaryExecutedTimeMs,
      });
    }

    for (const progress of [...executionProgressRecords].sort(compareExecutionProgressFacts)) {
      dailyLossTracker.restoreExecutionSnapshot({
        factStage: progress.factStage,
        direction: progress.direction,
        symbol: progress.symbol,
        side: OrderSide.Sell,
        orderId: progress.orderId,
        cumulativeQuantity: progress.cumulativeQuantity,
        cumulativeAmount: progress.cumulativeAmount,
        lastExecutionTimeMs: progress.lastExecutionTimeMs,
        orderRevisionMs: progress.orderRevisionMs,
      });
    }

    for (const record of [...completionRecords].sort(
      (left, right) => left.boundaryExecutedTimeMs - right.boundaryExecutedTimeMs,
    )) {
      dailyLossTracker.restoreProtectionBoundary({
        direction: record.direction,
        boundaryExecutedTimeMs: record.boundaryExecutedTimeMs,
        orderBaselines: record.orderBaselines,
      });
    }

    if (hydrateCooldownFromTradeLog) {
      if (currentDayKey === null) {
        throw new Error('[loadTradingDayRuntimeSnapshot] 当前交易日键无法解析');
      }

      const latestCompletionByDirection = new Map<
        ProtectiveLiquidationDirection,
        (typeof completionRecords)[number]
      >();
      for (const record of completionRecords) {
        const previous = latestCompletionByDirection.get(record.direction);
        if (
          previous === undefined ||
          record.boundaryExecutedTimeMs > previous.boundaryExecutedTimeMs
        ) {
          latestCompletionByDirection.set(record.direction, record);
        }
      }

      const latestProgressByDirection = new Map<
        ProtectiveLiquidationDirection,
        (typeof executionProgressRecords)[number]
      >();
      for (const progress of executionProgressRecords) {
        const completedBoundary = latestCompletionByDirection.get(
          progress.direction,
        )?.boundaryExecutedTimeMs;
        if (completedBoundary !== undefined && progress.lastExecutionTimeMs <= completedBoundary) {
          continue;
        }

        const previous = latestProgressByDirection.get(progress.direction);
        if (previous !== undefined && previous.symbol !== progress.symbol) {
          throw new Error(
            `[loadTradingDayRuntimeSnapshot] 同方向存在不同 symbol 的未完成 protection progress: ` +
              `${previous.symbol} !== ${progress.symbol}`,
          );
        }

        if (previous === undefined || compareExecutionProgressRecency(previous, progress) < 0) {
          latestProgressByDirection.set(progress.direction, progress);
        }
      }

      for (const execution of protectiveExecutedOrders) {
        const latestCompletion = latestCompletionByDirection.get(execution.direction);
        const persistedBaseline = latestCompletion?.orderBaselines.find(
          (baseline) => baseline.orderId === execution.orderId,
        );
        if (
          persistedBaseline !== undefined &&
          !decimalGt(execution.executedQuantity, persistedBaseline.cumulativeQuantity)
        ) {
          continue;
        }

        let persistedProgress: (typeof executionProgressRecords)[number] | undefined;
        for (const progress of executionProgressRecords) {
          if (progress.orderId !== execution.orderId) {
            continue;
          }

          if (
            persistedProgress === undefined ||
            compareExecutionProgressFacts(persistedProgress, progress) < 0
          ) {
            persistedProgress = progress;
          }
        }

        if (
          persistedProgress !== undefined &&
          !decimalGt(execution.executedQuantity, persistedProgress.cumulativeQuantity)
        ) {
          continue;
        }

        throw new Error(
          `[loadTradingDayRuntimeSnapshot] 保护性清仓订单缺少精确成交时间，无法恢复或补写 completion: ${execution.orderId}`,
        );
      }

      for (const progress of latestProgressByDirection.values()) {
        const position = lastState.positionCache.get(progress.symbol);
        const hasPosition =
          position !== null && Number.isFinite(position.quantity) && position.quantity > 0;
        const hasPendingProtectiveOrders = pendingProtectiveDirections.has(progress.direction);

        protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
          direction: progress.direction,
          symbol: progress.symbol,
          latestExecutedTimeMs: progress.lastExecutionTimeMs,
        });

        if (hasPosition || hasPendingProtectiveOrders) {
          continue;
        }

        const preparedEpisode = protectiveLiquidationEpisodeTracker.prepareCompletion({
          direction: progress.direction,
          isDirectionFlat: true,
          hasPendingProtectiveOrders: false,
        });
        if (preparedEpisode === null) {
          throw new Error(
            `[loadTradingDayRuntimeSnapshot] crash-gap episode 无法冻结: ${progress.orderId}`,
          );
        }

        const preparedDailyLoss = dailyLossTracker.prepareProtectionBoundary({
          direction: preparedEpisode.direction,
          boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
        });
        mixedTradeLogRepository.appendCompletionIdempotent({
          monitorSymbol: expectedMonitorSymbol,
          direction: preparedEpisode.direction,
          boundaryExecutedTimeMs: preparedEpisode.boundaryExecutedTimeMs,
          orderBaselines: preparedDailyLoss.orderBaselines,
        });
        dailyLossTracker.commitProtectionBoundary(preparedDailyLoss);
        protectiveLiquidationEpisodeTracker.commitCompletion(preparedEpisode);
      }
    }

    if (hydrateCooldownFromTradeLog) {
      tradeLogHydrator.hydrate();
    }

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
