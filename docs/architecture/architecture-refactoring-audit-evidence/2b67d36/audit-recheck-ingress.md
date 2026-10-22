# 订单读入边界独立二次复核

## summary

- **verdict：INF-C1、INF-C2、G3-C3 均 confirmed（可执行的条件性逻辑回归）。按共享根因归并为 1 项 major：在选择真正需要消费的观察/订单之前，把完整经济事实校验提升成全账户输入的硬前提。**不是 3 项独立记账错误，也不是一处 guard 就能完全修复：C1/C2 位于 SDK 观察构造，C3 位于 application 全量归一，必须同时纠正两层的选择顺序。
- **scope：**固定 current=`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`，develop=`6e239c8a128372bd9b2fb2d79464346792a5e81e`。以 develop 的真实行为和用户“不允许业务功能偏离”要求为真值；直接核查两版 caller、SDK mapper、合并去重、recorder、DailyLoss、启动 loader、rebuild、activation、fatal 通道，以及同 mapper 的直接 push/detail 消费边界。初审报告仅用来定位候选，不作为复核证据。
- **confidence：high（源码与离线差分）；实际 broker 发生频率：insufficient。**证明的是这些 SDK 类型允许、旧程序明确处理的输入若到达，current 会走到错误分支；没有连接实盘，没有生产样本，不能写成“券商通常会返回”“线上已经停机”。
- 已读取 code-review、typescript-project-specifications、core-program-business-logic、lazy-senior-developer 四项任务技能，另加载 context-mode；读取架构方案必要条款。复核前后 HEAD 均为固定 current，`git status --porcelain` 均为空。**未修改仓库源码、测试、配置、方案。**只在本 TEMP 目录写本报告、探针、JSON/文本证据及测试日志。

### 逐项裁决

| 初审编号 | 裁决 | 严重性 | 独立复核的具体结论 |
| --- | --- | --- | --- |
| INF-C1 | **confirmed** | major | SDK 合法 nullable 的 history 旧观察在 today 请求之前被完整事实 mapper 拒绝；原本应获选的完整 today 根本没有机会覆盖。相同来源内的被淘汰旧观察也存在同根问题。**不确认“所有终态缺价 history 都阻断”这一过宽描述**：有有效 revision 的普通终态缺价可映射为 null，完整 today 能覆盖，实测两版均通过。 |
| INF-C2 | **confirmed** | major | 已知终态、零累计成交、`OrderSide.Unknown` 在 develop 明确非 fatal 且不分类；current 无条件拒绝 side，连 current 仍保留的 domain 零成交终态豁免都不可达。不是获准的全局 fail-fast 加强。 |
| G3-C3 | **confirmed** | major | 与席位无关、无本系统 ownership 的合法 HK 普通终态缺价记录，通过实际 adapter/mapper 后，先在全账户 normalize 抛错，早于相关标的/归属选择；真实 activation 和真实启动 loader 均复现。真实监控队列把该内部 Error 送入 termination，全局交易与生产准入被关闭。 |

## critical issues

None。本次证据是扩大 fail-fast 范围导致的可用性/恢复回归；未证明错误成交、资金损失、放松交易门禁或坏账发布，不提升为 critical。

## major issues

### R-INGRESS-01 — 完整经济事实校验越过观察择优和业务消费范围（归并 INF-C1 / INF-C2 / G3-C3）

- **claim：**“SDK 可表达的原始观察”“按既定规则获选的快照”“真正属于该业务消费范围的经济事实”被过早等同。校验自身应继续严格，但其适用集合扩大了，原本应覆盖、忽略或留给原 owner 选择的输入变成全局硬失败。
- **dimensions：**implementation、project/spec、types、tests、comments。未引入风格类问题。

#### 1. 约束与 SDK 类型，不应误解为全面放松校验

