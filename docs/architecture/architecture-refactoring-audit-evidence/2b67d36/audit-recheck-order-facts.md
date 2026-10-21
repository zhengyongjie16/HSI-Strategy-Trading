# OE-001 / OE-002 独立二审：在线经济投影与 closed-order 观察

## summary

- **verdict：OE-001 confirmed；OE-002 confirmed（必须按下述输入/lifecycle 边界表述）。** 已从两版真实源码独立追链，并自建同输入 Monitor/recorder/Daily 差分，不导入 G4 报告的 repro/helper，也不以当前测试 oracle 代替 develop 真值。
- baseline：`6e239c8a128372bd9b2fb2d79464346792a5e81e`；HEAD：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。原仓库与两版 TEMP 快照均未改动。
- **最终定向执行：Bun exit 0；6 pass / 0 fail / 149 expect；0.203s wall（Bun157ms）**。不是全量门禁，不重复计算旧门禁结果。
- **否证/收窄：**旧历史重建的严格 `<`/`>` 时间分区本来就存在；新缺陷是将此规则扩散到旧在线扣减路径。完整的**更旧 revision OPEN**未触发 fatal；**仍被 timeout route 持有的 terminal tracked order**也不触发本项 fatal。成本列表为空时 R1 **不一定为0**，因真实 Daily offset 仍可能非零。
- confidence：high，限于复现的状态/观察矩阵和实际经济消费者；未访问实盘，未测市场消息出现概率或真实损失金额。

## critical issues

### OE-001 — confirmed：在线 SELL 重算历史时间区间，遗漏同毫秒尚未卖出的 BUY

- **claim：**两笔已实际在线终态入账的 BUY，SELL 仅抵扣其中100股后，HEAD 可以把未被抵扣、与 SELL 同 broker `updatedAt` 毫秒的剩余 BUY 一并从经济列表移除。原始成交事实保留，不等于成本/可卖列表保留。
- **evidence / 根因位置：**
  - 当前 `src/application/orderTracking/orderMonitor/eventFlow.ts:394-403` → `settlementFlow.ts:353-388` → `recorder/index.ts:48-116`。在线 `commitExecutionFact` 的 `economicInputChanged` 调用 `projectRecords`，将全部已保留事实重新投影并替换 BUY 列表；`recorder/orderStorage.ts:147-156` 对空列表返回cost=null。
  - `src/domain/order/executionProjection.ts:163-205` 将在线 slices 交历史 `applyFilteringAlgorithm`；关联 ID 仅在过滤回调拿到的 `beforeSell` 中起作用，不能救回已在时间分区被遗漏的等时 BUY。
  - `src/domain/order/orderFilteringEngine.ts:62-70,94-105,126-129`：M0 要求 `BUY.time > lastSellTime`，旧区间要求 `< sellTime`，区间补入要求 `> sellTime`，故等时 BUY 不在任一区间。
  - develop 在线 `src/core/trader/orderMonitor/settlementFlow.ts:636-658`、`:106-121` → `src/core/orderRecorder/index.ts:263-283` → `orderStorage.ts:168-228`：从当前本地列表按可信关联 ID 或低价优先整笔扣减，不按 BUY/SELL 时间排除剩余记录。
- **明确不是新增的旧行为：**develop `src/core/orderRecorder/orderFilteringEngine.ts:83-93,112-116` 的历史重建已经严格分区，`index.ts:222-226` 调用它；两版真实 recorder 对同毫秒历史 batch 的重建均得到空列表。本项不能写成“重构新引入 `<`”，也不能无条件将全局历史边界改成 `<=`。

### 独立复现与经济后果

两版均真实 `createOrderMonitor + createOrderRecorder + DailyLossTracker`，相同 raw SDK `PushOrderChanged`（Decimal/枚举/Date），当前经真实 `mapBrokerOrderPush`，旧版原生入口直收 raw。没有伪造 executionTime/revision：当前 mapper `src/infrastructure/longbridge/trade/orderMapper.ts:133-139` 本来以正成交订单 `updatedAtMs` 作时间代理。

**正常 pending 关联场景：**B1 BUY100@1，T-100ms；B2 BUY100@2，T；然后真实 `selectSellableOrders(ALL,max100)` 选择 B1、`submitSellOrder` 登记 pending，再跟踪并接收 S Filled100@1.5，T。T=`2026-10-07T10:00:00+08:00`，同一 BULL.HK、普通 ELO、非保护性。不是必须省略正常 pending 关联才触发。

