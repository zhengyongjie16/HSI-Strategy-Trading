/**
 * 订单记录唯一 owner。
 * 同一 broker identity 的 API/WS 事实及经济消费证明共同提交；OPEN partial 只更新权威事实。
 */
import { logger } from '../../utils/logger/index.js';
import { exactAdd, exactCompare } from '../../utils/numeric/exact.js';
import type {
  BrokerOrderExecutionFact,
  OrderFactBatchCommitResult,
  OrderFactCommitReceipt,
  OrderExecutionAdmission,
  OrderProjectionTarget,
} from '../../types/orderRecorder.js';
import type { OrderRecord, OrderRecorder, RawOrderFromAPI } from '../../types/services.js';
import type {
  OrderDailyLossAnalysisDeps,
  OrderRecorderDeps,
  OrderRecorderFactoryDeps,
  OwnedExecutionFact,
  PreparedExecutionCommit,
  ProjectionSliceInput,
} from './types.js';
import { createOrderStorage } from './orderStorage.js';
import { createOrderAPIManager } from './orderApiManager.js';
import { applyFilteringAlgorithm } from '../../domain/order/orderFilteringEngine.js';
import { resolveOrderOwnership } from '../../domain/order/orderOwnership.js';
import { calculateTotalQuantity } from '../../domain/order/orderQuantity.js';
import {
  classifyAndConvertOrders,
  classifyOrdersForRebuild,
  proportionExecutionCost,
} from './utils.js';
import { deductSellQuantityFromBuyOrders } from '../../domain/order/sellDeductionPolicy.js';
import {
  mergeBrokerOrderExecutionFact,
  withTrustedOrderExecutionTimes,
} from '../../domain/order/executionFact.js';

/** 将已映射 API 事实交给相同累计事实裁决，不由 revision 回填可信执行时间。 */
function apiOrderToExecutionFact(order: RawOrderFromAPI): BrokerOrderExecutionFact {
  if (!['BUY', 'SELL'].includes(order.executionSide)) {
    throw new Error('[订单记录] API 订单方向不可归属');
  }

  return {
    brokerOrderId: order.orderId,
    symbol: order.symbol,
    side: order.executionSide,
    cumulativeQuantity: order.executedQuantity,
    cumulativeAmount: order.executedAmount,
    executionTimeMs: order.executionTimeMs,
    updatedAtMs: order.updatedAtMs,
    phase: order.executionPhase,
  };
}

/** 将非零累计事实发布为金额/数量成本依据，不重建金融均价。 */
function factToRecord(fact: BrokerOrderExecutionFact): OrderRecord {
  if (fact.executionTimeMs === null || fact.cumulativeQuantity <= 0) {
    throw new Error('[订单记录] 零成交不能构造经济记录');
  }

  return {
    orderId: fact.brokerOrderId,
    symbol: fact.symbol,
    costAmount: fact.cumulativeAmount,
    executedQuantity: fact.cumulativeQuantity,
    executedTime: fact.executionTimeMs,
    submittedAt: undefined,
    updatedAt: new Date(fact.updatedAtMs),
  };
}

/** 比较候选投影，金额保持精确文本；不修改已发布列表。 */
function projectionChanged(
  previous: ReadonlyArray<OrderRecord>,
  next: ReadonlyArray<OrderRecord>,
): boolean {
  return (
    previous.length !== next.length ||
    next.some((record, index) => {
      const old = previous[index];
      return (
        old?.orderId !== record.orderId ||
        old.executedQuantity !== record.executedQuantity ||
        old.executedTime !== record.executedTime ||
        exactCompare(old.costAmount, record.costAmount) !== 0
      );
    })
  );
}

