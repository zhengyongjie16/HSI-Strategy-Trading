# G0 全量审计：总装配、跨链 wiring 与 ownership

## summary

- verdict：**G0 39/39 个生产文件已逐文件完成首审，未发现可由现有证据确认的现存行为漂移或 wiring 缺陷。**关键接缝另执行 9 个离线隔离探针，最终全部通过；这不是全仓等价性结论，也不是独立二审通过。
- scope：固定 SHA 的 app 装配、共享异步队列与 worker、businessEventProgram、入口、相关契约；沿必要真实消费者追至 snapshot/settlement/activation、order push/审计、startup/open rebuild、termination/cleanup。业务算法主体归对应链路代理，不重复声称全量主审。
- confidence：**medium**。G0 文件与实际连接证据充分；生产券商时序、完整统一测试与独立复核未由本代理完成。
- 行为基线：`6e239c8a128372bd9b2fb2d79464346792a5e81e`（develop = origin/develop = FETCH_HEAD）；被审计：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`（HEAD）。本文 `develop:` / `current:` 分别固定指此两 SHA，不引用活动分支未来值。
- 模型：本任务会话/活动进程已双证据确认为 `cliproxyapi/gpt-6.1-sol`、thinking `max`；PID 52792，会话 `c97d1070-6870-4893-afb7-d29f532e9af3.jsonl`，证据详见同目录 `audit-baseline-map.md` §1。没有用默认配置代替实际启动配置。
- 只读：没有修改仓库源、测试、配置或架构计划，没有切分支/reset/merge，没有启动 app、连接 SDK/实盘。只写本报告。隔离探针用 `bun --no-env-file --eval` 内存执行，不创建脚本或测试文件、不写 durable log、不构建。

## critical issues

未发现已确认缺陷。没有将 historical d2/2b 已修问题冒充当前 finding，也没有把未复核风险写成已发生事实。

## major issues

None。

## minor issues

None。不因行数、命名偏好或 G0 内部组装函数直接创建依赖而泛化报告结构违规；composition root 的真实职责已纳入判断。

## 1. 约束与裁决方法

已加载 `code-review`、`typescript-project-specifications`、`core-program-business-logic`、`lazy-senior-developer`、`context-mode` 及根 AGENTS。当前 business skill 仅作定位索引；任何旧语义结论均直接读 develop 源码。

指定计划的直接约束：

- `docs/architecture/architecture-refactoring-implementation-plan.md:33`：保持原业务/事实/生命周期/恢复语义，授权例外必须单列。
- `...plan.md:39`–`:47`、`:85`–`:88`：唯一 canonical snapshot owner；commit 不等于 business ready；旧 epoch/generation/版本不得覆盖或放行新事实。
- `...plan.md:69`–`:79`：行情/订单/系统时间分别推进；cancel ACK 不等于终态；ACTIVATING 完成准入才 ACTIVE；停交易仍可系统时间唤醒；清理保留原异构 stop/drain。
- `...plan.md:156`–`:165`：内部错误优先于过期处理，不得按 superseded 吞异常。
- `...plan.md:1249`：清理 dispatcher 先于 producer；只清原有延迟信号/待执行队列/warrant，不取消在途业务；dispatcher 内部错误 fatal。
- `...plan.md:1253`–`:1287`：运行期 activation 独立完成订单、Daily、配对 snapshot、持仓订阅、风险/名称/ACTIVE；**`:1283` 明确不调用 waitForFresh()**。不能把主审重点中的“snapshot→settlement ready→seat ACTIVE”误解为所有 activation 都新增全局 settlement 阻塞。

方法：先列 G0 全文件，再逐文件阅读 current 与 develop 对应实现/拆分 owner，追踪实际 import 消费、工厂创建、事件订阅、生命周期调用；对局部疑点回到原路径与计划做否证。AST 只用于核对生产 import/导出消费，不把静态存在当成运行时接线。

## 2. 真实总链路与初始状态

### 2.1 启动与初始状态没有拆出相互失配的副本

**current 路径**：`src/index.ts:15` → `app/runApp.ts:61` → shutdown 订阅 `:101` → prepare `:110` → strategy create `:113` → pre-gate `:126` → post-gate `:136` → startup snapshot `:152` → runtime/context 装配 → startup rebuild `:297` → runtime start `:327`。

**develop 对照**：`src/index.ts:15`（blob 完全相同，`212bb43b6ac4126a33694c5b46ff25f829b99032`）；`app/runApp.ts:49` 起原装配；`app/runAppDeps.ts:37` 的默认依赖清单。

- `current:src/app/runtime/createPostGateRuntime.ts:186`–`:210` 把旧 LastState 拆为独立 tradingTime/lifecycle/calendar/subscription 状态，默认值分别仍为 canTrade/isHalfDay/openProtection=null、currentDayKey=当日、ACTIVE/pending=false/tradingEnabled=true、已解析交易日缓存、空订阅集。
- 对照 `develop:src/app/runtime/createPostGateRuntime.ts:268`–`:290`，这些默认事实没有擅自变成 true/false 或丢失初始交易日。
- `current:src/app/runApp.ts:150`–`:151` 在真正 startup snapshot/rebuild 前显式关闭全局交易，保存原初始放行值；成功后只由 `runtime/lifecycle/startupRuntime.ts:21`–`:22` 恢复。失败分支不恢复。
- `tradingCalendarState`、riskChecker、symbolRegistry 与六个 trade 子实例都沿同一引用装配：`createPostGateRuntime.ts:229`、`:268`、`:300`、`:456`、`:497`；`createMonitorContext.ts:114`–`:149` 不重新创建第二浮亏 checker，calendar 用 getter 读取最新 map，不捕获旧 map。
- `current:src/app/runtime/createPreGateRuntime.ts:82`–`:103` 的 resolver 仅用于启动的一次查询。旧 `develop:src/app/lifecycle/rebuild.ts:22`–`:42` 含同日缓存；当前去掉该私有缓存不改变生产调用次数，因为 resolver 只由 pre-gate 创建后调用一次，运行期日历归另一 owner。不把“源码局部不同”直接列为可达行为漂移。

**触发场景/影响判断**：启动时交易日信息失败、午休/保护期开机、初始快照重试。现有连接可阻断普通交易并保留时间 owner；未证实字段副本不同步。最小修复方向：无需当前修改；后续若新增字段，应接入既有状态 owner，而不是新增镜像。

### 2.2 构造环在副作用前完整绑定

- `current:src/app/runtime/createPostGateRuntime.ts:82`–`:103` single-assignment binding 禁止未绑定读取和重复绑定。
- snapshot 的 account/positions readPort 延迟读 tradeRuntimeBinding（`:238`–`:241`）；tradeRuntime 在 `:328` 绑定。
- settlement 的 pending-protective reader 同样延迟取真实 orderMonitor（`:273`）；positions hook 延迟取 quoteSubscriptionRuntime（`:275`–`:277`）；quote runtime 在 `:429` 绑定。
- 业务依赖在 `:497`–`:503` 绑定完成，早于任何 startup `loadTradingDayRuntimeSnapshot` 和 start。`createTradeRuntime.ts:20`–`:139` 只创建子实例，不自行初始化 Private 订阅或启动执行。
- develop 原有 traderBinding/quote binding/settlement 关系见 `app/runtime/createPostGateRuntime.ts:303`–`:318`、`:338`–`:362`、`:475`–`:481`。当前不是双实例交叉读取，也没有为了拆 facade 提早运行未绑定 callback。

## 3. 事件注册顺序、唤醒与共享异步处理

### 3.1 私有订单事实与审计 listener

**真实顺序**：

1. `current:src/app/runtime/createTradeRuntime.ts:74`–`:110` 创建 orderPushPort/orderRecorder/orderMonitor，未订阅。
2. `current:src/app/runtime/createPostGateRuntime.ts:438`–`:452` 注册同步 audit listener，并立即登记 disposer。
3. `current:src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:412` 才调用 `orderMonitor.initialize()`。
4. `current:src/application/orderTracking/orderMonitor/index.ts:619`–`:624` 先 `setOnOrderChanged`，再 await subscribePrivate。
5. 初始化/恢复阶段事件走 BOOTSTRAPPING buffer；恢复 owner 才重放至 ACTIVE，不能因 logger/listener 注册晚而吞掉 startup 成交。

**develop 对照**：`app/runtime/createPostGateRuntime.ts:443`–`:458` 同步持久化 callback 在后续加载器前安装；`core/trader/index.ts:44`–`:47` 明确工厂不执行 WS 初始化/恢复；旧状态机/恢复主体归 order-execution 链审计。

**持久化语义**：`current:src/runtime/orderTradeAuditListener/index.ts:14`–`:24` 同步 audit；异常先 `reportFatalError` 再原样 throw。`application/orderTracking/tradeAudit/index.ts:87`–`:94` 同步 append，保留精确 price 文本/整数数量，不借此提交 protective completion。对照 `develop:src/app/runtime/createPostGateRuntime.ts:181`–`:195`、`:443`–`:453` 的原同步 append/fatal 边界。

**实际探针 A1/A2**：同步事件调用栈内 append 在返回后标记前完成；disposer 后再发事件不写；append 抛同一对象时门禁同步关闭且原对象同时进入 fatal 与调用方。均通过。没有真实落盘，不声称已演练损坏日志恢复。

### 3.2 初始积压、在途新增、延迟重试与丢失唤醒

- trade worker：`current:src/runtime/asyncProgram/processor.ts:97`–`:108` 先注册 onTaskAdded 再显式调度已有积压；`:62`–`:87` 以 inFlight/immediate 双门单飞，finally 清 inFlight 后重扫。对照 `develop:src/main/asyncProgram/utils.ts:109`–`:249`，只是从共享 utils 拆出 worker/notification，没有改变 FIFO 为 latest-only。
- monitor queue runner：`current:src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:73`–`:107`、`:116`–`:129` 同样“注册+首次调度+finally 重扫”；对照 develop 同路径 `main/asyncProgram/monitorTaskProcessor/queueRunner.ts:74`–`:137`。
- trade queue `current:.../tradeTaskQueue/index.ts:92`–`:110` 在真实 mutation 完成后通知；monitor queue `current:.../monitorTaskQueue/index.ts:159`–`:192` 用同 key latest 替换，其他有效任务仍 FIFO，未改成全队列 latest-only。
- monitor retry 的 timer owner 在 `current:src/runtime/asyncProgram/monitorTaskProcessor/index.ts:31`–`:57` 用 dedupeKey→handle+isCurrent 授权，`:82`–`:88` 新任务接棒先清旧 timer；stop/drain/restart 都清 timers（`:124`–`:139`）。异常通过 queueRunner 停 scheduling 后 fatal，不继续消费剩余任务。
- 原一次外部失败重试/取消语义在 `develop:src/main/asyncProgram/monitorTaskProcessor/index.ts:141`–`:185`；现 worker 只消费 application 的 retry 结果，次数/EMPTY 归 activation owner，不形成第二业务判定者。

**实际探针 Q1–Q4**：

- start 前 A 积压；A 在途新增 B；结果 A/B 各一次，maxConcurrency=1。
- A 在途时 stopAndDrain；B 未偷跑；restart 后 B 恰好一次。
- A 抛错触发真实 termination；原错误保留，队列关闭，B/C 不执行。
- monitor 旧 retry callback 在新 seatVersion 任务已完成后被强制调用；不能覆盖新 owner，没有残留 timer。

四项通过。没有证实 lost wakeup、重复消费或终止后调度回生。诊断 observer 的异常均局部捕获，mutation/消费者通知不被诊断阻断（trade queue `:42`–`:77`，monitor queue `:81`–`:117`）。

### 3.3 普通行情 host/emitter

- `current:src/runtime/businessEventProgram/index.ts:108`–`:155` 保留 pending observed time、single-flight/latest-only 同步策略入口；`:126`–`:153` 按 monitor 与 period 过滤事件。
- `current:src/runtime/businessEventProgram/emissionAdapter.ts:21`–`:80` 先校验 decision/origin，再检查当前 day、普通门禁、ACTIVE symbol/seatVersion，最后白名单 push；内部错误同栈 fatal。
- 对照 `develop:src/main/businessEventProgram/index.ts:104`–`:154`、`emissionAdapter.ts:21`–`:80`，diff 仅改 ordinarySignalGuard 的状态源/类型路径，没有删原授权或新增 action。
- `projectCandlesticks` 不再投影 SDK period（current utils `:9`–`:20`；develop `main/businessEventProgram/utils.ts:9`–`:21`）。当前策略公共输入不含 SDK period，host 已在事件与 snapshot 查询端固定 CANDLE_PERIOD；没有可见消费者据此选择业务周期，属于边界收口而非策略数据源改动。

**评估**：businessEventProgram.start 不主动消费已有 candle snapshot、也不在 gate 恢复自动制造新行情事件；这是 develop 已有语义，不作为本次丢失唤醒 finding。指标/策略内部采样正确性由 market-strategy 主审。

## 4. snapshot、settlement ready、席位 ACTIVE 的真实 owner 边界

### 4.1 启动/开盘路径：必须先完整 baseline 与 ready，再开全局交易

- root 在 `current:src/app/runApp.ts:150`–`:151` 关闭全局门禁。
- `application/tradingDayRebuild/startupRebuild.ts:45`–`:89` 使用 captured snapshotToken，重建 COMMITTED 后核对原 token，不接受 owner 换票。
- `:67` await 全部订阅对账；`:70`–`:77` reset/start settlement、completeRebuildBaseline，再 await ready；`:80`–`:88` 要求同一 captured token、当前 snapshot 与当前 S receipt 都成立。
- `runtime/lifecycle/startupRuntime.ts:21`–`:42` 仅当 COMMITTED 时恢复原交易状态、按固定顺序启动普通 runtime；先 cleanupDispatcher，再 activation/auto-search/periodic producer，再 processor/订单 route；初始系统时间 evaluate 必须 await，最后才启动普通 businessEventProgram。
- 对照 develop `app/runApp.ts:284`–`:335`：旧代码初次重建后 start/complete baseline/reconcile，再各 runtime→time evaluate→business。当前把原完成条件显式化并加强 receipt，而非把 raw read 当 ready。
- startup 快照 API_RETRY_PENDING 或重建外错保持 pending，`startupRuntime.ts:39` 仍启动系统时间，普通 runtime 不启动。探针 S1/S2 实际验证了该接线。
- open rebuild 的 app 组装在 `current:src/app/lifecycle/createLifecycleRuntime.ts:144`–`:159`；source、snapshot、S/quote 能力由相同实例注入。受控重建与运行期 activation 是不同路径，不能机械共享一个 ACTIVE 入口。

### 4.2 稳态 settlement：commit 不提前 ready，跨 await 追当前 revision

- `current:src/app/runtime/createPostTradeConsistencyRuntime.ts:16`–`:27` 返回唯一 application workflow，positions callback 是 await 的 quote reconciliation，不持有第二 pump/ready。
- business mapping `:34`–`:66` 将同一 seats、episodes、completionPersistence、dailyLoss boundary、cooldown 与 riskProjection 注入；没有 facade 自行判定空仓、append completion 或提交第二份内存状态。
- `current:src/application/postTradeSettlement/index.ts:442`–`:479` 在 callback await 前捕获 token/双方向版本；之后检查 target settlementVersion、work admission、snapshot current；旧 revision 则继续准备，不用回调参数当 current view。
- `current:src/runtime/quoteSubscriptionRuntime/index.ts:389`–`:395` 明确仅按当前事实串行对账；token 不是旧期待集合授权。
- `current:src/application/postTradeSettlement/readinessGate.ts:91`–`:103` 的 receipt 是 settlement 完成水位，普通 snapshot commitRevision 变化不等于新成交；消费者仍须独立复核本次选单 snapshot。这与方案“snapshot commit ≠ ready”不矛盾，不能把 receipt 误当所有未来快照 revision 的租约。
- 对照 `develop:src/app/runtime/createPostTradeConsistencyRuntime.ts:412`–`:459`、`:570`–`:679` 的原提交/订阅/风险/markFresh 顺序；当前把 weak Promise<void> ready 改为带 token 的能力，不另造业务账。

**实际探针 R1**：真实 snapshot owner 与真实 app settlement mapping，首次 commit=r1 后阻塞 onPositionsCommitted；等待方不得 ready。期间另一 `SEAT_ACTIVATION` 配对 commit=r2，不登记第二 settlement need；释放 hook 后实际调用 hook 两次，只发布 revision=2 风险投影，readyToken=2，fatal=0。证明本条接缝没有在 r1 回调晚返回后签旧 ready。

### 4.3 运行期 activation：独立 barrier，不新增全局 settlement 等待

- `current:src/app/runtime/createPostGateRuntime.ts:470`–`:495` 给 activation 注入相同 snapshot/quote/orders/daily/risk，**没有把它接到 waitForFresh()**。
- `application/seatActivation/index.ts:408`–`:435` 使用 SEAT_ACTIVATION 配对 refresh，之后以当前 view/token 重检并 await 持仓订阅；`:437`–`:487` 同步发布风险→条件清旧本地单→warrant/name→ACTIVE；finally 完整 release。
- `createAsyncRuntime.ts:67`–`:73` 的 canProcessTask 只要求 lifecycle enabled+非终止，连续交易门禁不被新加为 activation 取消条件。periodic task 另用 ordinary gate，职责不混。
- **develop 实际原路径**：`main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:318`–`:364` 读订单/日损/refresh account，`:426`–`:428` ACTIVE；`helpers/refreshHelpers.ts:49`–`:61` 刷新账户持仓后 await quote reconciliation；没有要求全局 post-trade waitForFresh。
- 计划 `:1283` 明确维持此隔离。因此“activation 没有注入 S fresh”这一初始疑点已排除，不作为缺陷，也不建议最小修复去增加全局等待。

## 5. partial startup → fatal → drain

### 5.1 acquired resource 总由唯一 cleanup 接管

- `current:src/app/runApp.ts:101`–`:106` 首次外部资源前安装 shutdown 并登记 disposer；strategy create 在 `startup/createSelectedStrategy.ts:36`–`:49` 先登记可清理 destroy，再做完整端口/identity 检查（与 develop 同源码逻辑）。
- pre-gate seat diagnostic 在 `createPreGateRuntime.ts:43`–`:56` 仅被动诊断且先登记 stop；market client acquisition await 返回后即登记 reset（`:73`–`:78`），再检查终止。
- post-gate tradeRuntime acquisition await 后先 bind+登记 orderMonitor drain、Private teardown（`:328`–`:338`），之后才 termination guard（`:341`）。终止期间迟到取得的 owner 不会因提早 return 漏清理。
- root 资源槽保存真实晚到实例；`runApp.ts:67`–`:94` 同步关交易/admission/producer，而 cleanup 等 `assembleAndRun()` 返回或失败后才开始（`:356`–`:364`）。不在 acquisition await 未落定时抢先执行固定清单。
- `current:src/app/shutdown/createCleanup.ts:29`–`:35` 禁止 execute 开始后继续登记；`:44`–`:61` 固定 phase+sequence 排序，单 handler 失败仍执行后续；`:71`–`:75` 汇总 AggregateError。
- develop 具有相同 acquired-resource 与 cleanup owner，见 `app/runtime/createPostGateRuntime.ts:338`–`:375`、`app/shutdown/createCleanup.ts:23`–`:99`、`app/runApp.ts` 终止段。当前新增 snapshot 生命周期能力不是第二 cleanup owner。

### 5.2 同步 termination 与最终异构 drain 不倒置

- `current:src/runtime/lifecycle/terminationRuntime.ts:32`–`:44` 标记终止→closeTradingGate→closeProducerAdmission→逐个 stop；`:48`–`:57` 保留首 fatal，对次错仅报告，不覆盖原对象。对照 `develop:src/app/runtime/createTerminationRuntime.ts:32`–`:57`，主体相同。
- `current:src/app/runtime/createPostGateRuntime.ts:245`–`:265` 同步开始 snapshot STOP/关闭 admission，真实 Promise 保存至后续 snapshot drain phase。
- `current:src/constants/cleanup.ts:9`–`:34`：abort freshness(10)→time/business/risk/quote/switch/producer/processor drains→order runtime(160)→audit listener unsubscribe(170)→Private teardown(175)→settlement(180)→snapshot issued drain(185)→quote subscription(190)→strategy destroy(200)→diagnostic unsubscribe(210)→market reset(230)。旧 phase 相对顺序见 develop 同文件 `:9`–`:32`；只插入新增 owner 必要位置。
- `current:src/application/orderTracking/orderMonitor/index.ts:649`–`:663` final teardown 等 initializationPromise，且只对真正成功 Private subscribe 退订；stopRuntime `:690`–`:702` 先停止事实入口/清 boot buffer，再 await route 与 public op。
- `current:src/application/postTradeSettlement/index.ts:690`–`:704` 包含自身 inFlight 和 snapshot.waitForIssuedDrain；quote 仍可让既 issued 的 caller 收口，直到最后 quote.stopAndDrain 才关准入。不能把“snapshot 请求关闭先发生”误报为“省略 issued drain”。
- `current:src/app/runApp.ts:365`–`:373` cleanup 错误不替换原 fatal；正常 shutdown 的 cleanup failure 则原样向外暴露。

**场景/影响判断**：market client acquisition、trade runtime acquisition、Private subscribe、startup refresh、rebuild、initial time evaluate 任一步挂起时发生 fatal/shutdown；当前真实接线可等待 acquired owner 落定并正常清理，不证实漏 disposer/终止后重新交易。SDK 未提供 native context 强制取消/关闭合同，不能把等待真实悬挂请求与“代码应当超时强杀”混为一谈。

## 6. 隔离动态验证（本代理实际执行）

所有探针均使用安装的 Bun **v1.4.2**、`bun --no-env-file --eval <内存脚本>`；只导入上述纯 owner/队列/映射，注入内存 I/O/timer/logger，无 SDK、无 app 启动、无 filesystem mutation。未与 validation 代理争用构建或测试输出目录。

| ID | 实际观察 | 结果 |
| --- | --- | --- |
| Q1 | trade queue start 前积压 A；A 在途 push B；A/B 一次，最大并发 1 | pass |
| Q2 | stopAndDrain 等 A，不消费 B；restart 后 B 一次 | pass |
| Q3 | A 抛原对象；真实 termination 关队列，B/C 不执行、fatal identity 不变 | pass |
| Q4 | 新 activation version 接棒后强制执行旧 timer callback，不产生旧任务/残留 timer | pass |
| S1 | startup cleanup dispatcher 先于 producer；businessEventProgram 等 initial time evaluate 完成 | pass |
| S2 | initialRebuildSucceeded=false 仅启动 time wakeup，tradingEnabled 仍 false | pass |
| A1 | 同步审计 append 顺序/精确文本/注销 listener | pass |
| A2 | append 抛错，真实 termination 同栈关门，调用方收到同一原错误 | pass |
| R1 | r1 hook 等待期间 r2 commit；hook=2，published=[2]，readyRevision=2，fatal=0 | pass |

**失败尝试如实记录**：R1 首次探针错误注入 `account=null`，被 snapshot 不变量拒绝；第二次把同一个 symbol 同时注入 LONG/SHORT，被 settlement binding 唯一归属校验拒绝。两次均 exit 1，属于探针 fixture 非法，不是仓库缺陷；改成合法 AccountSnapshot 与 SHORT EMPTY 后第三次 exit 0。没有把失败尝试隐藏成一次成功，也没有对源码加补丁。

本报告的动态结果不是本仓库完整 tests/type-check/build 结果；统一门禁由 validation 代理负责。

## 7. 现有测试证据与独立复核清单

本代理阅读并定位下列实际场景，但**没有宣称本轮执行了这些测试文件**：

- `tests/app/runApp.business.test.ts:717`、`:736`、`:751`：validation/snapshot/wiring 失败已取得资源清理；`:786`、`:821`：pending/rebuild API fail 只 time；`:910`、`:932`：initial time fatal/await；`:984`、`:1029`、`:1053`：late acquire 与错误身份。
- `tests/app/runAppTerminationMatrix.business.test.ts:296`、`:367`、`:396`、`:408`：真实 post-gate ownership 的 pending/fatal/shutdown 矩阵。
- `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts:203`、`:260`、`:315`、`:327`、`:363`、`:457`、`:489`、`:506`：六实例/四状态身份、positions hook、共享 checker、失败前 disposer、同步审计、不把 trade record 当 completion、统一 termination。
- `tests/app/runtime/postTradeSnapshotAuthorization.test.ts:20`：app capability mapping r10→r11 授权追赶。
- `tests/app/runtime/createAsyncRuntime.wiring.test.ts:251`、`:287`、`:364`、`:439`：periodic skipped/blocked/外错/内错接线。
- `tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts:410`、`:470`：固定 cache domain 顺序与 open owner。
- `tests/integration/startupSettlementReadiness.integration.test.ts:36`、`:100`、`:206`、`:253`：baseline superseded/外错不偷开普通 S retry、真实 async barrier。
- `tests/integration/rebuildSettlementReadiness.integration.test.ts:411`、`:444`、`:498`、`:539`：日切/新成交/外错后 S/quote readiness。
- `tests/integration/accountPositionConsistency/settlementSourceRegistration.test.ts:19`：受控覆盖不伪造 stale，在线事实同步登记。
- `tests/integration/activationAdmissionRecovery.integration.test.ts:261`、`:367`、`:423`、`:464`：activation 外错局部重试、串行命令 ownership、内部错误 fatal、普通 hold event 外错仍 fatal。

### 待统一二次独立复核的关键结论（不是当前 defect candidates）

1. lifecycle reviewer：startup/open captured token、initial time evaluate 及失败时 only-time 的结论，从 develop 与真实 owner 复核；不要只检查 mocked start 调用次数。
2. order-execution reviewer：audit 注册早于 initialize；boot buffer/replay/terminal 发事件顺序；order runtime drain 后 audit unsubscribe、再 Private teardown；同步持久化错误不能吞。
3. risk-account reviewer：同一 daily/episode/completion/risk 实例映射，r1→r2 期间只当前 projection/ready；receipt 不是未来所有 revision 租约。
4. seat-selection reviewer：运行期 activation 故意不 await 全局 S；完整 receipt/订阅/风险/ACTIVE 局部 barrier 与旧 previousSymbol 归属不丢失；raw target positions 的严格契约由真实卖出读取/执行边界保证，不以宽 account display 口径替代。
5. market-strategy reviewer：business host/remapped state 是同一引用；事件 period 过滤后删 SDK period 投影不改变策略输入；初始 snapshot 不合成新 candle 事件是 develop 行为。
6. validation reviewer：统一运行 relevant tests 与全套门禁；9 个探针只作补充，不能替代真实 recovery fixtures 和跨日集成。

目前没有需要最小修复的已证实根因；不提出“给所有 activation 加 waitForFresh”“所有 runtime start 都自动 seed candle”“给每个 owner 统一 wrapper”之类会改变业务语义的修复。

## positive findings

1. **单实例 identity 与状态所有权**：G0 拆宽 facade 时直接返回/注入六个真实 trade 子实例；canonical snapshot 的私有 store 没有经 LastState 镜像泄漏，日历 getter 保持实时引用。
2. **早注册、晚排空**：shutdown 在 acquisition 前注册；partial acquire disposer 在 guard return 前登记；审计早于 Private subscription；最终 unsubscribe 晚于订单 drain。
3. **授权而非时间猜测**：epoch/generation/seat/settlement token 在 await 后逐层重检，positions callback 不用迟到 token 重放旧期待集合；R1 探针验证当前 app mapping。
4. **队列不丢唤醒且保留业务策略**：已有积压显式唤醒，inFlight finally 重扫；trade FIFO 与 monitor per-key latest 分离；diagnostics 不进入业务失败路径。
5. **没有把同步 stop 当作 drain**：termination 立即关闭放行，root 等装配落定后按 heterogenous phase drain；首 fatal 保留，cleanup 汇总不覆盖。

## 8. 七维审查结论

| 维度 | G0 检查结果/边界 |
| --- | --- |
| implementation | 已覆盖初始化、事件注册、所有 G0 工厂消费者、queue/worker、startup/cleanup、直接 snapshot/S/activation 接缝；未发现已确认缺陷 |
| project/spec | 已按固定 plan/skills 审约束；明确区分运行期 activation 与受控 rebuild，避免无授权“统一”完成门禁；SDK 只在 adapter，不由 G0 业务直接泄漏 |
| type design | 39 文件中的全部类型文件逐一检查，资源槽可变边界只在装配期；runtime 事实/ports 不再依赖宽 Trader；静态类型不能代替 run-time token 校验，相关校验保留 |
| tests | 阅读实际场景与 test wiring，另执行 9 个内存隔离探针；完整运行/覆盖率由 validation 代理，未擅自声称全套通过 |
| comments | 核对 G0 关键流程注释与实际路径；少量历史 lastState/trader 名称仅作描述残留，未把它们包装为影响行为的 finding；没有无证据风格项 |
| dead code | 使用 TypeScript AST 核对全部生产 import；26 个有运行时导出的 G0 模块均有实际生产消费者，未发现无消费者 runtime 导出；外部/dynamic 策略模块边界不作直接删除结论 |
| simplification | 工厂根有意保留 composition mapping、异构 drain；没有提出不增益 wrapper/全局 registry/统一 worker 业务 policy；不将可少几行当作缺陷 |

## not assessed

- 本报告属于首审证据。没有由另一独立代理对本报告结论完成正式二审；主代理应交叉分派 §7 关键结论。自查和探针不冒充独立二审。
- 五条业务链算法主体、Longbridge enum/错误/金融 mapper 完整等价性、durable V1 schema 与所有文本恢复规则不归 G0 全量主责；本报告只审直接消费接缝。
- 没有启动 app，没有真实 broker native context，也未模拟所有任意长时间网络挂起；SDK 不提供强制取消合同的实盘行为不可离线保证。
- 没有本轮统一 tests/type-check/build/format/lint 结果或真实覆盖率数字；已交 validation。
- 没有真实 V1 历史与权威订单逐条对账、生产发布/回退完整恢复。
- “没有已确认缺陷”不等于所有并发调度组合都已穷举；尤其 quote/start 期间只读投影追赶、跨日重建与迟到事实需结合其他链路证据闭合。

## recommended next actions

1. 由各主责 reviewer 独立复核 §7 的跨链结论；若其发现候选，必须同时给 develop/current 行号、可达场景和最小根因，再作统一二审。
2. validation 纳入列出的 app/termination/readiness/activation 集成测试，并以其实际本轮输出为最终门禁证据；不得用历史计划数字替代。
3. 汇总覆盖时将附录 G0 39 文件标为“首审完成、跨链接缝已追踪、独立二审/统一动态门禁待汇总”，不要标成全仓等价性通过。

## 附录 A：G0 39/39 覆盖账本

下表每行一个 current 生产文件。行号为真实符号/契约锚点；同文件其余分支与消费者已阅读。类型迁移允许多来源，表内列最相关 develop 定义，不声称一个旧文件只映射一个新文件。

| # | current 文件与锚点 | develop 对照 | 检查点/验证 |
| --: | --- | --- | --- |
| 1 | `src/app/context/createMonitorContext.ts:92,111` | `src/app/context/createMonitorContext.ts:88,107` | 唯一 context/checker、名称派生、seat switch 窄能力、实时日历 getter |
| 2 | `src/app/context/types.ts:22,40,58` | `src/types/state.ts:77`；`src/app/types.ts:252` | assembly 与业务 ports/名称可变边界 |
| 3 | `src/app/lifecycle/createLifecycleRuntime.ts:38,169` | `src/app/lifecycle/createLifecycleRuntime.ts:37,153` | 六 cache domain 顺序、共享 owner、open rebuild 注入 |
| 4 | `src/app/lifecycle/types.ts:29,47` | `src/app/types.ts:570,586` | factories/实例契约，无运行时代码 |
| 5 | `src/app/runApp.ts:61,101,150,297,327,356` | `src/app/runApp.ts:49,74,288,317,339` | acquire/门禁/startup/时间/终止，S1/S2 |
| 6 | `src/app/runAppDeps.ts:28,38` | `src/app/runAppDeps.ts:27,37` | 生产协作者唯一默认注册、shutdown before acquisition |
| 7 | `src/app/runtime/createAsyncRuntime.ts:22,56,67,86,103` | `src/app/runtime/createAsyncRuntime.ts:21` | ordinary/activation/periodic 不同 gate，唯一 worker，disposer |
| 8 | `src/app/runtime/createPostGateRuntime.ts:121,186,229,268,300,438,470,497` | `src/app/runtime/createPostGateRuntime.ts:220,268,310,338,443,475` | 全依赖 identity、snapshot/审计/业务绑定顺序 |
| 9 | `src/app/runtime/createPostGateRuntimeDeps.ts:6` | `src/app/runtime/createPostGateRuntimeDeps.ts:6` | 六实例工厂、context/repository 定义消费者 |
| 10 | `src/app/runtime/createPostTradeConsistencyRuntime.ts:13,16,34` | `src/app/runtime/createPostTradeConsistencyRuntime.ts:299,323` | 纯 mapping，无第二 S pump/completion；R1 |
| 11 | `src/app/runtime/createPreGateRuntime.ts:34,43,64,73,82` | `src/app/runtime/createPreGateRuntime.ts:36,52,60` | config/strategy/SDK 前置顺序、晚 acquisition 清理 |
| 12 | `src/app/runtime/createPreGateRuntimeDeps.ts:4` | `src/app/runtime/createPreGateRuntimeDeps.ts:5` | broker factory 唯一默认依赖 |
| 13 | `src/app/runtime/createTradeRuntime.ts:20,50,74,85,113,132` | `src/core/trader/index.ts:51,78,89,98,119` | 一个 broker、六真实实例，构造不隐式 start |
| 14 | `src/app/runtime/types.ts:46,60,114,143,163,195` | `src/core/trader/types.ts:1`；`src/app/types.ts:520` | 子实例聚合仅 app 内部，S ports 精确能力 |
| 15 | `src/app/shutdown/createCleanup.ts:23,29,44,82` | `src/app/shutdown/createCleanup.ts:23,29,44,82` | 固定 phase/sequence、继续清理、幂等 execute |
| 16 | `src/app/shutdown/types.ts:9,20,32,43` | `src/app/types.ts:270` | cleanup owner/step/failure 契约 |
| 17 | `src/app/startup/createSelectedStrategy.ts:31,36,49` | `src/app/startup/createSelectedStrategy.ts:31` | destroy 先登记再完整契约验证，单实例 |
| 18 | `src/app/startup/prepareStrategy.ts:39,55,65` | `src/app/startup/prepareStrategy.ts:39,55,65` | 仅选中策略 import/prepare，目录迁移符合计划 |
| 19 | `src/app/startup/runtimeValidation.ts:66` | `src/app/startup/runtimeValidation.ts:66` | 监控/seat/position 验证、去重/required 保留 |
| 20 | `src/app/startup/strategyLoaderHelpers.ts:17,57,101,133` | `src/app/startup/strategyLoaderHelpers.ts:17,38,94,126` | 精确路径、链接拒绝、同步契约、错误 cause |
| 21 | `src/app/startup/tradingDayInfoResolver.ts:14,19` | `src/app/lifecycle/rebuild.ts:22,28` | 生产单次 resolver；去无消费者缓存不变行为 |
| 22 | `src/app/startup/types.ts:17,35,52,82` | `src/app/startup/types.ts:11,29`；`src/app/types.ts:191` | FS/selection/validation/trading-day 事实类型 |
| 23 | `src/app/types.ts:103,158,193,233` | `src/app/types.ts:97,601`；`src/types/state.ts:77` | root 工厂契约/稳定状态/晚到资源槽 |
| 24 | `src/application/types.ts:2,10` | `src/utils/quoteRetry/types.ts:37` | quoteRetry 参数结果，共享消费者存在 |
| 25 | `src/index.ts:15` | `src/index.ts:15` | 同 blob；error/exit 不漂移（未执行入口） |
| 26 | `src/runtime/asyncProgram/monitorTaskProcessor/index.ts:16,31,66,114` | `src/main/asyncProgram/monitorTaskProcessor/index.ts:66,141` | application retry 指令、当前身份、关门/stop；Q4 |
| 27 | `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:23,73,116,142` | `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:24,82,125` | single-flight、初始积压、finally 重扫、drain |
| 28 | `src/runtime/asyncProgram/monitorTaskProcessor/types.ts:12,18,37` | `src/main/asyncProgram/monitorTaskProcessor/types.ts:70,109` | task→owner 结果、仅两种 task、dayEpoch 能力 |
| 29 | `src/runtime/asyncProgram/monitorTaskQueue/index.ts:69,159,194,269` | `src/main/asyncProgram/monitorTaskQueue/index.ts:57` | per-key latest、有效 FIFO、close/回调、observer 旁路；Q4 |
| 30 | `src/runtime/asyncProgram/monitorTaskQueue/types.ts:7,14,65,87` | `src/main/asyncProgram/monitorTaskQueue/types.ts:49,71` | discriminated task/私有诊断 metadata/queue 契约 |
| 31 | `src/runtime/asyncProgram/processor.ts:13,43,62,97,128` | `src/main/asyncProgram/utils.ts:109,138,157,192,225` | FIFO、gate、单飞、fatal、stop/drain/restart；Q1/Q2/Q3 |
| 32 | `src/runtime/asyncProgram/taskNotifications.ts:8,13` | `src/main/asyncProgram/utils.ts:75,88` | notify/register/unregister 顺序等价，生产 queue 消费 |
| 33 | `src/runtime/asyncProgram/tradeTaskQueue/index.ts:92,110,181,190` | `src/main/asyncProgram/tradeTaskQueue/index.ts:132` | FIFO/close/pop/remove/clear、diagnostic 无副作用；Q1/Q2/Q3 |
| 34 | `src/runtime/asyncProgram/tradeTaskQueue/types.ts:6,12,59,87` | `src/main/asyncProgram/tradeTaskQueue/types.ts:45,73` | 真实 signal 类型与队列私有 metadata 分离 |
| 35 | `src/runtime/asyncProgram/types.ts:11,31` | `src/main/asyncProgram/types.ts:10,30` | worker 合同/业务 processTask 注入 |
| 36 | `src/runtime/businessEventProgram/emissionAdapter.ts:11,21,41,53,73` | `src/main/businessEventProgram/emissionAdapter.ts:11,21,41,52,72` | origin/day/seatVersion/action admission，fatal |
| 37 | `src/runtime/businessEventProgram/index.ts:17,34,107,126,158` | `src/main/businessEventProgram/index.ts:17,34,104,125,157` | latest-only、权威 candle、strategy once、stop/drain |
| 38 | `src/runtime/businessEventProgram/types.ts:13,35,54,62` | `src/main/businessEventProgram/types.ts:10,32` | host contracts 与独立状态能力 |
| 39 | `src/runtime/businessEventProgram/utils.ts:9,27,38,52` | `src/main/businessEventProgram/utils.ts:9,28,39,53` | freeze snapshot、合法时间/dayKey、decision own-key 白名单 |

**覆盖核对：39 个唯一 current 文件，未遗漏；仅覆盖定位不等于独立二审或统一测试通过。**

## 附录 B：额外直接追踪的跨链生产边界

这些文件只做接缝所需审查，不代替其他主责代理全量覆盖：

- lifecycle：`runtime/lifecycle/{startupRuntime,terminationRuntime,cacheDomains/signalRuntimeDomain}.ts`；`application/tradingDayRebuild/{startupRebuild,openRebuild,startupSnapshot,loadTradingDayRuntimeSnapshot,rebuildTradingDayState}.ts`。
- risk/account：`application/accountPositionSnapshot/index.ts`、`application/postTradeSettlement/{index,readinessGate}.ts`；`runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`。
- seat：`application/seatActivation/index.ts`、`application/seatSwitch/{periodicSwitchTask,switchStateMachine}.ts`、`runtime/seatActivationDispatcher/index.ts`、`runtime/seatRuntimeCleanupDispatcher/index.ts`、`runtime/periodicSwitchWakeupRuntime/index.ts`、`runtime/autoSearchWakeupRuntime/index.ts`。
- order：`application/orderTracking/orderMonitor/{index,eventFlow}.ts`、`application/orderTracking/{orderHoldRegistry,tradeAudit/index}.ts`、`runtime/orderTradeAuditListener/index.ts`。
- market/infra：`runtime/quoteSubscriptionRuntime/index.ts`、`runtime/monitorQuoteEventRuntime/{switchWakeupRuntime,monitorQuoteEventRuntime}.ts`、`infrastructure/longbridge/trade/{brokerAccessAdapter,orderPushAdapter}.ts`、`constants/cleanup.ts`、`types/account.ts`。

## 附录 C：最终只读/覆盖核验

2026-10-20T12:37:45.214Z 再次核验：工作区仍干净，分支仍 `beta-V2`；HEAD/develop/origin-develop/FETCH_HEAD 仍为文首固定 SHA。机器从本报告覆盖表提取 39 个唯一 current 路径，与固定 HEAD 的 G0 规则生成结果逐项比较：expected=39、rows=39、unique=39、missing=[]、extra=[]。报告正文约 38 KB；未创建额外仓库文件或修改任何受审代码。

<!-- FINAL-READONLY-VERIFICATION -->
