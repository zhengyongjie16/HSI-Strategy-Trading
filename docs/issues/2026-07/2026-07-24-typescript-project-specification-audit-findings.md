# TypeScript 项目规范全面审查问题清单

> 审查日期：2026-07-24
>
> 审查性质：只读规范审查；使用 `typescript-project-specifications` skill，未使用 `code-review` skill，未修改源代码。
>
> 结论状态：本文记录的“已确认”问题均经过主代理二次源码追踪；运行时问题与规范问题分开判定，不能将潜在风险表述为已经发生的订单、账本或资金损害。

## 1. 审查范围与方法

### 1.1 范围

- `src/` 生产 TypeScript 代码：253 个文件。
- `tests/` 测试 TypeScript 代码：173 个文件。
- `mock/`、`tools/` 及 TypeScript 配置、ESLint 配置和 package scripts。
- 按核心策略/订单、风险/订单记录、异步事件程序、生命周期/时间唤醒等职责拆分子代理审查。
- `docs/` 在本次审查阶段未作为源码范围读取；本文件是审查完成后按用户要求新增的结果文档。

### 1.2 规范依据

重点检查以下规则：

- `strict` TypeScript 与未知外部数据的边界校验。
- 工厂函数、依赖注入、事件驱动和 fail-fast。
- `readonly` / `ReadonlyArray`、纯函数和不可变数据。
- 类型定义位置、`types.ts` / `utils.ts` 职责边界、禁止无意义类型别名。
- 关键业务、生命周期、队列和工具函数的中文 JSDoc。
- 文件头注释、文件命名、参数数量、re-export、类型断言和嵌套三元表达式。

### 1.3 子代理协同结果

- 4 个子代理返回了完整报告，覆盖核心策略/订单、风险/订单记录、异步事件程序、生命周期/时间唤醒模块。
- 2 个子代理持续运行但未返回报告，等待后已关闭；未将其范围宣称为已完成。
- 主代理对列入本文的每一项均重新检查了源码、调用路径和现有测试覆盖。

## 2. 总体结论

项目的基础 TypeScript 配置和静态架构约束整体有效，但当前代码并非完全符合项目规范。最需要优先处理的是：

1. 把“提交/broker 接受”错误当成“已成交/已完成”，提前清理浮亏和末日清仓本地状态。
2. 外部牛熊证、订单枚举和持仓数据的异常响应存在 fail-open 路径。
3. fatal 状态、异步 retain 和队列 restart 的生命周期边界不完整。
4. 核心时间/timer 依赖、logger 和 fatal handler 未完全通过参数注入。
5. 不可变数组契约、类型别名和关键函数 JSDoc 仍有明确规范缺口。

## 3. 已确认的运行时与风控问题

### 3.1 浮亏保护在订单提交后提前清理本地买单记录

**主张**

保护性清仓订单仅提交或被 broker 接受时，不应清理本地买单记录和浮亏投影。

**证据与运行路径**

- `src/core/riskController/unrealizedLossMonitor.ts:98-122` 根据 `executionResult.executedOrderIds.length` 调用 `orderRecorder.clearBuyOrders` 并刷新浮亏数据。
- `src/core/trader/orderExecutor/index.ts:485-499` 将 `SUBMITTED` 和 `REPLACED` 的订单 ID 加入 `executedOrderIds`。
- 权威成交结算位于 `src/core/trader/orderMonitor/settlementFlow.ts:113-121`。
- 路径为：浮亏监控 → `trader.executeSignals` → 返回提交订单 ID → 清理本地订单记录 → 刷新浮亏缓存。

**判定**

已确认的本地账本/风控缓存错误。未成交、部分成交或后续撤单时，本地状态会先被删除；当前证据未证明已经造成 broker 错单或资金损失。

**最小修复与验证**

将清理和浮亏刷新移动到权威成交/终态结算及账户持仓刷新路径。增加“返回 submitted ID 但没有成交事件”的测试，确认不会清理记录；成交事件后才允许清理。

