# 单指数趋势延续重构三次复核问题记录

**日期**：2026-04-01 **复核范围**：`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md` 对应的当前工作区实现；重点覆盖运行时门禁、异步监控队列、浮亏风控契约、因子配置边界、趋势分类语义 **状态说明**：本次为三次复核；只保留“证据充分且必须修复”的问题正式立项，其余候选项单独说明为何不立项

---

## 结论先行

本次三次复核后，以下五项应保留为正式问题：

1. **严格运行时门禁没有传导到异步执行链，盘外仍可继续消费已入队任务，必须修复**
2. **单方向席位退化时会误删双向共享监控任务，保护性检查存在静默丢失风险，必须修复**
3. **`MAX_UNREALIZED_LOSS` 的配置契约与运行时风控口径分裂，必须修复**
4. **`VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS=1` 被校验放行，但会让确认层永久不就绪，必须修复**
5. **趋势分类把“已就绪但震荡”错误编码为 `null` 而不是 `range`，必须修复**

以下候选项经本轮复核后，不作为“已证实且必须修复”的正式问题立项：

1. **`DecisionSnapshot.holdReasons` 未贯通到主链日志**：真实存在，但更准确的定位是可观测性与方案验收完备性缺口，不是当前交易逻辑错误；本轮不按必须修复问题立项
2. **旧 delayed verification 残留字段、单元素数组 API 壳、多处命名残留**：真实存在，但当前更接近架构收尾和类型收敛问题，不构成当前主交易闭环错误；本轮不按必须修复问题立项

补充说明：

1. 当前工作区的 `bun type-check`、`bun lint`、`bun test` 均通过
2. 因此本文件记录的问题都不是基础编译错误，而是业务契约、风控边界、状态机闭环与配置语义问题

---

## 严重问题（必须修复）

### 问题 A：严格门禁未传导到异步执行链，盘外仍可继续消费已入队任务

**严重级别**：严重 **涉及文件**：

