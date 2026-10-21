# 换标链路独立二次复核：G3-C1、G3-C2 与 V-C6

## summary

- **verdict：G3-C1 的回补预算缩减、G3-C2 的“首次明确拒绝／本次尚未提交时旧操作释放余量 → 一次性 resolved → 全局 fatal”均 confirmed，建议作为两个 major 问题阻断业务等价性结论。** 不把拆单形式本身判作缺陷，不要求复刻 develop 的危险 EMPTY，也不把基线 ACK 后原已停滞误报成新增丢失重试。
- **scope：** `D:/Code/HSI-Strategy-Trading`，current 固定 `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`，develop 固定 `6e239c8a128372bd9b2fb2d79464346792a5e81e`。独立阅读两版实际 submit、改单、tracking、terminal settlement、换标预算、REBUY、switch runtime、fatal 及顶层退出连接；未依赖上一报告的 helper 输出作最终结论。
- **confidence：high**（两项主要差分及 gate 关闭已离线端到端执行）；V-C6 的“零价直接穿过真实 quote adapter”生产可达性另列 insufficient。
- 加载 `lazy-senior-developer`、`code-review`、`typescript-project-specifications`、`core-program-business-logic` 四技能及 context-mode；读取 `AGENTS.md` 和指定实施计划相关条款。**没有修改仓库源码、测试、配置或方案。** 仅本 TEMP 目录写审计脚本、运行日志及本报告；最终 `git status --porcelain=v1` 仍为空。

### 逐项裁决

| 子项 | 裁决 | 独立结论 |
|---|---|---|
| G3-C1：合法普通非 protective ELO 合并／200→80 | **confirmed** | 用两版相同、允许 REPLACE 的空关联普通旧 SELL 跑完整链；都真实卖出金额 200，develop 回补 200 股，current 回补 80 股。拆单可以是实现选择，缩减回补范围不是纯实现差异。 |
| G3-C1：任意旧 SELL 都应合并／原 fixture 的 BUY-OLD=60 也必然回补 200 | **rejected** | 关联集合仅覆盖 60、却需 REPLACE 到 100 时，develop 本来拒绝改单。独立 negative control 已执行，不能把 helper 的 REPLACE 决定冒充最终 native 成功。 |
| G3-C2：首次 submit 结构化明确拒绝、无本次 ACK | **confirmed** | develop 有限重试后实际 SELL→settlement→REBUY 成功；current 一次 REJECTED 后核仓 positive 即 fatal，关闭全局 gate。 |
| G3-C2：旧普通 SELL 零成交取消释放，本次还没有提交 | **confirmed** | 首次 drive 前、candidate await 内取消两种窗口都执行；develop 实际首次 SELL 100、回补 200；current 没有发移仓 SELL 即 fatal。 |
| “develop 已 ACK 后取消也会重新补卖” | **rejected** | 控制组 develop 合法 REPLACE ACK 后再零成交取消，本来保持 SWITCHING/WAIT，并没有第二次 SELL。该既有停滞不计入本次新增重试回归。 |
| V-C6：positive 保留旧 owner、fresh flat 不卖不回补而完成 | **rejected，作为缺陷的指控不成立** | 这两项安全改善值得保留，不应恢复危险 EMPTY。 |
| V-C6：price=0 的工作流输入触发“未提交仍 fatal” | **confirmed（工作流／runtime 契约层）** | 两版相同 quote double 输入，current 的真实 workflow→runtime→termination 关闭 gate；develop 本地 FAILED/EMPTY 而非 fatal。归并 G3-C2，不单列第三问题。 |
| V-C6：实盘 SDK 零价原样成为 price=0 Quote | **insufficient** | 两版真实 quote client 都把非正 lastDone 变为 null，不能把绕过该 mapper 的零价 double 宣称为完整实盘路径。不过 **null/MISSING 持续到重试耗尽** 的同输入完整链也已执行，current 同样升级 fatal，故不是仅靠不可达零价场景才有主问题。 |
| submit UNKNOWN 致命与 protective 跨目的隔离 | **rejected，作为本次回归的混淆项** | UNKNOWN 控制组两版都 fatal；本次 C1/C2 的旧单均非 protective，未借受控 protective 例外主张恢复危险跨目的扩量。 |

## critical issues

None。本轮没有证明真实资金损失或需要直接定 critical 的事故；下列是已确认的核心业务差分／全局可用性回归，不以“测试全绿”消解。

