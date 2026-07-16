# HSI 全仓高频交易性能审查结论

> 审查日期：2026-07-15
> 审查性质：只读、性能优先的全仓静态审查；未修改交易代码、配置或测试。
> 结论状态：所有列入“已确认”的项均已由独立第二代理重新追踪调用链与业务边界；实际毫秒级收益仍须通过生产回放或基准测试量化。

## 1. 审查方法与覆盖范围

审查将生产代码和对应测试按运行时职责拆为四个独立域：

1. 行情、指标、策略、信号与异步队列。
2. 风控、下单、订单监控、订单记录与日内亏损投影。
3. 生命周期、时间唤醒、订阅、展示、外部 I/O 与持久化。
4. 自动寻标/换标、启动装配、配置、公共工具与支撑运行时。

每个域先进行只读初检，再由未参与该域初检的代理独立复核候选。审查范围清单包含 251 个生产 TypeScript 文件和 173 个测试 TypeScript 文件；深度调用链追踪聚焦可达的热路径与对应业务边界。

本文件中的“优先级”是建议的测量/实施顺序，不等同于已量化的 p99 影响，也不等同于交易正确性严重级别。

## 2. 总体结论

没有可仅凭静态源码判为 critical 的交易正确性或性能缺陷。

已确认的主要问题集中在四类：

- 主线程同步磁盘持久化。
- 高频展示路径重复读取行情并写日志。
- K 线和指标 preview 的短生命周期对象分配。
- 成交后按方向全量重建日内亏损投影。

其余候选中，一部分是明确存在的结构性成本，但必须先用真实频率、SDK 时延、GC 与事件循环延迟决定是否值得改造；另一部分因交易语义或 SDK 并发契约不明确，不应直接实施“并行化”或“缓存化”。

| 建议优先级 | 已确认机制 | 主要影响 |
| --- | --- | --- |
| P0 | 同步全量成交日志持久化与 `fsyncSync` | 直接阻塞 Node 事件循环 |
| P1 | 高频展示补读行情并写双路日志 | 竞争 SDK、CPU、终端/文件 I-O |
| P1 | 活动 K 线指标状态克隆、K 线快照复制 | 增加分配率、GC 与行情处理尾延迟 |
| P1 | 日内亏损投影按方向重建 | 订单规模增长后的 CPU 与 GC |
| P2 | 风险冷却发生在实时行情读取之后 | 被拒绝买入任务仍消耗 quote 读取 |
| P2 | 全局交易 mutation FIFO | 慢 quote/SDK 造成跨订单队首阻塞 |
| P2 | 静态清仓先读多标的行情再筛阈值 | 自动寻标关闭时的额外 SDK I-O |
| P3 | 样本扫描、订阅集合重投影等 | 存在成本，但须先证明运行时占比 |

## 3. 已确认的高优先级优化点

### 3.1 P0：同步全量交易日志持久化阻塞事件循环

**位置与运行时路径**

- `src/services/mixedTradeLogRepository/index.ts:416-426,479-513,578-611`
- `src/core/trader/orderMonitor/settlementFlow.ts:373-395,760-774`
- `src/app/runtime/createPostGateRuntime.ts:435-446`

保护性清仓成交进度和带有效成交上下文的终态订单会触发同步持久化。每次新增记录都可能执行全量文件读取、JSON 解析与 schema 校验、全量序列化、同步写入、`fsyncSync` 和原子重命名；保留策略还可能扫描日志目录。单次成本随当日混合记录数 `R` 增长，且同步磁盘等待发生在 Node 主线程上。

因此，磁盘抖动会延迟 WebSocket 订单回报、行情回调、风险任务、定时器和异步队列消费。一次保护性终态还可能先写 progress、后写普通 trade record，产生两轮整文件处理。

**不能破坏的业务边界**

- 保护性清仓 progress 必须在 `DailyLossTracker` 提交权威事实前获得 durable ACK。
- 持久化失败时，不得释放待成交卖出占用、清理订单跟踪或发出终态事件。
- 不可直接改为 fire-and-forget、删除 `fsync`、合并/重排成交事实，或改变 fatal 与恢复顺序。

**最小安全方向**

