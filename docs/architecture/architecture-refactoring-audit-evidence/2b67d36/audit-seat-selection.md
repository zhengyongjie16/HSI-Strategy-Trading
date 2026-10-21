# G3 席位寻标轮换：只读业务等价性审计证据

## summary

- **verdict：不能据现有全绿测试声明与 develop 业务全量等价。** 本组自查复现了三个需要独立复核/授权裁决的候选：普通旧卖单合并及回补预算改变（G3-C1）、距离换标由可恢复决策转为一次性卖出及余仓 fatal（G3-C2）、全账户订单先经济归一使无关港股订单阻断激活（G3-C3）。目前不把尚未完成独立二审的候选称为最终缺陷。
- **独立二审 V-C6：已确认 oracle 差分不只是改注入。** fresh flat 的成功分支合理；但在真实账户 adapter 返回 positive 100、旧标价格为 0 的同类输入下，当前改为 fatal + 保留 OLD/SWITCHING，develop 为 FAILED/INVALID_QUOTE:SELL_OUT + EMPTY。保留真实持仓归属更安全，不等于全局终止策略已获授权，也不等于旧负向集成保护已经保留。见专节。
- **scope：G3 清单 34 个当前生产文件，以及证明其席位、行情订阅、交易授权、订单结算、激活、启动和午夜恢复链所需的直接依赖片段。** 文件级深度见覆盖矩阵；未声称把 G0/G4/G5 的整组实现全部深读。
- **confidence：行为差分 high；是否被另行业务授权 medium。** 本报告按源码和已执行的离线探针确认差分，不以重构文档/当前测试反向定义 develop 旧业务。

### 固定版本、只读边界

| 项目 | 固定值 |
| --- | --- |
| 当前 beta-V2 HEAD | `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144` |
| develop / origin/develop / FETCH_HEAD | `6e239c8a128372bd9b2fb2d79464346792a5e81e` |
| 仓库 | `D:/Code/HSI-Strategy-Trading` |
| 对照映射 | `C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-baseline-map.md` 的 G3 段（348–385 行） |

审计前及本轮复核末再次查询上述 SHA 相同，`git status --short` 为空。没有 checkout/reset，没有改仓库源码、测试、配置或方案，没有连接交易服务、启动实盘或打开交易门禁。探针通过 `bun run -` stdin、内存转译及 data URL 执行；没有写探针脚本。唯一交付写入为本 Markdown。加载了 AGENTS、code-review、TypeScript 规范、业务知识、context-mode、lazy-senior-developer；业务结论仍以固定 develop 的真实源码为真值。指定模型模板在当前界面不可核实，不作已核实声明。

## critical issues

**未提交已确认 critical 缺陷。** 下述三个候选已完成本组自查，但 G3-C1/C2/C3 仍请主代理安排独立复核。V-C6 已按其他验证代理的请求完成独立二审；它与 G3-C2 共用根因，不另重复计数。

## major issues（自查候选；不是待定事项已变成最终缺陷）

### G3-C1 — 普通旧 SELL 被隔离为独立操作，改变 broker 副作用及回补资金范围

- **状态：自查复现差分，待独立复核；建议 major。** 不是把跨 protective 扩量修正误报成回归；反例限定旧单和新增单都为普通、非 protective、同类型 ELO。
- **claim：** 距离换标以前可以把旧普通 SELL 余量与新可卖量合成同一 REPLACE，现在特意绕过普通合并，保留旧单另发新单；回补只认新单/其真实后继的金额。因此同一旧仓、旧单、成交价格下，回补数量发生可观测变化。
- **当前证据：**
  - `src/application/seatSwitch/signalBuilder.ts:38–57` 保留 `executionOrigin`。
  - `src/application/seatSwitch/switchStateMachine.ts:1040–1050` 构造 `SWITCH_MOVE` 卖出。
  - `src/application/orderExecution/submitFlow.ts:643–665`：`SWITCH_MOVE` 分支直接 `readFreshAvailableSellQuantity` 后 submit；注释明确“不撤、不改、不合并”。
  - `src/domain/seat/types.ts:156–174` 把预算 owner 定义为本次独立 ACK；`src/application/seatSwitch/switchStateMachine.ts:1191–1205` 和 REBUY 的 `:1379–1403` 只累计 `state.sellOrderId` 的 `getSellOperationOrderIds()` 成交金额。
  - 当前集成 `tests/integration/distanceSwitchIndependentSell.integration.test.ts:382–423` 断言旧 60 不变、新 SELL 40、cancel/replace 为零、最后 BUY 80。
- **develop 证据（均为固定旧 SHA）：**
  - `src/services/autoSymbolManager/switchStateMachine.ts:966–974` 产生普通 ELO SELL，quantity 为 available，没有当前的独立 origin 绕行。
  - `src/core/trader/orderExecutor/quantityResolver.ts:238–273` 新鲜 available 40 与 signal 40 得到 40。
  - `src/core/trader/orderExecutor/submitFlow.ts:708–734` 读取 pending SELL，交 `resolveSellMergeDecision`；`:747–820` 在 permit 内复核决策并调用 `replaceOrderPriceWithPermit(..., mergedQuantity)`；`:822–833` 返回 REPLACED/旧 orderId。
  - `src/core/trader/utils.ts:160–229` 在允许合并时使用 `pendingRemainingQuantity + newOrderQuantity`。
  - `src/core/trader/orderExecutor/index.ts:488–490` 把 REPLACED 的旧 ID 放入 executedOrderIds。
  - `src/services/autoSymbolManager/switchStateMachine.ts:1008–1014` 保存这个 ID；`:1035–1046` 用该 ID 的完整已成交记录决定 `sellNotional`；`:1215–1229` 按此预算回补。
- **最小场景：** 旧仓 100、旧普通 ELO SELL 未成 60，broker available 40；旧单没有 protective 身份，relatedBuyOrderIds 为 null，改单门禁/permit 都有效；下一标整手为 1。develop 合并为旧 SELL 100；当前保留旧 60，另发 40。两笔/合并单都按 2 成交、下一标价格为 1 时，旧路径预算 200、买 200；当前预算仅新 40×2=80、买 80。当前集成 fixture 的成交价默认值见同测试 `:322–345`，不是“旧单单独清空”的模糊反例。
- **真实链路：** monitor quote → 距离预检/预寻标 → 发布 SWITCHING + WAIT → switch wakeup → CANCEL_PENDING（仅撤旧 BUY）→ SELL_OUT → 普通执行器 → 旧版 merge/REPLACE 或当前独立 submit → 原订单 owner 结算 → 权威核仓 flat → BIND_NEW → WAIT_QUOTE/REBUY → ACTIVATING → activation dispatcher。
- **impact：confirmed（离线输入和源码上的行为差分），potential（实盘后果）。** 会改变 native mutation 次数、旧单优先级/价格、归属记录和回补规模；例中少回补 120 股。未声称有实盘损失或超卖。
- **根因修复方向：** 先裁决是否正式授权“旧单由原 owner 保持独立、只回补本次增量”。若要求旧业务等价，应让合法非 protective 合并路径继续可用，并保持实际经济操作范围一致；不能靠给旧单金额无条件相加，因为旧单也可能是独立策略退出。继续保留跨 protective 扩量隔离、真实 MO 后继和原票授权，不是删除新安全检查。
- **validation：** 附录 B1 的真实 develop helper 得到 `REPLACE/100/OLD`；当前真实 integration 在本组 398 项测试中通过并断言独立 SELL40/BUY80。还应把完全相同普通 ELO、related=null 输入送两版完整 submit/settlement/REBUY fixture，断言 native mutation 及 BUY 量，不能只分别跑两版各自 oracle。
- **测试缺口：** 新集成明确固化不同语义，不构成等价性证明；缺少固定 develop oracle 下同输入的完整 native 对照。
- **自查排除：** 不使用 protective 旧单、不使用无 available、不使用旧单自行全平等可能与基线相同的分支；精度升级不是这 200 对 80 的原因。
- **dimensions：** implementation、project/spec、types（新增 origin/预算身份表达了新政策）、tests、comments（注释准确描述新实现，但不能充当旧业务授权）。