## major issues

### G3-C1 — 普通合法卖单的真实卖出资金有 60% 被排除出换标回补

- **claim：** 距离换标把普通旧 SELL 和本次新量强制分成两个独立操作，并把回补预算限定为本次新 orderId／其 accepted 后继，导致相同旧仓、相同总成交金额下回补显著缩减。**只把资金范围变化判为缺陷；不把“不同 native 操作序列”自动等同不允许更优实现。**
- **evidence（current）：**
  - `src/application/orderExecution/submitFlow.ts:643–667`：`SWITCH_MOVE` 在通用合单之前分流，只为 broker 实时 available 新增 SELL；注释明确“不撤、不改、不合并”。普通合单仍在 `:670` 之后，`src/domain/order/sellMergePolicy.ts:48–66` 也仍允许普通同类型单张 REPLACE，但距离换标不经过它。
  - `src/application/seatSwitch/switchStateMachine.ts:1193–1205`：判断回补意图只累计 `state.sellOrderId` 的操作成员；`:1377–1393` REBUY 再按同一单／真实后继读 `costAmount`，没有计入等待的旧普通 SELL。
  - `src/domain/seat/types.ts:156–164` 的注释已把“ACK、拒绝、零可卖或报价失败”都设为一次性结束，并明示只有本次独立新增单提供预算；这是新语义的代码描述，**不是业务授权**。
- **evidence（develop，行号均属于上述固定旧 SHA）：**
  - `src/services/autoSymbolManager/switchStateMachine.ts:963–985` 以可用量构造 ELO SELL，交给真实 executor；`:1008–1014` 把 REPLACED/SUBMITTED 返回的实际 orderId 作为本次卖出身份。
  - `src/core/trader/orderExecutor/submitFlow.ts:708–730` 按实际 pending SELL 做通用合单；`:738–806` 在 mutation permit 内复核报价、旧单事实及关联数量，`:827–833` 更新 pending 数量后返回 `REPLACED OLD`。不是只执行 helper。
  - `src/core/trader/orderMonitor/settlementFlow.ts:645–674` 对 SELL 终态执行 `markSellFilled`、真实成交本地记录及累计执行登记；`src/services/autoSymbolManager/switchStateMachine.ts:1035–1046` 读取这张实际旧单的成交价×量，`:1215–1229` 用该预算按新价整手回补。
- **runtime path／同输入差分：**
  1. 两版共同初态：旧标总仓 100、available 40、普通非 protective ELO `OLD` 数量 60／已成交 0，关联集合为空；旧价 2、新价 1、lotSize 1，候选同一新标，交易门禁开启。
  2. develop 的真实 executor→monitor→native `replaceOrder(OLD, quantity=100, price=2)` 成功；当前真实 broker adapter 则 `submitOrder(NEW-1, SELL 40 @2)`，保留 `OLD 60`。
  3. 按每版实际生成的委托送同一“全部持仓以 2 成交”的 broker WS 事实：develop `OLD` 成交 100；current `OLD` 成交 60、`NEW-1` 成交 40。两版真实 recorder 最终卖出金额均 **200**，真实 settlement／freshness 均追平，最终 broker 持仓均空。
  4. 由两版真实 SwitchWakeupRuntime 消费 ORDER/FRESHNESS，后续相同新标 quote 推进 REBUY；develop 真正提交 BUY **200**，current 真正提交 BUY **80**，均落 `ACTIVATING`，没有 fatal。
