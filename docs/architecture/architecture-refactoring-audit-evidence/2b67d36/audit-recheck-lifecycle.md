# LC-01 独立二审：同连续交易时段重建恢复丢失周期换标唤醒

## summary

- **verdict：confirmed，major。**独立追踪生产装配和所有可见恢复入口后，确认新增的 lifecycle 复合派发门禁与旧的「只发布连续交易时段边沿」通知契约没有闭合。已到期 ACTIVE 路线可在重建成功后保留 `blockedOnGate`，没有任务也没有周期 timer。
- **范围校正**：不是整个交易系统停摆，也不是永久不恢复。全日市上午通常到 13:00 会恢复；半日市上午／全日市下午没有当天再次开门的保底，可能延续到下一交易日。same-direction truth mutation 或明确停止后重启等可更早恢复，不应说“任何事件都不能唤醒”。
- **confidence：high**（代码因果、可达条件和差分验证）；不声称该组合已在线上发生或造成实际损失。
- **固定基线**：current `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop／origin/develop／FETCH_HEAD `6e239c8a128372bd9b2fb2d79464346792a5e81e`。二审读取时四个 ref 一致，工作区干净。
- **执行模板**：宿主 PowerShell 确认 `cliproxyapi/gpt-6.1-sol`、`max`。context-mode 沙箱中的 PI 环境变量未继承，因此没有用该沙箱的 undefined 误判模板不符。
- 本次没有重跑全量或整套生命周期测试；仅执行下述独立、定向、固定源码的组合探针。没有修改仓库生产、测试、配置文件。

## critical issues

None。没有发现此问题会绕过交易授权或必然导致错误买卖的证据。

## major issues

### LC-01 — confirmed：恢复 gate 已开但已到期 periodic 没有恢复事件

- **claim**：signal domain 恢复 periodic 时 manager 的 lifecycle gate 仍关闭；已到期 route 清掉 due timer 后在第一层 gate 检查退出。manager 最后开门不通知 periodic；若本次评估的连续时段状态与上次同为 true，唯一连续 gate producer 不发边沿。挂起路线因而没有再次执行的必达入口。
- **impact：confirmed（离线可达行为），生产损失为 potential**：周期到期检查、建立等待空仓状态及其后的换标可能延迟。特别是恢复后卖出清空原持仓／本地订单时，本来应由周期等待 owner 接续，但当前路线连 waiting-empty 也未登记；订单和 fresh 事件不会救回它。仍持仓时并不应强行换标，因此不能把每一例挂起都量化成漏换或损失。
- **dimensions**：implementation、project/spec、type contract、tests。统一根因只计此一项。

### 1. 生产装配与恢复顺序（独立阅读，不依赖首审断言）

| 固定 current 位置 | 独立确认事实 |
| --- | --- |
| `src/app/runApp.ts:253-286` | 唯一 app 装配将同一 lifecycleState/tradingTimeState、bus、manager 接给 time evaluator/runtime；不是两份不相干 gate。 |
| `src/app/runtime/createPostGateRuntime.ts:417,737-759` | periodic 使用同一 bus；`getCanTradeNow` 精确为未终止 ∧ lifecycle.isTradingEnabled ∧ tradingTime.canTrade===true，due 用交易日历累计时长。 |
| `src/app/lifecycle/createLifecycleRuntime.ts:91-157,173-183` | 默认注册次序 signal→market→seat→order→risk→global；没有额外 post-open periodic callback。 |
| `src/runtime/lifecycle/dayLifecycleManager.ts:80-145,293-345` | 逆序 await 各域；运行 signal 时 lifecycle 仍 OPEN_REBUILDING/false；所有原 captured COMMITTED 验证后才 openAdmission、ACTIVE、isTradingEnabled=true。 |
| `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:109-145` | 完成 quote/S baseline 后，在 `:126` synchronous periodic.start，再启动后续 owners、重启 worker；返回 COMMITTED 不是已经开启 manager gate。 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts:357-390,651-675` | start 注册后立即 seed；due<=now 清掉 timer 后直接 dispatch。 |
| 同文件 `:209-254,296-316` | dispatchQueue 在进入任何 fresh await 前就看 gate；关闭则 blockedOnGate=true，dirty 已消费，dispatchBaseline 保留；没有任务/未来 timer。async 函数在第一个 await 前执行是同步的，不能假设 gate 在它看之前已打开。 |
| `src/runtime/timeWakeupEvaluationProgram/index.ts:219,288-309,325,359-365` | previousCanTrade 在 manager.tick 之前捕获；manager 外错重试结果返回后也更新纯连续时段 true；下次成功若 true→true 不发事件。 |
| 同文件 `:47-70,376-384` | **完整**自动寻标授权会在恢复时 false→true 发布；这不是完全没有恢复事件，而是 periodic 没订阅该事件。 |

### 2. 最小可达条件与实际路径

需要同时具备：自动寻标开启、正周期、有效 ACTIVE+activation+version+dayEpoch baseline、due<=periodic 恢复 seed 的真实当前时间，以及此前失败/评估已将本连续时段 canTrade 置 true。正常首次 false→true 开盘或 due 仍在未来不会因此丢失，探针有反例对照。

1. 前一日 15:59 激活 LONG 同一 HK 标的，周期 5 个交易分钟；午夜前仍持有该标的（不是手造的无持仓跨日 ACTIVE）。
2. 午夜 manager 在 false gate 下真实 stop/drain；`seatDomain.ts:55-67` 捕获 ACTIVE baseline 再清席位。`seatActivationCarryover.ts:31-93` 只对恢复成相同 symbol 的席位保留原时间。前日 ACTIVE 不触发“失败跨第二天清 carryover”分支。
3. 09:30 开盘 load 的外部请求失败；before seat preparation 的失败不会消费 carryover。manager 失败分支 `dayLifecycleManager.ts:365-389` 按 30/60/120/240s 退避（常量 `src/constants/index.ts:94-98`），evaluator 已发布连续门禁 true。
4. 09:37:30 第五次 load 成功。真实 loader `loadTradingDayRuntimeSnapshot.ts:517-543` → `seatPreparation.ts:23-59` → `domain/seat/seatPolicy.ts:291-318` 用成交历史+当前持仓找回原 symbol。`rebuildTradingDayState.ts:377-403,429` 在 gate 关闭下按 carryover 提交 ACTIVE，随后才清 carryover。真实累计 due=当日09:34。
5. global open→risk/order/seat/market→signal；periodic seed 已到期而 lifecycle gate 尚false，进入 blockedOnGate，无 timer、无 task。signal 返回后 manager 开门。
6. evaluator 发现连续时段 true→true，不发 continuous gate-open。完整自动寻标授权恢复只会驱动 EMPTY，当前 LONG ACTIVE 不受影响。恢复后正常报价、订单通知、真实 S refresh/fresh 都可以持续，periodic 仍不派发。