| 实际读取/计算 | develop | HEAD |
|---|---|---|
| S 前 BUY 经济数量 | 100 + 100 | 100 + 100 |
| S 后剩余 BUY | B2，100股，成本200 | 空列表 |
| 两版真实 Daily offset | -150 | -150 |
| 用真实 Daily offset 刷新风险 R1/N1 | 350 / 100 | 150 / 0 |
| 现价1、浮亏阈值50，真实 risk.check | `shouldLiquidate=true` | `false`（n1=0先返回） |
| 实际剩余 available100、现价3、智能平仓、timeout=null | quantity100 / shouldHold=false | quantity=null / shouldHold=true |

- 风险使用两版真实 `createUnrealizedLossChecker`，不是在探针复制公式。HEAD `src/domain/risk/unrealizedLossChecker.ts:18-35,65-83` 从唯一 recorder 成本取 N1；即使 R1 因日损偏移仍为150，N1=0 直接不触发。旧 `src/core/riskController/unrealizedLossChecker.ts:114-135,171-179` 使用剩余列表计算 R1/N1。
- 智能平仓使用两版正式 `resolveSellQuantityBySmartClose`，不是仅检查列表长度。HEAD `src/application/ordinarySell/quantitySelection.ts:137-182,242-248` 读取成本/可卖列表后 HOLD；真实 workflow `src/application/ordinarySell/index.ts:219-245` 对处理后的 HOLD 不调用 executor。
- 风险正式消费连接已核对：`src/domain/risk/index.ts:118-120` 直接暴露同一真实checker的prepare/publish/check；`src/app/runtime/createPostTradeConsistencyRuntime.ts:56-64` 绑定同一个 recorder；`src/application/postTradeSettlement/index.ts:226-240` 以真实 Daily offset prepare/publish。探针直接运行这些真实计算 owner，**未启动完整 PostTrade/snapshot 刷新或 app**，因此不声称全链实盘成交后刷新已端到端运行。
- **反证控制：**不登记 pending 关联的同毫秒场景也复现；把 SELL 时间单独改成 T+1ms 时，两版均保留 B2、数量100、成本200，真实风险/智能平仓一致。两版历史重建等时均空，证明是原在线路径行为扩散，不是历史旧边界的新发现。
- **impact：confirmed**——合法在线顺序下，经济成本/数量记录缺失，真实浮亏判断由触发变不触发、真实智能平仓由卖100变HOLD。**potential**——实盘剩余仓位保护或主动智能平仓被阻断。没有证明 broker 持仓被删、发生超卖或已经造成资金损失。
- **minimal fix：**在唯一经济投影 owner 中保留在线准入/实际消费次序或等价的已消费身份范围，使在线 SELL 只按旧关联/低价整笔策略消耗应消耗的 BUY，未卖出的等时 BUY 必须保留；历史 batch 无此全序时仍保留 develop 原分区。不要仅在风险层补 N1，也不要把全局 `<` 改为 `<=` 或引入第二本 BUY 账。修复须保留累计 SELL 只消费一次、合法金额修订与现有 clear-scope 语义。
- **回归场景：**真实 Monitor 在线 B1早/B2等时/SELL等时，分别有/无 pending 关联；BUY/SELL全部等时；SELL+1ms；重复终态与累计SELL增量；历史重建等时保持原结果。断言剩余 BUY、成本、真实 Daily offset、风险 R1/N1/check 和实际智能平仓输出，不能只锁纯过滤函数。
- **dimensions：**implementation、project/spec（develop行为真值）、tests、comments（当前注释“同毫秒 BUY 不进入任何区间”描述了实现，未授权扩散到旧在线路径）。

## major issues

### OE-002 — confirmed：已 detach 的 closed fact 重新准入观察，弱/重复消息被提升为 fatal

