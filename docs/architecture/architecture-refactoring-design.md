# 当前交易系统架构重构设计方案

> 本文是面向当前项目的架构重构设计，不是 `backtest-kit` 功能迁移方案，也不是通用量化平台设计。
>
> 目标是：除本文明确列出的事实一致性修复及 §6.6 的 submit UNKNOWN 失败策略收敛外，保持现有港股日内交易业务语义、订单事实和生命周期安全约束，降低跨运行时共享状态、Longbridge SDK 渗透、跨目录业务 owner 和生命周期多点维护造成的耦合，提升未来增加策略、执行后端、运行时能力和回放测试时的可扩展性。
>
> 设计基线：当前工作区 `HEAD=a2f0ca972695e7cc1a7a21555bc87d46df98ce4d`，结合 `docs/architecture/architecture-assessment.md`、当前源码调用链和 `backtest-kit@4c5f3c668798a594dcfe4e004466bdc55680f104` 的架构研究结果。
>
> 本文仅修订设计文档，不表示生产代码已经完成重构或修复。§7.2.1 明确登记共享卖单跨 protective 扩量的受控行为修正；不能以“保持现有合单行为”为由保留该已确认缺口。
>
> **运行边界：当前程序保持单实例、单进程运行。** 本方案只处理一个进程内的异步并发、乱序返回、队列协作和重启恢复，不设计多进程并行、分布式锁、跨进程 leader election、跨进程幂等协调或 Redis/Mongo 作为运行时一致性组件。若未来改变为多进程部署，必须另行设计进程间 owner、租约、锁、命令幂等和持久化一致性，不能把本文的进程内 revision 直接扩展解释为分布式协议。

---

## 1. 设计结论

### 1.1 总体目标

当前项目不需要引入一个新的“大框架”，而需要完成四个边界重构：

1. **把账户/持仓事实的提交权从多个运行时收口到一个 canonical snapshot owner。**
2. **把成交后业务就绪与原始快照提交分开，继续保持卖出和风险链路的安全门禁。**
3. **把交易业务从 Longbridge SDK 类型和上下文中逐步隔离。**
4. **把保护性清仓、席位激活/换标和生命周期从跨目录隐式协作改造成有明确 owner 的 application workflow。**

目标不是把所有代码移动到新目录，也不是为未来可能的多进程或多券商场景预建平台，而是让每个关键事实、命令、工作流和运行时都有明确的：

- owner；
- 输入契约；
- 可修改状态；
- 完成条件；
- 失败语义；
- 生命周期归属；
- 可验证的版本边界。

### 1.2 不变的业务安全约束

重构不得改变以下已有业务语义：

- 交易事件仍由行情、订单变化和系统时间分别推进。
- 普通行情仍保持 confirmed candle / active candle 的时间和替换语义。
- 普通信号、延迟验证、买入、卖出、保护性清仓、末日清仓仍是不同业务路径。
- 普通 BUY、换标回补 BUY 不强行合并为同一风控集合。
- 下单未知结果不自动当作安全失败重试。
- 撤单请求被接受不等于订单取得终态。
- 保护性清仓完成必须以权威持仓、待成交保护性订单和持久化完成事实共同确认。
- 席位必须经过 `ACTIVATING` 全部准入步骤才可进入 `ACTIVE`。
- 午休、开盘保护、末日接管、跨日清理和开盘重建继续拥有不同门禁。
- 外部暂时性失败与内部一致性/契约错误继续分别处理。
- 系统停止交易时，系统级时间唤醒仍可继续推进交易日判断和恢复重建。

### 1.3 最终推荐形态

```text
                         +-----------------------+
                         |       app/composition  |
                         |  依赖组装、策略选择、  |
                         |  runtime/lifecycle注册 |
                         +-----------+-----------+
                                     |
               +---------------------+---------------------+
               |                                           |
     +---------v---------+                         +---------v---------+
     | application       |                         | runtime           |
     | 业务用例 workflow  |                         | 事件、队列、唤醒、  |
     | 命令、门禁、完成    |                         | stop/drain         |
     +---------+---------+                         +---------+---------+
               |                                             |
     +---------v---------+                         +-----------v-------+
     | domain/contracts  |<------------------------| fact stores/ports  |
     | 业务模型、状态规则  |                         | 事实提交与查询边界  |
     +---------+---------+                         +-----------+-------+
               |                                             |
               +---------------------+-----------------------+
                                     |
                         +-----------v-----------+
                         | infrastructure        |
                         | Longbridge、持久化、    |
                         | 系统 clock/scheduler  |
                         +-----------------------+
```

这不是要求立即建立完整的 Clean Architecture。它是目标依赖方向：

```text
composition -> application/runtime -> contracts/domain -> ports
infrastructure -> implements ports
```

当前 `core`、`main`、`services` 可以渐进迁移，不需要一次性重命名或搬迁全部文件。

---

## 2. 当前全链路基线

### 2.1 启动链路

当前启动主路径由 `src/app/runApp.ts` 负责：

```text
选择策略
  -> pre-gate runtime
  -> post-gate runtime / LastState / Trader
  -> startup snapshot
  -> 标的运行时验证
  -> trading-day rebuild
  -> 创建业务与异步 runtime
  -> 成功重建后按顺序启动 runtime
  -> 启动 TimeWakeupRuntime
  -> 等待 termination
```

关键事实：

- `runApp` 已经是有效的 composition root，不应被新的通用框架替换。
- `createPostGateRuntime` 通过单次绑定解决 `Trader`、`PostTradeConsistencyRuntime`、`QuoteSubscriptionRuntime` 和 `MonitorContext` 的构造环。
- 当前晚绑定有 fail-fast 和 single-assignment 保护，但完整协作关系需要跨多个工厂阅读。
- 初始快照外部失败会保持交易关闭并转入后续生命周期重建；内部错误则终止。

### 2.2 行情与策略链路

```text
MarketDataClient
  -> BusinessEventProgram
  -> confirmed/active candle 合并
  -> 策略指标与延迟验证
  -> 普通交易意图
  -> buy/sell task queue
```

当前正确边界：

- `TradingSignalStrategy` 不持有 Trader 或 Broker 能力。
- 同一监控标的采用 single-flight/latest-only。
- 活动柱可替换，确认柱不倒退，乱序旧事件忽略。
- 策略只产出普通交易意图；标的归属、数量、委托类型和最终授权属于下游。

这一部分不需要按照 `backtest-kit` 的 `ClientStrategy` 合并。相反，应保留策略隔离，并将上下文进一步收窄为只读观察快照。

### 2.3 普通 BUY 链路

```text
strategy
  -> BuyProcessor
  -> 轻检查、交易频率、冷却、轮证风险、浮亏预筛
  -> 实时账户/持仓临时读取
  -> 现金/持仓上限
  -> Trader.executeSignals
  -> submitFlow 最终授权、最新行情、手数和数量
  -> Longbridge
```

该路径的账户/持仓读取是**本次风控的临时输入**，不是 canonical shared snapshot 的写入。重构时不能为了统一读模型而把 BUY 临时读写入 `LastState` 或推进成交后 freshness。

### 2.4 普通 SELL 链路

```text
SellProcessor
  -> 等待最近成交后的业务 freshness
  -> 读取 position facts 与执行行情
  -> 智能平仓选单
  -> pending-sell 占用协调
  -> Trader.executeSignals
  -> 撤单/改单/重算/补单
  -> OrderMonitor 依据权威事实推进
```

SELL 的 freshness gate 不能在“原始 positions API 返回”时提前完成。它当前还要求保护性清仓完成判断、R1/N1 刷新和相关后置业务按既有规则落定。

### 2.5 订单事实链路

```text
Longbridge push / order query
  -> order fact merge
  -> OrderMonitor route
  -> settlement
  -> order recorder / daily loss / pending-sell occupancy
  -> post-trade refresh need
  -> snapshot commit
  -> business readiness
```

必须保留：

- 累计成交量单调；累计数量不变时允许更高权威 revision 修正成交金额。
- 撤单 accepted 与 terminal 分开。
- 未知 submit 不普通重试。
- `orderId` 已取得但本地同步失败时，不重复提交同一意图。
- 保护性成交 progress 先持久化，再推进权威日损益事实。

### 2.6 席位激活与换标链路

```text
寻标/周期/距离触发
  -> 更新 seat identity/version
  -> SEARCHING 或 SWITCHING
  -> 撤买单/卖旧标/等待空仓
  -> 绑定新标
  -> ACTIVATING
  -> 行情准入
  -> 订单事实校验
  -> 订单归属重建
  -> 日内亏损与风险刷新
  -> 账户/持仓刷新
  -> 订阅协调
  -> ACTIVE
```

席位不是一个 symbol 参数，而是具有身份、方向和生命周期的业务聚合。`backtest-kit` 的 Exchange/Strategy connection 只能启发实例装配，不能替代 seat identity 和 activation barrier。

### 2.7 跨日与终止链路

当前有三类不同生命周期动作：

```text
正常启动
午夜清理 -> 开盘重建
进程终止 -> 快速关门 -> stop/drain -> teardown
```

`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` 的顺序是业务安全顺序，不应被简单改成统一 `stopAll()`。

---

## 3. 需要解决的根因

### 3.1 共享持仓事实存在多个 canonical writer

当前确认的直接写入点：

| 路径 | 文件 | 语义 |
| --- | --- | --- |
| 启动/重建 | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts` | 成对读取账户和持仓后提交初始快照 |
| 席位刷新 | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts` | 激活/换标期间的局部刷新 |
| 成交后刷新 | `src/app/runtime/createPostTradeConsistencyRuntime.ts` | settlement refresh 与 post-trade business |
| 时间唤醒 | `src/main/timeWakeupEvaluationProgram/index.ts` | 末日未知提交后的持仓重新读取 |
| 末日保护 | `src/core/doomsdayProtection/index.ts` | 提交后对本地缓存做乐观 filter |
| 午夜清理 | `src/main/lifecycle/cacheDomains/globalStateDomain.ts` | 日切清空 |

问题不是“有多个读取者”，而是多个模块同时有权写：

```text
lastState.cachedPositions = ...
lastState.positionCache.update(...)
```

其中 `createRefreshGate` 只协调 `PostTradeConsistencyRuntime` 自身，不覆盖席位刷新和时间唤醒。

### 3.2 freshness 与事实版本不是同一个概念

当前 `waitForFresh()` 的语义是：

```text
settlement staleVersion 已推进的刷新批次完成
```

它不是：

```text
所有 LastState writer 都已按时间顺序提交
```

也不是：

```text
券商已经保证返回结果包含某个成交
```

如果重构时把它简单改成“snapshot commit 后 resolve”，会破坏 SELL 和风险链路的安全语义。必须保留两个层次：

```text
canonical snapshot committed
  !=
post-trade business ready
```

### 3.3 `core` 与 Longbridge SDK 混合

SDK 类型和 runtime 上下文已经进入订单、风险、策略契约和末日保护。问题不是当前单券商产品不能运行，而是：

- 新增执行后端传播面大；
- 领域测试被 SDK 类型绑住；
- 精度和状态映射容易在多个 core 文件重复；
- 订单事实和 SDK 对象边界不清晰。

### 3.4 业务 owner 跨目录且用例完成条件分散

保护性清仓的完成判断和结果推进跨越：

```text
TradingRiskEventRuntime
unrealizedLossMonitor
Trader / OrderMonitor
protectiveLiquidationEpisodeTracker
PostTradeConsistencyRuntime
DailyLossTracker
LiquidationCooldown
MixedTradeLogRepository
```

这些模块各自有合理职责，但缺少一个清晰的 application workflow 作为审计入口。

### 3.5 生命周期依赖多份清单

当前 runtime 的创建、启动、跨日停止、最终终止和 cleanup 分散在多个位置。当前没有确认遗漏，但新增 runtime 的维护成本是结构性问题。

### 3.6 队列的策略语义未统一显式表达

当前已有：

- 行情 latest-only；
- 监控任务同事项替换；
- 买卖 FIFO；
- 订单事实保序；
- freshness wait；
- stop-and-drain。

这些不是同一种队列。重构不应统一成一个通用事件队列，而应明确每条通道的丢弃、合并、保序和持久化策略。

---

## 4. 目标架构与职责边界

目录优化与状态所有权、依赖边界优化共同构成本次重构目标。目标顶层为 `app / domain / application / runtime / infrastructure / config / constants / types / utils`，保留 `src/index.ts` 作为薄入口。原 `core/main/services` 是迁移期间的来源位置，不是最终混合职责容器；按闭合切面迁移，P6 清除最后残留。完整目录树、逐模块去向和阶段验收见 `architecture-refactoring-implementation-plan.md` 第 4 节。

这收紧了初版“优先在原目录最小落地”的物理实施选择，不改变本文的交易安全协议。先冻结目标归属，再迁移职责与文件；不得把重构等同于批量改路径，也不得因允许渐进实施而永久保留混合边界。

### 4.1 Domain：业务模型、规则与封装状态

逐切面建立以下领域边界，不预建空目录：

```text
src/domain/
  order/
  position/
  seat/
  risk/
  liquidation/
  strategy/
```

Domain 只依赖项目内部契约，不依赖：

- `TradeContext`；
- Longbridge `OrderStatus` 等枚举；
- WebSocket push 对象；
- 文件仓储；
- runtime scheduler。

允许 domain 定义：

- `OrderFact` 合并规则；
- pending-sell 占用规则；
- 席位状态迁移；
- 清仓完成条件；
- 风控纯计算；
- 成本/数量/实际成交金额计算。

Domain 可以通过工厂封装席位、订单占用、冷却等领域状态，并通过业务方法推进；不是只能容纳无状态函数。时间相关规则接收显式时间值，不读取系统时钟或安排 timer。`liquidationCooldown` 的计数和冷却规则属于此层；同目录 `tradeLogHydrator.ts` 的仓储读取/恢复编排归 application/protectiveLiquidation，实际文件读写归 infrastructure，不整目录搬入 domain。

