# HSI 单监控标的全链路业务审查问题记录

- **审查日期**：2026-07-11
- **审查对象**：当前工作树中的 HSI 单监控标的重构版本
- **审查方式**：只读、第一性原理、多个独立审查代理并行复核
- **业务基准**：`.codex/skills/core-program-business-logic/SKILL.md`
- **代码规范基准**：`.codex/skills/typescript-project-specifications/SKILL.md`
- **审查状态**：19 项原始 finding 与第一次完全重构后复核确认的 R1-C-01、R1-M-01 至 R1-M-05 均已完成实现、定向复核和 fresh 全仓验证；本结论只关闭已确认的 R1 finding，不宣告仓库全局 Minor 为零
- **代码修改**：原始审查阶段与第一次完全重构后复核均保持只读；其后分别完成 19 项原始 finding 与 R1 finding 的结构性修复

---

## 1. 执行摘要

当前程序已经从多监控标的并行结构收敛为：

- 唯一监控标的：HSI。
- 唯一 `MonitorContext`。
- LONG / SHORT 两个相互隔离的交易席位。
- 按席位方向、订单标的和异步 route 管理必要的运行态。

精确残留扫描没有发现仍在生产或测试代码中生效的多 monitor 配置集合、索引路由或运行时注册表。单监控标的外层架构方向正确，主要结构已经收敛。

全链路审查共确认 **19 项真实且需要修复的问题**。这些 finding 不是同一种性质：一部分已能由生产调用链直接触发运行缺陷，另一部分是公共类型、状态或最终副作用边界允许非法组合的结构风险。二者都需要修复，但不能把“结构上可构造”夸大为“生产已经触发”。

| 严重级别 | 数量 | 结论                                                           |
| -------- | ---: | -------------------------------------------------------------- |
| Critical |    4 | 可能直接造成真实订单孤儿、换标永久停摆、恢复漏单或成交事实倒退 |
| Major    |   11 | 破坏寻标存活性、时间门禁、日亏分段、类型不变量或关键业务契约   |
| Minor    |    4 | 已确认的状态镜像、排序、身份表达及审查文档残留                 |
| 合计     |   19 | 均经过第二轮确认并已完成修复                                   |

原始审查时全量测试虽为 `1133 pass / 0 fail`，但多项测试在反向固化错误语义，因此当时的“测试全绿”不能证明业务不变量成立。这一判断仍具有审计价值；相关错误期望现已被结构性实现和直接业务测试替换。

截至 2026-07-12，19 项原始 finding 已完成第一轮结构性修复；第一次完全重构后复核确认的 **1 项 Critical、5 项 Major** 也已完成后续结构修复并取得 fresh 全仓验证证据。历史 finding、发现时证据与修复必要性继续保留，当前关闭状态和结论边界以第 14 节为准。

### 1.1 19 项原始 finding 的第一轮修复状态

下表记录 19 项原始 finding 在第一轮结构性修复后的状态。第 4 至第 6 节保留 finding 被发现时的证据、触发链和修复建议，用于审计“为什么必须修”；其中旧行号只代表发现时快照，不应当作当前源码导航。第一次完全重构后复核发现的新增或残余问题见第 14 节。

| Finding | 性质 | 最终状态 | 主要结构修复 | 当前验证入口 |
| --- | --- | --- | --- | --- |
| C-01 | 可触发运行缺陷 | 已修复 | 换标 admission 在进入 `SWITCHING` 前完成失败型读取；mutation 后始终交接非空 `WAIT` owner | `tests/services/autoSymbolManager/switchStateMachine.business.test.ts` |
| C-02 | 可触发运行缺陷 | 已修复 | API 前授权只决定是否发请求；broker ack 后无条件承认远端订单事实并维持占用/追踪连续性 | `tests/core/trader/orderMonitor/routeProcessor.business.test.ts` |
| C-03 | 可触发运行缺陷 | 已修复 | 以 `classifyOrderStatusLifecycle` 统一穷尽开放/终态分类 | `tests/core/orderStatusLifecycle.test.ts`、`tests/core/trader/orderMonitor/recoveryFlow.business.test.ts` |
| C-04 | 可触发运行缺陷 | 已修复 | `orderFactMerge` 统一执行时间、累计成交量、状态生命周期和终态单调合并 | `tests/core/trader/orderMonitor/eventFlow.business.test.ts`、`tests/chaos/websocket-out-of-order.test.ts` |
| M-01 | 可触发运行缺陷 | 已修复 | 自动寻标 route 释放 active owner 后按权威 EMPTY 状态重排唯一 cooldown owner | `tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts` |
| M-02 | 可触发运行缺陷 | 已修复 | 无候选、输入构造异常和外部请求失败共用失败计数/冻结状态转换 | `tests/services/autoSymbolManager/autoSearch.business.test.ts`、`tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts` |
| M-03 | 可触发运行缺陷 | 已修复 | 最终 `submitOrder.beforeApi` 授权重新读取当前时间和当日交易日事实 | `tests/integration/buy-flow.integration.test.ts` |
| M-04 | 可触发运行缺陷 | 已修复 | 保护性清仓 progress 与 completion 分离；仅业务完成点持久化 completion | `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`、`tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` |
| M-05 | 可触发运行缺陷 | 已修复 | DailyLoss 以 per-order 累计事实和持久化 baseline 幂等推进，不再重复累计全量成交 | `tests/core/riskController/dailyLossTracker.segment.business.test.ts`、`tests/integration/orderMonitorDailyLossMonotonic.integration.test.ts` |
| M-06 | 可触发运行缺陷 | 已修复 | 保护边界采用 prepare/commit baseline，保留边界后的合法累计成交 | `tests/core/riskController/dailyLossTracker.segment.business.test.ts` |
| M-07 | 可触发运行缺陷 | 已修复 | 订单动作使用 `SUBMITTED / REPLACED / SKIPPED`，成功改单返回既有 orderId | `tests/integration/sell-flow.integration.test.ts`、`tests/types/traderExecutionResult.type.test.ts` |
| M-08 | 结构风险，含静态 bootstrap 合法例外 | 已修复 | `SeatState` 改为判别联合；公共运行时写入严格校验，静态标的初始 ACTIVE 仅保留窄 bootstrap 成员 | `tests/types/seat.type.test.ts`、`tests/services/autoSymbolManager/utils.business.test.ts` |
| M-09 | 未发现生产非法构造的结构存活性风险 | 已修复 | `WAIT` 使用非空 tuple；start/advance 结果以判别联合绑定 `stillPending`，runtime 再次 fail-fast | `tests/types/monitorContextPorts.type.test.ts`、`tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts` |
| M-10 | 结构风险 | 已修复 | 交易日历改为 required，删除消费者空 `Map` 回退，装配缺失直接失败 | `tests/types/state.type.test.ts`、`tests/app/context/createMonitorContext.business.test.ts` |
| M-11 | 结构风险 | 已修复 | 风控接口收窄到 `BuySignal`，删除卖出兼容分支和缓存表面 | `tests/types/signalProcessor.type.test.ts`、`tests/core/signalProcessor/riskCheckPipeline.business.test.ts` |
| m-01 | 结构冗余 | 已修复 | 删除 `MonitorState.signal` 与 `pendingDelayedSignals` 镜像 | `tests/types/state.type.test.ts`、残留扫描 |
| m-02 | 可触发确定性缺陷 | 已修复 | 恢复分配与智能平仓共用 `price → executedTime → orderId` 排序策略 | `tests/core/orderRecorder/getSellableOrders.test.ts`、`tests/core/orderRecorder/sellDeductionPolicy.test.ts` |
| m-03 | 未发现生产分叉的最终边界结构风险 | 已修复 | `ExecutableOrderCommand` 一次固化 action、symbol、direction、side、seatVersion 与关联买单身份 | `tests/integration/buy-flow.integration.test.ts`、`tests/integration/sell-flow.integration.test.ts` |
| m-04 | 文档治理缺陷 | 已修复 | 旧 review/recheck 标记为历史快照并由本文取代，不再作为当前源码事实 | `docs/plans/2026-07/2026-07-11-hsi-single-monitor-review-and-recheck.md` |

