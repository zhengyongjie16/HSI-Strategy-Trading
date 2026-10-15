/** 订单经济投影纯规则：同 broker ID 的消费覆盖、成本和整笔抵扣候选；不提交账本或 stale。 */
import { exactAdd, exactCompare } from '../../utils/numeric/exact.js';
import type { BrokerOrderExecutionFact } from '../../types/orderRecorder.js';
import type { OrderRecord } from '../../types/services.js';
import type { OrderFact } from '../../types/trade.js';
import type { OwnedExecutionFact, PreparedExecutionCommit, ProjectionSliceInput } from './types.js';
import { applyFilteringAlgorithm } from './orderFilteringEngine.js';
import { calculateTotalQuantity } from './orderQuantity.js';
import { proportionExecutionCost } from './orderRecordPolicy.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';
import { mergeBrokerOrderExecutionFact } from './executionFact.js';

/** 将已映射 API 事实交给相同累计事实裁决，不由 revision 回填可信执行时间。 */
export function apiOrderToExecutionFact(order: OrderFact): BrokerOrderExecutionFact {
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
export function factToRecord(fact: BrokerOrderExecutionFact): OrderRecord {
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
export function projectionChanged(
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

/** 准入与消费范围分别计算；OPEN partial 只更新权威事实，终态新增量才建立经济 slice。 */
export function prepareExecutionCommit(
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
export function projectSlices(
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
export function projectRecords(
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
