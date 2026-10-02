# 当前项目架构层面分析与重构前确认结论

> 本文是重构前的架构参考结论，不提供解决方案、重构方案或代码改造步骤。
>
> 评估日期：2026-09-27  
> 评估基线：`a2f0ca972695e7cc1a7a21555bc87d46df98ce4d`  
> 工作区说明：评估开始时已存在未由本次任务产生的暂存变更 `docs/plans/intradayRegressionThreePriceBacktest.md`；本报告未读取、未修改该文件。

---

## 1. 结论摘要

### 1.1 总体 verdict

当前项目的**目录结构和主要功能划分总体合理，已经形成了面向实时交易系统的事件驱动架构**；它不是简单的策略脚本、定时轮询器或把所有逻辑堆在一个 Trader 类中的实现。对当前明确产品范围——**单监控标的、单活跃策略、Longbridge 单券商、港股日内实盘、带启动恢复和跨日重建**——架构基本能够表达真实业务边界，并且已有较强的交易安全意识。

但是，当前架构还不能被确认是“低耦合、边界完全清晰且通用完善”的量化交易平台架构。主要原因不是目录数量不足，而是以下结构事实：

1. `LastState` 是跨 `app`、`main`、`core` 的可变共享状态，账户/持仓快照存在多个异步写入 owner；不同刷新链路之间没有共同版本仲裁。已通过最小运行探针复现“较旧持仓响应晚返回并覆盖较新缓存，成交 freshness 仍为 fresh”的应用层路径。
2. `core` 名义上是核心业务层，但订单执行、订单记录、末日保护、风险状态和策略公共类型仍大量直接依赖 Longbridge SDK；因此 `core` 不是独立于券商基础设施的纯业务核心。这是确定的适配耦合，不是单券商产品的功能缺陷。
3. 目录与职责并非一一对应：`app/runtime/createPostTradeConsistencyRuntime.ts` 实际执行保护性清仓完成、日内亏损分段和冷却推进；`services/autoSymbolManager` 实际承担交易工作流。理解一个完整业务域，必须跨 `app/main/core/services` 追踪。
4. 启动、跨日恢复、快速停止和最终 cleanup 由多处显式清单协同维护。当前没有发现已确认遗漏，但新增运行时所需的多点同步成本确实存在。
5. 普通买入与换标回补的风控集合不同，监控任务跨类型串行，买卖 FIFO 无显式容量上限，普通审计采用同步持久化。这些都是确认的运行边界；其中是否存在政策违规或性能不足，需要业务政策或负载证据，本报告不将其一律列为已确认缺陷。

因此，最终判定为：

> **当前架构对当前产品范围基本合理，主要运行链路已有较完整的自动化验证；但低耦合程度不均衡，共享事实一致性存在可复现的应用层缺口，SDK 依赖与跨目录职责使变更传播面较大。不能仅凭目录整齐、使用接口或测试全通过，就认定整个架构已经低耦合且没有重要风险。**

### 1.2 问题等级说明

本文区分三类结论：

- **架构问题**：有具体一致性缺口或明确的职责理解/变更传播成本；问题及其影响分别取证。
- **结构边界/设计取舍**：事实确定存在，但在当前产品范围内不必然错误，例如绑定单券商、不同交易目的使用不同检查、串行处理任务。
- **潜在运行影响**：调用链可达，但真实外部时序、负载或业务政策尚未验证；不声称线上已经发生。

`major/minor` 仅用于已经取证的问题或明确说明的维护性限制；不是对全部设计差异的故障评级。

当前未发现已确认的静态运行时循环依赖，也未发现当前测试证明的业务回归。

---

## 2. 评估范围与方法

### 2.1 实际检查范围

检查了以下范围：

- `src/index.ts`
- `src/app/`：启动、运行时组装、生命周期组装、终止和 cleanup
- `src/main/`：时间唤醒、行情事件、业务事件、异步队列、席位激活与清理、跨日生命周期、行情订阅
- `src/core/`：策略、信号、风险、订单记录、订单状态生命周期、交易执行、订单监控、末日保护
- `src/services/`：行情客户端、自动寻标、自动换标、清仓冷却、交易日志仓储
- `src/types/`、`src/constants/`、`src/utils/`
- 对应 `tests/architecture/`、`tests/app/`、`tests/main/`、`tests/core/`、`tests/integration/` 等测试
- `README.md` 中声明的系统范围与运行流程
- 官方开源项目架构资料：vn.py、QuantConnect LEAN、NautilusTrader

按项目规则，未扩展读取无关的 `tools/` 和历史 `docs/` 内容。

### 2.2 静态规模与依赖统计

以当前工作区 `src/**/*.ts` 静态扫描结果为准；行数按文本换行统计，包含注释、空行和文件尾空行，不是有效代码行数。文件数量与行数只描述规模，不作为架构优劣评分：

| 目录            | TypeScript 文件数 | 代码行数约计 | 架构观察                                   |
| --------------- | ----------------: | -----------: | ------------------------------------------ |
| `src/index.ts`  |                 1 |           31 | 薄入口                                     |
| `src/app`       |                20 |        3,722 | 组装、启动、生命周期、成交后业务收尾和终止 |
| `src/config`    |                11 |        2,105 | 配置读取、解析、验证                       |
| `src/constants` |                 3 |          515 | 常量与运行时协议常量                       |
| `src/core`      |                84 |       22,823 | 策略、风控、订单记录、交易执行与监控       |
| `src/main`      |                73 |       13,069 | 事件运行时、队列、时间唤醒、生命周期协调   |
| `src/services`  |                28 |        8,433 | 外部行情、寻标/换标、交易日志、冷却等服务  |
| `src/types`     |                14 |        2,687 | 跨模块公共契约                             |
| `src/utils`     |                28 |        3,061 | 通用工具与若干业务辅助边界                 |
| **合计**        |           **262** |   **56,446** | 不包含测试、mock 与工具文件                |

另有：

- `tests/` 共 187 个 `*.test.ts` 文件，206 个 TypeScript 文件（包含 setup/helper 等）。
- 生产源码直接导入 `longbridge` 的 import declaration 共 51 个文件，其中 runtime import 31 个、type-only import 20 个。
- 静态运行时 import 图未发现多文件环。扫描采用 TypeScript AST、解析相对静态 import/export、排除声明级 `import type`；不是对动态加载、闭包对象互相引用或异步等待环的证明。
- 直接导入 `LastState`、`MonitorContext`、`Trader`、`MarketDataClient` 符号的生产文件数量分别为 21、27、21、27 个。统计按导入符号去重计文件，不代表这些模块都读写所有字段；高扇出接口本身也不是缺陷。
- import 方向总体稳定：`app → main` 为 30 条运行时/21 条类型导入，`app → core` 为 13/8，`app → services` 为 10/5，`main → core` 为 10/13，`main → services` 为 7/8。`core/services/utils/types → app/main` 未发现静态导入；`constants/cleanup.ts` 对 app cleanup 类型有类型依赖，不构成运行时回环。
- 没有静态导入环，不等于没有对象协作环：`createPostGateRuntime.ts:307-320,369,431,477-484` 使用一次性绑定衔接 Trader、成交后刷新、订阅 runtime 和 MonitorContext，说明这些对象存在真实的双向协作关系。绑定具有未初始化读取和重复绑定的 fail-fast 保护。

