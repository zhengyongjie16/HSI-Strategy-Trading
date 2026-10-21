> 根目录阅读副本；配套机器可读账本：[coverage.json](./architecture/architecture-refactoring-audit-evidence/2b67d36/coverage.json)。原始证据目录保留，B01授权分类已同步更新。

# 全仓架构审计最终覆盖账本（吸收补证后的只读证据对账）

> **授权口径更新**：B01／V-C4／OE-003已由用户明确确认为授权业务改动，不作为问题、严重性统计或验收阻塞；本账本的文件覆盖数量与阅读证据不变。原报告哈希及引用行号保留初次归档的历史含义。

## summary

- verdict：**368个current文件与263个develop迁移索引均完整；245/245运行码模块现均有明确D级阅读证据，运行码D缺口为0。** 这是阅读覆盖完成，不是全仓业务等价、无缺陷、可发布或穷尽证明。
- scope：本次只读取两份覆盖补充报告、具名独立二审阅读清单和既有账本/JSON；以固定Git树清单核对集合。未重审生产源码、未重扫AST/import、未运行测试/probe/type-check/lint/应用或实盘。仅更新本TEMP目录的本报告与 `coverage.json`。
- 结构总计沿用此前核实的固定SHA元数据：**245运行码 + 122纯类型契约 + 1 JSON = 368**。122个类型和1个JSON不计入245运行码D，也不冒充全部字段/状态/消费者的穷尽证明。
- 固定current：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop／origin/develop／FETCH_HEAD：`6e239c8a128372bd9b2fb2d79464346792a5e81e`。原七组等级、原错误来源候选与补充前223D/22缺口快照均保留在JSON历史中。
- 当前245D由原223个明确D加SP九项、SO十三项逐文件闭合。两份补充均无新候选/新测试；本账本不改写既有finding、授权或独立二审状态。

## 1. 集合核验、等级历史与最新统计

| 核对项 | 最终结果 |
| --- | --- |
| current权威集合 | B:214–620；368行/368唯一路径；与固定HEAD全部src树集合相等，missing=0、extra=0、主审缺失=0 |
| TS/JSON | 367个TS（245运行码、122纯类型）+ `src/strategies/intradayRegression/config.json` 1项 |
| develop迁移索引 | B:621–890；263行/263唯一旧路径；与固定develop全部src树集合相等，missing=0、extra=0；有效候选目标均存在 |
| 原始索引机制 | 同路径50 / Git rename162 / 人工拆分或移除51；保留原定位性质，不作等价证明 |
| 基线未直接配对 | 原current表94项；保留原始未配对历史，部分已由补证定位旧祖先，不是漏审或新增业务数 |
| 原运行码主审等级（历史） | 213 D + 32 E（含G6原B）；不把原七组首审回写成当时已全文D |
| 补证前合并等级（历史） | 223/245有D，22个E/B-only缺口 |
| 本次明确补齐 | SP 9/9 + SO 13/13 =22项；SO全文有效范围合计797行。原等级→当前逐项见§3 |
| 当前有效运行码等级 | **245 D / 245；无D运行码=0**，仅表示关键实现/分支/错误出口有阅读证据 |
| 122类型 + 1JSON | 原契约/配置等级保留，额外小契约补读具名登记；非全部字段/动态消费/状态空间证明 |
| 本次只读 | 新测试0、生产源码读取0、AST重扫0、仓库写入0；四refs不变，`git status --short`为空 |

**证据别名（报告行号，非源码行号）**：B=`audit-baseline-map.md`；R0–R6为七组原报告；SP=`audit-coverage-supplement-platform.md`；SO=`audit-coverage-supplement-orders.md`；RF=`audit-recheck-order-facts.md`；RM=`audit-recheck-mutation-errors.md`。源码读范围来自具名报告明确陈述，不以本次未读取的源码扩大主张。

| 唯一主审 | 文件数 | 原始等级（保留） | 运行码 / 类型 / JSON | 当前运行码D | 本次补齐 | 仍无D运行码 |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| G0 `audit-global-wiring.md` | 39 | D39 | 27 / 12 / 0 | 27 | 0 | 0 |
| G1 `audit-lifecycle.md` | 34 | D28 / E6 | 25 / 9 / 0 | 25 | 5 | 0 |
| G2 `audit-market-strategy.md` | 42 | D42 | 32 / 9 / 1 | 32 | 0 | 0 |
| G3 `audit-seat-selection.md` | 34 | D29 / E5 | 24 / 10 / 0 | 24 | 2 | 0 |
| G4 `audit-order-execution.md` | 63 | E18 / D34 / P11 | 52 / 11 / 0 | 52 | 13 | 0 |
| G5 `audit-risk-account.md` | 36 | D25 / E11 | 25 / 11 / 0 | 25 | 0 | 0 |
| G6 `audit-infra-config.md` | 120 | A65 / T52 / B3 | 60 / 60 / 0 | 60 | 2 | 0 |

### 分级与历史保留

- **D**：明确阅读关键实现、正常/异常分支及错误出口，不是形式化等价、逐行/全部时序穷举或执行覆盖率。原**E/B**=等价diff/迁移核对，不能因补证完成就称首审时已D。
- `primaryCoverage.rawLevel/evidence`、唯一主审、各组`rawCoverageCounts`保持不变；`effectiveCoverage/deepRuntimeEvidence/coverageSupplement`单独记录最新补证；`coverageHistory/revisionHistory`保留旧223D/22缺口状态。
- **SCOPED_D**为独立二审明确阅读区段，不扩张成整文件D；原**SD_OR_E/P**仍保留。SP/SO是覆盖补齐，不冒充新一轮独立二审。
- `runtimeInsufficientlyDeepReviewed`对245运行码现均false；122类型为not-runtime、1JSON为配置。不能用false声称类型/配置已穷尽验证。
- 结构和直接消费者边完全复用旧版核实元数据，本次只更新边上的阅读证据。import、路径命中或测试/探针执行都不能单独计D。

## 2. 来源纠偏与迁移索引修订

保留B原候选及先前来源陈述，只更新有效来源/候选边。263旧文件集合与368current集合不变；纠偏不是新代码finding。下表含补证指出的精确来源、必要函数拆分与非一对一限定；原值见JSON历史。

| current路径/边界 | 补证后的有效旧来源 | 精确限定 |
| --- | --- | --- |
| `src/application/tradingDayRebuild/quoteSymbols.ts` | `src/main/utils.ts` SP:45 | Both collection functions from old main/utils:1-70; lifecycle/utils contains date enumeration, not either collector. |
| `src/application/tradingDayRebuild/seatActivationCarryover.ts` | `src/main/lifecycle/seatActivationCarryover.ts` SP:46 | Verified current and old full 1-101. |
| `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts` | `src/main/lifecycle/tradingCalendarPrewarmer.ts` SP:47 | Old main implementation 1-263. Date enumeration old lifecycle/utils:11-41 moved to current utils/time:135 and is a necessary dependency, not this file body. |
| `src/domain/tradingSession/index.ts` | `src/utils/time/index.ts` SP:48 | Reaffirms R1 correction: eight session functions old utils/time/index:125-422, not lifecycle/utils. |
| `src/runtime/timeWakeupPlanner/index.ts` | `src/main/timeWakeupPlanner/index.ts` SP:49 | Current and old full 1-35, exact predecessor verified. |
| `src/application/seatSwitch/signalBuilder.ts` | `src/services/autoSymbolManager/signalBuilder.ts` SP:50 | Builder old 1-79; old quantity helper:36-51 moved to domain/seat/switchPolicy:66-78, not deleted; origin has real semantics. |
| `src/domain/seat/switchPolicy.ts` | `src/services/autoSymbolManager/thresholdResolver.ts`<br>`src/services/autoSymbolManager/signalBuilder.ts` SP:50 | Add quantity-helper extraction lineage old:36-51 -> current:66-78 only; no extra whole-file D from a dependency window. |
| `src/domain/seat/seatSnapshot.ts` | `src/utils/seat/snapshots.ts` SP:51 | Actual snapshot/name predecessor old utils/seat/snapshots:1-55; task helper belongs to seatIdentity lineage. |
| `src/domain/seat/seatIdentity.ts` | `src/utils/seat/guards.ts`<br>`src/utils/seat/symbols.ts`<br>`src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts` SP:59 | Add task-seat validation source lineage; preserve guards/symbols origins; not a new full-file review. |
| `src/infrastructure/logger/index.ts` | `src/utils/logger/index.ts` SP:52 | Current full 1-753 vs old 1-747; config parsing old utils/runtime -> current config/runtime is a dependency, not an extra D module. |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | `src/services/mixedTradeLogRepository/index.ts` SP:53 | Current and old full 1-954; not a proof of exhaustive persistence fault equivalence. |
| `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts` | `src/utils/trading/tradeLogPath.ts` SP:60 | Exact helper function current:17 -> old:12; necessary dependency, not a tenth platform D file. |
| `src/utils/time/index.ts` | `src/utils/time/index.ts`<br>`src/main/lifecycle/utils.ts` SP:47 | Add date-enumeration function extraction old lifecycle/utils:11-41 -> current utils/time:135; retain same-path utils/time predecessor. |
| `src/application/orderExecution/buyThrottle.ts` | `src/core/trader/orderExecutor/buyThrottle.ts` SO:57 | Same-name old implementation full 1-85. |
| `src/application/orderExecution/submitFailureLogging.ts` | `src/core/trader/orderExecutor/utils.ts` SO:58 | Old executor/utils:73-145, main logging function:109-145; formerly unpaired entry now located. |
| `src/application/orderTracking/orderMonitor/orderObservation.ts` | `src/core/trader/orderMonitor/orderOps.ts`<br>`src/core/trader/orderMonitor/eventFlow.ts`<br>`src/core/trader/orderMonitor/settlementFlow.ts` SO:59 | No one-to-one old module. ACK/terminal/lifecycle protocol comparison only: orderOps:122-141,496-500; eventFlow:94-137,242-279; settlementFlow:326-335. ACK timing/terminal diagnostic confirmation/duration are added observations, not identical old metrics. |
| `src/application/orderTracking/orderMonitor/routingIndex.ts` | `src/core/trader/orderMonitor/routingIndex.ts` SO:60 | Old full 1-147 -> current 1-148; whitespace-only difference. RF:129 effective valid range clamped by SO:S04. |
| `src/application/orderTracking/tradeAudit/index.ts` | `src/app/runtime/createPostGateRuntime.ts` SO:61 | Old createPostGateRuntime:90-195 inline filter/construct/synchronous append. Timing/strict precision changes remain qualified. |
| `src/domain/order/cancelOutcomePolicy.ts` | `src/utils/trading/orderStatus.ts` SO:62 | Old utils/trading/orderStatus:1-46, not core/trader/utils. |
| `src/domain/order/orderAnalysis.ts` | `src/core/orderRecorder/index.ts`<br>`src/core/orderRecorder/orderFilteringEngine.ts` SO:63 | Old createDailyLossOrderAnalysisDeps composition recorder/index:490-500 plus filtering engine factory:160-168; not core/utils. |
| `src/domain/order/orderQuantity.ts` | `src/core/orderRecorder/utils.ts`<br>`src/utils/numeric/index.ts` SO:64 | Old aggregation recorder/utils:70-85 and amount-to-lot helper numeric/index:210-259. Executor quantityResolver:97-136 is caller, not full helper source. |
| `src/domain/order/orderRemark.ts` | `src/core/trader/utils.ts` SO:65 | Two functions from old trader/utils:41-69, not core/utils. |
| `src/domain/order/orderTrackingPolicy.ts` | `src/core/trader/orderMonitor/utils.ts` SO:66 | Seven policies from old trader/orderMonitor/utils:25-173; orderStatusLifecycle is only a classification dependency, not module implementation source. |
| `src/domain/order/orderTypePolicy.ts` | `src/core/trader/utils.ts` SO:67 | Order type selection old trader/utils:120-141. |
| `src/domain/order/smartClose.ts` | `src/core/signalProcessor/utils.ts` SO:68 | Old signalProcessor/utils:103-236; pure-rule D does not approve all financial precision boundaries. |
| `src/runtime/orderTradeAuditListener/index.ts` | `src/app/runtime/createPostGateRuntime.ts` SO:69 | Old inline listener/cleanup createPostGateRuntime:443-459; synchronous fatal/rethrow kept, timing difference qualified. |

**关键纠偏摘要：** quoteSymbols两函数均为old `src/main/utils.ts`，不再挂到lifecycle/utils；seatSnapshot主体为old `src/utils/seat/snapshots.ts`，旧monitor-task helper归seatIdentity来源链；lifecycle/utils日期枚举移到current utils/time:135。cancelOutcomePolicy来自old utils/trading/orderStatus，orderAnalysis来自old recorder组合，orderTrackingPolicy来自old orderMonitor/utils而非orderStatusLifecycle。

旧错误边已从有效迁移候选移除，但原始B行和旧候选仍在`baselineCandidates/provenanceHistory/effectiveCandidateHistory/correctionHistory`留存。orderObservation只列协议祖先，新增ACK时间、terminal诊断确认及duration不宣称旧版已有同名实现。

## 3. 原22运行码缺口的逐项闭合（历史→当前）

**当前仍缺D的运行码路径：无（0项）。** 下表保留原22条及原等级，给出SP/SO完整目标范围；不撤销相邻seat/order已有候选或授权争议。

| 原缺口current路径 | 原首审等级/证据 | 补充全文范围/证据 | 当前有效等级 |
| --- | --- | --- | --- |
| `src/application/tradingDayRebuild/quoteSymbols.ts` | G1/E R1:179 | P1 1–62 SP:45；详情 SP:64–78 | D；已闭合 |
| `src/application/tradingDayRebuild/seatActivationCarryover.ts` | G1/E R1:181 | P2 1–101 SP:46；详情 SP:79–94 | D；已闭合 |
| `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts` | G1/E R1:186 | P3 1–275 SP:47；详情 SP:95–111 | D；已闭合 |
| `src/domain/tradingSession/index.ts` | G1/E R1:188 | P4 1–289 SP:48；详情 SP:112–136 | D；已闭合 |
| `src/runtime/timeWakeupPlanner/index.ts` | G1/E R1:204 | P5 1–35 SP:49；详情 SP:137–146 | D；已闭合 |
| `src/application/seatSwitch/signalBuilder.ts` | G3/E R3:197 | P6 1–63 SP:50；详情 SP:147–163 | D；已闭合 |
| `src/domain/seat/seatSnapshot.ts` | G3/E R3:202 | P7 1–53 SP:51；详情 SP:164–178 | D；已闭合 |
| `src/application/orderExecution/buyThrottle.ts` | G4/E R4:178 | S01 1–85 SO:56；详情 SO:72–90 | D；已闭合 |
| `src/application/orderExecution/submitFailureLogging.ts` | G4/E R4:182 | S02 1–23 SO:57；详情 SO:91–103 | D；已闭合 |
| `src/application/orderTracking/orderMonitor/orderObservation.ts` | G4/E R4:190 | S03 1–99 SO:58；详情 SO:104–129 | D；已闭合 |
| `src/application/orderTracking/orderMonitor/routingIndex.ts` | G4/E R4:196 | S04 1–148 SO:59；详情 SO:130–148 | D；已闭合 |
| `src/application/orderTracking/tradeAudit/index.ts` | G4/E R4:203 | S05 1–94 SO:60；详情 SO:149–168 | D；已闭合 |
| `src/domain/order/cancelOutcomePolicy.ts` | G4/E R4:214 | S06 1–47 SO:61；详情 SO:169–186 | D；已闭合 |
| `src/domain/order/orderAnalysis.ts` | G4/E R4:218 | S07 1–13 SO:62；详情 SO:187–196 | D；已闭合 |
| `src/domain/order/orderQuantity.ts` | G4/E R4:222 | S08 1–51 SO:63；详情 SO:197–215 | D；已闭合 |
| `src/domain/order/orderRemark.ts` | G4/E R4:225 | S09 1–16 SO:64；详情 SO:216–229 | D；已闭合 |
| `src/domain/order/orderTrackingPolicy.ts` | G4/E R4:228 | S10 1–129 SO:65；详情 SO:230–251 | D；已闭合 |
| `src/domain/order/orderTypePolicy.ts` | G4/E R4:229 | S11 1–17 SO:66；详情 SO:252–261 | D；已闭合 |
| `src/domain/order/smartClose.ts` | G4/E R4:233 | S12 1–50 SO:67；详情 SO:262–279 | D；已闭合 |
| `src/runtime/orderTradeAuditListener/index.ts` | G4/E R4:239 | S13 1–25 SO:68；详情 SO:280–293 | D；已闭合 |
| `src/infrastructure/logger/index.ts` | G6/B R6:180 | P8 1–753 SP:52；详情 SP:179–197 | D；已闭合 |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | G6/B R6:182 | P9 1–954 SP:53；详情 SP:198–236 | D；已闭合 |

### 已有独立二审阅读证据：仅吸收范围

- RF:126–131逐项阅读范围纳入JSON：routingIndex原列1–150，由SO:S04确认有效全文1–148；executionProjection/orderFilteringEngine/executionFact和unrealizedLossChecker的明确全文保持，monitor/recorder/orderOps等其余区段仅记SCOPED_D。
- RM:182–201“完整/核心”合述与定向policy/orderOps/routeProcessor/routeRuntime阅读均保守记SCOPED_D，不借path-only记录声称新增整文件D。orderTrackingPolicy全文D来自SO:S10。
- 不在RF未明列的地方推定它已全文读orderAnalysis；本项当前D依据为SO:S07。独立报告原探针/测试结果不转记为本次新执行，finding状态不在本账本重裁。

