# 全量架构等价性审计：基线、规格、历史与覆盖地图（首轮）

## summary

- verdict：已固定最新远端 develop 行为基线并建立全 src 文件分派地图；本报告是可分派的首轮证据，不是全仓等价性通过结论，未发现并经第二独立复核确认的现存缺陷。
- scope：仓库 Git 状态与 refs、指定架构实施计划、适用 skills、两个历史修复的直接源码与测试变更、develop/HEAD 全部生产文件目录、实际入口与总装配接缝。未扫描无关 docs/tools，未启动应用、连接实盘或执行测试。
- confidence：基线/文件计数/环境 high；历史修复根因 high；历史修复在 HEAD 的全路径无回归 medium（仍须业务链代理与独立验证者复核）；业务等价性尚未完成。
- 只读承诺：没有修改仓库源代码、测试、配置、架构计划；没有 checkout/reset/merge。仅执行获授权的 fetch，以及写入本报告。

## 1. 实际模型与思考级别（已核实，不以默认配置冒充）

- 本任务对应活动进程：`node.exe` PID **52792**，父 PID **36880**。
- 会话：`C:/Users/65459/.pi/agent/pi-codex-subagents/runs/d05757cd87992b122c072242/c97d1070-6870-4893-afb7-d29f532e9af3.jsonl`。
- 只读进程命令行核实：`--provider cliproxyapi --model gpt-6.1-sol --thinking max`。
- 同一会话初始事件核实：2026-10-20T11:51:45.565Z `model_change` 为 `provider=cliproxyapi, modelId=gpt-6.1-sol`；随后 `thinking_level_change` 为 `max`。
- `settings.json` 默认值实际为 `openai-codex/gpt-6-luna`、`defaultThinkingLevel=max`；本任务被显式启动参数覆盖。环境变量没有提供 model/thinking 值，故不能仅凭环境变量声称符合。
- 以上确认的是本地实际启动与会话配置，不额外声称已检查代理服务背后真实模型路由。

## 2. 可统一广播的基线

| 项目 | 核实结果 |
| --- | --- |
| 审计时分支 | `beta-V2`，相对 `origin/beta-V2` ahead 1 |
| 被审计 HEAD | `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`，2026-10-20 17:14:19 +0800，`fix` |
| 最新远端行为基线 | **`6e239c8a128372bd9b2fb2d79464346792a5e81e`** |
| 本地 develop | 同上，2026-10-08 00:48:23 +0800，`docs fix` |
| origin/develop | 同上 |
| FETCH_HEAD | 同上 |
| develop...origin/develop | `0 0` |
| merge-base HEAD develop | 同上基线 SHA |
| 历史修复 d2aa590 | `d2aa59054abac546f506b27df45f161afcfc6578`，2026-10-19 19:17:21 +0800 |
| 历史修复 2b67d36 | 即当前 HEAD 的完整 SHA |
| 工作区 | 首次与 fetch 后 `git status --porcelain=v1 --branch` 均没有 tracked/untracked 文件项 |

`git fetch origin develop` **exit 0**，确实更新/核实了远端 develop，而非只读取旧远端跟踪引用。输出存在 Git Credential Manager 的代理 provider 探测警告及“不支持 https 方案的代理”提示，但实际 fetch 成功，没有把警告误报为失败。探测过程中曾有一次只读 `git rev-parse` 子进程启动报 `EPERM`，后续重试读取四个 refs 均成功，一致性结论来自成功重试，不依赖失败输出。

后续所有 `develop:path:line` 都指上述固定 SHA，不能在审计中途悄悄移动基线；`current:path:line` 指上述 HEAD。运行校验代理应在实际命令前重新核对 HEAD/工作区，但不切分支。

## 3. 规格约束与裁决优先级

已读取 `code-review`、`typescript-project-specifications`、`core-program-business-logic`、`lazy-senior-developer`、`context-mode` 和根 `AGENTS.md`。**当前 business skill 已随重构更新，只作为定位和不变量索引；不能据此倒推 develop 的原始需求。任何语义冲突先读取 develop 真实代码，再单列用户/方案显式授权的差异。**

指定计划：`docs/architecture/architecture-refactoring-implementation-plan.md`（2347 行）。首轮直接检查了开头约束、目标目录及迁移/验收索引；未把文中历史测试数字当作本次验证结果。

| 计划证据 | 必须保持/明确授权事项 | 审计含义 |
| --- | --- | --- |
| `...plan.md:33` | 总目标保持交易语义；仅列出的事实一致性、UNKNOWN、protective 归属隔离和精度升级为受控例外 | “架构改进”不能成为新增业务策略或恢复协议的授权 |
| `...plan.md:35` | submit UNKNOWN 一律既有 fatal、关闭放行、正常终止；不得自动重提或新增查询接管 | 这是方案明确的策略收敛，与 develop 的末日分支差异必须登记，不能称零行为差异 |
| `...plan.md:37` | 静态卖单不得扩量到旧 protective 订单；保留合法普通 REPLACE、旧 protective progress 和完成 | 受控修正，必须证明没有泛化禁改或丢失旧 protective 事实 |
| `...plan.md:37`–`:47` | canonical account/position 唯一 writer；snapshot commit 与 business ready 分离 | 用真实写路径和门禁证明，不看模块名字 |
| `...plan.md:49`–`:58` | SDK 收口 infrastructure；业务 owner 与生命周期 owner 明确；precision 不得退回普通 number | 去 SDK 不是数学语义授权变更 |
| `...plan.md:60`–`:63` | 保持公式、单位、阈值包含关系、排序键和完成条件；精确数学临界差异须登记 | 不冻结旧浮点误差，也不以新数值库为由改变公式 |
| `...plan.md:65`–`:79` | 保持各业务 policy、cancel ACK≠终态、ACTIVATING 准入、午休/开盘/跨日门禁、内部错误与暂时失败的区别、停盘仍时间唤醒 | 这些是每条业务链和总装配都要验证的契约 |
| `...plan.md:81`–`:97` | dayEpoch/generation/seat/settlement 版本不得旧结果覆盖新事实；离线全链路门禁；不发布不实盘 | 历史 3019 pass 不替代本次运行；真实历史对账和回退演练仍 not assessed |
| `...plan.md:7`–`:19` | 精度与策略布局的后续确认覆盖旧示意；金融结果至少三位、中间不统一三位、配置有界、基础运算精确、输出一次 half-even | 必须把允许的表示变化与禁止的业务漂移分开 |

注：上表是审核约束摘要，不代表接受所有历史文档状态文字为当前事实。若最新用户“仅允许架构改进”的范围被主代理解释为不再授权上述计划例外，应把例外单列请主代理裁决，而不是由子代理静默扩张范围。

## 4. 两个历史严重回归：根因、HEAD 状态、交叉分派

### 4.1 d2aa590：把独立券商时间事实错误绑定为先后不变量

- **历史已确认缺陷（不是当前新 finding）**：其父版本在引入逐笔成交时间事实后，仍在 domain、settlement、daily loss 和 durable repository 多层要求 `executionTime <= updatedAt/orderRevision`。独立券商成交时间合法地晚于 order revision 时，被跳过、拒绝或升级为内部错误；保护性 progress/结算和损益重算可因此中断。**该先后判断并非所有层都由重构新加，develop 的 protective settlement/durable 也有相关 guard；真正的语义漂移是事实来源变化后，旧假设被继续扩散并用于拒绝合法事实。**
- `git show d2aa590 -- src` 确认该修复只改 6 个生产文件：`application/orderTracking/orderMonitor/settlementFlow.ts`、`domain/order/executionFact.ts`、`domain/order/orderEconomics.ts`、`domain/order/orderFactMerge.ts`、`domain/risk/dailyLossTracker.ts`、`infrastructure/persistence/mixedTradeLogRepository/index.ts`。修复删除上述跨事实比较，而不是伪造/截断真实成交时间。
- **develop 直接裁决（已再次核对，避免倒推旧需求）**：`develop:src/core/trader/orderMonitor/settlementFlow.ts:265`–`:276` **确实有** `executedTimeMs > orderUpdatedAtMs` 拒绝条件；不得误报为 develop 完全没有该判断。原始订单来源在 `develop:src/core/orderRecorder/orderApiManager.ts:271`–`:294` 为 historyOrders→todayOrders→去重，原来源不是新增的逐笔 execution API。因此 d2 应定位为修复“新事实来源与旧约束不兼容”，不能仅凭其删除 guard 就声称是纯粹恢复 develop。后续必须沿 develop 真实时间赋值链与 HEAD 订单驱动赋值链独立裁决。
- **测试方向曾被写反的证据**：该提交把 `tests/application/orderTracking/orderMonitor/ordinaryRawExecutionFacts.business.test.ts` 的断言从“不得晚于同次 broker revision”改为“可以晚于”；把 `settlementFlow.business.test.ts` 从“零副作用失败”改为“仍使用真实成交时间”；并增加 daily loss 与 durable progress 接纳此情形的测试。故“已有测试通过”本身不证明 develop 等价。
- **develop 时间赋值的直接证据**：`develop:src/core/trader/orderMonitor/eventFlow.ts:111`–`:112` 同时用 `event.updatedAt` 生成 executedTimeMs/updatedAtMs；`develop:src/core/trader/orderMonitor/recoveryFlow.ts:457` 在已成交时用 snapshotUpdatedAtMs 生成 lastExecutedTimeMs。`develop:src/services/mixedTradeLogRepository/index.ts:204`、`:313` 也确实有 lastExecutionTimeMs > orderRevisionMs 的拒绝条件。因此旧模型应按“订单时间产生经济时间”整体理解，而不是把 guard 孤立地当成禁止一切独立真实成交时间的原始需求。
- **HEAD 状态**：当前后续 `2b67d36` 已改回订单驱动，`current:src/infrastructure/longbridge/trade/orderMapper.ts:139` 在累计成交大于零时使用订单 `updatedAtMs` 形成经济时间；旧 `domain/order/orderEconomics.ts` 已删除。这不是恢复了错误的跨事实先后约束，而是换回 develop 的订单事实来源。仍须独立复核 durable 历史中 `lastExecutionTimeMs > orderRevisionMs` 的合法输入在读/写/恢复/结算各层均可达并被接纳；本报告不声称已跑完这些路径。
- **建议复核责任**：order-execution 主审 current merge/event/settlement，risk-account 主审 daily-loss/progress，infra-config 主审 durable validator，validation 复跑上述反例。禁止只恢复一层判断而漏掉其余 5 层。

### 4.2 2b67d36：execution 驱动启动与全局整数收紧叠加，跨市场账户被错误纳入交易域

- **历史已确认缺陷（不是当前新 finding）**：从 `4a148b3` 引入逐笔 execution 驱动后，启动/重建新增 `historyExecutions/todayExecutions`，又把 `safeQuantityNumber` 作用域扩至账户全体。US 碎股（例如 0.0006）不属于本系统 HK 交易域，却能在归一时触发 RangeError，导致整个启动失败。只去掉 execution 调用仍不够，订单历史与账户持仓里同样可能有 US 碎股。
- 该修复本身较大：**179 个文件，56 个 src 文件、119 个 tests 文件，另含 2 个 mock、AGENTS 与直接相关修复记录**。不能把“fix”提交当作低风险小补丁。
- **develop 直接裁决**：`develop:src/core/orderRecorder/orderApiManager.ts:274`–`:294` 确实只读 historyOrders、todayOrders，保持顺序并合并；`develop:src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:259` 获取全量订单，`:300` 由订单重算日损益；`develop:src/core/trader/accountService.ts:92`–`:93` 对账户数量做 `decimalToNumber` 而非强制安全整数。
- **HEAD 已可见的修复证据**：
  - `current:src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:142`–`:152` 先判 HK scope，再对纳管订单做严格映射；`:178`–`:199` 维持 historyOrders→todayOrders 两读。
  - `current:src/infrastructure/longbridge/trade/orderMapper.ts:81`–`:82` 对全部纳管 HK 订单 quantity/executedQuantity 严格整数化，而非只校验当前席位。
  - `current:src/infrastructure/longbridge/trade/accountMapper.ts:12`–`:17` 与 `:40`–`:47` 将账户展示数量保留为有限非负 number，可保留 US 碎股与 accountChannel。
  - `current:src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts:40`–`:41` 是另一条专用目标卖出严格契约，不可与“全部 HK 订单严格”互相替代。
  - `current:src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:374`、`:419`–`:438` 经唯一 snapshot owner 获取配对事实并检查 epoch/generation；`:495` 在恢复副作用前检查历史一致性。