边界：不要求正好四次失败；只要成功 seed 时已有 overdue baseline 且纯连续 canTrade 已是 true 即可。四次失败用于给出不依赖异常调度的明确示例。首次在交易时段启动若没有跨日 carryover，activation 通常被重置为本次重建时刻，due 在未来；不能把所有启动失败恢复一概判为受影响。

### 3. 所有可见解除／重排旁路的排除与保留

对 `src/` 的 gate producer、periodic 返回方法调用者、symbolRegistry mutation、AUTO_SYMBOL_TICK producer 做全量字面引用搜索，再阅读下列实现；不把搜索命中本身当作深读结论。

| 旁路 | 是否能恢复此路由 | 证据及限制 |
| --- | --- | --- |
| 真实连续 gate-open | **能** | periodic `:449-473`；全日市13:00的 false→true 会 dispatchBaseline/plan。12:00、16:00的关闭边沿不会救回。 |
| 完整 autoSearch authorization 恢复 | **不能保证；对本例无效** | time evaluator `:47-70,376-384` 确实发布；periodic 类型 `types.ts:18-22` 只暴露 continuous observer。autoSearchWakeup `:168-177,310-340` 只 trigger EMPTY；另一个方向 EMPTY 变更不能 plan LONG。 |
| 订单／O hold 改变 | **本例无效** | periodic `:429-446,660-663` 的 redispatch 只查 waitingEmpty；初次 gate block 发生在尚未生成业务 task 前，waitingEmpty=null。orderHold/quote subscription 的真实对账不会写当前 ACTIVE 席位。 |
| S fresh（含 H position commit ack 后） | **本例无效** | periodic `:665-671` 只补 waitingEmpty 或 blockedOnFreshness；gate 检查在 freshness 之前，blockedOnFreshness=false。探针使用真实 S 发新 need、真实 H commit、真实 fresh，而非只手调空 observer。 |
| monitor quote | **正常安全区内无效** | quote runtime `monitorQuoteEventRuntime.ts:638-689,793-817,838-854` 走 distance，不调用周期 evaluate。真实 `switchStateMachine.ts:1655-1764` 在距离安全区内直接 NOOP、不写席位；探针用真实 workflow 的该分支。 |
| 距离真的越界→新换标/激活 | **可使旧路线失效并产生新路线** | switchStateMachine `:1727-1757` → enterSwitchingSeat；这是另一业务触发，不保证发生，不等于当前 overdue periodic 已正确恢复。不能断言任意后续 quote 都救回，也不能忽略该有条件旁路。 |
| 同方向任一 public truth mutation（包括值相同） | **能** | registry `symbolRegistry.ts:281-324` 每次 mutation 都同步 emit truth；periodic `:424-426` 不要求 baseline 真的变了，直接 plan。探针原值重写 LONG 即恢复1条合法任务。生产写入只在 autoSearch／activation／switch／recovery／midnight 等明确业务动作，正常账户/报价不会必然写该 ACTIVE route。 |
| 另一方向的 truth mutation／EMPTY 寻标成功 | **不救回 LONG** | truth callback 只 plan(event.direction)。独立探针对 SHORT 原值 mutation 后 LONG 仍0。 |
| 系统 time timer／开盘保护结束／末日窗口 | **本例无效** | time evaluator `:272-285,325-365` 只重新计算时间门禁；保护期结束不产生 continuous false→true。实测恢复后 system 下个timer是09:45，但该评估仍0；关闭保护时下一timer12:00也不是恢复入口。末日 workflow 或真实交易若改变席位属于有条件业务旁路，不是 timer 自动重播 periodic。 |
| 反复 evaluate / lifecycle.tick（pending=false） | **无效** | manager `:281-284` 只重写ACTIVE/true；没有 bus publication。probe 额外真实 evaluate 不派发。 |
| 再调用 periodic.start | **运行中无效** | periodic `:651-658` 幂等直接return。probe 已检查。 |
| 真 stop→start／次日日切重建 | **能** | periodic `:678-704` 清 route map，start重新seed；生产 start只有 `startupRuntime.ts:28` 与 `signalRuntimeDomain.ts:126`，没有定时自重启。下一交易日若正常首轮开盘可恢复，已做真实 midnight→open 对照。进程重启会重置内存激活语义，不作无条件保证。 |
| 已挂 future due timer | **能，且不属于此缺陷** | periodic `:394-415` due>now时保留timer。15分钟周期对照在09:37:30恢复还保留1个timer，到09:44派发；不是“所有周期失活”。 |
| failed-task reevaluate timer | **本例不存在** | `:576-613` 必须先有实际任务失败结果；gate前置block没有任何 task。 |
| task result / markWaitingEmpty / clearWaitingEmpty | **本例不存在合法调用者** | application `periodicSwitchTask.ts:90-96,101-120` 是真实入口；periodic `:523-532` 检查 dispatchedCanContinue原owner。没有派发就没有有效任务回调，不是可自行修复的后台轮询。 |
| H.openAdmission / logger / diagnostic | **无直接恢复** | H `accountPositionSnapshot/index.ts:556-560` 只调度其 pending；manager `:350-363` 只记录诊断与日志。不能把 isTradingEnabled 被写true误认为事件已通知。 |

### 4. develop 真行为及回归归因

- develop `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:109-136` **本就**在 manager 最后开门前 periodic.start；这段旧恢复顺序本身不是新增缺陷。
- develop `src/main/periodicSwitchWakeupRuntime/index.ts:128-150,177-233,431-445` 对 overdue seed 直接 scheduleLatest；没有 current 新增的派发前 lifecycle gate 挂起层。
- develop `src/main/lifecycle/dayLifecycleManager.ts:206-218` 最后设true；`src/main/timeWakeupEvaluationProgram/index.ts:298-321,371-377` 也只发连续边沿。不能把“事件不是复合gate”单独说成新引入。
- develop `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:78-111` 用 setImmediate 异步消费；同一成功恢复链的 microtask 先让 manager 开门。旧 handler `handlers/autoSymbol.ts:144-174` 随后检查 getCanTradeNow 并执行 due。
- 独立旧版探针不是单跑旧 periodic：从固定 develop **原** registry、periodic、queue、signal、manager、queueRunner、handler 组合；未重定向业务 import或改写函数。观测到 manager.tick 返回时队列已有task，下一真实 setImmediate 中 handler 见 gate=true且调用 due一次。business evaluate 和S/外部恢复是最小替身，未宣称跑了完整旧app。
- 因而回归归因是：**新增派发 gate 约束未配套 lifecycle 恢复交接**；不是要求撤回 gate约束，也不是旧版必然在关闭gate时执行错误交易。

