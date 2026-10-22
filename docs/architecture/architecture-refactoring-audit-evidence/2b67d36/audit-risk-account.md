# G5 风险／账户／清仓架构迁移审计

> 只读证据报告。G5首审及V-C1/V-C4/V-C5独立二审已完成，G5-RA01保留待他人复核标记。不得把两版分别通过其各自测试解释为业务等价。

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

## summary

- verdict：已确认至少三项 develop→current 真实行为差分（validation 原候选 V-C1、V-C4、V-C5）；必须分别判断事实一致性修复、风险策略改变和业务授权，不能作为“纯目录迁移”放行。另有独立候选 G5-RA01，已完成自身反证和两版真实模块复现，尚待其他代理复核，不能提前称为已双审最终缺陷。
- scope：G5 分派地图的36个 current 文件；并追踪风险行情事件→保护性订单提交→累计成交／订单账→canonical account/positions→settlement completion／daily-loss boundary／cooldown→readiness，以及普通 SELL、静态清仓、末日清仓和重启／日切接缝。
- confidence：medium。离线源码和内存探针证据较强；未接真实 broker，未完成所有 SDK/持久化实现的逐行审计，不能证明全量等价。
- 固定 current：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。
- 固定 develop／origin/develop／FETCH_HEAD：`6e239c8a128372bd9b2fb2d79464346792a5e81e`。已只读重新核对，三者一致。
- 模型证据：可见审核子进程命令行为 `--provider cliproxyapi --model gpt-6.1-sol --thinking max`；本报告不声称可验证服务端实际模型权重。
- 工作区：检查点 `git status --short` 输出空。未 checkout/reset/merge，未修改源码、配置、测试、实施计划，未实盘，未启动其他子代理；仅写本报告。

## critical issues

目前没有经过他人独立二审的新增 critical 最终缺陷。下列 G5-RA01 为高风险待二审候选；V-C4／B01 为已二审确认且用户已明确授权的业务变更，不作为问题或验收阻塞。

## major issues / 待二审逻辑候选

### G5-RA01：同量 revision 更新把折叠 API 历史伪装成完整历史，允许写出自身无法恢复的保护完成边界（待他人二审）

- claim：`resolveAuthoritativeOrderFactMerge` 对既有事实统一用 `...incoming` 构造下一事实，覆盖了已有 `historyCompleteFromZero=false` 和可信 `submittedAtMs`。来自在线 fill 的 incoming 一律是 `historyCompleteFromZero=true / submittedAtMs=null`。即使只是同量、同金额、仅 revision 推进，也会抹掉“启动／激活 API 快照是折叠历史”的事实。
- 当前证据：`src/domain/risk/dailyLossTracker.ts:300-317`（在线事实标记 complete=true）；`:350-370`（API重建标记false）；`:412-464`，尤其`:457`（`...incoming`）；`:1057-1077`（没有边界前快照且历史不完整才拒绝冻结）；`:1139-1157`（恢复发现缺baseline且订单创建不晚于边界则拒绝）。
- develop反证：`src/core/riskController/dailyLossTracker.ts:517-545` 同量高revision分支使用 `...current`，保留历史完整性和submittedAt；`:1073-1104` 因历史不完整拒绝冻结。数量真正推进时 develop 也有 `...incoming`，所以本项仅主张“同量revision／金额／阶段修订”新增暴露，不把基线已有的其他分支一并归为新回归。
- 最小场景：当日 API 重建 BUY100／总委托200，submittedAt=T-1000，已知累计成交代理T+2000；实际历史未完整持久化。随后收到同量100、同金额100、revision=T+3000的OPEN观察。要完成的保护episode边界为T+1000（例如保护终态晚到／恢复crash-gap）。该方向canonical持仓已flat、无pending protective。
- 完整路径：启动或激活 API订单归一→DailyLoss prepare/publish（历史折叠）→订单事件existing/tracked路径→settlementFlow.commitExecution→daily.recordCumulativeExecution→合并覆盖来源元数据→settlement.settleProtectiveLiquidationEpisodes→prepareProtectionBoundary错误返回缺BUY的baseline→同步append completion→commitBoundary/cooldown/episode→下一次启动loadTradingDayRuntimeSnapshot预检／恢复该completion→`cannot reconstruct protection boundary baseline: orderId=BUY`。
- 已运行结果（真实模块、无源码复制）：两版重建后首次freeze都拒绝；同量revision推进后旧版仍拒绝，新版返回`orderBaselines: []`。当前真实recorder+settlement fixture可进一步输出`RECOVERY true`并append只含保护SELL、不含BUY的completion；再用相同RawOrder和该空BUY基线恢复，当前抛`cannot reconstruct protection boundary baseline: orderId=BUY`。
- impact：confirmed（模块及settlement离线复现）—错误授权写出不具备充分证据的完成边界，且形成自身恢复拒绝的durable记录；potential（完整生产到达／broker时序未仿真）—风险偏移被不充分证据封存、重启fatal阻断交易。并非宣称已经实盘错单。
- 根因修复方向：保留当前事实的历史来源完整性与可信submittedAt；同量／revision／phase更新只替换共享merge裁决允许的累计字段，不把收到一次累计观察当作从零完整历史。真正数量推进的历史完整性同样需单独论证，不无条件沿用incoming=true。
- validation：增加“API折叠重建→同量revision-only→较早保护边界freeze仍拒绝”的两版oracle；增加“真实settlement写出的每个completion可由同一最终订单＋durable progress重启恢复”的闭环测试，覆盖BUY、普通SELL、protectiveSELL以及OPEN→TERMINAL同量修订。
- 现有缺测：已有边界冻结／恢复测试分别覆盖折叠快照拒绝及正常在线历史，但未防止一次无新增成交的观察把false升级true；332项本组定向测试通过未发现此组合。
- dimensions：implementation, type design, tests, project/spec。
- 状态：本代理独立首审与自身误报排除已完成，已向主代理请求转其他代理复核；未收到复核前不得作为双审最终缺陷。

## validation 原候选独立二审（首批已保存）

### V-C1：边界前同量高 revision 从抑制变为权威准入／落盘