### 1.2 共享根因与主要结构修复

19 项并非 19 个互不相关的偶然错误，主要来自五类共享根因：

1. **把本地授权误当成远端事实是否存在的开关**：典型为 C-02。修复后，授权只能阻止 API 前的新 mutation，broker 已接受的 orderId 必须进入本地事实链。
2. **不可逆 mutation 与后续 owner 没有组成一个状态转换**：典型为 C-01、M-01、M-09。修复后，所有 pending 状态都必须由订单事件、行情、新鲜度或 retry timer 中至少一个 owner 接管。
3. **累计事实、业务完成点和持久化边界混为一体**：典型为 C-04、M-04、M-05、M-06。修复后，订单事实按单调累计模型合并，保护性清仓 progress/completion 分离，并以可恢复 baseline 跨越崩溃窗口。
4. **同一业务身份被多个可独立分叉的字段重复表达**：典型为 M-07、M-08、M-10、M-11、m-03。修复后使用判别联合、required 事实和单一 `ExecutableOrderCommand` 收紧边界，不保留兼容壳。
5. **只在异步链路前段检查时间或状态**：典型为 M-03。修复后在最终不可逆 API 前重新授权，避免 await 之后继续沿用过期许可。

这些修复没有恢复多 monitor 抽象，也没有用 silent fallback、别名或兼容 wrapper 吸收错误输入。

---

## 2. 审查范围与方法

### 2.1 审查范围

本轮从真实生产入口和运行时装配向下追踪，覆盖：

1. 配置读取、配置验证与唯一 monitor 契约。
2. 启动快照、生命周期状态机、午夜清理与开盘重建。
3. 席位恢复、自动寻标、席位激活、距离换标和周期换标。
4. K 线事件、指标增量计算、策略信号生成和延迟验证。
5. 买入/卖出任务队列、席位版本隔离、风险检查和最终下单。
6. 订单提交、改单、撤单、超时转市价和待成交卖单占用。
7. 启动订单恢复、私有订单 WS、订单状态推进和终态结算。
8. 成交后账户/持仓刷新、日内亏损、浮亏、保护性清仓和冷却。
9. 末日拒买、末日撤单、末日清仓和有限重试边界。
10. TypeScript 类型不变量、项目规范、注释、死代码和兼容壳。
11. 生产入口与测试语义是否一致。
12. 多 monitor 重构残留、静默回退和错误降级。

### 2.2 多代理分工

三个独立审查代理并行处理以下领域，随后由主审交叉复核：

| 审查代理 | 第一轮负责范围 | 第二轮专项 |
| --- | --- | --- |
| 生命周期/寻标代理 | 启动、重建、自动寻标、距离/周期换标、席位激活 | 类型设计、注释与文档契约 |
| 信号/执行代理 | 信号生成、延迟验证、买卖分流、末日门禁、最终提交 | 项目规范、代码简化 |
| 订单/风险代理 | OrderRecorder、OrderMonitor、恢复、结算、日亏、浮亏、冷却 | 测试覆盖、死代码 |

### 2.3 正式问题认定标准

每项候选必须同时满足：

1. 能从当前生产调用链或公开类型契约中定位。
2. 与业务 skill、配置契约或状态不变量存在明确冲突。
3. 已回查上下游消费者和异步 owner。
4. 已通过静态检查、现有测试、无写入最小复现或定向测试进行第二轮确认。
5. 具有明确业务影响或结构性风险。
6. 存在真实修复必要性。

纯代码风格偏好、无法触发的猜测以及没有修复价值的事项未列为正式问题。

---

## 3. 当前实际业务全链路

### 3.1 启动和重建

1. 入口读取并验证唯一 `tradingConfig.monitor`。
2. 装配 Longbridge 行情、交易和账户访问上下文。
3. 加载账户、持仓、历史/当日订单、席位、交易日历和风险快照。
4. 重建 OrderRecorder、DailyLossTracker、冷却、席位归属和订单追踪。
5. 空席位根据自动寻标规则尝试补齐；命中后先进入 `ACTIVATING`。
6. 行情准入、订单和风险缓存刷新完成后才进入 `ACTIVE`。
7. 任一关键重建步骤失败时保持交易门禁关闭，由生命周期唤醒链路安排后续恢复。

### 3.2 信号生成和执行

1. HSI 一分钟线事件推进增量指标。
2. 策略生成即时信号或延迟验证信号。
3. `DelayedSignalVerifier` 持有延迟信号及验证样本。
4. 验证通过后再次检查交易门禁、席位状态、标的和 `seatVersion`。
5. 买入信号进入买入处理器，依次执行频率、冷却、价格、末日、牛熊证、账户和持仓检查。
6. 卖出信号等待成交后一致性刷新，再按持仓、OrderRecorder 和智能平仓规则计算卖量。
7. 买卖双方均在最终执行阶段重新读取行情，并在真正提交前再次检查生命周期和席位授权。

### 3.3 订单和结算

1. OrderExecutor 决定 SUBMIT、REPLACE、CANCEL_AND_SUBMIT 或 SKIP。
2. 卖单提交时在 OrderRecorder 中登记关联买单占用。
3. OrderMonitor 通过私有订单 WS 推进开放订单状态。
4. 完全成交、部分成交后撤单/拒单等终态进入 settlementFlow。
5. 结算更新买卖账本、pending-sell 占用、日亏状态和保护性清仓进度。
6. 成交后刷新账户和持仓，确认保护性清仓 episode 是否真正完成。

### 3.4 风险和保护

1. 买入风险按业务 skill 固定顺序执行。
2. 浮亏 runtime 根据 OrderRecorder、当前价格和日亏偏移计算保护阈值。
3. 保护性清仓提交后并不立即视为业务完成。
4. 只有最新持仓为空且不存在待成交保护性卖单时，才推进清仓完成、冷却和新亏损分段。
5. 收盘前 15 分钟拒绝新买入并检查未成交买单；前 5 分钟执行末日清仓。

### 3.5 自动寻标和换标

1. EMPTY 席位由 AutoSearchWakeupRuntime 驱动寻标。
2. 命中新标的后进入 ACTIVATING，再经刷新进入 ACTIVE。
3. ACTIVE 席位可因距回收价越界或周期到期进入 SWITCHING。
4. 换标状态机按撤单、移仓卖出、绑定新标的、激活、必要时回补的顺序推进。
5. 尚未完成的换标必须始终由订单事件、行情事件、新鲜度、重试 timer 或其他显式 owner 持有。

---

## 4. Critical 问题

### C-01：换标在进入 SWITCHING 后遇到外部 API 失败会永久失去 owner

**严重级别**：Critical **涉及文件**：

- `src/services/autoSymbolManager/switchStateMachine.ts:544-578`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:158-173`
- `src/main/periodicSwitchWakeupRuntime/index.ts:171-179`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:688-713`

