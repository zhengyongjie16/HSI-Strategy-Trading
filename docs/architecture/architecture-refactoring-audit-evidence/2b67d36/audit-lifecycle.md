# G1 生命周期、启动、恢复与停机：只读架构业务等价性审计

## summary

- **verdict：不能签发本范围相对 develop 的业务全等价结论。**发现 1 项有完整可达链、自查和离线组合复现的 major 候选 **LC-01**：重建恢复时已经到期的周期换标需求可能失去恢复唤醒。它仍须由主代理安排独立复核，本文不把自审结果冒充最终确认缺陷。
- **scope：**固定地图 G1 的 34 个 current 生产文件；为核对资源接线，额外追踪入口、composition root、H/S、订阅、各事件 owner、队列和 cleanup 的直接依赖。重点是业务执行时机、状态迁移、授权、错误归属和资源顺序，不是详细订单算法的全仓审计。
- **confidence：**LC-01 的单组自审证据 high；“本范围没有其他业务差异”的结论不成立，整体覆盖置信度 medium。明确列出未深入边界。
- **固定版本：**current beta-V2 HEAD `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop、origin/develop、FETCH_HEAD 均为 `6e239c8a128372bd9b2fb2d79464346792a5e81e`。开始/结束核验均未发现工作区改动。
- **方法：**以旧完整实现为行为真值；地图只用于找来源。实际阅读 current/旧实现和调用方，逐项检查接线；对部分纯迁移文件比较源码/函数体，并继续核对 import 指向。没有将 rename、路径相似或测试通过当作业务等价证明。
- **执行限制：**未 checkout/reset、未运行实际 app/交易、未创建测试/脚本/配置；只创建本报告。所有实验内存替换 broker/行情 IO；未调用真实 SDK 网络工厂。未自行启动子代理。
- **模型透明度：**任务指定 `cliproxyapi/gpt-6.1-sol max`；环境没有可见模型 ID 或思考档位，无法独立证实模板是否真正生效，也没有可证据化的不同型号提示。

## critical issues

None. 未形成可交付为最终确认的 critical 缺陷；不能据此推断详细交易算法无风险。

## major issues

### LC-01 — 同一连续交易时段重建恢复后，已到期周期换标路线缺少 lifecycle 恢复唤醒

- **状态：**自审排除主要误报并离线复现，**待独立复核**；本报告的稳定候选 ID 为 `LC-01`。
- **严重级别：**major。影响的是周期换标推进活性，不是已证明会越权下单或立即造成资金损失。
- **claim：**periodic runtime 现在会在派发前校验“lifecycle 已开门且属于连续交易时段”。但恢复链仍在 lifecycle 关闭时启动它；已到期路线会清掉 timer 并进入 `blockedOnGate`。manager 最后开启 lifecycle 后没有通知该 owner，而 time evaluator 只发布连续时段 `canTrade` 的变化；重试前后连续时段都是 true 时，没有恢复边沿。

#### current 精确证据

| 位置 | 事实 |
| --- | --- |
| `src/app/runtime/createPostGateRuntime.ts:737-755` | `getCanTradeNow` 同时要求未终止、`lifecycleState.isTradingEnabled`、`tradingTimeState.canTrade === true`；due 使用真实交易日历累计时长算法。 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:209-244` | `processDispatchQueue` 把 dirty 消费后，在 gate 关闭时设 `blockedOnGate=true` 返回；没有挂一个恢复 timer。 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:357-415`，特别是 `:382-390` | `planRoute` 对已经到期的 baseline 清除 route timer，直接尝试 dispatch，然后返回。 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:449-473` | 恢复处理依赖 false→true 的 gate 事件，重派 `dispatchBaseline` 或重新 plan。 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:651-673` | `start` 注册 listener 后立即 seed；fresh 通知只补 `waitingEmpty` 或 `blockedOnFreshness`，不补初次 `blockedOnGate`。 |
| `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:109-150`，特别是 `:130` | signal domain 在重建最后阶段启动 periodic，此时 manager 的 lifecycle 交易开关仍关闭。 |
| `src/runtime/lifecycle/dayLifecycleManager.ts:315-345` | 先 await 逆序各域，全部完成后才 `snapshot.openAdmission()`、清 pending、设 ACTIVE、`isTradingEnabled=true`；没有向 periodic 交接恢复需求。 |
| `src/runtime/timeWakeupEvaluationProgram/index.ts:291-309,315-325,359-365` | lifecycle tick 之后更新连续时段状态，且只在 previous/next `canTrade` 不同时发 gate event。 |
| `src/app/lifecycle/createLifecycleRuntime.ts:95-157` | 真正注册顺序为 signal→market→seat→order→risk→global；manager 逆序开盘，所以 signal 启动确实发生在全局开门之前。 |

#### develop 对照，不是基线已有

- `src/main/periodicSwitchWakeupRuntime/index.ts:128-151`：旧 `dispatchAutoSymbolTick` 在运行中直接 `scheduleLatest`；没有新增的派发前 lifecycle gate 挂起。
- `src/main/periodicSwitchWakeupRuntime/index.ts:177-233,431-445`：旧 owner 同样在 seed/due 时派发，因而同一 baseline 会产生任务。
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:109-136`：旧恢复顺序也是先 periodic.start，再 processor.restart；不能单独把这个旧顺序误报为新 bug。回归来自**新增派发授权要求与既有恢复顺序/通知契约没有一起闭合**。
- `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:78-102`：旧 worker 通过 `setImmediate` 异步消费，manager 正常完成的微任务链可先恢复交易门禁；并非旧任务必然在关门状态被同步消费掉。
- `src/main/lifecycle/dayLifecycleManager.ts:206-218`：旧最终恢复 gate。
- `src/main/timeWakeupEvaluationProgram/index.ts:298-321,327-337,371-377`：旧也只发布连续时段边沿。该事件契约本身不是重构新引入。

#### 最小真实生产场景与完整链路

1. 自动寻标开启且周期 > 0；前一日 LONG 持有同一港股轮证，激活时间为 2026-04-28 15:59，周期 5 个交易分钟。持仓使该 symbol 在次日恢复时仍然绑定。
2. 真实午夜：manager 关闭旧 epoch/交易准入；signal 停止 owner；seat domain 捕获 activation carryover 再清空席位。相关实现：`seatDomain.ts:55-67`，`seatActivationCarryover.ts:31-94`。正常前一日 ACTIVE 不是跨日 OPEN_REBUILD_FAILED，因此不会走“跨第二天丢弃旧 carryover”的分支。
3. 次日 09:30 首次开盘重建在账户/持仓或更早的外部读取阶段失败，未到消费 carryover 的 activation 提交。manager 仍会让 evaluator 将连续时段状态更新为 true；lifecycle 仍关闭。
4. 四次外部失败按原 30s、60s、120s、240s 退避，09:37:30 重建成功。周期 due 已是 09:34，早于恢复时间。
5. loader 使用真实席位恢复规则：`loadTradingDayRuntimeSnapshot.ts:517-543` → `seatPreparation.ts:23-59` → `getLatestTradedSymbol` 和 `resolveSeatOnStartup`，已成交历史+现有持仓可恢复原 symbol；`rebuildTradingDayState.ts:358-403` 用 carryover 恢复原激活时间，然后 `:436` 才清 carryover。故“已经到期且 ACTIVE”不是任意手造而不可达的状态。
6. global open rebuild 完成 load→rebuild→quote reconciliation→S baseline/fresh；最后 signal domain 启动 periodic。此时 lifecycle 开关 false，seed 的过期路线被挂起；它既不是 waiting-empty，也不是 blocked-on-freshness。
7. signal 返回 COMMITTED 后 manager 开门；连续时段在前几次失败评估中已经 true，true→true 不发布事件。没有任务、没有周期 timer。即使后续报价持续到达，也没有 periodic 的到期重播；order/fresh listener 也只处理上述特定挂起类别。

