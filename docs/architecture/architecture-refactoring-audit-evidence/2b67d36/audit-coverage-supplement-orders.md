# 订单模块覆盖补审：§3 指定的 13 个 E-only 文件

## summary

- **verdict：指定 13 个文件已补齐逐文件全文深读、固定 develop 来源对照和直接生产消费者证据，可将这 13 个运行码条目的覆盖深度由 E 补为 D。** 本续作未新增已确认缺陷；D 表示本文件的关键分支经过检查，不表示整个订单生命周期重新审完或已证明两版逐点等价。
- **scope：**`audit-coverage-ledger.md` §3 所列订单组 13 项，正文共 **797 行（不计文件末尾额外空行）**；必要调用方只读相关函数窗口。未扩展审查该节其余 9 项，未更改原账本或原首审／二审报告。
- **confidence：high**，限于上述文件的覆盖完整性及列出的静态比较；业务授权、外部 broker 全行为和竞态穷举不在此置信度内。
- 固定 current：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；固定 develop：`6e239c8a128372bd9b2fb2d79464346792a5e81e`。旧来源以该 SHA 的 `git show` 为准，不从新测试、新注释或 business skill 反推旧需求。
- **本续作没有运行任何测试、probe、type-check、lint 或 lint:fix；没有连接实盘、启动子代理、修改仓库文件或切换版本。** 既有报告的测试及二审结论只作具名引用，不算本续作新增执行结果。
- 沿用原指定 `cliproxyapi / gpt-6.1-sol / thinking max` 的会话约束；不把先前的本地配置证据冒称服务端实际模型路由证明。

## critical issues

None. 本覆盖续作未新确认 critical；不覆盖、撤销或升级既有报告的 finding 状态。

## major issues

None. 本覆盖续作未新确认 major。

## minor issues

None. 未为覆盖数字将术语、文件长度或纯风格差异列为问题。

## positive findings

1. `buyThrottle` 的核心实现仅改导入路径，`routingIndex` 仅有空白变化；已核对全文而不是仅凭重命名推定等价，见 S01、S04。
2. 撤单 policy 及直接消费者仍区分 **请求 ACK** 与 **非成交终态**；普通卖单合并不因 ACK 就释放占用或重下，见 S06。此结论不否定既有末日专用执行器协议差分。
3. 终态观测在结算之前确认、observer 异常隔离、恢复回滚保留已确认位，且没有另建事实 owner，见 S03；不能因此省略 lifecycle 对象身份的实际消费者。
4. 成交审计保留同步 append、完整上下文过滤后才校验 monitor、异常 fatal 后重抛及原 unsubscribe 登记，见 S05、S13。
5. 数量与智能平仓改用原金额／数量的精确运算，并在执行边界证明安全整数；这是需要明确登记的语义／精度差异，不被包装成“只有路径迁移”，见 S08、S12。

## 1. 范围、方法与证据复用

### 1.1 D 的限定含义

本轮逐一读到每个目标文件的最后一个有效行，检查所有运行分支、状态写入、错误／返回边界、导出及直接调用点，并与 develop 的实际实现位置比较。调用方只覆盖证明本文件契约所需窗口，**不将调用方窗口、一次 grep、自动截断输出或测试通过升级为整个调用方 D**。

初始批量输出及旧长工具文件打印曾超过输出边界；本报告采用后续缩小窗口、按符号读取及当前目标短文件全文核实的证据，不把“发起过全文打印”本身算深读。来源搜索没有命中的探索路径也不算覆盖。

所有 `current:` 行号均对应固定 current；未加前缀的 `src/` 行号亦为 current。`develop:` 行号对应固定 develop。下面的“无新增候选”只描述本补审没有提出新的可定项主张，**不是重新给整个 G4 发合格证**。

### 1.2 吸收的既有独立／跨组证据

已实际读取下列落盘段落并核对相应源码，不重复运行其测试：

- `audit-recheck-order-facts.md:129` 明列 `routingIndex.ts:1–150` 以及 monitor、eventFlow、settlementFlow、routeProcessor 的定向阅读范围。当前文件实际止于 148，故只引用有效的 1–148，见 S04；该二审不使本补审成为新的独立二审。
- `audit-recheck-mutation-errors.md:194–201` 的定向读取清单包含 `orderTrackingPolicy.ts` 及其 orderOps／routeProcessor／routeRuntime 消费者。清单没有替代本轮逐分支对照，见 S10；不重做 OE-005 的异常重放。
- `audit-risk-account.md:173` 已追到真实旧智能平仓 helper，指出整体盈利／盈利单／超时单阶段，以及精确交叉乘与显示均价的区别。本轮核对旧 helper 和新纯规则，见 S12。
- `audit-global-wiring.md:77` 已核对同步成交日志与 listener fatal/rethrow 边界。本轮核对抽取后的两个完整目标模块及装配窗口，见 S05、S13。
- `audit-spec-drift-register.md:12–17,31–37` 区分实现差分与本轮授权轴。本报告对精度、严格校验及事实观测只登记具体变化，**不因为方案自称“受控修复”就豁免纯架构等价要求**。