### 3.2 末日清仓在提交成功后提前清空持仓缓存和订单记录

**主张**

末日清仓完成条件必须是权威终态和持仓事实，而不是所有清仓订单已经返回 ID。

**证据与运行路径**

- `src/core/doomsdayProtection/index.ts:459-533` 在 `executedOrderCount === uniqueClearanceSignals.length` 时清理 `cachedPositions`、position cache 和 `orderRecorder`。
- `src/core/trader/orderExecutor/index.ts:485-499` 的 `executedOrderIds` 仍包含仅 `SUBMITTED` 或 `REPLACED` 的订单。
- `src/main/timeWakeupEvaluationProgram/index.ts:463` 的 `onPositionsCommitted` 只负责 `quoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth()`，不是提交后立即获得权威成交持仓的证明。

**判定**

已确认的状态一致性缺陷。新清仓单尚未成交时，系统可能已经表现为无持仓。

**最小修复与验证**

提交后保留本地订单和持仓事实，等待权威订单终态及账户持仓刷新后再清理。模拟仅返回 `executedOrderIds`、没有成交事件的场景，确认缓存和订单记录仍保留。

### 3.3 牛熊证方向和类型边界 fail-open

**主张**

方向不匹配或无法解析 `category` 的外部响应不能继续作为合法牛熊证或普通股票使用。

**证据与运行路径**

- `src/core/riskController/warrantRiskChecker.ts:128-144` 对方向不匹配只记录 warning。
- `src/core/riskController/warrantRiskChecker.ts:334-368` 仍返回方向错误的 `WarrantInfo`。
- `src/core/riskController/warrantRiskChecker.ts:389-407` 继续缓存该结果。
- `src/core/riskController/warrantRiskChecker.ts:434-466` 使用缓存类型计算风险阈值。
- `src/core/riskController/warrantRiskChecker.ts:346-356` 在 category 无法解析时返回 `isWarrant: false`，可能绕过牛熊证风控。

**判定**

已确认的外部数据边界问题。错误方向可能使用错误牛熊证阈值；畸形响应可能被当作普通股票并允许交易。普通股票确实没有 warrant quote 的合法路径不属于本问题。

**最小修复与验证**

区分 `NO_CANDIDATE` 与 `INVALID_RESPONSE`。方向不匹配或未知类型必须拒绝绑定并清除相关缓存。覆盖 Bear 返回给 CALL、未知 category、合法 Bull/Bear 三类测试。

### 3.4 无效持仓数据时持仓限制降级为只检查订单金额

**主张**

已有持仓但数量或成本价无效时，不能静默退化为只检查本次买入金额。

**证据与运行路径**

- `src/core/riskController/positionLimitChecker.ts:63-78` 对无效数量或成本价调用 `checkOrderNotionalOnly`。
- `src/core/riskController/positionLimitChecker.ts:130-136` 对无效数量可能直接视为没有有效持仓。
- `src/core/trader/accountService.ts:87-96` 和 `src/utils/helpers/index.ts:22-33` 的外部转换可能产生 `NaN`。
- 路径为：账户 API 持仓转换 → `RiskChecker.checkBeforeOrder` → `PositionLimitChecker.checkLimit`。

**判定**

已确认的风险 fail-open。异常持仓数据可能使超过单标的最大市值的订单通过；尚未证明线上已经发生超限交易。

**最小修复与验证**

匹配到正持仓但字段无效时直接拒绝或抛出明确数据错误，仅有限且为零的数量才能被视为无持仓。覆盖 `NaN` 数量、`NaN` 成本价和负数成本价。

### 3.5 `TimeWakeupRuntime` fatal 后可以被 `start()` 重新打开

**主张**

系统级时间唤醒进入 fatal 后应保持终态，不能通过普通 `start()` 再次运行。

**证据与运行路径**