### 2.3 验证结果

本次评估运行了与架构结论直接相关的检查：

- `bun run type-check`：通过。
- `bun run lint`：通过。
- `bun test`：**1992 pass，0 fail，187 files**。
- 架构、app、integration 子集：**353 pass，0 fail**。
- 额外通过 `bun -e` 调用真实 `createRefreshHelpers`、`createPostTradeConsistencyRuntime` 和 `createPositionCache`，注入 deferred Trader 响应执行双 owner 探针：较新的成交后刷新先提交 `quantity=200`，较旧的席位刷新请求随后提交 `quantity=100`，最终共享 `positionCache` 被覆盖为 100；前后 `currentVersion=staleVersion=1`，fatal 列表为空。只替换外部事实和无关协作者，未修改源码、未访问券商、未持久保存测试文件；可复核时序详见附录 C。这证明应用层接收乱序响应时的行为，不代表真实 SDK 已发生同样时序。
- 未执行会写入全仓的 `bun format` 或 `lint:fix`；只读分析不要求自动改写代码。

---

## 3. 当前架构的实际形态

### 3.1 顶层不是简单的分层架构，而是“组装层 + 业务核心 + 运行时编排”混合形态

当前顶层目录可以概括为：

```text
src/index.ts
  -> app/                 组合根、启动、终止、生命周期装配
  -> main/                运行时编排、事件 owner、队列、唤醒与恢复协调
  -> core/                策略、信号、风控、订单记录、交易执行、订单监控
  -> services/            外部服务适配及席位/寻标/交易日志等应用服务
  -> config/              配置边界
  -> types/               跨模块公共契约
  -> constants/           全局协议与业务常量
  -> utils/               通用工具及部分局部业务辅助
```

这不是严格意义上的 Clean Architecture 或 Hexagonal Architecture：

- `app` 以 composition root 为主，但也实际持有成交后业务收尾 runtime，不是纯装配层。
- `main` 是应用运行时编排层，负责将事件、定时唤醒、任务队列和业务 owner 接起来。
- `core` 同时包含领域规则和券商 SDK 交互相关的执行基础设施。
- `services` 同时包含外部 API 适配器和自动寻标/换标这类具有明显业务状态的应用服务。
- `types/` 提供跨层公共契约，但其中 `services.ts` 同时承载市场、订单、交易、风险、Trader 和运行时 port，公共面较宽。

所以，目录名本身不能简单解释为“上层 app、下层 core、最底层 services”。真实依赖方向更接近：

```text
app
  -> main / core / services / config / utils
main
  -> core / services / utils
core
  -> types / utils / constants / Longbridge SDK
services
  -> types / utils / constants / Longbridge SDK
utils
  -> types / constants / Longbridge SDK（少量）
```

这是一种可以支撑单进程实时交易的应用架构，但不是完全解耦的领域层架构。

### 3.2 `runApp` 是有效的 composition root

`src/app/runApp.ts:106-335` 明确表达了：

1. 选择并准备策略。
2. 创建 pre-gate runtime。
3. 创建 post-gate runtime 和共享状态。
4. 加载启动快照并进行运行时标的验证。
5. 创建交易日重建函数、异步 runtime、业务事件程序和生命周期 runtime。
6. 根据启动重建结果启动或阻断各个运行时。
7. 启动一次性时间唤醒，最后等待 termination。
8. 通过统一 cleanup 按阶段停止资源。

这部分是当前架构最清晰的区域之一。外部依赖通过 `runAppDeps`、runtime factory 和参数注入进入，生产组装点集中，测试也有对应的 wiring 测试。

需要注意的是，composition root 清晰并不意味着所有下层模块低耦合；它只是把依赖和生命周期的最终组装位置收口了。

### 3.3 事件驱动和 one-shot 唤醒边界基本合理

当前系统不是一个固定间隔扫描所有业务的循环，而是多个具有明确 owner 的运行时：

- `BusinessEventProgram`：监控 K 线、策略推进、普通信号输出。
- `MonitorQuoteEventRuntime`：监控标的 quote、距离换标或静态清仓。
- `TradingRiskEventRuntime`：交易标的 quote、浮亏保护性处理。
- `TimeWakeupRuntime`：交易时段、开盘保护、末日窗口、生命周期和 API 重评估。
- `AutoSearchWakeupRuntime`：空席位寻标。
- `PeriodicSwitchWakeupRuntime`：周期换标。
- `SwitchWakeupRuntime`：换标等待后的继续推进。
- `QuoteSubscriptionRuntime`：订阅集合的汇总和串行变更。
- `PostTradeConsistencyRuntime`：成交后账户/持仓/freshness/风险后置刷新。
- `OrderMonitor`：订单回报、成交、撤单、超时和补单。

`src/main/businessEventProgram/index.ts:1-157` 的 single-flight/latest-only 语义，以及 `src/main/quoteSubscriptionRuntime/` 对订阅 mutation 的统一持有，均显示出较好的异步边界意识。

---

## 4. 顶层目录和职责划分评价

### 4.1 `app/`：合理且必要，但生命周期清单存在维护耦合

**评价：合理。**

`app/` 的顶层主要负责应用装配。`createPreGateRuntime`、`createPostGateRuntime`、`createAsyncRuntime`、`createLifecycleRuntime` 等工厂使初始化顺序显式可见。但它不是纯组装目录：`createPostTradeConsistencyRuntime.ts:180-227,237-285` 直接决定保护性清仓完成、持久化完成边界、推进亏损分段/冷却并刷新浮亏。因此，`app` 内已经存在业务用例 owner；这与“应用组装层”的单一目录说明不完全一致，详见 5.6。

**确认的限制：**

- 初始化启动顺序在 `src/app/runApp.ts:310-335`。
- 跨日重新启动顺序在 `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:77-133`。
- 最终终止的快速 stop 列表在 `src/app/runApp.ts:75-103`。
- 各资源的完整 drain 又分别在 `src/app/runtime/createAsyncRuntime.ts:63-112`、`src/app/runtime/createPostGateRuntime.ts:330-366,559-562` 等创建处注册。

当前逐项比对未发现明确的运行时 owner 遗漏，且全量测试通过。因此这里不是当前故障，而是**同一资源的启动、跨日停止、进程终止快速停产和 cleanup 注册分散在多个位置，新增运行时时容易出现维护漂移**。

**结论：**组合根位置正确，但 app 的实际职责超出纯装配；生命周期编排的集中度中等，维护耦合已经存在，不能据此推断当前已有启停遗漏。

### 4.2 `main/`：运行时职责清晰，但编排层与业务服务存在较强连接

**评价：总体合理，但属于高编排耦合层。**

`main/` 的职责不是单一业务领域，而是运行期协调。它需要同时知道行情、席位、策略、Trader、队列、生命周期和清理，因此天然会有较多依赖。

正向事实：

- `main` 不反向依赖 `app`，已有 ESLint 架构规则和测试约束。
- 事件 owner 大多提供 `start`、`stop`、`stopAndDrain`，生命周期语义相对完整。
- 任务处理前普遍校验席位版本、标的和生命周期门禁。

结构性限制：

- `buyProcessor`、`sellProcessor` 和 `autoSearchWakeupRuntime` 直接使用 `services/autoSymbolManager/utils.ts` 的函数级辅助能力；当前没有发现循环依赖或运行错误，但服务内部路径变化会传播到多个主层运行时。
- 席位搜索、周期换标、距离换标、激活和清理之间通过 seat version、monitor task 协议、WAIT wakeup 结果和 app 装配中的 handoff 连接，连接是显式的，但不是低耦合的。