## 4. 368文件逐项覆盖账本

每行一个current文件。唯一主审和原等级永久保留，最新有效覆盖另列；平台补齐是baseline-map专门任务，不强行归给业务G0–G5。类型/JSON阅读不与运行码D混计。

### G0 总装配与跨链 wiring（39）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/app/context/createMonitorContext.ts` | `src/app/context/createMonitorContext.ts` | G0/D R0:247 | D R0:247 | G1/D R1:225<br>G2/D R2:301<br>G3/P R3:265 | 否；有明确D |
| `src/app/context/types.ts` | `src/types/state.ts`<br>`src/app/types.ts` | G0/D R0:248 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/app/lifecycle/createLifecycleRuntime.ts` | `src/app/lifecycle/createLifecycleRuntime.ts` | G0/D R0:249 | D R0:249 | G1/D R1:226<br>G2/D R2:302 | 否；有明确D |
| `src/app/lifecycle/types.ts` | `src/app/types.ts` | G0/D R0:250 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/app/runApp.ts` | `src/app/runApp.ts` | G0/D R0:251 | D R0:251 | G1/D R1:217<br>G2/P R2:325 | 否；有明确D |
| `src/app/runAppDeps.ts` | `src/app/runAppDeps.ts` | G0/D R0:252 | D R0:252 | G1/D R1:218 | 否；有明确D |
| `src/app/runtime/createAsyncRuntime.ts` | `src/app/runtime/createAsyncRuntime.ts` | G0/D R0:253 | D R0:253 | G1/D R1:223<br>G2/D R2:300<br>G3/P R3:266 | 否；有明确D |
| `src/app/runtime/createPostGateRuntime.ts` | `src/app/runtime/createPostGateRuntime.ts` | G0/D R0:254 | D R0:254 | G1/D R1:221<br>G2/P R2:327<br>G3/P R3:264<br>G4/P R4:246<br>G5/P R5:222 | 否；有明确D |
| `src/app/runtime/createPostGateRuntimeDeps.ts` | `src/app/runtime/createPostGateRuntimeDeps.ts` | G0/D R0:255 | D R0:255 | — | 否；有明确D |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts` | `src/app/runtime/createPostTradeConsistencyRuntime.ts` | G0/D R0:256 | D R0:256 | G1/D R1:224<br>G5/P R5:222<br>RF二审/SCOPED_D RF:131 | 否；有明确D |
| `src/app/runtime/createPreGateRuntime.ts` | `src/app/runtime/createPreGateRuntime.ts` | G0/D R0:257 | D R0:257 | G1/D R1:219<br>G2/P R2:326<br>G3/P R3:263<br>G6/P R6:292 | 否；有明确D |
| `src/app/runtime/createPreGateRuntimeDeps.ts` | `src/app/runtime/createPreGateRuntimeDeps.ts` | G0/D R0:258 | D R0:258 | G1/D R1:220 | 否；有明确D |
| `src/app/runtime/createTradeRuntime.ts` | `src/core/trader/index.ts` | G0/D R0:259 | D R0:259 | G1/D R1:222<br>G4/D R4:246<br>G5/P R5:222<br>G6/D R6:292 | 否；有明确D |
| `src/app/runtime/types.ts` | `src/core/trader/types.ts`<br>`src/app/types.ts` | G0/D R0:260 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/app/shutdown/createCleanup.ts` | `src/app/shutdown/createCleanup.ts` | G0/D R0:261 | D R0:261 | G1/D R1:227 | 否；有明确D |
| `src/app/shutdown/types.ts` | `src/app/types.ts` | G0/D R0:262 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/app/startup/createSelectedStrategy.ts` | `src/app/startup/createSelectedStrategy.ts` | G0/D R0:263 | D R0:263 | G1/D R1:229<br>G2/D R2:298 | 否；有明确D |
| `src/app/startup/prepareStrategy.ts` | `src/app/startup/prepareStrategy.ts` | G0/D R0:264 | D R0:264 | G1/D R1:228<br>G2/D R2:297 | 否；有明确D |
| `src/app/startup/runtimeValidation.ts` | `src/app/startup/runtimeValidation.ts` | G0/D R0:265 | D R0:265 | — | 否；有明确D |
| `src/app/startup/strategyLoaderHelpers.ts` | `src/app/startup/strategyLoaderHelpers.ts` | G0/D R0:266 | D R0:266 | G2/D R2:299 | 否；有明确D |
| `src/app/startup/tradingDayInfoResolver.ts` | `src/app/lifecycle/rebuild.ts` | G0/D R0:267 | D R0:267 | G1/D R1:230 | 否；有明确D |
| `src/app/startup/types.ts` | `src/app/startup/types.ts`<br>`src/app/types.ts` | G0/D R0:268 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/app/types.ts` | `src/app/types.ts`<br>`src/types/state.ts` | G0/D R0:269 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/types.ts` | `src/utils/quoteRetry/types.ts` | G0/D R0:270 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/index.ts` | `src/index.ts` | G0/D R0:271 | D R0:271 | G1/D R1:216 | 否；有明确D |
| `src/runtime/asyncProgram/monitorTaskProcessor/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/index.ts` | G0/D R0:272 | D R0:272 | G1/D R1:255<br>G3/SD_OR_E R3:230 | 否；有明确D |
| `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts` | `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts` | G0/D R0:273 | D R0:273 | G1/D R1:256<br>G3/SD_OR_E R3:231 | 否；有明确D |
| `src/runtime/asyncProgram/monitorTaskProcessor/types.ts` | `src/main/asyncProgram/monitorTaskProcessor/types.ts` | G0/D R0:274 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/asyncProgram/monitorTaskQueue/index.ts` | `src/main/asyncProgram/monitorTaskQueue/index.ts` | G0/D R0:275 | D R0:275 | G3/P R3:262 | 否；有明确D |
| `src/runtime/asyncProgram/monitorTaskQueue/types.ts` | `src/main/asyncProgram/monitorTaskQueue/types.ts` | G0/D R0:276 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/asyncProgram/processor.ts` | `src/main/asyncProgram/utils.ts` | G0/D R0:277 | D R0:277 | G1/D R1:252<br>G2/D R2:277<br>G4/D R4:246 | 否；有明确D |
| `src/runtime/asyncProgram/taskNotifications.ts` | `src/main/asyncProgram/utils.ts` | G0/D R0:278 | D R0:278 | G1/D R1:253<br>G2/D R2:276 | 否；有明确D |
| `src/runtime/asyncProgram/tradeTaskQueue/index.ts` | `src/main/asyncProgram/tradeTaskQueue/index.ts` | G0/D R0:279 | D R0:279 | G1/D R1:254<br>G2/D R2:274<br>G4/D R4:246 | 否；有明确D |
| `src/runtime/asyncProgram/tradeTaskQueue/types.ts` | `src/main/asyncProgram/tradeTaskQueue/types.ts` | G0/D R0:280 | 契约原等级保留；非穷尽 | G2/D R2:275 | 不适用：类型 |
| `src/runtime/asyncProgram/types.ts` | `src/main/asyncProgram/types.ts` | G0/D R0:281 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/businessEventProgram/emissionAdapter.ts` | `src/main/businessEventProgram/emissionAdapter.ts` | G0/D R0:282 | D R0:282 | G2/D R2:271 | 否；有明确D |
| `src/runtime/businessEventProgram/index.ts` | `src/main/businessEventProgram/index.ts` | G0/D R0:283 | D R0:283 | G1/D R1:240<br>G2/D R2:270 | 否；有明确D |
| `src/runtime/businessEventProgram/types.ts` | `src/main/businessEventProgram/types.ts` | G0/D R0:284 | 契约原等级保留；非穷尽 | G2/D R2:273 | 不适用：类型 |
| `src/runtime/businessEventProgram/utils.ts` | `src/main/businessEventProgram/utils.ts` | G0/D R0:285 | D R0:285 | G2/D R2:272 | 否；有明确D |

### G1 生命周期与时间门禁（34）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/application/tradingDayRebuild/executionNormalization.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G1/D R1:176 | D R1:176 | G3/SD_OR_E R3:227<br>G4/D R4:249<br>G5/P R5:228 | 否；有明确D |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` | G1/D R1:177 | D R1:177 | G0/P R0:293<br>G2/P R2:329<br>G3/P R3:255<br>G4/P R4:249<br>G5/P R5:228<br>G6/P R6:293 | 否；有明确D |
| `src/application/tradingDayRebuild/openRebuild.ts` | `src/app/lifecycle/rebuild.ts` | G1/D R1:178 | D R1:178 | G0/P R0:293<br>G6/P R6:293 | 否；有明确D |
| `src/application/tradingDayRebuild/quoteSymbols.ts` | `src/main/utils.ts`（补证定位；原候选留存） | G1/E R1:179 | D SP:45 | G6/P R6:293<br>平台补齐/D SP:45 | 否；有明确D |
| `src/application/tradingDayRebuild/rebuildTradingDayState.ts` | `src/main/lifecycle/rebuildTradingDayState.ts` | G1/D R1:180 | D R1:180 | G0/P R0:293<br>G3/P R3:256<br>G4/P R4:249<br>G5/P R5:228 | 否；有明确D |
| `src/application/tradingDayRebuild/seatActivationCarryover.ts` | `src/main/lifecycle/seatActivationCarryover.ts`（补证定位；原候选留存） | G1/E R1:181 | D SP:46 | G3/SD_OR_E R3:226<br>平台补齐/D SP:46 | 否；有明确D |
| `src/application/tradingDayRebuild/seatPreparation.ts` | `src/main/recovery/seatPreparation.ts` | G1/D R1:182 | D R1:182 | G3/SD_OR_E R3:225 | 否；有明确D |
| `src/application/tradingDayRebuild/startupFailureState.ts` | `src/main/lifecycle/startupFailureState.ts` | G1/D R1:183 | D R1:183 | — | 否；有明确D |
| `src/application/tradingDayRebuild/startupRebuild.ts` | `src/app/lifecycle/rebuild.ts` | G1/D R1:184 | D R1:184 | G0/P R0:293<br>G6/P R6:293 | 否；有明确D |
| `src/application/tradingDayRebuild/startupSnapshot.ts` | `src/app/startup/startupSnapshot.ts` | G1/D R1:185 | D R1:185 | G0/P R0:293<br>G6/P R6:293 | 否；有明确D |
| `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts` | `src/main/lifecycle/tradingCalendarPrewarmer.ts`（补证定位；原候选留存） | G1/E R1:186 | D SP:47 | G6/P R6:293<br>平台补齐/D SP:47 | 否；有明确D |
| `src/application/tradingDayRebuild/types.ts` | `src/main/lifecycle/types.ts`<br>`src/main/recovery/types.ts`（候选） | G1/D R1:187 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/tradingSession/index.ts` | `src/utils/time/index.ts`（补证定位；原候选留存） | G1/E R1:188 | D SP:48 | G3/SD_OR_E R3:240<br>平台补齐/D SP:48 | 否；有明确D |
| `src/domain/tradingSession/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G1/D R1:189 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts` | `src/main/lifecycle/cacheDomains/globalStateDomain.ts` | G1/D R1:190 | D R1:190 | G2/D R2:307 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts` | `src/main/lifecycle/cacheDomains/marketDataDomain.ts`（候选） | G1/D R1:191 | D R1:191 | G2/D R2:306 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/orderDomain.ts` | `src/core/trader/index.ts` | G1/D R1:192 | D R1:192 | G4/D R4:248 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/riskDomain.ts` | `src/main/lifecycle/cacheDomains/riskDomain.ts`（候选） | G1/D R1:193 | D R1:193 | G5/P R5:230 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/seatDomain.ts` | `src/main/lifecycle/cacheDomains/seatDomain.ts`（候选） | G1/D R1:194 | D R1:194 | G3/SD_OR_E R3:232<br>G6/P R6:294 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts` | `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`（候选） | G1/D R1:195 | D R1:195 | G0/P R0:293<br>G2/D R2:305<br>G3/SD_OR_E R3:233 | 否；有明确D |
| `src/runtime/lifecycle/cacheDomains/types.ts` | `src/main/lifecycle/cacheDomains/types.ts`（候选） | G1/D R1:196 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/lifecycle/dayLifecycleManager.ts` | `src/main/lifecycle/dayLifecycleManager.ts` | G1/D R1:197 | D R1:197 | — | 否；有明确D |
| `src/runtime/lifecycle/startup/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G1/D R1:198 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/lifecycle/startupRuntime.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G1/D R1:199 | D R1:199 | G0/P R0:293<br>G2/D R2:303 | 否；有明确D |
| `src/runtime/lifecycle/terminationRuntime.ts` | `src/app/runtime/createTerminationRuntime.ts` | G1/E R1:200 | D R2:304 | G0/P R0:293<br>G2/D R2:304<br>G3/SD_OR_E R3:234<br>G4/D R4:248<br>RM二审/SCOPED_D RM:191 | 否；有明确D |
| `src/runtime/lifecycle/types.ts` | `src/main/lifecycle/types.ts`（候选） | G1/D R1:201 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/timeWakeupEvaluationProgram/index.ts` | `src/main/timeWakeupEvaluationProgram/index.ts` | G1/D R1:202 | D R1:202 | G2/P R2:328<br>G5/P R5:230 | 否；有明确D |
| `src/runtime/timeWakeupEvaluationProgram/types.ts` | `src/main/timeWakeupEvaluationProgram/types.ts`（候选） | G1/D R1:203 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/timeWakeupPlanner/index.ts` | `src/main/timeWakeupPlanner/index.ts`（补证定位；原候选留存） | G1/E R1:204 | D SP:49 | 平台补齐/D SP:49 | 否；有明确D |
| `src/runtime/timeWakeupPlanner/types.ts` | `src/main/timeWakeupPlanner/types.ts`（候选） | G1/D R1:205 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/timeWakeupRuntime/index.ts` | `src/main/timeWakeupRuntime/index.ts`（候选） | G1/D R1:206 | D R1:206 | — | 否；有明确D |
| `src/runtime/timeWakeupRuntime/types.ts` | `src/main/timeWakeupRuntime/types.ts`（候选） | G1/D R1:207 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/tradingGateEventRuntime/index.ts` | `src/main/tradingGateEventRuntime/index.ts`（候选） | G1/D R1:208 | D R1:208 | G2/D R2:310<br>G3/SD_OR_E R3:235 | 否；有明确D |
| `src/runtime/tradingGateEventRuntime/types.ts` | `src/main/tradingGateEventRuntime/types.ts`（候选） | G1/D R1:209 | 契约原等级保留；非穷尽 | — | 不适用：类型 |