1. `docs/architecture/architecture-refactoring-implementation-plan.md:31–33` 要求除明确授权项外保留既有业务、订单事实和恢复协议；`:65–79` 保留错误分类和激活门禁；`:1259–1263,1280` 的激活顺序是读 allOrders 后做 related-symbol preflight；§15.2（`:2040`）明确“内部金融精度/范围/状态契约错误”应 fail-fast，**但“已明确允许丢弃/重试的外部缺失输入仍由原 owner 处理”**。这些条款不是把整个券商账户都升级成本系统完整经济账的授权。
2. 业务技能 `core-program-business-logic/SKILL.md:204–209` 明确：history/today 同身份合并、today 无条件优先、同源择新，然后按标的拆分。`:274–279` 保留未完成卖单归属失败、买单不匹配尝试撤单等严格恢复规则；本次修复不能把这些 OPEN 资源一起忽略。
3. 两版 `package.json` 均固定 longbridge **4.4.3**，本机安装亦为 4.4.3。实际 SDK 声明 `node_modules/longbridge/index.d.ts:1162–1200`：`Order.executedPrice: Decimal | null`（1178）、`Order.updatedAt: Date | null`（1200）；`side: OrderSide`（1182），而 `OrderSide.Unknown=0` 在 `:5428–5434` 是正式成员。反例使用 null，而不是以 SDK 未声明的 undefined、NaN、未来枚举或坏 symbol 造错。
4. **nullable/Unknown 的类型只证明结构可表达，不证明 broker 会以何种频率返回某状态组合。**业务是否能消费，仍由已选择的订单和对应 owner 的既有规则决定；不能因 nullable 就放行相关正成交，也不能仅因新类型变窄就删除旧明确允许忽略的记录。
5. current `src/types/trade.ts:9–35` 同时要求 `executionSide: 'BUY'|'SELL'`，允许普通终态 `executedAmount:null`。这适合已构造的业务事实，但不能强迫每一条待去重/待排除的账户观察先成为此类完整事实。应在构造窄事实之前表达/排除候选，而不是把 `'UNKNOWN'` 或虚构 BUY/SELL 塞进经济账。

#### 2. INF-C1：先对 history 完整映射，today 的优先权被前置错误截断

**current 精确证据：**

- `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:95–115` 的结构验证仍允许 nullable `executedPrice`、nullable/omitted `updatedAt`。
- 同文件 `:120–136` 每条观察调用 `mapBrokerOrder`；`:142–153` 对每条 HK 观察立即做完整映射。
- 同文件 `:178–199` 先 history 请求、验证并映射（188），之后才第二次 limiter/today 请求（190–196）。
- `src/infrastructure/longbridge/trade/orderMapper.ts:101–109` 立即拒绝在途正成交缺价、正成交缺独立 revision。
- `src/application/orderTracking/recorder/orderApiManager.ts:9–11` 只有 adapter 两组数组都成功返回后才调用去重；`src/domain/order/orderSnapshotPolicy.ts:29–40,50–91` 的 today 覆盖及同源择新规则还在，但已经来不及生效。

**develop 精确证据：**

- `src/core/orderRecorder/orderApiManager.ts:118–125,146–164` 允许并保留 SDK 缺价/缺 revision；`:174–181` 仅在快照版本比较时按 updatedAt/submittedAt 选版本，不把 submittedAt 冒充执行时间。
- 同文件 `:197–207,272–296`：两次 SDK 读和结构验证后，先形成 nullable RawOrder，再合并；today 无条件覆盖 history。
- `src/core/orderRecorder/index.ts:128–145` 先筛选目标 symbol；`src/core/orderRecorder/utils.ts:155–163,222–224` 才要求实际消费的非零成交具备完整 price/quantity/updatedAt。

**独立场景与输出：**

- `DUP/BULL.HK/BUY/Filled/10` 的 history `executedPrice=1, updatedAt=null`；today 同 ID、完整价格/独立 updatedAt。develop 真实 recorder fetch+预检成功，`executedBuyOrders=1`，读序列为 `throttle,history,throttle,today`；current **只读到 history**，抛 `TypeError: [orderMapper] executed order lacks independent broker revision`。
- history 为旧 `PartialFilled/5/executedPrice=null`，today 同 ID 为完整 `Filled/10`：同样 develop 成功、current 在 today 前拒绝。
- 完整终态缺价 history（revision 有效）被完整 today 覆盖：**两版都成功**，排除了“任意 null 成交价都会在 mapper 拒绝”的错误假设。
- 真正获选的 today 若缺 revision/缺价，或 history 完整但获选 today 缺 revision：**两版都拒绝**。修复不能借 history 补价/补 revision，也不能在坏 today 时退回好 history。
- 真实启动 loader 差分亦复现“history 缺 revision + 完整 today”：develop loader 返回快照，current 在相同 mapper 处抛错。

