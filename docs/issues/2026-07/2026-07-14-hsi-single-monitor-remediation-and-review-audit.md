# HSI 单监控重构：长时多代理修复与复核审计结论

- **记录日期**：2026-07-14
- **覆盖会话**：`019f55f1-d612-7543-93ab-f0ec1230317a`
- **会话时间窗**：2026-07-12 10:49:05 UTC 至 2026-07-14 12:00:27 UTC，约 **49 小时 11 分**。用户所称“近 40 小时”是近似值，本文以会话元数据为准。
- **审计对象**：HSI 单监控重构后的生产链、后续订单/风控/自动寻标修复，以及各阶段验证结论。
- **关联记录**：[2026-07-11 HSI 单监控全链路问题记录](2026-07-11-hsi-single-monitor-full-chain-review-findings.md)。后者保留原始 19 项 finding 与 R1 复核历史；本文补充长会话期间的实施、二次复核和最终验证边界。

---

## 1. 先给结论

本次工作不是一次单纯的“把测试跑绿”的重构。它从真实交易不变量出发，先后修复了订单事实单调性、最终报价/数量 TOCTOU、自动寻标 owner 存活性、保护性清仓与 DailyLoss 持久化、末日接管、风险门禁和 TypeScript 类型边界等问题。修复原则始终是：

1. 经纪商、行情和持久化输入是外部事实；事实缺失、非法或倒退时 fail-fast，不伪造时间、数量或归因。
2. 每个不可逆 mutation 后必须存在明确的继续推进 owner；不能留下没有 timer、事件或 route 的 pending 状态。
3. 任何会等待异步操作的下单路径，都必须在真正 SDK mutation 前重新读取最终事实并重新授权；不能沿用 P0 快照。
4. LONG / SHORT、`seatVersion`、订单、关联买单、累计成交和保护性清仓事件必须各自保持单一事实来源。
5. 不以 fallback、兼容层、吞错、`Date.now()` 伪造、旧值回填或“最小值补偿”掩盖未知事实。

历史记录支持以下两个不同层次的结论：

- **已闭环的历史 finding**：原始 19 项以及第一次完全重构后 R1 的 1 项 Critical、5 项 Major，都有相应的结构修复、定向反例和独立复核记录。它们在各自的验证快照中已关闭。
- **当前工作树的最终全仓结论不能写成“全绿/零问题”**：2026-07-14 最后一次完整 `bun test` 的真实结果是 **1653 pass / 6 fail / 1659 tests / exit 1**。之后用户明确收敛范围，只允许修复并复核 `apiFlakyRecovery`；该单测已通过定向修复与独立复核，但没有随后新的全仓测试、七维全仓深审或统一残留扫描。因此，不能把历史 `1275 pass / 0 fail` 或局部测试通过投射为当前工作树的最终全仓通过。

这不是否定已完成的修复，而是严格区分“已确认业务问题的闭环”和“当前整棵工作树的最新验证状态”。

---

## 2. 审计方法、证据等级与代理覆盖

### 2.1 代理与会话覆盖

从根会话递归解析 `session_meta.parent_thread_id`，得到：

| 项目                           | 数量 / 结果                      |
| ------------------------------ | -------------------------------- |
| 会话节点总数                   | 231（主会话 1 + 子代理后代 230） |
| 直接子代理记录                 | 193                              |
| `repair_*` 任务节点            | 73                               |
| `review_*` 任务节点            | 64                               |
| `confirm_*` 任务节点           | 45                               |
| `audit_*` / `final_*` 任务节点 | 15                               |

这些数字表示可追溯的任务会话节点，不表示 230 个互相独立、只执行一次的审查结论。同一代理可通过 follow-up 复用，因此不能仅凭任务名判定某个 finding 已关闭；本文只采用带时间的主会话摘要、确认/修复/复核的最终回报和实际命令输出。

### 2.2 统一工作流

```text
生产调用链 / 类型契约 / 运行时事实
  -> 独立确认（确认可触发性、业务影响、修复必要性）
  -> 最小结构性修复（先 RED，后 GREEN）
  -> 独立复核（不由实现者自证）
  -> 定向回归与阶段性全量验证
```

审计时拒绝以下推理捷径：

- 仅凭旧文档或旧测试失败认定生产代码有错；
- 仅凭全绿测试认定业务不变量成立；
- 将结构上可表示的非法状态夸大为已发生的生产事故；
- 为了保持旧测试或旧 API 形状而恢复兼容壳；
- 将合法的 symbol/order/direction Map 误删为“多 monitor 残留”。

