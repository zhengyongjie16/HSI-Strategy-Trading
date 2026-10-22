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
 * 4. 获取全量订单，用当日 durable progress/completion 的 known 累计状态归一 API 观察
 * 5. 解析席位绑定（prepareSeatsForRuntime）并全量重算日内亏损，随后重放原边界 progress
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
import { getHKDateKey } from '../../utils/time/index.js';
import {
  isInContinuousHKSession,
  isWithinMorningOpenWindow,
} from '../../domain/tradingSession/index.js';
import { normalizeExecutionOrder } from './executionNormalization.js';
import { prepareSeatsForRuntime } from './seatPreparation.js';
import { collectRuntimeQuoteSymbols } from './quoteSymbols.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { exactCompare, safeQuantityNumber } from '../../utils/numeric/exact.js';
import { assertExecutionHistory } from '../../domain/risk/executionHistory.js';
import type { ExecutionHistorySnapshot } from '../../domain/risk/types.js';
import { resolveOrderOwnership } from '../../domain/order/orderOwnership.js';
import { hasProtectiveLiquidationRemark } from '../../domain/order/orderRemark.js';
import { decimalGt } from '../../utils/numeric/index.js';
import type {
  LoadTradingDayRuntimeSnapshotDeps,
  LoadTradingDayRuntimeSnapshotParams,
  NormalizedExecutionOrder,
  RecoveryExecutionHistory,
  LoadTradingDayRuntimeSnapshotResult,
  TradingDayRuntimeInvalidationResult,
} from './types.js';
import type { ProtectiveLiquidationDirection } from '../../domain/liquidation/episode/types.js';
import type { OrderFact } from '../../types/trade.js';
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
  allOrders: ReadonlyArray<OrderFact>,
): ReadonlyMap<string, OrderFact> {
  const rawProtectiveSellOrdersById = new Map<string, OrderFact>();
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
  rawProtectiveSellOrdersById: ReadonlyMap<string, OrderFact>,
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
 * 构建并校验恢复期完整历史（progress phase-known + completion baseline phase-null）。
 * 同 revision/数量/金额/T 与跨 revision 的 quantity/amount/T 单调均在形成 known 前校验；
 * 不使用“排序最新”覆盖冲突，也不新建 evidence 仓库。
 */
function buildRecoveryExecutionHistories(
  progressRecords: ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>,
  completionRecords: ReadonlyArray<ProtectiveLiquidationCompletionRecordV1>,
): ReadonlyMap<string, RecoveryExecutionHistory> {
  const groupsByOrderId = new Map<
    string,
    {
      symbol: string;
      side: 'BUY' | 'SELL';
      direction: 'LONG' | 'SHORT';
      snapshots: ExecutionHistorySnapshot[];
    }
  >();

  const appendSnapshot = (
    snapshot: ExecutionHistorySnapshot,
    direction: 'LONG' | 'SHORT',
  ): void => {
    const existing = groupsByOrderId.get(snapshot.orderId);
    if (existing === undefined) {
      groupsByOrderId.set(snapshot.orderId, {
        symbol: snapshot.symbol,
        side: snapshot.side,
        direction,
        snapshots: [snapshot],
      });
    } else {
      if (existing.symbol !== snapshot.symbol || existing.side !== snapshot.side)
        throw new Error(
          `[loadTradingDayRuntimeSnapshot] 恢复历史 identity 冲突: ${snapshot.orderId}`,
        );

      if (existing.direction !== direction)
        throw new Error(`[loadTradingDayRuntimeSnapshot] 恢复历史方向冲突: ${snapshot.orderId}`);

      existing.snapshots.push(snapshot);
    }
  };

  for (const record of progressRecords) {
    appendSnapshot(
      {
        orderId: record.orderId,
        symbol: record.symbol,
        side: 'SELL',
        factStage: record.factStage,
        cumulativeQuantity: safeQuantityNumber(record.cumulativeQuantity),
        cumulativeAmount: record.cumulativeAmount,
        lastExecutionTimeMs: record.lastExecutionTimeMs,
        orderUpdatedAtMs: record.orderRevisionMs,
      },
      record.direction,
    );
  }

  for (const completion of completionRecords) {
    for (const baseline of completion.orderBaselines) {
      appendSnapshot(
        {
          orderId: baseline.orderId,
          symbol: baseline.symbol,
          side: baseline.side,
          factStage: null,
          cumulativeQuantity: safeQuantityNumber(baseline.cumulativeQuantity),
          cumulativeAmount: baseline.cumulativeAmount,
          lastExecutionTimeMs: baseline.lastExecutionTimeMs,
          orderUpdatedAtMs: baseline.orderRevisionMs,
        },
        completion.direction,
      );
    }
  }

  const histories = new Map<string, RecoveryExecutionHistory>();
  for (const [orderId, { snapshots, direction }] of groupsByOrderId) {
    const latest = assertExecutionHistory({ snapshots });
    if (latest === undefined) throw new Error('[DailyLossTracker] execution history is empty');

    histories.set(orderId, {
      known: {
        brokerOrderId: latest.orderId,
        symbol: latest.symbol,
        side: latest.side,
        cumulativeQuantity: latest.cumulativeQuantity,
        cumulativeAmount: latest.cumulativeAmount,
        executionTimeMs: latest.lastExecutionTimeMs,
        updatedAtMs: latest.orderUpdatedAtMs,
        phase: latest.factStage,
      },
      snapshots,
      direction,
    });
  }

  return histories;
}

/** 用归一后的 final API 事实补齐完整历史校验；任何冲突都在副作用前阻断。 */
function assertRecoveryHistoryAgainstOrders(
  histories: ReadonlyMap<string, RecoveryExecutionHistory>,
  allOrders: ReadonlyArray<NormalizedExecutionOrder>,
): void {
  const orderById = new Map(allOrders.map((order) => [order.orderId, order] as const));
  for (const [orderId, history] of histories) {
    const order = orderById.get(orderId);
    if (order === undefined)
      throw new Error(`[loadTradingDayRuntimeSnapshot] 恢复历史缺少当前 API 订单: ${orderId}`);

    assertExecutionHistory({
      snapshots: history.snapshots,
      finalSnapshot: {
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.executionSide,
        factStage: order.executionPhase,
        cumulativeQuantity: order.executedQuantity,
        cumulativeAmount: order.executedAmount,
        lastExecutionTimeMs: order.executionTimeMs,
        orderUpdatedAtMs: order.updatedAtMs,
      },
    });
  }
}

/**
 * 恢复不能借在线 OPEN→TERMINAL 裁决吞掉旧精度冲突。
 * 同 revision/quantity 的异金额必须由原 durable TERMINAL 确认；阶段变化或新 API 更精确都不是独立证据。
 * 更高 revision 和在线合法修订仍由原订单事实 owner 裁决，不在此改写历史或引入容差。
 */
function assertSameRevisionTerminalAmountHasDurableEvidence(
  progressRecords: ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>,
  rawProtectiveSellOrdersById: ReadonlyMap<string, OrderFact>,
): void {
  for (const progress of progressRecords) {
    const order = rawProtectiveSellOrdersById.get(progress.orderId);
    if (
      progress.factStage !== 'OPEN' ||
      order?.executionPhase !== 'TERMINAL' ||
      progress.orderRevisionMs !== order.updatedAtMs ||
      safeQuantityNumber(progress.cumulativeQuantity) !== order.executedQuantity ||
      order.executedAmount === null ||
      exactCompare(progress.cumulativeAmount, order.executedAmount) === 0
    ) {
      continue;
    }

    const observedAmount = order.executedAmount;
    const hasDurableTerminalEvidence = progressRecords.some(
      (terminal) =>
        terminal.factStage === 'TERMINAL' &&
        terminal.orderId === progress.orderId &&
        terminal.orderRevisionMs === progress.orderRevisionMs &&
        exactCompare(terminal.cumulativeQuantity, progress.cumulativeQuantity) === 0 &&
        exactCompare(terminal.cumulativeAmount, observedAmount) === 0 &&
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
 * @param deps 依赖注入（marketDataClient、trader、lastState、tradingConfig、symbolRegistry、dailyLossTracker、tradeLogHydrator）
 * @returns 接收 LoadTradingDayRuntimeSnapshotParams 的异步函数，返回全量订单与行情快照供重建使用
 */
export function createLoadTradingDayRuntimeSnapshot(
  deps: LoadTradingDayRuntimeSnapshotDeps,
): (params: LoadTradingDayRuntimeSnapshotParams) => Promise<LoadTradingDayRuntimeSnapshotResult> {
  const { logger } = deps;
  const {
    marketDataClient,
    orderRecorder,
    orderHoldRegistry,
    orderMonitor,
    tradingTimeState,
    tradingCalendarState,
    quoteSubscriptionState,
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

      tradingCalendarState.cachedTradingDayInfo = {
        dateKey: getHKDateKey(now) ?? '',
        info: tradingDayInfo,
      };
      tradingTimeState.isHalfDay = tradingDayInfo.isHalfDay;
    }

    await orderMonitor.initialize();
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
    const rawOrders = await orderRecorder.fetchAllOrdersFromAPI();
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
    // durable 来源/唯一归属先预检；API 观察必须先用 known 累计状态归一，再进入 daily 全量重算。
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

    const recoveryExecutionHistories = buildRecoveryExecutionHistories(
      executionProgressRecords,
      completionRecords,
    );
    const allOrders = rawOrders.map((order) =>
      normalizeExecutionOrder(order, recoveryExecutionHistories.get(order.orderId)?.known, 'THROW'),
    );
    // 完整历史（progress + baseline + 归一 final）在任何副作用前校验；冲突不得进入重算/回放。
    assertRecoveryHistoryAgainstOrders(recoveryExecutionHistories, allOrders);
    invalidation = resolveReceiptInvalidation();
    if (invalidation !== null) return invalidation;

    const recovery = {
      executionSnapshots: [...executionProgressRecords]
        .sort(compareExecutionProgressFacts)
        .map((progress) => ({ ...progress, side: 'SELL' as const })),
      boundaries: [...completionRecords].sort(
        (left, right) => left.boundaryExecutedTimeMs - right.boundaryExecutedTimeMs,
      ),
    };
    // durable 恢复不依赖席位搜索结果，先用同一纯 prepare 阻断缺失 baseline，避免 hold/seat 半发布。
    // 席位准备完成后仍需按最终相关标的集形成正式候选，不复用跨 await 的发布能力。
    if (completionRecords.length > 0 || executionProgressRecords.length > 0)
      dailyLossTracker.prepareRecalculationFromAllOrders(
        allOrders,
        tradingConfig.monitor,
        now,
        new Map(),
        undefined,
        recovery,
      );

    orderHoldRegistry.seedFromOrders(allOrders);
    await prepareSeatsForRuntime({
      tradingConfig,
      symbolRegistry,
      positions: canonicalView.positions,
      orders: allOrders,
      marketDataClient,
      logger,
      startupSeatSearch,
      canContinue: () => resolveReceiptInvalidation() === null,
      now: () => now,
      resolveCanAutoSearchNow: ({ currentTime, openDelayMinutes }) => {
        const tradingDayInfo = tradingCalendarState.cachedTradingDayInfo?.info ?? null;
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

    const orderHoldSymbols = orderHoldRegistry.getHoldSymbols();
    const allTradingSymbols = collectRuntimeQuoteSymbols(
      tradingConfig.monitor,
      symbolRegistry,
      canonicalView.positions,
      orderHoldSymbols,
    );
    const relatedTradingSymbols = new Set(allTradingSymbols);
    relatedTradingSymbols.delete(tradingConfig.monitor.monitorSymbol);
    const preparedDailyLoss = dailyLossTracker.prepareRecalculationFromAllOrders(
      allOrders,
      tradingConfig.monitor,
      now,
      new Map(),
      relatedTradingSymbols,
      recovery,
    );

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
          executedQuantity,
        });
      }
    }

    const latestProgressByDirection = new Map<
      ProtectiveLiquidationDirection,
      (typeof executionProgressRecords)[number]
    >();
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
    }

    dailyLossTracker.publishRecalculation(preparedDailyLoss);
    seatActivationDispatcher.dispatchCurrentActivatingSeats();
    protectiveLiquidationEpisodeTracker.resetAll();

    for (const [direction, boundaryExecutedTimeMs] of completedBoundaryByDirection) {
      protectiveLiquidationEpisodeTracker.restoreCompletedBoundary({
        direction,
        boundaryExecutedTimeMs,
      });
    }

    if (hydrateCooldownFromTradeLog) {
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

    quoteSubscriptionState.allTradingSymbols = allTradingSymbols;
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