### 5. 受影响时间窗口与延迟上限（从成功恢复算起）

前提是 timer按时执行、route一直有效、fresh最终ready且没有更早同方向 truth mutation；真正业务换标还必须满足原空仓/候选等条件。这里的“恢复”只指获得一次合法 due任务，不是承诺下单或成交。

| 恢复时窗 | 当前默认保底恢复点 | 额外延迟与边界 |
| --- | --- | --- |
| 全日市上午09:30≤r<12:00，同段true→true | 13:00的真实gate-open | `13:00-r`；粗上限3小时30分（严格失败重试例从09:30:30起，至多3小时29分30秒）。09:37:30例为3小时22分30秒。12:00只是关闭，不算恢复。 |
| 全日市下午13:00≤r<16:00，同段true→true | 当天没有再次开门 | 可错过剩余整个下午。若下一自然日是交易日且重建正常，同一symbol/activation仍可恢复，则下一日09:30；13:08例为20小时22分。周末／假日会延长。 |
| 半日市上午09:30≤r<12:00 | 当天没有13:00开门 | 可错过剩余半日。若下一自然日正常交易开盘恢复，09:37:30例为23小时52分30秒；不是统一“最多拖到当天13:00”。 |
| due在未来、没有正周期、EMPTY/ACTIVATING、不继承旧activation、正常初次false→true | 此 finding 不适用 | future due原timer或初次开门事件仍有效；不可扩大为全量启动/周期停摆。 |

**不存在无条件的固定墙钟延迟上限。**下午/半日后的下次真实交易日取决于日历和未来重建；若未来开盘也重复同类失败后同段恢复，缺失通知可反复出现。源内8分钟的最大外部重试间隔不构成此挂起的恢复上限；重建成功后nextRetryAtMs已清，periodic也没有失败重试timer。另一方面，有同方向truth或新交易时段时能够恢复，因此也不能称之为永久deadlock。

### 6. minimal fix（不实施）

在最终重建COMMITTED且 lifecycle真开门后，向 periodic 当前挂起需求交接一次恢复重评估。最小根因方向可复用**已存在的完整授权恢复事件**（time evaluator `:376`），给periodic增加明确恢复订阅；或由manager最终开门的owner显式发布lifecycle-resumed。只作为重读当前route并恢复dispatch/plan的触发，不把事件payload当新交易凭据。

保留 getCanTradeNow、epoch/seatVersion/activation baseline、fresh receipt、single-flight、原task closure和stop/drain。新通知与正常continuous-open同时发生时须幂等，不得重复任务；不能提前打开全局gate、删掉新授权检查、伪造纯连续门禁变化、增加固定轮询，或分别在quote/order/fresh三个消费者打补丁。

### 7. 独立验证结果／反例

最终附录probe exit=0（7个场景，所有fatal/errors=[]），没有运行首审probe。构建时曾因将旧periodic依赖误命名为orderMonitor而exit=1；已按真实旧trader契约修正，再使用完整固定源码成功运行。构建失败不是生产缺陷证据。

| 独立场景 | 恢复时观察 | 注入旁路／后继时序 | 结果 |
| --- | --- | --- | --- |
| develop原signal+manager+queueRunner+handler | manager开门前已入队 | 真实setImmediate执行 | handler执行时gate=true，due调用1次（due业务本身为记录调用的替身） |
| 首次false→true，1分钟周期正好到期 | 09:30恢复即1个task | 无重复 | 证明不是所有start都会挂；之后fresh使旧receipt失效是正常保护，未作为错误 |
| 四次外错后全日上午09:37:30 | ACTIVE/true、carryover恢复、H/S fresh；0 task、0 periodicTimer | O事件、真实S need/refresh/fresh、8个安全区报价、额外evaluate、幂等start、SHORT truth；09:45保护结束 | 全部仍0；12:00仍0，13:00得到1个当前授权有效task |
| 相同恢复，LONG原值truth mutation | 初始0 | registry真实public同方向写入 | 不需要gate边沿即得到1个有效task，确认有条件旁路 |
| 半日市 | 同上 | 12:00→13:00，后真实midnight→次日09:30 | 当天0；下一正常交易开盘1 |
| 外错持续至午后（真实system退避一直从09:30推进，含午休/13:00） | 13:08恢复，恢复时loads=24、task=0 | 16:00→真实midnight→次日09:30 | 当天0；下一正常开盘1。最后loads=25含次日重建，不是25次失败。 |
| 恢复时due未到（15分钟） | 09:37:30有1个periodicTimer | 09:44触发原timer | 得到1个有效task；与本finding区别明确 |

建议正式回归在同一真实app装配/生命周期组合上保留：同段外错恢复即exactly-one task、首次正常false→true无重复、future due不提前、同/异方向truth、fresh/order不冒充lifecycle、全日/半日/下午、无carryover/不同symbol、跨epoch/stop迟到回调不派发。当前 `tests/runtime/periodicSwitchWakeupRuntime/business.test.ts:147-218` 将getCanTradeNow与手工emitGate一起改变，无法发现生产复合门禁与pure-edge的脱节；`signalRuntimeDomain.test.ts:326-518` 以替身记次序，不验证这次实际交接。

## minor issues

None。未把命名／冗余注释／无完整消费证明的dead-code怀疑列成问题。

## positive findings

- gate/receipt在真实await后复核、single-flight、stop清timer和route identity仍须保留；confirmed liveness问题不等于这些安全改进应撤销。
- 正常false→true和future-due控制均能派发；真实same-directiontruth、下一交易开门可恢复，影响已据此收窄。
- 自动寻标的完整授权恢复通知本来就存在，改动可在owner交接处完成，无需新轮询或对报价/订单分别兜底。

## not assessed / 七维界限

- **implementation/project/type/tests**：仅本候选真实装配、通知契约、恢复链与旁路，证据如上；type问题是连续gate observer无法表达lifecycle恢复，不是缺readonly或any。
- **comments**：相关注释不能证明会有恢复事件；`blockedOnGate`称“原连续交易门禁”与实际复合predicate不同，仅作为此同根因契约证据，不另列风格问题。
- **dead code/simplification**：搜尽本候选可见调用入口，没有执行删除或提出泛化抽象；不是全仓死码/架构审计。
- 未在线调用SDK、不衡量实际网络失败概率／真实持仓交易损失；未重跑全测试或完整current/develop应用。probe没有覆盖全部旧恢复算法、风险/订单重建事务、全部pending-switch路由、production调度阻塞或发布回退。
- createPostGateRuntime与runApp只深读本候选gate/bus/due装配段，没有宣称整文件全审。真实H/S不被替身伪造ready；loader/rebuild与不相关owner替身边界在附录明确。

