# 订单监控 state-check 事故修复：精确实现规格

- **依据**：`docs/issues/2026-08/2026-08-04-order-monitor-state-check-incident-first-principles-analysis.md`（下称“事故分析”）
- **适用范围**：仅实现事故分析第 4 节三项 P0 的最小修复（4.1 / 4.2 / 4.3）与第 4.4 节要求的定向测试；不触碰事故分析第 5.2 节列出的任何禁止范围
- **代码快照**：`develop@460feec256143f4aa12916616f5299f995b58fd8`（SDK `longbridge@4.4.3`）
- **状态**：实现规格（待编码）

---

## 0. 总览

| P0 | 目标 | 主修改文件 | 消费/受影响文件 |
| --- | --- | --- | --- |
| P0-1 | Filled state-check 从 history 提取无歧义当前 Filled 发生时间，作为本地单调账务时间来源 | `orderStatusQuery.ts`、`src/types/trader.ts`、`orderFactMerge.ts` | `orderOps.ts`（仅注释）、`routeProcessor.ts`（仅注释）、`index.ts`（仅注释）、`utils.ts`（新增小助手） |
| P0-2 | route timer 投影互斥，消灭 0ms 自循环 | `routeRuntime.ts`（`resolveCancelRetrySchedule` / `resolveTimeoutSchedule`） | 无（`routeProcessor.canAttemptTimeoutHandling` 等语义保持不变） |
| P0-3 | route 失败后不再 dirty rerun、timer 不复活、fatal 只上报一次；4.4 微任务窗口关闭 | `routeRuntime.ts`（`runRoute` 失败路径、`launchRouteProcessing` 注册顺序） | 无 |

**设计总原则（继承事故分析）**：不是放宽 raw-fact gate，而是让 adapter 忠实表达已存在且可验证的 broker 终态事实；让 timer 与 fatal 生命周期不再制造额外业务推进。

---

## 1. P0-1：Filled state-check 的 history evidence extraction

### 1.1 目标行为

对本次已证实形态（`TERMINAL + Filled`、顶层 `updatedAt` 无效、history 中恰有一条与顶层成交数量/价格精确一致、时间为有效正有限 Date 的 Filled 记录）：

- `OrderStateCheckResult` TERMINAL 分支新增字段承载该发生时间；
- 下游 `orderFactMerge` 在“累计成交数量推进”时把它解析为原始 revision 时间（与 `orderUpdatedAtMs` 同语义：本地执行账务时间的派生来源，而非交易所逐笔成交时间）；
- 证据不足（缺失/损坏/冲突/不匹配）时保持 fail-closed：字段为 `null`，下游继续抛出现有异常；
- 顶层 `updatedAt` 有效时，行为与现状完全一致。

### 1.2 类型变更：新增 `filledHistoryTimeMs: number | null`

在 `src/types/trader.ts` 的 `OrderStateCheckResult` TERMINAL 分支新增：

```ts
| {
    readonly kind: 'TERMINAL';
    readonly closedReason: OrderClosedReason;
    readonly executedPrice: number | null;
    readonly executedQuantity: number | null;
    readonly submittedQuantity: number | null;
    /** SDK `updatedAt`（Last updated）映射的经纪商观察/revision 时间；……（原注释保留） */
    readonly orderUpdatedAtMs: number | null;
    /**
     * 仅当 closedReason === 'FILLED' 且顶层 updatedAt 无效时，从 history 提取的
     * “无歧义当前 Filled 发生/排序时间”（毫秒）。它是本地单调事实模型所需的发生/排序时间，
     * 与 orderUpdatedAtMs 承担同一账务时间用途；绝不得解释为交易所逐笔成交时间，
     * 也绝不伪造成顶层 updatedAt 的原始值。顶层 updatedAt 有效或证据不满足窄规则时为 null。
     */
    readonly filledHistoryTimeMs: number | null;
    readonly status: OrderStatus;
  }
```

**字段名论证**（为何用 `filledHistoryTimeMs` 而非事故分析 3.3 复现输出中的 `historyTimeMs`）：

1. **语义精确性**：本字段只允许承载“Filled history 证据提取出的时间”。`historyTimeMs` 暗示“任意 history 条目的时间”，容易被未来实现误用为 `history.at(-1)?.time` 之类的通配回退（这正是 4.1 明确禁止的）。`filledHistoryTimeMs` 把“仅 Filled、仅无歧义匹配”写进字段名，编译期与代码审查都能防回归。
2. **命名一致性**：现有 TERMINAL 分支已有 `orderUpdatedAtMs`、OPEN 分支已有 `updatedAtMs`，均以 `Ms` 结尾表示毫秒；`filledHistoryTimeMs` 沿用该惯例。
3. **文档对齐**：事故分析 3.3 的 `historyTimeMs` 是内存复现输出的临时标签而非已提交 API 名，本规格不承担兼容义务；测试断言以本字段语义（`filledHistoryTimeMs`）为准。
4. **禁止性自解释**：字段名中的 `filled` 排除了为 Canceled/Rejected/OPEN 提取 history 的扩展空间（5.2 禁止项 2）。

**不变式**：`filledHistoryTimeMs !== null` 蕴含 `closedReason === 'FILLED' && orderUpdatedAtMs === null`（由 1.3 提取规则保证）。因此下游 `??` 解析是安全的。

### 1.3 orderStatusQuery 提取规则（窄规则，严格按事故分析 4.1）

**入口门控**（`checkOrderState` 内，TERMINAL 分支构造处）：

```ts
const updatedAtMs = resolveUpdatedAtMs(detail.updatedAt);
const closedReason = resolveClosedReasonFromStatus(status);
if (closedReason !== null) {
  return {
    kind: 'TERMINAL',
    closedReason,
    status,
    executedPrice,
    executedQuantity,
    submittedQuantity,
    orderUpdatedAtMs: updatedAtMs, // 顶层派生值，原样保留
    filledHistoryTimeMs:
      closedReason === 'FILLED' && updatedAtMs === null
        ? resolveFilledHistoryTimeMs(detail) // 仅此路径才读 history
        : null,
  };
}
```

**提取函数**（`orderStatusQuery.ts` 模块内私有；建议放在 `resolveClosedReasonFromStatus` 之后）：