### 1.3 覆盖表（恰好为原 §3 的 13 项）

| ID | current 目标路径 | 本轮全文范围 | develop 实际旧来源 | 本轮深度 |
| --- | --- | --- | --- | --- |
| S01 | `src/application/orderExecution/buyThrottle.ts` | 1–85 | `src/core/trader/orderExecutor/buyThrottle.ts:1–85` | D |
| S02 | `src/application/orderExecution/submitFailureLogging.ts` | 1–23 | `src/core/trader/orderExecutor/utils.ts:73–145`，主要函数 109–145 | D |
| S03 | `src/application/orderTracking/orderMonitor/orderObservation.ts` | 1–99 | 无独立同名旧模块；旧 monitor 的 ACK／terminal／lifecycle 边界，详见 S03 | D |
| S04 | `src/application/orderTracking/orderMonitor/routingIndex.ts` | 1–148 | `src/core/trader/orderMonitor/routingIndex.ts:1–147` | D |
| S05 | `src/application/orderTracking/tradeAudit/index.ts` | 1–94 | `src/app/runtime/createPostGateRuntime.ts:90–195` | D |
| S06 | `src/domain/order/cancelOutcomePolicy.ts` | 1–47 | `src/utils/trading/orderStatus.ts:1–46` | D |
| S07 | `src/domain/order/orderAnalysis.ts` | 1–13 | `src/core/orderRecorder/index.ts:490–500`，及旧 filtering engine 工厂 160–168 | D |
| S08 | `src/domain/order/orderQuantity.ts` | 1–51 | `src/core/orderRecorder/utils.ts:70–85`；`src/utils/numeric/index.ts:210–259`；旧 quantityResolver 97–136 | D |
| S09 | `src/domain/order/orderRemark.ts` | 1–16 | `src/core/trader/utils.ts:41–69` | D |
| S10 | `src/domain/order/orderTrackingPolicy.ts` | 1–129 | `src/core/trader/orderMonitor/utils.ts:25–173` | D |
| S11 | `src/domain/order/orderTypePolicy.ts` | 1–17 | `src/core/trader/utils.ts:120–141` | D |
| S12 | `src/domain/order/smartClose.ts` | 1–50 | `src/core/signalProcessor/utils.ts:103–236` | D |
| S13 | `src/runtime/orderTradeAuditListener/index.ts` | 1–25 | `src/app/runtime/createPostGateRuntime.ts:443–459` | D |

## 2. 逐文件证据

### S01 — buyThrottle

**读取与 develop 对照：**current 全文 1–85；旧同名文件全文 1–85。完整 diff 仅导入相对路径迁移；另以导入路径归一化后的全文字符串比较确认相同，不是仅比较函数签名。

**关键分支：**

- `:34–57` 非 BUY 恒放行；BUYCALL 归 LONG、另一合法买入动作归 SHORT，两方向独立。未记录过则放行；`elapsed >= interval` 包含恰好到边界；未到则向上取整等待秒数。
- `:65–68` 只有显式 `recordBuyAttempt` 才写时钟；检查本身不占窗口；`:76–78` clear 清空同一 Map。
- 模块未新增现金预占、事实缓存、定时器、外部请求或错误吞并。时钟倒退、非法配置不是本文件新差异。

**直接生产调用方：**

- `src/application/orderExecution/index.ts:474–495` 每个执行器创建实例并注入 submit 的检查／记录能力；`:651–654` 暴露检查和 reset。
- `src/application/ordinaryBuy/riskChecks.ts:198–203` 预筛使用 `tradeFrequencyReader.canTradeNow`；真实装配为 `src/app/runtime/createPostGateRuntime.ts:662` 的同一 orderExecutor。
- `src/application/orderExecution/submitFlow.ts:364–369` permit 内再检查；`:481–487` 在 adapter 的 `onRemoteIssued` 回调记录真实请求尝试，**不是 ACCEPTED 后才记录，也不是任意本地预校验失败都占窗口**。旧调用在 `develop:src/core/trader/orderExecutor/submitFlow.ts:524–530`，先记录再 invoke permit；这是调用时点迁移，不把它隐藏在“模块全文相同”中。新回调边界见 `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts:142–184`。
- `src/runtime/lifecycle/cacheDomains/orderDomain.ts:30–35` 午夜在 runtime 已停后 reset。

**结论与未深入边界：**目标模块实现迁移等价；实际请求边界与旧不同已登记，未重新判定 submit 全部拒绝／UNKNOWN 授权。未穷举墙钟异常、跨进程持久节流及配置来源全链；也不从“没有按符号分桶”报错，因为旧实现相同。无新增候选。

### S02 — submitFailureLogging

**读取与 develop 对照：**current 全文 1–23；旧 `src/core/trader/orderExecutor/utils.ts:73–145`，含关键词识别器和完整 handleSubmitError。**不是旧 `src/core/utils.ts`**，后者没有这个交易错误处理函数。

**关键分支与差分：**