#### 触发条件

1. 席位原本为 ACTIVE。
2. 换标已找到候选。
3. `enterSwitchingSeat()` 已将席位切为 SWITCHING 并提升版本。
4. `switchStates` 已写入 `CANCEL_PENDING` 状态。
5. 紧接着的 `trader.getPendingOrders()` 抛出外部 API 错误。

#### 业务影响

- 原 AUTO_SYMBOL_TICK 或行情 owner 因异常没有取得 `WAIT` 结果。
- SwitchWakeupRuntime 没有收到 handoff。
- PeriodicSwitchWakeupRuntime 因席位已非 ACTIVE，读取不到有效 baseline。
- quote 驱动的距离换标入口也只从 ACTIVE 席位启动。
- 最终留下 `SWITCHING + switchState`，但没有订单、行情、新鲜度或 timer owner，换标永久悬挂。

#### 根因

不可逆状态 mutation 位于首次失败型外部 API 调用之前，而异常路径没有：

- 原子回滚。
- 明确失败终态。
- 延迟重试 owner。
- 强制生成 `WAIT` handoff。

#### 二次确认

使用 deferred/throwing `getPendingOrders` 在 mutation 后注入异常，确认：

- seat status 为 SWITCHING。
- seatVersion 已提升。
- switchState 仍存在。
- SwitchWakeupRuntime 中没有 route。
- 周期 route 因 ACTIVE baseline 失效而不再重新安排。

现有换标测试覆盖候选查询期间版本变化、撤单失败和卖出/回补异常，但没有覆盖该 mutation 后首次 API 异常。

#### 修复必要性

这是换标状态机的存活性不变量。状态机进入 pending 后必须存在且只能存在一个可继续推进的 owner，因此必须修复。

#### 建议修复方向

- 将“进入 SWITCHING + 创建 switchState + 建立下一步 owner”设计为同一原子状态转换。
- mutation 后发生外部 API 异常时，返回带重试 timer 或 freshness owner 的 `WAIT`。
- 若业务选择回滚，应同时清除 switchState、恢复合法 SeatState 并重新建立周期/行情 owner。
- 增加距离换标和周期换标两类 mutation 后异常测试。

---

### C-02：经纪商已接受的超时转市价卖单可能被本地故意遗弃

**严重级别**：Critical **涉及文件**：

- `src/core/trader/orderMonitor/routeProcessor.ts:433-501`
- `tests/core/trader/orderMonitor/routeProcessor.business.test.ts:1027-1108`

#### 触发条件

1. 超时卖单已进入转市价流程。
2. 市价单 `submitOrder()` 请求已发出。
3. 请求在途期间 runtime stop 或 route generation 发生变化。
4. 经纪商成功接受订单并返回真实新 orderId。
5. 返回后的 `canCommitTimeoutMarketConversion()` 判断为 false。

#### 业务影响

- 旧 pending-sell 占用被释放。
- 已被 broker 接受的新市价卖单不进入 OrderRecorder。
- 新订单不进入 OrderMonitor 追踪。
- 后续卖出决策可能再次选择同一批买单。
- 真实成交可能无法完成本地结算、日亏和持仓账本更新。

#### 根因

代码将“当前 route 是否仍允许发起新的外部 mutation”错误地应用于“已经发生的远端订单事实是否应被本地承认”。

一旦 broker 返回真实 orderId，远端事实不可撤销，不能再按 generation 变化丢弃。

#### 二次确认

现有两个测试明确断言：

- broker 接受新市价单。
- 本地 `trackedOrders=[]`。
- 本地 `pendingSell=[]`。

因此当前测试不是遗漏，而是在反向固化错误语义。

#### 修复必要性

该问题可直接产生未追踪真实订单和超量卖出风险，必须修复。

#### 建议修复方向

- generation/stop 检查只允许阻止 API 请求发出前的动作。
- API 成功返回 orderId 后，先记录远端事实、恢复 pending-sell 连续占用并进入 OrderMonitor。
- 本地同步失败时进入 fatal/恢复通道，但不得删除远端事实。
- 测试分别覆盖 API 前 stale、API 在途 stop、返回后 commit 和本地同步失败。

---

### C-03：四种有效开放订单状态未进入启动恢复链路

**严重级别**：Critical **涉及文件**：

- `src/constants/index.ts:250-260`
- `src/core/orderRecorder/utils.ts:170-205`
- `src/core/trader/orderMonitor/recoveryFlow.ts:354-375`
- `src/core/orderRecorder/orderApiManager.ts:71-90`

#### 遗漏状态

- `OrderStatus.NotReported`
- `OrderStatus.ReplacedNotReported`
- `OrderStatus.ProtectedNotReported`
- `OrderStatus.VarietiesNotReported`

#### 触发条件

程序启动或开盘重建时，权威订单快照中存在上述任一开放状态的买单或卖单。

#### 业务影响

- `classifyOrdersForRebuild` 将其当成非 pending 状态直接忽略。
- `recoverOrderTrackingFromSnapshot` 不恢复追踪。
- 开放卖单不恢复 pending-sell 防重占用。
- 买单可能无法按不匹配恢复规则撤销。
- 后续智能平仓、超时管理和订单事实可能与 broker 不一致。

#### 根因

`PENDING_ORDER_STATUSES` 是手工维护的非穷尽集合，没有和 SDK 完整 OrderStatus 枚举建立单一分类来源。

#### 二次确认

`orderApiManager.ts` 已明确把四个状态识别为有效 SDK OrderStatus，证明它们不是无效输入；但恢复测试中四个状态均为零命中。

#### 修复必要性

启动恢复必须覆盖所有开放订单状态，否则程序无法保证 pending-sell 防重和订单追踪连续性，必须修复。

#### 建议修复方向

- 建立开放、终态和未知状态的单一穷尽分类器。
- 恢复分类器和 OrderMonitor 统一使用该分类结果。
- 增加覆盖 SDK 全部 OrderStatus 的表驱动测试。
- `Unknown` 或未来未识别状态应 fail-fast，而非静默忽略。

---

### C-04：ACTIVE 订单 WS 允许累计成交事实倒退

**严重级别**：Critical **涉及文件**：

- `src/core/trader/orderMonitor/eventFlow.ts:43-85`
- `tests/chaos/websocket-out-of-order.test.ts:68`

#### 触发条件

仍处于开放生命周期的订单先收到较新事件，例如：

- `PartialFilled, executedQuantity=50, updatedAt=200`

随后收到旧事件，例如：

- `PartialFilled, executedQuantity=20, updatedAt=100`
- 或旧的 `New` 状态。

#### 业务影响

- `executedQuantity` 从 50 回退到 20。
- `status` 和 `lastExecutedTimeMs` 可回退。
- pending-sell 的已成交数量被改小。
- 后续剩余卖量、超时转市价数量或 REPLACE 数量可能被放大。
- 最坏情况下形成超量卖出。

#### 根因

`handleOrderChangedWhenActive` 无条件覆盖 tracked order，没有校验：

- 更新时间单调性。
- 累计成交量单调性。
- 开放状态的合法前进顺序。
- 终态不可回退。

#### 二次确认

无写入最小复现确认 `50@200 → 20@100` 后本地 quantity 变为 20。

现有名为 websocket out-of-order 的 chaos 测试只覆盖订单已经终态删除后收到旧事件，没有覆盖订单仍为 OPEN 时的乱序。

