# HSI Single Monitor Architecture Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前单 HSI monitor 版本继续精简为“唯一 monitor + LONG/SHORT 方向隔离”的直接架构，删除旧多 monitor 外层维度、兼容壳、补丁式校验和重复测试噪音。

**Architecture:** 配置、外部事件、订单恢复和持久化事实仍保留 monitorSymbol 校验；校验通过后，内部运行时只传递 direction、seatVersion、symbol 和业务事实。SymbolRegistry、任务队列、延迟验证、指标缓存、route baseline、风控状态和测试辅助都收缩到单 monitor 内部模型。

**Implementation status:** 本文记录最终目标与验收边界。已完成的实现不保留 `getMonitorSymbol`、`SeatVersionChangedEvent`、`MonitorTaskContext`、`seatProjection`、`routesByKey` 或 monitor-prefixed 内部 route key；后续修改必须以本节的实际目标契约为准。下方未勾选框保留原计划审计轨迹，不代表当前工作树未完成；以“Current Findings”和最终验证记录为准。

**Tech Stack:** TypeScript strict mode, Bun, Longbridge SDK, event-driven async runtimes, existing repository factories and test doubles.

---

## Current Findings

当前活跃代码中未发现需要继续迁移的 `tradingConfig.monitors`、`monitorContexts Map`、`MultiMonitorTradingConfig`、`originalIndex`、`MONITOR_SYMBOL_1` / `MONITOR_SYMBOL_N` 配置解析主路径。配置入口已经是 `TradingConfig.monitor + TradingConfig.global`，`parseMonitorConfig(env)` 读取无下标键。

后续审查的主问题已经从旧关键字和内部传播改为剩余 `monitorSymbol` 命中的边界分类：

- buy/sell task、monitor task、delayed verifier、indicator cache、display request 和 switch handoff 等内部路径已经基本不再携带唯一 `monitorSymbol`。剩余命中主要应归类为配置、外部事件校验、订单归属/恢复、持久化事实、日志和展示。
- `resolveMonitorContextSeatSnapshot` 已改为只按方向读取 `SymbolRegistry`；`resolveMonitorContextSymbolNames` 只从已验证的配置 monitor 与行情派生显示名称。旧 `resolveMonitorContextRuntimeSnapshot`、`collectBoundSeatSymbols` 已删除，后续审查应防止重新引入调用方 supplied monitor identity。
- 午夜 `SeatDomain` 只需要 `autoSymbolManager.resetAllState` 与 `warrantListCache.clear`；不得继续注入完整 `MonitorContext` 或测试侧的 seat snapshot 镜像。
- `TradingRisk` 路由索引只从 `SymbolRegistry` 派生；它不接收 `MonitorContext`，也不以 monitor 信息构造第二条内部索引。
- 风控/恢复链路仍必须保留外部事实归因校验；liquidation cooldown 的内部恢复合同已经收口为 direction key，外部 trade log/recovery facts 校验 monitorSymbol 后再传 direction。
- `tests/architecture/typeOrganization.test.ts` 已改为长期架构规则，不再锁一次性旧关键字。switchWakeup handoff 负测保留对象身份不变量，已删除 old foreign monitor route 命名。

## Non-Negotiable Boundaries

- Do not reintroduce `_1` / `_N` indexed config guards. 当前单 monitor 配置契约是无下标键；旧 indexed key 不应被生产解析层主动兼容或特殊扫描。
- Do not replace deleted multi-monitor architecture with one-element maps, registries, arrays, or helper shells.
- Do not silently map external facts to HSI. 外部行情事件、订单事件、恢复快照、trade log 和保护性清仓事实携带的 monitorSymbol 必须校验；不能默认归入唯一 monitor。
- Do not pass monitorSymbol through internal handoff APIs after the source owner has already validated the single monitor context. Cross-runtime handoff inside the same process is an internal boundary, not a new monitor route.
- Do not remove LONG/SHORT, seatVersion, order route, trading symbol, in-flight order, quote subscription, or candlestick cache maps when those are real business dimensions.
- Do not add tests whose purpose is only to prevent multi-monitor regression. Existing tests should be simplified, merged, or deleted where they only prove old structures are absent.

## Target Internal Contracts

### SymbolRegistry

Target interface shape:

```ts
export interface SymbolRegistry {
  getSeatState: (direction: 'LONG' | 'SHORT') => SeatState;
  getSeatVersion: (direction: 'LONG' | 'SHORT') => number;
  resolveSeatBySymbol: (symbol: string) => {
    readonly direction: 'LONG' | 'SHORT';
    readonly seatVersion: number;
  } | null;
  updateSeatState: (direction: 'LONG' | 'SHORT', nextState: SeatState) => SeatState;
  updateSeatStateWithVersionBump: (
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ) => {
    readonly seatState: SeatState;
    readonly seatVersion: number;
  };
  onSeatStateChanged: (listener: (event: SeatStateChangedEvent) => void) => Unsubscribe;
  onSeatTruthChanged: (listener: SeatTruthChangedListener) => Unsubscribe;
}
```

`SeatStateChangedEvent` 与 `SeatTruthChangedEvent` 是内部席位事实事件，不携带 `monitorSymbol`。可观测日志从唯一 `MonitorContext.config.monitorSymbol` 读取显示标签；持久化与外部边界则在各自入口完成 monitor 校验。