- current `:11–23` 参数只允许 `TradeSubmitResult` 的 `REJECTED`，单次记录 action、symbol、broker code、purpose 与原 cause 的格式化文本；不读 SDK 文本决定 retry、UNKNOWN 或可重提。
- 旧 `:79–98,109–145` 根据 short-selling／funds／network／rate-limit 文本选择日志，并在不支持做空时追加 warn。新版本不再保留这些文本分类日志。这是可见诊断差分，不能说输出逐字等价；旧函数这些分支本身也不执行下单或释放占用。

**直接生产调用方：**`src/application/orderExecution/submitFlow.ts:432–513`，`:498` 位于 response 已被判定 `REJECTED` 的分支；该调用不承接 ACCEPTED 或 UNKNOWN。请求分类、accepted 本地登记及 UNKNOWN fatal 属于外围 owner，已由原订单报告／异常二审负责，不在本轮重复推演或复跑。

**结论与未深入边界：**此文件确为日志职责而非第二套交易异常策略。未证明告警平台是否依赖旧短语，不将日志文案变化直接定为交易缺陷；logger 自身抛错与所有 SDK 失败源未重新注入验证。无新增候选。

### S03 — orderObservation

**读取与 develop 对照：**current 全文 1–99；旧没有独立模块，比较的是既有业务边界而不是虚构一对一旧文件：

- `develop:src/core/trader/orderMonitor/orderOps.ts:122–141` 的查询 terminal 缓存／ALREADY_CLOSED；`:496–500` cancel 成功只返回 CANCEL_CONFIRMED，明确等待 WS。
- `develop:src/core/trader/orderMonitor/eventFlow.ts:94–137,242–279` 权威事件关闭／结算调用；旧 `settlementFlow.ts:326–335` 最终移除 tracked、写 CLOSED、关 hold。
- 旧 lifecycle 是 OPEN/CLOSED 值；current 同一 Map 使用对象承载观测及结算元数据。**首 ACK 时间、一次 terminal 诊断确认及 duration 是新增观测，不宣称旧实现已有相同指标。**

**关键分支：**

- `:14–20` 读取本地时钟异常／非安全非负值变 null，仅缺省诊断时间，不补造 broker revision 或执行时间。
- `:24–30` 优先复用已有 lifecycle；无记录时依 closedOrderIds／trackedOrders 推导最低状态，不建立第二份订单登记表。
- `:34–41` 只写首个 ACK；即使时间无效写 null，也不拿下一次 ACK 伪装首次时间。
- `:48–75` terminalConfirmed 位在 diagnostics.record 前同步写入；observer 抛错被隔离，不能阻塞结算或覆盖原 fatal；不等价于 durable 成功、经济已消费或资源已释放。
- `:77–98` 只用首 ACK 与本地确认时刻计算 duration；缺失、相等、倒退或不安全差值均不造 0／负耗时；晚 ACK 不回补已经完成的配对。

**全部直接生产接入点（按模块）：**

- `orderOps.ts:129,235` 查询终态；`:544` 仅 `ACKNOWLEDGED` 调 recordCancelAcknowledgement。
- `eventFlow.ts:183,235` closed／tracked 权威终态准入后确认；`index.ts:390` 查询终态推进；`routeProcessor.ts:113,256,631` 跟进／超时权威终态；`recoveryFlow.ts:491` 恢复终态；`settlementFlow.ts:348` 结算入口再次幂等确认。以上均在 `src/application/orderTracking/orderMonitor/`。
- 状态消费核对了 `orderOps.ts:358,480–486`、`routeProcessor.ts:217`、`settlementFlow.ts:435–439`，仍使用 state 并展开保留观测元数据。
- `recoveryFlow.ts:108–124` 回滚仅重置 tracking；带 ACK／confirmed 的 entry 保留并将 state 置 null。`index.ts:675` 是全量 clear，不能混同恢复回滚。
- **不能遗漏的实际耦合：**`index.ts:759–805` 的 sell availability guard 捕获 symbol lifecycle，并在 `:792–795` 检查数量与对象身份。此模块的 `Map.set({...lifecycle})` 会更换对象身份，因此不能绝对声称“诊断元数据对任何业务 guard 都无影响”。guard 的保守失效不等于误结算或已证明交易缺陷。

**结论与未深入边界：**已覆盖全部 99 行及六个直接调用模块；既有业务边界与新增观测的区别明确。未对 ACK 恰好夹在 available 异步读取中间的所有交错重放，故不判 guard 的失效次数／重评活性等价；也未重审 closed revision／持久化失败矩阵。上述交错为 **not assessed 的边界，不是已确认 finding**；本轮没有形成新的、影响可定项的候选。

### S04 — routingIndex

**读取与 develop 对照：**current 全文 1–148；旧同名全文 1–147。完整 diff 仅一个空行；全文去空白比较相同。吸收 `audit-recheck-order-facts.md:129` 的已有深读证据，核实实际有效范围后引用，未为 D 数字重跑路由测试。

**关键分支：**