- **impact：confirmed —** 此输入回补金额从 200 缩减为 80，少回补 120（60%）；资金留在现金，不是算术精度修正或成交价变化。没有据此断言实盘盈亏已经受损。
- **重要限定：** 上一报告当前 fixture `tests/integration/distanceSwitchIndependentSell.integration.test.ts:293` 原先把 OLD 关联到 60 股的 BUY-OLD。若原样照搬该元数据，develop 的 `submitFlow.ts:783–787` 会因关联集合不能精确代表 100 而拒绝 REPLACE，不能直接拿它证明 200。本轮把两版共同输入设为合法普通全仓空关联，并另跑 `linked` negative control；旧版 `submitFlow.ts:241–254` 明确允许空关联，不是去掉业务校验伪造反例。
- **minimal fix：** 保留 fresh available、订单事实 guard、protective 隔离及真实 terminal settlement。最短路线是让合法普通同类型旧 SELL 的移仓继续复用已有合单 owner，持有真实 REPLACE／新单身份并按其完整实际卖出资金回补。若独立拆单确实更安全，可保留拆单形式，但必须保持原合法移仓资金范围：只按已证明属于本次移仓的普通旧单和新单／真实后继逐笔汇总，避免重复、protective 混入或按 symbol 臆测；不能以“独立 owner”直接把原预算砍掉。
- **validation：** TEMP 探针 `c1` 已同时运行两版真实 executor、monitor、WS settlement、真实 post-trade freshness、switch runtime 和 native BUY；断言两边卖出金额 200，BUY 分别 200／80；`linked` 同时验证不满足整单关联时基线确实不改单。修复后应保留 positive／negative 两类验收，而不是把所有旧单都强行合并。
- **测试缺口：** 当前集成 `tests/integration/distanceSwitchIndependentSell.integration.test.ts:382–424` 把“旧单不动、BUY80”写成期望，证明实现被测到，不证明业务等价；缺少合法普通 REPLACE 的 develop 端到端经济 oracle 及预算保持断言。
- **dimensions：** implementation、project/spec、types、tests、comments；不主张额外抽象或风格性清理。

### G3-C2 — 没有本次 accepted 卖出也被永久结案，把正常拒绝／释放余量／行情失败升级为进程退出

- **claim：** `sellSubmissionResolved` 把本次 SELL 已 ACK 和“没有发生本次 accepted SELL”的多种预期结果混成同一不可重试终态；最终把 broker 仍有旧仓当作不变量破坏，触发全局 fatal。对于已经明确无本次 ACK、无在途移交且可重新按 fresh available 规划的场景，这不是防重提所必需的 fail-fast，而是失败策略和影响范围升级。
- **evidence（current）：**
  - `src/application/seatSwitch/switchStateMachine.ts:235–245,903–916`：任何本次等待旧 SELL 的 `SETTLED_WITH_REMAINDER` 都能在本次尚未提交时把 resolved 置 true；`:1056–1059` 还用相同条件阻断最终授权。
  - `:963–970,1015–1030`：无效行情／行情重试耗尽同样结束唯一一次决策；`:1079–1086`：首次 `REJECTED`／`NO_AVAILABLE_QUANTITY` 或旧操作余量也结束决策，而不是明确无 ACK 后重新评估。
  - `:1124–1174` 等原有／新生订单全部结算，重新读 broker positions、force-refresh pending 并复核 guard 后，`:1187–1190` 仅因 totalQuantity>0 就抛“禁止补卖…等待人工处理”；**操作列表可以为空，本次可以从未 ACK**。
  - `src/application/orderTracking/orderMonitor/settlementFlow.ts:304–348,389–402,431–443`：普通零成交 cancel/reject 真实释放 pending，标记 `settlementCompleted`／`settledWithRemainder`，这不是未知是否成交。`orderMonitor/index.ts:287–307` 在资源确已结算、没有 pending 后返回该状态。
  - `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:669–675` 把上述普通 Error 原样交 `termination.reportFatalError`；`src/runtime/lifecycle/terminationRuntime.ts:30–44,48–57` 锁存首错、同步关闭准入并请求退出。
- **evidence（develop）：**
  - `src/core/trader/orderExecutor/submitFlow.ts:579–586` 对结构化明确 broker rejection 返回 SKIPPED，UNKNOWN／其他错误仍抛出；`orderExecutor/index.ts:489–490` 仅 SUBMITTED／REPLACED 算已执行。
  - `src/services/autoSymbolManager/switchStateMachine.ts:981–1002` 无 orderId 的结果执行原有限行情重试，`sellSubmitted` 只在 `:1008–1014` 的 accepted 结果后置 true。
  - `:884–900` 在本次未 accepted 时允许按释放后的可卖量卖出；只有已经 `sellSubmitted=true` 的后续 positive 才本来 WAIT。`src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:624–653` 已有相同 fatal owner，**新差异来自业务状态机抛错，不是新 runtime 才支持 fatal。**
