# G0→G2 独立交叉复核：metadata、订阅重投影与 WAIT owner

## summary

- **verdict：独立复核支持 G2 报告第 3 节这三个差异及其直接生产调用边界内“未发现已确认新增缺陷”的结论。三项均保留了本次查验的交易安全不变量，并有可重复证明的收益；不是要求恢复旧竞争/丢唤醒行为的未授权业务漂移 finding。**
- **不能据此声称零可观察差异，也不能批准 G2 全 42 文件或整个换标买卖算法。** 完整 metadata、当前订阅和补唤醒，确实可能让旧实现偶然跳过/卡住的合法工作完成，甚至改变一次具体运行的最终交易轨迹；本报告区分“保留政策的正确性/活性改进”与“放宽交易授权或改变数量/持仓政策”。
- scope：仅复核 `audit-market-strategy.md:144-148`、`:153-161` 三项，以及必要直接 caller、develop、生产装配和测试。没有重做 G0 首审、全文件地图或 G2 的 42 文件首审。
- confidence：**medium**。两版源码、全部相关生产入口实参与独立离线测试/差分相互印证；没有实盘、原生 SDK 部分成功合同或任意并发穷举证据。
- review independence：本代理是 G0 首审者，不是 G2 首审者。本轮直接读取两版源码/实参，并重新运行定向测试和独立构造差分；不是把 G2 的自查结果直接改称独立二审。
- 固定 develop：`6e239c8a128372bd9b2fb2d79464346792a5e81e`。
- 固定 current/HEAD：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。
- 恢复后 `HEAD`、`develop`、`origin/develop`、`FETCH_HEAD`、merge-base 均再次核验未变；Git 可见工作区干净，`beta-V2...origin/beta-V2 [ahead 1]`。**本轮没有 fetch、checkout、reset、merge 或修改受审源/测试/配置。**定向测试 preload 默认写了被忽略的 `tests/logs`，是本代理未事先隔离的执行副作用/只读纪律偏离，详见 §5；不以 Git 干净掩盖。
- 模型：本代理与 G2 的当前活动进程均明确 `--provider cliproxyapi --model gpt-6.1-sol --thinking max`；同一 run 找到的 **10 个子代理 JSONL 会话**全部 model/thinking 事件及 assistant message 元数据一致。详细证据见 §6，不以模板或默认值推定。

## critical issues

None。

## major issues

None。

## minor issues

None。下述实参范围、不可取消已发 SDK mutation、可选见证等是结论边界，不是在当前生产调用链已证实的缺陷。

## 1. 裁决标准与首审结论的限定

已重新加载 code-review、typescript-project-specifications、core-program-business-logic、lazy-senior-developer、context-mode。本次仍以固定 develop 源码为旧行为真值，不用更新后的 business skill 倒推旧需求。

用户明确允许不同实现但必须更优，因此不采用“每个内部输出/时序变化都需独立认定为未经授权业务变化”的过严标准：

1. 先确认 develop 真正行为，承认可观察差异。
2. 证明安全约束仍在实际 caller/最终副作用边界成立，而不是只看新代码注释。
3. 给出可触发的真实收益，不能只说新架构更合理。
4. 如果改变门禁、方向、数量、卖单归属、回补预算、策略阈值或恢复政策，则仍必须单列，不可借“owner 改进”批准。

计划 `docs/architecture/architecture-refactoring-implementation-plan.md:33` 列明事实一致性修复等例外；`:69-79` 保留事件/不同 policy/订单终态/各时段门禁；`:87-88` 要求旧 epoch/版本不能放行旧业务，snapshot、ready、ACTIVE 各一真实 owner。本报告不单凭计划含某项就推定有业务授权，而是以 caller 证据与差分裁决。

G2 第 3 节 `:142` 对零漂移严格口径留有用户裁决保留。本次按用户最新说明收敛：**这三项不需仅因内部可观察差异再升级为授权争议；但差异与对完成轨迹的可能影响仍必须在汇总中保留。**

| 差异 | 确实改变什么 | 没有证明发生什么 | 二审裁决 |
| --- | --- | --- | --- |
| getQuotes 捕获 metadata | await 期间退订/重订后的 name、prevClose、lotSize 输出与旧版不同 | 没有因此为旧席位/跨日/关门信号签发交易授权 | 完整读取实参、避免伪零/混代 metadata 的正确性收益成立 |
| 订阅 mutation 后重投影 | 同一 awaited 命令可按新 truth 增减订阅；不再使用旧 removed 差集；失败责任更窄 | 没有把持仓投影变成持仓写入或 settlement ready；没有替无关 owner 偷首次准入 | 保护当前事实、收敛当前订阅与保留失败责任的收益成立 |
| WAIT keeper 与 advance 分离 | 关门/接管时保留已发布 owner；在途订单事件可补一次推进 | 没有在接管/午休/旧 epoch/失效席位下允许新增 mutation | 活性改善成立；不能称买卖轨迹逐字相等，但不等于放宽买卖 policy |

