# 交易系统架构重构实施计划

> 本文是 `docs/architecture/architecture-refactoring-design.md` 的可执行实施计划；两份文档以同一组最终顶层目录和职责边界为目标。
>
> 本文定义实施顺序、任务拆分、依赖关系、代码影响、验证方式、发布与回退要求，不表示重构已经完成。目标目录、迁移来源和阶段验收在本文保持一致；实施时按 design §4、§13、附录 A 与本计划的对应条款执行。
>
> **范围更新：金融精度重构已纳入同次架构重构。**设计文档 §8.4 及相关条款中“保留旧 number 转换位置”“精度升级另立需求”的要求，以及 `OrderCommand.price: number` 示例，现在仅作为迁移前基线，不再是数值终态；数值表示、迁移与验收以本计划 §4.4、P0.4、§13.4.2 和 §15 为准。其余目录、owner、事件与事务边界仍沿用设计。本次只更新实施文档，未选择或安装十进制库，未修改代码、依赖或测试。
>
> **本轮用户确认记录（用户已确认全文及精度解释；以下口径为后续实施唯一依据。今后如需改变该口径，须再次确认）：**
>
> - 已确认 protective 责任边界：`PostTradeSettlementWorkflow` 独占保护性清仓最终完成判定、同步 durable append、daily-loss/cooldown/episode 内存提交及 ready；protective workflow 只负责触发、目的识别、执行前门禁和执行。订单 tracking 提供可信事实，domain 可提供纯规则，但不能形成第二判定者或提交者。
> - 用户精度原话为“所有精度保证小数点后三位”，此前回答为“确认全文及精度解释”；后续补充确认按“配置有界、基础运算精确、除法按用途处理、输出一次舍入”完善口径，具体边界见 §4.4。
> - 已确认本轮实施验收为离线全链路验收，不发布、不打开交易门禁、不连接实盘。离线静态/动态全链路及 mock/脱敏 fixtures 恢复演练是未来实施完成门槛；真实历史逐条对账及候选/回退版本完整恢复演练仍是未来生产发布阻断项。本次确认仅登记计划口径，不授权恢复代码重构或执行测试，也不授权发布/实盘操作。
>
> **已确认精度口径（后续实施唯一依据）：**“金融结果至少准确到小数点后三位；金额配置的整数部分最多 10 位、小数部分最多 3 位，超出直接拒绝，不截断或舍入。该限制不套用于 SDK 权威金融事实、历史文本或派生金额；中间状态不统一量化到三位，基础加减乘及比较保持精确。整手买量直接求精确整数商，成本与日损益保留金额/数量依据，比率判断不使用近似商或显示舍入；显示从精确计算依据按字段既定位数一次 half-even。V1 历史文本/schema 保真、不改写，技术指标不全量升级。P0 按实际支持的输入和业务公式验证库版本、精确接口与计算容量，不以固定 80 位或更多位数承诺无限输入范围下的精度，也不擅自另选业务量化/舍入政策。”例如成交金额 `1000`、数量 `3000` 的均价不能先量化为 `0.333` 再乘回数量而把成本变成 `999`；后续成本计算应保留原金额依据。
>
> 实施计划中上述已确认条款优先于相关设计文档中的示意；例如 design §7.4 若示意 protective 自行核对空仓、持久化 completion 并提交内存状态，应按本文 settlement 独占边界理解。本轮只修改本目标文档，不改 design 或其他文件。下列验收项均为未来实施要求，不表示本次文档修改已通过交易测试或实际恢复演练。
>
> 阅读顺序：先看第 4 节终态归属和第 5 节依赖，再按 Phase 0–6 执行；第 7 节列出不可拆分纵切，各阶段给出代码影响、实施任务和验收条件，第 17 节汇总最终验收清单。
>
> 计划基于当前仓库单进程、单实例运行模型制定。除非另行设计，本次实施不引入多进程、分布式锁、Redis/Mongo 运行时协调、跨进程事件总线、全局容器或热更新。backtest-kit 固定 revision 仅提供架构原则参考，不复制其全局容器/registry。

---

## 1. 实施目标与完成定义

### 1.1 总目标

除本文明确列出的事实一致性修复、下述 submit UNKNOWN 决策、共享卖单跨 protective 扩量修正及 §4.4 的金融精度升级外，保持现有港股日内交易业务语义、订单事实语义、生命周期安全门禁和恢复协议，完成以下五项根本性重构：

**submit UNKNOWN 的范围决策：**提交结果不可确认时，统一经既有 fatal 通道同步关闭交易放行并由顶层执行正常终止清理，不自动重提，也不新增自动查询接管、重评估、unresolved intent 持久化或重启恢复协议。当前基线的普通 BUY/SELL 已向上暴露 fatal；`src/main/timeWakeupEvaluationProgram/index.ts` 的末日分支仍会刷新持仓并安排重评估，实施时须删除该特殊分支并改为向上抛出原错误。这是本次明确决定的失败策略收敛，不声称当前所有路径已统一。以后若实际遇到此场景，再作为独立需求研究；本次不因该场景扩展恢复边界。该决策仅针对 submit 结果不可确认，不改变 cancel/replace 的既有 ACK、终态确认、602013 与 WAIT_WS_ONLY 协议。

**共享卖单的 protective 归属隔离（受控行为修正）：**当前基线静态入口虽传入 `isProtectiveLiquidation=false`，共享 pending-sell 快照却遗漏旧单身份，合单仅判断新请求；当旧单是同类型、可改单的 protective ELO 且其他执行条件均通过时，静态新增量可能经 `REPLACE` 被累计为 protective execution。默认保护性类型为 MO，不代表每次静态清仓都会触发。此为已确认的遗留实现缺口，不是本次重构新引入的问题。按 design §7.2.1，在 P3F 静态 owner 闭合时同步补齐旧单身份并禁止跨 protective 扩量，复用既有可信撤单终态、结算和最新可卖量重规划；普通合法 `REPLACE`、旧真实 protective progress 及合法 episode 完成继续保留。所需 P4.1/P4.2/P4.3 最小切片提前完成，不能仅迁移入口后推迟修正。本次只更新文档，规则及新增验收均为未来实施要求，不表示源码已经修复。

1. **Canonical account/position snapshot 唯一提交权**
   - 所有账户/持仓 canonical fact 的提交只经过一个 snapshot owner。
   - 任何业务模块都不能直接写 `LastState.cachedAccount`、`LastState.cachedPositions` 或调用 `positionCache.update()`。
   - 本地乐观投影不得冒充券商确认事实。

2. **Snapshot commit 与 post-trade business ready 分离**
   - `snapshot commit` 只表示 canonical 事实已合法提交。
   - `waitForFresh()` 继续表示成交后业务投影和完成条件已完成。
   - 卖出、风险和换标链路不能因原始账户/持仓读取完成而提前放行。

3. **业务 workflow 与 Longbridge SDK 解耦**
   - Longbridge SDK 类型、枚举、Decimal、push DTO 和 `TradeContext` 只停留在 infrastructure/adapter 边界。
   - application/domain 使用内部 command、fact、gate 和 receipt。
   - 通用十进制能力由独立库承接，按 §4.4 迁移金融输入、计算、状态与输出；不得将领域数学下沉 broker mapper，也不得把去 SDK 误作改用普通 number。
   - submit 结果不可确认按上述决策直接 fatal；撤单确认、订单终态和成交金额修正语义保持不变。

4. **业务 owner 与生命周期 owner 收口**
   - 保护性清仓触发/执行、成交后结算及 readiness、席位激活/换标和末日清仓拥有清晰的 application owner；保护性完成判定与完成事务只归 `PostTradeSettlementWorkflow`。
   - 生命周期使用静态、有序、可检查的资源清单，但不替换现有异构 stop/drain 编排。

5. **金融精度与显示边界收口**
   - 按文首已确认口径处理价格、金额、成本、盈亏及金融比率/阈值；P0 按该口径完成库版本、范围与内部计算容量工程验证后，去除旧金融链路不必要的 number 投影和多次往返。
   - 时间、版本、计数和经证明的安全整数数量继续使用 number；技术指标保留现有 number 算法、投影、比较和无效值语义，不统一为全量 Decimal。
   - 按已确认口径，显示维持各字段既定展示位数并 half-even；durable 数据按 V1 规范序列化，两者不复用补零文本，且不得把显示舍入前移到中间状态。
   - 保持业务公式、单位、阈值及包含关系、排序键顺序和完成条件；由消除浮点误差带来的临界结果变化必须按已确认口径登记并验证，不把旧误差冻结为正确答案。

### 1.2 不变的业务安全约束

重构期间不得改变以下事实：

- 行情、订单、系统时间仍分别推进各自业务链路。
- confirmed candle / active candle 的替换、确认、乱序忽略语义不变。
- 普通 BUY、普通 SELL、换标回补、保护性清仓、静态距回收价清仓、末日清仓继续使用不同 policy。
- 未知 submit 不自动重提。
- cancel acknowledged 不等于订单终态。
- 保护性清仓必须按“成交 progress 持久化 → 权威持仓/待成交保护性订单事实确认 → `PostTradeSettlementWorkflow` 最终完成判定 → 同步 completion 持久化 → daily loss/cooldown/episode 内存提交 → ready”的顺序推进；protective workflow 不另作完成判定或提交。
- `ACTIVATING` 未完成全部准入步骤前不能进入 `ACTIVE`。
- 午休、开盘保护、末日接管、跨日清理、开盘重建分别保留各自门禁。
- 外部暂时性失败与内部契约/不变量错误继续采用不同失败语义。
- 停止交易时系统级时间唤醒仍可推进交易日判断和重建时点。
- 生产升级前必须先按旧终止流程完成 drain；不设计运行中热切换。

### 1.3 完成定义

重构只有在以下条件全部满足后才可宣布完成：

- 全部 canonical account/position writer 已移除或改为调用 `application/accountPositionSnapshot` 的唯一 owner。
- `LastState` 不再向业务层暴露可写 snapshot 镜像和 `positionCache.update()` 能力。
- 旧 `dayEpoch`、`snapshotGeneration`、`seatVersion`、`settlementVersion` 结果不能覆盖新事实或放行旧业务。
- snapshot commit、settlement ready、seat ACTIVE 各自只有一个真实 owner；保护性清仓最终完成判定、completion append、daily-loss/cooldown/episode 内存提交和 ready 仅由 `PostTradeSettlementWorkflow` 拥有。
- application/domain 不依赖 Longbridge SDK；SDK DTO、枚举、Decimal、push/query 和错误映射只由对应 infrastructure adapter 处理，阶段性迁移例外已清零。
- 顶层物理结构收口为 `app/`、`domain/`、`application/`、`runtime/`、`infrastructure/`、`config/`、`constants/`、`types/`、`utils/`；`src/core/`、`src/main/`、`src/services/` 不再包含生产实现、旧 façade、转发层或兼容入口。
- 普通 BUY/SELL、换标、保护性清仓、静态距回收价清仓、末日清仓、订单恢复和跨日生命周期既有语义测试通过；既有普通交易 owner 直接迁移，不另加 wrapper owner。
- 新增并发/失效/未知结果/生命周期清单测试通过；测试最终目录镜像 `src/` 的职责布局，迁移前基线路径与目标路径有明确对应关系。
- `bun format`、`bun lint`、`bun type-check`、`bun build` 和完整 `bun test` 通过。
- V1 durable log 的结构、字段、严格文本校验、ID 和幂等规则保持；离线实施验收须通过静态/动态全链路及 mock/脱敏 fixtures 恢复演练。真实历史 V1 与权威订单逐条对账、精度迁移后候选版本和指定回退版本的完整恢复，均为未来生产发布阻断项；fixtures 不替代这些验证。
- P0.4 / §13.4.2 按文首已确认精度口径完成离线工程验收：金融输入/状态/运算不经未授权 number 投影，买量、距离、成本/盈亏、日损益、progress/baseline 和金融显示达到目标。实施完成不表示真实历史对账或发布/回退演练已完成。

**本轮实施完成与生产发布边界：** 实施完成必须通过离线静态与动态全链路验收、mock/脱敏 fixtures 恢复演练；本轮不发布、不打开交易门禁、不连接实盘，也不声称完成真实历史 V1+权威订单逐条对账或精度迁移后候选/回退版本完整恢复。后两项保持为未来生产发布阻断门禁，不能以 fixtures 替代。

**架构/物理归属完成定义：** 每个生产职责在第 4 节的来源→职责→终态目录→阶段→旧入口移除/验证映射中有且只有一个最终 owner；跨层事实契约落在最近共同父级的窄 `src/types/*` 文件，模块内契约留在相邻 `types.ts`。所有旧入口在其闭合阶段移除，P6 只做残留清理和物理收尾，不是首次确定分层或首次迁移业务。

---

## 2. 实施总原则

### 2.1 纵切迁移，不做双写灰度

每一个可运行合入单元必须完整替换旧 owner。开发分支允许内部先后提交，但中间版本不发布、不运行交易；P1 所有子任务完成前不能作为可运行版本合入：

```text
定义内部契约
  -> 迁移全部调用方
  -> 删除旧写入/旧入口
  -> 更新测试和架构检查
  -> 运行切面验证
  -> 才能合入
```

不允许：

- 新旧 snapshot writer 并行双写。
- 新旧订单 owner 同时推进同一订单事实。
- 新建 façade 仅把旧 runtime 换一个名字。
- 保留旧名委托链、re-export 或临时兼容层。
- 为了目录整齐提前搬迁无关模块。

### 2.2 先建立逻辑边界，再按闭合切面同步迁移物理目录

目录是表达架构边界的工程约束，不是最后的美化步骤。不能先搬文件再追调用链；每个闭合切面必须完成逻辑 owner、依赖方向、物理归属、旧入口移除和架构检查：

```text
识别真实 owner/不变量
  -> 定义 domain/application/port/adapter 边界
  -> 迁移全部调用方与测试
  -> 删除旧 owner/旧入口
  -> 将闭合切面放入第 4 节终态目录
  -> 更新架构扫描和依赖图
```

`src/core`、`src/main`、`src/services` 只作为迁移来源和未闭合切面的暂存位置，不是终态。P1/P2 可以且必须修改这些现存路径中的代码，以完成完整 writer/readers、安全协议和所需 SDK 窄切片；不得把“不得向旧目录新增业务”误解为禁止修复旧代码，也不得因此新增跨领域 owner、facade 或转发层。切面闭合后，其生产实现、测试和入口迁往第 4 节规定的位置；未闭合部分只可在原位置暂存至对应阶段，P6 前不以旧目录作为最终归属。

### 2.3 版本字段不混用

| 版本 | 所属事实 | 生成/推进时机 | 不可替代含义 |
| --- | --- | --- | --- |
| `dayEpoch` | 交易日生命周期 | 午夜清理推进一次；重建使用已建立的 epoch，同日重试不再推进 | 旧交易日结果不能提交 |
| `snapshotGeneration` | canonical snapshot 失效代次 | 成交事实、日切、重建开始，以及末日已确认提交满足原条件后使账户失效时推进 | 旧读取不能覆盖新事实或恢复已失效账户；账户失效本身不增加 settlementVersion；submit UNKNOWN 走终止协议，不建立专用重查代次 |
| `commitRevision` | 本地合法 snapshot commit 序号 | 一次完整合法提交后递增 | 不是券商远端 revision |
| `accountRevision` | account component 提交序号 | account component 合法提交后递增 | 不能代表 positions 已同步 |
| `positionRevision` | position component 提交序号 | positions component 合法提交后递增 | 不能代表 account 已同步 |
| `pairedCommitRevision` | account+positions 成对提交 | 双读均成功发布时记录本次 commitRevision；单组件提交不推进它 | 不声称远端原子快照 |
| `settlementVersion` | 成交后业务 readiness | 每次新的成交后刷新需求登记时推进 | 不等于 snapshot commit |
| `seatVersion` | 席位身份 | 绑定、换标或失效时推进 | 旧席位结果不得激活新席位 |

所有 receipt 和异步结果必须携带适用 epoch/version；比较时不得只比较裸整数。

### 2.4 内部错误优先于过期处理

异步结果返回后必须先识别和上报内部 `TypeError`、`ContractError`、`InvariantError` 等契约/不变量错误，再判断是否因 generation、epoch 或 seatVersion 过期。

只有以下结果可以按 superseded 处理：

- 成功但已经过期的外部读取结果。
- 已分类的预期外部失败且请求仍属于旧代次。

不能以“结果已过期”为理由吞掉内部错误。

### 2.5 现有安全策略优先于抽象对称

不为了目录对称创建没有独立完成条件的 workflow；不为了统一接口给每个资源增加空的 `start/stop/drain`；不为了统一交易流程新增 `RiskReservation`；不把所有队列改成 latest-only。

---

## 3. 当前基线与影响范围

### 3.1 已确认的 canonical writer

| 现有位置 | 当前行为 | 实施要求 |
| --- | --- | --- |
| `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` | 启动/重建双读并写 `cachedAccount/cachedPositions/positionCache` | 改为请求 snapshot owner；保留双读成功后成对提交 |
| `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts` | 席位激活刷新账户/持仓并写缓存 | 改为 `SEAT_ACTIVATION` refresh request；调用方接收 receipt |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts` | 成交后双读、写缓存、调用后置业务、mark fresh | 拆为 snapshot refresh + settlement workflow；保留 ready 语义 |
| `src/main/timeWakeupEvaluationProgram/index.ts` | 末日未知提交后直接读取并写持仓缓存、安排重评估 | 删除 UNKNOWN 专属刷新 helper/分支，向上抛出原错误进入 fatal；不另建 refresh source 或恢复 owner |
| `src/core/doomsdayProtection/index.ts` | 提交成功后清 account、过滤 positions、更新 positionCache | 删除 canonical 乐观写入；保留账户失效语义和既有订单追踪；不新增 UNKNOWN overlay |
| `src/main/lifecycle/cacheDomains/globalStateDomain.ts` | 午夜清空 account/positions/cache | 改为 snapshot owner `clearForDay`，先失效旧代次 |

### 3.2 主要直接读取方

移除 LastState snapshot 镜像时必须一并迁移以下读取方：

- `src/app/runApp.ts`：启动运行时标的验证使用 positions。
- `src/main/quoteSubscriptionRuntime/index.ts`：持仓标的订阅对账。
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`：静态清仓/距离换标相关持仓读取。
- `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`：换标状态机使用当前 positions。
- `src/services/accountDisplay/index.ts`：账户/持仓显示。
- 卖出、风险和保护性清仓完成判断中通过 `positionCache` 读取的调用方。
- 所有 `LastState` 类型的 `Pick<...cachedPositions...>` 和 `Pick<...positionCache...>` 契约。

普通 BUY 风控中的实时账户/持仓读取仍是临时读取，不应被强制写入 canonical snapshot，也不应推进 `settlementVersion`。

### 3.3 当前 post-trade freshness

当前 `createPostTradeConsistencyRuntime` 具备以下顺序：

```text
recordSettlementRefreshNeed
  -> refreshGate.markStale
  -> 账户/持仓读取
  -> positionCache 更新
  -> onPositionsCommitted
  -> settlement workflow 基于 tracking 提供的事实独占判定 protective completion，并推进冷却/日损益/R1/N1 等后置业务
  -> refreshGate.markFresh
```

重构必须保留该顺序的业务含义，但把 canonical commit 与后置业务 ready 拆开，禁止 snapshot owner 等待自身的 business ready。

### 3.4 Longbridge SDK 传播面

已确认 SDK 进入以下区域：

- `src/core/trader/index.ts`：创建 `TradeContext`。
- `src/core/trader/**`：账户、下单、订单监控、订单恢复、数量计算。
- `src/core/orderRecorder/**`：订单 API 和 `TradeContext` 依赖。
- `src/types/services.ts`、`src/types/trader.ts`、`src/types/risk.ts` 等公共契约。
- `src/utils/numeric/**`：SDK `Decimal` 相关计算。
- 订单状态、订单类型、TIF、push 对象和 SDK error 映射。

迁移不能只搜索运行时 import，必须同时搜索：

```text
from 'longbridge'
TradeContext
OrderStatus
OrderType
TimeInForceType
PushOrderChanged
Decimal
ReturnType<TradeContext[...]>
SDK 枚举比较
Period
```

### 3.5 生命周期现状

当前生命周期由三套机制共同维护：

1. `runApp.ts`：启动与进程终止生产者顺序。
2. `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`：午夜清理和开盘重建。
3. `src/app/shutdown/createCleanup.ts` + `src/constants/cleanup.ts`：增量注册、阶段排序、最终 cleanup。

实施时只增加静态覆盖检查，不建立第二套通用生命周期执行器。

### 3.6 当前精度基线与改造面

| 当前来源 | 已确认现状 | 本次精度任务 |
| --- | --- | --- |
| `src/services/quoteClient/**`、`src/core/trader/accountService.ts`、`src/types/{quote,account}.ts` | SDK 价格、账户金额、成本/数量进入 number 契约；账户 `positionValue` 直接相减 | 提前建立保真的金融事实和 mapper；差额/估值规则由所属 domain 计算，不移入 SDK mapper |
| `src/core/orderRecorder/**`、`src/core/trader/orderExecutor/quantityResolver.ts`、`src/services/autoSymbolManager/{signalBuilder,switchStateMachine}.ts` | 成交记录有 number 投影；买量使用 Decimal，回补构造信号前又转 number | 成交价格、金额与回补预算贯穿十进制；数量只在证明为安全整数时允许 number |
| `src/core/riskController/{utils,unrealizedLossChecker,dailyLossTracker,warrantRiskChecker}.ts` | Decimal 运算与 number 缓存/偏移、多次投影混合 | 成本、R1/R2、亏损偏移、累计金额和 baseline 保真；消除金融状态投影，保留公式及阈值关系 |
| `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`、`src/services/mixedTradeLogRepository/**` | 全量重算后恢复旧文本，tracker 有恢复后的 number 状态/比较 | 十进制恢复、历史对账和冲突门禁；V1 schema/ID 规则与逐条恢复保留 |
| `src/services/{accountDisplay,marketMonitor}/**`、`src/utils/{display,numeric}/**` | 金融显示大量使用 `number.toFixed`；`formatDecimal` 是 `roundDp → toNumber → toFixed` | 金融派生先做十进制计算，显示直接输出定点字符串，不回转 number |
| `src/core/strategy/intradayRegression/**`、时间/席位/版本契约 | 指标以 number 递推/显示，部分信号 Decimal 比较，延迟验证 number 比较；时间版本计数是 number | 指标算法及比较边界保留；结构性整数保留 number 并验证安全范围 |

此表是改造基线，不表示当前每个金融公式都已精确，也不表示混合类型本身必然造成交易错误。实施清单须追踪 SDK/query/push、配置/常量、共享字段、所有直接消费方、状态、恢复与显示；不能只改类型声明、格式器或 mapper。

---

## 4. 目标 owner 与依赖边界

### 4.1 最终依赖方向与职责

最终顶层目录固定为 `app/`、`domain/`、`application/`、`runtime/`、`infrastructure/`、`config/`、`constants/`、`types/`、`utils/`。依赖方向按下图执行：

```text
app (factory / composition / cleanup)
  -> application (use cases / failure policy)
  -> domain (state / rules / pure transitions)
  -> types (neutral cross-layer facts and narrow contracts)
infrastructure (I/O adapters) -> types / domain-neutral data
runtime (queues / timers / listeners / stop-drain) -> application / domain / types
```

`application` 通过窄 port 调用外部能力；`infrastructure` 实现 port，且由 `app` 装配。显式注入 port、回调或协作对象不构成静态反向 import，也不意味着全局容器。跨 domain/application/infrastructure 共享的内部 fact/contract 使用现有 `src/types/` 下按最近共同父级划分的窄文件；模块私有契约放相邻 `types.ts`。共享 fact 源不得依赖高层实现，不新建 `contracts/` 超级中心。

`domain` 可以封装领域状态及纯状态迁移，方法可接收显式时间值；domain 不发网络/文件/日志 I/O、不持有 timer、队列或调度。`application` 组织完整用例、事务边界及各用例失败/重试策略。`runtime` 才是真正队列、worker、timer、listener、事件路由及 stop/drain 的实现。`app` 仅保留工厂、依赖装配、启动入口和唯一 cleanup 编排；`src/app/runtime/create*.ts` 如保留，只是创建/组装 runtime 的工厂，不得承载第二套 runtime 或业务完成条件。

目标结构和以下迁移映射均为本轮正式终态，不是建议性的候选树；assessment §4/§5.6、design §4/§12/附录 A 与本计划共同构成实施依据。backtest-kit `4c5f3c668798a594dcfe4e004466bdc55680f104` 只借鉴明确边界、定义与执行分离等原则，不照搬全局 container/registry。

### 4.1.1 最终目录树及闭合迁移映射

下列结构为正式终态，不是过渡树或候选方案。现存 `src/core/`、`src/main/`、`src/services/` 仅为来源；P6 后不保留其中的生产实现、旧 façade、转发层或兼容入口。按真实职责可合并相邻目录，但不能造空层、第二 owner 或仅改名的 wrapper。