### G3-C2 — 距离卖出决策被一次性关闭，旧操作释放余量/明确拒绝/无效报价转为余仓 fatal

- **状态：自查复现；V-C6 的“positive + invalid quote”子场景已由本组独立二审；其他子场景待独立复核。建议 major，不将所有安全改进直接定性为逻辑错误。**
- **claim：** 当前以 `sellSubmissionResolved` 把旧操作带余量完成、首次明确拒绝/零可卖、报价无效/耗尽都合并为“不再允许卖出”；随后真实余仓大于零统一 throw。基线在首次尚未成功发单时可继续卖出/走原重试分支，报价无效则按业务失败清席位。失败协议及自动恢复能力改变，且不仅仅是 snapshot 读取更权威。
- **当前证据：**
  - `src/application/seatSwitch/switchStateMachine.ts:235–248` 根据 sellWait/入场后新生 SELL 的 `SETTLED_WITH_REMAINDER` 判余量；`:904–916` 立即关闭本轮新增决定。
  - `:961–979` `finishWithoutNewSell()` 将报价失败改为 resolved，保留旧标核仓；`:1013–1021` 将 invalid quote 送入此分支；`:1079–1085` REJECTED / NO_AVAILABLE_QUANTITY 同样关闭决定。
  - `:1117–1173` 等待原操作、核对 guard，再真实读取持仓及 pending；`:1186–1189` positive 总量抛“禁止补卖或绑定新标，等待人工处理”。
  - `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:668–676` 将这个普通 Error 交 `termination.reportFatalError`。
  - `src/runtime/lifecycle/terminationRuntime.ts:31–60` 锁存终止并同步关闭 gate/producer，不只是一次换标失败。
- **develop 证据：**
  - `src/services/autoSymbolManager/switchStateMachine.ts:884–901` total>0/available0 等；首次 `sellSubmitted=false` 且 available>0 可进入 SELL。
  - `:941–957` 无效报价 `failAndClear('INVALID_QUOTE:SELL_OUT')`；`:981–1001` 无 executedOrderId 进入既有 quote/retry timer 与重试计数分支，而不是当前首次明确拒绝后的余仓 fatal。旧`:964`在有效报价后重置计数，本报告不声称连续明确拒绝的总重试次数已被证明有界。
  - `:1008–1014` 仅有真实 ID 才记 sellSubmitted。旧版本“本次自己已有 ACK、后来取消带余量”也可能继续 WAIT；本报告不把这种旧已有停滞误说成新取消缺陷。
- **最小场景 1（旧操作释放）：** switch 已入 SELL_OUT、自己尚未发单，旧 SELL 在入场/等待窗口零成交取消，完成结算释放 100 可卖量。当前记旧 operation 为 SETTLED_WITH_REMAINDER 后不提交任何新 SELL，核仓 100 后 fatal；develop 以 sellSubmitted=false/available100 提交 SELL100。
- **最小场景 2（首次明确拒绝）：** 无旧 pending，持仓/available100，第一次提交返回明确拒绝、无 ACK。develop 返回 WAIT/RETRY_TIMER，retries=1、sellSubmitted=false；当前将 resolved=true，核仓 100 后 fatal。**此处不是 submit UNKNOWN**；方案授权的 UNKNOWN fatal 不适用。
- **最小场景 3（V-C6）：** 无旧 SELL、报价 0、权威仓位 100。develop FAILED/EMPTY；当前不发单、保留 OLD/SWITCHING，但通过 runtime fatal 终止。完整独立复核见后节。
- **真实链路：** 原 dayEpoch/seatVersion 的 SWITCHING owner → advancePendingSwitch → 原订单 operation 状态/首次 executor 决策 → 一次性 resolved → readSwitchPositions + force pending → residual Error → switch wakeup fatal → 顶层关闭全局交易和生产者。不是只有测试直接调用 throw 的假链路。
- **impact：confirmed（离线状态迁移和 V-C6 runtime fatal），potential（交易影响）。** 正常可解释的拒绝、旧单取消释放及坏报价会从等待/局部失败升级到全局停止；其他方向及后续保护动作也会被关闭。当前保留 positive 旧标归属确比直接 EMPTY 更安全，必须保留这一优点，不能为了复现基线而不安全地清席位。
- **根因修复方向：** 区分“已发 ACK、不可确认 UNKNOWN、明确未发、旧操作结束但本轮仍未发”四种事实，不能用一个 resolved 位统一冻结所有重试机会。对真实余仓保留 owner；明确未发时保持有界重试或采用经业务正式批准的暂停/人工协议。只有审定为内部不变量破坏时才用全局 fatal。不要去掉 final authoritative position/guard 检查，也不要简单恢复正仓 EMPTY。
- **validation：** 附录 B2 在同一 stdin 中加载真实 develop 状态机与当前工厂，复现“释放”及“明确拒绝”；端口状态为合成，但两版生产分支是真实执行，不复制状态算法。附录 C 把原 runtime 集成在内存改接真实 account adapter，独立复现 positive/flat 两种输入与 fatal/no mutation。
- **测试缺口：** `tests/integration/distanceSwitchIndependentSell.integration.test.ts:448–470,522–523` 验证新 fatal 语义，只能证明当前行为自洽。其 `:909–930` 是 flat 成功，不替代 positive+invalid 负向 runtime 测试；当前原 terminal finalization 也已改 flat（详 V-C6）。
- **自查排除：** 未把 base 自己已 ACK 后无法补卖误报为新增；区分明确拒绝和 UNKNOWN；确认 final positions 是真实 fresh positive 而非仅旧 canonical positive；未主张 positive 应直接改绑新标。
- **dimensions：** implementation、project/spec（失败规则/副作用协议）、types（resolved 合并不同业务事实）、tests、comments。

### G3-C3 — 先归一所有账户订单，未归属且无关的港股手工订单也可 fatal 阻断激活/恢复

- **状态：自查复现，待独立复核；建议 major。** 与 2b67d36 已修的“非港股市场范围不受控”不是同一个反例：本例是明确 HK、SDK 结构合法、但不属于本系统/本席位的订单。
- **claim：** 全量 `apiOrders.map(normalizeExecutionOrder)` 在席位相关范围/方向/ownership 过滤之前执行，要求所有账户港股正成交订单都有金额。adapter 却明确允许普通终态正成交缺价，保留 amount=null。一个无关手工 HK 单可因此把自动换标的激活送入不可恢复 fatal；旧实现会先按标的/ownership/有效成交范围消费，不被该单阻断。
- **当前证据：**
  - `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:132–153` 只按 HK scope 过滤；`:95–114` 接受 nullable executedPrice；随后 mapSnapshotOrder。
  - `src/infrastructure/longbridge/trade/orderMapper.ts:62–75,90–112` 明确允许普通终态正成交缺价，返回 executedAmount=null，不伪造金额。
  - `src/application/orderTracking/recorder/orderApiManager.ts:7–12` 合并历史/今日全量订单；`fetchAllOrdersFromAPI` 不按系统 ownership 过滤。
  - `src/application/seatActivation/index.ts:326–332` 先全量归一；`:334–361` 才收集 relatedTradingSymbols/方向并按相关 symbol 消费。
  - `src/application/tradingDayRebuild/executionNormalization.ts:45–48` null 原始金额直接 throw；`src/application/seatActivation/index.ts:563–565` 的激活调用方仅识别 external error，内部 Error 原样抛出。
  - `src/runtime/asyncProgram/monitorTaskProcessor/index.ts:66–88,102–108` SEAT_REFRESH 调 activate，队列错误进 fatal；queueRunner `:60–67` 停止调度再转发；termination 同 G3-C2。
  - 兄弟路径 `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:441,491–493` 对 rawOrders 全量归一，说明共同范围问题也到启动/开盘读入。此报告深读的是激活链，未声称完成整个 G4 恢复端到端复现。