- 独立结论：**真实差分已确认；不能仅据此确认新实现计算错误，也不能当纯迁移。**
- develop：`src/core/riskController/dailyLossTracker.ts:969-987` 在merged T不晚于currentBoundary时，于durable callback／事实发布之前返回false/false；当前 `src/domain/risk/dailyLossTracker.ts:882-951` 不再做此抑制，权威事实及durable更新，但`:183-196`仍封存旧段经济投影。
- 独立只读统一输入探针：BUY100@1，T时完成boundary；后同量100@1.1，T不变、revision+30000。旧输出`authoritativeFactChanged=false / durable=0 / loss=0`；新输出`ADMITTED / authoritativeFactChanged=true / executionAdvanced=false / durable=1 / loss="0"`，退出码0。
- 真实路径：WS已有broker事实或tracked订单→累计merge保留known T→settlementFlow→recorder.commitExecutionFact的准入回调→DailyLoss→protective progress durable（仅保护性SELL）→recorder权威发布／stale refresh。普通BUY没有protective durable；本探针传callback是观察准入契约，不应谎称所有BUY都真实写protective progress。
- 风险与价值：冻结旧段经济计算的同时保留同日权威revision/金额，可避免同一订单两个事实owner对高revision解释分叉，属于有可解释收益的事实一致性修复；但durable、recorder成本及刷新副作用确实变化。它改变下一段累计成交的基数和旧修订后的后续冲突水位，不能以“当前loss仍0”证明全链等价。
- 非最终缺陷判定：新实现接受权威修订本身未证明违反业务安全；需要明确记录为非纯迁移行为，并核实用户是否批准此具体事实一致性例外。不得用2b67d36新测试或新skill倒推授权。G5-RA01是另外一个更具体的来源元数据bug，不与本项混并。

### V-C4／B01：末日保留旧SELL、仅新增available（已授权，非问题）

- 独立结论（源码与旧新oracle已核对）：**执行策略真实改变；不能称为只有owner迁移。**
- develop：`src/core/trader/orderExecutor/submitFlow.ts:606-660` 查询全部pending SELL→发cancel→CANCEL_CONFIRMED后返回WAITING_FOR_AUTHORITATIVE_TERMINAL→后续pending移除才重读仓位并提交。
- 当前：`src/application/orderExecution/submitFlow.ts:579-605` captureSellAvailabilityGuard→新鲜可卖读取→available=0跳过，否则新增SELL；完全不撤／改单旧SELL。当前workflow `src/application/doomsdayClearance/index.ts:180-186` 在available<=0时不生成命令。
- oracle反向：旧`tests/integration/doomsday.integration.test.ts:377-525`要求先cancel并在terminal前不读仓／不submit；当前同文件`:462-546`要求旧普通／保护／MO／多SELL完全不变，仅available40新增40、available0不提交，cancel／replace被设为throw。
- 影响边界：不能从局部差分直接宣称“旧SELL必然不能清仓”或“必然漏平仓”。当前order monitor仍有原超时跟单，是否能在剩余收盘窗口内完成取决于旧单类型、提交时间、价格及超时配置。然而原有末日接管的撤旧单与终态等待保证确已消失，无法由新鲜available裁剪等价替代。
- 独立统一输入探针已运行exit0：总仓100、旧SELL占60、available40、原caller授权恒true；导入两版真实`createSubmitTargetOrder`，仅broker/limiter/monitor以本地能力替代。旧输出`WAITING_FOR_AUTHORITATIVE_TERMINAL; cancel=1/read=0/submit=0`；新输出`SUBMITTED; cancel=0/read=1/submit=1/quantity=40`。不是运行两套各自相反的测试后推断差分。
- 完整链路：timeWakeupEvaluationProgram→doomsday.evaluate→executeClearance筛选当前港股席位与行情→orderExecutor.executeDoomsdayClearanceSignals→最终门禁→submitTargetOrder专用分支→上述旧单差分→accepted进入orderMonitor.trackOrder→后续WS累计/终态进入recorder和settlement。当前`src/application/orderTracking/orderMonitor/routeProcessor.ts:690-704`仍只有配置开启且订单已超时时才转市价，`:707-741`的普通改单还有WAIT_WS_ONLY／不可改单类型／频率等条件；这不是无条件替代旧末日撤单接管的保证。
- accepted后本地差分应分开判断：develop `src/core/doomsdayProtection/index.ts:509-546`立即裁剪positions、回调订阅并clearBuyOrders；current `src/application/doomsdayClearance/index.ts:475-490`仅在全部accepted且live/epoch仍有效时invalidateAccount，不虚裁positions。后者防止“accepted当flat”的具体错误，具备可说明的改进理由，且实施计划明确记录；但取消／拒绝后缓存和成本可见时序确实不再与旧版相同。
- 判定：用户已明确确认V-C4／B01的“保留旧SELL只新增available”为授权业务改动，非问题、不设major等级、不构成验收阻塞。保留差分证据，不要求证明与旧策略等价或恢复旧撤单流程；本次也不将授权扩大解释为任何盘口下必然完成清仓。

### V-C5：过期冷却重启后下一次保护完成的行为改变

- 独立结论：**真实差分已确认；更像修复基线的重启／不重启不一致，不能说完全等价，也不宜径直定为新算法bug。**
- develop：`src/services/liquidationCooldown/tradeLogHydrator.ts:61-77`先restoreTriggerCount，发现cooldown过期再continue，不恢复cooldownMap起点；下一次record没有旧起点可触发清计数，因此旧满额计数继续累加并立即冷却。
- 当前：`src/application/protectiveLiquidation/tradeLogHydrator.ts:66-85`先判expired并跳过完整旧cycle，不恢复旧满额计数。
- 两版tracker的在线核心都按“上一个冷却过期→清旧起点和计数→从1开始”工作（develop `src/services/liquidationCooldown/index.ts:65-94`；current `src/domain/liquidation/cooldown/index.ts:59-88`）。故当前恢复更接近同一进程不重启时的行为，这提供了“更优”的具体理由，但不替代用户授权。
- 独立真实hydrator+tracker探针：10:00/01/02三次完成，limit3、minutes5，10:10重启，两版remaining=0；10:10再完成一次，旧remaining=300000，新remaining=0，退出码0。
- 影响：重启后下一轮保护完成之后，当前更早恢复买入／下一轮交易机会，旧版会立即挡5分钟；不是单纯日志／内部类型差异。应单列“基线缺陷修复候选／需授权变化”，由用户选择沿用旧冷却策略还是批准恢复一致性修复。
- 现有测试：当前`tests/application/protectiveLiquidation/tradeLogHydrator.business.test.ts:51-96`锁定新行为；旧测试未保护过期cycle。两版测试各全绿不证明此差分已获授权。

## minor issues

暂未确认应阻塞的minor；不以风格、行数或层数单独报告过度设计。

## positive findings（已追踪的不变量，不是全量等价结论）

- snapshot唯一writer、深不可变view、epoch/generation/revision授权与settlement readiness分离；停止／日切可撤销旧提交，不把旧异步read成功当成新generation可提交事实。
- 保护完成事务仅由settlement执行；检查真实flat／无pending protective，append completion先于daily-loss boundary、cooldown和episode内存提交；accepted不等于flat。
- 普通SELL持仓／freshness失效与quote缺失预算分离，旧授权失效重新选量，不吃报价retry；三阶段整体盈利→单单盈利→超时次序和关联整单扣减已对照旧helper，不以目录迁移diff冒充完整比较。
- 精确金融文本／原金额数量比较没有把显示均价重新当决策成本；港股执行安全整数与账户非港股正小数展示已分开。