### 2.3 证据优先级

1. 当时的真实命令输出、最小复现、RED/GREEN 记录和独立复核回报。
2. 当前 canonical findings 文档中明确标注的阶段性关闭与限制。
3. 被标记为历史快照的 plan 和早期测试计数，仅用于解释过去，不能替代当前事实。
4. 子代理任务名、局部日志和代码搜索结果只能作为定位线索，不能单独成为关闭依据。

---

## 3. 已确认的原始 19 项问题及第一轮结构修复

完整触发链、旧快照行号和每项定向测试见关联 findings 文档。为避免把上千行历史证据重复两遍，本节按业务性质归并，仍保留所有 finding 编号。

| 分类 | finding | 已确认的业务风险 | 结构性修复结果 |
| --- | --- | --- | --- |
| 可触发生产缺陷（12） | C-01、C-02、C-03、C-04、M-01 至 M-07、m-02 | 换标进入 `SWITCHING` 后可能失去唯一 owner；broker 已接受订单可被本地遗弃；开放订单恢复遗漏；WS 累计成交可倒退；无候选/异常后自动寻标停摆；末日拒买截止后仍提交；保护性清仓过早认定完成；重启日亏重复或错误分段；REPLACE 成功被报为零动作；同价订单恢复排序不稳定。 | 将 owner handoff、订单生命周期穷尽分类、单调事实合并、最终提交授权、progress/completion 分离、DailyLoss 幂等 baseline、稳定排序和动作结果判别化。 |
| 类型与结构边界（5） | M-08、M-09、M-10、M-11、m-03 | `SeatState`、pending switch、交易日历、买入风控和最终订单命令允许非法或重复表达的状态。部分属于“可构造风险”，并未声称已经在线触发。 | 使用判别联合、非空 `WAIT` owner、required calendar、`BuySignal` 风控入口和统一 `ExecutableOrderCommand` 收紧边界。 |
| 冗余与文档治理（2） | m-01、m-04 | Context 信号/延迟信号双真相镜像会漂移；旧 review/recheck 文档把历史状态写成当前事实。 | 删除镜像；将旧 plan 明确降级为历史快照，并由 canonical findings 文档承接当前结论。 |

其中必须特别区分两点：

- M-03 已证实的是“异步流程跨过末日拒买截止仍会在最终 API 前提交”；没有扩张为“迟到订单必然永久逃逸撤单”。
- M-08、M-09、m-03 是必须修复的公共类型/最终边界风险，但报告没有虚构它们都已在生产造成事故。

原始审查发现时，旧测试中存在五类反向固化错误语义：broker ack 后不追踪、寻标异常不计失败、FILLED 即完成保护性清仓、REPLACE 记为零成功、SELL 仍进入 BUY 风控。这是为什么本轮不能把旧测试期望直接视为业务规范。

---

## 4. 第一次完全重构后 R1 复核：新增 1 Critical、5 Major

第一轮修复完成后并没有直接宣布收敛，而是重新启动七维审查。R1 的 6 项 finding 及其结论如下。

| finding | 确认问题 | 修复与复核结论 |
| --- | --- | --- |
| R1-C-01 | TERMINAL state-check 可用陈旧终态否认本地已知累计成交，导致结算、DailyLoss、pending-sell 和 tracking 以较小事实收口。 | WS、OPEN state-check 与 TERMINAL state-check 统一进入单调事实合并；陈旧终态不再降低已知 quantity、price 或 revision。已关闭。 |
| R1-M-01 | AutoSearch 慢失败跨过 cooldown 后，route 释放时可能既无 timer、无事件也无 active route，留下未冻结 EMPTY 席位。 | 按权威 seat state 做 owner handoff；未到期注册唯一 one-shot，到期立即重驱，并覆盖慢失败时序。已关闭。 |
| R1-M-02 | mixed-log 的 record type、schema version 和 ID 公式分散在多个 producer，存在协议漂移风险。 | repository 只接收 domain input，协议字段与 canonical ID 全部内部派生。已关闭。 |
| R1-M-03 | DailyLoss “边界前最强 execution snapshot”算法在三条路径重复，未来容易分叉。 | 抽为一个纯 selector/comparator，rebuild、prepare、restore 共用。已关闭。 |
| R1-M-04 | 公共 SymbolRegistry mutation 接受包含 bootstrap 静态成员的完整 `SeatState`。 | 对外收窄为 `RuntimeWritableSeatState`，bootstrap 仅留在构造期。已关闭。 |
| R1-M-05 | 正式 findings 文档把历史测试盲区、已关闭项和当前状态混在一起。 | 分层保留历史快照与当前结论，避免文档本身误导后续修复。已关闭。 |