## 2. getQuotes metadata 捕获

### 2.1 两版真实差异

- develop `src/services/quoteClient/index.ts:474-480` 只在入口检查已订阅；`:482-489` await realtime；`:515-520` 才读取静态 cache 和 `prevCloseCache.get(...) ?? 0`。
- current `src/infrastructure/longbridge/market/quoteClient.ts:475-491` 在第一个 await 前，逐个检查 subscribed/staticInfo 并捕获 `{symbol, staticInfo, prevClose}`；`:493-500` await；`:514-529` 使用原 captured metadata。
- current `quoteClient.ts:363-371` 缺 prevClose 是内部状态不变量错误，不伪造 0；订阅阶段 `:581-604` 先建立真实 prevClose，`:608-614` SDK subscribe 成功才登记 subscribed。
- 两版退订都会在 SDK 成功后删本地 metadata。current 精确位置 `quoteClient.ts:642-659`。新实现并未禁止退订或因旧调用永久 retain。

**独立差分 M1**：AST 提取两版原 `getQuotes` 函数（没有重写其控制流），只对 builder 注入观察口以隔离金融精度升级：合法已订阅 A.HK → realtime await → 清 subscribed/staticInfo/prevClose → 返回 realtime。

| 传给 quote builder 的实参 | develop | current |
| --- | --- | --- |
| name | null | Entry Name |
| lotSize | null（观察口表示实际缺失） | 100 |
| prevClose | 0 | "99.2" |

exit 0。这里比较的是 metadata 实参，不声称观察口是完整 SDK quote builder。真实 current adapter 的 unsubscribe→resubscribe（新名称/新手数）两分支在 `tests/infrastructure/longbridge/market/quoteClient.test.ts:763-815` 实际运行通过。

### 2.2 可证明收益与真正影响

- 不把 cache 回收误写成“昨收就是 0”；同次已准入读取不在 await 后混入另一次订阅的 metadata。缺 realtime 仍返回 null，warn 使用入口名称；没有补造 realtime 价格。
- `prevClose` 在当前生产消费中只用于市场展示：`src/infrastructure/display/marketMonitor/index.ts:95`、`utils.ts:27-33`；未发现策略阈值或买卖触发消费该字段。name 主要进入展示/日志。
- **lotSize 不只是日志字段**：当前 `src/application/orderExecution/submitFlow.ts:393-400` 用于最终 BUY 数量；`quantityResolver.ts:105-108` 缺/非法 lotSize 返回 0；换标回补 `src/application/seatSwitch/switchStateMachine.ts:1393` 也用 lotSize。因此“绝不影响交易”是不准确的。旧 metadata 因退订竞争丢失时，完整 lotSize 可能避免一次合法 BUY 被偶然跳过。
- 旧 lotSize 缺失同样会跳过，不是新版修改了“没有手数就允许买入”：develop `src/core/trader/orderExecutor/quantityResolver.ts:115-119`、`:149-172`。本轮没有批准金融精度/整手公式的其他变更（G2 §3 第 2 项不在指定范围）。

### 2.3 实参与实际授权边界

生产 getQuotes 调用点已全量定位，不仅检查一个普通 BUY：

| current caller | 实际传入 | await 后的直接约束/消费 |
| --- | --- | --- |
| `application/ordinaryBuy/index.ts:81-82` | monitor + 当次 ACTIVE LONG/SHORT | 原 dayEpoch、原 signal seat/version、termination、task gate；风险后再次 callerAuthorization（`:114`） |
| `application/ordinarySell/index.ts:186-190` | 当次 ACTIVE 席位 symbol | 原 origin + selected snapshot/receipt/seat；不 current 则重选，不拿旧 quote 直接执行 |
| `application/orderExecution/submitFlow.ts:329-330,706` | 最终命令单 symbol | 最终 BUY/SELL/REPLACE 授权反复复核；最终 SDK issue `:454,481-490` 仍使用原授权闭包 |
| `application/seatActivation/index.ts:279-290` | awaited retain/admission 的 activation symbols | 每步 canContinueActivation；不可把返回 quote 当作 ACTIVE 准入凭据 |
| `application/seatSwitch/switchStateMachine.ts:143,1331-1335,1414-1418` | 当前 switch plan 的目标单 symbol | quote await 后 stopIfSwitchInvalid；真实 orderExecutor 继续用 canContinue + 同一 switch state |
| `application/staticLiquidation/index.ts:199,217-220` | monitor + 当次 long/short wakeup | receipt、snapshot、dayEpoch、原 purpose/route；失效重评估 |
| `application/doomsdayClearance/index.ts:373-375` | 当前席位集合 | isLive；之后命令仍经过 doomsday 专用执行授权 |
| `application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:763-765` | 本次已订阅 allTradingSymbols | 原 rebuild receipt invalidation；不能把晚到 quote 放进失效重建 |
| `runtime/monitorDisplayRuntime/index.ts:70-72` | 单 monitor | 展示 gate，仅渲染 |
| `runtime/tradingQuoteDisplayRuntime/index.ts:137,154-167` | 单 monitor 补充报价 | 重新检查 running、gate、当前 risk route，仅渲染 |