- `:19–28,41–45,69–80` 创建 route 初态；同 symbol 有状态就复用，重建时 generation 从独立 latest map 单调递增。
- `:54–60` 只取消本 route 持有的 timer；不枚举／清理整个调度器。
- `:91–100` Set 挂载及幂等 route 确保；`:110–133` missing bucket 是 no-op，仍有订单则保留 route，最后一个订单摘除才取消 timer 并删除 route。
- `:141–148` reset 清 routeStates 与 symbol bucket，**不清 latestRouteGenerationBySymbol**；旧异步 continuation 因而不能命中新 route 代号。不能为“彻底清理”擅自加清 generation 的简化。

**直接生产调用方：**

- `src/application/orderTracking/orderMonitor/orderOps.ts:480–486` track 后 attach；`settlementFlow.ts:431–439` 保留 tracked symbol 再 detach／删订单；`recoveryFlow.ts:124` 回滚 reset。
- `routeRuntime.ts:166–178` runtime 停用时清 route timer；`:202–238` timer 注册／旧 generation 验证；`:255–278` 异步 route 入口／返回后再次校验 generation。旧对应为 `develop:.../routeRuntime.ts:217–228,257–276`，该防护不是本次新发明。
- 静态搜索排除了同名误算：`src/runtime/tradingQuoteDisplayRuntime/routingIndex.ts`、`src/runtime/tradingRiskEventRuntime/routingIndex.ts` 是各自模块，不是本订单 routingIndex 的消费者。

**结论与未深入边界：**本文件所有运行分支与旧相同，没有发现应拆／应删的无用层。未模拟 timer.cancel 自身异常、极端 generation 数值耗尽或 processRoute 全部内部状态；不会把已有 routeProcessor 二审全部算本轮深读。无新增候选。

### S05 — tradeAudit/index

**读取与 develop 对照：**current 全文 1–94；旧 `src/app/runtime/createPostGateRuntime.ts:90–195` 的上下文过滤、action、reason、record 构造及同步 append。不是从仓储名字推定抽取等价。已核对 `audit-global-wiring.md:77`。

**关键分支及明确差分：**

- current `:19–31` 按 symbol／side／direction／价格／数量／时间次序短路；金融文本非法时 exactCompare 原样抛，不偷偷当缺失；数量、时间为安全正整数。
- `:50–58` 完整成交上下文后才校验 monitor；不完整外 monitor 事件先忽略，完整外 monitor 必须拒绝。旧同样是先 filter 后身份检查，但旧 `:100–107` 只用 isValidPositiveNumber，而非文本＋安全整数。
- `:34–42,60–78` 四种 action 保持；部分成交后 CANCELED／REJECTED 仍可落成交审计，记录 status=FILLED 且 reason 保留非 FILLED 关闭原因；原价格文本不转 number，数量转文本；protective 标识原样携带。
- `:87–94` 同步构造、同步 append，无 queue／await／第二账本或 completion；构造／持久化错误不吞。
- 旧记录 timestamp 在构造时隐式读取 formatter 当前时间（旧 `:171`），新由 listener 提交 recordedAt；新严格金融值边界与记录时点不能说逐点完全一致。

**直接生产调用方／输出：**

- `src/app/runtime/createPostGateRuntime.ts:438–452` 注入唯一 monitor、mixedTradeLogRepository.appendTradeRecord、formatter、clock、fatal handler，交给 S13 listener。
- 真实事件来自 `src/application/orderTracking/orderMonitor/settlementFlow.ts:443–454`；审计只消费结算事件，不反向决定 episode 是否完成。
- 顺带读取 `src/application/orderTracking/tradeAudit/types.ts:1–22`；运行时 guard 补足 string／number 类型没有表达的正值、安全整数不变量。

**结论与未深入边界：**同步 append／异常传播与过滤顺序得到源码支持；精度及严格校验差分如实登记。未穷尽 mixed log 的损坏、fsync／close／并发写入矩阵，也未重放重启恢复或判定合法 closed revision 应产生多少日志；这些不能由本文件全文推导。无新增候选。

### S06 — cancelOutcomePolicy

**读取与 develop 对照：**current 全文 1–47；实际旧源 `src/utils/trading/orderStatus.ts:1–46`，三个函数逻辑一致，仅文件头／类型导入迁移。**旧来源不是 `src/core/trader/utils.ts`。**

**关键分支：**

- `:10–20` ALREADY_CLOSED 拼 closedReason；RETRYABLE／UNKNOWN_FAILURE 拼 errorCode，只有 nullish 才用 UNKNOWN（空字符串不是被改成 UNKNOWN）；其他 kind 原样。
- `:28–34` CANCEL_CONFIRMED 或已确认 CANCELED／REJECTED 可停止重复撤单。
- `:42–47` 只有 ALREADY_CLOSED 的 CANCELED／REJECTED 才是非成交终态；ACK 和 FILLED 都不满足。不把名称 CANCEL_CONFIRMED 解释为 broker terminal。

**全部直接生产消费者：**