将普通 trade record 与保护性 progress 的耐久性边界显式区分。保护性 progress 保持“写前 ACK + 幂等可重放”；普通终态记录再迁移为单写者、顺序化的 append-only journal/WAL 或等价持久化器。无论采用何种实现，主流程必须仍能等待要求的 durable ACK。

**需要测量与验证**

- 按 1/100/1,000 条当日记录与连续终态事件，记录写入 p50/p95/p99、文件大小、CPU、event-loop lag 与订单事件排队时长。
- 执行崩溃注入：progress 写前/写后、内存事实提交前、终态事件前。
- 重启回放、幂等冲突、保护性清仓进度顺序及持久化失败阻断必须回归。

### 3.2 P1：展示路径可以接近行情推送频率读取 quote 与写日志

**位置与运行时路径**

- `src/main/businessEventProgram/index.ts:145-147`
- `src/main/monitorDisplayRuntime/index.ts:45-112`
- `src/main/tradingQuoteDisplayRuntime/index.ts:103-226`
- `src/services/quoteClient/index.ts:391-441`
- `src/services/marketMonitor/index.ts:225-327`
- `src/utils/logger/index.ts:451-599`

成功指标推进会请求 monitor 展示；交易标的 quote push 也会请求交易展示。两个 runtime 都已有 single-flight/latest-only，故不是无限并发读取；但当前一次读取很快完成时，下一条事件可立即再次调用 `ctx.realtimeQuote`，然后进行字符串格式化并向 console/file 两个 sink 写 INFO 日志。

展示不阻塞交易业务逻辑的语义，但它与信号、风险、下单共享事件循环、SDK 调用能力、内存和输出带宽，可能抬高尾延迟。

**最小安全方向**

展示路径独立限频、latest-only 合并并缓存最新可展示 quote。只能降低展示刷新频率，不能降低风险检查、下单行情、席位版本复核、信号处理或交易事件频率。必须保留 runtime gate、single-flight、route-current 校验和展示失败隔离。

**需要测量与验证**

- 记录 quote push/s、display cycle/s、`realtimeQuote` 调用数、日志字节、logger drain 与 event-loop p95/p99。
- 比较现状、仅 latest-only、限频渲染三种策略下的业务 handler p99 与最终展示状态。
- 新增快速 quote 返回时的限频测试，确保最后一个 snapshot 必达。

### 3.3 P1：活动 K 线 preview 与 K 线快照存在确定性分配热点

**活动 K 线指标状态克隆**

- `src/services/indicators/runtime/index.ts:126-136,515-521`
- `src/main/businessEventProgram/indicatorPipeline.ts:41-71`

每个未收线活动 K 线的成功更新会克隆完整 committed 指标状态，再生成 preview snapshot。EMA、RSI、PSY、MFI、KDJ、MACD、ADX 等启用指标的内部记录或数组会被复制。成本随指标族、周期与窗口长度增长，属于同步行情热路径中的 CPU/分配热点。

不能通过就地写 committed state 优化：活动 K 线不得污染 confirmed 基线，confirmed、shift、回放和缺失值语义必须与当前增量/全量算法一致。

**K 线快照数组复制**

- `src/services/quoteClient/candlestickCache.ts:164-302`
- `src/constants/index.ts:58-63`

有效且发生变化的 K 线 push，在 200 根窗口已满时至少创建两份 200 元素数组；同 timestamp replace 通常还会产生额外的 199 元素切片。乱序、重复和 confirmed 回滚已提前返回，不承担该成本。

**最小安全方向与验证**

先以 10k/100k 活动 K 线回放测 allocation rate、minor GC、handler p50/p99。可评估数组所有权移交、避免对刚构造的数组再复制、或严格受控的 copy-on-write；必须回归活动更新、确认、shift、重放、snapshot version、乱序与 confirmed 单调性。

### 3.4 P1：成交事实变化会重建方向级日内亏损投影

**位置与运行时路径**

- `src/core/riskController/dailyLossTracker.ts:148-236,909-998`
- `src/core/orderRecorder/orderFilteringEngine.ts:71-157`
- `src/core/orderRecorder/sellDeductionPolicy.ts:73-96`