```text
src/
├── app/                         # 唯一 composition root：factory、assembly、startup、cleanup
│   ├── runApp.ts
│   ├── runtime/                 # create*Runtime 工厂/装配器，不是 runtime 实现
│   ├── startup/                 # prepareStrategy / selected-strategy factory / config wiring
│   ├── lifecycle/               # 静态覆盖清单与验证
│   └── shutdown/                # 唯一具名 cleanup executor
│
├── domain/                      # 可封装状态与纯迁移；无 IO、队列、timer、调度
│   ├── order/                   # order facts、reducer、状态规则
│   ├── position/                # position facts/纯规则（不含 snapshot store）
│   ├── seat/                    # seat identity/selection/switch policy/纯状态
│   ├── risk/                    # 风险规则与纯评估
│   ├── liquidation/             # 清仓规则、执行状态、cooldown 状态
│   └── strategy/                # 策略纯元数据/参数模型/指标与验证计算
├── application/                 # 用例、完成条件、失败及重试 owner，通过窄 ports 调外部
│   ├── accountPositionSnapshot/ # coordinator、请求协调、generation、私有 store、internal pump
│   ├── postTradeSettlement/
│   ├── orderExecution/
│   ├── orderRecovery/           # 仅真实独立恢复用例；否则与 orderTracking 内聚且只一个 owner
│   ├── orderTracking/           # 订单事实推进/串行入口；可内聚 recovery，不拆第二账本
│   ├── ordinaryBuy/             # 迁移既有 BUY owner，不新增 wrapper owner
│   ├── ordinarySell/            # 迁移既有 SELL owner，不新增 wrapper owner
│   ├── seatActivation/
│   ├── seatSwitch/
│   ├── autoSearch/
│   ├── protectiveLiquidation/     # trigger/purpose/pre-execution gate/execution；最终 completion 归 postTradeSettlement
│   ├── staticLiquidation/
│   ├── doomsdayClearance/
│   ├── tradingDayRebuild/
│   └── riskRefresh/              # 仅真实独立职责；可与真实 owner 合并

├── runtime/                     # 实际 queues/workers/timers/listeners/event routing/stop-drain
│   ├── asyncProgram/             # 保留 buy/sell/task-queue 等现有具体语义名
│   ├── businessEventProgram/
│   ├── autoSearchWakeupRuntime/
│   ├── lifecycle/
│   ├── monitorDisplayRuntime/
│   ├── monitorQuoteEventRuntime/
│   ├── ordinarySignalGuard/
│   ├── periodicSwitchWakeupRuntime/
│   ├── quoteSubscriptionRuntime/
│   ├── seatActivationDispatcher/
│   ├── seatRuntimeCleanupDispatcher/
│   ├── strategy/                 # 选中策略的现存私有延迟执行、timer、emitter 与生命周期编排
│   ├── timeWakeupEvaluationProgram/
│   ├── timeWakeupPlanner/
│   ├── timeWakeupRuntime/
│   ├── tradingGateEventRuntime/
│   ├── tradingQuoteDisplayRuntime/
│   └── tradingRiskEventRuntime/

├── infrastructure/
│   ├── longbridge/trade/          # 交易 SDK adapter、DTO/enum/error mapper、trade port 实现
│   ├── longbridge/market/         # quote/warrant 查询与缓存、SDK mapper、外部 IO retry
│   ├── persistence/mixedTradeLogRepository/
│   ├── time/                     # system clock / setTimeout 等底层适配；唤醒编排属 runtime
│   ├── logger/
│   └── display/                   # 按现有职责输出账户/行情/监控显示
│
├── config/                       # 配置解析与校验
├── constants/                    # 集中稳定项目规则
├── types/                        # 最近共同父级的窄共享 fact/contract，不依赖高层实现
└── utils/                         # 仍有价值的通用纯工具；不承载业务 owner 或外部 IO

tests/                            # 最终职责镜像；基线旧路径只保留到对应测试迁移闭合
├── app/  domain/  application/  runtime/  infrastructure/
├── config/  constants/  types/  utils/
├── architecture/
└── integration/
```

**终态边界：**

- SnapshotCoordinator 的网络请求协调、generation、私有 store 和 scheduler-port 驱动的 internal pump 全部属于 `src/application/accountPositionSnapshot/`；不得放入纯 domain 或拆出第二 store/coordinator owner。domain 可封装状态、事实和纯迁移，但无 IO/调度；explicit time 值可作为领域计算输入。
- `src/application/orderTracking/` 是订单事实及经济投影推进唯一 owner。tracking/recovery 串行入口可内聚；已消费输入和投影覆盖元数据内聚现有订单记录/事实存储，规则归 `domain/order`，不为目录拆事务或建立第二订单账。activation、`orderExecution` 和 snapshot coordinator 不复制该状态；API 重建与在线结算共用设计 §9.2 的幂等基线。
- 普通 BUY/SELL 的现有 owner 直接迁入 `application/ordinaryBuy`、`application/ordinarySell`，不新增转发 wrapper。职责真实独立时可合并目录，但必须维持单一入口、完成条件和失败 owner。
- `src/app/runtime/create*.ts` 仅创建/装配具体程序；队列、事件监听、唤醒编排和 stop/drain 在 `runtime/`。底层系统时钟、setTimeout/clearTimeout 等实现位于 `infrastructure/time/`，经窄能力注入；业务 owner 为保持自身不变量而内聚的 pump 不另拆 runtime。保留现有具体 program 名及语义，不因层名而机械改名。
- 策略纯元数据、参数模型、指标增量状态、样本和验证计算属于 `domain/strategy`；现有 `intradayRegression/runtime/` 是指标增量计算，不因名字含 runtime 就迁到顶层 runtime。现存 `index.ts` / `verification/index.ts` 中私有 pending、timer/token、保存的 emitter 调用、clock/logger/fatal 与失效/reset/destroy 编排属于 `runtime/strategy/<策略目录>/`，不能把整套策略执行搬入 domain。仍由 app 只创建选中策略的一个实例，不公开 pending、不新增 runner/registry。`definition.ts` 的配置导入、prepare/create 装配与 selected-strategy factory 归 `app/startup`，配置解析归 `config`；实际行情监听仍归原具名 runtime。P3F 同切面定稿 definition/config 文件布局，并同步更新 `prepareStrategy` 的目录定位、`strategyLoaderHelpers` 的文件位置校验和 `.ts/.js` 扩展规则；不得只改静态 import 而留下旧路径或错误邻接约束，不增加路径探测回退、预加载或热更新。
- `services/autoSymbolFinder` 拆分为 `infrastructure/longbridge/market` 的 warrantList SDK 查询、外部缓存与 IO retry，`domain/seat` 的纯筛选规则，`application/autoSearch` 的失败/重试策略；SDK mapper 才依赖 SDK。
- `services/liquidationCooldown/index.ts` 的 Map 计数/冷却规则迁 `domain/liquidation/cooldown`，但同目录 `tradeLogHydrator.ts` 含仓储读取与恢复编排，归 `application/protectiveLiquidation` 的恢复职责，经窄仓储 port 工作；不能整目录搬入 domain。实际文件读写在 `infrastructure/persistence/mixedTradeLogRepository`。
- `refreshGate` 并入 `application/postTradeSettlement`；`positionCache` 作为私有索引由 `application/accountPositionSnapshot` 单一持有。SDK numeric mapper 进 trade/market adapter，领域数学仍按 domain 职责收口，恢复编排/排序归 application；通用纯数学留 `utils/numeric` 并由独立十进制库承接。新层消费前完成对应 SDK numeric 输入/结果契约替换，不能只保留审计字符串却把运算改成 number；quote retry 外部 IO 不得留在 utils。
- logger、display output、system clock/timer 平台调用按现有职责分别进入 infrastructure/logger、display、time；runtime 通过注入能力维护自己的唤醒策略和句柄，application 可内聚业务协调所需 pump。不得合并不同 owner 的 scheduler 为全局调度器；集中项目规则仍在 `constants/`。
- 跨层共享契约/facts 在最近共同父级 `src/types/<窄模块名>.ts`；模块私有契约在相邻 `types.ts`。type-only import 也必须满足依赖白名单；中性 fact 源不反向依赖高层实现，不新建 contracts 超级中心。

### 4.1.2 来源、终态、阶段与移除/验证映射

表内当前路径只表示迁移来源，不表示终态残留。P1/P2 为安全协议可修改旧路径且必须清理闭合切面；测试旧路径同理仅为迁移前基线。

| 当前来源 | 来源职责拆分 | 最终目录 | 闭合阶段 | 旧入口移除与验证 |
| --- | --- | --- | --- | --- |
| `src/core/doomsdayProtection/**` | 清仓规则与执行/完成条件 | `domain/liquidation` + `application/doomsdayClearance` | P1安全切片，P3E迁移 | 删除旧 cache 写/本地过滤；已确认订单沿既有事实链路；submit UNKNOWN 直接 fatal、不重提 |
| `src/core/orderRecorder/**`, `src/core/orderStatusLifecycle/**`, `src/core/trader/orderMonitor/**` | 权威 order facts、ownership/revision、经济投影覆盖、terminal、recovery 串行推进 | `domain/order` + `application/orderTracking`；SDK操作在 infra trade | P1最小幂等安全切片，P3/P4完整收口 | 单一 tracking/recovery owner；API/在线结算共用消费基线；旧 façade/重复入口清零；恢复缓冲/较新合并测试 |
| `src/core/trader/orderExecutor/**`, `src/core/trader/orderHoldRegistry.ts`, `src/core/trader/rateLimiter.ts` | 命令执行、持有/限速与纯数量/业务门禁 | `application/orderExecution` + 必要 `domain/order`; broker I/O 在 `infrastructure/longbridge/trade` | P3/P4 | 不把整个 trader 搬 infra；UNKNOWN/602013/WAIT_WS_ONLY 等价测试 |
| `src/core/trader/accountService.ts`, `src/core/trader/index.ts`, `src/core/trader/orderCacheManager.ts` | SDK context/read；业务组装；订单查询缓存分别归属 | SDK部分在`infrastructure/longbridge/trade`，用例组装在app，订单事实投影在`application/orderTracking`；缓存不得成为第二账本 | P1最小facts+mapper，P4完整收口 | P1新application无SDK；复用同一context，P4创建权仅在adapter；不整块搬Trader |
| `src/app/types.ts` | app本地装配参数与跨层能力契约分开 | 本地参数留app；其他能力按最近共同父级放窄types | P1/P2/P3/P4随切面，P6残留 | 删除对已迁移旧owner类型的依赖；type-only边界检查 |
| `src/core/trader/protectiveLiquidationEpisodeTracker/**`, `src/core/riskController/**`, `src/core/signalProcessor/**` | episode/daily-loss 状态及风险纯规则；protective trigger、目的识别、执行前门禁与执行归 protective 用例；可信 progress/订单事实由既有 tracking/settlement 路径提供 | `domain/liquidation`, `domain/risk`, `application/protectiveLiquidation`, `application/postTradeSettlement`, `riskRefresh` | P2/P3B/P3F | `PostTradeSettlementWorkflow` 独占最终完成判定、同步持久化及 daily-loss/cooldown/episode 内存提交；无第二判定/提交者；SELL/risk 策略等价测试 |
| `src/core/strategy/**`（含 intradayRegression definition/runtime/verification）、`src/app/startup/{prepareStrategy,strategyLoaderHelpers,createSelectedStrategy}.ts` | 纯指标/样本/验证与私有 pending/timer/emitter 执行、factory/config/动态加载拆开 | 纯计算/状态在 `domain/strategy`；现存私有执行在 `runtime/strategy/<策略目录>/`；definition prepare/create 与加载装配在 `app/startup`，配置解析在 `config` | P3F执行/加载闭合，所需SDK-free/Period切片提前；P4/P6仅收剩余映射/残留 | 仅加载并prepare选中入口一次；同步更新目录定位和definition/config位置校验；保存emitter、先失效后取消、同实例reset/destroy及一分钟线语义测试 |
| `src/core/utils.ts` 及 core 各 `utils.ts` | 领域辅助按最近 owner 收口，纯通用 helper 保留 | `domain/*` 或 `utils/` | P3–P6 | 清理跨层业务工具入口，依赖静态检查 |
| `src/main/asyncProgram/{buyProcessor,sellProcessor,tradeTaskQueue,monitorTaskQueue,monitorTaskProcessor}` | queue/worker/handler调度；买卖与席位业务分开 | `runtime/asyncProgram/**`; `application/ordinaryBuy`, `ordinarySell`, `seatActivation` | P1读路径，P3/P3F owner迁移 | 保留 FIFO/串行语义，移除业务副本；queue/UNKNOWN/方向隔离测试 |
| `src/main/businessEventProgram/**`, `src/main/ordinarySignalGuard/**`, `src/main/tradingGateEventRuntime/**` | event/gate listener 属 runtime；策略和动作由 application/domain 决定 | 同名 `runtime/*` + 对应 domain/application | P3F/P5 | 不造 EventBus；唯一业务 gate 与触发顺序测试 |
| `src/main/autoSearchWakeupRuntime/**`, `src/main/periodicSwitchWakeupRuntime/**`, `src/main/timeWakeupPlanner/**`, `src/main/timeWakeupRuntime/**`, `src/main/timeWakeupEvaluationProgram/**` | 具名 wakeup/timer/listener；委托 autoSearch/switch/doomsday/rebuild | 同名 `runtime/*`; 对应 `application/autoSearch`, `seatSwitch`, `doomsdayClearance`, `tradingDayRebuild` | P3/P5 | 保留 program 语义名；不改 marketEvents；时间窗口/stop测试 |
| `src/main/monitorQuoteEventRuntime/**`, `src/main/quoteSubscriptionRuntime/**`, `src/main/monitorDisplayRuntime/**`, `src/main/tradingQuoteDisplayRuntime/**` | quote/seat事件路由和订阅对账属runtime；决策属use case；输出属adapter | 同名 `runtime/*` + `infrastructure/display` | P1/P3/P5 | 删除 runtime 完成条件/直接 writer；dirty reconcile/display测试 |
| `src/main/tradingRiskEventRuntime/**`, `src/main/seatActivationDispatcher/**`, `src/main/seatRuntimeCleanupDispatcher/**`, `src/main/recovery/**` | routing/queue/cleanup在runtime；activation/rebuild/risk刷新在app usecase | 同名 `runtime/*` + `application/seatActivation`, `riskRefresh`, `tradingDayRebuild` | P1/P3/P5 | 唯一 activation owner；rebuild不绕过barrier；wiring测试 |
| `src/main/lifecycle/**`, `src/main/utils.ts` | 日切 stop/drain/rebuild协调与重建用例分开 | `runtime/lifecycle` + `application/tradingDayRebuild`; 通用纯工具留utils | P1/P5/P6 | 保留具名先后顺序；epoch/generation与lifecycle测试 |
| `src/services/accountDisplay/**`, `src/services/marketMonitor/**` | 展示/market读取按外部IO与纯呈现分开 | `infrastructure/display`, `infrastructure/longbridge/market`; 金融派生/纯呈现规则进domain/utils | P1起随字段消费者同步迁移，P4收口，P6仅扫残留 | 金融估值/涨跌使用十进制并直接输出string；不让展示成为业务 owner；§13.4.2输出测试 |
| `src/services/autoSymbolFinder/**` | warrant SDK query/cache、筛选、失败/重试三分 | `infrastructure/longbridge/market`, `domain/seat`, `application/autoSearch` | P3F/P4 | finder不再是复合owner；SDK import仅adapter；缓存/筛选/失败矩阵 |
| `src/services/autoSymbolManager/**` | seat state/selection/switch workflow分开 | `domain/seat`, `application/seatActivation`, `application/seatSwitch`, `application/autoSearch` | P3C/P3D/P3F | manager复合 owner 与委托 façade 清零；seatVersion/policy tests |
| `src/services/liquidationCooldown/**` | index/utils的计数冷却规则；tradeLogHydrator的读取/恢复用例分开 | `domain/liquidation/cooldown` + `application/protectiveLiquidation` 恢复职责；文件读取仍归persistence adapter；completion事务归 `application/postTradeSettlement` | P2/P3B | domain无仓储/日志IO；恢复顺序不变；最终完成判定与提交唯一归 settlement 测试 |
| `src/services/mixedTradeLogRepository/**` | durable mixed trade-log append/read | `infrastructure/persistence/mixedTradeLogRepository` | P2/P3B/P4 | application经窄port；格式/同步append语义测试 |
| `src/services/quoteClient/**` | quote SDK client/market mapper | `infrastructure/longbridge/market` | P1/P3首个金融消费前完成所需mapper，P4收余项 | 金融价格不先toNumber；指标投影独立；SDK仅market adapter，candle语义测试 |
| `src/utils/refreshGate/**`, `src/utils/positionCache/**` | readiness waiters 与 canonical position private index | `application/postTradeSettlement`, `application/accountPositionSnapshot` | P1迁移，P2正式归属 | 删除旧导出/LastState mirror；writer/late result tests |
| `src/utils/numeric/**`, `src/utils/accountPositions/**` | SDK mapper、领域算术、恢复比较与通用十进制算术分离 | SDK在`infrastructure/longbridge/{trade,market}`；规则在对应`domain/order`、`position`、`risk`；恢复归application；独立库纯算术在`utils/numeric` | P0仅按文首已确认口径验证库版本/范围/内部容量；P1起随首个消费纵切闭合，P4只收剩余mapper/显示 | 金融输入/状态/输出去除未授权number投影，整数/指标例外显式列出；按已确认口径完成§13.4.2离线目标与差分验收 |
| `src/utils/quoteRetry/**`, `src/utils/logger/**`, `src/utils/display/**`, `src/utils/time/**`, `src/utils/timer/**` | external retry/log/output/clock 与规则/调度分开 | quote IO在`infrastructure/longbridge/market`; `infrastructure/logger`, `infrastructure/display`, `infrastructure/time`; 唤醒编排在runtime，业务内聚pump仍属其owner；纯规则在domain/utils | 金融呈现P1起随首个消费者；其余P3–P6 | 金融格式化不经number；quote retry不留utils；timer经注入使用，domain不持timer；边界测试 |
| `src/utils/seat/**`, `src/utils/trading/**`, `src/utils/helpers/**`, `src/utils/error/**`, `src/utils/apiFailure/**`, `src/utils/runtime/**`, `src/utils/types.ts` | helper 按职责分到领域/use case/契约；通用纯工具保留 | `domain/seat`或`domain/order`, 对应 `application/*`, `src/types/` 或 `utils/` | 金融helper P1起随纵切；其余P3–P6 | 清理未授权decimalToNumber等金融调用，合法整数/指标保留；utils无业务owner，边界及分类差分测试 |
| `src/app/runtime/createPostTradeConsistencyRuntime.ts` | snapshot提交、settlement投影/readiness、调度与工厂拆开 | `application/accountPositionSnapshot`, `application/postTradeSettlement`；独立运行调度归runtime，app仅组装 | P1安全切片，P2 owner闭合 | 删除app中的业务完成实现，不以同义委托保留旧owner；r10/r11及wiring测试 |
| `src/types/services.ts` | Trader/市场/仓储/席位等超宽能力按真实使用范围分离 | 最近共同父级的窄types；跨层在`src/types/`，局部在模块`types.ts` | P1–P4随切面，P6残留 | 更新所有类型调用方，删除被替换接口，不建超级contracts |
| `src/types/state.ts` | canonical镜像、运行门禁/生命周期、其他状态分别归各owner | snapshot私有store在application；其余状态按runtime/application归属，公共只读view在窄types | P1移除snapshot镜像，P5/P6余项 | 无双存储或可写公共snapshot；不得将LastState原样改名为另一总状态 |
| `src/app/**`, `src/config/**`, `src/constants/**`, `src/types/**` 其余模块 | app组装、配置/集中规则、窄共享契约 | 按终态各自留 `app/config/constants/types`; strategy factory留app | P1/P3/P4/P5/P6 | app无业务完成条件；types无高层反向依赖；架构矩阵检查 |

`src/main/strategyPolicyAccess/` 在当前工作树中为空目录，不为它创建目标模块；实施时若该处新增了真实职责，应先按本表规则登记 owner，禁止复活空 façade。

现有 P0/P1 测试路径可暂留作为“迁移前基线”，但每条都有对应的最终测试镜像目录。新增测试从创建时即写入 `tests/<最终src职责>/`；闭合迁移时旧路径测试逐项移动并移除，不留下测试 facade。仅真实跨多 owner 的端到端场景留 `tests/integration/`。

### 4.2 owner 分配

| 事实/流程 | 唯一 owner 与物理位置 | 允许的输入 | 禁止的职责 |
| --- | --- | --- | --- |
| canonical account/position facts | `AccountPositionSnapshotCoordinator` + 私有 store；`application/accountPositionSnapshot` | broker read port、refresh request、day/generation token | domain 持 store/IO；业务 retry policy；第二 store；直接修改 LastState |
| post-trade ready 与 protective completion | `PostTradeSettlementWorkflow`；`application/postTradeSettlement` | snapshot receipt、order tracking 提供的可信 settlement/progress facts、position/待成交订单事实、projection result；domain 可提供纯判定规则 | protective/tracking 不得另作最终完成判定；不得有第二 completion append、daily-loss/cooldown/episode 内存提交者；SDK DTO、canonical snapshot 写入 |
| 席位身份/selection rules | `domain/seat` state/model + pure rules | seat commands、explicit time、seatVersion | 发 API、timer、直接更新账户/持仓 |
| 席位激活 | `application/seatActivation` | candidate、seatVersion、market/order/snapshot receipts | 直接决定其他方向状态 |
| 换标 | `application/seatSwitch` + `domain/seat` 显式 policy | periodic/distance policy、旧席位事实、新候选 | 合并不同 policy 为隐式 bool；新 wrapper owner |
| 普通 BUY / ordinary SELL | 现有 owner 分别直接迁至 `application/ordinaryBuy` / `application/ordinarySell` | 原信号、gate、实时事实和窄 port | 新增 facade/wrapper；统一交易流程 |
| auto search | `application/autoSearch`；筛选规则在 `domain/seat`，warrant IO/cache 在 infrastructure market | search trigger、strategy input、market facts | SDK查询、失败重试散落 runtime、重复缓存 owner |
| protective trigger/execution、static/doomsday liquidation | 分别由 `application/protectiveLiquidation`, `staticLiquidation`, `doomsdayClearance` 持有；纯规则在 `domain/liquidation` | purpose-specific trigger/order/position facts；protective 接收 readiness/gate | protective 不拥有最终 completion 判定/append/ready；不建共享第二订单账或跨目的混用 cooldown/completion；static/doomsday 仍保留各自既有 policy |
| order execution | `application/orderExecution` | internal command、gates、order facts | SDK类型/TradeContext、重复 tracking state |
| order tracking/recovery | `application/orderTracking` + `domain/order` | push/query facts、recovery input、durable facts | 另一个订单 ledger、ACK即终态、不同序列化 recovery owner |
| SDK command/fact mapping | `infrastructure/longbridge/trade`；market SDK映射在 `infrastructure/longbridge/market` | neutral internal facts/commands、SDK response/push | 买入风控、席位归属、清仓完成 |
| runtime lifecycle | 具体 `runtime/*` 程序 + app 的唯一 assembly/cleanup | 静态 lifecycle checklist、具名runtime refs | app 实现队列/timer/listener；统一 `stopAll` 覆盖策略 |
| trading-day rebuild use case | `application/tradingDayRebuild`；日切协调仍在 `runtime/lifecycle` | epoch、snapshot/seat/order facts、explicit rebuild command | app/runtime重建同一业务、重复推进epoch |

### 4.3 Command、Gate、Fact Event、Notification

实现中必须维持四类边界：

- **Command**：表达待执行意图，例如 `SubmitOrdinaryBuy`、`ActivateSeat`、`ReassessDoomsday`。
- **Gate**：判断当前动作是否允许，例如 `OrdinaryBuyGate`、`SettlementReadyGate`。
- **Fact Event**：表达已经发生且可审计的事实，例如 `OrderAccepted`、`OrderTerminalConfirmed`、`PositionSnapshotCommitted`。
- **Notification**：日志、监控、告警观察消息，不能推进业务完成。

以下等价关系必须禁止：

```text
OrderAccepted != OrderTerminalConfirmed
PositionSnapshotCommitted != PostTradeBusinessReady
queued notification completed != durable business commit
```

### 4.4 数值分类与已确认精度口径

**精度边界以文首已确认记录为准；本节按已确认解释口径执行，不是只迁移 SDK 的行为冻结，也不是所有数字统一 Decimal。**

| 数值类别 | 目标表示与运算 | 允许的 number 边界 |
| --- | --- | --- |
| 价格、回收价、现金/净资产、市值、成本、成交/回补金额、盈亏和亏损偏移 | SDK/配置输入保真；跨层金融 facts/commands 使用规范十进制 string，domain/application 财务计算和状态使用独立 Decimal 或其保真文本 | 不允许用于金融运算、阈值判断、状态缓存、持久化或金融显示的中间投影 |
| 回收价距离、金融涨跌/仓位比率、成交额筛选及金融阈值 | 独立 Decimal 计算/比较；保留百分比/小数比值单位换算和各处严格/包含边界 | 不在比较前用 toFixed、显示舍入或 number；技术指标阈值不属于此行 |
| 数量、手数、可卖量、订单占用量 | 仅已证明为安全整数的值可使用 number；其他值保留 Decimal/文本并遵守原数量策略；金额换算买量使用精确整数商并整手对齐，不先求近似商再 floor | 转换前证明整数性与 `Number.MAX_SAFE_INTEGER` 范围，聚合/增减后的结果也验证；不截断非法小数或用隐式转换绕过 |
| 时间、时长、版本、revision、计数、数组索引 | 保留 number/Date 及现有含义；整数值按各自契约验证安全范围，版本不混用 | 原生时间/数组/timer 与结构性整数运算无需 Decimal；内部溢出 fail-fast |
| EMA/MACD/KDJ/RSI/ADX/MFI/PSY 等技术指标及其阈值/样本 | 保留现有 number 递推、三位投影、缺省/非有限值处理、信号比较与延迟验证规则 | 仅在指标输入投影处按既有规则转换；投影不回写金融事实，不能将技术指标接口改造为全链路 Decimal |
| 金融显示与 durable 序列化 | 显示是明确位数的定点 string；durable 是 V1 严格规范十进制 string | 均不经 number 再格式化；非金融指标显示可继续 number.toFixed，计数直接转文本 |

**必须闭合的契约与边界：**

1. SDK 金融值在 trade/market adapter 读取原十进制文本并映射为中性 fact；domain/application 不透传或包装 Longbridge Decimal。金融配置/阈值和集中常量从文本解析，不先 `Number/parseFloat` 参与计算；保留合法输入范围、单位及原失败分类。
2. `OrderCommand.price` 采用 `string | null`，`quantity` 延续十进制 string；account/position、quote、order execution、risk、switch 和 settlement 的金融字段及全部调用方同步迁移。整数数量可以有经过验证的 number view，但不可把该规则推广到价格/金额。
3. 成本乘加、估值/涨跌、买量、回收价距离、候选筛选、R1/R2、日损益、累计金额及 baseline 差额/均价留在所属 domain；恢复/择新编排留 application，通用纯算术留 `utils/numeric`。SDK mapper 不代算业务公式，display adapter 不成为金融事实或完成条件 owner。
4. 删除金融链路旧 `decimalToNumber`、`toNumber`、原生金融 `+/-/*//`、`Math.min/max` 和 `toFixed` 的未授权使用及旧 number 缓存；替换为明确十进制运算。合法整数/指标调用仍可保留，不全仓机械禁用这些函数或运算符。
5. P0 按文首已确认口径验证独立库版本、下述合法输入范围、精确运算接口及实际业务计算容量；不自行决定新的业务量化/舍入政策。基础加减乘及比较保持精确，不因统一有效位设置静默舍入；三位是金融结果的精度目标，除金额配置的明确限制外，不作为 SDK 输入或中间状态的统一 scale 上限。不以固定 80 位或更大的全局精度代替精确整数商、金额/数量口径及交易比较，也不要求无限输入规模或任意运算链的精度保证。价格步进/订单约束保持；策略在启动前固定，不允许运行中修改全局精度。
6. 金融显示从精确值或原始分子/分母直接按各字段既定展示位数一次 half-even 并生成定点文本，不先统一舍入三位再舍入到显示位数；输出用除法不得成为后续财务状态或交易判断的输入。零值、符号和位数分别验证。V1 写入采用其既有无指数、无多余尾零的规范文本，读取不改写旧文本/schema；显示补零或量化值不回写金融事实。恢复后的金融状态不转 number；同量时间/revision 择新、排序键优先级和 OPEN/TERMINAL 规则保持。