### G2 行情与策略（42）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/application/quoteRetry.ts` | `src/utils/quoteRetry/index.ts` | G2/D R2:206 | D R2:206 | G3/SD_OR_E R3:243 | 否；有明确D |
| `src/domain/strategy/ordinarySignalGuard.ts` | `src/main/ordinarySignalGuard/index.ts` | G2/D R2:207 | D R2:207 | G1/D R1:238<br>G3/SD_OR_E R3:241 | 否；有明确D |
| `src/domain/strategy/utils.ts` | `src/core/strategy/utils.ts` | G2/D R2:208 | D R2:208 | — | 否；有明确D |
| `src/runtime/monitorDisplayRuntime/index.ts` | `src/main/monitorDisplayRuntime/index.ts` | G2/D R2:212 | D R2:212 | G1/D R1:247 | 否；有明确D |
| `src/runtime/monitorDisplayRuntime/types.ts` | `src/main/monitorDisplayRuntime/types.ts` | G2/D R2:213 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` | `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` | G2/D R2:214 | D R2:214 | G0/P R0:297<br>G1/D R1:250<br>G3/SD_OR_E R3:229<br>G5/P R5:230 | 否；有明确D |
| `src/runtime/monitorQuoteEventRuntime/setUtils.ts` | `src/main/monitorQuoteEventRuntime/setUtils.ts` | G2/D R2:215 | D R2:215 | — | 否；有明确D |
| `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts` | `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` | G2/D R2:216 | D R2:216 | G0/P R0:297<br>G1/D R1:251<br>G3/SD_OR_E R3:228 | 否；有明确D |
| `src/runtime/monitorQuoteEventRuntime/types.ts` | `src/main/monitorQuoteEventRuntime/types.ts` | G2/D R2:217 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/quoteSubscriptionRuntime/index.ts` | `src/main/quoteSubscriptionRuntime/index.ts` | G2/D R2:218 | D R2:218 | G0/P R0:297<br>G1/D R1:243<br>G3/P R3:261 | 否；有明确D |
| `src/runtime/quoteSubscriptionRuntime/types.ts` | `src/main/quoteSubscriptionRuntime/types.ts` | G2/D R2:219 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/tradingQuoteDisplayRuntime/index.ts` | `src/main/tradingQuoteDisplayRuntime/index.ts` | G2/D R2:220 | D R2:220 | G1/D R1:248 | 否；有明确D |
| `src/runtime/tradingQuoteDisplayRuntime/types.ts` | `src/main/tradingQuoteDisplayRuntime/types.ts` | G2/D R2:221 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/strategies/intradayRegression/config.json` | `src/core/strategy/intradayRegression/config.json` | G2/D R2:225 | JSON配置已读；非穷尽 | — | 不适用：JSON |
| `src/strategies/intradayRegression/config.ts` | `src/core/strategy/intradayRegression/config.ts` | G2/D R2:226 | D R2:226 | — | 否；有明确D |
| `src/strategies/intradayRegression/constants.ts` | `src/core/strategy/intradayRegression/constants.ts` | G2/D R2:227 | D R2:227 | — | 否；有明确D |
| `src/strategies/intradayRegression/definition.ts` | `src/core/strategy/intradayRegression/definition.ts` | G2/D R2:228 | D R2:228 | — | 否；有明确D |
| `src/strategies/intradayRegression/display.ts` | `src/core/strategy/intradayRegression/display.ts` | G2/D R2:229 | D R2:229 | — | 否；有明确D |
| `src/strategies/intradayRegression/dsl.ts` | `src/core/strategy/intradayRegression/dsl.ts` | G2/D R2:230 | D R2:230 | — | 否；有明确D |
| `src/strategies/intradayRegression/index.ts` | `src/core/strategy/intradayRegression/index.ts` | G2/D R2:231 | D R2:231 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicatorHelpers/types.ts` | `src/core/strategy/intradayRegression/indicatorHelpers/types.ts` | G2/D R2:232 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/strategies/intradayRegression/indicatorHelpers/utils.ts` | `src/core/strategy/intradayRegression/indicatorHelpers/utils.ts` | G2/D R2:233 | D R2:233 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/adx.ts` | `src/core/strategy/intradayRegression/runtime/adx.ts` | G2/D R2:234 | D R2:234 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/ema.ts` | `src/core/strategy/intradayRegression/runtime/ema.ts` | G2/D R2:235 | D R2:235 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/index.ts` | `src/core/strategy/intradayRegression/runtime/index.ts` | G2/D R2:236 | D R2:236 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/indicatorMath.ts` | `src/core/strategy/intradayRegression/runtime/utils.ts` | G2/D R2:237 | D R2:237 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/kdj.ts` | `src/core/strategy/intradayRegression/runtime/kdj.ts` | G2/D R2:238 | D R2:238 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/macd.ts` | `src/core/strategy/intradayRegression/runtime/macd.ts` | G2/D R2:239 | D R2:239 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/mfi.ts` | `src/core/strategy/intradayRegression/runtime/mfi.ts` | G2/D R2:240 | D R2:240 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/psy.ts` | `src/core/strategy/intradayRegression/runtime/psy.ts` | G2/D R2:241 | D R2:241 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/rsi.ts` | `src/core/strategy/intradayRegression/runtime/rsi.ts` | G2/D R2:242 | D R2:242 | — | 否；有明确D |
| `src/strategies/intradayRegression/indicators/types.ts` | `src/core/strategy/intradayRegression/runtime/types.ts` | G2/D R2:243 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/strategies/intradayRegression/profile/index.ts` | `src/core/strategy/intradayRegression/profile/index.ts` | G2/D R2:244 | D R2:244 | — | 否；有明确D |
| `src/strategies/intradayRegression/profile/types.ts` | `src/core/strategy/intradayRegression/profile/types.ts` | G2/D R2:245 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/strategies/intradayRegression/profile/utils.ts` | `src/core/strategy/intradayRegression/profile/utils.ts` | G2/D R2:246 | D R2:246 | — | 否；有明确D |
| `src/strategies/intradayRegression/signalRules.ts` | `src/core/strategy/intradayRegression/utils.ts` | G2/D R2:247 | D R2:247 | — | 否；有明确D |
| `src/strategies/intradayRegression/types.ts` | `src/core/strategy/intradayRegression/types.ts` | G2/D R2:248 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/strategies/intradayRegression/verification/index.ts` | `src/core/strategy/intradayRegression/verification/index.ts` | G2/D R2:249 | D R2:249 | — | 否；有明确D |
| `src/strategies/intradayRegression/verification/pendingVerification.ts` | `src/core/strategy/intradayRegression/verification/index.ts` | G2/D R2:250 | D R2:250 | — | 否；有明确D |
| `src/strategies/intradayRegression/verification/sampleRules.ts` | `src/core/strategy/intradayRegression/verification/utils.ts` | G2/D R2:251 | D R2:251 | — | 否；有明确D |
| `src/strategies/intradayRegression/verification/sampleStore.ts` | `src/core/strategy/intradayRegression/verification/sampleStore.ts` | G2/D R2:252 | D R2:252 | — | 否；有明确D |
| `src/strategies/intradayRegression/verification/types.ts` | `src/core/strategy/intradayRegression/verification/types.ts` | G2/D R2:253 | 契约原等级保留；非穷尽 | — | 不适用：类型 |

### G3 席位寻标轮换（34）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/application/autoSearch/candidateSearch.ts` | `src/services/autoSymbolFinder/index.ts`（候选） | G3/D R3:186 | D R3:186 | G6/P R6:294 | 否；有明确D |
| `src/application/autoSearch/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`<br>`src/services/autoSymbolManager/autoSearch.ts`（候选） | G3/D R3:187 | D R3:187 | — | 否；有明确D |
| `src/application/autoSearch/startupSeatSearch.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:188 | D R3:188 | G1/P R1:277 | 否；有明确D |
| `src/application/autoSearch/types.ts` | `src/services/autoSymbolFinder/types.ts`（候选） | G3/D R3:189 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/seatActivation/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`（候选） | G3/D R3:190 | D R3:190 | G0/P R0:295<br>G1/P R1:276<br>G5/P R5:228 | 否；有明确D |
| `src/application/seatActivation/rebuiltSeats.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:191 | D R3:191 | G1/D R1:235,R1:280 | 否；有明确D |
| `src/application/seatActivation/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:192 | 契约原等级保留；非穷尽 | G1/D R1:236 | 不适用：类型 |
| `src/application/seatSwitch/distanceSwitch.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:193 | D R3:193 | G2/D R2:317 | 否；有明确D |
| `src/application/seatSwitch/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`<br>`src/services/autoSymbolManager/index.ts`（候选） | G3/D R3:194 | D R3:194 | — | 否；有明确D |
| `src/application/seatSwitch/periodicSwitchTask.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:195 | D R3:195 | G0/P R0:295 | 否；有明确D |
| `src/application/seatSwitch/seatStateManager.ts` | `src/services/autoSymbolManager/seatStateManager.ts`（候选） | G3/D R3:196 | D R3:196 | — | 否；有明确D |
| `src/application/seatSwitch/signalBuilder.ts` | `src/services/autoSymbolManager/signalBuilder.ts`（补证定位；原候选留存） | G3/E R3:197 | D SP:50 | G4/P R4:249<br>平台补齐/D SP:50 | 否；有明确D |
| `src/application/seatSwitch/switchStateMachine.ts` | `src/services/autoSymbolManager/switchStateMachine.ts`（候选） | G3/D R3:198 | D R3:198 | G0/P R0:295<br>G4/P R4:249 | 否；有明确D |
| `src/application/seatSwitch/types.ts` | `src/services/autoSymbolManager/types.ts`（候选） | G3/D R3:199 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/seat/seatIdentity.ts` | `src/utils/seat/guards.ts`<br>`src/utils/seat/symbols.ts`<br>`src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts`（补证定位；原候选留存） | G3/E R3:200 | D R2:318 | G2/D R2:318 | 否；有明确D |
| `src/domain/seat/seatPolicy.ts` | `src/services/autoSymbolFinder/policyResolver.ts`<br>`src/utils/seat/guards.ts`（候选） | G3/D R3:201 | D R3:201 | G1/P R1:279 | 否；有明确D |
| `src/domain/seat/seatSnapshot.ts` | `src/utils/seat/snapshots.ts`（补证定位；原候选留存） | G3/E R3:202 | D SP:51 | 平台补齐/D SP:51 | 否；有明确D |
| `src/domain/seat/switchPolicy.ts` | `src/services/autoSymbolManager/thresholdResolver.ts`<br>`src/services/autoSymbolManager/signalBuilder.ts`（补证定位；原候选留存） | G3/D R3:203 | D R3:203 | — | 否；有明确D |
| `src/domain/seat/switchState.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:204 | D R3:204 | — | 否；有明确D |
| `src/domain/seat/symbolRegistry.ts` | `src/services/autoSymbolManager/utils.ts`<br>`src/utils/seat/symbols.ts`（候选） | G3/D R3:205 | D R3:205 | G1/D R1:237 | 否；有明确D |
| `src/domain/seat/types.ts` | `src/types/state.ts`<br>`src/utils/seat/types.ts`（候选） | G3/D R3:206 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/seat/warrantSelection/index.ts` | `src/services/autoSymbolFinder/policyResolver.ts`<br>`src/services/autoSymbolFinder/utils.ts`（候选） | G3/D R3:207 | D R3:207 | — | 否；有明确D |
| `src/domain/seat/warrantSelection/types.ts` | `src/services/autoSymbolFinder/types.ts`（候选） | G3/D R3:208 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/autoSearchWakeupRuntime/index.ts` | `src/main/autoSearchWakeupRuntime/index.ts`（候选） | G3/D R3:209 | D R3:209 | G0/P R0:295<br>G1/D R1:241 | 否；有明确D |
| `src/runtime/autoSearchWakeupRuntime/types.ts` | `src/main/autoSearchWakeupRuntime/types.ts`（候选） | G3/D R3:210 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/periodicSwitchWakeupRuntime/index.ts` | `src/main/periodicSwitchWakeupRuntime/index.ts`（候选） | G3/D R3:211 | D R3:211 | G0/P R0:295<br>G1/D R1:242 | 否；有明确D |
| `src/runtime/periodicSwitchWakeupRuntime/types.ts` | `src/main/periodicSwitchWakeupRuntime/types.ts`（候选） | G3/D R3:212 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/seatActivationDispatcher/index.ts` | `src/main/seatActivationDispatcher/index.ts`（候选） | G3/D R3:213 | D R3:213 | G0/P R0:295<br>G1/D R1:244 | 否；有明确D |
| `src/runtime/seatActivationDispatcher/types.ts` | `src/main/seatActivationDispatcher/types.ts`（候选） | G3/D R3:214 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/seatDiagnosticRuntime/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:218 | D R3:218 | G1/D R1:246 | 否；有明确D |
| `src/runtime/seatDiagnosticRuntime/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G3/D R3:219 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/seatRuntimeCleanupDispatcher/index.ts` | `src/main/seatRuntimeCleanupDispatcher/index.ts`（候选） | G3/E R3:215 | D R1:245 | G0/P R0:295<br>G1/D R1:245<br>G2/D R2:308 | 否；有明确D |
| `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts` | `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts`（候选） | G3/E R3:216 | D R2:309 | G2/D R2:309 | 否；有明确D |
| `src/runtime/seatRuntimeCleanupDispatcher/types.ts` | `src/main/seatRuntimeCleanupDispatcher/types.ts`（候选） | G3/D R3:217 | 契约原等级保留；非穷尽 | — | 不适用：类型 |