**runtime path：**生产 `src/app/runtime/createTradeRuntime.ts:73–78` 装配真实 recorder，`src/infrastructure/longbridge/trade/brokerAccessAdapter.ts:19–20` 装配本 adapter；启动 loader `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:441` 调 fetch，运行期 activation `src/application/seatActivation/index.ts:320` 也调同 fetch。启动 `startupSnapshot.ts:85–87` 不把该 TypeError 当外部请求失败重试，`src/app/runApp.ts:358–360` 送入 fatal；开盘重建 `src/runtime/lifecycle/dayLifecycleManager.ts:365–368` 同样按内部错误 fatal。

**impact：confirmed（条件性逻辑回归）**——完整、应被选中的券商观察存在仍无法恢复/激活；potential（真实 broker 是否返回该组合及发生频率未验证）。

**minimal fix：**分离结构/保真解包与完整经济事实构造；保留原 owner 的跨源/同源择优，**先选中最终观察，再对实际需消费的事实严格验证**。坏 identity、未知 status、非法字段结构、SDK getter 内部异常仍按原契约失败；不是捕获所有 mapper 错误继续读，也不是选择“哪条校验通过就用哪条”。

**测试缺口：**`tests/infrastructure/longbridge/trade/orderSnapshotReadFixture.ts:18–25,45–52`、`tests/integration/architectureRefactoringP1Native/trade/orderSnapshotNativeRead.test.ts:7–20` 的择优测试只有可完整映射的零成交输入；mapper `orderFactMapper.test.ts:109–113` 的“正成交缺 revision 拒绝”是正确负向测试，但不能代替“被覆盖旧观察 + 完整获选观察”的组合。应补 history/today 及同源重复两种组合，以及获选 today 错误不得 fallback 的反向用例。

#### 3. INF-C2：零成交终态 Unknown-side 的明确丢弃规则被窄 mapper 提前封死

**current 精确证据：**

- `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:65–77` 明确接受 `OrderSide.Unknown` 结构，后续 `:151–152` 却立即交给 mapper。
- `src/infrastructure/longbridge/trade/orderMapper.ts:73–80` 在读取 lifecycle、quantity 之前无条件拒绝所有非 BUY/SELL。
- domain **仍保留** `src/domain/order/orderRecordPolicy.ts:217–227` 的“零成交终态允许方向未归属”判断，但入口无法到达。

**develop 精确证据：**

- `src/core/orderRecorder/orderApiManager.ts:73–84,115,146–164` 保留 Unknown-side。
- `src/core/orderRecorder/utils.ts:203–209,222–237` 先验证非零经济事实，仅未知方向的非零成交或 OPEN 才失败；零成交 TERMINAL 直接忽略。
- 这不是仅靠推断：原测试 `tests/core/orderRecorder/classifyOrdersForRebuild.test.ts:119–175` 分别保护正成交 Unknown 拒绝、OPEN+0 Unknown 拒绝、TERMINAL+0 Unknown 非 fatal。
- 原恢复 `src/core/trader/orderMonitor/recoveryFlow.ts:384–387` 先跳过非 OPEN；原 DailyLoss `src/core/riskController/dailyLossTracker.ts:648–653` 也不消费此类记录。

**独立场景与输出：**HK、合法 ID/remark/时间/quantity，`side=Unknown, status=Canceled, executedQuantity=0, executedPrice=null, updatedAt=null`。develop 真实 API manager/recorder 读完两组，实际分类四组均为 0，真实启动 loader 返回快照；current 在 history mapper 抛 `unknown SDK execution side`，没有 today 请求。另两组控制 `Unknown+OPEN+0`、`Unknown+TERMINAL+正成交且完整金额时间`：**两版均拒绝**。

**impact：confirmed（条件性逻辑回归）**——无成交、无 OPEN 占用的可忽略观察变成整个恢复/激活的前提；potential（真实券商枚举组合频率未验证）。新架构窄类型不授权删除原显式豁免，因此不以“更优 fail-fast”驳回此项。