```ts
/** 运行时边界防御：SDK 类型是 Decimal，但运行时可能被损坏（测试用 Reflect.set 模拟）。 */
function isDecimalLike(value: unknown): value is { equals(other: unknown): boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { equals?: unknown }).equals === 'function'
  );
}

/**
 * 仅接受无歧义的当前 Filled history 证据，返回其发生时间（毫秒）；否则 null（fail-closed）。
 * 规则（事故分析 4.1）：
 * 1. detail.history 必须是数组（缺失/非数组/空数组 => null）
 * 2. 候选条目必须：status === OrderStatus.Filled；time 是有效正有限 Date；
 *    quantity/price 是 Decimal-like，且分别与 detail.executedQuantity/detail.executedPrice
 *    精确相等（Decimal.equals，不能退化为 number 比较）
 * 3. 多个候选的时间去重后恰好为一个值 => 接受；否则（0 个或时间不同的多个）=> null
 * 4. 不按数组顺序、不取最大时间、不做任何回填推断
 */
function resolveFilledHistoryTimeMs(detail: OrderDetail): number | null {
  if (!Array.isArray(detail.history)) {
    return null;
  }

  const candidateTimes = new Set<number>();
  for (const entry of detail.history) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.status !== OrderStatus.Filled) continue;

    const timeMs = resolveOccurrenceTimeMs(entry.time); // 有效正有限 Date
    if (timeMs === null) continue;

    if (!isDecimalLike(entry.quantity) || !isDecimalLike(entry.price)) continue;
    if (!isDecimalLike(detail.executedQuantity)) continue;
    if (detail.executedPrice === null || !isDecimalLike(detail.executedPrice)) continue;
    if (!detail.executedQuantity.equals(entry.quantity)) continue;
    if (!detail.executedPrice.equals(entry.price)) continue;

    candidateTimes.add(timeMs);
  }

  return candidateTimes.size === 1 ? (candidateTimes.values().next().value ?? null) : null;
}
```

**配套小助手**（`orderMonitor/utils.ts` 新增导出，不动 `resolveUpdatedAtMs`/`resolveTimeMs`）：

```ts
/**
 * 解析 history 条目的发生时间为毫秒时间戳。
 * 与 resolveTimeMs 同规则（Date 实例 + 正有限），但入参放宽为 unknown 以防御 SDK 运行时损坏。
 */
export function resolveOccurrenceTimeMs(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const timeMs = value.getTime();
  return Number.isFinite(timeMs) && timeMs > 0 ? timeMs : null;
}
```

**运行时边界处理清单**（现状测试用 `Reflect.set` 模拟损坏字段，新测试沿用）：

| 边界 | 行为 |
| --- | --- |
| `detail.history` 缺失（`undefined`）/ `null` / 非数组 / 空数组 | `Array.isArray` 守卫 → `null`（fail-closed） |
| 条目为 `null` 或非对象 | 跳过该条目（不构成候选，也不构成拒绝） |
| `entry.time` 非 Date / NaN / 0 / 负值 | 跳过该条目 |
| `entry.status !== OrderStatus.Filled` | 跳过（Cancelled/Rejected 等不参与） |
| `entry.quantity/price` 非 Decimal-like（如 number/string） | 跳过（不匹配，fail-closed） |
| `detail.executedQuantity` 非 Decimal-like 或 `detail.executedPrice === null` | 无候选 → `null` |
| 数量/价格任一不精确相等（Decimal.equals 为 false） | 跳过 |
| 多个候选时间不同 | 拒绝 → `null`（fail-closed） |
| 多个候选时间相同（同事件重复行） | 接受（去重后单一时间） |

> 说明：损坏条目只被“排除在候选之外”；歧义只来自“多个都完全匹配但时间不同”的候选，与事故分析 4.1 第 3 条一致。非 Filled 状态条目即使 time 有效也一律不参与。

### 1.4 orderFactMerge 消费点设计

三处消费点的核心改动：把“本次原始 revision 时间”从 `orderUpdatedAtMs` 解析改为 `orderUpdatedAtMs ?? filledHistoryTimeMs`。由于 `filledHistoryTimeMs` 只在 `Filled + 顶层 updatedAt 无效` 时非 null，`??` 对既有路径是严格幂等扩展。

**(a) `assertStateCheckRawExecutionFactsReady`**（`orderFactMerge.ts`）：

```ts
const rawUpdatedAtMs =
  stateCheckResult.kind === 'OPEN'
    ? stateCheckResult.updatedAtMs
    : (stateCheckResult.orderUpdatedAtMs ?? stateCheckResult.filledHistoryTimeMs);
```

- 后续 `!isValidPositiveFactNumber(rawUpdatedAtMs)` 抛错与 `rawUpdatedAtMs < knownUpdatedAtMs` 单调校验保持不变；
- **history 时间倒退时 fail-closed**：若 `filledHistoryTimeMs < trackedOrder.lastOrderUpdateAtMs`，命中现有“broker revision 倒退”异常，符合事故分析 4.1 第 5 条。

**(b) `assertProtectiveSellRawTerminalStateFactsReady`**（`orderFactMerge.ts`）：

函数顶部解析一次，两处 `assertProtectiveSellRawObservationFactsReady` 调用共用：

```ts
const resolvedOrderUpdatedAtMs =
  terminalState.orderUpdatedAtMs ?? terminalState.filledHistoryTimeMs;
```

（原两处 `executedTimeMs: terminalState.orderUpdatedAtMs, updatedAtMs: terminalState.orderUpdatedAtMs` 均改为 `resolvedOrderUpdatedAtMs`。）

**(c) `normalizeTerminalStateSnapshot`**（`orderFactMerge.ts`）：

```ts
const resolvedOrderUpdatedAtMs =
  terminalState.orderUpdatedAtMs ?? terminalState.filledHistoryTimeMs;
const observedFact = {
  status: terminalState.status,
  executedQuantity: terminalState.executedQuantity,
  executedPrice: terminalState.executedPrice,
  executedTimeMs: resolvedOrderUpdatedAtMs,
  updatedAtMs: resolvedOrderUpdatedAtMs,
};
```

- `executedTimeMs <= updatedAtMs` 校验在两者相等时自然通过（`mergeMonotonicOrderFact` → `assertRawExecutionAdvanceFactsReady` 中的 `observedFact.executedTimeMs > observedFact.updatedAtMs` 为 false）；
- 返回值 `orderUpdatedAtMs: mergedFact.updatedAtMs` 已由合并逻辑写入解析值，无需改动；
- `...terminalState` 展开会把 `filledHistoryTimeMs` 透传到 `NormalizedTerminalStateSnapshot`，无下游消费，无害。