- `src/application/doomsdayClearance/index.ts:660–708` 用宽谓词统计请求已接受并停止继续撤买单，日志明确“终态以后续 WS 为准”；FILLED 另分支处理。
- `src/application/seatSwitch/switchStateMachine.ts:827–884` ACK／非成交 close／FILLED 分支后仍返回 order-and-freshness wait，不由该谓词直接宣称空仓。
- `src/application/orderExecution/submitFlow.ts:825–873` 普通卖单合并先拒绝 FILLED，再要求每个 outcome 满足窄谓词；未达非成交终态即 SKIPPED，只有通过后才 fresh read 和重算。

**结论与未深入边界：**policy 本体及本次直接消费窗口没有将 ACK 当结算。此结论不重新裁决末日专用 SELL 是否应先撤旧单，也不覆盖整个换仓阶段机或所有 outcome 的 SDK 形成来源；OE-003/V-C4已归并为B01，用户明确授权、非问题；异常分类维持其报告状态。无新增候选。

### S07 — orderAnalysis

**读取与 develop 对照：**current 全文 1–13；旧真实组合 `src/core/orderRecorder/index.ts:490–500` 的 createDailyLossOrderAnalysisDeps，另读旧 `orderFilteringEngine.ts:160–168` 工厂，确认返回的只有无状态 applyFilteringAlgorithm。**旧源不是 `src/core/utils.ts`。**

**关键分支／类型边界：**current `:9–13` 是三个能力的对象组合，没有隐藏分支或内部可变账：filteringEngine、resolveOrderOwnership、classifyAndConvertOrders。由旧的每次创建薄对象改为静态能力组合；不是第二个 recorder，也不带提交经济事实能力。`src/domain/order/types.ts:241–251` 明确只读依赖形状；静态对象并不等于所有内部算法本轮重新全审。

**直接生产调用方：**唯一静态装配使用为 `src/app/runtime/createPostGateRuntime.ts:162–181`，`:173` 展开注入 dailyLossTracker；实际消费包括 `src/domain/risk/dailyLossTracker.ts:543–555` 的归属判定、`:329–350` 的转换与 `:719–723` 重算。旧 tracker 同样注入这三种能力。

**结论与未深入边界：**对象抽取没有新增事实 owner、时钟、缓存或 IO。未重复审 filtering／ownership／recordPolicy 各完整算法、Daily completedBoundary 或历史重算；纯组合覆盖不把这些长模块自动升级。无新增候选。

### S08 — orderQuantity

**读取与 develop 对照：**current 全文 1–51；旧汇总为 `src/core/orderRecorder/utils.ts:70–85`；旧金额换数量为 `src/utils/numeric/index.ts:210–259`，调用为 `src/core/trader/orderExecutor/quantityResolver.ts:97–136`。两个职责均实际定位，不强求同名旧文件。

**关键分支与差分：**

- `:12–29` amount、price、lotSize 均须严格正；lotSize 还须整数。直接计算 `floor(amount / (price * lotSize)) * lotSize`，不足一手返回文本 0，不经过近似商或 number。
- 执行出口仍须 safeQuantityNumber；本 helper 返回文本本身并没有证明可安全转 number。
- `:37–51` 空集合得 0；每条数量必须安全正整数，累计后也检查安全整数。旧 `:77–84` 把非有限单笔当 0，并以 Decimal 累加，没有相同安全正整数拒绝规则。这是严格内部不变量／精度差分，不以“工具迁移”掩盖，也不凭孤立非法对象立即定为生产回归。
- 对合法正整数 lot 与精确实数预算，两版意图均向下整手；原 Decimal 分步运算／number 输入与新原文本直接商，不宣称边界值逐点等价。

**全部直接生产消费者：**

- `src/application/orderExecution/quantityResolver.ts:87–126` 先验预算／价格与安全正整数 lot，再在 `:111–113` 调 wholeLotQuantity 并 safeQuantityNumber；0 返回跳过。
- `src/domain/seat/switchPolicy.ts:65–78` 同样先验 lot／预算／价格，再安全转换用于回补数量；本轮仅核对这个函数，不重审整个席位 policy。
- `src/application/orderTracking/recorder/orderStorage.ts:386–427` 先排除 pending／exclude IDs，再排序、汇总及按授权上限整笔截取；`src/domain/order/orderFilteringEngine.ts:31–37` 与 `src/domain/order/executionProjection.ts:183–192` 在卖出扣减前汇总 eligible buys。

**结论与未深入边界：**没有建立金额／现金第二 owner。整数约束只对这些已成交订单及执行数量能力判定；未据此声称其他市场账户持仓也必须整数。未穷举 SDK Decimal 上下限、旧日志非法数据如何进入 record 及全部重建拒绝矩阵；既有等时投影候选不在本轮重放。无新增候选。

### S09 — orderRemark

**读取与 develop 对照：**current 全文 1–16；旧 `src/core/trader/utils.ts:41–69` 两个函数。新单输出与后缀判断逻辑一致；常量两版均为 `QuantDemo` 和 `|PL`（current constants:68–71；develop:73–76）。**不是 `src/core/utils.ts` 的职责。**