### 二审实际生产源码覆盖

- **current深读**：`runtime/periodicSwitchWakeupRuntime/{index,types}.ts`；`runtime/tradingGateEventRuntime/index.ts`；`runtime/lifecycle/dayLifecycleManager.ts`、`runtime/lifecycle/{types,startupRuntime}.ts`；`runtime/lifecycle/cacheDomains/{signalRuntimeDomain,globalStateDomain,seatDomain,marketDataDomain,orderDomain,riskDomain}.ts`；`app/lifecycle/createLifecycleRuntime.ts`；`runtime/timeWakeupEvaluationProgram/{index,types}.ts`；`runtime/timeWakeupRuntime/index.ts`；`runtime/timeWakeupPlanner/index.ts`；`runtime/autoSearchWakeupRuntime/index.ts`；`domain/seat/symbolRegistry.ts`；`application/seatActivation/rebuiltSeats.ts`；`application/tradingDayRebuild/{seatActivationCarryover,seatPreparation,openRebuild}.ts`；`runtime/seatActivationDispatcher/index.ts`；`application/seatSwitch/{index,seatStateManager,distanceSwitch,periodicSwitchTask}.ts`；`app/runtime/createAsyncRuntime.ts`；`runtime/asyncProgram/monitorTaskProcessor/index.ts`。
- **current定向片段**：`app/runtime/createPostGateRuntime.ts:260-311,417,650-809`；`app/runApp.ts:245-367`；`application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:450-561`、`rebuildTradingDayState.ts:335-439`、`tradingCalendarPrewarmer.ts:1-145`；`domain/order/orderOwnership.ts:100-139`；`domain/seat/seatPolicy.ts:280-318`；`domain/tradingSession/index.ts:195-314`；`domain/seat/switchPolicy.ts:39-72`；`application/seatSwitch/switchStateMachine.ts:200-290,1490-1764`；`runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:1-265,638-689,790-912`、`switchWakeupRuntime.ts:835-1004`；`runtime/quoteSubscriptionRuntime/index.ts:360-489`；`application/accountPositionSnapshot/index.ts:1-190,480-603`；`application/postTradeSettlement/index.ts:50-200,230-349,395-527,625-819`；相关accountPosition/settlement/seat/time/runtime types；`runtime/asyncProgram/monitorTaskQueue/index.ts:1-145`；`runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts:78-130`；`constants/index.ts:94-98`；`utils/apiFailure/index.ts`。
- **develop原源码对照／内存执行**：`main/periodicSwitchWakeupRuntime/index.ts:49-150,177-234,355-405,418-463`；`main/lifecycle/cacheDomains/signalRuntimeDomain.ts:44-136`；`main/lifecycle/dayLifecycleManager.ts:45-101,170-248`；`main/timeWakeupEvaluationProgram/index.ts:296-337,365-383`；`main/asyncProgram/monitorTaskProcessor/queueRunner.ts:1-150`、`handlers/autoSymbol.ts:1-186`；`main/asyncProgram/monitorTaskQueue/index.ts`；`services/autoSymbolManager/utils.ts` registry部分；`utils/time/index.ts`累计due算法。执行器在内存加载的其它未展示依赖不冒称人工全深读。

## recommended next actions

1. 合并主报告时将LC-01由“待复核候选”更新为confirmed major；使用本二审修正的旁路和下午/半日影响边界，不夸大成全系统永久停摆。
2. 在最终lifecycle恢复交接处补一次当前有效periodic需求重评估，并保留授权/epoch/receipt/stop/single-flight。
3. 修复验证优先覆盖真实同段恢复组合，而不是只给测试harness手工emitGate。没有本候选以外的全量测试重跑要求。

## 附录 A：独立组合探针源码

此探针独立编写，不调用首审报告附录。读取固定 SHA 原模块并在内存转译；fake clock/timer、无网络。启动生产 `createLifecycleRuntime` 默认域组装，而不是手动伪造 gate-open；组合真实 H/S、periodic、autoSearch wakeup、quote distance runtime、seatRegistry、midnight carryover、seatPreparation、rebuilt activation、openRebuild、dayManager、time evaluator 与 time runtime。外部 loader IO 在返回原 snapshot receipt 后采用真实恢复规则，rebuild 中本问题无关的风险/订单/显示算法用空实现替代；处理器启停不消费队列，入队作为此探针观察边界。不会被解读为全 app 回放。