### 1.5 为什么不需要改其他文件（类型扩展自动透传论证）

| 文件/函数 | 现状对 TERMINAL 快照的使用 | 是否需要改 |
| --- | --- | --- |
| `orderOps.ts` `mapStateCheckResultToCancelOutcome` / `setReplaceTerminal` | 整个 `queryResult` 存入 `queriedTerminalStateByOrderId` / `latestReplaceTerminalByOrderId`（Map 值类型 `TerminalStateSnapshot`），只读 `submittedQuantity/executedQuantity/closedReason` | 否（类型自动扩展；仅注释） |
| `orderOps.ts` `cancelOrder` / `handleReplaceTempBlockedByStatus` / `replaceOrderPriceWithRunner` | 先调 `assertStateCheckRawExecutionFactsReady`（已改），再存快照；不直接读 `orderUpdatedAtMs` | 否（仅注释） |
| `routeProcessor.ts` `resolveTerminalSettlementInput` / `settlePendingReplaceTerminal` | `peek` 快照 → 两个已改函数 → `normalizeTerminalStateSnapshot` 输出 `executedTimeMs/orderUpdatedAtMs` | 否（仅注释） |
| `routeProcessor.ts` `settleBuyOrderTimeoutTerminal` / `handleSellOrderTimeout` | 消费 `resolveTerminalSettlementInput` 的归一化输出 | 否 |
| `index.ts` `settleActiveTerminalFromRaw` / `cancelAndSettle` / `replaceOrderPriceWithPermit` | `peek` 快照 → 两个已改函数；只读 `submittedQuantity/executedQuantity` | 否（仅注释） |
| `eventFlow.ts` | 只消费 WS `PushOrderChanged`，从不接收 `OrderStateCheckResult` | 否（零改动） |
| `settlementFlow.ts` | 只接收已归一化的 `FinalizeOrderSettlementParams`（number） | 否 |
| `types.ts` `TerminalStateSnapshot` | `Extract<OrderStateCheckResult, {kind:'TERMINAL'}>`，字段自动透传 | 否（可加一行注释） |

**需要更新注释的位置**（语义说明，无逻辑变化）：

1. `orderStatusQuery.ts`：文件头注释（“只读取 updatedAt”改为“updatedAt 无效时按窄规则消费 Filled history”）；`checkOrderState` JSDoc；新增提取函数注释。
2. `orderFactMerge.ts`：`assertStateCheckRawExecutionFactsReady`、`assertProtectiveSellRawTerminalStateFactsReady`、`normalizeTerminalStateSnapshot` 三处“SDK 仅提供 updatedAt”的注释改为“SDK 提供 updatedAt；当 Filled 且 updatedAt 无效时可由无歧义 Filled history 发生时间承担同一单调排序用途（`filledHistoryTimeMs`），两者都不得解释为交易所成交时间，也不得由 tracked/时钟补造”。
3. `orderOps.ts` / `routeProcessor.ts` / `index.ts`：在缓存 `TerminalStateSnapshot` 的注释处补充“快照可能携带 `filledHistoryTimeMs`，消费统一走 orderFactMerge 解析”。
4. `src/types/trader.ts`：新字段 JSDoc（见 1.2）。

### 1.6 禁止事项确认（事故分析 4.1，逐一排除）

| # | 禁止项 | 本设计的排除方式 |
| --- | --- | --- |
| 1 | `Date.now()` 补时间 | 提取只接受 history 中可验证的 Date；无任何时钟来源 |
| 2 | `submittedAt` 补时间 | 提取完全不接触 `detail.submittedAt` |
| 3 | 旧 tracked 时间补时间 | 提取/解析不读取 tracked 字段（单调校验只做拒绝不做回填） |
| 4 | 零值或任意 history 条目补时间 | 只接受“状态 Filled + 时间有效 + 数量/价格与顶层精确一致”的候选；零值 Date 被 `resolveOccurrenceTimeMs` 拒绝 |
| 5 | `updatedAt ?? history.at(-1)?.time` | 明确不实现；仅在 `updatedAt === null` 且 `closedReason === 'FILLED'` 时才读取 history，且不取末位、不按顺序 |
| 6 | 按数组顺序/最大时间/不匹配状态推断 | 候选去重按精确时间值；非 Filled 条目一律排除；时间不同的多个候选拒绝 |
| 7 | 用 history 回填顶层成交价格/数量 | 提取只产出时间；`executedPrice/executedQuantity` 仍只来自顶层 `decimalToNumber`，本改动不触碰 |
| 8 | 让 OPEN/部分成交/Canceled/Rejected 在缺 revision 时放行 | 门控 `closedReason === 'FILLED'`；其余终态与全部 OPEN 路径行为不变（仍 fail-closed） |
| 9 | 把 601011 错误文字直接解释为已撤销 | 不在本改动范围；`orderOps` 仍以 601011 触发 `checkOrderState` 权威确认，状态以 status 码为准 |

---

## 2. P0-2：route timer 投影互斥

### 2.1 目标行为与 owner 表格（事故分析 4.2）

| tracked 状态 | 唯一允许的 timer owner | 实现 |
| --- | --- | --- |
| 尚未到首次 timeout（含新挂单 `cancelRetryCount=0`） | `BUY_TIMEOUT` / `SELL_TIMEOUT` at `submittedAt + timeoutMs` | `resolveTimeoutSchedule`（现有）+ `resolveCancelRetrySchedule` 新增 `cancelRetryCount > 0` 门控 |
| 已产生 retry backoff（`cancelRetryCount > 0`） | `CANCEL_RETRY` at `nextCancelAttemptAt` | `resolveTimeoutSchedule` 新增拒绝；`resolveCancelRetrySchedule` 现有逻辑（配合新门控） |
| 已确认 cancel request、等待 WS 终态（`nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS`） | 无（WS 事件驱动） | `resolveTimeoutSchedule` 新增 sentinel 拒绝；`resolveCancelRetrySchedule` 现有 sentinel 拒绝 |
| 已结算 / 已脱离 tracking | 无 | 不变（无 tracked order 即无投影） |