策略按实际职责而非名称拆分：`intradayRegression/runtime/` 是指标增量计算与状态，应留在 domain/strategy；`definition.ts` 中配置导入、prepare/create 与选中策略工厂属于 app/startup，配置解析属于 config；只有实际行情监听和唤醒归顶层 runtime。

不允许 domain 自己：

- 发起网络请求；
- 创建 Longbridge `TradeContext`；
- 写 LastState；
- 安排 timer；
- 决定进程终止。

### 4.2 Application：完整业务用例 owner

按实际业务职责选择以下 application workflow 边界（不要求创建所有目录）：

```text
src/application/
  accountPositionSnapshot/
  postTradeSettlement/
  protectiveLiquidation/
  seatActivation/
  seatSwitch/
  ordinaryBuy/
  ordinarySell/
  doomsdayClearance/
```

仅在存在独立业务状态、跨模块完成条件或失败处理职责时建立 workflow。按闭合纵切直接迁移该职责、全部调用方和测试，删除旧 owner；不增加透传 façade，不把旧 runtime 完整包在新名字后面。普通买卖已有完整 owner 时保留它们，不为目录对称额外创建 workflow。

每个 workflow 必须说明实际具有的阶段、状态、失败处理和完成条件。以下是业务路径模板，不强制每个用例补齐外部命令、持久化或完成事件：

```text
Command
  -> Preconditions / Gate
  -> Domain decision
  -> External command port
  -> Fact observation
  -> Commit / persistence
  -> Completion event
```

Application 层负责：

- 跨 domain 的业务顺序；
- 选择对应交易目的的风控 policy；
- 组织 retry owner；
- 处理等待、重评估和完成条件；
- 发布业务事实事件。

Application 层不直接处理 Longbridge DTO。SnapshotCoordinator 的 broker read 编排、pump、single-flight/pending、waiter、版本仲裁和私有 store 整体归 `application/accountPositionSnapshot/`；经窄 read port 使用 adapter，不为分层拆成独立 domain store、runtime pump 和转发 façade。其他业务 owner 同样可以保留保证自身状态不变量所需的并发控制。

普通买卖、订单执行/跟踪/恢复、自动寻标、静态清仓和交易日业务重建均须有明确的 application 归属，复用并迁移现有 owner；并非只迁移上面优先列举的 workflow。SDK 映射、外部读取和队列监听从其实现中分离，不能将整个 Trader 原样搬进 infrastructure。

订单事实及经济投影由唯一 `application/orderTracking/` owner 推进；已消费输入和投影覆盖元数据内聚现有订单记录/事实存储，规则归 `domain/order`。activation、execution 和 snapshot coordinator 不另持订单账；API 重建与在线结算共用 §9.2 的幂等基线，不以目录迁移建立第二 owner。

### 4.3 Runtime：事件和生命周期协调

物理归属为 `src/runtime/`。Runtime 层只负责：

- 接收行情、订单和时间事件；
- single-flight/latest-only/FIFO；
- 将事件路由到 application workflow；
- stop、drain、restart；
- 调度下一次唤醒；
- 维护队列 admission。

Runtime 不负责：

- 直接修改 canonical snapshot；
- 自己决定保护性清仓完成；
- 直接解析 SDK 订单状态；
- 在多个业务流程之间复制同一套风控规则。

runtime 可调用注入的 application 能力；application 需要唤醒、投递或订阅协调时，经窄 port/回调协作，由 app 接线，不反向 import runtime 实现。对象协作不等于允许双向静态依赖，也不要求建立通用 EventBus。

### 4.4 Infrastructure：外部世界适配

```text
src/infrastructure/
  longbridge/
    trade/          # TradeContext、commands/facts、订单和账户持仓 mapper
    market/         # QuoteContext、行情与 warrant 查询及 mapper
  persistence/      # 交易日志、保护性 progress/completion 的实际文件读写
  time/             # 时钟与定时器实现，保持现有不同 scheduler 的归属
```

这里只列主要适配能力；实际日志和展示输出也按外部副作用归属，不为每个 mapper 创建独立层。到期筛选、候选排序和冷却规则不是基础设施；分别归 domain，调用与失败策略归 application。

Longbridge 适配器负责：

- 创建和持有 `TradeContext`；
- SDK 枚举、Decimal、push 对象转换；
- 订阅/退订；
- 命令结果和事实结果映射；
- 未知状态 fail-fast。

它不负责：

- 买量、整手对齐、回收价距离、成本/日损益公式或 progress/baseline 恢复排序；这些规则由 domain/application 使用 SDK 无关的十进制能力承接，不能为消除 SDK import 而塞进 broker mapper；
- 买入风控；
- 保护性清仓冷却；
- 席位激活；
- 判断某订单是否属于当前席位。

### 4.5 App/Composition：唯一组装根

保留 `src/app/runApp.ts` 为主组合根，逐步将创建行为收敛为：

```text
选择 definition
  -> 创建 ports/adapters
  -> 创建 stores
  -> 创建 application workflows
  -> 创建 runtimes
  -> 注册 lifecycle descriptors
  -> 启动
```

不引入模块级全局 service locator，不让业务模块从全局容器获取 Trader 或 Store。

`app/runtime` 若保留，只能存放创建/接线工厂；实际监听、队列和启停 owner 归 `runtime`。保留 `app/shutdown` 现有增量 cleanup 执行机制，日切运行编排归 runtime，业务重建完成条件归 application，不新增第二套生命周期执行器。

类型仍按最近共同父级放置：局部 `types.ts`、层内共享类型、必要的 `src/types/` 跨层窄契约。跨层事实模型不得经高层实现类型反向依赖；不把 `types/services.ts` 改名为另一个超级 `contracts`。常量继续按项目规范集中在 `src/constants/`；纯业务规则不因是纯函数而归入通用 utils。

---

## 5. 核心设计一：Canonical Snapshot Owner

### 5.1 目标

只有一个对象拥有目前由以下字段承载的 canonical 事实写入权（目标实现移入私有 store，不继续保留可写 LastState 镜像）：

```text
LastState.cachedAccount
LastState.cachedPositions
LastState.positionCache
```

建议命名为：

```text
AccountPositionSnapshotStore
```

或：

```text
CanonicalAccountPositionFacts
```

名称必须表达它是**事实提交者**，不是普通 cache helper。

### 5.2 读取和提交分离

允许多个业务 owner 发起读取请求，但不能直接提交：

```text
Seat refresh       ─┐
Post-trade         ─┼─> SnapshotCoordinator.requestRefresh()
Startup/rebuild    ─┘              |
                                   v
                         Broker read / merge / validate
                                   |
                                   v
                         SnapshotStore.commit()
```

接口草案（用于表达职责；正式实现的数据 type、能力 interface 放对应定义模块，不在 index.ts 内联，不 re-export）：

```ts
interface AccountPositionSnapshotCoordinator {
  requestRefresh(request: SnapshotRefreshRequest): Promise<SnapshotRefreshReceipt>;
  requestClear(request: SnapshotClearRequest): SnapshotClearReceipt;
  getSnapshot(): AccountPositionSnapshotView;
  getCommitStatus(): SnapshotCommitStatus;
}
```

请求必须带有业务来源：

```ts
type SnapshotRefreshRequest = Readonly<{
  readonly source: 'STARTUP_REBUILD' | 'OPEN_REBUILD' | 'SEAT_ACTIVATION' | 'POST_TRADE_SETTLEMENT';
  readonly dayEpoch: number;
  readonly refreshAccount: boolean;
  readonly refreshPositions: boolean;
}>;
```

### 5.3 三种版本必须分开

#### A. `dayEpoch`

表示生命周期代次。

- 午夜清理推进 epoch；
- 旧 epoch 的 API 响应不得提交；
- open rebuild 成功前不允许旧数据恢复到新 epoch。

#### B. `snapshotGeneration`

表示当前 canonical snapshot 的失效代次。

在以下情况推进：

- 已知成交事实到达，需要重新取得事实；
- 日切清理；
- 明确的重建开始。

请求在开始时捕获 generation，响应提交前必须验证仍有效。

#### C. `commitRevision`

只在一次合法 canonical commit 完成后递增。

- API 失败不递增；
- 过期响应丢弃且不递增；
- 本地乐观 projection 不递增；
- 它是应用提交序号，不宣称是券商远程 revision。

如果账户和持仓不是一次券商原子快照，必须在 receipt 中区分：

```text
accountRevision
positionRevision
pairedCommitRevision
```

不能用一个本地 revision 伪装成券商的一致时点。

### 5.4 Canonical commit 的原子边界

账户和持仓双读时：

```text
读账户 + 读持仓
  -> 两者都成功
  -> 验证 dayEpoch/generation
  -> 一次性发布 paired snapshot
```

失败时：

- 不更新成功的一半；
- 不推进对应 component 的“新鲜”状态；
- 将失败交回发起方的 retry owner。

position-only 刷新只能更新 position component，不能让调用方误以为 account 同步完成。

### 5.5 单飞和 pending 合并

SnapshotCoordinator 内部允许：

- 同一时刻最多一个 canonical batch in-flight；双读必须全部 settled 才释放 batch，即使其中一项先失败也不能提前宣布 drain 完成。
- 只有尚未发出 API 请求的 pending batch 可以合并字段并集；in-flight batch 的字段、参与者和 generation 全部冻结。
- 新请求一律进入唯一 pending batch，不附着到已发读的 batch；请求返回值必须来自入队后发起的读取，不靠 source priority 推断事实新旧。
- 在途被新 generation 失效时，底层请求自然结束，结果丢弃；仍有效的参与者需求转入 pending batch。内部 supersession 不消耗业务外部失败重试次数。
- 生命周期关门后只接受重建所需请求；正常运行下 pending batch 按字段并集服务全部有效来源，不建立优先级队列。成交需求不会被 seat 重试队列无限挡住，但不能抢占已经发出的外部调用。

这里的“单飞”只用于 canonical snapshot 读写，不应覆盖 BUY 风控的临时账户/持仓读取。BUY 的临时读取继续由普通买入流程管理。

### 5.6 失败 owner 不合并

| 失败来源     | 负责重试的 owner                       | 不应发生的行为                          |
| ------------ | -------------------------------------- | --------------------------------------- |
| 席位激活刷新 | `MonitorTaskProcessor` / seat workflow | 不推进 settlement stale，不影响另一方向 |
| 成交后刷新   | `PostTradeSettlementWorkflow`          | 不由 seat runtime 再重试一份            |
| 启动快照     | startup/lifecycle                      | 不伪装成 seat refresh 失败              |
| 开盘重建     | day lifecycle                          | 不让普通业务 runtime 自行恢复           |

submit UNKNOWN 不属于 snapshot refresh 来源：直接经既有 fatal 通道终止，不安排专用查询或重评估；撤单终态等待等既有末日业务重评估不变。

SnapshotCoordinator 可以负责请求合并和结果分类，但不应该再建立一个覆盖所有业务的通用 retry policy。

### 5.7 可直接实现的 batch 状态机

内部只保留 `admissionState + epoch + generation + inFlight + pending`。不要把所有请求做成另一条通用持久化任务队列。

| 时点 | 原子操作 | 后续动作 |
| --- | --- | --- |
| 请求入队 | 检查 epoch/admission；记录请求字段和独立 waiter，合入 pending | 若无 inFlight，安排 pump |
| pump 发读 | 将 pending 整体移动到 inFlight；**此时**捕获当前 generation、字段并集和参与者；清空 pending | 按冻结字段发 API |
| 已知事实失效 | 同步 generation++；settlement 来源同时登记 staleVersion 和刷新需求 | 后来的请求进入 pending，不改 inFlight token |
| API 全部 settled | **先识别并上报已经发生的内部契约/一致性错误，再验证 epoch/admission/generation**；只有成功结果或预期外部失败才可按 supersession 处理 | 旧 epoch/终止取消；旧 generation 把仍有效需求移入 pending；内部错误不可吞掉、不转业务重试 |
| 当前代次成功 | 验证 DTO；同步替换不可变快照与内部索引；递增 commitRevision 和被覆盖 component revision | 发布 commit 事实，resolve 参与者 receipt；随后继续 pump |
| 当前代次外部失败 | 不写快照，不递增 revision，不在 coordinator 内重试 | reject 本批有效参与者，携带原始分类/字段原因，由各 owner 决定重试 |
| 日切/终止 | 关闭相应 admission；推进失效代次；取消 waiter 和未开始需求 | await 已发 API 全部 settled 后 drain 完成，旧响应绝不发布 |

关键补充：

1. 失效通知必须放在现有订单事实成功结算并登记 `recordSettlementRefreshNeed` 的同步段内，不能延迟到普通通知的下一轮消费。保护性 progress 持久化失败时仍按现有 fatal 语义，不提前提交权威成交事实。
2. `generation` 在**发读时**捕获，不在入队时冻结。generation 不同但 epoch 相同属于 superseded，不是 API 失败；自动合入后继属于取消过期本地工作，不是重试交易或额外外部失败 retry。若已发请求返回 TypeError/ContractError/InvariantError 等内部错误，无论 generation 是否已变化，都按既有 fatal/首错机制上报；supersession 只能丢弃成功结果或预期外部失败，不能掩盖内部错误。终止期间不再启动后继 batch。
3. 参与者可在发读前或返回后取消。单个席位失效只取消该 waiter；不能取消共享 API 或其他 waiter。当前代次的有效 broker 数据可供其他参与者提交，激活 caller 仍必须自己复核 seatVersion/symbol/status。
4. 若组合批次含 account+positions，则两项成功才发布。任何一项失败整批不提交；错误保留实际失败组件，不能伪造另一组件失败。若其他来源仅要 positions，它也不能取得一个并未提交的成功 receipt，而由自己的既有重评估 owner 接收该批失败。**不得因合并批次失败而把 seat 错误升级成全局 fatal。**
5. 每个 waiter 恰好一次 resolve/reject/cancel。返回 receipt 至少带 epoch、generation、commitRevision、覆盖字段、component revision 和不可变 snapshot 引用；COMMITTED 才允许消费者推进。SUPERSEDED 是 coordinator 内部状态，不作为 seat 的外部失败；ABORTED 走现有生命周期取消语义。
6. 同步提交只替换内部私有引用和索引，不 await、不调用业务回调。快照数组和元素通过 readonly 契约隔离，不能向外暴露可写 Map 或 positionCache.update。commit 后按现有语义通道通知投影 owner，不建万能 EventBus。
7. 同一 epoch 的 revision 不回退；计数器可在新 epoch 内从零开始，比较必须带 epoch。submit UNKNOWN 走既有 fatal/终止协议，不建立专用重查代次，不虚构成交或增加 settlementVersion。
8. 单飞不增加超时策略。底层已有 API 超时/限流规则继续适用；若实际请求一直无法 settle，drain 的可终止性是既有外部接口约束，不能假装请求已取消而放行下一批写入。