### G4 订单执行恢复（63）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/application/orderExecution/buyThrottle.ts` | `src/core/trader/orderExecutor/buyThrottle.ts`（补证定位；原候选留存） | G4/E R4:178 | D SO:56 | G4本组补齐/D SO:56 | 否；有明确D |
| `src/application/orderExecution/index.ts` | `src/core/trader/orderExecutor/index.ts`（候选） | G4/D R4:179 | D R4:179 | G2/P R2:330<br>G3/P R3:257<br>G5/P R5:225<br>G6/P R6:292 | 否；有明确D |
| `src/application/orderExecution/quantityResolver.ts` | `src/core/trader/orderExecutor/quantityResolver.ts`（候选） | G4/D R4:180 | D R4:180 | G3/P R3:257<br>G5/P R5:225 | 否；有明确D |
| `src/application/orderExecution/rateLimiter.ts` | `src/core/trader/rateLimiter.ts`（候选） | G4/D R4:181 | D R4:181 | G6/D R6:292 | 否；有明确D |
| `src/application/orderExecution/submitFailureLogging.ts` | `src/core/trader/orderExecutor/utils.ts`（补证定位；原候选留存） | G4/E R4:182 | D SO:57 | G4本组补齐/D SO:57 | 否；有明确D |
| `src/application/orderExecution/submitFlow.ts` | `src/core/trader/orderExecutor/submitFlow.ts`（候选） | G4/D R4:183 | D R4:183 | G2/P R2:331<br>G3/P R3:257<br>G5/P R5:225 | 否；有明确D |
| `src/application/orderExecution/tradeMutationErrors.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/E R4:184 | D R6:292 | G1/P R1:275<br>G5/P R5:225<br>G6/D R6:292<br>RM二审/SCOPED_D RM:189 | 否；有明确D |
| `src/application/orderExecution/types.ts` | `src/core/trader/orderExecutor/types.ts`（候选） | G4/P R4:185 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/orderTracking/orderCacheManager.ts` | `src/core/trader/orderCacheManager.ts`（候选） | G4/D R4:186 | D R4:186 | G3/P R3:258<br>G6/D R6:293 | 否；有明确D |
| `src/application/orderTracking/orderHoldRegistry.ts` | `src/core/trader/orderHoldRegistry.ts`（候选） | G4/D R4:187 | D R4:187 | G0/P R0:296<br>G1/P R1:273<br>RM二审/SCOPED_D RM:200 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/eventFlow.ts` | `src/core/trader/orderMonitor/eventFlow.ts`（候选） | G4/D R4:188 | D R4:188 | G0/P R0:296<br>G1/P R1:269<br>G5/P R5:227<br>RF二审/SCOPED_D RF:129 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/index.ts` | `src/core/trader/orderMonitor/index.ts`（候选） | G4/D R4:189 | D R4:189 | G0/P R0:296<br>G1/P R1:268<br>G3/P R3:258<br>RF二审/SCOPED_D RF:129<br>RM二审/SCOPED_D RM:196 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/orderObservation.ts` | `src/core/trader/orderMonitor/orderOps.ts`<br>`src/core/trader/orderMonitor/eventFlow.ts`<br>`src/core/trader/orderMonitor/settlementFlow.ts`（补证定位；原候选留存） **协议祖先，非一对一旧实现** | G4/E R4:190 | D SO:58 | G4本组补齐/D SO:58 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/orderOps.ts` | `src/core/trader/orderMonitor/orderOps.ts`（候选） | G4/D R4:191 | D R4:191 | RF二审/SCOPED_D RF:129<br>RM二审/SCOPED_D RM:195 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/orderStatusQuery.ts` | `src/core/trader/orderMonitor/orderStatusQuery.ts`（候选） | G4/D R4:192 | D R4:192 | G6/D R6:293 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/recoveryFlow.ts` | `src/core/trader/orderMonitor/recoveryFlow.ts`（候选） | G4/D R4:193 | D R4:193 | G1/P R1:270<br>G5/P R5:227 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/routeProcessor.ts` | `src/core/trader/orderMonitor/routeProcessor.ts`（候选） | G4/D R4:194 | D R4:194 | G1/P R1:271<br>G5/P R5:227<br>RF二审/SCOPED_D RF:129<br>RM二审/SCOPED_D RM:197 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/routeRuntime.ts` | `src/core/trader/orderMonitor/routeRuntime.ts`（候选） | G4/D R4:195 | D R4:195 | G1/P R1:271<br>RM二审/SCOPED_D RM:198 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/routingIndex.ts` | `src/core/trader/orderMonitor/routingIndex.ts`（补证定位；原候选留存） | G4/E R4:196 | D SO:59 | G4本组补齐/D SO:59<br>RF二审/D RF:129 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/settlementFlow.ts` | `src/core/trader/orderMonitor/settlementFlow.ts`（候选） | G4/D R4:197 | D R4:197 | G1/P R1:272<br>G2/P R2:336<br>G3/P R3:258<br>G5/P R5:227<br>RF二审/SCOPED_D RF:129 | 否；有明确D |
| `src/application/orderTracking/orderMonitor/types.ts` | `src/core/trader/orderMonitor/types.ts`（候选） | G4/P R4:198 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/orderTracking/recorder/index.ts` | `src/core/orderRecorder/index.ts`（候选） | G4/D R4:199 | D R4:199 | G1/P R1:273<br>G2/P R2:335<br>G3/P R3:258<br>G5/P R5:226<br>RF二审/SCOPED_D RF:127 | 否；有明确D |
| `src/application/orderTracking/recorder/orderApiManager.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/D R4:200 | D R4:200 | G3/SD_OR_E R3:249<br>G6/D R6:293 | 否；有明确D |
| `src/application/orderTracking/recorder/orderStorage.ts` | `src/core/orderRecorder/orderStorage.ts`（候选） | G4/D R4:201 | D R4:201 | RF二审/SCOPED_D RF:127 | 否；有明确D |
| `src/application/orderTracking/recorder/types.ts` | `src/core/orderRecorder/types.ts`（候选） | G4/P R4:202 | 契约原等级保留；非穷尽 | G5/P R5:226 | 不适用：类型 |
| `src/application/orderTracking/tradeAudit/index.ts` | `src/app/runtime/createPostGateRuntime.ts`（补证定位；原候选留存） | G4/E R4:203 | D SO:60 | G0/P R0:296<br>G4本组补齐/D SO:60 | 否；有明确D |
| `src/application/orderTracking/tradeAudit/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/P R4:204 | 契约原等级保留；非穷尽；SO小契约补读 | G4/CONTRACT_TARGETED_FULL SO:165 | 不适用：类型 |
| `src/application/orderTracking/types.ts` | `src/core/trader/types.ts`（候选） | G4/P R4:205 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/ordinaryBuy/accountPositionsRead.ts` | `src/utils/accountPositions/index.ts`（候选） | G4/D R4:206 | D R4:206 | G5/P R5:223 | 否；有明确D |
| `src/application/ordinaryBuy/index.ts` | `src/core/signalProcessor/index.ts`（候选） | G4/D R4:207 | D R4:207 | G2/D R2:315 | 否；有明确D |
| `src/application/ordinaryBuy/riskChecks.ts` | `src/core/signalProcessor/riskCheckPipeline.ts`（候选） | G4/D R4:208 | D R4:208 | G5/P R5:223 | 否；有明确D |
| `src/application/ordinaryBuy/types.ts` | `src/core/signalProcessor/types.ts`<br>`src/utils/accountPositions/types.ts`（候选） | G4/P R4:209 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/ordinarySell/index.ts` | `src/core/signalProcessor/index.ts`（候选） | G4/D R4:210 | D R4:210 | G2/D R2:316<br>G5/P R5:224<br>RF二审/SCOPED_D RF:131 | 否；有明确D |
| `src/application/ordinarySell/quantityResolver.ts` | `src/core/signalProcessor/sellQuantityCalculator.ts`（候选） | G4/D R4:211 | D R4:211 | G5/P R5:224 | 否；有明确D |
| `src/application/ordinarySell/quantitySelection.ts` | `src/core/signalProcessor/utils.ts`（候选） | G4/D R4:212 | D R4:212 | G5/P R5:224<br>RF二审/SCOPED_D RF:131 | 否；有明确D |
| `src/application/ordinarySell/types.ts` | `src/core/signalProcessor/types.ts`（候选） | G4/P R4:213 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/order/cancelOutcomePolicy.ts` | `src/utils/trading/orderStatus.ts`（补证定位；原候选留存） | G4/E R4:214 | D SO:61 | G4本组补齐/D SO:61 | 否；有明确D |
| `src/domain/order/executionFact.ts` | `src/core/trader/orderMonitor/orderFactMerge.ts`（候选） | G4/D R4:215 | D R4:215 | G3/SD_OR_E R3:237<br>G5/P R5:229<br>G6/P R6:293<br>RF二审/D RF:128 | 否；有明确D |
| `src/domain/order/executionPolicy.ts` | `src/core/trader/orderExecutor/utils.ts`（候选） | G4/E R4:216 | D R2:319 | G2/D R2:319 | 否；有明确D |
| `src/domain/order/executionProjection.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/D R4:217 | D R4:217 | G5/P R5:229<br>RF二审/D RF:128 | 否；有明确D |
| `src/domain/order/orderAnalysis.ts` | `src/core/orderRecorder/index.ts`<br>`src/core/orderRecorder/orderFilteringEngine.ts`（补证定位；原候选留存） | G4/E R4:218 | D SO:62 | G5/P R5:229<br>G4本组补齐/D SO:62 | 否；有明确D |
| `src/domain/order/orderFactMerge.ts` | `src/core/trader/orderMonitor/orderFactMerge.ts`（候选） | G4/D R4:219 | D R4:219 | G5/P R5:229<br>RF二审/SCOPED_D RF:128 | 否；有明确D |
| `src/domain/order/orderFilteringEngine.ts` | `src/core/orderRecorder/orderFilteringEngine.ts`（候选） | G4/D R4:220 | D R4:220 | G5/P R5:229<br>RF二审/D RF:128 | 否；有明确D |
| `src/domain/order/orderOwnership.ts` | `src/core/orderRecorder/orderOwnershipParser.ts`（候选） | G4/D R4:221 | D R4:221 | G1/P R1:278<br>G3/SD_OR_E R3:236<br>G5/P R5:229<br>G6/D R6:294<br>RF二审/SCOPED_D RF:128 | 否；有明确D |
| `src/domain/order/orderQuantity.ts` | `src/core/orderRecorder/utils.ts`<br>`src/utils/numeric/index.ts`（补证定位；原候选留存） | G4/E R4:222 | D SO:63 | G4本组补齐/D SO:63 | 否；有明确D |
| `src/domain/order/orderReadLifecycle.ts` | `src/core/orderStatusLifecycle/index.ts`<br>`src/core/orderStatusLifecycle/utils.ts`（候选） | G4/E R4:223 | D R6:293 | G6/D R6:293 | 否；有明确D |
| `src/domain/order/orderRecordPolicy.ts` | `src/core/orderRecorder/utils.ts`（候选） | G4/D R4:224 | D R4:224 | G5/P R5:229 | 否；有明确D |
| `src/domain/order/orderRemark.ts` | `src/core/trader/utils.ts`（补证定位；原候选留存） | G4/E R4:225 | D SO:64 | G4本组补齐/D SO:64 | 否；有明确D |
| `src/domain/order/orderSnapshotPolicy.ts` | `src/core/orderStatusLifecycle/index.ts`（候选） | G4/E R4:226 | D R6:293 | G6/D R6:293 | 否；有明确D |
| `src/domain/order/orderTimeoutPolicy.ts` | `src/core/orderStatusLifecycle/index.ts`（候选） | G4/D R4:227 | D R4:227 | — | 否；有明确D |
| `src/domain/order/orderTrackingPolicy.ts` | `src/core/trader/orderMonitor/utils.ts`（补证定位；原候选留存） | G4/E R4:228 | D SO:65 | G4本组补齐/D SO:65<br>RM二审/SCOPED_D RM:199 | 否；有明确D |
| `src/domain/order/orderTypePolicy.ts` | `src/core/trader/utils.ts`（补证定位；原候选留存） | G4/E R4:229 | D SO:66 | G4本组补齐/D SO:66 | 否；有明确D |
| `src/domain/order/quoteReadiness.ts` | `src/core/utils.ts`（候选） | G4/E R4:230 | D R2:320 | G2/D R2:320 | 否；有明确D |
| `src/domain/order/sellDeductionPolicy.ts` | `src/core/orderRecorder/sellDeductionPolicy.ts`（候选） | G4/D R4:231 | D R4:231 | G5/P R5:229<br>RF二审/SCOPED_D RF:128 | 否；有明确D |
| `src/domain/order/sellMergePolicy.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/D R4:232 | D R4:232 | G3/SD_OR_E R3:238 | 否；有明确D |
| `src/domain/order/smartClose.ts` | `src/core/signalProcessor/utils.ts`（补证定位；原候选留存） | G4/E R4:233 | D SO:67 | G5/P R5:229<br>G4本组补齐/D SO:67 | 否；有明确D |
| `src/domain/order/types.ts` | `src/core/orderStatusLifecycle/types.ts`（候选） | G4/P R4:234 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/asyncProgram/buyProcessor/index.ts` | `src/main/asyncProgram/buyProcessor/index.ts`（候选） | G4/D R4:235 | D R4:235 | G1/D R1:257<br>G2/D R2:278 | 否；有明确D |
| `src/runtime/asyncProgram/buyProcessor/types.ts` | `src/main/asyncProgram/buyProcessor/types.ts`（候选） | G4/P R4:236 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/asyncProgram/sellProcessor/index.ts` | `src/main/asyncProgram/sellProcessor/index.ts`（候选） | G4/D R4:237 | D R4:237 | G1/D R1:258<br>G2/D R2:279 | 否；有明确D |
| `src/runtime/asyncProgram/sellProcessor/types.ts` | `src/main/asyncProgram/sellProcessor/types.ts`（候选） | G4/P R4:238 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/runtime/orderTradeAuditListener/index.ts` | `src/app/runtime/createPostGateRuntime.ts`（补证定位；原候选留存） | G4/E R4:239 | D SO:68 | G0/P R0:296<br>G4本组补齐/D SO:68 | 否；有明确D |
| `src/runtime/orderTradeAuditListener/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G4/P R4:240 | 契约原等级保留；非穷尽；SO小契约补读 | G4/CONTRACT_TARGETED_FULL SO:290 | 不适用：类型 |