### 2.2 `resolveCancelRetrySchedule`：新增 `cancelRetryCount > 0` 条件

```ts
function resolveCancelRetrySchedule(order: OrderMonitorTrackedOrder): RouteTimerSchedule | null {
  const remainingQuantity = order.submittedQuantity - order.executedQuantity;
  if (remainingQuantity <= 0) {
    return null;
  }

  // 新增：尚未产生 retry backoff 时，撤单动作尚未被发起过（或已被 WS 复位），
  // CANCEL_RETRY 不得投影；此时唯一合法 owner 是首次 timeout（resolveTimeoutSchedule）。
  // 这消除了新挂单 nextCancelAttemptAt=now 时反复注册 0ms CANCEL_RETRY 的自循环。
  if (order.cancelRetryCount <= 0) {
    return null;
  }

  if (
    !Number.isFinite(order.nextCancelAttemptAt) ||
    order.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS
  ) {
    return null;
  }

  return {
    key: `${order.orderId}:CANCEL_RETRY`,
    atMs: order.nextCancelAttemptAt,
  };
}
```

**论证**：

- `cancelRetryCount` 由 `routeProcessor.applyCancelRetryBackoff` 单调递增（每次撤单 retryable 失败 +1），由 `resetCancelRetry`（结算成功收口）/ `pauseCancelRetryAndWaitWs`（等待 WS）归零。因此 `> 0` 精确表达“已产生 retry backoff”，与事故分析 owner 表格第二行一一对应。
- 新挂单 `trackOrder` 初始化 `nextCancelAttemptAt = now, cancelRetryCount = 0`：新条件直接拒绝投影 → 不再产生 `TIMER@now` 自循环；首次 timeout owner 仍由 `resolveTimeoutSchedule` 投影。
- `eventFlow` 在 WS 显示状态离开 `WaitToCancel/PendingCancel` 时执行 `cancelRetryCount = 0; nextCancelAttemptAt = now`：此后 CANCEL_RETRY 不投影，但若 timeout 已过，`resolveTimeoutSchedule` 投影过期 timeout → 一次性 0ms 收敛 → 重新发起撤单。这是“WS 推进后恢复撤单机会”的合法一次性收敛（见 2.4 论证），不是自循环。
- timeout 配置禁用且 `cancelRetryCount = 0` 时无任何 timer：正确——尚无撤单意图，不该有空转唤醒。

### 2.3 `resolveTimeoutSchedule`：两个新增拒绝条件

```ts
function resolveTimeoutSchedule(
  order: OrderMonitorTrackedOrder,
  config: OrderMonitorConfig,
): RouteTimerSchedule | null {
  if (order.convertedToMarket || order.orderType === OrderType.MO) {
    return null;
  }

  const timeoutConfig = order.side === OrderSide.Buy ? config.buyTimeout : config.sellTimeout;
  if (!timeoutConfig.enabled) {
    return null;
  }

  // 新增 (a)：撤单请求已确认、正在等待 WS 终态（或已进入 timeout->MO 等待态），
  // 唯一 owner 是 WS；不得把早已过期的固定 timeout 重新投影为 0ms timer。
  if (order.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS) {
    return null;
  }

  // 新增 (b)：已产生 retry backoff 时，唯一 owner 是 CANCEL_RETRY（resolveCancelRetrySchedule）；
  // timeout 不得与它并存，避免过期 timeout 造成 0ms 自循环。
  if (order.cancelRetryCount > 0) {
    return null;
  }

  const atMs = order.submittedAt + timeoutConfig.timeoutMs;
  if (!Number.isFinite(atMs)) {
    return null;
  }

  return {
    key: `${order.orderId}:${resolveTimeoutTimerKind(order.side)}`,
    atMs,
  };
}
```

### 2.4 与 `canAttemptTimeoutHandling` 语义兼容性论证（事故分析 4.2 要求）

`routeProcessor.canAttemptTimeoutHandling(order, now)` 现有逻辑：

```ts
if (isClosedStatus(order.status) && !canHandleClosedTimeoutRoute(order)) return false;
if (canHandleClosedTimeoutRoute(order)) return true;
if (order.nextCancelAttemptAt > now) return false;
const remainingQuantity = order.submittedQuantity - order.executedQuantity;
return remainingQuantity > 0;
```

逐一核对新投影下“timeout 已过且可消费”仍可达：

1. **新挂单（count=0、nextCancelAttemptAt=now）**：投影 `BUY_TIMEOUT@submittedAt+timeout`。未到点 → 到时触发 `TIMER` wakeup → `shouldHandleTimeout` 为 true → 消费 timeout（撤单/结算）。到点前无 CANCEL_RETRY 干扰。✅
2. **timeout 已过但无任何 timer 的场景（count>0 或 sentinel）**：此时 route 仍可由 `RECOVERED`（start bootstrap）、`TRACKED`（新订单）、`ORDER_EVENT`（WS）、`QUOTE`（行情）wakeup 唤醒；`handleBuyOrderTimeout`/`handleSellOrderTimeout` 内部仍按 `canAttemptTimeoutHandling` 推进（`nextCancelAttemptAt <= now` 且剩余量 > 0 时执行撤单）。timer 投影只是“不再为空转注册 0ms”，不改变 wakeup 到达后的消费语义。✅
3. **一次性 0ms 收敛场景**：WS 复位（count=0、`nextCancelAttemptAt=now`）后 timeout 已过 → `resolveTimeoutSchedule` 投影过期 timeout → `scheduleBoundedOneShotAt` 以 `delayMs=0` 触发一次 `TIMER` → 消费后状态必然变化（backoff → future CANCEL_RETRY；或 sentinel → 无 timer；或终态结算 → 脱离 tracking），因此至多一次 0ms 收敛，不会自循环。✅
4. **`timeoutMarketConversionPending`**：`markTimeoutMarketConversionPending` 调 `pauseCancelRetryAndWaitWs` 置 sentinel → 新条件 (a) 使其不再投影 timeout；其终态推进由 WS `ORDER_EVENT` 显式唤醒（eventFlow 写入 `timeoutMarketConversionTerminalState` 后 `triggerRoute`），`canHandleClosedTimeoutRoute` 为 true 时 `canAttemptTimeoutHandling` 直接放行。✅
5. **replace WAIT_WS_ONLY**：`isWaitWsOnlyReplaceMode` 只影响 `replaceBlockedUntilAt`（sentinel），与 `nextCancelAttemptAt` 无关；`canEnterReplaceFlow` 中的 `nextCancelAttemptAt === WAIT_WS_ONLY` 检查与 `resolveReplaceRetrySchedule` 均不受本改动影响。✅