- **claim：**问题发生在终态已真实结算、tracked entry 已删除后，`eventFlow` 新增的 existing-recorder-fact 分支；不是仍被 timeout route 持有的 terminal tracked order。该分支对同 revision晚到 OPEN、普通缺价重复终态的判定，不保留旧“不重开、不重复结算”的容错边界。
- **evidence / 根因位置：**
  - develop `src/core/trader/orderMonitor/eventFlow.ts:94-105`，无 tracked 直接 return（终态只 warn），不会对重复 closed 观察重新合并。
  - 当前 `src/application/orderTracking/orderMonitor/eventFlow.ts:97-117`，无 tracked 但 recorder 有 existing 时，先要求正量观察本次价/金额完整；此校验发生在旧 revision/重复裁决前。普通终态缺价/零价此前能用完整 known facts 收资源，但 detach后同一原始消息被拒。
  - 该分支 `:132-145` 的 `isWeakOpenOrderObservation` 仅覆盖 OPEN→OPEN。`:150-170` 调 `mergeExecutionFact`；`src/domain/order/executionFact.ts:101-112` 先忽略旧 revision，再对非旧 revision TERMINAL→OPEN throw。因此不是所有旧消息都 fatal。
  - `src/application/orderTracking/orderMonitor/index.ts:582-606` 捕获该错误并 `termination.reportFatalError`；`src/runtime/lifecycle/terminationRuntime.ts:32-57`、`src/app/runApp.ts:66-98,353-374` 将其实接为同步关门/停准入与统一 cleanup，而非单订单 warn。

### 同输入真实 Monitor 观察矩阵

基础 SELL 控制：track普通SELL100 → PartialFilled50@1,T+10 → Canceled50@1,T+20。两版均真实 settle，pending=0、hold空、终态事件1；HEAD `getSellOperationState=SETTLED_WITH_REMAINDER` 且 recorder fact.phase=TERMINAL。源码 `settlementFlow.ts:431-443` 删除 tracked，`routingIndex.ts:111-133` 移除 bucket/空route并清timer，证明不是仅把订单status改为closed仍留route。

| settle/detach 后新增 raw 观察 | develop | HEAD |
|---|---|---|
| 同 revision PartialFilled50@1 | 忽略，无fatal | `fact stage regression: TERMINAL -> OPEN`，关门 |
| 更旧 revision PartialFilled50@1 | 忽略，无fatal | 无fatal，不增加终态事件 |
| 更新 revision PartialFilled50@1 | 忽略，无fatal | stage regression fatal；此行只记观察结果，不额外认定broker应允许状态倒退 |
| 同 revision New/零执行 | 忽略，无fatal | stage regression fatal |
| 同 revision Canceled50，原始价=null或0 | 忽略，无fatal | `已有broker事实的新观察缺少完整价格依据`，关门 |
| 更旧 revision Canceled50，原始价=null | 忽略，无fatal | 同上；价格检查先于旧revision裁决 |
| 更新 revision Canceled50@1，完整重复经济 | 忽略，无fatal | 无fatal，无额外refresh/terminal事件 |
| 更新 revision Canceled50@1.1，合法金额修订 | 忽略，无fatal | 无fatal；amount50→55、revision推进、原T保留、refresh+1、terminal事件仍1 |

**另一个直接、无需假定“OPEN更新revision合法”的复现：**BUY PartialFilled100@1,T+10 → Filled100@0,T+20 → 再次相同 Filled100@0,T+20。当前真实 mapper `orderMapper.ts:90-105` 将正量零价标为缺价，但普通 TERMINAL 可到业务merge；第一次在 tracked 分支成功收口，第二次完全相同消息转入detached分支后 fatal。两版首次终态均只有1条事件、hold释放；重复后经济记录仍100/成本100、refresh不增加，但只有HEAD关门。故不能用“decoder非法数据”否认该普通资源终态重复场景。

### tracked route 反证控制（本轮已真实执行）

1. 用两版真实 Monitor 激活 sell timeout=1s；时钟为 T+100000，submittedAt=T-1000；在注入的离线 cancel方法等待处暂停，**由真实 routeProcessor 自己设置 timeoutMarketConversionPending**，未直接改私有 runtime。
2. 此时发送 Canceled50@1,T+10，真实 eventFlow 将 terminal snapshot 交给 timeout owner，不 settle/detach；终态事件仍0、hold仍保留。
3. 再发同revision PartialFilled50@1，**两版均无fatal，终态事件仍0，hold仍保留**。随后停止route、释放离线ACK并排空；没有提交MO或真实请求。
4. 静态对应：`src/application/orderTracking/orderMonitor/routeProcessor.ts:142-159,543-593`；`eventFlow.ts:373-391` 保持tracked并唤醒route；`src/domain/order/orderFactMerge.ts:492-508` 对 known terminal tracked 直接null。现有 `tests/application/orderTracking/orderMonitor/eventFlow.business.test.ts:1392-1439` 的no-reopen例子正是这种 timeout tracked 状态，**不能反证已detach路径的缺陷**。
5. 此外真实 OPEN partial → 同量缺价 terminal（尚tracked的首次资源关闭）在两版均成功；与之后相同缺价terminal重复的失败形成直接对照。共享合并保护见 `orderFactMerge.ts:104-121,150-162,529-543`。