最终交易授权另直接确认 `src/application/orderExecution/index.ts:341-419`（当日、连续时段、purpose、接管/买入截止）、`:429` 起 caller+seat/direction；并非“quote 完整即可交易”。develop 最终 quote 后也检查授权，见 `src/core/trader/orderExecutor/submitFlow.ts:424-435`，该不变量没有被本项放宽。

**重要限定**：metadata 捕获不是原子市场快照/行情新鲜度证明，也不包含 subscription generation 授权。捕获的是 staticInfo 对象引用与 prevClose 值，不是深冻结所有 SDK 对象。若未来 caller 在合法读后任意退订/改变同 symbol 静态数据，却故意保留所有交易授权，raw API 可返回入口旧 lotSize；不能以本报告保证这种新 caller 正确。当前直接 `unsubscribeSymbols` 仅由 quote runtime owner 调用；reset 归重建/清理，相关授权失效后丢弃旧结果。当前生产 caller 边界内未找到旧 metadata 令已失效任务恢复交易的反例。

**裁决**：保留准入/最终门禁不变量且收益证实。无需为恢复 `prevClose ?? 0` 或晚读新 metadata 提出修复。

## 3. Quote subscription 重投影与失败 owner

### 3.1 develop 对照，不把所有纪律说成新发明

- develop `src/main/quoteSubscriptionRuntime/index.ts:129-151` 在命令开始时一次计算 added/removed，然后跨 subscribe await 使用旧 removed。
- develop `:163-169` 已把 desired update 与 SDK mutation 串行执行；`:191-194` 已禁止未准入 ACTIVATING 由普通席位投影首次接入；`:239-260` 已区分全量与 position reconciliation。**这些不变量不是重构新创造。**
- current `src/runtime/quoteSubscriptionRuntime/index.ts:129-182` 分开重投影、首次 admission 和只保护当前事实；`:188-267` 每个成功 SDK 阶段立即写 committed 后重新循环计算；`:278-287` 仍使用同一串行命令链。

### 3.2 生产实参与职责矩阵

| 入口/current 行号 | 实参/投影权限 | 成功或失败的 owner |
| --- | --- | --- |
| `reconcileFromCurrentTruth:367-383` | ALL；启动/受控重建显式启用四类 truth | startup/rebuild caller await，不等同 steady event |
| `reconcilePositionHoldFromCurrentTruth:389-395` | POSITION_HOLD；传入 token 是通知，实际读取当前 canonical snapshot | settlement/activation caller await；失败原样交原 owner |
| `handleSeatChanged:341-354`、`handleOrderHoldChanged:356-365` | ORDINARY；monitor/seat/order，不能首次接入失败 position symbol | 普通事件无恢复 owner，原失败政策仍 fatal |
| `retainSymbols:452-466` | NONE；显式临时 owner/reason/symbols 在自己命令执行时入 store；失败回滚 | activation/WAIT owner await，负责有限重试/错误分类 |
| `releaseRetain:469-477`、`waitForAdmission:479-492` | NONE，不代 POSITION_HOLD/ORDINARY 的首次准入 | 原临时 owner；返回不是 S ready/ACTIVE 凭据 |
| `stopAndDrain:423-443` | 停接事件、关闭 admission、清 retain 后串行退订 | cleanup owner；失败不自行重开准入 |

实际临时 retain 生产 caller 只有 activation、monitor static WAIT、switch WAIT；实际 reason 分别为 `SEAT_REFRESH_WAIT`、`STATIC_LIQUIDATION_WAIT`、`SWITCH_WAKEUP`，没有任意业务模块用 POSITION_HOLD reason 绕入口。activation 对照 `application/seatActivation/index.ts:279-290,519`；WAIT 直接调用点 `runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:322,369`、`switchWakeupRuntime.ts:354,404`。