### 2.5 保持现状的投影

- `resolveReplaceRetrySchedule`：不变（`TEMP_BLOCKED_BY_STATUS` + 有限 + 非 sentinel → `REPLACE_RETRY`；WAIT_WS_ONLY 时 sentinel 已拒绝）。
- `resolveQuoteRetrySchedule`：不变（`quoteRetryNextAt` 有限 → `QUOTE_RETRY`）。
- 不新增 poller / queue / timer 类型 / retry policy（5.2 禁止项 4）。

---

## 3. P0-3：route 失败后不再 dirty rerun

### 3.1 目标行为

- `processRoute` 抛错时：不执行 `reconcileRouteTimers`、不启动 dirty rerun；
- 清除本 generation 的 timer（`clearRouteTimers`）与 dirty / `pendingWakeupKind`；
- 错误继续向上传播到 `launchRouteProcessing` 的 catch：`firstRouteProcessingError` 登记 + `onFatalError` 恰好一次；
- `launchRouteProcessing` 改为“先 catch 登记、后 finally 删除 promise”，关闭 4.4 的 stopAndDrain 微任务窗口。

### 3.2 `runRoute` 失败路径设计

```ts
async function runRoute(
  symbol: string,
  generation: number,
  wakeupKind: OrderMonitorWakeupKind,
): Promise<void> {
  const routeState = getRouteState(symbol);
  if (routeState === null || !isRouteRuntimeActive() || routeState.generation !== generation) {
    return;
  }

  let routeError: unknown = null;
  try {
    await processRoute({
      symbol,
      generation,
      wakeupKind,
      latestQuote: routeState.latestQuote,
    });
  } catch (error) {
    routeError = error;
  }

  const latestRouteState = getRouteState(symbol);
  if (latestRouteState === null || latestRouteState.generation !== generation) {
    // 处理期间 stop/重置（resetRouteStateForStop）或 route state 被销毁：
    // timer 已被 clearRouteTimers 清理，直接传播错误，不做事后推进。
    if (routeError !== null) {
      throw routeError;
    }
    return;
  }

  if (routeError !== null) {
    // 失败路径：本 generation 立即冻结，不再做任何业务推进。
    clearRouteTimers(latestRouteState); // 本 generation 的 timer 不再复活
    latestRouteState.dirty = false; // 丢弃处理期间累积的 wakeup
    latestRouteState.pendingWakeupKind = null;
    // inFlight 保持 true：阻止后续 triggerRoute 启动新 pass（详见 3.3）
    throw routeError; // 传播到 launchRouteProcessing catch
  }

  // 成功路径：保持原 finally 的全部语义（reconcile + inFlight 复位 + dirty rerun）
  reconcileRouteTimers(symbol, generation);
  latestRouteState.inFlight = false;
  if (isRouteRuntimeActive() && latestRouteState.dirty) {
    const rerunWakeupKind = latestRouteState.pendingWakeupKind;
    latestRouteState.dirty = false;
    latestRouteState.pendingWakeupKind = null;
    switch (rerunWakeupKind) {
      case 'QUOTE':
      case 'ORDER_EVENT':
      case 'TIMER':
      case 'TRACKED':
      case 'RECOVERED': {
        latestRouteState.inFlight = true;
        launchRouteProcessing(symbol, rerunWakeupKind);
        break;
      }
      case null:
      default:
        break;
    }
  } else if (!isRouteRuntimeActive()) {
    latestRouteState.dirty = false;
    latestRouteState.pendingWakeupKind = null;
  }
}
```

要点：

- 成功路径逐字保留原 `finally` 语义（注释里说明“成功时才允许 dirty collapse 与 timer 投影”，与事故分析 4.3 最小边界一致）；
- 失败路径中 `clearRouteTimers(latestRouteState)` 复用的是 `routingIndex.clearRouteTimers`（已导入），对已被 stop 清空的 map 是幂等安全的；
- 错误不再经过 `finally`，因此 reconcile 与 rerun 都不会在失败后执行。

### 3.3 `inFlight` 在失败后的处理：保持 `true`（冻结）

**论证**：

- 保持 `inFlight = true` 的语义是“fail-fast = 停止新的业务推进”（事故分析 4.3）。失败后至 fatal 上报/应用 cleanup 之间，任何 `triggerRoute`（quote/WS/timer）只会置 dirty 而不会启动新 pass，从而保证 fatal 前不再出现可能含 broker mutation 的第二轮 route。
- `stopAndDrain` → `resetRouteStateForStop` 会复位 `inFlight = false` 并 `generation += 1`（现状代码，不改），因此重启/停止后 route 可正常恢复；若应用选择不停止（不推荐），该 symbol route 保持冻结，符合 fail-fast 意图。
- 失败路径在抛错前已清 dirty/pendingWakeupKind；若抛错后（fatal 前）又收到 wakeup，dirty 会被重新置位，但 `inFlight === true` 保证不会执行——这比“清完又脏”更安全。

### 3.4 `launchRouteProcessing` 的 catch/finally 顺序调整（事故分析 4.4）

```ts
const promise = runRoute(symbol, routeState.generation, wakeupKind);
activeRoutePromises.add(promise);
promise
  .catch((error: unknown) => {
    if (firstRouteProcessingError === null && error instanceof Error) {
      firstRouteProcessingError = error;
    }
    onFatalError(error);
  })
  .finally(() => {
    activeRoutePromises.delete(promise);
  });
```

**不变式（关闭微任务窗口的关键）**：对同一 promise，错误登记（`firstRouteProcessingError` 写入 + `onFatalError` 调用）**先于**从 `activeRoutePromises` 删除。因此：

- 若 `stopAndDrain` 快照时 promise 仍在集合中 → `Promise.allSettled` 等到 rejection → `stopError` 分支 → stop 以错误结束；
- 若 `stopAndDrain` 快照时 promise 已删除 → 错误必然已登记 → `firstRouteProcessingError` 非 null → stop 以错误结束；
- 不存在“stop 成功返回但 route 错误尚未上报”的状态，即复现输出 `{stopResult:'fulfilled', fatal:[...]}` 被结构性排除。

