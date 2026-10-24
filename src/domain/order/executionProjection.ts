/** 订单经济投影纯规则：同 broker ID 的消费覆盖、成本和整笔抵扣候选；不提交账本或 stale。 */
import { exactAdd, exactCompare } from '../../utils/numeric/exact.js';
import type { BrokerOrderExecutionFact, OrderRecord } from '../../types/orderRecorder.js';

import type { OrderFact } from '../../types/trade.js';
import type { OwnedExecutionFact, ProjectionSliceInput } from './types.js';
import { applyFilteringAlgorithm } from './orderFilteringEngine.js';
import { calculateTotalQuantity } from './orderQuantity.js';
import { proportionExecutionCost } from './orderRecordPolicy.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';
import { mergeBrokerOrderExecutionFact } from './executionFact.js';

/** 将已映射 API 事实交给同一累计事实裁决；T 沿用订单驱动代理，不在此另造时间。 */
export function apiOrderToExecutionFact(order: OrderFact): BrokerOrderExecutionFact {
  if (!['BUY', 'SELL'].includes(order.executionSide)) {
    throw new Error('[订单记录] API 订单方向不可归属');
  }

  return {
    brokerOrderId: order.orderId,
    symbol: order.symbol,
    side: order.executionSide,
    cumulativeQuantity: order.executedQuantity,
    cumulativeAmount: order.executedAmount ?? '0',
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
  origin: ProjectionSliceInput['slice']['origin'],
): OwnedExecutionFact {
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
        origin,
        clearedAtSequence: null,
      }),
    ];
  }

  return Object.freeze({
    fact,
    isLongSymbol,
    economicQuantity: terminal ? fact.cumulativeQuantity : economicQuantity,
    projectionSlices: Object.freeze(slices),
    relatedBuyOrderIds: Object.freeze(
      economicQuantity === 0 && relatedBuyOrderIds.length > 0
        ? [...relatedBuyOrderIds]
        : [...(previous?.relatedBuyOrderIds ?? [])],
    ),
  });
}

/** 单次整笔扣减保持候选展示顺序；精确金额/时间/ID 优先级由共用策略裁决。 */
function deductProjectionCandidates(
  buys: ReadonlyArray<OrderRecord>,
  sell: OrderRecord,
): ReadonlyArray<OrderRecord> {
  if (sell.executedQuantity >= calculateTotalQuantity(buys)) return [];

  const retained = new Set(
    deductSellQuantityFromBuyOrders(buys, sell.executedQuantity).map((buy) => buy.orderId),
  );
  return buys.filter((buy) => retained.has(buy.orderId));
}

/**
 * 按成功经济准入位置逐 SELL 重放，只从当前 live ranges 聚合完整 BUY 身份。
 * 精确关联先于任何时间/总量分区；非关联 SELL 的历史 ONLINE slices 只证明截止序列内的有效范围。
 * 每次消费立即映回原 range 引用，不从历史 batch 初始候选或已失效 range 回填。
 */
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

  const batches = new Map<number, ProjectionSliceInput[]>();
  for (const input of inputs) {
    const sequence = input.slice.admittedSequence;
    const batch = batches.get(sequence);
    if (batch === undefined) batches.set(sequence, [input]);
    else batch.push(input);
  }

  let survivors: ReadonlyArray<ProjectionSliceInput> = [];
  for (const [sequence, batch] of [...batches].sort(([left], [right]) => left - right)) {
    const buys: ProjectionSliceInput[] = [];
    const historySells: ProjectionSliceInput[] = [];
    const onlineSells: ProjectionSliceInput[] = [];
    for (const input of batch) {
      if (input.entry.fact.side === 'BUY') buys.push(input);
      else if (input.slice.origin === 'HISTORY') historySells.push(input);
      else onlineSells.push(input);
    }

    historySells.sort((left, right) => left.slice.executionTimeMs - right.slice.executionTimeMs);
    let lastHistoricalFilter: ProjectionSliceInput | undefined;
    for (const input of historySells) {
      if (input.entry.relatedBuyOrderIds.length === 0) lastHistoricalFilter = input;
    }

    survivors = [...survivors, ...buys].filter(
      ({ slice }) => slice.clearedAtSequence === null || slice.clearedAtSequence > sequence,
    );

    for (const input of [...historySells, ...onlineSells]) {
      const related = input.entry.relatedBuyOrderIds;
      if (related.length > 0) {
        // settlement 已证明的选择不可重新匹配；关联范围不存在也不得 fallback 普通扣减。
        survivors = survivors.filter(({ brokerOrderId }) => !related.includes(brokerOrderId));
        continue;
      }

      const sell = {
        ...factToRecord(input.entry.fact),
        executedQuantity: input.slice.quantity,
        executedTime: input.slice.executionTimeMs,
      };
      const records = aggregateBuySlices(survivors);
      let onlineCut = 0;
      for (const slice of input.entry.projectionSlices) {
        if (slice.origin === 'ONLINE') onlineCut = Math.max(onlineCut, slice.admittedSequence);
      }

      // 来源只能在完整身份聚合后判定；证据必须属于此刻仍有效的 range，而非历史上的同 ID。
      const onlineIds = new Set(
        survivors
          .filter(({ slice }) => slice.origin === 'ONLINE' || slice.admittedSequence <= onlineCut)
          .map(({ brokerOrderId }) => brokerOrderId),
      );
      const historicalBuys = records.filter((buy) => !onlineIds.has(buy.orderId));
      let onlineRemaining = records.filter((buy) => onlineIds.has(buy.orderId));
      let historicalRemaining = applyFilteringAlgorithm(historicalBuys, [sell], (beforeSell) => {
        const retained = deductProjectionCandidates([...beforeSell, ...onlineRemaining], sell);
        onlineRemaining = retained.filter((buy) => onlineIds.has(buy.orderId));
        return retained.filter((buy) => !onlineIds.has(buy.orderId));
      });
      if (input.slice.origin === 'HISTORY' && input !== lastHistoricalFilter) {
        // 历史批次中先保留旧候选、再追加未来区间；最后一轮才将 M0 放到最前，保持旧展示次序。
        historicalRemaining = [
          ...historicalRemaining.filter((buy) => buy.executedTime < sell.executedTime),
          ...historicalRemaining.filter((buy) => buy.executedTime > sell.executedTime),
        ];
      }

      const retained = new Map<string, ProjectionSliceInput[]>(
        [...historicalRemaining, ...onlineRemaining].map((buy) => [buy.orderId, []]),
      );
      for (const live of survivors) retained.get(live.brokerOrderId)?.push(live);

      survivors = [...retained.values()].flat();
    }
  }

  return survivors.filter(({ slice }) => slice.clearedAtSequence === null);
}

/** 过滤和展示使用同一个 broker identity 聚合；仅合并传入的有效范围，不扩展消费资格。 */
function aggregateBuySlices(
  inputs: ReadonlyArray<ProjectionSliceInput>,
): ReadonlyArray<OrderRecord> {
  const records = new Map<string, OrderRecord>();
  for (const input of inputs) {
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

/** survivor 展示列表按 broker ID 合并；成本依据始终是精确金额与安全数量。 */
export function projectRecords(
  facts: ReadonlyMap<string, OwnedExecutionFact>,
  symbol: string,
  isLongSymbol: boolean,
): ReadonlyArray<OrderRecord> {
  return aggregateBuySlices(projectSlices(facts, symbol, isLongSymbol));
}