### 5.8 本地保证与远端保证的界线

本协议能证明：旧本地代次不能提交；同一 owner 串行发布；双读不会在应用内只发布成功的一半；receipt 对应实际接受的读取。**它不能证明新发起的券商查询已包含某次成交，也不能使账户与持仓变成远端原子快照。** 本地时间、source priority、API 完成时间不能补足券商缺失的 revision/cursor。真实成交包含性若另有要求，需基于券商能力和对账事实单独设计，不能在本文承诺线性一致。

---

## 6. 核心设计二：Snapshot Commit 与 Business Ready 分离

### 6.1 两个概念

```text
SnapshotCommitted
  = canonical account/position facts 已成功提交

PostTradeBusinessReady
  = 成交后要求的所有业务投影和完成条件已完成
```

`waitForFresh()` 应继续表示第二个概念，不能降级为第一个概念。

### 6.2 Settlement readiness receipt

保留 `waitForFresh` 作为唯一正式业务门禁名称，不另增兼容入口。将当前隐含版本扩展为内部显式 receipt：

```ts
type SettlementReadinessReceipt = Readonly<{
  readonly dayEpoch: number;
  readonly settlementVersion: number;
  readonly snapshotCommitRevision: number;
  readonly ready: boolean;
}>;
```

**receipt 是已完成 settlement 的证明，不是对未来共享快照的租约。** `snapshotCommitRevision` 表示完成该 settlement 时采用的快照，不要求此后任何 seat refresh 都重新打开全局 gate。

已有等待 freshness 的 SELL/风险链路执行：

```text
waitForFresh()
  -> 取得当前 epoch / settlement 完成水位
  -> 同步读取不可变 position snapshot 和 positionRevision
  -> 执行业务选单、读取行情
  -> 最终执行前复核 epoch、settlement 水位、seatVersion
  -> 若选单依赖的 positionRevision 已变化，重新读取并重新选单
```

新成交使 settlement gate 重新 stale；日切取消旧 waiter/token。普通 seat commit **不增加 settlementVersion，也不撤销已完成的 settlement**，但使依赖旧持仓的在途决策重新评估。普通 shared commit 不要求所有席位重新完成 R1/N1 才允许全系统交易，继续遵循方向局部 activation barrier。最终数量裁剪、订单占用和撤单终态检查仍由 executor 负责。

这是明确的并发正确性修复，不是将 BUY 等原先不等待 gate 的路径纳入新准入政策。重评估由原任务 owner 安排，不创建自动下单重试；不得把 settlement receipt 与当前 positionRevision 强行判等而造成无人恢复的永久 stale。

### 6.3 Projection 顺序

成交后流程保持：

```text
订单事实结算
  -> 保护性成交 progress 持久化
  -> record settlement need
  -> canonical snapshot commit
  -> 持仓订阅投影
  -> 保护性清仓完成判定
  -> completion 持久化
  -> daily loss boundary commit
  -> cooldown / episode commit
  -> R1/N1 refresh
  -> settlement ready
```

尤其保留：

```text
completion persist 成功
  -> 才允许 daily loss / cooldown / episode 内存提交
```

### 6.4 防止自等待

SnapshotCoordinator 不等待 business ready：

```text
SnapshotCoordinator
  只负责 read/validate/commit/receipt

SettlementWorkflow
  收到 receipt 后负责 subscription、episode、R1/N1 和 ready
```

否则容易形成：

```text
snapshot commit
  -> callback
  -> waitForFresh
  -> 等待 snapshot commit 完成
```

这是必须禁止的协作环。

### 6.5 派生结果水位与迟到写入

区分 `settlementVersion` 与投影的 `{epoch, positionRevision, seatVersion}`：前者表示待完成业务批次，后者表示某个订阅/风险结果处理了哪个观察值。不能用一个整数同时表示两者。

- 订阅仍由 QuoteSubscriptionRuntime 独占。commit 通知只令其当前事实投影 dirty，runtime 按当前真相 single-flight 对账；不能让迟到的 r10 callback 把期望订阅集合回写成 r10。
- pending settlement 的订阅、完成判断和 R1/N1 使用 receipt 的不可变输入；每个 await 返回后检查 epoch/generation/revision。若已有 r11 提交，丢弃 r10 的未提交派生结果，重新取得当前 receipt（字段不足则请求补齐），对同一个 settlement 目标重算，不重复登记 stale。
- R1/N1 的计算与发布应分开。当前同步计算可在无 await 的校验—计算—发布段内完成；若有异步输入，先准备结果，再带适用 seat identity 做 compare-and-publish。只在函数返回后检查 token 不能撤销已经写出的旧缓存。
- 保护性 completion 的准备可先计算，**最后一次 token/订单事实/seat 校验、同步持久化 append、内存 boundary/cooldown/episode commit 之间不插入 await**。维持当前同步 durable repository，不能本轮顺手改异步持久化。
- 如果以后持久化变成异步，上述原子段不再成立，需要独立设计并发提交协议；这不是本次重构的隐含扩展。
- 对已完成 settlement 之后的普通 seat commit，不撤销 settlement 水位。seat owner 只完成其方向的风险和 activation；time-wakeup 继续非 UNKNOWN 的既有系统重评估，不再承担 UNKNOWN 持仓刷新。SELL 的持仓选单 token 按 §6.2 独立复核，不等待不存在的新 settlement。
- 因此本方案保证“pending settlement 不用过期投影宣告完成、局部投影不会迟到覆盖”，**不宣称全账户持仓和所有席位风险永远构成一个原子数据库快照**。若业务要求每个普通刷新都全局阻断交易直至全部风险重算，那是新增交易政策，不在本次范围。

验证时序必须含：`r10 settlement commit → subscription await → r11 seat commit → r10 late return`。预期 r10 不发布旧风险、不提交 completion；同一 settlement 由当前 receipt 完成，无永久等待。若在 r10 已全部完成后才发生 r11，则只使在途选单重新评估，不伪造新 settlement。

### 6.6 末日清仓的 canonical 事实与 UNKNOWN 处理

`doomsdayProtection` 不得通过过滤 `cachedPositions` 或更新 `positionCache` 伪造券商持仓事实；canonical account/position facts 只由 snapshot owner 提交。已确认返回 `orderId` 的订单继续沿现有 OrderMonitor、权威终态和成交结算链路处理。

本次重构不新增 `LiquidationActionOverlay`、unresolved intent、UNKNOWN 接管或重启恢复协议。按已确认的范围决策，submit 结果不可确认时统一直接 fatal：

**当前基线与目标的区别：**普通 BUY/SELL 已向上暴露不可确认提交并进入 fatal；`src/main/timeWakeupEvaluationProgram/index.ts` 的末日分支仍会刷新持仓并安排重评估。P1 须删除该 UNKNOWN 特殊刷新 helper/分支，在通用外部失败重评估之前抛出原错误，复用既有顶层 fatal/cleanup 通道，不在当前 handler 内 self-drain。这是明确的策略收敛，不是当前所有入口的既有行为。

```text
submit request attempted
  -> result cannot be confirmed
  -> report fatal / close trading admission
  -> do not resubmit
```

这里的 UNKNOWN 是应用层对“提交结果不可确认”的错误分类，不是券商提交响应字段；也不等同于 SDK 的 `OrderStatus.Unknown`。依据当前产品范围，未来若实际遇到该场景再独立研究，本次不实现自动接管或恢复、不增加相关持久字段。fatal 关闭交易放行后由顶层执行既有终止清理；代码版本回退不能充当 UNKNOWN 自动恢复路径。该决策不改变 cancel/replace 的既有 ACK、权威终态、602013 和 WAIT_WS_ONLY 协议。
---

## 7. 核心设计三：业务 Workflow 与交易目的 Policy

### 7.1 不建立一个统一“交易流程”

当前以下路径必须保持独立：

```text
OrdinaryBuy
OrdinarySell
SeatSwitchMove
SeatSwitchRebuy
ProtectiveLiquidation
StaticDistanceLiquidation
DoomsdayClearance
```

它们可以共享底层 command port 和 order fact model，但不能因为都调用 `Trader.executeSignals` 就强行共享全部风控和重试。

### 7.2 清仓目的及既有副作用矩阵

| 路径 | protective 标识 / 委托 | 数量与归属 | 买单记录及完成副作用 |
| --- | --- | --- | --- |
| 浮亏保护性 | `isProtectiveLiquidation=true`，原保护性委托类型 | 风险判定数量，executor 按最新可卖量裁剪 | 保护性 execution progress、episode、completion durable boundary、亏损分段和冷却保持当前顺序 |
| 静态距回收价 | `isProtectiveLiquidation=false`，WARRANT_LIQUIDATION_ORDER_TYPE | 原缓存可用量发起，executor 最终裁剪；新增量不得扩入 protective 旧单 | 保留提交成功后的原买单记录清理和浮亏刷新；静态成交不创建或推进 protective progress/episode。此前真实 protective episode 仍可在完成条件满足时提交 completion 并按原规则计冷却 |
| 末日 | 专用命令，非 protective，全局交易订单类型 + Day | 当前席位可证明归属；不要求整手、不智能选单、不关联买单；撤旧卖单后等权威终态再取量 | 保留既有提交成功条件下的买单记录投影清理；提交不证明空仓，不新建保护性分段/冷却。已有保护性 episode 仍按实际事实完成 |

末日旧副作用逐项迁移：

- `cachedPositions.filter` / `positionCache.update`：删除这条伪事实写入；已确认订单的防重复用既有 OrderMonitor 和 awaiting-terminal 状态，不新建 overlay 或第二本订单账。属于本次明确修复，而非宣称行为完全不变。
- `cachedAccount=null`：改为 snapshot owner 的账户有效性标记失效，不伪造余额/持仓归零。原 loader 用 null 判断是否需要双读的调用一并改读明确初始化/失效状态；重建仍成对读取。
- `onPositionsCommitted`：不为“提交成功”发 PositionSnapshotCommitted。订阅继续依据实际持仓、席位、订单和已有 retain 集合，不因 action accepted 提前退订；实际新快照提交后正常触发对账。
- `orderRecorder.clearBuyOrders`：按原全部执行成功条件保留为原 owner 的本地选单记录操作，不清除权威成交/durable progress；部分执行失败保留原条件。不能因删除 filter 就顺手删除或提前该操作。
- submit UNKNOWN：按 §6.6 统一为直接 fatal，删除末日 UNKNOWN 特殊刷新/重评估分支；关闭交易放行且不自动重提，不新增查询接管或持久化协议。

#### 7.2.1 共享卖单的 protective 归属隔离（明确的受控修正）

**基线缺口及范围。** 静态入口已经传入 `isProtectiveLiquidation=false`，但 `PendingSellOrderSnapshot` 不携带旧单 protective 身份，`resolveSellMergeDecision` 只检查新请求。当旧单是同类型、可改单的 protective ELO，且额外可卖量、授权、报价、关联数量及券商确认等条件均通过时，静态新增量可通过 `REPLACE` 合入旧 orderId，沿旧 tracked 身份被累计为 protective execution。默认保护性委托为 MO，因此不是每次静态清仓都会触发；恢复出的 protective ELO 也在影响范围内。该缺口来自共享执行边界，不是静态入口的标识错误，也不是本次重构新引入的问题。

**事实与决策。** 复用现有 order tracking，不新增订单账、清仓 overlay 或持久化格式：

1. 订单跟踪与 pending-sell 快照必须保留旧订单可证明的 protective 身份；当前契约最少需要必需的 `isProtectiveLiquidation: boolean`，不能用新命令的 `purpose` 覆盖旧身份，也不能用缺省 `false` 掩盖内部事实遗漏。历史订单按既有 remark provenance 恢复保护性身份，不为它们补造完整 purpose 枚举。
2. 共享合单决策对有效剩余量的旧单检查身份：新 protective 请求继续采用既有撤旧重规划规则；非 protective 新量遇到 protective 旧单时，禁止扩量 `REPLACE`，选择现有 `CANCEL_AND_SUBMIT`。普通非 protective 单张同类型、可改单旧单仍允许 `REPLACE`，其他既有合单限制不变。
3. 初次规划及提交前最新 pending-sell 事实复核均执行同一身份规则。旧事实发生变化时不得沿用过期的 `REPLACE` 决策；由原执行 owner 按既有结果分支退出或重评估。
4. 禁止通过清除旧单 protective 标志、重写 remark 或在结算层按数量比例拆分归属来绕过隔离。旧 orderId 的真实成交仍属于旧订单。