- `src/main/timeWakeupRuntime/index.ts:49-63` 的 `failFatal` 设置 `fatalError`、停止运行并清理 timer。
- `src/main/timeWakeupRuntime/index.ts:163-170` 的 `start()` 只检查 `running`，没有检查 `fatalError`。
- 路径为：评估失败 → `failFatal` → `running=false` → 再次 `start()` → 重新评估并可能发布交易门禁事件。

**判定**

已确认的状态机缺陷。子代理进行了最小复现，现有测试覆盖 fatal 暴露但未覆盖 fatal 后再次 `start()`。

**最小修复与验证**

`start`、`requestEvaluate` 和 `scheduleAt` 均拒绝 fatal 状态；如需恢复，增加显式 reset API。增加 fatal 后重启测试。

### 3.6 quote retain 异步操作未纳入 `stopAndDrain()`

**主张**

停止 runtime 时，所有 retain/release 异步操作都应被 drain 等待。

**证据与运行路径**

- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:394-407` 和 `:439-459` 使用 `void retainSymbols/releaseRetain`。
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:876-890` 的 `stopAndDrain()` 只等待 `activePromises`，retain/release 没有注册到该集合。
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:329-377` 和 `:859-879` 存在相同模式。
- 路径为：runtime 停止 → 发起异步释放 → 只等待 route Promise → `stopAndDrain()` 返回，而订阅 mutation 仍可能运行。

**判定**

已确认的独立 runtime 生命周期边界问题。全局 cleanup 可能随后等待订阅 runtime，但不能弥补该模块单独使用时的 drain 契约缺口。

**最小修复与验证**

跟踪 retain/release Promise，并在 `stopAndDrain()` 中一并等待。注入 deferred subscription runtime，确认 release 完成前 drain 不 resolve。

## 4. 已确认的 TypeScript 与架构规范问题

### 4.1 核心时间和 timer 依赖未完全注入

**证据**

- `src/core/strategy/index.ts:89,199` 直接使用 `Date.now()` / `new Date()`。
- `src/core/signalProcessor/riskCheckPipeline.ts:127` 直接读取 `Date.now()`。
- `src/core/trader/orderExecutor/buyThrottle.ts:44` 直接读取 `Date.now()`。
- `src/main/asyncProgram/delayedSignalVerifier/index.ts:139,142` 直接使用 `Date.now()` 和 `setTimeout()`。
- `src/core/trader/orderMonitor/routeRuntime.ts:26-33` 绑定原生 timer。
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:255,539` 使用可选依赖并回退到原生 timer/`new Date()`。

**运行路径与判定**

策略生成 → 风控冷却 → 下单执行 → 订单 timeout/retry/replace，以及延迟信号和行情事件 retry 均可能使用不同时间源。已确认违反依赖注入和严格事件回放规范，但尚未证明当前实时环境必然产生错误。

**最小修复与验证**

由装配层注入统一 `Clock` 和 scheduler，移除核心路径的直接系统时钟及隐式回退。使用 fake clock/scheduler 验证延迟验证、冷却、跨日、timeout 和 retry 的边界。

### 4.2 外部订单枚举字段类型收窄不足

**证据与判定**

- `src/core/trader/orderCacheManager.ts:54-68` 只检查 `side/status/orderType` 是数字。
- `src/core/trader/types.ts:179-194` 随后将这些字段视为 SDK 枚举并构造 `PendingOrder`。

这是已确认的外部信任边界类型问题。`number` 不是合法 SDK 枚举成员的充分证明。

**最小修复与验证**

使用 SDK 枚举成员校验或 schema/guard 校验非法值，并增加非法 side/status/orderType 的 fail-fast 测试。

### 4.3 可变数组契约和原地写入

**证据与判定**

- `src/core/signalProcessor/types.ts:35` 的 `ProcessSellSignalsParams.signals` 为 `Signal[]`。
- `src/core/signalProcessor/types.ts:61` 的 `processSellSignals` 返回 `Signal[]`，但实现 [sellQuantityCalculator.ts:121-137] 只读取入参并返回新数组。
- `src/core/orderRecorder/orderFilteringEngine.ts:72` 的 `currentBuyOrders` 为 `OrderRecord[]`，实现只调用 `filter`。
- `src/main/timeWakeupEvaluationProgram/index.ts:98-107` 的 `pushFutureCandidate` 原地 `.push()`。
- `src/core/strategy/utils.ts:246-263` 的 `pushSignalToCorrectArray` 原地修改两个传入数组。