## 验证记录（本代理亲自执行）

1. `git rev-parse HEAD develop origin/develop FETCH_HEAD`：与本文固定SHA一致；`git status --short`：空。
2. 定向命令：

```text
bun test tests/domain/risk tests/domain/liquidation tests/application/accountPositionSnapshot tests/application/postTradeSettlement tests/application/protectiveLiquidation tests/application/staticLiquidation tests/application/doomsdayClearance tests/application/ordinarySell tests/integration/accountPositionConsistency tests/integration/dailyLossAmountRevision.integration.test.ts tests/integration/protectiveLiquidation.integration.test.ts tests/integration/liquidationCooldownRecovery.integration.test.ts tests/integration/doomsday.integration.test.ts tests/integration/doomsdayIncremental.integration.test.ts
```

结果：exit0；332 pass／0 fail；1732 expect；39 files，284ms（Bun报告）。仅覆盖当前测试预期，不是基线等价证明。

3. V-C1／V-C5两版真实模块只读内存探针：exit0，具体数值见各节。
4. G5-RA01两版真实DailyLoss差分探针：exit0，旧拒绝／新允许缺BUY基线；当前真实settlement fixture也允许append；独立恢复探针拒绝同一边界。初次探针价格写成`.9`被精确文本语法拒绝（exit1），修为合法`0.9`重跑exit0；失败首跑不作为业务差分证据。
5. 主代理转来的验证代理结果：current3288／develop1992全量测试、两版typecheck/lint通过。此为外部验证结果，不冒称本代理亲跑；当前本组已发现oracle反转，所以全绿不能证明等价。
6. 已直接从本报告附录提取整段Bun probe再次执行：exit0；RA01旧拒绝／新freeze通过／新重启拒绝，以及V-C1/V-C4/V-C5关键差分全部重复成立。所有后续检查`git status --short`仍为空。

## not assessed

- 36主责文件逐项覆盖见下表。D指主要业务路径深读，E指契约/迁移diff核对；长文件和跨组接缝并未全量穷举所有组合。源码读取／类型迁移核对不等于形式化等价证明。
- 未进行真实broker交易、真实WS乱序／交易所终态延迟实验；不得据离线probe声称实盘已发生风险。
- SDK/persistence及展示属于G6、完整订单状态机属于G4，本文仅深读证明G5结论所需接缝，不宣称替代其全量审计。
- 负数非HK持仓mapper拒绝可复现，但尚无足够业务/SDK输入合法性证据，**不是已确认缺陷**；正小数混合账户已有针对性验证。

## recommended next actions

1. 其他代理独立复核G5-RA01来源元数据覆盖及completion重启闭环。
2. V-C4／B01的“保留旧单仅卖available”策略已由用户明确授权，保留当前策略与差分记录，无需追加裁决或缺陷修复。
3. V-C1／V-C5分别记录具体事实一致性修复和过期cycle恢复修复及授权；保留差分oracle。
4. 保留基线oracle和本报告中的只读复现；修复或批准具体业务差分后补闭环测试，再执行统一门禁，不用门禁通过替代等价论证。

## 36个主责生产文件覆盖

等级定义：**D 已深读**＝当前主要业务实现、对应develop关键分支及真实调用链已分析（长文件按下述关注边界，非声称所有行都已穷举证明）；**E 迁移／契约diff核对**＝已读接口并追踪装配/消费者，确认数据owner与授权传播，未单独证明其所有合法状态等价。**U 未深入**＝不把名称或单次grep当深读。G5分派36个均有实质D/E检查：25 D／11 E；G5内无完全未读文件，但U边界仍明确列于后文。