/** 创建订单 owner；所有预检、消费证明与列表发布在无 await 同步段完成。 */
function createOrderRecorderFromParts(deps: OrderRecorderDeps): OrderRecorder {
  const { storage, apiManager } = deps;
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

  /** 准入与消费范围分别计算；OPEN partial 只更新权威事实，终态新增量才建立经济 slice。 */
  function prepareExecutionCommit(
    incoming: BrokerOrderExecutionFact,
    isLongSymbol: boolean,
    previous: OwnedExecutionFact | undefined,
    relatedBuyOrderIds: ReadonlyArray<string>,
    admittedSequence: number,
  ): PreparedExecutionCommit {
    if (previous !== undefined && previous.isLongSymbol !== isLongSymbol) {
      throw new Error('[订单记录] 同 broker identity 的方向归属冲突');
    }

    const fact = mergeBrokerOrderExecutionFact(previous?.fact, incoming);
    const economicQuantity = previous?.economicQuantity ?? 0;
    const terminal = fact.phase === 'TERMINAL';
    const delta = terminal ? fact.cumulativeQuantity - economicQuantity : 0;
    let slices = previous?.projectionSlices ?? [];
    if (delta > 0) {
      if (fact.executionTimeMs === null) throw new Error('[订单记录] 经济范围缺少执行时间');

      slices = [
        ...slices,
        Object.freeze({
          quantity: delta,
          executionTimeMs: fact.executionTimeMs,
          admittedSequence,
          clearedAtSequence: null,
        }),
      ];
    } else if (
      terminal &&
      fact.executionTimeMs !== previous?.fact.executionTimeMs &&
      slices.length > 0
    ) {
      const executionTimeMs = fact.executionTimeMs;
      if (executionTimeMs === null)
        throw new Error('[订单记录] terminal slice lacks trusted execution time');

      slices = slices.map((slice, index) =>
        index === slices.length - 1 ? Object.freeze({ ...slice, executionTimeMs }) : slice,
      );
    }

    return {
      entry: Object.freeze({
        fact,
        isLongSymbol,
        economicQuantity: terminal ? fact.cumulativeQuantity : economicQuantity,
        projectionSlices: Object.freeze(slices),
        relatedBuyOrderIds: Object.freeze(
          economicQuantity === 0 && relatedBuyOrderIds.length > 0
            ? [...relatedBuyOrderIds]
            : [...(previous?.relatedBuyOrderIds ?? [])],
        ),
      }),
      receipt: {
        brokerOrderId: fact.brokerOrderId,
        authoritativeFactChanged: fact !== previous?.fact,
        executionAdvanced: fact.cumulativeQuantity > (previous?.fact.cumulativeQuantity ?? 0),
        economicProjectionChanged: false,
      },
    };
  }

  /** 所有已消费输入都由同 owner 保存；金额修订重跑原时序/低价优先整笔过滤。 */
  function projectSlices(
    facts: ReadonlyMap<string, OwnedExecutionFact>,
    symbol: string,
    isLongSymbol: boolean,
  ): ReadonlyArray<ProjectionSliceInput> {
    const inputs: ProjectionSliceInput[] = [];
    for (const [brokerOrderId, entry] of facts) {
      if (entry.fact.symbol !== symbol || entry.isLongSymbol !== isLongSymbol) continue;

      if (entry.fact.side === 'SELL') {
        const last = entry.projectionSlices.at(-1);
        if (last !== undefined) {
          // 消费证明可以分 delta，但整笔过滤必须只有一次 broker 累计 SELL 输入。
          inputs.push({
            brokerOrderId,
            entry,
            slice: { ...last, quantity: entry.economicQuantity },
          });
        }
      } else {
        for (const slice of entry.projectionSlices) inputs.push({ brokerOrderId, entry, slice });
      }
    }

    const record = (input: ProjectionSliceInput): OrderRecord =>
      Object.freeze({
        ...factToRecord(input.entry.fact),
        costAmount: proportionExecutionCost(
          input.entry.fact.cumulativeAmount,
          input.slice.quantity,
          input.entry.fact.cumulativeQuantity,
        ),
        executedQuantity: input.slice.quantity,
        executedTime: input.slice.executionTimeMs,
      });
    const inputByRecord = new Map(inputs.map((input) => [record(input), input]));
    const buyRecords: OrderRecord[] = [];
    const sellRecords: OrderRecord[] = [];
    for (const [order, input] of inputByRecord)
      (input.entry.fact.side === 'BUY' ? buyRecords : sellRecords).push(order);

    // 时间区间完全复用重建/Daily 原规则，不能按 Map 或同毫秒 BUY/SELL 到达顺序重算。
    const survivors = applyFilteringAlgorithm(buyRecords, sellRecords, (beforeSell, sell) => {
      const input = inputByRecord.get(sell);
      if (input === undefined) throw new Error('[订单记录] SELL 过滤缺少消费范围');

      const eligible = beforeSell.filter((buy) => {
        const buyInput = inputByRecord.get(buy);
        if (buyInput === undefined) throw new Error('[订单记录] BUY 过滤缺少消费范围');

        return (
          buyInput.slice.clearedAtSequence === null ||
          buyInput.slice.clearedAtSequence > input.slice.admittedSequence
        );
      });
      const grouped = new Map<string, OrderRecord>();
      for (const buy of eligible) {
        const previous = grouped.get(buy.orderId);
        const quantity = (previous?.executedQuantity ?? 0) + buy.executedQuantity;
        if (!Number.isSafeInteger(quantity)) throw new RangeError('[订单记录] 过滤范围数量越界');

        grouped.set(buy.orderId, {
          ...buy,
          executedQuantity: quantity,
          costAmount: exactAdd(previous?.costAmount ?? '0', buy.costAmount),
          executedTime: Math.max(previous?.executedTime ?? 0, buy.executedTime),
        });
      }

      const eligibleRecords = [...grouped.values()];
      if (sell.executedQuantity >= calculateTotalQuantity(eligibleRecords)) return [];

      const related = input.entry.relatedBuyOrderIds;
      if (related.length > 0) return eligible.filter((buy) => !related.includes(buy.orderId));

      const retained = new Set(
        deductSellQuantityFromBuyOrders(eligibleRecords, sell.executedQuantity).map(
          (survivor) => survivor.orderId,
        ),
      );
      return eligible.filter((buy) => retained.has(buy.orderId));
    });
    return survivors.flatMap((survivor) => {
      const input = inputByRecord.get(survivor);
      if (input === undefined) throw new Error('[订单记录] 幸存 BUY 缺少消费范围');

      return input.slice.clearedAtSequence === null ? [input] : [];
    });
  }

  /** survivor 展示列表按 broker ID 合并；成本依据始终是精确金额与安全数量。 */
  function projectRecords(
    facts: ReadonlyMap<string, OwnedExecutionFact>,
    symbol: string,
    isLongSymbol: boolean,
  ): ReadonlyArray<OrderRecord> {
    const records = new Map<string, OrderRecord>();
    for (const input of projectSlices(facts, symbol, isLongSymbol)) {
      const amount = proportionExecutionCost(
        input.entry.fact.cumulativeAmount,
        input.slice.quantity,
        input.entry.fact.cumulativeQuantity,
      );
      const previous = records.get(input.brokerOrderId);
      const quantity = (previous?.executedQuantity ?? 0) + input.slice.quantity;
      if (!Number.isSafeInteger(quantity)) throw new RangeError('[订单记录] 经济投影汇总越界');

      records.set(
        input.brokerOrderId,
        Object.freeze({
          ...factToRecord(input.entry.fact),
          costAmount: exactAdd(previous?.costAmount ?? '0', amount),
          executedQuantity: quantity,
          executedTime: Math.max(previous?.executedTime ?? 0, input.slice.executionTimeMs),
        }),
      );
    }

    return [...records.values()];
  }

  /** 所有预检先完成，再在无 await 段替换私有事实与经济列表。 */
  function commitExecutionFact(
    fact: BrokerOrderExecutionFact,
    isLongSymbol: boolean,
    relatedBuyOrderIds: ReadonlyArray<string>,
    beforeCommit: () => OrderExecutionAdmission,
  ): OrderFactCommitReceipt {
    const sequence = nextProjectionSequence();
    const previous = executionFacts.get(fact.brokerOrderId);
    const prepared = prepareExecutionCommit(
      fact,
      isLongSymbol,
      previous,
      relatedBuyOrderIds,
      sequence,
    );
    const staged = new Map(executionFacts);
    staged.set(fact.brokerOrderId, prepared.entry);
    const merged = prepared.entry.fact;
    const economicInputChanged =
      merged.cumulativeQuantity !== previous?.fact.cumulativeQuantity ||
      exactCompare(merged.cumulativeAmount, previous.fact.cumulativeAmount) !== 0 ||
      merged.executionTimeMs !== previous.fact.executionTimeMs ||
      merged.phase !== previous.fact.phase;
    const associationChanged =
      previous?.relatedBuyOrderIds.length !== prepared.entry.relatedBuyOrderIds.length ||
      previous.relatedBuyOrderIds.some(
        (id, index) => id !== prepared.entry.relatedBuyOrderIds[index],
      );
    // broker revision 水位不是经济变化；无需重算列表，也不制造新成交后的刷新需求。
    const next =
      economicInputChanged || associationChanged
        ? projectRecords(staged, fact.symbol, isLongSymbol)
        : storage.getBuyOrdersList(fact.symbol, isLongSymbol);
    const previousSell = storage.getSellRecordByOrderId(fact.brokerOrderId);
    const sell =
      prepared.entry.fact.side === 'SELL' && prepared.entry.economicQuantity > 0
        ? factToRecord(prepared.entry.fact)
        : null;
    const changed =
      projectionChanged(storage.getBuyOrdersList(fact.symbol, isLongSymbol), next) ||
      (sell !== null &&
        (previousSell?.executedQuantity !== sell.executedQuantity ||
          previousSell.executedTime !== sell.executedTime ||
          exactCompare(previousSell.costAmount, sell.costAmount) !== 0));
    // 经济覆盖不证明 durable/episode 义务已完成；纯重复也先经过同步准入与持久化。
    // 完整候选先成功，再同步准入/durable；封存抑制不写事实、覆盖、序列、列表或 stale。
    const admission: unknown = beforeCommit();
    if (admission === 'SUPPRESSED')
      return {
        brokerOrderId: fact.brokerOrderId,
        authoritativeFactChanged: false,
        executionAdvanced: false,
        economicProjectionChanged: false,
      };

    if (admission !== 'ADMITTED' && admission !== 'DUPLICATE')
      throw new Error('[订单记录] 缺少明确同步成交准入');

    if (!prepared.receipt.authoritativeFactChanged && !changed && !associationChanged)
      return { ...prepared.receipt, economicProjectionChanged: false };

    projectionSequence = sequence;
    executionFacts.set(fact.brokerOrderId, prepared.entry);
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

    return { ...prepared.receipt, economicProjectionChanged: changed };
  }

  /** 全 batch 归属/累计事实预检；controlled rebuild 才重建基线并放下旧 clear scope。 */
  function commitRebuildSnapshot(
    targets: ReadonlyArray<OrderProjectionTarget>,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
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
      classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === target.symbol));
    }

    const sequence = nextProjectionSequence();
    const staged = new Map(executionFacts);
    if (mode === 'REBUILD') {
      for (const [id, entry] of staged) {
        if (unique.has(entry.fact.symbol))
          staged.set(id, { ...entry, projectionSlices: [], relatedBuyOrderIds: [] });
      }
    }

    const receipts: OrderFactCommitReceipt[] = [];
    for (const order of allOrders) {
      const target = unique.get(order.symbol);
      if (target === undefined) continue;

      const prepared = prepareExecutionCommit(
        apiOrderToExecutionFact(order),
        target.isLongSymbol,
        staged.get(order.orderId),
        [],
        sequence,
      );
      const fact = prepared.entry.fact;
      let entry = prepared.entry;
      if (mode === 'REBUILD' && fact.phase === 'TERMINAL' && fact.cumulativeQuantity > 0) {
        const executionTimeMs = fact.executionTimeMs;
        if (executionTimeMs === null)
          throw new Error('[订单记录] rebuild execution lacks trusted time');

        entry = Object.freeze({
          ...prepared.entry,
          economicQuantity: fact.cumulativeQuantity,
          projectionSlices: Object.freeze([
            Object.freeze({
              quantity: fact.cumulativeQuantity,
              executionTimeMs,
              admittedSequence: sequence,
              clearedAtSequence: null,
            }),
          ]),
        });
      }

      staged.set(order.orderId, entry);
      receipts.push(prepared.receipt);
    }

    const lists = [...unique.values()].map((target) => ({
      target,
      next: projectRecords(staged, target.symbol, target.isLongSymbol),
    }));
    if (!isCurrent()) return { status: 'ABORTED' };

    const changedSymbols = new Set(
      lists
        .filter(({ target, next }) =>
          projectionChanged(storage.getBuyOrdersList(target.symbol, target.isLongSymbol), next),
        )
        .map(({ target }) => target.symbol),
    );
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
    return {
      status: 'COMMITTED',
      receipts: receipts.map((receipt) => {
        const entry = staged.get(receipt.brokerOrderId);
        if (entry === undefined)
          throw new Error('[订单记录] published receipt lacks staged broker identity');

        return { ...receipt, economicProjectionChanged: changedSymbols.has(entry.fact.symbol) };
      }),
    };
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
    fetchAllOrdersFromAPI: async () =>
      withTrustedOrderExecutionTimes(await apiManager.fetchAllOrdersFromAPI(), [
        ...deps.getExecutionTimeEvidence(),
        ...[...executionFacts.values()]
          .filter((entry) => entry.fact.executionTimeMs !== null)
          .map(({ fact }) => {
            const executionTimeMs = fact.executionTimeMs;
            if (executionTimeMs === null)
              throw new Error('[订单记录] selected execution evidence lacks trusted time');

            return {
              brokerOrderId: fact.brokerOrderId,
              symbol: fact.symbol,
              side: fact.side,
              cumulativeQuantity: fact.cumulativeQuantity,
              cumulativeAmount: fact.cumulativeAmount,
              lastExecutionTimeMs: executionTimeMs,
              orderRevisionMs: fact.updatedAtMs,
              phase: fact.phase,
            };
          }),
      ]),
    validateRebuildSnapshot: (symbol, allOrders) => {
      classifyOrdersForRebuild(allOrders.filter((order) => order.symbol === symbol));
    },
    getBuyOrdersForSymbol: storage.getBuyOrdersList,
    submitSellOrder: (
      orderId,
      symbol,
      direction,
      quantity,
      relatedBuyOrderIds,
      isProtectiveLiquidation,
      submittedAtMs,
    ) => {
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
        isProtectiveLiquidation,
        submittedAt: submittedAtMs,
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
  logger.debug('[订单记录] 创建唯一 broker fact owner');
  return createOrderRecorderFromParts({
    storage: createOrderStorage(),
    apiManager: createOrderAPIManager(deps),
    getExecutionTimeEvidence: deps.getExecutionTimeEvidence,
    settlementRefreshNeedRecorder: deps.settlementRefreshNeedRecorder,
  });
}

/** 日损益使用相同归属和整笔过滤纯规则，不引入第二订单事实 owner。 */
export function createDailyLossOrderAnalysisDeps(): OrderDailyLossAnalysisDeps {
  return {
    filteringEngine: { applyFilteringAlgorithm },
    resolveOrderOwnership,
    classifyAndConvertOrders,
  };
}