### G5 风险账户清仓（36）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/application/accountPositionSnapshot/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`<br>`src/utils/positionCache/index.ts`（候选） | G5/D R5:116 | D R5:116 | G0/P R0:294<br>G1/D R1:232<br>G2/P R2:334<br>G6/P R6:292 | 否；有明确D |
| `src/application/accountPositionSnapshot/types.ts` | `src/types/state.ts`（候选） | G5/E R5:117 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/accountQuery/index.ts` | `src/core/trader/accountService.ts`（候选） | G5/D R5:118 | D R5:118 | G6/D R6:292 | 否；有明确D |
| `src/application/doomsdayClearance/index.ts` | `src/core/doomsdayProtection/index.ts`（候选） | G5/D R5:119 | D R5:119 | G1/P R1:274<br>G4/SD_OR_E R4:248 | 否；有明确D |
| `src/application/doomsdayClearance/types.ts` | `src/core/doomsdayProtection/types.ts`（候选） | G5/E R5:120 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/postTradeSettlement/index.ts` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`（候选） | G5/D R5:121 | D R5:121 | G0/P R0:294<br>G1/D R1:233<br>RF二审/SCOPED_D RF:131 | 否；有明确D |
| `src/application/postTradeSettlement/readinessGate.ts` | `src/utils/refreshGate/index.ts`（候选） | G5/D R5:122 | D R5:122 | G0/P R0:294<br>G1/D R1:234<br>G2/P R2:333 | 否；有明确D |
| `src/application/postTradeSettlement/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/E R5:123 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/protectiveLiquidation/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/D R5:124 | D R5:124 | — | 否；有明确D |
| `src/application/protectiveLiquidation/tradeLogHydrator.ts` | `src/services/liquidationCooldown/tradeLogHydrator.ts`（候选） | G5/D R5:125 | D R5:125 | — | 否；有明确D |
| `src/application/protectiveLiquidation/types.ts` | `src/services/liquidationCooldown/types.ts`（候选） | G5/E R5:126 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/protectiveLiquidation/unrealizedLossExecutor.ts` | `src/core/riskController/unrealizedLossMonitor.ts`<br>`src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts`（候选） | G5/D R5:127 | D R5:127 | G4/D R4:248 | 否；有明确D |
| `src/application/riskRefresh/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/E R5:128 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/application/riskRefresh/warrantRiskRefresh.ts` | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`（候选） | G5/D R5:129 | D R5:129 | G3/SD_OR_E R3:242<br>G6/D R6:294 | 否；有明确D |
| `src/application/staticLiquidation/index.ts` | `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts`（候选） | G5/D R5:130 | D R5:130 | G2/P R2:332 | 否；有明确D |
| `src/application/staticLiquidation/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/E R5:131 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/liquidation/cooldown/index.ts` | `src/services/liquidationCooldown/index.ts`（候选） | G5/D R5:132 | D R5:132 | — | 否；有明确D |
| `src/domain/liquidation/cooldown/rules.ts` | `src/services/liquidationCooldown/utils.ts`（候选） | G5/D R5:133 | D R5:133 | — | 否；有明确D |
| `src/domain/liquidation/cooldown/types.ts` | `src/services/liquidationCooldown/types.ts`（候选） | G5/E R5:134 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/liquidation/doomsday/index.ts` | `src/core/doomsdayProtection/utils.ts`（候选） | G5/D R5:135 | D R5:135 | — | 否；有明确D |
| `src/domain/liquidation/doomsday/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/E R5:136 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/liquidation/episode/index.ts` | `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts`（候选） | G5/D R5:137 | D R5:137 | — | 否；有明确D |
| `src/domain/liquidation/episode/types.ts` | `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts`（候选） | G5/E R5:138 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/risk/buyPricePolicy.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/D R5:139 | D R5:139 | — | 否；有明确D |
| `src/domain/risk/dailyLossRules.ts` | `src/core/riskController/utils.ts`（候选） | G5/D R5:140 | D R5:140 | — | 否；有明确D |
| `src/domain/risk/dailyLossTracker.ts` | `src/core/riskController/dailyLossTracker.ts`（候选） | G5/D R5:141 | D R5:141 | G3/P R3:259<br>G4/SD_OR_E R4:248<br>RF二审/SCOPED_D RF:130 | 否；有明确D |
| `src/domain/risk/executionHistory.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G5/D R5:142 | D R5:142 | — | 否；有明确D |
| `src/domain/risk/index.ts` | `src/core/riskController/index.ts`（候选） | G5/D R5:143 | D R5:143 | RF二审/SCOPED_D RF:130 | 否；有明确D |
| `src/domain/risk/positionLimitChecker.ts` | `src/core/riskController/positionLimitChecker.ts`（候选） | G5/D R5:144 | D R5:144 | — | 否；有明确D |
| `src/domain/risk/types.ts` | `src/core/riskController/types.ts`（候选） | G5/E R5:145 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/domain/risk/unrealizedLossChecker.ts` | `src/core/riskController/unrealizedLossChecker.ts`（候选） | G5/D R5:146 | D R5:146 | G4/D R4:248<br>RF二审/D RF:130 | 否；有明确D |
| `src/domain/risk/warrantRiskChecker.ts` | `src/core/riskController/warrantRiskChecker.ts`（候选） | G5/D R5:147 | D R5:147 | G3/SD_OR_E R3:239 | 否；有明确D |
| `src/runtime/tradingRiskEventRuntime/routeValidation.ts` | `src/main/tradingRiskEventRuntime/routeValidation.ts`（候选） | G5/D R5:148 | D R5:148 | G2/D R2:313<br>G4/P R4:248 | 否；有明确D |
| `src/runtime/tradingRiskEventRuntime/routingIndex.ts` | `src/main/tradingRiskEventRuntime/routingIndex.ts`（候选） | G5/D R5:149 | D R5:149 | G2/D R2:312 | 否；有明确D |
| `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` | `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`<br>`src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts`（候选） | G5/D R5:150 | D R5:150 | G0/P R0:294<br>G1/D R1:249<br>G2/D R2:311 | 否；有明确D |
| `src/runtime/tradingRiskEventRuntime/types.ts` | `src/main/tradingRiskEventRuntime/types.ts`（候选） | G5/E R5:151 | 契约原等级保留；非穷尽 | G2/D R2:314 | 不适用：类型 |

### G6 基础设施配置公共契约（120）

| current路径 | develop有效来源/定位 | 唯一主审与原等级 | 当前有效覆盖 | 补充/跨组证据 | 实质运行码仍欠D？ |
| --- | --- | --- | --- | --- | --- |
| `src/config/auth/index.ts` | `src/config/auth/index.ts`（候选） | G6/A R6:102 | D R6:102 | — | 否；有明确D |
| `src/config/auth/types.ts` | `src/config/auth/types.ts`（候选） | G6/T R6:103 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/config/auth/utils.ts` | `src/config/auth/utils.ts`（候选） | G6/A R6:104 | D R6:104 | — | 否；有明确D |
| `src/config/runtime/index.ts` | `src/utils/runtime/index.ts`（候选） | G6/A R6:105 | D R6:105 | — | 否；有明确D |
| `src/config/trading/index.ts` | `src/config/trading/index.ts`（候选） | G6/A R6:106 | D R6:106 | — | 否；有明确D |
| `src/config/trading/types.ts` | `src/config/trading/types.ts`（候选） | G6/T R6:107 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/config/trading/utils.ts` | `src/config/trading/utils.ts`（候选） | G6/A R6:108 | D R6:108 | — | 否；有明确D |
| `src/config/types.ts` | `src/config/types.ts`（候选） | G6/T R6:109 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/config/utils.ts` | `src/config/utils.ts`（候选） | G6/A R6:110 | D R6:110 | — | 否；有明确D |
| `src/config/validator/index.ts` | `src/config/validator/index.ts`（候选） | G6/A R6:111 | D R6:111 | — | 否；有明确D |
| `src/config/validator/types.ts` | `src/config/validator/types.ts`（候选） | G6/T R6:112 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/config/validator/utils.ts` | `src/config/validator/utils.ts`（候选） | G6/A R6:113 | D R6:113 | G3/P R3:267 | 否；有明确D |
| `src/constants/cleanup.ts` | `src/constants/cleanup.ts`（候选） | G6/A R6:119 | D R6:119 | G0/P R0:297<br>G1/D R1:261 | 否；有明确D |
| `src/constants/diagnostics.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:120 | D R6:120 | — | 否；有明确D |
| `src/constants/financialConfig.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:121 | D R6:121 | — | 否；有明确D |
| `src/constants/index.ts` | `src/constants/index.ts`（候选） | G6/A R6:122 | D R6:122 | — | 否；有明确D |
| `src/constants/orderOwnership.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:123 | D R6:123 | — | 否；有明确D |
| `src/constants/orderReadMetadata.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:124 | D R6:124 | — | 否；有明确D |
| `src/constants/strategy.ts` | `src/constants/strategy.ts`（候选） | G6/A R6:125 | D R6:125 | G2/D R2:289 | 否；有明确D |
| `src/constants/tradeRateLimit.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:126 | D R6:126 | — | 否；有明确D |
| `src/infrastructure/diagnostics/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:170 | D R6:170 | — | 否；有明确D |
| `src/infrastructure/diagnostics/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:171 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/display/accountDisplay/index.ts` | `src/services/accountDisplay/index.ts`（候选） | G6/A R6:172 | D R6:172 | — | 否；有明确D |
| `src/infrastructure/display/marketMonitor/index.ts` | `src/services/marketMonitor/index.ts`（候选） | G6/A R6:173 | D R6:173 | G2/D R2:321 | 否；有明确D |
| `src/infrastructure/display/marketMonitor/priceDisplayInfo.ts` | `src/services/marketMonitor/priceDisplayInfo.ts`（候选） | G6/A R6:174 | D R6:174 | — | 否；有明确D |
| `src/infrastructure/display/marketMonitor/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:175 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/display/marketMonitor/utils.ts` | `src/services/marketMonitor/utils.ts`（候选） | G6/A R6:176 | D R6:176 | — | 否；有明确D |
| `src/infrastructure/externalApi/errorClassification.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:177 | D R6:177 | RM二审/SCOPED_D RM:187 | 否；有明确D |
| `src/infrastructure/externalApi/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:178 | D R6:178 | G2/D R2:287<br>G4/D R4:250<br>RM二审/SCOPED_D RM:186 | 否；有明确D |
| `src/infrastructure/externalApi/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:179 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/logger/index.ts` | `src/utils/logger/index.ts`（补证定位；原候选留存） | G6/B R6:180 | D SP:52 | 平台补齐/D SP:52 | 否；有明确D |
| `src/infrastructure/logger/types.ts` | `src/utils/logger/types.ts`（候选） | G6/T R6:181 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/longbridge/market/candlestickCache.ts` | `src/services/quoteClient/candlestickCache.ts`（候选） | G6/A R6:132 | D R6:132 | G2/D R2:260 | 否；有明确D |
| `src/infrastructure/longbridge/market/candlestickMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:133 | D R6:133 | G2/D R2:261 | 否；有明确D |
| `src/infrastructure/longbridge/market/marketEnumMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:134 | D R6:134 | G2/D R2:262 | 否；有明确D |
| `src/infrastructure/longbridge/market/marketMetadataMapper.ts` | `src/services/quoteClient/utils.ts`（候选） | G6/A R6:135 | D R6:135 | G2/D R2:263 | 否；有明确D |
| `src/infrastructure/longbridge/market/quoteClient.ts` | `src/services/quoteClient/index.ts`（候选） | G6/A R6:136 | D R6:136 | G1/P R1:281<br>G2/D R2:259 | 否；有明确D |
| `src/infrastructure/longbridge/market/quoteFinancialMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:137 | D R6:137 | G2/D R2:264<br>G3/SD_OR_E R3:247 | 否；有明确D |
| `src/infrastructure/longbridge/market/types.ts` | `src/services/quoteClient/types.ts`（候选） | G6/T R6:138 | 契约原等级保留；非穷尽 | G2/D R2:265 | 不适用：类型 |
| `src/infrastructure/longbridge/market/warrantListCache/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:139 | D R6:139 | G2/D R2:268<br>G3/SD_OR_E R3:245 | 否；有明确D |
| `src/infrastructure/longbridge/market/warrantListCache/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:140 | 契约原等级保留；非穷尽 | G2/D R2:269 | 不适用：类型 |
| `src/infrastructure/longbridge/market/warrantListReadAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:141 | D R6:141 | G2/D R2:266<br>G3/SD_OR_E R3:244 | 否；有明确D |
| `src/infrastructure/longbridge/market/warrantRequestMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:142 | D R6:142 | G2/D R2:267<br>G3/SD_OR_E R3:246 | 否；有明确D |
| `src/infrastructure/longbridge/trade/accountMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:148 | D R6:148 | G4/SD_OR_E R4:247<br>G5/P R5:231 | 否；有明确D |
| `src/infrastructure/longbridge/trade/accountReadAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:149 | D R6:149 | G5/P R5:231 | 否；有明确D |
| `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:150 | D R6:150 | G0/P R0:297 | 否；有明确D |
| `src/infrastructure/longbridge/trade/clientFactory/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:151 | D R6:151 | G1/P R1:280 | 否；有明确D |
| `src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:152 | D R6:152 | — | 否；有明确D |
| `src/infrastructure/longbridge/trade/clientFactory/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:153 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/longbridge/trade/mutationErrorClassification.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:154 | D R6:154 | G4/D R4:247<br>RM二审/SCOPED_D RM:184 | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:155 | D R6:155 | G4/D R4:247 | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderMapper.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:156 | D R6:156 | G3/P R3:260<br>G4/D R4:247<br>G5/P R5:231<br>RF二审/SCOPED_D RF:130 | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderPushAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:157 | D R6:157 | G0/P R0:297<br>G4/D R4:247 | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderReadErrorClassification.ts` | `src/core/trader/orderMonitor/utils.ts`（候选） | G6/A R6:158 | D R6:158 | — | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts` | `src/core/orderRecorder/orderApiManager.ts`（候选） | G6/A R6:159 | D R6:159 | G3/SD_OR_E R3:248<br>G4/D R4:247<br>G5/P R5:231 | 否；有明确D |
| `src/infrastructure/longbridge/trade/orderValidation.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:160 | D R6:160 | G4/D R4:247 | 否；有明确D |
| `src/infrastructure/longbridge/trade/pendingOrdersAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:161 | D R6:161 | G4/D R4:247 | 否；有明确D |
| `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:162 | D R6:162 | G4/SD_OR_E R4:247<br>G5/P R5:231 | 否；有明确D |
| `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:163 | D R6:163 | G4/D R4:247<br>G5/P R5:231<br>RM二审/SCOPED_D RM:185 | 否；有明确D |
| `src/infrastructure/longbridge/trade/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:164 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | `src/services/mixedTradeLogRepository/index.ts`（补证定位；原候选留存） | G6/B R6:182 | D SP:53 | G4/P R4:249<br>平台补齐/D SP:53 | 否；有明确D |
| `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts` | `src/utils/trading/tradeLogPath.ts`（补证定位；原候选留存） | G6/A R6:183 | D R6:183 | — | 否；有明确D |
| `src/infrastructure/persistence/mixedTradeLogRepository/types.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:184 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/infrastructure/time/index.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:185 | D R6:185 | G1/D R1:260<br>G2/D R2:288 | 否；有明确D |
| `src/runtime/timer/index.ts` | `src/utils/timer/index.ts`（候选） | G6/B R6:241 | D R1:259 | G1/D R1:259<br>RM二审/SCOPED_D RM:201 | 否；有明确D |
| `src/types/account.ts` | `src/services/accountDisplay/types.ts`<br>`src/types/account.ts`（候选） | G6/A R6:191 | 契约原等级保留；非穷尽 | G0/P R0:297<br>G3/P R3:268 | 不适用：类型 |
| `src/types/accountPosition.ts` | `src/services/accountDisplay/types.ts`<br>`src/types/state.ts`<br>`src/utils/accountPositions/types.ts`<br>`src/utils/positionCache/index.ts`（候选） | G6/A R6:192 | 契约原等级保留；非穷尽 | G3/P R3:268<br>G5/P R5:232 | 不适用：类型 |
| `src/types/accountReadPorts.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:193 | 契约原等级保留；非穷尽 | G3/P R3:268 | 不适用：类型 |
| `src/types/apiFailure.ts` | `src/utils/apiFailure/types.ts`（候选） | G6/T R6:194 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/brokerAccessPorts.ts` | `src/core/trader/index.ts`（候选） | G6/A R6:195 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/brokerClientFactory.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:196 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/cleanup.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:197 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/config.ts` | `src/types/config.ts`（候选） | G6/T R6:198 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/data.ts` | `src/types/data.ts`<br>`src/utils/helpers/types.ts`（候选） | G6/T R6:199 | 契约原等级保留；非穷尽 | G2/D R2:282 | 不适用：类型 |
| `src/types/diagnostics.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:200 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/display.ts` | `src/services/accountDisplay/types.ts`<br>`src/services/marketMonitor/types.ts`<br>`src/types/services.ts`（候选） | G6/T R6:201 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/events.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:202 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/lifecycle.ts` | `src/main/lifecycle/types.ts`（候选） | G6/T R6:203 | 契约原等级保留；非穷尽 | G1/D R1:263 | 不适用：类型 |
| `src/types/logger.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:204 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/marketPorts.ts` | `src/types/services.ts`（候选） | G6/A R6:205 | 契约原等级保留；非穷尽 | G2/D R2:281 | 不适用：类型 |
| `src/types/monitor.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:206 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderCancellation.ts` | `src/types/trader.ts`（候选） | G6/T R6:207 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderDetailReadPorts.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:208 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderExecutionPorts.ts` | `src/core/trader/index.ts`<br>`src/types/services.ts`（候选） | G6/T R6:209 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderHold.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:210 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderPushPorts.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:211 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderReadMetadata.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:212 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderRecorder.ts` | `src/types/orderRecorder.ts`（候选） | G6/T R6:213 | 契约原等级保留；非穷尽 | G4/SD_OR_E R4:250 | 不适用：类型 |
| `src/types/orderSnapshotReadPorts.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:214 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/orderTracking.ts` | `src/core/orderStatusLifecycle/types.ts`（候选） | G6/T R6:215 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/periodicSwitch.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:216 | 契约原等级保留；非穷尽 | G3/SD_OR_E R3:250 | 不适用：类型 |
| `src/types/quote.ts` | `src/types/quote.ts`（候选） | G6/T R6:217 | 契约原等级保留；非穷尽 | G2/D R2:283 | 不适用：类型 |
| `src/types/quoteSubscription.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:218 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/rateLimit.ts` | `src/utils/types.ts`（候选） | G6/T R6:219 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/risk.ts` | `src/types/risk.ts`（候选） | G6/T R6:220 | 契约原等级保留；非穷尽 | G5/P R5:232 | 不适用：类型 |
| `src/types/riskCheck.ts` | `src/core/signalProcessor/types.ts`（候选） | G6/T R6:221 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/runtime.ts` | `src/types/runtime.ts`<br>`src/types/state.ts`（候选） | G6/T R6:222 | 契约原等级保留；非穷尽 | G1/D R1:262<br>G2/D R2:285 | 不适用：类型 |
| `src/types/seat.ts` | `src/types/seat.ts`<br>`src/utils/helpers/types.ts`<br>`src/utils/seat/types.ts`（候选） | G6/T R6:223 | 契约原等级保留；非穷尽 | G3/SD_OR_E R3:250 | 不适用：类型 |
| `src/types/seatSwitch.ts` | `src/types/monitorContextPorts.ts`（候选） | G6/T R6:224 | 契约原等级保留；非穷尽 | G3/SD_OR_E R3:250 | 不适用：类型 |
| `src/types/settlement.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:225 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/signal.ts` | `src/types/signal.ts`（候选） | G6/T R6:226 | 契约原等级保留；非穷尽 | G2/D R2:284 | 不适用：类型 |
| `src/types/strategy.ts` | `src/core/strategy/types.ts`（候选） | G6/T R6:227 | 契约原等级保留；非穷尽 | G2/D R2:280 | 不适用：类型 |
| `src/types/timeControlPlane.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:228 | 契约原等级保留；非穷尽 | G1/D R1:264 | 不适用：类型 |
| `src/types/timer.ts` | `src/utils/timer/types.ts`（候选） | G6/T R6:229 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/trade.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:230 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/tradeLog.ts` | `src/services/mixedTradeLogRepository/types.ts`（候选） | G6/T R6:231 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/tradeMutationPorts.ts` | `src/core/trader/index.ts`（候选） | G6/A R6:232 | 契约原等级保留；非穷尽 | G4/SD_OR_E R4:250<br>RM二审/SCOPED_D RM:190 | 不适用：类型 |
| `src/types/tradingCalendar.ts` | `src/types/state.ts`<br>`src/types/tradingCalendar.ts`（候选） | G6/T R6:233 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/unrealizedLoss.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:234 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/types/warrantRisk.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/T R6:235 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/utils/apiFailure/index.ts` | `src/utils/apiFailure/index.ts`（候选） | G6/A R6:242 | D R6:242 | G1/P R1:275<br>G4/P R4:250<br>G5/P R5:232<br>RM二审/SCOPED_D RM:188 | 否；有明确D |
| `src/utils/display/index.ts` | `src/utils/display/index.ts`（候选） | G6/A R6:243 | D R6:243 | — | 否；有明确D |
| `src/utils/error/index.ts` | `src/utils/error/index.ts`（候选） | G6/A R6:244 | D R6:244 | — | 否；有明确D |
| `src/utils/helpers/index.ts` | `src/utils/helpers/index.ts`（候选） | G6/A R6:245 | D R6:245 | — | 否；有明确D |
| `src/utils/marketScope.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:246 | D R6:246 | G3/SD_OR_E R3:251 | 否；有明确D |
| `src/utils/numeric/exact.ts` | 新增/抽出/未配对；未伪造一对一旧来源 | G6/A R6:247 | D R6:247 | — | 否；有明确D |
| `src/utils/numeric/index.ts` | `src/utils/numeric/index.ts`（候选） | G6/A R6:248 | D R6:248 | G2/D R2:286,R2:291 | 否；有明确D |
| `src/utils/numeric/types.ts` | `src/utils/numeric/types.ts`<br>`src/utils/types.ts`（候选） | G6/T R6:249 | 契约原等级保留；非穷尽 | — | 不适用：类型 |
| `src/utils/time/index.ts` | `src/utils/time/index.ts`<br>`src/main/lifecycle/utils.ts`（补证定位；原候选留存） | G6/A R6:250 | D R6:250 | — | 否；有明确D |
| `src/utils/time/types.ts` | `src/utils/time/types.ts`<br>`src/utils/types.ts`（候选） | G6/T R6:251 | 契约原等级保留；非穷尽 | — | 不适用：类型 |

## 5. G4原P11 / G6原T52：契约消费者表更新

63项均为纯类型，原P/T历史保留。SO:S05/S13顺带全文读tradeAudit/types:1–22与listener/types:1–11已具名记录，不升级其他大型P契约或全订阅/仓储链语义。

**不足表更新：全部已登记直接运行时消费者均有D，已知消费者运行码D缺口=0。** G4为11/11项；G6为51/52项有直接D消费者。剩余 `src/types/orderHold.ts`只见3个纯类型中间导入者，直接运行时消费者记不适用；字段传播未评估，不列无意义业务补审任务。

**G0–G5直接消费只是归属统计，不是设施私有契约的合格门槛。** logger/persistence等由真实设施/平台实现消费且已有D，不要求业务代理为凑消费数字重审设施类型。直接import也不证明全部字段/合法状态/动态消费者。

| 原焦点组 | 纯类型数 | 有直接runtime消费者 | 有直接消费者D | 全部已知直接消费者均D | 无直接runtime边 | 已知消费者D缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| G4 | 11 | 11 | 11 | 11 | 0 | 0 |
| G6 | 52 | 51 | 51 | 51 | 1 | 0 |

业务组直接D描述性统计：G4 11/11；G6 41/52。其余为设施/平台消费或仅类型中间边，不当不足项。

| 契约文件 | 原等级/报告 | 最佳真实直接消费者及D证据 | 当前消费者/未评估边界 |
| --- | --- | --- | --- |
| `src/application/orderExecution/types.ts` | G4/P R4:185 | `src/application/orderExecution/buyThrottle.ts` — D SO:56 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/orderTracking/orderMonitor/types.ts` | G4/P R4:198 | `src/application/orderTracking/orderMonitor/eventFlow.ts` — D R4:188 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/orderTracking/recorder/types.ts` | G4/P R4:202 | `src/application/orderTracking/recorder/index.ts` — D R4:199 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/orderTracking/tradeAudit/types.ts` | G4/P R4:204 | `src/application/orderTracking/tradeAudit/index.ts` — D SO:60 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/orderTracking/types.ts` | G4/P R4:205 | `src/application/orderTracking/orderCacheManager.ts` — D R4:186 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/ordinaryBuy/types.ts` | G4/P R4:209 | `src/application/ordinaryBuy/accountPositionsRead.ts` — D R4:206 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/application/ordinarySell/types.ts` | G4/P R4:213 | `src/application/ordinarySell/index.ts` — D R4:210 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/domain/order/types.ts` | G4/P R4:234 | `src/application/tradingDayRebuild/executionNormalization.ts` — D R1:176 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/runtime/asyncProgram/buyProcessor/types.ts` | G4/P R4:236 | `src/runtime/asyncProgram/buyProcessor/index.ts` — D R4:235 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/runtime/asyncProgram/sellProcessor/types.ts` | G4/P R4:238 | `src/runtime/asyncProgram/sellProcessor/index.ts` — D R4:237 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/runtime/orderTradeAuditListener/types.ts` | G4/P R4:240 | `src/runtime/orderTradeAuditListener/index.ts` — D SO:68 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/config/auth/types.ts` | G6/T R6:103 | `src/config/auth/index.ts` — D R6:102 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/config/trading/types.ts` | G6/T R6:107 | `src/config/trading/utils.ts` — D R6:108 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/config/types.ts` | G6/T R6:109 | `src/config/utils.ts` — D R6:110 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/config/validator/types.ts` | G6/T R6:112 | `src/config/validator/index.ts` — D R6:111 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/infrastructure/diagnostics/types.ts` | G6/T R6:171 | `src/infrastructure/diagnostics/index.ts` — D R6:170 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/infrastructure/display/marketMonitor/types.ts` | G6/T R6:175 | `src/infrastructure/display/marketMonitor/utils.ts` — D R6:176 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/infrastructure/externalApi/types.ts` | G6/T R6:179 | `src/infrastructure/externalApi/index.ts` — D R2:287 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/infrastructure/logger/types.ts` | G6/T R6:181 | `src/infrastructure/logger/index.ts` — D SP:52 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/infrastructure/longbridge/market/types.ts` | G6/T R6:138 | `src/infrastructure/longbridge/market/candlestickCache.ts` — D R2:260 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/infrastructure/longbridge/market/warrantListCache/types.ts` | G6/T R6:140 | `src/infrastructure/longbridge/market/warrantListCache/index.ts` — D R2:268 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/infrastructure/longbridge/trade/clientFactory/types.ts` | G6/T R6:153 | `src/infrastructure/longbridge/trade/clientFactory/index.ts` — D R6:151 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/infrastructure/longbridge/trade/types.ts` | G6/T R6:164 | `src/infrastructure/longbridge/trade/orderMapper.ts` — D R4:247 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/infrastructure/persistence/mixedTradeLogRepository/types.ts` | G6/T R6:184 | `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` — D SP:53 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |
| `src/types/accountReadPorts.ts` | G6/T R6:193 | `src/application/accountQuery/index.ts` — D R5:118 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/apiFailure.ts` | G6/T R6:194 | `src/application/accountQuery/index.ts` — D R5:118 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/cleanup.ts` | G6/T R6:197 | `src/constants/cleanup.ts` — D R1:261 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/config.ts` | G6/T R6:198 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/data.ts` | G6/T R6:199 | `src/strategies/intradayRegression/indicators/adx.ts` — D R2:234 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/display.ts` | G6/T R6:201 | `src/infrastructure/display/marketMonitor/index.ts` — D R2:321 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/events.ts` | G6/T R6:202 | `src/runtime/quoteSubscriptionRuntime/index.ts` — D R2:218 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/lifecycle.ts` | G6/T R6:203 | `src/app/runtime/createPostGateRuntime.ts` — D R0:254 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/logger.ts` | G6/T R6:204 | `src/runtime/asyncProgram/monitorTaskQueue/index.ts` — D R0:275 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/monitor.ts` | G6/T R6:206 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderCancellation.ts` | G6/T R6:207 | `src/application/seatSwitch/switchStateMachine.ts` — D R3:198 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderDetailReadPorts.ts` | G6/T R6:208 | `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts` — D R4:247 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderExecutionPorts.ts` | G6/T R6:209 | `src/application/orderExecution/index.ts` — D R4:179 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderHold.ts` | G6/T R6:210 | `src/application/tradingDayRebuild/types.ts` R1:187<br>`src/runtime/quoteSubscriptionRuntime/types.ts` R2:219<br>`src/application/seatSwitch/types.ts` R3:199 | 仅类型中间边，无直接runtime项；字段传播未证，不列运行码缺口 |
| `src/types/orderPushPorts.ts` | G6/T R6:211 | `src/application/orderTracking/orderMonitor/index.ts` — D R4:189 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderReadMetadata.ts` | G6/T R6:212 | `src/application/seatSwitch/switchStateMachine.ts` — D R3:198 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderRecorder.ts` | G6/T R6:213 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderSnapshotReadPorts.ts` | G6/T R6:214 | `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts` — D R4:247 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/orderTracking.ts` | G6/T R6:215 | `src/application/orderTracking/orderMonitor/index.ts` — D R4:189 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/periodicSwitch.ts` | G6/T R6:216 | `src/runtime/periodicSwitchWakeupRuntime/index.ts` — D R3:211 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/quote.ts` | G6/T R6:217 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/quoteSubscription.ts` | G6/T R6:218 | `src/app/runtime/createPostGateRuntime.ts` — D R0:254 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/rateLimit.ts` | G6/T R6:219 | `src/application/orderExecution/quantityResolver.ts` — D R4:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/risk.ts` | G6/T R6:220 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/riskCheck.ts` | G6/T R6:221 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/runtime.ts` | G6/T R6:222 | `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts` — D R0:273 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/seat.ts` | G6/T R6:223 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` — D R1:180 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/seatSwitch.ts` | G6/T R6:224 | `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts` — D R2:216 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/settlement.ts` | G6/T R6:225 | `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` — D R2:214 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/signal.ts` | G6/T R6:226 | `src/application/orderExecution/buyThrottle.ts` — D SO:56 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/strategy.ts` | G6/T R6:227 | `src/app/startup/createSelectedStrategy.ts` — D R0:263 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/timeControlPlane.ts` | G6/T R6:228 | `src/app/lifecycle/createLifecycleRuntime.ts` — D R0:249 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/timer.ts` | G6/T R6:229 | `src/runtime/timeWakeupRuntime/index.ts` — D R1:206 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/tradeLog.ts` | G6/T R6:231 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` — D R1:177 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/tradingCalendar.ts` | G6/T R6:233 | `src/app/context/createMonitorContext.ts` — D R0:247 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/unrealizedLoss.ts` | G6/T R6:234 | `src/application/protectiveLiquidation/unrealizedLossExecutor.ts` — D R5:127 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/types/warrantRisk.ts` | G6/T R6:235 | `src/domain/risk/warrantRiskChecker.ts` — D R5:147 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/utils/numeric/types.ts` | G6/T R6:249 | `src/utils/numeric/index.ts` — D R2:286 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽 |
| `src/utils/time/types.ts` | G6/T R6:251 | `src/utils/time/index.ts` — D R6:250 | 所有已知直接runtime消费者D；字段/状态/动态边未穷尽；设施/平台消费已足，无需业务组重复审 |