**结论：**`main` 是清晰的应用编排层，但不是纯粹的事件总线；它承载了较多用例协调逻辑，因此复杂度和变更传播面都较高。这在当前交易业务范围内基本合理。

### 4.3 `core/`：领域规则丰富，但“核心层”与 SDK/infrastructure 混在一起

**评价：业务逻辑集中度高，但抽象边界不完整。**

`core/` 内部的子领域划分是可辨识的：

- `strategy/`
- `signalProcessor/`
- `riskController/`
- `orderRecorder/`
- `orderStatusLifecycle/`
- `trader/`
- `doomsdayProtection/`

尤其是 `trader/` 已经进一步拆成 account service、order cache、order monitor、order executor、hold registry 等子模块，明显优于大一统交易类。

但 `core/` 不是券商无关的领域核心。当前直接依赖 Longbridge 的生产文件包括：

- `src/core/trader/index.ts:20,78`：直接导入并创建 `TradeContext`。
- `src/core/trader/orderExecutor/submitFlow.ts:9`：直接使用 `OrderSide`、`OrderType`、`TimeInForceType`、`TradeContext`。
- `src/core/trader/orderMonitor/eventFlow.ts:9`、`recoveryFlow.ts:9`、`settlementFlow.ts:9`：直接使用 SDK 订单状态和推送类型。
- `src/core/orderRecorder/orderApiManager.ts:9`、`orderOwnershipParser.ts:11`、`utils.ts:1`：直接使用 SDK 订单类型和方向。
- `src/core/doomsdayProtection/index.ts:17`：直接使用 SDK 订单方向和类型。
- `src/core/riskController/dailyLossTracker.ts:7`、`utils.ts:1`：直接使用 SDK 订单事实。
- `src/core/strategy/types.ts:1`：策略公共快照契约直接使用 SDK `Period`。

这不是少量边缘 adapter，而是订单、风险、策略契约的多个核心路径都接触 SDK。

**结论：**若“core”只表示当前应用的核心业务代码，该命名和放置可以工作；若期望它成为可替换券商、可复用回测、可插拔 execution backend 的独立核心，则当前边界不成立。当前项目 README 明确是 Longbridge 单券商产品，因此这属于**已确认的低耦合不足和扩展性限制**，不等于当前单券商运行必然错误。

### 4.4 `services/`：外部服务和业务应用服务均有合理边界，但不是纯 infrastructure 层

**评价：大体合理。**

以下边界清晰：

- `quoteClient`：Longbridge 行情 API、订阅和缓存标准化。
- `mixedTradeLogRepository`：交易日志和保护性清仓恢复事实的持久化。
- `autoSymbolFinder`：候选列表请求、缓存、筛选和排序。
- `autoSymbolManager`：席位生命周期、换标状态机和业务推进。
- `liquidationCooldown`：清仓冷却事实和恢复。

`autoSymbolManager` 跨越“寻标—换标—移仓—回补—等待—激活”多个阶段，但这些阶段都围绕席位生命周期，不是无关职责混入；因此不能仅因文件较大或流程复杂判定为错误拆分。

其主要结构问题是：它在形式上位于 `services/`，实际承担很重的应用领域状态机，并依赖 `Trader`、`OrderRecorder`、`RiskChecker`、行情和席位注册表。这使它并非可替换的简单外部服务，而是**交易用例服务/领域协调器**。

**结论：**职责可读且现实，但目录层含义不完全准确；服务层与领域编排层之间存在中等耦合。

### 4.5 `types/`：有契约意识，但公共面过宽

`src/types/services.ts` 约 1,074 行，集中定义：

- Longbridge 订单枚举和验证后的订单类型。
- `MarketDataClient`、`MarketQuoteContext`。
- `OrderRecorder`、`Trader`。
- `RiskChecker`、`PositionCache`。
- `OrderStateChangedEvent`、`PostTradeConsistencyRuntimePort`。
- 自动寻标、风险和交易相关结构。

优点是接口契约明确，跨模块依赖可以通过 type/interface 注入，不必依赖具体实现。限制是多个领域的公共能力集中在同一文件及同一公共类型域中，导致 `Trader`、`MarketDataClient`、`OrderRecorder`、`RiskChecker` 等成为高扇出的跨层连接点。

**结论：**类型层比直接共享实现好，但当前公共契约面仍然较宽，不能判为低耦合类型边界。

### 4.6 `utils/`：大部分通用工具合理，部分目录已经是业务辅助模块

`utils/` 包含时间、定时器、错误、日志、行情重试、席位快照、持仓缓存等。很多模块符合纯函数和窄职责要求。

但 `utils/seat`、`utils/trading`、`utils/refreshGate` 等已经携带明显业务语义，尤其是被 `main`、`core` 和 `services` 共同依赖时，它们实际承担跨层协议作用。将其全部理解为“无业务规则的通用工具”并不准确。

**结论：**目录可用，但 `utils` 中存在跨层业务协议，属于中等隐式耦合来源；没有证据表明这已经造成当前运行故障。

---

## 5. 逐项复核：架构问题、结构限制与设计取舍

确认问题与边界不可混为一谈：5.1 是可复现的一致性缺口；5.2、5.6、5.7 是适配/职责/维护方面的结构限制；5.3—5.5 是经核对的运行边界，不据此认定政策违规或生产故障。

## 5.1 重要：共享持仓事实存在多个异步写入 owner，缺少跨 owner 版本仲裁

**级别：major，已确认可达的架构竞态风险。**

### claim

账户/持仓快照同时由席位刷新、成交后一致性刷新、时间唤醒末日刷新、启动/跨日重建等多个链路直接写入同一 `LastState`。这些链路各自有局部的 single-flight 或版本语义，但没有覆盖所有 owner 的共同提交序列、版本比较或 CAS。较旧请求晚返回时，可以覆盖较新的共享持仓缓存。

### evidence

- 可变共享状态定义：`src/types/state.ts:26-70`；`cachedAccount`、`cachedPositions` 属性可写，`positionCache` 引用是 `readonly`，但其公开 `update()` 可变更内部持仓。不能把 readonly 引用误当作只读状态。
- 席位刷新直接写入：`src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:49-61`。
- 成交后一致性刷新直接写入：`src/app/runtime/createPostTradeConsistencyRuntime.ts:417-460`。
- 时间唤醒末日刷新直接写入：`src/main/timeWakeupEvaluationProgram/index.ts:103-109`。
- 这些路径共享同一 Trader 和 LastState；`PostTradeConsistencyRuntime` 的 `inFlight` 只约束该 runtime 自身，不约束席位刷新或时间唤醒。
- `src/core/trader/rateLimiter.ts` 对账户/持仓读取提供调用节流，但该读取节流不锁住从发起 API 到响应提交的完整请求生命周期；同一文件对 trade mutation 另有完整串行区。`src/core/trader/accountService.ts:71-82` 没有跨 owner 的请求合并或版本提交。

### runtime path