**关键分支：**`:5–9` true 才追加后缀；`:12–16` 必须 string 且 endsWith，不用 includes，不以价格／订单类型／更新时间补造身份；null／undefined 为 false。它是旧后缀契约，不保证外部人工订单的真实性，也不反推完整 historical purpose。

**全部直接生产消费者：**

- `src/application/orderExecution/submitFlow.ts:603,638–641` 末日普通 SELL 用 false，常规按 signal 的 liquidation 身份构造 remark。
- `src/application/orderTracking/orderMonitor/eventFlow.ts:199` closed observation 读原 remark；`recoveryFlow.ts:329,518` 启动跟踪／结算使用原单 remark。
- `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:104–117,138,577–588` 保护性 SELL 源索引／progress 校验／当日保护性记录筛选。已核对直接函数窗口，不将整个 rebuild 算深读。

**结论与未深入边界：**不新增 protective 身份推断，生成和恢复共用同一原协议。未穷尽人工改 remark、broker 截断／编码以及全量 progress 来源矩阵；这些无新证据，不提删除／加强协议建议。共享卖单跨 protective 扩量差异维持原审结论。无新增候选。

### S10 — orderTrackingPolicy

**读取与 develop 对照：**current 全文 1–129；旧真实源 `src/core/trader/orderMonitor/utils.ts:25–173`，另核对中性状态转换 `src/infrastructure/longbridge/trade/orderMapper.ts:170–254` 及 `src/domain/order/orderReadLifecycle.ts:8–14`。旧 orderStatusLifecycle 只是被调用的开放／终态分类，不是这七项 policy 的整体旧来源。

**七项规则逐一核对：**

1. `:20–34` 配置 timeout 与更新间隔秒转毫秒、阈值、BUY 追高开关保持；不在 helper 内新增配置 IO。
2. `:42–49` Date、有限且大于 0，与旧 resolveTimeMs 相同；旧两层 resolveUpdatedAtMs／resolveSubmittedAtMs 包装被合并，不由此补造执行时间。
3. `:57–73` FILLED→FILLED；CANCELED／EXPIRED／PARTIALLY_CANCELED→CANCELED；REJECTED→REJECTED；其余 null。原枚举 PartialWithdrawal 的中性映射确为 PARTIALLY_CANCELED，未把部分成交本身判为关闭。
4. `:81–88` WAIT_WS_ONLY 仍为 TEMP_BLOCKED_BY_STATUS 与 MAX_SAFE_INTEGER sentinel 双条件；不是“任意将来阻塞都只等 WS”。
5. `:97–107` 缺省 WORKING 对应旧 OrderStatus.New，非 OPEN 初态抛错，不把终态重开。
6. `:115–117` 固定 3 位由旧 number.toFixed 改为原文本 formatDecimal；后者是 half-even（`src/utils/numeric/exact.ts:200–207`），**不能说临界舍入与旧 JS number 完全一致**。
7. `:126–129` 原文本差值取绝对值，替代旧 SDK Decimal abs；返回值为 string，不是 SDK Decimal。

**全部直接生产消费模块与调用位置：**

- `src/application/orderTracking/orderMonitor/index.ts:92` 配置；`orderOps.ts:464` 初态、`:699` WAIT_WS_ONLY；`routeProcessor.ts:731` 同一能力判断。
- `eventFlow.ts:181,233` 与 `orderStatusQuery.ts:53` 关闭原因；`recoveryFlow.ts:150–151,179–180,320` 更新排序／真实 submittedAt。
- `routeProcessor.ts:742–779`：目标 symbol 与正 quote 前置；价差 `< threshold` 才跳过（等于阈值允许）；BUY 不许高于初始价时对两值按固定小数位比较。格式化在这里直接影响行为，不只是日志，故精度差分已明确保留。

**结论与未深入边界：**已完整核对配置、时间、状态、WAIT_WS_ONLY、初态、两项价格规则及六个调用模块；不重跑 mutation-error 二审。不以新测试／方案一般金融升级条款直接裁定所有 round-half-even 临界值均获业务授权；全部 broker 状态组合、配置校验和 602013／WAIT_WS_ONLY 后续解除状态机仍沿用原审边界。无新增候选。

### S11 — orderTypePolicy

**读取与 develop 对照：**current 全文 1–17；旧 `src/core/trader/utils.ts:120–141`。三条返回路径与旧相同，参数名／分支表达式抽取不改优先级。

**关键分支：**`:10–12` override 只排除 null／undefined，不按 truthy 处理；`:14–17` protective 必须 `=== true` 才取 liquidationOrderType，否则 tradingOrderType。无 SDK enum、下单请求、缓存或授权职责。

**直接生产调用方：**唯一直接调用 `src/application/orderExecution/submitFlow.ts:638–641`，解析 config 后映射执行类型并构造 remark。`:634–636` 的 DOOMSDAY_CLEARANCE 在此前进入专用分支，因此本 helper 的等价不能证明末日专用订单类型／撤单协议等价。

**结论与未深入边界：**该优先级等价。未重新穷举配置 decoder、OrderTypeConfig→broker 类型的所有映射或 signal override 的全部生产来源；没有为单纯短函数新增机械测试。无新增候选。