- `src/main/lifecycle/dayLifecycleManager.ts:146-149`
- `src/main/mainProgram/index.ts:153-173`
- `src/app/runtime/createAsyncRuntime.ts:84-112`
- `src/app/runtime/createPostGateRuntime.ts:95`
- `src/main/asyncProgram/utils.ts:23-30`
- `src/core/trader/orderExecutor/index.ts:98-106`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:76-94`

#### 业务不变量

对当前单实例、双席位、港股连续交易时段模型来说：

1. 主循环在严格模式下判定 `canTradeNow=false` 后，不应再允许已入队的买卖/换标任务继续提交到真实执行链
2. 生命周期重建门禁与“当前是否处于可交易连续时段”不是同一个概念，不能混用同一布尔值表达
3. `AUTO_SYMBOL_TICK` 一类异步任务不能在盘内入队、盘外消费时继续沿用过期的时段快照

#### 三次复核取证

当前主循环在严格模式下确实会在 `canTradeNow=false` 时提前返回：

1. `mainProgram` 在 `dayLifecycleManager.tick()` 之后，若 `isStrictMode && (!isTradingDayToday || !canTradeNow)`，会直接 `return`
2. 但它不会停止、清空或废弃此前已经入队的异步任务

与此同时，异步执行链的真实门禁并不看实时 session，只看 `lastState.isTradingEnabled`：

1. `createAsyncRuntime()` 中 `monitorTaskProcessor`、`buyProcessor`、`sellProcessor` 的 `getCanProcessTask()` 全都绑定到 `lastState.isTradingEnabled`
2. `createPostGateRuntime()` 中 `createTrader()` 的 `isExecutionAllowed()` 同样只返回 `lastState.isTradingEnabled`
3. `executeSignalsWithLifecycleGate()` 与 `orderExecutor.canExecuteSignal()` 也只消费这一个布尔值

而 `dayLifecycleManager.tick()` 在 `pendingOpenRebuild=false` 时会无条件执行：

1. `mutableState.lifecycleState = 'ACTIVE'`
2. `mutableState.isTradingEnabled = true`

这意味着：

1. 它表达的是“当前不处于重建阻断期”
2. 它并不表达“当前仍在连续交易时段”

#### 最小复现

直接调用当前实现：

```json
{
  "currentDayKey": "2026-04-01",
  "lifecycleState": "ACTIVE",
  "pendingOpenRebuild": false,
  "targetTradingDayKey": null,
  "isTradingEnabled": true
}
```

复现条件是：

1. 初始 `pendingOpenRebuild=false`
2. 初始 `isTradingEnabled=false`
3. 调用 `dayLifecycleManager.tick(..., { isTradingDay: true, canTradeNow: false })`

结果表明：**在 `canTradeNow=false` 的情况下，`isTradingEnabled` 仍会被恢复为 `true`**。

另外，`AUTO_SYMBOL_TICK` 处理器在执行时会使用任务入队时携带的 `data.canTradeNow` / `data.openProtectionActive`，而不是重新读取当前 session 状态。这会放大“盘内入队、盘外消费”的过期快照问题。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

这不是单纯的命名问题，而是严格门禁没有真正闭合到异步执行链。

#### 修复边界

必须把以下两个概念拆开：

1. 生命周期重建门禁
2. 连续交易时段执行门禁

并确保买入、卖出、自动换标、订单执行真实提交点读取的是实时连续交易门禁，而不是仅看 `isTradingEnabled`。

---

### 问题 B：单方向席位退化会误删双向共享监控任务，保护性检查可能静默丢失

**严重级别**：严重 **涉及文件**：

- `src/main/processMonitor/utils.ts:38-50`
- `src/main/processMonitor/utils.ts:80-99`
- `src/main/processMonitor/seatSync.ts:67-99`
- `src/main/processMonitor/riskTasks.ts:61-148`
- `src/main/processMonitor/autoSymbolTasks.ts:68-89`

#### 业务不变量

在双席位模型中：

1. 某一方向席位退化，不应误伤另一方向仍然有效的风险监控任务
2. 共享任务只能在其所依赖的双向快照全部失效时删除，不能因为某一边退化就整体删除
3. `UNREALIZED_LOSS_CHECK` 这类保护任务不能依赖“后续价格变化也许会再补一个”来维持闭环

#### 三次复核取证

`clearMonitorDirectionQueues()` 当前通过 `isMonitorTaskForDirection()` 判断是否删除监控任务：

1. 若 `task.data.direction === direction`，则删除
2. 若 `task.data` 含 `seatSnapshots`，则视为共享任务，也删除
3. 若 `task.data` 同时含 `long` 与 `short`，则视为共享任务，也删除

这会把以下任务统统视为“属于 LONG”或“属于 SHORT”：

1. `AUTO_SYMBOL_SWITCH_DISTANCE`
2. `LIQUIDATION_DISTANCE_CHECK`
3. `UNREALIZED_LOSS_CHECK`

而 `seatSync()` 在 LONG 或 SHORT 从 `ACTIVE` 退化时，会直接调用 `clearDirectionQueues(direction)`。

#### 最小复现

直接向当前队列塞入两个共享任务后，对 `LONG` 执行清理，当前实现输出为：

```json
{
  "result": { "removedDelayed": 0, "removedBuy": 0, "removedSell": 0, "removedMonitorTasks": 2 },
  "queueEmpty": true
}
```

这里被删掉的正是：

1. `UNREALIZED_LOSS_CHECK`
2. `AUTO_SYMBOL_SWITCH_DISTANCE`

#### 为什么这不是“删了也能自动补回来”

`AUTO_SYMBOL_SWITCH_DISTANCE` 往往还能依靠后续 `hasPendingSwitch` 再次调度。

但 `UNREALIZED_LOSS_CHECK` 只在 `marketMonitor.monitorPriceChanges(...)` 返回 `priceChanged=true` 时才重新调度：

1. `scheduleRiskTasks()` 先更新展示与缓存
2. 只有 `priceChanged` 为真，才 `scheduleLatest('UNREALIZED_LOSS_CHECK')`

因此如果 LONG 退化时把共享浮亏任务删掉，而 SHORT 当下没有新的价格变化，那么 SHORT 一侧本该继续存在的浮亏保护检查会直接丢失。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

这属于保护性风控闭环问题，不是日志或清理策略偏好问题。

#### 修复边界

必须收敛为以下两种方向之一：

1. 只删除真正引用失效席位快照的任务
2. 将当前依赖双边快照的共享任务拆成方向级任务，避免一边席位退化误删另一边保护任务

---

### 问题 C：`MAX_UNREALIZED_LOSS` 的配置契约与运行时风控口径分裂

**严重级别**：严重 **涉及文件**：

- `src/types/config.ts:286-287`
- `src/constants/index.ts:61-62`
- `src/config/validator/index.ts:775-776`
- `src/config/validator/index.ts:938`
- `src/config/trading/runtime.ts:112`
- `src/app/buildStrategyRuntime.ts:45-50`
- `src/app/buildStrategyRuntime.ts:73-75`
- `src/core/riskController/unrealizedLossChecker.ts:32-34`
- `src/core/riskController/unrealizedLossMonitor.ts:39-40`

#### 业务不变量

这里真正需要被修复的，不是“变量名不好看”，而是**配置契约与运行时 enforcement 口径必须一致**。

当前系统对外暴露的是：

1. 配置项名 `MAX_UNREALIZED_LOSS`
2. 文档/类型注释/启动日志文案都是“单实例最大浮亏”

这会向使用者传达一个明确语义：**它约束的是整个单实例程序的浮亏边界**。

如果实现上想表达的是“每个执行标的各自一条阈值”，那也可以，但必须同步改配置名、日志名、类型名与文档口径；不能继续让外部看到“单实例总阈值”，内部却按“每个 symbol 各自阈值”执行。

#### 三次复核取证

对外契约侧：

1. `TradingConfig.strategy.maxUnrealizedLoss` 注释为“单实例最大浮亏”
2. 常量默认值注释也是“默认单实例最大浮亏”
3. `validator` 日志输出明确写“单实例最大浮亏”

运行时侧：

1. `createStrategyRuntimeConfigFromTradingConfig()` 把它投影成 `maxUnrealizedLossPerSymbol`
2. `buildStrategyRuntime()` 把该值分别注入 `createUnrealizedLossChecker()` 与 `createUnrealizedLossMonitor()`
3. `unrealizedLossChecker` 与 `unrealizedLossMonitor` 都按 symbol 独立缓存和独立检查

#### 最小反例

以阈值 `500 HKD` 为例：

1. `BULL.HK` 浮亏 `-400`
2. `BEAR.HK` 浮亏 `-400`
3. 实例总浮亏已经达到 `-800`

直接调用当前实现，输出为：

```json
{ "bull": { "shouldLiquidate": false }, "bear": { "shouldLiquidate": false }, "combinedLoss": -800 }
```

这说明当前行为是：

1. 每个 symbol 单独看是否小于 `-500`
2. 不会对“实例总浮亏已经超过 `500`”作出反应

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

#### 修复边界

这里允许两种修复方向，但必须二选一，不能继续维持当前分裂状态：

1. **按当前对外契约修实现**：真正收敛为单实例总浮亏阈值
2. **按当前实现修契约**：明确改名为 `MAX_UNREALIZED_LOSS_PER_SYMBOL` 或其他等价语义，并同步修正文档、日志、类型与校验边界

当前最不能接受的状态，就是继续保留“对外说单实例总阈值，内部实际按 per-symbol 执行”。

---

### 问题 D：`VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS=1` 被校验放行，但会让确认层永久不就绪

**严重级别**：严重 **涉及文件**：

- `src/config/validator/index.ts:423-429`
- `src/services/factors/runtime/sessionVwap.ts:26-32`
- `src/services/factors/runtime/utils.ts:411-414`
- `src/services/factors/runtime/intradayMomentum.ts:115-123`
- `tests/services/factors/runtime/index.business.test.ts:350-389`
- `docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:559`

#### 业务不变量

对这条配置来说，fail-fast 校验必须拒绝“语义上不可能满足”的值。

如果某个配置值一旦被接受，就会使对应因子永远处于 not-ready 状态，那么它就不应被视为有效配置。

#### 三次复核取证

当前校验器只要求：

1. `slopeWindowBars` 是整数
2. `slopeWindowBars > 0`

而运行时计算链路是：

1. `sessionVwap` 把 `slopeWindowBars` 归一化为至少 `1`
2. `computeSlope(values)` 在 `values.length < 2` 时返回 `null`
3. `computeReadiness()` 又把 `activeSessionVwapSlope !== null` 作为 `confirmationReady` 的硬前提

因此：

1. `slopeWindowBars=1` 会生成单点窗口
2. 单点窗口的斜率恒为 `null`
3. `confirmationReady` 因而永远为 `false`

#### 已有证据

现有业务测试已经覆盖了“窗口为 1 时 slope 为 `null`”：

1. `tests/services/factors/runtime/index.business.test.ts:350-389`
2. 其中 `singlePointSnapshot?.vwap.activeSessionVwapSlope` 明确断言为 `null`

这说明后半段行为已经被现有测试直接证明。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

#### 修复边界

校验器至少应将 `VWAP_CONFIRM_RULES_SLOPE_WINDOW_BARS` 收敛为：

1. 正整数
2. 且 `>= 2`

不能继续接受一个会让确认层永久不可达的配置值。

---

### 问题 E：趋势分类把“已就绪但震荡”错误编码为 `null`，而不是 `range`

**严重级别**：严重 **涉及文件**：

- `docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:264`
- `docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:386`
- `src/types/factor.ts:24`
- `src/services/factors/runtime/trendClassifier.ts:110-124`
- `src/services/factors/runtime/intradayMomentum.ts:100-105`
- `src/services/factors/runtime/entryDecision.ts:73-77`
- `src/services/factors/runtime/entryDecision.ts:174-177`

#### 业务不变量

趋势分类和 readiness 是两个不同维度：

1. readiness 回答的是“样本和前置因子是否已就绪”
2. trend classification 回答的是“就绪后当前属于上行、下行还是震荡”

按当前方案，趋势分类的合法值只有：

1. `trend_up`
2. `trend_down`
3. `range`

`null` 只能表示“尚未就绪或无有效分类输入”，不能拿来表示“已就绪但震荡”。

#### 三次复核取证

方案文档已明确规定：

1. 至少 `2/3` 窗口同号
2. `|TrendScore|` 达阈值
3. 满足则输出 `trend_up / trend_down`，否则输出 `range`

但当前实现是：

1. 若 `trendScore === null`，返回 `null`
2. 若 `momentum.sameSignCount < 2`，也直接返回 `null`
3. 只有在 `sameSignCount >= 2` 且 `|trendScore| < threshold` 时才返回 `range`

与此同时，`computeReadiness()` 对 `trendReady` 的判定并不要求 `sameSignCount >= 2`，只要求：

1. `trendBars` 足够
2. `trendScore` / `trendScore5m` / `trendScore15m` 非空

因此系统会出现一种不一致状态：

1. `trendReady=true`
2. `trendClassification=null`

#### 最小复现

直接调用当前实现：

```json
{ "result": null }
```

复现条件是：

1. `trendScore=1.2`
2. `threshold=0.8`
3. `sameSignCount=1`

这说明当前代码把“评分已算出、但三窗口同号不足 `2/3`”当成了 `null`，而不是 `range`。

#### 影响

这会直接影响：

1. `FactorSnapshot.trendClassification` 的语义稳定性
2. `entryDecision` 中的拒绝原因文本，当前会变成 `trend=null`
3. 因子日志与后续分析，把“未就绪”与“已就绪但震荡”混成同一状态

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

#### 修复边界

必须保证：

1. `trendScore === null` 时返回 `null`
2. `trendScore !== null` 且分类条件不满足时返回 `range`

不能继续把“已就绪但不成趋势”编码为 `null`。

---

## 已排除或暂不立项的问题

### X1：`DecisionSnapshot.holdReasons` 未贯通到主链日志

#### 三次结论

**本轮不作为“已证实且必须修复”的正式问题立项。**

#### 原因

这条问题真实存在：

1. `signalPlanner` 会构造 `holdReasons`
2. `core/strategy/index.ts` 只把 `actions` 转成 signal，丢掉了 `holdReasons`
3. 方案验收项也写到“日志能明确说明信号被拦截在 `regime / trend / structure / confirmation / instrumentAdaptation` 的哪一层”

但从当前业务闭环看：

1. 它不改变开仓/平仓结果
2. 它不造成资金风险边界失效
3. 它更准确地属于可观测性与方案完备性缺口

因此本轮不按“必须修复”的逻辑缺陷正式立项。

---

### X2：旧 delayed verification 残留字段、单元素数组 API 与命名残留

#### 三次结论

**本轮不作为“已证实且必须修复”的正式问题立项。**

#### 原因

以下问题都是真实存在的：

1. `Signal.indicators1` / `Signal.verificationHistory` 仍保留
2. `createSymbolRegistry([monitorConfig])` / `collectRuntimeQuoteSymbols([monitorConfig])` 仍保留单元素数组外形
3. 多处注释与局部命名仍保留 `monitor*` 历史表面

但本轮更准确的定位是：

1. 它们说明重构没有完全收尾
2. 它们增加阅读成本和类型边界噪音
3. 但当前没有证据表明它们已经破坏主交易逻辑、风险边界或 fail-fast 配置契约

因此本轮不按“必须修复”的正式问题立项。

---

## 建议的修复顺序

1. 先修问题 A，因为它直接关系到严格门禁是否真的覆盖到异步执行链
2. 再修问题 B，因为它会导致保护性检查静默丢失
3. 再修问题 C，因为它关系到浮亏风险边界的对外契约与内部 enforcement 是否一致
4. 再修问题 D，因为它属于 fail-fast 配置边界错误，会让策略在合法配置表象下永久 not-ready
5. 最后修问题 E，因为它会污染趋势分类语义、拒绝原因与因子解释链路

---

## 附：问题优先级汇总

| 编号 | 问题                                         | 级别   | 是否必须修复 |
| ---- | -------------------------------------------- | ------ | ------------ |
| A    | 严格门禁未传导到异步执行链                   | 严重   | 是           |
| B    | 单方向席位退化误删共享监控任务               | 严重   | 是           |
| C    | `MAX_UNREALIZED_LOSS` 契约与执行口径分裂     | 严重   | 是           |
| D    | `slopeWindowBars=1` 被放行但会永久阻断确认层 | 严重   | 是           |
| E    | 趋势分类把震荡态错误编码为 `null`            | 严重   | 是           |
| X1   | `holdReasons` 未贯通主链日志                 | 不立项 | 否           |
| X2   | 旧字段/API/命名残留                          | 不立项 | 否           |