- **develop 证据：**
  - `src/core/orderRecorder/orderApiManager.ts:104–127,148–165` 允许 nullable executedPrice 原样进入 RawOrder。
  - `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:318–352` 获取 raw orders，然后只为 related symbols 预检/刷新。
  - `src/core/orderRecorder/index.ts:128–145` 先 `filter(order.symbol===symbol)` 再分类预检。
  - `src/core/riskController/dailyLossTracker.ts:578–582,648–664` 无有效成交价/量先跳过，随后无 ownership 且不相关的单跳过。
- **最小场景：** 激活 `BULL.HK`，related 包括 BULL/BEAR/OLD_BULL；monitor mapping 为 `['HSI']`。全账户快照另有 `MANUAL-HK/00005.HK/HSBC HOLDINGS/BUY/Filled/ELO/qty=executedQty=10/executedPrice=null`，日期和 revision 有效。该单不归属 HSI；真实 mapBrokerOrder 接受并输出 amount=null。真实 activate 在 Daily prepare、O validate/commit 之前抛 `[执行归一] 正成交缺少本次原始金额: MANUAL-HK`，席位仍 ACTIVATING。
- **真实链路：** Broker history/todayOrders → HK scoped adapter → mapBrokerOrder → API manager 去重全量 → activation 的 all map → normalize throw → activate 非 external 不重试 → monitor worker/queue fatal → 全局关闭。启动 sibling 在全量归一同样可被拦，但完整启动 fatal 编排留给 G4/G0。
- **impact：confirmed（adapter接受、ownership=null、真实activate阻断的离线复现），potential（账户数据可达及生产停机）。** 本系统之外的港股手工历史数据扩大为本系统启动/换标可用性的硬前提。没有断言 broker 通常必定返回这种缺价单；可达性以 adapter 明文支持、旧输入契约和构造输入为证。
- **根因修复方向：** 在共享读入消费边界先确定“属于系统经济账/相关席位/待恢复订单”的范围，只对确需消费的订单做完整经济归一。相关标的即使无 ownership 也不能静默跳过，应继续明确拒绝；不要全局把缺金额改成 0、借 known 金额或降低相关订单校验。运行期和启动采用同一范围规则，避免只补一处。
- **validation：** 附录 B3 调真实 mapBrokerOrder + createSeatActivationWorkflow，输出 ownership=null、error=MANUAL-HK、Daily/validate/commit 全零；旧真实 DailyLoss 工厂对相同 nullable 原始订单重算不报错，ownership/convert 调用均为 0、loss=0。旧 recorder 的相关 symbol 过滤经源码对照证明。
- **测试缺口：** `tests/application/seatActivation/executionNormalizationFailure.business.test.ts:21–33,38–104` 仅验证 **相关 BULL.HK** 缺金额必须阻断，正确但不足以覆盖无关账户 HK 单；已有 market-scope 测试不能代替 ownership/席位范围隔离。
- **自查排除：** 不使用已在 adapter 被过滤的美股；不以畸形非 HK symbol 为反例；保持 submittedAt/updatedAt、枚举、数量合法；不主张相关系统成交缺金额应放行。
- **dimensions：** implementation、project/spec、types（OrderFact 允许终态缺金额，消费范围却被当作全账户完整账）、tests。

## V-C6 独立二审专节（validation 原候选 ID）

### 请求与独立方法

请求来源：`validation-peer-review-request.md:37–41`，原 ID **V-C6**。验证代理指出原 invalid SELL_OUT/positive canonical 的负向集成被改成 fresh-flat-success，请判断是否仅合理权威读仓升级，并补 fresh-positive 验证。

本组没有沿用“标题搜索未命中即删测”的推断，执行了以下独立步骤：

1. 读取固定 develop 原集成 `tests/integration/terminalSwitchFinalization.integration.test.ts:181–250` 和当前同文件全链 `:57–364`。
2. 用内存 CommonJS 转译 loader 读取 **固定 develop SHA** 的原测试和其依赖（37 个基线模块），仅替换 bun:test assertion 宿主和 logger，执行真实旧 workflow + monitor/switch runtimes，原三项断言成功。
3. 读取当前原测试文本到内存，用 Bun.Transpiler + data URL 执行；业务生产模块仍导入当前真实实现。只把 `readSwitchPositions: async () => []` 改成 **同 fixture 的真实 account.getStockPositions({symbols:[symbol]})**；捕获 fatal 通道而不真的退出测试进程。没有编辑测试文件。
4. fresh-positive 保留 native stockPositions=100；fresh-flat 在事件发出前把 native fixture 设为空，但 canonical snapshot 保留先前100，专门验证真实 fresh 读比旧缓存更新时的结果。两种都观察 mutation=0。

### 可运行结果

上述 stdin 探针 exit=0。结果：

| 同类输入 | develop 原 runtime 集成 | 当前真实 account adapter + runtime |
| --- | --- | --- |
| OLD qty100/available100，OLD quote=0，fresh positive100 | 返回 `FAILED/INVALID_QUOTE:SELL_OUT`；symbol=null/EMPTY；pending清除 | freshReads=1；fatal一次；`advanceResults=[]`；OLD_BULL/SWITCHING；pending=true；submit/native mutation均0 |
| canonical仍OLD100，fresh adapter已flat，OLD quote=0 | 基线没有这份独立fresh读口，本轮未虚构旧flat结果 | freshReads=1；无fatal；`COMPLETED`；NEW_BULL/ACTIVATING；pending=false；submit/native mutation均0 |

当前 positive 错误原文：

```text
[自动换标] 卖出操作全部结算后仍有旧标持仓，禁止补卖或绑定新标，等待人工处理: monitor=HSI.HK direction=LONG seatVersion=2 old=OLD_BULL.HK next=NEW_BULL.HK quantity=100 operations=[]
```

精确差分根因：`switchStateMachine.ts:961–979,1013–1021` 不再 `failAndClear`，而是 finishWithoutNewSell → final fresh read → `:1186–1189` residual throw。真实 runtime 由 `switchWakeupRuntime.ts:668–676` 将其升级 fatal，不是测试自己人为制造 fatal。

### 二审独立结论

- **确认 V-C6 的 oracle 已换场景。** 当前 `terminalSwitchFinalization...:203` 把 fresh 硬编码为空；`:326–355` 的成功断言不能证明原 positive+invalid 分支等价。原 positive100 输入与当前 fresh positive100 的结果确实不同。
- **fresh-flat 的实现结果是合理改进，不单列“flat 成功”为缺陷。** 新鲜权威持仓为空时，无需再强制卖出；完成换标且不伪造回补预算比使用旧缓存决定卖出更准确。
- **fresh-positive 的 ownership 保护也有明确优点，但失败协议变化仍真实存在。** 旧实现会清空仍有持仓的席位，这是基线的安全缺口；当前保留旧票/旧标并阻止误绑定优于恢复旧 EMPTY。然而从正常业务 FAILED 升级到全局 fatal 是另一项决策，不能由“fresh读更优”自动授权。需与 G3-C2 一并评审并记录批准的失败/重试策略，不能用本报告建议不安全回退。
- **测试保护结论限定：** 已读两个相关集成及状态机业务测试，并对 INVALID_QUOTE/invalid等标题和断言定向检索，未找到同一条真实 monitor→switch runtime 的 fresh-positive+invalid 回归。负面搜索不构成全仓无测试的证明。因此结论是“本组未找到等效负向 runtime 保护”，而不是“仓库绝无此测试”。本轮可运行探针填补审计证据，不是已合入长期回归测试。
- **裁决状态：** V-C6 所指测试差分/当前positive行为 **独立二审确认**；“应当回归旧EMPTY” **明确否决**；是否将全局fatal定为未授权业务缺陷，交主代理结合授权材料裁决。与 G3-C2 去重，不再新增一条同根因问题。