`_token` 不用于“重放通知当时的持仓集合”是正确边界；G0 直接 app mapping `src/app/runtime/createPostGateRuntime.ts:275-277` 把 positions commit 交唯一 quote owner；S/activation await 后仍自行复核 receipt/identity。不能把 quote reconciliation 的 void 完成升级成业务 ready。

### 3.3 独立差分与收益

**S1（两版原工厂，不落盘）**：初始 OLD.HK 已订阅；positions r2=SLOW.HK，position owner 发起 subscribe SLOW 并挂起；期间当前 positions 变 r3={OLD.HK,LATEST.HK}；释放 SDK，不另发一个 position 命令来“替新实现收尾”。

| 观察点（排空清理前取值） | develop | current |
| --- | --- | --- |
| subscribe | HSI+OLD；SLOW | HSI+OLD；SLOW；LATEST |
| unsubscribe | **OLD** | **SLOW** |
| 返回时实际订阅 | HSI、SLOW（旧投影） | HSI、OLD、LATEST（当前 truth） |

exit 0。由此证实的不是抽象“同步更好”：旧差集会把已重新需要的 OLD 退掉，并返回尚未收敛当前 truth；新 owner 保护 OLD，移除过时 SLOW，在同一负责持仓的命令内接入 LATEST。

真实 canonical H + app S mapping + quote owner 的集成 `tests/integration/quoteSubscriptionFailureOwnership.integration.test.ts:412-472` 本轮独立运行通过：r10 await 中 r11，旧 token 晚通知不退 OLD，最终 ready 使用 r11。失败政策 `:263` 起及 `tests/runtime/quoteSubscriptionRuntime/failureOwnership.business.test.ts:24` 起也独立通过：subscribe/unsubscribe 外错交回 awaited POSITION_HOLD，普通后继只做自己的 mutation，不偷重试。

### 3.4 哪些并非“只改时序”，哪些仍受限

- 远端 subscribe/unsubscribe 的集合和次数确实不同；缺/错退订减少可让风险、卖出或 activation 少一次缺价/等待，属于可观察活性变化。但订阅不写账户/持仓，不改订单数量，不生成 BUY/SELL，不签发 S ready。
- **不能无限概括为“从此绝不退订当前需要标的”**。若新的事实是在一个 unsubscribe 已经发到 SDK 后才出现，代码无法撤销远端指令；它只能登记真实 ACK，再按所属 projection 重读/重接或交后续 awaited owner。保护保证适用于本次发 mutation 前可见事实，而不是撤回在途网络请求。
- 部分成功指“成功的 subscribe/unsubscribe 阶段 ACK 已记录”，不是证明 SDK 一次批量请求内任意部分成功而抛错也可逐 symbol 得知；本轮没有原生 SDK 合同验证。
- 不能为了“更快”把 ORDINARY/NONE 升为 ALL。否则会替其他 owner 消耗首次准入、把可恢复外错推入 fatal；本次层次有实际责任，不是无收益复杂化。

**裁决**：当前事实一致性/失败归属收益证实，不改变交易 policy。无需回退循环或把所有事件统一全量重投影。

## 4. switch WAIT：保留 owner 不等于推进许可

### 4.1 develop 的可观察行为与 current 的差异

- develop `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:178-186` 把 doomsday takeover 直接当 route 终止；`:802-814` 只用已安装 ORDER_EVENT 索引；`:763-767` 关门后不安装本次 WAIT。
- develop monitor distance caller `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:768-785` 结果返回后又要求原 ACTIVE/purpose continuation 才 handoff；periodic caller `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts:104-121,170-183` 也在返回后检查交易 gate。
- current `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:177-196` 分离 route termination 与 execution gate；`:843-864` 对**仍在途、原 route current、当前席位 symbol 匹配**的订单事件先走 trigger 锁存 dirty；`:803-807` 先安装真实 WAIT，再按 gate 暂停。
- current `:522-558` 的真实推进仍要求 running + lifecycle/gate/非接管 + route dayEpoch/seatVersion/pending + 原 receipt current + selected positions token current；`:716-767` await freshness 后重检，然后才调用业务 `advancePendingSwitch`。

### 4.2 两个真实生产 handoff caller 的实参

**distance caller**：`src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:644-692`。

- result 必须 started，必须有本轮 `publishedRoute`，方向匹配且 `isCurrent()`；当前席位仍 SWITCHING、symbol 与 witness 匹配、seatVersion 一致。
- 传给 runtime 的是原 result、同一 monitorContext、方向、**捕获的 originalDayEpoch**，没有换当前 epoch 补票。
- witness 原工厂见 `src/application/seatSwitch/switchStateMachine.ts:640-684`：验证实际同步发布后创建，闭包同时核对 switch map 的对象身份、seatVersion、symbol、SWITCHING。不是“只要任意 WAIT 对象都能借当前席位续跑”。