**撤单与重新提交。** 复用 `submitFlow` / `orderOps` 的既有可信终态协议：撤单 ACK（基线 `CANCEL_CONFIRMED`）不等于 canceled terminal；只有取得可信非 FILLED 终态并完成旧单本地结算后，才能重新读取 broker 最新可卖量并按原数量策略重规划、授权及报价后另行提交非 protective 新单。保留旧部分成交的累计事实，不能重复提交已成交需求；`FILLED`、查询仍 OPEN、成交量缺失或事实不可信均不能当作可无条件换单。未获得继续条件时不改单、不新增委托、不执行静态成功后的买单记录清理，由原失败/重评估 owner 处理；不改变 cancel/replace 的失败分类，也不引入自动 submit 重提。

**Progress 与完成边界。** 静态新单的成交不得创建或推进 protective progress/episode、最新保护性执行时间或分段边界。旧 protective 单的真实成交和 durable progress 必须保留：部分成交后取消仍按权威累计事实结算；若静态卖出随后使方向空仓，且没有同方向 OPEN protective SELL，先前进行中的合法 episode 仍可完成。completion 使用该 episode 的最后真实保护性执行时间，继续按“completion 持久化 → daily-loss boundary commit → cooldown 触发计数 → episode commit”推进；是否激活 cooldown 仍由原 triggerLimit、计数及配置决定。不能将此合法完成误判为静态成交污染，也不能因静态目的而压制它。

**恢复边界。** broker remark 以既有 `|PL` 后缀结尾时可恢复 protective tracking；零成交挂单不独立创建 progress/episode，但已有 episode 时仍阻止提前完成。精确 episode 恢复继续要求匹配的 durable progress/completion，不使用 `order.updatedAt` 补造成交时间。恢复关联买单的精确数量检查可能拒绝某次改单，但不是目的隔离：双方关联为空时不会提供该屏障，数量匹配也不能授权跨 protective 扩量。

该修正与静态 owner 迁移构成同一闭合切面（实施计划 P3F，所需 P4.1/P4.2/P4.3 最小契约和执行/恢复切片提前完成），不得仅迁移入口、声明新 `purpose` 后将共享规则留到后续阶段。§14.3 与附录 B.1 定义未来跨模块验收；本文不表示这些修复或新增测试已经实现。

### 7.3 Command / Gate / Fact Event 三类协议

#### Command

```text
SubmitOrdinaryBuy
SubmitOrdinarySell
CancelPendingOrder
ReplaceOrder
ActivateSeat
SwitchSeat
ReassessDoomsday
```

#### Gate

```text
OrdinaryBuyGate
OrdinarySellGate
SeatActivationGate
DoomsdayGate
SettlementReadyGate
```

Gate 只表达是否允许当前动作，不把成功后的事实通知混进去。

#### Fact Event

```text
OrderAccepted
OrderFactUpdated
OrderTerminalConfirmed
PositionSnapshotCommitted
SeatActivated
LiquidationCompletionCommitted
TradingDayRebuilt
```

不能用 `OrderAccepted` 代表 `OrderTerminalConfirmed`，也不能用 `PositionSnapshotCommitted` 代表 `LiquidationCompletionCommitted`。

### 7.4 Application workflow 的最小职责

以 `ProtectiveLiquidationWorkflow` 为例：

```text
trigger
  -> verify direction/seat/lifecycle
  -> submit protective order
  -> 保留现有 protective episode 与订单跟踪（不另建订单账）
  -> consume order facts
  -> persist cumulative execution progress
  -> request canonical snapshot
  -> verify flat + no pending protective order
  -> persist completion boundary
  -> commit loss/cooldown/episode
  -> publish LiquidationCompleted
```

它不负责：

- 解析 Longbridge push；
- 计算 K 线；
- 管理系统 timer；
- 直接清空 canonical position cache。

这些分别由 adapter、strategy/runtime、scheduler、snapshot owner 负责。

### 7.5 复用既有防重与占用，不新增统一风险预占

官方文档的 `checkSignalAndReserve` 可用于理解“检查与占用不同”，但不是本项目必须新增现金/额度 reservation 的依据。单进程仍可能有异步竞态；是否需要新的资金预占必须由真实并发提交路径和现有风控政策证明，不能从“有多个 async 函数”直接推导。

本次只保留和明确既有机制：

- 普通 BUY 使用现有 FIFO、风险检查冷却、提交前频率记录、最终授权复核和订单跟踪；不在轻检查与 submit 之间增加新的资金冻结步骤。
- 普通 SELL 继续使用关联买单的 pending-sell 占用、改单协调、撤单终态确认和最新可卖量裁剪；不另建一份统一占用账。
- 换标回补、保护性及末日链路维持各自数量、门禁和重评估 owner，不能套用普通 BUY 的预占/释放政策。
- submit UNKNOWN 保持直接 fatal 且不自动重提；cancel acknowledged 继续按现有订单事实/恢复协议收敛。生命周期关门或 seatVersion 变化不能撤销已经发生的远端动作。

因此不新增 `RiskReservation` 服务、reservation 状态机、持久化预占表或跨进程锁。若后续发现具体可重现的超额提交竞态，应另行说明检查—提交间隙、影响范围和资金政策，再决定最小修复；不能把本次架构重构用作新增交易限制的授权。

### 7.6 Gate、Fact Event 与 Notification

本设计中的四类消息必须保持分离：

| 类型         | 作用                                 | 能否推进业务完成              |
| ------------ | ------------------------------------ | ----------------------------- |
| Command      | 表达要执行的业务意图                 | 由 workflow 接收并执行        |
| Gate         | 判断当前动作是否允许                 | 只能授权/拒绝当前动作         |
| Fact Event   | 表达已经发生且可审计的事实           | 只有对应 owner 可据此推进状态 |
| Notification | 面向日志、监控、告警和报表的观察消息 | 不能作为完成依据              |

因此：

```text
RiskRejectionNotification != RiskGateRejected 的 owner 状态
OrderAccepted != OrderTerminalConfirmed
PositionSnapshotCommitted != PostTradeBusinessReady
queued notification 完成 != durable business commit
```

如果一个 handler 的返回结果会影响交易完成条件，它必须成为 workflow 的显式 await 步骤，不能只注册成普通 listener。单进程事件通知可以使用既有语义通道和顺序队列，不需要引入跨进程 EventBus。

### 7.7 业务状态与合法命令

Backtest Kit 使用 discriminated union 限制非法状态。本项目应将同一原则用于多个较小的状态机，而不是建立一个统一 signal lifecycle：

| 聚合状态 | 允许操作 | 禁止操作 |
| --- | --- | --- |
| `SEAT.ACTIVATING` | 重建、校验事实、取消激活 | 普通 BUY/SELL |
| `SEAT.ACTIVE` | 普通意图、受控换标 | 直接改身份 |
| `ORDER.SUBMIT_UNKNOWN` | 直接 fatal、关闭交易放行、等待人工/后续独立处理 | 原命令自动重提、在本次重构中新增查询接管 |
| `CANCEL_ACKNOWLEDGED` | 等待事实、权威查询 | 直接标记 cancelled |
| `SETTLEMENT_STALE` | post-trade refresh | 放开依赖 readiness 的 SELL |
| `PROTECTIVE_LIQUIDATING` | 继续收口、事实重建 | 普通交易覆盖保护性流程 |

这些是既有协议的合法操作约束，不要求每行新增一个持久状态机。仅在字段随状态变化时用内部 discriminated union 防止非法组合；已有状态类型直接复用。submit UNKNOWN 描述提交结果不确定性，按 §6.6 统一为直接 fatal，不伪造券商订单状态，也不在本次重构中新增查询接管。订单终态不得回退，但仍允许既有单调合并规则接收更高权威的累计成交金额修正；不能把“终态不可回退”误写成“终态事实所有字段永远不可更新”。旧 seatVersion 结果不得激活新席位，旧投影不得覆盖新版本。数据用 `type`，能力用 `interface`，不暴露可写内部 Map。

### 7.8 生命周期层级

官方文档主要描述 strategy runner 生命周期；本项目必须明确以下层级不能互相替代：

```text
Strategy signal lifecycle
Strategy instance lifecycle
Trading-day lifecycle
Runtime/process lifecycle
Broker/order lifecycle
```

因此：

```text
strategy closed
  != order terminal
  != position snapshot refreshed
  != settlement ready
  != process cleanup complete
```

---

## 8. 核心设计四：Longbridge Adapter 与内部事实模型

### 8.1 最小 port，而不是通用 Broker 平台

建议新增最小交易 port：

```ts
interface TradeCommandPort {
  submitOrder(command: OrderCommand): Promise<SubmitOrderResult>;
  replaceOrder(command: ReplaceOrderCommand): Promise<ReplaceOrderResult>;
  cancelOrder(command: CancelOrderCommand): Promise<CancelOrderResult>;
}

interface TradeFactsPort {
  getAccountSnapshot(): Promise<AccountSnapshot>;
  getPositions(symbols?: ReadonlyArray<string>): Promise<ReadonlyArray<PositionFact>>;
  getOrders(scope: OrderQueryScope): Promise<ReadonlyArray<OrderFact>>;
  getOrder(orderId: string): Promise<OrderFact | null>;
  subscribeOrderFacts(listener: (fact: OrderFact) => void): Unsubscribe;
}
```

行情继续使用独立 `MarketDataClient`，不要把行情和交易强行塞进一个 Broker port。

### 8.2 OrderCommand 不携带业务 policy

`OrderCommand` 只表达交易意图已经经过哪个 workflow 决定：

```ts
type OrderCommand = Readonly<{
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly orderType: InternalOrderType;
  readonly timeInForce: InternalTimeInForce;
  readonly quantity: string;
  readonly price: number | null;
  readonly purpose:
    | 'ORDINARY_BUY'
    | 'ORDINARY_SELL'
    | 'SWITCH_MOVE'
    | 'SWITCH_REBUY'
    | 'PROTECTIVE_LIQUIDATION'
    | 'STATIC_DISTANCE_LIQUIDATION'
    | 'DOOMSDAY_CLEARANCE';
}>;
```

`purpose` 用于审计、订单归属和执行分支，不代表 adapter 需要理解全部业务规则。它只标识新命令，不自动隔离被修改旧订单的身份；`OrderFact`、tracked order 与 pending-sell view 须保留可证明的旧 protective 身份，共享 execution owner 按 §7.2.1 同时检查新旧事实。本次不为 UNKNOWN 新增 `clientIntentId` 或远端幂等协议，沿用已有信号身份及已确认的 orderId。

数值遵循 §8.4 的既有混合语义。示例 `quantity` 是中性十进制文本，承接原链路在提交前仍保留的 Decimal 数量，由 adapter 构造 SDK 值，不经 number 往返；`price` 保留原有 number 输入边界。其他命令/事实字段也须按原转换位置确定表示，不以这个示例推导全链路统一改用 string 或 number。

### 8.3 结果必须保留不确定性和结构化分类

| 操作 | 内部结果/失败分类 | owner 行为 |
| --- | --- | --- |
| submit | ACCEPTED(orderId)、明确业务 REJECTED、请求已尝试但结果 UNKNOWN | UNKNOWN 直接 fatal、关闭交易放行且不自动重提；已接受后本地记录失败保留 orderId 和一致性错误 |
| replace | ACKNOWLEDGED、明确拒绝、ORDER_ALREADY_CLOSED、可重试外部错误、UNKNOWN | 保留现有改单路由、错误码退避及权威查询；ack 不改写终态 |
| cancel | ACKNOWLEDGED、ALREADY_TERMINAL(权威 fact)、可重试外部错误、UNKNOWN | 接受后等事实；上层保留 CANCEL_NOT_STARTED；不凭错误文本推导 terminal |
| query/read | 成功事实、约定的 not-found、结构化外部请求失败 | 原 owner 决定重试；未知枚举/错误 DTO 为契约错误，不转为空数组/null |

adapter 保留内部类别、必要原始错误码、operation、requestAttempted、cause；业务层依赖内部标签而非解析 SDK error。必须保留 `orderOps` 中 `602013` 的四次退避、第五次权威查询、必要时 `WAIT_WS_ONLY`，以及 order-closed 响应而查询仍 OPEN 的处理。不能用统一 retryable 布尔值替代这些状态机。

分别定义各操作结果 type，`ReplaceOrderResult` 完整表达上述分类后才能迁移。内部 TypeError/ContractError/InvariantError 继续 fail-fast，不包装为 UNKNOWN。adapter 只识别/映射，不改变重试 owner、次数和时机。

约束：

- submit `UNKNOWN` 直接 fatal，不自动重提；
- `ACKNOWLEDGED` 不转换成 `CANCELED`；
- `orderId` 已取得但本地落账失败时，不重提原命令；
- 本次重构不新增 submit UNKNOWN 的查询、接管或系统重评估协议。

### 8.4 订单事实精度和 revision

SDK 解耦不等于精度升级，也不允许把现有十进制计算降为普通 number。当前基线是 **number/string 输入 → Decimal 中间运算、比较、取整 → 在既有位置转回 number/string**；局部还存在 number 比较和多次投影，并非纯 number，也不是全链路 Decimal。本次保留这些已观察到的混合语义、阈值包含关系与持久化格式，不定义基础类型别名冒充精确运算。

**转换位置与职责基线：**

| 链路及当前来源 | 必须保留的运算与转换 |
| --- | --- |
| 买量：`utils/numeric`、`trader/orderExecutor/quantityResolver`、`autoSymbolManager/signalBuilder` | 有限 number 按 `toString()`、string 按文本进入十进制；名义金额除价格后向下取整，再按每手向下对齐。普通提交量原先仍是 Decimal，不能先转 number 再计算/重建；换标回补结果在构造 signal 前原本转为 number，保留该位置。 |
| 回收价距离：`riskController/warrantRiskChecker`、`autoSymbolManager/switchStateMachine` | number 价格进入十进制，按 `(现价 - 回收价) / 回收价 × 100` 计算并进行阈值/区间比较；比较前不预舍入、不投影为 number。供换标比较的距离值继续保留十进制语义，原风险结果/展示的 number 转换仍在原位置。 |
| 日损益：`riskController/dailyLossTracker`、`riskController/utils#sumOrderCost` | 成交价/量与事实字段已有 number 边界；累计金额先做十进制乘法，成本汇总先做十进制乘加，baseline 差额、分段均价、已实现盈亏也用十进制。各自原有的 `toNumber()`、再进入十进制及 number 状态字段均保留，不能合并为一段“全精确”计算或全部改成 number。 |
| progress/baseline：`main/lifecycle/loadTradingDayRuntimeSnapshot`、`dailyLossTracker`、`mixedTradeLogRepository` | V1 累计数量/金额为 string；loader 恢复排序、执行量与 durable 值比较，以及 baseline 与边界快照匹配使用十进制比较，不用字典序或先转 number。tracker 恢复后的事实/baseline 投影和原有 number 比较仍保留。写入文本来自原 number → Decimal → `toString()`，不是 SDK 原始字符串。 |