**影响：**该路线至少在本连续交易时段内停留，直至下一次真正的连续交易 gate-open、席位 truth 变更、显式重启等适用事件；上午场示例可能拖到 13:00。系统级 timer 12:00 会关门，但它本身不会补发周期任务。不能把它描述成整个交易系统永久停摆，也不能声称已观察到实际损失。

#### 自查与离线验证

- 实验使用真实：symbol registry、midnight seat domain、activation carryover、seat preparation、rebuilt activation、H、S、open rebuild、global/signal domains、day manager、time evaluator、TimeWakeupRuntime、periodic runtime、gate bus、交易时长 due 纯规则。
- 替身边界：loader 的外部 IO 与 rebuild 中无关的风险/日志/订单算法用内存替身；load/activation 授权和 carryover 行为使用真实模块；无关 owner 的 start/stop 用空实现。因此这不是完整 app 或完整旧程序动态运行，但关键缺失唤醒链没有被替换。
- 已复现输出：

```text
due=2026-04-29T01:34:00.000Z                       # 香港 09:34
restoredActivation=true
loads=5
09:30:30 OPEN_REBUILD_FAILED, canTrade=true
09:31:30 OPEN_REBUILD_FAILED, canTrade=true
09:33:30 OPEN_REBUILD_FAILED, canTrade=true
09:37:30 ACTIVE, isTradingEnabled=true, canTrade=true
queuedTasks=0, periodicTimers=0
nextSystemMs=8550000                              # 下一系统边界 12:00
fatals=[]
developOwnerQueued=1                             # 旧周期 owner 同输入会派发
manualGateReplayQueued=1                         # 补发 gate-open 后当前路线才派发
```

- develop 动态对照仅把旧 periodic 源文件的两个运行时 import 重定向到已核对的常量/timer，再由 Bun 去 TypeScript 类型；其业务函数未改写。旧完整 app 的消费时序另外由上面 queueRunner/manager 源码证明，**不冒称运行了整个 develop**。
- 当前清理 gate 或 S fresh 已恢复，任务仍为 0，排除了“只是仍在重建/未 ready”的解释。补事件即可有任务，排除了非法席位版本或 due 日历算不出的解释。carryover 跨日实验排除了初次两段组合实验中“随意塞入旧 ACTIVE 席位”的证据弱点。

#### minimal fix

在**真正完成重建并重新开放 lifecycle 授权**的同一 ownership 交接处，为已挂起周期需求提供一次真实恢复重评估；或调整启动/seed 的归属，使它在该授权恢复后执行。保留原 captured receipt、dayEpoch、seatVersion、single-flight 和停止约束。不要为了让旧 seed 跑通而提前开放全局交易、去掉 lifecycle 检查、伪造连续时段变化或增加周期轮询。这是一个“gate 语义与恢复通知不一致”的共享根因，不应在报价/订单/多个调用方逐个补派。

#### validation / 现有测试缺口

- 新的行为验证应组合真实 `createLifecycleRuntime`/global/signal/periodic/time evaluator，制造同日 external retry、恢复时 due 已过、`canTrade=true`→true；断言开门后恰好一项有效任务、无重复派发，旧 epoch/停止回调不派发。
- 另验证首次正常开盘（false→true）、半日市、午休、持续外部失败、stop/drain、carryover 恢复为不同 symbol 时不继承。
- `tests/runtime/periodicSwitchWakeupRuntime/business.test.ts:147-218` 的 harness 把独立 gate 值和 emitGate 放在一起控制，不含真实 lifecycle 复合开关；其 gate-open 测试不能证明生产会发这个事件。
- `tests/runtime/lifecycle/cacheDomains/signalRuntimeDomain.test.ts:326-518` 主要断言空替身的启动次序，没有真实 periodic seed 和 manager 最后开门的联动。
- `tests/integration/rebuildSettlementReadiness.integration.test.ts:350-374` 的 manager 只注册执行 openRebuild 的单域，未接最后 signal domain/periodic 恢复链。
- 可运行离线复现放在附录 A，已有测试通过并不覆盖此交接缺口。
- **dimensions：**implementation、project/spec、types（不同 gate 语义未由能力契约表达）、tests。按同一根因只列此一项，不把对应缺测和恢复顺序重复计数。

## minor issues

None. 未把过时的形参说明、可写得更短的函数或无完整消费排查的 dead-code 怀疑升级成缺陷。

## 明确行为差异、历史修复与排除项

### LC-D1 — 末日 submit UNKNOWN 是真实非等价，但属于方案显式决策，不能混入“纯迁移等价”

- develop `src/main/timeWakeupEvaluationProgram/index.ts:453-496` 对 `isUnconfirmedOrderSubmissionError` 会刷新账户/持仓事实、对账 position hold，安排系统级重评估，并不在该分支直接 fatal。
- current `src/application/doomsdayClearance/index.ts:769-771,827-829`、`src/application/orderExecution/tradeMutationErrors.ts:39-72` 和 `src/utils/apiFailure/index.ts:62-75`：UNKNOWN 错误不属于登记在 WeakSet 的普通外部请求错误，原错继续上抛，经 TimeWakeup 的 fatal 和顶层 cleanup 终止。`tests/runtime/timeWakeupEvaluationProgram/business.test.ts:962-1004` 明确断言“不刷新、不对账、不返回重评估计划”。
- `docs/architecture/architecture-refactoring-design.md:771-786`（§6.6，特别是 :777）**明确承认旧/新不同并自述已有范围决策**，不是可以通过源代码证明等价的架构变化。
- 本轮用户要求以 develop 为业务真值，不因当前文档/测试反推新需求；因此该项作为**必须显式处理的非等价/授权边界**交主代理，不冒称“已等价”，也不擅自要求回退安全策略。若本轮严格不允许任何例外，必须由主代理单独列入结论；若用户认可方案的这一已声明例外，应明确写为例外，不能写成 develop 原本也 fatal。

### LC-X1 — 合成的第二次 baseline 失效停摆：未证明真实生产交错，不列缺陷