**periodic caller**：`src/application/seatSwitch/periodicSwitchTask.ts:34-86`。

- 发起前 `canOwnTask + 原 dayEpoch + 原 ACTIVE route + 原 receipt/task continuation + getCanTradeNow`。
- WAIT 之后，不再要求已经因同步发布 SWITCHING 而必然失效的 ACTIVE 身份；要求 witness 的 direction/symbol/seatVersion/function 合同、原 task owner/epoch 与 witness current，再传原 WAIT + originalDayEpoch。
- 这只是交回已发布事实 owner，不是再调用 start 或使用 witness 代替原 mutation permit。

**receiver 的 raw API 边界**：`switchWakeupRuntime.ts:1007-1049` 始终检查 runtime/lifecycle、context identity；originalDayEpoch 与 publishedRoute 在公共类型中允许缺省（`runtime/monitorQuoteEventRuntime/types.ts:271-287`）。缺省时会用当前 epoch，且只有提供 witness 才做 witness 校验。**所以“接收器对任意调用一律强制真实发布见证和原 epoch”不是准确结论。** 本次裁决成立于已完整搜索的两个生产 caller：二者都显式提供 originalDayEpoch，且先验证真实 publishedRoute。无缺省参数的第三个生产 caller；测试可用简化 WAIT。若将来新增 caller，必须保持该实参纪律，而不能引用当前二审为 raw API 任意输入兜底。

### 4.3 独立差分与实际用例

**W1/W2（原两版 runtime 工厂，memory scheduler）**：注入相同 manager 和原 gate；不使用新业务状态机的买卖算法代替旧算法。

| 触发 | develop | current | 说明 |
| --- | --- | --- | --- |
| 已消费初始 timer；advance 在途；新的 ORDER_EVENT 先于返回 ORDER_EVENT WAIT 索引安装 | advance=1，pending=true | advance=2，pending=false | 新版补住真实事件空隙；不是“两个版本执行轨迹相等” |
| advance 等待时跨 doomsday takeover；返回 SYMBOL_QUOTE WAIT，再发 quote/order | advance=1，retain=0 | advance=1，retain=1 | 新版保留 owner 但**没有第二次 advance** |
| 上述场景 stopAndDrain | timer=0，未释放 retain=0 | timer=0，未释放 retain=0 | owner 保留不是资源泄漏/跨日续跑许可 |

exit 0，fatal 均为空。该探针只验证 scheduler/keeper，不声称模拟真实成交。

本轮另直接运行并读取：

- `tests/integration/distanceSwitchIndependentSell.integration.test.ts:933` 两种真实订单来源 ZERO_CANCEL/HANDOFF_REJECTED；暂停的是嵌套 await 的结果回传，WAIT 与订单/释放由真实 owner 产生，不手造一个额外 timer/事件来替它唤醒。
- `tests/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts:1631`：发布之前进入接管，未发布、handoff=0、advance=0、broker=0；`:1663`：已真实发布后接管，handoff 保留但 advance/broker 均 0，日切后旧 epoch 不再接收。
- `tests/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts:1891,1940,2014,2068,2240`：午休重开、在途午休、stop 撤 continuation、lifecycle 关闭删除、接管只保留 owner；实际通过。

### 4.4 是否真的改变买卖行为

**是，活性修复可能改变一条具体运行轨迹。** 旧实现在事件空隙卡住 pending，新版下一次合法推进可能最终卖出/回补/激活；不能把这描述成“完全不涉及买卖”。但本项没有改成在旧 gate 关闭时执行同样 mutation，也没有把原 receipt 自动换成新授权。

真实 state machine 仍把每次 quote/订单 await 后的 `canContinue` 与 state 身份带到 executor：`src/application/seatSwitch/switchStateMachine.ts:1331-1335,1409-1418`；已 accepted ACK 的登记独立于后续旧票失效（`:1421-1429`），不是再提交一次。

最终 executor `src/application/orderExecution/index.ts:341-419,429` 与 `submitFlow.ts:454,481-490` 仍校验当日/连续时段/末日 purpose/原 caller/席位与卖出事实。**keeper 没有授权额外取消、买入、卖出，也没有增加新的 switch mode。** 它让本来已经开始的工作不丢 owner，并在以后真正允许时才继续。