1. `SEAT_REFRESH` 由 `SeatActivationDispatcher` 入队。
2. `seatRefresh` 调用 `refreshHelpers.refreshAccountCaches()`，发起持仓读取。
3. 另一方向仍可处于 `ACTIVE`，订单监控仍可处理成交。
4. 订单终态触发 `PostTradeConsistencyRuntime.recordSettlementRefreshNeed()`。
5. 成交后一致性 runtime 读取并提交较新的持仓事实，标记 freshness 为 fresh。
6. 之前的席位刷新请求随后返回，并无条件写入 `cachedPositions` 与 `positionCache`。
7. 卖出处理等后续链路从 `positionCache` 读取被覆盖后的事实。

### impact

**潜在但真实可达**：

- 卖出量计算、末日清仓、浮亏监控、持仓订阅保持等链路可能读取时间上较旧的持仓事实。
- 成交后一致性 gate 可能仍显示 fresh，因为旧写入没有让该 gate 重新变 stale。
- 这不是通过类型检查可以消除的局部实现问题，而是共享事实的 ownership 和提交序列问题。

本次最小运行探针已复现：较新结果先提交后，较旧响应晚返回，`positionCache` 最终恢复为旧数量；未触发 fatal。

### 反证与边界

- 当前所有可见写入路径都会同步更新列表和 `positionCache`，并且很多入口有席位版本或生命周期校验。
- 尚无证据证明 Longbridge SDK 在生产环境一定会返回这种乱序快照。
- 因此本文不声称已发生生产事故，只确认应用层允许该时序且没有共同仲裁。

### dimensions

Implementation、状态所有权、异步一致性、交易安全、测试覆盖边界。

---

## 5.2 重要：核心业务层直接依赖 Longbridge SDK，券商边界没有完整收口

**性质：已确认适配耦合；对更换 SDK、执行后端或扩大复用范围属于重要维护限制，不是当前单券商产品的功能缺陷。**

### claim

当前 `core` 不是独立的业务核心；订单、风险、末日保护、策略类型和交易监控直接使用 Longbridge SDK 的上下文、枚举、推送对象和订单状态。SDK 变化、券商替换、回测/仿真适配会传播到多个 core 文件。

### evidence

直接 SDK 依赖包括：

- `src/core/trader/index.ts:20` 导入 `TradeContext`，并在 `:78` 创建 `TradeContext.new(config)`。
- `src/core/trader/orderExecutor/submitFlow.ts:9` 使用 SDK 订单方向、订单类型、时间有效性和交易上下文。
- `src/core/trader/orderMonitor/eventFlow.ts:9`、`recoveryFlow.ts:9`、`settlementFlow.ts:9` 使用 SDK 推送和订单状态。
- `src/core/orderRecorder/orderApiManager.ts:9`、`orderOwnershipParser.ts:11`、`utils.ts:1` 使用 SDK 订单模型。
- `src/core/doomsdayProtection/index.ts:17` 使用 SDK 订单方向和订单类型。
- `src/core/riskController/dailyLossTracker.ts:7`、`utils.ts:1` 使用 SDK 订单事实。
- `src/core/strategy/types.ts:1` 的策略公共快照直接依赖 SDK `Period`。
- `src/types/services.ts:1-16` 也将 SDK 订单类型暴露在跨模块公共契约中。

### runtime path

Longbridge 的原始订单、推送和 SDK 枚举从 Trader/订单恢复进入 `OrderMonitor`、`OrderRecorder`、风险计算和策略/运行时契约，最终又通过公共类型被 `main` 和 `app` 消费。该依赖不是只存在于 `quoteClient` 或一个 broker adapter 内。

### impact

**已确认结构影响**：

- `core` 无法作为独立于 Longbridge 的领域核心被复用。
- 订单/风险相关测试需要面对 SDK 枚举或上下文语义；策略端口仅有 type-only `Period` 依赖，不能因此声称具体策略运行必然加载 SDK。
- 增加第二券商、纸面交易、回测撮合或离线重放时，适配范围会扩散到多个 core 和公共类型文件。
- SDK 的枚举/状态变化会直接影响核心订单生命周期和风险逻辑。

### 反证与边界

- README 明确当前产品绑定 Longbridge OpenAPI SDK，且不声明多券商或通用回测平台；在这一产品范围内，直接 SDK 依赖可以是有意的工程取舍。
- `quoteClient` 和部分 Trader port 已经做了标准化，说明项目并非完全没有适配边界。

### dimensions

Project architecture、dependency inversion、type design、可扩展性。

---

## 5.3 风控边界：不同 BUY 来源的检查集合不同

**性质：已确认路径差异；未认定为架构缺陷或风控政策违规。**

### claim

普通 BUY 的基础账户/持仓风控主要在 `BuyProcessor` 的前置链路完成；最终 `submitFlow` 重查了行情、浮亏、频率和最新买入价，但没有重做全部账户余额和单标的持仓上限检查。同时，自动换标回补路径直接调用 `Trader.executeSignals`，不经过普通 `BuyProcessor` 的完整风险流水线。

### evidence

- 普通买入风险链：`src/main/asyncProgram/buyProcessor/index.ts:141-165` 调用 `signalProcessor.applyRiskChecks`。
- 基础现金/持仓上限检查：`src/core/signalProcessor/riskCheckPipeline.ts:294-302`、`src/core/riskController/index.ts:105-145`。
- 最终提交边界：`src/core/trader/orderExecutor/submitFlow.ts:439-464`，此处重查浮亏、频率、最新买入价和最终行情，但未重做前述账户/持仓上限检查。
- 换标回补直接执行：`src/services/autoSymbolManager/switchStateMachine.ts:277-286,1223-1242` 调用 `trader.executeSignals`。

### runtime path

普通信号：

```text
strategy -> ordinary signal -> BuyProcessor -> applyRiskChecks -> Trader.executeSignals -> submitFlow -> SDK
```

自动换标回补：

```text
switchStateMachine -> build BUY signal -> Trader.executeSignals -> submitFlow -> SDK
```

两条路径最终共享部分 submit flow，但进入之前的基础账户/持仓检查集合不同。

### impact

**确认的契约含义**：

- 调用 `Trader.executeSignals` 不等于已经通过普通 `BuyProcessor` 的全部前置检查；调用路径与交易目的也是风控语义的一部分。
- 普通 BUY 的账户/持仓检查是观察时点校验，最终提交时不重新建立同一组账户事实；不能将其理解为资金预留或持仓限额的事务性保证。
- 换标回补按另一组用例规则进入执行器。是否应该继承普通买入的全部限制，不能从“BUY”这个动作名称单独推导。

本次未证明存在违反既定业务政策的交易，也不以“未重复每一项检查”直接判缺陷。

### 反证与边界

- 换标回补是独立业务流程，数量按已卖出金额计算；其业务规则可能有意不同于普通策略买入。
- 最终 submit flow 仍有生命周期、行情、浮亏、频率、价格和数量检查。
- 代码本身不能证明项目策略要求“回补必须受普通现金/持仓上限同等约束”；因此本文确认的是**风控入口不统一**，不是确认已经突破项目明示的风险政策。

### dimensions

Business logic boundary、risk control、execution gateway、application coupling。

---

## 5.4 调度边界：监控任务跨类型串行，买卖 FIFO 无显式容量上限

**性质：已确认调度/容量约束；无负载证据证明当前不满足时效要求，未认定为容量故障。**

### claim