```javascript
const cp = require('child_process');
const path = require('path');
const root = 'D:/Code/HSI-Strategy-Trading';
const OLD = '6e239c8a128372bd9b2fb2d79464346792a5e81e';
const HEAD = '2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144';
Object.assign(process.env, { APP_RUNTIME_PROFILE: 'test', APP_ENABLE_PROCESS_HOOKS: 'false',
  APP_LOG_ROOT_DIR: 'C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/infra-test-logs' });
const req = require('module').createRequire(root + '/package.json');
const ts = req('typescript');
const modules = new Map();
function load(p, ref = HEAD) {
  const key = ref + ':' + p;
  if (modules.has(key)) return modules.get(key).exports;
  const source = cp.execFileSync('git', ['show', key], { cwd: root, encoding: 'utf8' });
  const module = { exports: {} }; modules.set(key, module);
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const local = q => q.startsWith('.')
    ? load(path.posix.normalize(path.posix.join(path.posix.dirname(p), q)).replace(/\.js$/, '.ts'), ref)
    : req(q);
  new Function('require', 'module', 'exports', '__dirname', '__filename', js)(
    local, module, module.exports, root + '/' + path.posix.dirname(p), root + '/' + p);
  return module.exports;
}
const no = () => {};
const lifeOwner = () => ({ start: no, stop: no, stopAndDrain: async () => {}, restart: no });
async function flush() { for (let i = 0; i < 220; i++) await Promise.resolve(); }
function check(x, label) { if (!x) throw new Error('ASSERT: ' + label); }
async function scenario({ name, half = false, session = 'morning', interval = 5, branch = 'boundary', failures = 4 }) {
  let at = Date.parse('2026-04-29T00:00:00+08:00');
  const clock = { now: () => new Date(at) };
  const fatals = [], events = [], auths = [], tasks = [], orderListeners = new Set(), quoteListeners = new Set();
  const termination = { isTerminated: () => fatals.length !== 0, reportFatalError: e => fatals.push(String(e)) };
  const logger = { info: no, warn: no, error: no, debug: no };
  const diagnostics = { record: no };
  function schedulerFor(label) {
    const timers = new Map(); let sequence = 0;
    return { timers, scheduleTimer: (f, delay) => { const id = ++sequence; timers.set(id, { f, at: at + delay }); return id; },
      clearTimer: id => timers.delete(id), label };
  }
  const system = schedulerFor('system'), periodicTimers = schedulerFor('periodic'), background = schedulerFor('background');
  const initial = Date.parse('2026-04-28T15:59:00+08:00');
  const autoSearchConfig = { autoSearchEnabled: true, switchIntervalMinutes: interval, autoSearchOpenDelayMinutes: 0 };
  const config = { monitorSymbol: 'HSI.HK', longSymbol: 'BULL.HK', shortSymbol: 'BEAR.HK',
    autoSearchConfig, orderOwnershipMapping: ['HSI'], liquidationCooldown: { mode: 'minutes' } };
  const tradingConfig = { monitor: config, global: { doomsdayProtection: false,
    openProtection: { morning: { enabled: true, minutes: 15 }, afternoon: { enabled: false, minutes: null } } } };
  const registry = load('src/domain/seat/symbolRegistry.ts').createSymbolRegistry(config);
  registry.updateSeatState('LONG', { symbol: 'BULL.HK', status: 'ACTIVE', lastSwitchAt: null, lastSearchAt: null,
    lastSeatActivatedAt: initial, callPrice: '95', searchFailCountToday: 0, frozenTradingDayKey: null });
  const lifecycleState = { currentDayKey: '2026-04-28', lifecycleState: 'ACTIVE', pendingOpenRebuild: false, isTradingEnabled: true };
  const tradingTimeState = { canTrade: false, isHalfDay: null, openProtectionActive: null };
  const calendar = { cachedTradingDayInfo: null, tradingCalendarSnapshot: new Map() };
  const market = { isTradingDay: async date => ({ isTradingDay: true, isHalfDay: half && date.getTime() < Date.parse('2026-04-30T00:00:00+08:00') }),
    resetRuntimeSubscriptionsAndCaches: async () => {},
    onQuoteUpdated: f => { quoteListeners.add(f); return () => quoteListeners.delete(f); } };
  let held = true;
  const snapshot = load('src/application/accountPositionSnapshot/index.ts').createAccountPositionSnapshot({
    dayEpoch: 1, clock, diagnostics, reportFatalError: termination.reportFatalError, scheduler: { schedule: queueMicrotask },
    readPort: { getAccountSnapshot: async () => ({ currency: 'HKD', totalCash: '10000', netAssets: '11000',
      positionValue: '1000', cashInfos: [{ currency: 'HKD', availableCash: '10000' }] }),
      getStockPositions: async () => held ? [{ symbol: 'BULL.HK', symbolName: 'HSI RC', accountChannel: 'cash',
        currency: 'HKD', quantity: 100, availableQuantity: 100, costPrice: '10' }] : [] } });
  const api = load('src/utils/apiFailure/index.ts');
  const settlement = load('src/application/postTradeSettlement/index.ts').createPostTradeSettlementWorkflow({
    snapshot, clock, diagnostics, scheduler: background, termination, logger, isExternalFailure: api.isExternalApiRequestError,
    retryDelayMs: 1000, hasPendingProtectiveOrders: () => false, onPositionsCommitted: async () => {} });
  settlement.bindBusinessDeps({ monitorSymbol: config.monitorSymbol, seats: registry,
    episodes: { getInProgressEpisodes: () => [], prepareCompletion: () => null, commitCompletion: no },
    lossBoundaries: { getLossOffset: () => '0' }, completionPersistence: {}, cooldownTriggers: {},
    riskProjection: { prepare: symbol => ({ symbol, data: { r1: '0', n1: 0 } }), publish: no } });
  const bus = load('src/runtime/tradingGateEventRuntime/index.ts').createTradingGateEventRuntime({ logger });
  bus.onGateStateChanged(e => events.push(e));
  bus.onAutoSearchAuthorizationChanged(e => auths.push(e));
  const orderMonitor = { onOrderStateChanged: f => { orderListeners.add(f); return () => orderListeners.delete(f); },
    stopRuntimeAndDrain: async () => {}, startRuntime: no, clearTrackedOrders: no };
  const queue = { scheduleLatest: task => { tasks.push(task); return true; }, clearAll: () => 0 };
  const duration = load('src/domain/tradingSession/index.ts');
  const context = { config, symbolRegistry: registry, strategy: { resetForTradingDay: no, invalidateAll: no },
    riskChecker: { clearUnrealizedLossData: no, clearLongWarrantInfo: no, clearShortWarrantInfo: no } };
  const periodic = load('src/runtime/periodicSwitchWakeupRuntime/index.ts').createPeriodicSwitchWakeupRuntime({
    termination, snapshot, getCanTradeNow: () => !termination.isTerminated() && lifecycleState.isTradingEnabled && tradingTimeState.canTrade === true,
    monitorContext: context, symbolRegistry: registry, monitorTaskQueue: queue, orderMonitor,
    postTradeConsistencyRuntime: settlement, tradingGateEventRuntime: bus,
    calculateDueAtMs: ({ startMs, switchIntervalMinutes }) => duration.calculateTradingDurationDueAtMs({
      startMs, targetDurationMs: switchIntervalMinutes * 60000, calendarSnapshot: calendar.tradingCalendarSnapshot }),
    now: clock.now, scheduleTimer: periodicTimers.scheduleTimer, clearTimer: periodicTimers.clearTimer });
  const autoSearch = load('src/runtime/autoSearchWakeupRuntime/index.ts').createAutoSearchWakeupRuntime({
    termination, symbolRegistry: registry, autoSearchConfig, tradingTimeState, lifecycleState, tradingGateEventRuntime: bus,
    doomsdayProtectionEnabled: false, now: clock.now, scheduleTimer: background.scheduleTimer, clearTimer: background.clearTimer,
    autoSearch: { maybeSearchOnEvent: async () => {}, cancelSearch: no } });
  const seatSwitch = load('src/application/seatSwitch/index.ts').createSeatSwitchWorkflow({
    monitorConfig: config, symbolRegistry: registry, clock, logger, marketDataClient: market, cacheManager: {},
    orderHoldRegistry: { getHoldSymbols: () => new Set() }, orderMonitor, orderExecutor: {},
    orderRecorder: { getBuyOrdersForSymbol: () => held ? [{ orderId: 'BUY' }] : [] }, readSwitchPositions: async () => [],
    riskChecker: { getWarrantDistanceInfo: () => ({ distanceNumerator: '5', distanceDenominator: '100' }) },
    candidateSearch: { resolveDistanceRange: () => ({ min: '1', max: '10' }) },
    getTradingCalendarSnapshot: () => calendar.tradingCalendarSnapshot });
  context.seatSwitch = seatSwitch;
  const quote = load('src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts').createDefaultMonitorQuoteEventRuntime({
    logger, marketDataClient: market, monitorContext: context, now: clock.now, scheduleTimer: background.scheduleTimer,
    clearTimer: background.clearTimer, tradingTimeState, lifecycleState, snapshot,
    postTradeConsistencyRuntime: settlement, doomsdayProtectionEnabled: false, termination });
  const activation = load('src/application/seatActivation/rebuiltSeats.ts');
  const carry = load('src/application/tradingDayRebuild/seatActivationCarryover.ts');
  let loads = 0;
  async function loader() {
    loads++;
    if (session === 'afternoon' ? at < Date.parse('2026-04-29T13:01:00+08:00') : loads <= failures)
      throw api.createExternalApiRequestError({ operation: 'Probe.account', attempts: 1, cause: new Error('network unavailable') });
    const receipt = await snapshot.requestRefresh({ source: 'LIFECYCLE_REBUILD', dayEpoch: snapshot.getStatus().token.dayEpoch,
      refreshAccount: true, refreshPositions: true }).result;
    check(receipt.status === 'COMMITTED', 'H committed');
    await load('src/application/tradingDayRebuild/seatPreparation.ts').prepareSeatsForRuntime({ tradingConfig, symbolRegistry: registry,
      positions: snapshot.getView().positions, orders: [{ stockName: 'HSI RC', symbol: 'BULL.HK', executionStatus: 'FILLED', updatedAt: new Date(initial) }],
      startupSeatSearch: { searchSeat: async () => {} }, canContinue: () => snapshot.isCurrent(receipt.view.token,
        { account: true, positions: true, paired: true }), now: clock.now, resolveCanAutoSearchNow: () => false });
    return { status: 'COMMITTED', snapshotToken: receipt.view.token, allOrders: [], quotesMap: new Map() };
  }
  async function rebuild({ snapshotToken }) {
    calendar.tradingCalendarSnapshot = new Map([
      ['2026-04-28', { isTradingDay: true, isHalfDay: false }], ['2026-04-29', { isTradingDay: true, isHalfDay: half }],
      ['2026-04-30', { isTradingDay: true, isHalfDay: false }],
    ]);
    const seat = registry.getSeatState('LONG');
    const ok = activation.commitRebuiltSeatActivation({ symbolRegistry: registry, snapshot,
      getIsTradingEnabled: () => lifecycleState.isTradingEnabled, isTerminated: termination.isTerminated },
      { snapshotToken, seats: [{ direction: 'LONG', symbol: seat.symbol, status: seat.status,
        seatVersion: registry.getSeatVersion('LONG'), lastSeatActivatedAt: carry.resolveSeatActivationCarryover({
          symbolRegistry: registry, direction: 'LONG', symbol: seat.symbol }) ?? at }] });
    check(ok, 'rebuilt activation committed'); carry.clearSeatActivationCarryover(registry);
    return { status: 'COMMITTED', snapshotToken };
  }
  const quoteSubscriptionRuntime = { ...lifeOwner(), reconcileFromCurrentTruth: async () => {} };
  const post = { monitorContext: context, snapshot, lifecycleState, tradingTimeState,
    tradingCalendarState: calendar, quoteSubscriptionState: { allTradingSymbols: new Set() },
    periodicSwitchWakeupRuntime: periodic, autoSearchWakeupRuntime: autoSearch,
    monitorQuoteEventRuntime: quote, postTradeConsistencyRuntime: settlement, quoteSubscriptionRuntime,
    buyTaskQueue: { clearAll: () => 0 }, sellTaskQueue: { clearAll: () => 0 }, monitorTaskQueue: queue,
    tradingRiskEventRuntime: lifeOwner(), monitorDisplayRuntime: lifeOwner(), tradingQuoteDisplayRuntime: lifeOwner(),
    switchWakeupRuntime: lifeOwner(), seatActivationDispatcher: lifeOwner(), seatRuntimeCleanupDispatcher: lifeOwner(),
    ordinaryBuy: { resetRiskCheckCooldown: no }, dailyLossTracker: { resetAll: no }, protectiveLiquidationEpisodeTracker: { resetAll: no },
    liquidationCooldownTracker: { clearMidnightEligible: no, resetAllTriggerCounts: no }, loadTradingDayRuntimeSnapshot: loader,
    tradeRuntime: { orderMonitor, orderRecorder: { resetAll: no }, cacheManager: { clearCache: no },
      orderHoldRegistry: { clear: no }, orderExecutor: { resetBuyThrottle: no } } };
  const manager = load('src/app/lifecycle/createLifecycleRuntime.ts').createLifecycleRuntime({ logger, termination,
    preGateRuntime: { symbolRegistry: registry, warrantListCache: { clear: no }, marketDataClient: market, diagnostics },
    postGateRuntime: post, asyncRuntime: { buyProcessor: lifeOwner(), sellProcessor: lifeOwner(), monitorTaskProcessor: lifeOwner() },
    businessEventProgram: lifeOwner(), rebuildTradingDayState: rebuild });
  const evaluate = () => load('src/runtime/timeWakeupEvaluationProgram/index.ts').timeWakeupEvaluationProgram({
    logger, marketDataClient: market, cacheManager: {}, orderMonitor, orderExecutor: {}, tradingTimeState, lifecycleState,
    tradingCalendarState: calendar, snapshot, doomsdayClearanceWorkflow: {}, tradingConfig, monitorContext: context,
    tradingGateEventRuntime: bus, dayLifecycleManager: manager, now: clock.now });
  const tw = load('src/runtime/timeWakeupRuntime/index.ts').createTimeWakeupRuntime({
    termination, logger, now: clock.now, scheduleTimer: system.scheduleTimer, clearTimer: system.clearTimer, evaluate });
  await tw.start(); await flush();
  async function wake(iso) {
    at = Date.parse(iso); let runs = 0;
    while ([...system.timers.values()].some(t => t.at <= at)) {
      const [id, t] = [...system.timers].find(([id, t]) => t.at <= at); system.timers.delete(id); t.f(); await flush();
      if (++runs > 10) throw new Error('unexpected system loop');
    }
  }
  if (session === 'morning') {
    for (const part of ['30:00', '30:30', '31:30', '33:30', '37:30']) {
      await wake('2026-04-29T09:' + part + '+08:00');
      if (lifecycleState.isTradingEnabled) break;
    }
  } else {
    for (let i = 0; i < 60 && !lifecycleState.isTradingEnabled; i++) {
      const next = Math.min(...[...system.timers.values()].map(t => t.at));
      check(Number.isFinite(next), 'afternoon system retry timer exists');
      await wake(new Date(next).toISOString());
    }
  }
  const recoveredAt = clock.now().toISOString();
  const restored = registry.getSeatState('LONG').lastSeatActivatedAt === initial;
  const before = tasks.length;
  const periodicTimersAtRecovery = periodicTimers.timers.size;
  const nextSystemAtRecovery = new Date(Math.min(...[...system.timers.values()].map(t => t.at))).toISOString();
  check(restored && lifecycleState.isTradingEnabled && tradingTimeState.canTrade === true && (session === 'morning' ? loads === failures + 1 : loads > 5), name + ': valid restored current baseline');
  check(before === (failures === 0 ? 1 : 0), name + ': expected dispatch count');
  const gateEdges = events.length, authEdges = auths.length;
  if (!half && session === 'morning') held = false;
  for (const f of orderListeners) f({ symbol: 'BULL.HK' });
  settlement.recordSettlementRefreshNeed({ refreshAccount: true, refreshPositions: true });
  for (let rounds = 0; rounds < 3; rounds++) {
    for (const [id, t] of [...background.timers]) if (t.at <= at) { background.timers.delete(id); t.f(); }
    await flush();
  }
  const fresh = settlement.isCurrent(await settlement.waitForFresh());
  for (const f of orderListeners) f({ symbol: 'BULL.HK' });
  for (let i = 0; i < 8; i++) {
    for (const f of quoteListeners) f({ symbol: 'HSI.HK', quote: { price: '100' }, timestamp: at, revision: i });
    await flush();
  }
  await evaluate(); await flush(); periodic.start(); await flush();
  check(tasks.length === before, name + ': order/fresh/quote/true-eval/idempotent-start did not wake');
  registry.updateSeatState('SHORT', registry.getSeatState('SHORT')); await flush();
  check(tasks.length === before, 'other-direction truth does not replan LONG');
  const normalBypassTasks = tasks.length;
  if (branch === 'control') { /* Normal first opening already dispatched once. */ }
  else if (branch === 'sameTruth') registry.updateSeatState('LONG', registry.getSeatState('LONG'));
  else if (interval > 5) {
    for (const [id, t] of [...periodicTimers.timers]) if (t.at <= at + 3600000) {
      at = t.at; periodicTimers.timers.delete(id); t.f(); await flush(); break;
    }
  } else {
    if (session === 'morning') {
      await wake('2026-04-29T09:45:00+08:00');
      check(tasks.length === 0, 'open-protection edge is not periodic lifecycle recovery');
      await wake('2026-04-29T12:00:00+08:00');
      check(tasks.length === 0, 'close edge does not wake periodic');
      await wake('2026-04-29T13:00:00+08:00');
    } else await wake('2026-04-29T16:00:00+08:00');
  }
  await flush();
  const tasksAfterBranch = tasks.length;
  if (half || session === 'afternoon') {
    check(tasks.length === 0, 'no same-day open edge');
    await wake('2026-04-30T00:00:00+08:00');
    await wake('2026-04-30T09:30:00+08:00');
    check(tasks.length === 1, 'next trading open reseeds due route');
  }
  const latestTaskAuthorized = tasks.at(-1)?.data.canContinue() ?? null;
  if (branch !== 'control' && tasks.length > 0) check(latestTaskAuthorized, 'rescue task keeps genuine current authorization');
  console.log(JSON.stringify({ name, recoveredAt, loads, restored, fresh, tasksAtRecovery: before, normalBypassTasks,
    tasksAfterBranch, tasksAfterNextOpen: tasks.length, latestTaskAuthorized, periodicTimersAtRecovery, nextSystemAtRecovery, periodicTimers: periodicTimers.timers.size, gateEdgesAtRecovery: gateEdges,
    authEdgesAtRecovery: authEdges, gateEdgesAfterBranch: events.length, state: lifecycleState.lifecycleState, fatals }));
  await tw.stopAndDrain(); await quote.stopAndDrain(); await autoSearch.stopAndDrain(); await periodic.stopAndDrain(); await settlement.stopAndDrain();
}
async function developControl() {
  const logger = { info: no, warn: no, error: no, debug: no };
  const errors = [], observations = [];
  const termination = { isTerminated: () => false, reportFatalError: e => errors.push(String(e)) };
  const state = { currentDayKey: '2026-04-29', pendingOpenRebuild: true, lifecycleState: 'OPEN_REBUILD_FAILED', isTradingEnabled: false };
  const now = () => new Date('2026-04-29T09:37:30+08:00');
  const config = { monitorSymbol: 'HSI.HK', longSymbol: 'BULL.HK', shortSymbol: 'BEAR.HK',
    autoSearchConfig: { autoSearchEnabled: true, switchIntervalMinutes: 5 } };
  const registry = load('src/services/autoSymbolManager/utils.ts', OLD).createSymbolRegistry(config);
  registry.updateSeatState('LONG', { symbol: 'BULL.HK', status: 'ACTIVE', lastSeatActivatedAt: now().getTime() - 600000,
    lastSearchAt: null, lastSwitchAt: null, callPrice: null, searchFailCountToday: 0, frozenTradingDayKey: null });
  const queue = load('src/main/asyncProgram/monitorTaskQueue/index.ts', OLD).createMonitorTaskQueue();
  const periodic = load('src/main/periodicSwitchWakeupRuntime/index.ts', OLD).createPeriodicSwitchWakeupRuntime({
    termination, monitorContext: { config }, symbolRegistry: registry, monitorTaskQueue: queue,
    trader: { onOrderStateChanged: () => no }, postTradeConsistencyRuntime: { onFreshReached: () => no },
    tradingGateEventRuntime: { onGateStateChanged: () => no }, calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
      load('src/utils/time/index.ts', OLD).calculateTradingDurationDueAtMs({ startMs,
        targetDurationMs: switchIntervalMinutes * 60000,
        calendarSnapshot: new Map([['2026-04-29', { isTradingDay: true, isHalfDay: false }]]) }),
    now, scheduleTimer: () => { throw new Error('unexpected old due timer'); }, clearTimer: no });
  const context = { config, symbolRegistry: registry, strategy: {}, autoSymbolManager: {
    evaluatePeriodicSwitchDue: async () => { observations.push(state.isTradingEnabled); return { kind: 'NOOP' }; },
    getPeriodicSwitchPendingState: () => ({ pending: true }) } };
  const handler = load('src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts', OLD).createAutoSymbolTickHandler({
    monitorContext: context, switchWakeupRuntime: {}, periodicSwitchWakeupRuntime: periodic,
    getCanTradeNow: () => state.isTradingEnabled });
  const runner = load('src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts', OLD).createQueueRunner({
    monitorTaskQueue: queue, termination, processQueue: async () => {
      while (!queue.isEmpty()) await handler(queue.pop());
    }, onQueueError: e => errors.push(String(e)), onAlreadyRunning: no });
  const signal = load('src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts', OLD).createSignalRuntimeDomain({
    logger, termination, monitorContext: context, buyProcessor: lifeOwner(), sellProcessor: lifeOwner(), monitorTaskProcessor: runner,
    businessEventProgram: lifeOwner(), tradingRiskEventRuntime: lifeOwner(), monitorQuoteEventRuntime: lifeOwner(),
    monitorDisplayRuntime: lifeOwner(), tradingQuoteDisplayRuntime: lifeOwner(), switchWakeupRuntime: lifeOwner(),
    periodicSwitchWakeupRuntime: periodic, quoteSubscriptionRuntime: { ...lifeOwner(), reconcileFromCurrentTruth: async () => {} },
    autoSearchWakeupRuntime: lifeOwner(), seatActivationDispatcher: lifeOwner(), seatRuntimeCleanupDispatcher: lifeOwner(),
    trader: { startOrderMonitorRuntime: no }, postTradeConsistencyRuntime: { resetAbort: no, start: no, completeRebuildBaseline: no } });
  const manager = load('src/main/lifecycle/dayLifecycleManager.ts', OLD).createDayLifecycleManager({
    mutableState: state, cacheDomains: [signal], logger, termination });
  await manager.tick(now(), { dayKey: '2026-04-29', canTradeNow: true, isTradingDay: true });
  const queuedBeforeImmediate = !queue.isEmpty();
  await new Promise(resolve => setImmediate(resolve)); await flush();
  check(queuedBeforeImmediate && observations.length === 1 && observations[0] === true && errors.length === 0,
    'develop queued before gate restored, then real worker handled after gate enabled');
  console.log(JSON.stringify({ name: 'develop-real-signal-manager-queue-runner-handler', queuedBeforeImmediate,
    gateAtExecution: observations, state: state.lifecycleState, errors }));
  await runner.stopAndDrain(); periodic.stop();
}
(async () => {
  await developControl();
  await scenario({ name: 'first-open-false-true-control', failures: 0, interval: 1, branch: 'control' });
  await scenario({ name: 'morning-boundary' });
  await scenario({ name: 'morning-same-truth', branch: 'sameTruth' });
  await scenario({ name: 'halfday-no-afternoon', half: true });
  await scenario({ name: 'afternoon-no-opening-edge', session: 'afternoon' });
  await scenario({ name: 'not-yet-due-control', interval: 15 });
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
```