| current文件（相对仓库根） | 等级 | develop对照／实际关注内容 |
| --- | --- | --- |
| `src/application/accountPositionSnapshot/index.ts` | D | 旧refreshHelpers＋positionCache；深不可变、请求合并、在途撤销、epoch/generation/paired提交与drain |
| `src/application/accountPositionSnapshot/types.ts` | E | 旧state；COMMITTED/ABORTED、请求dayEpoch和account/positions能力边界 |
| `src/application/accountQuery/index.ts` | D | 旧core/trader/accountService；账户与positions并行读取、只查不提交owner状态 |
| `src/application/doomsdayClearance/index.ts` | D（重点） | 旧core/doomsdayProtection/index＋旧timeWakeup；窗口、撤买、available筛选、门禁、报价retry、UNKNOWN、accepted副作用；V-C4 |
| `src/application/doomsdayClearance/types.ts` | E | 旧doomsdayProtection/types；context/currentTime/live/positions/executor契约 |
| `src/application/postTradeSettlement/index.ts` | D（重点） | 旧createPostTradeConsistencyRuntime＋refreshHelpers；need/version pump、refresh、订阅确认、完成事务、R1/N1、rebuild/recovery、stop/drain |
| `src/application/postTradeSettlement/readinessGate.ts` | D | 旧utils/refreshGate；receipt、waiter、stale/valid分离、stop/rebuild abort |
| `src/application/postTradeSettlement/types.ts` | E | 新接口；businessDeps及ready/snapshot/completion分权，非新增需求自动授权 |
| `src/application/protectiveLiquidation/index.ts` | D | 旧tradingRiskEventRuntime＋unrealizedLossExecutor；captured dayEpoch、latest trigger、final receipt/position/seat授权 |
| `src/application/protectiveLiquidation/tradeLogHydrator.ts` | D | 旧services/liquidationCooldown/tradeLogHydrator；全文件与统一输入probe；V-C5 |
| `src/application/protectiveLiquidation/types.ts` | E | 旧cooldown/types等；trigger/route/attempt/deps的窄能力 |
| `src/application/protectiveLiquidation/unrealizedLossExecutor.ts` | D | 旧riskController/unrealizedLossMonitor＋旧runtime executor；accepted后的local clear/publish和外部/内部失败分离 |
| `src/application/riskRefresh/types.ts` | E | 新接口；WarrantRiskRefreshResult及publish权限 |
| `src/application/riskRefresh/warrantRiskRefresh.ts` | D | 旧warrantRiskChecker异步部分／refreshHelpers；查询候选、未知类型、授权后同步发布、外错重试归属 |
| `src/application/staticLiquidation/index.ts` | D（重点） | 旧monitorQuoteEventRuntime/staticLiquidationExecutor；两方向候选、readiness等待、行情失败retry、最终guard、accepted清理 |
| `src/application/staticLiquidation/types.ts` | E | 新接口；WAIT/RE_EVALUATE/result与原caller canContinue |
| `src/domain/liquidation/cooldown/index.ts` | D | 旧services/liquidationCooldown/index；trigger计数／有效期／跨日清理／查询无副作用；V-C5 |
| `src/domain/liquidation/cooldown/rules.ts` | D＋规则等价diff | 旧services/liquidationCooldown/utils；minutes/half-day/one-day、simulate cycle；去掉import/注释后的语法一致仅为辅助证据 |
| `src/domain/liquidation/cooldown/types.ts` | E | 旧cooldown/types；now显式输入和注入能力变化 |
| `src/domain/liquidation/doomsday/index.ts` | D | 旧doomsdayProtection/utils＋窗口helper；正常／半日收盘、截止后拒买、retry严格早于收盘 |
| `src/domain/liquidation/doomsday/types.ts` | E | 新状态容器；当日撤买／retry预算持有者 |
| `src/domain/liquidation/episode/index.ts` | D | 旧protectiveLiquidationEpisodeTracker；fill-progress、方向身份、prepare/commit completion、恢复 |
| `src/domain/liquidation/episode/types.ts` | E | 旧episode/types；pending/flat完成资格及prepared边界 |
| `src/domain/risk/buyPricePolicy.ts` | D | 旧signalProcessor/utils:37起；最新成本金额×数量严格比较，null行情交调用方 |
| `src/domain/risk/dailyLossRules.ts` | D | 旧riskController/utils；香港日键、原金额求和、归属诊断；部分成交不是诊断终态计数 |
| `src/domain/risk/dailyLossTracker.ts` | D（重点） | 旧同名模块；raw/fill来源、累计merge、分段baseline冻结、原子prepare/publish、恢复校验；G5-RA01、V-C1 |
| `src/domain/risk/executionHistory.ts` | D | 旧DailyLoss恢复逻辑拆出；revision/quantity/phase/T分组、null-phase历史、最终API上界；未声称所有长序列穷举 |
| `src/domain/risk/index.ts` | D | 旧riskController/index；现金顺序、持仓限额、共享R1/N1、不再持异步workflow |
| `src/domain/risk/positionLimitChecker.ts` | D | 旧同名checker；计划金额／同标的成本价估值、阈值等号、目标symbol数量校验 |
| `src/domain/risk/types.ts` | E | 旧riskController/types＋新能力；只读候选、historyCompleteFromZero与submittedAt来源意义 |
| `src/domain/risk/unrealizedLossChecker.ts` | D | 旧同名checker；R1=cost-lossOffset，N1原量，prepare/publish，严格低于负阈值 |
| `src/domain/risk/warrantRiskChecker.ts` | D | 旧同名checker；同步缓存、bull/bear阈值方向和等号、原分子交叉比较，查询拆往riskRefresh |
| `src/runtime/tradingRiskEventRuntime/routeValidation.ts` | D | 旧main同名；symbol/direction/seatVersion一致性；另有display消费者，未误删 |
| `src/runtime/tradingRiskEventRuntime/routingIndex.ts` | D | 旧main同名；真实seat snapshot、多空重复symbol fail-fast、路由索引 |
| `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` | D | 旧main/runtime＋executor；每方向single-flight/latest-only、fresh事件唤醒、stop/drain，不复制业务授权 |
| `src/runtime/tradingRiskEventRuntime/types.ts` | E | 旧main/types；调度态与application route/trigger契约 |

## 全链路核对与尚存边界

### 账户／持仓 → 风险就绪

`createTradeRuntime/createPostTradeConsistencyRuntime`注入同一个snapshot与settlement；`accountQuery`只读取；`accountPositionSnapshot/index.ts:183-220,273-398,468-506`持有读取准入、过期重排、唯一提交与drain；`postTradeSettlement/index.ts:373-532`持有成交need的refresh、positions订阅确认和业务发布；`readinessGate.ts`持有业务ready receipt而非可写account缓存。

核对的危险交错：read已发出→末日all-accepted失效account→旧read返回；停止／日切→旧read返回；pending请求合并但原caller epoch不同；positions-only不偷换paired证据。没有把一次snapshot提交等同于“日损和R1/N1已经结算”。账户失效推进generation不额外制造一次成交settlementVersion。此owner分离有真实防旧任务写新日状态的价值，不能因类型/文件增多就认定过度设计。

旧实现对照：`src/core/trader/accountService.ts`、`src/utils/positionCache/index.ts`、`src/utils/refreshGate/index.ts`、`src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`及旧`createPostTradeConsistencyRuntime.ts`。新token协议不等于旧接口字节等价；本组核对的是消费侧阻断旧状态和最终恢复的义务。

### 风险报价 → 保护提交 → 实际成交／完成

`tradingRiskEventRuntime.ts:112-168`捕获trigger、方向single-flight/latest-only；`protectiveLiquidation/index.ts:59-158`先定epoch/route，waitForFresh之后取同日latest，再验证seat/receipt/position token；`unrealizedLossExecutor.ts:48-111`判断阈值、透传原isCurrent到executor，accepted后只有原guard仍有效才clear成本并同步发布新R1/N1。真正broker订单已确认不能因guard随后过期而被本地否认／自动重提。

成交链：`orderTracking/orderMonitor/eventFlow.ts:112-211,249-352,394起`→`settlementFlow.ts:151-250,366起`→`recorder/index.ts:48-116`与`dailyLossTracker.ts:882-951`同步准入/持久化→recorder权威/经济投影→snapshot stale/refresh→`postTradeSettlement/index.ts:130-220`。保护episode仅进度被提交不意味着完成；确认方向真实flat且无pending protective后，**先append completion，再boundary，再cooldown，最后episode complete**，无await插入此提交段。恢复调用`:778-809`复用同一事务，cooldown之后由durable hydrator重投影。

已排除的误报：protective/static accepted后clearBuyOrders不是新架构首次引入。develop `src/core/riskController/unrealizedLossMonitor.ts:111-121`及`src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:289-301`已有清理。旧取消/拒绝SELL也会处理部分成交和关联释放（旧settlementFlow`:691-725`），不能只看到新clear就定回归。当前recorder`:216-241`把clear表示为经济范围消费证明；这使late API/WS不能随便复活已清scope。**保护性未成交取消后是否应无重建恢复全部成本，是基线也有的复杂业务边界，本次未证明所有取消/恢复排列完全等价，不能宣称此点已全面闭环通过。**

### 普通卖出与风险成本接缝

真实旧计算不在薄包装`sellQuantityCalculator.ts`本身，而在develop `src/core/signalProcessor/utils.ts:103-235`；本次已补读该helper。对照当前`ordinarySell/quantitySelection.ts:97-245`和`domain/order/smartClose.ts`：整体盈利命中即ALL并返回，否则PROFIT_ONLY后在remaining额度内TIMEOUT_ONLY，排除stage2订单ID，维持整笔关联；显示均价仅日志，不用于新决策。当前直接用原金额/数量交叉比较属于精度升级，临界值输入不主张与旧number舍入逐点相同。