**minimal fix：**在最终快照观察选定之后、构造 BUY/SELL 窄事实之前，按原精确条件处理 `Unknown + 已知TERMINAL + 累计量0`，不构造经济事实。**不要先逐条删除 today 的 Unknown 终态而让 history 意外复活**；先遵守跨源择优。Unknown OPEN 或正成交继续拒绝，不默认成 BUY/SELL，不推广到本来就严格的 pending 查询口。

**测试缺口：**current `tests/domain/order/classifyOrdersForRebuild.test.ts:22–51,190–215` 用 `Reflect.set(...,'UNKNOWN')` 破坏内部类型来验证该 domain 豁免，并注释“不是外部 SDK Unknown 的 mapper 准入”。这些测试通过并不能证明真实入口仍可达。应补 **SDK snapshot → 去重 → recorder/loader** 的完整三态矩阵，而不是把不可达分支的单测当迁移等价证据。

#### 4. G3-C3：无关 HK 手工终态记录，在相关范围判断前全量 normalize

**current 精确证据：**

- `src/infrastructure/longbridge/trade/orderMapper.ts:56–65,90–114` 明确允许普通终态正成交缺价，保持 `executedAmount=null`；`orderSnapshotReadAdapter.ts:142–153` 仅先排除非 HK，并不按 system ownership 排除手工 HK 订单。
- `src/application/seatActivation/index.ts:320–332` fetch 后对全部 apiOrders normalize；`:334–354` 才计算 relatedTradingSymbols/方向，`:356–374` 才做相关订单与 ownership 验证，`:380–404` 才 Daily prepare 和 O commit。
- related 集合来自同文件 `:130–150` 的新标、不同旧标、当前 LONG/SHORT，不包含任意其他港股。
- `src/application/tradingDayRebuild/executionNormalization.ts:45–48` 对任意正成交的 null amount 立即抛错，未先选择业务消费范围。
- 启动/开盘 sibling：`src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:491–493` 同样全量归一，`:544–560` 才收集最终 related 集并形成 Daily 候选。最终受控 rebuild 的 recorder 范围本来仍是 per-target：`rebuildTradingDayState.ts:95–102`，以及 `src/application/orderTracking/recorder/index.ts:259–260`。

**develop 精确证据：**

- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:318–352` 获取 allOrders 后，先对 related symbols 预检，再 Daily recalculation，再刷新当前方向订单。
- `src/core/orderRecorder/index.ts:128–145` 按 symbol 筛选后才分类。
- `src/core/riskController/dailyLossTracker.ts:578–582,648–664` 跳过无有效成交事实；有效但无 ownership 且不相关的记录也不入本系统日损。
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:259–305` 先准备席位/相关集合，再 Daily；`src/main/lifecycle/rebuildTradingDayState.ts:69–86` 只重建当前席位标的；TERMINAL 手工单不进入上述原 pending 恢复。

**独立场景（并非重用初审原文结果）：**

- LONG 激活 BULL.HK，SHORT 为 BEAR.HK，previous=OLD_BULL.HK，`monitorSymbol=HSI.HK, orderOwnershipMapping=['HSI']`，paired account/positions snapshot 已初始化，无 durable recovery 记录。
- 全账户 history 另含 `MANUAL-HK / 00005.HK / HSBC HOLDINGS / BUY / Filled / ELO / quantity=executedQuantity=400 / submittedPrice=100 / executedPrice=null`，提交/更新日期有效，`remark=''`。实际 SDK Decimal/枚举 → 真实 adapter/recorder；真实 ownership 解析结果为 null，mapper 输出 `TERMINAL, amount=null`。它不在 related 集、不被 durable 引用、无 OPEN 资源。
- **develop：**真实 `createSeatRefreshHandler`，配真实 recorder/DailyLoss，返回 processed，席位 ACTIVE，loss=0；related validate=3、Daily=1、方向订单刷新=1。
- **current：**真实 `createSeatActivationWorkflow` 在 `[执行归一] 正成交缺少本次原始金额: MANUAL-HK` 抛错；validate/Daily prepare/Daily publish/order commit **全部 0**，finally release=1，席位仍 ACTIVATING。
- 进一步把同一真实 activation 送入真实 monitorTaskQueue/monitorTaskProcessor/queueRunner/termination：fatal=true，`closeTradingGate=1, closeProducerAdmission=1`。不是把一段局部 throw 推测成全局错误。
- 真实 loader 差分：develop 返回 snapshot；current 在同一 normalize 拒绝。将同一手工单仅补成合法执行价后，两版 loader 均成功（current COMMITTED），两版 activation 均 ACTIVE，排除 fixture 本身不能完成流程的假设。