监控任务队列将席位刷新和周期换标等不同业务任务放入同一 runner，并逐项等待完成；买入/卖出 FIFO 队列直接追加，未见容量或背压上限。行情输入虽然采用 latest-only，但已获准进入交易队列的意图仍可能按 FIFO 长时间积压。

### evidence

- 监控处理器单 runner 和顺序 `await`：`src/main/asyncProgram/monitorTaskProcessor/index.ts:276-297,327-335`、`src/main/asyncProgram/monitorTaskProcessor/queueRunner.ts:87,111-115`。
- 席位刷新会等待行情准入、行情读取、订单和账户/持仓请求：`src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:303-318,364`。
- 周期换标也进入同一监控任务处理路径：`src/main/periodicSwitchWakeupRuntime/index.ts:145`。
- 买卖任务队列采用数组追加：`src/main/asyncProgram/tradeTaskQueue/index.ts:30,49-60`；消费者按顺序等待任务完成：`src/main/asyncProgram/utils.ts:138-148`。

### runtime path

- 外部 API 响应慢时，一个 `SEAT_REFRESH` 可以占用监控 runner，后续 `AUTO_SYMBOL_TICK` 不能及时推进。
- 行情持续产生信号而执行器被行情、账户、持仓、freshness 或订单状态等待阻塞时，买卖 FIFO 队列增长。
- 当前执行阶段会再次校验交易日、席位身份和交易门禁，因此失效任务可被丢弃。积压至少消耗队列内存和出队校验时间；是否继续消耗 API 配额取决于任务在哪个门禁被拦截，不能一概而论。

### impact

**潜在影响**：

- 周期换标可能晚于计划时点。
- 信号等待时间可能随负载增加。
- 在持续高频行情或外部 API 退化时，队列积压可能造成内存和执行时效压力。

### 反证与边界

- 当前产品只有一个监控标的，买卖处理器分离，且普通行情本身 latest-only；不能仅凭队列结构断言当前运行一定会积压。
- 监控队列有同 key 待处理任务替换机制；买卖 FIFO 不应被描述为同样的 latest-only/dedupe 队列。席位版本和执行前门禁降低旧身份任务继续执行的风险。
- 串行与 FIFO 可能是为了保留业务操作顺序。没有延迟预算、流量测量或积压阈值依据时，不能据此判定串行粒度错误。

### dimensions

Concurrency、backpressure、event processing、runtime scalability。

---

## 5.5 持久化边界：普通审计与订单运行态并非同一原子提交

**性质：已确认一致性与延迟取舍；当前未观察到故障，不评级为确定缺陷。**

### claim

普通订单终态先更新运行态订单追踪并发出 `OrderStateChanged`，再由 app 监听器同步写入交易日志；普通日志写入失败会升级 fatal，但不能回滚已完成的内存结算。保护性清仓进度采用了更严格的先持久化、后提交顺序，但普通成交日志不是同一模式。

### evidence

- 订单终态结算后发事件：`src/core/trader/orderMonitor/settlementFlow.ts:772-774`。
- app 监听器持久化：`src/app/runtime/createPostGateRuntime.ts:443-452`。
- 交易日志仓储同步文件写入和 fsync：`src/services/mixedTradeLogRepository/index.ts:601-647,936-944`。
- 保护性清仓进度另有先持久化后更新的路径：`src/app/runtime/createPostTradeConsistencyRuntime.ts:214-229`、`src/core/riskController/dailyLossTracker.ts:975-985`。

### impact

**潜在影响**：

- 慢磁盘会阻塞订单状态事件处理。
- 普通审计写入失败时，内存订单事实已经推进，而日志未必存在；系统 fail-stop 后需要依靠券商快照或人工对账。

### 反证与边界

- 普通交易日志不是订单事实的唯一恢复源，启动恢复主要依赖券商订单快照。
- 保护性清仓这一交易安全敏感路径已经有更严格的持久化顺序。

### dimensions

Persistence boundary、failure atomicity、operational recovery。

---

## 5.6 职责清晰度：完整业务 owner 已跨出目录名所暗示的边界

**性质：已确认维护性问题，minor；没有证据显示职责分布已经造成错误成交。**

### claim 与证据

`app` 在项目目录说明中是应用组装层，但 `src/app/runtime/createPostTradeConsistencyRuntime.ts:180-227` 不是简单接线：它查询保护性清仓事件、确认空仓和无待成交保护性订单、准备亏损边界、持久化完成记录，然后提交亏损分段、冷却计数及事件完成状态。`:237-285` 又负责可归属席位的浮亏刷新。相关业务依赖由 `createPostGateRuntime.ts:477-484` 后绑定。

同一业务域的其他部分位于：

- `core/trader/protectiveLiquidationEpisodeTracker`：事件进度和完成准备。
- `core/riskController/dailyLossTracker.ts`：损益事实和亏损分段。
- `services/liquidationCooldown`：冷却。
- `services/mixedTradeLogRepository`：持久化事实。
- `main/tradingRiskEventRuntime`：触发。

同时，`services/autoSymbolManager/index.ts:45-145` 和 `switchStateMachine.ts` 并非简单外部服务，而是围绕席位组织撤单、卖出、替换与回补的业务状态机。`utils/refreshGate/index.ts` 也是持有 waiter/version 状态的工厂，不是无副作用纯函数集合。

### 影响与复核

**已确认的影响是认知和变更传播成本**：只按 `core=业务、services=外部服务、app=组装、utils=纯工具` 寻找职责，会漏掉真正决定交易后置语义的 owner。保护性清仓的“什么时候完成”不能只在 riskController 或 tracker 内完成审查。

**反证**：跨领域用例本来就需要协调多个模块；应用服务位于 app 在某些架构风格下也是合理的，不能仅凭目录名称判为分层违规。这里确认的是本仓库目录说明的表达能力不足，以及同一业务用例跨多层分布的维护成本，不是要求把所有相关文件物理放在一起。

**维度**：目录职责、用例内聚性、注释/目录说明的准确性。验证方式为沿上述调用链核对实际状态推进和持久化顺序，而不是用大文件行数打分。

---

## 5.7 生命周期：已形成明确协议，但资源覆盖依赖多处清单协同

**性质：已确认维护耦合，minor；未发现当前启停遗漏。**

同一运行时需要同时出现在适用的资源创建/cleanup 注册、初次启动、跨日停止/恢复和终止快速停产路径中，证据见 4.1。它们不是完全重复：系统级时间唤醒必须在交易关闭期间继续驱动恢复，最终退出又必须销毁策略而不只是清空交易日状态。

当前 `runApp.ts:310-335` 与 `signalRuntimeDomain.ts:77-133` 的成对关系、cleanup phase 及 termination gate 都已核对；对应 wiring、termination matrix 和 drain lifecycle 测试通过。因此，不存在“因为列表不同就证明漏停某个 runtime”的结论。

维护成本仍然客观存在：一个 owner 的完整生命周期契约不是由其自己的接口和创建点就能完全读出，而是依赖多处清单与顺序约定。这是跨日恢复、初始化和退出都比较复杂时形成的协作耦合；**不会因存在统一 cleanup 函数就自动消失，也不能直接推断为业务缺陷**。

**维度**：生命周期、异步资源 ownership、集成测试边界。

---

## 6. 未确认缺陷但需要明确记录的结构性风险

以下项目经过复核，存在架构关注点，但目前不应写成已确认故障：

### 6.1 席位换标控制链分散