`ordinarySell/index.ts`在freshness／position superseded时重选数量；`orderExecution/quantityResolver.ts:204-237`在最终执行前只对目标HK持仓新鲜读取；执行器在permit内再次行情／授权／整笔关联量核对。外部quote缺失预算与内部权威事实失效分开，不能无限吃quote次数。完整SELL合单/撤单/replace/ws-terminal状态机由G4主责；本报告仅把G5金额、可卖、stale/readiness接缝追到该owner，未独自覆盖其所有状态。

### 静态回收距离清仓

当前`staticLiquidation/index.ts:137-399`：waitForFresh后使用原epoch、receipt和position token；异步行情后重核；缺报价/外部失败返回WAIT/重评估；已知无效行情不伪造可执行价格。牛证／熊证买入拒绝用严格边界，而静态清仓包含等号（`warrantRiskChecker.ts:91-175`）；该方向已对照旧checker的decimalLt/Gt/Lte/Gte。未把“所有风险”硬塞进一个异步workflow；查询与同步规则分权有明确外错重试/最终授权价值。

### 末日窗口与失败收敛

正常日／半日市、截止拒买和收盘前retry沿原窗口规则拆到`domain/liquidation/doomsday`；撤买仍以ACK与WS终态区分，并保留602013/WAIT_WS_ONLY的既有订单owner收敛。**submit UNKNOWN**则是实施计划`:35`明确单列的失败策略收敛：旧末日catch刷新持仓并安排重评估（旧timeWakeupEvaluationProgram`:406-492`），当前向fatal/cleanup传播；不自动重提，也不新增UNKNOWN查询接管协议。本报告将其记为明确例外，**不**再与V-C4“主动取消旧SELL语义被删除”混淆。

末日all-accepted不再虚裁positions／清整方向买单有防止把accepted当flat的具体改进理由；**保留旧SELL只卖available**则为用户已明确授权的V-C4／B01策略，不再要求额外业务决策。当前超时跟单存在不代表会在剩余窗口内必然成交，此限制不改变B01的已授权、非问题分类。

### 启动、重建、日切、取消后的恢复

直接读取`tradingDayRebuild/executionNormalization.ts`、`loadTradingDayRuntimeSnapshot.ts:274起,487-579,770起`、`rebuildTradingDayState.ts`关键发布段和`seatActivation/index.ts`guard/await调用点。重建prepare DailyLoss与recorder候选、预检durable历史，最终同步授权后发布；首次保护完成也走settlement专用recovery入口，避免两个completion owner。跨日`runtime/lifecycle/cacheDomains/riskDomain.ts`清旧epoch/risk状态，termination停止／drain已发任务。

但G5-RA01说明这种闭环仍能被**事实来源元数据丢失**穿透：模块正常的在线merge结果可错误放宽后续freeze，故不因“恢复代码有严格校验”就判安全。取消恢复所有业务排列没有独自穷举；position-flat／no-pending检查也不证明所有更早BUY历史已完整，这正是本候选的根因。

## 历史提交校正与修复完整性

| 项目 | 判定 | 证据／边界 |
| --- | --- | --- |
| `executionTime <= revision`前提 | 历史已修；不能报成develop无此判断 | develop本来有前提，但两个时间均来自updatedAt代理。重构曾拆成独立时间使前提失效；d2aa590删实时fill、启动扫描、progress恢复三处检查。当前仍校验正安全时间，不恢复错误跨时钟排序 |
| 执行时间驱动启动／归属 | 2b67d36在本范围修复可见；不证明所有输入 | 当前orderMapper正成交T=该单updatedAt代理；DailyLoss重建同量保留known T，API最终事实与durable完整历史分开预检。不能把旧updatedAt有效性／当日过滤当重构新增 |
| 全账户数量整数化／市场范围扩大 | 已在本组相关出口校正 | accountMapper canonical允许非HK正小数；sellPositionReadAdapter/quantityResolver仅验证目标HK原始数量；doomsday只过滤HK再做席位归属。US负持仓合法性仍缺业务证据，不升格缺陷 |
| 经济范围／SELL投影 | 2b67d36修复点可见，完整性未全部独审 | 已读executionProjection、recorder、sellDeduction/filtering；SELL累计输入只一次参与整笔过滤，clear scope不被普通API重放复活；完整订单合并状态机交G4 |
| 边界前权威修订 | 当前仍有真实非等价差分 | V-C1；经济投影冻结与权威/durable接受拆开，不称纯迁移 |
| API历史完整性来源 | 当前仍存在新候选 | G5-RA01：同量分支从develop的`...current`变为统一`...incoming`，丢来源证明。已有最终历史校验没有补此在线升级漏洞 |
| 末日占用卖量／旧SELL接管 | 当前仍有真实非等价差分 | V-C4；历史`8fd0eef`等提交表达了变更意图，但提交标题／当前测试不能代替业务授权 |
| 过期冷却恢复 | 当前更接近旧tracker不重启行为，但非纯迁移 | V-C5；旧恢复计数而未恢复过期起点，当前不恢复整个过期cycle |

## 七个review lenses

| 维度 | 检查与结果 | 未深入／限制 |
| --- | --- | --- |
| Implementation | 追踪完整事实/快照/结算/风险/清仓链；独立复现G5-RA01；V-C1/C4/C5区别处理 | 未真实broker回放所有乱序、跨进程crash、市场延迟 |
| Project & Spec | develop为行为oracle；计划中UNKNOWN、精度及accepted≠flat例外显式记录；其余变化仍需证明／授权 | 新skill、新测试和“fix”提交不能自行授权；用户最终策略选择不由本代理替代 |
| Type Design | readonly候选、明确COMMITTED/ABORTED和receipt/position token、同步prepare/publish；G5-RA01显示boolean来源仍可非法升级 | 未为所有接口枚举非法构造；SDK品牌与私有permit完整设计由G6/G4 |
| Tests | 332定向通过＋两版真实模块统一输入probe；已明确旧新反向oracle和缺少的组合测试 | 未亲跑两版全套typecheck/lint/test（使用验证代理结论且注明来源） |
| Comments | 核对accepted≠flat、canonical与ready不同、revision-only不改经济、完整历史含义；主注释方向有具体依据 | 历史完整性代码与语义矛盾计入RA01，不另凑注释finding；不声称读完所有日志文案 |
| Dead Code | 搜生产静态消费者：routeValidation有display引用，cooldown.restore/record被hydrator用，buyPricePolicy被ordinaryBuy用，windowEntry被timeWakeup用 | `restoreProtectionBoundary`、`restoreExecutionSnapshot`实例返回能力当前未见生产直接调用（内部publisher/recovery拆分后主要测试消费），仅**B级候选**，未排完外部契约/测试恢复价值，不建议直接删；无A级死码结论 |
| Simplification | snapshot token、readiness receipt、runtime调度与application业务分离有真实异步失效价值；不能以层数判过度设计 | 未找到可证明无业务价值且消费链完整排除的抽象；无“过度设计”最终finding。统一merge若以省分支损失来源元数据反而是RA01风险 |