**严格负向控制（不能拿修复范围问题掩盖真正错误）：**

- 改为相关 BULL.HK 且缺 amount：两版都拒绝。
- 相关 BULL.HK、完整价格时间但 `stockName='HSBC HOLDINGS'` 无 ownership：两版都拒绝，current 明确报 captured 席位归属冲突，develop 在 Daily 报相关成交不可归属。
- **反对只保留 relatedSymbols 的过窄修复：**OTHER.HK 不在席位 related 集，但名称 HSI RC 明确归本系统；先买 10×2、后卖 10×1 的当日订单，在两版真实 Daily 上均得到 loss=-10。筛掉这类离席位的自有历史经济事实会改变风险业务，不能作为修复。

**runtime path：**`src/app/runtime/createPostGateRuntime.ts:470–502` 注入同一 recorder/Daily/snapshot 到真实 activation；activation `:563–565` 仅捕获明确外部错误，内部 Error 原抛；`src/runtime/asyncProgram/monitorTaskProcessor/index.ts:85–88,102–108` 调 activate 并送 fatal；`queueRunner.ts:60–65,102–104` 先停调度；`src/runtime/lifecycle/terminationRuntime.ts:33–44,48–58` 锁存 fatal 并关闭交易/producer 准入。错误分类本身不应改成吞错或局部 retry。

**impact：confirmed（条件性逻辑回归与队列全局 fatal）**——本系统范围之外的港股手工历史数据成为所有启动/换标可用性的硬前提。未发现坏数据已发布、半记账或错误交易；生产输入发生率仍未验证。

**minimal fix：**在完整经济归一之前按原 consumer 规则确定范围；至少排除“无 ownership、非相关、无 pending/保护性/durable 消费义务”的普通终态观察，同时保留：相关标的（即便不可归属也必须报错）、本监控**按原有效成交选择规则确需计算 Daily 的经济事实**（不局限当前席位）、已知事实 owner/待恢复 pending、durable 引用和保护性事实。不能简单用“名字能匹配 ownership”代替原先的有效成交选择：原 Daily 会先排除无有效成交价/量的非目标观察；下节另有同根实测。但若该单本就属于相关目标、known、pending 或 durable 义务，仍不得借此绕开完整性校验。启动与 runtime 用同一口径，不能只补 activation。不要把所有 null amount 写成 0、借 known 金额/均价补洞、默认归属，亦不要取消真正获选事实的完整性门禁。

**测试缺口：**`tests/application/seatActivation/executionNormalizationFailure.business.test.ts:21–33,38–104` 正确覆盖相关 BULL.HK 缺金额阻断；`tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts:1875–1918` 正确覆盖保护性/需恢复正成交 null amount。两者均不足以覆盖非 HK 过滤之后仍存在的 **HK 非系统终态**，应加入本例、完整手工单对照、related/unowned 拒绝及 owned-but-outside-related 的 -10 日损控制。

#### 5. 同根残留的有界核查（不再另加独立 finding 数量）