空席位寻标、周期换标、距离换标、激活和等待分别由：

- `AutoSearchWakeupRuntime`
- `PeriodicSwitchWakeupRuntime`
- `MonitorQuoteEventRuntime`
- `SwitchWakeupRuntime`
- `SeatActivationDispatcher`
- `monitorTaskProcessor` 的 handlers
- `autoSymbolManager/switchStateMachine`

共同完成。

这确实形成了共享 seat version、任务协议和 WAIT handoff 的耦合，但职责仍然可追踪：runtime 持有唤醒/等待 owner，manager 持有换标阶段状态和决策，registry 持有席位真相。当前未发现因这组分散职责导致的具体错误。

### 6.2 末日清仓的本地持仓口径短暂领先于券商成交事实

`src/core/doomsdayProtection/index.ts:472-473,504-546` 在提交成功后会调整本地买单/持仓口径；后续订单成交与成交后一致性刷新会继续收敛，重启时也会从券商快照重建。因此这更准确地描述为**窗口内的乐观本地投影**，不是已确认的持久事实错误。

### 6.3 pending sell 占用和 tracked order 是两个协同账本

`OrderMonitor` 管理订单生命周期，`OrderRecorder` 管理待成交卖单对买单的占用。两者有恢复期校验与 ACTIVE 门禁，职责也不是重复的；当前未发现已确认不一致，但这属于高价值一致性边界。

### 6.4 warrant cache 清理与在途请求

`autoSymbolFinder` 的 cache 清理与在途请求返回之间从局部代码看存在旧结果重新写回的可能，但当前生命周期顺序会先排空寻标/换标 owner，再执行 seat domain cache 清理；在可见调用链中未确认竞态。

---

## 7. 低耦合程度评价

### 7.1 相对低耦合的区域

- **策略与交易执行之间**：`TradingSignalStrategy` 只接收冻结行情/席位快照，输出普通 `StrategyDecision`；策略不直接持有 Trader、行情客户端或下单能力。`src/core/strategy/types.ts:1-152` 的端口设计较清晰。
- **行情客户端与业务事件之间**：`quoteClient` 将 Longbridge push 转换为标准化 quote/K 线事件和本地缓存快照。
- **订阅 mutation**：由 `QuoteSubscriptionRuntime` 统一持有和串行化，避免多个业务 owner 直接竞争 SDK 订阅操作。
- **订单恢复与订单监控**：存在 BOOTSTRAPPING、ACTIVE、STOPPED 状态，实时事件暂存和恢复后回放，恢复失败不直接放行交易。
- **生命周期和清理**：cleanup 注册、阶段顺序、fatal 保留和 stop-and-drain 语义较明确。

### 7.2 中等或较高耦合的区域

- **共享状态**：`LastState` 被多个运行时直接读写，所有权不是单一 owner。
- **公共类型**：`src/types/services.ts` 集中多个业务领域 port 和 SDK 类型。
- **交易执行**：`core/trader` 同时负责 SDK 上下文、账户、订单缓存、订单监控、订单执行、订单占用和部分生命周期门禁。
- **席位领域**：寻标、换标、激活、订单/风险刷新和订阅保留分散跨越 `services/main/app`。
- **风险入口**：普通买入、换标回补、末日清仓、保护性清仓是不同调用路径；它们的检查集合和执行目的不同，不能仅凭共享 `Trader.executeSignals` 认定已共享全部风控。

### 7.3 “低耦合”结论

当前项目可以称为：

> **局部模块低耦合，跨运行时事实中等耦合，跨基础设施边界和共享状态高耦合。**

不能整体称为低耦合架构。

---

## 8. 功能完整性评价

### 8.1 对当前产品范围：基本完整

当前范围不是通用量化平台，而是一个明确的 Longbridge 港股实时交易程序。针对这个范围，已看到以下完整能力：

- 单活跃策略选择与策略配置校验。
- 监控标的 K 线事件、指标、延迟验证和普通信号。
- 买入/卖出分流和独立异步处理。
- 买入风控、牛熊证风险、浮亏保护、清仓冷却。
- 普通卖出、智能平仓、待成交卖单占用。
- 订单状态监控、成交推进、超时、撤单、跟价和部分成交收口。
- 启动快照、订单恢复、账户/持仓刷新和开盘重建。
- 自动寻标、距离换标、周期换标、席位激活与版本失效。
- 交易日、半日市、开盘保护、末日清仓和午夜清理。
- 订阅集合协调、展示 runtime、fatal/外部 API 错误分类、退出 cleanup。

从功能覆盖看，当前项目不是明显缺少关键实时交易模块的半成品。

### 8.2 对通用量化交易平台：不完整，但不能作为当前产品缺陷

与主流开源量化框架相比，当前项目没有形成以下通用平台能力：

- 独立、可替换的 broker/venue adapter 层。
- 统一的回测撮合引擎与实盘执行器替换机制。
- 多策略、多账户、多监控标的或多资产并行模型。
- 研究数据、历史数据、回测结果和实盘结果的统一抽象。
- 通用事件总线或可持久化事件日志重放模型。
- 独立的组合构建、执行算法、venue 对账和多券商路由层。

这些能力与项目 README 声明的单监控、单策略、Longbridge 实盘范围不一致，因此只能判为**平台化完整性不足**，不能判为当前项目没有完成既定产品功能。

---

## 9. 与主流开源量化框架的对照

以下对照用于判断架构形态，不是要求当前项目照搬这些框架。资料获取日期均为 **2026-09-27**；源码分别固定在 vn.py `4.1.0`、LEAN `v2.4.0.1`、NautilusTrader `v1.231.0`，只作为可追溯的架构样本，**不声称它们是各项目最新版本**。网站文档可能滚动更新。未使用 star 数、社区热度或不同口径吞吐量对项目打分。

### 9.1 vn.py

官方源码显示：

- `EventEngine` 负责事件队列与事件分发。
- `MainEngine` 组合 gateway 和 app engine。
- `BaseGateway` 收口连接、订阅、下单、撤单、账户/持仓/订单/成交查询与回调。
- CTA strategy、Risk Manager 和 gateway 之间有相对明确的策略、风控、交易入口边界。

参考：