## 额外实际读取的生产文件（不计入36主责）

下列是为闭合调用链实际读过的文件；**重点片段**不等于全文件逐逻辑等价已证。失败读取的不存在路径不列入覆盖。

- app装配（重点）：`src/app/runtime/createPostTradeConsistencyRuntime.ts`、`createTradeRuntime.ts`、`createPostGateRuntime.ts`。
- ordinaryBuy：`src/application/ordinaryBuy/accountPositionsRead.ts`、`riskChecks.ts`。
- ordinarySell：`src/application/ordinarySell/index.ts`、`quantitySelection.ts`、`quantityResolver.ts`。
- execution：`src/application/orderExecution/index.ts`、`quantityResolver.ts`、`submitFlow.ts`、`tradeMutationErrors.ts`。
- recorder：`src/application/orderTracking/recorder/index.ts`、`types.ts`。
- orderMonitor（重点）：`src/application/orderTracking/orderMonitor/settlementFlow.ts`、`eventFlow.ts`、`recoveryFlow.ts`、`routeProcessor.ts`。
- rebuild（重点）：`src/application/tradingDayRebuild/executionNormalization.ts`、`loadTradingDayRuntimeSnapshot.ts`、`rebuildTradingDayState.ts`；`src/application/seatActivation/index.ts`只读关键guard/await调用，未深入完整激活状态机。
- order domain：`src/domain/order/smartClose.ts`、`executionProjection.ts`、`executionFact.ts`、`orderAnalysis.ts`、`orderRecordPolicy.ts`、`orderOwnership.ts`、`orderFactMerge.ts`（前部与merge入口，非全文件）、`orderFilteringEngine.ts`、`sellDeductionPolicy.ts`。
- runtime：`src/runtime/timeWakeupEvaluationProgram/index.ts`；`src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`（220–520、590–820及调用提取）；`src/runtime/lifecycle/cacheDomains/riskDomain.ts`、`terminationRuntime.ts`。
- Longbridge trade适配：`src/infrastructure/longbridge/trade/accountMapper.ts`、`accountReadAdapter.ts`、`sellPositionReadAdapter.ts`、`orderMapper.ts`、`orderSnapshotReadAdapter.ts`、`tradeMutationAdapter.ts`。
- 共享契约／失败分类：`src/types/risk.ts`、`src/types/accountPosition.ts`、`src/utils/apiFailure/index.ts`。

实际develop对照还包括：`src/core/orderRecorder/{index,utils,orderStorage,orderFilteringEngine,sellDeductionPolicy,types}.ts`；`src/core/trader/orderMonitor/{settlementFlow,recoveryFlow}.ts`；`src/core/trader/orderExecutor/{submitFlow,quantityResolver}.ts`；`src/core/trader/accountService.ts`；`src/core/riskController/{dailyLossTracker,index,positionLimitChecker,unrealizedLossChecker,unrealizedLossMonitor,warrantRiskChecker,utils,types}.ts`；`src/core/doomsdayProtection/{index,utils}.ts`；`src/core/signalProcessor/{sellQuantityCalculator,utils}.ts`；`src/core/trader/protectiveLiquidationEpisodeTracker/{index,types}.ts`；`src/main/asyncProgram/sellProcessor/index.ts`；`src/main/tradingRiskEventRuntime/{tradingRiskEventRuntime,unrealizedLossExecutor,routeValidation,routingIndex}.ts`；`src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts`；`src/main/timeWakeupEvaluationProgram/index.ts`；`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`重点；`src/app/runtime/createPostTradeConsistencyRuntime.ts`；`src/services/liquidationCooldown/{index,tradeLogHydrator,utils}.ts`；`src/utils/{positionCache,refreshGate}/index.ts`。

## 可运行只读统一输入复现（G5-RA01、V-C1、V-C4、V-C5）

以下命令从仓库根目录运行；只用`git show <固定SHA>:<path>`把旧模块加载到Bun虚拟namespace，不checkout、不导出旧树、不写测试脚本、不连接broker。旧/新模块各使用自身真实逻辑；只把边界数据适配到各版契约，未复制被比较算法。V-C4依赖替身限于broker、monitor和limiter，比较真实submitFlow路径。PowerShell：

