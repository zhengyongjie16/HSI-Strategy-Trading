# 架构重构全链路业务等价性审计

## summary

**原审计结论（受审版本 `2b67d36`）：B01 已由用户明确授权，不作为问题或验收阻塞；其余 F01–F08 仍需处理，该受审版本尚不能通过本次审计验收。** F03 工作区实施与离线验证见[本轮补记](#f03-implementation-verification)，不代表 F05 或全报告各项已修。

经分领域首审和另一子代理独立二次复核，确认 **8 项实现／失败协议问题：1 项 critical、7 项 major**。**B01（末日保留旧 SELL、仅新增 available）已由用户明确确认为授权业务改动，不计入问题、严重性统计或验收阻塞，仅保留行为变更记录。**此外，4 类有改进依据或方案明示的行为变化单独登记，不混作已证实的新算法缺陷。

最严重的问题不是目录或抽象层数，而是：在线订单经济投影丢失剩余买单；事实来源信息被修订覆盖后写出无法再次恢复的保护完成记录；局部、明确的外部失败或普通重复消息被升级为全局退出；换标预算缩小；恢复门禁与唤醒事件没有同步闭合。

- **行为基线**：最新远端 `develop`，`6e239c8a128372bd9b2fb2d79464346792a5e81e`。本次执行 `git fetch origin develop` 成功，`develop = origin/develop = FETCH_HEAD`。
- **受审版本**：`beta-V2`，`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。
- **重点历史提交**：`d2aa59054abac546f506b27df45f161afcfc6578`、上述 `2b67d36`。
- **规格依据**：`docs/architecture/architecture-refactoring-implementation-plan.md`；只针对授权、历史条款交叉检查其直接引用的设计文档，没有扩大到无关文档。
- **执行方式**：10 个通用子代理会话，显式配置均为 `cliproxyapi/gpt-6.1-sol / thinking=max`，已通过本地进程／会话配置核实；不声称验证了服务端隐藏路由。主代理只协调和汇总，不承担源码结论的首审或二审。
- **置信度**：下列具名反例及根因 high；任意外部时序、所有状态组合和生产发布安全的穷尽结论未建立。没有实盘事故或真实损失的断言。
- **原审计只读边界**：未修改生产源码、测试、配置或原方案，未切换分支、reset、merge，未连接实盘。本文件为新增审计文档。多数探针／验证在 TEMP 隔离目录运行；一组定向测试的默认 preload 更新了被忽略的 `tests/logs`，不能声称文件系统完全无副作用，未擅自清理这些日志。

### 总表与去重

| 最终编号 | 原调查编号 | 等级 | 已确认问题 | 独立二审 |
|---|---|---|---|---|
| F01 | OE-001 | **critical** | 在线 SELL 投影遗漏同毫秒剩余 BUY，浮亏保护与智能平仓结果错误 | validation |
| F02 | G5-RA01 | major | 无新增成交的修订覆盖历史来源，保护 completion 写出后自身恢复拒绝 | seat-selection |
| F03 | OE-002 | major | 正成交终态首次缺价额被 known 掩盖；closed 同证据迟到 OPEN 误触发阶段回退 fatal | validation |
| F04 | OE-005 | major | cancel／replace 一般外部拒绝被扩为 UNKNOWN fatal | market-strategy |
| F05 | INF-C1、INF-C2、G3-C3 | major | 完整事实校验先于观察择优和消费范围选择，扩大启动／激活／推送失败范围 | recheck-ingress |
| F06 | G3-C1 | major | 距离换标缩减合法普通卖单对应回补预算，同卖出200却回补200→80 | recheck-switch |
| F07 | G3-C2，含 V-C6 的有效子场景 | major | 本次尚未接受卖单，明确拒绝／旧单释放／缺行情耗尽仍被一次性结案并全局 fatal | recheck-switch |
| F08 | LC-01 | major | 同连续时段重建恢复后，已到期周期换标缺少恢复唤醒 | infra-config |

F05 的三个主子场景及同根旁支只计一个根因；V-C6 不另计；V-C1、V-C5 不混入上述8项实现缺陷。B01／V-C4／OE-003 为同一已授权业务变更，不属于问题清单。测试缺口并入对应根因，不重复凑数。

## critical issues

### F01｜在线 SELL 复用历史时间分区，遗漏同毫秒尚未卖出的 BUY

**当前位置**：

- `src/application/orderTracking/recorder/index.ts:48-116`。
- `src/domain/order/executionProjection.ts:163-205`。
- `src/domain/order/orderFilteringEngine.ts:62-70,94-105,126-129`。
- 消费者：`src/domain/risk/unrealizedLossChecker.ts:18-35,65-83`，`src/application/ordinarySell/quantitySelection.ts:137-182,242-248`。

**旧版依据**：`develop:src/core/trader/orderMonitor/settlementFlow.ts:636-658` → `src/core/orderRecorder/index.ts:263-283` → `src/core/orderRecorder/orderStorage.ts:168-228`。在线卖出按已有 BUY 列表、明确关联或低价优先整笔扣减，不用买卖时间严格不等式删除其他已入账 BUY。

**根因**：当前每次在线经济事实变化均重新运行历史过滤。历史规则的 `BUY.time < SELL.time` 和 `BUY.time > SELL.time` 都不覆盖等时 BUY。关联 ID 也只能作用于进入时间区间的记录，救不回已被分区遗漏的 BUY。

**真实可运行反例**：B1 买100股@1，时间 T−100ms；B2 买100股@2，时间 T；通过正式选单选择B1，并登记 pending SELL关联；随后S卖100股@1.5，时间T。三个时间均来自合法 broker `updatedAt`，不需要伪造跨时钟关系。两版真实 Monitor、recorder、Daily、风险和智能平仓参与差分。

| 结果 | develop | 当前 |
|---|---|---|
| SELL后剩余BUY | B2，100股，成本200 | 空列表 |
| 实际Daily offset | -150 | -150 |
| 风险R1／N1 | 350／100 | 150／0 |
| 现价1、浮亏阈值50 | 触发保护清仓 | 不触发，N1=0提前返回 |
| available100、现价3、智能平仓 | 卖100 | HOLD |

**影响**：已确认本地经济账与实际消费结果错误；实盘剩余持仓的保护和智能平仓可能失效。不是 broker 持仓被删除，也不是已经发生资金损失。

**重要反证**：旧历史批量重建本来存在严格时间分区，两版历史等时输入都可能得到空列表；回归是把该规则扩散到原在线路径。SELL改为T+1ms时两版均保留B2。不能写成“重构新加了所有严格时间判断”，也不能说缺成本后R1必为0。

**最小修复方向**：在唯一经济投影 owner 保留在线准入／实际消费次序或等价身份范围，确保卖出只消耗应消耗的BUY。不能在风险层补假数量，不能简单全局把 `<` 改成 `<=`，不能引入第二本BUY账。

**回归验证**：真实Monitor下有／无pending关联、全部等时、SELL晚1ms、重复终态、累计SELL增量、历史批量恢复分别验证；同时断言剩余BUY、成本、Daily offset、R1/N1与智能平仓输出。现有覆盖严格递增时间的测试不能防止此反例。

**维度**：实现、需求／方案、测试、注释。**二审**：`audit-recheck-order-facts.md`；6项独立差分测试中包含本项及F03。

## major issues

### F02｜同量修订覆盖历史来源，写出自身无法恢复的保护完成记录

**当前位置**：`src/domain/risk/dailyLossTracker.ts:300-317,350-370,412-464`，关键为 `:457` 的 `...incoming`；冻结 `:1057-1077`，恢复 `:1139-1157`。

**旧版依据**：`develop:src/core/riskController/dailyLossTracker.ts:453-476,517-545` 的无新增成交修订用 `...current`，保留 `historyCompleteFromZero=false` 和可信 `submittedAtMs`。

**根因**：API快照是折叠历史，来源为false且有提交时间；在线累计观察默认来源true、提交时间null。当前经济merge合法接受同量revision／金额／phase修订后，连Daily专属来源字段也统一采用incoming。收到一次无新增成交的观察并没有补回从零历史。

**独立完整链路**：真实保护SELL部分成交写progress → 进程重启，真实loader恢复折叠BUY和进行中episode → BUY同量revision更新 → 保护SELL同量取消，保留原执行时间 → 真实执行器提交普通SELL平掉剩余仓位 → canonical flat → settlement从真实episode推导较早boundary → 实际JSONL completion落盘 → 新实例再次loader恢复。

- 无BUY修订控制组：证据不足，在写completion前拒绝。
- 有BUY修订实验组：来源被错误升级，写出的completion只有保护SELL、缺BUY baseline；下一新实例读同一JSONL和最终订单，抛 `cannot reconstruct protection boundary baseline: orderId=BUY`。
- boundary由真实保护成交进度推导，不是fixture手工指定完成时间；普通SELL后flat不意味着保护boundary必须等于当前时间。

**影响**：确认不充分证据可被提交为完成边界，并形成自身重启拒绝的durable数据；可能影响风险分段／冷却及后续恢复。未量化实际损失。

**最小修复方向**：在Daily共享合并结果投影处保留既有来源证据，尤其 `executionAdvanced=false` 时不覆盖完整性和可信提交时间。继续接受合法revision，继续保留严格freeze／restore校验；不要伪造0基线、挪boundary为now或删日志使恢复通过。

**回归验证**：API false → duplicate／revision-only／amount／OPEN→TERMINAL；重复保持幂等，合法修订不升级来源。增加真实progress→loader→平余仓→completion→全新loader闭环，要求任何成功写出的completion可被相同最终事实恢复。

**限定**：完全重复观察不会触发；数量真正增长时旧版已有incoming来源问题，不算本次新增。**二审**：`audit-recheck-risk-boundary.md`，4类观察×2版本共8组执行，另4组当前真实链路，真实隔离JSONL写读。**维度**：实现、类型／来源契约、测试、需求。

### F03｜正成交终态首次准入失守，closed 同证据迟到 OPEN 误触发阶段回退

**直接链路（原受审版本 `2b67d36`，行号随修复变动）**：`src/infrastructure/longbridge/trade/orderMapper.ts` → `src/domain/order/orderFactMerge.ts` → `src/application/orderTracking/orderMonitor/eventFlow.ts`；共享裁决 `src/domain/order/executionFact.ts`；fatal出口 `orderMonitor/index.ts`。

**最新复核准则（本轮实施与验证见[补记](#f03-implementation-verification)）**：本次原始量价／金额证据不完整的正成交终态，必须在**第一次**准入时 fatal；不能凭同量或 known 完整继承旧价／旧额。金额可以合法修订，数量相同不足以证明本次经济事实未变。closed 的严格事实校验不是此类异常的根因，不得放宽它来容忍第二次消息。

**旧版依据及边界**：`develop:src/core/trader/orderMonitor/eventFlow.ts:94-105` 无tracked直接返回，可说明closed旧观察的历史收口，但不能授权正成交终态缺价额时沿用known。

**原受审版本的根因分为两个子场景**：

1. mapper允许普通正成交终态把原始零价转为缺价；domain的普通同量终态旁路再用known价格、金额完成结算，首次异常被掩盖。closed重复才因完整性校验fatal，错误被推迟到第二次。
2. 新增“已无tracking但recorder仍有事实”的合法修订入口后，真实settle/detach后的同revision迟到OPEN进入共享阶段回退校验；没有在closed入站窄范围丢弃证据完整且与已接受终态身份、revision、数量、金额均相同的观察。

**历史独立复现（保留证据，旧验收前提已被替代）**：

1. 普通BUY PartialFilled100@1 → 同量Filled原始价0（mapper映为缺价）→ 再次完全相同Filled。受审版本第一次tracked借known关闭资源，第二次closed fatal；**第一次成功结算本身即违反最新准则**，不能把“第二次不fatal”作为此输入的修复目标。
2. 普通SELL部分成交后Canceled并真实settle/detach，再收到同revision PartialFilled，触发 `TERMINAL -> OPEN` fatal。允许丢弃的范围以以下完整同证据条件为准，不能仅凭同revision放行。
3. 完整的更旧revision OPEN被忽略；尚由timeout owner保留tracked的终态收到同revision OPEN，两版均不fatal。这是历史控制，不授权异常正成交终态沿用known；合法更高revision金额修订仍须保留，不能一律丢弃closed事件。

**影响**：首条异常正成交终态被旧事实掩盖并完成结算，错误直到重复观察才暴露；另一个子场景则将合法同证据迟到OPEN升级为全局退出。未证实重复成交或重复扣减；其他订单的跟进／保护停止是潜在后果。

**F03 修复准则（本轮已实施，验证见补记）**：

- **异常正成交终态首次fatal**：mapper与domain都必须拒绝本次原始数量、价格或金额缺失／零／无效的正成交终态，保留有效revision／时间要求；普通BUY／SELL与保护SELL均不得借known价额完成结算。不得重试、补查、等待第二次消息或在closed兜底。真实零成交的非Filled终态仍正常关闭，不能把Filled伪作零成交。
- **closed只窄范围丢弃迟到OPEN**：仅在已无tracking、已有TERMINAL事实，且入站证据完整、broker身份（orderId／symbol／side及归属）匹配、同revision、同累计数量、同累计金额时丢弃；不重开资源、不发布经济变化、不重复settle。共享事实owner的阶段回退拒绝保持，不能把此入口过滤扩为一般 `TERMINAL -> OPEN` 放行。
- 保留完整旧revision非增量的既有stale处理与合法同量金额修订；缺证据不能借“旧revision／同量”绕过首次校验。

**回归验收准则（本轮离线结果见[补记](#f03-implementation-verification)）**：真实mapper→Monitor的第一条缺失／零／无效价额正成交终态即fatal，结算前无副作用；domain直接调用及state-check也不能沿用known。另须真实settle/detach验证完整同证据迟到OPEN被丢弃，并与仍tracked的timeout控制组分开；身份冲突仍拒绝，除完整旧revision非增量的stale外，未满足窄丢弃条件的阶段回退仍拒绝。覆盖普通BUY／SELL、保护SELL、真实零成交非Filled、完整旧revision非增量和合法closed金额修订，断言无重复terminal、hold释放或经济消费。

**二审**：`audit-recheck-order-facts.md` 为历史证据，不能用其原有通过结果证明最新首次 fatal 准则；本轮全链路二审及原两位 reviewer 的独立复验均已完成，F03 无剩余代码发现，离线结果与边界见[补记](#f03-implementation-verification)。**维度**：实现、类型（经济phase≠tracking生命周期）、测试、需求。

<a id="f03-implementation-verification"></a>

#### 本轮实施与验证补记（仅 F03）

基线 HEAD：`353b621f46120dc20bf7aec57949c3f73234a83f`；以下为其工作区修复的离线证据，不改写 `2b67d36` 原审计结论，也不代表 F05 或全报告各项已修。

- **实施**：已删除 mapper 正量终态缺价豁免，以及 domain 缺证据时借 known 补价收口；统一本次原始数量、价格、金额及有效 revision 准入，先于 stale／known／已终态过滤及任何资源／经济／durable 副作用。`Filled + Q=0` 矛盾终态也已由 mapper、domain 两处 guard 首次拒绝，不会先落终态再以 `handled:false` 忽略后续有效成交；真实零成交的非 Filled（如 `Canceled／Rejected`）继续合法。
- **边界**：closed 仅忽略已无 tracking、已有 TERMINAL 事实，且本次证据完整、完整 identity（orderId／symbol／side／归属）匹配、同 revision、同累计数量及金额的迟到 OPEN 重放；其他坏证据首次拒绝，全局 phase guard 不变。完整旧 revision 非增量、合法同量金额修订及 `T=null` 时本次有效 revision 代理模型均保留。
- **全链路二审闭环**：发现并最小修复 Monitor 公共 operation 等待 fanout 等其他 I/O 后才 fatal、seatActivation 等待 `finally release` 后才 fatal 的时序问题；两者均复用现成 termination，先关闭双 gate 再排空，首错不变，外部 API 失败政策不变。原两位 reviewer 已独立复验全部关闭，F03 无剩余代码发现。
- **最终全仓离线总览**：`bun --no-env-file test --preload ./tests/setup/testRuntime.ts`，启用 `OfflineSdkGuard`，使用临时 `APP_LOG_ROOT_DIR`；**320 files／3420 tests：3418 pass／2 fail，22767 assertions，330.48s**。这是本轮最终全仓结果，**不是全绿**。
- **两项失败归因**：均在干净 HEAD `353b621f46120dc20bf7aec57949c3f73234a83f` 的临时快照中重现；852 个归档文件已逐 blob 核对，环境同为 Windows／Bun 1.3.14，非 F03 新增。`tests/config/runtime/runtime.business.test.ts` 硬编码默认日志根，与显式 `APP_LOG_ROOT_DIR` 冲突；去掉该环境变量的控制通过。`tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts:393` 的非法 UTF-8 确实被拒绝，但实际 `Invalid byte sequence` 不匹配测试 regex。未修改这些无关测试。
- **检查与专项**：`lint:fix`、非修改 `lint`、`type-check`、`git diff --check` 均通过。真实 `rateLimiter` + `termination` 专项 **4 cases** 确认 detail 异常不产生第二次 SDK I/O，dirty pass 2 不等于第二次请求。
- **较早定向批次（历史，不累计）**：实施验证 **52 files／609 pass／0 fail**；独立高价值 **10 files／117 pass／0 fail**；独立邻接 **36 files／357 pass／0 fail**。批次有重叠，不相加、不替代最终全仓总览；邻接发现的 recorder 旧 fixture 契约不符已最小修正并独立复验，未跳过。
- **未覆盖**：未连接真实券商，未做“坏 callback → 实际 OS 进程 exit”的单体端到端；源码 `fatal → cleanup → exit(1)` 链已完整追踪。本轮仅覆盖 F03，不宣告 F05 或全报告验收完成。

### F04｜cancel／replace 一般外部失败被错误套用 submit UNKNOWN fatal

**当前位置**：`src/infrastructure/longbridge/trade/mutationErrorClassification.ts:139-190`；`src/application/orderTracking/orderMonitor/orderOps.ts:299-324`，关键 `:306`；`routeProcessor.ts:960-963` → `routeRuntime.ts:161-172`。

**旧版依据**：`develop:src/core/trader/orderMonitor/orderOps.ts:502-519` 一般cancel失败返回 `UNKNOWN_FAILURE`；`:799-801` 一般replace失败返回 `NOT_EXECUTED`。

**真实输入**：native方法抛 `Error("HTTP 403 permission denied")`，附 `status:403`，不是TypeError、不是臆造业务码。两版真实externalApi均只请求一次并原样抛给owner；其局部 `FAIL_FAST` 只表示“不做请求重试”，不等于全应用fatal。

**链路与差分**：实际adapter → orderOps → 真实Monitor跟价replace／BUY超时cancel → routeRuntime。

- develop保留局部失败结果，后续合法行情仍能继续，drain正常。
- 当前分类UNKNOWN并抛 `TradeMutationUnknownError`，自动route第一次失败即全局fatal，drain再暴露同一错误。
- 公共cancel也由返回失败变抛错，但其全局后果取决于caller；已经完整证实全局退出的是上述两条自动route。

**影响**：单张订单的普通外部拒绝扩大为整个系统退出。不是所有未知提交都应放行，也不证明403已在生产发生。

**方案对照**：实施计划 `:35` 限定submit UNKNOWN例外，`:1582` 要求cancel／replace既有错误分类和重试时机保持。不能用中性标签统一化改变业务错误政策。

**最小修复方向**：在共享结果契约／操作owner恢复cancel／replace一般失败结果；保留submit UNKNOWN fatal、内部错误、暂态有限重试、closed权威查询、602012／602013／WAIT_WS_ONLY及ACK≠终态。

**回归验证**：真实native错误producer到route，不只注入中性UNKNOWN；分别验证replace、超时cancel和公共cancel，首失败后门禁、后续事实推进及drain。**二审**：`audit-recheck-mutation-errors.md`，6个Monitor场景；定向现有测试9项通过。**维度**：实现、需求／方案、测试。

### F05｜完整事实校验早于观察择优和消费范围选择

**归并**：INF-C1、INF-C2、G3-C3，共同根因一项；修复必须同时覆盖SDK mapper与application归一两层。

#### F05-a：将本应被 today 覆盖的旧 history 提前判死

- 当前：`src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:120-153,178-199`，history逐条完整映射在today请求前；`orderMapper.ts:101-109` 拒绝正成交缺revision或在途正成交缺价。
- 旧版：`develop:src/core/orderRecorder/orderApiManager.ts:118-125,146-164,197-207,272-296`，保留nullable原始观察，先history／today择优，再对实际业务消费事实校验。
- 反例：同ID history正成交 `updatedAt=null`，today完整；或旧PartialFilled缺价、today完整Filled。旧版恢复成功；当前只请求history就TypeError，完整today没有机会覆盖。
- 同来源重复的旧观察亦有此问题。**历史控制，受F03新准则影响**：受审版本的普通终态缺价但revision有效的history可映射为null并被today覆盖，两版都通过；该结果只说明旧实现，不再是正成交终态的保持目标。按最新F03，正成交终态本次缺／零／无效价额须首次fatal，不能依赖today覆盖或known补值；F05其他范围问题仍需独立处理。

#### F05-b：旧明确允许忽略的 Unknown＋零成交＋终态变为全局失败

- 当前 `orderMapper.ts:73-80` 在lifecycle／quantity判定前一概拒绝Unknown side；domain的 `src/domain/order/orderRecordPolicy.ts:217-227` 仍保留豁免，却不能从真实SDK入口到达。
- 旧 `develop:src/core/orderRecorder/utils.ts:203-209,222-237` 明确忽略零成交已知终态Unknown；OPEN或正成交Unknown仍拒绝。
- SDK 4.4.3正式包含Unknown枚举、Order.executedPrice／updatedAt可null；结构可表达不等于证明实际返回频率。

#### F05-c：无关HK手工终态数据阻断系统启动／激活

- 当前 `src/application/seatActivation/index.ts:320-332` 全账户normalize后，`:334-374` 才选related及归属；`src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:491-493` 同样全量归一。
- `src/application/tradingDayRebuild/executionNormalization.ts:45-48` 对任意正成交null金额抛错。
- 旧 `develop:src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:318-352` 先related预检；recorder先symbol过滤；Daily原来按有效成交和ownership选择消费范围。
- 历史反例：激活BULL.HK，全账户另有无本系统归属、非related、无pending／durable义务的00005.HK手工普通Filled单，成交价null。受审版本adapter允许该普通终态缺价表示；旧激活ACTIVE、旧loader成功；受审版本在Daily／O提交前抛错，真实监控队列进一步关闭全局准入。**此前要求放行此缺价输入的前提已被F03首次fatal准则替代**，不能用它作为最新放行目标，也不据此宣称F05整体已修。

**同根旁支**：untracked且recorder无known的HK推送，本应被eventFlow忽略，却先被mapper严格拒绝。独立验证Unknown零成交终态及无关partial缺价会fatal。不能修成“无tracking一概丢弃”，因为closed但有known的合法修订仍须处理。

**影响**：确认恢复／激活／消息准入范围扩大；没有坏账已经发布的证据。broker出现这些组合的频率未在线验证。

**最小修复方向**：严格区分原始结构／保真读取、原规则择优、原consumer消费集合、窄经济事实构造。先选中，再对真正需消费的事实严格校验；不得用“哪条校验通过就选哪条”。Unknown终态丢弃也要在today优先之后，防止history复活。**此范围修复不得绕过F03对异常正成交终态的mapper／domain首次fatal要求**，旧普通缺价可映射的对照不是最新目标。

**必须保留的负向控制**：坏的获选today不可fallback；相关缺金额、相关不可归属、Unknown OPEN／正成交仍拒绝；非席位但属于系统的完整历史仍须参与日损（独立控制OTHER.HK往返loss=-10），不能简单只保留relatedSymbols；pending API本来严格拒绝Unknown，未认定为新增回归。

**二审**：`audit-recheck-ingress.md`，26场景断言全部通过，相关现有102测试通过。**维度**：实现、需求、类型边界、测试、注释。

### F06｜距离换标回补预算从完整合法移仓缩减为新单增量

**当前位置**：`src/application/orderExecution/submitFlow.ts:643-667` 的SWITCH_MOVE独立提交；`src/application/seatSwitch/switchStateMachine.ts:1193-1205,1377-1393` 只计本次新单／后继金额。

**旧版依据**：`develop:src/core/trader/orderExecutor/submitFlow.ts:708-833` 允许合法普通REPLACE；`src/services/autoSymbolManager/switchStateMachine.ts:1008-1046,1215-1229` 按实际返回卖出operation完整成交金额回补。

**独立端到端反例**：旧仓100，普通非protective ELO旧SELL60未成，可用40；旧、新卖价2，新标买价1，lot1；关联集合为空，满足旧合法REPLACE约束。

- 旧版真实改单OLD到100，全部成交200金额，回补BUY200。
- 当前保留OLD60、另发NEW40，两单实际总成交同为200，回补只按NEW80金额，BUY80。
- 两版均经真实executor、monitor、成交结算、freshness、switch runtime到native BUY，未用helper的合并建议冒充最终改单成功。

**负向控制**：若旧关联集合仅覆盖60却试图改为100，旧版本来拒绝；该输入不能证明200→80。二审已另跑合法空关联正例和关联不匹配负例。

**影响**：确认同样合法移仓资金下少回补120股；现金保留不等于满足原回补业务。不是精度误差、不是必然亏损。

**最小修复方向**：可继续复用合法普通合单，或保留拆单但证明本次移仓资金范围一致；必须只汇总有明确本次归属的旧／新／真实后继，防重复和protective混入。不能按symbol把所有旧卖单金额盲加，也不能把拆单形式本身判错。

**方案**：`:37,1390,1829` 保留普通合法REPLACE；protective隔离例外不覆盖两单均普通的反例。当前独立SELL／预算政策可追到 `c36cadb2`，未找到针对性范围例外。

**回归验证**：合法／不合法关联、普通／protective、真实总成交金额、回补数量、后继MO身份。现有集成把BUY80写为预期，不能作为等价证明。**二审**：`audit-recheck-switch.md`。**维度**：实现、需求、类型／预算归属、测试。

### F07｜本次无 accepted SELL 的可恢复结果，被一次性结案后全局退出

**当前位置**：`src/application/seatSwitch/switchStateMachine.ts:903-916,963-970,1015-1030,1079-1086,1187-1190`；`src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:669-675`。

**旧版依据**：`develop:src/services/autoSymbolManager/switchStateMachine.ts:884-900,981-1014`，只有得到真实accepted订单ID才标记sellSubmitted；尚未提交时可利用释放的余量首次卖出，明确未提交走原重评估。

**根因**：`sellSubmissionResolved` 把已ACK、明确拒绝、无可卖量、旧操作余量结算、缺行情耗尽混为同一“不再决定卖出”。随后真实正持仓统一被视为不变量破坏，哪怕本次从未accepted，也全局fatal。

**独立验证的生产形态**：

- 首次native结构化明确拒绝 `{code:601013}`，无ACK：旧版下一次受控timer实际SELL、成交后回补成功；当前一次拒绝后核仓positive即fatal。
- 首次drive前／候选await内，旧普通SELL零成交取消并释放：旧版首次SELL100并回补200；当前未发新SELL即fatal。
- 真实行情mapper可产生null/MISSING，持续到原报价重试耗尽：旧局部FAILED；当前无native提交仍全局fatal。

**V-C6限定**：quote double直接price=0的差分已确认，但真实quote adapter会把非正价映为null，不能把零价double称作完整实盘路径；上面的MISSING耗尽是另行验证的有效形态。fresh-flat无卖出正常完成、positive保留旧owner都是合理安全改进，不作为缺陷，不应回退EMPTY。

**影响**：确认单方向可解释失败扩大到全应用关闭；不是必要的UNKNOWN防重提，因为已经明确本次没有accepted／未知提交。旧版自己已ACK后再取消的等待停滞本来存在，不算本项新增。

**最小修复方向**：区分已accepted、结果不确定、明确未accepted和旧operation已可靠释放。无本次ACK时恢复原有限重评估／首次提交能力；保留真实持仓owner与最终核仓。行情耗尽的本地暂停政策需明确，不得简单把fatal改EMPTY，也不得无条件重置已ACK／UNKNOWN状态。

**回归验证**：本次ACK前后、明确拒绝／UNKNOWN、普通／protective、fresh flat／positive、pending handoff／已释放、缺行情耗尽，必须经真实runtime看全局gate。当前测试锁定“拒绝最终决定”不能证明业务授权。

**二审**：`audit-recheck-switch.md`；共12探针命令、23版本分支，含F06及控制场景。**维度**：实现、失败协议、类型状态区分、测试。

### F08｜重建成功开门没有唤醒已到期周期换标

**当前位置**：

- `src/app/runtime/createPostGateRuntime.ts:737-755`，派发predicate包含lifecycle＋连续时段。
- `src/runtime/periodicSwitchWakeupRuntime/index.ts:209-244,382-390,449-473,651-673`。
- `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:109-150`。
- `src/runtime/lifecycle/dayLifecycleManager.ts:315-345`。
- `src/runtime/timeWakeupEvaluationProgram/index.ts:291-309,359-365`。

**旧版依据**：`develop:src/main/periodicSwitchWakeupRuntime/index.ts:128-151,177-233` 在seed时先排任务，旧queueRunner通过setImmediate消费，manager微任务链已完成开门。旧恢复顺序本身不是新bug。

**根因**：新增复合gate在派发前阻断；signal domain恢复periodic时lifecycle仍关，已过期route清timer后进入blockedOnGate。manager最终开lifecycle未通知；时间owner只发布纯连续时段false→true。失败重试期间canTrade早已true，恢复时true→true不发边沿。

**独立反例**：前日15:59 ACTIVE同标、周期5交易分钟、有持仓，午夜真实carryover；次日开盘外部读失败四次，09:37:30恢复，due本应09:34。账户／settlement已fresh、lifecycle ACTIVE，仍0任务、0周期timer。旧组合会派发1项；补真实gate恢复可派发1项。

**旁路和影响限定**：普通订单事件、fresh事件、安全区报价、开盘保护结束和反复evaluate不救回；同方向truth mutation可以救回，另一方向不行。全日市上午通常等到13:00，例中延迟3小时22分30秒；半日市上午／全日市下午可到下一交易日，且无无条件固定上限。不是整个系统永久死锁，也不是所有启动或未来due受影响。

**最小修复方向**：最终重建COMMITTED、lifecycle真正开门时，向有效挂起周期需求交接一次恢复重评估；可复用已有完整授权恢复事件。保留epoch、seatVersion、receipt、single-flight、原caller。不能提前开门、删除gate、伪造连续边沿或加轮询。

**回归验证**：真实域组装下同段失败恢复、首次false→true、future due、半日／下午、同／异方向truth、fresh／order、跨epoch和stop迟到回调，断言exactly-once有效任务。现有harness手工一起改gate和emit事件掩盖了生产断线。

**二审**：`audit-recheck-lifecycle.md`，7个独立组合场景。**维度**：实现、事件／授权契约、需求、测试。

## 已授权业务变更（不属于问题）

### B01｜末日保留旧 SELL，仅按当前 available 新增清仓单

**状态：已授权，非问题，无严重性等级，不构成验收阻塞。** 用户已明确确认：“B01是授权的业务改动，无需将B01视作问题。”原审计对本项的 major、待授权、回退建议及验收阻塞分类撤销。以下仅保留旧新行为与验证证据，不要求恢复旧策略，也无需再次申请B01授权。

- 旧 `develop:src/core/trader/orderExecutor/submitFlow.ts:600-678`：取得全部pending SELL → 撤单 → ACK后等待可信终态 → 重读仓位 → 提交。
- 当前 `src/application/orderExecution/submitFlow.ts:575-605`：保留旧SELL、不撤不改不合并 → guard后读available → 只新增available。

| 同输入15:56、旧普通ELO SELL未成 | develop | 当前 |
|---|---|---|
| available=0 | cancel=1，不读仓、不新提交，等待终态 | cancel=0，读仓后不提交，无本项重评估 |
| available=40 | cancel=1，不读仓、不新提交，等待终态 | cancel=0，立刻新增40，旧单不变 |

两名业务代理独立执行了真实提交路径对照，确认当前实现采用上述已授权策略。旧SELL继续由原order monitor按配置、订单状态和剩余时段处理；这与旧版主动撤单接管不同，但该差异属于B01的授权范围，不据此列为问题。

**方案历史**：`develop`时方案`:1305`要求先旧SELL终态再读可卖；当前方案`:1360`改为不撤不改不合并。`8fd0eefc8c7aa1da996e069b30f503e9ea2fe105` 同步修改实现、方案和测试。该历史差分继续保留；本项授权依据现已由用户直接确认，不再处于待裁决状态。

**保留的安全约束**：accepted不等于成交／flat；当前不虚裁canonical持仓、不立即清整方向BUY。B01授权不取消真实成交、持仓、订单身份与最终提交门禁校验。

**处置**：保留已授权的“旧SELL不撤、不改、不合并，仅按最新available新增”策略，不因与develop不同而回退；本项不安排缺陷修复或追加授权。此授权仅针对B01，不扩展到距离换标预算或明确拒绝后的失败策略，F06／F07结论不变。

**既有验证记录**：available=0不新增、available=40新增40，以及旧普通／protective／MO卖单保持原状态的对照；详细验证范围见下列证据，不据此声称所有生产成交时序已穷尽。**证据**：`audit-order-execution.md` OE-003、`audit-risk-account.md` V-C4、`audit-spec-drift-register.md`。**维度**：业务需求、实现、测试、方案变更管理。

## 不混作新算法缺陷的行为／范围登记

这些变化真实存在，不能写作“纯目录迁移”；但有合理安全或一致性收益，不能机械回退。仓库方案的历史“用户已确认”记录说明文档背景，不是本次对任意进一步漂移的自动授权。

| 编号 | 已确认差分 | 改进依据、范围结论 |
|---|---|---|
| D01／V-C1 | 已完成保护boundary之前的同量高revision，由Daily抑制变为准入、更新权威事实／durable／refresh。真实closed保护单修订：旧落盘1→1，新1→2；新第二次落盘失败可fatal | 权威revision一致性有价值；Daily仍0、hold只关闭一次、episode未重开，未证实重复日损／冷却。方案`:828`一般合法修订条款存在，但未专门说明废除该封存准入抑制。记录特定边界与新增失败点，需范围裁决，不计入8项新实现bug，亦不与F02来源丢失混同 |
| D02／V-C5 | limit3、5分钟冷却，10:00／01／02三次完成，10:10重启后再完成一次：旧立即再冷却300000ms，新不冷却、重新计数 | 当前更接近原tracker“不重启持续运行”的行为，属于合理旧缺陷修复候选，不应叫新冷却算法bug；但确实改变重启后交易放行时长，未找到针对性方案例外。当前 `protectiveLiquidation/tradeLogHydrator.ts:66-85`；旧 `services/liquidationCooldown/tradeLogHydrator.ts:61-77` |
| D03／LC-D1、V-S1 | 末日submit UNKNOWN：旧刷新持仓／协调订阅并安排1000ms重评估；当前直接fatal／cleanup，无专属刷新或timer | 实施计划§1.1`:35`在develop时已明示这一非等价目标，与普通BUY／SELL统一且不自动重提。是方案内明确变化，不是意外漏迁移。不可把此例外扩张到F04的cancel／replace或F07的明确拒绝 |
| D04／精确金融计算 | number／Decimal混用转为金融保真文本、精确计算及规定显示舍入；部分浮点临界结果有意变化 | 实施计划§1.1、§4.4`:454-484`在重构前已明确纳入，不能把全部精确化判成未经设计的偏离。但不授权改数量政策、市场／订单消费范围、回补归属、恢复、计数或失败协议；指标number算法仍应保持 |

D01已由订单和风险代理复核；D02由validation与风险代理独立统一输入确认；D03由生命周期源码审计与validation真实双实现探针确认；D04按原方案明确围栏及领域对照登记，不声称任意输入的数值结果均已穷尽。

## 过度设计／过度复杂化的结论

**没有足够证据把整个新分层、所有token、事件owner或精确数值设施一概判为过度设计，也没有确认可直接删除的A级死代码。** 文件增加、层数增加不是缺陷证据。

已经确认的复杂性问题是具体的：

1. **统一逻辑抹掉不同语义**：F01将历史批量过滤扩到在线消费；F02把来源证据当一般incoming字段；F04把submit失败政策推广到所有mutation。
2. **同一状态位合并不同业务结果**：F07把ACK、明确拒绝、旧单释放和报价失败都标为resolved，产生不必要的全局终止。
3. **类型变窄先于真正选择边界**：F05为了统一完整OrderFact，扩大成整个账户观察都必须满足完整经济契约。
4. **增加安全predicate却漏掉事件义务**：F08是完整gate与通知不匹配，不需要用更多定时轮询兜底。
5. **“独立操作”改变经济范围**：F06的拆单不必错误，但不应借owner隔离改变回补资金政策。

优先修这些共享根因，不建议为本审计新增通用框架、兼容层、影子账或全局fallback。

## positive findings

经过对照／交叉二审，以下改进应保留，不能因修复上述问题整体回退：

- 行情metadata在await前捕获，避免并发退订制造伪0昨收／丢lotSize；最终席位和提交授权仍独立检查。
- 订阅mutation后重读当前需求，避免旧差集退订重新需要的标的；首次准入失败仍归原owner，不冒充settlement ready。
- 保留真实已发布WAIT及在途事件，不等于获得新mutation权限；午休／末日接管／生命周期关闭仍撤销推进授权。
- canonical snapshot唯一writer、版本／epoch隔离，snapshot commit与business ready区分；旧异步结果不能给新代次续票。
- fresh-flat可以完成换标；fresh-positive保留旧标ownership，不错误发布EMPTY／新标。
- accepted不等于flat，真实protective完成坚持持仓／pending确认及durable先于内存提交。
- 普通合法高revision事实修订、protective身份隔离、真实MO后继占用交接、最终报价／permit／原caller门禁均有实际约束价值。
- 策略数学核心、延迟验证规则、采样／队列的多项疑点与develop一致；部分“断言减少”实为helper提取／重复断言移除，不是保护删除。

## 两个历史严重问题的复核

### d2aa590

不能归因为“重构凭空添加executionTime≤revision”。develop本来存在这些判断，例如旧 `orderMonitor/settlementFlow.ts:275` 与日志仓储检查；当时两种时间同来自订单updatedAt。重构中间态引入独立execution时间后，原先后假设失效，多层仍沿用才造成合法事实被拒绝。

当前不应重新加回无依据的跨时钟先后约束。历史修复已存在，但不能由该提交已修推导所有成交准入／恢复语义已正确；F02、F03、F05是原受审版本 `2b67d36` 中仍存在的具体问题，F03 工作区进展见[本轮补记](#f03-implementation-verification)。

### 2b67d36

历史根因至少包括：execution驱动启动、全局数量安全整数化、跨市场范围失控。受审版本 `2b67d36` 已恢复订单驱动数据源，账户正小数展示与HK执行整数约束分离，非HK在严格订单映射前过滤，不能重复报告这些已修路径。

但该修复也改动了closed-order修订入口、经济投影、共同归一和封存准入。该受审版本的F01／F03／F05等说明“修回订单来源”并不等于端到端恢复旧业务语义；D01还需明确登记其非纯迁移范围。不能把该受审版本的所有问题都归因于这两个提交：B01来自`8fd0eef`，F06／F07关键政策来自`c36cadb2`，D02来自`8464691`，D03来自`4a148b3`。

## 覆盖与验证

### 文件与全链路覆盖

已建立 **368个current文件（367 TS＋1策略JSON）** 与 **263个develop文件** 的迁移／责任账本；七组唯一分派无遗漏、无重复：

| 组 | 责任 | current文件 |
|---|---|---:|
| G0 | 总装配、跨链wiring、共享队列 | 39 |
| G1 | 启动、跨日、时间门禁、恢复、停机 | 34 |
| G2 | 行情、指标、策略、延迟验证、订阅runtime | 42 |
| G3 | 寻标、席位、换标、激活 | 34 |
| G4 | 买卖执行、订单跟踪／结算、恢复 | 63 |
| G5 | 账户、风险、保护完成、冷却、清仓 | 36 |
| G6 | SDK、配置、公共契约、持久化、日志、数值 | 120 |

最终账本确认：**245／245个运行码模块均有明确D级阅读证据**；另外122个纯类型契约、1个JSON单独登记。初版22个仅有E／B证据的运行模块已分别完成9项平台和13项订单补审，无新候选。D表示关键实现与调用链深读，**不表示每行、每个状态组合或所有并发时序均已证明正确**。原始等级、旧来源候选和补充前状态保留在账本历史中。

G4原P11和G6原T52全部核实为纯类型文件，不是隐藏未读运行逻辑。补审后，G4这11项以及G6中有直接运行时消费者的51项，其已知直接消费者均有D证据；`src/types/orderHold.ts`只有类型中间边，保留字段传播未评估边界。契约字段的全部动态／间接消费者仍不能由静态import或测试执行自动证明。

### 原审计有效全量门禁（历史）

验证代理在固定Git导出TEMP副本中执行，未运行原仓库lint:fix／format，未启动实盘。共用已安装依赖；没有按两版lockfile重新安装的独立环境证明。下表“当前”指原受审版本 `2b67d36`，**3288 pass／0 fail、317 文件为历史结果，不是本轮 F03 全仓测试**；本轮离线结果见[补记](#f03-implementation-verification)。

| 检查 | 当前 | develop |
|---|---|---|
| `bun --no-env-file run type-check` | exit0，7.682s | exit0，4.926s |
| `bun --no-env-file run lint` | exit0，92.477s | exit0，56.187s |
| 全量测试 | **3288 pass／0 fail**，317文件，19669断言 | **1992 pass／0 fail**，187文件，7638断言 |
| 测试耗时 | 305.161s | 54.733s |

旧版有效测试命令显式preload外置offline SDK guard：`bun --no-env-file test --preload <TEMP>/validation-offline-sdk-guard.ts`。首次Bun帮助页空跑虽exit0，已经排除，不算通过；探针构造错误／环境断言失败及纠正均保留，不冒充产品缺陷。

**不累计不同代理重叠的定向测试数。** 该历史全绿只证明当时各自oracle通过，不能证明新旧等价，也不能替代本轮 F03 的 **3418 pass／2 fail**。关键反向oracle和缺测已在每条finding说明。

### 独立二审证据索引

**持久化报告附件**：[architecture-refactoring-audit-evidence/2b67d36](./architecture/architecture-refactoring-audit-evidence/2b67d36/)。本次领域首审、独立二审、范围登记、覆盖账本和验证说明均保存在该目录；附件保留原始差分与复核证据；B01／V-C4／OE-003的分类已按用户直接授权同步校正，非问题。其他“候选／待复核”的历史状态以本总报告及对应二审为准。

可执行探针、SDK离线guard及原始测试日志仍位于本机审计工作目录：`C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`。附件中有些报告内含完整可运行探针，但TEMP脚本的绝对路径依赖当前机器；如需跨机长期复跑，应单独迁移这些脚本和运行环境，不能把报告归档等同于已建立永久回归套件。

| 报告／工件 | 内容 |
|---|---|
| `audit-recheck-order-facts.md`、`recheck-order-facts.test.ts` | F01、F03历史差分；6 pass／149断言，真实Monitor＋经济消费者；不代表最新F03首次fatal准则已验证 |
| `audit-recheck-risk-boundary.md`、`recheck-risk-boundary-{differential,probe}.ts` | F02；同量来源、自然边界、实际JSONL→新loader |
| `audit-recheck-mutation-errors.md` | F04；两版wrapper／adapter／自动route，附可运行探针 |
| `audit-recheck-ingress.md`、`audit-recheck-ingress.probe.cjs` | F05；26场景及择优／scope负向控制 |
| `audit-recheck-switch.md`、`audit-recheck-switch-probe.ts` | F06／F07；12命令23分支，合法合并及ACK前后控制 |
| `audit-recheck-lifecycle.md` | F08；7个真实域组合场景，附独立探针 |
| `audit-order-execution.md`、`audit-risk-account.md` | B01、D01、D02首审／交叉复核，完整旧新证据 |
| `audit-spec-drift-register.md` | 原方案与后续改写的逐条范围及Git归因 |
| `audit-validation.md`、`validation-coverage-supplement.md`、`validation/` | 两版有效门禁、原始日志、oracle差分、SDK隔离界限 |
| `audit-baseline-map.md`、`audit-coverage-ledger.md`、`coverage.json` | 368/263文件账本、实际阅读级别和未评估边界 |
| `audit-cross-g0-g2.md`、`audit-market-strategy.md` §8 | 合理架构差异交叉复核及10会话本地模型配置证据 |

主要差分复跑入口（会写审计输出，不修改受审源码；复跑前保留已有证据并隔离日志根）：

```powershell
# 在审计证据目录运行；依赖当前固定仓库与已安装依赖。
bun ./audit-recheck-ingress.probe.cjs
# 直接运行一个换标差分；完整runner还会运行定向测试：
bun run ./audit-recheck-switch-probe.ts c1
bun run ./recheck-risk-boundary-differential.ts
bun run ./recheck-risk-boundary-probe.ts
# F01/F03使用其隔离启动器及离线SDK guard：
node ./run-recheck-order-facts.cjs
```

这些脚本只在TEMP，未作为生产测试提交；具体环境／路径约束、失败首跑、有效原始输出见各报告。`audit-recheck-switch-run.cjs` 除差分外还会在仓库cwd运行现有定向测试，并覆盖同名TEMP日志／结果；若使用完整runner，应明确隔离日志根并先另存旧证据。“只读审计”仅指不修改受审源码、测试、配置和方案，不表示文件系统零写入。源码发生变化后不得把本次结果当作新版本验证。

## minor issues

None。没有为凑数量把命名、行数、注释噪音、未穷尽动态消费者的dead-code怀疑或纯审美简化列为问题。

## not assessed

- 实盘券商消息频率、真实账户／订单／历史JSONL对账、行情优先级、成交概率、生产资金损失；SDK声明和离线可达性不等于线上已经发生。
- 完整生产发布、回退、损坏历史数据修复、跨进程所有crash-gap和网络时序；F02虽完成隔离真实JSONL闭环，不代表全部持久化故障矩阵通过。
- 全部122类型契约每个字段的动态／间接传播、全仓外部反射／字符串消费者、所有状态穷举；没有A级死代码删除结论。
- 其他操作系统、重新安装旧依赖后的可重复性、OS级网络隔离／抓包证明。离线guard阻断SDK会话工厂，不冒称防火墙隔离。
- 除用户已直接确认的B01外，其他历史额外业务变化的独立审批原文未评估；本次B01授权不自动扩展至D01–D04或F01–F08。

## recommended next actions

1. **先修F01**：恢复在线经济账正确性，同时保护风险与智能平仓消费，不在下游补假数据。
2. **修F02并审慎对待既有durable**：保持来源证据，确保成功completion能自恢复；如需处理真实日志，先按真实历史对账，不自动删改。
3. **继续处理F04／F05／F07**：F03 已按最新准则完成首次拒绝、closed 窄范围丢弃与 fatal 时序修复，并经独立复验，见[本轮补记](#f03-implementation-verification)；其余问题仍须恢复正确消息／范围／失败归属，保留严格实际事实、UNKNOWN及内部不变量保护，避免统一catch或降级。
4. **修F06／F08**：恢复原合法移仓资金范围与lifecycle恢复唤醒，不用新轮询或影子账掩盖。
5. **B01按已授权业务变更保留，不作为问题处理；D01–D04另行维持原范围登记**。B01无需再次授权或恢复旧末日接管策略；其他有明确改进的部分保留并写清边界，不能机械回滚安全收益。
6. 将已独立复现的正／反例转为长期业务回归；修复时运行与范围相称的验证及项目必需检查。**原审计（受审版本 `2b67d36`）仅分析与记录，没有实施修复，不能据其全绿门禁宣告可按纯架构重构发布。** F03 工作区实施与离线验证见[本轮补记](#f03-implementation-verification)，不构成全报告通过。