**不因此批准相邻业务变化**：独立卖单与普通旧 SELL 是否合并、哪些 sell ID 进入回补预算、拒单/零成交/重算恢复/初次业务发布等由 seat/order/risk 对应二审单独裁决。即便这些地方另有缺陷，也不能从 keeper 的改善推出整个 state machine 正确；反过来也不能把相邻根因混入这三项。

**裁决**：独立活性/ownership 收益证实；保留不同门禁与最终执行授权。没有证据需要恢复接管期间销毁已发布 WAIT 或删除在途订单事件锁存。

## 5. 本代理实际验证与复现边界

### T1 — metadata、position 失败归属、WAIT owner

```powershell
bun --no-env-file test tests/infrastructure/longbridge/market/quoteClient.test.ts tests/runtime/quoteSubscriptionRuntime/failureOwnership.business.test.ts tests/integration/quoteSubscriptionFailureOwnership.integration.test.ts tests/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts
```

Bun v1.4.2 `(744846f84)`；exit **0**；**79 pass / 0 fail / 564 expect() calls**；4 files，3.92s。

### T2 — 两个真实 handoff caller 与真实订单空隙

```powershell
bun --no-env-file test tests/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts tests/integration/distanceSwitchIndependentSell.integration.test.ts tests/integration/periodicAutoSymbolChain.integration.test.ts
```

exit **0**；**66 pass / 0 fail / 568 expect() calls**；3 files，460ms。

### T3 — metadata 不得替代最终副作用授权

```powershell
bun --no-env-file test tests/application/orderExecution/finalQuoteMutationPermit.business.test.ts
```

exit **0**；**23 pass / 0 fail / 170 expect() calls**；1 file，99ms。直接包括 `:600` quote await 期间关门、`:645` P1 后 seat 失效，均不继续 mutation。

**合计：8 个不同文件、168 pass、0 fail、1302 expect() calls。** 这是本轮实际运行，不引用 G2 历史输出为本轮结果；也不是全套门禁。

### 验证副作用与只读纪律偏离（非生产代码 finding）

运行上述测试前，本代理确认它们不写 source/config、没有真实 SDK，但遗漏了测试全局 preload 的日志路径。`bunfig.toml:3` 自动加载 `tests/setup/testRuntime.ts`；该文件 `:13-17,22-24` 在未显式指定 APP_LOG_ROOT_DIR 时使用 `tests/logs`。`--no-env-file` 只是不读 env 文件，**不代表禁止日志写入**。logger 真实文件流见 `src/infrastructure/logger/index.ts:386-391`。

后续只读核查观察到被忽略的 `tests/logs/system/2026-10-21.log`（5036 bytes）和 `tests/logs/debug/2026-10-21.log`（4941 bytes），mtime 均为 **2026-10-20T16:49:09.229Z**，与本轮 T1 期间相符；`git status --ignored --short -- tests/logs` 返回 `!! tests/logs/`。没有前置 ignored-artifact 快照，不能宣称其他忽略输出逐字不变。

这是本代理未预先把 launcher 日志根隔离的验证执行偏差，不是受审源码缺陷；已主动告知主代理。**没有清理/回滚日志，也不再运行默认日志根测试。**受审源、测试、配置与冻结 refs 仍未变。只有本报告属于主动授权的证据写入，不能再写成“任何文件均未落盘”。今后如重跑，应先由主代理明确授权 TEMP 日志输出，再显式设置 APP_LOG_ROOT_DIR；不要仅凭 Git 干净宣称完全只读。

### M1 / S1 / W1-W2 独立旧新差分

均用 `bun --no-env-file --eval` 内存代码：

1. `git show <固定SHA>:<旧路径>` 读取旧源码，Bun.Transpiler 去类型；M1 用 TypeScript AST 精确取原 getQuotes，S/W 用原工厂完整函数。
2. 不改生产控制流；旧模块仅把原导入能力注入真实可复用 helper/观察口，适配 old LastState/trader 与 current snapshot/orderMonitor 的数据来源。S 注入同一 positions getter；W 未测试 abort 分类、金融/订单算法，因该场景不走这些分支。
3. 注入内存 API/timer/缓存，按 §2/3/4 的顺序释放 Promise；在 stop/drain 前复制 observations，避免 cleanup 改变证据数组。
4. M1 exit 0、S1 最终 exit 0、W1-W2 exit 0，输出见对应表。无 SDK context、无实盘、无日志落盘、无临时测试文件。

**探针准备失败如实记录**：S1 最初用 Bun `data:text/javascript` 动态加载 TS 转译模块，被当文本而不是模块，factory 未导出，exit 1；诊断后改为内存 Function 注入。第二次已经观察到期望差分，但结果数组仍引用清理会修改的数组，cleanup 后的断言误报，exit 1；改在 cleanup 前 structuredClone 后第三次 exit 0。两次是探针装载/观察方式错误，没有修改仓库、没有生产测试失败。M1 与 W1-W2 首次执行均 exit 0。