#### 修复必要性

累计成交是订单系统的权威单调事实，回退会直接破坏卖量与结算，必须修复。

#### 建议修复方向

- 拒绝 updatedAt 更旧的开放事件。
- 累计成交量不得递减。
- 对相同时间的事件制定确定性合并规则。
- 明确开放状态转换表。
- 终态订单不得回到开放状态。

---

## 5. Major 问题

### M-01：正常“无候选”结果不会安排下一次自动寻标

**涉及文件**：

- `src/services/autoSymbolManager/autoSearch.ts:124-152`
- `src/main/autoSearchWakeupRuntime/index.ts:204-243`

**触发条件**：一次正常寻标执行完成，但 `findBestWarrant` 返回 null。

**业务影响**：SEARCHING 同步写回 EMPTY 时，同 route 仍在 `activeRouteKeys`，EMPTY 事件被忽略；finally 删除 route key 后没有安排 cooldown timer。若无其他 gate 或 seat 事件，该方向永久停止寻标。

**根因**：runtime 只为 API 异常安排 timer，没有为正常无候选结果重新读取权威状态并补排 owner。

**二次确认**：静态调用链确认成功返回后没有 replan；现有 8 个 AutoSearchWakeupRuntime 测试没有真实无候选 timer 场景。

**修复必要性**：EMPTY 席位的自动寻标存活性由该 runtime 负责，必须修复。

**建议修复方向**：route 完成后重新读取 SeatState；若同版本仍 EMPTY 且未冻结，按冷却时间安排一次性 timer。

---

### M-02：自动寻标 API 异常不累计失败次数，也不会触发当日冻结

**涉及文件**：

- `src/services/autoSymbolManager/autoSearch.ts:91-121`
- `src/main/recovery/seatPreparation.ts:169-184,221-241`
- `tests/main/autoSearchWakeupRuntime/autoSearchWakeupRuntime.business.test.ts:275-335`

**触发条件**：候选输入构造或候选 API 查询抛出外部请求错误。

**业务影响**：异常可无限重试且永不达到 `maxSearchFailuresPerDay`，违反业务 skill 明确规定的“未找到候选与寻标执行异常均进入失败计数”。

**根因**：异常 catch 原样保留 `searchFailCountToday` 和冻结标记，仅依赖 timer 重试。

**二次确认**：现有测试明确要求异常不得推进失败计数或冻结。

**修复必要性**：失败冻结是自动寻标的业务边界，不是实现偏好，必须修复。

**建议修复方向**：无候选和执行异常共用失败状态转换；仅未真正执行寻标的门禁、开盘延迟等场景不计数。

---

### M-03：买入可以跨越末日保护截止时间后继续提交

**涉及文件**：

- `src/main/asyncProgram/buyProcessor/index.ts:143-210`
- `src/core/signalProcessor/riskCheckPipeline.ts:217-255`
- `src/core/trader/orderExecutor/submitFlow.ts:155-169`

**触发条件**：

1. 正常日 15:44:59.900 或半日市 11:44:59.900 通过末日拒买检查。
2. 随后的实时账户、持仓、执行行情或 rate limiter 等 await 跨过截止时间。
3. 最终 `submitOrder` 在截止后执行。

**业务影响**：

- 15 分钟拒买窗口内仍产生新买单。
- 原文进一步推断“迟到订单可能永远不会再被取消”的影响过强：系统级时间唤醒仍会重评估末日保护，当前证据只足以确认“最终提交越过强制截止边界”，不把后续撤单永久遗漏列为已证实后果。

**根因**：末日时间授权只在 risk pipeline 中检查一次，最终不可逆 API mutation 前没有重新验证。

**二次确认**：可控时钟无写入复现确认订单在 15:45:01 进入提交；当前测试只覆盖进入 risk pipeline 时已处于截止窗口。

**修复必要性**：末日拒买属于强制交易时间边界，必须修复。

**最终修复**：

- 在最终 `submitOrder.beforeApi` 授权中重新读取当前时间和当日交易日历，正常日与半日市到达截止点后拒绝买入。
- 正常日和半日市跨界均由 `tests/integration/buy-flow.integration.test.ts` 直接覆盖。

---

### M-04：保护性清仓完成日志写在订单 FILLED，而非业务完成点

**涉及文件**：

- `src/app/runtime/createPostGateRuntime.ts:128-183,429-435`
- `src/app/runtime/createPostTradeConsistencyRuntime.ts:194-225`
- `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts:300`

**触发条件**：单个保护性卖单进入 FILLED，但刷新后方向持仓仍不为空，或仍存在其他待成交保护性卖单。

**业务影响**：

- trade log 提前记录 `PROTECTIVE_LIQUIDATION_COMPLETED`。
- 重启 hydrator 可能恢复错误的冷却或日亏分段边界。
- 部分成交后取消但最终已空仓的 episode 反而可能没有完成日志。

**根因**：订单 FILLED 终态被错误地等同于保护性清仓 episode 业务完成。

**二次确认**：真正完成条件位于 PostTradeConsistencyRuntime 的“持仓为空且无 pending protective order”；但持久化测试明确要求 FILLED 时立即写完成。

**修复必要性**：清仓完成日志是重启恢复依据，必须与业务完成点一致。

**建议修复方向**：由 episode completion 事件统一持久化完成记录，并保证同一 episode 恰好写一次。

---

### M-05：重启后的部分成交订单会在日亏状态中重复记账

**涉及文件**：

- `src/core/riskController/dailyLossTracker.ts:230-330,361-374`
- `src/core/trader/orderMonitor/settlementFlow.ts:286-328,421-431`

**触发条件**：

1. 重建快照中存在部分成交订单。
2. `recalculateFromAllOrders` 已将累计 executed quantity 纳入状态。
3. 恢复追踪后订单进入终态。
4. settlementFlow 再次把完整累计数量传给 `recordFilledOrder`。

**业务影响**：同一 orderId 的成交数量被重复加入日亏买卖记录，日内已实现亏损偏移失真。

**根因**：增量记录接口接收的是累计成交事实，却没有 per-order watermark、delta 或幂等合并。

**二次确认**：快照转换和终态结算均使用完整累计 executed quantity；现有测试只分别验证重算和增量，没有验证真实恢复顺序。

**修复必要性**：日亏偏移直接参与浮亏风险口径，必须修复。

**建议修复方向**：按 orderId 保存已计成交量，只追加 delta；或统一通过可幂等的订单事实集合重算。

---

### M-06：开启新保护周期会删除边界后的合法成交

**涉及文件**：

- `src/core/riskController/dailyLossTracker.ts:437-453`
- `src/app/runtime/createPostTradeConsistencyRuntime.ts:214-217`

**触发条件**：

1. 保护性成交的边界时间为 T。
2. 一致性刷新完成前已经发生 T 之后的新成交。
3. episode 完成后调用 `startNewProtectionEpisode(T)`。

**业务影响**：`resetDirectionState` 会删除整个方向状态，包括本应属于新周期的 T 后成交。

**根因**：边界推进使用整体清空，没有按时间分段保留新周期记录。

**二次确认**：现有边界测试先清空再写新成交，没有覆盖真实的“边界成交 → 异步刷新期间新成交 → 完成确认”顺序。

**修复必要性**：会低估新周期损失并削弱后续浮亏保护，必须修复。

**建议修复方向**：推进边界时过滤并保留 `executedTime > T` 的记录，或基于权威订单快照重新计算新 segment。