权威累计成交事实变化后，系统会重建该方向的 `DailyLossState`：遍历已记录事实、复制买卖数组、排序卖单，并按“时间顺序 + 低价优先 + 整单不拆分”规则过滤买单。该机制不是每笔成交重新读取 API `allOrders`；全量 API 重建仅发生在启动重建/seat refresh。但日内方向事实增多、部分成交频繁时，现有重投影依然形成规模相关的 CPU、排序与临时数组成本。

**不能破坏的业务边界**

必须保持乱序/重复 revision 拒绝、累计金额修订、OPEN 到 TERMINAL 状态变化、保护性清仓分段 baseline，以及低价优先整单扣减口径。

**最小安全方向**

先引入“本次事实变化是否真正影响损益投影”的精确结果位，跳过 stage-only、等量等金额的无效重投影。若后续实现增量投影，现有全量算法必须保留为 oracle，用随机乱序、部分成交、金额修订与保护性边界序列逐事件对照。

## 4. 已确认但应先 profile 的优化点

### 4.1 买入冷却在读取实时行情后才生效

- `src/main/asyncProgram/buyProcessor/index.ts:90-137`
- `src/core/signalProcessor/riskCheckPipeline.ts:126-167`

买入任务先读取 monitor/LONG/SHORT 三标的 quote，才进入风险冷却。策略连续命中、队列积压且冷却拒绝时，任务仍已消耗实时行情读取。

可考虑先做不依赖 quote 的只读冷却准入；正式冷却占用仍应保留在原风险管道，且必须保留初始/最终 seat-version 校验与下单前最新行情校验。先记录冷却命中数、冷却前 quote 次数、队列深度、任务 age 与 quote latency。

### 4.2 全局交易 mutation FIFO 的队首阻塞

- `src/core/trader/rateLimiter.ts:45-58,96-126`
- `src/core/trader/orderExecutor/submitFlow.ts:423-578`

单一 `sequenceTail` 将最终 quote、授权、数量计算、SDK 提交和本地跟踪收口串行化。慢 quote 或 broker 请求会阻塞跨标的提交、取消和改单。该机制是显式正确性设计，不应轻率拆分 final quote 与下单，否则会重新引入 quote-to-order TOCTOU、API 间隔或待卖占用问题。

先为 queue wait、最终 quote、授权、SDK、local-sync 分段打点。只有证明跨标的原子性可以细分后，才评估“全局 API 配额 lane + 更窄的业务 mutation lane”。

### 4.3 自动寻标关闭时，静态清仓在阈值筛选前读取多标的行情

- `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:172-224`
- `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts:772-815,837-851`

在 static liquidation 模式，每个可处理 route 先读取 monitor、LONG、SHORT quote，再判断距回收价阈值。route 已有 latest-only 合并，但正常区间、空仓或仅一侧有效时仍可能发生不必要的批量读取。

不得以旧 `event.quote` 替代当前清仓事实。任何预筛都必须保留 lifecycle/末日/freshness 门禁、WAIT/retry、seat-version、方向去重和最终执行行情语义。仅在该模式的 route rate、阈值命中率与 SDK 批量读取成本确认后实施。

### 4.4 延迟验证样本与策略求值的局部 CPU 成本

- `src/main/asyncProgram/indicatorCache/utils.ts:30-86`
- `src/main/asyncProgram/delayedSignalVerifier/utils.ts:169-177`
- `src/core/strategy/index.ts:160-180`
- `src/core/strategy/utils.ts:86-169`

延迟验证对 T0/T0+5s/T0+10s 各做一次线性最近样本查找；过期前缀清理在真正过期时才有 size-dependent `splice` 成本，并非每次 push 都全量扫描。策略求值存在“可评估性 + 阈值判断”双扫描，但能短路，且周期解析已有模块级缓存。

它们适合作为 profile 驱动的低风险 CPU 优化：保留三时点、等距取后者、无时间容差、缺失即失败、OR/N-of-M 与 reason 文本语义后，评估 head index/二分定位或预编译 evaluator。

## 5. 低优先级或条件性优化点

### 5.1 订阅集合无变化时的本地重投影

- `src/main/quoteSubscriptionRuntime/index.ts:26-28,67-123,158-243`