- **仍须二次独立核验**：US pending/push/detail 是否在所有入口均隔离；HK 非当前席位订单仍严格；账户碎股展示不得流入交易数量；baseline-only BUY、durable boundary 冻结、历史/在线/重算经济裁决是否一致；终态重复/晚到事实是否只应用一次；缺失 revision 不得伪造时间。已定位测试含 `tests/application/orderTracking/orderMonitor/ordinaryRawExecutionFacts.business.test.ts`、`tests/domain/risk/dailyLossExecutionBoundary.test.ts`、`tests/integration/architectureRefactoringRecovery/recovery.integration.test.ts`、`tests/integration/strategyRecoveryStartup.integration.test.ts`、`tests/utils/marketScope.test.ts`。
- 直接相关修复文档 `docs/order-driven-startup-regression-repair-plan.md:29`–`:46` 支持上述根因，但结论已由 develop/HEAD 源码交叉核实，不以该文档自述代替代码，也不把其“未提交”历史时态当作当前状态。

## 5. 全 src 生产文件统计与唯一主责分派

统计口径：`git ls-tree -r --name-only <SHA> -- src` 的所有 tracked 文件，**包含策略 config.json**，不只统计 `.ts`。develop **263**，current **368**；`git diff --shortstat develop HEAD -- src` 为 443 files changed / 29641 insertions / 24781 deletions。diff 的变更项数不等于当前文件数。

### 5.1 顶层统计

| 顶层 | develop 文件数 | current 文件数 |
| --- | ---: | ---: |
| app | 20 | 23 |
| core | 85 | 0 |
| main | 73 | 0 |
| services | 28 | 0 |
| application | 0 | 80 |
| domain | 0 | 50 |
| runtime | 0 | 66 |
| infrastructure | 0 | 44 |
| strategies | 0 | 29 |
| config | 11 | 12 |
| constants | 3 | 8 |
| types | 14 | 45 |
| utils | 28 | 10 |
| index.ts | 1 | 1 |
| **合计** | **263** | **368** |

### 5.2 唯一主责分组（覆盖不等于已审完）

| 组 | current 文件数 | 首要范围 | 分派/边界 |
| --- | ---: | --- | --- |
| G0 总装配与跨链 wiring | **39** | `app/**` 23、`runtime/asyncProgram` 共享编排 10、`runtime/businessEventProgram/**` 4、`application/types.ts`、`index.ts` | **五条业务链+infra 之外的显式剩余组**；建议续派本代理全局审计。业务代理可读相关装配，不能因此默认 39 个文件已有人完整覆盖 |
| G1 生命周期与时间门禁 | **34** | tradingDayRebuild 12、runtime/lifecycle 12、timeWakeupEvaluation/Planner/Runtime 各2、tradingGateEventRuntime 2、domain/tradingSession 2 | 已有 lifecycle 代理；与 G0/G3/G5 双向核对 |
| G2 行情与策略 | **42** | strategies 29、domain/strategy 2、monitorQuoteEventRuntime 4、quoteSubscriptionRuntime 2、monitorDisplayRuntime 2、tradingQuoteDisplayRuntime 2、application/quoteRetry.ts | 已有 market-strategy；adapter 与配置实现归 G6，但端到端不可省略 |
| G3 席位寻标轮换 | **34** | autoSearch 4、seatActivation 3、seatSwitch 7、domain/seat 9、autoSearchWakeup 2、periodicSwitchWakeup 2、seatActivationDispatcher 2、cleanupDispatcher 3、seatDiagnosticRuntime 2 | 已有 seat-selection；必须对照 G0 的实际注入和 G5 ready |
| G4 订单执行恢复 | **63** | orderExecution 8、orderTracking 20、ordinaryBuy 4、ordinarySell 4、domain/order 21、buy/sellProcessor 各2、orderTradeAuditListener 2 | 已有 order-execution；push/query/mutation adapter 与 durable 在 G6，经济风险提交在 G5 |
| G5 风险账户清仓 | **36** | accountPositionSnapshot 2、accountQuery 1、doomsdayClearance 2、postTradeSettlement 3、protectiveLiquidation 4、riskRefresh 2、staticLiquidation 2、domain/liquidation 7、domain/risk 9、tradingRiskEventRuntime 4 | 已有 risk-account；与 G1 跨日失效、G4 事实提交、G6 durable 共同闭合 |
| G6 基建配置公共契约 | **120** | infrastructure 44、config 12、constants 8、types 45、utils 10、runtime/timer 1 | 已重启 infra-config；types 虽主归此组，业务字段/owner 契约必须由对应业务代理共同复核 |
| **合计** | **368** | 每个文件恰好一个唯一主责组 | **未匹配 0、重叠主责 0；G0 39 文件是当前待显式认领范围** |

validation 代理不替代上述生产文件主审：其负责验证结果、行为覆盖映射、负向反例和独立复核证据。全量测试通过不自动证明每个文件业务等价。

## 6. 旧模块 → 新 owner 地图（可直接分派）

