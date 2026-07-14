# HSI Single-Monitor Architecture Review and Recheck Plan

> [!WARNING] **历史快照，已被取代。** 本文记录 2026-07-11 较早代码快照的实施与验证，保留内容仅用于追溯；其中“仅发现一项”、`resolveSignalSeat`、`1116 pass` 及已收敛结论均不得作为当前源码事实。当前 19 项 finding、二次复核修正、修复状态与最终验证规则以 [HSI 单监控标的全链路业务审查问题记录](../../issues/2026-07/2026-07-11-hsi-single-monitor-full-chain-review-findings.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans for any future implementation task. This document is a retrospective and recheck contract; it does not authorize restoring deleted multi-monitor abstractions.

**Goal:** 记录本轮将项目收敛为“唯一可配置 HSI monitor + LONG/SHORT 方向隔离”后的全链路审查结论、已确认缺陷、已实施修复和可重复的二次复核方法。

**Architecture:** 系统只保留一个 TradingConfig.monitor 和一个 MonitorContext。SymbolRegistry 是 LONG/SHORT 席位状态及版本的唯一真相；唯一 monitor 已装配和校验后，内部任务、路由与生命周期只传递 direction、seatVersion、交易标的和业务事实。monitorSymbol 只保留在配置、外部行情事件、订单/恢复/持久化事实校验，以及必要的展示和日志边界。

**Tech Stack:** TypeScript strict mode、Bun、Longbridge SDK、事件驱动运行时、现有业务集成测试。

---

## 1. 审查目标与最终结论

本轮审查不是把旧多标的代码包装成单元素集合，而是从业务事实重新确认：

1. 唯一 monitor 的外层维度是否已经从配置、装配、任务、路由、恢复、风险和测试中真实消失。
2. 删除 monitor 维度后，LONG/SHORT、seatVersion、交易标的、订单 route、持仓和行情订阅等真实业务维度是否完整保留。
3. 外部或持久化事实是否仍经过 monitor 归因校验，避免被静默映射到 HSI。
4. 最终副作用边界是否保护方向、席位版本、订单归属、清仓冷却和风险分账。
5. 测试是否从“旧字段/旧字符串必须不存在”的结构锁收敛为业务行为测试。

结论：唯一 monitor 架构已落实到活跃生产路径。本轮发现一项真实的最终下单方向不变量缺陷，已用红绿测试并以 fail-fast 方式修复。其余确认项为旧多标的壳、双真相缓存、冗余内部参数/命名和测试噪音，均已直接删除或收敛。最终格式化、静态检查、完整测试和构建均通过；未发现仍需修复的活跃多标的残留。

## 2. 第一性原理下的目标模型

| 业务事实 | 正确模型 | 必须保留的原因 | 禁止保留的旧模型 |
| --- | --- | --- | --- |
| 监控对象 | 一个可配置 monitorSymbol | 外部行情、配置和持久化归因仍须知道监控对象 | monitors[]、monitorContexts Map、索引环境变量 |
| 交易方向 | LONG / SHORT | 牛/熊证席位、买卖冷却、订单记录、风险和换标均按方向隔离 | 把两个方向合并为无方向状态 |
| 席位身份 | direction + seatVersion | 换标后必须阻断旧信号、旧任务和旧 route | 使用 monitor 前缀模拟唯一 route |
| 交易标的 | symbol | 一个方向可因自动寻标/换标而更换标的 | 以 monitor 作为订单/行情的唯一键 |
| 外部事实 | monitorSymbol + 可解析归属 | 外部 quote、订单、trade log、恢复快照可能不是当前 HSI | 将任意外部事实默认归入 HSI |

完整运行时链路：

```text
无下标配置 MONITOR_SYMBOL
  -> 唯一 TradingConfig.monitor
  -> createMonitorContext / SymbolRegistry(LONG, SHORT)
  -> 行情事件与信号流水线（校验席位、绑定 seatVersion）
  -> 买卖队列 / 延迟验证 / 换标任务（direction + seatVersion）
  -> Trader.executeSignals
  -> OrderExecutor（最后一次 action、方向、版本一致性校验）
  -> OrderMonitor / OrderRecorder / 风控与恢复事实

外部 quote、订单事件、trade log、恢复快照
  -> monitorSymbol 归因校验
  -> 仅向内部传递 direction、seatVersion、symbol 和已解析业务事实
```

关键不是“代码再也不能出现 monitorSymbol”，而是它不能继续成为内部队列、Map 或 route 的第二维。它在外部边界仍是阻断错误归因所需的事实字段。

## 3. 全链路确认的架构收敛

### 3.1 配置与应用装配

- 配置入口是 TradingConfig.monitor + TradingConfig.global；生产解析只读取无下标配置。活跃代码、测试、mock、README 与 .env.example 中没有 MONITOR_SYMBOL_1 / MONITOR_SYMBOL_N、collectIndexedMonitorConfigKeys 或 MultiMonitorTradingConfig。
- createMonitorContext 只创建一个上下文。MonitorContext 不再缓存 seatState / seatVersion 副本，席位真相由 SymbolRegistry 统一提供。
- 原名 syncMonitorContextRuntimeSnapshot 已全量改为 syncMonitorContextSymbolNames。该函数只刷新名称缓存，名称与实现语义一致，未保留旧名别名。

### 3.2 信号、任务与周期换标

- 普通信号从 SymbolRegistry 读取活动席位并写入当前 seatVersion；延迟验证、买卖任务和监控任务不再传递 monitor 路由参数。
- 已删除只负责把 SymbolRegistry 写回 MonitorContext 的 seatProjection；这消除了“注册表真相 + Context 镜像”可能漂移的双真相。
- MonitorTaskContext、requireContext 包装器和多余 tradingConfig 透传已删除；处理器直接注入唯一 MonitorContext。
- 周期换标、风险 route 和 wakeup state 以 LONG / SHORT 或 direction:seatVersion 表示真实业务身份；不再保留 routesByKey 镜像或 monitor 前缀 route key。

### 3.3 生命周期、恢复与风控

- 午夜 SeatDomain 只接收实际需要的 symbolRegistry、autoSymbolManager.resetAllState 和 warrantListCache；它清空 LONG/SHORT 席位并提升版本，不再同步已删除的 Context 席位镜像。
- 启动/开盘恢复直接计算 LONG 与 SHORT 的恢复标的并写入注册表，不再先生成 monitorSymbol:direction 快照 Map 再读回。
- TradingRiskEventRuntime 从 SymbolRegistry 的权威快照构造 tradingSymbol -> direction + seatVersion；同一标的归属两方向会 fail-fast，route state 只按方向保存 single-flight 状态。
- 清仓冷却内部键已收敛为方向。持久化 trade log 与恢复事实仍须先验证 monitorSymbol，验证后才写入方向级 tracker。

## 4. 已确认问题、为什么真实、以及所做修复

### F-01：最终下单边界缺少“动作方向 = 席位方向”校验（已修复，重要）

**证据与复现：** ExecutableSignal 同时包含 action、symbol 和 seatVersion，但静态类型不能表达“BUYPUT / SELLPUT 必须对应 SHORT 席位标的”。旧 OrderExecutor 依据 symbolRegistry.resolveSeatBySymbol(symbol) 得到 isShortSymbol 和版本，又依据 action 决定买卖动作。因此 BUYPUT + BULL.HK(LONG) + LONG seatVersion 可以通过版本校验。

**运行时后果：** 下单 payload 的买卖 side 来自 BUYPUT，而订单追踪、卖单关联、保护性清仓归属和仓位计算把 BULL.HK 当成 LONG；买入节流又按 BUYPUT 记录 SHORT。这会把同一成交写入不同方向的账本与风控状态，属于真实业务错误，而不是多标的兼容性问题。

**影响路径：** 普通买卖任务、末日清仓、静态清仓、浮亏保护和自动换标移仓最终都会经过 Trader.executeSignals -> OrderExecutor.executeSignals。普通信号已有前置校验，但最终执行器不能把上游约定作为唯一安全边界。

**直接修复：**

- 在 src/core/trader/orderExecutor/index.ts 增加 resolveSignalDirection，将四种可执行动作唯一映射为 LONG / SHORT。
- resolveSignalSeat 返回实际 direction，而不是仅返回布尔值。
- 在任何节流、下单、订单追踪或本地分账副作用前比较两个方向；不一致直接抛出内部不变量错误，不跳过、不重映射、不回退。
- 仅在比较通过后从权威方向推导 isShortSymbol。

**验证：** tests/integration/buy-flow.integration.test.ts 直接将 BUYPUT 与 BULL.HK（LONG 席位）送入最终执行器。红测时 Promise 实际 resolved 且已提交订单；修复后断言抛错，且 submitOrder 与 trackOrder 调用数均为 0。该测试保护 LONG/SHORT 账本不变量，并非“防多标的回归”测试。

### F-02：Context 内保存席位镜像导致双真相（已修复，架构冗余）

**证据：** 旧 MonitorContext.seatState / seatVersion 只是 SymbolRegistry 的副本，并通过 seatProjection、启动同步和生命周期同步回写。

**风险：** 换标、午夜清理、恢复和异步任务交错时，镜像可能先于或晚于注册表更新；调用方无法判断应信任哪一个版本。单 monitor 不需要为一个注册表再建立投影层。

**直接修复：** 删除 seatProjection 与 Context 中的席位镜像；所有需要席位事实的运行时直接读取 SymbolRegistry。MonitorContext 只保留名称缓存，名称由注册表和 quotesMap 派生。

### F-03：旧多标的外壳仍以单元素中间层存在（已修复，架构冗余）

**确认对象：** MonitorTaskContext / requireContext、恢复阶段的 monitorSymbol:direction 临时快照 Map、风险路由的 routesByKey 镜像、周期换标的 route 包装器、买入节流/下单函数中重复传递的唯一 monitor 配置。

**判定：** 这些对象不再承载多实例、跨边界校验或真实业务状态，只是旧 monitor 维度的残余包装。保留它们会使后续修改误以为内部存在多个 monitor route。

**直接修复：**

- 任务处理器直接注入唯一 MonitorContext；任务 key 保持 direction 与 seatVersion。
- 恢复逻辑直接计算 LONG 与 SHORT 的恢复标的并写入注册表。
- 风险路由仅保留按交易标的查询的 Map 和按方向清理 in-flight 状态的 Set。
- 下单器在创建时绑定唯一配置；买入节流按方向保存时间。

### F-04：末日保护仍透传可从 Context 推导的 monitorSymbol（已修复，轻微冗余）

src/core/doomsdayProtection/index.ts 的 resolveSeatSymbol(context, monitorSymbol, direction) 中第二个参数只用于日志，唯一调用方又从同一个 context.config.monitorSymbol 原样传入。已收敛为 resolveSeatSymbol(context, direction)，日志直接由 Context 读取配置。该修复不改变清仓行为，也没有引入别名或兼容层。

### F-05：配置与冷却合同的历史残留（已修复并在本轮复核）

- validateAllConfig 是独立可调用的配置校验边界。此前它未覆盖显式无效的 DOOMSDAY_PROTECTION，导致解析层与聚合校验层的 fail-fast 语义不一致；现已复用布尔校验，并由配置业务测试覆盖。
- 方向级清仓冷却已是实际模型，旧 buildCooldownKey(symbol, direction) 无生产或测试调用，已删除；当前活跃搜索为 0。

### F-06：测试和文档仍锁定已删除实现形状（已修复）

已删除或改写以下不具业务价值的测试噪音：

- 断言内部任务或 route 对象“不含 monitorSymbol / MonitorContext”的 exact-shape 测试。
- 队列负载中专门使用 @ts-expect-error 拒绝 monitorSymbol 的结构锁。
- SymbolRegistry 事件 payload 的 exact-shape 断言；仅保留方向、版本、状态和事件顺序等业务行为断言。
- 已删除 runtime snapshot 的旧命名、注释和测试表述。

保留的测试只验证 FIFO、方向路由、seatVersion 失效、订单归属、外部事实 fail-fast、清仓行为和 LONG/SHORT 隔离。

## 5. 仍保留 monitorSymbol 的分类与理由

| 位置 | 为什么保留 | 处理规则 |
| --- | --- | --- |
| src/config | 唯一 monitor 的配置事实 | 只读取无下标 MONITOR_SYMBOL |
| 外部 quote / startup 校验 | 事件可能不属于当前 HSI | 与配置值比较，不匹配按边界规则处理 |
| orderMonitor、订单归属、settlement | 订单/成交事实必须可归因 | 有相关成交却缺失或错误归因时 fail-fast |
| loadTradingDayRuntimeSnapshot、trade log hydrator | 持久化事实来自进程外 | 校验后只向内部 tracker 传 direction 等已解析事实 |
| 买入前监控行情、静态清仓 quote 集合 | 需要读取 HSI 价格 | 作为行情查询 symbol，不作为内部 route key |
| 日志与展示 | 供操作者辨识唯一监控对象 | 不写入内部队列、route 或状态 key |

本轮扫描得到 21 个 monitorSymbol 命中位于 async quote、静态清仓、日志和 HSI 行情读取；src/main/tradingRiskEventRuntime 为 0。它们没有形成按 monitor 的内部 Map、任务 payload 或 route key。

## 6. 二次复核清单

后续复核必须从现有代码事实开始，不得仅依赖本文件或旧计划文字。

### Task 1: 复核单 monitor 主契约

- [ ] 检查 src/config/trading 只暴露 TradingConfig.monitor，没有 monitors[]、索引配置扫描或 \_1 / \_N 环境变量分支。
- [ ] 检查 src/app 只装配一个 MonitorContext，且不存在 Map<string, MonitorContext> 或 lookup helper。
- [ ] 检查 MonitorContext 没有重新缓存席位状态/版本；席位读取必须回到 SymbolRegistry。

Run:

```powershell
rg -n "tradingConfig\.monitors|monitorContexts|getMonitorContext|MultiMonitorTradingConfig|originalIndex|MONITOR_SYMBOL_1|MONITOR_SYMBOL_N|collectIndexedMonitorConfigKeys" src tests mock README.md .env.example
rg -n "Map<string,\s*MonitorContext>|ReadonlyMap<string,\s*MonitorContext>|routesByMonitor|queuesByMonitor|registryByMonitor|byMonitor" src tests mock README.md .env.example
```

Expected: no active hits.

### Task 2: 复核内部与外部边界

- [ ] 内部任务、route 和 tracker 不传递 monitor 路由字段；保留的 key 只能是 direction、seatVersion、symbol 或订单 id。
- [ ] 外部事件、订单、恢复快照和 trade log 的 monitorSymbol 均在边界校验，且不存在静默映射到 HSI。
- [ ] OrderExecutor 在提交任何副作用前验证 action 方向、当前席位方向和 seatVersion 一致。

Run:

```powershell
rg -n "MonitorTaskContext|seatProjection|routesByKey|buildCooldownKey|getMonitorSymbol|SeatVersionChangedEvent|resolveMonitorContextRuntimeSnapshot|collectBoundSeatSymbols" src tests mock
bun test tests/integration/buy-flow.integration.test.ts
```

Expected: 第一条无活跃命中；买入集成测试包含“动作方向与席位方向不一致” fail-fast 场景并通过。

### Task 3: 复核测试是否保护业务而非旧结构

- [ ] 不新增“第二个 monitor”“字段不存在”“旧字符串不存在”类测试。
- [ ] 可以保留能阻止错误下单、错误恢复、错误归因、跨方向账本污染和 seatVersion 陈旧执行的行为测试。
- [ ] 删除任何只为锁死内部对象形状而存在的断言；不以删测试为由删除外部边界和方向隔离的业务测试。

Run:

```powershell
rg -n "'monitorSymbol'\s+in|'monitorContext'\s+in|@ts-expect-error.*monitorSymbol" tests
```

Expected: no hits.

### Task 4: 完整验证

- [ ] 先运行格式化，再运行 lint、类型检查、完整测试和构建。
- [ ] 扫描结果按“活跃代码 / 活跃测试 / 当前文档 / 历史文档 / 合法外部边界”分类，不能仅凭关键字决定删除。
- [ ] 不对用户已有大规模工作树执行 reset、checkout、revert 或自动提交。

Run:

```powershell
bun format
bun lint
bun type-check
bun test
bun run build
git diff --check
```

Expected: 全部 exit 0；git diff --check 允许 CRLF 提示，但不得有空白错误。

## 7. 本轮验证证据

| 检查 | 结果 |
| --- | --- |
| 红测：错误 BUYPUT + LONG symbol | 修复前 buy-flow 明确失败：Promise 实际 resolved 且提交订单，证明问题可重现 |
| 绿测：最终下单方向守卫 | bun test tests/integration/buy-flow.integration.test.ts：11 pass / 0 fail |
| 末日保护定向测试 | bun test tests/integration/doomsday.integration.test.ts：16 pass / 0 fail |
| 测试/文档精简定向测试 | 5 个文件 24 pass / 0 fail |
| 格式化 | 第二次 bun format exit 0；第一次暴露的 lint 问题已修正后重跑 |
| Lint | bun lint exit 0 |
| TypeScript | bun type-check exit 0 |
| 完整测试 | bun test：1116 pass / 0 fail / 3666 assertions |
| 构建 | bun run build exit 0 |
| 残留扫描 | 旧多标的标识、单元素外壳、测试 shape lock 均为 0 活跃命中 |
| 空白检查 | git diff --check exit 0；仅有现有工作树 CRLF 提示，无空白错误 |
| 进程清理 | 复核后没有存活的 bun 进程 |

## 8. 协作审查记录与边界

- 简化/死代码复核确认：生命周期和风险路由没有重新引入 monitorContexts、MonitorTaskContext、seatProjection、routesByKey 等壳；仍存在的 symbol-keyed 容器均具有订单、方向或行情的业务意义。
- 运行时/类型复核确认并促成 F-01：最终下单边界必须独立保护 action 与席位方向一致性。该结论已由红绿测试和完整测试二次验证。
- 规范/测试复核用于删除实现形状锁、修正文档命名，并保留真正的方向、恢复和外部事实业务测试。
- 两名较早的执行型子代理因额度限制中止；其未交付结论未被当作证据。主线程以源代码、定向测试、完整测试、构建和残留扫描完成了补充验证。

## 9. 当前状态

本报告覆盖的修复均已存在于当前工作树；未执行 reset、revert、checkout、stage、commit 或远程发布。工作树原本包含大规模重构修改，后续提交时应由提交者按业务边界审阅 diff，而不是依据“工作树是否干净”判断本轮正确性。