- **runtime path／同输入差分：**
  - **`rejected`：** 共同先把旧普通 SELL60 完整成交，broker 留仓 40/available40，旧操作为已完成而非余量；距离换标首次 native submit 结构化抛 `{code:601013}`，下次允许接受。develop 原状态机注册 2 秒重试，由真实 runtime 的 timer 重试并实际 ACK SELL40，再经真实 WS settlement／freshness、quote 回补 BUY80、ACTIVATING、gate 仍开。current adapter 正确分类 REJECTED、executor 返回该决策，但状态机即 resolved，fresh positive40＋pending空后抛错；真实 runtime 记录 fatal、gate=false、仍保留 OLD/SWITCHING。本次没有 accepted SELL，不存在 ACK 后猜测重提。
  - **`released`／`released-admission`：** 共同旧仓100/available40、旧普通 SELL60；在首次实际卖出前，或 candidate 搜索 await 内，真实收到 OLD 零成交 Canceled，broker 更新为100/available100，等待原 owner 真实释放。本次没有 issued SELL、没有 MO handoff、没有 UNKNOWN。develop 经同一 runtime 真正首次 SELL100，WS成交200元后 BUY200并完成；current 未发任何新 SELL，就因旧操作余量 resolved→fresh positive100→全局 fatal。
  - **V-C6 direct：** 没有未结旧卖单，工作流 quote.price=0，fresh positive40。develop 本地 FAILED/EMPTY、gate开；current 不清 owner 是正确改进，但进一步 resolved→fatal、gate关并无不确定提交依据。相同初始 canonical positive、执行前 broker 已 fresh flat 的 direct 对照，current 无 SELL／BUY、正常 ACTIVATING，这一安全改进没有被本报告判缺陷。
  - **生产对应的 MISSING：** quote double 返回 null/空 Map（与真实 mapper 非正价输出形态相同），两版真实 runtime 均按 2 秒间隔重试。第六次驱动达到 `MAX_ATTEMPTS=5` 耗尽，develop 本地 FAILED，不走 fatal；current 未产生任何 native 提交仍 fresh positive→fatal。具体零价实盘路径的限定见下文。
- **impact：confirmed —** 可恢复的首次明确拒绝、旧普通操作真实关闭，以及无本次提交的行情失败，使单方向换标扩成全应用退出。探针已执行真实 termination 的 gate 同步关闭和首错锁存；生产装配还把该 termination 绑定到两方向准入、队列和全部 producer：`src/app/runtime/createPostGateRuntime.ts:535–552`、`src/app/runApp.ts:66–103`，顶层 `:353–373` 等待终止、执行唯一 cleanup 并抛出原 fatal。未声称已在实盘触发，也未把本探针的少量 cleanup callbacks 说成执行了整个生产退出演练。
- **为什么不是必要兜底：**
  1. 明确拒绝在 adapter／旧 executor 中是“未被接受”的证据，不是 UNKNOWN；本次 accepted id 为空。
  2. 旧普通 SELL 的零成交取消释放在统一 tracking owner 中已经结束，没有原操作／MO移交争抢；随后又有 fresh broker 持仓、pending及 guard 复核。
  3. 席位继续 OLD/SWITCHING 已能阻断旧信号／新标交易。防误绑、保留 owner，不推出必须关闭另一方向及整个进程。
  4. 内部数量非法、事实矛盾、真正 UNKNOWN、本次 accepted 后的非预期余仓可以保留原严格路径；这不能授权把本次未 accepted 的明确业务拒绝也升级同类错误。
- **minimal fix：** 在同一 switch owner 内分清“已 accepted／结果不确定”与“确定未 accepted、允许重评估”。对本次无 ACK 的明确拒绝恢复原有限重试 owner；旧普通操作可靠释放后，按最新可卖量与原授权做**首次**移仓提交，不受其他旧单的 settled-with-remainder 永久否决。行情无效／重试耗尽可以继续阻止动作并保留旧 owner，通过既有 SYMBOL_QUOTE／timer／可观察本地阻塞处理，不应仅因正仓、零本次提交就抛全局 fatal。**不要简单删除核仓或把 throw 改成 EMPTY；不要无条件重置已 ACK／UNKNOWN 的防重提状态，也不要擅自扩大为 ACK 后自动补卖。** 具体耗尽后本地暂停政策如需超出原口径，应先明确业务裁决，而不是用全局 fatal 代替。
- **validation：** `rejected`、`released`、`released-admission`、`invalid-positive-direct`、`invalid-flat-direct`、`missing-positive-direct` 及两个 pending-old invalid 对照均已跑固定两版真实 workflow／executor／tracking／runtime／termination；已执行的基线恢复分支继续跑到真实 SELL settlement、真实 post-trade ready 和 native REBUY，不以 helper 返回空数组推断恢复成功。
- **测试缺口：** 当前 `tests/integration/distanceSwitchIndependentSell.integration.test.ts:597–613` 断言首次拒绝“是最终决定”；`:809–853` 断言行情失败最终 residual fatal；`:933–1094` 断言旧零成交取消／handoff拒绝关闭 gate。它们覆盖了**新策略**，没有对照 develop 的“本次未 accepted 可恢复”业务契约。需要在真实 runtime 层保留本次 ACK／无 ACK、明确拒绝／UNKNOWN、fresh positive／flat、普通／protective、pending handoff／已释放的交叉反例。
- **dimensions：** implementation、project/spec、types（resolved 合并不同事实）、tests、comments。根因归并为一项，不把 V-C6、各 await 窗口分别重复计数。