## positive findings

1. **候选规则未因拆层变成三套。** `autoSearch/candidateSearch.ts` 同时供启动补席、运行期空席、换标预寻标；domain/warrantSelection 保持两层严格开区间、API距回收比值×100、主阈值严格在完整安全区间内、距阈值优先再分均成交额。比较使用精确文本/比率，日志投影不反喂排序。HK 候选和席位范围在当前边界校验。
2. **SEARCHING 原 owner 失效有明确收口。** `autoSearch/index.ts` 在候选 await 后重新验证版本/状态/授权；取消保留搜索时间和失败事实并 bump 版本；无阈值在创建 owner 前跳过，不计失败。启动异常复原 EMPTY但不计运行失败；运行无候选/明确外部失败才计数/冻结。没有把 startup 异常当日内失败。
3. **周期替换没有继承距离回补。** `domain/seat/switchPolicy.ts:17–36` 两个具名 policy；`initialSwitchState` 仅 DISTANCE 保留 shouldRebuy；周期以 ACTIVE激活时间累计交易时长、等待现存订单/持仓清空；不能进入 SELL_OUT/REBUY（状态机显式断言）。
4. **已提交 WAIT 不因门禁后闭被丢 owner。** `switchStateMachine.ts:621–686` 在原票有效时发布 SWITCHING、原state及publishedRoute；handoff只证明真实route不授交易许可。switch runtime 对订单/freshness/quote/timer显式唤醒，连续时段或末日接管只暂停；lifecycle/termination才停止收口。周期 runtime 的原baseline、dispatchedCanContinue、blockedOnGate、waitingEmpty避免用新票复活旧任务。
5. **ACK 事实不等于当前业务授权。** switch REBUY 用原state WeakMap保留已发买单ID，拒绝因 await 后授权改变把真实ACK当未发重提；SELL也先保存真实ACK再做后置route检查。没有因简化删掉这些真实安全状态。
6. **激活有真实屏障和错误归属。** retain/admission → execution quotes → O/Daily预检/提交 → paired snapshot → 持仓订阅 → risk → ACTIVE → await retain release；只对明确 external失败一次重试，内部错误不伪装无候选；release不覆盖主体首错。G3-C3质疑的是归一范围，不是否要校验相关经济事实。
7. **退场清理/诊断不会代理业务完成。** cleanup只消费ACTIVE退场/身份变化，清方向信号、策略等待、risk缓存；queueCleanup明确保留SEAT_REFRESH。diagnostic runtime在最早registry mutation前订阅，clock/observer异常隔离，不进行订单/激活/扫描补偿。
8. **午夜失效边界可追踪。** seatDomain先capture仅ACTIVE同symbol的激活基线，reset switch、clear warrant cache、双方向bump并EMPTY；open rebuild在交易关闭下完成事实/风险/订阅，固定paired token和全部captured seat身份再发布ACTIVE。未将旧symbol累计时长带入新symbol。

## 七维审查结论

| Review lens | 已实施的检查与结论 | 限制 |
| --- | --- | --- |
| Implementation | 全席位状态链、异步失效、WAIT归属、订单/读仓/回补/订阅、失败与午夜路径；G3-C1/C2/C3如上 | 未证明完整G4 broker mutation/settlement所有分支等价 |
| Project and Spec | 实际装配与层间端口；方案§1.1、第33–37行的授权例外，§9.4/1306–1330的policy、预算、WAIT及顺序；没有用新增文件等同新增需求授权 | 未对整份全部架构方案合规性作全仓裁决 |
| Type Design | SeatState判别联合、原route/dayEpoch/token/receipt、非空WAIT、具名policy、origin与一次性resolved语义；看到新类型清楚表达新规则不等于规则被授权 | 类型不可能替代外部SDK事实检查；没有要求将所有runtime校验搬进类型 |
| Tests | 398项本组离线测试通过；读相关integration/业务fixtures；运行同输入旧/新探针，独立V-C6 | 当前全绿和数量增长不能证明旧oracle被保留；未执行穷举交错/正式model checking |
| Comments | 注释对原票、ACK、WAIT、retained owner顺序有真实why；独立新增/不补卖注释准确解释当前实现 | 有旧autoSymbolManager命名遗留的低影响类型说明，未以此凑缺陷；注释不能证明新政策授权 |
| Dead Code | 搜索G3全部export函数的生产静态消费者；未发现零生产消费者；检查dispatcher在app装配及stop/drain实际连接 | 未完成所有返回成员/字符串协议的全仓动态穷尽证明；此边界按C级not assessed，不建议删除 |
| Simplification | 没有基于行数、双owner数量或审美提出过度设计；ACK WeakMap、原票闭包、dayEpoch/seatVersion隔离具有真实约束收益 | 未发现已确认且不改变业务的独立简化问题；不以合并workflow来消除必要授权边界 |

## 历史已修、基线已有、合理架构差异

- **时间/修订约束的历史归因必须保留。** `executedTime <= revision` 不是这次重构凭空新加：develop `src/core/trader/orderMonitor/orderFactMerge.ts:120,425`、`settlementFlow.ts:275` 已有检查；当时 eventFlow `:111`、orderOps `:170`、orderFactMerge `:156,171,237` 都从订单updatedAt派生成交时间，原假设成立。后来引入独立execution timestamp才使假设失效。`d2aa59054abac546f506b27df45f161afcfc6578` 已修相关检查；不能列成当前G3新缺陷。
- **2b67d36 的已修根因分类不改写。** execution-driven startup、全局数量整数化、市场范围不受控，按主审已固定口径记为历史修复；G3-C3是HK内部未归属账户订单的经济归一范围，不以美股碎股重复报历史scope问题。
- **基线本来存在的安全缺口不伪装回归。** V-C6旧positive+invalid会EMPTY；本组不建议恢复这种丢持仓归属行为。基线自己已ACK的sell之后有余量也可能等待不动，不能把所有取消余量场景都归为新回归。
- **跨午夜/进程的未完成switch计划不持久化：本轮没有足够证据证明是新丢失。** develop seatDomain本来resetAllState、清EMPTY；当前也如此。是否必须新增持久化恢复是独立需求；本组只核查旧/新席位身份隔离和carryover，不报未授权持久化功能缺失。
- **受控重建直接发布ACTIVE与运行期activation分开是合理架构差异。** 前者在关门状态下由统一重建完成全套事实/风险/订阅，后者用SEAT_REFRESH按原身份完成；不能因两个入口即认定绕过屏障，实际检查了app wiring及rebuild调用。
- **protective归属隔离为明示授权修正。** 方案§1.1第37行允许禁止跨protective扩量并保留普通合法REPLACE；G3-C1反例专门排除此例外。

## 实际文件覆盖矩阵

### 标记口径

- **已深读**：阅读该文件关键生产分支、契约及调用/错误出口；不代表所有依赖也全读。
- **等价diff核对**：已读取当前内容并与旧对应代码做定向/LCS差分，迁移本身主要是拆分/类型/路径变化；不以此宣称其所有跨模块副作用已经全量等价。
- **未深入**：只连接/检索/局部取证，或未覆盖完整owner协议。下表分别给出当前深度与旧来源深度；类型文件的“深读”是契约阅读，不是独立交易流程证明。

G3 34项均已纳入，不以目录整体替代文件级记录：