### Trade And Monitor Tasks

Target buy/sell task shape:

```ts
export type Task<TType extends string> = {
  readonly id: string;
  readonly type: TType;
  readonly data: TaskSignal<TType>;
  readonly createdAt: number;
};
```

Target monitor task payloads:

```ts
export type AutoSymbolTickTaskData = Readonly<{
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  symbol: string;
  lastSeatActivatedAt: number;
  currentTimeMs: number;
}>;

export type SeatRefreshTaskData = Readonly<{
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
  previousSymbol: string | null;
  nextSymbol: string;
  callPrice?: number | null;
  symbolName: string | null;
  apiRetryAttempt?: number;
}>;
```

`dedupeKey` remains direction-based, for example `AUTO_SYMBOL_TICK:${direction}` and `SEAT_REFRESH:${direction}`. `seatVersion` remains the stale-task isolation boundary.

### Indicator Cache And Delayed Verifier

Target cache API:

```ts
export interface IndicatorCache {
  push: (values: VerificationSampleValues, sampleTimestampMs: number) => void;
  getClosest: (targetTime: number) => IndicatorCacheEntry | null;
  clearAll: () => void;
}
```

Target verifier API:

```ts
export interface DelayedSignalVerifierPort {
  addSignal: (params: {
    readonly signal: Signal;
    readonly verificationIndicators: ReadonlyArray<VerificationIndicator>;
  }) => void;
  onVerified: (callback: VerifiedCallback) => void;
  cancelAllForDirection: (direction: 'LONG' | 'SHORT') => number;
  cancelAll: () => number;
  getPendingCount: () => number;
  destroy: () => void;
}
```

Quote/event monitor validation happens before signal creation. `Signal` carries `seatVersion` but not `monitorSymbol`, so the verifier should no longer expose a monitor route dimension.

### Direction Route Helper

Add one small helper only if repeated route-key code remains after the first refactors:

```ts
export type DirectionRouteKey = 'LONG' | 'SHORT';
export type VersionedDirectionRouteKey = `${DirectionRouteKey}:${number}`;

export function buildDirectionRouteKey(direction: DirectionRouteKey): DirectionRouteKey {
  return direction;
}

export function buildVersionedDirectionRouteKey(params: {
  readonly direction: DirectionRouteKey;
  readonly seatVersion: number;
}): VersionedDirectionRouteKey {
  return `${params.direction}:${params.seatVersion}`;
}
```

Keep this helper thin. Do not merge auto-search, periodic switch, distance switch, static liquidation, and trading risk runtimes into a single state machine.

## Files By Refactor Area

### Area A: Registry And Seat Utilities

Modify:

- `src/types/seat.ts`
- `src/services/autoSymbolManager/utils.ts`
- `src/utils/seat/snapshots.ts`
- `src/utils/seat/symbols.ts`
- `src/main/utils.ts`
- `src/main/recovery/seatPreparation.ts`
- `src/main/lifecycle/rebuildTradingDayState.ts`
- `src/main/lifecycle/tradingCalendarPrewarmer.ts`
- `src/main/lifecycle/cacheDomains/seatDomain.ts`
- `src/main/quoteSubscriptionRuntime/index.ts`
- `tests/**` that mock `SymbolRegistry`

### Area B: Internal Task Contracts

Modify:

- `src/main/asyncProgram/tradeTaskQueue/types.ts`
- `src/main/asyncProgram/tradeTaskQueue/index.ts`
- `src/main/businessEventProgram/signalPipeline.ts`
- `src/app/wiring/registerDelayedSignalHandlers.ts`
- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/main/asyncProgram/sellProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskQueue/types.ts`
- `src/main/asyncProgram/monitorTaskQueue/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- `src/main/seatActivationDispatcher/index.ts`
- `src/main/periodicSwitchWakeupRuntime/index.ts`
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`

### Area C: Cache, Verifier, And Display Runtimes

Modify:

- `src/main/asyncProgram/indicatorCache/types.ts`
- `src/main/asyncProgram/indicatorCache/index.ts`
- `src/main/asyncProgram/delayedSignalVerifier/types.ts`
- `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
- `src/main/businessEventProgram/index.ts`
- `src/main/monitorDisplayRuntime/types.ts`
- `src/main/monitorDisplayRuntime/index.ts`
- `src/main/tradingQuoteDisplayRuntime/types.ts`
- `src/main/tradingQuoteDisplayRuntime/index.ts`

### Area D: Route Baselines And Switch/Risk Runtimes

Modify:

- `src/main/autoSearchWakeupRuntime/index.ts`
- `src/main/autoSearchWakeupRuntime/types.ts`
- `src/main/periodicSwitchWakeupRuntime/types.ts`
- `src/main/monitorQuoteEventRuntime/types.ts`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/main/tradingRiskEventRuntime/types.ts`
- `src/main/tradingRiskEventRuntime/routingIndex.ts`
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`

### Area E: Risk, Recovery, And Settlement Attribution

Modify:

- `src/types/risk.ts`
- `src/core/riskController/dailyLossTracker.ts`
- `src/core/riskController/unrealizedLossMonitor.ts`
- `src/core/signalProcessor/riskCheckPipeline.ts`
- `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts`
- `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`
- `src/core/trader/orderMonitor/settlementFlow.ts`
- `src/core/trader/orderMonitor/recoveryFlow.ts`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- `src/services/liquidationCooldown/tradeLogHydrator.ts`

### Area F: App Assembly And Config Quality

Modify:

- `src/app/runtime/createPostGateRuntime.ts`
- `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- `src/app/runApp.ts`
- `src/app/types.ts`
- `src/config/trading/utils.ts`
- `src/config/validator/utils.ts`
- `.env.example`

### Area G: Tests And Current Docs

Modify or delete:

- `tests/architecture/typeOrganization.test.ts`
- `tests/main/asyncProgram/tradeTaskQueue/business.test.ts`
- `tests/main/asyncProgram/monitorTaskQueue/business.test.ts`
- `tests/main/asyncProgram/buyProcessor/business.test.ts`
- `tests/main/asyncProgram/sellProcessor/business.test.ts`
- `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
- `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- `tests/main/monitorDisplayRuntime/business.test.ts`
- `tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts`
- `tests/main/seatActivationDispatcher/seatActivationDispatcher.business.test.ts`
- `tests/main/seatRuntimeCleanupDispatcher/business.test.ts`
- `tests/main/periodicSwitchWakeupRuntime/business.test.ts`
- `tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts`
- `tests/integration/liquidationCooldownRecovery.integration.test.ts`
- `docs/plans/2026-07/2026-07-07-hsi-single-monitor-refactor-plan.md`
- `README.md`
- `.env.example`

## Implementation Tasks

### Task 1: Lock The Boundary Contract In Code Comments And Types

**Files:**

- Modify: `src/types/seat.ts`
- Modify: `src/types/risk.ts`
- Modify: `src/main/asyncProgram/tradeTaskQueue/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Modify: `src/main/asyncProgram/indicatorCache/types.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/types.ts`

- [ ] **Step 1: Change comments from monitor-route wording to single-monitor wording**

In the affected `types.ts` files, remove comments that say data is keyed by monitor route when the real key is direction or seatVersion. Use this wording pattern:

```ts
/**
 * 类型用途：唯一 monitor 内按 LONG/SHORT 方向维护运行态。
 * 数据来源：外部 monitorSymbol 已在入口边界校验；本类型不再表达 monitor 路由维度。
 * 使用范围：内部运行时与测试辅助。
 */
```

- [ ] **Step 2: Update type names only when behavior changes**

Rename only stale monitor-route names. Keep names that describe real business concepts:

```ts
// Keep
TradingRiskRoute
SwitchWakeupRoute
PeriodicSwitchRoute

// Remove stale wrapper instead of renaming it
MonitorTaskContext -> direct MonitorContext injection
```

- [ ] **Step 3: Run type-only compile check**

Run:

```powershell
bun type-check
```

Expected: may fail while later tasks are incomplete. Record only errors caused by new target signatures.

### Task 2: Refactor SymbolRegistry To Direction-First

**Files:**

- Modify: `src/types/seat.ts`
- Modify: `src/services/autoSymbolManager/utils.ts`
- Modify: `src/utils/seat/snapshots.ts`
- Modify: `src/utils/seat/symbols.ts`
- Modify: all direct `symbolRegistry.getSeatState(monitorSymbol, direction)` call sites under `src/`
- Test: existing tests that build `SymbolRegistry` doubles

- [ ] **Step 1: Update `SymbolRegistry` interface**

Replace monitor-first methods with direction-first methods:

```ts
export interface SymbolRegistry {
  getSeatState: (direction: 'LONG' | 'SHORT') => SeatState;
  getSeatVersion: (direction: 'LONG' | 'SHORT') => number;
  resolveSeatBySymbol: (symbol: string) => {
    readonly direction: 'LONG' | 'SHORT';
    readonly seatVersion: number;
  } | null;
  updateSeatState: (direction: 'LONG' | 'SHORT', nextState: SeatState) => SeatState;
  updateSeatStateWithVersionBump: (
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ) => {
    readonly seatState: SeatState;
    readonly seatVersion: number;
  };
  onSeatStateChanged: (listener: (event: SeatStateChangedEvent) => void) => Unsubscribe;
  onSeatTruthChanged: (listener: SeatTruthChangedListener) => Unsubscribe;
}
```

- [ ] **Step 2: Update `createSymbolRegistry` implementation**

Keep only the two directional seat entries; the registry itself does not retain a monitor identifier:

```ts
getSeatState(direction: 'LONG' | 'SHORT'): SeatState {
  return resolveSeatEntry(seatStore, direction).state;
},
getSeatVersion(direction: 'LONG' | 'SHORT'): number {
  return resolveSeatEntry(seatStore, direction).version;
},
```

`resolveSeatEntry` should accept only `seatStore` and `direction`. `resolveSeatBySymbol` returns only `{ direction, seatVersion }`; state consumers must re-read the registry. Emit `{ direction }` truth events after every atomic state mutation.

- [ ] **Step 3: Update call sites**

Mechanical replacement examples:

