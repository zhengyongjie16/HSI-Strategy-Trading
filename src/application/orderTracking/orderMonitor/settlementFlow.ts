/** 订单终态结算：唯一 recorder 累计经济事实，durable 成功先于提交，资源关闭与经济幂等分离。 */

import { compareBuyOrdersBySellPriority } from '../../../domain/order/sellDeductionPolicy.js';
import { recordOrderTerminalConfirmation } from './orderObservation.js';
import type {
  DailyLossAuthoritativeFactSnapshot,
  DailyLossCumulativeExecutionResult,
} from '../../../types/risk.js';
import type { OrderRecorder } from '../../../types/orderRecorder.js';
import { exactCompare, exactMultiply } from '../../../utils/numeric/exact.js';
import { detachTrackedOrder } from './routingIndex.js';
import type {
  FinalizeOrderSettlementParams,
  FinalizeOrderSettlementResult,
  OrderCumulativeExecutionParams,
  SettlementFlow,
  SettlementFlowDeps,
} from './types.js';

/** 保留原整笔关联策略：累计卖量恰好覆盖关联买单时才声明精确关联，否则用累计过滤。 */
function exactRelatedIds(
  recorder: OrderRecorder,
  symbol: string,
  isLong: boolean,
  ids: ReadonlyArray<string>,
  quantity: number,
): ReadonlyArray<string> {
  if (ids.length === 0 || quantity <= 0) return [];

  const selected = recorder
    .getBuyOrdersForSymbol(symbol, isLong)
    .filter((order) => ids.includes(order.orderId))
    .sort(compareBuyOrdersBySellPriority);
  if (selected.length !== ids.length) return [];

  const settled: string[] = [];
  let matched = 0;
  for (const order of selected) {
    matched += order.executedQuantity;
    if (!Number.isSafeInteger(matched)) throw new RangeError('[订单监控] 关联数量越界');

    if (matched > quantity) return [];

    settled.push(order.orderId);
    if (matched === quantity) return settled;
  }

  return [];
}