**注意**：`onFatalError` 保持同步且不抛错（现有契约）；catch 内不 rethrow，`finally` 链上的 promise 结果不被消费（现状亦如此）。

### 3.5 定向测试（4.4 窗口）

在 `routeRuntime.business.test.ts` 新增：

- **场景 A（在途失败 + 并发 stop）**：`processRoute` await deferred 后抛错；`triggerRoute` → `await firstPassEntered` → 立即调用 `stopAndDrain()`（不 await）→ release deferred → `await stopAndDrain`。断言：`stopAndDrain` **reject**（`/route process failed/`）、`fatalErrors.length === 1`、`runtime.running === false`。（旧代码下该交错可能 fulfill，新代码下必然 reject。）
- **场景 B（失败已登记后再 stop）**：`processRoute` 直接抛错；`triggerRoute` → `flushMicrotasks`（错误已登记、promise 已删除）→ `await stopAndDrain`。断言：reject（走 `firstRouteProcessingError` 分支），fatal 仍恰好一次。
- **场景 C（失败后不再产生任何推进）**：`processRoute` 抛错前 `triggerRoute('QUOTE')` 置 dirty；断言失败后 `dirty === false`、`pendingWakeupKind === null`、`timerHandles.size === 0`、`processCount === 1`、`fatalErrors.length === 1`。

---

## 4. 测试矩阵（事故分析第 6 节，全部覆盖）

### 4.1 测试文件归属总表

| # | 场景 | 归属测试文件 | 断言要点 |
| --- | --- | --- | --- |
| 1 | 真实 Filled 样本：epoch updatedAt + 单一精确匹配 Filled history | `orderStatusQuery.business.test.ts`（提取）；`terminalSnapshotFacts.business.test.ts`（合并准入）；`routeProcessor.business.test.ts`（结算一次 + 全链路副作用） | 见 4.2 |
| 2 | history 缺失/非数组/无效 Date/状态不匹配/价格数量不匹配/多个冲突候选 → fail-closed | `orderStatusQuery.business.test.ts`（字段为 null）；`orderOps.business.test.ts`（断言抛错且零副作用）；`terminalSnapshotFacts.business.test.ts`（保护性 SELL 抛错） | 见 4.3 |
| 3 | 有效顶层 updatedAt → 原有路径不变 | `orderStatusQuery.business.test.ts` | `orderUpdatedAtMs` 正常、`filledHistoryTimeMs === null`（即使 history 匹配也跳过） |
| 4 | 新挂单未超时 `cancelRetryCount=0` → 不注册到期 CANCEL_RETRY，只保留首次 timeout owner | `routeRuntime.business.test.ts` | `timerHandles` 仅含 `BUY_TIMEOUT`/`SELL_TIMEOUT`；推进到 timeout 触发一次 `TIMER` |
| 5 | 已 retry backoff → 只存在 future CANCEL_RETRY，无过期 timeout 自循环 | `routeRuntime.business.test.ts` | 仅 `CANCEL_RETRY@nextCancelAttemptAt`；`advanceBy(0)` 不产生新 `TIMER` |
| 6 | `CANCEL_CONFIRMED` + 已超过 timeout → 只等待 WS | `routeRuntime.business.test.ts` | `nextCancelAttemptAt === WAIT_WS_ONLY` 时 `timerHandles.size === 0`；推进时间无 `TIMER` |
| 7 | route 失败期间收到 dirty wakeup → 不启动第二轮、只上报一次 fatal、不重挂 timer | `routeRuntime.business.test.ts` | `processCount === 1`、`fatalErrors.length === 1`、`timerHandles.size === 0`、`dirty === false` |
| 8 | 普通 Buy / 普通 Sell / 保护性 Sell 既有结算与持久化顺序不变（回归） | 现有 `routeProcessor.business.test.ts`、`settlementFlow.business.test.ts`、`eventFlow.business.test.ts`、`ordinaryRawExecutionFacts.business.test.ts` 全量保持绿 | `filledHistoryTimeMs === null` 时行为与现状逐字节一致 |
| 9 | stopAndDrain 微任务窗口定向测试（4.4） | `routeRuntime.business.test.ts` | 见 3.5 |

### 4.2 场景 1：真实 Filled 样本的“只结算一次 + 全链路副作用”验证分层

- **提取层（orderStatusQuery）**：构造 `status=5(Filled), executedQuantity=180000, executedPrice=0.055, updatedAt=Date(0), history=[{status:Filled, quantity:180000, price:0.055, time:Date(1785821355000)}]`（用 `Reflect.set` 注入损坏字段同款手法构造 history）。断言 `TERMINAL` 且 `orderUpdatedAtMs === null`、`filledHistoryTimeMs === 1785821355000`。
- **合并层（terminalSnapshotFacts）**：已知事实 `executedQuantity=0, lastOrderUpdateAtMs=null` + 上述快照 → `assertStateCheckRawExecutionFactsReady` 不抛；`normalizeTerminalStateSnapshot` 输出 `executedTimeMs === orderUpdatedAtMs === 1785821355000`。
- **结算一次层（routeProcessor.business.test.ts）**：沿用现有 `createSettlementFlow` + `createOrderStorage` 真实装配（该文件已如此装配），构造买入订单 + `queriedTerminalStateByOrderId` 预置上述快照 → 驱动 `handleBuyOrderTimeout` → 断言：
  - `settleOrder` 被调用恰好 1 次（用计数 mock 或真实 settlementFlow 的幂等结果）；
  - ack 后 `queriedTerminalStateByOrderId` 已删除；再次触发同一 pass 不再结算（`peek` 为 null 走撤单路径或直接返回）；
  - 全链路副作用正确产生：本地买单记录（`orderRecorder` trade log）、累计成交事实（DailyLoss `recordCumulativeExecution`）、成交后刷新需求（`cacheManager.clearCache`/`postTradeConsistencyRuntime`）、订单状态事件（`emitOrderStateChanged`）各恰好一次。
  - **说明**：routeProcessor 测试层是“只结算一次 + 全链路副作用”的最合适层——它同时具备真实 settlementFlow 与 route 驱动语义；`index.ts` 层（`cancelAndSettle`）的“只结算一次”由 `settleActiveTerminalFromRaw` 的 `alreadySettled` 幂等保护已有测试基础，本次不新增 index 级测试文件（避免扩大测试面），如需可后续补充。