R1 闭环后明确保留的边界包括：真实 Longbridge WS 乱序/重连、仓库外 `SeatStateChangedEvent` 消费者、mixed-log 多进程并发与断电级持久化均未做真实环境验证；这些不是“已归零”的项目。

---

## 5. 本次长会话继续发现并修复的主链问题

本节来自 2026-07-12 至 2026-07-14 的会话取证，不以旧文档替代实时确认。每一项均按确认、最小修复、独立复核拆分；若日志只支持阶段结论，则明确写出限制。

| 领域 | 已确认的问题 | 最短结构修复 | 复核结论与限制 |
| --- | --- | --- | --- |
| 延迟验证与启动订单恢复 | `DelayedSignalVerifier` 内部异常可能绕过 post-gate fatal drain；重建只恢复 `Filled` 会漏掉具有效成交事实的终态部分成交订单。 | fatal handler 成为必需依赖并进入既有致命错误通道；重建按“终态 + 有效成交事实”归档，OPEN 只保留 pending。 | 独立复核与 124 项重建定向测试、lint、type-check 记录均通过。日历 provider 的一项空值候选没有完整最终正文，不单独列为闭环。 |
| 最终报价、数量与 SDK mutation TOCTOU | BUY、SELL、保护性、末日、REPLACE 在限流/撤单/仓位 await 后仍可能使用 P0 旧报价、旧 lotSize 或旧数量。 | 在现有 mutation permit 内读取 P1 最终报价、重新授权和重算数量；仅 `invoke()` 实际消耗 SDK 配额。覆盖 submit、CANCEL_AND_SUBMIT、REPLACE、cancel 和 timeout-MO。 | 先 RED 后 GREEN；P1 payload、quantity、track price、FIFO 和无效 P1 零副作用均有专项回归。 |
| 撤单重提交与智能平仓 | 撤单窗口发生部分成交后可能按旧剩余量重挂；最终可卖量小于关联整单量时会让 pending-sell 与账本分叉。 | 在实际副作用前重新读取权威终态/可卖量；关联买单与最终数量保持整单原子一致，不用 `Math.min` 补偿截断。 | 受控 `100/40`、`110` 场景和 112 项相关测试记录支持修复；本审计未提取到每项最终审查全文，故不虚构更细总数。 |
| DailyLoss、保护性清仓与 durable progress | 非法 `updatedAt` 可静默漏算；同日身份冲突在失败前可能清旧偏移；保护性终态 progress 的持久化/依赖次序不完整。 | 先构造并验证候选事实再原子提交；严格时间事实；`prepareProtectiveTerminalExecution` 变为 required DI，并在 snapshot/settlement 前 durable-first。 | 独立 audit 反证 DailyLoss 原子提交，protective hook 复核确认无 optional/fallback。 |
| SDK 日期与订单原始事实 | Invalid/0/负 Date 可穿过 SDK 边界；恢复使用 `Date.now()` 伪造；WS、OPEN、TERMINAL/state-check 可能借旧 tracked/known 值补齐新增成交。 | `orderApiManager` 在唯一外部边界拒绝非法时间；`orderFactMerge` 对每次新增成交要求本次 raw quantity/price/time/revision 合法且单调，不回填旧值或当前时间。 | manager 23/23、recovery 7/7 与独立边界审查通过。日志仍建议补一组 `updatedAt:null/undefined` 端到端覆盖，是否已全部补足无法仅靠本次提取断言。 |
| orderMonitor state-check、602013 与撤单 API | raw preflight 曾晚于 cache/outcome/retry/tracked 写入；第 5 次 602013 查询可覆盖 WS 已切换的 owner；retry index 有 `?? 8000` fallback；普通/末日撤单共享 overload。 | preflight 前置到任何写入前；用 owner snapshot 阻止旧 await 重写 `WAIT_WS_ONLY`；非法 retry index fail-fast；拆分 `cancelOrder` / `cancelDoomsdayOrder`。 | 第 6 次 replace 竞态 RED/GREEN 和独立复核支持闭环；中期 lint/fixture 噪音被后续单独处理，不应反推业务修复无效。 |
| 生命周期、末日接管与换标 | 15:55/11:55 接管后，跨 await 的距离/周期换标、pending switch 和静态清仓仍可能推进，关闭 gate 后可能再次 handoff/replan。 | required 实时 `canContinue` 在每个外部 await 后、seat mutation/owner handoff/broker mutation 前复核；普通链和末日链保留不同 owner。 | 151 项 focused 通过并有 `SWITCHING` 归因验证；独立 review 链记录为闭环。 |
| 自动寻标 route owner | 午休、lifecycle close、stop 或末日接管期间 finder 返回，可能把过期 SEARCHING 推进为 ACTIVATING/失败计数；授权事件晚到时 route 已删，SEARCHING 永久残留。 | 每个 await 后验证授权、direction、seatVersion、SEARCHING；关闭时原子 `EMPTY + version bump`，重开重驱；finally 删除 route 前取消仍归属该 route 的失效 owner。 | 第一版修复后复核又发现“finder 先完成、授权事件后到”竞态，随后真实时序 RED/GREEN 修复。最终报告为 stale 6/6、auto-search 17/17、time-wakeup 31/31，另有 lint/type/diff 通过。 |
| 风控类型与 BUY 浮亏门禁 | `RiskChecker`/持仓限制可接受 SELL/HOLD/null；保护性清仓尚未执行时，浮亏触发的普通 BUY 仍可能穿过 pipeline 与最终 P1 submit。 | 风控接口只接受 `BuySignal`；同一 required `RiskChecker.checkUnrealizedLoss` 同时用于预筛和 P1 最终 BUY gate；SELL、保护性、末日 SELL 走明确旁路。 | SELL/HOLD/null 类型 RED，RiskChecker 30/30；BUY 浮亏 60/60。独立复核确认阈值 0/相等/缓存缺失语义与无 fallback/no-op。 |
| 死代码、规范与测试契约 | 删除 `resolveOrderSide`、`isOrderNotFound`，并处理 rateLimiter 时间闭包、permit 判别、周期 wiring、fixture、注释和命名残留。 | 直接删除无调用符号，收紧 required test doubles，修正实际职责的测试；不保留别名或兼容路径。 | build 后 `dist` 复扫确认已删符号无残留。局部规范闭环不等价于当前整个脏工作树无所有规范债。 |