| 直接边界 | 裁决及证据 | 验证边界 |
| --- | --- | --- |
| 同来源择新之前的旧观察 | **confirmed**。today 数组依次含缺价旧 PartialFilled 和完整更新 Filled，同 ID；develop 留下完整新观察，current 在 mapper 拒绝。位置仍为 snapshot adapter `:142–153`、snapshot policy `:38–40,75–91`。 | 是 INF-C1 的直接同根补例；不声称检查了任意字段畸形组合。 |
| 非系统 HK 终态缺 revision | **confirmed**。00005.HK/HSBC HOLDINGS 完整价格、`updatedAt=null`，ownership=null；develop 真实 activation ACTIVE，current 在 history mapper 失败，甚至到不了 C3 normalize。 | 只改 application 的 related filter 仍残留此上游路径；位置 mapper `:107–109`。 |
| 名称可归属但非 related 的缺价终态 | **confirmed**。OTHER.HK/HSI RC、非席位、无 known/pending/durable 引用，正量但 executedPrice=null：develop 真实 activation ACTIVE、Daily loss=0，current 在全量 normalize 失败。原 Daily `src/core/riskController/dailyLossTracker.ts:648–656` 在 ownership 解析前就用 hasValidExecution 排除该观察；它并非原 owner 真正选入的经济事实。 | 同根选择顺序残留，不新增计数；与完整 OTHER.HK 往返日损=-10 的控制必须同时保护。不能笼统说“所有可归属单都必须在全账户 mapper 完整校验”，也不能反过来忽略相关/known/durable 错误。 |
| 运行期 untracked/no-known HK 推送在丢弃前完整映射 | **confirmed（同根旁支）**。current `orderMapper.ts:147–164` 用同 mapper；`orderMonitor/index.ts:583–605` 先 decode，失败直接 fatal；而 current 自己在 `eventFlow.ts:95–100,210–215` 对无 tracked 且无 known 的单本应忽略，develop `src/core/trader/orderMonitor/eventFlow.ts:94–105` 亦忽略，原注册回调 `index.ts:444–456` 直送 eventFlow。独立运行 current 真实已注册 callback + Monitor + termination：①未知方向、Canceled、0 成交；②普通 untracked PartialFilled/5 缺价；均 fatal、两个准入关闭各 1 次；develop 真实 eventFlow 均忽略。 | SDK PushOrderChanged.updatedAt **非 nullable**（SDK `:1560`），因此两个推送反例都使用有效 Date，没有拿 query 的 nullable 类型冒充 push 类型。无跟踪普通终态缺价的对照两版都忽略、current 不 fatal，未扩大成“所有手工推送都会停机”。该旁支是单独实测，不是从 snapshot 推断。 |
| pending adapter 对 Unknown 的严格拒绝 | **rejected（作为新增回归）**。current `pendingOrdersAdapter.ts:41–46` 的拒绝虽先于最终 pending 过滤，但 develop `src/core/trader/orderCacheManager.ts:68–69,159–169` 同样先用严格集合验证全数组，原 `src/constants/index.ts:205–209` 只允许 Buy/Sell。 | 不得借 INF-C2 去放宽 pending API 的既有契约。未用非法小数/负数另造无证据候选。 |
| 单订单 detail 严格验证 | 本次**未发现已确认新增 scope 回归**。`orderDetailReadAdapter.ts:22–31` 已由指定 orderId 选定，必须验证身份、HK 和真实事实。 | 未宣称所有 detail 场景完全等价，也不建议放松 tracked/known/durable 引用订单；这些是真正获选事实。 |

**共享修复注意：**push 不能仅用“没有 tracked 就跳过”的补丁；current 已支持 tracking 关闭后仍由 recorder 保存 known 同 ID 的新 revision（`eventFlow.ts:99–208`），此类记录仍必须完整校验和合并。先选择 tracked/known/需恢复对象，再校验真正获选事实，不删除合法修订。snapshot 的 today 优先和 pending 恢复规则同样不能被省略。

## minor issues

None。没有把首审措辞、类型偏好或不可证明 dead code 单独列缺陷。

## positive findings

- current 保留精确 Decimal 原文、终态缺价显式 null、不造 0 金额的 mapper 设计是正确的；应纠正的是调用范围，而非削弱经济账不变量。
- 相关缺 amount、相关但不可归属、Unknown OPEN/正成交、坏的获选 today 在两版负向控制中都被拒绝，必须继续保留。
- 激活归一失败前没有 Daily/O 发布，finally retain 释放仍执行；真实 fatal 通道关闭全局准入。没有证据要求改成吞内部错误或无限重试。
- `OTHER.HK` 的 owned-but-not-related 日损=-10 对照证明，当前 Daily 的经济范围不能简单替换成席位 related 集。

## 独立验证与证据工件

目录：`C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`

