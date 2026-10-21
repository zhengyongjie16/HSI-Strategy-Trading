# 方案／授权边界与业务漂移登记册

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

## summary

- **结论：不能把“符合当前方案”与“相对 develop 业务等价”合并成一个结论。** §1.1 本来就包含超出纯架构迁移的明示业务例外；另有在后续提交中连同源码和测试一起改写的方案条款，以及没有找到针对性方案依据的变化。
- 本册只做最后分配的**方案、范围与授权对照**，不重做 G1 首审、不重审 LC-01。LC-01 已交 infra-config 独立复核，本册不声称二审已完成、不预判其结论。
- 固定 current `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop / origin/develop / FETCH_HEAD `6e239c8a128372bd9b2fb2d79464346792a5e81e`。下文未标 `develop:` 的方案行号均指 current 固定 SHA。
- 主方案：`docs/architecture/architecture-refactoring-implementation-plan.md`，下文简称 **P**。仅为解释优先级和核对特定条款，定向读取 `docs/architecture/architecture-refactoring-design.md`，简称 **D**。未读取无关 docs。
- 领域行为证据沿用已落盘 `audit-validation.md`、`validation-peer-review-request.md`、`audit-seat-selection.md`、`audit-lifecycle.md` 的对应节，并对必要源码片段和 Git diff/blame 重新核对。**领域报告中的候选状态不因本册转为最终缺陷。**
- 本续作没有新增或运行测试，没有运行 type-check/lint，也没有修改源码、原方案或既有领域报告；仅创建本册。

### 两个必须分开的判定轴

1. **实现轴：**是否存在实际行为差分、是否违反明确业务契约、独立二审是否完成。安全收紧也可能改变行为，但不能仅凭差分就称实现 bug。
2. **范围／授权轴：**方案是否明写该变化、何时写入、是否为明示例外；是否有本轮用户直接授权。方案中的“用户已确认”“受控修复”“验收通过”都是仓库中的陈述，**不等同于本轮可验证的用户授权证据**。

初审以用户“不能业务偏移”的要求为准；用户现已直接确认B01为授权业务改动，该项不作为问题或阻塞。此确认仅针对B01，不自动扩展到UNKNOWN、精度及其他业务变化；其他范围仍按原登记处理，不能仅凭方案自述豁免。另一方面，本册不会要求恢复不安全的重提、虚构空仓、丢失事实、过卖或带病放行。

## 分类定义

| 标记 | 含义 | 不能据此推出的结论 |
| --- | --- | --- |
| **A：§1.1 明示例外** | 顶层目标把它明确从“保持既有业务”中列出，且有具体边界 | 不自动证明本轮用户授权、不证明实现符合全部边界 |
| **B：仅后文／一般条款／新测试** | 有具体后文政策或一般描述，或只有新增／反向测试 oracle；未找到针对该差分的顶层明示例外 | 后文与测试不能自行改写 develop 真值；不是全都属于实现 bug |
| **C：与保留条款冲突** | 差分无法落入明示例外，且与明确保留的执行、失败或恢复协议不一致 | 不是“立即回退旧危险行为”的建议；仍需安全、经授权的业务裁决 |

B 与 C 不是互斥：一个变化可能被新测试固定，同时违反保留条款。下面特别区分“有具体相反条款”与“仅违反顶层保持语义、没有针对该分支的具体豁免”，不把一般措辞夸大为精确专条。

## 1. §1.1 明示例外清单与边界

### 1.1 顶层原句

**P:31-37（§1.1）**，核心为 **P:33**：

> 除本文明确列出的事实一致性修复、下述 submit UNKNOWN 决策、共享卖单跨 protective 扩量修正及 §4.4 的金融精度升级外，保持现有港股日内交易业务语义、订单事实语义、生命周期安全门禁和恢复协议。

固定 develop 的同段为 **`develop:P:27-33`**，核心在 `:29`；UNKNOWN 在 `:31`、protective 隔离在 `:33`。这些明示例外不是在本轮审计后才首次出现。

| 明示例外 | 精确条款 | 允许的方案内变化 | 不属于该例外的扩张 |
| --- | --- | --- | --- |
| **“本文明确列出的事实一致性修复”** | P:33；snapshot/ready 目标 P:39-47；具体幂等/覆盖 P:824-828；保护性唯一提交 P:13,74,1222-1234 | 按明确列出的场景修复 canonical 写入、旧代次提交、ready 提前、重复经济投影及 owner/事务多点提交等具体缺口 | 不是“任何看起来更安全的新政策”通行证。必须指出具体修复条款、旧缺口、最小行为变化；不能以此概括过期计数重置、普通换标不合并、明确拒绝升级 fatal 或所有边界修订 |
| **submit UNKNOWN 失败策略收敛** | **P:35**；P:1346-1353,1366-1368；D:771-786 | 末日 submit 结果不可确认时不再专属刷新／重评估，抛原错进入既有 fatal/cleanup；不自动重提 | P:35 末句明确不改变 cancel/replace ACK、终态确认、602013、WAIT_WS_ONLY；更不包含**明确 REJECTED、尚未 ACK、零可卖量、旧单取消释放或无效报价** |
| **共享卖单跨 protective 扩量修正** | **P:37**；P:1389-1393、1824-1831；D:825-836 | 非 protective 新量遇已有 protective 单时禁止扩量 REPLACE；保留旧单身份，沿可信撤单终态／结算／最新可卖量重规划 | **P:1390、1829 明确保留普通非 protective、同类型、可改单旧单的原合法 REPLACE**；不能泛化为所有旧 SELL 不合并，也不授权把回补预算改成只算本次新 ACK |
| **金融精度升级** | **P:33 → §4.4:454-484**；P:7,14,17；§13.4.2 P:1834-1847 | 金融 facts/状态/计算保真，精确整数商、比率交叉乘比较、显示一次 half-even，受控修正旧浮点临界差异；明确金额配置范围 | 不改原数量政策、费用、关联归属、时序、恢复准入、失败分类、技术指标算法或 V1 schema/ID。不能用精度需求解释 SELL operation 范围、冷却计数或封存边界准入政策变化 |

### 1.2 文档内部的“确认”记录，不是本轮授权证明

- **P:7** 明示“金融精度重构已纳入同次架构重构”，并指明旧 D §8.4 的冻结转换位置只作迁移前基线；**P:11-19** 存有“用户已确认全文及精度解释”“本轮只修改文档”等记录。
- **P:14、17** 记录精度原话及补充口径；`git blame` 表明该两行当前内容最后由 **`6e239c8`**（2026-10-08）更新。P:7、33、35、37 追至 **`0071a6e2`**（2026-10-02），它是 develop 的祖先；protective owner／相关细化还有 **`8121d76d`**（2026-10-03）。
- 上述历史只证明：**方案文本在重构前已含这些例外及确认自述**。初审未取得独立授权证据；后续用户已直接确认B01授权，故撤销该项待授权结论，其他范围不据此扩大。
- **P:5** 也明说计划条文本身不作为完成证明；任何后续“已完成／已验证／用户已确认”措辞不能替代实际行为和授权证据。

## 2. 逐项登记总表

| 项目 | develop → current 的核心差分 | 方案等级 | 与方案关系／登记结论 |
| --- | --- | --- | --- |
| **LC-D1 UNKNOWN fatal** | 末日 UNKNOWN 专属刷新并重评估 → 原错 fatal/cleanup | **A** | §1.1 明示且承认旧路径不同。是**方案内非纯架构业务变化**，不是据此发现实现违约；本轮授权仍不可由文档自述推定 |
| **精确数值收口** | 混合 number/Decimal → 金融保真文本／精确状态及运算；临界错误按目标修正 | **A** | §1.1、§4.4 明示升级，P:7 明确覆盖旧 D §8.4。符合具体边界的变化不报“违反当前方案”，但不能宣称与 develop 每个数值结果相同 |
| **V-C4／B01 末日保留旧 SELL** | 先撤旧 SELL、等权威终态后读可卖 → 保留旧 SELL，直接按 available 新增 | **用户直接授权；非问题** | 当前 P:1360 明写新策略，`8fd0eef` 同步修改源码、方案和oracle；用户已确认授权该业务改动，不列major或验收阻塞，不要求恢复旧协议。与develop的差分仅作历史记录 |
| **V-C5 过期冷却恢复** | 先恢复触发计数、后判冷却已过期 → 过期周期连计数一起不恢复，下一完成从零累积 | **B：新增测试/实现注释** + **C：恢复保持条款冲突** | 两份指定方案未找到过期周期清计数的针对性条款；P:33、1228、1393、1830 要求既有恢复／阈值规则保持。不是已找到一条“过期必须恢复旧计数”的专条，而是没有获豁免的恢复结果变更 |
| **V-C1 封存边界前同量高 revision** | Daily 拒绝、无 durable → 权威准入及 durable；经济投影仍冻结 | **B：一般修订条款支持，不是具体边界例外** | P:828、927、1844、1864 描述合法同量修订，但未明确把“已完成保护边界前原 SUPPRESSED”改为 ADMITTED。不能据一般条款确认授权；**也不能仅本册断言与每条修订条款直接冲突或定为实现 bug**，保留边界解释/范围差异待领域二审 |
| **G3-C1 独立 SELL／回补范围** | 合法普通旧 SELL 可 REPLACE 并按该操作预算回补 → 独立新 SELL，仅本次 ACK/后继预算 | **B：新增代码/测试政策** + **C：普通 REPLACE／换标保留协议冲突** | 未找到针对距离换标的此项新政策；P:1390、1829 保留合法普通合并，P:1306-1331 保留 policy 区分与既有副作用/回补顺序。protective 例外不覆盖“旧、新都是普通 ELO”反例 |
| **G3-C2 一次性决策及余仓 fatal** | 未成功 ACK 时的原等待/重试或局部失败 → 拒绝/零可卖/旧操作释放/坏报价也关闭卖出决定，正余仓全局 fatal | **B：新增代码/测试政策** + **C：既有失败/重评估协议冲突** | 未找到针对普通明确拒绝、旧单释放余量或无效报价的“直接全局 fatal”条款；P:35 只针对 UNKNOWN，P:77 区分外部与内部失败，D:1038 明确 REJECTED 与 UNKNOWN 不同。**保留正持仓旧 owner 是安全改进；升级 fatal 是另一项业务决策** |

## 3. 各项证据、历史与范围裁决

### 3.1 V-C4／B01 — 已授权末日策略变更（非问题，保留历史差分）

**实际差分及领域来源**

- `audit-validation.md:144-152`、`validation-peer-review-request.md:21-27` 已列两版完整调用及 oracle。
- develop `src/core/trader/orderExecutor/submitFlow.ts:600-660`：查询 pending SELL、cancel，ACK 后待权威终态移除，再读仓/submit。
- current `src/application/orderExecution/submitFlow.ts:575-605`：注释和执行均为不处理旧单，capture guard 后读取 fresh available，有量则新 submit。
- 旧 `tests/integration/doomsday.integration.test.ts:377-525` 与新同文件 `:462-546` 是相反预期，不是路径迁移。current 的 cancel/replace 替身故意 throw，要求 available40 直接新增40，0 available 则不新增。

**方案精确对照**

- **`develop:P:1305`**：`末日清仓仍先处理旧待成交卖单，取得权威终态后再重新取可卖持仓。`
- **`develop:P:1307`**：保留既有成功条件下的 `orderRecorder.clearBuyOrders` 副作用，但不清除权威成交事实。
- **current P:1360**：改为 `不撤销、不修改、不合并任何已有 SELL`，只按 available 新增，全部占用则不新增。
- **current P:1362**：末日 accepted 不再 clearBuyOrders；**P:827** 同步删去“末日仍按原条件主动清理”的要求。
- **D:630** 也由“撤单终态等待等既有末日重评估不变”，改为“不以撤销旧 SELL 或等待其终态为前置条件”。
- §1.1 **P:35** 只授权 UNKNOWN 失败策略；**P:37** 的跨 protective 隔离修正要求可信撤单终态/重规划，不能解释成所有末日旧 SELL 都不处理。

**Git 归因——纠正单纯 blame 的误导**

- **`8fd0eefc8c7aa1da996e069b30f503e9ea2fe105`，2026-10-17 22:02:06 +08，`C1. 末日清仓把“持仓全部被旧 SELL 占用”误判为“无需清仓”`**：实际 patch 删除 `doomsdayAwaitingTerminalOrderIdsBySymbol`、`getPendingSellOrders`/cancel fanout 和 `WAITING_FOR_AUTHORITATIVE_TERMINAL` 分支；同时修改 P、D 和 doomsday integration。
- `git log -S "WAITING_FOR_AUTHORITATIVE_TERMINAL" develop..HEAD -- <两版 submitFlow 路径>` 锁定这一提交；P:1360/1362/827 的 blame 同为 `8fd0eefc`。
- current 留下的 helper／submit 调用部分行仍 blame 到旧 `3ed3517`，**不能由保留下来的行归因被删除的撤单协议**。`audit-validation.md` 对“较早 3ed3517 等”的表述在此细化：不撤旧 SELL 这一行为反转，应归到 `8fd0eef`，不是 `2b67d36`。

**登记结论**

这是**已由用户直接确认授权的业务政策变化**。当前实现与 P:1360 的“保留旧SELL、仅新增available”策略一致；相对develop及旧P:1305的差分保留为变更历史，不构成问题、major或验收阻塞。原“缺少授权、需裁决或恢复旧策略”的结论撤销，无需再次取得B01授权；本次授权不扩展至F06换标预算或F07失败策略。

### 3.2 V-C5 — 新增过期周期重置行为，未找到针对性方案依据

**领域证据**：`audit-validation.md:154-162`、`validation-peer-review-request.md:29-35`。

- develop `src/services/liquidationCooldown/tradeLogHydrator.ts:61-77` 先 `restoreTriggerCount`，再判断旧冷却是否到期。
- current `src/application/protectiveLiquidation/tradeLogHydrator.ts:66-85` 在 restore 前 early continue；`:66` 注释明确“已结束的冷却周期不恢复起点或旧计数”。
- 已有领域探针采用相同日志：10:00/01/02 三次完成、limit3、5min 冷却，10:10 重启，两版当时 remaining 均0；下一次保护性完成 develop remaining300000ms，current 0。**本册不重新运行该探针**。
- 新增 `tests/application/protectiveLiquidation/tradeLogHydrator.business.test.ts:51-96` 固化重启后重新数满3次。新测试证明新目标，不证明旧行为等价。

**方案**

- P:33 要求恢复协议保持；**P:1228** 要求继续按 durable progress/completion boundary/累计基线恢复；**P:1393、1825** 表明冷却仍按原阈值及既有完成顺序；**P:1830** 要求完整 loader/cooldown hydration 按原精确事实恢复。
- 定向搜索 P、D 的“冷却过期/过期冷却/restoreTriggerCount/计数周期/冷却周期/触发次数”，未找到过期 cycle 丢弃旧 count 的业务例外。两文中的“过期”主要是 epoch/generation/seatVersion，不可拿来授权冷却计数重置。
- 不把“从日志恢复”理解为任意重定义恢复出的状态；也不把这列为精度差异。

**历史**：新 early-continue 及新测试追至 **`846469108697252fe911b45294549c3446d97296`，2026-10-14，P3**；不是 d2aa590 或 2b67d36 的新引入。

**登记结论**：新增测试＋代码明确表达的新业务规则；**与保留既有恢复结果的总约束冲突，未找到针对性例外**。这可能是在修旧冷却缺口，但“旧实现有问题”与“本轮获准修改”必须分开；不擅自决定恢复哪一套交易阻断时长。实现是否存在额外错误及二审结论沿用风险领域报告，本册不升级候选状态。

### 3.3 V-C1 — 一般“合法金额修订”条款不等于明确废除封存前准入抑制

**领域证据**：`audit-validation.md:132-142`、`validation-peer-review-request.md:5-14`。

- develop `src/core/riskController/dailyLossTracker.ts:975-977` 在合并事实的执行时间不晚于已完成保护边界时返回 false/false，发生在 durable callback 之前。
- current `src/domain/risk/dailyLossTracker.ts:882-951` 移除该准入抑制；`:930-949` 仍可 durable 和发布权威事实；冻结的是经济投影，并非所有权威/durable 状态。
- `tests/domain/risk/dailyLossExecutionBoundary.test.ts:20-52` 由 SUPPRESSED/false/durable0 改为 ADMITTED/true/durable1；recorder boundary 和 settlement 测试也改了 oracle。两版 loss 均0不代表权限、持久化或后续恢复等价。
- 领域报告已特别提示：develop 本地 recorder/refresh 的执行次序不完全跟随 Daily 返回，**不能夸大成旧整条 O/H 都不变**。

**方案相容部分**

- **P:828、927** 允许合法同量高 revision 的金额/时间/阶段修订；强调不把修订当新增成交、不重复经济副作用、tracking 关闭不能屏蔽合法事实准入。
- **P:1844** 的精度验收也要求“数量不变时合法权威金额修正仍生效”；**P:1864** 要求完整已消费输入及原过滤规则。
- D:185、1073-1075、1167 等存在相应的事实单调／经济覆盖区分。这些描述是实在存在的，**不能说方案完全没有提金额修订或只有新测试**。

**未被具体写明的扩张**

- 在这两份指定方案中，未找到“已完成保护边界前原本被抑制的同量修订，现在必须重新权威准入及调用 durable”的专门例外，也没有“边界仅冻结经济投影”的明确政策变更句。
- 上述一般条款有“合法”“原规则”“持久化与错误语义保持”的前提；旧边界抑制决定哪些事实仍有资格进入。不能循环论证：先把旧 SUPPRESSED 改为“合法”，再用“合法修订仍生效”证明获准。
- P:1836 又要求分开报告“原有效行为保持／旧浮点受控修正／历史冲突恢复阻断”。该准入和 durable 调用次数差分不是仅仅修一个浮点末位。

**历史**

- **`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`** 的实际 patch 删除 `currentBoundary` 的两处 SUPPRESSED 分支，并在同提交更改上述测试；不是只移动目录。
- P:828 等一般修订文字的主要来源是重构前 **`0071a6e2`**，已存在于 develop 方案；`2b67d36` 并未新增针对该边界的授权条款。

**登记结论**：**B——一般后文能支持“保留合法权威修订”的架构方向，但不足以明确授权这个特定边界扩张**。这与 V-C4 不同：没有找到一条精确后文把旧边界 policy 反写成新 policy。需交领域二审区分事实修复、边界政策和恢复影响；本册不把它判为“明确违反所有修订条款”，也不建议删除合法权威修正或恢复任何不成立的时间假设。

### 3.4 G3-C1 — protective 隔离例外不能扩大为合法普通旧 SELL 的全面隔离

**领域证据**：`audit-seat-selection.md:27-51`。

- current `src/application/orderExecution/submitFlow.ts:643-665` 对 `executionOrigin==='SWITCH_MOVE'` 绕过普通合并；明确“不撤、不改、不合并”。
- `src/application/seatSwitch/switchStateMachine.ts:1193-1205,1379-1403` 只用本次新 `sellOrderId` 及后继操作的金额回补；`src/domain/seat/types.ts:156-174` 定义相应预算 identity。
- develop `src/core/trader/orderExecutor/submitFlow.ts:708-833`、`src/core/trader/utils.ts:160-229` 可把普通旧单余量与新量做合法 REPLACE；旧 switch 状态机 `:1008-1046,1215-1229` 按该实际操作金额回补。
- 领域反例排除了 protective 身份：旧100、普通 ELO pending60、available40，正常 permit/关联条件下旧可合并为100；current 另发40，只认新操作预算。价格2→下一标1时预算/回补200对80，不是数值误差。
- 新 `tests/integration/distanceSwitchIndependentSell.integration.test.ts:382-423` 固化独立 SELL40/BUY80，只能证明新政策自洽。

**方案**

- **P:37** 例外针对“跨 protective 扩量”，并特意要求“普通合法 REPLACE”继续保留。
- **P:1390、1829** 更具体要求非 protective 普通同类型可改单旧单仍可 REPLACE，不能扩大为禁止全部合单；D:829-831 也保留其他既有合单限制。
- **P:1306-1323** 要求周期／距离 policy 显式、回补金额来源和失败规则清楚，**P:1330、1867** 要求换标交易副作用门禁顺序／既有移仓回补顺序保持。该“必须显式定义 policy”是重构契约，**不是允许自行选择新的 policy 值**。
- P:1390/1829 的直接场景是共享执行和静态 protective 隔离，不能只凭一行就声称它单独规范了每个 distance-origin。结论依据是它与 §1.1 保持换标业务的总要求、没有新 distance 例外、以及原共享规则被 origin 绕开的实际组合。
- 未找到独立 ACK 预算或禁止普通 SWITCH_MOVE 合并的对应条款；UNKNOWN、精度、protective 三类例外均不能覆盖该反例。

**历史**：独立 SWITCH_MOVE 分支、预算 identity 及独立集成测试始于 **`c36cadb2d7c1a424d9998b7b9db20f01d78819f9`，2026-10-18，`fix M3`**；后续测试修改不改变这一来源。

**登记结论**：**B＋C，属于没有找到方案授权、并与合法普通合并／换标保留协议冲突的业务变化候选**。是否最终认定实现 bug 应承接 G3 独立二审。不得用“保护性归属隔离已经授权”把普通旧单也一并隔离；也不建议把所有旧单金额无条件加到回补预算，旧单可能属于其他独立退出意图。

### 3.5 G3-C2 — 明确拒绝／余仓失败策略，不是 UNKNOWN 例外

**领域证据**：`audit-seat-selection.md:53-77`；同报告 V-C6 二审节对 fresh-positive＋invalid quote 的证据。这里只登记范围，不重跑实验。

- current `switchStateMachine.ts:904-916,961-979,1013-1021,1079-1085` 把旧操作带余量结算、报价失败、REJECTED／NO_AVAILABLE_QUANTITY 都收成一次性的 `sellSubmissionResolved`。
- `:1187-1189` 在权威总量仍正时 throw“禁止补卖或绑定新标，等待人工处理”；真实 runtime `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:668-676` 把它送到全局 termination，不只是局部换标失败。
- develop `src/services/autoSymbolManager/switchStateMachine.ts:884-901,941-957,981-1014` 的尚未 ACK、旧单释放可卖量、明确未成功提交及无效报价，分别走原卖出／等待重评估／局部失败。并非旧自己已 ACK 后的所有余仓也能重试，领域报告已排除该误报。
- 当前独立集成 `distanceSwitchIndependentSell.integration.test.ts:448-470,522-523` 固化新 fatal；新 oracle 不能充当需求批准。

**方案**

- **P:35** 限定 submit“结果不可确认”；**D:1038** 把 ACCEPTED、明确 REJECTED、UNKNOWN 分开。不能把“明确拒绝且没有 ACK”解释成 UNKNOWN。
- **P:77** 保留外部暂时失败和内部契约/不变量错误的不同语义；**P:1318-1321、1330** 要求换标失败/完成条件、交易副作用协议保持。D:916-918 保留各链路自身数量、门禁和重评估 owner。
- P:156-165 的内部错误优先、P:832/1285 的 activation 错误策略，**没有把普通未发单／旧操作释放／坏报价自动定义为内部契约破坏**。不能通过新增一个 Error/“invariant”注释获得业务授权。
- 未找到“卖出只准一次决定，凡正余仓均全局 fatal”的精确方案条款。

**历史**：一次性标志、REJECTED／NO_AVAILABLE 关闭决定及最终正余仓 throw 的关键代码由 **`c36cadb2`（2026-10-18）** 引入；与 G3-C1 同提交但业务影响不同，不等于都能由某个 M3 修复标题获得范围批准。

**登记结论**：**B＋C，尚未找到明示例外的失败／恢复协议变化**。必须拆成两件事：

1. 真实正持仓时保留旧 owner、不错误发布 EMPTY/新标，这是值得保留的安全约束；
2. 明确未发单、可解释拒绝、旧单释放或无效报价是否应关闭整个系统，是新的业务失败政策。

本册不建议去掉权威核仓或让正仓变 EMPTY，也不建议对 UNKNOWN 自动重提或恢复无界重试。应由主代理取得明确政策裁决，在真实 ACK／无 ACK／不确定／旧操作终态事实之间保持区分，并由相应领域复核验证。

### 3.6 LC-D1 — 方案内明示非等价，不能误报成“方案未提”

- 领域来源 `audit-lifecycle.md` 的 LC-D1；develop `src/main/timeWakeupEvaluationProgram/index.ts:453-496` 有 UNKNOWN 专属刷新事实、对账持仓订阅及重评估。
- current `src/application/doomsdayClearance/index.ts:769-771,827-829` 原错上抛；中性 UNKNOWN 错误不被普通 external API 分类接住，经既有 fatal/cleanup。
- **P:35** 直接承认“基线普通 BUY/SELL 已 fatal，但末日仍会刷新／重评估”，要求删特殊分支；**D:777** 同样明确承认，不存在“旧所有入口本来都 fatal”的等价性解释。
- 真正代码策略迁移追至 **`4a148b3b37ab9abe187c06edeec3a7bc35b1bc72`，2026-10-12，P0-P1**。Git patch 增加 UNKNOWN 原错直抛并删除 `refreshDoomsdayPositionFacts` 分支。不是 `2b67d36` 才出现。
- **登记：A；实现符合已写入方案的这项非纯架构目标，但与 develop 的末日失败策略不等价。** 本轮授权未由独立用户材料证实，不因 P 的“明确决定”措辞豁免。不能据此建议恢复不安全自动重提或撤销 fail-closed。

### 3.7 精确数值收口 — 明示升级有精确围栏，不能包办所有行为差分

**明确范围**

- **P:7** 将精度升级纳入同次重构，明确覆盖旧 D §8.4 的“保留旧 number 转换位置”；**P:33** 列为例外，**P:454-484** 定义终态。
- **P:460-464**：金融价格/金额/阈值保真；数量只有已证明 safe integer 可用 number，其他 Decimal/文本或沿原契约拒绝；时间/版本保留 number；技术指标 number 算法不全量升级。
- **P:469-474**：金融中间状态不经有损 number，基础加减乘/比较精确；只输出按既定位数一次 half-even，不统一把输入和状态压成三位。
- **P:478-482**：金额配置最多10位整数＋3位小数，超出拒绝；该限制不套 SDK/历史/派生回补预算；买量直接求 `A/(P×L)` 的精确整数商，保持名义金额不等式、原卖量/费用政策；均价保留金额/数量依据；比率精确等价比较。
- **P:1836** 要求分别报告“原有效行为保持”“旧浮点误差受控修正”“历史冲突/恢复阻断”；**P:1840-1848** 给出 BUY/SELL/换标、临界阈值、V1 文本及技术指标边界，明确不要求错误旧浮点决策相同。

**文档内部表面矛盾的正确处理**

- **D:1056-1077** 仍保留旧混合 number/Decimal 冻结文字；不能只引这几行就把所有精确化判成“与方案冲突”。P:7 以明确的范围更新／优先级指向 P §4.4 和 §13.4.2，且这段覆盖声明已经存在于 develop 的方案 P:7。
- 相反，实施者不能引用“精度升级”自行改整数策略、全部市场范围、成交时间含义、统计触发计数、补仓 operation 归属、重试 owner 或 durable conflict 准入。**P:474** 保持时间/revision 择新和 OPEN/TERMINAL 规则，**P:479-482** 保持合法性／失败分类／原数量和费用政策，**P:1845-1846** 保持 V1 schema/ID及历史冲突拒绝边界。
- `7000/0.07` 保留100000股、不退化90000，与“以更精确目标修正旧浮点临界错误”要分别登记，不能一概叫业务漂移，也不能一概叫纯架构等价。

**历史与授权**

- P:7/33 的范围升级最早相关 blame 为 `0071a6e2`；精度解释的当前关键内容 P:14/17 在 develop HEAD `6e239c8` 已写入。其“用户已确认”是仓库中的记录，不是本册掌握的本轮直接批准。
- `2b67d36` 涉及 execution 驱动启动、数量/市场范围等修复，不能把其中所有事实准入变化都归为“精度当然允许”。具体经济算法及 adapter 全输入边界仍由领域审计负责，本册没有重新全量验证。

**登记：A，且只限明确围栏。** 符合这些围栏的精确化是方案明示的业务/数值范围扩张；在本轮“不能偏移”的要求下应单独列例外待裁决，而不是宣称逐结果等价。超出围栏则另按实现错误／未授权业务变化审查，不能靠新的数值测试豁免。

## 4. 必要 Git 时间线及证据强弱

| 提交 | 时间（+08）/主题 | 本册能证明的事实 |
| --- | --- | --- |
| `0071a6e2c2702af8cb62edee71879bd88c0e837c` | 2026-10-02，docs plan | P §1.1 例外、一般修订/普通 REPLACE 等关键文本的祖先来源；是 develop 祖先。不是用户授权原文 |
| `8121d76d7c7d99fcc389c92c70bd6f3f8020308f` | 2026-10-03，docs fix | protective completion 唯一 owner、完成顺序及恢复等细化；不包含过期 cycle 清计数或 distance 一次性卖出授权 |
| `6e239c8a128372bd9b2fb2d79464346792a5e81e` | 2026-10-08，docs fix；固定 develop | 已有精度范围/确认解释；程序行为仍作为本轮真值，不因同树计划描述未来目标而当成已实现 |
| `4a148b3b37ab9abe187c06edeec3a7bc35b1bc72` | 2026-10-12，P0-P1 | LC-D1 删除末日 UNKNOWN 专属刷新／重评估，直接 fatal |
| `846469108697252fe911b45294549c3446d97296` | 2026-10-14，P3 | V-C5 新 hydrator 在 restoreCount 前跳过过期 cycle，新增对应测试 |
| `8fd0eefc8c7aa1da996e069b30f503e9ea2fe105` | 2026-10-17，末日旧 SELL 占用修复 | V-C4 撤旧/等终态分支实际删除，P/D 反向条款、清买单副作用和新 oracle 同提交更新 |
| `c36cadb2d7c1a424d9998b7b9db20f01d78819f9` | 2026-10-18，fix M3 | G3-C1 独立普通 SWITCH_MOVE SELL/预算，G3-C2 一次性决定/余仓 fatal，及独立 integration |
| `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144` | 2026-10-20，fix；固定 current | V-C1 删除封存边界前两处抑制分支，并反转 boundary 测试 oracle |

**归因原则：**`blame` 只能解释留在当前文件里的行；对于已删除的约束，用 `git log -S/-G` 定位，再核实际 patch 和旧快照。提交名“fix”“review fixed”不证明无业务变化，也不证明获批。

## 5. 面向主代理的结论用语

### 应当说

- “相对 develop 已发现行为差分；其中 UNKNOWN 和精度是方案 §1.1 明示非等价目标，但本轮授权不能由文档自述推定。”
- “V-C4／B01的末日策略已由用户直接授权，非问题；`8fd0eef` 的源码／方案／测试差分仅作为已授权变更历史保留，不要求恢复旧策略。”
- “V-C5 没有找到过期重启清计数的针对性例外；G3-C1/C2 没有找到独立卖出/预算缩窄/明确拒绝余仓 fatal 的针对性例外，且与保留协议存在冲突。”
- “V-C1 有一般合法修订条款，仍未明确覆盖封存边界前准入与 durable 的这个特定扩张；需要领域复核和范围裁决，不能只凭新 oracle 判授权。”
- “保留当前权威事实、安全核仓和 fail-closed 约束；把重试/撤单/恢复/预算范围作为独立业务政策核准，而非机械恢复旧危险实现。”

### 不应当说

- “方案写了已确认，所以用户已经授权本轮全部变化。”
- “所有都是修 bug，因此不属于业务漂移。”
- “新测试通过证明和 develop 等价。”
- “UNKNOWN fatal 例外覆盖所有明确拒绝、坏报价和正余仓。”
- “protective 隔离允许普通旧 SELL 一律独立；精度升级允许改变 operation、时间或计数语义。”
- “要等价就应立即恢复正持仓 EMPTY、自动重提 UNKNOWN、去掉权威核仓或忽略历史冲突。”

## 6. 验证、范围及未评估项

- **本续作只读验证：**核对固定 SHA/status；读取指定 P/D 相关章节及上述领域报告相应节；按项查 `git blame --line-porcelain`、`git log -S`、`git show`；静态复核必要源码/测试的现有片段。**没有新建/运行测试或探针**。落盘后再次核对 HEAD/develop/origin/develop/FETCH_HEAD 均匹配固定 SHA，`git status --short` 为空。
- 实际定向读取生产片段：`src/application/orderExecution/submitFlow.ts`、`src/application/seatSwitch/switchStateMachine.ts`、`src/application/protectiveLiquidation/tradeLogHydrator.ts`、`src/domain/risk/dailyLossTracker.ts`，以及 Git 中旧对应文件和 UNKNOWN 时间评估分支。只为登记差分与历史，不冒充重新完成订单/风险/席位全域审计。
- 实际使用的落盘报告：`audit-validation.md:132-162`、`validation-peer-review-request.md:5-35`、`audit-seat-selection.md:27-77` 与其 V-C6 二审节、`audit-lifecycle.md` 的 LC-D1。本文没有修改这些报告；V-C4 历史归因的细化在本册独立记录。
- 七维适用性：implementation/project-spec/comments/tests 的证据与归因适用且已核对；type design 只识别 origin/resolved/预算 identity 表达的新政策，不做新类型审计；dead code 与 simplification 非本续作任务，未扩展审查。未把文档、测试注释或类型名当授权。
- 初审未获取独立于仓库文档的历史批准会话；后续用户直接确认B01为已授权改动，现已据此更新分类。其他事项的授权不能从B01推定。
- V-C1/V-C5/G3-C1/G3-C2 的最终状态沿总报告及独立二审；V-C4／B01明确为已授权、非问题，LC-01不重审。
- 精确数值完整实现、adapter 数量/市场范围、生产网络失败和实盘结果未在本续作重新验证。
- 指定模型模板保持为 `cliproxyapi/gpt-6.1-sol max`；环境未提供可独立核验的模型 ID/思考档位，不声称已技术验证模板生效。

## recommended next actions

1. 主代理汇总时把**当前实现缺陷**与**方案已有但超出纯架构需求的业务变化**分栏，保留各候选独立二审状态，不另起重复缺陷。
2. B01／V-C4已获得用户直接确认，保留当前末日策略及行为差分记录，不作为问题或待裁决项；UNKNOWN／精度及其他范围登记保持原边界，不从B01授权推导新的豁免。
3. 对 V-C1 的封存边界解释、V-C5 的重启计数、G3-C1 的预算 operation 及 G3-C2 的失败级别，依已有领域二审和用户直接决策确定安全目标；不把后文或新增测试当批准材料。
4. 不建议立即回退安全机制；若需调整，应保留可信事实／核仓／防重和已发生远端动作的收口，只在经批准的业务边界内修正共享根因。