| # | 当前生产文件 | 当前深度/检查重点 | develop 对照深度/来源 |
| --- | --- | --- | --- |
| 1 | `src/application/autoSearch/candidateSearch.ts` | 已深读：参数、候选IO、失效与日志 | finder/index + policyResolver/utils 对应流程及diff |
| 2 | `src/application/autoSearch/index.ts` | 已深读：SEARCHING、失败、cancel | autoSymbolManager/autoSearch 全流程diff；旧handler接线 |
| 3 | `src/application/autoSearch/startupSeatSearch.ts` | 已深读：启动异常/无候选分离 | main/recovery/seatPreparation 的旧search流程；新文件非新需求授权 |
| 4 | `src/application/autoSearch/types.ts` | 已深读：三入口窄契约 | finder/types及旧manager相关契约局部对照 |
| 5 | `src/application/seatActivation/index.ts` | 已深读：完整激活与release/重试 | old handler/seatRefresh全流程及差分 |
| 6 | `src/application/seatActivation/rebuiltSeats.ts` | 已深读：关门paired token及身份 | 旧统一rebuild完成出口局部对照 |
| 7 | `src/application/seatActivation/types.ts` | 已深读：orders/risk/subscription最小能力 | 新拆契约；对照旧handler使用面 |
| 8 | `src/application/seatSwitch/distanceSwitch.ts` | 已深读：距离事件、预检、retry | 旧monitorQuote runtime入口局部对照 |
| 9 | `src/application/seatSwitch/index.ts` | 已深读：唯一状态maps与工厂装配 | old autoSymbolManager/index、handler接线diff |
| 10 | `src/application/seatSwitch/periodicSwitchTask.ts` | 已深读：原route票、handoff、结果重排 | old handler/autoSymbol对应逻辑diff |
| 11 | `src/application/seatSwitch/seatStateManager.ts` | 已深读：version、suppression、EMPTY | old同名文件diff |
| 12 | `src/application/seatSwitch/signalBuilder.ts` | 等价diff核对：当前全读，origin新增单列C1 | old同名signal构造、方向映射 |
| 13 | `src/application/seatSwitch/switchStateMachine.ts` | 已深读：admit至完成/失败；重点OLD/SELL/REBUY/周期 | old同名文件对阶段全流程diff；SELL_OUT和预算已运行旧工厂 |
| 14 | `src/application/seatSwitch/types.ts` | 已深读：授权、订单operation、policy接口 | oldmanager/types相关契约diff/局部 |
| 15 | `src/domain/seat/seatIdentity.ts` | 等价diff核对：当前全读 | old utils/seat/guards、symbols相关纯判断 |
| 16 | `src/domain/seat/seatPolicy.ts` | 已深读：启动/信号/失败/冻结纯规则 | finder/policyResolver + oldmanager/utils相关纯规则diff |
| 17 | `src/domain/seat/seatSnapshot.ts` | 等价diff核对 | oldhelpers/seatSnapshot、utils/seat/snapshots |
| 18 | `src/domain/seat/switchPolicy.ts` | 已深读：触发边界、整手、两mode | oldthresholdResolver及状态机内联规则diff |
| 19 | `src/domain/seat/switchState.ts` | 已深读：完整初始事实 | 旧状态机内联初始化；one-shot变化单列 |
| 20 | `src/domain/seat/symbolRegistry.ts` | 已深读：不变量、event版本、mutation | old autoSymbolManager/utils注册表部分diff |
| 21 | `src/domain/seat/types.ts` | 已深读：状态/预算/策略联合 | oldtypes/state、utils/seat/types相应契约局部 |
| 22 | `src/domain/seat/warrantSelection/index.ts` | 已深读：两层筛选、排序、期限 | oldfinder/policyResolver+utils对应算法diff |
| 23 | `src/domain/seat/warrantSelection/types.ts` | 已深读：精确金融文本、比率用途 | oldfinder/types对应契约局部 |
| 24 | `src/runtime/autoSearchWakeupRuntime/index.ts` | 已深读：timer/gate/版本/cancel/drain | oldmain同runtime行为diff |
| 25 | `src/runtime/autoSearchWakeupRuntime/types.ts` | 已深读：事件源和授权 | oldmain同types局部对照 |
| 26 | `src/runtime/periodicSwitchWakeupRuntime/index.ts` | 已深读：baseline、dirty、原任务票、gate恢复 | oldmain同runtime逻辑diff |
| 27 | `src/runtime/periodicSwitchWakeupRuntime/types.ts` | 已深读：observer非写owner、route state | oldmain同types契约局部 |
| 28 | `src/runtime/seatActivationDispatcher/index.ts` | 已深读：SWITCHING→ACTIVATING/seed/入队 | oldmain同dispatcher对应diff |
| 29 | `src/runtime/seatActivationDispatcher/types.ts` | 已深读：previous symbol/epoch/queue | oldmain同types相关契约 |
| 30 | `src/runtime/seatRuntimeCleanupDispatcher/index.ts` | 等价diff核对：当前全读、真实app消费者 | oldmain同dispatcher对应diff |
| 31 | `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts` | 等价diff核对：方向清理且保留SEAT_REFRESH | oldmain同queueCleanup对应diff |
| 32 | `src/runtime/seatRuntimeCleanupDispatcher/types.ts` | 已深读：清理能力边界 | oldmain同types相关契约 |
| 33 | `src/runtime/seatDiagnosticRuntime/index.ts` | 已深读：被动订阅/观测异常隔离/stop | 新增被动观测，无旧配对；已查真实app装配 |
| 34 | `src/runtime/seatDiagnosticRuntime/types.ts` | 已深读：只有观测依赖 | 新增契约，不持有业务写入能力 |

### 证明链的额外生产文件（没有把整目录冒称全读）

**已深读或针对完整席位相关函数读/diff：**

- `src/application/tradingDayRebuild/seatPreparation.ts`
- `src/application/tradingDayRebuild/seatActivationCarryover.ts`
- `src/application/tradingDayRebuild/executionNormalization.ts`
- `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`（席位/距离及其共用route；静态清仓业务规则不在本组重新全审）
- `src/runtime/asyncProgram/monitorTaskProcessor/index.ts`
- `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts`
- `src/runtime/lifecycle/cacheDomains/seatDomain.ts`
- `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts`（停止/重启序列）
- `src/runtime/lifecycle/terminationRuntime.ts`
- `src/runtime/tradingGateEventRuntime/index.ts`
- `src/domain/order/orderOwnership.ts`
- `src/domain/order/executionFact.ts`
- `src/domain/order/sellMergePolicy.ts`
- `src/domain/risk/warrantRiskChecker.ts`
- `src/domain/tradingSession/index.ts`（交易分钟、周期累计）
- `src/domain/strategy/ordinarySignalGuard.ts`
- `src/application/riskRefresh/warrantRiskRefresh.ts`
- `src/application/quoteRetry.ts`
- `src/infrastructure/longbridge/market/warrantListReadAdapter.ts`
- `src/infrastructure/longbridge/market/warrantListCache/index.ts`
- `src/infrastructure/longbridge/market/warrantRequestMapper.ts`
- `src/infrastructure/longbridge/market/quoteFinancialMapper.ts`
- `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts`
- `src/application/orderTracking/recorder/orderApiManager.ts`
- `src/types/seat.ts`、`src/types/seatSwitch.ts`、`src/types/periodicSwitch.ts`
- `src/utils/marketScope.ts`

**局部读取/定向diff，明确未深入整个文件或owner：**

