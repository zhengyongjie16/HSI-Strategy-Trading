# 验证覆盖补盲（不重跑全量）

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

## summary

- **verdict：本轮未新增可直接确认的实现缺陷。** 找到多项旧保护的迁移后断言；另证实一项此前验证交接表未列的、**计划明载但与 develop 不等价**的末日 UNKNOWN 策略差分（V-S1）。需主代理核对用户是否明确授权例外，不由计划、新 skill 或新测试自行授权。
- scope：固定 develop `6e239c8a128372bd9b2fb2d79464346792a5e81e` → HEAD `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；以 199 个未匹配旧标题为线索，定向筛查生命周期、信号、席位和订单风险。没有接管其他组的全链源码审计，也没有重审已送 G4/G5/G3 的 V-C1/V-C4/V-C5/V-C6。
- 方法：AST 索引的 1688→2458、旧标题未匹配 199 是**静态声明数**，不是执行测试数，也不等于保护消失。按生命周期/信号/席位相关路径与词汇初筛命中 82 条，再只追下表高价值路径；不声称逐一读完这 82 条或全部 199 条的源码。
- confidence：具体差分与列出的替代断言 **high**；补盲完整性 **medium**，不构成全仓功能等价结论。

## critical issues

None. 本补充无已完成第二独立复核的最终缺陷。

## major issues

None. V-S1 是已证实差分/授权核对项，不先行定级为实现缺陷。

## minor issues

None. 不报告风格、重复断言或单纯覆盖率意见。

## V-S1 — 计划明载的末日 submit UNKNOWN：旧刷新重评估 → 当前 fatal（待授权核对）

### 事实与运行路径

1. **同一外部原因可达两种分支，不只是改了测试错误类型。** develop `src/core/trader/orderExecutor/submitFlow.ts:121-129` 使用 `wrapExternalApiRequest`，`retries:0`（不直接重试 submit）；其 `src/utils/apiFailure/index.ts:293-320,340-375` 会将无业务码的 `network timeout / ETIMEDOUT` 归为 `ExternalApiRequestError`。当前真实 adapter `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts:170-185` 经 `mutationErrorClassification.ts:124-134` 将相同已发请求、无六位业务码的原因映射为 UNKNOWN；`src/application/orderExecution/submitFlow.ts:502-518` 构造 `TradeMutationUnknownError`。
2. develop `src/main/timeWakeupEvaluationProgram/index.ts:458-501` 对此刷新持仓、更新旧持仓事实、协调订阅，再安排 `currentMs + TRADING.INTERVAL_MS`；持仓/订阅暂态失败也保留系统级重评估。旧测试 `tests/main/timeWakeupEvaluationProgram/business.test.ts:760-909` 明确保护这些分支。
3. 当前 `src/application/doomsdayClearance/index.ts:827-844` 只消费 `ExternalApiRequestError`；UNKNOWN 原错上抛，经 `src/runtime/timeWakeupRuntime/index.ts:43-46,111-121` 报 fatal。`src/runtime/lifecycle/terminationRuntime.ts:32-57` 调用同步关停能力，`src/app/runApp.ts:66-98` 将该能力实接为关闭 `lifecycleState.isTradingEnabled` 和队列准入，`:353-374` 执行统一 cleanup 并暴露原 fatal。当前 `tests/runtime/timeWakeupEvaluationProgram/business.test.ts:962-1005` 刻意要求 UNKNOWN 不刷新、不协调订阅、不返回重评估计划。
4. **关键反证：不是隐蔽漏迁移。** `docs/architecture/architecture-refactoring-implementation-plan.md:33-35,849-865` 明确要求删除上述旧特殊分支，改走 fatal。新测试标题的相关行 blame 为 `4a148b3b`；UNKNOWN 构造分支为 `66e631cd`，不是直接归因给最后两次提交。

### 独立 TEMP 探针

`coverage-unknown-probe.test.ts` 向两版注入同一个 `Error('network timeout') + code='ETIMEDOUT'`；使用两版真实 doomsday owner、time evaluation 和 timer runtime，当前真实 mutation adapter，以及真实 termination runtime 记录关闭结果。无真实网络调用。

| 观察量 | develop | HEAD |
|---|---|---|
| 顺序调用 | submit → positions → subscriptions | 仅 submit |
| 返回后的持仓数 | 0（注入的刷新结果） | 1（保持原 canonical） |
| 下一次 timer | 1000ms | 无 |
| terminated / trading gate | false / open | true / closed |
| fatal | false | `TradeMutationUnknownError`，cause 保留 |

- Bun 子进程 **exit 0；1 pass / 0 fail / 14 expect；0.154s wall（Bun 105ms）**。
- 边界：未装配完整 submitFlow。探针在 executor 注入边界分别桥接真实旧 wrapper、当前 adapter 与生产所用错误构造；完整 submitFlow 的 throw/上抛连接由源码核对，不能将此写成完整实盘端到端证明。两版 timer 共享当前结构兼容的 termination fixture，仅用于观察同一 fatal 通道，不声称旧 termination 源码已深审。
- 启动器初次返回 1 是汇总正则只认 `tests`、未认 `1 test`；**测试本身第一次即 exit 0**。已从原始日志修正汇总，未重跑。原始 JSON/日志保留，修正证据为 `validation/coverage-unknown-probe-corrected.json`。
- 本次没有重跑 typecheck、lint 或全量测试；原门禁结果不变。

### 判定与建议

- **confirmed：**同一代表性暂态原因会改变进程继续运行、持仓刷新与下一次唤醒行为；不是业务等价。
- **potential impact：**末日响应丢失即关整个交易门；若远端实际未接受/未完成，剩余持仓将不再由本进程继续按旧策略重评估。探针没有证明真实市场发生漏平仓，也没有判定两种策略哪一种更安全。
- **不确定性：**方案虽声明这是明确决策，但本审计约束禁止由方案自行授权漂移；本分工没有用户明确批准该例外的证据。若主代理已有该证据或其他组已审同根因，应引用并归并，而非重复报 bug。
- minimal action：先确认是否进入用户批准的行为例外清单；若要求严格 develop 等价，由 G4/G5 复核旧恢复/重评估 owner 的保留方案。不要直接让所有 UNKNOWN 自动重提，也不要把旧系统级重评估误写成 SDK 自动 retry。
- validation：保留同一外部原因的差分检查及交易门/刷新/timer 断言；按获准语义验收。
- dimensions：implementation、tests、project/spec 的授权边界；尚未完成第二独立复核。

## positive findings — 旧标题未匹配不代表保护消失

下列为**具体测试断言的定位/抽查**，不是对相关生产模块全链等价背书。它们已由此前有效全量门禁执行，本轮只定向读断言，不重复跑全量。

| 旧保护线索（develop 测试） | 当前可运行保护证据 / 本轮结论 |
|---|---|
| `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts:264` 后续工厂失败前登记 listener disposal | 当前同文件 `:327-360`：真实工厂失败后 cleanup 两次，unsubscribe 只一次。保护仍在，不是删测。 |
| `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts:1237` pending work 清除后才推进 freshness | `tests/application/postTradeSettlement/postTradeSettlement.business.test.ts:1397-1444`：invalid baseline 不清 pending、不发 fresh；真实 rebuild commit 后才到 version1/fresh。迁至 application owner。 |
| 同旧文件 `:1653` 正常终止等待晚到持仓订阅提交，双 owner 排空后不得 mutation | 当前 `postTradeSettlement.business.test.ts:1832-1906`：订阅未完成时 drain 等待；posttrade drain → quote drain；后续 retain/reconcile 不再 mutation。 |
| `tests/app/shutdown/createCleanup.business.test.ts:166` 最后 reset market data | 当前同文件 `:124-164` 的完整有序断言仍以 `resetMarketData` 结束；不是单项标题消失就丢保护。 |
| `tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts:329` 午夜后从 committed truth 重投影订阅 | 当前 `tests/runtime/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts:350-394`：两次相同订阅集合与最终集合相等。仅状态载体改名。 |
| `tests/main/lifecycle/cacheDomains/{globalStateDomain,riskDomain,orderDomain,signalRuntimeDomain}.test.ts` 清理和重建顺序 | 当前镜像下 `globalStateDomain.test.ts:60-156` 保护关门、清空 canonical、旧 token 失效并等待已发 IO；`riskDomain.test.ts:19-156` 保留 BUY 冷却、日损与非 minutes 午夜清理；`orderDomain.test.ts:13-58` 保护运行态 reset；`signalRuntimeDomain.test.ts:309-323,491-520` 保护停/排空顺序与 quote + postTrade baseline 先于 runtime 启动。 |
| 旧 BUY/SELL processor 业务下沉后，是否丢串行/迟到任务保护 | `tests/runtime/asyncProgram/buyProcessor/index.test.ts:19` FIFO + 在途排空；SELL `index.test.ts:58,193` 保留重试等待不堵队列、停止取消句柄与迟到 callback 不恢复旧任务。业务断言转移后不能只数原 processor 的 expect。 |
| 普通 BUY 风控/席位失效与 SELL 旧日授权 | `tests/application/ordinaryBuy/index.test.ts:76-241` 保留原成本相等拒绝、实时报价后读取实时事实、await 中席位身份变化不得提交；`riskChecks.test.ts:113,194,308,484,530` 保护冷却含时间0、亏损提前拒绝、实时账户/持仓与内部错误不降级。`tests/application/ordinarySell/index.test.ts:267-328` 保护报价 await 中 DAY_CUT 后旧 epoch 不提交及原日历/数量上限传递。 |
| 旧空席位寻标失败、冷却、旧 owner 不能覆盖新席位 | `tests/application/autoSearch/autoSearch.business.test.ts:66-239` 保留 LONG/SHORT 激活、冻结、冷却等；`autoSearch.staleContinuation.business.test.ts:43-178` 保留晚到 candidate/null/external 不落账、stale internal 保留原错、交易日与席位版本隔离及 context await 失权不得发真实查询。 |
| 旧 LONG/SHORT 三入口同一候选策略与触发方向无关 | `tests/integration/autoSearchPolicyConsistency.integration.test.ts:134-239` 的参数化 LONG/SHORT 真实三入口断言仍比较同一候选；`tests/domain/seat/warrantSelection/business.test.ts:16-371` 另保护开区间、主/降级排序、精确金额及比例单位。后者不是替代集成测试的理由；这里二者均存在。 |
| 旧重建订单/日历/展示失败 | `tests/application/tradingDayRebuild/rebuildTradingDayState.test.ts:316,552,577,758,788` 等：SHORT 坏成交使整个 preflight 在 commit/prepare/publish/tracking/ACTIVE 前失败；内部错误保留原 identity。包装文案改变不等于旧失败保护被吞掉。 |

另抽到一个**不能直接当删保护**的反向 oracle：旧 `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.business.test.ts:611-627` 要求 accepted 后即使 seatVersion 已变仍清本地状态；当前 `tests/application/staticLiquidation/business.test.ts:681-700` 要求保留 accepted ID、但不得向已换席位清理/发布。当前生产 `src/application/staticLiquidation/index.ts:338-381` 明确区分真实 broker ID 与旧授权下的本地发布。**这是局部语义真变化，不以“更安全”自动认定等价；但尚未追到导致额外交易/错误风险计算的完整外部路径，因此不提升为新可靠缺陷候选。** 若其他组正审 accepted/stale-owner 语义，宜作为同根因线索归并。

## 实际源码覆盖（本补充新增阅读；不冒充全文件审计）

| 当前生产文件 | 本轮深读区段 / 限制 |
|---|---|
| `src/runtime/timeWakeupEvaluationProgram/index.ts` | `183-227,340-411`；其余为既有阅读/符号核对，不新增全文件覆盖声明。 |
| `src/application/doomsdayClearance/index.ts` | `260-504,620-847`；不宣称本轮完整审清所有 retry 状态分支。 |
| `src/application/orderExecution/submitFlow.ts` | `452-570`；UNKNOWN/accepted/私有授权取消上抛；其他入口只是符号定位，已有 V-C4 不在此重复判定。 |
| `src/application/orderExecution/tradeMutationErrors.ts` | `1-63` 全文；只限错误构造契约。 |
| `src/infrastructure/longbridge/trade/mutationErrorClassification.ts` | `1-190` 全文；未对每个 cancel/replace broker 码逐一做等价复现。 |
| `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts` | `1-185`；submit 序列化/调用/分类，不含后续 replace/cancel 实现。 |
| `src/utils/apiFailure/index.ts` | `1-109` 全文；错误身份与内部错误判定。 |
| `src/runtime/timeWakeupRuntime/index.ts` | `1-175` 全文；timer/dirty/fatal/stop。 |
| `src/runtime/lifecycle/terminationRuntime.ts` | `1-68` 全文；fatal 锁存及同步关停。 |
| `src/app/runApp.ts` | `58-102,330-381`；核对 fatal 实接关门/停准入及顶层 wait/cleanup 尾段，不算完整 app 装配审计。 |
| `src/application/staticLiquidation/index.ts` | `335-383`；accepted 后 stale 身份与清理/风险发布尾段；其他流程仅检索。 |

旧版对照深读区段：`src/main/timeWakeupEvaluationProgram/index.ts:1-122,396-510`；`src/utils/apiFailure/index.ts:1-180,280-375`；`src/core/trader/orderExecutor/submitFlow.ts:112-141,522-598`；`src/core/doomsdayProtection/index.ts:1-82,142-201,436-555`，另定位工厂签名。旧 TimeWakeupRuntime 实现在探针中被执行，但**本轮未深读**；不能把导入执行算源码阅读。fixture/helper/type/config 的阅读用于组装探针或核对声明，不扩计生产链路覆盖。

## not assessed

- 199 条未匹配旧标题逐一回归映射，以及未选择的其余链路；本轮是补盲抽查，不是完整测试等价证明。
- V-S1 的用户授权原文、第二独立复核和真实远端响应/收盘风险；实施计划不是授权替代品。
- static accepted 后 stale 席位局部清理变化的完整结算/重建后果；只掌握局部事实，不报最终缺陷。
- 以上测试定位没有替代相应生产 owner 的完整调用链审计；生命周期/普通信号/寻标等生产源不因读了测试就计为深审。
- 七维中 implementation/tests 与相关注释/窄类型已定向检查；完整类型设计、死代码、简化不在此次补盲范围，未额外提出相关缺陷；方案一致性仅就 UNKNOWN 明文核对，不能据此确认全方案一致。

## 只读与证据

- 所有新增文件仅写 TEMP：本报告、`coverage-unknown-probe.test.ts`、`run-coverage-unknown-probe.cjs` 及 `validation/coverage-unknown-probe*` 原始/修正结果。没有改仓库源码、测试、配置，也没有删原始失败记录。
- 使用既有白名单环境、TEMP 用户目录、`--no-env-file` 与外部 SDK 工厂 guard；submit 为注入的纯离线方法。不是 OS 网络隔离证明。没有启动 app/start/dev 或访问真实交易账户。
- 探针前后，旧快照 **525** 和当前快照 **823** 个 tracked 文件 SHA-256 均未变；原仓库 HEAD 固定，`git status --porcelain` 为空，`git diff --check` exit0。
- 续跑核实当前可见进程祖先 PID **32780**（`node.exe`）显式参数仍为 `provider=cliproxyapi / model=gpt-6.1-sol / thinking=max`，证据 `validation/coverage-model-runtime-flags.json`；仅证明可见运行配置，不证明代理服务后台路由。

## recommended next actions

1. 主代理先核对 V-S1 是否已有用户明确批准的行为例外，或已由其他组独立审过同根因；缺证据时定向交 G4/G5，而不是把该计划明载变化包装成漏迁移。
2. 将上表替代保护定位用于消除“旧标题未匹配=删保护”的误报；不要用它们替代六组剩余源码审计，也不要扩成全仓等价结论。
3. V-C1／V-C5／V-C6的最终二审归并以总报告为准；V-C4已归并为B01，用户明确授权、非问题。本补盲没有新代码变化或未解决测试失败，不需要重跑全量门禁。