## 6. 263旧文件迁移索引

原始263行/机制不变，下表列补证纠偏后的有效current定位。路径边不等于所有旧符号逐一证明迁移等价；observation只为协议祖先，日期枚举/数量helper按限定函数拆分。原候选、边变更理由和evidence均保留于JSON。

| develop路径 | 有效current定位/祖先候选 | 原机制/锚点 | 补证纠偏/限定 |
| --- | --- | --- | --- |
| `src/app/context/createMonitorContext.ts` | `src/app/context/createMonitorContext.ts` | 同路径，行为待比较；G0 B:627 | — |
| `src/app/lifecycle/createLifecycleRuntime.ts` | `src/app/lifecycle/createLifecycleRuntime.ts` | 同路径，行为待比较；G0 B:628 | — |
| `src/app/lifecycle/rebuild.ts` | `src/application/tradingDayRebuild/startupRebuild.ts`<br>`src/application/tradingDayRebuild/openRebuild.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1 B:629 | — |
| `src/app/runApp.ts` | `src/app/runApp.ts` | 同路径，行为待比较；G0 B:630 | — |
| `src/app/runAppDeps.ts` | `src/app/runAppDeps.ts` | 同路径，行为待比较；G0 B:631 | — |
| `src/app/runtime/createAsyncRuntime.ts` | `src/app/runtime/createAsyncRuntime.ts` | 同路径，行为待比较；G0 B:632 | — |
| `src/app/runtime/createPostGateRuntime.ts` | `src/app/runtime/createPostGateRuntime.ts`<br>`src/application/orderTracking/tradeAudit/index.ts`<br>`src/runtime/orderTradeAuditListener/index.ts` | 同路径，行为待比较；G0 B:633 | SO:61,SO:69 |
| `src/app/runtime/createPostGateRuntimeDeps.ts` | `src/app/runtime/createPostGateRuntimeDeps.ts` | 同路径，行为待比较；G0 B:634 | — |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts` | `src/app/runtime/createPostTradeConsistencyRuntime.ts` | 同路径，行为待比较；G0 B:635 | — |
| `src/app/runtime/createPreGateRuntime.ts` | `src/app/runtime/createPreGateRuntime.ts` | 同路径，行为待比较；G0 B:636 | — |
| `src/app/runtime/createPreGateRuntimeDeps.ts` | `src/app/runtime/createPreGateRuntimeDeps.ts` | 同路径，行为待比较；G0 B:637 | — |
| `src/app/runtime/createTerminationRuntime.ts` | `src/runtime/lifecycle/terminationRuntime.ts` | R100 Git 定位，非等价证明；G1 B:638 | — |
| `src/app/shutdown/createCleanup.ts` | `src/app/shutdown/createCleanup.ts` | 同路径，行为待比较；G0 B:639 | — |
| `src/app/startup/createSelectedStrategy.ts` | `src/app/startup/createSelectedStrategy.ts` | 同路径，行为待比较；G0 B:640 | — |
| `src/app/startup/prepareStrategy.ts` | `src/app/startup/prepareStrategy.ts` | 同路径，行为待比较；G0 B:641 | — |
| `src/app/startup/runtimeValidation.ts` | `src/app/startup/runtimeValidation.ts` | 同路径，行为待比较；G0 B:642 | — |
| `src/app/startup/startupSnapshot.ts` | `src/application/tradingDayRebuild/startupSnapshot.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1 B:643 | — |
| `src/app/startup/strategyLoaderHelpers.ts` | `src/app/startup/strategyLoaderHelpers.ts` | 同路径，行为待比较；G0 B:644 | — |
| `src/app/startup/types.ts` | `src/app/startup/types.ts` | 同路径，行为待比较；G0 B:645 | — |
| `src/app/types.ts` | `src/app/types.ts` | 同路径，行为待比较；G0 B:646 | — |
| `src/config/auth/index.ts` | `src/config/auth/index.ts` | 同路径，行为待比较；G6 B:647 | — |
| `src/config/auth/types.ts` | `src/config/auth/types.ts` | 同路径，行为待比较；G6 B:648 | — |
| `src/config/auth/utils.ts` | `src/config/auth/utils.ts` | 同路径，行为待比较；G6 B:649 | — |
| `src/config/trading/index.ts` | `src/config/trading/index.ts` | 同路径，行为待比较；G6 B:650 | — |
| `src/config/trading/types.ts` | `src/config/trading/types.ts` | 同路径，行为待比较；G6 B:651 | — |
| `src/config/trading/utils.ts` | `src/config/trading/utils.ts` | 同路径，行为待比较；G6 B:652 | — |
| `src/config/types.ts` | `src/config/types.ts` | 同路径，行为待比较；G6 B:653 | — |
| `src/config/utils.ts` | `src/config/utils.ts` | 同路径，行为待比较；G6 B:654 | — |
| `src/config/validator/index.ts` | `src/config/validator/index.ts` | 同路径，行为待比较；G6 B:655 | — |
| `src/config/validator/types.ts` | `src/config/validator/types.ts` | 同路径，行为待比较；G6 B:656 | — |
| `src/config/validator/utils.ts` | `src/config/validator/utils.ts` | 同路径，行为待比较；G6 B:657 | — |
| `src/constants/cleanup.ts` | `src/constants/cleanup.ts` | 同路径，行为待比较；G6 B:658 | — |
| `src/constants/index.ts` | `src/constants/index.ts` | 同路径，行为待比较；G6 B:659 | — |
| `src/constants/strategy.ts` | `src/constants/strategy.ts` | 同路径，行为待比较；G6 B:660 | — |
| `src/core/doomsdayProtection/index.ts` | `src/application/doomsdayClearance/index.ts` | R050 Git 定位，非等价证明；G5 B:661 | — |
| `src/core/doomsdayProtection/types.ts` | `src/application/doomsdayClearance/types.ts` | R026 Git 定位，非等价证明；G5 B:662 | — |
| `src/core/doomsdayProtection/utils.ts` | `src/domain/liquidation/doomsday/index.ts` | R068 Git 定位，非等价证明；G5 B:663 | — |
| `src/core/orderRecorder/index.ts` | `src/application/orderTracking/recorder/index.ts`<br>`src/domain/order/orderAnalysis.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:664 | SO:63 |
| `src/core/orderRecorder/orderApiManager.ts` | `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts` | R027 Git 定位，非等价证明；G6 B:665 | — |
| `src/core/orderRecorder/orderFilteringEngine.ts` | `src/domain/order/orderFilteringEngine.ts`<br>`src/domain/order/orderAnalysis.ts` | R073 Git 定位，非等价证明；G4 B:666 | SO:63 |
| `src/core/orderRecorder/orderOwnershipParser.ts` | `src/domain/order/orderOwnership.ts` | R089 Git 定位，非等价证明；G4 B:667 | — |
| `src/core/orderRecorder/orderStorage.ts` | `src/application/orderTracking/recorder/orderStorage.ts` | R064 Git 定位，非等价证明；G4 B:668 | — |
| `src/core/orderRecorder/sellDeductionPolicy.ts` | `src/domain/order/sellDeductionPolicy.ts` | R086 Git 定位，非等价证明；G4 B:669 | — |
| `src/core/orderRecorder/types.ts` | `src/application/orderTracking/recorder/types.ts` | R042 Git 定位，非等价证明；G4 B:670 | — |
| `src/core/orderRecorder/utils.ts` | `src/domain/order/orderRecordPolicy.ts`<br>`src/domain/order/orderQuantity.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:671 | SO:64 |
| `src/core/orderStatusLifecycle/index.ts` | `src/domain/order/orderReadLifecycle.ts`<br>`src/domain/order/orderSnapshotPolicy.ts`<br>`src/domain/order/orderTimeoutPolicy.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:672 | SO:232 |
| `src/core/orderStatusLifecycle/types.ts` | `src/domain/order/types.ts`<br>`src/types/orderTracking.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 B:673 | — |
| `src/core/orderStatusLifecycle/utils.ts` | `src/domain/order/orderReadLifecycle.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:674 | SO:232 |
| `src/core/riskController/dailyLossTracker.ts` | `src/domain/risk/dailyLossTracker.ts` | R065 Git 定位，非等价证明；G5 B:675 | — |
| `src/core/riskController/index.ts` | `src/domain/risk/index.ts` | R025 Git 定位，非等价证明；G5 B:676 | — |
| `src/core/riskController/positionLimitChecker.ts` | `src/domain/risk/positionLimitChecker.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:677 | — |
| `src/core/riskController/types.ts` | `src/domain/risk/types.ts` | R051 Git 定位，非等价证明；G5 B:678 | — |
| `src/core/riskController/unrealizedLossChecker.ts` | `src/domain/risk/unrealizedLossChecker.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:679 | — |
| `src/core/riskController/unrealizedLossMonitor.ts` | `src/application/protectiveLiquidation/unrealizedLossExecutor.ts` | R033 Git 定位，非等价证明；G5 B:680 | — |
| `src/core/riskController/utils.ts` | `src/domain/risk/dailyLossRules.ts` | R068 Git 定位，非等价证明；G5 B:681 | — |
| `src/core/riskController/warrantRiskChecker.ts` | `src/domain/risk/warrantRiskChecker.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:682 | — |
| `src/core/signalProcessor/index.ts` | `src/application/ordinaryBuy/index.ts`<br>`src/application/ordinarySell/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:683 | — |
| `src/core/signalProcessor/riskCheckPipeline.ts` | `src/application/ordinaryBuy/riskChecks.ts` | R077 Git 定位，非等价证明；G4 B:684 | — |
| `src/core/signalProcessor/sellQuantityCalculator.ts` | `src/application/ordinarySell/quantityResolver.ts` | R079 Git 定位，非等价证明；G4 B:685 | — |
| `src/core/signalProcessor/types.ts` | `src/application/ordinaryBuy/types.ts`<br>`src/application/ordinarySell/types.ts`<br>`src/types/riskCheck.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 B:686 | — |
| `src/core/signalProcessor/utils.ts` | `src/application/ordinarySell/quantitySelection.ts`<br>`src/domain/order/smartClose.ts` | R066 Git 定位，非等价证明；G4 B:687 | SO:68 |
| `src/core/strategy/intradayRegression/config.json` | `src/strategies/intradayRegression/config.json` | R100 Git 定位，非等价证明；G2 B:688 | — |
| `src/core/strategy/intradayRegression/config.ts` | `src/strategies/intradayRegression/config.ts` | R100 Git 定位，非等价证明；G2 B:689 | — |
| `src/core/strategy/intradayRegression/constants.ts` | `src/strategies/intradayRegression/constants.ts` | R100 Git 定位，非等价证明；G2 B:690 | — |
| `src/core/strategy/intradayRegression/definition.ts` | `src/strategies/intradayRegression/definition.ts` | R087 Git 定位，非等价证明；G2 B:691 | — |
| `src/core/strategy/intradayRegression/display.ts` | `src/strategies/intradayRegression/display.ts` | R094 Git 定位，非等价证明；G2 B:692 | — |
| `src/core/strategy/intradayRegression/dsl.ts` | `src/strategies/intradayRegression/dsl.ts` | R100 Git 定位，非等价证明；G2 B:693 | — |
| `src/core/strategy/intradayRegression/index.ts` | `src/strategies/intradayRegression/index.ts` | R095 Git 定位，非等价证明；G2 B:694 | — |
| `src/core/strategy/intradayRegression/indicatorHelpers/types.ts` | `src/strategies/intradayRegression/indicatorHelpers/types.ts` | R100 Git 定位，非等价证明；G2 B:695 | — |
| `src/core/strategy/intradayRegression/indicatorHelpers/utils.ts` | `src/strategies/intradayRegression/indicatorHelpers/utils.ts` | R100 Git 定位，非等价证明；G2 B:696 | — |
| `src/core/strategy/intradayRegression/profile/index.ts` | `src/strategies/intradayRegression/profile/index.ts` | R100 Git 定位，非等价证明；G2 B:697 | — |
| `src/core/strategy/intradayRegression/profile/types.ts` | `src/strategies/intradayRegression/profile/types.ts` | R087 Git 定位，非等价证明；G2 B:698 | — |
| `src/core/strategy/intradayRegression/profile/utils.ts` | `src/strategies/intradayRegression/profile/utils.ts` | R093 Git 定位，非等价证明；G2 B:699 | — |
| `src/core/strategy/intradayRegression/runtime/adx.ts` | `src/strategies/intradayRegression/indicators/adx.ts` | R095 Git 定位，非等价证明；G2 B:700 | — |
| `src/core/strategy/intradayRegression/runtime/ema.ts` | `src/strategies/intradayRegression/indicators/ema.ts` | R098 Git 定位，非等价证明；G2 B:701 | — |
| `src/core/strategy/intradayRegression/runtime/index.ts` | `src/strategies/intradayRegression/indicators/index.ts` | R090 Git 定位，非等价证明；G2 B:702 | — |
| `src/core/strategy/intradayRegression/runtime/kdj.ts` | `src/strategies/intradayRegression/indicators/kdj.ts` | R098 Git 定位，非等价证明；G2 B:703 | — |
| `src/core/strategy/intradayRegression/runtime/macd.ts` | `src/strategies/intradayRegression/indicators/macd.ts` | R097 Git 定位，非等价证明；G2 B:704 | — |
| `src/core/strategy/intradayRegression/runtime/mfi.ts` | `src/strategies/intradayRegression/indicators/mfi.ts` | R094 Git 定位，非等价证明；G2 B:705 | — |
| `src/core/strategy/intradayRegression/runtime/psy.ts` | `src/strategies/intradayRegression/indicators/psy.ts` | R098 Git 定位，非等价证明；G2 B:706 | — |
| `src/core/strategy/intradayRegression/runtime/rsi.ts` | `src/strategies/intradayRegression/indicators/rsi.ts` | R098 Git 定位，非等价证明；G2 B:707 | — |
| `src/core/strategy/intradayRegression/runtime/types.ts` | `src/strategies/intradayRegression/indicators/types.ts` | R098 Git 定位，非等价证明；G2 B:708 | — |
| `src/core/strategy/intradayRegression/runtime/utils.ts` | `src/strategies/intradayRegression/indicators/indicatorMath.ts` | R092 Git 定位，非等价证明；G2 B:709 | — |
| `src/core/strategy/intradayRegression/types.ts` | `src/strategies/intradayRegression/types.ts` | R097 Git 定位，非等价证明；G2 B:710 | — |
| `src/core/strategy/intradayRegression/utils.ts` | `src/strategies/intradayRegression/signalRules.ts` | R097 Git 定位，非等价证明；G2 B:711 | — |
| `src/core/strategy/intradayRegression/verification/index.ts` | `src/strategies/intradayRegression/verification/pendingVerification.ts` | R072 Git 定位，非等价证明；G2 B:712 | — |
| `src/core/strategy/intradayRegression/verification/sampleStore.ts` | `src/strategies/intradayRegression/verification/sampleStore.ts` | R097 Git 定位，非等价证明；G2 B:713 | — |
| `src/core/strategy/intradayRegression/verification/types.ts` | `src/strategies/intradayRegression/verification/types.ts` | R091 Git 定位，非等价证明；G2 B:714 | — |
| `src/core/strategy/intradayRegression/verification/utils.ts` | `src/strategies/intradayRegression/verification/sampleRules.ts` | R097 Git 定位，非等价证明；G2 B:715 | — |
| `src/core/strategy/types.ts` | `src/types/strategy.ts` | R094 Git 定位，非等价证明；G6 B:716 | — |
| `src/core/strategy/utils.ts` | `src/domain/strategy/utils.ts` | R100 Git 定位，非等价证明；G2 B:717 | — |
| `src/core/trader/accountService.ts` | `src/application/accountQuery/index.ts` | R036 Git 定位，非等价证明；G5 B:718 | — |
| `src/core/trader/index.ts` | `src/app/runtime/createTradeRuntime.ts`<br>`src/types/brokerAccessPorts.ts`<br>`src/types/orderExecutionPorts.ts`<br>`src/types/tradeMutationPorts.ts` | 拆分/移除 owner 定位候选，待符号级核查；G0/G6 B:719 | — |
| `src/core/trader/orderCacheManager.ts` | `src/application/orderTracking/orderCacheManager.ts` | R069 Git 定位，非等价证明；G4 B:720 | — |
| `src/core/trader/orderExecutor/buyThrottle.ts` | `src/application/orderExecution/buyThrottle.ts` | R091 Git 定位，非等价证明；G4 B:721 | SO:57 |
| `src/core/trader/orderExecutor/index.ts` | `src/application/orderExecution/index.ts` | R073 Git 定位，非等价证明；G4 B:722 | — |
| `src/core/trader/orderExecutor/quantityResolver.ts` | `src/application/orderExecution/quantityResolver.ts` | R044 Git 定位，非等价证明；G4 B:723 | — |
| `src/core/trader/orderExecutor/submitFlow.ts` | `src/application/orderExecution/submitFlow.ts` | R055 Git 定位，非等价证明；G4 B:724 | — |
| `src/core/trader/orderExecutor/types.ts` | `src/application/orderExecution/types.ts` | R046 Git 定位，非等价证明；G4 B:725 | — |
| `src/core/trader/orderExecutor/utils.ts` | `src/domain/order/executionPolicy.ts`<br>`src/application/orderExecution/submitFailureLogging.ts` | R029 Git 定位，非等价证明；G4 B:726 | SO:58 |
| `src/core/trader/orderHoldRegistry.ts` | `src/application/orderTracking/orderHoldRegistry.ts` | R077 Git 定位，非等价证明；G4 B:727 | — |
| `src/core/trader/orderMonitor/eventFlow.ts` | `src/application/orderTracking/orderMonitor/eventFlow.ts`<br>`src/application/orderTracking/orderMonitor/orderObservation.ts` | R054 Git 定位，非等价证明；G4 B:728 | SO:59；observation仅协议祖先 |
| `src/core/trader/orderMonitor/index.ts` | `src/application/orderTracking/orderMonitor/index.ts` | R059 Git 定位，非等价证明；G4 B:729 | — |
| `src/core/trader/orderMonitor/orderFactMerge.ts` | `src/domain/order/orderFactMerge.ts`<br>`src/domain/order/executionFact.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:730 | — |
| `src/core/trader/orderMonitor/orderOps.ts` | `src/application/orderTracking/orderMonitor/orderOps.ts`<br>`src/application/orderTracking/orderMonitor/orderObservation.ts` | R062 Git 定位，非等价证明；G4 B:731 | SO:59；observation仅协议祖先 |
| `src/core/trader/orderMonitor/orderStatusQuery.ts` | `src/application/orderTracking/orderMonitor/orderStatusQuery.ts` | R040 Git 定位，非等价证明；G4 B:732 | — |
| `src/core/trader/orderMonitor/recoveryFlow.ts` | `src/application/orderTracking/orderMonitor/recoveryFlow.ts` | R074 Git 定位，非等价证明；G4 B:733 | — |
| `src/core/trader/orderMonitor/routeProcessor.ts` | `src/application/orderTracking/orderMonitor/routeProcessor.ts` | R078 Git 定位，非等价证明；G4 B:734 | — |
| `src/core/trader/orderMonitor/routeRuntime.ts` | `src/application/orderTracking/orderMonitor/routeRuntime.ts` | R096 Git 定位，非等价证明；G4 B:735 | — |
| `src/core/trader/orderMonitor/routingIndex.ts` | `src/application/orderTracking/orderMonitor/routingIndex.ts` | R099 Git 定位，非等价证明；G4 B:736 | SO:60 |
| `src/core/trader/orderMonitor/settlementFlow.ts` | `src/application/orderTracking/orderMonitor/settlementFlow.ts`<br>`src/application/orderTracking/orderMonitor/orderObservation.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:737 | SO:59；observation仅协议祖先 |
| `src/core/trader/orderMonitor/types.ts` | `src/application/orderTracking/orderMonitor/types.ts` | R065 Git 定位，非等价证明；G4 B:738 | — |
| `src/core/trader/orderMonitor/utils.ts` | `src/infrastructure/longbridge/trade/orderReadErrorClassification.ts`<br>`src/domain/order/orderTrackingPolicy.ts` | R041 Git 定位，非等价证明；G6 B:739 | SO:66 |
| `src/core/trader/protectiveLiquidationEpisodeTracker/index.ts` | `src/domain/liquidation/episode/index.ts` | R079 Git 定位，非等价证明；G5 B:740 | — |
| `src/core/trader/protectiveLiquidationEpisodeTracker/types.ts` | `src/domain/liquidation/episode/types.ts` | R082 Git 定位，非等价证明；G5 B:741 | — |
| `src/core/trader/rateLimiter.ts` | `src/application/orderExecution/rateLimiter.ts` | R085 Git 定位，非等价证明；G4 B:742 | — |
| `src/core/trader/types.ts` | `src/application/orderTracking/types.ts` | R032 Git 定位，非等价证明；G4 B:743 | — |
| `src/core/trader/utils.ts` | `src/domain/order/orderTypePolicy.ts`<br>`src/domain/order/orderRemark.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:744 | SO:171,SO:65,SO:67 |
| `src/core/utils.ts` | `src/domain/order/quoteReadiness.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:745 | SO:189 |
| `src/index.ts` | `src/index.ts` | 同路径，行为待比较；G0 B:746 | — |
| `src/main/asyncProgram/buyProcessor/index.ts` | `src/runtime/asyncProgram/buyProcessor/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:747 | — |
| `src/main/asyncProgram/buyProcessor/types.ts` | `src/runtime/asyncProgram/buyProcessor/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:748 | — |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts` | `src/application/autoSearch/index.ts`<br>`src/application/seatSwitch/index.ts`<br>`src/runtime/asyncProgram/monitorTaskProcessor/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3/G0 B:749 | — |
| `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts` | `src/application/seatActivation/index.ts` | R029 Git 定位，非等价证明；G3 B:750 | — |
| `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts` | `src/application/riskRefresh/warrantRiskRefresh.ts`<br>`src/application/accountPositionSnapshot/index.ts`<br>`src/application/postTradeSettlement/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:751 | — |
| `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts` | `src/domain/seat/seatIdentity.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:752 | SP:59 |
| `src/main/asyncProgram/monitorTaskProcessor/index.ts` | `src/runtime/asyncProgram/monitorTaskProcessor/index.ts`<br>`src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts` | 拆分/移除 owner 定位候选，待符号级核查；G0 B:753 | — |
| `src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts` | `src/runtime/asyncProgram/monitorTaskProcessor/queueRunner.ts` | R090 Git 定位，非等价证明；G0 B:754 | — |
| `src/main/asyncProgram/monitorTaskProcessor/types.ts` | `src/runtime/asyncProgram/monitorTaskProcessor/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G0 B:755 | — |
| `src/main/asyncProgram/monitorTaskQueue/index.ts` | `src/runtime/asyncProgram/monitorTaskQueue/index.ts` | R068 Git 定位，非等价证明；G0 B:756 | — |
| `src/main/asyncProgram/monitorTaskQueue/types.ts` | `src/runtime/asyncProgram/monitorTaskQueue/types.ts` | R083 Git 定位，非等价证明；G0 B:757 | — |
| `src/main/asyncProgram/sellProcessor/index.ts` | `src/runtime/asyncProgram/sellProcessor/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:758 | — |
| `src/main/asyncProgram/sellProcessor/types.ts` | `src/runtime/asyncProgram/sellProcessor/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4 B:759 | — |
| `src/main/asyncProgram/tradeTaskQueue/index.ts` | `src/runtime/asyncProgram/tradeTaskQueue/index.ts` | R054 Git 定位，非等价证明；G0 B:760 | — |
| `src/main/asyncProgram/tradeTaskQueue/types.ts` | `src/runtime/asyncProgram/tradeTaskQueue/types.ts` | R088 Git 定位，非等价证明；G0 B:761 | — |
| `src/main/asyncProgram/types.ts` | `src/runtime/asyncProgram/types.ts` | R095 Git 定位，非等价证明；G0 B:762 | — |
| `src/main/asyncProgram/utils.ts` | `src/runtime/asyncProgram/processor.ts` | R055 Git 定位，非等价证明；G0 B:763 | — |
| `src/main/autoSearchWakeupRuntime/index.ts` | `src/runtime/autoSearchWakeupRuntime/index.ts` | R084 Git 定位，非等价证明；G3 B:764 | — |
| `src/main/autoSearchWakeupRuntime/types.ts` | `src/runtime/autoSearchWakeupRuntime/types.ts` | R060 Git 定位，非等价证明；G3 B:765 | — |
| `src/main/businessEventProgram/emissionAdapter.ts` | `src/runtime/businessEventProgram/emissionAdapter.ts` | R090 Git 定位，非等价证明；G0 B:766 | — |
| `src/main/businessEventProgram/index.ts` | `src/runtime/businessEventProgram/index.ts` | R093 Git 定位，非等价证明；G0 B:767 | — |
| `src/main/businessEventProgram/types.ts` | `src/runtime/businessEventProgram/types.ts` | R079 Git 定位，非等价证明；G0 B:768 | — |
| `src/main/businessEventProgram/utils.ts` | `src/runtime/businessEventProgram/utils.ts` | R096 Git 定位，非等价证明；G0 B:769 | — |
| `src/main/lifecycle/cacheDomains/globalStateDomain.ts` | `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts` | R034 Git 定位，非等价证明；G1 B:770 | — |
| `src/main/lifecycle/cacheDomains/marketDataDomain.ts` | `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts` | R077 Git 定位，非等价证明；G1 B:771 | — |
| `src/main/lifecycle/cacheDomains/orderDomain.ts` | `src/runtime/lifecycle/cacheDomains/orderDomain.ts` | R071 Git 定位，非等价证明；G1 B:772 | — |
| `src/main/lifecycle/cacheDomains/riskDomain.ts` | `src/runtime/lifecycle/cacheDomains/riskDomain.ts` | R071 Git 定位，非等价证明；G1 B:773 | — |
| `src/main/lifecycle/cacheDomains/seatDomain.ts` | `src/runtime/lifecycle/cacheDomains/seatDomain.ts` | R079 Git 定位，非等价证明；G1 B:774 | — |
| `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` | `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts` | R078 Git 定位，非等价证明；G1 B:775 | — |
| `src/main/lifecycle/cacheDomains/types.ts` | `src/runtime/lifecycle/cacheDomains/types.ts` | R043 Git 定位，非等价证明；G1 B:776 | — |
| `src/main/lifecycle/dayLifecycleManager.ts` | `src/runtime/lifecycle/dayLifecycleManager.ts` | R052 Git 定位，非等价证明；G1 B:777 | — |
| `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | R048 Git 定位，非等价证明；G1 B:778 | — |
| `src/main/lifecycle/rebuildTradingDayState.ts` | `src/application/tradingDayRebuild/rebuildTradingDayState.ts` | R034 Git 定位，非等价证明；G1 B:779 | — |
| `src/main/lifecycle/seatActivationCarryover.ts` | `src/application/tradingDayRebuild/seatActivationCarryover.ts` | R097 Git 定位，非等价证明；G1 B:780 | SP:46 |
| `src/main/lifecycle/startupFailureState.ts` | `src/application/tradingDayRebuild/startupFailureState.ts` | R058 Git 定位，非等价证明；G1 B:781 | — |
| `src/main/lifecycle/tradingCalendarPrewarmer.ts` | `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts` | R087 Git 定位，非等价证明；G1 B:782 | SP:47 |
| `src/main/lifecycle/types.ts` | `src/runtime/lifecycle/types.ts`<br>`src/application/tradingDayRebuild/types.ts`<br>`src/types/lifecycle.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1/G6 B:783 | — |
| `src/main/lifecycle/utils.ts` | `src/utils/time/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1 B:784 | SP:57,SP:58,SP:47 |
| `src/main/monitorDisplayRuntime/index.ts` | `src/runtime/monitorDisplayRuntime/index.ts` | R090 Git 定位，非等价证明；G2 B:785 | — |
| `src/main/monitorDisplayRuntime/types.ts` | `src/runtime/monitorDisplayRuntime/types.ts` | R059 Git 定位，非等价证明；G2 B:786 | — |
| `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` | `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` | R073 Git 定位，非等价证明；G2 B:787 | — |
| `src/main/monitorQuoteEventRuntime/setUtils.ts` | `src/runtime/monitorQuoteEventRuntime/setUtils.ts` | R100 Git 定位，非等价证明；G2 B:788 | — |
| `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts` | `src/application/staticLiquidation/index.ts` | R048 Git 定位，非等价证明；G5 B:789 | — |
| `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` | `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts` | R082 Git 定位，非等价证明；G2 B:790 | — |
| `src/main/monitorQuoteEventRuntime/types.ts` | `src/runtime/monitorQuoteEventRuntime/types.ts` | R064 Git 定位，非等价证明；G2 B:791 | — |
| `src/main/ordinarySignalGuard/index.ts` | `src/domain/strategy/ordinarySignalGuard.ts` | R050 Git 定位，非等价证明；G2 B:792 | — |
| `src/main/periodicSwitchWakeupRuntime/index.ts` | `src/runtime/periodicSwitchWakeupRuntime/index.ts` | R043 Git 定位，非等价证明；G3 B:793 | — |
| `src/main/periodicSwitchWakeupRuntime/types.ts` | `src/runtime/periodicSwitchWakeupRuntime/types.ts` | R056 Git 定位，非等价证明；G3 B:794 | — |
| `src/main/quoteSubscriptionRuntime/index.ts` | `src/runtime/quoteSubscriptionRuntime/index.ts` | R054 Git 定位，非等价证明；G2 B:795 | — |
| `src/main/quoteSubscriptionRuntime/types.ts` | `src/runtime/quoteSubscriptionRuntime/types.ts` | R065 Git 定位，非等价证明；G2 B:796 | — |
| `src/main/recovery/seatPreparation.ts` | `src/application/tradingDayRebuild/seatPreparation.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1 B:797 | — |
| `src/main/recovery/types.ts` | `src/application/tradingDayRebuild/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G1 B:798 | — |
| `src/main/seatActivationDispatcher/index.ts` | `src/runtime/seatActivationDispatcher/index.ts` | R098 Git 定位，非等价证明；G3 B:799 | — |
| `src/main/seatActivationDispatcher/types.ts` | `src/runtime/seatActivationDispatcher/types.ts` | R089 Git 定位，非等价证明；G3 B:800 | — |
| `src/main/seatRuntimeCleanupDispatcher/index.ts` | `src/runtime/seatRuntimeCleanupDispatcher/index.ts` | R082 Git 定位，非等价证明；G3 B:801 | — |
| `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` | `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts` | R100 Git 定位，非等价证明；G3 B:802 | — |
| `src/main/seatRuntimeCleanupDispatcher/types.ts` | `src/runtime/seatRuntimeCleanupDispatcher/types.ts` | R082 Git 定位，非等价证明；G3 B:803 | — |
| `src/main/timeWakeupEvaluationProgram/index.ts` | `src/runtime/timeWakeupEvaluationProgram/index.ts` | R061 Git 定位，非等价证明；G1 B:804 | — |
| `src/main/timeWakeupEvaluationProgram/types.ts` | `src/runtime/timeWakeupEvaluationProgram/types.ts` | R032 Git 定位，非等价证明；G1 B:805 | — |
| `src/main/timeWakeupPlanner/index.ts` | `src/runtime/timeWakeupPlanner/index.ts` | R100 Git 定位，非等价证明；G1 B:806 | SP:49 |
| `src/main/timeWakeupPlanner/types.ts` | `src/runtime/timeWakeupPlanner/types.ts` | R100 Git 定位，非等价证明；G1 B:807 | — |
| `src/main/timeWakeupRuntime/index.ts` | `src/runtime/timeWakeupRuntime/index.ts` | R094 Git 定位，非等价证明；G1 B:808 | — |
| `src/main/timeWakeupRuntime/types.ts` | `src/runtime/timeWakeupRuntime/types.ts` | R069 Git 定位，非等价证明；G1 B:809 | — |
| `src/main/tradingGateEventRuntime/index.ts` | `src/runtime/tradingGateEventRuntime/index.ts` | R094 Git 定位，非等价证明；G1 B:810 | — |
| `src/main/tradingGateEventRuntime/types.ts` | `src/runtime/tradingGateEventRuntime/types.ts` | R036 Git 定位，非等价证明；G1 B:811 | — |
| `src/main/tradingQuoteDisplayRuntime/index.ts` | `src/runtime/tradingQuoteDisplayRuntime/index.ts` | R092 Git 定位，非等价证明；G2 B:812 | — |
| `src/main/tradingQuoteDisplayRuntime/types.ts` | `src/runtime/tradingQuoteDisplayRuntime/types.ts` | R061 Git 定位，非等价证明；G2 B:813 | — |
| `src/main/tradingRiskEventRuntime/routeValidation.ts` | `src/runtime/tradingRiskEventRuntime/routeValidation.ts` | R083 Git 定位，非等价证明；G5 B:814 | — |
| `src/main/tradingRiskEventRuntime/routingIndex.ts` | `src/runtime/tradingRiskEventRuntime/routingIndex.ts` | R081 Git 定位，非等价证明；G5 B:815 | — |
| `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` | `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` | R029 Git 定位，非等价证明；G5 B:816 | — |
| `src/main/tradingRiskEventRuntime/types.ts` | `src/runtime/tradingRiskEventRuntime/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:817 | — |
| `src/main/tradingRiskEventRuntime/unrealizedLossExecutor.ts` | `src/application/protectiveLiquidation/unrealizedLossExecutor.ts`<br>`src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:818 | — |
| `src/main/utils.ts` | `src/application/tradingDayRebuild/quoteSymbols.ts` | R065 Git 定位，非等价证明；G1 B:819 | SP:45 |
| `src/services/accountDisplay/index.ts` | `src/infrastructure/display/accountDisplay/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:820 | — |
| `src/services/accountDisplay/types.ts` | `src/types/account.ts`<br>`src/types/accountPosition.ts`<br>`src/types/display.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:821 | — |
| `src/services/autoSymbolFinder/index.ts` | `src/application/autoSearch/candidateSearch.ts` | R040 Git 定位，非等价证明；G3 B:822 | — |
| `src/services/autoSymbolFinder/policyResolver.ts` | `src/domain/seat/seatPolicy.ts`<br>`src/domain/seat/warrantSelection/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:823 | — |
| `src/services/autoSymbolFinder/types.ts` | `src/application/autoSearch/types.ts`<br>`src/domain/seat/warrantSelection/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:824 | — |
| `src/services/autoSymbolFinder/utils.ts` | `src/domain/seat/warrantSelection/index.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:825 | — |
| `src/services/autoSymbolManager/autoSearch.ts` | `src/application/autoSearch/index.ts` | R057 Git 定位，非等价证明；G3 B:826 | — |
| `src/services/autoSymbolManager/index.ts` | `src/application/seatSwitch/index.ts` | R038 Git 定位，非等价证明；G3 B:827 | — |
| `src/services/autoSymbolManager/seatStateManager.ts` | `src/application/seatSwitch/seatStateManager.ts` | R078 Git 定位，非等价证明；G3 B:828 | — |
| `src/services/autoSymbolManager/signalBuilder.ts` | `src/application/seatSwitch/signalBuilder.ts`<br>`src/domain/seat/switchPolicy.ts` | R062 Git 定位，非等价证明；G3 B:829 | SP:50 |
| `src/services/autoSymbolManager/switchStateMachine.ts` | `src/application/seatSwitch/switchStateMachine.ts` | R064 Git 定位，非等价证明；G3 B:830 | — |
| `src/services/autoSymbolManager/thresholdResolver.ts` | `src/domain/seat/switchPolicy.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:831 | — |
| `src/services/autoSymbolManager/types.ts` | `src/application/seatSwitch/types.ts` | R039 Git 定位，非等价证明；G3 B:832 | — |
| `src/services/autoSymbolManager/utils.ts` | `src/domain/seat/symbolRegistry.ts` | R059 Git 定位，非等价证明；G3 B:833 | — |
| `src/services/liquidationCooldown/index.ts` | `src/domain/liquidation/cooldown/index.ts` | R086 Git 定位，非等价证明；G5 B:834 | — |
| `src/services/liquidationCooldown/tradeLogHydrator.ts` | `src/application/protectiveLiquidation/tradeLogHydrator.ts` | R079 Git 定位，非等价证明；G5 B:835 | — |
| `src/services/liquidationCooldown/types.ts` | `src/domain/liquidation/cooldown/types.ts`<br>`src/application/protectiveLiquidation/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:836 | — |
| `src/services/liquidationCooldown/utils.ts` | `src/domain/liquidation/cooldown/rules.ts` | R093 Git 定位，非等价证明；G5 B:837 | — |
| `src/services/marketMonitor/index.ts` | `src/infrastructure/display/marketMonitor/index.ts` | R076 Git 定位，非等价证明；G6 B:838 | — |
| `src/services/marketMonitor/priceDisplayInfo.ts` | `src/infrastructure/display/marketMonitor/priceDisplayInfo.ts` | R075 Git 定位，非等价证明；G6 B:839 | — |
| `src/services/marketMonitor/types.ts` | `src/types/display.ts` | R050 Git 定位，非等价证明；G6 B:840 | — |
| `src/services/marketMonitor/utils.ts` | `src/infrastructure/display/marketMonitor/utils.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:841 | — |
| `src/services/mixedTradeLogRepository/index.ts` | `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | R098 Git 定位，非等价证明；G6 B:842 | SP:53 |
| `src/services/mixedTradeLogRepository/types.ts` | `src/types/tradeLog.ts` | R040 Git 定位，非等价证明；G6 B:843 | — |
| `src/services/quoteClient/candlestickCache.ts` | `src/infrastructure/longbridge/market/candlestickCache.ts` | R068 Git 定位，非等价证明；G6 B:844 | — |
| `src/services/quoteClient/index.ts` | `src/infrastructure/longbridge/market/quoteClient.ts` | R084 Git 定位，非等价证明；G6 B:845 | — |
| `src/services/quoteClient/types.ts` | `src/infrastructure/longbridge/market/types.ts` | R091 Git 定位，非等价证明；G6 B:846 | — |
| `src/services/quoteClient/utils.ts` | `src/infrastructure/longbridge/market/marketMetadataMapper.ts` | R064 Git 定位，非等价证明；G6 B:847 | — |
| `src/types/account.ts` | `src/types/account.ts` | 同路径，行为待比较；G6 B:848 | — |
| `src/types/config.ts` | `src/types/config.ts` | 同路径，行为待比较；G6 B:849 | — |
| `src/types/data.ts` | `src/types/data.ts` | 同路径，行为待比较；G6 B:850 | — |
| `src/types/monitorContextPorts.ts` | `src/types/seatSwitch.ts` | R056 Git 定位，非等价证明；G6 B:851 | — |
| `src/types/orderRecorder.ts` | `src/types/orderRecorder.ts` | 同路径，行为待比较；G6 B:852 | — |
| `src/types/quote.ts` | `src/types/quote.ts` | 同路径，行为待比较；G6 B:853 | — |
| `src/types/risk.ts` | `src/types/risk.ts` | 同路径，行为待比较；G6 B:854 | — |
| `src/types/runtime.ts` | `src/types/runtime.ts` | 同路径，行为待比较；G6 B:855 | — |
| `src/types/seat.ts` | `src/types/seat.ts` | 同路径，行为待比较；G6 B:856 | — |
| `src/types/services.ts` | `src/types/display.ts`<br>`src/types/marketPorts.ts`<br>`src/types/orderExecutionPorts.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:857 | — |
| `src/types/signal.ts` | `src/types/signal.ts` | 同路径，行为待比较；G6 B:858 | — |
| `src/types/state.ts` | `src/types/runtime.ts`<br>`src/types/tradingCalendar.ts`<br>`src/types/accountPosition.ts`<br>`src/application/accountPositionSnapshot/types.ts`<br>`src/domain/seat/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6/G5/G3 B:859 | — |
| `src/types/trader.ts` | `src/types/orderCancellation.ts` | R031 Git 定位，非等价证明；G6 B:860 | — |
| `src/types/tradingCalendar.ts` | `src/types/tradingCalendar.ts` | 同路径，行为待比较；G6 B:861 | — |
| `src/utils/accountPositions/index.ts` | `src/application/ordinaryBuy/accountPositionsRead.ts` | R082 Git 定位，非等价证明；G4 B:862 | — |
| `src/utils/accountPositions/types.ts` | `src/application/ordinaryBuy/types.ts`<br>`src/types/accountPosition.ts` | 拆分/移除 owner 定位候选，待符号级核查；G4/G6 B:863 | — |
| `src/utils/apiFailure/index.ts` | `src/utils/apiFailure/index.ts` | 同路径，行为待比较；G6 B:864 | — |
| `src/utils/apiFailure/types.ts` | `src/types/apiFailure.ts` | R054 Git 定位，非等价证明；G6 B:865 | — |
| `src/utils/display/index.ts` | `src/utils/display/index.ts` | 同路径，行为待比较；G6 B:866 | — |
| `src/utils/error/index.ts` | `src/utils/error/index.ts` | 同路径，行为待比较；G6 B:867 | — |
| `src/utils/helpers/index.ts` | `src/utils/helpers/index.ts` | 同路径，行为待比较；G6 B:868 | — |
| `src/utils/helpers/types.ts` | `src/types/data.ts`<br>`src/types/seat.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:869 | — |
| `src/utils/logger/index.ts` | `src/infrastructure/logger/index.ts` | R098 Git 定位，非等价证明；G6 B:870 | SP:52 |
| `src/utils/logger/types.ts` | `src/infrastructure/logger/types.ts` | R050 Git 定位，非等价证明；G6 B:871 | — |
| `src/utils/numeric/index.ts` | `src/utils/numeric/index.ts`<br>`src/domain/order/orderQuantity.ts` | 同路径，行为待比较；G6 B:872 | SO:64 |
| `src/utils/numeric/types.ts` | `src/utils/numeric/types.ts` | 同路径，行为待比较；G6 B:873 | — |
| `src/utils/positionCache/index.ts` | `src/application/accountPositionSnapshot/index.ts`<br>`src/types/accountPosition.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5/G6 B:874 | — |
| `src/utils/quoteRetry/index.ts` | `src/application/quoteRetry.ts` | R034 Git 定位，非等价证明；G2 B:875 | — |
| `src/utils/quoteRetry/types.ts` | `src/application/types.ts` | 拆分/移除 owner 定位候选，待符号级核查；G0 B:876 | — |
| `src/utils/refreshGate/index.ts` | `src/application/postTradeSettlement/readinessGate.ts` | 拆分/移除 owner 定位候选，待符号级核查；G5 B:877 | — |
| `src/utils/runtime/index.ts` | `src/config/runtime/index.ts` | R091 Git 定位，非等价证明；G6 B:878 | — |
| `src/utils/seat/guards.ts` | `src/domain/seat/seatPolicy.ts`<br>`src/domain/seat/seatIdentity.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:879 | — |
| `src/utils/seat/snapshots.ts` | `src/domain/seat/seatSnapshot.ts` | R084 Git 定位，非等价证明；G3 B:880 | SP:51 |
| `src/utils/seat/symbols.ts` | `src/domain/seat/seatIdentity.ts`<br>`src/domain/seat/symbolRegistry.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3 B:881 | — |
| `src/utils/seat/types.ts` | `src/domain/seat/types.ts`<br>`src/types/seat.ts` | 拆分/移除 owner 定位候选，待符号级核查；G3/G6 B:882 | — |
| `src/utils/time/index.ts` | `src/utils/time/index.ts`<br>`src/domain/tradingSession/index.ts` | 同路径，行为待比较；G6 B:883 | SP:48 |
| `src/utils/time/types.ts` | `src/utils/time/types.ts` | 同路径，行为待比较；G6 B:884 | — |
| `src/utils/timer/index.ts` | `src/runtime/timer/index.ts` | R092 Git 定位，非等价证明；G6 B:885 | — |
| `src/utils/timer/types.ts` | `src/types/timer.ts` | R079 Git 定位，非等价证明；G6 B:886 | — |
| `src/utils/trading/orderStatus.ts` | `src/domain/order/cancelOutcomePolicy.ts` | R087 Git 定位，非等价证明；G4 B:887 | SO:62 |
| `src/utils/trading/tradeLogPath.ts` | `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts` | R076 Git 定位，非等价证明；G6 B:888 | — |
| `src/utils/types.ts` | `src/utils/time/types.ts`<br>`src/utils/numeric/types.ts`<br>`src/types/rateLimit.ts` | 拆分/移除 owner 定位候选，待符号级核查；G6 B:889 | — |