`7000 / 0.07`、每手 `10000` 是必须冻结的差分：现有十进制买量为 `100000`；直接 number 中间结果为 `99999.99999999999`，最终买量为 `90000`。保留十进制是在避免退化，不是新增精度需求。

**SDK 无关的承接方式：**通用算术继续由 `src/utils/numeric/**` 的纯函数提供，底层改为直接依赖独立十进制库，不包装或透传 Longbridge Decimal。领域公式归 `domain/order`、`domain/position`、`domain/risk` 等实际职责；恢复编排/排序归对应 application。SDK 构造、解析及边界转换才属于 trade/market adapter。中性十进制文本或独立库值可承接原来的 Decimal 中间值；不能只把原文本作为审计附件、实际公式却用 number。

P0 必须对照当前 SDK 实现，选定并锁定独立库版本、精度/舍入、输入验证、取整及序列化规则，通过实施计划 §13.4.2 的差分；不得假设任意库的默认参数等价。新 domain/application 消费 numeric 前，须闭合通用算术替换及全部受影响的输入/结果契约，移除对应 SDK 例外，不能等 P4 收尾，也不能让新层继承旧 SDK 类型。此次仅修订设计，未选择或安装实际依赖。

恢复还须冻结具体择新次序：同订单 progress 按 orderId、revision、十进制累计量、OPEN → TERMINAL；跨订单 recency 按执行时间、revision、十进制累计量、阶段、orderId；边界快照按不晚于边界的执行时间、revision、原 number 数量、TERMINAL 优先。同量仍按较新的时间/revision 择新，不能只看最大数量。

事实单调合并不等于经济投影副作用已消费。API 重建与 push/query 结算必须保留同一 broker orderId，并按 §9.2 区分已接受累计事实、实际投影覆盖和终态资源收尾；日损去重、数量未推进或 tracking 已关闭，都不能单独替代经济投影的幂等与合法金额修正判断。

V1 JSONL 文本格式、progress ID 和幂等冲突检测不变：不同 ID 的旧记录逐条恢复，同 ID/同 payload 去重、异 payload 失败；数量/金额文本不在读取时重新规范化，例如 `0.30` 当前被拒绝，不改写成 `0.3`。原 SDK 字符串若另用于审计，须与这种既有 durable 文本区分。旧 `.json`/legacy completion 的现有拒绝语义也不放宽，不主动改变日志协议。

事实字段仍按各自旧链路的运算输入和消费边界确定；边界可表达：

```text
raw/decimal string
quantity
executedAmount
averagePrice
updatedAt
source revision/cursor（若券商提供）
```

如果券商没有远程 revision：

- 本地 `commitRevision` 只能表示应用接收顺序；
- 不能声称 snapshot 一定包含某次成交；
- readiness 语义必须说明这是“应用层当前代次读取和投影完成”，不是远端线性一致证明。

### 8.5 Adapter 迁移顺序

1. P0 按 §8.4 冻结转换位置和差分，锁定独立十进制承接；新增内部订单/账户/持仓/事实类型，不丢失原 Decimal 中间语义。新层消费前完成所需 numeric 替换，不推迟到 P4。全链路精度升级是单独需求，需另定数值表示、舍入、日志和恢复协议，不绑定本次架构重构。
2. Longbridge adapter 只做 SDK 与内部表示的单点映射，不接管领域算术或恢复比较。
3. 先迁移 submit/replace/cancel。
4. 再迁移 order query/push/recovery。
5. 再迁移 account/position snapshot。
6. 最后移除 core 和公共契约中的 SDK type/runtime import。

不建立临时或长期兼容层。每个闭合调用切面迁移时删除旧入口；迁移完成后，旧 SDK 类型不再从 `src/types/services.ts` 向业务层暴露。

---

## 9. 核心设计五：席位工作流和激活屏障

### 9.1 SeatRegistry 只拥有身份事实

`SeatRegistry` 负责：

- `EMPTY/SEARCHING/SWITCHING/ACTIVATING/ACTIVE`；
- 当前 symbol；
- direction；
- seatVersion；
- switch/activation timestamps；
- failure/freeze data。

它不负责：

- 发起 Longbridge 请求；
- 直接修改账户/持仓 canonical facts；
- 安排多个 runtime 的 stop；
- 判断保护性清仓完成。

### 9.2 SeatActivationWorkflow

本节是运行期目标协议，不表示现有调用方已具备全部防旧写检查。候选提交、版本迁移和旧运行态清理由上游 producer 与席位事件负责，不能统一画成“绑定后再 version++”：自动寻标绑定新标时按原规则提升版本；距离/周期换标在 `ACTIVE -> SWITCHING` 时提升版本并触发旧方向清理，后续绑定和 `SWITCHING -> ACTIVATING` 不重复提升版本。dispatcher 对当前 ACTIVATING 身份 latest-only 派发任务，携带入队 dayEpoch 与席位身份，并保留换标的真实 previousSymbol。执行入口在首个 await 前验证该 epoch/身份与生命周期准入，整次工作固定这份身份基线，不能在异步返回后换成当前 epoch 给旧任务补合法性。

旧方向清理只覆盖原有延迟信号、待执行队列和 warrant 信息，不代表已取消 in-flight 工作或清空浮亏缓存；在途工作由身份/事实校验和最终订单授权阻断。清理 dispatcher 必须先于激活 producer 启动，同步 listener 的内部错误仍 fatal，不能把已提交的席位状态当作清理成功证明。

**运行期顺序：**

```text
current ACTIVATING identity / lifecycle admission
  -> validate callPrice
  -> await retain(next/previous symbols)
  -> await market admission
  -> read execution quotes
  -> capture order-read token before I/O
  -> read allOrders for this task
  -> related-symbol preflight + order-read token validation
  -> daily loss recalculate / commit
  -> current-direction local order rebuild + consumed-fact coverage commit
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

**订单输入的早期栅栏：** 发出 `allOrders` 读取前捕获 `dayEpoch + snapshotGeneration + direction + symbol + seatVersion + ACTIVATING`。每次任务读取自己的订单输入，不跨任务复用。返回后及日损/订单列表写入前复核 token；预检覆盖新标、不同的旧标以及当前双方向相关标的。预检、日损重算/提交、方向订单列表及其实际消费覆盖提交之间不插入 await。日损直接分析全量订单，不依赖重建后的买单缓存；预检也不能替代日损的成交归属校验，所以日损拒绝后不能继续订单重建、账户刷新、风险发布或 ACTIVE，finally 清理仍须执行。

当前日损重算只对返回列表中出现的同一 orderId 合并已有 fact，方向订单重建则直接替换本地 buy list；二者都不能自动保护读取期间新增、但旧响应中缺失的 WS 成交。较新的后置 canonical receipt 不能给尚未合法提交的旧 `allOrders` 补合法性。若身份仍有效但 generation 已推进，由原 activation owner 追赶当前代次并重读未提交的订单输入；这属于本地 supersession，不消耗一次外部 API 重试、不回落 EMPTY、不重复登记 settlement stale。日切、停止或身份失效则取消旧工作；内部错误不能借过期判定吞掉。

**跨入口经济投影幂等：** 合法 API 重建后，同单晚到的 WS/query 终态仍可能再次修改本地订单列表：当前 `recordLocalBuy` 不接 broker orderId，而存储生成 LOCAL ID 并追加；随后日损按同 orderId 返回事实未改变，也不能撤销该追加。真实组件与外部 API 替身的内存交错（无真实券商调用）已复现：单价 1、日损偏移 0，API 投影 BUY 100 股后，同单 WS 使本地数量变为 200 股、R1/N1 为 200/200，持仓响应仍为 100 股、席位仍 ACTIVE。这与读取期间旧响应缺少新成交的窗口不同，generation/receipt 栅栏不能替代以下前提；两项缺口均须在 P1 关闭：

- API 重建与 push/query 结算在现有唯一订单 owner 内共用 broker orderId、累计数量/金额、时间/revision、阶段及原冲突校验规则。已消费输入和覆盖元数据内聚现有订单记录/事实存储，不新增第二账或 durable 格式，不用新的 LOCAL 身份重复表示同一成交。
- API 本地提交同步登记分类/过滤实际消费的事实及投影覆盖，与方向订单列表同段提交；不把全部 raw 输入标为已消费。OPEN partial 若仍只在 pending 或日损事实中，不能宣称已被本地买卖经济投影消费。覆盖须包含被 SELL 消除的 BUY、已消费 SELL 和空结果的消费证明；清空本地买单列表不等于删除该证明。受控 rebuild 也须在合法基线提交时同步建立相应覆盖。
- 在线结算依据共同覆盖判断经济副作用，而非仅看日损的 `authoritativeFactChanged` / `executionAdvanced` 或幸存买单。相同已消费事实不再次追加 BUY、不重复扣减 SELL；累计量合法推进或更高权威的金额/时间/阶段修订按原单调规则更新同一订单，已覆盖部分不再消费。必要时利用 owner 保留的完整已消费输入，按既有关联买单、卖单时序及低价优先整笔过滤规则重算受影响口径；同量金额修正不得虚构成交数量推进，过滤结果的合法变化不等于新增成交，也不额外重拉 API。
- 经济投影去重不跳过首次可信终态的 pending 占用释放/移交、routing/hold/tracking 关闭及既有结算收尾；不能提前填 `closedOrderIds` 或直接跳过整个 `settleOrder` 来防重。tracking 关闭不替代事实准入，也不屏蔽合法金额修正；覆盖不证明 protective progress 已落盘、终态已收口或 settlement 已 ready，原持久化顺序和错误分类保持。

**后置发布栅栏：** canonical owner 只完成 read/validate/commit/receipt，不等待业务 ready；订阅等待由 activation owner 持有，不能调用 `waitForFresh()` 把自身接入 settlement 等待环。每个 await 后复核生命周期、epoch、席位身份及适用的 generation/revision。上述跨入口幂等前提成立后，此前合法的本地提交若随后遇到新事实，保留提交并用当前事实重新准备未提交的 snapshot/订阅/风险结果，不回放旧订单响应；“当前事实”须来自已正确更新的经济投影，而非重复计量的缓存。普通 commitRevision 变化不使订单输入自动失效，也不重拉订单或推进 settlement stale；后置派生依赖的 revision 改变时，获取当前所需 receipt（字段不足才补读）并重算。

R1/N1 数学上只依赖买单记录和日损偏移，不依赖订阅成功；但当前风险方法直接写共享缓存，因此保留“持仓订阅成功后再发布”的业务屏障。同步计算使用无 await 的校验—计算—发布尾段；若准备阶段含异步输入，必须先准备、再 compare-and-publish，不能先写风险缓存再检查。旧标本地买单清理仅在 previousSymbol 不同于新标且不再由任何当前席位归属时执行，不等于抹掉旧标真实持仓、成交事实或全局订阅。

**完成、清理与失败：** ACTIVE 是该方向业务放行点，不是 finally 已成功的证明。ACTIVE 事件先将永久 `SEAT_BOUND` 归属投影排入同一订阅串行链，随后完整 await 临时 retain 释放；不新增“释放成功才能 ACTIVE”的要求。重试只对仍匹配 ACTIVATING 的任务有效；主体已 ACTIVE 后，release 失败不回滚、不重新激活，也不新增专用 release 重试 owner。保留主体/清理错误分类及优先级，内部错误不能被外部清理失败覆盖，内部 release 错误仍 fatal。

方向隔离限定为 activation 状态与重试归属，不声称全量订单、双方向日损或订阅集合天然方向隔离：

- LONG 的明确外部激活失败不清掉 SHORT 当前 ACTIVE，也不推进全局 settlement stale；已有成交导致的 stale 仍由 settlement owner 管理。
- 运行期明确外部请求失败仍最多一次延迟重试，耗尽才使当前方向 EMPTY；回收价或原规则明确的风险事实无效立即 EMPTY；订单契约、成交归属和内部不变量错误仍 fatal。
- 生命周期关门/停止或身份失效只取消旧工作，不计为新席位成功/失败、不自动 EMPTY；仅连续交易时段关闭不新增 activation 取消条件，普通订单仍独立检查交易门禁。
- 订阅错误按入口归属：activation awaited 调用归 activation 重试，settlement 持仓对账归 settlement stale/重试，普通席位/订单订阅事件保持既有 fatal 分类，不改为 activation 方向局部失败。

该路径从上游已交付 ACTIVATING 开始。距离移仓的卖旧/按实际卖出金额回补仍在 SWITCHING 用例内完成后才进入 ACTIVATING，不因普通 BUY/SELL 的 ACTIVE 门禁改变 migration purpose 授权。启动/开盘受控 rebuild 与静态 bootstrap ACTIVE 例外独立审计，在全局交易关闭下完成自己的订单、snapshot、风险和订阅基线，不能机械重复整条运行期链路，也不能作为运行期绕过屏障的入口。generation 栅栏只防本地已知失效的旧读写，不承诺券商新查询包含全部成交或提供跨接口远端原子快照（§5.8）。

### 9.3 SeatSwitchWorkflow

周期换标、距离换标和移仓可以共享状态机基础设施，但必须显式带 policy：

```text
policy = PERIODIC_REPLACE
policy = DISTANCE_MOVE
```

它们的差异包括：

- 是否卖旧标；
- 是否回补；
- 预寻标边界；
- 失败处理；
- 是否保留旧标归属；
- 回补使用实际卖出金额；
- 是否等待可用持仓变为零。

不要把它们合并成一个“泛化 switch”后再用布尔参数隐藏业务差异。可以共享阶段执行器，但每个 policy 必须显式实现：

```text
candidate selection
old seat handling
sell-out requirement
rebuy requirement
failure policy
completion condition
```

与 activation 的交接必须闭合：DISTANCE_MOVE 保留 SWITCHING 内回补及其 migration 授权，完成后才交付 ACTIVATING；PERIODIC_REPLACE 不额外获得移仓行为。已提交 SWITCHING/pending 状态的 WAIT 必须归现有 switch wakeup owner，或由生命周期停止协议明确收口；后置连续时段门禁关闭只暂停推进，不能抹掉已提交工作的 owner 交接。不得靠后续行情、重复 tick 或新增扫描兜底恢复 ownerless SWITCHING。

---

## 10. 核心设计六：Runtime 生命周期声明

### 10.1 设计目标

当前已有 cleanup phase，但 startup、midnight、termination 和 cleanup 的资源清单分散。由于程序是单进程，不需要动态 registry、跨进程生命周期协调或插件发现；只需要在 composition root 维护一份静态、有序的 lifecycle checklist，并由架构测试校验覆盖：

```text
startAfterRebuild          已完成重建后启动哪些 owner
stopAdmissionAndStopNow   fatal/终止时同步关门和停产
midnightStopAndDrain      午夜停止和排空哪些交易日资源
openRebuildStart          重建后的基线、订阅与恢复顺序
finalDrainAndDispose      最终终止时按 cleanup phase 排空和销毁
```

每组只列实际 owner、现有操作和有序依赖，不引入统一 RuntimeDescriptor 能力接口，不给没有 drain/start 的资源补空方法。静态清单负责完整性校验，原有具名编排函数继续执行；不再建立第二个动态 registry 或通用生命周期执行器。资源取得后立即登记 cleanup，工厂完整返回前失败也能释放已取得资源。原 `CLEANUP_PHASE_ORDER` 保持为有序终止协议，不由数字 priority、动态拓扑排序或跨进程协调替换。

### 10.2 不用统一 stopAll

策略必须支持差异：

- TimeWakeupRuntime 在交易关闭和重建期间继续运行；
- BusinessEventProgram 在午夜前必须先停止；
- Queue processor 需要 drain；
- OrderMonitor 需要等待事实收口；
- QuoteSubscriptionRuntime 要在事实 owner 停止后处理订阅；
- Strategy teardown 最后执行。

因此 checklist 只集中声明资源能力和顺序，不能把所有生命周期压平成相同动作。

### 10.3 跨日流程目标

```text
MIDNIGHT_CLEAR
  1. close trading gate
  2. abort settlement waiters
  3. stop market/order producers
  4. drain monitor/seat handlers
  5. drain buy/sell
  6. stop order monitor and post-trade worker
  7. stop subscription worker
  8. clear queues and strategy day state
  9. snapshot store clearForDay