seat/order/retain 事件即使不改变最终订阅集合，仍可能重建 owner、desired、committed Set 与 added/removed 数组，并进入 `mutationChain`。已确认这不是重复 SDK subscribe/unsubscribe，而是本地 `O(R + S + C)` 分配与微任务噪音。

如有高频 churn，先在 owner 投影层做集合等价短路；若合并队列，每个调用者仍须等到自己的 revision 已 reconcile，并保留 `waitForAdmission` 补偿检查和 fatal 传播。

### 5.2 待成交卖单按 symbol 查询未复用已有索引

- `src/core/trader/orderMonitor/index.ts:528-562`
- `src/core/trader/orderMonitor/routingIndex.ts:90-124`

`getPendingSellOrders(symbol)` 扫描全部 tracked orders、复制并排序，尽管已有 `trackedOrderIdsBySymbol`。可从该索引获取候选，再复用原有 open-status、`PartialWithdrawal`、剩余量和 `submittedAt` 排序；收益取决于同时追踪订单数，通常较小。

### 5.3 自动寻标 TTL 命中后仍扫描候选列表

- `src/services/autoSymbolFinder/index.ts:181-247`
- `src/services/autoSymbolFinder/utils.ts:294-331`

TTL 命中只复用 warrant 原始列表，`findBestWarrant` 仍对全列表执行 Decimal 判定、流动性计算与主/降级候选选择。它不在逐笔行情热路径中，只有候选列表较大且短时间重复寻标时才可能值得优化。

不能直接缓存最终候选：`tradingMinutes`、流动性阈值、方向策略、主/降级候选带和稳定并列顺序都会影响结果。仅在 profile 证实后，才能按“列表版本 + 完整选择输入”缓存不可变评估投影。

## 6. 已复核的非问题与保护边界

- 系统时间、自动寻标和周期换标均使用 bounded one-shot timer、route 去重和 stop 清理，不存在应替换为轮询的需求。
- 风险、行情和订单路由的 single-flight/latest-only、freshness、seat-version 二次校验是必要正确性机制，不能为减少调用而删除。
- 订阅 SDK 调用仅发生在真实 added/removed 差集存在时；优化重点仅限本地投影。
- 配置解析、认证初始化、常量构造、runtime-symbol 校验和 type-only 模块均在启动/编译边界，不是稳态行情热点。
- 持仓缓存只在成交后刷新时 `O(P)` 重建，后续按 symbol 查询为 `O(1)`。
- `RefreshGate.waitForFresh()` 在 stale 时确实逐调用创建 waiter，但当前调用图受单飞、latest-only、卖出串行和 LONG/SHORT 方向上限约束，同时等待者是小常数；仅建议监控 waiter 高水位，不作为当前性能问题。
- 双方向空席位恢复寻标确实串行，但最多影响 LONG/SHORT 两个方向的启动/开盘重建冷路径。未验证 SDK 并发契约和失败原子性前，不应直接改为 `Promise.all`。

## 7. 建议的验证与实施顺序

1. **先增加低开销指标**：event-loop lag、同步日志写入耗时/文件大小、quote push 与 display cycle 比、`realtimeQuote` 调用数、活动 K 线 handler p99/分配率、日内亏损投影耗时、mutation queue wait。
2. **建立三组真实回放基准**：高频活动 K 线、连续部分成交/保护性成交、慢 quote/慢 broker 并发提交。
3. **按安全性实施**：先处理有 durable ACK 约束的持久化器，再隔离展示 I-O，随后降低 snapshot/preview 复制，之后为日内亏损投影增加等价无效重算短路。
4. **每项优化都回归业务不变量**：seat version、最新行情、延迟验证三时点、低价优先整单扣减、保护性清仓 durable 顺序、恢复失败阻断、末日清仓。

## 8. 审查限制

- 未运行 CPU/heap profile、压力测试、全量测试或生产行情回放，因此不提供毫秒级收益承诺。
- 未确认 Longbridge 同一 `QuoteContext` 下 `staticInfo`/`quote`、或双方向 warrant 查询的并发额度、线程安全与失败收口；不应据此直接并行化。
- 审查过程中发现工作区已有大量未提交改动；本次仅新增本结论文档，未修改任何交易代码、配置或测试。