## minor issues

None。本轮不做无关命名、格式、死码或层级风格清理。

## 方案与用户核心要求的核对

1. 指定实施计划 `docs/architecture/architecture-refactoring-implementation-plan.md:34–38`（§1.1）列出保持业务的总前提，以及 submit UNKNOWN、protective 隔离等受控例外；`:63` 要求保持业务公式、单位、阈值、排序及完成条件；`:69–77` 保持不同 policy、ACK不等于终态、外部暂时失败与内部错误分类。
2. 同文 `:1304–1332`（§9.4 P3D）要求保留距离／周期 policy 差异、回补来源、失败规则、完成条件及交易副作用顺序；**未规定“距离移仓独立新增一次，旧普通单不计预算，明确拒绝／释放余量必 fatal”。**
3. 同文 `:1390`（§9.6）还明确“普通非 protective 单张同类型可改单旧单仍允许 REPLACE，其他合单限制不变”。C1 反例两张都普通，不能拿 protective 受控例外抵消。
4. 同文 `:1360` 的“不撤、不改、不合并既有SELL”明确属于 **P3E 末日清仓**。这一政策本身不证明可复制到 P3D 距离移仓；两者目的、窗口和回补不同。
5. 源码／测试确实把新一次性语义写得很清楚，但它们不能自证用户授权。当前指定计划中未检出该新距离语义；§5.1 的 SDK／迁移例外也不是业务策略修改许可。**即使后来将该新语义写入方案，也会直接改变上述 develop 的预算和恢复行为；除非用户另行明确批准，仍偏离本次“实现可以不同但必须更优、核心业务不可漂移”的要求。** 不以“更快停止所以更安全”替代证明，它不自动优于保留 owner、已确认未提交时在原门禁下安全重评估。
6. `AGENTS.md:33,38–40` 要求不得过度兜底，业务明确可重试的外部失败不得升级 fatal；四技能用于评估契约和业务边界，不把现文档描述当作旧实现等价证明。当前业务技能的换标失败回 EMPTY 也不能要求恢复这一危险基线；事实保留和范围克制要同时满足。

## positive findings

- fresh 核仓、final pending refresh、availability guard、状态／授权过期复核和保留 OLD/SWITCHING 能防止未空仓误绑；本复核明确支持保留这些改进（current `switchStateMachine.ts:1124–1185`）。
- `invalid-flat-direct` 在 canonical 仍 positive、broker 已真实 flat 时，无 SELL、无伪预算、正常交新标 ACTIVATING；这是比原 INVALID→EMPTY 更合理的事实一致性收口，**不建议回滚**。
- accepted 后继身份只记录真实 accepted MO，预算读真实成交而非估算，是安全能力（`orderMonitor/index.ts:244–264`）；应在保持业务范围的修复中复用，而不是新建账本。
- 明确拒绝和 UNKNOWN 的 adapter 分类正确：`mutationErrorClassification.ts:124–135`；UNKNOWN 控制组两版都经真实 runtime fatal，current `submitFlow.ts:502–518` 不猜orderId、不重提，此受控失败政策不应回退。
- `acked-cancel` 控制组证明 develop 本来就可能在已 ACK 后保持 WAIT。本报告没有把这一旧停滞、也没有把“当前更明确暴露已 ACK 余仓”一概报成新的丢失重试。

## 可运行验证与证据

所有文件位于 `C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`：