- `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts`：席位准备、rawOrders归一、恢复known与入口；完整durable恢复协议未深入。
- `src/application/tradingDayRebuild/rebuildTradingDayState.ts`：席位发布、carryover、原token检查；整条统一重建编排未深入。
- `src/application/orderExecution/index.ts`、`authorization.ts`、`quantityResolver.ts`、`submitFlow.ts`：SWITCH_MOVE/REBUY、返回结果、授权、合并和实时available路径；普通全部策略执行与所有mutation边界未深入。
- `src/application/orderTracking/orderCacheManager.ts`、`recorder/index.ts`、`orderMonitor/index.ts`、`orderMonitor/settlementFlow.ts`：pending/operation/结算通知及预算接口；完整broker mutation、MO timeout、restore/hydration协议未深入。
- `src/domain/risk/dailyLossTracker.ts`：全量重算范围、ownership、原始成交准入、相关提交接口；完整风险分段/episode归因未深入。
- `src/infrastructure/longbridge/trade/orderMapper.ts`：snapshot/push事实映射及nullable/范围/时间；真实mapBrokerOrder已在探针调用，全部SDK枚举协议未重新全审。
- `src/runtime/quoteSubscriptionRuntime/index.ts`：席位真相投影、retain/admission/release/positions-ready和失败归属；其他订阅来源全部竞态未深入。
- `src/runtime/asyncProgram/monitorTaskQueue/index.ts`：latest-only、方向清理/消费连接；队列全部动态行为未深入。
- `src/app/runtime/createPreGateRuntime.ts`：被动诊断start/stop连接。
- `src/app/runtime/createPostGateRuntime.ts`：候选/启动搜索/activation/订阅/periodic/switch/cleanup实际依赖注入；其他app装配未深入。
- `src/app/context/createMonitorContext.ts`：seatSwitch使用同一真实accountService的getStockPositions和订单owner。
- `src/app/runtime/createAsyncRuntime.ts`：periodic handler、seatActivation worker及真实门禁连接。
- `src/config/validator/utils.ts:320–355`：静态LONG/SHORT同symbol配置拒绝，未审全配置系统。
- `src/types/account.ts`、`accountReadPorts.ts`、`accountPosition.ts`：本组涉及的持仓读口/paired token契约。

**develop 额外读取/运行的对应生产路径（只列实际范围）：**

- `src/services/autoSymbolFinder/{index,policyResolver,utils,types}.ts`：候选相关算法和契约。
- `src/services/autoSymbolManager/{index,autoSearch,thresholdResolver,seatStateManager,signalBuilder,switchStateMachine,utils,types}.ts`：寻标和换标相关函数/差分；utils中非席位用途未延伸。
- `src/main/asyncProgram/monitorTaskProcessor/handlers/{autoSymbol,seatRefresh}.ts`，`helpers/seatSnapshot.ts`。
- `src/main/{autoSearchWakeupRuntime,periodicSwitchWakeupRuntime,seatActivationDispatcher,seatRuntimeCleanupDispatcher}` 对应G3文件；`monitorQuoteEventRuntime` 席位相关runtime。
- `src/main/recovery/seatPreparation.ts`、`src/main/lifecycle/cacheDomains/seatDomain.ts` 及与carryover相关旧重建片段。
- `src/core/trader/orderExecutor/{index,quantityResolver,submitFlow}.ts`、`src/core/trader/utils.ts`：SELL合并/返回ID/授权与回补直接链。
- `src/core/orderRecorder/{index,orderApiManager,utils,orderFilteringEngine,orderOwnershipParser}.ts`：相关symbol过滤、nullable原始输入、重算工厂依赖（部分仅加载/局部对照，不称整模块深读）。
- `src/core/riskController/dailyLossTracker.ts`：相关重算范围/有效成交准入；真实旧工厂已运行。
- `src/core/trader/orderMonitor/{orderFactMerge,settlementFlow,eventFlow,orderOps}.ts`：仅历史timestamp归因片段。
- `src/utils/seat/{guards,snapshots,symbols,types}.ts`、`src/types/{state,risk}.ts` 的相应旧契约。

“内存loader加载了37个模块”只用于可复现测试的依赖说明，**不将自动加载但未人工分析的全部模块算作已深读**。不存在的 `recorder/apiManager.ts`、`lifecycle/postGatePhaseRuntime.ts`、`cacheDomains/quoteDomain.ts` 的失败读取不计覆盖。

## 验证记录

### 本组实际执行

- 离线命令：

```powershell
bun test tests/domain/seat tests/application/autoSearch tests/application/seatSwitch tests/application/seatActivation tests/runtime/autoSearchWakeupRuntime tests/runtime/periodicSwitchWakeupRuntime tests/runtime/monitorQuoteEventRuntime tests/runtime/seatActivationDispatcher tests/runtime/seatRuntimeCleanupDispatcher tests/runtime/seatDiagnosticRuntime tests/application/tradingDayRebuild/seatPreparation.business.test.ts tests/runtime/lifecycle/cacheDomains/seatDomain.test.ts tests/integration/distanceSwitchIndependentSell.integration.test.ts tests/integration/distanceSwitchTimeoutRebuy.integration.test.ts tests/integration/autoSymbolSwitch.integration.test.ts tests/integration/seatRefreshDayEpoch.integration.test.ts tests/integration/autoSearchPolicyConsistency.integration.test.ts tests/integration/terminalSwitchFinalization.integration.test.ts tests/integration/lifecycle tests/runtime/quoteSubscriptionRuntime/failureOwnership.business.test.ts
```

结果 **exit=0；398 pass / 0 fail；2874 expect() calls；39 files；1162ms**。只执行mock/fixture离线测试。早先还执行过两组部分重叠测试；第一组输出截断不报数量，第二组39 pass/0 fail/249 expect/10files。以此次完整汇总为本组主要证据，不累加重复数量。

- develop真实merge helper：exit0，`REPLACE mergedQuantity100 target OLD pendingRemaining60`。
- develop/当前真实状态机四次同输入探针：exit0；释放余量和明确拒绝的差分见附录。
- 真实broker mapper→activation无关HK订单：exit0；amount=null、ownership=null、错误MANUAL-HK、Daily/O均未提交。
- 旧真实DailyLoss工厂：exit0，缺价无关HK单被跳过、loss0。
- V-C6 develop原runtime集成：exit0，原3断言成功（未当作bun test的正式测试计数）。
- V-C6当前真实account adapter双分支runtime：exit0，fresh positive fatal/保留OLD，fresh flat COMPLETED/ACTIVATING，均native mutation0。
- 报告写成后直接从本Markdown提取B0+B1、B0+B2、B3、C、B0+C2五份代码再次通过stdin运行，**五份均exit0且stderr为空**；随后`git status --short`仍为空。附录不是未执行的伪代码。

### 由验证代理提供，非本组重复执行

用户及 `validation-peer-review-request.md` 通知：两版typecheck/lint/full test均通过；current **3288**、develop **1992**。不据此推断任何候选不存在，不把报告引用的验证代理结果写成本组亲自执行的全仓验证。

### 失败尝试，不计作验证成功

初次Bun虚拟module加载旧utils路径失败；初次tsconfig直接JSON.parse因JSONC注释失败；初次V-C6内存包装因宿主字符串语法失败。这些为审计脚本问题，不是仓库缺陷，已换正确loader/包装重跑并取得上列exit0。早期长输出被截断的探针不作为证据，已用短JSON结果重新运行。

## not assessed

- 真实交易服务/生产账户数据是否出现nullable终态成交价、broker实际改单时序/订单优先级及实盘盈亏：未访问外部服务；不把构造fixture可达性等同已发生事故。
- G0完整启动/恢复/生命周期并发编排、G4完整cancel/replace UNKNOWN与settlement/durable owner、G5全部业务ready/episode/cooldown：本组只追席位所需接口/片段，留各组主审。
- 所有SDK枚举、执行明细读口和普通策略信号全链：不是G3完整深入范围。
- 任意时间交错的形式验证、所有动态字符串/反射/外部导出消费、所有工厂返回成员的dead code穷尽：没有完成，不能据局部grep建议删除。
- 正式业务授权的全部外部记录：可见方案明示例外没有独立新增/一次性卖出授权；若另有明确批准材料，主代理应对G3-C1/C2重新裁决，而非仅依新测试证明获准。
- G3-C1/C2/C3的独立二审尚需主代理安排；本组未自行启动子代理。

## recommended next actions