```powershell
bun --eval @'
import { plugin } from 'bun';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { OrderSide, OrderStatus } from 'longbridge';
import { createDailyLossTracker as createNewDaily } from './src/domain/risk/dailyLossTracker.ts';
import { orderAnalysis } from './src/domain/order/orderAnalysis.ts';
import { toHongKongTimeIso } from './src/utils/time/index.ts';
import { createSubmitTargetOrder as createNewSubmit } from './src/application/orderExecution/submitFlow.ts';
import { createLiquidationCooldownTracker as createNewCooldown } from './src/domain/liquidation/cooldown/index.ts';
import { createTradeLogHydrator as createNewHydrator } from './src/application/protectiveLiquidation/tradeLogHydrator.ts';

const sha = '6e239c8a128372bd9b2fb2d79464346792a5e81e';
const root = process.cwd();
plugin({
  name: 'readonly-fixed-develop',
  setup(build) {
    build.onResolve({ filter: /^virtual\// }, args => ({
      path: args.path.slice(8), namespace: 'baseline',
    }));
    build.onLoad({ filter: /.*/, namespace: 'baseline' }, args => {
      const text = execFileSync('git', ['show', sha + ':' + args.path], {
        cwd: root, encoding: 'utf8',
      });
      return {
        contents: text.replace(/(from\s*['"]|import\s*['"])(\.[^'"]+)(['"])/g,
          (_, prefix, specifier, quote) => prefix + 'virtual/' +
            path.posix.normalize(path.posix.join(path.posix.dirname(args.path), specifier))
              .replace(/\.js$/, '.ts') + quote),
        loader: 'ts', resolveDir: root,
      };
    });
  },
});
const { createDailyLossTracker: createOldDaily } =
  await import('virtual/src/core/riskController/dailyLossTracker.ts');
const { createDailyLossOrderAnalysisDeps } =
  await import('virtual/src/core/orderRecorder/index.ts');
const { createSubmitTargetOrder: createOldSubmit } =
  await import('virtual/src/core/trader/orderExecutor/submitFlow.ts');
const { createLiquidationCooldownTracker: createOldCooldown } =
  await import('virtual/src/services/liquidationCooldown/index.ts');
const { createTradeLogHydrator: createOldHydrator } =
  await import('virtual/src/services/liquidationCooldown/tradeLogHydrator.ts');
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const makeDaily = old => old
  ? createOldDaily({ ...createDailyLossOrderAnalysisDeps(), toHongKongTimeIso })
  : createNewDaily({ ...orderAnalysis, toHongKongTimeIso, onOwnershipWarning() {} });
const t = Date.parse('2026-10-07T02:00:00Z');
const now = new Date(t + 5000);
const scope = { monitorSymbol: 'HSI.HK', orderOwnershipMapping: ['HSI'] };
const rawCommon = {
  orderId: 'BUY', symbol: 'A.HK', stockName: 'HSI RC', remark: '',
  submittedAt: new Date(t - 1000), updatedAt: new Date(t + 2000),
};
const rawNew = {
  ...rawCommon, executionSide: 'BUY', executionStatus: 'PARTIAL', executionPhase: 'OPEN',
  status: 'PARTIALLY_FILLED', orderType: 'LO', price: '1', quantity: 200,
  executedPrice: '1', executedQuantity: 100, executedAmount: '100',
  executionTimeMs: t + 2000, updatedAtMs: t + 2000,
};
const fill = old => ({
  orderId: 'BUY', symbol: 'A.HK', direction: 'LONG', side: old ? OrderSide.Buy : 'BUY',
  factStage: 'OPEN', executedQuantity: 100, executedPrice: old ? 1 : '1',
  executedTimeMs: t + 2000, orderUpdatedAtMs: t + 2000,
});
const freeze = daily => daily.prepareProtectionBoundary({
  direction: 'LONG', boundaryExecutedTimeMs: t + 1000,
});
const outcome = run => { try { return run(); } catch (error) { return error.message; } };
let newBoundary;
for (const old of [true, false]) {
  const daily = makeDaily(old);
  const rawOld = {
    ...rawCommon, side: OrderSide.Buy, status: OrderStatus.PartialFilled,
    orderType: 'LO', price: 1, quantity: 200, executedPrice: 1, executedQuantity: 100,
  };
  if (old) daily.recalculateFromAllOrders([rawOld], scope, now);
  else daily.publishRecalculation(daily.prepareRecalculationFromAllOrders([rawNew], scope, now));
  const before = outcome(() => freeze(daily));
  const result = daily.recordCumulativeExecution({ ...fill(old), orderUpdatedAtMs: t + 3000 });
  const after = outcome(() => freeze(daily));
  if (!old) newBoundary = after;
  console.log(old ? 'OLD_RA01' : 'NEW_RA01', JSON.stringify({ before, result, after }));
}
console.log('NEW_RA01_RESTART', outcome(() => {
  const latest = {
    ...rawNew, updatedAt: new Date(t + 3000), updatedAtMs: t + 3000, executionTimeMs: t + 3000,
  };
  makeDaily(false).prepareRecalculationFromAllOrders([latest], scope, now, new Map(), undefined,
    { executionSnapshots: [], boundaries: [newBoundary] });
  return 'ACCEPTED';
}));
// RA01接续：真实recorder + settlement completion路径；只替代账户读取和durable append。
{
  const { createExecutionFixture } = await import('./tests/application/orderTracking/recorder/executionFixture.ts');
  const { createPostTradeSettlementWorkflow } = await import('./src/application/postTradeSettlement/index.ts');
  const { createAccountSnapshotDouble, createLoggerDouble } = await import('./tests/helpers/testDoubles.ts');
  const { isExternalApiRequestError } = await import('./src/utils/apiFailure/index.ts');
  const f = createExecutionFixture({ nowMs: t,
    readPort: { getAccountSnapshot: async () => createAccountSnapshotDouble('10000'), getStockPositions: async () => [] },
    persistProgress() {},
  });
  const h = await f.snapshot.requestRefresh({ source: 'AUDIT', dayEpoch: 1, refreshAccount: true, refreshPositions: true }).result;
  if (h.status !== 'COMMITTED') throw Error('initial snapshot aborted');
  const prepared = f.daily.prepareRecalculationFromAllOrders([rawNew], scope, now);
  f.recorder.commitRebuildSnapshot([{ symbol: 'A.HK', isLongSymbol: true }], [rawNew],
    () => prepared.isCurrent() && f.snapshot.isCurrent(h.snapshotToken, { account: true, positions: true, paired: true }), 'ACTIVATION');
  f.daily.publishRecalculation(prepared);
  f.flow.recordCumulativeExecution({ orderId: 'BUY', symbol: 'A.HK', side: 'BUY', monitorSymbol: 'HSI.HK',
    isLongSymbol: true, isProtectiveLiquidation: false, factStage: 'OPEN', executedPrice: '1',
    executedQuantity: 100, executedAmount: '100', executedTimeMs: t + 2000, orderUpdatedAtMs: t + 3000 });
  f.flow.settleOrder({ orderId: 'PROTECTIVE', symbol: 'A.HK', side: 'SELL', monitorSymbol: 'HSI.HK',
    isLongSymbol: true, isProtectiveLiquidation: true, closedReason: 'FILLED', source: 'WS',
    executedPrice: '0.9', executedQuantity: 100, executedAmount: '90',
    executedTimeMs: t + 1000, orderUpdatedAtMs: t + 1000 });
  const h2 = await f.snapshot.requestRefresh({ source: 'AUDIT', dayEpoch: 1, refreshAccount: true, refreshPositions: true }).result;
  if (h2.status !== 'COMMITTED') throw Error('flat snapshot aborted');
  const completions = [];
  const settlement = createPostTradeSettlementWorkflow({ snapshot: f.snapshot,
    scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout }, termination: f.termination,
    logger: createLoggerDouble(), clock: { now: () => now }, diagnostics: { record() {} }, retryDelayMs: 1,
    isExternalFailure: isExternalApiRequestError, onPositionsCommitted: async () => {}, hasPendingProtectiveOrders: () => false,
  });
  settlement.bindBusinessDeps({ monitorSymbol: 'HSI.HK',
    seats: { getSeatState: () => ({ status: 'EMPTY', symbol: null }), getSeatVersion: () => 1 },
    episodes: f.episode, completionPersistence: { appendCompletionIdempotent: c => completions.push(c) },
    lossBoundaries: f.daily, cooldownTriggers: { recordLiquidationTrigger() {} },
    riskProjection: { prepare() { throw Error('no active seats'); }, publish() {} },
  });
  const accepted = settlement.completeProtectionRecovery({ snapshotToken: h2.snapshotToken, pendingProtectiveDirections: new Set() });
  console.log('NEW_RA01_SETTLEMENT', JSON.stringify({ accepted, completions, episodes: f.episode.getInProgressEpisodes() }));
}
for (const old of [true, false]) {
  const daily = makeDaily(old);
  daily.resetAll(new Date(t));
  daily.recordCumulativeExecution(fill(old));
  daily.commitProtectionBoundary(daily.prepareProtectionBoundary({
    direction: 'LONG', boundaryExecutedTimeMs: t + 2000,
  }));
  let durable = 0;
  const result = daily.recordCumulativeExecution({
    ...fill(old), executedPrice: old ? 1.1 : '1.1', orderUpdatedAtMs: t + 32000,
  }, () => durable++);
  console.log(old ? 'OLD_VC1' : 'NEW_VC1', JSON.stringify({
    result, durable, loss: daily.getLossOffset('LONG'),
  }));
}
const first = Date.parse('2026-10-07T10:00:00+08:00');
const at = first + 600000;
const cooldown = { mode: 'minutes', minutes: 5 };
for (const old of [true, false]) {
  const tracker = old ? createOldCooldown({ nowMs: () => at }) : createNewCooldown();
  (old ? createOldHydrator : createNewHydrator)({
    nowMs: () => at, logger,
    tradingConfig: { monitor: {
      monitorSymbol: 'HSI.HK', liquidationTriggerLimit: 3, liquidationCooldown: cooldown,
    } },
    liquidationCooldownTracker: tracker,
    mixedTradeLogRepository: { loadCompletionRecords: () => [0, 1, 2].map(i => ({
      recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION', version: 1,
      monitorSymbol: 'HSI.HK', direction: 'LONG',
      boundaryExecutedTimeMs: first + i * 60000, orderBaselines: [],
    })) },
  }).hydrate();
  const get = () => tracker.getRemainingMs({ direction: 'LONG', cooldownConfig: cooldown, currentTimeMs: at });
  const before = get();
  tracker.recordLiquidationTrigger({ direction: 'LONG', executedTimeMs: at, triggerLimit: 3, cooldownConfig: cooldown });
  console.log(old ? 'OLD_VC5' : 'NEW_VC5', JSON.stringify({ before, after: get() }));
}
for (const old of [true, false]) {
  const effects = { cancel: 0, read: 0, submit: 0, quantity: null };
  const clock = () => new Date('2026-02-16T07:56:00Z');
  const pending = [{ orderId: 'OLD', submittedQuantity: 60, executedQuantity: 0,
    status: 'NEW', orderType: 'ELO', submittedPrice: '9', submittedAt: clock().getTime() }];
  const target = (old ? createOldSubmit : createNewSubmit)({
    logger, diagnostics: { record() {} },
    rateLimiter: { throttle: async () => {}, withTradeMutation: async run => run({ invoke: async invoke => invoke() }) },
    cacheManager: { clearCache() {} },
    orderMonitor: {
      getPendingSellOrders: () => pending,
      cancelOrder: async () => { effects.cancel++; return { kind: 'CANCEL_CONFIRMED', relatedBuyOrderIds: [] }; },
      captureSellAvailabilityGuard: () => () => true, trackOrder() {},
    },
    orderRecorder: {}, globalConfig: { tradingOrderType: 'ELO' }, ctx: {},
    readSellPositions: async () => { effects.read++; return [{ symbol: 'BULL.HK', quantity: 100, availableQuantity: 40 }]; },
    tradeMutationPort: { submitOrder: async (payload, issued) => {
      issued(); effects.submit++; effects.quantity = payload.submittedQuantity;
      return { kind: 'ACCEPTED', orderId: 'NEW' };
    } },
    marketDataClient: { getQuotes: async () => new Map([['BULL.HK', { price: '1.1', lotSize: 100 }]]) },
    monitorConfig: { monitorSymbol: 'HSI.HK' }, unrealizedLossBuyGate: {},
    canExecuteSignal: () => true, canTradeNow: () => ({ canTrade: true }), recordBuyAttempt() {}, now: clock,
  });
  const result = await target({ kind: 'SELL',
    signal: { symbol: 'BULL.HK', symbolName: null, action: 'SELLCALL', reason: '末日清仓', seatVersion: 1 },
    direction: 'LONG', side: old ? OrderSide.Sell : 'SELL',
    executionPurpose: 'DOOMSDAY_CLEARANCE', purpose: 'DOOMSDAY_CLEARANCE',
  }, () => true);
  console.log(old ? 'OLD_VC4' : 'NEW_VC4', JSON.stringify({ result, effects }));
}
'@
```