### S12 — smartClose

**读取与 develop 对照：**current 全文 1–50；真实旧 helper `src/core/signalProcessor/utils.ts:103–236`，不是旧 sellQuantityCalculator 的薄转发。核对 `audit-risk-account.md:173`，并读新 application 三阶段窗口。

**关键分支与差分：**

- `:9–24` 首先解析 currentPrice；costBasis null 返回 false；数量须安全正整数；成本严格正且 `currentPrice * quantity > costAmount` 才整体盈利，等于成本不盈利。显示均价不参与。
- 旧 `:138–145` 使用有限正 number 成本均价比较 currentPrice；因此精确交叉乘会纠正旧均价／二进制舍入的临界值，不宣称原输入空间逐点一致。
- `:27–40` 可用／已选均非负安全整数，已选超限抛错；旧阶段剩余额度是 `Math.max(0, available - stage2)`，新不再静默钳平内部超限。
- `:43–50` 两阶段共同受 available 约束后 safe sum；无 own ledger／占用写入。

**直接生产调用方及其必要上游：**

- 唯一消费模块 `src/application/ordinarySell/quantitySelection.ts`：`:131–153` 校验 available／时钟，从 recorder 读原成本并调 overallProfitable，整体盈利只选 ALL 后返回；`:182–196` PROFIT_ONLY 后计算 remaining；`:202–218` TIMEOUT_ONLY 限剩余额度并排除 stage2 IDs；`:226–228` 最终安全汇总和关联 IDs。
- 成本直接源 `src/application/orderTracking/recorder/orderStorage.ts:147–156` 每次计算成本金额／数量，没有均价第二缓存；可卖单由同 owner 的 `:386–407` 排除 pending／已选 IDs 后选出，不由本纯规则预扣 broker 可卖。

**结论与未深入边界：**三阶段顺序／整笔关联不因 helper 抽取而换序；金融精度和严格超限错误是明示差分。原 OE-001 的成本缺失消费者影响不在这里重放或重复计数。未重审 timeout 交易分钟／午休／半日历、浮亏门禁、所有仓位刷新竞态及非法内部阶段结果的全局处置。无新增候选。

### S13 — orderTradeAuditListener/index

**读取与 develop 对照：**current 全文 1–25；旧 `src/app/runtime/createPostGateRuntime.ts:443–459` 的内联 listener 与 cleanup。旧同步 try/catch/fatal/rethrow 边界没有变成后台 Promise。已核对 `audit-global-wiring.md:77`。

**关键分支：**

- `:14–24` 创建时立即订阅；收到事件才逐次读 now，并在同一栈调 audit；返回事件源原始 unsubscribe，无第二队列、提前取消或自持 cleanup。
- `:18–20` 捕获 audit／clock 异常，先 reportFatalError 再 throw 原 error。未加“日志失败可以忽略”的 fallback；reportFatalError 自身若抛错没有额外保底，旧同样如此，不作为新回归。
- 新 listener 为每个事件先读时钟，即使之后 audit 因上下文不足过滤；旧只有完整记录构造至 timestamp 才隐式取时。这个取时点差分得到登记，不把同步协议保持夸大为时钟读取次数相同。

**直接生产调用方：**`src/app/runtime/createPostGateRuntime.ts:438–452` 唯一创建点，注入 monitor.onOrderStateChanged、S05 audit、clock.now、termination.reportFatalError，并原样登记 `UNSUBSCRIBE_TRADER_LISTENER`。顺带读取 `src/runtime/orderTradeAuditListener/types.ts:1–11`，能力契约没有拿完整 trader／账本／cleanup。

**结论与未深入边界：**订阅、同步持久化失败传播与 cleanup 阶段保持。未穷尽 termination.reportFatalError 自身失败、事件源多 listener 顺序、所有 shutdown 交错、生产时钟不可用和仓储故障矩阵；这些不由本文件 25 行证明。无新增候选。

## 3. 七维审查与验证边界

| 维度 | 本续作完成项 | 未据此宣称的内容 |
| --- | --- | --- |
| Implementation | 13 文件全部分支、状态写／返回、异常、固定旧来源及上述直接消费者 | 不重开既有 G4 全链或把所有相邻 owner 算 D |
| Project / Spec | 层间依赖、纯 policy 与 IO 分离、同步审计；精度／观测／严格校验差分显式登记 | 不以新注释、新测试或方案自述豁免用户的业务等价要求 |
| Type Design | 检查 REJECTED 的 Extract、readonly 能力组合、string 金融值及 safe integer 的运行时补足；定向读直接依赖类型 | 不声称大型 types 或所有消费者的穷尽类型审计完成 |
| Tests | 只定位既有测试及标题，以区分可复用证据与空白；本轮零执行 | 标题不是断言全文，静态命中不是 pass；未读／未跑的测试不能作结果 |
| Comments | 核对 ACK≠terminal、diagnostic confirmation≠settlement、精确比较≠显示均价等关键契约与代码 | 没有把陈旧 Decimal 术语或文字顺序作为新交易缺陷 |
| Dead Code | 对目标模块导出做固定 HEAD 的生产符号／导入搜索，追踪薄对象和注册回调的真实装配；同名 routingIndex 去歧义 | 不将无独立同名测试等同 dead code；未穷尽外部／动态协议，所以没有 A 级删除主张 |
| Simplification | 确认 route generation、observer 占位、窄 cancel 谓词、同步 listener 各有直接职责 | 未为了行数或覆盖数建议删除安全边界、合并事实 owner 或额外抽象 |