**输入范围与除法用途的补充边界：**

- **金额配置：**买入金额、持仓市值上限、最大浮亏及成交额阈值等金额类配置，整数部分最多 10 位、小数部分最多 3 位，最大非负值为 `9,999,999,999.999`。去除首尾空白后只接受普通十进制文本，不接受科学计数法；从原始文本校验后直接解析，不先经 `Number/parseFloat`。默认值遵守同一约束；各字段原有单位、正数/允许零值规则保持，超出范围直接作为配置错误拒绝，不自动截断或舍入。该上限不套用于实际卖出回补预算或其他派生金额。
- **外部与历史事实：**SDK 成交均价、账户成本、价格和金额保留原十进制值；不能为了满足配置格式而截断到三位，也不对 V1 旧文本追加配置位数校验或改写。合法性及失败分类仍由原所属链路处理，不自行增加外部事实的三位限制。
- **买量除法：**预算 `A`、价格 `P` 为正且每手数量 `L` 为有效正整数时，直接求 `A ÷ (P × L)` 的精确整数商，再乘 `L`；不先做近似除法再 floor。按既有名义金额口径，结果 `Q` 必须满足 `P × Q ≤ A < P × (Q + L)`，不足一手时 `Q = 0` 并沿原规则跳过；不改变显式数量、卖量裁剪或费用政策。
- **均价除法：**保留已有成交/分段金额与数量作为后续计算依据；成本、日损益不通过舍入后的均价乘回数量重建。数量为正时，当前价高于成本均价等价于 `当前价 × 数量 > 成本金额`；均价之间的比较/排序使用对应金额与数量交叉相乘，其他排序键和包含关系保持。需要展示均价时才按输出位数求商，不新增通用有理数系统或持久化 schema。
- **比率除法：**用于风险阈值、候选筛选或排序时，在已有正分母前提下通过交叉乘法等精确等价运算判断，不比较舍入后的比率。例如回收价为正时，`(当前价 − 回收价) ÷ 回收价 × 100 < 阈值` 等价于 `(当前价 − 回收价) × 100 < 阈值 × 回收价`；百分比单位及严格/包含边界不变。比率仅在终态输出时按目标位数一次舍入，不回流交易判断。

**迁移门禁：**P0 记录旧输入/运算/投影位置，并为每个金融字段列出目标契约、生产者、全部消费方、允许投影及闭合阶段；P0 只按文首已确认口径做库版本、输入范围与内部计算容量的工程验证，不另定业务量化/舍入政策。首个相关新层消费前，完成独立 numeric、所需 mapper、财务状态/全部调用方及显示的完整纵切；可先在旧来源实现必要切片，不能增加有损兼容层、双写或把缺口推迟到 P4。精度变化按 §13.4.2 做离线验收；真实历史恢复和候选/回退版本证明仍是 §15 的未来生产发布阻断项。

---

## 5. 实施依赖图与合入策略

### 5.1 总体依赖图与依赖白名单矩阵

```text
P0 行为基线、文首已确认精度口径的独立库工程验证、终态矩阵和 staged probes
  -> P1 snapshot 正确性纵切 + 保真 account/position facts/mapper 与全部金融消费者/所需 quote 切片
  -> P2 settlement readiness 与 protective completion 唯一 owner 闭合 + 所需成交金额/损益/baseline 财务状态精度闭合
  -> P3A owner收口验收 -> P3B protective trigger/purpose/pre-execution gate/execution -> P3C activation -> P3D switch
       -> P3E doomsday -> P3F ordinary buy/sell + autoSearch + static liquidation + risk refresh
  -> P4.1 internal facts/ports -> P4.2 command execution -> P4.3 order tracking/recovery
       -> P4.4 snapshot-read seam 收尾（不是首次建模/映射） -> P4.5 SDK leakage zero
  -> P5 rebuild owner 闭合 + runtime lifecycle checklist + app assembly/cleanup 验证
  -> P6 旧目录/旧入口/宽契约残留清理与物理验收
  -> 离线静态/动态全链路验收与 mock/脱敏 fixtures 恢复演练

真实历史逐条对账及精度迁移后候选/回退版本完整恢复属于后续生产发布阻断，不计作本轮离线实施完成；本轮不发布、不开门、不连接实盘。
```

P1/P2 修改 `core/main/services` 现有来源代码是闭合安全切面的必要工作，不因目标目录已确定而推迟。P1 提前建立最小账户/持仓中性 facts、窄 read port 和 Longbridge mapper，阻断 SDK 契约进入 snapshot/application；P2 的 readiness receipts 和协作 port 同样只能用内部事实，若现存协作者类型泄漏 SDK，先做最小 facts/mapper 切片，不可新增 legacy SDK 例外。任何 P3 workflow 在移入 `application/**` 前，必须先闭合其所需的最小内部 facts/ports/adapter mapper；缺口可在旧来源路径做切片或暂留未闭合旧实现，不可把 SDK import 带入新 owner。P4 继续收口其余 order/query/market adapter；P4.4 只收尾剩余 account/position SDK read/query 映射和 BUY/SELL 读路径，不是第一次创建 account/position contract、mapper 或 snapshot port。

| 发起层 | 允许静态 import | 禁止规则 |
| --- | --- | --- |
| `app/**` | `application/**`, `runtime/**`, `domain/**`, `infrastructure/**`, `config/**`, `constants/**`, `types/**`, `utils/**`（仅 composition/factory） | 业务决策/完成条件；自身实现 queue/timer/listener；容器/服务定位器；直接 SDK import |
| `application/**` | `domain/**`, `types/**`, `constants/**`, `utils/**` 及本层无环的必要协作；工厂装配仍在app | 静态依赖 runtime/app/infrastructure；SDK DTO/enum/Decimal/TradeContext；直接持久化或外部 IO 实现 |
| `runtime/**` | `application/**`, `domain/**`, `types/**`, `constants/**`, `utils/**` 及本层无环的必要协作 | 静态反向依赖 app/infrastructure；私有业务完成条件；全局调度器或动态 registry；SDK 类型 |
| `domain/**` | `domain/**`, `types/**`, `constants/**`, `utils/**` | application/runtime/app/infrastructure；网络/文件/logger IO；timer/queue/scheduler；SDK |
| `infrastructure/**` | `types/**`, `constants/**`, `utils/**`, 本 adapter/infra 内部中性模块 | application/app/runtime；未经中性契约直接依赖上层；将业务 policy 塞进 SDK mapper |
| `config/**`, `constants/**`, `types/**`, `utils/**` | 同层或更低层的中性模块（`types` 可用 domain-neutral types/constants/utils） | 反向依赖 app/application/runtime/infrastructure 实现；循环依赖；utils 承载 IO/业务 owner |
| tests | 镜像被测模块的依赖；新增测试仅 `tests/infrastructure/longbridge/**` 可构造 SDK fixtures | type-only/dynamic/test helper/re-export绕过；P0前已存在的测试fixture只按冻结 occurrence 白名单暂存，不能新增 |

此矩阵对运行时 import 与 `import type` 一视同仁；port 回调/协作对象由上层注入，不等于 static reverse import。跨层共享事实/port 放最近共同父级现有 `src/types/<narrow>.ts`，本地契约相邻放置；禁止新增 contracts 超级中心或 `types` 反向依赖高层实现。`app` 是唯一允许静态装配 infrastructure adapter 的层，SDK 本身只能由 infrastructure/longbridge adapter import。

**阶段例外固定且只缩不增：** P0 对当前 production source 和 test fixtures 分别建立按“文件 + import specifier + SDK symbol/type”的实际 occurrence 清单并冻结，不以整个目录 wildcard 放行。源码基线候选明确包括 `src/app/types.ts`、`src/config/**`、`src/constants/index.ts`、`src/core/{doomsdayProtection,orderRecorder,orderStatusLifecycle,riskController,strategy,trader}/**`、`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`、`src/services/{autoSymbolFinder,autoSymbolManager,quoteClient}/**`、`src/types/{config,data,risk,services,signal,trader}.ts`、`src/utils/{numeric,apiFailure,helpers}/**`；以 P0 实测 occurrences 为准，不在清单的文件不得获得例外。旧基线 tests fixtures 同样逐 occurrence 冻结，只允许未迁移的旧测试来源，新增测试 SDK fixtures 仅在 `tests/infrastructure/longbridge/**`。P1 将账户/持仓 DTO、枚举/数值映射与 read port 从旧来源切至内部 facts/`infrastructure/longbridge/trade`，只保留逐项记录的 order 等待 P4 旧 occurrences。P2 收口 settlement collaborator contracts，相关旧 SDK types 切成中性 facts/mapper；新 settlement/domain/application 一律零例外。P3 每闭合一个 owner 即删该组 source/test occurrence。P4.5 后生产 SDK import 白名单仅 `src/infrastructure/longbridge/{trade,market}/**` 真实 adapter/mapper；不得将旧 exception 搬进新目录。P5/P6 不再有旧 SDK 或业务 test fixture 的 SDK 例外。

**旧非 SDK 依赖边单独管理：** 上表是最终依赖矩阵，不要求 P0 将所有 app→旧实现边同时清零。P0 另生成“来源文件 + 解析后目标文件 + 使用能力 + 闭合截止阶段”的全量旧依赖边清单，禁止目录级放行。以下为已核对的装配边示例；全量清单须包括其余 app 工厂、旧模块及 type-only 边：