- 可疑结构真实存在：global 的 `openRebuild.ts:122-143` 已完成 quote/S baseline；signal `signalRuntimeDomain.ts:112-125` 又做一次。若第二次失效返回 false，则 manager `dayLifecycleManager.ts:328-338` 把它当 ABORTED，保留 pending、不加 timer；S `postTradeSettlement/index.ts:729-771` 会停止调度。
- 曾在第二次 `onPositionsCommitted` 人工注入 `recordSettlementRefreshNeed`，组合实验确实停留 MIDNIGHT_CLEANED；这是**合成重入证据**而非生产可达证据。
- 自查：生产的该回调在 `createPostGateRuntime.ts:274-279` 只对 quote position hold 做 awaited ack。global 的完整 reconciliation/baseline 已收敛后，如果没有事实变化，signal 的两段 reconciliation 通常没有 SDK subscribe/unsubscribe 差集（`quoteSubscriptionRuntime/index.ts:188-259,367-395`），只能形成 Promise 微任务链。不能仅凭存在 `await` 就声称网络 WS macrotask 必然能插入。
- 本组没有证明在该窗口有真实 IO、同步业务 listener 或已在途业务命令产生同日失效。**排除为本组缺陷主张；保留为未深入并发边界。**不得把人工注入复现写成第二个确认回归。

### 历史 d2aa590 / 2b67d36 复查口径

1. **旧已有 executionTime≤revision 检查。**develop `src/core/trader/orderMonitor/settlementFlow.ts:265-276` 及 `orderFactMerge.ts:120,425` 已有时间关系判断。旧事实链把两个时间都由订单 updatedAt 派生，不能把旧判断误报成重构新增。`d2aa59054abac546f506b27df45f161afcfc6578` 删除 current `settlementFlow.ts` 的该拒绝条件，是独立 execution 时间引入后旧假设不再成立的历史修复；本报告不重复报已修项。
2. **2b67d36 的根因不能只写“时间比较”。**已核对 `createTradeRuntime.ts` 删除启动对 executionLedgerPort/`getExecutionTimeEvidence` 的接线、`createPostGateRuntime.ts` 不再向 broker factory 注入 orderEconomics、loader 加入 shared execution normalization 和 durable 历史预检。用户校正的 execution 驱动启动、全局数量整数化、市场范围失控三个根因均必须保留。
3. **当前归一入口：**`executionNormalization.ts:34-73` 让 shared merge 裁决量/金额/phase，正成交输入执行时间采用 `order.updatedAtMs`；零量金额/时间检查、正量缺原始金额拒绝都没有在本模块偷偷填均价。`loadTradingDayRuntimeSnapshot.ts:476-496` 在副作用前完成 durable history + 当前 API 事实校验。运行期 seat activation 的另一个调用在 `src/application/seatActivation/index.ts:325-331` 使用 KEEP_KNOWN；本组只核对接线，不替另一组背书全部 merge 算法。
4. **范围限制：**本组已复核“启动/重建不再靠 execution 查询驱动”这一接线；没有独立穷尽数字 adapter 的所有数量边界和港股/非港股过滤，不能宣称三个根因全仓已经修完。其完整性需与 G3/G4/G6 审计合并。
5. `quoteSymbols.ts` 收集所有持仓 symbol 的循环在旧 `main/lifecycle/utils.ts` 的同名函数体中已经存在；市场过滤是否正确要追输入 adapter/上游，不能仅凭该循环把历史范围问题再次报为 G1 新回归。

## 端到端链路与正向证据

### 启动与初始次序

`src/index.ts` → `runApp` 的唯一 termination/cleanup → prepare strategy → pre-gate resources → post-gate（H、S 与一次绑定的 trade/quote 能力）→ startup snapshot → 运行时符号验证 → monitor context/async owners/lifecycle/time 装配 → startup rebuild → `startRuntimeAfterStartupRebuild` → 等待 termination → 唯一 cleanup。

- `runApp.ts:150` 保存原 startupTradingEnabled；首次重建期间关闭交易；`startupRebuild.ts:38-149` 只允许 captured COMMITTED + quote + S fresh 完成，而 API_RETRY_PENDING 不携带伪造空事实。
- `startupRuntime.ts:23-56`：成功时按明确次序启动显示、订阅、seat cleanup/activation、auto-search、periodic、风险/quote/switch、processor、order monitor；之后 await 首轮 TimeWakeup，最后才启动普通 business event。首次重建失败时只启动系统时间 owner，仍可走恢复而不是把唤醒一并停掉。
- 对照旧 runApp 与旧 cache domains 追踪了初始顺序；runtime helper 拆分本身未作为缺陷。LC-01 是恢复授权发生变化后没有闭合的具体例外。

### 跨日与恢复

- 实际域注册唯一，午夜正序 signal→market→seat→order→risk→global，开盘逆序；`createLifecycleRuntime.ts:95-157` 与 manager `:69-145`。
- manager `:208-269` 同步失效旧 epoch/关闭 snapshot admission，再排空；同一次日切重试不重复推进 epoch，currentDayKey 仅全部清理完成后提交。
- seat carryover 仅同 symbol 继承；symbol 不同不带旧激活时长；空快照重复捕获不会抹掉已有有效 carryover。current `seatActivationCarryover.ts` 与旧对应文件除 import 路径外无实现变化。
- order domain 的拆能力清理顺序 `orderRecorder.resetAll → cache.clear → holds.clear → monitor.clearTracked → executor.resetBuyThrottle`，与 develop `src/core/trader/index.ts:223-228` 的聚合 `resetRuntimeState` 一致，不能把解聚合本身误报为漏清理。
- `openRebuild.ts`/`startupSnapshot.ts`/`startupRebuild.ts` 区分 COMMITTED、SUPERSEDED、ABORTED；同日 supersession 本地重载，内部/金融事实错误仍抛出，不伪装 external retry。最终票据不能换成当前 token 给旧事实续签。这些更强安全约束不等于已证明所有业务时机全等价，LC-01/LC-X1 仍须分别处理。

### 时间、门禁与外部失败

- **develop 原本就有** TimeWakeupRuntime 的 single-flight/dirty/one-shot 和纯 planner，绝不是这次新增“事件驱动”后都需重定义的业务。current `timeWakeupPlanner/index.ts` 与旧源码完全相同；`timeWakeupRuntime/index.ts` runtime 实现没有行为 diff（注释和 import 迁移单列核对）。bounded timer 函数体与旧相同。
- `domain/tradingSession/index.ts` 的八个函数与 develop `src/utils/time/index.ts` 逐函数体核对：运行语句相同；一个 helper 的 dayInfo 类型从 TradingCalendarDayInfo 换为 TradingDayInfo。地图把它候选定位到 lifecycle/utils 并不准确，实际对照的是旧 time 实现。
- 首轮/后续时间评估先推进 lifecycle，再发布连续时段/auto-search 授权，规划交易日、午休、收盘、午夜、保护窗口及外部失败 retry；没有把业务 route 的专有 timer 混入全局 planner。
- 外部 API 失败沿其 owner 的既有重评估或指数退避；内部错误通过真实错误分类 fail-fast。UNKNOWN 的策略差异已单列 LC-D1，不能被“普通外部失败仍重试”概括掉。