1. 主代理对G3-C1/C2/C3安排独立复核，优先同一输入完整native对照G3-C1、激活scope同根因兄弟入口G3-C3。V-C6二审证据已交付，不另计第四个同根因缺陷。
2. 对G3-C2先做明确业务裁决：保留positive持仓owner是安全要求；明确拒绝/无报价/旧操作释放是否必须全局终止，是独立政策，不能混同submit UNKNOWN，也不要恢复不安全EMPTY。
3. 长期测试应保留fresh-flat和fresh-positive两类fixture；用统一develop oracle检查已授权例外以外的native mutations、budget和失败出口，而不只是让两版各自全绿。
4. 在三候选裁决后，由对应owner做根因范围修复；本审计没有实施任何代码更改。

---

## 附录 B：可运行只读 stdin 探针

以下代码在仓库根目录执行。PowerShell可用 `@'` / `'@ | bun run -` 包住代码，不创建脚本。B0为B1/B2/旧Daily探针共用前缀，需与对应片段放在**同一次stdin**中；只用git show读取旧SHA，无checkout。外部IO均为fixture/注入替身。

### B0 旧源码内存loader（可选harness用于运行旧原集成）

```typescript
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const OLD = '6e239c8a128372bd9b2fb2d79464346792a5e81e';
const req = createRequire(process.cwd() + '/package.json');
const cache = new Map();
const logger = { debug(){}, info(){}, warn(){}, error(){} };
function oldRequire(file) {
  if (cache.has(file)) return cache.get(file).exports;
  if (file === 'src/utils/logger/index.ts') return { logger };
  const raw = execFileSync('git', ['show', OLD + ':' + file], { encoding:'utf8' });
  const module = { exports:{} };
  cache.set(file, module);
  const js = ts.transpileModule(raw, { compilerOptions: {
    module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true,
  }}).outputText;
  new Function('require','exports','module','__filename','__dirname',js)(
    name => name === 'bun:test' ? harness : name.startsWith('.')
      ? oldRequire(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)).replace(/\.js$/, '.ts'))
      : req(name), module.exports, module, file, path.posix.dirname(file),
  );
  return module.exports;
}
```

`harness`仅运行旧测试时才需定义；普通生产模块没有bun:test依赖，不会读取该变量。

### B1 G3-C1：执行真实develop合并规则

```typescript
const { OrderType, OrderStatus } = req('longbridge');
const { resolveSellMergeDecision } = oldRequire('src/core/trader/utils.ts');
console.log(JSON.stringify(resolveSellMergeDecision({
  symbol:'OLD.HK',
  pendingOrders:[{orderId:'OLD',submittedQuantity:60,executedQuantity:0,
    orderType:OrderType.ELO,status:OrderStatus.New}],
  newOrderQuantity:40,newOrderType:OrderType.ELO,isProtectiveLiquidation:false,
})));
// 实际输出：{"action":"REPLACE","mergedQuantity":100,"targetOrderId":"OLD",
// "pendingOrderIds":["OLD"],"pendingRemainingQuantity":60,"reason":"replace-and-merge"}
```

当前完整native对照见前述398项命令中 `distanceSwitchIndependentSell.integration.test.ts:382–423`。B1本身只证明旧helper决定，不冒充完整broker路径执行。

### B2 G3-C2：两版真实状态机的释放余量/明确拒绝

```typescript
import { createSwitchStateMachine as currentFactory } from './src/application/seatSwitch/switchStateMachine.ts';
const oldFactory = oldRequire('src/services/autoSymbolManager/switchStateMachine.ts').createSwitchStateMachine;
async function run(current, scenario) {
  const t = Date.parse('2026-03-13T03:00:00Z'), calls=[];
  const state={direction:'LONG',switchMode:'DISTANCE',seatVersion:1,stage:'SELL_OUT',
    oldSymbol:'OLD.HK',nextSymbol:'NEW.HK',nextCallPrice:current?'20000':20000,
    sellSubmitted:false,sellOrderIdsAtAdmission:scenario==='released'?['OLD']:[],
    sellSubmissionResolved:false,sellWaitOrderIds:scenario==='released'?['OLD']:[],
    sellOrderId:null,shouldRebuy:true,quoteRetryAttempts:0,quoteRetryNextAt:null,
    quoteRetryExhausted:false,cancelRequestSubmitted:true};
  const position={symbol:'OLD.HK',quantity:100,availableQuantity:100};
  const executeSignals=async signals=>{
    calls.push(signals.map(s=>({action:s.action,symbol:s.symbol,quantity:s.quantity})));
    return scenario==='rejected'
      ? {executedOrderIds:[],quoteFailures:[],sellDecisionResults:signals.map(signal=>({signal,kind:'REJECTED'}))}
      : {executedOrderIds:['NEWSELL'],quoteFailures:[]};
  };
  const cacheManager={getPendingOrders:async()=>[]};
  const orderMonitor={getKnownSellOrderIds:()=>scenario==='released'?['OLD']:[],
    getUnsettledSellOrderIds:()=>[],getSellOperationState:()=>'SETTLED_WITH_REMAINDER',
    captureSellAvailabilityGuard:()=>()=>true,getSellOperationOrderIds:id=>[id]};
  const deps={autoSearchConfig:{autoSearchEnabled:true},monitorSymbol:'HSI.HK',
    symbolRegistry:{getSeatVersion:()=>1,getSeatState:()=>({symbol:'OLD.HK',status:'SWITCHING'})},
    trader:{getPendingOrders:cacheManager.getPendingOrders,executeSignals},
    cacheManager,orderMonitor,orderExecutor:{executeSignals},
    orderHoldRegistry:{getHoldSymbols:()=>new Set()},readSwitchPositions:async()=>[position],
    orderRecorder:{getSellRecordByOrderId:()=>null},riskChecker:{},
    marketDataClient:{getQuotes:async()=>new Map([['OLD.HK',{symbol:'OLD.HK',name:'OLD',
      price:current?'1':1,prevClose:current?'1':1,timestamp:t,lotSize:1}]])},
    now:()=>new Date(t),switchStates:new Map([['LONG',state]]),periodicSwitchPending:new Map(),
    resolveSuppression:()=>null,markSuppression(){},enterSwitchingSeat:()=>1,updateSeatState(){},
    resolveDirectionSymbols:()=>({buyAction:'BUYCALL',sellAction:'SELLCALL'}),
    buildOrderSignal:p=>p,pendingOrderStatuses:new Set(),buySide:current?'BUY':1,logger,
    maxSearchFailuresPerDay:3,getHKDateKey:()=>'2026-03-13'};
  let error=null,result=null;
  try { result=await(current?currentFactory:oldFactory)(deps).advancePendingSwitch({
    direction:'LONG',positions:[position],canContinue:()=>true,
  }); } catch(e) { error=e.message; }
  return {current,scenario,calls,result,error,resolved:current?state.sellSubmissionResolved:state.sellSubmitted,
    retries:state.quoteRetryAttempts};
}
for(const scenario of ['released','rejected'])
  for(const current of [false,true]) console.log(JSON.stringify(await run(current,scenario)));
```

实际短结果：

```text
released old: SELL100, WAIT ORDER_EVENT/FRESHNESS, no error, sellSubmitted=true
released current: no SELL, error等待人工处理 qty100 operations[OLD], resolved=true
rejected old: SELL100, WAIT SYMBOL_QUOTE/RETRY_TIMER, no error, retries1, sellSubmitted=false
rejected current: SELL(quantity=null由executor实时决定), error等待人工处理 qty100 operations[], resolved=true
```

### B3 G3-C3：真实mapper→真实activation；独立可运行