- `audit-recheck-switch-probe.ts`：独立探针。两版源码均用 `git show <固定SHA>:<path>` 读取并仅在内存 transpile。装配各版真实 executor、order monitor、recorder、settlement、post-trade consistency、switch workflow、wakeup runtime、termination；SDK native端点、报价与候选服务为离线fixture。
- current 复用其真实集成 fixture 的工厂装配而不运行其测试断言；只在审计 loader 内把旧普通 SELL 的关联集合设为空，与 develop 同输入，使其满足真实 REPLACE 校验。其余生产实现不替换。测试专用 `bun:test.describe/it` no-op 只为导出装配工厂，**不是 mock 生产 state machine 或合并 helper**。
- runtime 由受控 timer、真实订单事件／freshness，以及端口发布的新标 quote 继续推进；没有手造成功 driveResult。旧版和新版的金融表示差异（number／decimal文本）按各自原契约输入；所有选取的价格／金额／数量均精确可表示，排除了精度升级干扰。
- `audit-recheck-switch-run.cjs`：逐场景执行，保留 `audit-recheck-switch-<场景>.log`，写 `audit-recheck-switch-results.json`。**12 个命令全部 exit=0；23 个版本分支（含单独旧版关联负例）；stderr 均为空。** 这不是把 23 说成 Bun 正式测试数量。
- 最终探针 SHA-256：`9a3cc9249336a9f71debe6ea2d2331ccf14c7a2dcde5d2b5724103712480cef3`。

复跑：

```powershell
Set-Location D:/Code/HSI-Strategy-Trading
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-switch-run.cjs
# 单项，例如完整200/80资金差分：
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-switch-probe.ts c1
# 首次明确拒绝、candidate-await释放、生产null报价耗尽：
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-switch-probe.ts rejected
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-switch-probe.ts released-admission
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/audit-recheck-switch-probe.ts missing-positive-direct
```

独立执行当前相关测试：

```text
bun test tests/integration/distanceSwitchIndependentSell.integration.test.ts tests/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts tests/application/seatSwitch/switchStateMachine.business.test.ts tests/integration/terminalSwitchFinalization.integration.test.ts
107 pass / 0 fail / 859 expect() calls / 4 files / exit=0
```

原始日志：`audit-recheck-switch-current-tests.log`。它证明这些新策略已有测试，并不推翻两版业务差分。未把上一审计或其他代理的全仓测试数量冒充本轮执行。早期 fixture 参数／事件状态编码／timer 驱动脚本构造失败已修正，不作为源码缺陷；本报告只取最终 runner 的成功、断言齐全证据。

## not assessed

- **V-C6 精确实盘零价可达性：** current `src/infrastructure/longbridge/market/quoteClient.ts:292–295,523–530`、develop `src/services/quoteClient/index.ts:302–305` 都把非正 lastDone 映射为 null。直接 price=0 double 的差分是工作流／runtime契约证据，不是原SDK到业务的完整可达证明；本轮另外用生产可返回的 null/MISSING 完成耗尽差分。未声称内部坏decimal文本也应重试。
- 实盘订单优先级、成交概率、手续费及盈亏影响：没有联网或访问真实账户；C1 确认的是预算差异，不推断真实收益差异。
- 全生产 app 启动和整个 cleanup 顺序没有动态演练；已静态追到同一 termination 的真实 app 消费，并动态确认 workflow/runtime/termination 的同步关gate。
- G3-C3、周期换标、candidate排序、activation全scope、全仓架构／所有SDK和恢复协议不在本次二审范围。dead code 全消费排除未做，不列删除建议；简化只讨论同根因，不添加通用框架。
- 没有获得独立于当前方案、代码注释和新增测试的用户新交易政策授权记录；若存在外部明确批准，需要重新裁决“未经授权”部分，但预算与失败出口的已执行事实不会因此变成等价。

## recommended next actions

1. 优先修复 G3-C2 的无本次 ACK 分支：保留旧owner与核仓、防止误绑，不把明确拒绝／普通旧单可靠释放当作 UNKNOWN 或全局不变量错误；保留已 ACK／UNKNOWN 的防重提保护。
2. 恢复 G3-C1 的原合法回补资金范围；可选普通合法合单，或证明独立拆单不改变预算，不能借 protective／末日政策替代距离移仓旧契约。
3. 把本次正反例作为持久回归验收：合法空关联与关联60不匹配、本次ACK前后、拒绝／UNKNOWN、fresh flat／positive。先由主代理裁定业务边界，再由对应owner修改，本二审不实施代码变更。
4. 不回滚 safer fresh-flat／positive owner保留；不依据“当前107全绿”或向方案新增文字而宣布与 develop 核心业务等价。