1. **`audit-recheck-ingress.probe.cjs`**：独立编写只读内存源码加载器，`git show <fixedSHA>:<path>` → TypeScript `transpileModule` CommonJS，真实 longbridge 4.4.3 Decimal/枚举。执行两版真实 recorder/classifier/activation/loader；current 队列和 push 使用真实 Monitor/termination。仅 logger 替换为无写盘观察者，测试 harness 的 `bun:test` 注册禁用；计数 wrapper 透传原方法。风险、订阅、账户/持仓读端口为核验过的测试替身，不声称是完整实盘环境。加载 165 个模块是执行依赖数，**不当作人工深读覆盖数**。
2. **`audit-recheck-ingress.results.json`**：27 行记录=26 个场景+1 个 fixture 假设；所有场景期望和额外数量/金额/门禁断言通过。包括坏 today 不可回退、真正相关错误必须失败、owned outside related 日损=-10，以及 queue/push 全局 fatal 控制。
3. **`audit-recheck-ingress.probe.stdout.txt` / `.stderr.txt`**：最终探针 exit=0，stderr=0 字节；最终探针 SHA-256=`e68835ce7e22e66425fe07ba3f0d9b542821c31711b1ee5c983597d2054f23e7`。
4. **`audit-recheck-ingress.tests.txt`**：独立串行运行现有 5 文件，共 **102 pass / 0 fail / 364 expect() calls**。文件为 mapper、native snapshot read、domain classify、activation normalization failure、startup loader。测试全部通过与本次反例不矛盾：缺的是真实 ingress 组合/作用域用例，不是现有相关错误测试本身应删除。

复现探针（不需要 checkout、不生成仓库文件）：

```powershell
Set-Location C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020
bun ./audit-recheck-ingress.probe.cjs
```

现有测试由外部 TEMP cwd 运行并显式 preload 仓库 `tests/setup/testRuntime.ts`，`APP_LOG_ROOT_DIR` 指向本 TEMP 内 `audit-recheck-ingress-test-logs`，避免 tests/logs 等仓库写入；精确命令记录在 `.tests.txt`。探针与测试均离线，不创建真实 SDK context、不发实盘网络/交易请求。

## not assessed

- **生产外部事实：**未访问 broker、真实历史 Order/NAPI 实例或线上日志；SDK 声明并不保证所有跨字段组合实际出现。确认的是输入可达代码分支和 develop/current 的明确差异，不是已发生事故。history 与 today 两次读并非原子一致的生产概率、故障持续时间未量化。
- **完整启动/发布演练：**执行真实两版 loader 与关键 recorder/activation 链，部分外部端口/恢复辅助器为仓库 fixture；未运行完整生产 app，也未演练真实 durable 数据迁移、发布或回退。不把 loader 成功写成已完成生产恢复证明。全局 fatal 已另外由真实 queue/push/termination 验证，启动 fatal 分类也有源码直连证据。
- **七维范围：**implementation/project/types/tests/comments 已在本边界检查；dead code 未做全仓消费者排除，不列候选；simplification 仅建议共享选择边界，不做美化重构。未检查与本三项无直接关系的交易规则、其他配置差异或全部 SDK 字段组合。
- **status/type 契约：**未把 OrderStatus.Unknown、未来数值、坏 identity/remark、负数量/精度越界当作可忽略输入；没有证据要求放宽它们。

## recommended next actions

1. 主审将三候选登记为 **1 项 major 共享边界回归，3 个 confirmed 子场景**；保留同源重复、启动 sibling、上游缺 revision 和 untracked/no-known push 作为同根验收矩阵，不重复累计缺陷数。
2. 修复前先保留本差分控制：先按照原来源/版本和业务范围选择，再构造严格事实；坏获选 today 不回退，related/unowned、owned outside related、pending/durable/保护性不能丢。若方案选择在 raw ingress 过滤，必须证明不会破坏 today 优先和同 ID known 修订。
3. 给真实 snapshot ingress、runtime activation、startup loader 和直接 push 边界补组合测试；不要只改 domain 单测，也不要通过弱化 related 错误/金额/时间/归属校验使测试变绿。
4. 本轮不对 broker 发生频率作推定；未来生产历史对账应量化这些输入组合，并沿方案既定发布门禁处理，不以本次离线 confirmed 代替上线验证。