```typescript
import { mapBrokerOrder } from './src/infrastructure/longbridge/trade/orderMapper.ts';
import { OrderType,OrderStatus,OrderSide,Decimal } from 'longbridge';
import { createSeatActivationWorkflow } from './src/application/seatActivation/index.ts';
import { createMonitorContext } from './tests/helpers/asyncProgram.ts';
import { createSnapshotFixture } from './tests/helpers/accountPositionSnapshot.ts';
import { createAccountSnapshotDouble,createQuoteSubscriptionRuntimeDouble } from './tests/helpers/testDoubles.ts';
import { createDiagnosticObserverDouble } from './tests/helpers/diagnostics.ts';
import { resolveOrderOwnership } from './src/domain/order/orderOwnership.ts';
const now=new Date('2026-03-13T03:00:00Z');
const order=mapBrokerOrder({orderId:'MANUAL-HK',symbol:'00005.HK',stockName:'HSBC HOLDINGS',
  side:OrderSide.Buy,status:OrderStatus.Filled,orderType:OrderType.ELO,remark:'',
  price:new Decimal('100'),quantity:new Decimal('10'),executedPrice:null,
  executedQuantity:new Decimal('10'),submittedAt:new Date(+now-60000),updatedAt:now});
const context=createMonitorContext();
context.symbolRegistry.updateSeatState('LONG',{...context.symbolRegistry.getSeatState('LONG'),
  status:'ACTIVATING',symbol:'BULL.HK',callPrice:'20000'});
const snapshot=await createSnapshotFixture({account:createAccountSnapshotDouble('100000'),positions:[]});
const calls={dailyPrepare:0,validate:0,commit:0};
const workflow=createSeatActivationWorkflow({diagnostics:createDiagnosticObserverDouble(),
  clock:{now:()=>now},config:{...context.config,orderOwnershipMapping:['HSI']},
  symbolRegistry:context.symbolRegistry,
  orders:{...context.orderRecorder,fetchAllOrdersFromAPI:async()=>[order],
    validateRebuildSnapshot:()=>{calls.validate++},commitRebuildSnapshot:()=>{calls.commit++}},
  dailyLoss:{...context.dailyLossTracker,prepareRecalculationFromAllOrders:()=>{
    calls.dailyPrepare++;throw new Error('unexpected daily prepare');}},
  risk:context.riskChecker,snapshot,subscriptions:createQuoteSubscriptionRuntimeDouble(),
  getQuotes:async()=>new Map(),setDirectionSymbolName(){},logger:{debug(){},error(){}}});
let error=null;
try { await workflow.activate({dayEpoch:snapshot.getView().token.dayEpoch,direction:'LONG',
  seatVersion:context.symbolRegistry.getSeatVersion('LONG'),previousSymbol:'OLD_BULL.HK',
  nextSymbol:'BULL.HK',callPrice:'20000',symbolName:'BULL.HK'},()=>true);
} catch(e) { error=e.message; }
console.log(JSON.stringify({amount:order.executedAmount,
  ownership:resolveOrderOwnership(order,{monitorSymbol:'HSI.HK',orderOwnershipMapping:['HSI']}),
  error,calls,seat:context.symbolRegistry.getSeatState('LONG').status}));
// 实际：amount=null ownership=null error=[执行归一]...MANUAL-HK
// calls={dailyPrepare:0,validate:0,commit:0} seat=ACTIVATING
```

## 附录 C：V-C6 完整当前runtime双分支（独立stdin运行）

此脚本只在内存转换测试宿主、真实读仓绑定及观测，不写原文件。assert保留关键不变量。当前生产worker/quote/switch/adapter仍用真实模块。

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const file=path.resolve('tests/integration/terminalSwitchFinalization.integration.test.ts');
const base=fs.readFileSync(file,'utf8'), all=[];
for(const mode of ['fresh-positive','fresh-flat']) {
  globalThis.__auditFatalErrors=[];
  let pending;
  globalThis.__auditHarness={describe:(_,fn)=>fn(),it:(_,fn)=>{pending=fn()},expect:v=>({
    toBeTrue:()=>assert.equal(v,true),toBe:x=>assert.equal(v,x),toEqual:x=>assert.deepEqual(v,x),
  })};
  let source=base.replace("import { describe, expect, it } from 'bun:test';",
    'const {describe,expect,it}=globalThis.__auditHarness;');
  source=source.replace(/from (['"])(\.[^'"\r\n]+)\1/g,(_,q,p)=>
    'from '+q+pathToFileURL(path.resolve(path.dirname(file),p.replace(/\.js$/,'.ts'))).href+q);
  source=source.replace('const actualAutoSymbolManager = createSeatSwitchWorkflow({',
    'let freshReads=0; const actualAutoSymbolManager = createSeatSwitchWorkflow({');
  source=source.replace('readSwitchPositions: async () => [],',
    'readSwitchPositions: async (symbol) => {freshReads++; return account.getStockPositions({symbols:[symbol]});},');
  source=source.replace(/reportFatalError: \(error\) => \{\s*throw error;\s*\}/g,
    'reportFatalError: (error) => { globalThis.__auditFatalErrors.push(error); }');
  if(mode==='fresh-flat') source=source.replace('switchWakeupRuntime.start();',
    'native.setStockPositions([]); switchWakeupRuntime.start();');
  source=source.replace('await waitUntil(() => advanceResults.length === 1);',mode==='fresh-positive'
    ? 'await waitUntil(() => globalThis.__auditFatalErrors.length === 1);'
    : 'await waitUntil(() => advanceResults.length === 1);');
  const start=source.indexOf('      expect(advanceResults).toEqual([');
  const last='      expect(native.nativeMutations()).toEqual([]);';
  const end=source.indexOf(last,start);
  assert(start>=0&&end>start);
  source=source.slice(0,start)+'      globalThis.__auditResult={mode:'+JSON.stringify(mode)+
    ',reads:freshReads,fatals:globalThis.__auditFatalErrors.map(e=>e.message),advanceResults,'+
    'seat:symbolRegistry.getSeatState("LONG"),pending:actualAutoSymbolManager.hasPendingSwitch("LONG"),'+
    'mutationCalls,nativeMutations:native.nativeMutations()};\n'+source.slice(end+last.length);
  const js=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source);
  await import('data:text/javascript;base64,'+Buffer.from(js+'\n//'+mode).toString('base64'));
  await pending;
  const r=globalThis.__auditResult;
  assert.equal(r.mutationCalls,0);assert.deepEqual(r.nativeMutations,[]);
  if(mode==='fresh-positive') {
    assert.equal(r.fatals.length,1);assert.match(r.fatals[0],/等待人工处理/);
    assert.equal(r.seat.status,'SWITCHING');assert.equal(r.seat.symbol,'OLD_BULL.HK');
    assert.equal(r.pending,true);
  } else {
    assert.deepEqual(r.fatals,[]);assert.equal(r.advanceResults[0].driveResult.kind,'COMPLETED');
    assert.equal(r.seat.status,'ACTIVATING');assert.equal(r.pending,false);
  }
  all.push(r);
}
console.log(JSON.stringify({validation:'V-C6',results:all}));
```

### C2 执行原develop集成（B0 + 以下片段，同一次stdin）

```typescript
import assert from 'node:assert/strict';
let pending,checks=0;
const observations=[];
function partial(v,x) { for(const[k,y]of Object.entries(x)) {
  if(y&&typeof y==='object') partial(v[k],y); else assert.deepEqual(v[k],y);
}}
const harness={describe:(_,fn)=>fn(),it:(_,fn)=>{pending=fn()},expect:v=>({
  toBeTrue:()=>{checks++;assert.equal(v,true)},
  toBeFalse:()=>{checks++;assert.equal(v,false)},
  toBe:x=>{checks++;assert.deepEqual(v,x)},
  toEqual:x=>{checks++;observations.push(v);assert.deepEqual(v,x)},
  toMatchObject:x=>{checks++;observations.push(v);partial(v,x)},
})};
oldRequire('tests/integration/terminalSwitchFinalization.integration.test.ts');
await pending;
console.log(JSON.stringify({validation:'V-C6-baseline-original',checks,observations,
  loadedBaselineModules:cache.size}));
// 实际exit0、checks3；FAILED/INVALID_QUOTE:SELL_OUT、EMPTY；loadedBaselineModules37。
```

---

报告状态：已完成本组只读取证及V-C6独立二审，等待主代理对三个自查候选的跨组独立复核/业务授权裁决。未据各版测试全绿作全量等价性承诺。