### 4.3 场景 2：fail-closed 零副作用断言清单

对每个失败变体（history 缺失 / 非数组 / 无效 Date / 状态不匹配 / 数量不匹配 / 价格不匹配 / 多个时间冲突候选），在 `orderOps.business.test.ts` 用 `createOrderOps` harness（参考现有 `ordinaryRawExecutionFacts` 的 OPEN null-revision 用例）断言：

- `cancelOrder` 抛 `[订单监控] state-check 累计成交数量推进但缺少有效 broker revision`；
- `queriedTerminalStateByOrderId` 无该 orderId（terminal cache 未写——断言发生在 `mapStateCheckResultToCancelOutcome` 之前）；
- tracked order 的 `status/executedQuantity/executedPrice/lastExecutedTimeMs/lastOrderUpdateAtMs` 不变；
- `pendingSellQuantities === []`、`dailyLossInputs === []`、`settlementInputs === []`、`routeWakeups === []`、`orderRecorder` 无任何写入（trade log 未写）。

### 4.4 测试装配约定（沿用现状模式）

- 损坏字段统一用 `Reflect.set(snapshot, 'history', value)` 注入，不伪造静态类型（与 `overwriteUpdatedAtAtRuntimeBoundary` 同手法）；
- history 条目构造：`{ status: OrderStatus.Filled, time: new Date(...), quantity: new Decimal(180000), price: new Decimal(0.055) } as unknown as OrderHistoryDetail`；
- timer 相关测试使用现有 `createRuntimeTimerHarness`（fake setTimeout + 手动 advance），并注意 `finally { harness.restore() }`。

---

## 5. 不允许改动的文件/范围清单（事故分析 5.2 的 5 项，逐项确认）

1. **不得重新设计 `OrderStateCheckResult` 全部类型、拆出全局 revision 服务或重写 `settlementFlow`**——本次只在 TERMINAL 分支追加一个可空字段并扩展消费解析，不新增 union 分支、不删字段、不动 `settlementFlow.ts` 逻辑。
2. **不得为 OPEN、PartialFilled、Canceled、Rejected 做 history 推断**——提取严格门控 `closedReason === 'FILLED'`。
3. **不得修改 WS reconnect、订阅、启动恢复或交易日重建**——`eventFlow.ts`、`recoveryFlow.ts`、`initialize` 等零改动。
4. **不得引入全局周期性订单对账、无限/有限补偿重试或“未知即删除”**——不新增 poller/queue/timer 类型/retry policy；`routeRuntime` 只改投影条件与失败分支。
5. **不得吞掉 cleanup 或把内部状态错误降级为成功退出**——`stopAndDrain` 的错误暴露契约保持；`runRoute` 失败路径仍然 throw，cleanup 仍能捕获并上报。

**明确零改动的文件**：`eventFlow.ts`、`recoveryFlow.ts`、`settlementFlow.ts`、`routingIndex.ts`、`src/utils/timer/index.ts`、`routeProcessor.ts`（仅注释可改）、`orderOps.ts`（仅注释可改）、`index.ts`（仅注释可改）、`src/core/trader/orderMonitor/types.ts`（可加注释，类型经 `Extract` 自动扩展）。

---

## 6. 实现顺序与验证命令

1. `src/types/trader.ts` 类型 + `orderMonitor/utils.ts` 新助手；
2. `orderStatusQuery.ts` 提取；
3. `orderFactMerge.ts` 三处消费；
4. `routeRuntime.ts` P0-2 两处投影 + P0-3 失败路径与注册顺序；
5. 测试（按 4.1 归属）→ 先写反例再实现（事故分析第 6 节建议）；
6. 全量验证：

```text
bun format
bun lint
bun type-check
bun test tests/core/trader/orderMonitor/
```

在没有新的全量命令输出前，不得把定向结果表述为“全仓已验证”（事故分析第 6 节）。

---

## 7. 风险与边界论证

### 7.1 P0-1 风险

- **Decimal.equals 两侧必须都是 Decimal**：采用 `isDecimalLike` 鸭子类型守卫；若 SDK 未来把 history 字段类型改为 number，equals 守卫会 fail-closed（返回 null），而不是误匹配——这是有意为之的保守方向。
- **多重 Filled 历史（不同时间）**：Longbridge 正常每订单一条 Filled 历史；若出现多条不同时间 → 拒绝（fail-closed），宁可重试也不猜。
- **Filled + executedPrice === null 的畸形详情**：无候选 → `filledHistoryTimeMs = null` → 下游沿用现有“缺少有效成交价/缺少有效 broker revision”异常，安全。
- **与 WS 路径的交互**：`filledHistoryTimeMs` 只出现在 state-check TERMINAL 快照；WS 事实仍走 `resolveUpdatedAtMs`，两者在 `orderFactMerge` 中按同一单调规则合并（`mergeMonotonicOrderFact` 的 revision 倒退校验覆盖 history 时间倒退），不会引入新的竞争面。
- **事故分析 4.5 的 cancel/WS 竞争窗口**：明确不在本次范围（保留边界），本改动不放大该窗口。

### 7.2 P0-2 风险

- **WS 复位后的一次性 0ms 收敛**：属于合法收敛而非自循环（见 2.4 论证），但实现后需用测试钉住“至多一次”。
- **`cancelRetryCount` 与 sentinel 组合不存在**（`pauseCancelRetryAndWaitWs` 同时归零），因此两个新增条件互不遮蔽；若未来代码改变该不变量，两个条件仍各自独立 fail-safe（sentinel 拒绝 + count 拒绝）。
- **timeout 禁用 + 撤单意图**：timeout 禁用时订单本就不走超时撤单；末日/外部撤单路径不受 timer 投影影响。

### 7.3 P0-3 风险

- **失败后 `inFlight = true` 冻结**：若 `onFatalError` 不触发 cleanup，symbol route 永久冻结——这是 fail-fast 的预期语义，且 `stopAndDrain`/`resetRouteStateForStop` 提供唯一复位路径；已在 3.3 写明。
- **catch/finally 重排后 `onFatalError` 抛错**：会令 finally 链产生未处理 rejection；维持“onFatalError 不得抛错”的既有契约（现状同样如此），不加 try 包裹以免掩盖错误来源。
- **`firstRouteProcessingError` 只登记首个 Error**：`instanceof Error` 守卫保持现状；非 Error 拒绝值仍只走 `onFatalError`，stop 时经 `result.reason instanceof Error` 判断——保持现状语义。