### fatal 与 cleanup

- `terminationRuntime.ts` 对旧 `src/app/runtime/createTerminationRuntime.ts` **原文相同**（不是只看 R100）：先同步锁存终态，尝试全部关闭回调后通知主流程；首个原始 fatal（含 null/undefined）不被次要停生产错误覆盖。同步 stop 与顶层异步 drain 分开，避免 handler 自 drain。
- `runApp` 资源创建在终止后落定才汇合 cleanup；增量注册可清理部分构造成功的资源；cleanup 单次 Promise、同 phase 稳定注册顺序、全部步骤尝试后 AggregateError。首 fatal 优先于 cleanup 次错。
- `signalRuntimeDomain.ts:77-107` 与 `constants/cleanup.ts` 核对：先取消 freshness 等待并停上游，再 monitor processor、seat cleanup、buy/sell、order monitor、S，最后 quote；TimeWakeup 不在午夜 signal domain 停止，从而既不 self-drain 死锁，也不会关门后失去日切/恢复唤醒。
- H/S/quote 的 stop/drain 直接链已追：S `postTradeSettlement/index.ts:685-707` 等待真实 in-flight 和 issued snapshot drain；最终 cleanup 的 H snapshot drain 在 S 后、quote 前；quote `:423-447` 等已有 mutation、拒绝重新借失败打开准入。没有仅以空 stop 替身的顺序测试证明远端资源全部释放。

## 七维 review lenses 汇总

| 维度 | 已做的具体检查 | 结果与界限 |
| --- | --- | --- |
| Implementation | 启动/初次失败、跨日域顺序、同日恢复、单航班 timer、授权、fatal/cleanup；真实生产闭环和旧实现对照 | LC-01 为待独立复核候选；LC-X1 因可达性证据不足排除。未深入详细订单算法。 |
| Project and Spec | AGENTS、TS skill、business skill、目标方案及 develop 真值 | 不用方案的“已完成”记录证明源码。LC-D1 为明文非等价/授权边界，需主代理显式处理。未发现有证据的新增 module-boundary 缺陷。 |
| Type Design | 34 文件中的 result union、captured token、readonly 能力、void→COMMITTED/ABORTED 消费、source 枚举、start/stop 最小能力 | 不以类型安全代替运行活性；gate capability 的布尔值未表达恢复事件契约是 LC-01 同根因，不另报。未对所有上游 SDK 中性类型作全量审计。 |
| Tests | 阅读关键 harness 与真实接线差异；运行 1354 个相关测试，另有跨日/失败/恢复离线组合 | LC-01 缺口是跨 owner 组合，不是机械覆盖率。通过测试不足以证明等价。 |
| Comments | 核对启动/午夜/开盘/stop 文档及历史时间假设；区别陈述和行为 | 主要注释能解释 why。局部旧 lastState/trader 词汇没有证明实质维护影响，未升级；UNKNOWN 文档确实承认行为不同。 |
| Dead Code | 查询关键公开 factory/start/stop/result 消费点、注册表和生命周期真实连接；检查拆出的 normalization 两个生产调用 | 未形成消费链完整排除的 A 级 dead-code 候选，不建议删除。完整全仓动态消费/外部导出排查未做。 |
| Simplification | 评估重复 baseline、拆分状态/能力、helper/事件间接层是否有真实额外业务/维护成本 | 不以文件数/行数认定过度设计。双 baseline 可疑但未证明现实额外 IO 或可靠性缺陷，不独立报“过度设计”；优先修复 LC-01 的单一 ownership 交接根因，不建议新建通用框架。 |

## 实际文件覆盖清单

**分级：**“已深读”指读到本文件的业务/契约实现并追本组所需调用，不等于所有依赖算法已审计；“等价 diff 核对”指明确对旧源码/函数体比较、检查差异与 import/调用契约，结论仅限所述范围；“未深入”不能计入证明全等价的覆盖。下表按用户地图精确列 34 个 G1 current 文件，**28 已深读、6 等价 diff 核对**；后面另列本组没有深入的跨组边界。