```ts
// Before
symbolRegistry.getSeatState(monitorSymbol, 'LONG');
symbolRegistry.getSeatVersion(monitorSymbol, direction);
symbolRegistry.updateSeatState(monitorSymbol, direction, nextState);

// After
symbolRegistry.getSeatState('LONG');
symbolRegistry.getSeatVersion(direction);
symbolRegistry.updateSeatState(direction, nextState);
```

Keep `monitorSymbol` variables only where they are used for external event validation, logs, order ownership, or persisted facts.

- [ ] **Step 4: Update tests and doubles**

Replace test double method signatures in `tests/**`:

```ts
const symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'> = {
  getSeatState: (direction) => (direction === 'LONG' ? longSeat : shortSeat),
  getSeatVersion: (direction) => (direction === 'LONG' ? longVersion : shortVersion),
};
```

- [ ] **Step 5: Verify no monitor-first registry API remains**

Run:

```powershell
rg -n "getSeatState\\([^,]+,|getSeatVersion\\([^,]+,|updateSeatState\\([^,]+," src tests
```

Expected: no active call sites except historical docs if deliberately ignored.

### Task 3: Remove monitorSymbol From Buy/Sell Task Queues

**Files:**

- Modify: `src/main/asyncProgram/tradeTaskQueue/types.ts`
- Modify: `src/main/asyncProgram/tradeTaskQueue/index.ts`
- Modify: `src/main/businessEventProgram/signalPipeline.ts`
- Modify: `src/app/wiring/registerDelayedSignalHandlers.ts`
- Modify: `src/main/asyncProgram/buyProcessor/index.ts`
- Modify: `src/main/asyncProgram/sellProcessor/index.ts`
- Modify: `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- Test: `tests/main/asyncProgram/tradeTaskQueue/business.test.ts`
- Test: buy/sell processor tests

- [ ] **Step 1: Update task type**

Use:

```ts
export type Task<TType extends string> = {
  readonly id: string;
  readonly type: TType;
  readonly data: TaskSignal<TType>;
  readonly createdAt: number;
};
```

`TaskQueue.push` should accept `Omit<Task<TType>, 'id' | 'createdAt'>`.

- [ ] **Step 2: Remove monitorSymbol from queue implementation**

Change queue push construction:

```ts
const fullTask: Task<TType> = {
  id: randomUUID(),
  type: task.type,
  data: task.data,
  createdAt: Date.now(),
};
```

- [ ] **Step 3: Remove monitorSymbol from all enqueue calls**

Before:

```ts
buyTaskQueue.push({
  type: 'VERIFIED_BUY',
  data: buySignal,
  monitorSymbol,
});
```

After:

```ts
buyTaskQueue.push({
  type: 'VERIFIED_BUY',
  data: buySignal,
});
```

- [ ] **Step 4: Processor derives monitor from context**

Before:

```ts
const monitorSymbol = requireExpectedMonitorSymbol(expectedMonitorSymbol, task.monitorSymbol);
```

After:

```ts
const monitorSymbol = monitorContext.config.monitorSymbol;
```

Keep `validateSignalSeat({ monitorSymbol, signal, symbolRegistry })` until Task 2 or a later task removes the monitor parameter from `validateSignalSeat`.

- [ ] **Step 5: Cleanup predicates use direction and seatVersion**

Replace queue cleanup predicates:

```ts
task.monitorSymbol === monitorSymbol && isDirectionAction(task.data.action, direction);
```

with:

```ts
isDirectionAction(task.data.action, direction);
```

If the cleanup event carries `previousVersion`, prefer:

```ts
isDirectionAction(task.data.action, direction) && task.data.seatVersion === previousVersion;
```

- [ ] **Step 6: Delete old monitor grouping tests**

Remove test cases that use a second monitor symbol such as `TECH.HK` only to test queue removal. Keep FIFO, `removeTasks`, and `clearAll` behavior using task type, action, direction, or seatVersion predicates.

### Task 4: Remove monitorSymbol From Monitor Task Queue And Processor

**Files:**

- Modify: `src/main/asyncProgram/monitorTaskQueue/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskQueue/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/types.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/index.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`
- Modify: `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`
- Modify: `src/main/seatActivationDispatcher/index.ts`
- Modify: `src/main/periodicSwitchWakeupRuntime/index.ts`
- Modify: `src/main/autoSearchWakeupRuntime/index.ts`
- Test: `tests/main/asyncProgram/monitorTaskQueue/business.test.ts`
- Test: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`

- [ ] **Step 1: Update monitor task envelope**

Use:

```ts
type MonitorTaskByDataMap<
  TDataMap extends MonitorTaskDataMapBase,
  TType extends keyof TDataMap = keyof TDataMap,
> = TType extends keyof TDataMap
  ? Readonly<{
      id: string;
      type: TType;
      dedupeKey: string;
      data: TDataMap[TType];
      createdAt: number;
    }>
  : never;
```

- [ ] **Step 2: Remove monitorSymbol from `AutoSymbolTickTaskData` and `SeatRefreshTaskData`**

Use the target shapes from the Target Internal Contracts section.

- [ ] **Step 3: Update queue implementation**

Remove `monitorSymbol` from logs and task construction:

```ts
const fullTask = {
  id: randomUUID(),
  type: task.type,
  dedupeKey: task.dedupeKey,
  data: task.data,
  createdAt: Date.now(),
} as MonitorTask<TDataMap, TType>;
```