- **impact：confirmed**——相同普通资源终态重放或同revision晚到OPEN可使HEAD由正常运行变fatal并关门；经济记录没有被重复消费、终态事件没有重复发出。**potential**——整进程其他订单跟进/保护停止；本轮未证明真实市场发生频率或具体漏平仓。
- **minimal fix：**在 closed lifecycle 入口先裁决可忽略的非重开资源观察/已知经济事实吸收的普通terminal重复，再对真正新增的可信累计/金额/水位执行共享owner准入；将已完整known的普通同量资源终态与原始增量缺价区分。保留protective原始证据严格性，不偷补真实新增量价格。不要无条件忽略所有closed事件，也不要删除全局stage-regression校验：本探针已证明合法closed更高revision金额修订有实际消费/refresh义务。
- **回归场景：**上述矩阵全部保留；重点断言无fatal/不关门、无二次terminal、无hold二次释放/无重复refresh，同时保留合法金额修订准入。timeout仍tracked控制必须与真实settle/detach分开构造，不能只调用纯helper或伪造closed status。
- **dimensions：**implementation、type design（经济phase与tracking lifecycle不是同一不变量）、tests、project/spec。

## minor issues

None.

## 逐项确认 / 否证边界

| 主张 | 独立二审判定 |
|---|---|
| OE-001：在线SELL导致未卖出的等时BUY被遗漏 | **confirmed**；真实Monitor、无关联和正常pending关联均复现。 |
| “旧历史严格边界是重构新引入” | **rejected**；旧历史本来如此，历史两版输出相同。 |
| “缺陷只因探针省略pending/related IDs” | **rejected**；正式选单→pending提交→Monitor Filled仍复现。 |
| “成本被清后风险R1必为0” | **rejected（过宽）**；本正常关联场景R1=150但N1=0仍跳过风险。两版Daily offset=-150未变，不列为本次新回归。 |
| OE-002：已detach后的特定重复/同revision弱观察fatal | **confirmed**；原始价格0的同一普通Filled重放本身即可证明。 |
| “所有旧revision乱序OPEN都fatal” | **rejected**；完整旧revision OPEN被忽略。 |
| “尚tracked timeout owner收到terminal后再来OPEN也fatal” | **rejected**；真实timeout route控制两版均不fatal。 |
| “为修复OE-002应忽略所有closed观察” | **rejected**；合法新revision金额修订需保留，探针实际验证amount50→55/refresh+1。 |

## 复现与执行证据

目录：`C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`。

- 自建探针：`recheck-order-facts.test.ts`。只导入两版真实生产模块及既有无关config/rateLimiter/market/symbol测试替身，不导入G4候选脚本，不mock Monitor/recorder/Daily/risk/smart-close。
- 启动器：`run-recheck-order-facts.cjs`；白名单环境沿用 `validation/current-environment.json`，强制 `BUN_OPTIONS=--no-env-file`，显式加载外部 `validation-offline-sdk-guard.ts`。实际命令为 `bun --no-env-file test --preload <TEMP>/validation-offline-sdk-guard.ts <TEMP>/recheck-order-facts.test.ts`。
- **最终证据：**`validation/recheck-order-facts-route-control.json` 与同前缀 `.stdout.log/.stderr.log`。stdout有 `RECHECK_OE001`、`RECHECK_OE001_ASSOCIATED`、`RECHECK_OE001_HISTORY`、`RECHECK_OE002`、`RECHECK_OE002_BUY`、`RECHECK_OE002_TRACKED_ROUTE` 六组原始结构化观察。
- 保留全部先前运行：首轮 `recheck-order-facts.*` exit0/3pass/94expect；扩展首跑 `recheck-order-facts-extended.*` **exit1/4pass/1fail/115expect**，原因是探针错误预设旧Daily offset=0，真实原有严格历史过滤两版均-150；仅TEMP修正该oracle后 `recheck-order-facts-final.*` exit0/5pass/122expect；补closed合法修订控制的 `recheck-order-facts-verified.*` exit0/5pass/135expect；最终route控制6pass/149expect。**没有覆盖/删除失败日志，也不把探针自错说成生产缺陷。**
- 原始stderr中的“找不到待成交卖出订单”来自刻意无关联/无pending控制；正常关联场景有真实pending。结果不能用warning有无代替判定。
- 没有全量typecheck/lint/test重跑，没有app/start/dev或实盘。原生方法均为注入的离线方法；timeout控制唯一cancel是纯内存deferred ACK。SDK guard只阻断工厂/会话，不声称OS防火墙或抓包证明。
- 每次执行前后快照tracked文件逐一SHA-256：current823、develop525，**changed=[]**；HEAD固定、原仓库`git status --porcelain`空、`git diff --check`exit0。
- 本轮续跑可见进程祖先PID **47368**（node.exe）显式配置 `provider=cliproxyapi / model=gpt-6.1-sol / thinking=max`；仅核实运行参数，不声称验证隐藏服务端路由。