---

## 6. 最后六个测试失败：必须与生产缺陷分开看

2026-07-14 的全量测试不是“生产发现 6 个新 bug”，而是发现 6 个需要逐项确认的测试契约问题：

| 失败域 | 当时的确认结论 | 后续状态 |
| --- | --- | --- |
| `tests/chaos/apiFlakyRecovery.test.ts` | 测试把普通 `Error('transient ...')` 当成可重试 SDK 暂态错误，且 fake timer 用固定 microtask 次数猜测 retry timer 已登记。生产分类只接受 network/timeout/明确状态码等事实，不能为绿测扩大分类。 | **已修复并复核**。改为既有 `network timeout` 契约；先观测 retry timer，再推进时间并等候第二次 cancel 与 route timer。生产代码未改。 |
| `tests/integration/sellFlow.integration.test.ts` | `CANCEL_AND_SUBMIT` 遇到 TERMINAL `executedQuantity=null` 时，正确行为是任何本地结算前 fail-fast；旧测试名称写“fails closed”却期待正常空结果。 | **已修复并复核**。测试现在断言 reject，并保留 `cancelOrder=1`、`orderDetail=1`、`submitOrder=0` 与无 pending-sell 占用副作用；定向运行 1 pass / 0 fail。 |
| `tests/main/asyncProgram/buyProcessor/business.test.ts` 的 4 项 | 旧测试仍把 BuyProcessor 当成第二次最终报价、最新买价、lotSize、最终 permit/TOCTOU owner；这些职责已迁移到 `OrderExecutor/submitFlow`。 | 在用户收敛命令前复核被中断，故不能把 4 项一律写成生产缺陷或已关闭测试债。 |

`apiFlakyRecovery` 的最后一次定向链条为：独立确认 → 测试修复 → 独立复核发现固定 flush 仍有时序假设 → 条件式等待二次修复 → 独立终检批准。其最终断言仍是：撤单成功后等待 WS 非成交终态，`orderDetail=0`，`submitOrder=0`；没有新增盲重试、兼容分类或生产 fallback。

---