| current 完整路径 | 分级 | develop 对照或实际核对范围 |
| --- | --- | --- |
| `src/application/tradingDayRebuild/executionNormalization.ts` | 已深读 | 新拆/新增文件；对共享 merge 调用、两处消费者、零量/缺金额/known 处理逐项核对；不宣称 shared merge 全部经济规则等价。 |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | 已深读 | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`；读取全部主流程及 durable history helper，区分授权改造和历史修复。 |
| `src/application/tradingDayRebuild/openRebuild.ts` | 已深读 | `src/app/lifecycle/rebuild.ts` 的旧入口；当前完整 owner 循环/quote/S/结果消费，不当作简单迁移。 |
| `src/application/tradingDayRebuild/quoteSymbols.ts` | 等价 diff 核对 | 旧 `src/main/lifecycle/utils.ts` 的 collectRuntimeQuoteSymbols 函数体相同；旧 `src/main/utils.ts` 内 collectAllQuoteSymbols 仅去掉生产必传 registry 的空参分支/缩小参数。上游市场过滤不在此函数里证明。 |
| `src/application/tradingDayRebuild/rebuildTradingDayState.ts` | 已深读 | `src/main/lifecycle/rebuildTradingDayState.ts`；订单/日历/风险/激活/恢复顺序及 captured 失效处理。 |
| `src/application/tradingDayRebuild/seatActivationCarryover.ts` | 等价 diff 核对 | `src/main/lifecycle/seatActivationCarryover.ts` 实现无 diff（import 迁移单独核对）；另由真实跨日实验消费。 |
| `src/application/tradingDayRebuild/seatPreparation.ts` | 已深读 | `src/main/recovery/seatPreparation.ts`；历史+持仓恢复、启动补席准入和原授权。 |
| `src/application/tradingDayRebuild/startupFailureState.ts` | 已深读 | `src/main/lifecycle/startupFailureState.ts`；三个 lifecycle 字段的副作用。 |
| `src/application/tradingDayRebuild/startupRebuild.ts` | 已深读 | 原 runApp/`src/app/lifecycle/rebuild.ts` 相关旧内联链；不是仅凭地图配对。 |
| `src/application/tradingDayRebuild/startupSnapshot.ts` | 已深读 | `src/app/startup/startupSnapshot.ts`；READY/API pending/ABORTED 与本地重载。 |
| `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts` | 等价 diff 核对 | `src/main/lifecycle/tradingCalendarPrewarmer.ts`：可见差异为 lastState→calendar state、依赖类型/导入拆分；未把 API 实际日历正确性算作已验证。 |
| `src/application/tradingDayRebuild/types.ts` | 已深读 | 全部 363 行契约及消费者；旧 lifecycle/recovery 类型只作相应能力来源对照。 |
| `src/domain/tradingSession/index.ts` | 等价 diff 核对 | 实际来源 `src/utils/time/index.ts`；八个函数运行体相同、一个 dayInfo 参数类型改名，import 依赖核对。 |
| `src/domain/tradingSession/types.ts` | 已深读 | 新位置的 session range/due params；对实际函数消费。 |
| `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts` | 已深读 | `src/main/lifecycle/cacheDomains/globalStateDomain.ts`；H clear、唯一日期提交、整轮结果。 |
| `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts` | 已深读 | 对应旧域；午夜 reset 与开盘 receipt 确认。 |
| `src/runtime/lifecycle/cacheDomains/orderDomain.ts` | 已深读 | 对应旧域 + `src/core/trader/index.ts:223-228` 聚合清理实现对照。 |
| `src/runtime/lifecycle/cacheDomains/riskDomain.ts` | 已深读 | 对应旧域；冷却、日损益、episode、方向保持/清理次序及授权结果。 |
| `src/runtime/lifecycle/cacheDomains/seatDomain.ts` | 已深读 | 对应旧域；carryover 捕获/失效及空席位/version。 |
| `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts` | 已深读 | 对应旧域；全部 stop/drain 与 start/restart 实际连接，LC-01。 |
| `src/runtime/lifecycle/cacheDomains/types.ts` | 已深读 | 全部 169 行能力边界，与真实装配核对。 |
| `src/runtime/lifecycle/dayLifecycleManager.ts` | 已深读 | `src/main/lifecycle/dayLifecycleManager.ts`；全部状态/重试/owner/结果消费。 |
| `src/runtime/lifecycle/startup/types.ts` | 已深读 | 新拆 startup owner 能力；实际全部消费者。 |
| `src/runtime/lifecycle/startupRuntime.ts` | 已深读 | 原 runApp 初始次序；成功/失败分支与 timeWakeup 首评估。 |
| `src/runtime/lifecycle/terminationRuntime.ts` | 等价 diff 核对 | 旧 `src/app/runtime/createTerminationRuntime.ts` 原文相同；依赖同一 runtime contract；检查实际顶层接线。 |
| `src/runtime/lifecycle/types.ts` | 已深读 | 完整 CacheDomain、OpenRebuildContext/result 与 manager 消费。 |
| `src/runtime/timeWakeupEvaluationProgram/index.ts` | 已深读 | `src/main/timeWakeupEvaluationProgram/index.ts`；时间门禁、lifecycle、授权、doomsday 交接。 |
| `src/runtime/timeWakeupEvaluationProgram/types.ts` | 已深读 | 对应旧类型与 current 窄依赖；不把订单能力实现算作本文件覆盖。 |
| `src/runtime/timeWakeupPlanner/index.ts` | 等价 diff 核对 | 对应旧文件原文相同；输入/输出实际连接另核对。 |
| `src/runtime/timeWakeupPlanner/types.ts` | 已深读 | 完整候选/hasWork 联合类型。 |
| `src/runtime/timeWakeupRuntime/index.ts` | 已深读 | 对应旧文件；runtime 实现相同，停止注释变化，timer import 指向的函数体另核对。 |
| `src/runtime/timeWakeupRuntime/types.ts` | 已深读 | 完整 start/stop/drain 与 timer 依赖。 |
| `src/runtime/tradingGateEventRuntime/index.ts` | 已深读 | 对应旧实现；差异主要为类型拆源，事件隔离和消费边界核对；不将旧 listener 策略当新缺陷。 |
| `src/runtime/tradingGateEventRuntime/types.ts` | 已深读 | 完整 gate/auto-search publisher/subscriber 能力，LC-01 的实际消费者。 |

### G1 以外，为真实接线深入读取的生产文件

以下列的是实际读取分析，而非只出现于 import 的名字；边界仍以括号说明为准：

- 入口/装配：
  - `src/index.ts`
  - `src/app/runApp.ts`
  - `src/app/runAppDeps.ts`
  - `src/app/runtime/createPreGateRuntime.ts`
  - `src/app/runtime/createPreGateRuntimeDeps.ts`
  - `src/app/runtime/createPostGateRuntime.ts`
  - `src/app/runtime/createTradeRuntime.ts`
  - `src/app/runtime/createAsyncRuntime.ts`
  - `src/app/runtime/createPostTradeConsistencyRuntime.ts`
  - `src/app/context/createMonitorContext.ts`
  - `src/app/lifecycle/createLifecycleRuntime.ts`
  - `src/app/shutdown/createCleanup.ts`
  - `src/app/startup/prepareStrategy.ts`
  - `src/app/startup/createSelectedStrategy.ts`
  - `src/app/startup/tradingDayInfoResolver.ts`
- H/S 与席位授权：
  - `src/application/accountPositionSnapshot/index.ts`
  - `src/application/postTradeSettlement/index.ts`
  - `src/application/postTradeSettlement/readinessGate.ts`
  - `src/application/seatActivation/rebuiltSeats.ts`
  - `src/application/seatActivation/types.ts`（重建激活契约）
  - `src/domain/seat/symbolRegistry.ts`
  - `src/domain/strategy/ordinarySignalGuard.ts`
- runtime owner/异步生命周期：
  - `src/runtime/businessEventProgram/index.ts`
  - `src/runtime/autoSearchWakeupRuntime/index.ts`
  - `src/runtime/periodicSwitchWakeupRuntime/index.ts`
  - `src/runtime/quoteSubscriptionRuntime/index.ts`
  - `src/runtime/seatActivationDispatcher/index.ts`
  - `src/runtime/seatRuntimeCleanupDispatcher/index.ts`
  - `src/runtime/seatDiagnosticRuntime/index.ts`
  - `src/runtime/monitorDisplayRuntime/index.ts`
  - `src/runtime/tradingQuoteDisplayRuntime/index.ts`
  - `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
  - `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
  - `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
  - `src/runtime/asyncProgram/processor.ts`
  - `src/runtime/asyncProgram/taskNotifications.ts`
  - `src/runtime/asyncProgram/tradeTaskQueue/index.ts`
  - `src/runtime/asyncProgram/monitorTaskProcessor/index.ts`（queue/owner 交接；具体业务 handler 未全部深入）
  - `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts`
  - `src/runtime/asyncProgram/buyProcessor/index.ts`（准入、消费和排空，不含下游数量算法）
  - `src/runtime/asyncProgram/sellProcessor/index.ts`（同上）
  - `src/runtime/timer/index.ts`（另与旧 bounded timer 函数体对照）
  - `src/infrastructure/time/index.ts`
  - `src/constants/cleanup.ts`
  - `src/types/runtime.ts`
  - `src/types/lifecycle.ts`
  - `src/types/timeControlPlane.ts`

### 局部读取 / 未深入的跨组生产边界