## positive findings

- 当前已经拆开经济事实与终态资源关闭；本探针中的合法closed金额修订能够保留原T、推进金额/revision、只新增必要refresh、不重发终态。修OE-002应保留这个能力。
- 真实tracked timeout owner与首次普通缺价资源关闭仍有保护；不应把这些正确路径误报或为修detached路径而扩大改动。
- 两版Daily同一旧分区口径提供了有用控制，防止将旧offset问题或推测风险R1=0错误包装为此次回归。

## 实际阅读范围与 not assessed

**新增深读的当前生产区段：**
- `src/application/orderTracking/recorder/index.ts:1-218,253-303`；`recorder/orderStorage.ts:1-90,146-157,267-303,325-369`。
- `src/domain/order/executionProjection.ts:1-244` 全文；`orderFilteringEngine.ts:1-178` 全文；`executionFact.ts:1-176` 全文；`orderFactMerge.ts:77-189,325-424,470-600`；`orderOwnership.ts:1-117`；`sellDeductionPolicy.ts:1-98`。
- `src/application/orderTracking/orderMonitor/index.ts:70-244,575-729,755-854`；`eventFlow.ts:1-260,290-430`；`settlementFlow.ts:1-49,45-264,298-459`；`orderOps.ts:200-304,405-513`；`routingIndex.ts:1-150`；`routeProcessor.ts:66-161,510-656,820-985`。
- `src/infrastructure/longbridge/trade/orderMapper.ts:73-167`；`src/domain/risk/unrealizedLossChecker.ts:1-109`全文；`src/domain/risk/index.ts:107-123`；`dailyLossTracker.ts:149-179,843-875`（其余沿用此前阅读，不新增全文件声明）。
- `src/application/ordinarySell/quantitySelection.ts:96-282`；`ordinarySell/index.ts:178-281`；`postTradeSettlement/index.ts:214-266`；`src/app/runtime/createPostTradeConsistencyRuntime.ts:39-70`。fatal顶层与termination沿用本代理此前补盲已深读区段，不重复扩大覆盖。

**旧版主要对照区段：**`src/core/orderRecorder/index.ts:1-110,167-300,441-532`；`orderStorage.ts:110-232`；`orderFilteringEngine.ts:73-159`；`orderOwnershipParser.ts:1-112`；`src/core/trader/orderMonitor/index.ts:1-170`；`eventFlow.ts:40-159,245-305`；`settlementFlow.ts:98-125,205-394,624-678`；`src/core/riskController/unrealizedLossChecker.ts:1-195`；`src/core/signalProcessor/sellQuantityCalculator.ts:1-191`。旧smartClose底层utils由真实执行消费，未在本轮全文深审；旧routeProcessor只定向检索timeout标记、其余由真实Monitor执行控制，**不计为源码深读**。

- not assessed：真实市场消息概率、所有相同时间多SELL/晚到BUY排列、重启恢复所有组合、protective/durable全部边界；完整PostTrade/snapshot/app全链执行和所有财务后果。探针没有真实账户/券商仓位查询，剩余available100按两个BUY200减SELL100作为消费者输入。
- type design仅就phase/lifecycle边界作定向判断；全仓死代码、简化、命名/格式与完整方案一致性不在本轮范围。未因测试执行覆盖而声称已深读所有被导入生产文件。

## recommended next actions

1. 主代理将OE-001、OE-002更新为**已完成独立二审confirmed**，并归并此报告的收窄条件；勿保留“所有旧消息均fatal”或“风险R1必0”等扩展措辞。
2. 修复根因分别归唯一经济投影owner、closed-observation准入边界；不要在risk/smart-close加补丁，也不要抹掉历史分区或合法closed修订。
3. 使用本报告同输入矩阵作为回归基线，保留原始日志与探针自错记录。本任务只读交付，不改码；未经修复/授权闭合，不给全仓等价或可发布结论。