预期关键输出：

```text
OLD_RA01 after=无法精确冻结 protection boundary baseline
NEW_RA01 after={direction:LONG,boundaryExecutedTimeMs:1791338401000,orderBaselines:[]}
NEW_RA01_RESTART [DailyLossTracker] cannot reconstruct protection boundary baseline: orderId=BUY
OLD_VC1 authoritativeFactChanged=false,durable=0,loss=0
NEW_VC1 admission=ADMITTED,authoritativeFactChanged=true,executionAdvanced=false,durable=1,loss="0"
OLD_VC5 before=0,after=300000
NEW_VC5 before=0,after=0
OLD_VC4 WAITING_FOR_AUTHORITATIVE_TERMINAL,cancel=1,read=0,submit=0
NEW_VC4 SUBMITTED,cancel=0,read=1,submit=1,quantity=40
```

V-C1、V-C4、V-C5的处置建议补充：

- **V-C1／major等价验收差分**：最小处理不是先回滚权威merge，而是明确批准“经济封存但权威revision继续准入”的规则，再保留旧oracle差分说明，并补closed/tracked、重复progress、后续新增量、跨日与重启断言；若没有批准则恢复原准入边界。维度：implementation/spec/tests。
- **V-C4／B01：已授权业务变更，非问题**：按用户确认保留“旧SELL不撤、不改、不合并，仅按最新available新增”的策略，不恢复旧cancel／terminal-wait流程，不列major或验收阻塞；原差分与验证继续作为变更证据。
- **V-C5／major等价验收差分，合理修复候选**：若用户批准恢复与在线行为一致，保留当前过期cycle清零，并补“重启／不重启同输入同结果”测试；若严格不允许修旧缺陷，则需要保留旧重启冷却语义，但应记录其不一致风险。维度：implementation/spec/tests。

## 不能扩写的结论

- 没有“已证明全仓等价”结论；G5主责覆盖不等于所有跨组状态机独自完成。
- 没有把负US持仓拒绝、protective accepted清成本、旧updatedAt筛选直接当新缺陷。
- 没有把V-C1/C5的可解释改进自动当授权，也没有把V-C4直接写成必然漏平仓。
- G5-RA01的现象和两版反证已确认，但第二代理复核尚未回传；提交主代理时必须保留该状态。