### 3.1 测试只读定位清单（不是新执行记录）

- `tests/application/orderTracking/orderMonitor/orderObservation.business.test.ts:146,191,252,272`：标题涉及首次 ACK、terminal 先赢、observer 抛错与恢复回滚；本轮只提取测试入口标题，不重读／重跑原链路。S03 的 availability guard 对象身份交错没有因此被判已覆盖。
- `tests/application/orderTracking/orderMonitor/routingIndex.business.test.ts:52,74,103,114`：标题涉及 attach／detach／generation／reset；已有二审深读证据复用，不重跑。
- `tests/application/orderTracking/tradeAudit/index.test.ts:98,139,161`、`tests/runtime/orderTradeAuditListener/index.test.ts:33`：标题涉及上下文过滤／monitor／原金额文本／订阅时钟 unsubscribe；不把标题匹配等同完整错误矩阵保护。
- `tests/domain/order/cancelOutcomePolicy.test.ts:11,33`、`tests/domain/order/smartClose.test.ts:10,18`、`tests/application/orderTracking/recorder/orderAnalysisBoundary.test.ts:49,95,101`：仅定位既有单测，不添加、执行或依据它们反推业务需求。
- 其他小 policy 没有直接函数名测试命中并不证明缺测，更不证明无人消费；可能通过执行器／monitor 集成覆盖。本轮不为覆盖数字重新运行任何测试，也不把 architecture baseline 清单的字符串引用算业务验证。

## not assessed

1. 原候选 OE-001／002／005 的新独立裁决以及 OE-004/V-C1 授权裁决；本轮未重放，沿用各自最新具名报告。OE-003/V-C4已跨G5归并为B01，且用户明确授权、非问题；此次仅同步该分类，不改变覆盖与验证事实。
2. S03 lifecycle 对象身份写入与 fresh-available guard 的全部异步交错、重评活性；当前只有源码边界证据，没有新增可定项影响证明。
3. 全量 SDK broker 错误码、未文档化推送／查询时序、时钟故障及所有中性状态组合。
4. 仓储 append 的磁盘／fsync／close／并发篡改全矩阵，重启后完整财务后果，所有 listener 的全生命周期时序。
5. 精度／严格校验在旧 number／SDK Decimal 边界值上的全输入等价及本轮授权。本文已登记具体差分，未作“方案写了即已授权”的结论。
6. §3 的其余 9 个 E/B 项、大型 types 全部消费者、整仓 dead-code 动态／外部出口穷举。本文 D 不覆盖这些。

## recommended next actions

1. 主代理将本报告的 **S01–S13** 作为原账本 §3 对应 13 项的 D 补证；保留旧首审账本原始深度，增加“本续作补齐”的来源，不回写成首审当时已全文读完。本续作没有修改原账本。
2. 原 G4 首审 34D／18E／11P 中，这 13 个 E 现在具备补充 D 证据；机械相加可表为 **47D／5E／11P**，但这只是与首审账本叠加，不是全局最新去重统计。余下 5 个原 E 为 tradeMutationErrors、executionPolicy、orderReadLifecycle、orderSnapshotPolicy、quoteReadiness；其已有二审证据由主代理归并，不由本轮重复安排测试。
3. §2 的 `tradeAudit/types.ts` 与 `orderTradeAuditListener/types.ts` 原本因直接实现消费者缺 D 而未闭环：S05／S13 现在提供相应消费者 D；同时这两个小类型文件已定向全文核对。主代理可补链接，**不顺势升级其他 P 级 types 或整条订阅／仓储链**。
4. 保留原审发现的独立二审／授权流程。若后续专门调查 S03 guard 交错，应先检查现有 submit 重新评估 owner，再决定是否需要新增最小验证；不要因本报告写了 not-assessed 就直接记作缺陷或为了覆盖数字重跑全套测试。

---

### 交付前最终静态核对

- 从原账本 §3 机器提取 G4 的 13 个路径，与本报告覆盖表逐项比较：**13/13、唯一项 13、missing=[]、extra=[]**；13 个明细节齐全，源文件有效行数合计 797，每项范围与固定 current 文件一致。
- `git rev-parse HEAD`：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；`develop`、`origin/develop`、`FETCH_HEAD` 均仍为 `6e239c8a128372bd9b2fb2d79464346792a5e81e`。
- `git status --short` 输出为空；只新写本指定 TEMP 报告，未修改原账本或仓库。
- 上述是报告一致性／版本／状态核对，**不是执行订单测试、probe 或生产函数验证**；本续作新增测试执行数仍为 0。

本文件是只读证据补充，不是源码／测试／配置／方案修复。