/** 同步协调器：经济候选先完成，再 durable/daily commit，再 recorder publish 与同步 stale 登记。 */
export function createSettlementFlow(deps: SettlementFlowDeps): SettlementFlow {
  const {
    runtime,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    protectiveLiquidationEpisodeTracker,
    persistProtectiveLiquidationExecutionProgress,
    postTradeConsistencyRuntime,
    emitOrderStateChanged,
  } = deps;

  function recordDaily(
    params: OrderCumulativeExecutionParams,
    onProtectiveProgressCommitted: (snapshot: DailyLossAuthoritativeFactSnapshot) => void,
  ): DailyLossCumulativeExecutionResult {
    if (params.executedQuantity === 0)
      return { admission: 'DUPLICATE', authoritativeFactChanged: false, executionAdvanced: false };

    if (
      params.monitorSymbol === null ||
      params.executedQuantity === null ||
      params.executedPrice === null ||
      params.executedTimeMs === null ||
      params.orderUpdatedAtMs === null
    )
      throw new Error('[订单监控] 正成交缺少唯一归属或可信执行时间/revision');

    const monitorSymbol = params.monitorSymbol;
    const previous = orderRecorder.getExecutionFact(params.orderId);
    const needsProtectiveProgress =
      params.isProtectiveLiquidation &&
      params.side === 'SELL' &&
      (!runtime.closedOrderIds.has(params.orderId) ||
        previous === null ||
        params.orderUpdatedAtMs > previous.updatedAtMs ||
        params.executedQuantity > previous.cumulativeQuantity ||
        params.factStage !== previous.phase);
    return dailyLossTracker.recordCumulativeExecution(
      {
        orderId: params.orderId,
        factStage: params.factStage,
        direction: params.isLongSymbol ? 'LONG' : 'SHORT',
        symbol: params.symbol,
        side: params.side,
        executedQuantity: params.executedQuantity,
        executedPrice: params.executedPrice,
        executedTimeMs: params.executedTimeMs,
        orderUpdatedAtMs: params.orderUpdatedAtMs,
      },
      needsProtectiveProgress
        ? (snapshot) => {
            persistProtectiveLiquidationExecutionProgress({
              monitorSymbol,
              direction: params.isLongSymbol ? 'LONG' : 'SHORT',
              symbol: params.symbol,
              orderId: params.orderId,
              ...snapshot,
            });
            onProtectiveProgressCommitted(snapshot);
          }
        : undefined,
    );
  }

  function applyEpisode(
    params: OrderCumulativeExecutionParams,
    result: DailyLossCumulativeExecutionResult,
    firstTerminal: boolean,
    trustedExecutedTimeMs: number | null,
  ): void {
    const updatesInProgressEpisode =
      result.authoritativeFactChanged &&
      trustedExecutedTimeMs !== null &&
      protectiveLiquidationEpisodeTracker
        .getInProgressEpisodes()
        .some(
          (episode) =>
            episode.direction === (params.isLongSymbol ? 'LONG' : 'SHORT') &&
            episode.symbol === params.symbol &&
            trustedExecutedTimeMs > episode.latestExecutedTimeMs,
        );
    // 合法时间修订只追赶现存进行中事件；已完成或不存在的 episode 不由 closed 修订重建。
    if (
      (result.executionAdvanced || firstTerminal || updatesInProgressEpisode) &&
      params.executedQuantity !== null &&
      params.executedQuantity > 0 &&
      params.side === 'SELL' &&
      params.isProtectiveLiquidation &&
      trustedExecutedTimeMs !== null
    )
      protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress({
        direction: params.isLongSymbol ? 'LONG' : 'SHORT',
        symbol: params.symbol,
        executedTimeMs: trustedExecutedTimeMs,
      });
  }

  function commitExecution(
    params: OrderCumulativeExecutionParams,
    related: ReadonlyArray<string>,
    publishEpisode = true,
    finalizeTerminal = false,
  ): DailyLossCumulativeExecutionResult {
    if (params.executedQuantity === null || params.orderUpdatedAtMs === null)
      throw new Error('[订单监控] 缺少完整累计数量/revision');

    if (
      params.executedQuantity > 0 &&
      (params.monitorSymbol === null ||
        params.executedPrice === null ||
        exactCompare(params.executedPrice, '0') <= 0 ||
        params.executedTimeMs === null ||
        exactCompare(
          exactMultiply(params.executedPrice, String(params.executedQuantity)),
          params.executedAmount,
        ) !== 0)
    ) {
      throw new Error('[订单监控] 正成交原始价格/金额/归属/执行时间不完整');
    }

    const previous = orderRecorder.getExecutionFact(params.orderId);
    const admissionObservation: {
      result: DailyLossCumulativeExecutionResult | null;
      protectiveProgress: DailyLossAuthoritativeFactSnapshot | null;
    } = {
      result: null,
      protectiveProgress: null,
    };
    orderRecorder.commitExecutionFact(
      {
        brokerOrderId: params.orderId,
        symbol: params.symbol,
        side: params.side,
        phase: params.factStage,
        cumulativeQuantity: params.executedQuantity,
        cumulativeAmount: params.executedAmount,
        executionTimeMs: params.executedTimeMs,
        updatedAtMs: params.orderUpdatedAtMs,
      },
      params.isLongSymbol,
      related,
      () => {
        const admission = recordDaily(params, (snapshot) => {
          admissionObservation.protectiveProgress = snapshot;
        });
        admissionObservation.result = admission;
        return admission.admission;
      },
    );

    const adjudication = admissionObservation.result;
    if (adjudication === null) throw new Error('[订单监控] 经济提交未产生真实准入结果');

    if (publishEpisode && adjudication.admission !== 'SUPPRESSED') {
      const firstTerminal = finalizeTerminal && !runtime.closedOrderIds.has(params.orderId);
      // API 的经济覆盖、timeout prepare 都不证明 episode 已发布；首次正式收口补齐而不伪造成交。
      applyEpisode(
        params,
        adjudication,
        firstTerminal,
        admissionObservation.protectiveProgress?.lastExecutionTimeMs ?? null,
      );
      const committed = orderRecorder.getExecutionFact(params.orderId);
      if (
        firstTerminal &&
        (!params.isProtectiveLiquidation ||
          params.side !== 'SELL' ||
          protectiveLiquidationEpisodeTracker
            .getInProgressEpisodes()
            .some(
              (episode) =>
                episode.direction === (params.isLongSymbol ? 'LONG' : 'SHORT') &&
                episode.symbol === params.symbol,
            )) &&
        previous !== null &&
        committed !== null &&
        committed.cumulativeQuantity === previous.cumulativeQuantity &&
        exactCompare(committed.cumulativeAmount, previous.cumulativeAmount) === 0 &&
        committed.executionTimeMs === previous.executionTimeMs &&
        committed.phase === previous.phase
      ) {
        // 保留普通正成交终态补刷新；保护性 SELL 仅唤醒 S 完成现存 episode，旧边界补关资源不重复刷新。
        postTradeConsistencyRuntime.recordSettlementRefreshNeed({
          refreshAccount: true,
          refreshPositions: true,
        });
      }
    }

    return adjudication;
  }

  function recordCumulativeExecution(
    params: OrderCumulativeExecutionParams,
  ): DailyLossCumulativeExecutionResult {
    return commitExecution(params, []);
  }

  /** timeout terminal 先经 O candidate 校验，再同步 durable/daily 与经济提交；episode/terminal 资源仍在正式 settle 收口。 */
  function prepareProtectiveTerminalExecution(
    params: FinalizeOrderSettlementParams,
  ): DailyLossCumulativeExecutionResult | null {
    const tracked = runtime.trackedOrders.get(params.orderId);
    if (
      tracked?.executionSide !== 'SELL' ||
      !tracked.isProtectiveLiquidation ||
      params.executedQuantity === 0
    )
      return null;

    if (
      params.executedQuantity === null ||
      !Number.isSafeInteger(params.executedQuantity) ||
      params.executedQuantity < 0 ||
      exactCompare(params.executedAmount, '0') <= 0 ||
      params.executedTimeMs === null ||
      params.orderUpdatedAtMs === null
    )
      throw new Error('[订单监控] 保护性终态原始执行事实不完整');

    const pending = orderRecorder
      .getPendingSellSnapshot()
      .find((entry) => entry.orderId === params.orderId);
    const related = exactRelatedIds(
      orderRecorder,
      tracked.symbol,
      tracked.isLongSymbol,
      pending?.relatedBuyOrderIds ?? [],
      params.executedQuantity,
    );
    return commitExecution(
      {
        factStage: 'TERMINAL',
        orderId: params.orderId,
        side: 'SELL',
        monitorSymbol: tracked.monitorSymbol,
        symbol: tracked.symbol,
        isLongSymbol: tracked.isLongSymbol,
        isProtectiveLiquidation: true,
        executedPrice: params.executedPrice,
        executedQuantity: params.executedQuantity,
        executedAmount: params.executedAmount,
        executedTimeMs: params.executedTimeMs,
        orderUpdatedAtMs: params.orderUpdatedAtMs,
      },
      related,
      false,
    );
  }

  /** 先经济事实，再幂等关闭 terminal resources；closed set 不得阻止合法后续金额/revision 修订。 */
  function settleOrder(params: FinalizeOrderSettlementParams): FinalizeOrderSettlementResult {
    const tracked = runtime.trackedOrders.get(params.orderId);
    const trackedSide = tracked?.executionSide ?? null;
    const side = params.side ?? (tracked === undefined ? null : trackedSide);
    const symbol = tracked?.symbol ?? params.symbol ?? null;
    const monitorSymbol = tracked?.monitorSymbol ?? params.monitorSymbol ?? null;
    const isLong = tracked?.isLongSymbol ?? params.isLongSymbol;
    const protective = tracked?.isProtectiveLiquidation ?? params.isProtectiveLiquidation ?? false;
    const pending = orderRecorder
      .getPendingSellSnapshot()
      .find((entry) => entry.orderId === params.orderId);
    const quantity = params.executedQuantity;
    if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 0)
      throw new Error('[订单监控] terminal 累计数量无效');

    if (params.closedReason === 'FILLED' && quantity === 0)
      return { handled: false, relatedBuyOrderIds: null };

    if (
      quantity > 0 &&
      (symbol === null || side === null || isLong === undefined || monitorSymbol === null)
    )
      throw new Error('[订单监控] 正成交无法解析唯一 monitor/direction');

    const resourceOnlyZero = quantity === 0 && params.closedReason !== 'FILLED';
    if (resourceOnlyZero) {
      const previous = orderRecorder.getExecutionFact(params.orderId);
      if (
        exactCompare(params.executedAmount, '0') !== 0 ||
        params.executedTimeMs !== null ||
        (tracked !== undefined && tracked.executedQuantity > 0) ||
        (previous !== null && previous.cumulativeQuantity > 0)
      ) {
        throw new Error('[订单监控] 零执行资源终态与可信经济事实冲突');
      }

      if (
        params.orderUpdatedAtMs !== null &&
        (!Number.isSafeInteger(params.orderUpdatedAtMs) || params.orderUpdatedAtMs <= 0)
      ) {
        throw new Error('[订单监控] 零执行资源终态带有非法broker revision');
      }
    }

    recordOrderTerminalConfirmation(deps, params);

    // 关联身份来自可信 submission 与提交前精确覆盖，不可在经济过滤后由 survivor 反向合成。
    // 无执行的非FILLED终态只走下方原资源关闭链，不制造O/Daily/durable/S经济完成事实。
    let exactEconomicAssociation: ReadonlyArray<string> | null = null;
    if (!resourceOnlyZero && symbol !== null && side !== null && isLong !== undefined) {
      const related =
        side === 'SELL'
          ? exactRelatedIds(
              orderRecorder,
              symbol,
              isLong,
              pending?.relatedBuyOrderIds ?? [],
              quantity,
            )
          : [];
      if (side === 'SELL' && related.length > 0) exactEconomicAssociation = related;

      commitExecution(
        {
          factStage: 'TERMINAL',
          orderId: params.orderId,
          side,
          monitorSymbol,
          symbol,
          isLongSymbol: isLong,
          isProtectiveLiquidation: protective,
          executedPrice: params.executedPrice,
          executedQuantity: quantity,
          executedAmount: params.executedAmount,
          executedTimeMs: params.executedTimeMs,
          orderUpdatedAtMs: params.orderUpdatedAtMs,
        },
        related,
        true,
        true,
      );
    }

    if (runtime.closedOrderIds.has(params.orderId))
      return { handled: false, relatedBuyOrderIds: null };

    let relatedBuyOrderIds: ReadonlyArray<string> | null = null;
    if (side === 'SELL') {
      const released =
        params.closedReason === 'FILLED'
          ? orderRecorder.markSellFilled(params.orderId)
          : orderRecorder.markSellCancelled(params.orderId);
      // 零成交保留可信 submission 占用；正成交只有精确覆盖已证明时才输出剩余关联。
      if (released !== null && (quantity === 0 || exactEconomicAssociation !== null)) {
        const remaining = released.relatedBuyOrderIds.filter(
          (id) =>
            symbol !== null &&
            isLong !== undefined &&
            orderRecorder
              .getBuyOrdersForSymbol(symbol, isLong)
              .some((order) => order.orderId === id),
        );
        if (remaining.length > 0) relatedBuyOrderIds = remaining;
      }

      const disposition = params.pendingSellDisposition;
      if (disposition?.kind === 'HANDOFF_TO_FOLLOW_UP_SELL') {
        if (symbol === null || isLong === undefined || tracked === undefined)
          throw new Error('[订单监控] 跟进卖单缺少原 owner/提交时间');

        relatedBuyOrderIds ??= orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
          symbol,
          isLong ? 'LONG' : 'SHORT',
          disposition.followUpQuantity,
        );

        orderRecorder.submitSellOrder(
          params.orderId,
          symbol,
          isLong ? 'LONG' : 'SHORT',
          disposition.followUpQuantity,
          relatedBuyOrderIds,
          tracked.submittedAt,
        );
      }
    }

    runtime.closedOrderIds.add(params.orderId);
    if (tracked !== undefined) detachTrackedOrder(runtime, tracked.symbol, params.orderId);

    runtime.trackedOrders.delete(params.orderId);
    runtime.trackedOrderLifecycles.set(params.orderId, {
      ...runtime.trackedOrderLifecycles.get(params.orderId),
      state: 'CLOSED',
      settlementCompleted: true,
      settledWithRemainder:
        side === 'SELL' && tracked !== undefined && quantity < tracked.submittedQuantity,
    });
    orderHoldRegistry.markOrderClosed(params.orderId);
    emitOrderStateChanged({
      orderId: params.orderId,
      symbol,
      side,
      status: params.closedReason,
      monitorSymbol,
      isLongSymbol: isLong ?? null,
      isProtectiveLiquidation: protective,
      executedPrice: params.executedPrice,
      executedQuantity: quantity,
      executedTimeMs: params.executedTimeMs,
    });
    return { handled: true, relatedBuyOrderIds };
  }
  return { prepareProtectiveTerminalExecution, recordCumulativeExecution, settleOrder };
}