- [vn.py EventEngine](https://github.com/vnpy/vnpy/blob/4.1.0/vnpy/event/engine.py)
- [vn.py MainEngine](https://github.com/vnpy/vnpy/blob/4.1.0/vnpy/trader/engine.py)
- [vn.py BaseGateway](https://github.com/vnpy/vnpy/blob/4.1.0/vnpy/trader/gateway.py)
- [CTA Strategy](https://www.vnpy.com/docs/cn/community/app/cta_strategy.html)

与当前项目相比：

- 当前项目的 `runApp`、runtime factory 和事件 owner 已有类似 `MainEngine` 的组合根作用。
- 当前项目的 `quoteClient` 类似部分行情 gateway，但交易 `core/trader` 仍深度吸收 SDK 语义，不像独立 gateway 那样完全收口。
- 当前项目的风险逻辑比简单 Risk Manager 更贴合港股轮证业务；普通买入和换标回补使用不同的检查入口，必须按各自交易目的理解，不能从 Trader 门面推导出二者已共享全部风控。

### 9.2 QuantConnect LEAN

官方源码和文档显示：

- Engine 通过 data feed、transaction handler、result、realtime handler 等组件组装运行环境。
- `AlgorithmManager` 按时间片顺序处理算法回调和交易事件。
- Algorithm Framework 区分 Alpha、Portfolio Construction、Risk Management、Execution。
- 回测和实盘共享算法循环，但交易处理器、数据馈送和 brokerage 组件可替换。

参考：

- [LEAN Engine](https://github.com/QuantConnect/Lean/blob/v2.4.0.1/Engine/Engine.cs)
- [LEAN AlgorithmManager](https://github.com/QuantConnect/Lean/blob/v2.4.0.1/Engine/AlgorithmManager.cs)
- [Algorithm Framework overview](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/overview)
- [Execution model key concepts](https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/execution/key-concepts)

与当前项目相比：

- 当前项目有较强的实时事件和生命周期状态机，但没有 LEAN 那样明确的可替换回测/实盘交易处理器边界。
- 当前项目策略端口隔离较好，但订单执行、风险和 SDK 类型在 `core` 中更紧密。
- 当前项目的 `LastState` 更像多个运行时共享的应用状态，而不是由特定组件持有并通过明确 handler/事件更新的状态库。

### 9.3 NautilusTrader

官方架构文档显示：

- 以 node/kernel 组织 MessageBus、Cache、data/risk/execution engine、Portfolio 和 Trader。
- MessageBus 同时支持 pub/sub、request/response 与 command/event 通信。
- RiskEngine、ExecutionEngine、ExecutionClient 和 execution algorithm 有明确分工。
- 回测和实盘尽量复用核心引擎、Cache、MessageBus、Strategy 与 Execution Algorithm，但使用不同的数据和执行环境。

参考：

- [Nautilus architecture](https://github.com/nautechsystems/nautilus_trader/blob/v1.231.0/docs/concepts/architecture.md)
- [Message bus](https://github.com/nautechsystems/nautilus_trader/blob/v1.231.0/docs/concepts/message_bus.md)
- [Execution](https://github.com/nautechsystems/nautilus_trader/blob/v1.231.0/docs/concepts/execution.md)
- [Backtest execution flow](https://github.com/nautechsystems/nautilus_trader/blob/v1.231.0/docs/concepts/backtesting/execution-flow.md)

与当前项目相比：

- 当前项目已有多个事件 owner 和显式 freshness/seat version，但没有统一 MessageBus/Cache 作为所有共享事实的单一协调边界。
- 当前项目有订单监控和执行状态机，但 execution、risk、broker push、对账和持久化之间仍主要通过共享 port/LastState/事件监听连接。
- 当前项目的跨日恢复比许多简单策略脚本完整，但恢复范围是应用特定业务事实，不是通用平台级状态恢复。

### 9.4 对照后的客观结论

主流框架的共同趋势不是“目录更多”，而是：

1. broker/venue 的命令、查询、推送和事实恢复有明确适配边界。
2. 策略、风控、组合/执行和交易处理之间的职责边界可替换。
3. 共享状态有明确 owner、缓存语义和恢复来源。
4. 回测/实盘的共用部分与不可共用部分被显式区分。
5. 事件处理的顺序、背压、对账和持久化语义被作为架构协议，而不是由多个调用方隐式组合。

当前项目已经体现其中多项原则，但复用范围和产品目标更窄。特别需要避免三个错误推论：**没有中心 MessageBus 不等于不是事件驱动；没有通用 Cache 不等于没有状态 owner；没有事件溯源或数据库不等于恢复不完整。**当前类型化订阅、回调和队列可以承担合适的事件协作职责。真正的问题在于特定事实是否有一致的写入/版本契约，而不是是否采用某个框架的类名或基础设施。

---

## 10. 正向架构结论

以下是应在后续重构参考中保留的已确认优点：

1. **组合根明确**：`runApp` 把策略选择、runtime 创建、启动重建、运行和清理顺序集中表达。
2. **策略隔离较好**：策略输出的是中性普通意图，不直接决定标的、数量、委托类型或清仓权限。
3. **事件驱动边界实际存在**：K 线、quote、时间唤醒、订单状态、成交后刷新和席位变化不是一个大循环混在一起。
4. **latest-only/single-flight 使用有业务依据**：行情、展示和部分监控任务按“只保留最新事实”的语义处理，而不是机械地堆积所有行情事件。
5. **订单恢复模型相对完整**：历史/当日订单合并、实时事件暂存与回放、订单生命周期校验、成交累计量单调性和异常状态 fail-fast 均有明确代码路径。
6. **席位版本和生命周期门禁有效**：旧标的、旧席位、旧交易日的信号和任务通常会在执行前被阻断。
7. **外部失败与内部一致性错误有区分**：外部 API 暂时失败多数按业务规则等待/重评估，内部契约错误则 fail-fast；这符合交易系统安全边界。
8. **保护性清仓的恢复事实较严谨**：执行进度、完成边界和冷却/亏损分段之间存在持久化和幂等意识。
9. **架构约束已有自动化检查**：import boundary、strategy private boundary、type organization 等测试不是只停留在目录约定层面。
10. **测试数量和关键业务覆盖较强**：全量测试 1992 项通过，且覆盖启动、恢复、换标、订单监控、保护性清仓、末日保护、成交后刷新等非平凡路径。

---

## 11. 未评估与置信度边界

以下内容本次没有足够证据，不作确定性判断：

- Longbridge SDK 内部是否对账户/持仓请求做了额外串行化、快照版本保证或缓存；只确认应用层未实现共同仲裁。
- 生产网络延迟、WebSocket 丢事件、断线重连、券商返回顺序和实际交易负载下的队列积压规模。
- 进程突然崩溃、机器断电、磁盘损坏时普通交易日志与券商订单事实的最终对账表现。
- 多监控标的、多账户、多策略和多券商场景；当前项目配置和 README 明确限制为单监控、单活跃策略。
- 回测收益正确性、历史数据质量、撮合模型真实性；当前仓库主要是实时交易程序，不是完整回测平台。
- `tools/`、历史 `docs/` 和未被当前调用链触达的外部脚本是否存在额外架构耦合。全量 lint/type-check/test 会包含配置允许的工具检查，但本次没有据此开展工具模块架构审查。
- 全仓死代码与所有注释的逐项正确性：本次仅核对影响架构判断的注释、目录说明、调用方和契约，没有完成每个导出/动态入口的全局死代码证明；不输出“全部代码都有效”或“注释全部准确”的结论。
- 高可用、运维报警、长时间 soak test、进程监督和容灾部署：源码级日志/错误出口不等于这些运营能力已被完整验证。

本报告对项目内部结构的置信度为 **high**；对真实券商时序、生产性能和线上故障发生情况的置信度为 **medium**。

---

## 12. 最终确认结论

1. **架构和模块目录是否合理？**
   - 对当前单券商、单策略、单监控标的实时交易产品：**基本合理**。
   - 对通用量化框架或多券商/回测平台：**不完整**。

2. **功能划分是否合理？**
   - 策略、事件运行时、订单监控、风险、席位和生命周期均已形成可辨识职责，**总体合理**。
   - 自动换标是应用领域状态机，不是简单 service；`core` 也不是纯领域层，`types/services.ts` 不是窄公共契约。这些目录语义与实际职责有偏差。

3. **是否是低耦合架构？**
   - **不能整体判定为低耦合**。
   - 策略端口、行情标准化、订阅 runtime、订单恢复和 cleanup 局部低耦合；共享 `LastState`、Longbridge SDK 渗透、BUY 多入口、席位/生命周期跨层编排属于中高耦合。

4. **是否足够清晰？**
   - 主运行流程和主要业务链路**清晰度较高**，README、app 组装和测试均能反映真实路径。
   - 共享持仓事实的写入仲裁边界不完整，业务 owner 与目录归属也不完全一致。不同 BUY 路径的检查集合需要沿实际用例理解，不能把 Trader 门面误当作“已完成全部风控”的凭据。

5. **是否足够完善？**
   - 作为当前产品的实时交易程序：**功能覆盖基本完善，但仍存在重要架构风险**。
   - 作为通用量化平台：**不是当前产品定位，也未形成相应复用架构**。没有多券商、统一回测或平台级事件重放，不构成当前产品的当然缺陷。

> 最终判断：**当前项目已有清楚的实时交易应用骨架和较完整的业务验证，目录大方向成立；但整体不能认定为充分低耦合。最明确的一致性问题是共享持仓的多 owner 写入与局部 freshness 之间的缺口；最明确的维护限制是 SDK 深度耦合、业务职责跨目录分布，以及生命周期多点协同。不同交易路径、串行队列和持久化方式必须按业务目的判断，不能将它们自动归入“需要修复的缺陷”。**

---

## 附录 A：关键证据索引

| 主题 | 关键位置 |
| --- | --- |
| 组合根与运行顺序 | `src/app/runApp.ts:106-335` |
| post-gate 共享对象组装 | `src/app/runtime/createPostGateRuntime.ts:213-703` |
| 成交后一致性 owner | `src/app/runtime/createPostTradeConsistencyRuntime.ts:417-546` |
| 可变共享 LastState | `src/types/state.ts:26-70` |
| 普通 K 线事件与策略边界 | `src/main/businessEventProgram/index.ts:1-157`、`src/core/strategy/types.ts:1-152` |
| 监控任务队列 | `src/main/asyncProgram/monitorTaskProcessor/` |
| 买卖任务队列 | `src/main/asyncProgram/tradeTaskQueue/index.ts`、`src/main/asyncProgram/utils.ts` |
| 订单门面与子模块 | `src/core/trader/index.ts:50-250` |
| 最终提交边界 | `src/core/trader/orderExecutor/submitFlow.ts:439-600` |
| 普通买入前置风控 | `src/main/asyncProgram/buyProcessor/index.ts:120-190`、`src/core/signalProcessor/riskCheckPipeline.ts:294-302` |
| 换标回补执行 | `src/services/autoSymbolManager/switchStateMachine.ts:277-286,1223-1242` |
| 跨日 runtime 顺序 | `src/app/lifecycle/createLifecycleRuntime.ts:85-142`、`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:77-133` |
| 架构约束测试 | `tests/architecture/importBoundary.test.ts`、`tests/architecture/strategyBoundary.test.ts`、`tests/architecture/typeOrganization.test.ts` |
| 项目声明的产品范围 | `README.md:20-202` |

## 附录 B：本次未提供的内容

- 未提供任何修复方案。
- 未提供目录重构方案。
- 未提供代码迁移顺序。
- 未修改 `src/`、测试或配置。
- 未将潜在生产风险表述为已发生线上故障。
- 未因缺少通用回测、多券商或多策略能力而否定当前明确产品范围内的合理性。

## 附录 C：持仓多写入最小探针的复核记录

### C.1 实际执行时序与结果

使用真实 `createRefreshHelpers`、`createPostTradeConsistencyRuntime`、`createPositionCache`，仅注入 Trader 响应、无活动席位/无待完成保护性事件的协作者，以及系统 timer。探针不模拟完整下单，不调用 Longbridge API。

| 步骤 | 行为 | 缓存数量 | freshness |
| --- | --- | --: | --- |
| 1 | 席位刷新 helper 先调用 `getStockPositions`，其响应被 deferred 保留 | — | 未推进 |
| 2 | 记录成交后刷新需要，第二次持仓请求返回数量 200 | 200 | `currentVersion=1, staleVersion=1` |
| 3 | 释放第一条请求，返回较旧数量 100；helper 提交结果 | 100 | 仍为 `currentVersion=1, staleVersion=1` |
| 4 | 检查 fatal 并排空 runtime | 100 | fatal 列表为空 |

探针退出码为 0，断言上述次序确实发生。它复现的是**代码缺少跨 owner 仲裁时的响应处理结果**，不是对 SDK 内部行为的测试。生产可达性的独立静态依据是：一侧 `ACTIVATING` 不关闭另一侧交易，订单监控和席位刷新独立运行，账户 API 节流只排列请求开始时点，不覆盖响应提交。

### C.2 可复核的独立命令

在仓库根目录运行以下 PowerShell 命令。它只使用依赖注入，不读取交易凭据，不启动交易应用；没有新增测试文件。当前工具链允许 `bun -e` 解释该最小 TypeScript 形状的测试替身，这些替身仅覆盖探针实际使用的能力，不是完整生产类型实例。

```powershell
$probe = @'
import { createPostTradeConsistencyRuntime } from './src/app/runtime/createPostTradeConsistencyRuntime.ts';
import { createRefreshHelpers } from './src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts';
import { createPositionCache } from './src/utils/positionCache/index.ts';

const oldRequest = Promise.withResolvers();
const oldStarted = Promise.withResolvers();
const fatals = [];
let requests = 0;
const position = (quantity) => ({ symbol: 'BULL.HK', quantity, availableQuantity: quantity });
const trader = {
  getAccountSnapshot: async () => null,
  getStockPositions: () => {
    if (++requests === 1) {
      oldStarted.resolve();
      return oldRequest.promise;
    }
    return Promise.resolve([position(200)]);
  },
};
const lastState = { cachedAccount: null, cachedPositions: [], positionCache: createPositionCache() };
const runtime = createPostTradeConsistencyRuntime({
  getTrader: () => trader,
  lastState,
  onPositionsCommitted: async () => {},
  scheduler: { scheduleTimer: setTimeout, clearTimer: clearTimeout },
  termination: { isTerminated: () => false, reportFatalError: (e) => fatals.push(String(e)) },
});
runtime.bindBusinessDeps({
  monitorContext: { symbolRegistry: { getSeatState: () => ({ status: 'EMPTY', symbol: '' }) } },
  protectiveLiquidationEpisodeTracker: { getInProgressEpisodes: () => [] },
});
const helper = createRefreshHelpers({ trader, lastState, canContinue: () => true });
const earlier = helper.refreshAccountCaches();
await oldStarted.promise;
runtime.start();
runtime.recordSettlementRefreshNeed({ refreshAccount: false, refreshPositions: true });
await runtime.waitForFresh();
const afterFresh = { quantity: lastState.positionCache.get('BULL.HK')?.quantity, status: runtime.getStatus() };
oldRequest.resolve([position(100)]);
await earlier;
const afterLateResponse = { quantity: lastState.positionCache.get('BULL.HK')?.quantity, status: runtime.getStatus() };
console.log(JSON.stringify({ requests, afterFresh, afterLateResponse, fatals }));
await runtime.stopAndDrain();
if (afterFresh.quantity !== 200 || afterLateResponse.quantity !== 100 || fatals.length !== 0) {
  throw new Error('Unexpected probe result');
}
'@
bun -e $probe
```