Seat refresh replacement log should read fields from data:

```ts
`[SEAT_REFRESH replaced] direction=${readStringField(task.data, 'direction')} seatVersion=${readNumberField(task.data, 'seatVersion')} nextSymbol=${readStringField(task.data, 'nextSymbol')} dedupeKey=${task.dedupeKey} replacedCount=${removedCount}`;
```

- [ ] **Step 4: Delete `MonitorTaskContext` and `requireContext`**

Inject the unique `MonitorContext` directly into the processor and its handlers. Handlers should use:

```ts
const monitorSymbol = context.config.monitorSymbol;
```

only when calling external-boundary APIs or logging.

- [ ] **Step 5: Update task producers**

Before:

```ts
monitorTaskQueue.scheduleLatest({
  type: 'SEAT_REFRESH',
  dedupeKey,
  monitorSymbol,
  data: {
    monitorSymbol,
    direction,
    seatVersion,
    previousSymbol,
    nextSymbol,
    callPrice,
    symbolName,
  },
});
```

After:

```ts
monitorTaskQueue.scheduleLatest({
  type: 'SEAT_REFRESH',
  dedupeKey,
  data: {
    direction,
    seatVersion,
    previousSymbol,
    nextSymbol,
    callPrice,
    symbolName,
  },
});
```

- [ ] **Step 6: Delete duplicate mismatch tests**

Delete tests whose only assertion is `task.monitorSymbol` or `task.data.monitorSymbol` mismatch. Replace table-driven processor tests with direction/seatVersion stale-task cases already relevant to single monitor.

### Task 5: Refactor IndicatorCache And DelayedSignalVerifier To Single-Monitor APIs

**Files:**

- Modify: `src/main/asyncProgram/indicatorCache/types.ts`
- Modify: `src/main/asyncProgram/indicatorCache/index.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/types.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/index.ts`
- Modify: `src/main/asyncProgram/delayedSignalVerifier/utils.ts`
- Modify: `src/main/businessEventProgram/index.ts`
- Modify: `src/main/monitorDisplayRuntime/types.ts`
- Modify: `src/main/monitorDisplayRuntime/index.ts`
- Modify: `src/main/tradingQuoteDisplayRuntime/types.ts`
- Modify: `src/main/tradingQuoteDisplayRuntime/index.ts`
- Modify: `src/app/context/createMonitorContext.ts`
- Test: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Test: `tests/main/businessEventProgram/business.test.ts`

- [ ] **Step 1: Update IndicatorCache types**

Use:

```ts
export type IndicatorCacheOptions = {
  readonly retentionWindowMs?: number;
};

export interface IndicatorCache {
  push: (values: VerificationSampleValues, sampleTimestampMs: number) => void;
  getClosest: (targetTime: number) => IndicatorCacheEntry | null;
  clearAll: () => void;
}
```

- [ ] **Step 2: Update IndicatorCache implementation**

Remove `expectedMonitorSymbol` and `requireExpectedMonitorSymbol`. Implement:

```ts
push(values: VerificationSampleValues, sampleTimestampMs: number): void {
  const entry: IndicatorCacheEntry = {
    timestamp: sampleTimestampMs,
    values,
  };
  pushToQueue(queue, entry, retentionWindowMs);
}

getClosest(targetTime: number): IndicatorCacheEntry | null {
  if (queue.entries.length === 0) {
    return null;
  }

  return findClosestEntry(queue, targetTime);
}
```

- [ ] **Step 3: Update verifier entry type and API**

Remove `monitorSymbol` from `PendingSignalEntry` and `addSignal`. Keep signal identity by symbol/action/triggerTime and seatVersion in the signal itself.

- [ ] **Step 4: Update verification reads**

Before:

```ts
indicatorCache.getClosest(monitorSymbol, targetTime);
```

After:

```ts
indicatorCache.getClosest(targetTime);
```

- [ ] **Step 5: Update cancellations**

Replace:

```ts
cancelAllForDirection(monitorSymbol, direction);
```

with:

```ts
cancelAllForDirection(direction);
```

and filter pending signals by signal action direction only.

- [ ] **Step 6: Simplify tests**

Keep tests for verification pass/fail, missing samples, duplicate signal id, direction cancellation, and clear all. Delete tests that only assert non-HSI monitor mismatch at this internal cache/verifier layer.

- [ ] **Step 7: Collapse monitor display request APIs**

`monitorDisplayRuntime.requestRender` should not accept `monitorSymbol`. The caller has already passed the single monitor event boundary before it has a monitor snapshot.

Before:

```ts
requestRender({
  monitorSymbol,
  monitorSnapshot,
});
```

After:

```ts
requestRender({
  monitorSnapshot,
});
```

The renderer may still receive `monitorSymbol` from `monitorContext.config.monitorSymbol` for operator display. `tradingQuoteDisplayRuntime` may continue to render the monitor quote next to a trading quote, but its route identity must be direction/trading symbol/seatVersion, not monitorSymbol.

### Task 6: Collapse Route Baselines To Direction And SeatVersion

**Files:**