- `src/application/orderTracking/orderMonitor/index.ts`：初始化、start/stop、cleanup 接口；没有为完整订单状态机背书。
- `src/application/orderTracking/orderMonitor/eventFlow.ts`：事件提交/fatal/刷新通知链。
- `src/application/orderTracking/orderMonitor/recoveryFlow.ts`：恢复时序、bootstrapping/ACTIVE 和重建连接。
- `src/application/orderTracking/orderMonitor/routeRuntime.ts`、`src/application/orderTracking/orderMonitor/routeProcessor.ts`：stop/drain、事件重入和部分 route 分支；大型路由算法未全读。
- `src/application/orderTracking/orderMonitor/settlementFlow.ts`：历史 d2aa590 时间条件和直接结算/通知调用点；未完整审计详细 settlement 算法。
- `src/application/orderTracking/orderHoldRegistry.ts`、`src/application/orderTracking/recorder/index.ts`：恢复/清理/归一调用消费；未穷尽订单账本所有算法。
- `src/application/doomsdayClearance/index.ts`：门禁、调度、UNKNOWN/外错上抛、canonical 持仓入口；未全量评估清仓选单和数量计算。
- `src/application/orderExecution/tradeMutationErrors.ts`、`src/utils/apiFailure/index.ts`：已读错误构造/分类，未将 broker mutation adapter 的全部行为计为本组审计。
- `src/application/seatActivation/index.ts:325-331`：normalizeExecutionOrder 的 KEEP_KNOWN 消费点；常规激活的其他算法未深入。
- `src/application/autoSearch/startupSeatSearch.ts`：启动补席失败政策、旧结果/版本准入；非完整候选排序算法审计。
- `src/domain/order/orderOwnership.ts`：读取历史席位解析规则；不替代订单身份组的全仓归属审计。
- `src/domain/seat/seatPolicy.ts`：ACTIVE/绑定和 `resolveSeatOnStartup` 的持仓优先/港股约束；未审全文件其他信号规则。
- `src/infrastructure/longbridge/trade/clientFactory/index.ts`：工厂资源/失败与 execution 接线局部；未全量审 SDK 映射、数值与所有市场范围。此前尝试的 `src/domain/seat/activation.ts`、`src/infrastructure/longbridge/clientFactory/index.ts` 和 `src/application/seatActivation/rebuildCommit.ts` 在固定 HEAD 不存在，读取失败，不计入实际覆盖；真实重建激活实现是上列 `src/application/seatActivation/rebuiltSeats.ts`。
- `src/infrastructure/longbridge/market/quoteClient.ts`：事件分发、订阅重置与约 835-920 行资源边界，未全读大型行情 adapter。
- `strategyLoaderHelpers.ts` 内部、详细下单/撤改单/数量规则、全部策略指标/验证算法、shared execution merge/history、日损益公式及适配器全市场边界 **未深入**。

### 实际测试/指令读取（不计入生产文件覆盖）

读取了 `AGENTS.md`、code-review/TypeScript/business/context-mode/lazy-senior skills 和目标架构方案有关章节；baseline map 只筛 G1/必要定位，未整份装入上下文。

重点阅读测试：`tests/runtime/lifecycle/dayLifecycleManager.test.ts`、`tests/runtime/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`、`tests/runtime/lifecycle/fixtures/openRebuildContext.ts`、`tests/runtime/periodicSwitchWakeupRuntime/business.test.ts`、`tests/runtime/timeWakeupEvaluationProgram/business.test.ts`、`tests/integration/rebuildSettlementReadiness.integration.test.ts`、`tests/integration/startupSettlementReadiness.integration.test.ts`、`tests/integration/postTradeDrainLifecycle.integration.test.ts`、`tests/helpers/accountPositionSnapshot.ts`、`tests/helpers/testDoubles.ts`、`tests/setup/testRuntime.ts`、`bunfig.toml`。运行目录中的其他测试只表示执行过，未一律计为深读。

## 验证结果

环境：`APP_ENABLE_PROCESS_HOOKS=false`、`APP_LOG_ROOT_DIR=NUL`；test preload 使用 OfflineSdkGuard。没有 lint:fix（它会改文件，与只读范围不符）。

```text
bun test tests/app tests/runtime/lifecycle tests/runtime/timeWakeupEvaluationProgram tests/runtime/timeWakeupRuntime tests/runtime/timeWakeupPlanner tests/runtime/timer tests/runtime/tradingGateEventRuntime tests/runtime/periodicSwitchWakeupRuntime tests/runtime/autoSearchWakeupRuntime tests/application/tradingDayRebuild tests/integration/rebuildSettlementReadiness.integration.test.ts tests/integration/startupSettlementReadiness.integration.test.ts tests/integration/postTradeDrainLifecycle.integration.test.ts tests/integration/lifecycle
exit=0
1354 pass / 0 fail / 7325 expect() calls
Ran 1354 tests across 122 files. [9.38s]
```

- 之前同范围一轮测试也 exit 0，但当时汇总被筛选，不补造那一轮的数量；以上数字来自最后一次实际执行。
- `bun type-check`：exit 0，输出 `$ tsc -p tsconfig.json`。
- LC-01：真实跨日/累积时长/四次 external retry/同段恢复离线组合成功复现；旧 periodic owner 同输入入队 1 项，当前补恢复事件后入队 1 项；无 fatal。
- LC-X1：人工 callback 注入可复现结构风险，但真实生产交错未证明，不作缺陷结论。
- 源码比较：termination/planner 原文相同；timer/交易时段函数体、部分域/reset 顺序单独对照，不靠 Git rename。曾有一次旧模块动态 import 和一次 sandbox TypeScript AST 入口失败，后来以正确绝对依赖重新执行；失败的运行不计为对照成功。
- 从落盘报告提取附录 A 并实际 `bun -e` 再执行：exit 0，输出与正文一致；表格计数核验 G1=34、深读=28、等价 diff 核对=6。
- `git status --short`：结束核验为空；固定 SHA 再次匹配。仅报告位于仓库外。
- **所有通过项仅证明所运行路径与声明的局部不变量，不证明全仓或本范围全量业务等价。**

## not assessed

1. 独立复核尚未执行；须由主代理安排另一通用子代理核验 LC-01 的生产可达性/基线对照/严重级别。本子代理无自行派生权限。
2. LC-D1 例外是否获本轮用户授权须主代理按最高优先用户要求确定；本组不把文档自述当用户新授权。
3. 详细订单、数字精度、全市场过滤、策略算法和 SDK 资源真实网络失效情形按前述边界未深入；不能给“2b67d36 三个根因全部修完”的总保证。
4. LC-X1 所需真实异步交错未证；全仓动态 dead-code 排除、形式化证明和长时间真实 SDK 演练未做。

## recommended next actions

1. 独立复核 LC-01；若确认，在真实 lifecycle 授权恢复交接处修共享根因，并加真实 owner 组合的行为回归。
2. 主代理显式标注 LC-D1，不把它藏在“架构等价”中；与用户认可例外的证据分别归档。
3. 合并 G0/G3/G4/G5/G6 的审计，尤其启动 execution 接线、数量和市场范围三个历史根因的完整性，避免既漏报又把旧已有检查误报为新增。
4. 不以本组 1354 测试通过替代跨组接线证明；保留本报告的覆盖/未深入分级和候选独立复核状态。