| develop 旧范围 | current 对应范围 | 主审链/重要接缝 |
| --- | --- | --- |
| `app/runApp`、`app/runtime`、`app/lifecycle`、startupSnapshot/rebuild | app 总装配 + application/tradingDayRebuild + runtime/lifecycle | G0/G1；不是只改路径，startup receipt、termination、resource ownership 已改变 |
| `main/lifecycle/**`、`main/recovery/**` | application/tradingDayRebuild/** + runtime/lifecycle/** + application/seatActivation | G1/G3；跨日清理与重建步骤顺序、旧 epoch 结果丢弃 |
| `main/timeWakeup*`、`main/tradingGateEventRuntime` | runtime 同名目录 + domain/tradingSession + application/doomsdayClearance | G1/G5；停止交易仍时间唤醒；UNKNOWN 方案例外单列 |
| `services/quoteClient/**`、`utils/marketData/**` | infrastructure/longbridge/market/** + runtime/quoteSubscriptionRuntime | G2/G6；candle active/confirmed 与订阅交错 |
| `core/strategy/intradayRegression/**` | strategies/intradayRegression/** | G2；包括 config.json、DSL、指标、verification，不可只审入口 |
| `core/strategy/types.ts`、utils | types/strategy.ts + domain/strategy/utils.ts | G2/G6；策略端口/host 边界 |
| `main/monitorQuoteEventRuntime/**` | runtime/monitorQuoteEventRuntime/** + application/staticLiquidation/** | G2/G5；静态清仓已迁移业务 owner |
| `services/autoSymbolFinder/**` | application/autoSearch/candidateSearch、startupSeatSearch + domain/seat/warrantSelection | G3/G6；Longbridge warrant 读取仅 adapter，排序/阈值仍领域规则 |
| `services/autoSymbolManager/**` | application/autoSearch、seatSwitch + domain/seat | G3；WAIT owner、版本、回补与撤单事实 |
| `main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh`、main/recovery | application/seatActivation + runtime/seatActivationDispatcher | G3/G0；准入全部完成才 ACTIVE |
| `core/trader/orderExecutor/**`、rateLimiter | application/orderExecution/** | G4/G6；submit permit 与 UNKNOWN 错误分类 |
| `core/trader/orderMonitor/**` | application/orderTracking/orderMonitor/** + domain/order/orderFactMerge/route/orderStatus 规则 | G4；真实 state-check、push、restore、terminal 接缝 |
| `core/orderRecorder/**` | application/orderTracking/recorder/** + domain/order/** + infrastructure/longbridge/trade/orderSnapshotReadAdapter | G4/G6；历史优先去重与所有纳管订单严格契约 |
| `core/orderStatusLifecycle/**` | domain/order/orderTrackingPolicy、orderSnapshotPolicy、orderTimeoutPolicy、orderReadLifecycle + types + runtime/orderTradeAuditListener 等消费者 | G4；删除旧 façade 不代表行为删除 |
| `core/signalProcessor/**`、main/ordinarySignalGuard | application/ordinaryBuy/** + ordinarySell/** + runtime buy/sellProcessor | G4/G2；不新增 wrapper owner，保持信号 policy |
| `core/trader/accountService`、utils/accountPositions、positionCache、refreshGate | application/accountQuery + accountPositionSnapshot + postTradeSettlement + ordinaryBuy/accountPositionsRead + infrastructure/trade adapters | G5/G0/G6；唯一 snapshot writer 和 ready 分离是最高优先接缝 |
| `core/riskController/**` | domain/risk/** + application/riskRefresh + protectiveLiquidation/unrealizedLossExecutor | G5；成本口径与日损益分段、清仓触发不同职责 |
| `services/liquidationCooldown/**`、core/trader/protectiveLiquidationEpisodeTracker | domain/liquidation/{cooldown,episode} + application/protectiveLiquidation/tradeLogHydrator + postTradeSettlement | G5；completion append 后才提交 cooldown/episode/ready |
| `core/doomsdayProtection/**`、main/timeWakeupEvaluationProgram | domain/liquidation/doomsday + application/doomsdayClearance + runtime/timeWakeupEvaluationProgram | G5/G1；占用卖量不是无需清仓 |
| `services/mixedTradeLogRepository/**` | infrastructure/persistence/mixedTradeLogRepository/** | G6/G5；V1 文本、同步 append、幂等、独立时间字段 |
| `services/accountDisplay/marketMonitor`、utils/display/logger | infrastructure/display/**、logger/** + runtime display consumers | G6/G2/G5；字段位数与一次舍入、US 账户展示不得进入交易数量 |
| config/constants/types/utils 旧公共模块 | 同名收口 + 新窄 ports + utils/numeric/exact | G6 + 各业务链；类型可达性、默认值、边界数值和错误语义不可漂移 |

完整逐文件地图见后续自动生成附录：同路径、Git rename（25% 相似度，仅定位证据）、拆分/owner 映射明确区分，绝不把 rename 相似度当成等价性证明。

## 7. 全局 wiring / ownership 接缝候选（待验证，不是已证实缺陷）

以下是基于真实路径需要续派的全局检查项，**均为 potential 接缝，尚无足够证据列为 critical/major finding**：

1. **唯一 snapshot owner 与 ready/ACTIVE 交接**：`current:src/app/runtime/createPostGateRuntime.ts` → `application/accountPositionSnapshot` → `application/postTradeSettlement` → `application/seatActivation`；对照 `develop:src/app/runtime/createPostTradeConsistencyRuntime.ts`、`develop:src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`、`develop:src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:189`–`:196`。重点防旧 receipt 仅因 account read 完成就放行交易、跨 await 旧 token/seatVersion 混入。
2. **事件发布、队列背压与 stop/drain owner**：`current:src/runtime/businessEventProgram/**`、`runtime/asyncProgram/{processor,taskNotifications,monitorTaskProcessor,monitorTaskQueue,tradeTaskQueue}` 与 `app/runtime/createAsyncRuntime.ts`；对照 develop `main/**` 同名组件。重点防队列清空不取消 handler、清理先退订再等必要事实、共享消费者未接线。
3. **订单事实到审计/持久化/结算的接线**：`current:src/app/runtime/createTradeRuntime.ts`、`createPostGateRuntime.ts`、`runtime/orderTradeAuditListener`、orderPushAdapter/eventFlow/settlementFlow。不能因模块已存在就认为订阅已安装，或 listener throw 被吞后继续 ready。
4. **fatal 首错保留与全部部分资源清理**：`current:src/app/runApp.ts:66`、`:79`–`:102`、`:357`–`:373` 与 `app/shutdown/createCleanup.ts`；对照 `develop:src/app/runtime/createTerminationRuntime.ts`、runApp/cleanup。关注装配中途终止、新资源晚创建、stop→drain 顺序、异常不改变 UNKNOWN fail-closed。
5. **系统级时间唤醒与交易门禁解耦**：`current:src/app/runApp.ts:297`、`:327`、runtime/timeWakeup*、lifecycle 与 `tradingGateEventRuntime`；对照 develop 同路径 main runtime。停盘/午休/跨日关闭不能把下次重建所需唤醒一起停掉。
6. **宽 Trader/LastState 拆成窄端口后的遗漏与双 owner**：`app/context/createMonitorContext.ts`、`app/runtime/*Deps.ts`、`src/types/*Ports.ts`、`src/application/types.ts`。检查调用方全部迁移、工厂返回值真实消费、可写快照没有经类型或闭包泄漏；dead-code 仅在完整生产消费边界排除后报告。
7. **账户范围与金融值出口**：`accountReadAdapter/accountMapper/sellPositionReadAdapter`、`config/validator`、`utils/numeric`、display、orderOwnership/marketScope 在运行时的连接。严格 HK 订单、专用目标卖出读取、宽账户展示是三种边界，不能在总装配中接错 port。

### 7.1 已核对的总装配/跨链符号锚点（用于续派，不冒充缺陷证明）

| 接缝 | current 精确锚点 | develop 精确锚点 |
| --- | --- | --- |
| 账户 snapshot 创建/结算/席位激活 | `src/app/runtime/createPostGateRuntime.ts:229`、`:268`、`:470`；`src/application/accountPositionSnapshot/index.ts:80`、`src/application/postTradeSettlement/index.ts:245`、`src/application/seatActivation/index.ts:196` | `src/app/runtime/createPostTradeConsistencyRuntime.ts:299`、`:458`–`:459`、`:570`；`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:234`、`:428` |
| 共享异步队列的最终 drain owner | `src/app/runtime/createAsyncRuntime.ts:22`、`:81`、`:98`、`:116` | `src/app/runtime/createAsyncRuntime.ts:21`、`:67`、`:89`、`:112` |
| business event owner 与 stop/drain | `src/runtime/businessEventProgram/index.ts:16`–`:17` | `src/main/businessEventProgram/index.ts:16`–`:17` |
| 订单追踪/执行 owner 的实际创建 | `src/app/runtime/createTradeRuntime.ts:20`、`:85`、`:113` | `src/core/trader/index.ts` 的统一 trader 装配；与 `src/core/trader/orderMonitor/eventFlow.ts:111`、`src/core/trader/orderMonitor/recoveryFlow.ts:457` 的事实入口共同核对 |
| 统一终止/清理 | `src/app/runApp.ts:66`、`:79`–`:102`、`:357`–`:373`；`src/app/shutdown/createCleanup.ts:23` | `src/app/runtime/createTerminationRuntime.ts:10`、`:38`–`:39`、`:48`；`src/app/shutdown/createCleanup.ts:23`；`src/app/runApp.ts:74` |
| 停止交易后的系统级时间唤醒 | `src/runtime/timeWakeupRuntime/index.ts:21`、`:168`–`:173` | `src/main/timeWakeupRuntime/index.ts:21`、`:168`–`:173` |
| 宽上下文拆窄契约 | `src/app/context/createMonitorContext.ts:111` | `src/app/context/createMonitorContext.ts:107` |

## critical issues

未发现经二次独立复核确认的现存 critical 缺陷。历史严重缺陷详见 §4，不重复冒充当前发现。

## major issues

None（首轮地图尚未完成 G0 的全局行为审计）。

## minor issues

None（不报告风格偏好）。

## positive findings

- fetch 后四个 refs、merge-base 与 ahead/behind 均一致，基线已可重现。
- 全部 368 个当前生产文件可以唯一分派，没有因顶层目录重排而遗漏生产文件；全局 39 个文件显式列为剩余主责而非默认为别人已覆盖。
- 两个历史修复已经出现“测试本身把错误新假设固化”的具体证据，后续审计将 develop 源码作为裁决而不是只看新测试。

## not assessed

- G0 总装配及七个全局接缝的完整运行时路径、所有生产导出消费边界：等待本代理续派；此处只是定位。
- 五条业务链与 G6 全量等价性：由对应已运行代理负责，不能把文件分组误报为已审通过。
- 类型、注释、dead code、simplification：已加载规范，但本阶段仅审约束/地图和历史直链，未做全量逐项结论；后续各主责链补齐七维。
- 实际运行测试/类型检查/构建、覆盖与负向反例：validation 代理执行，本代理未并行运行以避免共享构建状态竞争。
- 真实生产券商数据、真实历史 V1 逐条对账、实盘/发布/候选和回退完整恢复：未进行，不在离线首轮地图可证明范围。
- 本地代理服务背后模型路由：仅确认本地实际启动参数和会话配置。

## recommended next actions

1. 立即向全部代理广播固定 develop/HEAD SHA；所有语义差异同时写 develop 与 current 精确 path:line。
2. 续派本代理 G0 39 文件及七个全局 wiring 接缝，尤其 snapshot→settlement ready→seat ACTIVE、partial startup→termination→drain。
3. G6 主审 120 文件并将 adapter/type/financial 边界逐条交回对应业务链闭合，不把公共目录全揽后只审静态依赖。
4. validation 按 d2 与 2b 的反例交叉验证；独立验证者不得只复述第一审结论，所有候选二次从 develop 与真实调用路径复核。
5. 汇总时以附录逐文件账本核对“分派、首审、复审、动态验证、not assessed”，未闭合项不能计为全量覆盖完成。

<!-- GENERATED-COVERAGE-APPENDIX -->

## 附录 A：全 current src 唯一主责账本（368 / 368）

下列 `:1` 仅为文件定位锚点，不是行为证明行号。每个 current 文件恰好出现一次；人工 owner 映射仅为定位候选，不能替代符号和运行路径核查。

### G0 总装配与跨链 wiring（39 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/app/context/createMonitorContext.ts:1` | `src/app/context/createMonitorContext.ts:1` |
| `src/app/context/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/app/lifecycle/createLifecycleRuntime.ts:1` | `src/app/lifecycle/createLifecycleRuntime.ts:1` |
| `src/app/lifecycle/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/app/runApp.ts:1` | `src/app/runApp.ts:1` |
| `src/app/runAppDeps.ts:1` | `src/app/runAppDeps.ts:1` |
| `src/app/runtime/createAsyncRuntime.ts:1` | `src/app/runtime/createAsyncRuntime.ts:1` |
| `src/app/runtime/createPostGateRuntime.ts:1` | `src/app/runtime/createPostGateRuntime.ts:1` |
| `src/app/runtime/createPostGateRuntimeDeps.ts:1` | `src/app/runtime/createPostGateRuntimeDeps.ts:1` |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts:1` | `src/app/runtime/createPostTradeConsistencyRuntime.ts:1` |
| `src/app/runtime/createPreGateRuntime.ts:1` | `src/app/runtime/createPreGateRuntime.ts:1` |
| `src/app/runtime/createPreGateRuntimeDeps.ts:1` | `src/app/runtime/createPreGateRuntimeDeps.ts:1` |
| `src/app/runtime/createTradeRuntime.ts:1` | `src/core/trader/index.ts:1` |
| `src/app/runtime/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/app/shutdown/createCleanup.ts:1` | `src/app/shutdown/createCleanup.ts:1` |
| `src/app/shutdown/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/app/startup/createSelectedStrategy.ts:1` | `src/app/startup/createSelectedStrategy.ts:1` |
| `src/app/startup/prepareStrategy.ts:1` | `src/app/startup/prepareStrategy.ts:1` |
| `src/app/startup/runtimeValidation.ts:1` | `src/app/startup/runtimeValidation.ts:1` |
| `src/app/startup/strategyLoaderHelpers.ts:1` | `src/app/startup/strategyLoaderHelpers.ts:1` |
| `src/app/startup/tradingDayInfoResolver.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/app/startup/types.ts:1` | `src/app/startup/types.ts:1` |
| `src/app/types.ts:1` | `src/app/types.ts:1` |
| `src/application/types.ts:1` | `src/utils/quoteRetry/types.ts:1` |
| `src/index.ts:1` | `src/index.ts:1` |
| `src/runtime/asyncProgram/monitorTaskProcessor/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:1`<br>`src/main/asyncProgram/monitorTaskProcessor/index.ts:1` |
| `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/index.ts:1`<br>`src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:1` |
| `src/runtime/asyncProgram/monitorTaskProcessor/types.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/types.ts:1` |
| `src/runtime/asyncProgram/monitorTaskQueue/index.ts:1` | `src/main/asyncProgram/monitorTaskQueue/index.ts:1` |
| `src/runtime/asyncProgram/monitorTaskQueue/types.ts:1` | `src/main/asyncProgram/monitorTaskQueue/types.ts:1` |
| `src/runtime/asyncProgram/processor.ts:1` | `src/main/asyncProgram/utils.ts:1` |
| `src/runtime/asyncProgram/taskNotifications.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/asyncProgram/tradeTaskQueue/index.ts:1` | `src/main/asyncProgram/tradeTaskQueue/index.ts:1` |
| `src/runtime/asyncProgram/tradeTaskQueue/types.ts:1` | `src/main/asyncProgram/tradeTaskQueue/types.ts:1` |
| `src/runtime/asyncProgram/types.ts:1` | `src/main/asyncProgram/types.ts:1` |
| `src/runtime/businessEventProgram/emissionAdapter.ts:1` | `src/main/businessEventProgram/emissionAdapter.ts:1` |
| `src/runtime/businessEventProgram/index.ts:1` | `src/main/businessEventProgram/index.ts:1` |
| `src/runtime/businessEventProgram/types.ts:1` | `src/main/businessEventProgram/types.ts:1` |
| `src/runtime/businessEventProgram/utils.ts:1` | `src/main/businessEventProgram/utils.ts:1` |

### G1 生命周期与时间门禁（34 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/application/tradingDayRebuild/executionNormalization.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:1` | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:1` |
| `src/application/tradingDayRebuild/openRebuild.ts:1` | `src/app/lifecycle/rebuild.ts:1` |
| `src/application/tradingDayRebuild/quoteSymbols.ts:1` | `src/main/lifecycle/utils.ts:1`<br>`src/main/utils.ts:1` |
| `src/application/tradingDayRebuild/rebuildTradingDayState.ts:1` | `src/main/lifecycle/rebuildTradingDayState.ts:1` |
| `src/application/tradingDayRebuild/seatActivationCarryover.ts:1` | `src/main/lifecycle/seatActivationCarryover.ts:1` |
| `src/application/tradingDayRebuild/seatPreparation.ts:1` | `src/main/recovery/seatPreparation.ts:1` |
| `src/application/tradingDayRebuild/startupFailureState.ts:1` | `src/main/lifecycle/startupFailureState.ts:1` |
| `src/application/tradingDayRebuild/startupRebuild.ts:1` | `src/app/lifecycle/rebuild.ts:1` |
| `src/application/tradingDayRebuild/startupSnapshot.ts:1` | `src/app/startup/startupSnapshot.ts:1` |
| `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts:1` | `src/main/lifecycle/tradingCalendarPrewarmer.ts:1` |
| `src/application/tradingDayRebuild/types.ts:1` | `src/main/lifecycle/types.ts:1`<br>`src/main/recovery/types.ts:1` |
| `src/domain/tradingSession/index.ts:1` | `src/main/lifecycle/utils.ts:1` |
| `src/domain/tradingSession/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts:1` | `src/main/lifecycle/cacheDomains/globalStateDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts:1` | `src/main/lifecycle/cacheDomains/marketDataDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/orderDomain.ts:1` | `src/main/lifecycle/cacheDomains/orderDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/riskDomain.ts:1` | `src/main/lifecycle/cacheDomains/riskDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/seatDomain.ts:1` | `src/main/lifecycle/cacheDomains/seatDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:1` | `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:1` |
| `src/runtime/lifecycle/cacheDomains/types.ts:1` | `src/main/lifecycle/cacheDomains/types.ts:1` |
| `src/runtime/lifecycle/dayLifecycleManager.ts:1` | `src/main/lifecycle/dayLifecycleManager.ts:1` |
| `src/runtime/lifecycle/startup/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/lifecycle/startupRuntime.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/lifecycle/terminationRuntime.ts:1` | `src/app/runtime/createTerminationRuntime.ts:1` |
| `src/runtime/lifecycle/types.ts:1` | `src/main/lifecycle/types.ts:1` |
| `src/runtime/timeWakeupEvaluationProgram/index.ts:1` | `src/main/timeWakeupEvaluationProgram/index.ts:1` |
| `src/runtime/timeWakeupEvaluationProgram/types.ts:1` | `src/main/timeWakeupEvaluationProgram/types.ts:1` |
| `src/runtime/timeWakeupPlanner/index.ts:1` | `src/main/timeWakeupPlanner/index.ts:1` |
| `src/runtime/timeWakeupPlanner/types.ts:1` | `src/main/timeWakeupPlanner/types.ts:1` |
| `src/runtime/timeWakeupRuntime/index.ts:1` | `src/main/timeWakeupRuntime/index.ts:1` |
| `src/runtime/timeWakeupRuntime/types.ts:1` | `src/main/timeWakeupRuntime/types.ts:1` |
| `src/runtime/tradingGateEventRuntime/index.ts:1` | `src/main/tradingGateEventRuntime/index.ts:1` |
| `src/runtime/tradingGateEventRuntime/types.ts:1` | `src/main/tradingGateEventRuntime/types.ts:1` |

### G2 行情与策略（42 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/application/quoteRetry.ts:1` | `src/utils/quoteRetry/index.ts:1` |
| `src/domain/strategy/ordinarySignalGuard.ts:1` | `src/main/ordinarySignalGuard/index.ts:1` |
| `src/domain/strategy/utils.ts:1` | `src/core/strategy/utils.ts:1` |
| `src/runtime/monitorDisplayRuntime/index.ts:1` | `src/main/monitorDisplayRuntime/index.ts:1` |
| `src/runtime/monitorDisplayRuntime/types.ts:1` | `src/main/monitorDisplayRuntime/types.ts:1` |
| `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:1` | `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:1` |
| `src/runtime/monitorQuoteEventRuntime/setUtils.ts:1` | `src/main/monitorQuoteEventRuntime/setUtils.ts:1` |
| `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:1` | `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:1` |
| `src/runtime/monitorQuoteEventRuntime/types.ts:1` | `src/main/monitorQuoteEventRuntime/types.ts:1` |
| `src/runtime/quoteSubscriptionRuntime/index.ts:1` | `src/main/quoteSubscriptionRuntime/index.ts:1` |
| `src/runtime/quoteSubscriptionRuntime/types.ts:1` | `src/main/quoteSubscriptionRuntime/types.ts:1` |
| `src/runtime/tradingQuoteDisplayRuntime/index.ts:1` | `src/main/tradingQuoteDisplayRuntime/index.ts:1` |
| `src/runtime/tradingQuoteDisplayRuntime/types.ts:1` | `src/main/tradingQuoteDisplayRuntime/types.ts:1` |
| `src/strategies/intradayRegression/config.json:1` | `src/core/strategy/intradayRegression/config.json:1` |
| `src/strategies/intradayRegression/config.ts:1` | `src/core/strategy/intradayRegression/config.ts:1` |
| `src/strategies/intradayRegression/constants.ts:1` | `src/core/strategy/intradayRegression/constants.ts:1` |
| `src/strategies/intradayRegression/definition.ts:1` | `src/core/strategy/intradayRegression/definition.ts:1` |
| `src/strategies/intradayRegression/display.ts:1` | `src/core/strategy/intradayRegression/display.ts:1` |
| `src/strategies/intradayRegression/dsl.ts:1` | `src/core/strategy/intradayRegression/dsl.ts:1` |
| `src/strategies/intradayRegression/index.ts:1` | `src/core/strategy/intradayRegression/index.ts:1` |
| `src/strategies/intradayRegression/indicatorHelpers/types.ts:1` | `src/core/strategy/intradayRegression/indicatorHelpers/types.ts:1` |
| `src/strategies/intradayRegression/indicatorHelpers/utils.ts:1` | `src/core/strategy/intradayRegression/indicatorHelpers/utils.ts:1` |
| `src/strategies/intradayRegression/indicators/adx.ts:1` | `src/core/strategy/intradayRegression/runtime/adx.ts:1` |
| `src/strategies/intradayRegression/indicators/ema.ts:1` | `src/core/strategy/intradayRegression/runtime/ema.ts:1` |
| `src/strategies/intradayRegression/indicators/index.ts:1` | `src/core/strategy/intradayRegression/runtime/index.ts:1` |
| `src/strategies/intradayRegression/indicators/indicatorMath.ts:1` | `src/core/strategy/intradayRegression/runtime/utils.ts:1` |
| `src/strategies/intradayRegression/indicators/kdj.ts:1` | `src/core/strategy/intradayRegression/runtime/kdj.ts:1` |
| `src/strategies/intradayRegression/indicators/macd.ts:1` | `src/core/strategy/intradayRegression/runtime/macd.ts:1` |
| `src/strategies/intradayRegression/indicators/mfi.ts:1` | `src/core/strategy/intradayRegression/runtime/mfi.ts:1` |
| `src/strategies/intradayRegression/indicators/psy.ts:1` | `src/core/strategy/intradayRegression/runtime/psy.ts:1` |
| `src/strategies/intradayRegression/indicators/rsi.ts:1` | `src/core/strategy/intradayRegression/runtime/rsi.ts:1` |
| `src/strategies/intradayRegression/indicators/types.ts:1` | `src/core/strategy/intradayRegression/runtime/types.ts:1` |
| `src/strategies/intradayRegression/profile/index.ts:1` | `src/core/strategy/intradayRegression/profile/index.ts:1` |
| `src/strategies/intradayRegression/profile/types.ts:1` | `src/core/strategy/intradayRegression/profile/types.ts:1` |
| `src/strategies/intradayRegression/profile/utils.ts:1` | `src/core/strategy/intradayRegression/profile/utils.ts:1` |
| `src/strategies/intradayRegression/signalRules.ts:1` | `src/core/strategy/intradayRegression/utils.ts:1` |
| `src/strategies/intradayRegression/types.ts:1` | `src/core/strategy/intradayRegression/types.ts:1` |
| `src/strategies/intradayRegression/verification/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/strategies/intradayRegression/verification/pendingVerification.ts:1` | `src/core/strategy/intradayRegression/verification/index.ts:1` |
| `src/strategies/intradayRegression/verification/sampleRules.ts:1` | `src/core/strategy/intradayRegression/verification/utils.ts:1` |
| `src/strategies/intradayRegression/verification/sampleStore.ts:1` | `src/core/strategy/intradayRegression/verification/sampleStore.ts:1` |
| `src/strategies/intradayRegression/verification/types.ts:1` | `src/core/strategy/intradayRegression/verification/types.ts:1` |

### G3 席位寻标轮换（34 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/application/autoSearch/candidateSearch.ts:1` | `src/services/autoSymbolFinder/index.ts:1` |
| `src/application/autoSearch/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:1`<br>`src/services/autoSymbolManager/autoSearch.ts:1` |
| `src/application/autoSearch/startupSeatSearch.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/autoSearch/types.ts:1` | `src/services/autoSymbolFinder/types.ts:1` |
| `src/application/seatActivation/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:1` |
| `src/application/seatActivation/rebuiltSeats.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/seatActivation/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/seatSwitch/distanceSwitch.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/seatSwitch/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:1`<br>`src/services/autoSymbolManager/index.ts:1` |
| `src/application/seatSwitch/periodicSwitchTask.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/seatSwitch/seatStateManager.ts:1` | `src/services/autoSymbolManager/seatStateManager.ts:1` |
| `src/application/seatSwitch/signalBuilder.ts:1` | `src/services/autoSymbolManager/signalBuilder.ts:1` |
| `src/application/seatSwitch/switchStateMachine.ts:1` | `src/services/autoSymbolManager/switchStateMachine.ts:1` |
| `src/application/seatSwitch/types.ts:1` | `src/services/autoSymbolManager/types.ts:1` |
| `src/domain/seat/seatIdentity.ts:1` | `src/utils/seat/guards.ts:1`<br>`src/utils/seat/symbols.ts:1` |
| `src/domain/seat/seatPolicy.ts:1` | `src/services/autoSymbolFinder/policyResolver.ts:1`<br>`src/utils/seat/guards.ts:1` |
| `src/domain/seat/seatSnapshot.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts:1`<br>`src/utils/seat/snapshots.ts:1` |
| `src/domain/seat/switchPolicy.ts:1` | `src/services/autoSymbolManager/thresholdResolver.ts:1` |
| `src/domain/seat/switchState.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/seat/symbolRegistry.ts:1` | `src/services/autoSymbolManager/utils.ts:1`<br>`src/utils/seat/symbols.ts:1` |
| `src/domain/seat/types.ts:1` | `src/types/state.ts:1`<br>`src/utils/seat/types.ts:1` |
| `src/domain/seat/warrantSelection/index.ts:1` | `src/services/autoSymbolFinder/policyResolver.ts:1`<br>`src/services/autoSymbolFinder/utils.ts:1` |
| `src/domain/seat/warrantSelection/types.ts:1` | `src/services/autoSymbolFinder/types.ts:1` |
| `src/runtime/autoSearchWakeupRuntime/index.ts:1` | `src/main/autoSearchWakeupRuntime/index.ts:1` |
| `src/runtime/autoSearchWakeupRuntime/types.ts:1` | `src/main/autoSearchWakeupRuntime/types.ts:1` |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:1` | `src/main/periodicSwitchWakeupRuntime/index.ts:1` |
| `src/runtime/periodicSwitchWakeupRuntime/types.ts:1` | `src/main/periodicSwitchWakeupRuntime/types.ts:1` |
| `src/runtime/seatActivationDispatcher/index.ts:1` | `src/main/seatActivationDispatcher/index.ts:1` |
| `src/runtime/seatActivationDispatcher/types.ts:1` | `src/main/seatActivationDispatcher/types.ts:1` |
| `src/runtime/seatDiagnosticRuntime/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/seatDiagnosticRuntime/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/seatRuntimeCleanupDispatcher/index.ts:1` | `src/main/seatRuntimeCleanupDispatcher/index.ts:1` |
| `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts:1` | `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts:1` |
| `src/runtime/seatRuntimeCleanupDispatcher/types.ts:1` | `src/main/seatRuntimeCleanupDispatcher/types.ts:1` |

### G4 订单执行恢复（63 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/application/orderExecution/buyThrottle.ts:1` | `src/core/trader/orderExecutor/buyThrottle.ts:1` |
| `src/application/orderExecution/index.ts:1` | `src/core/trader/orderExecutor/index.ts:1` |
| `src/application/orderExecution/quantityResolver.ts:1` | `src/core/trader/orderExecutor/quantityResolver.ts:1` |
| `src/application/orderExecution/rateLimiter.ts:1` | `src/core/trader/rateLimiter.ts:1` |
| `src/application/orderExecution/submitFailureLogging.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderExecution/submitFlow.ts:1` | `src/core/trader/orderExecutor/submitFlow.ts:1` |
| `src/application/orderExecution/tradeMutationErrors.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderExecution/types.ts:1` | `src/core/trader/orderExecutor/types.ts:1` |
| `src/application/orderTracking/orderCacheManager.ts:1` | `src/core/trader/orderCacheManager.ts:1` |
| `src/application/orderTracking/orderHoldRegistry.ts:1` | `src/core/trader/orderHoldRegistry.ts:1` |
| `src/application/orderTracking/orderMonitor/eventFlow.ts:1` | `src/core/trader/orderMonitor/eventFlow.ts:1` |
| `src/application/orderTracking/orderMonitor/index.ts:1` | `src/core/trader/orderMonitor/index.ts:1` |
| `src/application/orderTracking/orderMonitor/orderObservation.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderTracking/orderMonitor/orderOps.ts:1` | `src/core/trader/orderMonitor/orderOps.ts:1` |
| `src/application/orderTracking/orderMonitor/orderStatusQuery.ts:1` | `src/core/trader/orderMonitor/orderStatusQuery.ts:1` |
| `src/application/orderTracking/orderMonitor/recoveryFlow.ts:1` | `src/core/trader/orderMonitor/recoveryFlow.ts:1` |
| `src/application/orderTracking/orderMonitor/routeProcessor.ts:1` | `src/core/trader/orderMonitor/routeProcessor.ts:1` |
| `src/application/orderTracking/orderMonitor/routeRuntime.ts:1` | `src/core/trader/orderMonitor/routeRuntime.ts:1` |
| `src/application/orderTracking/orderMonitor/routingIndex.ts:1` | `src/core/trader/orderMonitor/routingIndex.ts:1` |
| `src/application/orderTracking/orderMonitor/settlementFlow.ts:1` | `src/core/trader/orderMonitor/settlementFlow.ts:1` |
| `src/application/orderTracking/orderMonitor/types.ts:1` | `src/core/trader/orderMonitor/types.ts:1` |
| `src/application/orderTracking/recorder/index.ts:1` | `src/core/orderRecorder/index.ts:1` |
| `src/application/orderTracking/recorder/orderApiManager.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderTracking/recorder/orderStorage.ts:1` | `src/core/orderRecorder/orderStorage.ts:1` |
| `src/application/orderTracking/recorder/types.ts:1` | `src/core/orderRecorder/types.ts:1` |
| `src/application/orderTracking/tradeAudit/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderTracking/tradeAudit/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/orderTracking/types.ts:1` | `src/core/trader/types.ts:1` |
| `src/application/ordinaryBuy/accountPositionsRead.ts:1` | `src/utils/accountPositions/index.ts:1` |
| `src/application/ordinaryBuy/index.ts:1` | `src/core/signalProcessor/index.ts:1` |
| `src/application/ordinaryBuy/riskChecks.ts:1` | `src/core/signalProcessor/riskCheckPipeline.ts:1` |
| `src/application/ordinaryBuy/types.ts:1` | `src/core/signalProcessor/types.ts:1`<br>`src/utils/accountPositions/types.ts:1` |
| `src/application/ordinarySell/index.ts:1` | `src/core/signalProcessor/index.ts:1` |
| `src/application/ordinarySell/quantityResolver.ts:1` | `src/core/signalProcessor/sellQuantityCalculator.ts:1` |
| `src/application/ordinarySell/quantitySelection.ts:1` | `src/core/signalProcessor/utils.ts:1` |
| `src/application/ordinarySell/types.ts:1` | `src/core/signalProcessor/types.ts:1` |
| `src/domain/order/cancelOutcomePolicy.ts:1` | `src/core/trader/utils.ts:1`<br>`src/utils/trading/orderStatus.ts:1` |
| `src/domain/order/executionFact.ts:1` | `src/core/trader/orderMonitor/orderFactMerge.ts:1` |
| `src/domain/order/executionPolicy.ts:1` | `src/core/trader/orderExecutor/utils.ts:1` |
| `src/domain/order/executionProjection.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/order/orderAnalysis.ts:1` | `src/core/utils.ts:1` |
| `src/domain/order/orderFactMerge.ts:1` | `src/core/trader/orderMonitor/orderFactMerge.ts:1` |
| `src/domain/order/orderFilteringEngine.ts:1` | `src/core/orderRecorder/orderFilteringEngine.ts:1` |
| `src/domain/order/orderOwnership.ts:1` | `src/core/orderRecorder/orderOwnershipParser.ts:1` |
| `src/domain/order/orderQuantity.ts:1` | `src/core/orderRecorder/utils.ts:1` |
| `src/domain/order/orderReadLifecycle.ts:1` | `src/core/orderStatusLifecycle/index.ts:1`<br>`src/core/orderStatusLifecycle/utils.ts:1` |
| `src/domain/order/orderRecordPolicy.ts:1` | `src/core/orderRecorder/utils.ts:1` |
| `src/domain/order/orderRemark.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/order/orderSnapshotPolicy.ts:1` | `src/core/orderStatusLifecycle/index.ts:1` |
| `src/domain/order/orderTimeoutPolicy.ts:1` | `src/core/orderStatusLifecycle/index.ts:1` |
| `src/domain/order/orderTrackingPolicy.ts:1` | `src/core/orderStatusLifecycle/index.ts:1`<br>`src/core/orderStatusLifecycle/utils.ts:1` |
| `src/domain/order/orderTypePolicy.ts:1` | `src/core/trader/utils.ts:1` |
| `src/domain/order/quoteReadiness.ts:1` | `src/core/utils.ts:1` |
| `src/domain/order/sellDeductionPolicy.ts:1` | `src/core/orderRecorder/sellDeductionPolicy.ts:1` |
| `src/domain/order/sellMergePolicy.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/order/smartClose.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/order/types.ts:1` | `src/core/orderStatusLifecycle/types.ts:1` |
| `src/runtime/asyncProgram/buyProcessor/index.ts:1` | `src/main/asyncProgram/buyProcessor/index.ts:1` |
| `src/runtime/asyncProgram/buyProcessor/types.ts:1` | `src/main/asyncProgram/buyProcessor/types.ts:1` |
| `src/runtime/asyncProgram/sellProcessor/index.ts:1` | `src/main/asyncProgram/sellProcessor/index.ts:1` |
| `src/runtime/asyncProgram/sellProcessor/types.ts:1` | `src/main/asyncProgram/sellProcessor/types.ts:1` |
| `src/runtime/orderTradeAuditListener/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/orderTradeAuditListener/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |

### G5 风险账户清仓（36 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/application/accountPositionSnapshot/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:1`<br>`src/utils/positionCache/index.ts:1` |
| `src/application/accountPositionSnapshot/types.ts:1` | `src/types/state.ts:1` |
| `src/application/accountQuery/index.ts:1` | `src/core/trader/accountService.ts:1` |
| `src/application/doomsdayClearance/index.ts:1` | `src/core/doomsdayProtection/index.ts:1` |
| `src/application/doomsdayClearance/types.ts:1` | `src/core/doomsdayProtection/types.ts:1` |
| `src/application/postTradeSettlement/index.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:1` |
| `src/application/postTradeSettlement/readinessGate.ts:1` | `src/utils/refreshGate/index.ts:1` |
| `src/application/postTradeSettlement/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/protectiveLiquidation/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/protectiveLiquidation/tradeLogHydrator.ts:1` | `src/services/liquidationCooldown/tradeLogHydrator.ts:1` |
| `src/application/protectiveLiquidation/types.ts:1` | `src/services/liquidationCooldown/types.ts:1` |
| `src/application/protectiveLiquidation/unrealizedLossExecutor.ts:1` | `src/core/riskController/unrealizedLossMonitor.ts:1`<br>`src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts:1` |
| `src/application/riskRefresh/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/application/riskRefresh/warrantRiskRefresh.ts:1` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:1` |
| `src/application/staticLiquidation/index.ts:1` | `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:1` |
| `src/application/staticLiquidation/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/liquidation/cooldown/index.ts:1` | `src/services/liquidationCooldown/index.ts:1` |
| `src/domain/liquidation/cooldown/rules.ts:1` | `src/services/liquidationCooldown/utils.ts:1` |
| `src/domain/liquidation/cooldown/types.ts:1` | `src/services/liquidationCooldown/types.ts:1` |
| `src/domain/liquidation/doomsday/index.ts:1` | `src/core/doomsdayProtection/utils.ts:1` |
| `src/domain/liquidation/doomsday/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/liquidation/episode/index.ts:1` | `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts:1` |
| `src/domain/liquidation/episode/types.ts:1` | `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts:1` |
| `src/domain/risk/buyPricePolicy.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/risk/dailyLossRules.ts:1` | `src/core/riskController/utils.ts:1` |
| `src/domain/risk/dailyLossTracker.ts:1` | `src/core/riskController/dailyLossTracker.ts:1` |
| `src/domain/risk/executionHistory.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/domain/risk/index.ts:1` | `src/core/riskController/index.ts:1` |
| `src/domain/risk/positionLimitChecker.ts:1` | `src/core/riskController/positionLimitChecker.ts:1` |
| `src/domain/risk/types.ts:1` | `src/core/riskController/types.ts:1` |
| `src/domain/risk/unrealizedLossChecker.ts:1` | `src/core/riskController/unrealizedLossChecker.ts:1` |
| `src/domain/risk/warrantRiskChecker.ts:1` | `src/core/riskController/warrantRiskChecker.ts:1` |
| `src/runtime/tradingRiskEventRuntime/routeValidation.ts:1` | `src/main/tradingRiskEventRuntime/routeValidation.ts:1` |
| `src/runtime/tradingRiskEventRuntime/routingIndex.ts:1` | `src/main/tradingRiskEventRuntime/routingIndex.ts:1` |
| `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:1` | `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:1`<br>`src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts:1` |
| `src/runtime/tradingRiskEventRuntime/types.ts:1` | `src/main/tradingRiskEventRuntime/types.ts:1` |

### G6 基建配置公共契约（120 文件）

| current 文件 | develop 来源/定位候选 |
| --- | --- |
| `src/config/auth/index.ts:1` | `src/config/auth/index.ts:1` |
| `src/config/auth/types.ts:1` | `src/config/auth/types.ts:1` |
| `src/config/auth/utils.ts:1` | `src/config/auth/utils.ts:1` |
| `src/config/runtime/index.ts:1` | `src/utils/runtime/index.ts:1` |
| `src/config/trading/index.ts:1` | `src/config/trading/index.ts:1` |
| `src/config/trading/types.ts:1` | `src/config/trading/types.ts:1` |
| `src/config/trading/utils.ts:1` | `src/config/trading/utils.ts:1` |
| `src/config/types.ts:1` | `src/config/types.ts:1` |
| `src/config/utils.ts:1` | `src/config/utils.ts:1` |
| `src/config/validator/index.ts:1` | `src/config/validator/index.ts:1` |
| `src/config/validator/types.ts:1` | `src/config/validator/types.ts:1` |
| `src/config/validator/utils.ts:1` | `src/config/validator/utils.ts:1` |
| `src/constants/cleanup.ts:1` | `src/constants/cleanup.ts:1` |
| `src/constants/diagnostics.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/constants/financialConfig.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/constants/index.ts:1` | `src/constants/index.ts:1` |
| `src/constants/orderOwnership.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/constants/orderReadMetadata.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/constants/strategy.ts:1` | `src/constants/strategy.ts:1` |
| `src/constants/tradeRateLimit.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/diagnostics/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/diagnostics/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/display/accountDisplay/index.ts:1` | `src/services/accountDisplay/index.ts:1` |
| `src/infrastructure/display/marketMonitor/index.ts:1` | `src/services/marketMonitor/index.ts:1` |
| `src/infrastructure/display/marketMonitor/priceDisplayInfo.ts:1` | `src/services/marketMonitor/priceDisplayInfo.ts:1` |
| `src/infrastructure/display/marketMonitor/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/display/marketMonitor/utils.ts:1` | `src/services/marketMonitor/utils.ts:1` |
| `src/infrastructure/externalApi/errorClassification.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/externalApi/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/externalApi/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/logger/index.ts:1` | `src/utils/logger/index.ts:1` |
| `src/infrastructure/logger/types.ts:1` | `src/utils/logger/types.ts:1` |
| `src/infrastructure/longbridge/market/candlestickCache.ts:1` | `src/services/quoteClient/candlestickCache.ts:1` |
| `src/infrastructure/longbridge/market/candlestickMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/marketEnumMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/marketMetadataMapper.ts:1` | `src/services/quoteClient/utils.ts:1` |
| `src/infrastructure/longbridge/market/quoteClient.ts:1` | `src/services/quoteClient/index.ts:1` |
| `src/infrastructure/longbridge/market/quoteFinancialMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/types.ts:1` | `src/services/quoteClient/types.ts:1` |
| `src/infrastructure/longbridge/market/warrantListCache/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/warrantListCache/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/warrantListReadAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/market/warrantRequestMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/accountMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/accountReadAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/clientFactory/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/clientFactory/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/mutationErrorClassification.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/orderMapper.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/orderPushAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/orderReadErrorClassification.ts:1` | `src/core/trader/orderMonitor/utils.ts:1` |
| `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:1` | `src/core/orderRecorder/orderApiManager.ts:1` |
| `src/infrastructure/longbridge/trade/orderValidation.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/pendingOrdersAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/longbridge/trade/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts:1` | `src/services/mixedTradeLogRepository/index.ts:1` |
| `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts:1` | `src/utils/trading/tradeLogPath.ts:1` |
| `src/infrastructure/persistence/mixedTradeLogRepository/types.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/infrastructure/time/index.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/runtime/timer/index.ts:1` | `src/utils/timer/index.ts:1` |
| `src/types/account.ts:1` | `src/services/accountDisplay/types.ts:1`<br>`src/types/account.ts:1` |
| `src/types/accountPosition.ts:1` | `src/services/accountDisplay/types.ts:1`<br>`src/types/state.ts:1`<br>`src/utils/accountPositions/types.ts:1`<br>`src/utils/positionCache/index.ts:1` |
| `src/types/accountReadPorts.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/apiFailure.ts:1` | `src/utils/apiFailure/types.ts:1` |
| `src/types/brokerAccessPorts.ts:1` | `src/core/trader/index.ts:1` |
| `src/types/brokerClientFactory.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/cleanup.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/config.ts:1` | `src/types/config.ts:1` |
| `src/types/data.ts:1` | `src/types/data.ts:1`<br>`src/utils/helpers/types.ts:1` |
| `src/types/diagnostics.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/display.ts:1` | `src/services/accountDisplay/types.ts:1`<br>`src/services/marketMonitor/types.ts:1`<br>`src/types/services.ts:1` |
| `src/types/events.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/lifecycle.ts:1` | `src/main/lifecycle/types.ts:1` |
| `src/types/logger.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/marketPorts.ts:1` | `src/types/services.ts:1` |
| `src/types/monitor.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderCancellation.ts:1` | `src/types/trader.ts:1` |
| `src/types/orderDetailReadPorts.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderExecutionPorts.ts:1` | `src/core/trader/index.ts:1`<br>`src/types/services.ts:1` |
| `src/types/orderHold.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderPushPorts.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderReadMetadata.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderRecorder.ts:1` | `src/types/orderRecorder.ts:1` |
| `src/types/orderSnapshotReadPorts.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/orderTracking.ts:1` | `src/core/orderStatusLifecycle/types.ts:1` |
| `src/types/periodicSwitch.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/quote.ts:1` | `src/types/quote.ts:1` |
| `src/types/quoteSubscription.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/rateLimit.ts:1` | `src/utils/types.ts:1` |
| `src/types/risk.ts:1` | `src/types/risk.ts:1` |
| `src/types/riskCheck.ts:1` | `src/core/signalProcessor/types.ts:1` |
| `src/types/runtime.ts:1` | `src/types/runtime.ts:1`<br>`src/types/state.ts:1` |
| `src/types/seat.ts:1` | `src/types/seat.ts:1`<br>`src/utils/helpers/types.ts:1`<br>`src/utils/seat/types.ts:1` |
| `src/types/seatSwitch.ts:1` | `src/types/monitorContextPorts.ts:1` |
| `src/types/settlement.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/signal.ts:1` | `src/types/signal.ts:1` |
| `src/types/strategy.ts:1` | `src/core/strategy/types.ts:1` |
| `src/types/timeControlPlane.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/timer.ts:1` | `src/utils/timer/types.ts:1` |
| `src/types/trade.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/tradeLog.ts:1` | `src/services/mixedTradeLogRepository/types.ts:1` |
| `src/types/tradeMutationPorts.ts:1` | `src/core/trader/index.ts:1` |
| `src/types/tradingCalendar.ts:1` | `src/types/state.ts:1`<br>`src/types/tradingCalendar.ts:1` |
| `src/types/unrealizedLoss.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/types/warrantRisk.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/utils/apiFailure/index.ts:1` | `src/utils/apiFailure/index.ts:1` |
| `src/utils/display/index.ts:1` | `src/utils/display/index.ts:1` |
| `src/utils/error/index.ts:1` | `src/utils/error/index.ts:1` |
| `src/utils/helpers/index.ts:1` | `src/utils/helpers/index.ts:1` |
| `src/utils/marketScope.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/utils/numeric/exact.ts:1` | 新增/未配对；不等于新增需求已获授权 |
| `src/utils/numeric/index.ts:1` | `src/utils/numeric/index.ts:1` |
| `src/utils/numeric/types.ts:1` | `src/utils/numeric/types.ts:1`<br>`src/utils/types.ts:1` |
| `src/utils/time/index.ts:1` | `src/utils/time/index.ts:1` |
| `src/utils/time/types.ts:1` | `src/utils/time/types.ts:1`<br>`src/utils/types.ts:1` |

## 附录 B：全 develop src → current 定位账本（263 / 263）

低阈值 rename 可能误配，仅用于迁移覆盖定位，不是等价性证明。不存在同名文件不代表行为被删除；人工候选均待真实符号消费者复核。

| develop 文件 | current 目标/owner 候选 | 映射机制与主责 |
| --- | --- | --- |
| `src/app/context/createMonitorContext.ts:1` | `src/app/context/createMonitorContext.ts:1` | 同路径，行为待比较；G0 |
| `src/app/lifecycle/createLifecycleRuntime.ts:1` | `src/app/lifecycle/createLifecycleRuntime.ts:1` | 同路径，行为待比较；G0 |
| `src/app/lifecycle/rebuild.ts:1` | `src/application/tradingDayRebuild/startupRebuild.ts:1`<br>`src/application/tradingDayRebuild/openRebuild.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1 |
| `src/app/runApp.ts:1` | `src/app/runApp.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runAppDeps.ts:1` | `src/app/runAppDeps.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createAsyncRuntime.ts:1` | `src/app/runtime/createAsyncRuntime.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createPostGateRuntime.ts:1` | `src/app/runtime/createPostGateRuntime.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createPostGateRuntimeDeps.ts:1` | `src/app/runtime/createPostGateRuntimeDeps.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts:1` | `src/app/runtime/createPostTradeConsistencyRuntime.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createPreGateRuntime.ts:1` | `src/app/runtime/createPreGateRuntime.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createPreGateRuntimeDeps.ts:1` | `src/app/runtime/createPreGateRuntimeDeps.ts:1` | 同路径，行为待比较；G0 |
| `src/app/runtime/createTerminationRuntime.ts:1` | `src/runtime/lifecycle/terminationRuntime.ts:1` | R100 Git 定位，非等价证明；G1 |
| `src/app/shutdown/createCleanup.ts:1` | `src/app/shutdown/createCleanup.ts:1` | 同路径，行为待比较；G0 |
| `src/app/startup/createSelectedStrategy.ts:1` | `src/app/startup/createSelectedStrategy.ts:1` | 同路径，行为待比较；G0 |
| `src/app/startup/prepareStrategy.ts:1` | `src/app/startup/prepareStrategy.ts:1` | 同路径，行为待比较；G0 |
| `src/app/startup/runtimeValidation.ts:1` | `src/app/startup/runtimeValidation.ts:1` | 同路径，行为待比较；G0 |
| `src/app/startup/startupSnapshot.ts:1` | `src/application/tradingDayRebuild/startupSnapshot.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1 |
| `src/app/startup/strategyLoaderHelpers.ts:1` | `src/app/startup/strategyLoaderHelpers.ts:1` | 同路径，行为待比较；G0 |
| `src/app/startup/types.ts:1` | `src/app/startup/types.ts:1` | 同路径，行为待比较；G0 |
| `src/app/types.ts:1` | `src/app/types.ts:1` | 同路径，行为待比较；G0 |
| `src/config/auth/index.ts:1` | `src/config/auth/index.ts:1` | 同路径，行为待比较；G6 |
| `src/config/auth/types.ts:1` | `src/config/auth/types.ts:1` | 同路径，行为待比较；G6 |
| `src/config/auth/utils.ts:1` | `src/config/auth/utils.ts:1` | 同路径，行为待比较；G6 |
| `src/config/trading/index.ts:1` | `src/config/trading/index.ts:1` | 同路径，行为待比较；G6 |
| `src/config/trading/types.ts:1` | `src/config/trading/types.ts:1` | 同路径，行为待比较；G6 |
| `src/config/trading/utils.ts:1` | `src/config/trading/utils.ts:1` | 同路径，行为待比较；G6 |
| `src/config/types.ts:1` | `src/config/types.ts:1` | 同路径，行为待比较；G6 |
| `src/config/utils.ts:1` | `src/config/utils.ts:1` | 同路径，行为待比较；G6 |
| `src/config/validator/index.ts:1` | `src/config/validator/index.ts:1` | 同路径，行为待比较；G6 |
| `src/config/validator/types.ts:1` | `src/config/validator/types.ts:1` | 同路径，行为待比较；G6 |
| `src/config/validator/utils.ts:1` | `src/config/validator/utils.ts:1` | 同路径，行为待比较；G6 |
| `src/constants/cleanup.ts:1` | `src/constants/cleanup.ts:1` | 同路径，行为待比较；G6 |
| `src/constants/index.ts:1` | `src/constants/index.ts:1` | 同路径，行为待比较；G6 |
| `src/constants/strategy.ts:1` | `src/constants/strategy.ts:1` | 同路径，行为待比较；G6 |
| `src/core/doomsdayProtection/index.ts:1` | `src/application/doomsdayClearance/index.ts:1` | R050 Git 定位，非等价证明；G5 |
| `src/core/doomsdayProtection/types.ts:1` | `src/application/doomsdayClearance/types.ts:1` | R026 Git 定位，非等价证明；G5 |
| `src/core/doomsdayProtection/utils.ts:1` | `src/domain/liquidation/doomsday/index.ts:1` | R068 Git 定位，非等价证明；G5 |
| `src/core/orderRecorder/index.ts:1` | `src/application/orderTracking/recorder/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/orderRecorder/orderApiManager.ts:1` | `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:1` | R027 Git 定位，非等价证明；G6 |
| `src/core/orderRecorder/orderFilteringEngine.ts:1` | `src/domain/order/orderFilteringEngine.ts:1` | R073 Git 定位，非等价证明；G4 |
| `src/core/orderRecorder/orderOwnershipParser.ts:1` | `src/domain/order/orderOwnership.ts:1` | R089 Git 定位，非等价证明；G4 |
| `src/core/orderRecorder/orderStorage.ts:1` | `src/application/orderTracking/recorder/orderStorage.ts:1` | R064 Git 定位，非等价证明；G4 |
| `src/core/orderRecorder/sellDeductionPolicy.ts:1` | `src/domain/order/sellDeductionPolicy.ts:1` | R086 Git 定位，非等价证明；G4 |
| `src/core/orderRecorder/types.ts:1` | `src/application/orderTracking/recorder/types.ts:1` | R042 Git 定位，非等价证明；G4 |
| `src/core/orderRecorder/utils.ts:1` | `src/domain/order/orderRecordPolicy.ts:1`<br>`src/domain/order/orderQuantity.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/orderStatusLifecycle/index.ts:1` | `src/domain/order/orderReadLifecycle.ts:1`<br>`src/domain/order/orderTrackingPolicy.ts:1`<br>`src/domain/order/orderSnapshotPolicy.ts:1`<br>`src/domain/order/orderTimeoutPolicy.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/orderStatusLifecycle/types.ts:1` | `src/domain/order/types.ts:1`<br>`src/types/orderTracking.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 |
| `src/core/orderStatusLifecycle/utils.ts:1` | `src/domain/order/orderReadLifecycle.ts:1`<br>`src/domain/order/orderTrackingPolicy.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/riskController/dailyLossTracker.ts:1` | `src/domain/risk/dailyLossTracker.ts:1` | R065 Git 定位，非等价证明；G5 |
| `src/core/riskController/index.ts:1` | `src/domain/risk/index.ts:1` | R025 Git 定位，非等价证明；G5 |
| `src/core/riskController/positionLimitChecker.ts:1` | `src/domain/risk/positionLimitChecker.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/core/riskController/types.ts:1` | `src/domain/risk/types.ts:1` | R051 Git 定位，非等价证明；G5 |
| `src/core/riskController/unrealizedLossChecker.ts:1` | `src/domain/risk/unrealizedLossChecker.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/core/riskController/unrealizedLossMonitor.ts:1` | `src/application/protectiveLiquidation/unrealizedLossExecutor.ts:1` | R033 Git 定位，非等价证明；G5 |
| `src/core/riskController/utils.ts:1` | `src/domain/risk/dailyLossRules.ts:1` | R068 Git 定位，非等价证明；G5 |
| `src/core/riskController/warrantRiskChecker.ts:1` | `src/domain/risk/warrantRiskChecker.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/core/signalProcessor/index.ts:1` | `src/application/ordinaryBuy/index.ts:1`<br>`src/application/ordinarySell/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/signalProcessor/riskCheckPipeline.ts:1` | `src/application/ordinaryBuy/riskChecks.ts:1` | R077 Git 定位，非等价证明；G4 |
| `src/core/signalProcessor/sellQuantityCalculator.ts:1` | `src/application/ordinarySell/quantityResolver.ts:1` | R079 Git 定位，非等价证明；G4 |
| `src/core/signalProcessor/types.ts:1` | `src/application/ordinaryBuy/types.ts:1`<br>`src/application/ordinarySell/types.ts:1`<br>`src/types/riskCheck.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 |
| `src/core/signalProcessor/utils.ts:1` | `src/application/ordinarySell/quantitySelection.ts:1` | R066 Git 定位，非等价证明；G4 |
| `src/core/strategy/intradayRegression/config.json:1` | `src/strategies/intradayRegression/config.json:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/config.ts:1` | `src/strategies/intradayRegression/config.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/constants.ts:1` | `src/strategies/intradayRegression/constants.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/definition.ts:1` | `src/strategies/intradayRegression/definition.ts:1` | R087 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/display.ts:1` | `src/strategies/intradayRegression/display.ts:1` | R094 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/dsl.ts:1` | `src/strategies/intradayRegression/dsl.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/index.ts:1` | `src/strategies/intradayRegression/index.ts:1` | R095 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/indicatorHelpers/types.ts:1` | `src/strategies/intradayRegression/indicatorHelpers/types.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/indicatorHelpers/utils.ts:1` | `src/strategies/intradayRegression/indicatorHelpers/utils.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/profile/index.ts:1` | `src/strategies/intradayRegression/profile/index.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/profile/types.ts:1` | `src/strategies/intradayRegression/profile/types.ts:1` | R087 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/profile/utils.ts:1` | `src/strategies/intradayRegression/profile/utils.ts:1` | R093 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/adx.ts:1` | `src/strategies/intradayRegression/indicators/adx.ts:1` | R095 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/ema.ts:1` | `src/strategies/intradayRegression/indicators/ema.ts:1` | R098 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/index.ts:1` | `src/strategies/intradayRegression/indicators/index.ts:1` | R090 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/kdj.ts:1` | `src/strategies/intradayRegression/indicators/kdj.ts:1` | R098 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/macd.ts:1` | `src/strategies/intradayRegression/indicators/macd.ts:1` | R097 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/mfi.ts:1` | `src/strategies/intradayRegression/indicators/mfi.ts:1` | R094 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/psy.ts:1` | `src/strategies/intradayRegression/indicators/psy.ts:1` | R098 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/rsi.ts:1` | `src/strategies/intradayRegression/indicators/rsi.ts:1` | R098 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/types.ts:1` | `src/strategies/intradayRegression/indicators/types.ts:1` | R098 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/runtime/utils.ts:1` | `src/strategies/intradayRegression/indicators/indicatorMath.ts:1` | R092 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/types.ts:1` | `src/strategies/intradayRegression/types.ts:1` | R097 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/utils.ts:1` | `src/strategies/intradayRegression/signalRules.ts:1` | R097 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/verification/index.ts:1` | `src/strategies/intradayRegression/verification/pendingVerification.ts:1` | R072 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/verification/sampleStore.ts:1` | `src/strategies/intradayRegression/verification/sampleStore.ts:1` | R097 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/verification/types.ts:1` | `src/strategies/intradayRegression/verification/types.ts:1` | R091 Git 定位，非等价证明；G2 |
| `src/core/strategy/intradayRegression/verification/utils.ts:1` | `src/strategies/intradayRegression/verification/sampleRules.ts:1` | R097 Git 定位，非等价证明；G2 |
| `src/core/strategy/types.ts:1` | `src/types/strategy.ts:1` | R094 Git 定位，非等价证明；G6 |
| `src/core/strategy/utils.ts:1` | `src/domain/strategy/utils.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/core/trader/accountService.ts:1` | `src/application/accountQuery/index.ts:1` | R036 Git 定位，非等价证明；G5 |
| `src/core/trader/index.ts:1` | `src/app/runtime/createTradeRuntime.ts:1`<br>`src/types/brokerAccessPorts.ts:1`<br>`src/types/orderExecutionPorts.ts:1`<br>`src/types/tradeMutationPorts.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G0/G6 |
| `src/core/trader/orderCacheManager.ts:1` | `src/application/orderTracking/orderCacheManager.ts:1` | R069 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/buyThrottle.ts:1` | `src/application/orderExecution/buyThrottle.ts:1` | R091 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/index.ts:1` | `src/application/orderExecution/index.ts:1` | R073 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/quantityResolver.ts:1` | `src/application/orderExecution/quantityResolver.ts:1` | R044 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/submitFlow.ts:1` | `src/application/orderExecution/submitFlow.ts:1` | R055 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/types.ts:1` | `src/application/orderExecution/types.ts:1` | R046 Git 定位，非等价证明；G4 |
| `src/core/trader/orderExecutor/utils.ts:1` | `src/domain/order/executionPolicy.ts:1` | R029 Git 定位，非等价证明；G4 |
| `src/core/trader/orderHoldRegistry.ts:1` | `src/application/orderTracking/orderHoldRegistry.ts:1` | R077 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/eventFlow.ts:1` | `src/application/orderTracking/orderMonitor/eventFlow.ts:1` | R054 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/index.ts:1` | `src/application/orderTracking/orderMonitor/index.ts:1` | R059 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/orderFactMerge.ts:1` | `src/domain/order/orderFactMerge.ts:1`<br>`src/domain/order/executionFact.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/trader/orderMonitor/orderOps.ts:1` | `src/application/orderTracking/orderMonitor/orderOps.ts:1` | R062 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/orderStatusQuery.ts:1` | `src/application/orderTracking/orderMonitor/orderStatusQuery.ts:1` | R040 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/recoveryFlow.ts:1` | `src/application/orderTracking/orderMonitor/recoveryFlow.ts:1` | R074 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/routeProcessor.ts:1` | `src/application/orderTracking/orderMonitor/routeProcessor.ts:1` | R078 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/routeRuntime.ts:1` | `src/application/orderTracking/orderMonitor/routeRuntime.ts:1` | R096 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/routingIndex.ts:1` | `src/application/orderTracking/orderMonitor/routingIndex.ts:1` | R099 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/settlementFlow.ts:1` | `src/application/orderTracking/orderMonitor/settlementFlow.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/trader/orderMonitor/types.ts:1` | `src/application/orderTracking/orderMonitor/types.ts:1` | R065 Git 定位，非等价证明；G4 |
| `src/core/trader/orderMonitor/utils.ts:1` | `src/infrastructure/longbridge/trade/orderReadErrorClassification.ts:1` | R041 Git 定位，非等价证明；G6 |
| `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts:1` | `src/domain/liquidation/episode/index.ts:1` | R079 Git 定位，非等价证明；G5 |
| `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts:1` | `src/domain/liquidation/episode/types.ts:1` | R082 Git 定位，非等价证明；G5 |
| `src/core/trader/rateLimiter.ts:1` | `src/application/orderExecution/rateLimiter.ts:1` | R085 Git 定位，非等价证明；G4 |
| `src/core/trader/types.ts:1` | `src/application/orderTracking/types.ts:1` | R032 Git 定位，非等价证明；G4 |
| `src/core/trader/utils.ts:1` | `src/domain/order/orderTypePolicy.ts:1`<br>`src/domain/order/cancelOutcomePolicy.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/core/utils.ts:1` | `src/domain/order/orderAnalysis.ts:1`<br>`src/domain/order/quoteReadiness.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/index.ts:1` | `src/index.ts:1` | 同路径，行为待比较；G0 |
| `src/main/asyncProgram/buyProcessor/index.ts:1` | `src/runtime/asyncProgram/buyProcessor/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/main/asyncProgram/buyProcessor/types.ts:1` | `src/runtime/asyncProgram/buyProcessor/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:1` | `src/application/autoSearch/index.ts:1`<br>`src/application/seatSwitch/index.ts:1`<br>`src/runtime/asyncProgram/monitorTaskProcessor/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3/G0 |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:1` | `src/application/seatActivation/index.ts:1` | R029 Git 定位，非等价证明；G3 |
| `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:1` | `src/application/riskRefresh/warrantRiskRefresh.ts:1`<br>`src/application/accountPositionSnapshot/index.ts:1`<br>`src/application/postTradeSettlement/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts:1` | `src/domain/seat/seatSnapshot.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/main/asyncProgram/monitorTaskProcessor/index.ts:1` | `src/runtime/asyncProgram/monitorTaskProcessor/index.ts:1`<br>`src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G0 |
| `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:1` | `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:1` | R090 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/monitorTaskProcessor/types.ts:1` | `src/runtime/asyncProgram/monitorTaskProcessor/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G0 |
| `src/main/asyncProgram/monitorTaskQueue/index.ts:1` | `src/runtime/asyncProgram/monitorTaskQueue/index.ts:1` | R068 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/monitorTaskQueue/types.ts:1` | `src/runtime/asyncProgram/monitorTaskQueue/types.ts:1` | R083 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/sellProcessor/index.ts:1` | `src/runtime/asyncProgram/sellProcessor/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/main/asyncProgram/sellProcessor/types.ts:1` | `src/runtime/asyncProgram/sellProcessor/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4 |
| `src/main/asyncProgram/tradeTaskQueue/index.ts:1` | `src/runtime/asyncProgram/tradeTaskQueue/index.ts:1` | R054 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/tradeTaskQueue/types.ts:1` | `src/runtime/asyncProgram/tradeTaskQueue/types.ts:1` | R088 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/types.ts:1` | `src/runtime/asyncProgram/types.ts:1` | R095 Git 定位，非等价证明；G0 |
| `src/main/asyncProgram/utils.ts:1` | `src/runtime/asyncProgram/processor.ts:1` | R055 Git 定位，非等价证明；G0 |
| `src/main/autoSearchWakeupRuntime/index.ts:1` | `src/runtime/autoSearchWakeupRuntime/index.ts:1` | R084 Git 定位，非等价证明；G3 |
| `src/main/autoSearchWakeupRuntime/types.ts:1` | `src/runtime/autoSearchWakeupRuntime/types.ts:1` | R060 Git 定位，非等价证明；G3 |
| `src/main/businessEventProgram/emissionAdapter.ts:1` | `src/runtime/businessEventProgram/emissionAdapter.ts:1` | R090 Git 定位，非等价证明；G0 |
| `src/main/businessEventProgram/index.ts:1` | `src/runtime/businessEventProgram/index.ts:1` | R093 Git 定位，非等价证明；G0 |
| `src/main/businessEventProgram/types.ts:1` | `src/runtime/businessEventProgram/types.ts:1` | R079 Git 定位，非等价证明；G0 |
| `src/main/businessEventProgram/utils.ts:1` | `src/runtime/businessEventProgram/utils.ts:1` | R096 Git 定位，非等价证明；G0 |
| `src/main/lifecycle/cacheDomains/globalStateDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts:1` | R034 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/marketDataDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts:1` | R077 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/orderDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/orderDomain.ts:1` | R071 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/riskDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/riskDomain.ts:1` | R071 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/seatDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/seatDomain.ts:1` | R079 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:1` | `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:1` | R078 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/cacheDomains/types.ts:1` | `src/runtime/lifecycle/cacheDomains/types.ts:1` | R043 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/dayLifecycleManager.ts:1` | `src/runtime/lifecycle/dayLifecycleManager.ts:1` | R052 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:1` | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:1` | R048 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/rebuildTradingDayState.ts:1` | `src/application/tradingDayRebuild/rebuildTradingDayState.ts:1` | R034 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/seatActivationCarryover.ts:1` | `src/application/tradingDayRebuild/seatActivationCarryover.ts:1` | R097 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/startupFailureState.ts:1` | `src/application/tradingDayRebuild/startupFailureState.ts:1` | R058 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/tradingCalendarPrewarmer.ts:1` | `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts:1` | R087 Git 定位，非等价证明；G1 |
| `src/main/lifecycle/types.ts:1` | `src/runtime/lifecycle/types.ts:1`<br>`src/application/tradingDayRebuild/types.ts:1`<br>`src/types/lifecycle.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1/G6 |
| `src/main/lifecycle/utils.ts:1` | `src/domain/tradingSession/index.ts:1`<br>`src/application/tradingDayRebuild/quoteSymbols.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1 |
| `src/main/monitorDisplayRuntime/index.ts:1` | `src/runtime/monitorDisplayRuntime/index.ts:1` | R090 Git 定位，非等价证明；G2 |
| `src/main/monitorDisplayRuntime/types.ts:1` | `src/runtime/monitorDisplayRuntime/types.ts:1` | R059 Git 定位，非等价证明；G2 |
| `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:1` | `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:1` | R073 Git 定位，非等价证明；G2 |
| `src/main/monitorQuoteEventRuntime/setUtils.ts:1` | `src/runtime/monitorQuoteEventRuntime/setUtils.ts:1` | R100 Git 定位，非等价证明；G2 |
| `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:1` | `src/application/staticLiquidation/index.ts:1` | R048 Git 定位，非等价证明；G5 |
| `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:1` | `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:1` | R082 Git 定位，非等价证明；G2 |
| `src/main/monitorQuoteEventRuntime/types.ts:1` | `src/runtime/monitorQuoteEventRuntime/types.ts:1` | R064 Git 定位，非等价证明；G2 |
| `src/main/ordinarySignalGuard/index.ts:1` | `src/domain/strategy/ordinarySignalGuard.ts:1` | R050 Git 定位，非等价证明；G2 |
| `src/main/periodicSwitchWakeupRuntime/index.ts:1` | `src/runtime/periodicSwitchWakeupRuntime/index.ts:1` | R043 Git 定位，非等价证明；G3 |
| `src/main/periodicSwitchWakeupRuntime/types.ts:1` | `src/runtime/periodicSwitchWakeupRuntime/types.ts:1` | R056 Git 定位，非等价证明；G3 |
| `src/main/quoteSubscriptionRuntime/index.ts:1` | `src/runtime/quoteSubscriptionRuntime/index.ts:1` | R054 Git 定位，非等价证明；G2 |
| `src/main/quoteSubscriptionRuntime/types.ts:1` | `src/runtime/quoteSubscriptionRuntime/types.ts:1` | R065 Git 定位，非等价证明；G2 |
| `src/main/recovery/seatPreparation.ts:1` | `src/application/tradingDayRebuild/seatPreparation.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1 |
| `src/main/recovery/types.ts:1` | `src/application/tradingDayRebuild/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G1 |
| `src/main/seatActivationDispatcher/index.ts:1` | `src/runtime/seatActivationDispatcher/index.ts:1` | R098 Git 定位，非等价证明；G3 |
| `src/main/seatActivationDispatcher/types.ts:1` | `src/runtime/seatActivationDispatcher/types.ts:1` | R089 Git 定位，非等价证明；G3 |
| `src/main/seatRuntimeCleanupDispatcher/index.ts:1` | `src/runtime/seatRuntimeCleanupDispatcher/index.ts:1` | R082 Git 定位，非等价证明；G3 |
| `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts:1` | `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts:1` | R100 Git 定位，非等价证明；G3 |
| `src/main/seatRuntimeCleanupDispatcher/types.ts:1` | `src/runtime/seatRuntimeCleanupDispatcher/types.ts:1` | R082 Git 定位，非等价证明；G3 |
| `src/main/timeWakeupEvaluationProgram/index.ts:1` | `src/runtime/timeWakeupEvaluationProgram/index.ts:1` | R061 Git 定位，非等价证明；G1 |
| `src/main/timeWakeupEvaluationProgram/types.ts:1` | `src/runtime/timeWakeupEvaluationProgram/types.ts:1` | R032 Git 定位，非等价证明；G1 |
| `src/main/timeWakeupPlanner/index.ts:1` | `src/runtime/timeWakeupPlanner/index.ts:1` | R100 Git 定位，非等价证明；G1 |
| `src/main/timeWakeupPlanner/types.ts:1` | `src/runtime/timeWakeupPlanner/types.ts:1` | R100 Git 定位，非等价证明；G1 |
| `src/main/timeWakeupRuntime/index.ts:1` | `src/runtime/timeWakeupRuntime/index.ts:1` | R094 Git 定位，非等价证明；G1 |
| `src/main/timeWakeupRuntime/types.ts:1` | `src/runtime/timeWakeupRuntime/types.ts:1` | R069 Git 定位，非等价证明；G1 |
| `src/main/tradingGateEventRuntime/index.ts:1` | `src/runtime/tradingGateEventRuntime/index.ts:1` | R094 Git 定位，非等价证明；G1 |
| `src/main/tradingGateEventRuntime/types.ts:1` | `src/runtime/tradingGateEventRuntime/types.ts:1` | R036 Git 定位，非等价证明；G1 |
| `src/main/tradingQuoteDisplayRuntime/index.ts:1` | `src/runtime/tradingQuoteDisplayRuntime/index.ts:1` | R092 Git 定位，非等价证明；G2 |
| `src/main/tradingQuoteDisplayRuntime/types.ts:1` | `src/runtime/tradingQuoteDisplayRuntime/types.ts:1` | R061 Git 定位，非等价证明；G2 |
| `src/main/tradingRiskEventRuntime/routeValidation.ts:1` | `src/runtime/tradingRiskEventRuntime/routeValidation.ts:1` | R083 Git 定位，非等价证明；G5 |
| `src/main/tradingRiskEventRuntime/routingIndex.ts:1` | `src/runtime/tradingRiskEventRuntime/routingIndex.ts:1` | R081 Git 定位，非等价证明；G5 |
| `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:1` | `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:1` | R029 Git 定位，非等价证明；G5 |
| `src/main/tradingRiskEventRuntime/types.ts:1` | `src/runtime/tradingRiskEventRuntime/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts:1` | `src/application/protectiveLiquidation/unrealizedLossExecutor.ts:1`<br>`src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/main/utils.ts:1` | `src/application/tradingDayRebuild/quoteSymbols.ts:1` | R065 Git 定位，非等价证明；G1 |
| `src/services/accountDisplay/index.ts:1` | `src/infrastructure/display/accountDisplay/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |
| `src/services/accountDisplay/types.ts:1` | `src/types/account.ts:1`<br>`src/types/accountPosition.ts:1`<br>`src/types/display.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |
| `src/services/autoSymbolFinder/index.ts:1` | `src/application/autoSearch/candidateSearch.ts:1` | R040 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolFinder/policyResolver.ts:1` | `src/domain/seat/seatPolicy.ts:1`<br>`src/domain/seat/warrantSelection/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/services/autoSymbolFinder/types.ts:1` | `src/application/autoSearch/types.ts:1`<br>`src/domain/seat/warrantSelection/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/services/autoSymbolFinder/utils.ts:1` | `src/domain/seat/warrantSelection/index.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/services/autoSymbolManager/autoSearch.ts:1` | `src/application/autoSearch/index.ts:1` | R057 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/index.ts:1` | `src/application/seatSwitch/index.ts:1` | R038 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/seatStateManager.ts:1` | `src/application/seatSwitch/seatStateManager.ts:1` | R078 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/signalBuilder.ts:1` | `src/application/seatSwitch/signalBuilder.ts:1` | R062 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/switchStateMachine.ts:1` | `src/application/seatSwitch/switchStateMachine.ts:1` | R064 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/thresholdResolver.ts:1` | `src/domain/seat/switchPolicy.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/services/autoSymbolManager/types.ts:1` | `src/application/seatSwitch/types.ts:1` | R039 Git 定位，非等价证明；G3 |
| `src/services/autoSymbolManager/utils.ts:1` | `src/domain/seat/symbolRegistry.ts:1` | R059 Git 定位，非等价证明；G3 |
| `src/services/liquidationCooldown/index.ts:1` | `src/domain/liquidation/cooldown/index.ts:1` | R086 Git 定位，非等价证明；G5 |
| `src/services/liquidationCooldown/tradeLogHydrator.ts:1` | `src/application/protectiveLiquidation/tradeLogHydrator.ts:1` | R079 Git 定位，非等价证明；G5 |
| `src/services/liquidationCooldown/types.ts:1` | `src/domain/liquidation/cooldown/types.ts:1`<br>`src/application/protectiveLiquidation/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/services/liquidationCooldown/utils.ts:1` | `src/domain/liquidation/cooldown/rules.ts:1` | R093 Git 定位，非等价证明；G5 |
| `src/services/marketMonitor/index.ts:1` | `src/infrastructure/display/marketMonitor/index.ts:1` | R076 Git 定位，非等价证明；G6 |
| `src/services/marketMonitor/priceDisplayInfo.ts:1` | `src/infrastructure/display/marketMonitor/priceDisplayInfo.ts:1` | R075 Git 定位，非等价证明；G6 |
| `src/services/marketMonitor/types.ts:1` | `src/types/display.ts:1` | R050 Git 定位，非等价证明；G6 |
| `src/services/marketMonitor/utils.ts:1` | `src/infrastructure/display/marketMonitor/utils.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |
| `src/services/mixedTradeLogRepository/index.ts:1` | `src/infrastructure/persistence/mixedTradeLogRepository/index.ts:1` | R098 Git 定位，非等价证明；G6 |
| `src/services/mixedTradeLogRepository/types.ts:1` | `src/types/tradeLog.ts:1` | R040 Git 定位，非等价证明；G6 |
| `src/services/quoteClient/candlestickCache.ts:1` | `src/infrastructure/longbridge/market/candlestickCache.ts:1` | R068 Git 定位，非等价证明；G6 |
| `src/services/quoteClient/index.ts:1` | `src/infrastructure/longbridge/market/quoteClient.ts:1` | R084 Git 定位，非等价证明；G6 |
| `src/services/quoteClient/types.ts:1` | `src/infrastructure/longbridge/market/types.ts:1` | R091 Git 定位，非等价证明；G6 |
| `src/services/quoteClient/utils.ts:1` | `src/infrastructure/longbridge/market/marketMetadataMapper.ts:1` | R064 Git 定位，非等价证明；G6 |
| `src/types/account.ts:1` | `src/types/account.ts:1` | 同路径，行为待比较；G6 |
| `src/types/config.ts:1` | `src/types/config.ts:1` | 同路径，行为待比较；G6 |
| `src/types/data.ts:1` | `src/types/data.ts:1` | 同路径，行为待比较；G6 |
| `src/types/monitorContextPorts.ts:1` | `src/types/seatSwitch.ts:1` | R056 Git 定位，非等价证明；G6 |
| `src/types/orderRecorder.ts:1` | `src/types/orderRecorder.ts:1` | 同路径，行为待比较；G6 |
| `src/types/quote.ts:1` | `src/types/quote.ts:1` | 同路径，行为待比较；G6 |
| `src/types/risk.ts:1` | `src/types/risk.ts:1` | 同路径，行为待比较；G6 |
| `src/types/runtime.ts:1` | `src/types/runtime.ts:1` | 同路径，行为待比较；G6 |
| `src/types/seat.ts:1` | `src/types/seat.ts:1` | 同路径，行为待比较；G6 |
| `src/types/services.ts:1` | `src/types/display.ts:1`<br>`src/types/marketPorts.ts:1`<br>`src/types/orderExecutionPorts.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |
| `src/types/signal.ts:1` | `src/types/signal.ts:1` | 同路径，行为待比较；G6 |
| `src/types/state.ts:1` | `src/types/runtime.ts:1`<br>`src/types/tradingCalendar.ts:1`<br>`src/types/accountPosition.ts:1`<br>`src/application/accountPositionSnapshot/types.ts:1`<br>`src/domain/seat/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6/G5/G3 |
| `src/types/trader.ts:1` | `src/types/orderCancellation.ts:1` | R031 Git 定位，非等价证明；G6 |
| `src/types/tradingCalendar.ts:1` | `src/types/tradingCalendar.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/accountPositions/index.ts:1` | `src/application/ordinaryBuy/accountPositionsRead.ts:1` | R082 Git 定位，非等价证明；G4 |
| `src/utils/accountPositions/types.ts:1` | `src/application/ordinaryBuy/types.ts:1`<br>`src/types/accountPosition.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 |
| `src/utils/apiFailure/index.ts:1` | `src/utils/apiFailure/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/apiFailure/types.ts:1` | `src/types/apiFailure.ts:1` | R054 Git 定位，非等价证明；G6 |
| `src/utils/display/index.ts:1` | `src/utils/display/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/error/index.ts:1` | `src/utils/error/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/helpers/index.ts:1` | `src/utils/helpers/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/helpers/types.ts:1` | `src/types/data.ts:1`<br>`src/types/seat.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |
| `src/utils/logger/index.ts:1` | `src/infrastructure/logger/index.ts:1` | R098 Git 定位，非等价证明；G6 |
| `src/utils/logger/types.ts:1` | `src/infrastructure/logger/types.ts:1` | R050 Git 定位，非等价证明；G6 |
| `src/utils/numeric/index.ts:1` | `src/utils/numeric/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/numeric/types.ts:1` | `src/utils/numeric/types.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/positionCache/index.ts:1` | `src/application/accountPositionSnapshot/index.ts:1`<br>`src/types/accountPosition.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5/G6 |
| `src/utils/quoteRetry/index.ts:1` | `src/application/quoteRetry.ts:1` | R034 Git 定位，非等价证明；G2 |
| `src/utils/quoteRetry/types.ts:1` | `src/application/types.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G0 |
| `src/utils/refreshGate/index.ts:1` | `src/application/postTradeSettlement/readinessGate.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G5 |
| `src/utils/runtime/index.ts:1` | `src/config/runtime/index.ts:1` | R091 Git 定位，非等价证明；G6 |
| `src/utils/seat/guards.ts:1` | `src/domain/seat/seatPolicy.ts:1`<br>`src/domain/seat/seatIdentity.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/utils/seat/snapshots.ts:1` | `src/domain/seat/seatSnapshot.ts:1` | R084 Git 定位，非等价证明；G3 |
| `src/utils/seat/symbols.ts:1` | `src/domain/seat/seatIdentity.ts:1`<br>`src/domain/seat/symbolRegistry.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3 |
| `src/utils/seat/types.ts:1` | `src/domain/seat/types.ts:1`<br>`src/types/seat.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G3/G6 |
| `src/utils/time/index.ts:1` | `src/utils/time/index.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/time/types.ts:1` | `src/utils/time/types.ts:1` | 同路径，行为待比较；G6 |
| `src/utils/timer/index.ts:1` | `src/runtime/timer/index.ts:1` | R092 Git 定位，非等价证明；G6 |
| `src/utils/timer/types.ts:1` | `src/types/timer.ts:1` | R079 Git 定位，非等价证明；G6 |
| `src/utils/trading/orderStatus.ts:1` | `src/domain/order/cancelOutcomePolicy.ts:1` | R087 Git 定位，非等价证明；G4 |
| `src/utils/trading/tradeLogPath.ts:1` | `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts:1` | R076 Git 定位，非等价证明；G6 |
| `src/utils/types.ts:1` | `src/utils/time/types.ts:1`<br>`src/utils/numeric/types.ts:1`<br>`src/types/rateLimit.ts:1` | 拆分/移除 owner 定位候选，待符号级核查；G6 |

## 附录 C：机器核对结果

- 固定基线 `6e239c8a128372bd9b2fb2d79464346792a5e81e`；固定 HEAD `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。
- develop 263/263：同路径 50，Git rename 162，人工拆分/移除 51。
- current 368/368：唯一主责均已匹配，未匹配 0、重叠 0。
- 94 个 current 文件没有上述直接旧文件配对：已全部列入附录 A，不得漏审；不等于真实新增业务数。
- 所有映射目标存在性已对固定 HEAD tracked 树核验；账本完整不代表行为等价已通过。
- 本附录生成仅写本报告，没有写入仓库源、测试、配置或计划。