- Modify: `src/main/periodicSwitchWakeupRuntime/types.ts`
- Modify: `src/main/periodicSwitchWakeupRuntime/index.ts`
- Modify: `src/main/monitorQuoteEventRuntime/types.ts`
- Modify: `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- Modify: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- Modify: `src/main/tradingRiskEventRuntime/types.ts`
- Modify: `src/main/tradingRiskEventRuntime/routingIndex.ts`
- Modify: `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- Optional create: `src/utils/seat/routeKeys.ts`

- [ ] **Step 1: Remove monitorSymbol from internal route baseline types**

Periodic baseline target:

```ts
export type PeriodicSwitchRouteBaseline = Readonly<{
  direction: 'LONG' | 'SHORT';
  symbol: string;
  seatVersion: number;
  lastSeatActivatedAt: number;
}>;
```

Switch route target:

```ts
export type SwitchWakeupRoute = Readonly<{
  routeKey: SwitchWakeupRouteKey;
  direction: 'LONG' | 'SHORT';
  seatVersion: number;
}>;
```

- [ ] **Step 2: Remove monitorSymbol from switch handoff params**

`SwitchWakeupHandoffParams` is an internal handoff between already single-monitor runtimes. Remove `monitorSymbol` from the handoff payload and validate context identity directly:

```ts
if (params.monitorContext !== deps.monitorContext) {
  throw new Error('[SwitchWakeupRuntime] handoff monitorContext identity mismatch');
}
```

Build `SwitchWakeupRoute` from `{ direction, seatVersion }`. The route key remains `${direction}:${seatVersion}`; only the handoff performs the object-identity check and the route object carries neither monitor context nor monitorSymbol.

- [ ] **Step 3: Narrow TradingRisk route key maps**

Use a symbol lookup for incoming quote resolution plus a direction set solely for in-flight state pruning:

```ts
routesBySymbol: Map<string, TradingRiskRoute>;
activeRouteKeys: Set<'LONG' | 'SHORT'>;
```

Do not keep a second `routesByKey` map that merely mirrors direction information already present in the route.

- [ ] **Step 4: Add route helper only if repeated code remains**

If at least three modules still duplicate key creation, create `src/utils/seat/routeKeys.ts` with the helper shown in Target Internal Contracts. Otherwise leave local helpers in place.

### Task 7: Refactor Risk, Protective Episode, And Recovery State Keys

**Files:**

- Modify: `src/types/risk.ts`
- Modify: `src/core/riskController/dailyLossTracker.ts`
- Modify: `src/core/riskController/unrealizedLossMonitor.ts`
- Modify: `src/core/signalProcessor/riskCheckPipeline.ts`
- Modify: `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts`
- Modify: `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`
- Modify: `src/core/trader/orderMonitor/settlementFlow.ts`
- Modify: `src/core/trader/orderMonitor/recoveryFlow.ts`
- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Modify: `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`
- Modify: `src/services/liquidationCooldown/tradeLogHydrator.ts`
- Test: risk/recovery/protective episode tests

- [ ] **Step 1: Bind DailyLossTracker to unique monitor**

Keep initialization receiving monitor config:

```ts
recalculateFromAllOrders(
  allOrders,
  monitor,
  now,
  protectionBoundaryByDirection,
  relatedTradingSymbols,
);
```

After initialization, internal methods should use direction:

```ts
getLossOffset: (direction: 'LONG' | 'SHORT') => number;
startNewProtectionEpisode: (params: {
  readonly direction: 'LONG' | 'SHORT';
  readonly boundaryExecutedTimeMs: number;
}) => void;
```

`recordFilledOrder` should not accept `monitorSymbol` after settlement attribution has been resolved. Validate monitor/direction in `settlementFlow` or the ownership resolver first, then pass a direction-level filled-order input to `DailyLossTracker`.

Target:

```ts
recordFilledOrder: (input: {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly side: OrderSide;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
  readonly orderId?: string | null;
}) => void;
```

- [ ] **Step 2: Keep protective episode and cooldown internal keys direction-only**

Internal trackers should use direction as the complete state key:

```ts
const key = direction;
```

Tracker methods used by internal callers should accept `direction` only. Recovery and trade-log hydrator methods may validate persisted monitor facts before calling the direction-only tracker, but must not rebuild a combined monitor/direction internal key.

- [ ] **Step 3: Preserve external recovery fact validation**

`loadTradingDayRuntimeSnapshot` and `tradeLogHydrator` remain external/persisted-fact boundaries. They should parse persisted facts, validate any recorded monitorSymbol against the configured monitor, and only then pass direction and timestamps to internal trackers:

```ts
if (parsed.monitorSymbol !== expectedMonitorSymbol) {
  throw new Error(
    `[loadTradingDayRuntimeSnapshot] ${source} monitorSymbol 不匹配唯一配置: ${parsed.monitorSymbol} !== ${expectedMonitorSymbol}`,
  );
}
```

- [ ] **Step 4: Re-check settlement attribution behavior**

For `settlementFlow`, confirm the branch where `recordedExecution !== null && !executionContextReady` currently returns `handled: false`. If the order has positive execution facts and missing monitor/direction attribution, change to fail-fast:

```ts
if (recordedExecution !== null && !executionContextReady) {
  throw new Error(
    `[订单监控] 订单 ${orderId} 存在成交事实但缺少唯一 monitor/direction 归因，阻断结算`,
  );
}
```