---

### M-07：成功 REPLACE 被报告为零成功订单动作

**涉及文件**：

- `src/core/trader/orderExecutor/submitFlow.ts:292-327`
- `src/core/trader/orderExecutor/index.ts:239-251`
- `src/core/trader/types.ts:261-265`
- `src/services/autoSymbolManager/switchStateMachine.ts:263-274`
- `tests/integration/sell-flow.integration.test.ts:517-642`

**触发条件**：卖出信号命中 REPLACE，broker 已确认改单，pending-sell 数量和关联买单也已更新。

**业务影响**：

- `submitTargetOrder` 返回 null。
- `executeSignals` 返回 `submittedCount=0`。
- 换标状态机把已成功的移仓卖出误判为失败。
- 可能重复拉行情、重试，最终以 SELL_OUT_SUBMIT 失败收口或清空席位。
- 卖出实绩和回补金额无法可靠推进。

**根因**：返回契约把“是否创建新订单”错误地当成“是否成功执行订单动作”。

**二次确认**：sell-flow 集成测试明确验证 broker-confirmed REPLACE 已完成，同时断言结果仍为零。

**修复必要性**：多个消费者按该结果判断订单动作成功与否，已经形成真实业务误判，必须修复。

**建议修复方向**：改为 `SUBMITTED | REPLACED | SKIPPED` 判别联合，成功结果统一携带有效订单 ID。

---

### M-08：SeatState 类型和注册表允许非法生命周期组合

**涉及文件**：

- `src/types/seat.ts:17-41`
- `src/services/autoSymbolManager/utils.ts:265-269,391-449`

**原始宽类型可表示的非法状态示例**：

- `EMPTY + symbol`
- `SEARCHING + symbol`
- 任意运行期 `ACTIVE + lastSeatActivatedAt:null`

**业务影响**：

- EMPTY 携带 symbol 会被 `resolveSeatBySymbol` 当成真实席位归属。
- 运行期 ACTIVE 缺少激活时间会使周期换标 due 计算失效。
- 状态、标的和激活时间不再构成可信权威真相。

**根因**：`status`、`symbol` 和 `lastSeatActivatedAt` 是互相独立的可空字段；运行时断言只检查 ACTIVE/ACTIVATING 必须有 symbol。

**二次确认修正**：无写入最小复现成功写入 `EMPTY/BAD.HK`，随后 `resolveSeatBySymbol()` 返回 LONG，证明公共写入不变量确实存在。`ACTIVE + null` 需要区分：自动寻标关闭时，静态配置标的在注册表刚创建、尚未经历运行时重建的窄 bootstrap 状态是合法例外；问题在于旧类型和公共写入无法把该例外限制在初始化边界，导致任意历史运行态也可伪造相同组合。

**修复必要性**：SeatState 是席位生命周期权威状态，必须修复。

**最终修复**：按 status 建立判别联合，运行期 ACTIVE 强制有限激活时间；仅 `createSymbolRegistry` 静态初始化允许元数据全为空/零的窄 bootstrap 成员，公共 mutation 禁止重新写入该例外。

---

### M-09：pending-switch 类型不能保证存在后续唤醒 owner

**涉及文件**：