## 附录 B：复运行命令与最终输出

在仓库根目录执行下列 PowerShell，只读附录中的 JavaScript 并内存运行；无仓库写入、无网络：

```powershell
$report = 'C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-lifecycle.md'
$text = [IO.File]::ReadAllText($report)
$probe = [regex]::Match($text, '(?s)```javascript\r?\n(.*?)\r?\n```').Groups[1].Value
bun --no-env-file --eval $probe
```

最终复运行 exit=0；原样输出如下（时间为UTC，+8为港时）。loads 对半日/下午样例含次日成功重建；不是失败数。正常first-open控制在后续fresh注入后旧receipt失效，因此最后latestTaskAuthorized=false是预期保护，不是恢复失败；后续救回的各案例均为true。

```jsonl
{"name":"develop-real-signal-manager-queue-runner-handler","queuedBeforeImmediate":true,"gateAtExecution":[true],"state":"ACTIVE","errors":[]}
{"name":"first-open-false-true-control","recoveredAt":"2026-04-29T01:30:00.000Z","loads":1,"restored":true,"fresh":true,"tasksAtRecovery":1,"normalBypassTasks":1,"tasksAfterBranch":1,"tasksAfterNextOpen":1,"latestTaskAuthorized":false,"periodicTimersAtRecovery":0,"nextSystemAtRecovery":"2026-04-29T01:45:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":1,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":1,"state":"ACTIVE","fatals":[]}
{"name":"morning-boundary","recoveredAt":"2026-04-29T01:37:30.000Z","loads":5,"restored":true,"fresh":true,"tasksAtRecovery":0,"normalBypassTasks":0,"tasksAfterBranch":1,"tasksAfterNextOpen":1,"latestTaskAuthorized":true,"periodicTimersAtRecovery":0,"nextSystemAtRecovery":"2026-04-29T01:45:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":1,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":3,"state":"ACTIVE","fatals":[]}
{"name":"morning-same-truth","recoveredAt":"2026-04-29T01:37:30.000Z","loads":5,"restored":true,"fresh":true,"tasksAtRecovery":0,"normalBypassTasks":0,"tasksAfterBranch":1,"tasksAfterNextOpen":1,"latestTaskAuthorized":true,"periodicTimersAtRecovery":0,"nextSystemAtRecovery":"2026-04-29T01:45:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":1,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":1,"state":"ACTIVE","fatals":[]}
{"name":"halfday-no-afternoon","recoveredAt":"2026-04-29T01:37:30.000Z","loads":6,"restored":true,"fresh":true,"tasksAtRecovery":0,"normalBypassTasks":0,"tasksAfterBranch":0,"tasksAfterNextOpen":1,"latestTaskAuthorized":true,"periodicTimersAtRecovery":0,"nextSystemAtRecovery":"2026-04-29T01:45:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":1,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":3,"state":"ACTIVE","fatals":[]}
{"name":"afternoon-no-opening-edge","recoveredAt":"2026-04-29T05:08:00.000Z","loads":25,"restored":true,"fresh":true,"tasksAtRecovery":0,"normalBypassTasks":0,"tasksAfterBranch":0,"tasksAfterNextOpen":1,"latestTaskAuthorized":true,"periodicTimersAtRecovery":0,"nextSystemAtRecovery":"2026-04-29T08:00:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":3,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":5,"state":"ACTIVE","fatals":[]}
{"name":"not-yet-due-control","recoveredAt":"2026-04-29T01:37:30.000Z","loads":5,"restored":true,"fresh":true,"tasksAtRecovery":0,"normalBypassTasks":0,"tasksAfterBranch":1,"tasksAfterNextOpen":1,"latestTaskAuthorized":true,"periodicTimersAtRecovery":1,"nextSystemAtRecovery":"2026-04-29T01:45:00.000Z","periodicTimers":0,"gateEdgesAtRecovery":1,"authEdgesAtRecovery":2,"gateEdgesAfterBranch":1,"state":"ACTIVE","fatals":[]}

```

最终 git status --short 无输出；未改仓库。二审完成，交主代理归并。