这是已确认的不可变优先规范问题。当前数组主要由调用方新建，未发现外部共享对象被破坏。

**最小修复与验证**

读取型参数改为 `ReadonlyArray`；纯转换函数返回新数组；确需累加的局部状态限制在工厂内部并明确可变边界。使用冻结数组进行策略、卖出和订单过滤验证。

### 4.4 全局 logger 绕过依赖注入

**证据**

以下模块直接导入全局 logger：

- `src/main/lifecycle/cacheDomains/globalStateDomain.ts:15`
- `src/main/lifecycle/cacheDomains/marketDataDomain.ts:12`
- `src/main/lifecycle/cacheDomains/orderDomain.ts:12`
- `src/main/lifecycle/cacheDomains/riskDomain.ts:14`
- `src/main/lifecycle/cacheDomains/seatDomain.ts:12`
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:18`
- `src/main/timeWakeupEvaluationProgram/index.ts:15`
- `src/main/quoteSubscriptionRuntime/index.ts:13`
- `src/main/tradingGateEventRuntime/index.ts:9`
- `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:18`
- `src/main/tradingQuoteDisplayRuntime/index.ts:15`

**判定与修复**

这是已确认的依赖注入规范问题，不是已确认的错误订单问题。应将 runtime 所需的 logger 能力加入依赖类型，由应用装配层注入，并用独立 logger 验证测试隔离。

### 4.5 fatal handler 为可选依赖

**证据与运行路径**

- `src/main/asyncProgram/types.ts:43` 和 `src/main/asyncProgram/monitorTaskProcessor/types.ts:123` 将 `onFatalError` 定义为可选。
- `src/main/asyncProgram/utils.ts:156` 捕获错误后调用 `onFatalError?.()`，之后继续调度。
- 生产装配当前传入 handler，但工厂契约允许不完整注入。

**判定**

这是潜在 fail-fast 风险，不是已确认的线上故障。

**最小修复与验证**

将 handler 改为必需依赖，或缺失时重新抛出错误。测试不注入 handler 时错误不能被静默消费。

### 4.6 无意义类型别名

`src/main/periodicSwitchWakeupRuntime/types.ts:52` 的 `PeriodicSwitchAutoSymbolTickTaskData` 只是 `MonitorTaskDataMap['AUTO_SYMBOL_TICK']` 的直接别名。

这是已确认的规范问题，无运行时影响。应直接使用索引访问类型并删除别名，随后进行残留引用扫描和 type-check。

### 4.7 关键工具和生命周期函数缺少 JSDoc

**已确认缺少文档的工具函数**

- `src/utils/refreshGate/index.ts:62,126,131`
- `src/utils/time/index.ts:81`
- `src/utils/timer/index.ts:26,35`
- `tools/calculateTradingFees/utils.ts:15,19,39`

**已确认缺少文档的关键函数**

- `src/core/trader/orderMonitor/index.ts:455` `stopRuntimeAndDrain`
- `src/core/trader/orderMonitor/orderStatusQuery.ts:52` `checkOrderState`
- `src/core/trader/orderMonitor/settlementFlow.ts:518` `settleOrder`
- `src/core/trader/orderMonitor/routeProcessor.ts:913` `createRouteProcessor`
- `src/main/seatActivationDispatcher/index.ts:50` `scheduleSeatRefresh`
- `src/main/asyncProgram/monitorTaskProcessor/index.ts:210`
- `src/main/monitorDisplayRuntime/index.ts:23` `createMonitorDisplayRuntime`
- `src/main/tradingQuoteDisplayRuntime/index.ts:29` `createTradingQuoteDisplayRuntime`

**判定与修复**

这是确认的注释规范问题，不直接改变运行时行为。工具函数应补齐函数说明、`@param` 和 `@returns`；关键业务/生命周期函数应说明状态迁移、异步副作用、失败语义和停止顺序。

### 4.8 声明为纯函数的卖出扣减策略含有日志副作用

`src/core/orderRecorder/sellDeductionPolicy.ts:9-15` 声明模块核心原则为“纯函数、无副作用”，但 `:58-71` 对负数或非有限数量调用全局 logger 并静默返回原列表副本。

这是确认的规范问题，业务影响较低。非法输入应在调用边界拒绝，纯函数内部不应依赖全局日志。

### 4.9 `createIndicatorCache` 文档与类型契约不一致

`src/main/asyncProgram/indicatorCache/index.ts:22` 的 JSDoc 说明 options 可省略，但 `:27` 的 TypeScript 签名要求 `options: IndicatorCacheOptions`。

这是确认的公开 API 文档问题。应修正文档或将 options 设为可选，不能同时保留两套契约。

## 5. 潜在风险与规范观察

### 5.1 `restart()` 可能破坏 single-flight

- `src/main/asyncProgram/utils.ts:150` 的 `restart()` 直接 `stop()` 后 `start()`。
- `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:151` 存在相同模式。
- `stop()` 不等待 `inFlightPromise`，旧任务仍可能运行，新任务再次调度；旧 Promise 的 `finally` 还可能覆盖新的状态引用。

当前生产生命周期主要使用 `stopAndDrain()`，因此尚未确认已经触发重复执行。应先用 deferred task 验证最大并发数，再决定让 restart 等待 drain 或引入 generation/lifecycle latch。

### 5.2 `DateRotatingStream` 严格违反优先工厂函数规则

`src/utils/logger/index.ts:109` 使用 `class DateRotatingStream extends Writable`，并在 `:384-385` 实例化。该类是 Node.js `Writable` 适配器，文件已有“无法改为工厂函数”的说明，因此记录为低优先级规范观察，不判定为运行时缺陷。

若严格整改，应改为工厂函数返回带 `write` 和 `closeSync` 能力的 `Writable` 适配对象，并回归日志轮转、flush 和退出清理。

## 6. 未发现的问题

全库静态检查和测试未发现：

- 实际 `any` 类型、无说明的 `@ts-ignore`。
- re-export、类型位置内联 `import('...')`。
- 嵌套三元表达式、超过 7 个位置参数。
- 非 camelCase 生产文件名。
- `types.ts` 混入运行时代码、`utils.ts` 混入类型声明。
- 缺少生产文件头注释或类型声明块注释。
- 明确的重复下单、错误成交结算、资金损失或 broker 错单证据。

外部 API 边界整体使用 `unknown` 和类型守卫，但订单枚举和牛熊证 `category` 的问题仍需按本文处理。

## 7. 验证结果

- `bun type-check`：通过。
- `bun lint`：主代理独立重跑通过；一个子代理曾得到无诊断退出码 255，未作为最终结论。
- `bun test`：1662 passed、0 failed，162 个测试文件。
- Prettier `--check`：通过。
- `git diff --check`：通过。
- 工作区最终无源代码修改。
- 本次审查产生的测试、ESLint、tsc、Prettier 进程已清理；用户原有的 `bun src/index.ts`、`bun start` 和 SonarLint 进程未擅自终止。

## 8. 后续处理顺序建议

1. 先修复浮亏保护、末日清仓和牛熊证/持仓数据的 fail-open 与提交/成交语义问题。
2. 修复 `TimeWakeupRuntime` fatal 重启和 quote retain drain 边界。
3. 统一核心时间、timer、logger 和 fatal handler 的依赖注入契约。
4. 修复外部枚举校验、不可变数组契约和无意义类型别名。
5. 补齐工具及关键生命周期函数 JSDoc，最后处理低优先级文档和工厂函数观察项。