## 6. 实际本地模型/思考配置核实

### 6.1 方法与 G2 直接证据

核实范围仅本次审计的 run：

`C:/Users/65459/.pi/agent/pi-codex-subagents/runs/d05757cd87992b122c072242/`

不是从任务模板或报告自述推定。只读查询了：

1. 活动 `node.exe` 的 Win32_Process ProcessId/ParentProcessId/CommandLine，提取 `--provider`、`--model`、`--thinking`、`--session`。
2. 逐个 JSONL 的 `model_change`、`thinking_level_change`；再机器核对全部已记录 assistant message 的 provider/model，避免只看开头一次 metadata。
3. 仅提取配置字段，不导出环境变量、密钥或账户信息。

**G2** 的会话为 `0f14212a-1f9c-4ef4-b64e-a7a54d86dd0b.jsonl`，初始任务明确对应 `audit-market-strategy.md`：

- `model_change` ID **6504d5a7**，时间 **2026-10-20T11:52:57.858Z**：provider=`cliproxyapi`，modelId=`gpt-6.1-sol`。
- `thinking_level_change` ID **4830a176**，同一时间：thinkingLevel=`max`。
- 恢复后活动进程 **PID 55152 / parent 36880** 明确参数 `--provider cliproxyapi --model gpt-6.1-sol --thinking max --session .../0f14212a-...jsonl`（观察时间 2026-10-20T16:45:14.223Z）。
- 此会话已记录 assistant messages 的 provider/model 全部一致，无其他模型切换记录。

因此 **G2 首审报告未写足 metadata 不等于模型不可核实或不合规；本地运行配置已由独立证据补齐。**

### 6.2 同 run 统一核对表

下表 PID 是 **2026-10-20T16:45:14.223Z** 的恢复后快照值，不把旧启动 PID 与恢复 PID 不同误判为模型变化。每个会话都有 model/thinking 各一个事件，全部 `cliproxyapi/gpt-6.1-sol / max`；所有可见 assistant 元数据均同模型，nonmatching=0。

| 任务（由首个实际 user task 确认） | 会话文件名（上述目录） | 恢复后 PID | model/thinking 事件时间 UTC |
| --- | --- | ---: | --- |
| G0/基线地图/本交叉复核 | `c97d1070-6870-4893-afb7-d29f532e9af3.jsonl` | 49064 | 11:51:45.565 / 11:51:45.566 |
| G1 lifecycle | `bffcbacb-b3dd-4d36-a066-95d6c5953394.jsonl` | 31004 | 11:52:57.835 |
| G2 market-strategy | `0f14212a-1f9c-4ef4-b64e-a7a54d86dd0b.jsonl` | 55152 | 11:52:57.858 |
| G3 seat-selection 首审 | `77a4ce97-75ed-4bf6-bc46-39f0a060615b.jsonl` | 无活动进程 | 11:52:57.905 |
| G4 order-execution | `e73604e0-d552-4be0-9557-d2745841cdb2.jsonl` | 53400 | 11:52:57.977 |
| G5 risk-account | `34cadedc-6229-4bfe-aefb-24c48c075152.jsonl` | 54956 | 11:52:57.999 |
| G6 infra-config 重启首审 | `56a228f9-fb4d-47fb-a92b-02cf0de9177e.jsonl` | 41932 | 11:54:03.599 |
| validation 重启 | `d3dc5dd3-cef3-4c4d-8dab-bd3078472d72.jsonl` | 32780 | 11:54:21.683 |
| infra/HK 范围与激活 normalize 独立二审 | `0773b2d1-29dd-4242-bea1-8defa6df54ce.jsonl` | 44804 | 12:47:04.588 |
| seat/卖单/回补独立二审 | `442bdf2c-d8cd-44f2-8d4e-629f16e05ef5.jsonl` | 41692 | 12:47:39.481 |

**后续再次观察 2026-10-20T17:03:02.921Z**：本 run 活动进程为 8 个，均同 provider/model/thinking；G2 再恢复为 PID **37300**，G3 首审也恢复为 PID **47272**，G1 为 **42140**，validation 为 **47368**；其余活动者为 G0 **49064**、infra **41932**、两独立二审 **44804/41692**。所以 G3 现也有同会话 CLI 证据，不仅会话事件；order/risk 此时不在活动进程列表，但此前快照和原会话均已核实。PID 数量变化是任务结束/恢复观察，不推定模型变化。

