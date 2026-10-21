# G4：订单执行、跟踪与恢复业务等价性证据报告

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

## summary

- **verdict：不能判定订单全生命周期与 develop 业务等价。** 首审自查已复现实时剩余 BUY 丢失、closed-order 合法重放导致 fatal、cancel/replace 通用外部拒绝被升级 fatal 三项候选；末日不撤旧 SELL 的差分经对 validation 的独立二审确认。封存边界前同量修订也存在可达的权威事实／durable／刷新行为变化，但不能扩大为“重新计入日损或重复完成 episode”。
- **scope：**分组地图 G4 的 63 个 current 生产文件；按下文账本区分链路深读、语义 diff 核对和局部契约阅读，另追踪必要的 adapter、风险、startup、末日及持久化消费者。不声称逐字全读或全部 368 文件审完。
- **confidence：**具体复现场景 high；整个订单全生命周期的穷尽等价结论 medium，未深入边界见后文。
- **固定版本：**current/beta-V2 `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop/origin/develop/FETCH_HEAD `6e239c8a128372bd9b2fb2d79464346792a5e81e`。报告中的 current/develop 行号均针对这两个版本，不以活动分支名字代替版本证据。
- **只读约束：**没有改源码、测试、配置、架构方案，没有 checkout/reset，没有连接实盘或自行启动子代理。自定义验证均为 `bun --no-env-file -e` 内存运行；仅写本报告。验证代理已生成的 TEMP baseline 快照只作只读导入，已核对所用关键模块字节与固定 develop `git show` 一致。
- **审查约束：**已加载 lazy-senior-developer、code-review、typescript-project-specifications、core-program-business-logic，另加载 context-mode。业务真值取旧生产实现；新测试、新注释、business skill 不充当需求授权。
- **模型说明：**本会话启动配置曾核对为 `cliproxyapi / gpt-6.1-sol / thinking max`（本地 PID/session 配置证据）；这不是后端实际路由的可验证证明。本报告不伪称已验证代理服务端模型。

### 状态口径

- **首审候选／自查已复现：**本代理完成生产链路及反证自查，尚待另一独立代理复核，不称最终已确认缺陷。
- **独立二审 confirmed：**针对 validation 原候选重新读取两版生产代码并独立运行对照；确认范围必须明确。confirmed 行为差分不等于一切潜在财务后果均已发生。
- **rejected：**给出推翻原主张的具体证据；**not-assessed：**现有证据不足，不提升为问题。

## critical issues

### OE-001｜首审候选，自查已复现，待独立二审：实时 SELL 重算套用历史时间区间，丢弃同毫秒未卖出的 BUY

- **位置：**current `src/domain/order/executionProjection.ts:122-164,213-225`，`src/domain/order/orderFilteringEngine.ts:90-100,119-123`；入口 `src/application/orderTracking/recorder/index.ts:48-111`。
- **claim：**旧在线扣减针对当时已有 BUY 列表整笔扣减；当前每次在线事实更新重跑历史过滤，BUY 时间等于 SELL 的记录不在任何严格区间中，可能把仍真实持有的 BUY 从成本与智能平仓账本删除。
- **develop 证据：**`src/core/trader/orderMonitor/settlementFlow.ts:636-658` → `src/core/orderRecorder/index.ts:263-283` → `src/core/orderRecorder/orderStorage.ts:168-231`。旧 `updateAfterSell` 用现有列表、显式关联 ID 或低价优先整笔扣减，不因为 BUY 与 SELL 同毫秒而排除剩余 BUY。旧历史重建 `src/core/orderRecorder/orderFilteringEngine.ts` **本来就有**严格时间分区，本项不是把该历史边界冒充新增；回归是将其扩散到旧在线路径。
- **最小触发：**依次接收 B1 BUY100@1，T+100；B2 BUY100@2，T+200；S SELL100@1.5，T+200，都是正常 Filled、同一 BULL.HK、无保护性标记、SELL 关联集合为空。broker `updatedAt` 毫秒相同即可，无需人为构造非法的 executionTime/revision 组合。
- **完整真实链路：**离线 SDK push → `orderMapper.mapBrokerOrderPush` → `orderMonitor.handleOrderPush` → `eventFlow` → `settlementFlow.commitExecution` → recorder `commitExecutionFact` → `projectRecords/projectSlices` → `applyFilteringAlgorithm`。后者 `BUY.time < SELL.time` 与 `BUY.time > SELL.time` 都不包含 B2。下游 `src/domain/risk/unrealizedLossChecker.ts:18-35` 直接取该成本；`src/application/ordinarySell/quantitySelection.ts:137-182,242-249` 以该成本和 BUY 列表选单；`src/application/ordinaryBuy/riskChecks.ts:274-283` 消费浮亏预筛。
- **对照结果（同一输入）：**develop 真实 Monitor+Recorder 保留 `LOCAL_1791338400200_2`，100 股@2，fatal=[]；current 真实 Monitor+Recorder 返回 BUY=[]、cost=null。额外调用真实风险与智能平仓：risk `{r1:"0",n1:0}`，`shouldLiquidate:false`；实际剩余100股、现价3时 smartClose `shouldHold:true,quantity:null`。两次链路均没有实际 broker mutation。
- **impact：confirmed（复现场景的账本与消费者错误）；potential（实盘风险）——**实际剩余成本与数量被清零，浮亏保护可能失效、普通智能平仓可能拒卖。没有声称 broker 持仓本身被删除。
- **minimal fix：**在共同经济投影 owner 保留在线已消费 BUY 的全序／身份，等时 BUY 不得无声遗漏。不要简单把所有历史 `<` 改为 `<=`，那会改变旧恢复分区、重复扣减边界；应分别证明在线输入与历史重建所需的消费顺序，保留整笔低价优先和累计 SELL 一次扣减语义。
- **validation：**附录 A1 可直接运行当前最小账本 repro；本次还通过两版真实 Monitor 统一输入验证。回归测试应同时断言剩余 BUY、cost、risk R1/N1 与 smartClose，不只测单一过滤函数。
- **现有测试缺口：**`tests/integration/accountPositionConsistency/orderEconomicCoverage.test.ts:104-177` 覆盖累计 SELL 整单扣减及重放，但 BUY/SELL 时间严格递增；没有上述在线等时且仍剩 BUY 的端到端断言。历史过滤已有严格边界测试不能证明在线语义保持。
- **dimensions：**implementation、project/spec、tests、comments。当前“同毫秒 BUY 不进入任何区间”的注释描述了实现，不能证明旧在线需求授权。

## major issues

### OE-002｜首审候选，自查已复现，待独立二审：closed-order revision 新入口把合法重复／乱序推送升级为全局 fatal

- **位置：**current `src/application/orderTracking/orderMonitor/eventFlow.ts:98-119,128-170`；`src/domain/order/executionFact.ts:103-107`；fatal owner `src/application/orderTracking/orderMonitor/index.ts:582-608`、`src/runtime/lifecycle/terminationRuntime.ts:31-58`。
- **claim：**`2b67d36` 允许关闭 tracking 的已有事实继续接收 revision，但未保持 tracked 路径对弱观察与普通缺价终态的收口协议。
- **develop 证据：**`src/core/trader/orderMonitor/eventFlow.ts:94-105` 无 tracked 直接 return。旧不会重新向 daily/经济 merge 提交晚到的 closed-order OPEN 或重复缺价终态。
- **最小场景 A：**普通 BUY Filled(100@1,T+100)，tracking 已关闭；随后同 revision、同量同价 PartialFilled。current 首次 fatal=false，第二次 fatal=true。新 closed 分支只过滤 OPEN→OPEN 弱观察，TERMINAL→OPEN 被共享 merge 抛错。
- **最小场景 B：**普通 BUY PartialFilled(100@1,T+100) → 同量 Filled 缺价/零价 → 完全重复同一缺价 Filled。current 三步 fatal=[false,false,true]。第一条缺价终态在 tracked 路径按既有完整经济证据关资源；重复进入 closed 分支，却被 `eventFlow.ts:108-119` 的完整价格校验拒绝。`orderMapper.ts:90-105` 明确把正量零价投影为缺价，且普通 TERMINAL 是允许到业务 merge 的输入，并非 decoder 非法样本。
- **runtime path：**SDK producer → 真实 push adapter/mapper → Monitor decoder → `eventFlow` closed 分支 → 抛错 → `handleOrderPush` catch → `termination.reportFatalError` → 同步关闭交易与 producer 准入、正常 cleanup。此路径不依赖 route mutation 或新订单。
- **impact：confirmed——**本次离线真实 Monitor 复现了正常重复／乱序消息触发 fatal，成本保留100但交易运行被停止；未声称重复成交或 broker 仓位错误。可导致其他订单保护性跟进停止，后者为潜在后果。
- **minimal fix：**在 closed lifecycle 边界先辨别不能重新打开资源的旧／弱观察，以及已由 known 完整经济事实吸收的普通资源终态重复；合法更高 revision／金额修订仍走共同事实 owner。不要无条件忽略所有 closed 推送，否则会撤销 `2b67d36` 的合法 revision 修复。
- **validation：**附录 A2 使用真实 Monitor 运行 A/B；还应断言无 fatal、无二次 terminal/hold 关闭、无重复经济消费，并保留现有 closed revision 正向用例。
- **测试缺口：**`tests/integration/closedOrderRevisionWatermark.integration.test.ts` 覆盖 closed 更高 revision；`tests/application/orderTracking/orderMonitor/eventFlow.business.test.ts:1390-1439` 的 no-reopen 场景保留 tracked timeout owner，不能覆盖已 detach 的分支；`terminalNativeEvidence.test.ts` 的共享缺价 merge 测试没有再重复一次完整 Monitor 推送。
- **dimensions：**implementation、type design（phase 与 lifecycle 不是同一不变量）、tests、project/spec。

## 已授权业务变更（非问题）

### OE-003／validation V-C4／B01｜已授权：末日保留旧SELL，仅新增available

- **位置：**current `src/application/orderExecution/submitFlow.ts:575-605`；develop `src/core/trader/orderExecutor/submitFlow.ts:600-678`。
- **claim：**末日专用提交路径从“撤全部旧 SELL → 等权威终态 → 重读可卖量 → 提交”改成“保留旧 SELL → 直接读当前 available → 仅提交 available”。这是业务协议变化，不是 port 替换。
- **真实上游／下游：**系统末日 workflow → `executeDoomsdayClearanceSignals` → dedicated command → `submitDoomsdayClearanceSell`。current 在 availability guard 后直接读取，旧 pending SELL 不再 cancel/replace；accepted 新单正常注册 monitor。原 pending SELL 的目的、价格与数量由原跟踪继续维持，不能等同末日已重建覆盖。
- **旧证据：**develop `submitFlow.ts:606-608` 获取全部 pending SELL，`:627-651` cancel 并在 ACK 后返回 WAITING_FOR_AUTHORITATIVE_TERMINAL，`:610-619` 使重复调用继续等待，`:662-678` 仅在旧单离开 pending 后重读并提交。ACK 不是终态。
- **最小统一输入：**15:56 HK、BULL.HK、旧普通 ELO SELL100/未成交，撤单返回 CANCEL_CONFIRMED；分别 available=0 与 available=40。
- **本次独立高层 executor 对照：**

  | 输入 | develop | current |
  |---|---|---|
  | available=0 | cancel=1，positions read=0，submit=0，awaitingAuthoritativeTerminalSymbols=[BULL.HK] | cancel=0，positions read=1，submit=0，reevaluationSymbols=[] |
  | available=40 | 同上，等待旧单终态 | cancel=0，positions read=1，立刻提交40股 ELO、现价1.9；旧SELL不变 |

- **impact：confirmed（撤旧/终态等待/新增量协议差分）；potential（交易后果）——**被旧限价单占用的数量不再由末日主动撤回、按新价格重新覆盖。旧单离收盘很近、正常跟踪尚未到重报价／超时时点时可能留仓。本次没有连接实盘，不能写成“已发生漏平仓”；可用量不包含旧卖单占用，故也不能错误宣称这必然超卖。
- **处置：**用户已授权保留旧SELL、仅新增available，不恢复旧撤单／terminal-wait策略，不列为缺陷或验收阻塞；保留当前数量读取、P1 permit、最终报价、protective身份和accepted后tracking约束。
- **validation：**附录 A3 为无需网络的两版直接 submitFlow 对照；本次还运行了真实高层 executor + current 原生 port producer 的 available0/40 对照。该差分作为已授权变更证据保留，不作为恢复旧策略的验收要求。
- **测试 oracle 证据：**develop `tests/integration/doomsday.integration.test.ts:377-525` 要求 cancel、terminal 前不读仓不下单；current 同文件`:462-546` 反向要求不 cancel/replace。current `tests/application/orderExecution/finalQuoteMutationPermit.business.test.ts:913-969` 明确保留旧单、cancel/detail 均为0。两版各自测试通过不证明等价。
- **dimensions：**implementation、project/spec、tests、comments。current `submitFlow.ts:575-577` 的注释与新实现相符，但不是旧行为允许变化的证据。
- **最终状态：**validation 原候选V-C4与OE-003合并为B01；行为差分已经独立确认，用户已明确授权，非问题。

## 其他行为差分与major候选（保留原审计状态）

### OE-004／validation V-C1｜独立二审 confirmed（行为差分；缺陷归类待授权裁决）：封存前同量修订不再受准入抑制，新增 durable、权威水位与刷新

- **位置：**current `src/domain/risk/dailyLossTracker.ts:882-951`、`src/application/orderTracking/orderMonitor/settlementFlow.ts:78-112,151-205`、`src/application/orderTracking/orderMonitor/eventFlow.ts:98-205`。develop `src/core/riskController/dailyLossTracker.ts:969-994` 尤其`:974-977`。
- **claim：**旧 merge 后 `lastExecutionTimeMs <= completedBoundary` 会在 durable callback 与 filledOrderFacts 发布前 false/false 返回；当前没有该 suppression，仍 ADMITTED／发布修订。用户指定旧实现为真值时，这是应显式裁决的状态及失败策略差分，不能只因新测试写了 ADMITTED 就视为授权。
- **独立真实闭单链路：**两版真实 Monitor+Recorder+Daily；先 protective SELL100@0.45、Filled、T，落盘并关闭；以 T 提交 protection boundary、restoreCompletedBoundary；再推同单同量0.46、revision=T+30000，remark 必须使用真实 `QuantDemo|PL`。两版都不发 broker mutation。
- **本次观测：**

  | 项目 | develop：修订前→后 | current：修订前→后 |
  |---|---|---|
  | durable progress 次数 | 1→1 | 1→2 |
  | settlement refresh 次数 | 1→1 | 1→2 |
  | SELL 记录金额 | 45→45（旧记录price=0.45） | 45→46 |
  | hold closed 次数 | 1→1 | 1→1 |
  | DailyLoss | 0→0 | "0"→"0" |
  | in-progress episode／pending | []／[] | []／[] |

- **额外失败路径：**仅让第二次 progress persistence 抛 `AUDIT_DISK_UNAVAILABLE`，current 经真实 Monitor fatal=true，O 保持45、刷新不增加；develop closed event 根本不再进入落盘，不会触发这次持久化失败。此为新增可达的失败点，不把模拟故障写为已发生磁盘事故。
- **重要反证／避免误报：**不能声称“develop settleOrder 收到边界前终态后 O/H/S 全部不更新”。旧 `settlementFlow.ts:636-658` 先本地 BUY／SELL 记账，`:660-687` 后调用 Daily，并在 authoritativeFactChanged=false 时主动补刷新，最终还会关 H/terminal。故首次 tracked terminal 的本地 SELL、占用释放与 refresh，旧版也会更新。这里确认的 closed-order 晚修订与 durable 差分，不能泛化到所有结算。
- **没有确认的后果：**current `dailyLossTracker.ts:191-202` 仍按 protectionBoundary 排除旧经济段；`settlementFlow.ts:115-148` 不会因 closed revision 凭空重建已完成 episode；startup `loadTradingDayRuntimeSnapshot.ts:644-677` 也过滤 completed boundary 之前 progress，且不把相同累计量当未恢复的新成交。**未证明重新计损、重复冷却、重复买卖扣减或重开 H。**
- **impact：confirmed——**权威事实、落盘、刷新和异常触发范围确实改变；potential——新增磁盘失败可停止运行。财政损害、重启后错误余额尚未证实，不能升为 critical。
- **授权反证必须并列：**方案`docs/architecture/architecture-refactoring-implementation-plan.md:828`确有“累计量合法推进或同量高revision金额/时间/阶段修订仍更新同一订单”以及“tracking关闭也不屏蔽事实准入/合法修正”；同段又要求“持久化与错误语义保持”。因此一般closed合法修订可能属于`:33`列明的事实一致性修复，**不能仅因旧版无tracked时忽略就自动判缺陷**。本项独立确认的是进一步移除**completedBoundary之前**的Daily准入抑制及新增durable失败点；上述一般条款是否明确覆盖这项封存策略，需主代理基于原授权裁决。major栏表示需裁决的等价性差分，不冒称授权已被最终否定。
- **minimal fix／授权裁决：**若目标严格保持旧封存准入，须在共同 Daily admission owner、durable callback 之前恢复 boundary suppression，并使 recorder 遵从 SUPPRESSED；不能只拦某个 WS caller，也不能丢掉边界之后真实增量。若主代理确认上述事实一致性例外已授权“封存只抑制经济，不抑制权威／durable”，应将本项归为受控行为差异而非缺陷，保留差分与新增失败点。当前新增注释与反向测试本身不足以完成该授权证明。
- **validation：**附录 A2 的 sealed-success/sealed-write-failure；validation 原 TEMP `behavior-probe.test.ts` 第一用例只证明 Daily 局部，不替代这里的实际 Monitor 验证。旧首次终态路径另以源码顺序排除误报。
- **测试缺口／oracle：**`2b67d36` 修改 `tests/domain/risk/dailyLossExecutionBoundary.test.ts:20-52`、`tests/application/orderTracking/recorder/executionFactBoundary.business.test.ts:121-154` 与 `tests/application/orderTracking/orderMonitor/settlementFlow.business.test.ts:759-913`。新版断言支持新行为，不能充当旧 suppression 已获授权的证据。
- **dimensions：**implementation、project/spec、tests、comments。
- **二审状态：validation V-C1 confirmed（行为及失败路径差分）；其“重计日损／重开 episode”扩展主张 rejected；重启后财务损害 not-assessed。**

### OE-005（原调查号OE-X1）｜首审候选，自查补证已复现，待独立二审：cancel/replace 通用非重试外部拒绝被套用 submit UNKNOWN 的 fatal 策略

- **位置：**current `src/infrastructure/longbridge/trade/mutationErrorClassification.ts:139-190`，`src/application/orderTracking/orderMonitor/orderOps.ts:299-324`（`:306` UNKNOWN直接throw）；`src/application/orderTracking/orderMonitor/routeProcessor.ts:960-963` → `routeRuntime.ts:161-172`。
- **claim：**未命中特殊业务码／外部暂态的真实cancel/replace请求失败，由旧明确失败结果变为throw UNKNOWN；route owner随后fatal。该变化不是仅把旧SDK错误投影为中性标签，而是错误处置范围扩张。
- **develop：**`src/core/trader/orderMonitor/orderOps.ts:502-519`一般cancel失败返回`UNKNOWN_FAILURE`；`:799-801`一般replace失败返回`NOT_EXECUTED`并更新时间／日志。`src/infrastructure/externalApi/index.ts`旧对应实现对403非重试错误原样抛给上述旧owner，没有先包装为耗尽暂态错误。
- **触发：**真实broker mutation依赖拒绝`Object.assign(new Error("HTTP 403 permission denied"),{status:403})`，非TypeError/内部错误、不含臆造六位broker业务码。两版同一请求事实、有效授权、attached订单。该输入属于现有外部HTTP状态分类边界；未声称某特定未文档化业务码能由cancel返回。
- **独立补证：**真实旧orderOps + current原生tradeMutationAdapter producer，对同一cause：cancel旧`UNKNOWN_FAILURE/errorCode:null`，新抛`TradeMutationUnknownError`、`requestAttempted:true`、operation为cancel、cause身份保留；replace旧`NOT_EXECUTED`，新同样throw，均仅发出一次本地mock请求、无额外query。
- **完整route实测：**两版真实Monitor、ELO SELL100@1、关闭SELL timeout、priceUpdateInterval=1秒、推进本地时钟60秒并发quote1.1。旧replaceRequests=1、fatal=[]，route正常排空；current真实adapter→orderOps→routeProcessor→routeRuntime，fatal=true，原始错误为`TradeMutationUnknownError: ...TradeContext.replaceOrder: HTTP 403 permission denied`，stop/drain重新暴露同一错误。未连接broker。
- **impact：confirmed（失败策略及全局停止差分）；potential（交易后果）——**一次局部订单的非重试外部拒绝现在会停止整个交易与其他订单跟进，而不是保留旧订单等待后续事实／下一次跟价。没有声称此HTTP故障已在生产发生。
- **spec：**`docs/architecture/architecture-refactoring-implementation-plan.md:35`明确submit UNKNOWN策略且“不改变cancel/replace既有ACK、终态确认、602013与WAIT_WS_ONLY协议”；至少不能未经裁决把该submit策略扩散成所有mutation UNKNOWN统一fatal。
- **minimal fix：**按operation恢复旧cancel/replace一般外部失败的owner结果与后续策略，不把这些错误套入submit UNKNOWN；仍保留程序错误原样fatal、有限暂态重试、closed权威查询、602012/602013状态机和ACK/terminal分离。修共享根因，不在各workflow逐个catch吞错。
- **validation：**附录A4给出两版orderOps完整同输入探针；本次另完成两版真实Monitor行情驱动replace的fatal对照。应增加adapter→route端到端负向断言，确认不是仅对中性标签的单元测试。
- **现有测试缺口：**`tests/application/orderTracking/orderMonitor/orderOps.business.test.ts:2689-2790`直接注入中性UNKNOWN并要求fatal，不证明旧SDK失败策略等价；现有602012/602013和retry测试只保护特殊类别，未覆盖此旧一般失败的oracle。
- **dimensions：**implementation、project/spec、tests。
- **状态校正：**早期因没有可确认输出／未证明码可达而保持OE-X1；现在已重新取得完整同输入与真实route结果，升为自查已复现候选，但仍需独立二审，不称终审缺陷。

## minor issues

None. 不为凑数把新分层、文件长度、纯转发或类型别名机械列为缺陷。

## validation 原候选独立二审专节

| validation 原 ID | 结论 | 独立证据／限定 |
|---|---|---|
| V-C1 | **confirmed（行为差分）；是否缺陷需授权裁决** | 真实旧／新 Monitor 相同 protective closed revision：durable 1→1 对1→2、refresh1→1对1→2；新第二次持久化故障会 fatal。方案`:828`一般closed合法修订条款为明确反证，封存准入是否在例外内不能由新测试倒推。详情 OE-004。 |
| V-C1：develop 本地 O/H 完全不动的扩大解释 | **rejected** | 旧 settleOrder 首次 terminal 在 Daily 返回之前先写本地 O，false结果仍补 S，最终关H；不能从 Daily false 推导本地不变。 |
| V-C1：重新入损／重复 episode／重启财务错误 | **rejected／not-assessed** | 实测 Daily两版均0、H只关一次、episode仍空；startup过滤旧进度，未证实财务损害；不以局部候选替代完整后果。 |
| V-C4／B01 | **已授权业务变更，非问题** | 真实 dedicated executor 相同 available0/40 与旧 SELL：旧 cancel并等待，新不cancel、直接读取／提交available。详情 OE-003。 |
| V-C4：accepted 后不再清 O 的单独缺陷 | **rejected（以现有证据不足立项）** | 当前真实 fill 经 recorder 经济提交再刷新；accepted 只证明委托接受，不证明已成交。canonical owner 下保留 O／positions 至权威事实到达有合理归属，不能单凭旧立即清缓存判错。尚未覆盖所有 UI/报表时点，不宣称该部分全量等价。 |

二审结果不依赖两版测试全绿。validation 告知 current3288／develop1992 及两版 lint/typecheck 通过，属于该验证代理的结果，不冒称本代理自行重跑了这套全量命令。

## positive findings

1. **broker accepted 后不降级成未提交：**`src/application/orderExecution/tradeMutationErrors.ts` 保留 UNKNOWN 的 operation/requestAttempted/code/cause，并为 accepted 本地同步失败保留 orderId；submitFlow 注册失败不会自动重提。
2. **timeout 占用连续：**`src/application/orderTracking/orderMonitor/routeProcessor.ts:348-368,402-535`：先由 settlement 保留旧 pending placeholder；permit前失效／未发出失败释放；发出后 UNKNOWN 保留并fatal；ACK后记录 continuation、track新单、登记新pending后再释放旧placeholder。不能以“不是 cash reservation”误判该防重账不存在。
3. **旧路由 continuation 不能继续修改新 owner：**route generation、tracked对象身份、symbol bucket 三重检查；replace terminal 优先于timeout/reprice；单次route最多一个broker mutation。已读实际route/routeRuntime/routingIndex，不只读注释。
4. **普通 BUY 双读取排空：**`src/application/ordinaryBuy/accountPositionsRead.ts` 启动账户／持仓两个请求、内部异常当下上报、等待两个请求落定、内部错误优先保留原 rejection，不发布半个 canonical snapshot。
5. **恢复编排不是重复下单入口：**`src/application/orderTracking/orderMonitor/recoveryFlow.ts` 校验归属、submitted时间与数量，重建pending关联、合并bootstrap缓冲，再激活route；不匹配BUY使用既有撤单/终态确认，SELL保留原目的与数量证据。未发现可在无broker事实下凭恢复API自动重提的已确认回归。
6. **共享卖单 protective 身份隔离为已声明受控修复：**不把静态新增量偷记为旧 protective progress；普通合法replace、旧真实progress与episode仍须保留。未仅以“新旧有差异”把该明确列出的修复报成回归。
7. **跨市场与数量修复有实际生产证据：**account mapper允许非港股小数；`sellPositionReadAdapter`只对目标symbol原始文本做安全整数证明；`quantityResolver`只验证目标持仓；末日先滤HK。以下历史复查不把它们误报为问题。

## 七维审查结论

| 维度 | 实际检查及结论 |
|---|---|
| Implementation | 已追consumer→普通用例→授权/提交→monitor→WS/query→结算/累计事实→超时占用交接→恢复；OE-001/002/003与V-C1为具体行为证据，未用复杂度作为缺陷理由。 |
| Project and Spec | 固定旧SHA为oracle；方案`docs/architecture/architecture-refactoring-implementation-plan.md:33-37`列明例外，`:35`特别限定submit UNKNOWN而非cancel/replace。新注释／测试不能反推授权；V-C1授权边界须主代理显式裁决。 |
| Type Design | 阅读执行purpose、authorization闭包、mutation结果联合、累计fact、phase、terminal snapshot、pending/hold与route状态契约。closed lifecycle与phase不是同一个状态，OE-002展示强运行时校验放错入口的后果。未机械建议复杂品牌化或把一切校验移到类型层；大型types仅局部读，见覆盖账本。 |
| Tests | 运行订单相关现有739项和额外33项；对等时BUY/SELL、closed缺价重复、末日旧SELL、封存前修订做负向离线probe。反向oracle已列明；不以通过率声称全量等价。 |
| Comments | 核对current过滤同毫秒说明、closed“不重结算资源”、末日“既有SELL不变”、边界“只封存经济”注释与真实行为；事实描述准确不代表需求授权。没有把解释why的注释当冗余。 |
| Dead Code | 搜索工厂返回、消费者及生产/测试边界；`convertedToMarket`只见false写和多处读，但develop同样如此，不能当新增回归或直接建议删除。外部注册／类型导出未穷尽，按C级放未评估；不输出无证据dead-code finding。 |
| Simplification | 确认route generation、accepted continuation、同步durable callback各有实际安全职责，不因分层多判过度设计。recorder重建内纯`projectionChanged`返回未消费是可简化调查点，但仅凭局部未证明异常语义/不变量可保持，不列发现、不建议直接删。 |

## 历史修复复查及已排除项

- **`d2aa590`：**读取相关执行／结算／席位diff，并追普通关联买单总量精确校验、每attempt授权、timeout占用接力。没有把单文件diff通过当作整个提交已闭合；席位状态机和post-trade唯一completion事务不属本组全深读，交对应组复核。
- **`2b67d36`：**复查native价格/金额证据、closed revision入口、executionNormalization、账户数量／目标市场过滤。OE-002说明closed revision修复尚有重放边界问题；V-C1说明同提交修改了旧封存准入oracle。
- **历史归因校正：**develop原本已有`executionTime <= revision`判断，旧两时间均源自订单updatedAt。重构引入独立execution时间使旧假设可能失效，不能写成该判断是新加。`2b67d36`相关根因同时包括execution驱动启动、全局数量整数化、市场范围失控，不只归因一个条件。
- **测试补证：**`bun test tests/infrastructure/longbridge/trade/accountMapper.test.ts tests/infrastructure/longbridge/trade/mixedAccountSnapshotScope.business.test.ts tests/infrastructure/longbridge/trade/orderDetailReadAdapter.test.ts tests/infrastructure/longbridge/trade/orderFactMapper.test.ts tests/infrastructure/longbridge/trade/pendingOrdersAdapter.test.ts tests/integration/architectureRefactoringP1Native/trade/terminalNativeEvidence.test.ts`：exit0，33 pass/0 fail，6 files，90ms。仅证明所运行场景。
- **无cash reservation账不是新增回归：**旧实现没有独立现金预占账。本次实际检查BUY实时account/positions、频率及授权、SELL pending关联、hold、timeout handoff；不能凭current没新建现金reservation系统报错。
- **同时间过滤的历史已有部分：**旧历史重建严格时间过滤仍归基线已有边界；OE-001只针对已由旧在线列表保留的BUY。
- **V-C2/V-C3局部内部契约差分：**executionTime/revision独立输入或内部0成本，不经原SDK来源与真实消费者验证前不提升为订单缺陷。本组未把它们作为确认项。

## not assessed

1. **完整post-trade completion/cooldown恢复：**已追V-C1所需Daily冻结、episode不重开、progress恢复过滤与O/S影响；未逐分支穷尽`src/application/postTradeSettlement/**`、`src/domain/liquidation/episode/**`及cooldown全部策略，主责G5。
2. **完整持久化仓储故障矩阵：**读了progress callback真实装配、启动load/归一/history校验、仓储append/fsync/close/lock的相关片段；没有对所有文件损坏、并发篡改、磁盘错误实际落盘实验，不声称全验证。
3. **broker外部业务码完整集合：**未取得broker服务端全部错误码及响应协议；不主张已穷尽。原OE-X1已用非臆造业务码的HTTP403边界补齐实际adapter/route对照，移至OE-005自查候选；历史602014探针不作为定案证据。
4. **席位全状态机／风险全域：**读取了成本／sell-operation直接消费者和routeValidation；没有穷尽所有席位switch/cooldown/warrant/cache/UI路径。
5. **生产网络及SDK服务端时序：**全部离线；没有实际cancel、replace、submit、持仓查询或native TradeContext连接，不对broker的未文档化响应作保证。
6. **类型与dead-code穷尽：**大型types只审与当前链路相关部分；未对全部外部动态消费作A类无用证明。无独立lint/typecheck运行归属本代理的证据，引用validation的结果必须标明来源。

## G4 主责63文件分级覆盖账本

**分级定义：**D=围绕真实业务链路深读并与旧对应实现比较，含关键正常/异常分支，不等于逐字符穷尽；E=主要做迁移/语义diff与调用消费者核对，不宣称模块全行为已证等价；P=局部契约或选段阅读，不能当完整审计；U=未深入。长输出曾截断的部分不因发起读取而算全文覆盖。

| # | current生产文件 | 级别 | 实际分析焦点／旧对应 |
|---:|---|:---:|---|
|1|`src/application/orderExecution/buyThrottle.ts`|E|频率记录、冷却；旧orderExecutor同名|
|2|`src/application/orderExecution/index.ts`|D|purpose、caller授权、executeSignals、末日专用入口；旧orderExecutor|
|3|`src/application/orderExecution/quantityResolver.ts`|D|目标HK持仓、安全数量、限流后重校验；旧orderExecutor|
|4|`src/application/orderExecution/rateLimiter.ts`|D|mutation permit生命周期、限流；旧core/trader/rateLimiter|
|5|`src/application/orderExecution/submitFailureLogging.ts`|E|拒绝与UNKNOWN日志边界、消费者|
|6|`src/application/orderExecution/submitFlow.ts`|D|普通/保护/末日提交、合并、关联、cancel等待、accepted本地同步|
|7|`src/application/orderExecution/tradeMutationErrors.ts`|E|UNKNOWN与accepted错误原身份/订单ID保存|
|8|`src/application/orderExecution/types.ts`|P|purpose/authorization/submit结果与deps；未全文证明|
|9|`src/application/orderTracking/orderCacheManager.ts`|D|pending读取、cache失效与submit/monitor真实调用|
|10|`src/application/orderTracking/orderHoldRegistry.ts`|D|seed/track/terminal关闭、symbol hold|
|11|`src/application/orderTracking/orderMonitor/eventFlow.ts`|D|WS状态、重复乱序、缺价终态、closed新revision|
|12|`src/application/orderTracking/orderMonitor/index.ts`|D|monitor装配/订阅/恢复、fatal、stop/drain、continuation|
|13|`src/application/orderTracking/orderMonitor/orderObservation.ts`|E|经济/terminal观察通知、幂等边界|
|14|`src/application/orderTracking/orderMonitor/orderOps.ts`|D|cancel/replace授权、重试、602012/602013/WAIT_WS_ONLY、query facts|
|15|`src/application/orderTracking/orderMonitor/orderStatusQuery.ts`|D|权威detail映射、终态与QUERY_FAILED、保护性原始证据|
|16|`src/application/orderTracking/orderMonitor/recoveryFlow.ts`|D|bootstrap缓冲、snapshot归属、pending关联、不匹配BUY关闭|
|17|`src/application/orderTracking/orderMonitor/routeProcessor.ts`|D|timeout优先、cancel终态、follow-up MO占用连续、ACK后continuation|
|18|`src/application/orderTracking/orderMonitor/routeRuntime.ts`|D|symbol generation、调度、旧await continuation、stop/drain|
|19|`src/application/orderTracking/orderMonitor/routingIndex.ts`|E|attach/detach、bucket/timer、generation重置；旧同名diff|
|20|`src/application/orderTracking/orderMonitor/settlementFlow.ts`|D|O/Daily/durable顺序、partial/terminal、H/S与episode|
|21|`src/application/orderTracking/orderMonitor/types.ts`|P|tracked/runtime/route/terminal与deps相关字段，未全类型审查|
|22|`src/application/orderTracking/recorder/index.ts`|D|事实准入、projection、rebuild/clear、刷新、去重|
|23|`src/application/orderTracking/recorder/orderApiManager.ts`|D|history/today快照读取及归一交界；旧record API manager逻辑|
|24|`src/application/orderTracking/recorder/orderStorage.ts`|D|BUY/SELL投影存储、pending占用、整笔选单、getCostBasis|
|25|`src/application/orderTracking/recorder/types.ts`|P|factory/storage/deps与边界签名|
|26|`src/application/orderTracking/tradeAudit/index.ts`|E|成交审计订阅、调用及异常边界；未全日志格式审计|
|27|`src/application/orderTracking/tradeAudit/types.ts`|P|审计输入/依赖窄契约|
|28|`src/application/orderTracking/types.ts`|P|OrderMonitor/hold/cache及runtime装配相关契约|
|29|`src/application/ordinaryBuy/accountPositionsRead.ts`|D|双请求启动/排空、内错优先；旧utils/accountPositions|
|30|`src/application/ordinaryBuy/index.ts`|D|普通BUY入口、授权与风险管线；旧signalProcessor|
|31|`src/application/ordinaryBuy/riskChecks.ts`|D|轻检查顺序、实时account/positions、unrealized预筛；旧riskCheckPipeline|
|32|`src/application/ordinaryBuy/types.ts`|P|普通BUY依赖和输出，未全跨域类型消费|
|33|`src/application/ordinarySell/index.ts`|D|普通SELL入口、持仓与执行授权；旧signalProcessor|
|34|`src/application/ordinarySell/quantityResolver.ts`|D|可卖量/普通智能平仓选择接口；旧sellQuantityCalculator|
|35|`src/application/ordinarySell/quantitySelection.ts`|D|全仓/总体盈利/盈利单/超时单、占用排除|
|36|`src/application/ordinarySell/types.ts`|P|SELL输入及依赖窄契约|
|37|`src/domain/order/cancelOutcomePolicy.ts`|E|ACK与权威终态区分、真实末日/席位消费者；旧trader/utils等|
|38|`src/domain/order/executionFact.ts`|D|累计量/金额/T/revision/phase、旧事实兼容及closed入口|
|39|`src/domain/order/executionPolicy.ts`|E|action/orderType、跨日、protective判定；旧executor/utils|
|40|`src/domain/order/executionProjection.ts`|D|完整消费输入、slice、clear与SELL整单投影|
|41|`src/domain/order/orderAnalysis.ts`|E|daily分析组合依赖与真实Daily消费者；旧core/utils|
|42|`src/domain/order/orderFactMerge.ts`|D|tracked观察、弱OPEN、普通缺价资源终态、保护性完整事实|
|43|`src/domain/order/orderFilteringEngine.ts`|D|历史时间分区／整笔扣减与新在线消费；旧同名对照|
|44|`src/domain/order/orderOwnership.ts`|D|monitor/direction/symbol归属及startup/push/最新标的消费者|
|45|`src/domain/order/orderQuantity.ts`|E|整手与安全整数出口、精确总量；旧orderRecorder/utils|
|46|`src/domain/order/orderReadLifecycle.ts`|E|open/terminal与priority，旧orderStatusLifecycle|
|47|`src/domain/order/orderRecordPolicy.ts`|D|API分类、原始经济证据、盈利/超时选单与pending状态|
|48|`src/domain/order/orderRemark.ts`|E|真实`|PL`provenance与submit/恢复消费者|
|49|`src/domain/order/orderSnapshotPolicy.ts`|E|snapshot分类/读状态规则；旧orderStatusLifecycle|
|50|`src/domain/order/orderTimeoutPolicy.ts`|D|cancel backoff、timeout terminal、remaining数量与优先级|
|51|`src/domain/order/orderTrackingPolicy.ts`|E|配置秒转毫秒、关闭原因、price差值/归一；旧lifecycle|
|52|`src/domain/order/orderTypePolicy.ts`|E|交易类型选择、protective与普通配置；旧trader/utils|
|53|`src/domain/order/quoteReadiness.ts`|E|必要报价、缺失/无效类型；普通/末日真实消费者|
|54|`src/domain/order/sellDeductionPolicy.ts`|D|低价优先整笔、关联精确扣减与develop在线对照|
|55|`src/domain/order/sellMergePolicy.ts`|D|合单REPLACE/CANCEL_AND_SUBMIT、protective身份隔离|
|56|`src/domain/order/smartClose.ts`|E|精确整体盈利、剩余量与阶段总量；旧signalProcessor/utils|
|57|`src/domain/order/types.ts`|P|fact/known/ownership/timeout/command相关类型，未全文穷尽|
|58|`src/runtime/asyncProgram/buyProcessor/index.ts`|D|BUY queue消费、异步门禁、错误fatal与用例调用；旧main同名|
|59|`src/runtime/asyncProgram/buyProcessor/types.ts`|P|worker窄依赖|
|60|`src/runtime/asyncProgram/sellProcessor/index.ts`|D|SELL queue消费、异步门禁、错误fatal与用例调用；旧main同名|
|61|`src/runtime/asyncProgram/sellProcessor/types.ts`|P|worker窄依赖|
|62|`src/runtime/orderTradeAuditListener/index.ts`|E|同步审计异常fatal再原样重抛、unsubscribe身份|
|63|`src/runtime/orderTradeAuditListener/types.ts`|P|listener行为契约|

主责清单 **63/63 已归档，无遗漏；D=34、E=18、P=11、U=0**（从报告表格机器计数，并与分组地图逐条核对，无缺漏、无重复）。**P级不是已完成全模块等价证明**；不能由63行误写成63个文件均已全文深读。

### 为闭合证据而实际读取的其他生产文件（不计入63主责）

- 装配／consumer：`src/app/runtime/createTradeRuntime.ts`（D）；`src/app/runtime/createPostGateRuntime.ts`（P，progress persistence实际注入）；`src/runtime/asyncProgram/processor.ts`、`src/runtime/asyncProgram/tradeTaskQueue/index.ts`（D）。
- adapter（D，主要入站/错误边界）：`src/infrastructure/longbridge/trade/orderPushAdapter.ts`、`orderMapper.ts`、`tradeMutationAdapter.ts`、`mutationErrorClassification.ts`、`orderSnapshotReadAdapter.ts`、`orderDetailReadAdapter.ts`、`orderValidation.ts`、`pendingOrdersAdapter.ts`；`accountMapper.ts`、`sellPositionReadAdapter.ts`（E/D，金融量及市场范围）。
- 风险／末日／生命周期：`src/domain/risk/unrealizedLossChecker.ts`（D）；`src/domain/risk/dailyLossTracker.ts`（P/D，累计merge、封存、恢复、baseline而非所有分支）；`src/application/protectiveLiquidation/unrealizedLossExecutor.ts`（D）；`src/application/doomsdayClearance/index.ts`（P/D，HK过滤、提交与accepted/重评估）；`src/runtime/tradingRiskEventRuntime/routeValidation.ts`（P）；`src/runtime/lifecycle/terminationRuntime.ts`（D）；`src/runtime/lifecycle/cacheDomains/orderDomain.ts`（D）。
- 重建／持久化／席位：`src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts`（P，progress/completion/known归一/episode恢复关键段）；`rebuildTradingDayState.ts`（P，snapshot/seat token、O/R1N1/recover顺序）；`executionNormalization.ts`（D）；`src/infrastructure/persistence/mixedTradeLogRepository/index.ts`（P，append/fingerprint/同步IO与progress接口相关段）；`src/application/seatSwitch/switchStateMachine.ts`（P，仅sell-operation/cost直接消费者）；`signalBuilder.ts`（P）。
- 公共契约／IO错误：`src/types/orderRecorder.ts`、`src/types/tradeMutationPorts.ts`（P/D）；`src/utils/apiFailure/index.ts`（P）；`src/infrastructure/externalApi/index.ts`（D）。
- develop实际对照：`src/core/trader/orderMonitor/{index,eventFlow,settlementFlow,recoveryFlow,orderOps,orderStatusQuery,routeProcessor,routeRuntime,routingIndex}.ts`，`src/core/trader/orderExecutor/{index,submitFlow,quantityResolver,buyThrottle,types,utils}.ts`，`src/core/orderRecorder/{index,orderStorage,sellDeductionPolicy,orderFilteringEngine,utils,orderOwnershipParser}.ts`，`src/core/riskController/dailyLossTracker.ts`，`src/main/asyncProgram/{buyProcessor,sellProcessor}/index.ts`及分组地图对应的拆分来源（部分为diff/选段，不统一声称全文）。
- **明确不计覆盖：**读取不存在的`src/domain/risk/unrealizedLossBuyGate.ts`、`tests/application/orderExecution/submitFlowFixture.ts`以及develop不存在的`src/main/asyncProgram/processor.ts`均失败；失败调用不是已读证据。

## 验证记录

1. 本代理运行订单相关离线套件：

```text
bun test tests/application/orderExecution tests/application/orderTracking tests/domain/order tests/runtime/asyncProgram/buyProcessor tests/runtime/asyncProgram/sellProcessor tests/integration/closedOrderRevisionWatermark.integration.test.ts tests/integration/sellFlow.integration.test.ts tests/integration/buyFlow.integration.test.ts tests/integration/accountPositionConsistency/orderEconomicCoverage.test.ts tests/integration/architectureRefactoringP1Native/trade/terminalNativeEvidence.test.ts
```

结果：exit0，739 tests / 52 files / 3465 expect calls，约7.11s。并非全量测试。

2. 额外市场／金融边界33项：见历史复查命令，exit0。
3. 自定义内存probe：统一输入develop/current实时BUY/SELL；current两组closed replay；develop/current protective closed revision及current第二次落盘故障；develop/current末日available0/40。可见结果均已重新取得，未把旧截断输出当成功证据。探针曾因旧episode模块路径错误失败一次，修正到`src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`后才采纳结果；错误remark首次试验也被替换为真实`buildOrderRemark(true)`后重新运行。
4. TEMP baseline导入校验：所用旧monitor/index、eventFlow、submitFlow、dailyLossTracker、orderStorage与固定SHA逐字相等；避免只依据TEMP目录名推定基线版本。
5. 报告落盘后自动从附录抽取A1/A2/A3代码，分别以 `bun --no-env-file -e` 再执行，三个命令均exit0；A2取得两个fatal原始错误分别为`fact stage regression: TERMINAL -> OPEN`及`已有broker事实的新观察缺少完整价格依据`。sealed-success与sealed-write-failure也输出预述差分，避免仅给未运行伪代码。补入A4后再次抽取执行，exit0，cancel/replace均复现旧返回结果而新throw UNKNOWN。
6. 最近工作区核对：HEAD/develop为上述固定SHA，报告落盘及附录重跑后`git status --short`仍为空。未执行lint:fix（只读任务禁止改文件）。validation提供的全量结果仅列来源，不替代本报告负向证据。

## 附录 A：可运行的离线最小验证

所有命令在 `D:/Code/HSI-Strategy-Trading` 执行；不创建脚本文件、不构造真实TradeContext、不读取交易凭证。使用PowerShell时建议把`bun --no-env-file -e`代码放入here-string参数；下面用通用单引号展示。A2较长但复用真实生产Monitor而非模拟其业务逻辑。

### A1：OE-001 当前最小投影重现

```sh
bun --no-env-file -e '
import { createExecutionFixture } from "./tests/application/orderTracking/recorder/executionFixture.ts";
const f = createExecutionFixture();
for (const [id, side, p, a, t] of [["B1","BUY","1","100",100],["B2","BUY","2","200",200],["S","SELL","1.5","150",200]])
  f.commit(id, side, p, a, 100, 1791338400000 + t, "BULL.HK");
console.log(f.recorder.getBuyOrdersForSymbol("BULL.HK", true), f.recorder.getCostBasis("BULL.HK", true));
await f.sink.stopAndDrain();
'
```

当前输出`[] null`；旧在线正确保留100股@2。旧真实Monitor对照的原始结果已在OE-001记录；可用固定TEMP baseline中的真实旧Monitor同样发三个native Filled复验，而不是拿旧历史filter当在线oracle。

### A2：真实 Monitor 的 closed replay 与封存修订

```sh
bun --no-env-file -e '
import { createBrokerIngressFixture } from "./tests/integration/architectureRefactoringP1Native/trade/brokerIngressFixture.ts";
import { createExecutionFixture } from "./tests/application/orderTracking/recorder/executionFixture.ts";
import { createDiagnosticObserverDouble } from "./tests/helpers/diagnostics.ts";
import { createLoggerDouble, createMarketDataClientDouble, createSymbolRegistryDouble } from "./tests/helpers/testDoubles.ts";
import { createTradingConfig } from "./mock/factories/configFactory.ts";
import { wrapExternalApiRequest } from "./src/infrastructure/externalApi/index.ts";
import { scheduleBoundedOneShotAt } from "./src/runtime/timer/index.ts";
import { buildOrderRemark } from "./src/domain/order/orderRemark.ts";
const T = Date.parse("2026-10-07T02:00:00Z");
for (const mode of ["openReplay", "missingPriceDuplicate", "sealed-success", "sealed-write-failure"]) {
  const protective = mode.startsWith("sealed");
  const base = { orderId:"AUDIT",symbol:"BULL.HK",stockName:"HSI RC",remark:protective?buildOrderRemark(true):"",side:protective?"SELL":"BUY",orderType:"ELO",status:"Filled",quantity:"100",executedQuantity:"100",submittedPrice:protective?"0.45":"1",executedPrice:protective?"0.45":"1",submittedAtMs:T-1000,updatedAtMs:T };
  const io=await createBrokerIngressFixture(base), f=createExecutionFixture({nowMs:T});
  let writes=0,refresh=0,closed=0,failWrite=false;
  const sink={recordSettlementRefreshNeed:p=>{refresh++;return f.sink.recordSettlementRefreshNeed(p)}};
  const rec=io.createRecorder({rateLimiter:f.rateLimiter,settlementRefreshNeedRecorder:sink});
  const m=io.createMonitor({diagnostics:createDiagnosticObserverDouble(),logger:createLoggerDouble(),wait:async()=>{},requestExternalApi:wrapExternalApiRequest,scheduleBoundedOneShotAt,rateLimiter:f.rateLimiter,cacheManager:{clearCache(){},getPendingOrders:async()=>[]},marketDataClient:createMarketDataClientDouble(),orderRecorder:rec,dailyLossTracker:f.daily,orderHoldRegistry:{...f.holds,markOrderClosed:id=>{closed++;f.holds.markOrderClosed(id)}},protectiveLiquidationEpisodeTracker:f.episode,persistProtectiveLiquidationExecutionProgress(){if(failWrite)throw Error("AUDIT_DISK_UNAVAILABLE");writes++},postTradeConsistencyRuntime:sink,tradingConfig:createTradingConfig(),symbolRegistry:createSymbolRegistryDouble(),isContinuousTradingAllowed:()=>false,termination:f.termination,now:()=>new Date(T),scheduleTimer:setTimeout,clearTimer:clearTimeout});
  await m.initialize(); await m.recoverOrderTrackingFromSnapshot([]);
  m.trackOrder({orderId:base.orderId,symbol:base.symbol,side:base.side,executionSide:base.side,orderType:"ELO",price:base.submittedPrice,initialSubmittedPrice:base.submittedPrice,quantity:100,isLongSymbol:true,monitorSymbol:"HSI.HK",isProtectiveLiquidation:protective});
  if(protective)rec.submitSellOrder(base.orderId,base.symbol,"LONG",100,[],T);
  const fatal=[]; const emit=p=>{io.emitOrderChangedFrame({...base,...p});fatal.push(f.termination.getFatalState().hasFatalError)};
  if(mode==="openReplay") {emit({});emit({status:"PartialFilled"})}
  else if(mode==="missingPriceDuplicate") {emit({status:"PartialFilled"});emit({executedPrice:"0"});emit({executedPrice:"0"})}
  else {emit({});f.daily.commitProtectionBoundary(f.daily.prepareProtectionBoundary({direction:"LONG",boundaryExecutedTimeMs:T}));f.episode.restoreCompletedBoundary({direction:"LONG",boundaryExecutedTimeMs:T});failWrite=mode==="sealed-write-failure";emit({executedPrice:"0.46",updatedAtMs:T+30000})}
  const state=f.termination.getFatalState();
  console.log(JSON.stringify({mode,fatal,error:state.hasFatalError?String(state.error):null,writes,refresh,closed,sell:rec.getSellRecordByOrderId(base.orderId),loss:f.daily.getLossOffset("LONG"),episode:f.episode.getInProgressEpisodes()}));
  await m.stopRuntimeAndDrain();await m.teardown();await f.sink.stopAndDrain();
}
'
```

当前关键预期：openReplay=`[false,true]`；missingPriceDuplicate=`[false,false,true]`；sealed-success写2次/刷新2次/H只关1次/日损0/episode空；sealed-write-failure第二次fatal且旧经济记录不半发布。该命令不把模拟磁盘错误算作真实生产事故。

### A3：V-C4 两版 dedicated submitFlow 统一输入（available=0）

依赖验证代理已只读展开的固定baseline快照；相关文件已与SHA核对。此探针不发任何submit，旧cancel仅为本地依赖函数。

```sh
bun --no-env-file -e '
import {createSubmitTargetOrder as current} from "./src/application/orderExecution/submitFlow.ts";
import {createTradingConfig} from "./mock/factories/configFactory.ts";
import {createRateLimiterDouble,createLoggerDouble} from "./tests/helpers/testDoubles.ts";
import {OrderSide} from "longbridge";
const {createSubmitTargetOrder:old}=await import("C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/validation/develop-baseline/src/core/trader/orderExecutor/submitFlow.ts");
const cfg=createTradingConfig(),signal={symbol:"BULL.HK",action:"SELLCALL",triggerTimeMs:Date.parse("2026-07-10T07:56:00Z"),reason:"audit"};
for(const [name,factory] of [["develop",old],["current",current]]) {
 let cancel=0,read=0;
 const run=factory({logger:createLoggerDouble(),rateLimiter:createRateLimiterDouble(),cacheManager:{clearCache(){}},orderMonitor:{getPendingSellOrders:()=>[{orderId:"OLD"}],captureSellAvailabilityGuard:()=>()=>true,cancelOrder:async()=>{cancel++;return {kind:"CANCEL_CONFIRMED"}}},orderRecorder:{},globalConfig:cfg.global,monitorConfig:cfg.monitor,ctx:{stockPositions:async()=>{read++;return {channels:[]}}},readSellPositions:async()=>{read++;return []},tradeMutationPort:{},marketDataClient:{},unrealizedLossBuyGate:{},canExecuteSignal:()=>true,canTradeNow:()=>true,recordBuyAttempt(){},now:()=>new Date(signal.triggerTimeMs)});
 const result=await run({signal,side:name==="develop"?OrderSide.Sell:"SELL",executionPurpose:"DOOMSDAY_CLEARANCE",isLongSymbol:true,isShortSymbol:false,monitorSymbol:"HSI.HK"},()=>true);
 console.log(JSON.stringify({name,cancel,read,result}));
}
'
```

实测exit0：develop cancel1/read0/WAITING_FOR_AUTHORITATIVE_TERMINAL；current cancel0/read1/SKIPPED。

### A4：OE-005 两版真实 orderOps＋current native adapter 同一HTTP403拒绝

```sh
bun --no-env-file -e '
import {createBrokerIngressFixture} from "./tests/integration/architectureRefactoringP1Native/trade/brokerIngressFixture.ts";
import {createDiagnosticObserverDouble} from "./tests/helpers/diagnostics.ts";
import {createLoggerDouble,createOrderRecorderDouble,createRateLimiterDouble} from "./tests/helpers/testDoubles.ts";
import {createTradingConfig} from "./mock/factories/configFactory.ts";
import {createOrderHoldRegistry} from "./src/application/orderTracking/orderHoldRegistry.ts";
import {OrderSide,OrderType} from "longbridge";
const O="C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/validation/develop-baseline/";
const {createOrderOps:oldOps}=await import(O+"src/core/trader/orderMonitor/orderOps.ts"),h=await import(O+"tests/helpers/testDoubles.ts"),c=await import(O+"mock/factories/configFactory.ts");
const runtime=()=>({trackedOrders:new Map(),trackedOrderLifecycles:new Map(),bootstrappingOrderEvents:new Map(),closedOrderIds:new Set(),queriedTerminalStateByOrderId:new Map(),latestReplaceTerminalByOrderId:new Map(),orderStateChangedListeners:new Set(),trackedOrderIdsBySymbol:new Map(),routeStatesBySymbol:new Map(),latestRouteGenerationBySymbol:new Map(),runtimeState:"ACTIVE",running:false,unsubscribeQuoteUpdated:null});
const T=Date.parse("2026-10-07T02:00:00Z");
for(const operation of ["cancel","replace"]){
 const cause=Object.assign(new Error("HTTP 403 permission denied"),{status:403});let count=0;
 const old=oldOps({termination:{isTerminated:()=>false,reportFatalError(){}},now:()=>new Date(T),runtime:runtime(),monitorConfig:c.createTradingConfig().monitor,ctx:{cancelOrder:async()=>{count++;throw cause},replaceOrder:async()=>{count++;throw cause}},rateLimiter:h.createRateLimiterDouble(),cacheManager:{clearCache(){}},orderHoldRegistry:{trackOrder(){},markOrderClosed(){}},orderRecorder:h.createOrderRecorderDouble(),recordCumulativeExecution(){},orderStatusQuery:{checkOrderState:async()=>{throw Error("unexpected query")}},triggerRoute(){}});
 old.trackOrder({orderId:"O",symbol:"BULL.HK",side:OrderSide.Buy,orderType:OrderType.ELO,price:1,initialSubmittedPrice:1,quantity:100,isLongSymbol:true,monitorSymbol:"HSI.HK",isProtectiveLiquidation:false});
 let oldResult;try{oldResult=operation==="cancel"?await old.cancelOrder("O",{kind:"ORDER_FACT"}):await old.replaceOrderPrice("O",1.1,{kind:"ORDER_FACT"})}catch(e){oldResult={error:String(e)}};
 const io=await createBrokerIngressFixture({orderId:"O",symbol:"BULL.HK",stockName:"BULL",remark:"",side:"BUY",orderType:"ELO",status:"New",quantity:"100",executedQuantity:"0",submittedPrice:"1",executedPrice:"0",submittedAtMs:T-1000,updatedAtMs:T});io.setCancelFailure(cause);io.failReplace(cause);
 const cur=io.createOperations({diagnostics:createDiagnosticObserverDouble(),captureWorkGuard:()=>()=>true,logger:createLoggerDouble(),wait:async()=>{},termination:{isTerminated:()=>false,reportFatalError(){}},now:()=>new Date(T),runtime:runtime(),monitorConfig:createTradingConfig().monitor,rateLimiter:createRateLimiterDouble(),cacheManager:{clearCache(){}},orderHoldRegistry:createOrderHoldRegistry(),orderRecorder:createOrderRecorderDouble(),recordCumulativeExecution(){},triggerRoute(){}});
 cur.trackOrder({orderId:"O",symbol:"BULL.HK",side:"BUY",executionSide:"BUY",orderType:"ELO",price:"1",initialSubmittedPrice:"1",quantity:100,isLongSymbol:true,monitorSymbol:"HSI.HK",isProtectiveLiquidation:false});
 let newResult;try{newResult=operation==="cancel"?await cur.cancelOrder("O",{kind:"ORDER_FACT"}):await cur.replaceOrderPrice("O","1.1",{kind:"ORDER_FACT"})}catch(e){newResult={error:String(e),requestAttempted:e.requestAttempted,operation:e.operation,causePreserved:e.cause===cause}};
 console.log(JSON.stringify({operation,oldResult,oldRequests:count,newResult,nativeCalls:io.nativeReadCounts()}));
}
'
```

此A4只验证共享orderOps协议，完整Monitor行情驱动fatal结果已记OE-005；不能把直接catch错误的probe谎称已触发全局termination。

## recommended next actions

1. 将OE-001、OE-002、OE-005及本报告的最小probe交另一独立代理复核；不得把“自查已复现”省略为所有候选已终审。
2. V-C4与G5末日审查已归并为B01，按用户明确授权保留当前策略，不作为问题处理；V-C1按已证实的durable/权威/刷新及失败边界差分裁决授权，剔除重计日损／重开H等未成立后果。
3. 将已补齐同一HTTP403请求失败、真实adapter/route证据的OE-005一并交独立二审；不得再引用早期被截断的602014探针作定案依据。
4. 按P级账本与not-assessed边界补审post-trade/episode/seat/持久化及动态消费；测试全绿不能覆盖这些分析缺口。
5. 修复获确认的共享根因时保留合法revision、累计SELL整单扣减、cancel ACK/terminal区分、protective身份隔离、timeout占用连续与accepted不可重提不变量。仅报告建议，本轮未修改任何代码。