OPEN_REBUILD
  1. 使用日切建立的 epoch；同日重建重试只更新读取 generation，不重复制造交易日
  2. load paired account/position/order facts
  3. rebuild order ownership
  4. rebuild risk/calendar facts
  5. establish snapshot baseline
  6. reconcile subscription truth
  7. start activation/search/switch workers
  8. start market/risk/order producers
  9. 受控重建基线完成后按现有 lifecycle 条件开门；运行期 ACTIVATING 继续由方向局部门禁保护
```

TimeWakeupRuntime 不属于上述交易 producer 的停止范围，继续负责交易日和重建时点。它触发的 midnight/rebuild 不能反向等待自己 drain。全局开门不能依赖只有开门后 MonitorTaskProcessor 才能执行的运行期 activation；受控 rebuild 基线和运行期 activation 是不同路径。

### 10.4 终止流程

```text
termination latch
  -> close trading gate
  -> close queue admission
  -> stop producers
  -> abort waits
  -> drain consumers
  -> stop order monitoring
  -> unsubscribe listeners
  -> teardown trader
  -> stop snapshot/post-trade worker
  -> stop subscriptions
  -> destroy strategy
```

descriptor 只能降低漏列风险，不能取代 termination 的首个 fatal 锁存和 cleanup phase 语义。worker 内 fatal 只同步关门/停产并通知顶层；只有顶层 cleanup await 全局 drain。禁止 worker/handler/scheduler 在自身在途任务中等待自己的 stopAndDrain。cleanup 某步失败继续后续步骤并汇总，保留首个 fatal。

---

## 11. 运行通道和背压协议

### 11.1 单进程并发边界

本项目不通过多进程共享内存或队列运行。账户/持仓提交者、订单事实处理 owner、席位注册表及生命周期 owner 均在当前进程内组装。方向/标的任务和 waiter 按现有业务范围创建，不因“单进程”强行合并为一个全局对象；也不为它们建立单例注册框架。

因此本方案解决的是 JavaScript/Bun 异步任务之间的竞态，而不是分布式一致性。`generation`、`commitRevision`、`seatVersion` 和 `settlementVersion` 只提供进程内失效与排序保护；它们不构成跨进程 fencing token。进程重启后以 durable order facts、交易日快照和既有恢复流程重建内存状态。

不增加以下运行时设施：

- Redis 分布式锁或缓存一致性层；
- Mongo/数据库唯一索引作为运行时并发协调；
- 跨进程事件总线；
- 跨进程 scheduler、租约或 leader election；
- 为单进程问题引入 worker thread/cluster。

### 11.2 明确通道类型

| 通道             | 语义                  | 规则                             |
| ---------------- | --------------------- | -------------------------------- |
| Monitor candle   | 最新观察              | single-flight/latest-only        |
| Monitor task     | 业务事项最新安排      | 同 key 可替换，版本失效          |
| Buy task         | 已获准的顺序意图      | FIFO，不能擅自丢弃               |
| Sell task        | 已获准的顺序意图      | FIFO，不能擅自丢弃；执行前仍复核 |
| Order fact       | 权威事实              | 保序、不得丢失、单订单串行       |
| Snapshot refresh | canonical read/commit | 单飞、合并、generation 校验      |
| Time wakeup      | 系统时点              | one-shot，持有下一时点           |

### 11.3 不新增未经业务确认的容量策略

架构可以增加观测：

- queue depth；
- oldest task age；
- refresh wait duration；
- order fact lag；
- seat activation duration。

但不能直接加入：

- 买卖队列满时丢弃任务；
- 用 latest-only 替代 BUY/SELL FIFO；
- 统一超时后重试下单；
- 用队列积压自动改变风险策略。

这些都需要业务政策确认，当前设计不擅自改变。

---

## 12. 与 `backtest-kit` 的借鉴关系

### 12.1 可以借鉴

| `backtest-kit` 设计 | 当前采用方式 |
| --- | --- |
| Schema/Connection/Client 分层 | Definition/Factory/Runtime 分离，减少实例创建散落 |
| DI container 与 scoped context | 显式 factory 注入；只对一次执行/工作流使用局部、显式传递的上下文，不把关键业务 token 隐藏在 ambient context 中 |
| 版本与执行 token | 显式传播 `dayEpoch`、`seatVersion`、`settlementVersion`、`snapshotGeneration`；不额外引入统一 `mode` 作为业务主轴 |
| 语义事件通道 | 分开 Gate、Command、Fact Event、Notification，不建立万能或跨进程 EventBus |
| 生命周期清单 | composition root 内静态 runtime checklist，校验资源覆盖和顺序；不建立动态 registry、跨进程协调或多进程运行模型 |
| Exchange/adapter 边界 | Longbridge SDK 只在 infrastructure/adapter 侧映射 |

### 12.2 不采用

- 全局 `backtest` service locator；
- 模块级共享 schema registry；
- 将所有业务状态放入一个 `ClientStrategy`；
- 用通用 signal lifecycle 代替 seat/order/liquidation workflow；
- 将回测/live 运行模式抽象成当前交易系统的唯一主轴；
- 把所有事件放进一个无语义总线。

当前策略已经通过 `prepareStrategy` 做免注册动态加载，不需要为解决耦合再引入策略注册中心。

---

## 13. 渐进实施计划

### Phase 0：冻结行为基线

目标：只增加保护网，不改变业务。

工作：

- 固定普通 BUY/SELL、换标、保护性、末日、订单恢复、金额修正测试。
- 按 §8.4 冻结数值转换位置；独立十进制库版本/配置须通过买量、距离、日损益与 progress/baseline 差分后锁定，见实施计划 P0.4 / §13.4.2。相关新层消费前完成承接，不能把该保护推迟至 P4。
- 冻结目标目录、模块迁移映射、允许依赖和阶段截止；对现存违规记录精确基线例外，禁止新增传播，随对应切面完成删除例外。
- 增加架构扫描：禁止新的 domain/application 代码直接 import Longbridge，包含 type-only 依赖；不能只检查最终尚不存在的目录。
- 记录现有 freshness、seat activation、lifecycle 顺序，并独立登记旧非 SDK 装配依赖边及删除阶段；最终层矩阵不直接阻断未迁移 owner 的既有 app 装配，搬入新层不能继承旧例外，详见实施计划 §5.1。
- 增加关键运行指标但不改变策略。

验收：

```text
bun format
bun lint
bun type-check
# 然后运行该切面相关的 bun test <测试文件/目录>；跨核心链路收尾运行全套
```

以及新增关键路径测试全部通过。

### Phase 1：建立 SnapshotCoordinator

目标：先闭合已确认的旧响应覆盖与 API/在线结算重复经济投影问题。

工作：

1. 在 `src/application/accountPositionSnapshot/` 新增完整 canonical snapshot owner。同步闭合账户/持仓内部模型、窄 read port 及必要 SDK mapper；不得等 P4 才消除新 application 的 SDK DTO 依赖。仅前置本纵切所需适配，不夹带整个 Trader 重写。
2. 迁移 `refreshHelpers` 的账户/持仓写入；同步闭合 §9.2 的早期订单栅栏与跨入口经济投影幂等最小切片，当前来源中的订单存储/结算契约可先修改，完整 orderTracking 迁移不提前塞入 P1，也不能成为推迟正确性修复的理由。
3. 迁移 `createPostTradeConsistencyRuntime` 的写入。
4. 在 startup/open rebuild 现存链路迁移 snapshot 写入与读取，不将完整重建用例提前塞入 P1；完整 owner 在 P5 闭合，P3C 先完成受控 activation 门禁接入。
5. 删除 time-wakeup 的 submit UNKNOWN 专属重读及重评估分支，向上抛出原错误进入既有 fatal/cleanup。
6. 将 midnight clear 改为 coordinator 的 day clear。
7. 从 LastState 移除账户/持仓可写字段和 positionCache mutation 能力，所有消费者切换到 snapshot 只读能力；其余字段按真实 owner 保留，不设双存储或临时镜像。
8. 删除 doomsday 对 canonical positions 的乐观过滤，保留 account invalidation；已确认订单复用既有 tracking/terminal 链路防重，submit UNKNOWN 按 §6.6 直接 fatal，不新增 overlay。

验收：

- 旧 generation 响应无法提交；
- API 订单列表与实际消费覆盖同段提交；同单晚到 WS/query 不重复投影，OPEN partial 不虚标已消费，同量金额修正与终态资源收尾不被去重吞掉；
- `commitRevision` 单调；
- 账户/持仓双读失败不会提交半个快照；
- seat refresh 不改变 settlement stale；
- 末日提交不导致 positionCache 提前 flat；
- 现有 SELL freshness 语义不变。

Phase 1 是一个不可拆开的正确性纵切：上述全部 writer、消费者、失效登记、跨入口订单经济投影幂等、pending settlement 投影 token 校验和末日 projection 必须同时接通后才能合入；不交付仍有旁路写入的半成品。以下 Phase 2 只迁移职责归属和正式契约；Phase 3/4 迁移订单 owner 时继承并复验已建立的消费基线，不把关键安全协议推迟到下一阶段。

### Phase 2：拆分 Snapshot Commit 与 Settlement Ready

目标：明确 `waitForFresh` 语义，减少 post-trade runtime 的职责混合。

工作：

- 保留 `waitForFresh` 为唯一正式接口，直接迁移实现和调用方；
- 内部增加 snapshot commit receipt；
- 在 `src/application/postTradeSettlement/` 收口 subscription projection、protective completion、R1/N1 的业务顺序；运行调度归 runtime、app 仅组装。所需订单/行情/仓储窄契约和映射随本阶段完成；
- readiness token 关联 day epoch、settlement version、snapshot revision；
- 增加最终下单前 token 复核；
- 保持 completion persistence 顺序。

验收：

- raw snapshot 已提交但后置业务未完成时 SELL 仍等待；
- 新成交会使旧 token 失效；
- 日切会拒绝旧 waiter；
- 不出现 snapshot owner 等待自身 business ready 的环。

### Phase 3：迁移 Application Workflow 业务所有权

目标：让复杂业务有可审计的入口，每个已闭合 owner 直接进入 application/domain 目标目录，不先机械搬全部代码。

优先顺序：

1. 复核 P2 已完成的 `PostTradeSettlementWorkflow`，不重复建立 owner；
2. `ProtectiveLiquidationWorkflow`；
3. `SeatActivationWorkflow`；
4. `SeatSwitchWorkflow`；
5. `DoomsdayClearanceWorkflow`。

每个闭合切面直接迁移完成条件、状态和失败处理，同步更新物理归属、调用、事件和镜像测试，删除旧 runtime 中的业务实现。普通买卖、搜索和静态清仓等既有 owner 的归属迁移也纳入本阶段，具体顺序见实施计划；执行 port 和内部事实缺失时先完成其最小适配切片。若两个 workflow 分摊同一完成事务，先只建 PostTradeSettlement owner，将保护性 completion 作为内聚函数；不为名称齐全而拆分。

验收：

- 保护性清仓完成条件只有一个 application owner；
- 运行期席位激活只由一个 workflow 决定 ACTIVE；受控 rebuild/static bootstrap 依 §9.2 单独审计，不能成为运行期绕过入口；
- 周期/距离换标 policy 差异仍可独立测试；
- app/runtime 不再直接拼接完整业务完成条件。
- 静态 owner 与 §7.2.1 的共享合单隔离同时闭合：非 protective 新量不扩入 protective 旧单，先前合法 episode 仍能完成；所需内部事实/执行/恢复切片不能推迟至 P4。

### Phase 4：收口 Longbridge Adapter

目标：完成剩余 SDK 传播面收口；除 §7.2.1 明确登记的跨 protective 扩量修正及其他已列出的受控修正外，不修改交易政策。P1/P2/P3 已需要的窄契约和 mapper 必须提前随切面落地；以下是剩余能力的闭合顺序，不是所有适配能力的首次建立时间。

顺序：

1. 内部 `OrderCommand`、`OrderFact`、`PositionFact`、`AccountSnapshot`；
2. submit/replace/cancel port；
3. order query/push/recovery；
4. 补齐 P1 窄 read port 以外的 account/position 读取调用方和 adapter 生命周期归属；
5. 订单规则、业务执行/恢复与事件监听分别迁入 domain/application/runtime，清除原 core 的 SDK 依赖；
6. SDK 仅留 `src/infrastructure/longbridge/{trade,market}/`，quote adapter 独立于 Trade port；行情和寻标业务规则不得随 SDK 整块下沉。

验收：

- submit UNKNOWN 直接 fatal，不重试、不启动 UNKNOWN 专属查询或重评估；
- cancel ack 与 terminal 分离；
- 金额 revision 修正保留；
- §8.4 的混合数值语义及 §13.4.2（实施计划）的差分继续通过：十进制运算/比较/取整、原 number/string 转换位置和 V1 恢复协议均不退化；不声称完成全链路精度升级；
- 普通、换标、两类清仓和恢复链路均仍通过原测试基线。

### Phase 5：静态生命周期清单收敛

目标：减少新增 runtime 的多点清单维护，不引入动态生命周期框架。

工作：

- 在 P1 snapshot 安全切片和 P3C activation 接入基础上，完整迁移重建用例到 application/tradingDayRebuild、日切协调到 runtime/lifecycle，删除旧重建入口；不改变恢复/开门次序；启动初次重建由 `startupRebuild.ts::executeStartupRebuild` 独占，启动/终止协调分别落于 `runtime/lifecycle/{startupRuntime,terminationRuntime}.ts`，app 仅装配并 await 唯一 cleanup；
- 在 composition root 维护静态 checklist；
- checklist 校验 startup/midnight/rebuild/termination 的现有静态顺序和资源覆盖，不生成通用执行器；
- 保留当前特殊 lifecycle policy；
- 增加“每个 runtime 必须有 termination/cleanup 策略”的架构测试。

验收：

- 新增 runtime 在静态清单中集中声明能力并校验各具名路径覆盖；实际 startup/midnight/rebuild/termination 接线仍按既有不同策略维护，不能用一条注册替代真实编排；
- TimeWakeup 在交易关闭期间仍运行；
- stop/drain 顺序不回退；
- cleanup 失败仍保留首个 fatal。

### Phase 6：收窄其余公共契约并清除迁移残留

本阶段不是首次决定目录或首次分离业务 owner。P0 冻结目标，P1–P5 已闭合的切面直接落入目标位置；这里完成剩余模块的归属迁移，并清除生产 `src/core/`、`src/main/`、`src/services/` 的混合实现和空壳转发。

按最近共同父级拆分 `src/types/services.ts` 等其余宽契约。早期纵切所需的窄接口必须随对应阶段立即完成，不能拖到本阶段。每个被替换契约同步更新全部调用方并删除旧接口，不保留 re-export 或旧名委托。测试镜像目标目录，历史评估中的来源路径保留为证据，不误改成尚不存在的目标路径。

目录迁移必须体现真实职责拆分，不单纯按旧文件夹整块改名。每次移动必须伴随：

- import 影响检查；
- runtime owner 检查；
- 相关测试路径更新；
- 架构边界测试更新。

---

## 14. 测试与验证设计

### 14.1 Snapshot 一致性

必须覆盖：

1. seat refresh 旧读在成交后返回，不能覆盖新 position snapshot；
2. 启动/重建读取的旧 epoch 返回，不能恢复旧数据；
3. account 成功、positions 失败时不提交账户半快照；
4. positions commit revision 不倒退；
5. 过期 response 不触发 `onPositionsCommitted`；
6. 多个来源请求合并只产生允许数量的 broker read；
7. 新 settlement 不由旧 in-flight batch 满足，pending 合并不丢需求；
8. seat refresh 外部失败不改变 settlement stale；
9. day clear 后旧响应和旧 projection 全部失效。

### 14.2 Ready 语义

必须覆盖：

1. snapshot 已 commit，但 subscription projection 未完成时，SELL 仍等待；
2. protection completion persistence 失败时，不推进 cooldown、daily loss boundary 和 episode；
3. R1/N1 失败时不 mark ready；
4. 新 settlement 到达时，旧 readiness token 失效；
5. 多个 waiter 在新 settlement 期间都追到最新目标；
6. 日切 abort 只拒绝旧 waiter，不影响新 epoch baseline；
7. 不发生 coordinator self-await。

### 14.3 订单 port

必须覆盖：

1. 普通 BUY/SELL 与末日 submit `UNKNOWN` 均直接 fatal，不重提、不启动 UNKNOWN 专属读取或重评估，顶层按既有顺序 cleanup；
2. submit accepted 后本地记录失败，不重提原意图；
3. cancel acknowledged 不等于 canceled；
4. cancel 后仍有部分成交，最终按累计事实结算；
5. quantity 不变但 amount revision 更新；
6. 未知 SDK status fail-fast；
7. 映射前后保持 §8.4 的输入/转换语义；独立十进制计算与当前 SDK 基线差分等价，覆盖买量、回收价阈值、日损益及 progress/baseline 恢复，原始审计字符串不能替代这些检查；
8. order recovery 的缓冲回放和 pending-sell 对账不变。

§7.2.1 的目的隔离还必须用真实 static executor → shared order executor → order monitor/recorder → progress/episode 链路验证，不能 mock `executeSignals` 后只断言入口传入 `false`。仅 mock broker、行情、时钟及持久化 IO 边界，断言：

- 零成交 protective ELO + 静态新增量：不 `REPLACE`；可信取消并结算、重读可卖量后提交新 orderId，tracking/remark 非 protective；新单成交不产生 protective progress/episode。
- 旧单总量 1,500、已成交 500、剩余 1,000 + 静态新增 1,000：旧真实 partial fill 进入 progress，取消及新单成交后 protective 进度只属于旧单的真实成交；若无撤单窗口新增成交则为 500，完成时间不改为静态成交时间。方向最终空仓后，旧合法 episode 恰好完成一次，按原触发计数决定是否激活 cooldown。
- 撤单 ACK、查询仍 OPEN、缺少可信终态数量：本轮不改单、不新增委托、不清理静态买单记录；旧 tracking/progress 保持，后续权威终态到达后由原流程安全重评估。撤单窗口新增成交仍归旧 protective 单，重规划扣除真实已成交量。
- 恢复出的 protective ELO（零成交/部分成交、关联买单为空/非空）仍采用同一目的规则；不能把关联数量校验当隔离条件。普通非 protective ELO 的合法 `REPLACE` 仍通过。
- 完整启动恢复另验 loader 的 remark provenance、durable progress/completion 和 cooldown hydration；仅调用 order tracking 或 episode restore 的测试不能宣称覆盖该完整链路。单独零成交 protective 挂单不创建 episode；已有 progress + 零成交 protective 挂单继续阻止完成；缺失精确执行事实按既有协议阻断恢复。

### 14.4 席位和生命周期

必须覆盖：

1. seatVersion 变化使旧 activation 结果失效，且换标绑定/激活不重复 bump 或清理；
2. LONG 明确外部激活失败不修改 SHORT 当前 ACTIVE，不推进全局 settlement stale；
3. distance switch 可接管 periodic switch 的等待，但不破坏 policy；已提交 WAIT 在时段关门后仍有暂停/取消 owner；
4. 运行期 activation 按 §9.2 保序，订单预检或日损拒绝后无后续激活发布；
5. LONG 的旧 allOrders 等待期间 SHORT 新成交，旧响应不得抹掉其已确认日损；只变普通 commitRevision 不重拉订单；
6. 回补提交后 ACTIVATING 的 API 已投影同单 FILLED，账户/订阅等待期间同单 WS/query 晚到，数量、成本、日损与最终 R1/N1 只消费一次，tracking/hold/占用仍正常收口；
7. 重放相同已消费事实时，已被 SELL 消除的 BUY 不复活、已消费 SELL 不再次扣减；空投影仍保留消费证明，受控 rebuild 与缓冲回放共用合法基线；
8. OPEN partial 未被本地订单投影消费时不虚标覆盖，同量终态仍按原规则首次投影；同量高 revision 金额修正更新正确口径，不虚构成交数量推进、不改变原过滤规则；
9. 订阅 pending/失败或等待中身份失效时不发布新风险或 ACTIVE；所有派生发布前检查 token；
10. ACTIVE 后 retain 归属接棒、完整 await release 和主体/清理错误优先级保持；受控 rebuild/static 例外不能放宽运行期门禁；
11. 午夜清理中不再生成交易命令；
12. TimeWakeup 仍能安排 open rebuild；
13. startup 部分失败 cleanup 不遗漏已创建 runtime；
14. termination stop/drain 次序与当前协议一致。

### 14.5 架构静态检查

建议增加以下约束：

- `domain/**` 禁止 import Longbridge；
- `application/**` 禁止 import Longbridge；
- P1 后 `LastState.cachedAccount/cachedPositions` 和对外 `positionCache.update` 不存在；canonical 写入只在 snapshot owner 的私有 store 内，不把 LastState 留作内部镜像；
- 新增 runtime 必须在 composition root 的静态 lifecycle checklist 中声明；
- `TradeContext.new` 最终只允许 `infrastructure/longbridge/trade`，composition 不创建或传递 SDK context；迁移期仅保留 P0 登记的旧创建点至 P4，P1 read adapter 复用现存 context，不额外创建连接；
- 禁止业务模块 import 全局 service locator；
- `types/services.ts` 不再新增领域无关的大接口。

---

## 15. 运行观测与故障诊断

重构后必须能区分以下情况：

```text
snapshot request started
snapshot response accepted
snapshot response discarded: stale generation
snapshot commit revision
settlement stale version
settlement ready version
seat version invalidated
order submit unknown fatal
order terminal confirmed
liquidation completion committed
```

建议日志字段：

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
settlementVersion
orderId
```

指标：

- snapshot response discard count；
- snapshot refresh duration；
- settlement readiness duration；
- queue depth/oldest age；
- seat activation duration；
- unknown submit count；
- cancel acknowledgement-to-terminal duration；
- open rebuild retry count。

这些指标只用于诊断，不自动改变业务策略。

---

## 16. 非目标与明确不做的事情

本方案不包括：

0. 多进程部署、跨进程共享运行状态、分布式锁、leader election、跨进程幂等或 Redis/Mongo 运行时协调；当前进程重启仍通过既有 durable facts 和恢复流程重建状态。

1. 将当前系统迁移到 `backtest-kit`；
2. 引入通用多券商平台；
3. 一次性重写所有 `core/main/services`；
4. 将系统改造成完整 Event Sourcing；
5. 用统一风控替换普通 BUY、换标回补、保护性清仓和末日路径；
6. 把所有队列改为 latest-only；
7. 对未知下单结果增加自动重试；
8. 把所有事实放进一个超级 `TradingEngine`；
9. 为当前单策略动态加载路径增加全局策略注册中心；
10. 以时间戳或 source priority 伪装券商远程一致性；
11. 把测试回放结果直接等同于实盘成交结果。

---

## 17. 最终验收标准

重构完成的判断不应是“目录更像某个框架”，而应满足：

### 事实一致性

- 所有 canonical account/position 写入经过唯一提交 owner；
- 旧代次响应不能覆盖新事实；
- freshness 与 readiness 的版本含义明确且不混用；
- 本地 projection 不冒充 broker fact；
- API 重建与在线结算共享订单经济投影消费基线，列表与覆盖同段提交，同单重放不重复计量，合法金额修正和终态收尾不被去重屏蔽。

### 业务安全

- 普通买卖和换标回补的 policy 差异仍存在；
- submit UNKNOWN 按 §6.6 统一为直接 fatal；撤单 accepted、订单终态和金额修正语义不变；
- 保护性清仓持久化顺序不变；
- seat activation 和 lifecycle gates 不提前放行。

### 可扩展性

- 新的 refresh source 不需要直接写 LastState；
- 新的 execution backend 只实现 adapter port；
- 新的业务 workflow 有单一 application owner；
- 新的 runtime 有一次性生命周期声明；
- 最终 domain/application/runtime 及内部公共契约无 SDK 依赖，包含 type-only 引用；迁移期间的精确例外按阶段清零。
- 生产 `src/core/`、`src/main/`、`src/services/` 的职责全部按目标映射迁出，无旧实现、转发 façade 或新增混合模块；镜像测试及架构检查同步迁移。

### 可维护性

- 能从 workflow 入口找到完整业务完成条件；
- 能从 runtime descriptor 找到启动、跨日、终止和 cleanup 归属；
- 能通过日志字段还原事实版本、席位版本和 settlement 版本；
- 关键并发、恢复和失败边界有可运行测试。

---

## 18. 结论

当前项目的下一步不应是“换用一个框架”，而应是一次以事实所有权和业务 workflow 为中心的渐进式重构。

最优先的技术顺序是：

```text
冻结目标目录、职责映射与分阶段依赖约束
  -> 统一 canonical snapshot 提交（同步闭合所需窄 port/mapper）
  -> 分离 snapshot commit 与 settlement ready
  -> 独立 protection/liquidation projection
  -> 建立 application workflow owner
  -> 收口剩余 Longbridge adapter
  -> 集中声明 runtime 生命周期
  -> 清理其余宽契约和过渡目录残留
```

各切面在职责迁移时同步进入目标物理位置；最后一步不是首次落实分层，也不授权仅以改目录名宣告重构完成。

`backtest-kit` 对本方案的价值在于提供以下边界启发；其中生命周期清单与快照仲裁是本项目结合实际运行协议的设计，不声称由参考库直接提供：

- 静态定义和运行实例应分开；
- 连接/工厂边界有助于控制创建和依赖；
- 执行上下文应明确传播；
- Gate、Fact Event 与 Notification 不应混合；
- 状态机应尽量使非法状态不可表示；
- 组件生命周期可以在单进程 composition root 内用静态清单集中校验；
- single-flight、generation 和 shared promise 适合解决当前进程内的异步调度问题。

本次核查也明确删除了不必要的扩展设计：不新增统一 `RiskReservation` 服务，不建立动态 RuntimeDescriptor registry，不引入 Redis/Mongo 运行时协调，不把单进程 revision 扩展成分布式协议。

但当前项目必须保留自己的核心特征：

```text
事实驱动的订单状态
席位身份与激活屏障
按交易目的分离的 workflow
严格的清仓完成条件
明确的未知结果处理
不同生命周期阶段的异构启停顺序
```

这才是解决当前低扩展性和逻辑耦合问题的根本路径。

---

## 附录 A：闭合迁移清单与目标落地位置

以下为统一后的目标位置。原有路径只用于定位迁移来源，不授权在旧混合目录继续增加新 owner；不要求一次创建全部空目录。完整去向、阶段和测试镜像映射见实施计划第 4 节。

| 切面 | 目标 owner/位置（拟新增或迁入） | 必须同时修改的现有路径 |
| --- | --- | --- |
| 账户持仓事实 | `src/application/accountPositionSnapshot/`：完整 coordinator、私有 store/pump；对外只读 view 与 request capability | `src/types/state.ts`、`src/app/runtime/createPostGateRuntime.ts`、`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`、`src/main/lifecycle/cacheDomains/globalStateDomain.ts`、`src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts`、`src/main/timeWakeupEvaluationProgram/index.ts`、`src/core/doomsdayProtection/index.ts`、`src/app/runtime/createPostTradeConsistencyRuntime.ts` |
| 消费者与派生结果 | 原有 `positionCache` 查询能力收窄；业务 owner 持有 receipt，不持有 update | `src/main/asyncProgram/sellProcessor/index.ts`、`src/main/quoteSubscriptionRuntime/index.ts`、`src/main/monitorQuoteEventRuntime/`、`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts` 以及全部 LastState account/position 读取调用方 |
| 成交后业务 | `src/application/postTradeSettlement/`：承接业务完成条件和 readiness；runtime 调度、app 工厂仅组装 | `src/app/runtime/createPostTradeConsistencyRuntime.ts`、`src/core/trader/orderMonitor/settlementFlow.ts`、`src/utils/refreshGate/index.ts`、`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` |
| SDK trading adapter | `src/infrastructure/longbridge/trade/`；跨层窄契约放最近共同父级（必要时 `src/types/`），不 re-export | `src/core/trader/index.ts`、`src/core/trader/accountService.ts`、`src/core/trader/orderExecutor/submitFlow.ts`、`src/core/trader/orderMonitor/orderOps.ts`、`src/core/trader/orderMonitor/orderStatusQuery.ts`、`src/core/trader/orderMonitor/recoveryFlow.ts`、`src/types/services.ts` 及 SDK 类型调用方 |
| 席位用例 | `src/application/{autoSearch,seatActivation,seatSwitch}/` 承接用例，`src/domain/seat/` 承接身份与规则，scheduler/dispatcher 归 runtime | `src/main/seatActivationDispatcher/index.ts`、`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts`、`src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts`、post-gate 装配和生命周期清单 |
| 生命周期清单 | `src/app/lifecycle/` 中一份静态资源清单/校验器（单进程内） | `src/app/runApp.ts`、`src/app/runtime/createTerminationRuntime.ts`、`src/app/shutdown/createCleanup.ts`、`src/constants/cleanup.ts`、`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` |

目标层与 owner 归属是验收约束，不是可延期的目录美化；层内具体文件名按实际职责细化，不得创建空层或把纯计算包装成事件。所有工厂保持显式依赖注入：共享对象可一次绑定，但必须启动前绑定完毕、single-assignment、缺失立即失败。消除的是宽依赖和业务所有权混乱，不是为了消灭 late binding 强行制造全局容器。

每个切面合入前必须搜索全部读写/导出/配置/测试/文档引用。由于只有单进程，除静态调用方外不需要寻找跨进程消费者；但必须确认同进程内所有 runtime、queue handler、timer 和 cleanup owner：

- 原 `cachedAccount/cachedPositions` 直接赋值、`positionCache.update` 对外调用为零；初始化与日切只能由事实 owner 执行。
- snapshot 提交、settlement ready、运行期 seat ACTIVE、completion durable commit 各只有一个真实 owner；受控 rebuild/static bootstrap 的显式入口依 §9.2 审计，不能并发推进运行期激活。
- 旧 facade、旧别名委托、re-export 不存在；无需迁移的现有模块不顺手清理。
- SDK 收口不能只搜 runtime import，必须包含 type-only import、公共 DTO、枚举比较、Decimal 运算和策略 `Period` 契约。行情 Period 用内部周期标签映射，不改变一分钟线规则。
- startup recovery 继续先订阅/缓冲，再加载和恢复归属，再回放/对账进入 ACTIVE。实际 `recoveryFlow` 合并每单较新回报并按更新时间回放，不借本次重构擅自改成“全部按接收顺序”。

### A.1 纵切合入与失败处理

没有双写灰度或两套订单 owner 并行运行。每个切面代码可分开发提交，但只有旧路径全部替换且关键测试通过后才作为可运行版本交付。失败的开发切面回退代码，不回滚已经发生的券商动作或日志事实。生产升级需先用原终止流程完成 drain，再启动新版本执行原恢复链路；不设计运行中热替换。本文不变更 durable log 格式，已有事实恢复协议必须持续可读。

所有策略定义只加载显式选中的模块；跨日重置同一策略实例，最终终止才 destroy。只读 RuntimeClock/RuntimeScheduler 继续显式注入；关键业务 token 不隐藏在 ambient context 中。单进程场景下，各资源按原有归属和生命周期显式组装；不新增 reservation state，不把不同用途的 scheduler 合并为一个全局调度器，也不需要跨进程同步版本或分布式缓存。

## 附录 B：验证矩阵及证据索引

### B.1 关键新增检查（不以覆盖率为目的）

| 检查 | 可控时序 | 必须断言 |
| --- | --- | --- |
| batch 冻结 | position-only 在途后入队 account+positions | 后者不由已发读批次 resolve；后继成对读取 |
| 过期错误优先级 | 旧 batch 已失效后返回内部契约错误 | 仍进入 fatal/首错路径，不被 supersession 吞掉；成功或预期外部错误才按后继协议处理 |
| 真实 single-flight | account 已失败，positions 尚 pending | 不 commit、不提前 drain、不发并行 canonical batch |
| 跨成交旧读 | seat read 开始后登记成交失效 | 旧响应丢弃，需求可转后继，seat 外部失败次数不增加 |
| 派生结果失效 | r10 commit 后 await；r11 commit；r10 返回 | 无旧风险写回/旧 completion；同一 settlement 可在当前 revision 完成 |
| 非 settlement 提交 | 已 ready 后 seat 新 commit | 不增加 settlement stale；旧选单复核，不永久 wait |
| 取消隔离 | LONG seatVersion 改变，共享批次有其他参与者 | 只取消 LONG waiter，其他结果不丢失 |
| 日切与自等待 | TimeWakeup evaluate 触发 midnight，期间有刷新 | 旧 epoch 结果无效；TimeWakeup 不等待自己 drain |
| 部分启动失败 | 第二/第三资源构造失败或收到 fatal | 已取得资源恰好释放一次，未启动者不再启动 |
| 清仓目的隔离 | protective ELO 零成交/部分成交/恢复后遇到静态新增量；仅撤单 ACK 与可信终态分别控制 | 非 protective 新量不 `REPLACE` protective 旧单；新单成交不推进 protective progress；未获可信终态不重提或清理买单记录；旧合法 episode 可按真实执行时间完成；不伪造持仓 flat |
| SDK 错误等价 | 602013、order-closed 查询仍 OPEN、query 外部失败、DTO TypeError | 原重试/查询 owner 不变；内部契约错误仍 fatal |

现有测试优先扩展，而非复制：

- `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`：snapshot/ready、durable completion 顺序。
- `tests/core/trader/submitFlow.errorClassification.business.test.ts`：未知 submit 与已接受后的本地失败。
- `tests/core/trader/orderMonitor/terminalSnapshotFacts.business.test.ts`、`tests/core/trader/orderMonitor/ordinaryRawExecutionFacts.business.test.ts`：累计事实与终态。
- `tests/main/monitorQuoteEventRuntime/staticLiquidationExecutor.business.test.ts` 仅为静态入口基线，其 `executeSignals` 替身不覆盖共享合单；新增目的隔离场景必须放 `tests/integration/` 并连接 §14.3 的真实模块。普通 `REPLACE` 可复用 `tests/core/trader/finalQuoteMutationPermit.business.test.ts` / `tests/integration/sellFlow.integration.test.ts`；完整恢复结合 `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`，随 owner 迁移更新镜像路径。
- `tests/app/runApp.business.test.ts`：启动待恢复与 TimeWakeup。
- `tests/architecture/importBoundary.test.ts`、`tests/architecture/strategyBoundary.test.ts`、`tests/architecture/typeOrganization.test.ts`：依赖和类型组织边界。

实施时新增 snapshot coordinator 的专属 deferred-request 测试；其余按实际切面扩展既有测试。修改代码后按项目要求 `bun format → bun lint → bun type-check`，再运行相称业务检查；检查通过后无新改动/失败/疑点不重复扩大验证。

### B.2 本地证据

以文件路径和行为为主，行号仅表示本次基线定位：

| 证据 | 定位 |
| --- | --- |
| 席位直接写账户/持仓 | `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:49–61` |
| 成交后双读、提交、后置业务与 markFresh | `src/app/runtime/createPostTradeConsistencyRuntime.ts:415–493` |
| completion 先持久化后提交内存 | 同上 `:194–229` |
| freshness 追最新 stale 高水位，不是快照租约 | `src/utils/refreshGate/index.ts:40–160` |
| 末日乐观删除持仓及清买单副作用 | `src/core/doomsdayProtection/index.ts:472–546` |
| 启动双读与清理 | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:180–196`；`src/main/lifecycle/cacheDomains/globalStateDomain.ts:25–33` |
| 跨日停止/重建与基线 | `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:77–133` |
| submit 未知结果分类 | `src/core/trader/orderExecutor/submitFlow.ts:121–164,419–580` |
| 换标实际卖出金额决定回补 | `src/services/autoSymbolManager/switchStateMachine.ts:1035–1045,1215–1242` |
| SDK cancel/replace 特殊错误处理 | `src/core/trader/orderMonitor/orderOps.ts:502–612` |
| 静态 false 不足以隔离共享 REPLACE | `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:110–114`；`src/core/trader/types.ts:415–426`；`src/core/trader/orderMonitor/index.ts:552–585`；`src/core/trader/utils.ts:160–226`；`src/core/trader/orderExecutor/submitFlow.ts:724–833` |
| 旧单身份及累计 progress 保留 | `src/core/trader/orderMonitor/orderOps.ts:661–724`；`src/core/trader/orderMonitor/settlementFlow.ts:224–276,345–444`；`src/core/trader/protectiveLiquidationEpisodeTracker/index.ts:44–109` |
| 恢复 tracking 与精确 episode 不等价 | `src/core/trader/orderMonitor/recoveryFlow.ts:293–363`；`src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:308–545` |

assessment 附录 C 的 200→100 覆盖探针是**既有评估证据**，本轮未重跑。本文新增的状态机、token 和 adapter 契约均为设计，不是已验证实现。

### B.3 远端参考（固定 commit）

- [注册/定义入口](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/function/add.ts)
- [StrategySchemaService](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/lib/services/schema/StrategySchemaService.ts)
- [StrategyCoreService](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/lib/services/core/StrategyCoreService.ts)
- [StrategyConnectionService](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/lib/services/connection/StrategyConnectionService.ts)
- [ExchangeConnectionService](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/lib/services/connection/ExchangeConnectionService.ts)
- [ClientStrategy：不照搬的大型运行态实现](https://github.com/tripolskypetr/backtest-kit/blob/4c5f3c668798a594dcfe4e004466bdc55680f104/src/client/ClientStrategy.ts)

本方案仅采用定义/实例/依赖边界的设计启发。生命周期清单和快照仲裁是针对本项目的设计，不声称是远端库直接提供的能力。

## 附录 C：本次交付范围

仅新增本设计文档；没有修改交易实现、运行交易测试、连接 Longbridge 或验证实盘时序。完成了事实、执行与 SDK、席位生命周期三组源码分析及独立设计审查，并据审查修订 batch 状态机、投影版本协议、末日副作用归属、同步停止/异步 drain 和闭合迁移要求。真正实施的完成条件仍以各 Phase 验收为准。