---

## 8. 已检查文件清单与本设计结论摘要

### 8.1 已检查文件（本规格的依据）

| 类别 | 文件 |
| --- | --- |
| 事故分析 | `docs/issues/2026-08/2026-08-04-order-monitor-state-check-incident-first-principles-analysis.md`（全文） |
| P0-1 主改 | `src/core/trader/orderMonitor/orderStatusQuery.ts`、`orderFactMerge.ts`、`utils.ts`（`resolveUpdatedAtMs`/`resolveTimeMs`） |
| 类型 | `src/types/trader.ts`（`OrderStateCheckResult`）、`src/core/trader/orderMonitor/types.ts`（`TerminalStateSnapshot`/`NormalizedTerminalStateSnapshot`/`RouteTimerSchedule`/`OrderMonitorTimerKind` 等） |
| P0-2/P0-3 主改 | `src/core/trader/orderMonitor/routeRuntime.ts`（`resolveCancelRetrySchedule`/`resolveTimeoutSchedule`/`runRoute`/`launchRouteProcessing`/`stopAndDrain`）、`routingIndex.ts`（`clearRouteTimers`） |
| 消费入口 | `src/core/trader/orderMonitor/orderOps.ts`（`cancelOrder`/`handleReplaceTempBlockedByStatus`/`replaceOrderPriceWithRunner`）、`routeProcessor.ts`（`resolveTerminalSettlementInput`/`settlePendingReplaceTerminal`/`settleBuyOrderTimeoutTerminal`/`canAttemptTimeoutHandling`/`applyCancelRetryBackoff`/`pauseCancelRetryAndWaitWs`）、`index.ts`（`settleActiveTerminalFromRaw`/`cancelAndSettle`） |
| WS 对照 | `src/core/trader/orderMonitor/eventFlow.ts`（只读，不改） |
| 工具 | `src/utils/timer/index.ts`（`scheduleBoundedOneShotAt` 0ms 行为）、`src/constants/index.ts`（`ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS = Number.MAX_SAFE_INTEGER`） |
| SDK 类型 | `node_modules/longbridge/index.d.ts`：`OrderDetail`（1266 行起，`history: Array<OrderHistoryDetail>`、`updatedAt: Date | null`）、`OrderHistoryDetail`（1354 行起，`price/quantity: Decimal`、`status: OrderStatus`、`time: Date`）、`Decimal.equals/comparedTo`、`OrderStatus.Filled = 5` |
| 测试 | `orderStatusQuery.business.test.ts`、`routeRuntime.business.test.ts`、`terminalSnapshotFacts.business.test.ts`、`ordinaryRawExecutionFacts.business.test.ts`、`orderOps.business.test.ts`、`routeProcessor.business.test.ts`（装配模式：`Reflect.set` 损坏字段、`createRuntimeTimerHarness`、`createSettlementFlow` 真实装配） |

### 8.2 设计结论摘要

1. **P0-1**：`OrderStateCheckResult.TERMINAL` 新增 `filledHistoryTimeMs: number | null`（仅在 Filled + 顶层 updatedAt 无效时由窄规则从 history 提取）；`orderFactMerge` 三处消费点改为 `orderUpdatedAtMs ?? filledHistoryTimeMs`；其余模块经类型透传零逻辑改动（仅注释）；9 项禁止项逐一排除。
2. **P0-2**：`resolveCancelRetrySchedule` 增加 `cancelRetryCount > 0` 门控；`resolveTimeoutSchedule` 增加 sentinel 与 `cancelRetryCount > 0` 两个拒绝条件；owner 表格与 `canAttemptTimeoutHandling` 推进语义逐条论证兼容。
3. **P0-3**：`runRoute` 失败路径清 timer/dirty、保持 `inFlight=true` 冻结、throw 传播；`launchRouteProcessing` 改为 catch 先登记、finally 后删除，关闭 4.4 微任务窗口；配套三个定向测试场景。
4. **测试矩阵**：事故分析第 6 节 9 项全部给出文件归属与断言要点。

### 8.3 设计风险提示（实现时需注意）

1. **4.4 窗口的精确复现**：旧代码下该窗口依赖受控微任务交错（事故分析用内存复现），直接写“旧代码会 fulfill”的测试可能难以稳定触发；建议以“不变式测试”为准（stopAndDrain 在失败场景下必须 reject，绝不 fulfill），而非复刻旧缺陷本身。
2. **`resolveOccurrenceTimeMs` 入参 `unknown`**：`entry.time` 静态类型是 `Date`，直接传 `unknown` 需要一次显式断言/cast，避免 lint 报错；建议实现为 `resolveOccurrenceTimeMs(entry.time as unknown)` 并注释运行时边界。
3. **P0-2 对现有 routeRuntime 测试的影响**：现有测试 `start 时会为 nextCancelAttemptAt 投影 CANCEL_RETRY timer` 构造了 `cancelRetryCount` 默认 0 的订单——新门控会使该测试失效，**必须**同步把 fixture 改为 `cancelRetryCount: 1`（或按新语义重写为“未产生 backoff 不投影”）。这是本次改动中唯一会破坏既有测试的 fixture 变更点。
4. **routeProcessor 既有测试中的 `nextCancelAttemptAt` fixture**：多处构造 `nextCancelAttemptAt = now - 1` 且 `cancelRetryCount` 默认 0——在 P0-2 下 timeout timer 仍会投影（count=0），行为不变；但若 fixture 同时置 sentinel，需检查是否依赖旧 timeout 投影（应改为显式断言无 timer）。

### 8.4 置信度

- **P0-1 设计**：高（窄规则与消费点均与事故分析 4.1 逐条对应，类型透传路径已逐一核对）。
- **P0-2 设计**：高（owner 表格映射直接、既有测试 fixture 影响已识别）。
- **P0-3 设计**：高（失败路径与注册顺序设计直接对应 4.3/4.4 最小边界；4.4 窗口的机制细节依赖受控复现，实现后需用不变式测试钉住）。
- **整体**：高。本规格不引入任何超出事故分析第 4/5 节边界的设计。
