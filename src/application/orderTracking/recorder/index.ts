/**
 * 订单记录唯一 owner。
 * 同一 broker identity 的 API/WS 事实及经济消费证明共同提交；OPEN partial 只更新权威事实。
 */

import {
  apiOrderToExecutionFact,
  factToRecord,
  prepareExecutionCommit,
  projectionChanged,
  projectRecords,
  projectSlices,
} from '../../../domain/order/executionProjection.js';
import { validateOrdersForRebuild } from '../../../domain/order/orderRecordPolicy.js';
import type { OwnedExecutionFact } from '../../../domain/order/types.js';
import type {
  BrokerOrderExecutionFact,
  OrderExecutionAdmission,
  OrderFactBatchCommitResult,
  OrderProjectionTarget,
  OrderRecorder,
} from '../../../types/orderRecorder.js';

import type { OrderFact } from '../../../types/trade.js';
import { exactCompare } from '../../../utils/numeric/exact.js';
import { createOrderStorage } from './orderStorage.js';
import type { OrderRecorderDeps, OrderRecorderFactoryDeps } from './types.js';

/** 创建订单 owner；所有预检、消费证明与列表发布在无 await 同步段完成。 */
function createOrderRecorderFromParts(deps: OrderRecorderDeps): OrderRecorder {
  const { storage, orderSnapshotReadPort } = deps;
  const executionFacts = new Map<string, OwnedExecutionFact>();
  let projectionSequence = 0;

  function nextProjectionSequence(): number {
    if (
      !Number.isSafeInteger(projectionSequence) ||
      projectionSequence === Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError('[订单记录] 经济范围版本越界');
    }

    return projectionSequence + 1;
  }

  /** 所有预检先完成，再在无 await 段替换私有事实与经济列表。 */
  function commitExecutionFact(
    fact: BrokerOrderExecutionFact,
    isLongSymbol: boolean,
    relatedBuyOrderIds: ReadonlyArray<string>,
    beforeCommit: () => OrderExecutionAdmission,
  ): void {
    const sequence = nextProjectionSequence();
    const previous = executionFacts.get(fact.brokerOrderId);
    const entry = prepareExecutionCommit(
      fact,
      isLongSymbol,
      previous,
      relatedBuyOrderIds,
      sequence,
      'ONLINE',
    );
    const staged = new Map(executionFacts);
    staged.set(fact.brokerOrderId, entry);
    const merged = entry.fact;
    const authoritativeFactChanged = merged !== previous?.fact;
    const economicInputChanged =
      merged.cumulativeQuantity !== previous?.fact.cumulativeQuantity ||
      exactCompare(merged.cumulativeAmount, previous.fact.cumulativeAmount) !== 0 ||
      merged.executionTimeMs !== previous.fact.executionTimeMs ||
      merged.phase !== previous.fact.phase;
    const associationChanged =
      previous?.relatedBuyOrderIds.length !== entry.relatedBuyOrderIds.length ||
      previous.relatedBuyOrderIds.some((id, index) => id !== entry.relatedBuyOrderIds[index]);
    // broker revision 水位不是经济变化；无需重算列表，也不制造新成交后的刷新需求。
    const next =
      economicInputChanged || associationChanged
        ? projectRecords(staged, fact.symbol, isLongSymbol)
        : storage.getBuyOrdersList(fact.symbol, isLongSymbol);
    const previousSell = storage.getSellRecordByOrderId(fact.brokerOrderId);
    const sell =
      entry.fact.side === 'SELL' && entry.economicQuantity > 0 ? factToRecord(entry.fact) : null;
    const changed =
      projectionChanged(storage.getBuyOrdersList(fact.symbol, isLongSymbol), next) ||
      (sell !== null &&
        (previousSell?.executedQuantity !== sell.executedQuantity ||
          previousSell.executedTime !== sell.executedTime ||
          exactCompare(previousSell.costAmount, sell.costAmount) !== 0));
    // 经济覆盖不证明 durable/episode 义务已完成；纯重复也先经过同步准入与持久化。
    // 完整候选先成功，再同步准入/durable；交易日准入抑制不写事实、覆盖、序列、列表或 stale。
    // Daily 的已冻结边界仅约束日损投影，不阻止同日合法累计事实进入本 owner。
    const admission: unknown = beforeCommit();
    if (admission === 'SUPPRESSED') return;

    if (admission !== 'ADMITTED' && admission !== 'DUPLICATE')
      throw new Error('[订单记录] 缺少明确同步成交准入');

    if (!authoritativeFactChanged && !changed && !associationChanged) return;

    projectionSequence = sequence;
    executionFacts.set(fact.brokerOrderId, entry);
    if (economicInputChanged || associationChanged)
      (isLongSymbol ? storage.setBuyOrdersListForLong : storage.setBuyOrdersListForShort)(
        fact.symbol,
        next,
      );

    if (sell !== null && economicInputChanged) storage.setSellRecord(sell);

    if (economicInputChanged)
      deps.settlementRefreshNeedRecorder.recordSettlementRefreshNeed({
        refreshAccount: true,
        refreshPositions: true,
      });
  }

  /** 全 batch 归属/累计事实预检；controlled rebuild 才重建基线并放下旧 clear scope。 */
  function commitRebuildSnapshot(
    targets: ReadonlyArray<OrderProjectionTarget>,
    allOrders: ReadonlyArray<OrderFact>,
    isCurrent: () => boolean,
    mode: 'ACTIVATION' | 'REBUILD',
  ): OrderFactBatchCommitResult {
    const unique = new Map<string, OrderProjectionTarget>();
    for (const target of targets) {
      const old = unique.get(target.symbol);
      if (
        target.symbol.length === 0 ||
        (old !== undefined && old.isLongSymbol !== target.isLongSymbol)
      )
        throw new Error('[订单记录] API batch 归属冲突');

      unique.set(target.symbol, target);
      validateOrdersForRebuild(allOrders.filter((order) => order.symbol === target.symbol));
    }

    const sequence = nextProjectionSequence();
    const staged = new Map(executionFacts);
    if (mode === 'REBUILD') {
      for (const [id, entry] of staged) {
        if (unique.has(entry.fact.symbol))
          staged.set(id, { ...entry, projectionSlices: [], relatedBuyOrderIds: [] });
      }
    }

    for (const order of allOrders) {
      const target = unique.get(order.symbol);
      if (target === undefined) continue;

      const prepared = prepareExecutionCommit(
        apiOrderToExecutionFact(order),
        target.isLongSymbol,
        staged.get(order.orderId),
        [],
        sequence,
        'HISTORY',
      );
      const fact = prepared.fact;
      let entry = prepared;
      if (mode === 'REBUILD' && fact.phase === 'TERMINAL' && fact.cumulativeQuantity > 0) {
        const executionTimeMs = fact.executionTimeMs;
        if (executionTimeMs === null)
          throw new Error('[订单记录] rebuild execution lacks trusted time');

        entry = Object.freeze({
          ...prepared,
          economicQuantity: fact.cumulativeQuantity,
          projectionSlices: Object.freeze([
            Object.freeze({
              quantity: fact.cumulativeQuantity,
              executionTimeMs,
              admittedSequence: sequence,
              origin: 'HISTORY',
              clearedAtSequence: null,
            }),
          ]),
        });
      }

      staged.set(order.orderId, entry);
    }

    const lists = [...unique.values()].map((target) => ({
      target,
      next: projectRecords(staged, target.symbol, target.isLongSymbol),
    }));
    if (!isCurrent()) return { status: 'ABORTED' };

    projectionSequence = sequence;
    executionFacts.clear();
    for (const [id, entry] of staged) executionFacts.set(id, entry);

    for (const { target, next } of lists)
      (target.isLongSymbol ? storage.setBuyOrdersListForLong : storage.setBuyOrdersListForShort)(
        target.symbol,
        next,
      );

    for (const entry of staged.values()) {
      if (unique.has(entry.fact.symbol) && entry.fact.side === 'SELL' && entry.economicQuantity > 0)
        storage.setSellRecord(factToRecord(entry.fact));
    }

    // ACTIVATION/REBUILD 是受控覆盖基线，不以新 brokerId 推造在线成交及全局 stale。
    for (const [brokerOrderId, entry] of staged)
      if (brokerOrderId !== entry.fact.brokerOrderId)
        throw new Error('[订单记录] staged fact identity mismatch');

    return { status: 'COMMITTED' };
  }

  /** 仅标记当前幸存经济范围为 cleared；SELL 过滤消除的范围仍可因合法修订重新筛选。 */
  function clearBuyOrders(symbol: string, isLongSymbol: boolean): void {
    const current = projectSlices(executionFacts, symbol, isLongSymbol);
    const sequence = nextProjectionSequence();
    for (const [id, entry] of executionFacts) {
      const cleared = current
        .filter((input) => input.brokerOrderId === id)
        .map((input) => input.slice);
      if (cleared.length > 0)
        executionFacts.set(
          id,
          Object.freeze({
            ...entry,
            projectionSlices: Object.freeze(
              entry.projectionSlices.map((slice) =>
                cleared.includes(slice)
                  ? Object.freeze({ ...slice, clearedAtSequence: sequence })
                  : slice,
              ),
            ),
          }),
        );
    }

    projectionSequence = sequence;
    storage.clearBuyOrders(symbol, isLongSymbol);
  }

  /** 生命周期 reset 清空唯一 fact owner 与经济列表，不保留跨日消费证明。 */
  function resetAll(): void {
    executionFacts.clear();
    projectionSequence = 0;
    storage.clearAll();
  }

  return {
    commitExecutionFact,
    getExecutionFact: (brokerOrderId) => executionFacts.get(brokerOrderId)?.fact ?? null,
    commitRebuildSnapshot,
    clearBuyOrders,
    getLatestBuyOrderCost: storage.getLatestBuyOrderCost,
    getCostBasis: storage.getCostBasis,
    getSellRecordByOrderId: storage.getSellRecordByOrderId,
    fetchAllOrdersFromAPI: orderSnapshotReadPort.fetchAllOrders,
    validateRebuildSnapshot: (symbol, allOrders) => {
      validateOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
    },
    getBuyOrdersForSymbol: storage.getBuyOrdersList,
    submitSellOrder: (orderId, symbol, direction, quantity, relatedBuyOrderIds, submittedAtMs) => {
      if (
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(submittedAtMs) ||
        submittedAtMs <= 0
      ) {
        throw new Error('[订单记录] pending SELL 提交事实无效');
      }

      storage.addPendingSell({
        orderId,
        symbol,
        direction,
        submittedQuantity: quantity,
        relatedBuyOrderIds,
      });
    },
    updatePendingSell: storage.updatePendingSell,
    markSellFilled: storage.markSellFilled,
    markSellPartialFilled: storage.markSellPartialFilled,
    markSellCancelled: storage.markSellCancelled,
    getPendingSellSnapshot: storage.getPendingSellSnapshot,
    allocateRelatedBuyOrderIdsForRecovery: storage.allocateRelatedBuyOrderIdsForRecovery,
    selectSellableOrders: storage.selectSellableOrders,
    resetAll,
  };
}

/** 创建正式订单 owner，保留既有组装入口但不保留旧事实写方法。 */
export function createOrderRecorder(deps: OrderRecorderFactoryDeps): OrderRecorder {
  const { logger } = deps;
  logger.debug('[订单记录] 创建唯一 broker fact owner');
  return createOrderRecorderFromParts({
    storage: createOrderStorage(logger),
    orderSnapshotReadPort: deps.orderSnapshotReadPort,
    settlementRefreshNeedRecorder: deps.settlementRefreshNeedRecorder,
  });
}