补充：`C:/Users/65459/.pi/agent/settings.json` 默认实际上是 **openai-codex/gpt-6-luna / max**，不是任务要求的模型；此次显式 CLI 和会话配置覆盖了默认值。没有把默认模型误作为实际模型，也没有修改设置。

**边界**：未审查 cliproxyapi 代理后端真实供应商/模型路由，不能凭本地 metadata 证明远端实现。统一核验覆盖本 run 找到的 10 个会话，及两个时间快照合计覆盖到全部 10 个会话的活动 CLI；没有声称 10 个同时活动。此前 RPC 超时但未留下本 run 会话的启动尝试没有可查实际执行证据。没有为核实而启动新子代理。

## positive findings

1. metadata 的生命周期与 caller 授权分开：完整读取不授权过期业务；quote 缺失也不被伪造成可用价格。
2. subscription 保留旧串行 update/首次准入纪律，再加当前事实重投影；没有让“保护已订阅”变成“偷新 owner 准入”。
3. WAIT keeper 基于真实发布见证，advance 基于当前授权；两种能力不互相代替，能补空隙又不跨接管窗口交易。
4. 增量 ACK 与 accepted 事实不因后续旧票失效被否认；最终 stop/drain 仍清理 retain/timer，没有拿安全停机换活性。

## 7. 七维审查与覆盖边界

| 维度 | 本轮结论 |
| --- | --- |
| implementation | 三个差异的原两版路径、生产参数与最终副作用授权已追踪；收益由定向测试和独立差分证明；无已确认新增缺陷 |
| project/spec | 按“业务不变量不漂移、实现允许更优”裁决，不要求复刻竞争错误；计划不被单独当作业务授权 |
| type design | 检查 Quote/market port、projection union、WAIT handoff/witness；明确 token/witness 可选 raw API 与两个生产实参的区别 |
| tests | 本轮 8 文件 168 pass，另 3 类内存差分；不是全套/原生 SDK；测试通过不代替 develop 对照 |
| comments | 核对 metadata 捕获/owner/WAIT 关键 why；“保护当前事实”限定为可见事实，未把注释读成能取消已发网络请求 |
| dead code | 已追踪本次 getQuotes、subscribe/unsubscribe、retain、handoff 全部生产调用点；未扩展全仓 dead-code 审计，没有删除建议 |
| simplification | projection/keeper 区分有实际失败/空隙反例支撑，不建议回退成全量重投影或统一 gate wrapper |

## not assessed

- G2 其余指标/DSL/策略采样/延迟验证、金融文本升级、MACD 简化不在本交叉任务；不据此签发全 42 文件二审通过。
- 整个 switch 买卖政策、原卖单合并/关联、回补预算、恢复/拒单 fatal 等相邻问题由其他二审负责。本报告只裁决 keeper/scheduler/metadata/订阅接缝。
- 真实 SDK partial batch success、静态资料对象原地修改、同 symbol 交易日内手数变更、无限持续事实变动时调度公平性未作生产实验。
- 无实盘、无应用启动、无真实 broker/native context 或 durable 落盘恢复；未独立运行全套构建/type-check/lint。
- 只有当前已核实的生产 caller 纪律成立；未来新增任意 raw API caller 不能直接继承“无缺陷”结论。
- 本地模型证据不是代理后端路由审计，也不是主代理模型配置审计。

## recommended next actions

1. 汇总中将三项标为“**独立复核：保持交易不变量、有可证明收益的行为/活性改进；无该根因新增 finding**”，并保留可能改变合法完成轨迹的事实，勿简写“完全等价”。
2. 不建议恢复伪零 metadata、旧 removed 差集、关门销毁已发布 WAIT，或把所有订阅命令提升为 ALL。若后续发现真实买卖政策偏移，应按独立根因报告，不能从这三项借授权。
3. 将本报告 §6 并入统一模型核实证据，为 G2 补齐实际配置记录；同 run 无模型不符记录。统一 tests/build 仍以 validation 实际输出为准。

## 附录：最终只读核验

2026-10-20T17:01:38.888Z 再次直接读取：`HEAD=2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`，`develop=origin/develop=FETCH_HEAD=6e239c8a128372bd9b2fb2d79464346792a5e81e`；`git status --porcelain=v1 --branch` 仅显示 `## beta-V2...origin/beta-V2 [ahead 1]`，没有受审文件变更。报告所有必需章节、三个实际测试命令均已核验。

仅主动创建本交叉报告，没有回写 G0/G2 首审报告或对测试日志进行清理；测试 preload 的 ignored 日志副作用详见 §5，不纳入“受审代码未改”的隐含豁免。