## 7. 验证证据时间线：不可混用的快照

| 验证阶段 | 实际证据 | 覆盖范围 | 可以得出的结论 | 不能得出的结论 |
| --- | --- | --- | --- | --- |
| 更早历史快照（2026-07-08） | `1116 pass / 0 fail` | 早期 single-monitor 树 | 当时版本通过 | 不能代表本轮工作树。 |
| 本轮开始前 handoff（2026-07-12） | `1275 pass / 0 fail` | 本轮开始前 baseline | 可解释本轮起点 | 是交接记录，不是本轮结束后的 fresh run。 |
| 初期验证 | 某个较早 index 快照上的 `git diff --cached --check` exit 0；同时发起过 `bun test/lint/type-check` | 早期修复树 | 该时点的 cached diff 无空白错误 | Bun 命令完成输出在异步续接中截断，不能记作已证明全绿；也不代表随后或当前暂存区状态。 |
| 多轮定向 RED/GREEN | DailyLoss 113/0、loader 55/0、smart sell/orderOps 33/0、BUY 80/0、route 77/0、fixture 合计 108/0 等 | 各自模块 | 对相应修复有直接回归证据 | 互相重叠，不能相加成全仓测试总数。 |
| **最后完整测试**（2026-07-14 19:29 SGT） | `bun test`：**1653 pass / 6 fail / 1659 tests / 163 files / exit 1** | 当前当时全仓测试 | 全仓测试未通过；6 个失败需分别判定 | 不能写成 1653/0 或问题归零。 |
| 同一完整验证批 | `bun type-check` exit 0；`bun run build` exit 0；`git diff --check` exit 0（仅 CRLF warning） | 全仓 TS、构建、diff whitespace | 这三项在同一快照通过 | 不能抵消测试 6 fail；`bun lint` 虽曾执行，但可用完成输出为空，不能标为本轮最终已证实通过。 |
| 全量失败后的诊断 | apiFlaky RED：0/1；BuyProcessor：6/10 pass、4 fail | 失败项 | 可用于定位测试语义/时序 | 不是新的全仓验证。 |
| apiFlaky 最终定向验证 | 单测 1/0；scoped Prettier、ESLint、`git diff --check` 通过 | 仅 chaos harness | 该测试修复通过、生产分类未扩大 | 不是全仓 test、format、lint 或 residual scan。 |

因此，本报告的最终验证结论是：**已确认修复具备相应的定向测试与独立复核；当前工作树没有“最后一次全仓测试全绿”的证据。**

---

## 8. 复核结论

### 8.1 已获得复核支持的结论

1. 单监控目标模型仍是正确的：一个可配置 HSI monitor，LONG/SHORT 方向隔离，SymbolRegistry 为席位真相，外部事实保留 monitor 归因校验，内部 route 不重新引入 monitor 维度。
2. 原始 19 项与 R1 6 项均不是靠兼容代码“压住”测试，而是通过单调事实合并、required dependency、判别联合、final permit、owner handoff 和单一来源实现收紧了真实边界。
3. 长会话期间的订单事实、最终报价、自动寻标、末日接管、DailyLoss/保护性清仓与 BUY 浮亏门禁均有 confirm → repair → review 记录；其中关键修复都保留了直接业务回归。
4. `apiFlakyRecovery` 已完成最后一轮定向“确认 → 修复 → 独立终检”，终检结论为 approve。

### 8.2 本报告明确不作的结论

1. 不声称当前整个工作树已经全量测试通过。
2. 不声称所有 Minor、历史规范债、文档改进或未来风险为零。
3. 不将尚未完成复核的 BuyProcessor 四项失败写成生产缺陷。
4. 不以旧 plan 的“仅发现一项”、`1116 pass` 或 R1 的 `1275 pass` 替代最后完整验证的 `1653/6`。
5. 不声称真实 Longbridge WS 乱序/重连、多进程 mixed-log、断电级持久化或仓库外消费者已经在真实环境验证。

### 8.3 当前可执行的后续边界（本报告不执行）

若后续重新启动收敛，正确顺序是：先独立确认并处理剩余 4 个测试失败的真实契约，再在所有修复完成后重跑 `bun format`、`bun lint`、`bun type-check`、`bun test`、`bun run build`、残留扫描和 `git diff --check`。在没有这一步之前，不应发布“最终零残留”结论。

---

## 9. 工作树与文档边界