Do not silently skip daily loss, cooldown, or protective episode side effects.

- [ ] **Step 5: Keep unrelated external noise ignored**

Orders that cannot be resolved and have no relevant in-day execution facts may continue to be ignored or skipped according to existing ownership rules. The fail-fast rule applies to relevant executed facts that should affect current monitor/direction state.

### Task 8: Split Post-Gate Assembly And Remove Two-Phase Post-Trade Binding

**Files:**

- Modify: `src/app/runtime/createPostGateRuntime.ts`
- Modify: `src/app/runtime/createPostTradeConsistencyRuntime.ts`
- Modify: `src/app/runApp.ts`
- Modify: `src/app/types.ts`
- Optional create only if it replaces real complexity without increasing indirection: `src/app/runtime/createRuntimeQueues.ts`
- Optional create only if it replaces real complexity without increasing indirection: `src/app/runtime/createTradeRiskRuntime.ts`
- Optional create only if it replaces real complexity without increasing indirection: `src/app/runtime/createQuoteRuntimes.ts`

- [ ] **Step 1: Create small local factory functions first**

Inside `createPostGateRuntime.ts`, extract functions without moving files:

```ts
function createRuntimeQueues(): {
  readonly buyTaskQueue: ReturnType<typeof createBuyTaskQueue>;
  readonly sellTaskQueue: ReturnType<typeof createSellTaskQueue>;
  readonly monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
} {
  return {
    buyTaskQueue: createBuyTaskQueue(),
    sellTaskQueue: createSellTaskQueue(),
    monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
  };
}
```

Only move to separate files after this reduces the main factory and tests remain understandable.

- [ ] **Step 2: Bind post-trade deps immediately after monitorContext exists**

Move the binding currently in `runApp` into post-gate creation after `monitorContext` is created:

```ts
postTradeConsistencyRuntime.bindBusinessDeps({
  monitorContext,
  dailyLossTracker,
  liquidationCooldownTracker,
  protectiveLiquidationEpisodeTracker,
});
```

Then remove the binding block from `runApp`.

- [ ] **Step 3: Decide whether `bindBusinessDeps` should remain**

If tests still need delayed binding, keep the method but production should bind in `createPostGateRuntime`. If no legitimate caller needs delayed binding, change `createPostTradeConsistencyRuntime` constructor to receive business deps directly.

- [ ] **Step 4: Extract fatal channel helper**

If duplicated fatal handling remains in `createPostGateRuntime` and `createAsyncRuntime`, introduce a small helper:

```ts
export function createFatalChannel(): {
  readonly handleFatalError: (error: unknown) => void;
  readonly drainFatalError: () => Promise<never>;
};
```

Only introduce this if it removes real duplication; do not add a generic abstraction for one caller.

### Task 9: Remove Configuration Clamp Fallbacks And Example Noise

**Files:**

- Modify: `src/config/trading/utils.ts`
- Modify: `src/config/validator/utils.ts`
- Modify: `tests/config/*.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Replace `parseBoundedNumberConfig` clamp behavior**

Change current “warning and clamp” behavior to fail-fast for explicit invalid values. Keep default only when env key is absent.

Target behavior:

```ts
function parseOptionalFailFastBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  const rawValue = env[envKey];
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw createConfigValidationError(`[配置错误] ${envKey} 必须为 ${min} 到 ${max} 之间的数字`, [
      envKey,
    ]);
  }

  return value;
}
```

- [ ] **Step 2: Apply it to optional bounded configs**

Use fail-fast parsing for:

- `AUTO_SEARCH_EXPIRY_MIN_MONTHS`
- `AUTO_SEARCH_OPEN_DELAY_MINUTES`
- `LIQUIDATION_TRIGGER_LIMIT`

Keep default-on-missing behavior.

- [ ] **Step 3: Remove duplicate example block**

In `.env.example`, delete the second `DOOMSDAY_PROTECTION=true` block so the global section contains it once.

- [ ] **Step 4: Update tests**

Tests should assert explicit out-of-range values throw config validation errors. Do not add indexed key rejection tests.

### Task 10: Simplify Tests And Current Documentation

**Files:**

- Modify or delete: `tests/architecture/typeOrganization.test.ts`
- Modify: `tests/main/asyncProgram/tradeTaskQueue/business.test.ts`
- Modify: `tests/main/asyncProgram/monitorTaskQueue/business.test.ts`
- Modify: `tests/main/asyncProgram/buyProcessor/business.test.ts`
- Modify: `tests/main/asyncProgram/sellProcessor/business.test.ts`
- Modify: `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
- Modify: `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`
- Modify: `tests/main/monitorDisplayRuntime/business.test.ts`
- Modify: `tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts`
- Modify: `tests/main/seatActivationDispatcher/seatActivationDispatcher.business.test.ts`
- Modify: `tests/main/seatRuntimeCleanupDispatcher/business.test.ts`
- Modify: `tests/main/periodicSwitchWakeupRuntime/business.test.ts`
- Modify: `docs/plans/2026-07/2026-07-07-hsi-single-monitor-refactor-plan.md`
- Modify: `README.md`

- [ ] **Step 1: Delete source-regex architecture locks**

Remove tests that only assert absence of old strings or old implementation shapes, for example checks against:

```ts
/Map<string,\s*MonitorContext>/
/monitorContexts/
/多标的支持/
/createMultiMonitor/
```

Keep architecture tests that enforce durable repository rules, such as `types.ts` containing only type declarations, if those rules remain useful.

- [ ] **Step 2: Delete second-monitor task tests**

Remove queue tests that use a second monitor like `TECH.HK` solely to prove monitor grouping. Replace with existing FIFO/remove/clear tests using action, direction, or seatVersion.

- [ ] **Step 3: Merge repeated foreign monitor fail-fast tests**

Keep one representative boundary test per trust boundary:

- external quote event is ignored if event symbol is not the configured monitor;
- trade log or recovery fact with mismatched monitorSymbol fails fast before direction-only tracker hydration;
- order settlement with executed facts but missing attribution fails fast;
- LONG/SHORT duplicate trading symbol fails fast.

Delete display-layer and internal queue-layer mismatch tests after those internals no longer carry monitorSymbol.

- [ ] **Step 4: Update the 2026-07-07 plan as historical**

At the top of `docs/plans/2026-07/2026-07-07-hsi-single-monitor-refactor-plan.md`, add a short note:

```md
> Historical note: this plan describes the initial single-monitor migration. The active follow-up simplification plan is `2026-07-09-hsi-single-monitor-architecture-simplification-plan.md`; where this older document asks to add or retain indexed-key/foreign-monitor regression tests, the newer plan supersedes it.
```

Do not edit historical sections line-by-line unless they are still referenced as current instructions.

### Task 11: Verification And Residual Review

**Files:**

- No planned source edits except fixes required by verification failures.

- [ ] **Step 1: Run formatting**

Run:

```powershell
bun format
```

Expected: command completes without errors. Review changed files because formatting may touch a large dirty tree.

- [ ] **Step 2: Run lint**

Run:

```powershell
bun lint
```

Expected: no lint errors.

- [ ] **Step 3: Run type-check**

Run:

```powershell
bun type-check
```

Expected: no TypeScript errors.

- [ ] **Step 4: Run tests**

Run:

```powershell
bun test
```

Expected: test suite passes. If tests were deleted or merged, confirm the remaining tests still cover behavior, not old implementation shape.

- [ ] **Step 5: Run build**

Run:

```powershell
bun run build
```

Expected: build passes.

- [ ] **Step 6: Run residual scans**

Run:

```powershell
rg -n "tradingConfig\\.monitors|monitorContexts|getMonitorContext|MultiMonitorTradingConfig|originalIndex|MONITOR_SYMBOL_1|MONITOR_SYMBOL_N|collectIndexedMonitorConfigKeys" src tests mock README.md .env.example
rg -n "monitorSymbol" src/main/asyncProgram src/main/monitorQuoteEventRuntime src/main/tradingRiskEventRuntime src/core src/types src/app
rg -n "Map<string,\\s*MonitorContext>|ReadonlyMap<string,\\s*MonitorContext>|routesByMonitor|queuesByMonitor|registryByMonitor|byMonitor" src tests mock README.md .env.example
rg -n "legacy|compat|backward compatible|temporary|transitional|shim|fallback|workaround|兼容|补丁|临时|过渡|兜底|回退" src tests mock README.md .env.example
git diff --check
```

Expected:

- First command has no active code/test/current-doc hits.
- Remaining `monitorSymbol` hits are classified into allowed external boundary/logging/persisted fact cases or unexpected active leftovers requiring follow-up.
- No compatibility/fallback wording remains for this refactor in active code/tests/current docs.
- `git diff --check` reports no whitespace errors.

## Residual Classification Rules

During residual review, classify every remaining monitor-related hit:

| Category | Allowed? | Rule |
| --- | --- | --- |
| config monitor symbol | yes | `TradingConfig.monitor.monitorSymbol` is the single configured monitor. |
| external quote event | yes | Must compare event symbol to configured monitor. |
| order ownership / recovery fact | yes | Must fail fast when relevant facts cannot be attributed. |
| persisted trade log fact | yes | Must validate monitorSymbol before restoring state. |
| logs and display labels | yes | May show configured monitor for operator clarity. |
| SymbolRegistry internal API parameter | no | Use direction-first API. |
| buy/sell task monitor field | no | Queue is single monitor. |
| monitor task monitor field | no | Queue is single monitor; use direction/seatVersion. |
| indicator cache monitor parameter | no | Cache is single monitor. |
| route key including monitorSymbol | no | Internal route is direction or direction+seatVersion. |
| tests proving old multi-monitor absence | no | Delete or convert to behavior tests. |
| indexed config key guards | no | Do not preserve obsolete `_1` / `_N` checks. |

## Self-Review Checklist

- [ ] Spec coverage: registry, queues, cache/verifier, route baselines, risk/recovery, app assembly, config quality, tests/docs, and verification are all covered.
- [ ] No compatibility shell is introduced; no one-element multi-monitor structure is retained as an implementation strategy.
- [ ] No new tests are added solely to block multi-monitor regression.
- [ ] LONG/SHORT direction and seatVersion remain explicit business boundaries.
- [ ] External facts are not silently remapped into HSI.
- [ ] Historical docs are either left historical or explicitly superseded by this plan.