- `src/types/monitorContextPorts.ts:18-93`
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:414-447,535-550`

**触发条件**：

- `WAIT` 携带空 `wakeups`。
- 或 `stillPending:true` 配合 NOOP、COMPLETED、FAILED。

**业务影响**：SwitchWakeupRuntime 会删除旧索引，再注册零个新 owner，pending switch 永久悬挂。

**根因**：类型没有把“仍 pending”与“必须返回非空 WAIT owner”绑定。

**二次确认**：当前生产构造器尚未返回非法组合，因此本项不是“已经触发的 pending switch 故障”，而是跨模块公共类型、测试替身和 runtime 允许破坏存活性不变量的结构风险。状态机 owner 是安全边界，依赖调用方口头约定不可接受。

**修复必要性**：类型边界正用于保证状态机存活性，不能依赖调用方口头约定。

**最终修复**：

- `WAIT.wakeups` 使用非空 tuple。
- `stillPending:true` 只能配非空 WAIT。
- `stillPending:false` 只能配 NOOP、COMPLETED 或 FAILED。
- SwitchWakeupRuntime 在替换旧 owner 前再次检查非法结果并 fail-fast。

---

### M-10：交易日历核心不变量被 optional 类型和空 Map 回退削弱

**涉及文件**：

- `src/types/state.ts:100`
- `src/app/runtime/createPostGateRuntime.ts:263-286,631-636`
- `src/app/context/createMonitorContext.ts:142-143`
- `src/main/asyncProgram/sellProcessor/index.ts:294-295`
- `src/main/timeWakeupEvaluationProgram/index.ts:191-205`

**触发条件**：因错误装配或测试夹具遗漏，`tradingCalendarSnapshot` 为 undefined。

**业务影响**：

- 智能平仓超时计时静默失效。
- 无法规划后续开盘。
- 周期换标 due 计算静默失效。
- 换标逻辑读取到虚假的空交易日历。

**根因**：生产唯一构造点始终创建 Map，生命周期也只清空或重建；optional 主要服务可省略字段的测试 fixture。

**二次确认**：生产不存在删除或赋值 undefined 的合法路径，但四个消费者均使用 `?? new Map()` 静默降级。

**修复必要性**：交易日历是生命周期和交易时长计算的必需事实，必须 fail-fast。

**建议修复方向**：字段改为 required，删除空 Map 回退，补齐测试夹具；预热失败继续阻断重建。

---

### M-11：买入风控接口仍保留不可达的卖出兼容壳

**涉及文件**：

- `src/core/signalProcessor/types.ts:64-73`
- `src/core/signalProcessor/riskCheckPipeline.ts:274-287`
- `src/types/services.ts:908-918`
- `tests/core/signalProcessor/riskCheckPipeline.business.test.ts:1020`

**现状**：

- `applyRiskChecks<TSignal extends Signal>` 接受任意信号。
- 风控流水线保留卖出基础风险检查分支。
- RiskCheckContext 保留只供该分支使用的缓存账户和持仓。
- mixed buy/sell 测试继续要求卖出信号通过该接口。

**业务影响**：

- 违反“卖出不走买入风控”的明确业务边界。
- 非法 SellSignal 调用保持可编译。
- 形成第二套无生产消费者的卖出检查路径。
- 后续维护可能误用该兼容表面。

**根因**：单标的重构后仍保留旧通用 Signal 风控契约。

**二次确认**：生产唯一调用者是 BuyProcessor；SellProcessor 明确只调用 `processSellSignals`。

**修复必要性**：业务规则和项目规范均禁止此兼容壳，需要修复。

**建议修复方向**：将接口收窄为 BuySignal，移除卖出分支、缓存字段和 mixed 测试，不保留委托兼容层。

---

## 6. Minor 问题

### m-01：MonitorState 保留两个失效状态镜像

**涉及文件**：

- `src/types/state.ts:39-43`
- `src/utils/helpers/index.ts:62-68`
- `src/main/lifecycle/cacheDomains/globalStateDomain.ts:25-29`

`signal` 和 `pendingDelayedSignals` 只有初始化、跨日清空和测试 fixture 使用，没有生产读取或事件更新。真实信号由任务队列处理，真实延迟状态由 DelayedSignalVerifier 私有 Map 持有。

**修复方向**：删除两个字段、初始化、清理代码和测试夹具，避免第二状态真相。

---

### m-02：恢复 pending sell 关联买单只按价格排序

**涉及文件**：

- `src/core/orderRecorder/orderStorage.ts:502-543`

业务基准要求恢复选单采用：

`price → executedTime → orderId`

当前实现仅按 executedPrice 排序。多个买单价格相同时，输入顺序会决定分配结果。

**二次确认**：逆序时间的等价价格订单复现选择了较晚订单。

**修复方向**：补全成交时间和 orderId tie-breaker，并增加真实 OrderStorage 测试。

---

### m-03：最终下单边界重复表达标的和方向身份

**涉及文件**：

- `src/core/trader/orderExecutor/types.ts:13`
- `src/core/trader/types.ts:120`
- `src/core/trader/orderExecutor/index.ts:123,239`
- `src/core/trader/orderExecutor/submitFlow.ts:144,177,236`

公共入口已接收 `ExecutableSignal`，但私有提交边界重新放宽为 `Signal`，并独立传入：

- `targetSymbol`
- `side`
- `isShortSymbol`

原始唯一生产调用点传参一致，因此本项不是已触发的现行运行故障；风险在于最终不可逆副作用边界允许授权标的、SDK payload 标的和本地账本方向由独立参数分叉。该边界一旦被新调用方或后续重构误用，错误会直接进入远端订单和本地账本，因此仍必须修复。

**最终修复**：使用 `ExecutableOrderCommand` 在入口一次固化 action、symbol、direction、side、seatVersion 与关联买单身份，submit/replace/cancel 和本地登记均消费同一命令。

---

### m-04：当前 review/recheck 文档给出失真的“已经收敛”结论

**涉及文件**：

- `docs/plans/2026-07/2026-07-11-hsi-single-monitor-review-and-recheck.md:23,76-93,227-229`

该历史文档曾声称只发现一项缺陷且其余问题已经收敛，与本轮确认的换标、订单、自动寻标、风险和类型问题冲突；其中 `resolveSignalSeat` 是旧快照名称，不是当前源码 API。

**业务影响**：后续维护者或 agent 可能依据该文档把真实问题误分类为已验证状态。

**最终修复**：已在旧文档顶部标记“历史快照/被本文取代”，保留其历史内容用于追溯，但禁止将其中函数名、测试数字和收敛结论当作当前事实。

---

## 7. 未确认疑点

以下候选经过复核后没有列入正式问题：

1. `PeriodicSwitchPendingState` 的 boolean/optional 组合仍可进一步收窄，但尚未找到生产路径构造矛盾状态。
2. `SwitchState` 的扁平阶段字段存在进一步判别联合化空间，但当前主要构造和消费者未发现已触发错误。
3. 部分 `RiskCheckResult`、`WarrantDistanceLiquidationResult` 类型仍较宽，但未确认生产矛盾状态。
4. `tests/integration/` 下仍有 8 个早期 integration 文件使用 kebab-case，违反 lower-camelCase 文件名规范；它们是既有历史规范债，未发现业务行为或模块引用影响，不属于本轮 R1 目标残留，也不计入本轮阻塞 finding。
5. 外部 broker 的真实 WS 交付顺序、断线重连和边缘订单状态没有进行真实账户验证，本轮依据 SDK 契约和测试替身判断。

---

## 8. 测试与覆盖盲区

### 8.1 反向固化错误语义的测试

以下内容是原始 19 项 finding 被发现时的历史测试状态，不再描述第一次完全重构后复核时的当前测试状态。当时以下测试不是简单缺测，而是在阻止正确修复：

1. broker 已接受超时市价补单后，要求新订单不进入本地追踪和占用。
2. 自动寻标 API 异常后，要求失败计数和冻结状态不变化。
3. 保护性订单 FILLED 后，要求立即持久化业务完成。
4. broker-confirmed REPLACE 后，要求 `submittedCount=0`。
5. mixed buy/sell 测试要求 `applyRiskChecks` 继续处理卖出信号。

### 8.2 缺少的关键测试

以下列表同样属于原始审查快照；对应测试在第一轮修复中已有不同程度补充，但不能据此推导当前问题已经归零：

1. 席位 mutation 为 SWITCHING 后首次外部 API 异常。
2. SDK 全 OrderStatus 的穷尽恢复矩阵。
3. OPEN 生命周期中的 WS 乱序、累计成交递减和状态回退。
4. 正常无候选结果后的真实 cooldown timer。
5. 自动寻标异常连续达到冻结上限。
6. 买入在异步检查期间跨越 15:45 或 11:45。
7. 重启部分成交订单后再进入终态。
8. 保护边界后、异步刷新完成前发生新成交。
9. FILLED 但未空仓、仍有 pending、partial-canceled 后空仓三种 episode 完成场景。
10. WAIT 空 owner 和 `stillPending` 矛盾组合。
11. 等价价格买单按时间、orderId 稳定恢复。

### 8.3 测试结论边界

原始审查时全量测试全部通过，只能证明当时实现与当时测试一致；当时部分测试还反向固化了错误语义。后续修复已补入 TERMINAL state-check 陈旧快照、AutoSearch 慢失败 owner 交接、mixed-log domain input、DailyLoss 单一 selector 与 SymbolRegistry compile-time mutation 边界测试。最终关闭结论同时依赖这些反例测试、全仓验证和残留扫描，而不是只依赖测试总数。

---

## 9. 单监控标的重构残留扫描

以下关键字在 `src`、`tests`、`config` 中的活跃命中均为零：

| 扫描项                            | 活跃命中 |
| --------------------------------- | -------: |
| `MultiMonitorTradingConfig`       |        0 |
| `tradingConfig.monitors`          |        0 |
| `monitorContexts`                 |        0 |
| `getMonitorContext`               |        0 |
| `originalIndex`                   |        0 |
| `MONITOR_SYMBOL_N` / 编号环境变量 |        0 |
| `monitorIndex`                    |        0 |
| `monitorConfigs`                  |        0 |

保留的以下集合具有真实业务用途，不属于旧多 monitor 壳：

- 按 symbol 管理的行情和订单状态。
- 按 LONG/SHORT 隔离的席位、日亏和风险状态。
- 按订单 ID 管理的 tracked order。
- 按 route 管理的自动寻标、周期换标和 pending-switch 唤醒。
- 激活期间需要临时保留的新旧交易标的订阅。

---

## 10. 验证证据边界与当前入口

### 10.1 原始审查证据仅用于复现 finding

原始 `1133 pass / 0 fail`、旧 diff-check 结果和“116 个既有变更条目”描述属于 finding 发现时的工作树快照，只能证明当时的复现环境，不能作为 19 项修复后的当前证据。工作树和暂存区在多代理实现期间持续变化，任何旧计数都会失真。

### 10.2 修复后的专项验证入口

定向执行并通过的测试域包括：

- 自动寻标与 AutoSearchWakeupRuntime。
- 距离换标、周期换标、SwitchWakeupRuntime。
- 买入、卖出和末日保护集成测试。
- OrderRecorder、OrderMonitor、恢复和 settlementFlow。
- DailyLossTracker、保护性清仓和冷却。
- ACTIVE WS chaos 场景。
- TypeScript 架构和类型组织测试。

原始无写入复现已被以下反向业务测试替换：

- 买入跨越末日截止时在最终 API 前被拒绝。
- ACTIVE WS 旧事件不能降低累计成交或 pending-sell 事实。
- `EMPTY + symbol` 和公共运行期 bootstrap 伪造在 mutation 前被拒绝。
- 等价价格买单恢复稳定遵循三键排序。
- 换标 admission 失败保持 ACTIVE；mutation 后始终返回非空 owner。

### 10.3 最终 fresh 验证结果

所有 R1 代码与文档修改结束后，主代理在最终工作树上重新执行了六项验证：

| 验证项     | fresh 结果                                                  |
| ---------- | ----------------------------------------------------------- |
| Format     | 通过                                                        |
| Lint       | 通过                                                        |
| Type-check | 通过                                                        |
| Test       | `1275 pass / 0 fail / 4111 assertions / 146 files / 38.99s` |
| Build      | 通过                                                        |
| Diff-check | 当前工作树相对 `HEAD` 的 `git diff HEAD --check` 通过       |

专项测试仍作为 finding 到行为的直接证据保留；上述 fresh 全仓结果用于确认最终工作树没有被后续合并改动破坏。测试通过不替代残留扫描，R1 的结构闭环见第 14.7 节。

本轮没有刷新用户既有暂存区。该文档的旧暂存版本仍包含 10 处 Markdown hard-break 尾随空格，因此当前 `git diff --cached --check` 不通过；这是暂存区旧快照的格式状态，不是当前工作树内容或 R1 代码修复的阻塞证据。用户后续主动更新暂存内容时再对新暂存快照执行 cached check。

---

## 11. 修复实施分组

### 第一批：生产安全阻断项（已完成）

1. C-02 broker 已接受订单的本地事实连续性。
2. C-04 ACTIVE WS 累计成交和状态单调性。
3. C-03 SDK 开放订单状态穷尽恢复。
4. C-01 SWITCHING mutation 后异常 owner。

这四项已优先完成，因为它们影响真实订单事实、超量卖出和状态机存活性。

### 第二批：强业务边界（已完成）

1. M-03 末日截止最终提交授权。
2. M-07 REPLACE 成功结果契约。
3. M-05 部分成交重启后的日亏幂等。
4. M-06 日亏分段边界后成交保留。
5. M-04 保护性清仓业务完成持久化。
6. M-01/M-02 自动寻标 owner 和失败冻结。

### 第三批：类型和结构收敛（已完成）

1. M-08 SeatState 判别联合。
2. M-09 pending-switch liveness 类型。
3. M-10 交易日历 required/fail-fast。
4. M-11 买入风控接口收窄。
5. m-01 至 m-04 的状态、排序、身份和文档清理。

---

## 12. 修复后二次复核清单

每项修复完成后至少重新执行：

1. 问题对应的最小复现或定向业务测试。
2. 相关模块完整测试目录。
3. `bun type-check`。
4. `bun lint`。
5. `bunx prettier --check src tests`。
6. `bun test`。
7. 当前工作树执行 `git diff HEAD --check`；只有在用户主动刷新暂存区后，才对新暂存快照执行 `git diff --cached --check`。
8. 多 monitor 残留精确扫描。
9. 反向固化测试扫描，确保错误期望已被替换。
10. 修复后重新从生产入口回查 owner、状态、远端事实和本地账本是否闭环。

19 项原始 finding 与第 14 节 R1 finding 均已有直接实现和验证入口，并已在最终工作树上完成 fresh 检查。该关闭结论只覆盖已确认 finding；未确认候选、未评估外部环境和非阻塞历史规范债仍按各自章节保留，不能被测试总数抹去。

---

## 13. 第一轮结构性修复完成时的阶段结论

HSI 单 monitor 外层重构已经基本完成：

- 配置只保留唯一 monitor。
- 运行时只持有唯一 MonitorContext。
- LONG/SHORT 通过席位方向隔离。
- 没有发现仍在生效的多 monitor 索引、集合或兼容注册表。

第一轮二次确认表明：19 项原始 finding 均真实且具备修复必要性，但 M-08、M-09、m-03 必须按本文件修正后的边界理解，不能夸大为已在生产触发；M-03 的已证实影响是越过最终拒买截止提交，不能额外断言迟到订单永久逃逸撤单。

该阶段工作树完成了全部 19 项原始 finding 的结构性修复：远端订单事实连续性、订单生命周期单调性、换标/寻标 owner、末日最终授权、保护性清仓 progress/completion、DailyLoss 崩溃恢复、SeatState/WAIT/日历/风控类型边界以及最终执行身份均建立了直接业务或类型测试入口。

第一次完全重构后复核已经推翻“当前问题全部收敛”的判断；本节仅保留为第一轮结构性修复完成时的阶段记录。当前有效审核结论见第 14 节。

---

## 14. 第一次完全重构后的审核结论（2026-07-12）

### 14.1 复核方式与总览

第一次完全重构后的只读复核启用了 7 个独立 reviewer profile，并由终审代理交叉裁决，确认 **Critical 1、Major 5**。随后各 finding 分别采用直接结构修复、反例测试和独立复核完成收口。

| 严重级别         | 复核确认 | 当前状态                                        |
| ---------------- | -------: | ----------------------------------------------- |
| Critical         |        1 | R1-C-01 已实现并关闭                            |
| Major            |        5 | R1-M-01 至 R1-M-05 已实现或完成文档治理并关闭   |
| Minor / 清理候选 |     若干 | 不作为 R1 阻塞项；未据此宣告仓库全局 Minor 为零 |

本轮修复未引入兼容性回退、静默 rollback 或无必要的 `prepare → persist → commit` 替代结构。

### 14.2 Critical

#### R1-C-01：TERMINAL state-check 可否认已知成交事实

**涉及文件**：

- `src/core/trader/orderMonitor/routeProcessor.ts:86`

**原确认问题**：终态查询结果没有经过 `mergeMonotonicOrderFact`。WS 与 OPEN state-check 已经使用单调事实合并，但 TERMINAL state-check 仍存在独立边界。

**原可复现场景**：本地已经知道订单部分成交 `50@1`，broker 终态查询却返回陈旧的 `Canceled` 且成交数量为 `0` 或 `20`。旧链路可能直接使用较小数量结算。

**业务影响**：

- `OrderRecorder` 少记成交。
- `DailyLoss` 少记已实现成交事实。
- pending-sell 占用结算数量偏小。
- 订单随后仍会进入 `CLOSED` 并清除 tracking，正确成交事实失去后续修正 owner。

**关闭结果**：TERMINAL state-check 已与 WS、OPEN state-check 共用单调事实合并边界；陈旧终态不能降低 tracked 累计成交、成交价或 revision。公共撤单路径与终态结算测试同时验证 OrderRecorder、DailyLoss、pending-sell 和 tracking 清理副作用按合并后的权威事实推进。

**状态**：已关闭。

**复核来源**：implementation-reviewer、test-coverage-reviewer。

### 14.3 Major

#### R1-M-01：AutoSearch 慢失败可能永久丢失 owner

**涉及文件**：

- `src/services/autoSymbolManager/autoSearch.ts:33`

**原确认问题**：`lastSearchAt` 使用搜索开始时间。如果请求耗时超过 cooldown，`SEARCHING → EMPTY` 事件会在 route active 期间被折叠；旧 `finally` 释放 route 后发现 cooldown 已经过期时，既不建立 timer，也不立即重新评估。

**业务影响**：席位可能永久停留在未冻结的 `EMPTY` 状态，没有任何 owner 推进下一次寻标；对应日志还会错误声称“等待 cooldown owner 重试”。

**关闭结果**：route 释放后统一执行权威 owner handoff；cooldown 未到期时注册唯一 one-shot timer，已经到期时立即按当前 seat version 重触发。慢速无候选跨过 cooldown 的反例测试确认不会并发搜索，也不会留下无 timer、无事件、无 active route 的未冻结 EMPTY 席位。

**状态**：已关闭。

**复核来源**：implementation-reviewer、test-coverage-reviewer、comment-reviewer。

#### R1-M-02：Mixed-log 持久化契约缺少单一来源

**涉及文件**：

- `src/services/mixedTradeLogRepository/index.ts:23`

**原确认问题**：版本、record type、字段及 ID 公式在 repository、正常运行路径和启动 crash-gap 路径中重复硬编码。虽然未确认直接运行错误，但这是高风险持久化协议漂移点；模块说明还遗漏了 execution-progress record。

**关闭结果**：repository 的 completion/progress append API 只接收不含协议字段的 domain input；`tradingDayKey`、record type、schema version 和 canonical ID 全部由 repository 内部派生并严格校验。正常运行与 crash-gap producer 已删除协议拼装，模块职责同步补全 execution-progress。

**状态**：已关闭。

**复核来源**：project-spec-reviewer、code-simplification-reviewer、type-design-reviewer、comment-reviewer。

#### R1-M-03：DailyLoss 核心 snapshot 选择算法复制三次

**涉及文件**：

- `src/core/riskController/dailyLossTracker.ts:565`

**原确认问题**：“选择 boundary 前最强 execution snapshot”的五级比较逻辑在 rebuild、prepare、restore 三条路径分别维护。

**业务影响**：任意一处未来修改都可能使运行态、崩溃窗口和重启恢复采用不同 snapshot，从而产生 DailyLoss 分叉。

**关闭结果**：边界前最强 execution snapshot 已收敛为单一纯 selector/comparator，由 rebuild、prepare、restore 共用；表驱动测试锁定 execution time、order revision、累计数量及 OPEN/TERMINAL 的既定字典序优先级。

**状态**：已关闭。

**复核来源**：code-simplification-reviewer。

#### R1-M-04：SymbolRegistry 公开 mutation 类型仍允许 bootstrap 状态

**涉及文件**：

- `src/types/seat.ts:100`

**原确认问题**：公共 `SeatState` 包含仅构造期合法的静态 `ACTIVE/null` bootstrap 成员，但公开 mutation 仍接受完整 `SeatState`，依靠运行时断言拒绝该状态。

**关闭结果**：`RuntimeWritableSeatState` 已成为公开 mutation 和状态更新器的直接输入；静态 bootstrap 状态仅保留在注册表构造期。运行时断言继续保护不可信动态输入，类型测试同时确认 bootstrap 状态不能通过公共 mutation 编译。

**状态**：已关闭。

**复核来源**：type-design-reviewer。

#### R1-M-05：正式 findings 文档当前状态失真

**涉及文件**：

- `docs/issues/2026-07/2026-07-11-hsi-single-monitor-full-chain-review-findings.md`

**确认问题**：修改前，文档一方面声明 19 项全部关闭，另一方面第 8 节仍以当前时态声称错误测试正在阻止修复、关键测试仍缺失；同时本轮又确认了两个未关闭运行缺陷，导致头部与最终结论失真。

**关闭结果**：本文已将 19 项状态明确限定为“第一轮结构性修复状态”，将第 8 节标记为原始审查快照，并在本节记录 R1 finding 的发现、修复和 fresh 验证结果。头部、执行摘要、验证段与当前有效结论现已保持一致。

**状态**：已关闭。

**复核来源**：comment-reviewer、implementation-reviewer、test-coverage-reviewer。

### 14.4 Minor、历史规范债与结论边界

R1-C-01 与 R1-M-01 至 R1-M-05 的关闭，不等价于仓库全局不存在任何 Minor、注释改进或机械规范债。本轮没有把未经重新确认的旧清理候选升级为当前运行问题，也没有为了追求形式上的“零命中”扩大重构范围。

当前明确保留的非阻塞历史规范债是 `tests/integration/` 下 8 个早期 kebab-case 文件。它们早于本轮命名收敛，当前测试发现和模块引用均正常；批量改名会产生与 R1 业务修复无关的路径噪音，因此不属于本轮目标残留。

### 14.5 经复核仍成立的正向结论

以下关键修复在第一次完全重构后复核中仍被确认成立：

- broker ack 后不会否认已经发生的远端订单创建事实。
- WS、OPEN state-check 与 TERMINAL state-check 的累计数量、价格和状态采用统一单调合并。
- protective execution progress、completion baseline、mixed log 和启动恢复链路总体正确。
- `prepare → persist → commit` 是必要的故障模型，不属于过度设计。
- switch 的非空 `WAIT` owner、`SeatState` 运行时断言和最终买入截止授权均有真实业务意义。
- 未发现活跃 multi-monitor 兼容壳、静默 fallback 或 rollback。
- `ExecutableOrderCommand`、`OrderActionResult`、`BuySignal` 风控边界及 required trading calendar 的主要收敛仍然成立。

终审同时驳回了可能造成过度设计的建议：当前不要求把所有 settlement 参数重写为巨型判别联合，也不要求引入复杂 opaque DailyLoss token，除非未来出现可复现的错误路径。

### 14.6 未评估范围

1. 真实 Longbridge WS 乱序、断线重连及边缘状态，仅依据 SDK 契约和测试替身审查。
2. `SeatStateChangedEvent` 是否存在仓库外消费者，删除前仍需确认。
3. mixed log 多进程并发写入与真实断电级目录持久性未验证。

### 14.7 六类残留扫描闭环

最终工作树完成以下六类精确扫描与结构复核：

| 扫描类别 | 闭环结果 |
| --- | --- |
| TERMINAL state-check 绕过单调事实合并的独立结算入口 | 0 个未解释活跃入口 |
| AutoSearch 过期 cooldown 后无 timer、无事件、无 active route 的 owner 空洞 | 反例测试关闭，0 个已知空洞 |
| mixed-log producer 自行拼 `recordType`、`schemaVersion`、`completionId`、`progressId` 或 `v1:` | repository 外目标 producer 0 命中 |
| DailyLoss boundary snapshot selector/comparator 重复实现 | 1 个共享实现，消费者无复制 |
| SymbolRegistry 公共 mutation 接受完整 `SeatState` 或 bootstrap ACTIVE/null | 0 个宽类型 mutation 边界 |
| 活跃 multi-monitor 壳、silent fallback、rollback 或兼容 wrapper | 0 个确认目标残留 |

扫描按业务结构判断，不把合法的 symbol/order/direction Map、持久化记录字段、operator display 或历史文档命中误报为旧架构残留。

### 14.8 当前有效结论

第一次完全重构后的复核曾确认 **Critical 1、Major 5**；这些 R1 finding 现均已实现并关闭，并取得 `1275 pass / 0 fail / 4111 assertions / 146 files / 38.99s` 及 format、lint、type-check、build、当前工作树相对 `HEAD` 的 diff-check 全部通过的 fresh 证据。用户既有暂存区未在本轮刷新，其旧快照格式状态不纳入当前工作树通过结论。

因此，当前可以认定：**第一次完全重构后审核确认的 R1 Critical/Major 已收敛为零，R1-M-05 文档治理问题同步关闭。** 该结论不覆盖真实 Longbridge 环境未评估项，也不宣告仓库全局 Minor、历史规范债或未来改进项为零。