| 现有来源文件 | 现有目标文件 | 删除旧边的截止阶段 |
| --- | --- | --- |
| `src/app/runtime/createPostGateRuntime.ts` | `src/core/doomsdayProtection/index.ts` | P3E |
| `src/app/runtime/createPostGateRuntime.ts` | `src/services/liquidationCooldown/index.ts`、`tradeLogHydrator.ts` | P3B |
| `src/app/runtime/createPostGateRuntime.ts` | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` | P5；P1先切断其canonical写入 |
| `src/app/runtime/createPostGateRuntime.ts` | `src/main/quoteSubscriptionRuntime/index.ts` | 最迟P5；P1先完成只读snapshot及迟到投影保护 |

旧 owner 未迁移时，既有装配边按记录阶段暂存；合法的新 app→目标层装配边不属于例外。P1 为避免提前重写整个 Trader，单独授权旧 `src/core/trader/index.ts` 在原装配点用同一个现存 context 创建真实 account/position read adapter；这是有效 I/O 实现，不是兼容 façade，不能借此新增 SDK 业务传播。该特定旧装配边登记并在 P4 context/生命周期收口时删除，届时恢复 app 唯一组装根规则。

新 domain/application/runtime 不得静态依赖旧混合实现，必要协作由 app 将中性窄 port 注入。文件搬到新层不能继承旧例外，既有调用方改用新 owner 后立即删除对应旧边。扫描须有正反例：未到期的既有 app 装配边通过、同一依赖搬入新 application 失败、截止阶段后旧边失败、合法层内共享类型通过。

**精度任务随架构纵切交付，不新增一个末尾“补精度”阶段：**

| 阶段 | 精度闭合要求 |
| --- | --- |
| P0 | 按文首已确认精度口径记录旧转换位置、建立目标/受控差异清单，仅做库版本、输入范围、内部计算容量的工程验证及 mock/脱敏 fixtures 离线恢复验证，不自行决定业务量化/舍入政策。真实历史对账和候选/回退完整恢复留作未来发布门禁 |
| P1 | account/position 金融事实、最小 trade/quote mapper、全部 reader 的估值/风控/显示同步迁移；相依成交/风险字段提前做必要切片，不回转旧 number 接口 |
| P2 / P3B | 首次 settlement 消费前闭合累计金额、日损益、R1/N1、progress/baseline 与 durable 输入；P3B 迁移 owner 时复验，不首次补救已放行的有损状态 |
| P3D / P3F | 换标预算/回补、普通 BUY/SELL、价格限制、距离/静态清仓、autoSearch 金融筛选与风险计算闭合；公式、单位和阈值关系保持 |
| P4 | 收余下 SDK query/push/command mapper 与金融显示；§13.4.2 全矩阵复验，未授权金融 number 边界清零 |
| P5 / P6 | 完整启动/开盘重建/日切离线链路及 fixtures 恢复演练；清理旧契约/工具调用/测试引用，不首次迁移金融精度。真实历史对账、精度迁移后候选/回退完整恢复仍是未来生产发布阻断项 |

可并行：P2 后可准备 P4 order DTO/mapping 研究和 adapter 专属测试；不能因此把 P4 未闭合类型引入新 workflow。P3/P4 改同一调用链时串行。P5 等 P3/P4 owner 闭合；P6 等 P1–P5 业务与精度迁移完成。

### 5.2 每个可运行合入单元的门槛

下列门槛约束闭合合入单元，不要求每个开发分支内部提交都能独立运行；尤其不得据此拆开 P1 安全纵切。

每个可运行合入单元必须包含：

1. 变更涉及的内部类型/接口。
2. 全部直接调用方迁移。
3. 旧 writer/旧入口删除。
4. 对应测试更新或新增。
5. 架构扫描更新。
6. 依序执行 `bun format → bun lint → bun type-check`，再执行相关 `bun test` 的结果。
7. 涉及数值字段时附 §4.4 迁移清单及 §13.4.2 目标/差分证据；类型、状态、恢复和显示全部消费方闭合，旧误差修正与非数值行为等价分别验证。
8. 不涉及的范围和未解决风险说明。

禁止将“暂时保留旧入口，下一阶段再删”作为合入条件。

---

## 6. Phase 0：冻结行为基线与建立保护网

### 6.1 目标

在任何 owner 迁移前，建立可重复验证的旧行为基线及 §4.4 精度验收准备；精度口径已由用户确认，P0 只增加离线验证、静态检查和观测，不改变生产交易逻辑；旧浮点误差只作为差分证据，不冻结为目标正确行为。

### 6.2 任务清单

#### P0.1 建立基线测试清单

至少固定以下测试组：

- `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`
- `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- `tests/main/lifecycle/rebuildTradingDayState.test.ts`
- `tests/integration/postTradeDrainLifecycle.integration.test.ts`
- `tests/core/trader/submitFlow.errorClassification.business.test.ts`
- `tests/core/trader/orderMonitor/terminalSnapshotFacts.business.test.ts`
- `tests/core/trader/orderMonitor/ordinaryRawExecutionFacts.business.test.ts`
- `tests/core/trader/orderMonitor/openStateAmountRevision.business.test.ts`
- `tests/core/trader/protectiveLiquidationEpisodeTracker/protectiveLiquidationEpisodeTracker.business.test.ts`
- `tests/main/seatActivationDispatcher/seatActivationDispatcher.business.test.ts`
- `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
- `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.business.test.ts`
- `tests/integration/protectiveLiquidation.integration.test.ts`
- `tests/integration/strategyRecoveryStartup.integration.test.ts`
- `tests/main/lifecycle/cacheDomains/signalRuntimeTermination.test.ts`
- `tests/app/runApp.business.test.ts`

若某文件路径在当前分支不存在，以实际对应测试路径替换，但必须保留同一业务切面。上列均是迁移前基线路径，不代表最终测试位置；按第 4.1.2 的 `tests/<src终态职责>/` 镜像迁移。典型对应为：

| 当前基线测试路径 | 最终测试职责路径 |
| --- | --- |
| `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts` | `tests/application/postTradeSettlement/` 与 `tests/app/runtime/` 的工厂 wiring 测试分开 |
| `tests/main/lifecycle/{loadTradingDayRuntimeSnapshot,rebuildTradingDayState}.test.ts` | `tests/runtime/lifecycle/` + `tests/application/tradingDayRebuild/` |
| `tests/core/trader/submitFlow.*.test.ts` | `tests/application/orderExecution/` |
| `tests/core/trader/orderMonitor/*.test.ts` | `tests/application/orderTracking/` + `tests/domain/order/` |
| `tests/core/trader/protectiveLiquidationEpisodeTracker/*.test.ts` | `tests/domain/liquidation/`；workflow/settlement tests 到 `tests/application/` |
| `tests/main/seatActivationDispatcher/*.test.ts` | `tests/application/seatActivation/`；dispatcher wiring 到 `tests/runtime/seatActivationDispatcher/` |
| `tests/services/autoSymbolManager/switchStateMachine.*.test.ts` | `tests/domain/seat/` 与 `tests/application/seatSwitch/` 按纯规则/用例拆分 |
| `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.*.test.ts` | `tests/application/staticLiquidation/` + 对应 runtime wiring |
| `tests/main/lifecycle/cacheDomains/signalRuntimeTermination.test.ts` | `tests/runtime/lifecycle/` |
| `tests/app/runApp.business.test.ts` | `tests/app/` 仅保留 composition/wiring assertions |
| `tests/integration/*.integration.test.ts` | 保持 `tests/integration/`（确属跨 owner 端到端时） |

P0 可暂时在当前基线路径运行；每个新增测试必须从创建时就位于最终职责目录，迁移完成删除旧测试文件，不留 forwarding test。README/AGENTS/其他旧路径文档只在实施对应迁移时定向更新，本次仅记录映射。

#### P0.2 建立行为探针

增加只读探针或测试断言，记录：

- freshness stale/current 版本变化。
- seat activation 起止和最终状态。
- snapshot writer 调用来源。
- unknown submit、cancel acknowledged、terminal confirmation。
- protective progress/completion 顺序。
- protective ELO 零成交、部分成交及恢复后遇到静态新增量时，共享合单的旧单身份、分支和累计 progress；记录当前可达的污染，不把它冻结为正确目标行为。§13.4.1 的隔离目标由 P3F 闭合验收。
- 午夜清理和开盘重建顺序。

探针只用于日志/测试，不自动改变策略。

#### P0.3 增加分阶段架构保护规则

在现有 `tests/architecture/importBoundary.test.ts`、`strategyBoundary.test.ts`、`typeOrganization.test.ts` 基础上按阶段收紧，不能让 P1 先依赖 P4/P5：

| 规则 | P0 冻结/保护行为 | 严格目标与例外收缩时点 |
| --- | --- | --- |
| 终态目录与 owner | 固定第 4.1.2 来源/目标/阶段清单；记录现存旧目录 owner，不允许新增第二 owner | 每个闭合切面进入目标目录并移除来源入口；P6 旧 core/main/services 生产残留为零 |
| canonical writer | 固定全部现有 writer/readers 名单并禁止新增旁路 | P1 全 writer、readers 与 `LastState` 可写镜像归零后强制 |
| 金融数值边界 | 记录字段级旧投影与§4.4合法整数/指标边界；新金融契约不新增number桥接 | 每个纵切删除对应金融投影并验证实际值；P4金融未授权number状态/格式化归零，不能全仓禁用number运算 |
| 新 domain/application SDK import | 从 P0 即拒绝任何新 import/type-only 泄漏；P1/P2迁移的旧路径按固定逐文件基线暂存 | 目标层始终零例外；P1账户/持仓切片，P2 settlement契约切片，P3逐 owner 缩旧例外，P4.5生产只剩infra/longbridge adapters |
| legacy SDK baseline | 精确记录 §5.1 列出的现存 core/trader、orderRecorder、types、strategy/Period、numeric、quote/warrant adapter来源 | 只许可原文件未闭合部分；迁走即删路径例外；不得拓展到新 app/domain/application 或新测试 |
| `TradeContext.new` | 当前 `src/core/trader/index.ts` 作为唯一旧创建来源被检测；不新增第二context | P1 真实read adapter可在旧Trader装配点接收现存context并向snapshot提供窄port，app/application不接触SDK context；P4将创建/生命周期整体移入trade adapter并删旧创建例外 |
| runtime 生命周期覆盖 | 记录既有创建/启停/cleanup；禁止另建registry | P5 静态 checklist完成后强制验证，执行仍用现有具名runtime/cleanup |
| service locator / global registry | 禁止新增使用；backtest-kit仅借鉴原则 | P0起全阶段 |
| type-only/dynamic/test bypass | 与常规 import 同样扫描；adapter fixtures 仅在 adapter tests | P0起全阶段 |

P0 冻结例外是测试扫描的已知旧源白名单，不是生产兼容层或目标层授权。扫描须对新违规 fail、对合法 adapter 探针 pass，并按阶段删白名单；不得为了通过而放宽整个目录或延后 P1/P2 安全移植。

#### P0.4 建立金融精度目标与独立十进制迁移门禁

以设计 §8.4 和本计划 §3.6 的真实调用链记录旧 number/string → Decimal → number/string 及多次投影，但不再冻结这些金融投影为终态。按文首已确认口径及 §4.4 列出每个金融字段的保真输入、状态、公式/比较、输出及全部消费方；安全整数和技术指标的合法 number 边界单独登记。

- 承接固定为 **独立十进制库 + SDK 无关 `utils/numeric` 纯算术**。候选库优先评估 `bignumber.js`，P0 验证并锁定实际版本；选型须证明十进制输入保真、加减乘及比较精确、直接整数除法和终态一次舍入可用，不能只检查配置的精度位数。不自建任意精度框架。领域公式/财务状态归对应 domain，用例/恢复排序归 application；SDK 构造/解析归 adapter，不包装 Longbridge，也不让 mapper 计算买量/盈亏。
- P0 按 §4.4 的金额配置 10 位整数/3 位小数约束、SDK/历史事实保真及三类除法用途验证库接口和实际业务容量；三位不作为其他输入或中间状态的统一 scale。验证配置边界、整手预算边界、金额/数量口径、精确阈值比较及一次 half-even 输出，不以固定 80 位或“使用 Decimal”冒充无限精度；不得另行选择业务量化/舍入政策，不修改生产逻辑或旧日志。
- 差分分三类：①旧纯十进制有效结果、业务公式/单位/阈值关系及非金融行为保持；②旧 number 运算/投影误差按独立十进制目标修正并登记临界决策变化；③历史 durable 冲突、无法证明恢复或回退的情况按 §15 阻断，不以容差或改写文本消解。目标断言不能只复制旧实现。
- 强制买量：旧输入金额 `7000`、价格 `0.07`、每手 `10000` 与新金融文本输入必须同得 `100000`，不能退化为 number 算法的 `90000`。同时验证原生 `0.1 + 0.2` 的误差、事后转 Decimal 不能修复，以及移除金融投影后的目标结果。
- 按已确认口径离线验证金融显示直接定点输出、沿用各字段既定展示位数及 half-even；现有 `roundDp` 样例 `1.005 → 1.00`、`1.015 → 1.02` 用于显示规则验证。显示位数不用于中间状态量化；指标 number.toFixed 不在删除范围。
- 离线 P0 使用 mock/脱敏 fixtures 演练 V1 读取、买/卖 baseline、同 revision 数量/金额/阶段、crash-gap completion、日损益分段及冷却；fixtures 只验证离线链路，不替代真实历史对账。结构/ID/冲突规则保持，不要求新精确金额文本与旧 number 结果相同，不伪造权威 revision。真实旧 V1 日志与对应权威订单输入的逐条对账及完整恢复留作未来生产发布阻断。
- SDK 基线/映射探针只在 `tests/infrastructure/longbridge/{trade,market}/`，目标 numeric/domain/application 用中性 fixture；测试从创建时遵循最终职责镜像。
- 首个相关新层消费前完成通用算术、所需保真 mapper、全部调用方和财务状态/显示切片，并删对应旧例外。P1/P2/P3 所需切片不等 P4；旧 `utils/numeric` 的 SDK 依赖或有损 number 接口不能成为过渡例外。

以下任务和 §13.4.2 均为未来实施要求；此次仅修订计划，没有选定/安装库或新增测试，不表示已实现精度升级或完成恢复演练。

### 6.3 P0 验收

- 基线测试通过。
- 已记录当前各切面的测试命令和结果。
- P0.4 旧转换位置、目标字段/边界与受控差异已登记；按文首已确认精度口径，对库版本、输入范围和内部计算容量经离线工程验证。有效旧十进制结果保留，旧浮点误差用独立目标验证，不用宽松误差容限抹平差异。
- 架构扫描能够识别新增违规。
- 没有交易逻辑和持久化格式变化。

### 6.4 P0 退出条件

P0 完成后才能开始 P1。若基线测试存在失败，必须先区分既有失败与本次新增失败；未建立清晰基线，或 P0.4 的目标/库工程验证、差异分类及离线 fixtures 恢复演练未明确，不得进入 snapshot writer 和相关金融契约/数值迁移。真实生产数据对账与候选/回退版本完整恢复证明仍必须在发布前按 §15 执行，不能由离线 fixtures 替代。

---

## 7. Phase 1：建立 Canonical Snapshot Coordinator

> P1 是本次重构的最小正确性纵切，必须在一次闭合迁移中完成全部 writer、全部消费者、失效通知和 pending settlement token 校验。末日 submit UNKNOWN 按 §1.1 统一为直接 fatal，不在本次重构中新增 UNKNOWN overlay、接管或重启恢复协议。不能交付“新 coordinator + 旧 writer 仍存在”的半成品。

### 7.1 目标

建立唯一的账户/持仓事实提交者：

```text
refresh request
  -> pending merge
  -> single in-flight canonical batch
  -> broker account/position read
  -> epoch/generation validation
  -> atomic component/paired commit
  -> immutable receipt/view
```

### 7.2 设计与类型任务

#### P1.1 定义 snapshot 内部类型

终态实现位置：

```text
src/application/accountPositionSnapshot/  # coordinator、request coordination、generation、private store、internal pump
src/types/accountPosition.ts              # 跨层共享的窄 snapshot fact/receipt/read-port contract
```

P1 可以先修改 §3 中 `src/core/**`、`src/main/**`、`src/utils/positionCache/**` 等现有来源路径完成安全纵切；它们只作迁移来源，不是新目标层。SnapshotCoordinator 连同 network request coordination、generation、private store 和注入 scheduler port 驱动的 pump 属 application owner；domain 只承载纯事实/规则/状态迁移，不拆第二 owner。模块内私有 waiter/pump types 放相邻 `types.ts`。

具体命名可按实际实现调整，但必须包含：

- `AccountPositionSnapshotView`：只读账户、持仓、component revision、paired revision，以及明确的 account/positions 初始化与有效性状态。
- `SnapshotRefreshRequest`：source、dayEpoch、refreshAccount、refreshPositions、参与者信息。
- `SnapshotClearRequest`：日切/终止原因和 epoch。
- `SnapshotCommitStatus`：admission、inFlight、pending、generation、revision。
- `SnapshotRefreshReceipt`：结果状态、epoch、generation、commit revision、覆盖字段、component revision、不可变 view。
- `SnapshotReadPort`：账户/持仓 broker read 能力。
- waiter 的 resolved/rejected/cancelled 结构。

账户/持仓 fact、read result 和跨层窄 read port 在 P1 即采用 §4.4 的保真中性契约：现金、净资产、成本/价格、市值等金融字段使用规范十进制文本，数量的 number view 须证明安全整数；epoch/revision/version 继续 number。SDK DTO/枚举/Decimal 由 `infrastructure/longbridge/trade` 最小 mapper 处理，所需 quote 金融 mapper 同步提前；不等 P4。

同一 P1 可运行纵切迁移全部 snapshot reader、估值/风控/选单/显示及其相依字段，必要 order/risk/numeric 切片可先改旧来源再随 owner 迁移。禁止为让旧消费者继续工作，把新金融 fact 回转 number 或添加旧接口适配层；不能只升级 store 的类型。遵循项目 TypeScript 规范：数据用 `type`，能力用 `interface`，属性默认 `readonly`；不在 `index.ts` 内联公共类型，不做 re-export。

#### P1.2 实现版本协议

必须实现：

- `dayEpoch`：午夜先关闭 admission 并推进旧 epoch 失效，再执行 drain/clear。
- `snapshotGeneration`：重建开始、已知成交、日切，以及 P1.9 原条件下的末日已确认提交使账户失效时同步推进。该账户失效操作本身不登记新的 settlementVersion/成交刷新需求；期间真实成交仍按原协议登记。submit UNKNOWN 直接走终止协议，不新增专用重查代次。
- 已知成交的 generation 失效与 `recordSettlementRefreshNeed` 必须在订单事实成功结算的同一同步段登记，不能交给下一轮 notification；保护性 progress 持久化失败时不提前发布权威成交事实。
- 同日重建重试只更新 generation，使用日切已建立的 epoch；清理重入不得重复推进同一次日切 epoch。
- `commitRevision`：仅合法 commit 递增。
- account/position/paired revision 分开维护。
- 同一 epoch 内 revision 单调；新 epoch 比较时带 epoch。

#### P1.3 实现 single-flight/pending 状态机

内部只保留：

```text
admissionState
currentEpoch
currentGeneration
inFlight
pending
```

规则：

- 一次最多一个 canonical batch in-flight。
- pending batch 只能合并尚未发出的字段并集。
- 发起 API 后冻结字段、参与者和 generation。
- 新需求不能附着到已发 batch。
- 双读必须使用 `Promise.allSettled` 等待全部 settled，不能因一项失败提前 drain。
- account+positions 组合读取任一失败都不提交任何一半。
- position-only 只能发布 position component，不得让调用方误以为 account 已同步。
- 过期成功结果丢弃并把仍有效参与者转入后继 pending。
- 外部失败交给调用方 owner 决定重试，coordinator 不建立统一 retry policy。
- 每个 waiter 恰好 resolve/reject/cancel 一次；只有 COMMITTED receipt 可以推进业务，SUPERSEDED 仅为内部转移，ABORTED 沿既有生命周期取消语义处理。
- 同一共享 batch 中单个 seat waiter 取消不能取消其他 waiter。
- 合并双读失败保留实际失败组件，position-only waiter 不能收到未提交的“成功”；分别交回原 owner，不能将 seat 失败升级为全局 fatal。
- 请求拒绝观察点立即上报内部错误以关闭交易；同时仍须等待该批全部 API settled 才允许 drain 完成，不增加新超时或假取消策略。

#### P1.4 实现只读事实边界

私有 store 的 commit 和内部索引不能注入业务调用方。由 coordinator 按实际使用范围暴露最小能力：

- 消费者：不可变 snapshot view、只读 position lookup 和状态查询。
- refresh owner：`requestRefresh()`，含 source/字段和独立取消参与者能力。
- 订单结算/末日 owner：受限的事实失效登记、账户有效性失效能力，不提供直接赋值。
- lifecycle/composition：关 admission、日切失效/clear、stop/drain、恢复重建 admission 的能力。

具体方法在 P1.1 定稿，`requestClear()` 的同步失效/取消与实际 API drain 必须明确区分；不为方法名统一暴露一个超级接口。

不得暴露：

- 可写 `Map`。
- `positionCache.update()`。
- LastState 镜像对象。
- 直接修改内部数组元素的引用。

同步 commit 只能替换内部引用和索引，不 await、不调用业务回调；业务通知在 owner 收到 receipt 后通过既有语义通道推进。

### 7.3 组装与迁移任务

#### P1.5 接入 composition root

由 `src/app/runtime/createPostGateRuntime.ts` 这个工厂装配并持有 `application/accountPositionSnapshot` owner，显式注入：

- P1 内部 account/position read port（由提前的最小 Longbridge facts/mapper adapter 实现；不得把 `TradeContext`/SDK types 传入 owner）。
- scheduler/clock port（驱动 owner 内部 pump；不拆第二 pump/runtime owner，也不新增全局 scheduler）。
- termination/admission 控制。
- logger/metrics 观察能力。

通过 `resources` 暴露只读 runtime capability，不让业务模块从全局容器获取。app 工厂只装配，不复制 coordinator 逻辑。

#### P1.6 迁移启动/开盘重建

以下是现存来源路径。P1 在 loader/rebuild 原调用链完成 snapshot writer/readers 与安全协议改造，不要求同时迁移整套订单/风险/席位重建用例。完整重建 owner 统一在 P5 闭合至 `application/tradingDayRebuild`，日切协调归 `runtime/lifecycle`；P3C 先完成其 activation barrier 接入。P1 若某旧 helper 已仅剩转发，立即删除并让调用方直接使用窄 snapshot 能力，不保留 façade：

- 来源 `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`、`src/main/lifecycle/rebuildTradingDayState.ts` -> `src/runtime/lifecycle/` 调度 + `src/application/tradingDayRebuild/` 用例。
- 来源 `src/app/startup/startupSnapshot.ts`、`src/app/runApp.ts` -> `src/app/startup/` 与 composition；app 仅装配/验证调用。
- canonical read/commit -> `src/application/accountPositionSnapshot/`，共享契约 -> `src/types/accountPosition.ts`。

要求：

- 启动/重建双读仍在两项成功后成对提交。
- 用 snapshot owner 的显式初始化/有效性状态替换 `lastState.cachedAccount === null` 判断；持有旧 view 不等于账户仍有效，初始化与重建仍成对读取。
- 运行时标的验证读取 snapshot view，不读 LastState 镜像。
- 初始 API 外部失败继续进入 `API_RETRY_PENDING`/开盘重建语义。
- 内部错误仍立即 fail-fast。

#### P1.7 迁移席位刷新

以下现存来源可在 P1 修改以去除 writer，并在 P3C 闭合迁入最终 owner：

- 来源 `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`、`handlers/seatRefresh.ts` -> `src/runtime/asyncProgram/` 调度 + `src/application/seatActivation/`。
- 来源 `src/main/seatActivationDispatcher/**` -> `src/runtime/seatActivationDispatcher/` 队列/触发 + `src/application/seatActivation/` 完成条件。
- seat identity/pure state -> `src/domain/seat/`；snapshot refresh 永远调用 application snapshot owner。
- 幂等安全切片还包括 `src/core/orderRecorder/**`、`src/core/trader/orderMonitor/{settlementFlow,eventFlow,recoveryFlow,types}.ts` 及受影响的订单输入契约/调用方；P1 可先在旧来源的唯一写入链路闭合，正式 orderTracking 归属按 §4.1.2 迁移，不把正确性推迟到 P3/P4。

要求：

- seat refresh 使用 `SEAT_ACTIVATION` source；任务携带入队 dayEpoch/席位身份，在首个 await 前验证并固定工作基线，不在迟到返回后换成当前 epoch。receipt 返回后由 activation owner 复核 epoch、适用 generation/revision 及 `seatVersion`、symbol、direction、status。coordinator 不等待业务 ready，持仓订阅等待归 activation owner。
- 保留 §9.3 的运行期实际顺序：全量订单预检 → 日损重算/提交 → 当前方向本地订单重建 → canonical account/position receipt → 持仓订阅成功 → 风险共享发布 → 条件化旧标本地记录清理 → warrant/name → ACTIVE。不得按职责示意图任意重排。
- `allOrders` 发读前捕获 `dayEpoch + snapshotGeneration + direction + symbol + seatVersion + ACTIVATING`；返回后及任何日损/订单写入前复核。当前代码只检查席位身份，旧响应仍可能覆盖读取期间新增的另一方向成交；后置较新 receipt 不能使旧订单输入重新有效，这一现存缺口必须在 P1 关闭。
- 新标、不同的旧标、当前双方向相关标的均预检；token 校验、预检、日损重算/提交、方向订单列表及其实际消费覆盖提交为无 await 本地段。日损归属拒绝后不得继续订单重建、账户刷新、风险或 ACTIVE；当前订单方法的同步替换后 `Promise.resolve` 不提供延迟提交保护。
- 在 P1 关闭 API 已投影成交后同单 WS/query 再投影的独立缺口，完整契约见设计 §9.2。重建/结算共用 broker orderId、累计数量/金额、时间/revision、阶段与冲突规则；已消费输入及覆盖由唯一订单 owner 管理，不以 LOCAL ID 再表示同一成交，不新增第二账或 durable 格式。
- API 基线与列表同段登记分类/过滤实际消费覆盖，不能把全部 raw 输入、OPEN partial 或日损已合并事实都标为本地经济投影已消费。保留被 SELL 消除的 BUY、已消费 SELL 和空结果证明；清空买单列表不清空该证明，受控 rebuild 也同步建立覆盖。在线结算按共同覆盖防止重复追加/扣减，不能仅依据日损的 `authoritativeFactChanged` / `executionAdvanced` 或幸存列表。
- 主动 `clearBuyOrders` 不是 SELL 抵扣，也不代表权威持仓为空。保护性、静态、末日及旧标清理仍只在各自原条件下执行；同一订单 owner 在清理本地列表的无 await 段保留其对当时已投影且实际被清理部分的作用范围。历史金额修订重算不得忽略仍有效的清理效果，但权威事实、日损益及适用口径仍按原规则修订；不得永久屏蔽整个 symbol/orderId、吞掉后续新成交、未覆盖增量或 OPEN partial 的首次终态投影。主动清理与被 SELL 规则过滤消除分开表达，后者仍允许合法修订引起原规则允许的过滤变化。受控 rebuild 继续按原语义建立新基线，并同段处理消费覆盖与清理作用范围，不把普通 WS/query 修订当成重建；不伪造成交、不删权威事实、不新增第二账、durable 格式或跨重建清理墓碑。
- 累计量合法推进或同量高 revision 的金额/时间/阶段修订仍更新同一订单，已覆盖部分不再消费；必要时利用 owner 保留的完整已消费输入，按原关联买单、卖单时序及低价优先整笔过滤规则重算。不把修订当新增成交，过滤结果的合法变化不等于成交数量推进，不额外重拉 API。经济去重不跳过 pending 占用释放/移交、routing/hold/tracking 关闭及既有收尾；不得提前填 `closedOrderIds` 或跳过整个 `settleOrder`，tracking 关闭也不屏蔽事实准入/合法修正。覆盖不证明 protective progress 已落盘或 settlement ready，持久化与错误语义保持。
- 身份仍有效而 generation 推进时，由原 activation owner 追赶当前代次、重读未提交的订单输入；这是本地 supersession，不消耗一次外部 API 重试、不 EMPTY、不重复登记 settlement stale。上述跨入口幂等前提成立后，合法本地提交之后有新事实，才保留提交并按正确更新的当前经济投影重做未提交的后置准备。普通 commitRevision 变化不重拉订单；依赖的后置 revision 改变时，获取当前 receipt 并重算，字段不足才补读。
- 每个 await 后复核适用 token；R1/N1 与最终 ACTIVE 使用无 await 校验—计算—发布尾段，有异步输入则 prepare 后 compare-and-publish，禁止先写风险缓存再检查。ACTIVE 事件的永久订阅归属先排入串行链，finally 完整 await releaseRetain；释放不是新增 ready 门禁，保留主体/清理错误优先级，内部错误不能被外部清理失败覆盖。
- LONG/SHORT 隔离限于 activation 状态/重试：单方向明确外部失败不清掉另一方向 ACTIVE，也不推进全局 settlement stale；共享订单、日损和订阅集合不假定方向隔离。
- 运行期明确外部失败仍只安排一次延迟重试，耗尽才使当前 ACTIVATING 方向 EMPTY；生命周期关门/停止或身份失效仅取消旧工作，不自动 EMPTY。回收价或原规则明确的风险事实无效立即 EMPTY；订单契约、成交归属、内部不变量或清理内部错误仍 fatal，过期不能吞错。已 ACTIVE 后 release 失败不回滚、不重新激活。
- 保留上游版本提升/旧态清理边沿，以及受控 rebuild/static bootstrap 例外；仅连续时段关闭不新增 activation 取消条件。完整入口、订阅错误归属、远端保证边界和验收见 §9.3 / 设计 §9.2。

#### P1.8 迁移成交后刷新及全部派生防旧写

现有来源 `src/app/runtime/createPostTradeConsistencyRuntime.ts` 可在 P1 修改以完成全部安全协议，但它不是终态业务 owner。P1 闭合安全后，P2 将 refresh/readiness/completion 用例迁入 `src/application/postTradeSettlement/`；`src/app/runtime/createPostTradeConsistencyRuntime.ts` 终态只做工厂/装配，不保留同义业务 façade。安全协议必须在本阶段完成：

- API 双读交给 coordinator；receipt 只表示 snapshot committed，不能直接 mark fresh。
- QuoteSubscriptionRuntime 继续独占订阅，通知只标记 dirty，并按当前事实 single-flight 对账；迟到 r10 callback 不可回写 r10 期望集合。
- pending settlement 的订阅、completion 准备、R1/N1 均携带 receipt；每个 await 后复核 epoch/generation/revision 和适用 seatVersion。r11 到达后丢弃 r10 尚未提交的派生结果，获取当前 receipt（字段不足才请求补齐），为同一 settlement 目标重算，不重新 mark stale。
- R1/N1 分开准备与发布：同步计算使用无 await 的校验—计算—发布段；有异步输入时使用 compare-and-publish。禁止先写缓存再在函数返回后检查 token。
- `PostTradeSettlementWorkflow` 独占 protective 最终完成判定；它基于 order tracking 提供的可信 progress/order facts、snapshot/待成交订单 facts（可调用 domain 纯规则）完成最终 token/事实/seat 校验 → 同步 durable append → daily loss boundary/cooldown/episode 内存提交，并在全部原有 ready 条件满足后发布 ready。此段无 await；protective workflow 和 tracking 均不另作完成判定或提交。保持既有同步 repository、progress 持久化路径及顺序，不改变日志格式。
- 后续 R1/N1 和所有既有 ready 条件完成后才能 `markFresh()`；若新成交到达，等待者继续追赶最新 settlement 水位。
- SELL、风险、monitor quote、switch wakeup 在等待、行情读取和提交间的 epoch/settlement/seat/positionRevision 复核也在 P1 接通。持仓变化由原 owner 重选/重评估，不创建自动交易重试。

P2 只把已正确实现的协议正式归属到 settlement workflow，不再首次增加这些安全检查。

#### P1.9 收口 time wakeup 的 UNKNOWN 错误通道与 doomsday 事实边界

下列仅为需修改的现存来源，P1 立即清理直接 snapshot 写入；P3E/F 将完成条件分别迁入 `application/doomsdayClearance`、`application/staticLiquidation`，计时/事件入口迁入同名 `runtime/*`：

- `src/main/timeWakeupEvaluationProgram/index.ts` -> `src/runtime/timeWakeupEvaluationProgram/`。
- `src/core/doomsdayProtection/index.ts` -> `src/domain/liquidation/` 纯规则 + `src/application/doomsdayClearance/`。
- `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts`（若有直接 cache 写入）-> `src/application/staticLiquidation/`；事件路由留 `src/runtime/monitorQuoteEventRuntime/`。

要求：

- submit UNKNOWN 直接经既有 fatal 通道上报，关闭交易放行，不自动重提，不新增 UNKNOWN 查询、接管、重评估或持久化协议。
- 删除 `timeWakeupEvaluationProgram` 中 UNKNOWN 后刷新持仓、协调订阅及安排重评估的特殊分支与仅为该分支服务的 helper；在通用外部失败重评估分支之前向上抛出原错误，进入现有顶层 fatal/cleanup 通道，不在当前 handler 内 self-drain。
- 已确认返回 orderId 的订单继续由既有 OrderMonitor、订单终态和成交结算链路处理；复用既有订单身份及 awaiting-terminal 状态防重，不新增第二本订单账。
- 旧 epoch/generation 结果不能提交。
- 删除 filter/update 和 submit-success 的伪 PositionSnapshotCommitted 通知；接受订单不证明空仓，不触发提前退订或 protective completion。
- 在原“全部执行成功且 live gate 仍有效”条件下，由 snapshot owner 在同一同步段将账户标为 invalid/needs-refresh 并推进 snapshotGeneration，阻止失效前已发出的 paired read 重新恢复账户有效性；既有 owner 后续当前 generation 的合法 paired commit 才可恢复有效性。此次账户失效本身不增加 settlementVersion/成交刷新需求，期间真实成交仍按原协议登记；不改成每张 accepted 或部分成功都失效，不新增专属主动刷新/重评估。该已接受订单路径与 UNKNOWN fatal 无关。
- `orderRecorder.clearBuyOrders` 仍遵守原全部执行成功、方向归属、live gate 条件；部分成功不能扩大清理范围，不删除权威成交或 durable progress。

#### P1.10 迁移午夜清理

可修改的现存来源：`src/main/lifecycle/cacheDomains/globalStateDomain.ts`、`signalRuntimeDomain.ts`、`dayLifecycleManager.ts`。它们分别拆至 `src/runtime/lifecycle/` 的日切协调和 `src/application/accountPositionSnapshot/` / `src/application/tradingDayRebuild/` 的 owner；旧 `main/lifecycle` 完成迁移后移除。

要求：

1. 先关闭交易和普通 snapshot admission；受控重建请求通过单独受限准入。
2. 同步推进本次日切 epoch/generation，取消旧 snapshot waiter 和未开始 pending，abort freshness waiters，保证 drain consumer 不等待永不执行的旧请求。
3. 按现有顺序停止 producer、排空 monitor/seat 和 buy/sell，收口 OrderMonitor、post-trade/snapshot owner，再停止订阅 owner。
4. 已发 API 必须全部 settled 才算实际排空；终止中不启动后继 batch，旧响应不发布，内部错误仍报告首错。
5. 完成 store 新日空基线及业务队列/策略日状态清理；不得再次推进同一次日切 epoch。
6. open rebuild 使用已建立的 epoch。重试只推进读取 generation，受控基线和订阅完成后按既有条件开门，不能等待只有开门后才能执行的运行期 activation。

TimeWakeupRuntime 不等待自己 drain；其触发的 midnight/rebuild 继续通过 day lifecycle owner 执行。

#### P1.11 迁移所有读取方

现存 `main/app/services` 读路径可在 P1 修改；最终消费只读 view/lookup 或窄 capability，不保留 `LastState` snapshot 镜像。目标职责在 `runtime/*`、相应 `application/*`、`infrastructure/display` 和 `application/accountPositionSnapshot` 间按 §4.1.2 分配。改造所有 `LastState` 读方：

- quote subscription truth reconciliation。
- switch wakeup / monitor quote event。
- sell/风险链路中需要 canonical position view 的读取。
- account display。
- startup runtime validation。
- 所有 `Pick<LastState, ...>` 类型。

### 7.4 P1 测试任务

新增测试从创建时即按终态路径镜像：

```text
tests/application/accountPositionSnapshot/accountPositionSnapshot.business.test.ts
tests/application/accountPositionSnapshot/accountPositionSnapshot.concurrency.test.ts
```

至少覆盖：

1. position-only in-flight 后入队 account+positions 不附着已发 batch。
2. account 成功、positions 失败时不提交账户半快照。
3. account 失败但 positions 仍 pending 时不提前 drain、不发并行 canonical batch。
4. 成交失效后旧 seat read 返回，旧结果丢弃，需求进入后继 batch。
5. 旧 epoch 返回不能提交。
6. generation 失效后成功结果不提交，仍有效 waiter 不丢失。
7. 旧 generation 返回内部错误仍 fatal，不被 supersession 吞掉。
8. 多来源请求正确合并字段并集。
9. 单个 seat waiter 取消不影响共享 batch 其他参与者。
10. 每个 waiter 恰好完成一次。
11. commitRevision、component revision 不回退。
12. clearForDay 后旧 projection 和旧响应均无效。
13. doomsday accepted 不使 snapshot 变 flat。
14. `onPositionsCommitted` 只在实际 snapshot commit 后触发。
15. r10 settlement commit → subscription await → r11 seat commit → r10 late return：旧风险/旧 completion 不发布，同一 settlement 可在当前 receipt 完成。
16. 订单事实成功结算与 generation/stale/refresh need 同步登记；保护性 progress 落盘失败不能提前推进这些事实。
17. 已 ready 后 seat commit 不增加 stale；SELL 旧持仓选单重算，不永久等待或重复 submit。
18. 普通 BUY/SELL 与末日 submit UNKNOWN 均直接进入 fatal/cleanup，不重提、不启动 UNKNOWN 专属读取或重评估；已确认订单沿既有 tracking/terminal 事实链路防重；全部成功后的账户失效、paired refresh 恢复有效性及部分成功时的买单清理条件不变。
19. snapshot waiter 在 consumer drain 前取消，day clear/rebuild retry 不重复推进 epoch；TimeWakeup 不等待自己 drain。
20. 高有效位金融 SDK 输入经 mapper → snapshot → 全部估值/风控/显示消费者保持目标值；账户差额/持仓估值不回转 number，旧 epoch/generation 不改变精度契约。
21. 数量/版本聚合和递增验证 safe-int，金融显示直接定点输出；指标投影与算法不因 financial fact 类型迁移改变。
22. 无其他买卖、日损偏移 0：回补提交后 ACTIVATING 的 API 已投影 FILLED BUY 100 股、成本 100；账户/订阅 await 期间同单相同已消费事实的 WS/query 晚到，最终数量 100、R1/N1 为 100/100，日损不重复累计，tracking/hold/占用仍正常收口。使用同一真实 recorder/tracker/订单 owner，不用两个独立实例比较替代该交错。
23. 重放相同已消费事实时，API 已消除的 BUY 不复活、已消费 SELL 不再次扣减；空投影仍有消费证明。OPEN partial 若只在 pending/日损中，不虚标本地投影覆盖，同量终态仍按原规则首次投影，不能因 `executionAdvanced = false` 跳过。
24. 同量高 revision 合法金额修正更新成本、过滤结果、日损及 R1/N1，不虚构成交数量推进，过滤结果按原规则重算；已消费输入与覆盖同段更新。终态资源收尾与经济副作用分别幂等，原权威冲突/归属错误仍 fail-fast。
25. 同一真实订单 owner 已投影 BUY → 按原条件主动 clear → 同单重放/合法金额修订：当时实际被清理部分不复活，权威金额与日损仍正确修订；后续新成交、未覆盖增量及 OPEN partial 首次终态仍正常投影。另验 SELL 过滤的合法修订变化与受控 rebuild 新基线，不能用永久屏蔽 symbol/orderId 或全局忽略修订通过测试。
26. deferred paired read 已发出 → 末日全部执行成功且 live gate 有效 → 账户失效 → 旧读成功返回：账户仍 invalid，旧结果不提交；未发生新成交时 settlementVersion 不变，既有 owner 后继当前 generation 的合法 paired commit 才恢复 valid。部分成功或 live gate 关闭仍按原条件处理，不因本检查扩大失效范围。

P1 在以下基线路径更新安全断言；测试随其实际 owner 的完整闭合阶段迁往目标目录，不要求在 P1 提前搬完 P2/P3/P5 的完整用例测试。P1 已新增的 coordinator 测试直接位于终态目录：

- `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` -> `tests/runtime/lifecycle/` + `tests/application/tradingDayRebuild/`。
- `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts` -> `tests/application/postTradeSettlement/` + `tests/app/runtime/` wiring。
- `tests/main/quoteSubscriptionRuntime/quoteSubscriptionRuntime.business.test.ts` -> `tests/runtime/quoteSubscriptionRuntime/`。
- `tests/main/asyncProgram/monitorTaskProcessor/{business,seatRefreshRelease.business}.test.ts`、`tests/core/orderRecorder/rebuildRefresh.business.test.ts`、`tests/core/trader/orderMonitor/settlementFlow.business.test.ts`：P1 增加早期栅栏/同一实例经济幂等安全断言；随 owner 迁至 `tests/application/{seatActivation,orderTracking}/`，真实跨 owner 交错放 `tests/integration/`。
- `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.business.test.ts` -> `tests/application/staticLiquidation/` + `tests/runtime/monitorQuoteEventRuntime/`。
- `tests/app/runApp.business.test.ts` -> `tests/app/` 的 assembly assertions。

### 7.5 P1 验收标准

- 生产代码中 canonical writer 白名单只剩 snapshot owner。
- `cachedAccount/cachedPositions/positionCache.update` 直接写入扫描为零。
- snapshot view 不可写，position cache 更新能力不外泄。
- 所有读取方迁移完成，无 LastState 镜像双存储。
- 旧 generation/epoch 不能覆盖新事实。
- P1.7 的早期订单栅栏及 API/在线结算经济投影幂等已生效：列表/实际覆盖同段提交，同单重放不重复计量，OPEN partial 不虚标覆盖，合法金额修正与终态收尾不被去重吞掉；不能只凭 receipt/日损去重宣告安全。
- 双读失败不会发布半快照。
- seat refresh 不推进 settlement stale。
- doomsday submit UNKNOWN 已统一为直接 fatal、不重提，旧 UNKNOWN 刷新 helper/重评估分支已删除；已确认订单不冒充 canonical position facts，account invalidation 已接入 loader。
- 成交同步失效登记、r10/r11 派生防旧写、最终 positionRevision 复核、completion 无 await 原子段均已生效。
- quote projection 只按当前真相对账；非 settlement commit 不制造全局 stale。
- 本切面的金融字段及所有消费者通过 §13.4.2，未授权 number 桥接为零；与后续成交/风险字段相依的最小切片已提前闭合，不延后补精度。
- P0 基线与 P1 新增/迁移测试通过；已登记的旧浮点期望按十进制目标更新，其他业务语义不变；本阶段跨核心链路，合入前执行全套测试。

---

## 8. Phase 2：拆分 Snapshot Commit 与 Post-Trade Business Ready

### 8.1 目标

明确两个不同的完成概念：

```text
SnapshotCommitted
  = canonical account/position facts 已提交

PostTradeBusinessReady
  = subscription、保护性完成判断、R1/N1、日损益/冷却等后置业务已完成
```

`waitForFresh()` 保持为正式业务门禁名称，不新增兼容入口。保护性清仓最终完成判定、completion 同步 append、daily-loss/cooldown/episode 内存提交及 ready 推进均独占归 `PostTradeSettlementWorkflow`；tracking 只提供权威事实，纯 domain rule 可由该 workflow 调用，但没有第二判定者/提交者。P1 已经实现上述分离和所有并发防护；P2 的增量是正式契约与职责迁移，不再次改变交易准入政策。

### 8.2 任务清单

#### P2.1 定义 settlement receipt

跨层使用的 readiness receipt 放于最近共同父级的 `src/types/settlement.ts`（仅含中性内部 fact）；仅 settlement 模块内部的协作 DTO 放 `src/application/postTradeSettlement/types.ts`。新契约不得沿用 `src/types/services.ts` 等旧 SDK 泄漏类型：

```ts
type SettlementReadinessReceipt = Readonly<{
  readonly dayEpoch: number;
  readonly settlementVersion: number;
  readonly snapshotCommitRevision: number;
  readonly ready: boolean;
}>;
```

如业务需要，再带 `positionRevision`、`seatVersion` 等适用水位；不能把所有水位压成一个整数。

#### P2.2 建立 PostTradeSettlementWorkflow

终态 owner：

```text
src/application/postTradeSettlement/
  index.ts
  types.ts          # 仅 module-local contracts；跨层 receipt 在 src/types/settlement.ts
```

迁移来源包括 `src/app/runtime/createPostTradeConsistencyRuntime.ts`、`src/utils/refreshGate/**`、现有 post-trade collaborator/type contracts。P1 已在旧路径完成安全协议；P2 把它闭合迁入 application owner，并删除 app/runtime 中业务实现与 refreshGate 旧入口。若来源 collaborator SDK 类型泄漏，先切成内部 fact/mapper，不允许给新 workflow 加 legacy 例外。

流程：

```text
可信订单事实由既有 order tracking/settlement 路径推进（保护性累计 progress 仍先同步持久化，路径与顺序不变）
  -> 同步登记 generation 失效、settlementVersion 和 refresh need
  -> 请求 snapshot refresh / 接收 commit receipt
  -> 持仓订阅投影
  -> settlement 收集 tracking 提供的保护性 progress、权威持仓和待成交订单事实；可调用 domain 纯规则准备资格结果
  -> PostTradeSettlementWorkflow 独占最终完成判定及 token/订单事实/seat 校验
  -> 同步 completion append
  -> daily loss boundary commit
  -> cooldown / episode 内存提交
  -> R1/N1 刷新（使用已提交的新 boundary）
  -> 发布 readiness
```

P2 首次消费前闭合执行价格/累计金额、成本、日损益/亏损偏移、R1/R2 和 progress/baseline 财务状态的 §4.4 契约；移除金融中间 number 投影，数量按其整数/Decimal 契约处理。SDK/order fact、仓储输入及所有协作者一并做必要切片，不能用字符串外壳保留内部 number 运算；历史恢复冲突按 §15 验证。

`PostTradeSettlementWorkflow` 是唯一最终判定与事务 owner：completion 校验 → 同步 append → boundary/cooldown/episode 内存提交之间不插入 await，不把仓储异步化。protective/tracking 不另行判定或提交；该 completion 事务始终内聚于 P2 settlement，P3B 不得迁出或复制。

其他异步 await 返回后检查：

- `dayEpoch`。
- `settlementVersion`/目标版本。
- snapshot generation/commit revision。
- seat identity/version（如属于特定席位）。
- 订单事实是否仍满足完成条件。

#### P2.3 保留并强化 protection completion 顺序

必须由 `PostTradeSettlementWorkflow` 独占最终完成判定与下列提交顺序：

```text
settlement 最终判定通过
  -> completion persistence 成功
  -> daily loss boundary commit
  -> cooldown/episode 内存提交
  -> R1/N1 按新 boundary 刷新
  -> 所有既有条件满足后 readiness 可推进
```

tracking 提供可信事实，domain 可提供纯规则；二者都不是第二判定者或提交者。保护性累计 progress 的既有 tracking/settlement 持久化路径与先后关系不变。持久化失败时：

- 不推进内存 cooldown。
- 不推进 daily loss 分段边界。
- 不将 episode 标为完成。
- 走既有 fatal/失败语义。

#### P2.4 防止 coordinator self-await

Snapshot owner 不能：

- 等待 `waitForFresh()`。
- 在同步 commit 内调用业务 callback。
- 以 ready 作为 snapshot commit 条件。

Settlement workflow 才能在收到 snapshot receipt 后运行后置投影。

#### P2.5 迁移 P1 已接通的 SELL、风险和换标门禁

以下是现存调用来源，可在 P2 修改；最终 queue/listener 留同名 `runtime/*`，普通 SELL、switch 和 risk decision 分别由 `application/ordinarySell`、`application/seatSwitch`、`application/riskRefresh` / `protectiveLiquidation` 通过 readiness gate 完成，不改变原政策：

- 来源 `src/main/asyncProgram/sellProcessor/index.ts` -> `src/runtime/asyncProgram/sellProcessor/` + `src/application/ordinarySell/`。
- 来源 `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`、`switchWakeupRuntime.ts` -> 同名 `src/runtime/monitorQuoteEventRuntime/` + 对应 application use case。
- 来源 `src/main/tradingRiskEventRuntime/tradingRiskEventRuntime.ts` -> `src/runtime/tradingRiskEventRuntime/` + `src/application/riskRefresh/` 或 `protectiveLiquidation/`。

执行时序：

```text
waitForFresh
  -> 读取当前不可变 position snapshot/revision
  -> 读取行情并进行选单/风险决策
  -> 最终执行前复核 epoch、settlement 水位、seatVersion、positionRevision
  -> 若 positionRevision 已变化，重新读取并重新选单
```

不把 `BUY` 原本的临时实时读取纳入该 readiness policy。

#### P2.6 迁移并回归 P1 已实现的迟到派生结果协议

不得在本阶段才首次实现以下时序保护；保留 P1 的测试并迁移其真实 owner：

```text
r10 settlement commit
  -> subscription await
  -> r11 seat snapshot commit
  -> r10 late return
```

预期：

- r10 迟到结果不能写旧风险/旧 completion。
- 同一 settlement 可以基于当前合法 receipt 完成。
- 普通 seat commit 不增加 `settlementVersion`，不撤销已完成 readiness。
- 已完成 readiness 后新 position revision 只使在途选单重新评估，不制造永久 stale。

### 8.3 P2 测试任务

重点扩展：

- 迁移前基线 `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts` -> `tests/application/postTradeSettlement/`；app runtime 仅留 assembly wiring tests。
- 新增 `tests/application/postTradeSettlement/postTradeSettlement.business.test.ts`。
- 新增 `tests/application/postTradeSettlement/postTradeSettlement.concurrency.test.ts`。
- drain 集成仍位于 `tests/integration/postTradeDrainLifecycle.integration.test.ts`。
- SELL、风险、换标的新/迁测试分别镜像 `tests/application/ordinarySell/`, `seatSwitch/`, `riskRefresh/`；runtime wiring 留 `tests/runtime/`。

必须覆盖：

1. snapshot 已 commit 但订阅投影未完成时 SELL 仍等待。
2. protection completion persistence 失败时不推进 cooldown/daily loss/episode。
3. R1/N1 失败不 mark ready。
4. 新 settlement 使旧 readiness token 失效。
5. 多 waiter 追随最新有效 settlement 目标。
6. 日切 abort 旧 waiter，新 epoch baseline 可正常建立。
7. snapshot owner 不等待 settlement ready。
8. position revision 在选单期间变化时重新选单，不重复登记 settlement stale。
9. 普通 seat commit 不撤销已完成 settlement readiness。
10. 精确累计金额/损益状态、数量不变的合法权威金额修正及 baseline 分段通过 §13.4.2；历史精度冲突不推进完成/冷却/ready，正常权威修正不被误禁。

### 8.4 P2 验收标准

- `waitForFresh()` 仍只在所有原有 post-trade business 完成后 resolve。
- raw snapshot commit 不再被消费者当成业务 ready。
- receipt 能追踪 day/settlement/snapshot revision。
- 不存在 coordinator self-await。
- 迟到投影不能覆盖新 revision。

### 8.5 P2 离线实施完成证据（2026-10-12）

本轮 P2 已通过离线工程验收，不等同于生产恢复或发布验收。所有实施 owner 停写后，由单一验证执行者串行完成质量链、定向/全量测试及构建；以下数量分别统计，不相加为独立测试总数。

#### 实际职责与接线

- `src/application/postTradeSettlement/index.ts` 为唯一刷新 pump、completion 同步事务、R1/N1 发布与 readiness owner；`src/app/runtime/createPostTradeConsistencyRuntime.ts` 仅保留 factory、窄协作器映射与启动前单次绑定。共享 receipt/recovery 契约直接来自 `src/types/settlement.ts`，旧 app status/test helper 导出已清除。
- 日损状态与规则已直接迁至 `src/domain/risk/dailyLossTracker.ts`、`dailyLossRules.ts`、`types.ts`；app 直接装配真实 domain owner，通过窄 `onOwnershipWarning` 注入原 warning 观测。不保留旧 core wrapper/re-export，不建立第二订单账或第二 completion owner。
- `tests/integration/postTradeSettlementOwner.integration.test.ts` 使用同一 native tracking、recorder/daily-loss、snapshot、真实订阅 owner、durable repository 与真实风险 owner：native 回报触发刷新，paired snapshot 已提交但订阅 ack 尚未返回时，completion、冷却与 ready 均未推进；ack 后依次完成 durable append、分段/episode、真实 R1/N1 再发布 ready，另一方向精确成本保持不变。
- `tests/integration/architectureRefactoringRecovery/recovery.integration.test.ts` 使用真实 repository → loader → 同一 settlement recovery 能力 → 真实 hydrator/tracker → rebuild；全部 LONG/SHORT episode 先恢复，再同步收口一次，随后 hydrate 一次且不调用 live cooldown trigger。重启保持原 V1 文本与 completion 幂等，实际剩余冷却一致；triggerLimit=2 的部分计数恢复后，下一次 live completion 恰好激活一次冷却，重复 baseline 不双计。
- 旧 V1 同 revision、同量、仅 OPEN→API TERMINAL 阶段推进而金额不同，若没有既有独立 durable TERMINAL 确认则 fail-fast，不推进 completion/cooldown/ready。独立证据须经 monitor/symbol/direction/保护性 SELL 来源校验，且同 orderId/revision/quantity/executionTime、精确金额与 API 一致；其他订单、金额、symbol、direction、数量、revision、执行时间共七类不匹配负例均拒绝。在线同 revision 合法修订及更高 revision 合法修订继续通过，不改 schema、历史文本或冲突容差。
- 六消费者（普通 SELL、监控行情、静态清仓、换标唤醒、周期换标唤醒、交易风险）保留原 readiness/position/seat 复核与防旧写；日切/abort waiter、shutdown/fatal drain、开盘重建 baseline 由对应行为与集成测试覆盖。本轮不强行提前搬迁其 P3/P5 物理目录。

#### 静态门禁与残留

- `baseline.stage` 从 P1 收紧至 P2；21 个 SDK import、296 个 SDK use、7 个 legacy edge、94 个 helper occurrence 的原 P2 cutoff 当期失效。只修改阶段，不重采冻结 occurrence、不扩大 allowance、不推迟 cutoff；`unresolved.json` 不变。先前两条日损 legacy debt 已通过真实迁移清零。
- 门禁增加 P2 多重集合到期、旧 readiness 物理入口、旧 app status/test 导出及 durable/recovery 金额防 number 回退正反例。层矩阵仅约束生产 `src/*`，不将 `tests/application/*` 真实协作者装配误判为生产反向依赖；SDK/fixture、snapshot 与金融检查独立保留。
- 对生产/行为测试含新增文件共 593 个 TypeScript 文件的 module AST 扫描，旧 `utils/refreshGate`、`core/riskController/dailyLossTracker` 与 `core/riskController/utils` 直接模块引用为零。冻结 baseline/numeric probe 的历史审计键、迁移来源表与历史文档保留，不机械改写历史路径。

#### 串行验收结果

| 实际命令/范围 | 退出码 | 结果 |
| --- | --- | --- |
| `bun --no-env-file test tests/architecture/refactoring --timeout 30000` | 0 | 229 pass / 0 fail，4 files，2544 assertions；P2 debt 清零 |
| `bun --no-env-file run format` | 0 | 659 files；格式器旁路修改的 3 份历史/无关 Markdown 恢复原字节，剩余额外格式改动 0 |
| `bun --no-env-file run lint` | 0 | 0 diagnostics |
| `bun --no-env-file run type-check` | 0 | 0 diagnostics |
| P2 定向测试（完整 argv 见下述证据文件） | 0 | 371 pass / 0 fail，28 files，2860 assertions |
| `bun --no-env-file test --timeout 30000` | 0 | 2585 pass / 0 fail，256 files，15943 assertions |
| `bun --no-env-file run build` | 0 | clean + TypeScript build 成功，301 个 JavaScript 产物；不执行产物 |
| `git diff --check HEAD` | 0 | 无 whitespace error |

P2 定向范围包括 `tests/application/postTradeSettlement/`、app settlement wiring/authorization、native 单实例 owner 集成、真实 recovery/loader/hydrator、`tests/domain/risk/`、金额修订与保护性 baseline 集成、六消费者、订阅失败 ownership、drain、startup/rebuild readiness。完整实际命令、退出码与原始离线输出位于仓外 `D:/Temp/hsi-p2-final-20261012/`，对应 `architecture-final-results.json`、`quality-final-results.json`、`tests-build-final-results.json`、`all-build-diff-final-results.json` 及同名输出文件。

全量首轮发现六处 ESLint typed fixture 仍引用已删除 core 文件，已只改为真实 domain 路径且保持规则/断言不变；另一个失败来自验证 launcher 的自定义日志目录与既有默认路径测试冲突。最终按授权取消该 override，以既有 preload 的默认 `tests/logs` 重跑全量通过，未改 runtime 测试或生产契约。

#### 验收边界与剩余发布阻断

执行环境只保留基础 OS 变量与测试配置，使用 `--no-env-file`；测试 preload 固定 test profile、禁用进程 hooks，并安装离线 SDK 网络工厂保护。仅使用 mock/脱敏 fixtures 与测试隔离文件 IO，不启动 app、不联网实盘、不读取凭证或真实生产日志。静态门禁不替代任意跨函数语义证明。

P3 剩余 workflow/runtime 物理目录迁移、真实旧 V1 与权威订单逐条对账、真实生产恢复演练及发布/回退演练不在本轮。它们仍是相应后续阶段或生产发布的验收事项，不能由本轮离线全绿推定完成。

---

## 9. Phase 3：迁移 Application Workflow 业务所有权

> 每个 workflow 必须完成“入口、状态、完成条件、失败处理、事件/receipt、测试”的闭合迁移。只创建文件或包裹旧 runtime 不算完成。P2 已建立 settlement 的安全语义与 application owner；P3A 只验收残留物理/调用边界，不能重复迁移或建立第二 workflow。P3B-E 按各自目的迁独立职责；protective 最终完成判定、同步 append、daily-loss/cooldown/episode 内存提交及 ready 始终由唯一 `PostTradeSettlementWorkflow` 拥有，P3B 不迁出/复制该事务。P3F 补齐普通交易、搜索、静态清仓及必要风险刷新，使第 4.1.2 映射无遗漏。

### 9.1 P3A：PostTradeSettlementWorkflow 收口验收

P2 已创建并迁移正式 settlement owner；P3A 不再创建第二个 workflow，只审查残留 wiring、runtime 边界及完成事务归属。若 P2 已闭合，直接提交验收证据，无需为了阶段名再改一次代码。

#### 范围

- 来源：`src/app/runtime/createPostTradeConsistencyRuntime.ts`（P1/P2 可修改的迁移前业务路径）。
- 终态：`src/application/postTradeSettlement/`；上游具名事件/队列继续在既有 `src/runtime/*`，app 中 `createPostTradeConsistencyRuntime` 仅为 factory/wiring。
- 不在 P3A 再搬一次 P2 已迁移业务；只验证旧入口删除、runtime stop/drain 边界、事务单一归属。

#### 任务

- 将 `recordSettlementRefreshNeed`、refresh request 合并、业务投影和 readiness owner 收口。
- runtime 只负责接收事实/时间事件和调用 workflow。
- 明确失败 owner：成交后刷新由 settlement workflow 重试；不由 seat runtime 或 snapshot coordinator 再重试。
- 保留交易日清理、abort waiter、重建 baseline 语义。
- 删除旧 runtime 中已迁移的业务实现；保留 app 工厂时它只能装配，不能留下旧 owner 的同义委托 façade。

#### 验收

- 能从 workflow 入口找到完整 settlement ready 条件。
- `waitForFresh` 调用方无需了解 snapshot coordinator 内部。
- 业务失败和内部 fatal 分类不变。

#### P3A 独立验收进度

- 只读验收已确认 P2 owner 闭合，无待补业务缺口；11 个文件的定向验证为 **97 pass / 0 fail，816 assertions**。
- 保留唯一 settlement 完成事务，不新增 wrapper、第二 workflow 或重复测试。
- P3B 新 episode/cooldown/repository 接线完成后，仍须在最终集成中复核同实例注入与 completion 唯一调用点；本记录不表示整个 P3 已验收，也不更新 stage baseline。

### 9.2 P3B：ProtectiveLiquidationWorkflow

#### 范围

终态 owner 为 `src/application/protectiveLiquidation/`，规则/state 为 `src/domain/liquidation/` 与 `src/domain/risk/`；不新建第二本订单账，也不把 cooldown 当持久化：

- 来源 `src/main/tradingRiskEventRuntime/**`、`unrealizedLossExecutor.ts` -> `src/runtime/tradingRiskEventRuntime/` 事件路由 + application trigger/use case。
- 来源 `src/core/trader/protectiveLiquidationEpisodeTracker/**`、`src/core/riskController/dailyLossTracker.ts` -> `domain/liquidation` episode state 与 `domain/risk` daily-loss rules。
- 来源 `src/services/liquidationCooldown/index.ts`/纯 utils -> `domain/liquidation/cooldown` 的 Map-backed state/rules；`tradeLogHydrator.ts` 的仓储读取和恢复推进 -> `application/protectiveLiquidation` 内聚恢复职责。durable trade-log 实际读写只在 `mixedTradeLogRepository` adapter，domain 不接仓储或 logger。
- 来源 `src/core/trader/orderMonitor/settlementFlow.ts` -> order facts 由 `application/orderTracking` 推进；completion 的同步 durable transaction 仍归 `application/postTradeSettlement`。
- 来源 `src/app/runtime/createPostGateRuntime.ts` 中 progress persistence wiring -> app 只装配 application ports；具体持久化实现迁 `infrastructure/persistence`。

#### 任务

- protective workflow 只负责 trigger、目的识别、执行前门禁和执行；不负责 protective 最终完成判定、completion durable append、daily-loss/cooldown/episode 内存提交或 ready。
- 可信订单/progress 事实仍由既有 `application/orderTracking` 与 settlement 路径推进和持久化，顺序不变；order tracking 解析并提供事实，不成为第二最终判定者或 completion 提交者。
- `PostTradeSettlementWorkflow` 独占 protective 最终完成判定、completion 同步 append、daily-loss boundary/cooldown/episode 内存提交及 readiness 推进。它基于 tracking 提供的可信 progress/order facts、权威持仓及待成交订单事实作最终判定；纯规则可留 `domain/liquidation` / `domain/risk` 并由 settlement 调用，但不得形成第二判定者或提交者。
- progress 持久化仍先于日损益/episode/cooldown 内存提交；复验 P2 已闭合的精确累计金额、日损益、亏损偏移和 baseline 状态，迁移 owner 不重新引入 number 投影。
- 保留保护性与静态距回收价清仓的副作用差异；共享合单的已知缺口按 §9.6 显式修正，不将现有算法整体视为等价迁移目标。
- 保护性完成资格仍以既有进行中的 progress、方向空仓且无待成交保护性卖单为事实条件；最终是否满足只由 settlement 判定。静态卖出可使旧合法 episode 的事实条件满足，但不能自行宣告完成；其事实仍归旧保护性成交记录。
- 重启恢复继续从 durable progress、completion boundary 和累计基线恢复；不足以精确恢复时阻断恢复。

#### 验收

- protective trigger、purpose、执行前门禁与执行归 `application/protectiveLiquidation`；protective 最终完成判定、同步 append、daily-loss/cooldown/episode 内存提交及 ready 只归 `application/postTradeSettlement`。
- 同一事件不会被重复累计或重复激活冷却；order tracking 只提供事实，domain 纯规则不另成判定者/提交者。
- 真实 protective progress、最后执行时间及既有提交顺序保持，此前合法 episode 仍可由 settlement 合法完成。静态新增量的跨目的隔离在 P3F（§9.6 / §13.4.1）首次闭合并验收，不作为 P3B 的前置门槛。

### 9.3 P3C：SeatActivationWorkflow

终态为 `src/application/seatActivation/`；identity/state/纯 migration 在 `src/domain/seat/`，dispatcher/队列在同名 `src/runtime/*`。

#### 范围（均为现存迁移来源）

- `src/main/seatActivationDispatcher/index.ts` -> `runtime/seatActivationDispatcher` + application workflow。
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts` 与 `helpers/{refreshHelpers,seatSnapshot}.ts` -> runtime handler + application activation/snapshot receipt consumer；纯身份规则归 `domain/seat`。
- `src/main/lifecycle/rebuildTradingDayState.ts`：P3C 只闭合受控 activation 接入与唯一 ACTIVE 门禁，不重复迁移整个 rebuild owner；完整用例在 P5 迁入 `application/tradingDayRebuild`，日切协调归 `runtime/lifecycle`。
- `src/services/autoSymbolManager/` 激活状态部分 -> `domain/seat` 与唯一 application owner。

#### 任务

入口与版本前提先闭合，不把“绑定新标 → version++ → 清空所有旧态”当作统一流程：自动寻标按原绑定规则提升版本；距离/周期换标在 `ACTIVE -> SWITCHING` 提升版本并触发旧方向清理，后续绑定/ACTIVATING 不重复 bump。清理 dispatcher 先于 producer 启动，只清原有延迟信号、待执行队列和 warrant 信息，不清浮亏缓存、不取消 in-flight 工作；后者由身份/事实校验及最终订单授权阻断。listener 内部错误仍 fatal，不能把已提交状态视为清理已成功。dispatcher latest-only 派发当前 ACTIVATING，携带入队 dayEpoch/席位身份并保留真实 previousSymbol。执行入口首个 await 前验证并固定 epoch/身份与生命周期准入，不能在迟到返回后换成当前 epoch。

以下与设计 §9.2 一致，只描述运行期激活，不重排上游移仓或受控重建：

```text
current ACTIVATING identity / lifecycle admission
  -> validate callPrice
  -> await retain(next/previous symbols)
  -> await market admission
  -> read execution quotes
  -> capture order-read token before I/O
  -> read allOrders for this task
  -> related-symbol preflight + order-read token validation
  -> DailyLoss prepare (no state publish)
  -> current-direction local order rebuild + consumed-fact coverage commit
  -> DailyLoss publish
  -> canonical account/position paired refresh (SEAT_ACTIVATION)
  -> validate receipt + current identity
  -> await position-hold subscription reconcile from current truth
  -> validate current receipt + identity + fact generation
  -> synchronous final publish:
       R1/N1 calculate/publish
       -> old-symbol local buy records cleanup (only if no seat owns it)
       -> warrant info from callPrice / direction name
       -> ACTIVE
finally:
  -> await releaseRetain
```

必须保持以下边界：

- **订单读写：** 发读前捕获 `dayEpoch + snapshotGeneration + direction + symbol + seatVersion + ACTIVATING`，每任务读取自己的 allOrders；返回后及日损/订单发布前复核。预检覆盖新、不同的旧、当前双方向相关标的。用户已确认保留现有同步顺序：预检 → DailyLoss prepare → 方向订单列表及其实际消费覆盖 commit → DailyLoss publish，全段不插入 await；prepare 不发布日损运行态，且不依赖重建后的缓存，预检不能替代其归属校验。旧快照缺少新 WS orderId 时，当前日损同 ID 合并和订单列表替换都不保护该新事实；必须实现 P1.7 的早期栅栏，不能靠后置 receipt 补合法性。
- **幂等基线：** 继承 P1.7 / 设计 §9.2 的共同 broker orderId 与实际消费覆盖，不在 P3C 重建第二账或首次补防重。相同已消费事实的同单 WS/query 不再次追加 BUY/扣减 SELL；OPEN partial、已消除 BUY、已消费 SELL、空结果与同量金额修正按完整契约处理，不用日损去重/幸存列表替代，也不跳过终态资源收尾。
- **分阶段追赶：** 发读期间 generation 变化但身份仍有效，由同一 owner 追赶当前代次、重读未提交订单输入；不消耗外部失败重试、不 EMPTY、不重开 settlement stale。跨入口幂等前提成立后，此前合法提交后有新事实，保留提交并按正确更新的当前经济投影重做未提交的后置准备；普通 commitRevision 变化不重拉订单，只让依赖旧 revision 的派生重新准备。迟到结果不计为新席位成功/失败，内部错误仍先分类、不能按过期吞掉。
- **snapshot/订阅/风险：** coordinator 只 read/validate/commit/receipt，不等待业务 ready；activation owner 校验 receipt 后等待当前事实的持仓订阅，不调用 `waitForFresh()`。每个 await 后复核生命周期、epoch、身份及适用 generation/revision；当前字段足够则取新 receipt 重算，否则补读。R1/N1 数学上不依赖订阅，但现方法直接发布共享缓存，故保留订阅成功后才发布的业务屏障。最终计算/发布、条件化旧标本地买单清理、warrant/name、ACTIVE 不插入 await；有异步准备必须 compare-and-publish，禁止先写后检。旧标清理只在 previousSymbol 不同于新标且无当前席位归属时发生，不删除真实持仓/成交或全局订阅。
- **ACTIVE 与 release：** ACTIVE 是业务放行点，永久 SEAT_BOUND 投影先排入同一订阅串行链，再 finally 完整 await releaseRetain。释放不成为新 ready 门禁；主体已 ACTIVE 后 release 失败不回滚、不重做激活、不新增 release 专用重试。保留主体/清理错误分类和优先级，内部错误不被外部清理失败覆盖。
- **失败/取消：** 只对仍匹配 ACTIVATING 的任务安排一次明确外部失败延迟重试，耗尽才使该方向 EMPTY；回收价或原规则明确的风险事实无效立即 EMPTY，订单契约/归属/内部不变量错误 fatal。生命周期关门/停止或身份失效只取消旧工作，不自动 EMPTY；仅连续时段关闭不新增 activation 取消条件。activation awaited 订阅错误归其重试；settlement 对账失败由 settlement 保持 stale/重试；普通席位/订单订阅事件保持既有 fatal 分类，不混成 activation 方向局部失败。
- **方向隔离：** 明确外部激活失败不清掉另一方向 ACTIVE、不推进全局 settlement stale；隔离指状态/重试，不假定共享订单、双方向日损和全局订阅天然隔离。
- **独立路径：** 距离移仓回补仍在 SWITCHING 用例内完成后才交付 ACTIVATING，migration purpose 不机械套普通 BUY/SELL 的 ACTIVE 门禁。启动/开盘受控 rebuild 与静态 bootstrap ACTIVE 例外单独审计，全局交易关闭下完成自己的订单、snapshot、风险和订阅基线；不重复整条运行期流程，也不变成 runtime 绕过入口。generation 栅栏不证明券商新查询已包含全部成交或远端接口原子一致（设计 §5.8）。

不是全流程事务：预检/日损拒绝时无后续激活派生发布，不表示此前 retain、admission、行情读取或上游合法移仓均未发生；finally 仍执行。订阅失败不回滚已合法提交的共享券商事实，不新增全流程回滚、全局风险屏障或并行阶段。

#### 验收

- 运行期只有 SeatActivationWorkflow 能决定 `ACTIVATING -> ACTIVE`，普通 BUY/SELL 不早于业务屏障放行。
- `rebuildTradingDayState.activateRebuiltSeats` 通过显式受控基线路径审计，不机械重跑 runtime activation；静态 bootstrap ACTIVE 例外不能绕过开门前的完整基线。
- 自动寻标/周期/距离入口的版本提升、清理边沿和 previousSymbol 保持；不额外 bump，不重复清理，不改变 SWITCHING 内回补。
- 全量订单预检或日损归属拒绝后，不再执行该任务的订单重建、账户刷新、风险/ACTIVE 发布；仍完整等待 retain 清理。
- 真实“LONG 读旧 allOrders，SHORT ACTIVE 新 SELL 成交，旧响应迟到”交错中，旧响应不能改写已确认日损或订单列表；generation 追赶不消耗外部重试、不重复 stale，停止/日切时不启动追赶。
- 同一真实订单 owner 中，回补提交 → ACTIVATING → API 已投影 FILLED → 后置 await → 同单 WS/query 的交错不重复数量/成本/日损，R1/N1 正确，终态资源仍正常收口；不能用两个独立 recorder 的等价输出替代验证。
- 已消除 BUY 重放、已消费 SELL 重放、空结果、OPEN partial → 同量终态和同量高 revision 金额修正均符合 P1.7；受控基线恢复也同步建立实际消费覆盖，不因 owner 迁移重置幂等语义。
- 仅普通 commitRevision 更新不重拉 allOrders；后置 r10 派生在 r11 到达后不得发布，改用当前事实/receipt 准备。
- 订阅 pending/失败、等待中身份/epoch/generation 失效时，不提前发布新风险或 ACTIVE；单方向明确外部失败不改另一方向当前 ACTIVE。
- ACTIVE 后 SEAT_BOUND 接棒且 finally 完整 await release；清理外部/内部失败及主体错误组合保持原分类/优先级，主体已 ACTIVE 不重做激活。

### 9.4 P3D：SeatSwitchWorkflow

终态为 `src/application/seatSwitch/`，pure policy/state 在 `src/domain/seat/`，周期/距离 wakeup 保留具名 `src/runtime/periodicSwitchWakeupRuntime/`、`runtime/monitorQuoteEventRuntime/`。来源包括 `src/services/autoSymbolManager/switchStateMachine.ts`、`src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` 和现有周期/距离换标 runtime；保留 `PERIODIC_REPLACE` 与 `DISTANCE_MOVE` policy 差异，不复合迁入 activation 或 autoSearch owner。

#### 任务

使用共享阶段执行器，但 policy 必须显式定义：

- candidate selection。
- old seat handling。
- 是否卖旧标。
- 是否等待可用持仓归零。
- 是否回补。
- 回补金额来源。
- 失败/冻结规则。
- 完成条件。

不得用一组布尔值隐藏 policy 差异。与 P3C 的接口保留 DISTANCE_MOVE 在 SWITCHING 内回补后再交付 ACTIVATING，不给 PERIODIC_REPLACE 增加移仓行为。

已提交 SWITCHING/pending 状态的 WAIT 必须归现有 switch wakeup owner，或由生命周期停止协议明确收口；后置连续时段门禁关闭只暂停推进，不能抹掉已提交工作的 owner 交接。不得依赖后续行情/重复 tick，或新增扫描兜底恢复 ownerless SWITCHING。

#### 验收

- 周期和距离换标均能独立测试。
- 实际卖出金额以精确 Decimal/文本决定回补预算；预算/价格/信号/command 不经有损 number，买量向下整手规则和安全整数数量边界通过 §13.4.2。
- 旧 seatVersion 的晚到任务不能写入当前席位。
- 换标交易副作用的订单、持仓、订阅和生命周期门禁顺序不变；WAIT owner 交接不是新增交易副作用，不能被后置时段门禁抹掉。
- pending 已提交、WAIT 尚未交接时连续时段门禁关闭，工作仍有暂停/取消 owner；不会留在无人推进的 SWITCHING，也不以激活任务代管或重排回补。

### 9.5 P3E：DoomsdayClearanceWorkflow

终态 doomsday owner 为 `src/application/doomsdayClearance/`；末日窗口纯规则与执行状态在 `src/domain/liquidation/`；timer/event program 保留语义名于 `src/runtime/timeWakeupEvaluationProgram/`。

#### 范围（均为现存迁移来源）

- `src/core/doomsdayProtection/index.ts` -> domain rules + application use case，移除旧 canonical writer。
- `src/main/timeWakeupEvaluationProgram/index.ts` -> `runtime/timeWakeupEvaluationProgram/` 仅路由/触发。
- `src/core/trader/orderExecutor/quantityResolver.ts` -> pure quantity rule/application command prep/infra latest-quantity read 按职责拆分。
- `src/core/trader/orderMonitor/orderOps.ts` -> order command/tracking owner；本阶段只迁移末日调用，不建立第二套 order facts。

#### 任务

本阶段不新增 `LiquidationActionOverlay`。submit UNKNOWN 按 §1.1 统一为直接 fatal；P1 已完成末日特殊分支删除，本阶段只迁移 owner：

```text
submit request attempted
  -> result cannot be confirmed
  -> report fatal / close trading admission
  -> do not resubmit
```

约束：

- UNKNOWN 不创建本地伪 orderId、伪 acceptedQuantity 或 unresolved 持久状态。
- 已确认返回 orderId 的订单继续由既有 OrderMonitor 和权威终态推进；已接受不代表成交或空仓。
- canonical positions 只来自 snapshot owner；不因 UNKNOWN 直接修改为 flat。
- 末日清仓仍先处理旧待成交卖单，取得权威终态后再重新取可卖持仓。
- 不把末日清仓转为保护性 completion/cooldown。
- 保留既有成功条件下的 `orderRecorder.clearBuyOrders` 副作用，但不清除权威成交事实。

#### 验收

- submit accepted 不会把本地持仓立即过滤为空。
- UNKNOWN 直接上报 fatal，关闭交易放行并进入既有终止清理；不重复 submit，不安排 UNKNOWN 专属查询或重评估。
- 已确认订单仍由既有 tracking/terminal 链路防重和收口，不新增 overlay 状态机。
- 末日窗口、席位归属和当前标的校验不变。

### 9.6 P3F：普通交易、自动寻标、静态清仓与风险刷新

#### 终态目标与迁移来源

- 策略私有执行与动态加载：按 §4.1.1 的职责拆分在本阶段闭合，现存 pending/timer/saved-emitter 与生命周期编排迁至 `runtime/strategy/<策略目录>/`，纯指标增量状态、样本/验证计算留 domain。迁移 `prepareStrategy` / `strategyLoaderHelpers` / selected factory 的全部路径和布局契约，保留精确文件/扩展名校验、只 import/prepare 选中项一次、配置失败先于 SDK 创建及同一实例跨日重置；所需 SDK-free 契约随切面提前完成，不等待 P4，不新建策略 runner/registry。
- 普通买入：现有 `src/main/asyncProgram/buyProcessor/**`、`src/main/ordinarySignalGuard/**`、`src/core/signalProcessor/**` 按职责拆为 `runtime/asyncProgram` 队列、`domain/risk|strategy` 纯规则和 `application/ordinaryBuy/` 既有 BUY owner。直接迁移既有 owner，不新增 wrapper，不改变 BUY 原有临时账户/持仓读取和风控集合。
- 普通卖出：现有 `src/main/asyncProgram/sellProcessor/**`、sell quantity/risk 调用方迁入 `application/ordinarySell/`；FIFO queue 留 `runtime/asyncProgram/sellProcessor/`。最终执行前仍按 §8 gate 校验 position revision，不扩大 BUY 或 SELL 策略。
- 自动寻标：现有 `src/services/autoSymbolFinder/**` 必须拆为 `infrastructure/longbridge/market` 的 warrantList SDK query/cache/外部 IO retry、`domain/seat` 的纯筛选排序规则、`application/autoSearch` 的调用/失败/重试决策；wakeup timer 留 `runtime/autoSearchWakeupRuntime/`。新层禁止直接依赖 SDK。
- 静态距回收价清仓：现有 `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts` 拆成 `runtime/monitorQuoteEventRuntime` 触发 + `application/staticLiquidation/` 执行与失败 owner + `domain/liquidation` 纯规则。静态新增量及其成交不归入 protective progress/episode，也不独立产生保护性 completion、cooldown 或分段边界；实际成交仍参与正常结算与日损益计算。若此前已有真实 protective episode，静态成交使方向空仓后只提供 settlement 判定所需事实；旧 episode 仍由 `PostTradeSettlementWorkflow` 按其真实执行边界判定、完成与提交。此目标必须同时闭合以下共享执行修正，而非仅保留入口的 `false` 标识。
- 风险刷新：现有 `src/main/tradingRiskEventRuntime/**` / `src/core/riskController/**` 中真实独立的风险事实刷新由 `application/riskRefresh/` 持有；P3B 已迁移的 protective trigger、daily-loss completion 不重复迁入。若没有独立入口/完成条件，则并入真正的 activation/settlement/risk owner，不为目录齐全创建第二 workflow。
- `application/orderRecovery/` 仅在恢复构成独立于 tracking 的真实用例入口/失败策略时拆出；否则 recovery 与订单事实更新继续内聚在 `application/orderTracking/` 的一个串行入口。二者不并行拥有 order facts，不拆 durable completion transaction。

#### 静态 owner 与共享执行的最小闭合切面

依 design §7.2.1，复用现有订单事实、终态结算及可卖量流程，不新增订单账、overlay、通用清仓框架或 durable log 格式。P4.2 已覆盖共享提交/改单模块；需要提前完成的是以下明确规则及最小契约，而不是扩建新 owner：

1. **旧单事实（P4.1 最小切片）。** 迁移来源 `src/core/trader/types.ts` 的 `PendingSellOrderSnapshot` 最少增加必需的 `isProtectiveLiquidation: boolean`；`src/core/trader/orderMonitor/index.ts#getPendingSellOrders` 从 tracked order 原样输出。同步更新全部调用方及 snapshot fixtures，不能设兼容默认值或将旧身份改为新请求身份。终态 `OrderFact` / tracking / pending-sell view 保留该可证明归属；不要求为历史订单补造全部 purpose。
2. **共享决策（P4.2 最小切片）。** `src/core/trader/utils.ts#resolveSellMergeDecision` 对有效剩余量旧单检查身份：非 protective 新量遇 protective 旧单，选择已有 `CANCEL_AND_SUBMIT`，禁止扩量 `REPLACE`。新 protective 请求保留原撤旧规则，普通非 protective 单张同类型可改单旧单仍允许 `REPLACE`，其他合单限制不变。`submitFlow.ts` 的初次决策与提交前最新事实复核使用同一规则，事实变化时不沿用旧 `REPLACE`。
3. **终态与数量（P4.2 执行连接）。** 复用 `submitFlow.ts` / `orderOps.ts`：ACK（当前 `CANCEL_CONFIRMED`）不是 canceled terminal；取得可信非 FILLED 终态并完成本地结算后，重新读取 broker 可卖量，扣除实际已成交需求并按原数量策略重规划、授权及报价后提交新 orderId，保留非 protective tracking/remark。`FILLED`、查询仍 OPEN、终态成交量缺失或事实不可信时不能继续换单；不新增委托、不提前清理静态买单记录，保持既有失败分类和重评估 owner。
4. **身份与恢复（P4.3 最小切片）。** `orderOps.ts` 不清除旧 protective 标志或改写 remark；`recoveryFlow.ts` 按既有 broker `|PL` 后缀恢复身份，并将其带入 pending-sell 决策。零成交挂单不创建 progress/episode；已有 episode 时仍阻止提前完成。精确恢复沿用 loader 的 durable progress/completion 匹配，不能使用 `order.updatedAt` 补造成交时间。关联买单数量校验可能拒绝改单，但空关联或恰好匹配均不能成为跨目的扩量豁免。
5. **原成交与完成。** `settlementFlow.ts` / order tracking、DailyLossTracker / episode tracker 保留旧单真实累计成交和执行时间，包括撤单窗口新增成交；不得清除旧身份、按混合数量比例拆归属或压制旧合法 episode。静态新单不推进 protective progress；旧 episode 在方向空仓且无同方向 OPEN protective SELL 后，由 `PostTradeSettlementWorkflow` 基于这些事实独占最终判定，并按 completion 持久化 → daily-loss boundary commit → cooldown 计数 → episode commit 完成，激活冷却继续受原触发阈值约束。

这些来源按 §4 迁至 `domain/order` 规则、`application/orderExecution` / `orderTracking` 和 trade adapter；最小切片可先在旧来源完成，再随 P3F 闭合迁移，不能把 SDK 类型带入新 application。P3F 不得以“现有静态单测通过”或“已有 OrderCommand.purpose”为隔离验收；必须执行 §13.4.1 的真实跨模块检查，未闭合前不发布该切面。

#### P3F 验收

- BUY/SELL queue、策略 policy、application owner 分层清楚；旧 BUY/SELL owner 被直接迁移且不存在纯转发 wrapper。
- 策略私有 timer 不落入 domain；复用 `tests/app/startup/prepareStrategy.test.ts` 验证新布局的 `.ts/.js` 定位及仅选中入口加载，迁移真实 pending/emitter/lifecycle 测试到 `tests/runtime/strategy/` 和对应宿主镜像。保存初始 emitter/SELL 授权、验证前先消费 token、失效后旧回调不输出、reset/destroy 与午休/末日/方向失效接线均保持；纯指标/验证计算测试归 `tests/domain/strategy/`。
- warrantList/caching 外部依赖只在 market adapter；筛选为纯 domain/seat 规则；autoSearch 重试由 application 唯一负责。
- static liquidation 与 protective/doomsday 的交易目的及副作用互不混淆；非 protective 新量不扩入 protective 旧单，旧合法 episode 完成未被禁止，§13.4.1 场景通过。
- 价格限制、现金/市值上限、成本/智能平仓、回收价距离、候选比率/成交额筛选和风险刷新按 §4.4 做十进制计算/比较，严格或包含边界及筛选排序优先级不变；§13.4.2 的受控误差修正通过，指标算法/验证不被连带升级。
- `tests/application/ordinaryBuy/`, `ordinarySell/`, `autoSearch/`, `staticLiquidation/`, `riskRefresh/`（只为真实独立职责新增）镜像最终源码；runtime wiring tests 镜像具体 runtime 名称。

### 9.7 Phase 3 共享验收

- application workflow 是唯一业务完成条件 owner；其中 protective 最终完成判定/事务只归 `PostTradeSettlementWorkflow`，不由 `ProtectiveLiquidationWorkflow` 或 order tracking 复制。
- runtime 只做事件路由、队列、timer、stop/drain。
- domain 纯规则不发网络、不写 LastState、不安排 timer。
- workflow 失败 owner 不被其他 runtime 重复接管。
- 既有交易目的矩阵未被统一流程抹平。
- P3F 的 §13.4.1 隔离链路通过：静态新增量不推进 protective progress/episode、执行时间或分段边界；旧真实 protective episode 的最终判定与完成只由 settlement owner 作出，合法完成与冷却计数保持。

---

## 10. Phase 4：收口 Longbridge Adapter 与内部事实模型

### 10.1 目标

P4 完成后，生产环境所有 Longbridge SDK runtime/type-only import 仅存在于 `src/infrastructure/longbridge/trade/**` 与 `src/infrastructure/longbridge/market/**` 的真实 adapter/mapper。P1 已提前建立 account/position 最小 facts/read port/mapper，P2 已清理 settlement collaborator SDK contracts；本阶段拆分剩余 order facts、commands、query/push/recovery、策略 Period 和 account/position query，不是到 P4 才开始消除业务 SDK leakage。`app` 只装配 adapter factory，不 import SDK 或持有 `TradeContext`。

### 10.2 内部契约任务

跨层共享数据/port 放最近共同父级的现有 `src/types/` 目录，按需新增 `src/types/trade.ts`、`src/types/accountPosition.ts` 等窄契约文件；模块内私有协议放相邻 `types.ts`。不建总 contracts 文件夹，不以 type-only 方式绕开矩阵。

```text
TradeCommandPort
TradeFactsPort
OrderCommand
ReplaceOrderCommand
CancelOrderCommand
OrderFact
AccountSnapshot
PositionFact
SubmitOrderResult
ReplaceOrderResult
CancelOrderResult
OrderQueryScope
```

能力使用 `interface`，数据使用 `type`；不从 `types/services.ts` 继续扩大 Trader 超宽接口。

`OrderCommand.purpose` 仅用于审计、归属和执行分支，不包含买入风控策略本身：

```text
ORDINARY_BUY
ORDINARY_SELL
SWITCH_MOVE
SWITCH_REBUY
PROTECTIVE_LIQUIDATION
STATIC_DISTANCE_LIQUIDATION
DOOMSDAY_CLEARANCE
```

`OrderCommand.purpose` 只描述新命令，不会改变被修改旧单的身份；`OrderFact`、tracked order 与 pending-sell view 必须另保留可证明的旧 protective 身份，由 execution owner 同时检查新旧事实，按 §9.6 禁止跨 protective 扩量。不得仅增加新命令枚举就宣称完成目的隔离。

本次不为 UNKNOWN 新增 `clientIntentId` 或远端幂等协议；沿用已有信号身份和已确认的 orderId。

### 10.3 Adapter 迁移顺序

#### P4.1 映射基础事实

- P1 已有的 account/position facts、read port 和最小 mapper 继续复用；P4 仅补齐尚未收口的账户/持仓 query/result paths，不创建第二套契约/mapper。
- 迁移剩余 SDK order DTO/query/push -> 内部 `OrderFact`/fact event；SDK enums -> 内部联合类型。
- SDK Decimal 构造/解析与映射只在 infra mapper；金融输入直接读十进制文本，领域计算/状态使用按文首已确认口径经 P0.4 工程验证的独立库，command 金融值由文本直接构造 SDK 值，不经 number 往返。
- 按已确认 §4.4 口径执行金融精度升级并移除旧金融 number 投影。保留安全整数/指标边界、公式/单位、阈值包含关系及 V1 schema/ID 规则。领域公式、整手规则、progress/baseline 比较不得迁入 broker mapper，mapper 不承担金融规则。

#### P4.2 迁移 submit/replace/cancel

以下为现存迁移来源，不是终态实现路径：

- `src/core/trader/orderExecutor/submitFlow.ts` -> `src/application/orderExecution/` + `src/infrastructure/longbridge/trade/` command adapter。
- `src/core/trader/orderMonitor/orderOps.ts` -> `application/orderTracking` / `orderExecution` 分责；adapter 实现进 infra。
- 相关来源 `types.ts`、test doubles 和错误分类 -> 最近共同父级 `src/types/trade.ts` 或模块相邻 `types.ts`；业务测试 fixtures 不再依赖 SDK。

结果必须保留：

- submit accepted(orderId)。
- 明确业务 rejected。
- request attempted but UNKNOWN：由上层直接报告 fatal，不得落入普通外部失败的重评估分支。
- replace acknowledged、明确 rejected、already closed、retryable external error、UNKNOWN。
- cancel acknowledged、already terminal（附权威 fact）、retryable external error、UNKNOWN。
- 上层 preflight 保留 `CANCEL_NOT_STARTED`：请求尚未发送，不得转为 acknowledged/UNKNOWN；该结果属于 order operation owner，不强塞进 broker response union。
- 各操作类型保留 operation、requestAttempted、必要原始错误码、cause；业务层使用内部标签而非自行解析 SDK 文本。
- orderId 已取得但本地落账失败时不得重提原命令。

保留现有 `602013` 四次退避、第五次权威查询、必要时 `WAIT_WS_ONLY` 的 owner 和时机，不能用统一 `retryable` 布尔值替代。

§9.6 的旧单身份、共享合单规则、可信终态及新鲜可卖量重规划属于此共享执行边界；其最小切片已要求随 P3F 提前闭合。P4.2 收尾迁移时继续验证该规则，不回退为只检查新命令 `purpose`，也不把 cancel ACK 当新单提交许可。

#### P4.3 迁移 order query/push/recovery

现存来源 `src/core/trader/orderMonitor/{orderStatusQuery,recoveryFlow,types}.ts`、`src/core/orderRecorder/{orderApiManager,types}.ts` 闭合迁入 `src/application/orderTracking/` + `src/domain/order/`，所有 SDK query/push/status mapper 迁 `src/infrastructure/longbridge/trade/`。Recovery 仍先订阅/BOOTSTRAPPING 缓冲并由一个串行入口推进；只有存在独立恢复入口和失败策略时才使用 `application/orderRecovery/`，不为物理拆分产生第二 tracking owner。

保持：

- 累计成交量单调。
- 数量不变时允许更高权威 revision 修正金额。
- 继承 P1.7 已实现的经济投影消费契约；API 基线恢复、BOOTSTRAPPING 缓冲回放及 query/push 共用 broker orderId 与实际消费覆盖，同段建立列表/覆盖，不把 pending OPEN partial 当已消费。同单重放不再次追加 BUY/扣减 SELL，合法金额修正与终态资源收尾不被去重屏蔽；不新增第二账或 durable 格式。
- progress/baseline 财务值精确恢复，不再投影为 number；数量仅在证明安全整数时允许 number 比较，否则使用 Decimal。时间/revision 择新、排序键顺序与阶段优先级不变；按 §13.4.2 / §15 恢复全部不同 ID 历史记录，不折叠为 latest-only，也不重写旧精度事实。
- cancel accepted 与 terminal 分开。
- recovery 先订阅并 BOOTSTRAPPING 缓冲，再加载事实、恢复归属/占用、合并回放/对账进入 ACTIVE。当前 recoveryFlow 每单合并较新回报并按更新时间回放，不能改为原始接收顺序 FIFO。
- pending-sell 占用恢复和关联买单归属不变；恢复出的旧 protective 身份进入同一共享合单规则，零成交 tracking 与精确 episode 恢复仍分离，不能以关联买单数量检查替代 §9.6 的目的隔离。
- 未知 SDK status fail-fast，不转为空数组或 null。

#### P4.4 收尾剩余 account/position snapshot read seam（不是首次创建）

P1 已闭合 canonical snapshot 内部 facts/窄 read port 和最小 Longbridge account/position mapper；P2 新 settlement 已使用中性 contract。P4.4 只把以下尚余的现存 SDK/query/业务读取职责收口到既有 adapter 与 owner，不重新定义、不重复创建 snapshot store/coordinator：

- 来源 `src/core/trader/accountService.ts` 中余下 SDK access -> `infrastructure/longbridge/trade`；application 只调用 port。
- 来源 `src/core/trader/orderExecutor/quantityResolver.ts` -> pure quantity policy `domain/order|position` / `application/orderExecution` 与最新可卖量 adapter read 按职责拆开。
- `application/accountPositionSnapshot` 继续使用 P1 创建的 read port/mapper；不增加第二 store owner。
- 普通 BUY 临时账户/持仓读取由既有 `application/ordinaryBuy` 使用内部 facts，并保持是临时风险输入。
- 普通 SELL/末日执行时的最新可卖量确认由相应用例经 trade port 读取，不能用 cached canonical view 替代执行前裁剪。

这些读取必须区分：

- canonical snapshot read/commit。
- BUY 临时风险输入。
- SELL/末日执行时的最新可卖量确认。

不能用一份 shared snapshot 替代执行前权威数量裁剪。

#### P4.5 删除 SDK 业务渗透

完成闭合迁移后搜索并清理：

- `src/types/services.ts` 对 SDK 类型的暴露。
- `src/types/trader.ts` 对 SDK 语义的间接暴露。
- `core` 和业务 workflow 中的 `TradeContext`、SDK enum、push DTO、SDK Decimal 依赖。
- `src/core/strategy/types.ts` 等策略契约的 SDK `Period`：改为内部周期标签，迁移 definition、MarketDataClient 契约、调用方及适配映射，不改变一分钟线 confirmed/active 语义。
- config/constants、risk、numeric、标的筛选中实际穿越业务边界的 SDK 类型：仅 SDK 映射移入 mapper，领域公式/比较由 SDK 无关十进制能力承接，不能把整块数学移入 mapper 或简单改后缀绕过扫描。
- 业务测试中直接构造 SDK 对象的非 adapter 部分。

P4.5 后合法 production SDK 边界仅为：

- 交易：`src/infrastructure/longbridge/trade/**` 中 adapter/factory/mapper。
- 行情与 warrants：`src/infrastructure/longbridge/market/**` 中 quote/warrant adapter、SDK mapper 和对应外部 IO retry/cache；纯市场筛选规则不在例外内。
- composition root 只 import 无 SDK 类型的 adapter factory，不创建/传递 SDK context。

行情继续使用独立 MarketDataClient，不并入 Trade port。P1/P2 已提前闭合 snapshot/readiness 所需的窄 SDK contract 切片；其余旧来源 exception 必须逐阶段删除。最终静态扫描（含 type-only/dynamic import）须验证业务违规 import fail、合法 market adapter pass。

### 10.4 Phase 4 测试任务

新增测试从创建时即位于终态镜像目录：

```text
tests/infrastructure/longbridge/trade/orderFactMapper.test.ts
tests/infrastructure/longbridge/trade/tradeAdapter.business.test.ts
tests/architecture/longbridgeBoundary.test.ts
```

迁移前 `tests/core/trader/**`、`tests/core/orderRecorder/**` 和 `tests/services/quoteClient/**` 只作为现状基线；订单、恢复、market adapter 测试在 P4 闭合时移至 `tests/application/orderTracking/`, `tests/domain/order/`, `tests/infrastructure/longbridge/{trade,market}/`，删除旧文件。

必须覆盖：

1. 普通 BUY/SELL 与末日 submit UNKNOWN 均直接 fatal，不重提、不启动 UNKNOWN 专属读取或重评估；fatal 仍由顶层执行既有 cleanup。
2. accepted 后本地记录失败不重提。
3. cancel acknowledged 不等于 canceled。
4. cancel 后部分成交按累计事实结算。
5. 数量不变但金额 revision 更新。
6. 未知 SDK status fail-fast。
7. SDK DTO TypeError/ContractError/InvariantError 不被包装为 UNKNOWN。
8. 602013、order-closed/query-open 等既有特殊分支不变。
9. adapter 保真金融输入/command；§13.4.2 的买量、距离、日损益、progress/baseline 及显示满足十进制目标，受控修正旧浮点误差；合法整数/指标语义保持，不以原 number 结果代替精度验收。
10. order recovery、pending-sell 和 protective progress 测试继续通过。
11. 最终门禁关闭返回 CANCEL_NOT_STARTED，broker cancel 调用为零，既不等待虚构 ack，也不进入 UNKNOWN。
12. replace 明确拒绝独立分支、请求错误原始码/cause/attempted 保留。
13. Period 改为内部标签后策略一分钟线行为不变；合法 quote adapter SDK import 不误报。
14. 加载订单期间注入 push，按现有每单较新回报合并和更新时间回放，不丢加载窗口的事实。
15. §13.4.1 的目的隔离、旧合法 episode 完成及恢复边界在 SDK 收口后继续通过；新命令目的与旧订单身份均未在 mapper、快照或替身中丢失。

### 10.5 Phase 4 验收标准

- 生产代码全部扫描后 Longbridge SDK import/type-only import 仅在 `src/infrastructure/longbridge/trade/**`、`src/infrastructure/longbridge/market/**` 的 adapter/mapper；`app/domain/application/runtime/config/constants/types/utils` 均为零。
- 生产业务模块和 app composition 不直接创建/暴露 `TradeContext`。
- adapter 是 SDK status/DTO/Decimal/push/query/error 映射的唯一边界；纯筛选、cooldown、risk rule 及领域数学/恢复比较不属于 adapter。
- P0.4 / §13.4.2 按文首已确认精度口径完成全矩阵离线复验：金融事实/状态/计算/显示无未授权 number 投影，独立库无 SDK 依赖；V1 结构/校验/ID 规则保持，fixtures 离线恢复通过。真实历史逐条对账及候选/回退完整恢复仍是未来生产发布门禁。
- submit UNKNOWN 按 §1.1 统一为 fatal；保留 UNKNOWN/ACK/terminal 区分，cancel/replace 的既有错误分类及重试时机不变。
- 除 §1.1 / §9.6 已列修复及 §4.4 / §13.4.2 明确登记的金融精度变化外，普通交易、换标、清仓和恢复链路行为等价；公式、门禁、目的隔离与旧合法 protective 完成保持。

---

## 11. Phase 5：收敛静态生命周期清单

### 11.1 目标

在 `app` composition root 建立一份静态、可检查、有序的生命周期资源清单；它只登记/校验，不执行生命周期动作、不替换具名 runtime。职责必须分开：app factories 创建并注入依赖；具名 `runtime/lifecycle` 负责日切协调、producer stop、队列 drain 和重建时点；`application/tradingDayRebuild` 执行重建用例；`accountPositionSnapshot` 持有自己的 admission/generation/store 协议；唯一 app cleanup executor 负责最终具名 cleanup。减少新增 runtime 时遗漏 startup/midnight/rebuild/termination/cleanup 的风险，不建动态 registry 或第二执行器。

### 11.2 清单内容

建议新增：

```text
src/app/lifecycle/
  lifecycleChecklist.ts
  lifecycleChecklistValidation.ts
  types.ts
```

清单至少覆盖：

```text
startAfterRebuild
stopAdmissionAndStopNow
midnightStopAndDrain
openRebuildStart
finalDrainAndDispose
```

每项只声明真实存在的 owner 和顺序依赖，不补空方法。

### 11.3 迁移任务

#### P5.1 闭合重建 owner 并盘点所有 runtime

在 P1 已完成 snapshot 安全改造、P3C 已闭合 activation 门禁的基础上，此阶段完整迁移 `src/main/lifecycle/rebuildTradingDayState.ts` 的业务重建入口、完成条件和失败策略到 `application/tradingDayRebuild`；拆出 `runtime/lifecycle` 的具名日切/启停协调。迁移所有调用方与镜像测试，删除旧入口，不改变既有加载、恢复、激活和开门顺序。§4 的生命周期来源行中 P1/P3 只代表前置安全切片，P5 是完整 owner 的唯一截止阶段；P6 仅扫残留。

以 `src/app/runApp.ts`、`src/app/runtime/createPostGateRuntime.ts`（factory only）、迁移前来源 `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts`、`src/app/shutdown/createCleanup.ts` 为入口；最终目录分别是 `src/app/`, 具名 `src/runtime/*`, `src/application/tradingDayRebuild/` 和唯一 cleanup。登记：

- 创建位置。
- 启动位置。
- 停止位置。
- drain 位置。
- 午夜行为。
- 重建行为。
- 最终 cleanup phase。
- 是否在交易关闭时仍需运行。

#### P5.2 校验现有顺序，不执行新顺序

`runtime` 按原有具体 program 名落位；app 中同名 `create*Runtime` 如保留仅为 factory。dayLifecycleManager/time wakeup 之类实际 timer/queue/listener 不能在 `app/runtime` 留实现。静态清单不得改写顺序、不得执行 stop/drain，不新增第二 cleanup executor。架构测试校验：

- TimeWakeupRuntime 在交易关闭/重建期间仍存在。
- BusinessEventProgram 在午夜前停止。
- monitor/buy/sell 队列按现有规则 drain。
- OrderMonitor 在订阅和 trader teardown 前收口。
- QuoteSubscriptionRuntime 在事实 owner 停止后处理订阅。
- Strategy destroy 在交易/事实/订阅 owner 收口后执行；最终行情 reset、退出监听注销继续保持现有 cleanup phase 相对顺序，不能把“最后”解释为强行移动到所有资源之后。
- cleanup 失败继续后续步骤并汇总首个 fatal。

#### P5.3 资源取得即登记 cleanup

保留当前增量登记模型：资源创建成功后立即登记 cleanup，工厂返回前失败也能释放已取得资源。

不要将 `CLEANUP_PHASE_ORDER` 替换为动态拓扑排序或数字 priority 自动推导。现有 phase order 仍是终止协议。

#### P5.4 禁止 self-drain

架构/单测检查以下约束：

- worker/handler/scheduler 不在自身 in-flight task 中等待自己的 stopAndDrain。
- TimeWakeup 触发 midnight/rebuild 时不等待自身 drain。
- fatal 只负责同步关门/停产并通知顶层；全局 cleanup 由顶层 await。

### 11.4 Phase 5 测试任务

新增建议：

```text
tests/app/lifecycle/lifecycleChecklist.test.ts
tests/app/lifecycle/lifecycleChecklist.wiring.test.ts
```

扩展迁移前基线后落到最终职责镜像：

- `tests/main/lifecycle/cacheDomains/signalRuntimeTermination.test.ts`、`tests/main/lifecycle/dayLifecycleManager.test.ts` -> `tests/runtime/lifecycle/`。
- `tests/app/shutdown/createCleanup.business.test.ts`、`tests/app/runAppTerminationMatrix.business.test.ts` -> `tests/app/shutdown/` / `tests/app/`（仅唯一cleanup wiring）。
- `tests/integration/postTradeDrainLifecycle.integration.test.ts` -> 保持 `tests/integration/`。

### 11.5 Phase 5 验收标准

- 新增 runtime 只有 app 静态清单中的一个覆盖登记点，但实际启动/停止仍由具名 runtime / 唯一 app cleanup executor 执行。
- app/runtime 文件只负责 factory/assembly；日切协调属于 runtime，重建属于 application；不存在两个文件都自称 runtime 实现的重复层。
- startup/midnight/rebuild/termination/cleanup 覆盖可由测试验证。
- TimeWakeup 的特殊持续运行语义不变。
- stop/drain 顺序不回退；cleanup 只有一个 executor，失败仍继续后续步骤并汇总首错。

---

## 12. Phase 6：收窄公共契约与物理目录

### 12.1 目标

P0/§4 已确定终态目录、职责、依赖矩阵与逐源迁移路径；P1–P5 按闭合切面迁移 owner。P6 不是首次决定架构或首次移动业务，而是清理迁移剩余的宽公共接口、物理残渣、旧路径、旧名 façade/转发和文档链接，并验证既定终态。只清理真实残留，不为目录漂亮扩大范围。

### 12.2 任务

#### P6.1 拆分宽契约

重点检查：

- `src/types/services.ts`
- `src/types/trader.ts`
- `src/types/state.ts`
- `src/types/risk.ts`
- `src/app/types.ts`

按最近共同父级拆分：

- snapshot read/commit capability。
- settlement readiness capability。
- trade command/facts port。
- seat registry/activation capability。
- lifecycle capability。
- notification/logging capability。

禁止继续把无关能力塞入 `Trader` 或全局 `LastState`。

#### P6.2 清理旧入口与来源目录

全量搜索并删除：

- 旧 snapshot writer helper。
- 旧 SDK type alias。
- 旧 façade、旧名委托链、re-export、wrapper 和兼容层。
- 不再使用的 LastState 字段类型。
- 本次迁移直接造成的 dead code。
- `src/core/`、`src/main/`、`src/services/` 中所有生产实现/混合职责路径；终态不保留这三个根目录下的混合实现、仅转发层、旧入口或兼容目录。逐路径依 §4.1.2 验证，不能以 re-export 或目录 stub 充数。

同步定向更新 README、AGENTS、`src/` 旧路径引用及其他实施文档中的迁移路径/命令，仅在未来对应实施切面闭合时更新。本轮仅更新本实施计划，数值要求优先级按文首声明处理；不修改设计文档或预先批量改写其他文档。

#### P6.3 物理目录移动

仅在逻辑 owner 已稳定后移动文件。每次移动必须同时完成：

- import 影响检查。
- runtime owner 检查。
- 相关测试路径更新。
- 架构边界规则更新。
- 全量调用方和导出引用检查。

### 12.3 Phase 6 验收标准

- 新功能/跨层事实从最近共同父级窄契约导入，不依赖超级 `services` 类型，`types` 无高层反向依赖。
- 无业务模块依赖全局 service locator，无跨层 contracts 超级中心。
- 无旧名字兼容委托、forwarding facade、无关 re-export 或第二 store/order/runtime/cleanup owner。
- `src/core/`、`src/main/`、`src/services/` 无生产实现、混合职责、转发层或兼容路径；若空目录可删除，不允许作为“保留兼容”位置。
- 物理目录与第 4.1.1 终态一致；owner/依赖在此前阶段已建立并验收，P6 不再首次定架构。

---

## 13. 测试与验证矩阵

### 13.1 每个阶段的验证顺序

验证项按 P0–P6 分阶段收紧；P0 的旧来源白名单按 §5.1 固定且只减不增，不因 P4 尚未完成而阻断 P1/P2 对旧实现的安全修改，也绝不授权新 domain/application 引入旧 SDK contract。每阶段同时核对目标目录、调用方、旧入口删除、最终测试镜像和边界扫描。

修改 TypeScript 后按项目约定执行：

```text
bun format
bun lint
bun type-check
bun test <本阶段相关文件或目录>
```

跨核心链路阶段收尾执行：

```text
bun test
bun build
```

`bun format` 会写入文件，只在确认当前工作树改动范围可控时运行。若仓库存在与本次无关的工作树改动，应先记录并避免把无关格式化结果混入提交。

### 13.2 Snapshot 一致性

| 场景 | 必须断言 |
| --- | --- |
| seat read 在成交后返回 | 旧结果不能覆盖新 snapshot；需求进入后继 batch |
| 启动/重建读取的旧 epoch 返回 | 不提交、不恢复旧日事实 |
| account 成功/positions 失败 | 不提交 account 半快照 |
| positions-only commit | 只推进 position revision，不伪造 account fresh |
| 新 generation 失效 in-flight | 成功结果丢弃，外部失败次数不增加 |
| 旧 generation 内部错误 | 仍报告 fatal/首错 |
| 多来源请求合并 | 未发 batch 合并字段；已发 batch 不被追加参与者 |
| waiter 取消 | 只取消目标 waiter，不影响其他参与者 |
| 日切 | 旧响应、旧 projection、旧 pending 全部失效 |
| 末日 accepted | 不提前 flat、不提前退订、不触发 completion |
| 原条件下 accepted 账户失效与旧 paired read 交错 | 同步 generation 失效阻断旧提交；失效本身不增加 settlementVersion，后续当前代次合法 paired commit 才恢复账户有效性 |

### 13.3 Settlement readiness

必须覆盖：

- snapshot committed 但 subscription 未完成时 SELL 仍等待。
- completion persistence 失败时不推进 cooldown、daily loss boundary、episode。
- R1/N1 失败不 mark ready。
- 新 settlement 使旧 token 失效。
- 多 waiter 追到同一最新 settlement。
- 日切只拒绝旧 epoch waiter。
- coordinator 不 self-await。
- seat commit 不增加 settlement stale。
- positionRevision 变化时依赖旧 positions 的选单重新计算。

### 13.4 Order adapter

必须覆盖：

- submit UNKNOWN 直接 fatal，不重提、不触发专属读取或重评估；普通交易和末日入口均验证。
- accepted 后本地记录失败不重提。
- cancel acknowledged 不等于 canceled。
- 订单部分成交后撤销按累计事实结算。
- 数量不变、金额 revision 更新。
- 未知 SDK status fail-fast。
- 结构化错误分类不依赖 SDK error 文本解析。
- 602013、order-closed/query-open、WAIT_WS_ONLY 分支保持。
- 金融映射保真并通过 §13.4.2 的目标/差分与恢复门禁；安全整数/指标边界保持。不能只断言 number 相等或原审计字符串无损，更不能保留内部浮点运算。

#### 13.4.1 清仓目的隔离与既有 episode 完成

在 P3F 首次闭合、P4 SDK 收口后复验。连接真实 static executor → shared order executor → order tracking/recorder → `PostTradeSettlementWorkflow` / DailyLossTracker / episode tracker，仅 mock broker、行情、时钟和持久化 IO 边界（不连接实盘）；静态单测中的 `executeSignals` 替身不能覆盖该链路。检查事实归属、broker 调用、durable progress，以及由 settlement 独占的最终 completion 判定、同步 append 和内存提交，不只断言入口标识。

| 场景 | 必须断言 |
| --- | --- |
| 模拟在途零成交 protective ELO + 静态新增量（mock broker） | `replaceOrder` 为零；可信取消结算后重读可卖量，提交非 protective 新 orderId / remark；新单成交不创建 protective progress/episode |
| 旧总量 1,500、已成交 500、剩余 1,000 + 静态新增 1,000 | 真实 partial fill 先记录旧 progress；若无撤单窗口新增成交则旧 protective 累计量始终为 500，不把静态新增量算入；新单按可信终态及最新可卖量重规划 |
| 静态卖出后方向空仓 | 旧进行中 episode 在无同方向 OPEN protective SELL 时，由 `PostTradeSettlementWorkflow` 独占最终判定并恰好完成一次；同步 completion append 后再按既有顺序提交 boundary/cooldown/episode。boundary 使用旧最后真实保护性执行时间，不使用静态成交时间；是否激活 cooldown 仍按原 triggerLimit 决定 |
| 仅 cancel ACK、查询仍 OPEN、可信终态数量缺失 | 不 `REPLACE`、不提交新单、不执行静态买单清理；旧身份/progress 保留，后续权威终态仍可由原流程安全重评估 |
| 撤单窗口新增 partial fill | 新成交归旧 protective orderId，先持久化/结算其累计事实；重规划扣除真实已成交量，不重复卖出需求 |
| recovered protective ELO，零成交/部分成交、关联买单为空/非空 | 同一目的规则始终生效，不依赖精确关联数量恰好拒绝改单；旧真实 progress 保留，静态新单不推进它 |
| 普通非 protective 同类型可改单旧单 | 原合法 `REPLACE` 与最终授权/报价/数量校验继续通过，不扩大修正为禁止全部合单 |
| 完整启动 loader 与 cooldown hydration | remark provenance、durable progress/completion 按原精确事实恢复；单独零成交挂单不创建 episode；已有 progress + 零成交 protective 挂单是 settlement 判定不可完成的权威事实，不能由 tracking/episode 状态自行提交 completion；不从 `order.updatedAt` 补造时间，缺失精确事实仍阻断恢复 |

跨 owner 场景留 `tests/integration/`。入口基线为 `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.business.test.ts`；普通改单复用 `tests/core/trader/finalQuoteMutationPermit.business.test.ts` / `tests/integration/sellFlow.integration.test.ts`；恢复结合 `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 和 cooldown recovery 测试，随迁移更新最终镜像。仅调用 tracking/episode restore 的 recovered-order 检查不得宣称覆盖完整启动 loader、crash-gap completion 和 hydration；后者须单独验收。这些是未来测试要求，本次未修改测试或程序。

#### 13.4.2 金融精度目标、差分与恢复验收

按文首已确认精度口径，P0 建立离线十进制目标并工程验证候选库，首个相关新层消费前通过，P4 全矩阵离线复验。未来实施验收使用 mock/脱敏 fixtures 做静态、动态全链路及恢复演练；真实历史原始 V1+权威订单逐条对账、精度迁移后候选/回退版本完整恢复只作为未来生产发布阻断项，不以 fixtures 代替。分别报告“原有效行为保持”“旧浮点误差受控修正”“历史冲突/恢复阻断”，不把旧 number 输出视作通用正确答案。不得用宽松 epsilon、显示舍入、文本改写或复制旧公式掩盖差异；非终止除法按 §4.4 的用途边界验证，不能以近似商取整或显示舍入代替精确交易判断；P0 不擅自选定业务量化/舍入政策。这些是未来验收要求，不表示此次已实现后端或新增测试。

| 范围 | 必须断言的目标 |
| --- | --- |
| 金融输入/契约 | SDK 高有效位值和合法配置文本直接进入中性 string/独立 Decimal；覆盖 price/cash/cost/amount/金融阈值及 query/push 两类输入，不经 Number/parseFloat。金额配置接受 `9999999999.999`，拒绝 `10000000000`、`1.2345` 和科学计数法；默认值及字段原有正数/零值规则同样验证。SDK/历史事实超过三位小数时仍保真，不误套配置限制。非法/缺失输入按所属原链路分类；事后 Decimal 转换不能修复此前 `0.1 + 0.2` 的误差，目标十进制加法必须为 `0.3`。 |
| 整数与数量 | 时间/版本/计数保留 number；数量允许 number 的边界证明整数性及 safe-int，聚合/递增结果也验证。非整数/超范围值不偷偷 floor/toNumber；保留 Decimal/文本或按原契约拒绝。字段级测试区分金额大数与不可安全表示的整数数量。 |
| 普通 BUY/SELL 与换标回补 | 金额 `7000`、价格 `0.07`、每手 `10000` 的新文本输入仍得 `100000`，不得为 `90000`；预算 `7499.999`、价格 `2.500`、每手 `1000` 必须得 `2000` 股，不能因近似商舍入而买 `3000` 股。精确整数商满足 §4.4 的名义预算不等式；整手边界/低于一手/小数价格、可卖裁剪和占用累计均正确。真实预算 → quantity policy → signal/command → adapter 不丢金融位数，合法整数数量投影不改结果。 |
| 金融比率、阈值与筛选 | 牛/熊距离的相等及两侧、买入价格/现金/市值上限、静态清仓、换标 SAFE/DANGER、候选成交额/接近度排序按精确等价计算、同一公式/单位及原严格或包含边界判断，不用近似商或显示舍入。当前价 `20070`、回收价 `20000` 的距离应等于 `0.35%`；当前价 `20069.99` 时距离为 `0.34995%`，牛证买入仍因低于 `0.35%` 被拒绝，不因显示为 `0.350%` 而放行。旧浮点临界差异按目标分类登记，不强求错误旧决策相同。 |
| 成本、累计金额与日损益 | 成交价×累计量、成本乘加、R1/R2、baseline 差额/分段均价/realizedPnL、盈利归零与亏损符号符合十进制目标；状态、返回值和后续计算不经金融 number 投影，不按金额显示两位或均价三位提前量化。分段金额 `1000`、数量 `3000` 的成本保持 `1000`，不能由三位均价 `0.333` 乘回数量得到 `999`；均价比较/排序使用金额与数量的精确依据。数量不变时合法权威金额修正仍生效。 |
| progress/baseline 比较与择新 | 数值比较不用字典序；数量依 safe-int/Decimal 契约，金融金额始终 Decimal。保留同订单 orderId/revision/数量/阶段与跨订单执行时间/revision/数量/阶段/orderId 排序、边界快照 TERMINAL 优先和同量择新。baseline 精确匹配与恢复后的财务状态一起验证，不保留旧金融 number 比较。 |
| V1 durable 规则 | 结构、字段、ID组成、严格文本语法、同ID/同payload去重及异payload失败保持；新文本从精确状态规范序列化，不经 number、不承诺等于旧投影文本。不同ID旧 JSONL逐条恢复，不折叠latest-only；拒绝`0.30`/指数文本，旧`.json`/legacy completion拒绝语义不放宽，读取不改写。 |
| 离线 fixtures 与未来历史恢复/回退 | 当前离线完成使用 mock/脱敏 fixtures 演练完整 loader/rebuild、progress/completion、买/卖 baseline、crash-gap、损益分段/冷却；该结果不声称真实历史逐条对账。未来生产发布前，须以原始 V1 历史日志及对应权威订单输入逐条对账，并分别演练精度迁移后候选版本和指定回退版本完整恢复。所有阶段均不得伪造新事实或借阶段更新吞掉冲突；真实权威金额修正与精度差异分开判定，不可证明时关门 fail-fast。 |
| 技术指标与非金融路径 | EMA/MACD/KDJ/RSI/ADX/MFI/PSY 的 number算法、三位投影、空值/NaN/Infinity/缺量等原处理保持；信号 Decimal比较及延迟验证原生number比较边界分别验证。金融 fact 的独立指标投影不回写财务值；timer、索引、计数无需Decimal。 |
| 金融显示 | 按文首已确认精度口径：账户差额/持仓估值/行情涨跌先按十进制计算，再直接定点 string；显示维持各字段既定展示位数并一次 half-even，验证正负/零/尾零及既有样例（`1.005→1.00`、`1.015→1.02`）；两位显示时 `1.0051→1.01`，不能先舍入为三位 `1.005` 再得到 `1.00`。输出除法直接从原始分子/分母按目标显示位数舍入，不回流财务计算或交易判断。支持范围内超过 number 有效位的输入仍显示正确；不调用 `toNumber().toFixed()`，不将补零显示文本写入 V1，指标 `toFixed` 可保留。 |

测试按职责镜像：独立算术/格式化在 `tests/utils/numeric/`，金融配置在 `tests/config/`，公式在对应 `tests/domain/{order,position,risk,seat}/`，指标在 `tests/domain/strategy/`，用例/恢复在 `tests/application/{accountPositionSnapshot,postTradeSettlement,orderExecution,orderTracking,seatSwitch,protectiveLiquidation,tradingDayRebuild}/`；SDK 基线/映射只在 `tests/infrastructure/longbridge/{trade,market}/`，显示输出在 `tests/infrastructure/display/`，日志 IO 在 `tests/infrastructure/persistence/mixedTradeLogRepository/`。只有真实跨 owner 场景放 `tests/integration/`，SDK fixture 不带入 domain/application。

复用旧基线 `tests/core/riskController/{warrantRiskChecker.business,dailyLossTracker.segment.business}.test.ts`、`tests/services/mixedTradeLogRepository/business.test.ts`、`tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` 及相关金额 revision/指标/显示检查；随 owner 闭合迁往镜像职责。只更新已登记浮点误差的旧期望，不放宽无关断言，不保留 forwarding test。

### 13.5 Seat/lifecycle

必须覆盖：

- seatVersion 变化使旧 activation 结果失效；寻标/换标版本与清理边沿保持，不重复 bump。
- LONG 明确外部激活失败不改 SHORT 当前 ACTIVE，不推进全局 settlement stale。
- 按 §9.3 保持运行期顺序；预检/日损拒绝无后续激活发布，订阅 pending/失败或身份失效不提前发布风险/ACTIVE。
- 旧 allOrders 与另一方向新成交交错不能抹掉已确认日损/订单；只变普通 commitRevision 不重拉订单、不重复 stale。
- API 已投影成交后同单相同已消费事实的 WS/query 晚到不重复数量/成本/日损，最终 R1/N1 正确且 terminal 资源正常收口；该重放不复活已消除 BUY、不再次扣减已消费 SELL，空结果保留消费证明。
- OPEN partial 未被订单投影消费时不虚标覆盖，同量终态仍按原规则首次投影；同量高 revision 金额修正依完整已消费输入更新口径，不虚构成交数量推进，过滤结果仍按原规则重算；受控基线与回放复用同一消费契约。主动 clear 的实际清理范围不因历史修订复活，后续新成交/未覆盖增量/首次终态不被吞掉，SELL 过滤合法变化及受控 rebuild 原基线语义保持。
- P3F 策略执行/加载闭合后，私有 timer/saved-emitter/失效/reset/destroy 只由原唯一实例推进；新 definition/config 布局及 `.ts/.js` 定位可运行，不残留旧字符串路径/错误邻接约束，不预加载未选中策略。
- ACTIVE 后永久订阅接棒、完整 await release、错误优先级保持；受控 rebuild/static 例外不放宽 runtime 门禁。
- 周期/距离换标 policy 独立正确；SWITCHING 内移仓回补顺序保持，已提交 WAIT 在时段关门后仍有暂停/取消 owner。
- 午夜清理不生成普通交易命令。
- TimeWakeup 可继续安排 open rebuild。
- 部分启动失败只释放已取得资源且每项一次。
- termination stop/drain 顺序保持。
- cleanup 某步失败仍执行后续步骤并汇总。

### 13.6 架构静态检查

边界测试放最终镜像职责路径，建议包括：

- `tests/architecture/longbridgeBoundary.test.ts`。
- `tests/architecture/snapshotWriterBoundary.test.ts`。
- `tests/architecture/numericBoundary.test.ts`（字段级金融契约/投影保护，不机械禁用整数或指标number）。
- `tests/app/lifecycle/lifecycleChecklist.test.ts`。
- `tests/app/lifecycle/lifecycleChecklist.wiring.test.ts`。
- `tests/architecture/finalDirectoryOwnership.test.ts`（生产 `src/{core,main,services}/` 不再有实现/forwarding facade）。

扫描范围迁移期间同时覆盖旧来源与新终态：旧来源按 §5.1 固定路径例外，目标层无例外；production `import`、`import type`、re-export/dynamic import 都扫描。P4.5 后唯一 SDK import 白名单是 `src/infrastructure/longbridge/{trade,market}/**` adapters；P6 还验证 app factory-only、runtime 实现单一位置、types 中性契约、无第二 snapshot/order/lifecycle owner。

数值保护须有正反例：金融mapper先toNumber、已迁移财务状态改回number、金融格式器回转number应失败；保真文本mapper、经验证的整数数量、时间/计数和既有指标number投影应通过。结合 §13.4.2 的真实值/链路检查，不能仅凭类型名或关键词扫描宣称金融精度通过。

---

## 14. 观测、日志与故障诊断

### 14.1 必须可区分的事件

```text
snapshot request started
snapshot response accepted
snapshot response discarded: stale generation
snapshot response discarded: stale epoch
snapshot commit revision
settlement stale version
settlement ready version
seat version invalidated
order submit unknown fatal
order terminal confirmed
liquidation completion committed
trading day rebuilt
```

### 14.2 建议统一字段

```text
operation
source
purpose
symbol
seatDirection
seatVersion
dayEpoch
snapshotGeneration
snapshotCommitRevision
accountRevision
positionRevision
pairedCommitRevision
settlementVersion
orderId
requestAttempted
```

字段只用于诊断、审计和测试，不自动改变交易策略。结构化日志若附带金融值，使用保真的十进制字符串；人类可读字段使用显示定点字符串，不直接记录库对象、回转number或把显示文本作为事实比较依据。

### 14.3 必须监控的指标

- snapshot response discard count。
- snapshot refresh duration。
- snapshot pending wait duration。
- settlement readiness duration。
- queue depth / oldest task age。
- seat activation duration。
- unknown submit count。
- cancel acknowledgement-to-terminal duration。
- open rebuild retry count。
- snapshot commit revision 与 settlement ready version 的推进滞后。

### 14.4 故障排查顺序

出现交易异常时按以下顺序定位：

1. 确认当前 `dayEpoch` 和 lifecycle gate。
2. 确认 seatVersion、当前 symbol 和 seat status。
3. 确认 command purpose、已知 orderId；submit UNKNOWN 检查原错误与 fatal/cleanup 记录，不猜测订单身份。
4. 确认 snapshot generation/commit revision 是否被丢弃。
5. 确认 settlementVersion 是否 stale、是否 ready。
6. 确认订单事实是否已达权威终态。
7. 最后检查行情、价格和数量裁剪，并区分十进制源文本/计算值、显示舍入值及合法整数/指标投影；历史金额冲突检查 revision/阶段和 §15 对账证据，不以显示文本判定事实相等。

---

## 15. 发布、回退与数据安全

本节定义未来生产发布/回退的独立安全门禁，不属于本轮离线实施验收的替代项。本轮须通过离线静态、动态全链路及 mock/脱敏 fixtures 恢复演练，但不发布、不打开交易门禁、不连接实盘；当前不声称已完成真实历史逐条对账或候选/回退版本完整恢复。真实历史原始 V1 + 权威订单逐条对账、以及精度迁移后候选版本和指定回退版本的完整恢复，必须在未来生产发布前完成；mock/脱敏 fixtures 不能替代这些生产门禁。

### 15.1 发布前检查

未来实际生产发布前必须：

1. 使用旧版本正常终止，完成 drain 和 cleanup。
2. 确认 durable trade log、订单事实和保护性 progress 可被新版本读取。
3. 运行完整测试、构建和类型检查。
4. 核对无遗留旧 snapshot writer、旧 SDK 业务 import、旧 façade。
5. 核对日志能够输出 epoch/generation/revision/seatVersion/settlementVersion。
6. 确认订单恢复先订阅并 BOOTSTRAPPING 缓冲，再加载事实、恢复归属和占用、按现有规则合并回放/对账，最后进入 ACTIVE。
7. 冻结原始旧 V1 日志与对应权威订单输入，完成 §13.4.2 的真实历史逐条对账和完整启动/开盘重建演练，覆盖买/卖 baseline、损益分段、episode/冷却；V1 可解析不代表新精度恢复必然成立。该项是未来生产发布阻断，不是本轮离线完成项，当前未验证。
8. 记录金融精度受控差异、仍受支持的输入范围及所有恢复阻断；对无法证明的旧事实保持关门并沿既有人工对账流程处理，不自动修写日志。确认时间/revision及 number 数量满足各自整数契约。
9. 指定回退版本对“精度迁移后候选版本实际生成的 durable 事实＋对应券商事实”通过完整恢复与金融状态核验；未证明前不承诺生产回退可用，不发布。该完整演练也不是可由 fixtures 替代的离线完成证据。

### 15.2 运行中异常处理

出现以下情况时，新版本必须采用 fail-safe 行为：

- canonical snapshot 内部契约错误：立即上报 fatal，关闭交易放行，不将其当作外部失败重试。
- 双读一半失败：不提交任何不完整 paired snapshot，交给对应 owner 重试。
- 未知 submit：直接上报 fatal、关闭交易放行并执行既有终止清理，不重复提交，不新增 unresolved/overlay 持久状态或自动恢复分支。
- cancel acknowledged：继续等待订单事实，不直接标记终态。
- seatVersion 过期：丢弃结果，不改变当前席位。
- 保护性 completion 持久化失败：由唯一 `PostTradeSettlementWorkflow` 不推进冷却、日损益边界和 episode 完成；protective/tracking 不另行判定或提交。
- 内部金融精度/范围/状态契约错误：fail-fast，禁止转number、静默舍入或降级继续交易；已明确允许丢弃/重试的外部缺失输入仍由原 owner 处理，指标无效值规则不改变。
- 历史amount/baseline与新精确事实冲突：只由删除number投影造成的差异不是新的权威修正，不能借OPEN→TERMINAL、伪造revision/ID或容差吞掉；阶段转换或“金额更精确”本身不是修正证据。正常可证明的权威修正仍按原协议处理，但不豁免同ID异payload冲突、baseline匹配和单调性校验。无法区分或无法精确恢复时fail-fast并关门，不推进损益边界/冷却/episode/ready，不改历史payload。
- lifecycle cleanup 单步失败：继续后续清理并汇总失败；保留首个 fatal。

### 15.3 回退方式

回退只针对代码版本，不回滚已经发生的券商动作、订单事实、成交日志或持久化完成事实。以下是未来生产发布前必须完成的回退安全演练，不属于本轮离线实施验收；本轮不声称已演练。回退目标必须具备保真处理新金融状态的能力，且必须对精度迁移后候选版本生成的数据及对应券商事实完成完整恢复验证；不得默认退到精度改造前的 number 实现。保留 V1 结构不能弥补旧实现的数值能力不足，生产发布前必须准备并验证可用回退目标。

回退步骤：

1. 关闭交易门禁。
2. 等待当前版本按既有终止流程 drain。
3. 保留所有新版本产生的 durable facts。
4. 使用发布前已通过验证的指定回退版本启动完整恢复，重新读取订单/持仓事实；不是任选上一提交。
5. 核对该版本可恢复新精度日志的progress/completion、买/卖baseline、金融状态、席位及持仓归属；“能解析V1”不能代替这些证明。
6. 只有全部恢复事实、金融状态及归属可证明时才重新开门；否则保持关门并对账，不以回转number、删除新事实或改写日志强行回退。

上述步骤仅为正常代码版本回退流程，不是 submit UNKNOWN 的自动恢复方案，也不能借版本回退绕过 fatal。UNKNOWN 自动恢复不在本次范围。

不设计运行中热切换，也不把新旧版本的内存 revision 互相解释为同一序列。

### 15.4 持久化格式要求

本次金融精度升级继续使用 V1 durable schema：字段、schemaVersion、ID组成、严格十进制文本校验、同ID去重/冲突检测与逐条恢复规则保持；不增精度补偿字段、双写记录或兼容读取层。新金额/数量文本直接从精确状态按V1规范生成，不经过number，可能不同于旧投影结果，不能承诺字节等价。历史payload/ID原样保留，不补造revision；仍拒绝`0.30`、指数文本及现有不允许的旧记录。显示定点补零与durable规范序列化分开。

精度升级不能恢复旧日志中已经丢失的位数。必须将这些历史值与对应权威订单输入做 §15.1 完整对账，按 §15.2 保留不可证明事实的fail-fast；未通过不得发布或开门，不通过读取时归一化、重新生成旧记录等方式绕过。

submit UNKNOWN 仍直接 fatal，不新增 unresolved intent、overlay 或其字段；其自动接管/恢复不在本次数值升级范围。如未来实际需要改变 schema 或 UNKNOWN 恢复协议，须另行明确批准，不作为本计划的隐式fallback。

---

## 16. 风险清单与控制措施

| 风险 | 影响 | 控制措施 | 阻断条件 |
| --- | --- | --- | --- |
| 旧 writer 遗留 | 旧数据覆盖新事实 | P1 一次迁移全部 writer；架构扫描白名单归零 | 任一生产直接写入存在 |
| freshness 被降级为 snapshot commit | SELL/风险提前放行 | P2 receipt 和 readiness 测试；保留 `waitForFresh` 语义 | raw commit 可直接 resolve ready |
| submit UNKNOWN 被当作普通外部失败重评估 | 重复下单/事实不一致 | 普通交易和末日入口均直接 fatal；删除末日 UNKNOWN 特殊刷新分支 | UNKNOWN 自动重提或继续重评估 |
| 末日 accepted 被当成 flat | 重复清仓/错误订阅/错误风险 | 复用既有订单追踪防重，按权威持仓对账；保留 account invalidation | accepted 后 position 被本地过滤 |
| 过期内部错误被吞 | 安全故障静默 | 先错误分类再做 supersession | 旧 generation 内部错误不 fatal |
| 席位/订单旧结果发布 | 旧输入覆盖已确认日损/订单或交易到错误标的 | allOrders 发读前 epoch/generation/席位 token；派生发布前校验；runtime/rebuild 独立验收 | 旧订单输入能写共享派生或旧身份能推进 ACTIVE |
| API/在线结算重复经济投影 | 重复 BUY、重复 SELL 抵扣或错误 R1/N1 | P1.7 同一 broker orderId/实际消费覆盖；列表与覆盖同段提交；含已消除/空结果/OPEN partial/金额修正及终态收尾交错验收 | 仅凭 generation/receipt/日损去重宣告安全，或晚到同单事实再次计量、去重吞掉合法修正/资源收尾 |
| 方向互相影响 | LONG/SHORT 交易被误停或共享事实被覆盖 | activation 状态/重试按方向隔离；共享事实独立版本校验 | 单方向明确外部激活失败修改另一方向状态或旧订单响应覆盖其事实 |
| 订单 adapter 改变 retry 语义 | 重复下单/漏处理 | 逐操作结果 union；保留 602013 和 WAIT_WS_ONLY | UNKNOWN 自动重提 |
| SDK 类型残留/阶段扫描误阻断 | 继续扩大传播或妨碍安全纵切 | P0固定旧文件例外；P1 account/position 最小 facts/mapper，P2 readiness contract 切片；每闭合阶段删例外 | 任一新 domain/application SDK依赖，或P4.5后infra/longbridge外有SDK import |
| app factory/runtime implementation 双份 | 双队列/双timer或cleanup顺序漂移 | app只装配；具名program在runtime；day协调runtime、rebuild use case在application、一个cleanup executor | app/runtime存在实际业务scheduler/queue/listener或第二cleanup executor |
| 旧 core/main/services 残留或错把P6当首定架构 | 最终仍混合职责/forwarding facade | P0冻结终态/逐源映射，P1–P5闭合迁移，P6只扫残留并物理验收 | P6后任一旧根目录有生产实现/兼容入口 |
| 测试只覆盖 happy path | 竞态/恢复故障进入生产 | deferred、乱序、partial failure、UNKNOWN 矩阵 | 关键失败边界无可运行测试 |
| 远端一致性被过度承诺 | 错误判断成交包含性 | 明确本地 revision 边界 | 用时间/source priority 证明远端包含成交 |
| warrant查询与筛选/失败策略混放 | SDK泄漏、重复缓存/重试或筛选规则绑厂商 | infrastructure market查询/cache；domain/seat纯筛选；application/autoSearch失败策略 | 新 domain/application imports Longbridge，或 autoSearch重试有第二owner |
| cooldown错误列为持久化 | 误把 Map冷却规则与durable log混同 | `domain/liquidation/cooldown`；仅 mixedTradeLogRepository进persistence | 文档/实现把 cooldown Map称repository/persistence owner |
| 只换类型/格式器仍保留金融number | 输入或状态已丢精度，财务/阈值继续错误 | §4.4字段纵切与§13.4.2真实链路验证；全部生产者/消费者同步 | 金融mapper先toNumber、财务状态number或显示回转number |
| Decimal默认精度/舍入被误认为无限精确 | 乘加丢位、临界信号/取整或显示改变 | P0按文首已确认口径工程验证库版本/输入范围/内部容量；不另定业务量化/舍入政策，指标与整数单独保留 | 未按已确认口径完成工程验证即迁移、静默溢出/丢位、显示舍入参与决策 |
| 历史精度冲突被当权威修正 | 旧baseline/分段/冷却错误恢复或ID冲突被绕过 | 旧日志＋权威输入对账，完整loader/crash-gap验收，不改payload/revision | 以容差/阶段转换/改写旧文本消解不可证明冲突 |
| V1可读被当代码回退安全 | 旧版本投影number后无法恢复新baseline | 指定回退版本完整恢复新日志及金融状态，失败保持关门 | 未演练却承诺回退，或删新事实/改日志强行开门 |

---

## 17. 最终验收清单

### 17.1 事实一致性

- [ ] canonical account/position 唯一 owner 是 `application/accountPositionSnapshot`；coordinator/pump/generation/private store 不在 domain，也无第二 store。
- [ ] P1 已闭合全部 writer 与 reader；LastState snapshot mirror 和 `positionCache.update()` 直接写入为零。
- [ ] 旧 epoch 结果不能提交。
- [ ] 旧 generation 结果不能覆盖新事实。
- [ ] 双读不会提交成功的一半。
- [ ] `commitRevision` 只在合法 commit 后递增。
- [ ] account/position/paired revision 分开表达。
- [ ] 本地 projection 不冒充 broker fact。
- [ ] API 重建与在线结算共享订单经济投影消费基线，列表/实际覆盖同段提交；覆盖不是全部 raw 输入或日损去重结果，主动 clear 保留当时实际清理范围及消费证明，历史修订不复活该部分，不吞新成交/未覆盖增量/首次终态；SELL 过滤合法变化及受控 rebuild 基线语义保持，不新增第二账/durable 格式。
- [ ] submit UNKNOWN 直接 fatal，不重提，不伪造订单或持仓事实。

### 17.2 Settlement readiness

- [ ] `waitForFresh()` 仍表示 post-trade business ready。
- [ ] snapshot commit 不直接 resolve readiness。
- [ ] protective 最终完成判定、同步 durable append、daily-loss/cooldown/episode 内存提交及 ready 只由 `PostTradeSettlementWorkflow` 拥有；tracking 提供事实，domain 纯规则不形成第二判定/提交者。
- [ ] completion persistence 成功后才推进 cooldown/daily loss/episode。
- [ ] 新 settlement 使旧 token 失效。
- [ ] 普通 seat commit 不无故制造 settlement stale。
- [ ] 不存在 snapshot owner self-await。

### 17.3 业务安全

- [ ] 普通 BUY、SELL、换标回补、保护性、静态距回收价、末日 policy 仍分离。
- [ ] BUY 临时账户/持仓读取未被错误纳入 canonical settlement。
- [ ] SELL 仍在 readiness 和最终 position revision 复核后执行。
- [ ] UNKNOWN submit 直接 fatal、不重提，不新增 UNKNOWN 查询接管或重启恢复协议。
- [ ] cancel acknowledged 不等于 terminal。
- [ ] pending-sell 保留旧 protective 身份，非 protective 新量不扩量 `REPLACE` protective 旧单；可信终态结算后按新鲜可卖量重新提交，§13.4.1 跨模块场景通过。
- [ ] 静态成交不推进 protective progress/episode；旧真实 episode 由 settlement owner 按最后保护性执行时间独占判定/完成，并保留原 durable commit / cooldown 计数顺序。
- [ ] 恢复 protective tracking 与精确 episode 区分，空/非空关联买单不替代目的隔离；完整 loader / hydration 单独验收。
- [ ] 累计成交和金额 revision 语义不变。
- [ ] P1.7 的 API → 同单 WS/query、已消除 BUY、已消费 SELL、空结果、OPEN partial → 同量终态及同量金额修正回归通过；经济去重不虚构成交数量推进、不跳过 pending/hold/routing/tracking 收尾，最终日损与 R1/N1 正确。
- [ ] P0.4 / §13.4.2 金融目标与差分通过：输入/状态/运算/显示无未授权number投影，买量、距离、成本/盈亏、日损益与progress/baseline符合十进制目标，旧浮点修正明确登记。
- [ ] 安全整数数量/时间/版本/计数契约通过，技术指标算法/投影/信号与延迟验证语义保持，未一刀切全量Decimal。
- [ ] V1 结构/文本校验/ID/冲突规则和择新顺序保持；离线 mock/脱敏 fixtures 恢复演练通过，新数值不要求等于旧 number 文本，历史冲突不伪装权威修正。
- [ ] 金融显示直接定点字符串，显示维持既有位数并 half-even，不影响交易判断，补零显示文本不写 durable。
- [ ] 未来生产发布阻断：真实原始 V1 + 权威订单逐条对账，以及精度迁移后候选/指定回退版本完整恢复演练；当前未验证，fixtures 不替代，不计作本轮离线完成。
- [ ] 运行期 ACTIVE 只在 §9.3 完整 activation barrier 后出现；受控 rebuild/static bootstrap 例外独立审计，完整基线完成前不得打开全局交易门禁。
- [ ] 末日窗口和跨日门禁不提前放行。
- [ ] 已知成交事实结算、generation 同步失效、settlement stale/refresh-need 登记位于同一同步段；保护性 progress 持久化失败不提前发布成交事实。
- [ ] r10/r11 compare-and-publish 覆盖 subscription/R1/N1/completion，旧派生不写；`PostTradeSettlementWorkflow` 独占最终 completion 判定，token/order/seat 校验→同步 durable append→daily-loss/cooldown/episode 内存提交无 await；tracking 仅提供事实。
- [ ] doomsday submit UNKNOWN 直接 fatal、不自动重提，旧特殊刷新/重评估分支已删除；已确认订单沿既有事实链路防重且不使 positions flat；原条件下 account invalidation 同步推进 generation，旧 paired read 不能恢复 valid，失效本身不增加 settlementVersion/专属重评估，后续当前代次 paired commit 才恢复有效性。

### 17.4 可维护性与边界

- [ ] 最终顶层结构为 `app/domain/application/runtime/infrastructure/config/constants/types/utils`。
- [ ] `src/core/`、`src/main/`、`src/services/` 无生产实现、混合职责、旧 façade、转发层或兼容目录。
- [ ] `app/runtime/create*.ts` 仅 factory/assembly；独立queue/listener/唤醒与stop-drain归具名runtime，底层clock/timer适配归infrastructure，业务内聚pump不另拆owner；app仅一个cleanup executor。
- [ ] domain 可封装状态/规则但无IO/调度；应用用例唯一拥有失败策略/完成条件。
- [ ] P3F 已闭合现存策略私有执行至 `runtime/strategy/`，未因名称把纯指标 runtime 搬走；definition/config 动态加载布局与路径校验同步迁移，只创建选中策略一个实例，无新增 runner/registry 或旧路径回退。
- [ ] domain/application 新增代码无 Longbridge import；P4.5 后 SDK imports 仅在 `infrastructure/longbridge/{trade,market}`。
- [ ] SDK mapping 只有 adapter 负责；独立Decimal不透传SDK类型，领域公式/财务状态与恢复编排不下沉mapper。
- [ ] 新 runtime 在静态 lifecycle checklist 中声明。
- [ ] checklist 不取代现有 stop/drain 执行器。
- [ ] 无全局 service locator。
- [ ] 无旧 facade、旧名委托链、无关 re-export。
- [ ] 宽 `Trader`/`LastState` 契约已按职责收窄。

### 17.5 验证与交付

以下区分离线实施完成与未来生产发布门禁。本轮只要求离线门槛，不发布、不开门、不连接实盘，也不声称未来发布门禁已验证。

**离线实施完成门槛：**静态/动态全链路验收及 mock/脱敏 fixtures 恢复演练必须通过；fixtures 不替代真实历史、候选或回退版本的生产发布验证。

- [ ] 按文首已确认精度口径完成离线工程验证；P0 不自行决定业务量化/舍入政策。
- [ ] `bun format` 通过。
- [ ] `bun lint` 通过。
- [ ] `bun type-check` 通过。
- [ ] `bun test` 通过。
- [ ] `bun build` 通过。
- [ ] 相关架构测试通过，`tests/` 按最终 `src/` 职责镜像；基线旧测试路径均已迁移，新增测试没有旧路径。
- [ ] 启动恢复、订单恢复、保护性清仓、末日清仓、autoSearch、静态清仓、普通BUY/SELL、换标、跨日和终止集成的离线静态/动态全链路测试通过。
- [ ] mock/脱敏 fixtures 覆盖恢复链路并演练通过。

**未来生产发布阻断（不属于本轮离线实施完成，当前未验证）：**

- [ ] 生产发布前完成旧版本 drain、原始 V1 日志与权威订单事实逐条精度对账、完整候选版本恢复及指定回退版本演练，无未解决的精度恢复冲突；不得以 fixtures 替代。
- [ ] 按文首已确认精度口径记录实际库版本/输入范围/内部容量验证、字段级数值边界、受控误差修正、回退步骤和未解决风险；未证明安全时不发布/不开门。

---

## 18. 实施时的首批操作顺序

按以下顺序开始实际编码，不跳过 P0，不把旧来源路径当作终态，也不在P1完成前交付半套 writer owner：

1. 记录工作树与旧基线；冻结第4.1.2映射、§5.1例外，增设writer/SDK/lifecycle探针。按用户已确认的文首精度口径完成P0.4字段分类、独立十进制目标/差分和库版本/范围/内部计算容量工程验证，并用 mock/脱敏 fixtures 做离线恢复演练。不得自行锁定业务量化/舍入政策；真实历史对账与候选/回退完整恢复保留为未来发布阻断，旧转换位置仅用于定位删除点。
2. P1定义 `application/accountPositionSnapshot` owner 与 `src/types/accountPosition.ts` 保真facts/read port，提前完成trade/所需quote mapper、所有金融reader/状态/显示及相依切片；新层消费前闭合，不回转旧number接口、不等P4。
3. 由 `app/runtime/createPostGateRuntime` 工厂仅装配 snapshot owner；一次性闭合全部旧来源 writer/readers、同步失效/epoch、P1.7 早期订单栅栏及跨入口经济投影消费基线、r10/r11派生防旧写，并将末日 submit UNKNOWN 统一为直接 fatal、不重提；保留已接受订单路径的 account invalidation，移除 LastState 写镜像。
4. P2 基于P1既有安全协议，将 `createPostTradeConsistencyRuntime` 的业务 owner和`refreshGate`迁至`application/postTradeSettlement`，把共享receipt放`src/types`；先切断遗留SDK协作者类型，不重复实现P1协议、不强拆completion无await事务。
5. P3A只验收P2迁移/旧入口移除；再依次闭合P3B protective、P3C activation、P3D switch、P3E doomsday、P3F ordinary BUY/SELL、autoSearch、static liquidation与真实独立riskRefresh；P3F 同步闭合 §9.6 的旧单身份与共享合单隔离，提前完成所需 P4 最小契约/执行/恢复切片并运行 §13.4.1 验收，不只迁移静态入口。
6. P4按submit/replace/cancel、order facts/query/push/recovery、剩余account/position/market read和金融显示收口；P4.4仅补齐P1既有契约/mapper，不首次建模或首次补精度；SDK仅infra/longbridge，§13.4.2全矩阵复验。
7. P5登记静态lifecycle checklist；验证app factory、runtime日切协调、application/tradingDayRebuild及唯一cleanup executor分工，并保持所有具名顺序。
8. P6按既定表清理宽契约、无用代码、所有 `src/{core,main,services}/` 生产残留、旧facade/转发层/测试旧路径；对应实施时才定向更新README、AGENTS、源码旧路径文档，不现在全局批量改写。
9. 完成各阶段镜像/全量测试、构建、架构扫描、离线静态/动态全链路及 mock/脱敏 fixtures 恢复演练；本轮不发布、不开门、不连接实盘。真实历史逐条对账及候选/指定回退版本完整恢复作为未来生产发布阻断，未通过不得发布/开门；不在迁移中引入热切换。

---

## 19. 计划结论

终态架构以以下固定职责边界为验收对象，而非把迁移来源目录当成目标：

```text
src/app                 factory / composition / startup / 唯一 cleanup
src/domain              状态、事实模型、纯业务规则和迁移
src/application         唯一 use case owner、失败策略、完成条件
src/runtime             具名 queue / timer / listener / event routing / stop-drain
src/infrastructure      Longbridge、persistence、time、logger、display adapters
src/config/constants/types/utils
```

其中 `application/accountPositionSnapshot` 独占 network request coordination、generation、private store、internal pump；`application/postTradeSettlement` 独占 readiness，且与 snapshot commit 分离，并独占 protective 最终完成判定、同步 durable append、daily-loss/cooldown/episode 内存提交；protective 只触发/识别目的/执行前门禁/执行，tracking 提供事实、domain 纯规则不形成第二判定或提交者。各交易目的有各自既有业务 owner，不创建第二订单账或 wrapper；SDK 最终只留 `infrastructure/longbridge/{trade,market}`。P1一次完成全部 snapshot writers/readers 和安全失效协议，submit UNKNOWN 统一为直接 fatal、不重提；P2正式收口 settlement owner，P3按职责迁业务，P4收余下adapter，P5闭合重建用例并验证生命周期单一编排，P6仅清扫旧目录/契约残留。完成后 `src/{core,main,services}/` 不留生产实现、混合职责或转发/兼容层。

金融精度升级纳入上述阶段，按文首已确认解释口径及 §4.4 的补充边界实施：金额配置最多 10 位整数/3 位小数，SDK 与历史金融事实保真；金融结果至少准确到小数点后三位，基础加减乘及比较精确，中间状态不统一量化到三位。整手买量直接求精确整数商，均价保留金额/数量依据，比率使用精确等价比较；显示按既定位数一次 half-even，V1 历史文本/schema 保真不改写。P0 验证实际库版本、精确接口及支持范围/计算容量，不以固定 80 位承诺无限范围的精度，不另定业务量化/舍入政策。安全整数与技术指标保留 number。离线完成须通过静态/动态全链路及 mock/脱敏 fixtures 恢复演练，不发布/不开门/不连接实盘。真实历史 V1+权威订单逐条对账及精度迁移后候选/回退版本完整恢复是未来生产发布阻断项，当前未验证，fixtures 不替代；V1 schema/ID规则保持不等于新数值字节等价或旧版本自动可恢复。

`backtest-kit@4c5f3c668798a594dcfe4e004466bdc55680f104` 只借鉴架构原则，不复制全局容器/registry。此计划不授权全量数字Decimal化、技术指标算法升级、多进程一致性、统一 reservation/交易流程、UNKNOWN自动重试/恢复、统一 EventBus、动态生命周期 registry 或 backtest-kit 迁移。超出本计划的业务政策或持久化schema变更须另行明确批准。
