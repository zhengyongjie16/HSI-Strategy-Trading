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
import { TRADING } from '../../constants/index.js';
import {
  getHKDateKey,
  isInContinuousHKSession,
  isWithinMorningOpenWindow,
} from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { prepareSeatsForRuntime } from '../recovery/seatPreparation.js';
import { collectRuntimeQuoteSymbols } from '../utils.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { exactCompare, safeQuantityNumber } from '../../utils/numeric/exact.js';
import { withTrustedOrderExecutionTimes } from '../../domain/order/executionFact.js';
import type { OrderExecutionTimeEvidence } from '../../types/orderRecorder.js';
import { resolveOrderOwnership } from '../../domain/order/orderOwnership.js';
import { hasProtectiveLiquidationRemark } from '../../domain/order/orderRemark.js';
import { decimalGt } from '../../utils/numeric/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  LoadTradingDayRuntimeSnapshotResult,
  TradingDayRuntimeInvalidationResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../domain/liquidation/episode/types.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import type {
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
} from '../../types/tradeLog.js';

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
    exactCompare(left.cumulativeQuantity, right.cumulativeQuantity) ||
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
    exactCompare(left.cumulativeQuantity, right.cumulativeQuantity) ||
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
    if (order.executionSide !== 'SELL' || !hasProtectiveLiquidationRemark(order.remark)) {
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
    if (rawOrder?.executionSide !== 'SELL' || !hasProtectiveLiquidationRemark(rawOrder.remark)) {
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
 * 恢复不能借在线 OPEN→TERMINAL 裁决吞掉旧精度冲突。
 * 同 revision/quantity 的异金额必须由原 durable TERMINAL 确认；阶段变化或新 API 更精确都不是独立证据。
 * 更高 revision 和在线合法修订仍由原订单事实 owner 裁决，不在此改写历史或引入容差。
 */
function assertSameRevisionTerminalAmountHasDurableEvidence(
  progressRecords: ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>,
  rawProtectiveSellOrdersById: ReadonlyMap<string, RawOrderFromAPI>,
): void {
  for (const progress of progressRecords) {
    const order = rawProtectiveSellOrdersById.get(progress.orderId);
    if (
      progress.factStage !== 'OPEN' ||
      order?.executionPhase !== 'TERMINAL' ||
      progress.orderRevisionMs !== order.updatedAtMs ||
      safeQuantityNumber(progress.cumulativeQuantity) !== order.executedQuantity ||
      exactCompare(progress.cumulativeAmount, order.executedAmount) === 0
    ) {
      continue;
    }

    const hasDurableTerminalEvidence = progressRecords.some(
      (terminal) =>
        terminal.factStage === 'TERMINAL' &&
        terminal.orderId === progress.orderId &&
        terminal.orderRevisionMs === progress.orderRevisionMs &&
        exactCompare(terminal.cumulativeQuantity, progress.cumulativeQuantity) === 0 &&
        exactCompare(terminal.cumulativeAmount, order.executedAmount) === 0 &&
        terminal.lastExecutionTimeMs === progress.lastExecutionTimeMs,
    );
    if (!hasDurableTerminalEvidence) {
      throw new Error(
        `[loadTradingDayRuntimeSnapshot] 同 revision OPEN/TERMINAL 金额冲突缺少独立 durable 终态证据: ${progress.orderId}`,
      );
    }
  }
}

/**
 * 创建交易日运行时快照加载函数（工厂）。
 * 注入依赖后返回 loadTradingDayRuntimeSnapshot，用于启动初始化与开盘重建时加载账户、持仓、订单、席位与行情快照。
 *
 * @param deps 依赖注入（marketDataClient、trader、lastState、tradingConfig、symbolRegistry、dailyLossTracker、tradeLogHydrator、reportFatalError）
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
    protectionRecovery,
    startupSeatSearch,
    seatActivationDispatcher,
    snapshot,
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
    const originToken = { ...snapshot.getView().token };
    const resolveOriginInvalidation = (): TradingDayRuntimeInvalidationResult | null => {
      if (
        snapshot.getView().token.dayEpoch !== originToken.dayEpoch ||
        snapshot.getStatus().admission === 'CLOSED'
      ) {
        return { status: 'ABORTED' };
      }

      return snapshot.isCurrent(originToken, { account: false, positions: false })
        ? null
        : { status: 'SUPERSEDED' };
    };
    let invalidation = resolveOriginInvalidation();
    if (invalidation !== null) return invalidation;

    const expectedMonitorSymbol = tradingConfig.monitor.monitorSymbol;
    if (requireTradingDay) {
      const tradingDayInfo = await marketDataClient.isTradingDay(now);
      if (!tradingDayInfo.isTradingDay) {
        throw new Error('重建触发时交易日信息无效');
      }

      invalidation = resolveOriginInvalidation();
      if (invalidation !== null) return invalidation;

      lastState.cachedTradingDayInfo = {
        dateKey: getHKDateKey(now) ?? '',
        info: tradingDayInfo,
      };
      lastState.isHalfDay = tradingDayInfo.isHalfDay;
    }

    await trader.initializeOrderMonitor();
    invalidation = resolveOriginInvalidation();
    if (invalidation !== null) return invalidation;

    const handle = snapshot.requestRefresh({
      source: params.source === 'OPEN_REBUILD' ? 'LIFECYCLE_REBUILD' : 'STARTUP',
      dayEpoch: originToken.dayEpoch,
      refreshAccount: true,
      refreshPositions: true,
    });
    const accountPositionReceipt = await handle.result.finally(handle.cancel);
    if (accountPositionReceipt.status === 'ABORTED') return { status: 'ABORTED' };

    const canonicalView = accountPositionReceipt.view;
    const capturedSnapshotToken = accountPositionReceipt.snapshotToken;
    const resolveReceiptInvalidation = (): TradingDayRuntimeInvalidationResult | null => {
      const originInvalidation = resolveOriginInvalidation();
      if (originInvalidation !== null) return originInvalidation;

      return capturedSnapshotToken.dayEpoch === originToken.dayEpoch &&
        capturedSnapshotToken.snapshotGeneration === originToken.snapshotGeneration &&
        snapshot.isCurrent(capturedSnapshotToken, { account: true, positions: true, paired: true })
        ? null
        : { status: 'SUPERSEDED' };
    };
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    logger.debug('账户和持仓信息获取成功，开始解析席位');
    const rawOrders = await trader.fetchAllOrdersFromAPI();
    const currentDayKey = getHKDateKey(now);
    if (hydrateCooldownFromTradeLog && currentDayKey === null)
      throw new Error('[loadTradingDayRuntimeSnapshot] 当前交易日键无法解析');

    const completionRecords =
      hydrateCooldownFromTradeLog && currentDayKey !== null
        ? [...mixedTradeLogRepository.loadCompletionRecords(currentDayKey)]
        : [];
    const executionProgressRecords =
      hydrateCooldownFromTradeLog && currentDayKey !== null
        ? [...mixedTradeLogRepository.loadExecutionProgressRecords(currentDayKey)]
        : [];
    // durable 来源/唯一归属先预检，再补真实 T；首轮 daily 全量重算不能先消费 API revision 伪 T。
    assertCompletionRecordsMatchExpectedMonitor(completionRecords, expectedMonitorSymbol);
    const rawProtectiveSellOrdersById = collectRawProtectiveSellOrdersById(rawOrders);
    assertExecutionProgressRecordsHaveRawProtectiveProvenance(
      executionProgressRecords,
      rawProtectiveSellOrdersById,
      tradingConfig.monitor,
      expectedMonitorSymbol,
    );

    assertSameRevisionTerminalAmountHasDurableEvidence(
      executionProgressRecords,
      rawProtectiveSellOrdersById,
    );
    const trustedEvidence: OrderExecutionTimeEvidence[] = executionProgressRecords.map(
      (progress) => ({
        brokerOrderId: progress.orderId,
        symbol: progress.symbol,
        side: 'SELL',
        phase: progress.factStage,
        cumulativeQuantity: safeQuantityNumber(progress.cumulativeQuantity),
        cumulativeAmount: progress.cumulativeAmount,
        lastExecutionTimeMs: progress.lastExecutionTimeMs,
        orderRevisionMs: progress.orderRevisionMs,
      }),
    );
    for (const completion of completionRecords)
      for (const baseline of completion.orderBaselines) {
        const order = rawOrders.find((entry) => entry.orderId === baseline.orderId);
        if (order?.symbol !== baseline.symbol || order.executionSide !== baseline.side)
          throw new Error('[loadTradingDayRuntimeSnapshot] completion baseline 原始订单归属冲突');

        const ownership = resolveOrderOwnership(order, tradingConfig.monitor);
        if (
          ownership?.monitorSymbol !== expectedMonitorSymbol ||
          ownership.direction !== completion.direction
        )
          throw new Error(
            '[loadTradingDayRuntimeSnapshot] completion baseline monitor/direction 归属冲突',
          );
        // V1 baseline 只证明累计载荷和执行时间，不加入要求 phase 的 progress 事实序列。
        // durable 边界仍由 dailyLoss 的原恢复规则消费，不替它编造 OPEN/TERMINAL。
      }

    const completionBaselines = completionRecords.flatMap(
      (completion) => completion.orderBaselines,
    );
    const ordersWithBaselineTimes = rawOrders.map((order) => {
      if (order.executionTimeMs !== null || order.executedQuantity === 0) return order;

      const matching = completionBaselines.filter(
        (baseline) =>
          baseline.orderId === order.orderId &&
          baseline.symbol === order.symbol &&
          baseline.side === order.executionSide &&
          safeQuantityNumber(baseline.cumulativeQuantity) === order.executedQuantity &&
          baseline.orderRevisionMs <= order.updatedAtMs,
      );
      const latest = [...matching].sort(
        (left, right) => right.orderRevisionMs - left.orderRevisionMs,
      )[0];
      if (latest === undefined) return order;

      for (const baseline of matching) {
        if (
          baseline.orderRevisionMs === latest.orderRevisionMs &&
          (baseline.lastExecutionTimeMs !== latest.lastExecutionTimeMs ||
            exactCompare(baseline.cumulativeAmount, latest.cumulativeAmount) !== 0)
        ) {
          throw new Error(
            '[loadTradingDayRuntimeSnapshot] 同 revision completion baseline 事实冲突',
          );
        }
      }

      // 只补已证明的 T；API 的 quantity/amount/revision/status 原样交 O owner 裁决。
      return Object.freeze({ ...order, executionTimeMs: latest.lastExecutionTimeMs });
    });
    const executionTimeFacts = ordersWithBaselineTimes.map((order) =>
      Object.freeze({
        orderId: order.orderId,
        symbol: order.symbol,
        executionSide: order.executionSide,
        executedQuantity: order.executedQuantity,
        executedAmount: order.executedAmount,
        executionTimeMs: order.executionTimeMs,
        updatedAtMs: order.updatedAtMs,
        executionPhase: order.executionPhase,
      }),
    );
    const trustedTimeFacts = withTrustedOrderExecutionTimes(executionTimeFacts, trustedEvidence);
    const allOrders = ordersWithBaselineTimes.map((order, index) => {
      const fact = trustedTimeFacts[index];
      if (
        fact?.orderId !== order.orderId ||
        fact.symbol !== order.symbol ||
        fact.executionSide !== order.executionSide
      ) {
        throw new TypeError(
          '[loadTradingDayRuntimeSnapshot] trusted execution fact identity changed',
        );
      }

      return fact.executionTimeMs === order.executionTimeMs
        ? order
        : Object.freeze({ ...order, executionTimeMs: fact.executionTimeMs });
    });
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    trader.seedOrderHoldSymbols(allOrders);
    await prepareSeatsForRuntime({
      tradingConfig,
      symbolRegistry,
      positions: canonicalView.positions,
      orders: allOrders,
      startupSeatSearch,
      canContinue: () => resolveReceiptInvalidation() === null,
      now: () => now,
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
    });
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    seatActivationDispatcher.dispatchCurrentActivatingSeats();
    const orderHoldSymbols = trader.getOrderHoldSymbols();
    const allTradingSymbols = collectRuntimeQuoteSymbols(
      tradingConfig.monitor,
      symbolRegistry,
      canonicalView.positions,
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
      const executedQuantity = order.executedQuantity;
      const hasProtectiveExecution =
        order.executionSide === 'SELL' && isValidPositiveNumber(executedQuantity);
      if (order.executionSide === 'SELL' && order.executionPhase === 'OPEN') {
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
        side: 'SELL',
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
        protectiveLiquidationEpisodeTracker.restoreInProgressEpisode({
          direction: progress.direction,
          symbol: progress.symbol,
          latestExecutedTimeMs: progress.lastExecutionTimeMs,
        });
      }

      // 全部历史事实与 episode 恢复后，由唯一 settlement owner 同步收口 crash-gap。
      // 恢复能力不直接触发冷却，随后 hydrate 根据 durable completion 只回放一次。
      if (
        !protectionRecovery.completeProtectionRecovery({
          snapshotToken: capturedSnapshotToken,
          pendingProtectiveDirections,
        })
      ) {
        return resolveReceiptInvalidation() ?? { status: 'ABORTED' };
      }
    }

    if (hydrateCooldownFromTradeLog) {
      tradeLogHydrator.hydrate();
    }

    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    if (resetRuntimeSubscriptions) {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
      invalidation = resolveReceiptInvalidation();
      if (invalidation !== null) return invalidation;
    }

    lastState.allTradingSymbols = allTradingSymbols;
    if (allTradingSymbols.size > 0) {
      await marketDataClient.subscribeSymbols([...allTradingSymbols]);
      invalidation = resolveReceiptInvalidation();
      if (invalidation !== null) return invalidation;
    }

    await marketDataClient.subscribeCandlesticks(
      tradingConfig.monitor.monitorSymbol,
      TRADING.CANDLE_PERIOD,
      'INTRADAY',
    );
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    const quotesMap = await marketDataClient.getQuotes(allTradingSymbols);
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    return {
      status: 'COMMITTED',
      snapshotToken: capturedSnapshotToken,
      allOrders,
      quotesMap,
    };
  };
}