## 附录 A：LC-01 可运行的纯离线证据脚本

在仓库根目录用 Bun 执行下面 JavaScript；只动态 import 生产模块，IO/无关 owner 为内存替身，不写文件、不创建 SDK。仓库路径变动时只修改 root。最后会停止实验 owner。可直接从本报告抽取执行：

```powershell
$env:APP_LOG_ROOT_DIR='NUL'; $env:APP_ENABLE_PROCESS_HOOKS='false'
$p='C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-lifecycle.md'
$m=[regex]::Match([IO.File]::ReadAllText($p),'(?s)<!-- LC01_SCRIPT_BEGIN -->\s*```javascript\s*(.*?)\s*```\s*<!-- LC01_SCRIPT_END -->')
if (-not $m.Success) { throw '未找到证据脚本' }
bun -e $m.Groups[1].Value
```

<!-- LC01_SCRIPT_BEGIN -->
```javascript
// Real lifecycle/signal/seat/global domains + H/S + periodic. In-memory IO only.
const root = 'D:/Code/HSI-Strategy-Trading', base = 'file:///' + root + '/';
const paths = [
  'application/accountPositionSnapshot/index.ts', 'application/postTradeSettlement/index.ts',
  'runtime/lifecycle/dayLifecycleManager.ts', 'runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts',
  'runtime/lifecycle/cacheDomains/globalStateDomain.ts', 'runtime/lifecycle/cacheDomains/seatDomain.ts',
  'application/tradingDayRebuild/openRebuild.ts', 'runtime/timeWakeupEvaluationProgram/index.ts',
  'runtime/timeWakeupRuntime/index.ts', 'runtime/periodicSwitchWakeupRuntime/index.ts',
  'runtime/tradingGateEventRuntime/index.ts', 'utils/apiFailure/index.ts',
  'domain/seat/symbolRegistry.ts', 'application/tradingDayRebuild/seatPreparation.ts',
  'application/tradingDayRebuild/seatActivationCarryover.ts', 'application/seatActivation/rebuiltSeats.ts',
  'domain/tradingSession/index.ts',
];
const [Hm, Sm, Lm, Dm, Gm, Seatm, Om, Em, Tm, Pm, Bm, Fm, Rm, Prm, Cm, Am, Session] =
  await Promise.all(paths.map(p => import(base + 'src/' + p)));
let now = new Date('2026-04-29T00:00:00+08:00');
const clock = { now: () => now }, log = { info() {}, warn() {}, debug() {}, error() {} };
const diagnostics = { record() {} }, fatals = [];
const termination = { isTerminated: () => false, reportFatalError: e => fatals.push(String(e)) };
const monitorConfig = {
  monitorSymbol: 'HSI.HK', longSymbol: null, shortSymbol: null, orderOwnershipMapping: ['HSI'],
  autoSearchConfig: { autoSearchEnabled: true, switchIntervalMinutes: 5, autoSearchOpenDelayMinutes: 5 },
};
const seats = Rm.createSymbolRegistry(monitorConfig);
const activation = Date.parse('2026-04-28T15:59:00+08:00');
seats.updateSeatState('LONG', {
  ...seats.getSeatState('LONG'), symbol: '12345.HK', status: 'ACTIVE', lastSeatActivatedAt: activation,
});
const positions = [{ symbol: '12345.HK', quantity: 100, availableQuantity: 100,
  costPrice: '1', market: 'HK', currency: 'HKD', stockName: 'HSI RC' }];
const H = Hm.createAccountPositionSnapshot({
  dayEpoch: 1, clock, diagnostics, reportFatalError: termination.reportFatalError,
  scheduler: { schedule: queueMicrotask }, readPort: {
    getAccountSnapshot: async () => ({ totalCash: '10000', netAssets: '10100', positionValue: '100', cashInfos: [] }),
    getStockPositions: async () => positions,
  },
});
const S = Sm.createPostTradeSettlementWorkflow({
  snapshot: H, clock, diagnostics, termination, logger: log,
  scheduler: { scheduleTimer() { throw Error('Unexpected ordinary S timer'); }, clearTimer() {} },
  retryDelayMs: 1000, isExternalFailure: Fm.isExternalApiRequestError,
  hasPendingProtectiveOrders: () => false, onPositionsCommitted: async () => {},
});
S.bindBusinessDeps({ monitorSymbol: 'HSI.HK', seats, episodes: { getInProgressEpisodes: () => [] },
  completionPersistence: {}, lossBoundaries: { getLossOffset: () => 0 }, cooldownTriggers: {},
  riskProjection: { prepare: () => null, publish() {} } });
const lifecycle = { currentDayKey: '2026-04-28', lifecycleState: 'ACTIVE',
  pendingOpenRebuild: false, isTradingEnabled: true };
const time = { canTrade: false, isHalfDay: false, openProtectionActive: false };
const calendar = { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() };
const quote = { reconcileFromCurrentTruth: async () => {}, start() {}, stopAndDrain: async () => {} };
const bus = Bm.createTradingGateEventRuntime({ logger: log });
const tasks = [], periodicTimers = new Map(), systemTimers = new Map();
let nextHandle = 0;
const monitor = { config: monitorConfig, strategy: { invalidateAll() {}, resetForTradingDay() {} } };
const calcDue = ({ startMs, switchIntervalMinutes }) => Session.calculateTradingDurationDueAtMs({
  startMs, targetDurationMs: switchIntervalMinutes * 60000, calendarSnapshot: calendar.tradingCalendarSnapshot,
});
const periodicDeps = {
  termination, snapshot: H, monitorContext: monitor, symbolRegistry: seats,
  monitorTaskQueue: { scheduleLatest: t => { tasks.push(t); return true; } },
  getCanTradeNow: () => lifecycle.isTradingEnabled && time.canTrade === true,
  orderMonitor: { onOrderStateChanged: () => () => {} }, postTradeConsistencyRuntime: S,
  tradingGateEventRuntime: bus, calculateDueAtMs: calcDue, now: clock.now,
  scheduleTimer: (callback, delay) => { const id = ++nextHandle; periodicTimers.set(id, { callback, delay }); return id; },
  clearTimer: id => periodicTimers.delete(id),
};
const periodic = Pm.createPeriodicSwitchWakeupRuntime(periodicDeps);
let loads = 0;
const global = Gm.createGlobalStateDomain({
  logger: log, tradingTimeState: time, tradingCalendarState: calendar,
  quoteSubscriptionState: { allTradingSymbols: new Set() }, snapshot: H,
  runTradingDayOpenRebuild: date => Om.executeTradingDayOpenRebuild({
    now: date, termination, snapshot: H, quoteSubscriptionRuntime: quote, postTradeConsistencyRuntime: S,
    loadTradingDayRuntimeSnapshot: async () => {
      if (++loads <= 4) throw Fm.createExternalApiRequestError({
        operation: 'accountBalance', attempts: 3, cause: Error('transient'),
      });
      const r = await H.requestRefresh({ source: 'LIFECYCLE_REBUILD', dayEpoch: H.getStatus().token.dayEpoch,
        refreshAccount: true, refreshPositions: true }).result;
      const allOrders = [{ stockName: 'HSI RC', symbol: '12345.HK', executionStatus: 'FILLED',
        updatedAt: new Date('2026-04-28T15:59:00+08:00') }];
      await Prm.prepareSeatsForRuntime({ tradingConfig: { monitor: monitorConfig }, symbolRegistry: seats,
        positions: H.getView().positions, orders: allOrders, startupSeatSearch: { searchSeat: async () => {} },
        canContinue: () => true, now: clock.now, resolveCanAutoSearchNow: () => false });
      return { status: 'COMMITTED', snapshotToken: r.snapshotToken, allOrders, quotesMap: new Map() };
    },
    rebuildTradingDayState: async p => {
      const captured = ['LONG', 'SHORT'].flatMap(direction => {
        const st = seats.getSeatState(direction);
        return st.symbol ? [{ direction, symbol: st.symbol, status: st.status,
          seatVersion: seats.getSeatVersion(direction),
          lastSeatActivatedAt: Cm.resolveSeatActivationCarryover({ symbolRegistry: seats, direction, symbol: st.symbol })
            ?? date.getTime() }] : [];
      });
      if (!Am.commitRebuiltSeatActivation({ symbolRegistry: seats, snapshot: H,
        getIsTradingEnabled: () => lifecycle.isTradingEnabled, isTerminated: termination.isTerminated },
        { snapshotToken: p.snapshotToken, seats: captured })) throw Error('activation rejected');
      Cm.clearSeatActivationCarryover(seats);
      return { status: 'COMMITTED', snapshotToken: p.snapshotToken };
    },
  }),
});
const passive = { start() {}, restart() {}, stop() {}, stopAndDrain: async () => {} };
const signal = Dm.createSignalRuntimeDomain({
  logger: log, termination, monitorContext: monitor, quoteSubscriptionRuntime: quote,
  postTradeConsistencyRuntime: S, periodicSwitchWakeupRuntime: periodic,
  ...Object.fromEntries(['businessEventProgram', 'tradingRiskEventRuntime', 'monitorQuoteEventRuntime',
    'monitorDisplayRuntime', 'tradingQuoteDisplayRuntime', 'switchWakeupRuntime', 'autoSearchWakeupRuntime',
    'seatActivationDispatcher', 'seatRuntimeCleanupDispatcher', 'monitorTaskProcessor', 'buyProcessor',
    'sellProcessor'].map(k => [k, passive])),
  orderMonitor: { startRuntime() {}, stopRuntimeAndDrain: async () => {} },
  buyTaskQueue: { clearAll: () => 0 }, sellTaskQueue: { clearAll: () => 0 }, monitorTaskQueue: { clearAll: () => 0 },
});
const seatDomain = Seatm.createSeatDomain({ logger: log, symbolRegistry: seats,
  seatSwitch: { resetAllState() {} }, warrantListCache: { clear() {} } });
const manager = Lm.createDayLifecycleManager({ mutableState: lifecycle, snapshot: H,
  cacheDomains: [signal, seatDomain, global], diagnostics, termination, logger: log });
await manager.tick(now, { dayKey: '2026-04-29', canTradeNow: false, isTradingDay: true });
calendar.cachedTradingDayInfo = { dateKey: '2026-04-29', info: { isTradingDay: true, isHalfDay: false } };
calendar.tradingCalendarSnapshot = new Map(['2026-04-28', '2026-04-29']
  .map(d => [d, { isTradingDay: true, isHalfDay: false }]));
const due = calcDue({ startMs: activation, switchIntervalMinutes: 5 });
now = new Date('2026-04-29T09:30:00+08:00');
const evaluate = () => Em.timeWakeupEvaluationProgram({ logger: log, marketDataClient: {},
  tradingTimeState: time, lifecycleState: lifecycle, tradingCalendarState: calendar, snapshot: H,
  tradingConfig: { global: { doomsdayProtection: false, openProtection: {
    morning: { enabled: false, minutes: null }, afternoon: { enabled: false, minutes: null } } } },
  monitorContext: monitor, tradingGateEventRuntime: bus, dayLifecycleManager: manager, now: clock.now });
const T = Tm.createTimeWakeupRuntime({ termination, logger: log, now: clock.now, evaluate,
  scheduleTimer: (callback, delay) => { const id = ++nextHandle; systemTimers.set(id, { callback, delay }); return id; },
  clearTimer: id => systemTimers.delete(id) });
await T.start();
const transitions = [];
for (let i = 0; i < 4; i++) {
  const [id, timer] = systemTimers.entries().next().value;
  systemTimers.delete(id); now = new Date(now.getTime() + timer.delay); timer.callback();
  for (let j = 0; j < 220; j++) await Promise.resolve();
  transitions.push({ hk: now.toISOString(), state: lifecycle.lifecycleState, canTrade: time.canTrade });
}
console.log(JSON.stringify({ due: new Date(due).toISOString(),
  restoredActivation: seats.getSeatState('LONG').lastSeatActivatedAt === activation,
  loads, transitions, state: lifecycle.lifecycleState, enabled: lifecycle.isTradingEnabled,
  canTrade: time.canTrade, queuedTasks: tasks.length, periodicTimers: periodicTimers.size,
  nextSystemMs: [...systemTimers.values()][0].delay, fatals }));
// Old owner only: business source unmodified, just type erasure/import relocation.
const cp = require('child_process');
let old = cp.execSync('git show 6e239c8a128372bd9b2fb2d79464346792a5e81e:src/main/periodicSwitchWakeupRuntime/index.ts',
  { cwd: root, encoding: 'utf8' })
  .replace("'../../constants/index.js'", JSON.stringify(base + 'src/constants/index.ts'))
  .replace("'../../utils/timer/index.js'", JSON.stringify(base + 'src/runtime/timer/index.ts'));
const oldModule = await import('data:text/javascript;base64,' + Buffer.from(
  new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(old)).toString('base64'));
let oldTasks = 0;
const prior = oldModule.createPeriodicSwitchWakeupRuntime({ ...periodicDeps,
  trader: periodicDeps.orderMonitor, monitorTaskQueue: { scheduleLatest: () => { oldTasks++; return true; } } });
prior.start(); console.log('developOwnerQueued=' + oldTasks); prior.stop();
bus.emitGateStateChanged({ previousCanTrade: false, nextCanTrade: true });
for (let i = 0; i < 30; i++) await Promise.resolve();
console.log('manualGateReplayQueued=' + tasks.length);
T.stop(); await periodic.stopAndDrain(); await S.stopAndDrain();
if (fatals.length) throw new Error('unexpected fatal');
```
<!-- LC01_SCRIPT_END -->