当前工作树长期处于大范围未提交重构状态，且有旧 kebab-case 测试删除与新 camelCase 测试未跟踪的迁移过程。因此：

- 历史报告中的文件数、测试数、暂存状态和行号只对应各自快照；
- 本报告没有 reset、checkout、stage、commit 或修改任何生产逻辑；
- 本报告新建后应与原 canonical findings 文档一起审阅，而不是覆盖或倒置其历史阶段结论；
- 当前 `docs/plans/2026-07/2026-07-11-hsi-single-monitor-review-and-recheck.md` 已明确是历史快照，不可作为当前实现状态依据。

---

## 10. 可审计来源索引

| 来源 | 用途 |
| --- | --- |
| 根会话 `019f55f1-d612-7543-93ab-f0ec1230317a` | 2026-07-12 至 2026-07-14 的主调度、确认/修复/复核消息和命令输出。 |
| 230 个子代理后代会话（其中 193 个直接子代理） | 对应业务链、订单/风险、生命周期、自动寻标、最终报价、类型与测试契约的独立确认和复核。 |
| `docs/issues/2026-07/2026-07-11-hsi-single-monitor-full-chain-review-findings.md` | 原始 19 项和 R1 6 项的正式历史、关闭状态、范围限制。 |
| `docs/plans/2026-07/2026-07-11-hsi-single-monitor-review-and-recheck.md` | 已取代的历史 plan；仅用于避免误用旧“1116 pass/仅一项”结论。 |
| `apiFlakyRecovery` 子链 `019f607f-e509-7d40-a80e-bd9c7ca60de8` | 最后一次确认、测试 harness 修复和独立终检的定向证据。 |

本文件的目的不是压缩为“所有事情都完成了”，而是在长时、多代理、脏工作树条件下保留可追溯的事实：哪些问题确实被证明、怎样修复、怎样复核，以及当前仍然不能宣告完成的部分。

---

## 11. 2026-07-14 补充复核：订单累计成交量上界必须在事实入口校验

### 11.1 二次确认结论

此前局部修复曾试图在 `routeProcessor` 的超时卖单剩余量计算处处理 `Math.max(remaining, 0)` 的静默归零；该层不是正确的校验边界：

1. `FILLED` 终态会直接结算，绕过超时补市价的剩余量计算；
2. WS 先把合并事实写入 tracked order，保护性 timeout 还会先准备 DailyLoss/durable progress，之后才进入 route；
3. 普通 WS 终态会直接结算，OPEN/TERMINAL state-check 和启动恢复也各有不经过该函数的路径。

因此，`0 <= executedQuantity <= 当前有效 submittedQuantity` 不是为不可达边界添加的兜底，而是订单账本、pending-sell 占用、DailyLoss 与结算的基本事实不变量，必须在外部事实首次进入本地状态前拒绝。

“当前有效委托量”取 tracked order 的 `submittedQuantity`：改单成功后它被更新为“已成交量 + 新剩余量”，所以它比历史原始下单量更准确，也不会把陈旧 state-check 当作合法事实。

### 11.2 结构修复与避免过度设计的结论

- 在 `orderFactMerge` 定义唯一共享断言，并用于 WS 单调合并、state-check 预检和终态归一化；
- 恢复 pending 订单和不匹配买单的终态恢复也在 `trackOrder`、pending-sell 分配与结算前使用同一断言；
- 删除 `routeProcessor` 的下游重复断言及其“直接构造非法内部 timeout snapshot”的测试，避免把已在入口拒绝的外部非法事实再做一层迟到防御；
- 没有新增回退、截断、补零、旧值回填、重试或兼容分支。`executedQuantity === submittedQuantity` 保持合法。

### 11.3 回归证据

先新增并确认四类用例在修复前失败：保护性 SELL `FILLED` WS、OPEN state-check、TERMINAL state-check 归一化、启动恢复的 `101/100` 累计成交事实。修复后，以下 5 个订单监控测试文件定向运行结果为 **177 pass / 0 fail**：

- WS 事实会在 settlement、tracked mutation 前拒绝；
- OPEN state-check 不会推进 tracked、cumulative execution 或 pending-sell；
- TERMINAL 归一化不会被 `FILLED` 绕过；
- 恢复不会创建 tracking 或 pending-sell 占用；
- 原有 routeProcessor 超时、结算与转市价行为仍通过。

这是一项已确认且必要的结构修复；它不改变本报告第 8 节对“当前没有最终全仓全绿证据”的限制。