## positive findings

- 368current/263旧路径集合、唯一主审和原等级均可回查；SP9+SO13恰好闭合原22缺口，没有用依赖/类型/测试凑245D。
- 新来源修订同步到正向祖先和逆向迁移边，原错误候选留存，不静默覆盖历史；独立阅读区段与全文D区别保留。
- 真实直接runtime消费者均D，同时保留设施归属和纯类型中间边，不派生无业务价值的类型重审。

## not assessed

- **245D不是全仓合格证**：逐行/逐状态/全部并发时序穷举、形式化或全输入等价、动态/外部消费、真实SDK/市场事实、实盘概率/损失、完整V1逐条对账、磁盘断电/崩溃保证、生产发布/回退未因本账本完成。
- 122类型的全部字段/联合状态/消费者语义和1JSON全部配置组合/策略后果仍非穷尽证明。设施类型没有G0–G5直接消费不是缺陷。
- 补证原not-assessed边界继续有效：observer lifecycle对象身份与available异步guard交错、精度/严格校验全边界、signal origin既有政策裁决、execution/revision跨层恢复、持久化故障矩阵等不由目标模块D一并批准。
- 本账本只吸收独立二审明确阅读范围，不重裁finding、授权、确认/待复核或修复状态。两份补充无新候选不撤销既有候选，不表示实际差分获授权。
- 本次未读取生产源码、未重扫AST/import、未新增或执行测试/probe；旧测试执行结果保持原阶段，不转记本次验证。

## recommended next actions

1. 可将245/245运行码D、缺口0用于阅读覆盖汇总；与缺陷修复/授权/独立二审/门禁状态分栏，不称全仓等价或可发布。
2. 依真实风险保留未评估边界；不要为设施类型缺少业务组直接消费而机械重复审查，也不要为覆盖数字重复跑测试。
3. 此结论仅对固定SHA有效；后续源码/基线变动应先标记过期，再按实际差分更新。

## 机器交付核验

- `files`和Markdown逐文件表均368项且唯一；`developMigrationIndex`和Markdown旧索引均263项且唯一；与固定两Git树集合相等，missing/extra均0。
- `runtimeFilesWithDeepReadEvidence=245`、`runtimeFilesLackingDeepReadEvidence=0`、`runtimeDeepReviewGapPaths=[]`；类型122和JSON1单列。
- 原primary reviewer/grade/evidence与旧结构/直接导入边的前后hash保持一致；SP/SO来源hash、9/13逐项范围、SO797行以及旧22项完整闭合均有JSON记录。
- 本次源码读取0、AST扫描0、新测试0、仓库写入0；仅更新TEMP指定两个交付文件。
