# Mixed Trade Log 严格 JSONL 异步持久化重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. 生产链任务 4 至任务 10 必须作为一个不可拆分的上线单元完成，并在最终合并前使用 superpowers:requesting-code-review 进行独立复核。

**Goal:** 在不改变订单结算、保护性清仓、DailyLoss、冷却与恢复业务逻辑的前提下，将当日 mixed trade log 从同步全文件 JSON 数组读改写，重构为严格 JSONL、进程内单写者、异步 durable append，使追加成本不再随当日历史记录数线性增长，并避免磁盘等待冻结事件循环。

**Architecture:** 每个交易日使用一个严格 JSONL 文件。Repository 独占 lazy materialized 文件句柄和单写者 Promise 链；ACTIVE WebSocket 事件由只同步登记 thunk、从后续 microtask/drain 执行业务的全局 FIFO 保序，并用显式 barrier 完成 BOOTSTRAPPING handoff。SDK event ingress gate 与 route execution gate 必须正交：handoff 同步段只把 ingress 从启动缓存切到 FIFO，cached/new event 均按顺序进入同一 FIFO；recovery barrier 成功前 `recoveryReady=false`，任何 cached/new event 的 `triggerRoute` 都直接 no-op；barrier 成功只设置 `recoveryReady=true`，不启动 route，随后仍由既有生命周期位置调用 `routeRuntime.start()`。`start()` 必须先断言 ready，只有 ready=true 才能修改 running、订阅 quote 并在现有 bootstrap 边界唯一执行 active route bootstrap；ready=false 必须保持完全未启动并 fail fast。同一个 OrderMutationLane 由 trader composition root 创建并注入 orderMonitor 与 orderExecutor；改单在同一 order lane 内采用严格两阶段结构：第一阶段申请 RateLimiter trade-mutation permit，permit callback 内只完成最终行情、merge truth、授权复核和唯一 broker replace attempt，随后释放 permit；closed-business-error 与 602013 返回不同 attempt result，前者释放 permit后立即权威查询，后者由专用 Owned finalization 保持前四次 1/2/4/8 秒退避且不查询，仅第五次在 permit 已释放后进入权威查询。全部累计成交事实与 completion 由 LONG/SHORT per-direction lane 串行；保护性 SELL admission 的可见性必须早于任何路径首次让旧 protective pending 对 completion 不可见：executor 新单链在取得 order/RateLimiter 前独立登记；WS timeout terminal eventFlow 在已持有 order lane 时、把 tracked status 改为 closed 前短暂进入 direction lane 登记，并把同一 token 附着到 timeout conversion terminal state 交给 route；API query/route 若旧 tracked 仍 open 且没有已移交 token，则在确定 `SETTLE_AND_CONVERT` 后、旧 settlement 前登记。completion 在 direction lane 内从 flat/pending/admission 资格读取一直持有到 durable commit；eventFlow 到 route、旧 tracked 消失到新 `trackOrder`/recorder 发布之间 token 持续可见，route 不得重复 reserve。任何 broker await 都不持有 direction lane，最终按明确 disposition 清除或保留 token。资源顺序固定为：executor admission 独立 `direction → release` 后再申请 order/RateLimiter；WS eventFlow 与 API route 只允许在现有 order ownership 内短暂 `order → direction reserve → release`；completion 从不申请 order lane，因此该短临界段不形成环。progress 与 completion 保持 durable-first，ordinary 保持本地结算完成后再 durable append 的现有边界。

**Tech Stack:** TypeScript、Bun 1.3.14、Node 文件系统 Promise API、FileHandle.appendFile、FileHandle.sync、Bun test、现有 Zod/领域校验器与项目生命周期框架。

---

## 1. 文档状态

### 1.1 结论状态

本文是 2026-07-15 对 P0“同步全量交易日志持久化阻塞事件循环”完成首次审计与方案设计，并在 2026-07-16 按当前源码重新完成并发、生命周期和 listener 全链路复核后的最终实施方案。

确认结论：

- 问题真实存在：当前三类 append 都会同步读取、解析、严格校验并全量重写当日 JSON 文件，同时执行同步 fsync。
- 事件循环阻塞真实存在：同步文件 I/O、全量 JSON parse、schema 遍历、stringify 和写入均在主 JS 线程内联执行。
- 优化方向明确：append-only 与异步文件 API 能消除 O(R) 全量重写，并允许事件循环在磁盘等待期间继续运行。
- 绝对收益不承诺固定百分比：生产收益取决于每日记录规模、保护性 progress 突发频率和部署磁盘尾延迟。
- 本重构按正确性敏感的高优先级治理执行；不以降低耐久性换取吞吐。

### 1.2 本文取代的旧设计

以下旧设计已经被二次审查否决，不得作为本文的实现变体重新引入：

- 全局 TradeFactCommitCoordinator。
- 自定义二进制 frame、header、sequence、checksum、SHA-256 或 commit magic。
- Worker 搬运全文件重写。
- group commit。
- ordinary batch 或非 durable 模式。
- 任意 queue record 数、queue bytes 或 payload size 阈值。
- DailyLoss 累计成交事实的新增 prepare/commit 状态机。
- 多进程共同写入协议。
- 运行时旧 JSON 数组兼容读取、格式自动探测、双读、双写或 JSON fallback。
- 反向迁移工具。
- 写入失败后回退到同步 JSON 数组重写。
- 超时后继续业务提交。
- 自动跳过任意完整坏行。
- 猜测、补全或解析未以 LF 结束的尾部。
- 将 STOPPED 状态下正常晚到的 SDK event 升级为 fatal。
- 强制所有同步 order-state listener 包装为 async Promise-only listener。
- FILE_FINISHED_RETENTION_PENDING 与 retention 专用自动重试状态机。
- order lane 内部函数再次申请同一 orderId lane 的隐式重入设计。
- ACTIVE FIFO `admit()` 调用栈内同步执行业务闭包。
- 已经持有 TradeMutationPermit 后再申请 order lane。
- 在 `withTradeMutation` callback 内直接或间接调用 `orderStatusQuery.checkOrderState`、`rateLimiter.throttle` 或再次调用 `withTradeMutation`。
- 用兼容 wrapper、旧 `replaceOrderPriceWithRunner` 委托或旧 `replaceOrderPriceWithPermit` 入口把 broker attempt 与 permit 释放后的权威 query 重新合并。
- completion append 后再重查 pending/admission 并补偿、回滚或删除 completion。
- 为 admission 增加磁盘 marker、超时自动释放、跨进程租约或恢复期兼容 reader。

### 1.3 部署原子性

任务 1 至任务 3 可以作为纯测试与底层准备独立合并。

任务 4 至任务 10 改变 repository、异步契约、订单事件顺序、业务提交边界和生命周期关闭顺序，必须作为一个不可拆分的生产部署单元。该单元未全部完成时，不得部署交易程序。

任务 11 是停机迁移与工具切换；必须在任务 4 至任务 10 完成并验证后执行。最终 release artifact 必须先在生产 `logs/trades` 的完整备份副本上运行离线 persistence verifier，且 verifier 只能执行 migration、唯一 codec/repository strict open、恢复数据解析断言、费用工具与 close；不得装配 trader、建立 broker/行情连接、启动 producer 或修改 broker。演练使用的 binary、配置 schema 与迁移/费用工具必须和待部署产物完全相同。

生产目录第一次受控 rename `active → backup` **开始时**即进入只允许 strict JSONL-compatible fix-forward 的不可逆阶段。legacy backup 从这一刻起只作为离线迁移等价性和审计证据，不再授权旧 binary、旧目录或任何反向恢复。该边界不能推迟到 producer 或 append：生产可写 startup/recovery 在 producer 启动前就可能因 crash-gap completion 执行 append，而 producer 启动后还可能先产生 broker 事实再暴露本地失败；因此生产第一次 rename 后，任何可写启动前都必须已经接受单向 strict JSONL 激活语义。

---

## 2. 已确认的当前运行时事实

| 事实 | 当前位置 | 当前语义 |
| --- | --- | --- |
| 当日 mixed log 全量读取与校验 | src/services/mixedTradeLogRepository/index.ts:416 | existsSync、readFileSync、JSON.parse、逐条 schema 校验 |
| 当日 mixed log 全量原子重写 | src/services/mixedTradeLogRepository/index.ts:479 | mkdirSync、openSync、writeFileSync、fsyncSync、renameSync |
| completion append | src/services/mixedTradeLogRepository/index.ts:537 | 同步、幂等、写入返回前 durable |
| execution progress append | src/services/mixedTradeLogRepository/index.ts:578 | 同步、幂等、写入返回前 durable |
| ordinary trade append | src/services/mixedTradeLogRepository/index.ts:602 | 同步、全量重写 |
| retention 扫描 | src/services/mixedTradeLogRepository/index.ts:507 | 当前仅在实际新增记录前执行；UNCHANGED 与无 append 不触发，保留上限来自 LOGGING.MAX_RETAINED_LOG_FILES |
| DailyLoss 权威事实提交钩子 | src/core/riskController/dailyLossTracker.ts:946 | 钩子返回后才写 filledOrderFactsById |
| 保护性 progress 调用 | src/core/trader/orderMonitor/settlementFlow.ts:345 | progress 在 DailyLoss 权威事实提交前持久化 |
| ordinary 事件发出 | src/core/trader/orderMonitor/settlementFlow.ts:760 | closed、tracking 清理后发出 |
| order-state listener 遍历 | src/core/trader/orderMonitor/index.ts:127 | Set 插入顺序同步调用 |
| SDK WebSocket callback | src/core/trader/orderMonitor/index.ts:469 | callback 内同步调用 eventFlow |
| BOOTSTRAPPING replay | src/core/trader/orderMonitor/recoveryFlow.ts:166 | 当前同步 snapshot、sort、clear 后逐条直接执行 ACTIVE handler，再切换 ACTIVE |
| 全局 trade mutation FIFO | src/core/trader/rateLimiter.ts:45,107 | withTradeMutation callback 持有全局序列席位，直到最终行情、授权、SDK mutation 与回调收口完成 |
| signal 卖单合并改单 | src/core/trader/orderExecutor/submitFlow.ts:738 | 当前先取得 TradeMutationPermit，再调用 orderMonitor.replaceOrderPriceWithPermit |
| route 普通改单 | src/core/trader/orderMonitor/routeProcessor.ts:1014 | 当前 orderMonitor 内部改单路径自行申请 RateLimiter trade-mutation permit |
| replace runner 自重入 | src/core/trader/orderMonitor/orderOps.ts:578,618,674,847 | signal merge 持有外层 TradeMutationPermit 时，closed-business-error 或第 5 次 602013 分支仍会调用 orderStatusQuery.checkOrderState |
| 权威订单查询限流 | src/core/trader/orderMonitor/orderStatusQuery.ts:57 | checkOrderState 首步调用 rateLimiter.throttle，与 withTradeMutation 共用同一个非重入 sequenceTail |
| broker 接受后的 trackOrder | src/core/trader/orderExecutor/submitFlow.ts:528,546 | broker 接受后在同一 permit callback 内同步一次性发布 tracked order |
| ordinary listener | src/app/runtime/createPostGateRuntime.ts:435 | order-state event 后同步 append |
| completion 提交链 | src/app/runtime/createPostTradeConsistencyRuntime.ts:194 | prepare → persist → DailyLoss/cooldown/episode commit |
| 启动快照读取 | src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:281 | completion 与 progress 分别读取同一文件 |
| crash-gap completion | src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:472 | append 成功后提交恢复边界 |
| cooldown hydrator | src/services/liquidationCooldown/tradeLogHydrator.ts:17 | 当前再次读取 repository |
| 午夜停止顺序 | src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:90 | 依次停止 producer、order monitor、post-trade |
| shutdown phase | src/constants/cleanup.ts:8 | post-trade stop 后尚无 repository close phase |
| 日志路径 | src/utils/trading/tradeLogPath.ts:12 | 当前为 logs/trades/YYYY-MM-DD.json |

当前定向基线：

- 5 个相关测试文件：86 pass、0 fail、338 assertions。
- Bun 1.3.14 Windows 临时目录验证：两条 JSONL 可通过 appendFile、sync、逐行 JSON.parse 完成写读闭环。
- 在 sync Promise 等待期间，zero-delay timer 能运行，证明异步磁盘等待不会像同步 fsync 一样冻结事件循环。
- 当前基线 git diff --check 通过。

---

## 3. 不可改变的业务契约

### 3.1 Execution progress

必须保持以下顺序：

1. 进入对应 order lane。
2. 在 order lane 内进入对应 direction lane。
3. 在 direction lane 内读取 current fact、合并输入并判断权威事实是否变化。
4. 保护性 SELL 且事实变化时，生成唯一 canonical progress record。
5. repository append 并完成 sync。
6. append ACK 后才提交 filledOrderFactsById。
7. 非保护性事实不写 progress，但其 current fact 读取、merge、权威事实提交与方向重算同样必须留在 direction lane 内。
8. 权威事实提交后才能重建方向 baseline、重算 DailyLoss、记录保护性 episode progress、请求 post-trade refresh。

失败语义：

- append 或 sync 失败时，不得提交新的 DailyLoss 权威事实。
- 不得执行依赖该新事实的 episode progress 与 refresh 副作用。
- 错误必须沿当前 settlement/event/route/recovery Promise 链传播到 fatal 通道。

不改变：

- authoritativeFactChanged 与 executionAdvanced 的判定。
- OPEN、TERMINAL 与 revision merge 规则。
- progressId、canonical payload 和冲突判定。
- 方向隔离与 protection boundary 算法。

### 3.2 Completion

必须保持以下顺序：

1. 进入对应 direction lane，并在该 ownership 内读取最新 flat、pending protective orders 与 in-flight protective admission。
2. 只有 flat=true、pending=false、admission=false 时才 prepare episode。
3. prepare DailyLoss protection boundary。
4. 生成 canonical completion record。
5. repository append 并完成 sync；在 ACK 返回前持续持有同一 direction lane，使新的 protective admission、同方向 progress 和另一 completion 都只能排队。
6. durable ACK 后 commit DailyLoss boundary。
7. 写入 liquidation cooldown。
8. commit protective episode。

失败语义：

- durable ACK 前任何 completion 业务状态都不得提交。
- completion append 失败时，不得提交 DailyLoss boundary、cooldown 或 episode。
- crash-gap completion 补写同样遵守 durable-first。
- append 后不得再以 pending/admission 二次检查、补偿记录或回滚 completion；资格线性化必须在 append 前由 direction lane 一次完成。

不改变：

- completionId 与幂等冲突规则。
- flat、pending protective orders、boundary 时间和 order baselines 判定。
- cooldown 次数、窗口与触发逻辑。

保护性订单 admission 契约：

- admission 不是订单、episode 或持久化事实，只是进程内“本方向存在一个尚未完成 broker 收口、且可能产生或替换保护性 SELL”的短生命周期 token。
- protective SELL admission 必须在任何路径首次让旧 protective pending 对 completion 不可见之前登记。executor 新单链通过独立 `direction lane → reserveOwned` 登记；WS timeout terminal eventFlow 必须在已持 order lane 内、写入 closed tracked status 前短暂执行 `order lane → direction lane → reserveOwned`，并把 token 附着到 timeout conversion terminal state；API query/route 仅在旧 tracked 仍 open、terminal state 未携带 token且已确定 `SETTLE_AND_CONVERT` 时，于旧 settlement 前登记。所有登记都立即释放 direction lane，绝不能持有 direction lane 等待状态写入、settlement、RateLimiter、broker 或 query。
- completion 在同一 direction lane 内同时检查 flat、pending 和 admission；任一 admission 存在即不得 prepare completion，并且从资格读取到 durable commit 结束前一直持有 direction lane，阻止新 admission 插入。
- broker 明确未尝试、明确拒绝、业务明确 SKIPPED，或 broker accepted 且 `trackOrder` 与必要 recorder 占用已同步成功发布后，才允许在 permit/order ownership 释放后通过 direction lane 清除 token。WS timeout 的成功路径必须形成 `admission visible → tracked status closed → terminal state carries same token → route reuses token → old tracked settlement → broker attempt → new tracked/recorder visible → admission cleared`，eventFlow 到 route 之间不得释放或重复 reserve。
- tracked 已 closed 且 timeout terminal state 已携带 `protectiveAdmission` 时，后续可合并的重复或更新 terminal fact 必须继承同一 token identity；不得覆盖为 null、替换为新 token或再次调用 reserve。protective timeout terminal state 缺失 token 属于内部不变量错误，必须在覆盖 state、触发 route 或 settlement 前 fail fast。
- unconfirmed submission、broker accepted 后本地 track/recorder 同步失败或其他无法证明“broker 未接受且本地无订单”的结果不得清除 token；必须沿既有 fatal 通道停止 producer。token 不设置超时，也不允许 completion 绕过。
- stop/recovery 失败路径先停止 producer、drain post-trade/FIFO/lanes，再 reset admission registry；进程崩溃自然丢失 token，但下一次启动只能用 broker 全量订单、保护性 remark、progress/completion 与持仓快照重建事实。不得把内存 token 持久化或猜测 broker 结果。

### 3.3 Ordinary trade record

必须保持当前真实业务边界：

1. 订单本地 settlement 先完成。
2. closedOrderIds、tracked runtime、order hold 与 recorder 状态按现有逻辑推进。
3. 发出 order-state event。
4. 在首次 await 前复制 listener Set，固定本次 emission 的参与集合与插入顺序。
5. 按快照顺序逐个 await listener；listener 可以同步返回 void，也可以返回 Promise。
6. ordinary persistence 保持在当前注册位置，由该 listener 构造 canonical record 并 durable append。
7. ordinary listener 完成后才执行其后注册的 switch/periodic listeners。
8. 全部 listener 完成后 settlement Promise 才完成。

失败语义：

- ordinary append 失败会使 settlement Promise reject，并进入 fatal。
- 已完成的本地 settlement 不回滚。
- 不新增补偿事务、回滚状态机或延迟业务提交。
- 任一 listener 同步 throw 或异步 reject 后都不得继续执行后续 listener。

不改变：

- ordinary record 的生成门禁。
- FILLED、部分成交后 CANCELED/REJECTED 与零成交终态的记录规则。
- record 字段、成交归属和费用工具口径。

### 3.4 WebSocket 与订单事件

- STOPPED 状态下，SDK callback 必须同步忽略事件，不进入缓存或 FIFO，不触发 fatal。
- BOOTSTRAPPING 状态下，SDK callback 必须同步把事件放入现有启动缓存，不返回 Promise 给 SDK。
- ACTIVE FIFO ingress 状态下，SDK callback 必须同步把业务 thunk 登记到全局 FIFO；该 ingress 状态不代表 route execution gate 已打开。
- `admit()` 只能登记 thunk 并安排后续 microtask/drain；调用栈内绝不能执行业务闭包。
- FIFO 内部拥有异步 thunk Promise、barrier、错误捕获和 fatal 传播。
- FIFO 必须严格保持 SDK callback 的到达顺序。
- 第一个 event thunk 或 barrier throw/reject 后，FIFO 必须缓存唯一根因并只上报一次 fatal；后续已经接纳或未来接纳的 ACTIVE thunk 不得继续改变业务状态。
- 已排队但被跳过的 barrier、当前 barrier 与未来 `enqueueBarrier()` 返回的 Promise 必须全部使用同一根因 reject，不得永久 pending。
- SDK event ingress 从 BOOTSTRAPPING cache → ACTIVE FIFO 的交接必须在同一个不包含 await 的同步临界段内完成，但该 ingress 切换不得同时打开 route execution gate：
  1. 复制并排序当前 bootstrap cache。
  2. 清空 bootstrap cache。
  3. 将全部 cached events 封装为 thunk，并按顺序同步 admit 到 ACTIVE FIFO。
  4. 在 FIFO 中同步登记 recovery barrier。
  5. 将后续 SDK ingress 切换为 ACTIVE FIFO，同时保持 route execution gate 关闭。
- `admit()` 不得在该同步段内启动任何 cached event；同步段结束后才能从后续 microtask/drain 开始执行。
- 同步交接完成后才能 await barrier。等待期间到达的新 SDK event 必须排在 recovery barrier 之后，不得重新进入 bootstrap cache。
- cached/new event 在 barrier 前即使调用 `triggerRoute` 也必须直接 no-op，不记录额外 route wakeup intent；恢复期间的全部 tracked symbols 会由后续既有 `routeRuntime.start()` 内 bootstrap 统一覆盖，额外 dirty/wakeup 状态没有业务收益且会制造重复 route pass。
- recovery await barrier 成功后只设置 `recoveryReady=true`，不得调用 `bootstrapActiveRoutes()`、不得把 `running` 改为 true，也不得启动 route。route execution gate 的唯一判定是 `runtime.running && runtime.recoveryReady`；既有生命周期仍在原位置调用 `routeRuntime.start()`。`start()` 必须在修改 running、注册 quote listener 或调用 bootstrap 之前断言 `recoveryReady=true`；ready=false 时抛出内部生命周期错误并保持 `running=false`、无 quote subscription、零 bootstrap，不能留下半启动状态。
- barrier reject 必须沿现有 recovery catch 执行 reset、clear cache、关闭 ingress、设置 `recoveryReady=false`、切换 STOPPED 并重新抛出同一根因；`stopRuntimeAndDrain` 与 `clearTrackedOrders` 同样重置 ready。失败路径不得启动任何 route。
- 午夜 runtime stop 必须 drain FIFO 当前任务和所有已经接纳的任务，但保持 FIFO/lane 可在下一交易日复用。
- 最终 shutdown 同样 stop/drain；FIFO 与 lanes 不新增仅服务于进程退出后调用的永久 close 状态。

### 3.5 Order mutation 与 RateLimiter

- OrderMutationLane 持续拥有同一个 orderId 的完整改单 orchestration；RateLimiter trade-mutation permit 和 query throttle 只能作为该 order lane 内先后发生、彼此不嵌套的两个阶段。
- 第一阶段固定为 `order lane → withTradeMutation callback → permit.invoke(broker replace) → callback return → permit release`。
- closed-business-error 必须返回 `NEEDS_AUTHORITATIVE_QUERY`，permit 释放后立即执行 `仍持有同一 order lane → orderStatusQuery.checkOrderState → rateLimiter.throttle → authoritative query`。
- 602013 必须返回独立的 `TEMP_BLOCKED_602013`，不得伪装为 `NEEDS_AUTHORITATIVE_QUERY`：专用 Owned finalization 在第 1 至第 4 次分别写入 1/2/4/8 秒 `TEMP_BLOCKED` 退避且不得 query；仅第 5 次在 permit 已释放、仍持有同一 order lane 时执行权威 query。
- 任意 RateLimiter callback 内禁止直接或间接调用 `orderStatusQuery.checkOrderState`、`rateLimiter.throttle` 或 `rateLimiter.withTradeMutation`；该约束覆盖 signal merge 与普通 route 两条改单路径。
- direction lane 与 repository 只允许在权威 query 已返回 TERMINAL、并进入既有 terminal settlement 路径后按原 durable 边界获取；它们不与 mutation permit 或 query throttle 同时持有。
- 同一个 OrderMutationLane 由 `createTrader` 创建并注入 orderMonitor 与 orderExecutor，不能各自创建私有 lane。
- public order mutation ingress 负责取得 order lane；内部 Owned 函数只消费已经取得的 order ownership，不得重复申请同一 orderId lane。
- signal sell merge REPLACE 必须先进入目标 order lane，再调用 `withTradeMutation`；permit 内重新读取最终行情、重算 merge truth、复核授权并调用唯一的 attempt-only Owned 入口。callback 返回并释放 permit 后，仍在同一 order lane 内消费 attempt result，必要时执行权威 query。
- route 普通改单使用同一 attempt-result → permit release → optional authoritative query 结构；不得保留另一套 runner 或错误处理分支。
- 删除 `replaceOrderPriceWithRunner`、`ReplacePermitRunner` 与 `replaceOrderPriceWithPermit`。新实现不得保留旧入口委托到新入口的兼容层。
- attempt-only Owned 函数只允许读取已持有 order ownership 下的 tracked truth、执行授权复核并调用一次 `permit.invoke`；它不得 query、throttle、重新申请 mutation permit、settle 或 ACK。
- permit 释放后的 completion/finalization Owned 函数严格复用当前 OPEN / TERMINAL / QUERY_FAILED 的事实更新、settlement、错误传播和 ACK 语义。
- broker 已接受的新订单没有可供预先锁定的 orderId；`trackOrder` 继续作为 permit 内的同步一次性发布边界，不得在 permit 内新增异步 order lane 获取，以免改变现有下单成功后的本地收口语义。

### 3.6 保护性 SELL admission 与全局锁序

- admission 的 acquire/release 都是 `direction lane` 短任务，任务结束后不再持有 direction lane。executor 新单链在申请 order lane、mutation permit 或 query throttle 前独立 reserve；WS timeout terminal eventFlow 在已有 order ownership 内、tracked status 首次变 closed 前 reserve 并把 token 移交给 terminal state；API query/route 仅在旧 tracked 仍 open 且没有移交 token时，于旧 settlement 前 reserve。
- 新保护性卖单链路的顺序是：`direction lane reserve → release direction lane → optional order lane → mutation permit → release permit → optional query/finalization → release order lane → direction lane release admission`。
- WS 保护性 timeout follow-up 的顺序是：`order lane/eventFlow → direction reserve → release direction → tracked status closed → terminal state carries token → route reuses token → old settlement/clear tracked → broker submit → synchronous new trackOrder/recorder publish → release order lane → direction release admission`。
- API query/route timeout 的顺序是：`order lane → old tracked remains open → resolve SETTLE_AND_CONVERT → reserve only if terminal state has no token → release direction → old settlement/clear tracked → broker submit/publish → release order lane → direction release admission`。
- completion 的顺序是：`direction lane → flat/pending/admission eligibility → repository → boundary/cooldown/episode commit → release direction lane`。
- order settlement/progress 的顺序保持：`order lane → direction lane → repository`。WS status mutation 前 reserve 与 API route reserve 都复用同一既有方向，只持有极短 direction turn；completion 从不请求 order lane，executor reserve 也会先释放 direction 再等待 order，因此不存在 direction ↔ order 环。任何 mutation permit 内仍禁止 await direction lane。
- accepted order 的 `trackOrder` 仍在 permit callback 内同步发布；admission 清除必须在 callback 返回、permit 释放后发生。禁止为清除 token 在 permit 内 await direction lane。
- admission registry 只保存 opaque token Set；release 必须验证 token identity，重复释放或跨方向释放 fail fast。它不推导订单状态、不自动过期、不参与 JSONL schema。

### 3.7 启动、午夜与 shutdown

- 正常 LF 完整的交易日文件在可写打开时只完整读取一次；只有按协议截断 torn tail 后才严格重读截断结果。
- 同一次启动恢复不得分别为 progress、completion 和 cooldown 重读同一文件。
- 午夜必须先停止所有 producer，再 drain WebSocket FIFO、order lanes、direction lanes 和 repository writer。
- finishTradingDay 完成后才允许清理当日运行态并打开下一交易日。
- shutdown 必须在 order monitor 与 post-trade consistency 停止后关闭 repository。

---

## 4. 最终架构与所有权

### 4.1 串行化层次

```text
SDK WebSocket callback
  ├─ BOOTSTRAPPING → 同步缓存
  └─ ACTIVE ingress → 全局 OrderEvent FIFO（只登记 thunk，后续 microtask/drain 执行）
                  ↓
          shared per-order mutation lane
                  ↓
       如需改单：RateLimiter mutation permit（释放）
                  ↓
       如需权威确认：RateLimiter query throttle（释放）
                  ↓
       必要时 per-direction trade-fact lane
                  ↓
       MixedTradeLogRepository writer chain
                  ↓
          appendFile(line) → sync()

route execution gate（与 SDK ingress gate 正交）
  ├─ recoveryReady=false：cached/new event 可进入 FIFO，但 triggerRoute 直接 no-op
  ├─ start(recoveryReady=false)：fail fast，running/subscription/bootstrap 均不变
  └─ start(recoveryReady=true)：设置 running/订阅，并在 start 内唯一 bootstrap

保护性 SELL admission（与 completion 共用 direction lane 线性化）
  executor：direction lane reserve token → release lane → optional order/RateLimiter/broker
  WS timeout：order lane/eventFlow → reserve → tracked closed → terminal state 持同一 token → route
  API timeout：order lane/route → 仅无 token 且旧 tracked open 时 reserve → old settlement → broker
  → broker accepted 时同步发布 trackOrder/recorder
  → permit/order lane 全部释放 → direction lane release token
```

七层职责不可合并：

1. ACTIVE FIFO：只负责 WebSocket 回报的全局到达顺序、异步启动、barrier 与 fatal 所有权。
2. order lane：负责同一个 orderId 的所有业务变更互斥，跨 orderMonitor 与 orderExecutor 共享，覆盖 WS、route query、recovery、signal merge replace 与 terminal settlement。
3. RateLimiter：mutation permit 只拥有唯一 broker attempt；query throttle 只拥有权威读取配额。两者共享同一 FIFO，但绝不允许 callback 内重入，也不承担 order state ownership。
4. direction lane：负责 LONG 或 SHORT 方向的全部累计成交事实、progress、DailyLoss 权威事实、protective admission 与 completion/boundary 提交不交错。
5. repository writer chain：只负责文件追加顺序、ID 幂等索引和文件错误中毒，不负责业务状态。
6. SDK event ingress gate：只负责 STOPPED no-op、BOOTSTRAPPING cache 与 ACTIVE FIFO admit 的同步分流，不拥有 route 启动权。
7. route execution gate：唯一判定为 `running && recoveryReady`；recovery 只维护 ready，既有生命周期 `routeRuntime.start()` 必须先校验 ready，再维护 running/quote subscription 并在原位置唯一 bootstrap。

### 4.2 固定资源获取顺序

唯一允许的资源顺序：

```text
executor protective admission reserve：direction lane → release

order lane
  → WS timeout status mutation 前 admission reserve：direction lane → release → terminal state 移交 token
  → 或 API route 在旧 tracked open 且无 token时 reserve：direction lane → release
  → RateLimiter trade-mutation permit → release
  → optional RateLimiter query throttle → release
  → optional direction lane → repository

protective admission release：所有 order lane / RateLimiter ownership 释放后 → direction lane
```

具体路径：

- 所有累计成交事实：order lane → direction lane；只有保护性 SELL 事实变化时继续进入 repository。
- progress：order lane → direction lane → repository。
- completion：direction lane → flat/pending/admission eligibility → repository → boundary/cooldown/episode commit；直到 commit 完成才释放 lane。
- ordinary：order lane → sequential listeners → repository。
- route 普通改单：order lane → mutation permit 内 attempt-only → permit release → attempt result；只有需要权威确认时再进入 query throttle，TERMINAL settlement 成功后才 ACK。
- signal merge REPLACE：order lane → mutation permit 内 final quote / merge truth / authorization / attempt-only → permit release → attempt result；只有需要权威确认时再进入 query throttle，后续事实与 ACK 语义同普通 route。
- broker 新订单提交：保护性 SELL 先在独立 direction lane 短临界段登记 admission 并释放 lane；随后 RateLimiter → broker submit → 同步 trackOrder；permit 释放后再经 direction lane 清除 admission。因为 orderId 只在 broker 接受后产生，该同步发布边界不得新增异步 lane 获取。
- WS route timeout `SETTLE_AND_CONVERT`：eventFlow 已在 tracked status 变 closed 前 reserve，并把 token 放入 timeout conversion terminal state；route 必须原样取得和复用该 token，不得再次 reserve。API query/route 若旧 tracked 仍 open 且 terminal state 没有 token，才在 settlement 前 reserve。两者随后统一执行 settlement → broker submit → 同步发布新 trackOrder/recorder → 释放 permit/order lane → direction release admission；unknown submission 或 accepted 后本地同步失败保留 token 到 fatal stop。
- 已持有 TradeMutationPermit 的任何路径都不得申请 order lane。
- 任意 `withTradeMutation` callback 内不得调用 `checkOrderState`、`throttle` 或 `withTradeMutation`；query 只能发生在 callback 已返回之后。
- public ingress 申请 order lane，内部 `*Owned` 函数不得重复申请。
- repository 内部不得回调 order lane、direction lane 或任何业务组件。
- completion 不得先占 repository 再请求 direction lane。
- direction lane 内不得请求 RateLimiter 或 order lane；admission reserve/release 都不得包裹 broker、query、settlement 或等待 order lane。timeout conversion 只允许外层已持有 order lane 时调用一个立即结束的 direction task。

该规则既保留原同步代码隐含的不可交错语义，也消除异步化后的死锁环。

### 4.3 不设置人为队列阈值

本方案不增加 record 数、字节数、payload 大小或等待时间阈值。

原因：

- 当前系统是单实例交易进程，正确的背压来源是 Promise 链本身。
- 任意阈值会新增当前业务中不存在的拒绝分支。
- 真实写入失败由文件系统错误直接定义，不以人为超时替代 durable ACK。
- ACTIVE FIFO thunk/barrier fatal 后停止后续业务闭包并拒绝全部未完成与未来 barrier；order lane、RateLimiter 与 direction lane 只传播错误，由既有 fatal owner 停止 producer；repository 在未吸收的存储或目录错误后 poison。任何一层都不进行降级。

如果未来生产指标证明积压本身成为独立故障，必须另立需求并基于真实容量数据设计；不在本重构中预埋。

---

## 5. 严格 JSONL 协议

### 5.1 文件与记录格式

生产文件：

```text
logs/trades/YYYY-MM-DD.jsonl
```

每条 committed record：

```text
JSON.stringify(canonicalRecord) + "\n"
```

强制规则：

- 严格 UTF-8；scan 必须对原始 bytes 使用 fatal UTF-8 decoder，非法 byte 不得替换为 U+FFFD 后继续解析。
- 一行一条 JSON object。
- 只允许 LF 作为记录终止符。
- 不写 pretty JSON。
- 不写 BOM。
- 不写 header、footer、版本 frame 或校验块。
- 每个 append 只编码和校验新增的一条 canonical record。
- repository 使用 FileHandle.appendFile 完整追加该行，然后调用 FileHandle.sync。
- `FileHandle.appendFile` 是 convenience API，实现可以用多次底层 write 完成一条 line；任一部分写入后 reject 都按 torn tail 或 ACK 模糊窗口处理，不假设单次全写。
- append Promise 只有在 sync 成功后 resolve。本文中的 durability 仅指 `FileHandle.sync()` 成功返回所代表的 OS durability ACK；具体落盘保证受 Windows、文件系统、设备与写缓存实现约束，不宣称普通测试能够证明绝对掉电不丢失。
- 当日日志文件不存在时，openTradingDay 只建立内存 active-day 状态并返回空快照，不创建目录、空文件或 FileHandle。
- 只有第一次真正 APPENDED line 才 lazy 创建目录与文件；UNCHANGED 和零 append 交易日不得改变目录 bytes 或文件集合。

### 5.2 committed 定义

只有以 LF 完整终止的行才属于协议上的 committed line。

可写启动：

1. 以 bytes 完整读取文件一次，并定位最后一个 LF；最后一个 LF 及其之前是 LF-complete prefix，之后是候选 torn tail。
2. 如果文件为空，直接得到空快照。
3. 在修改文件前，先对 LF-complete prefix 的全部完整行执行 5.3 的完整严格读取：fatal UTF-8、raw CR byte、JSON、schema、day、canonical ID 与 ID conflict 任一失败都立即退出，文件 bytes 必须保持不变。
4. 如果文件最后一个 byte 是 LF，说明不存在 torn tail；prefix 严格校验通过后直接使用该次扫描结果，不修改文件、不进行第二次完整读取。
5. 如果非空文件中一个 LF 都不存在，LF-complete prefix 为空；整段 bytes 都是首条未 committed 的 torn tail。空 prefix 校验通过后截断到 0 并调用 sync，再严格重读空文件。
6. 如果文件存在 LF 但最后一个 byte 不是 LF，只有 LF-complete prefix 全部严格合法后，才截断最后一个 LF 之后的全部 bytes。
7. 截断后调用 sync；只有发生截断时才从文件开头严格重读并校验截断结果。

因此，“完整坏行 + torn tail”必须在任何 truncate 前失败，完整文件 bytes 保持不变。tail repair 只删除已确认严格合法 prefix 之后、协议上从未 committed 的非 LF 尾部。

该规则只丢弃协议上从未 committed 的 torn tail，不尝试：

- JSON.parse 非 LF 尾部。
- 猜测尾部是否曾经 sync。
- 补写右括号、引号或 LF。
- 从尾部提取部分字段。

只读工具：

- 不允许截断或修复。
- 发现非 LF 尾部立即失败。
- 非空文件中一个 LF 都不存在时立即失败。
- 发现任意完整坏行立即失败。

### 5.3 严格读取

每一条 LF 终止的完整行必须依次通过：

1. 原始 bytes BOM 检查、raw CR byte 检查、fatal UTF-8 decode 与非空行检查；禁止 Buffer.toString('utf8') 或非 fatal TextDecoder 静默生成 U+FFFD。
2. raw line segment 中出现任意 `0x0D` CR byte 都失败，从而显式拒绝 CRLF 与 JSON whitespace CR；JSON 字符串中的转义 `\\r` 是反斜杠与字母 `r` bytes，不属于 raw CR，必须允许。
3. JSON.parse。
4. mixed record schema。
5. record kind 对应的领域 schema。
6. canonical record 重新构造。
7. 文件交易日与 record 交易日一致性检查。
8. progressId 或 completionId 的 canonical ID 检查。
9. 同 ID payload 一致性检查。

严格读取不要求输入 line 的原始 bytes 与 `JSON.stringify(canonicalRecord)` 全字节相等；本协议只对生产写出使用 canonical serialization，并对 BOM、CR、UTF-8、JSON、schema、day 与 ID 不变量做严格校验。

处理规则：

- 相同 progressId 且 canonical payload 完全相同：视为同一事实，索引中保留一份，append API 返回 UNCHANGED。
- 相同 completionId 且 canonical payload 完全相同：视为同一事实，索引中保留一份，append API 返回 UNCHANGED。
- 相同 ID 但 payload 不同：fail fast。
- 任意完整行 JSON 非法、schema 非法、day mismatch 或 ID conflict：fail fast。
- 任意 LF 完整行包含非法 UTF-8 byte：writable startup 与 read-only scan 都 fail fast，不截断、不替换、不跳过。
- 不跳过、不隔离、不自动删除完整坏行。
- ordinary record 保留文件原始顺序，不新增去重规则。

### 5.4 单次加载快照

repository 打开交易日文件时返回一次不可变快照：

```ts
type MixedTradeLogTradingDaySnapshot = Readonly<{
  tradingDayKey: string;
  executionProgressRecords: ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>;
  completionRecords: ReadonlyArray<ProtectiveLiquidationCompletionRecordV1>;
}>;
```

两个分类数组由同一次严格扫描产生。扫描仍必须严格解析和校验 ordinary records，但 ordinary records 不保留在生产启动快照中，避免把与恢复无关的全日普通成交记录常驻内存。

loadTradingDayRuntimeSnapshot 与 liquidationCooldown hydrator 必须消费该快照，不得再次打开日志文件。费用工具使用独立 strict read-only reader，不复用生产启动快照。

---

## 6. 精确接口目标

以下是目标契约。实现可以调整纯命名，但不得改变 Promise、durability、所有权与顺序语义。

### 6.1 Repository

```ts
export type IdempotentAppendResult<TRecord> = Readonly<{
  kind: 'APPENDED' | 'UNCHANGED';
  record: TRecord;
}>;

export interface MixedTradeLogRepository {
  openTradingDay(tradingDayKey: string): Promise<MixedTradeLogTradingDaySnapshot>;

  appendCompletionIdempotent(
    input: ProtectiveLiquidationCompletionInput,
  ): Promise<IdempotentAppendResult<ProtectiveLiquidationCompletionRecordV1>>;

  appendExecutionProgressIdempotent(
    input: ProtectiveLiquidationExecutionProgressInput,
  ): Promise<IdempotentAppendResult<ProtectiveLiquidationExecutionProgressRecordV1>>;

  appendTradeRecord(record: PersistableTradeRecord): Promise<void>;

  finishTradingDay(): Promise<void>;
  close(): Promise<void>;
}
```

契约：

- openTradingDay 必须在任何 append 前成功。
- 同一实例同一时刻只拥有一个 active trading day。
- append 输入交易日必须与 active trading day 一致。
- openTradingDay 遇到 absent file 时不得 materialize 文件；文件句柄只在首次真正 APPENDED line 时 lazy 创建。
- idempotent append 无论 APPENDED 或 UNCHANGED 都返回 repository 生成或索引命中的 canonical record；调用方不得复制 canonicalization。
- repository 维护最小 `retentionRequired` 内部状态；任意一条新 line 在 sync 成功并返回 APPENDED 后设为 true。进程重启打开已有非空且严格合法的当日 JSONL 时同样恢复为 true，因为该文件可能来自“APPENDED 已 durable、finishTradingDay 尚未执行”的崩溃窗口；不存在或严格扫描后为空的文件保持 false。
- UNCHANGED 不写文件、不创建空文件，也不因本次调用单独设置 retentionRequired；零 append 且 absent/empty 的交易日同样不创建文件、不触发 retention。已有非空合法文件在 open 时恢复 retentionRequired 不属于 UNCHANGED 副作用，也不引入新的持久状态文件或 retention 自动重试状态机。
- finishTradingDay 停止接纳新 append，等待 writer chain；仅在 handle 已 materialize 时执行最终 sync 并关闭。
- 只有 retentionRequired=true 时，finishTradingDay 才异步对 .jsonl 文件执行一次现有 LOGGING.MAX_RETAINED_LOG_FILES 规则；保留数量、日期排序及单文件 stat/unlink 失败时记录并跳过的现有语义。
- lazy materialization 的 mkdir/open、openTradingDay 的文件系统 read/open、tail repair 的 truncate/sync、appendFile/sync、handle close，以及 retention 中未被允许跳过的目录或存储错误，均属于 repository storage failure，必须缓存首次 root cause 并进入 POISONED；唯一例外是 5.1 已定义为正常空交易日的目标 daily file `ENOENT`，它进入 absent-file 分支而不是 poison。单文件 stat/unlink 失败只能记录该文件并跳过，不得扩大为目录级吞错。
- repository 状态必须显式区分 `UNOPENED`、`ACTIVE(day)`、`FINISHED(day)`、`POISONED` 与 `CLOSED`。`POISONED` 与 `CLOSED` 是永久状态；`FINISHED(day)` 是该交易日已完成、但实例仍可服务下一交易日的可复用状态。
- `UNOPENED.openTradingDay(day)` 严格扫描一次并进入 `ACTIVE(day)`。`ACTIVE(day).openTradingDay(day)` 必须幂等返回当前内存 snapshot，不重新打开或扫描文件；这是开盘重建在后续 domain 失败后整条流水线重试所必需的契约。
- `ACTIVE(dayN).openTradingDay(dayM)` 且 dayM 不同必须 fail fast；必须先成功 finish dayN，禁止隐式切日、隐式 close 或丢弃当前 index/writer 状态。
- `FINISHED(dayN).openTradingDay(dayN)` fail fast，避免把已完成交易日重新激活。`FINISHED(dayN).openTradingDay(dayNext)` 且 dayNext 不同时，允许进入生命周期提供的下一交易日：整个 strict scan、ID index/snapshot 构造、materialization/writer/retention 初始状态建立都只发生在独立、空的 candidate state 中；扫描与索引全部成功后才一次性把 live state 从 `FINISHED(dayN)` 替换为 `ACTIVE(dayNext)`。candidate 的 schema、day、canonical ID 或 ID conflict 失败时只丢弃 candidate，live state 必须仍是原封不动的 `FINISHED(dayN)`，允许修正文件后重试；文件系统 read/open 或其他 storage failure 则按 8.1 进入 POISONED。任何跨日路径都不得在 candidate 成功前清空、挪走或逐字段改写 dayN 的 live ownership。repository 只校验 key 与 finished day 不同，不猜测周末、假日或交易日历上的“相邻日期”；目标交易日正确性仍由 lifecycle 已解析的 dayKey 负责。
- finishTradingDay 成功后进入 `FINISHED(activeDay)`。生命周期因后续其他 domain 失败而重复执行午夜链时，再次调用 finishTradingDay 必须直接成功，不重复 drain、sync、close 或 retention。
- POISONED 状态下重复 finishTradingDay 返回同一根因，不自动重试 retention，也不允许打开下一交易日。POISONED 后调用 close 仍必须对 poison 发生时已经取得且尚可能存活的 handle 执行一次 best-effort 物理关闭；该清理不得恢复写入、不得把状态改回 FINISHED/CLOSED、不得覆盖首次 storage root cause。对外 close 始终以同一个 root cause identity reject；best-effort close 自身失败只记录为附加诊断，重复 close 复用同一 cleanup promise，不形成自动重试循环。
- close 在 shutdown 时执行；如果当日仍 active，等价于 finishTradingDay 后永久关闭实例。
- close 后任何 open 或 append 都失败。
- repository 不提供 loadCompletionRecords 与 loadExecutionProgressRecords 的独立重读 API。

### 6.2 DailyLoss hook

```ts
type BeforeAuthoritativeFactCommit = (
  snapshot: DailyLossAuthoritativeFactSnapshot,
) => Promise<void>;

recordCumulativeExecution(
  input: DailyLossCumulativeExecutionInput,
  beforeAuthoritativeFactCommit?: BeforeAuthoritativeFactCommit,
): Promise<DailyLossCumulativeExecutionResult>;
```

实现要求：

- 保留现有 merge、boundary 和 state commit 结构。
- 只把 hook 改为 Promise，并在 filledOrderFactsById.set 之前 await。
- 不增加 prepareCumulativeExecution、commitCumulativeExecution 或可跨调用保存的 preparation object。
- 调用者在 await 期间持有 direction lane，因此不允许同方向事实穿插改变 currentFact。

### 6.3 Sequential await listeners

```ts
type OrderStateChangedListener = (
  event: OrderStateChangedEvent,
) => void | Promise<void>;

onOrderStateChanged(
  listener: OrderStateChangedListener,
): Unsubscribe;
```

emit 规则：

```ts
const listeners = [...orderStateChangedListeners];
for (const listener of listeners) {
  await listener(event);
}
```

必须在首次 await 前快照 listener Set，避免 await 期间的注册或注销改变本次 emission 的参与集合。禁止 Promise.all。Set 插入顺序是业务顺序的一部分；同步 listener 直接完成，异步 listener 等待 Promise；同步 throw 与异步 reject 都立即终止后续 listener。

### 6.4 Lanes

```ts
export interface OrderMutationLane {
  run<T>(orderId: string, task: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export interface TradeFactDirectionLane {
  run<T>(direction: 'LONG' | 'SHORT', task: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export type ProtectiveOrderAdmission = Readonly<{
  token: symbol;
  direction: 'LONG' | 'SHORT';
}>;

export type TimeoutMarketConversionTerminalState = Readonly<{
  closedReason: TerminalClosedReason;
  source: 'WS' | 'STATE_CHECK';
  executedPrice: number | null;
  executedQuantity: number;
  executedTimeMs: number | null;
  orderUpdatedAtMs: number | null;
  preparedProtectiveTerminalExecution?: DailyLossCumulativeExecutionResult;
  protectiveAdmission: ProtectiveOrderAdmission | null;
}>;

export interface ProtectiveOrderAdmissionRegistry {
  reserveOwned(direction: 'LONG' | 'SHORT'): ProtectiveOrderAdmission;
  hasInFlightOwned(direction: 'LONG' | 'SHORT'): boolean;
  releaseOwned(admission: ProtectiveOrderAdmission): void;
  resetAfterDrain(): void;
}

export interface ActiveOrderEventFifo {
  admit(task: () => Promise<void>): void;
  enqueueBarrier(task: () => void | Promise<void>): Promise<void>;
  drain(): Promise<void>;
}
```

order lane ownership 必须采用明确的双层函数：

- handleOrderChanged(event) 负责 orderMutationLane.run(event.orderId, ...)。
- handleOrderChangedOwned(event) 假定已持有 lane，并且只能调用 settleOrderOwned。
- settleOrderOwned、recordCumulativeExecutionOwned 等内部函数不得再次申请同一 order lane。

要求：

- ACTIVE FIFO 的 event thunk 或 barrier 首次失败后停止执行后续事件，并向既有 fatal owner 传播一次。
- order lane 与 direction lane 只负责串行和错误传播，不新增独立永久 poison 状态。
- lane task reject 后由调用链与既有 fatal owner 决定全局停止；lane 本身不把普通业务异常转换为局部永久失效。
- order lane 非重入。每个外部 ingress 对一个 orderId 只能申请一次 lane；已经持有 lane 的内部函数禁止再次调用 run(orderId, ...)。
- 公开 ingress 与内部 owned 函数必须显式分层：ACTIVE FIFO、route、replace、cancel、recovery 入口负责申请 lane；handleOrderChangedOwned、settleOrderOwned、recordCumulativeExecutionOwned 等内部流程只消费已有 permit。
- OrderMutationLane 与 TradeFactDirectionLane 的唯一 behavior interface 定义在 src/core/trader/types.ts；orderMonitor、orderExecutor 与 post-trade consistency 直接 import type，不得重复声明或 re-export。
- ProtectiveOrderAdmissionRegistry 的唯一 interface 同样定义在 src/core/trader/types.ts；registry 由 `createTrader` 创建并与同一个 TradeFactDirectionLane 一起注入 orderMonitor、orderExecutor 与 post-trade consistency。全部 `*Owned` 方法只能在对应 direction lane task 内调用。
- `TimeoutMarketConversionTerminalState` 必须显式携带 `protectiveAdmission`。WS eventFlow reserve 后写入同一 token；route 取得该 state 时消费同一 token，不允许仅用 boolean/count 重新推导，也不允许在已有 token 时再次 reserve。非保护性 timeout 与无需 token 的 API state 可显式为 null。
- 对 protective timeout，`protectiveAdmission` 实际上是强制非空不变量：第一次 WS terminal snapshot 建立 token；后续 terminal snapshot merge 必须从 previous state 复制同一对象 identity。若 protective timeout state 为 null token，eventFlow 与 route 都必须 fail fast，禁止以补 reserve 修复受损状态。
- token 使用 identity 而非计数器句柄；同方向允许多个独立 admission 并存。跨方向释放、未知 token、重复释放都属于内部不变量错误并 fail fast。
- ActiveOrderEventFifo 是 order monitor 内部行为契约，唯一 interface 定义在 src/core/trader/orderMonitor/types.ts。
- `admit()` 只同步链接 queue node 并安排后续 microtask/drain，绝不能在调用栈内执行 task。
- SDK event ingress gate 与 route execution gate 必须是两个独立状态；把 ingress 切到 FIFO 不得隐式使 `routeRuntime.isActive()` 成立。
- runtime store 显式增加 `recoveryReady`。recovery barrier 成功前，cached/new event 的 `triggerRoute` 直接 no-op；barrier 成功只设置 ready，不调用 bootstrap。`routeRuntime.start()` 在既有生命周期位置先断言 ready；ready=false 时不得修改 running、不得订阅 quote、不得 bootstrap，ready=true 时才以 `running && recoveryReady` 通过 gate 并唯一调用一次 `bootstrapActiveRoutes()`。
- FIFO 首次 task 或 barrier throw/reject 后缓存唯一根因、只触发一次 fatal；已排队但未完成、当前及未来 barrier 都用同一根因 reject。
- FIFO poison 后 future admit 同步 no-op，不链接新的待执行节点且不执行闭包；future enqueueBarrier 立即以缓存根因 reject；drain 也必须结束并报告同一根因，不能永久 pending。
- 午夜使用 drain，等待当日已接纳任务但保持组件可供下一交易日复用。
- 最终 shutdown 仍使用 stop/drain；进程退出后不可达调用不新增 FIFO/lane 永久 close 状态。
- 不吞 Promise rejection，不产生 unhandled rejection。
- lane 不设置容量或超时参数。

### 6.5 Protective order admission 契约

protective SELL 的 executor outer scope 与 route timeout conversion owner 都必须显式维护 disposition，而不是在无条件 `finally` 中释放：

```ts
type ProtectiveAdmissionDisposition =
  | 'SAFE_TO_RELEASE'
  | 'RETAIN_UNTIL_RUNTIME_STOP';
```

精确边界：

- 在 protective SELL 通过同步 signal contract/seat authorization 后、第一次可能读取新鲜卖出数量或进入 pending merge/cancel/replace/submit 的 await 之前，执行 `directionLane.run(direction, () => reserveOwned(direction))`。该 lane task 只登记 token 并立即返回。
- WS timeout terminal eventFlow 在已持 order lane 内，若 protective SELL 的 timeout conversion pending 且本次 merge 将 tracked status 从 open 改为 closed，必须先执行一次短暂的 `directionLane.run(direction, () => reserveOwned(direction))`。reserve 完成后才允许写 closed status，并把同一 token 写入 `timeoutMarketConversionTerminalState.protectiveAdmission`；eventFlow 不释放 token，route 取得该 terminal state 时原样接管。
- 若 tracked 已 closed 且 `timeoutMarketConversionTerminalState` 已存在，后续更高 revision 或可合并 terminal snapshot 只更新 terminal fact 字段，并逐字继承 previous `protectiveAdmission` 引用；reserve 调用次数保持 1。previous protective state 缺少 token时直接 fail fast，不创建替代 token、不把 null 写回 state。
- API query/route 若旧 tracked status 仍 open、terminal state 没有 admission 且 resolution 已确定为 `SETTLE_AND_CONVERT`，才在旧 settlement 前 reserve。若 terminal state 已携带 token，route 必须复用，重复 reserve 属于内部不变量错误。
- `SKIPPED`、无可卖数量、最终行情缺失、授权失效、明确 broker rejection、replace/cancel 明确未产生新未知订单时设为 `SAFE_TO_RELEASE`。
- broker accepted 且 `trackOrder` 与必要的 pending sell recorder 同步发布完成后设为 `SAFE_TO_RELEASE`；只有 mutation permit callback 返回后，outer 才能通过 direction lane 调用 `releaseOwned`。
- unconfirmed submission 与 accepted-order local sync failure 设为 `RETAIN_UNTIL_RUNTIME_STOP` 并原样传播 fatal。禁止因为 Promise reject 就默认清除 token。
- signal merge REPLACE/CANCEL_AND_SUBMIT 即使开始时已有 pending protective order，也必须持有 admission：旧 pending 可能在 cancel/query/WS 期间消失，而新 broker 事实尚未发布。
- protective timeout 即使 `orderRecorder` 已保留 follow-up occupancy，也必须持有 admission：completion 的 pending 资格读取以 tracked protective order 为准，recorder placeholder 不能替代 broker/order-monitor 可见性。
- route resolution 为 `WAIT_RETRY` 时保留 terminal state 与 token，不释放 admission；后续 route 重试继续复用。
- route resolution 为 `SETTLE_FILLED` 或 `SETTLE_NO_REMAINDER` 时不提交 follow-up；只有终态 settlement、累计事实 durable commit、tracking/ACK 收口全部成功且 order ownership 释放后，才通过 direction lane 释放 token，使 completion 在下一次显式 refresh 中重新判断。
- `SETTLE_AND_CONVERT` 的 precheck skip、明确未发起 broker 请求或明确 broker rejection，在旧 settlement 与本地占位收口完成、order ownership 释放后安全释放；broker 请求结果未知或 accepted 后本地同步失败继续保留到 fatal stop。
- admission 清除后若 tracked protective order 仍 open，completion 会看到 pending；若明确没有产生订单，completion 才可在后续 lane turn 重新判断。不得在 admission 清除前后追加补偿 completion。

生命周期：

- 正常 stop 先停止产生新 protective signal，再 drain executor/FIFO/order/post-trade/direction tasks；只有所有 producer 与 completion owner 都停止后才能 `resetAfterDrain()`。
- fatal ambiguity 保留 admission 只用于阻止本进程继续误提交 completion，不要求 drain 等待 token 归零，也不引入超时。
- restart 不恢复 token；它依赖既有严格启动快照验证 broker orders、protective remark、position、progress/completion。若这些事实无法收口，启动恢复本身 fail fast，不以 admission fallback 放行。

### 6.6 两阶段 replace 契约

`src/core/trader/orderMonitor/types.ts` 是 replace 内部结果的权威定义位置；其他模块直接从定义文件 import type，禁止 re-export：

```ts
export type ReplaceBrokerAttemptResult =
  | {
      readonly kind: 'BROKER_CONFIRMED';
    }
  | {
      readonly kind: 'NOT_EXECUTED';
      readonly reason: 'EXECUTION_FACT_CHANGED' | 'AUTHORIZATION_REVOKED';
    }
  | {
      readonly kind: 'NEEDS_AUTHORITATIVE_QUERY';
      readonly errorCode: string | null;
      readonly message: string;
    }
  | {
      readonly kind: 'TEMP_BLOCKED_602013';
      readonly errorCode: string | null;
      readonly message: string;
    };
```

唯一允许的 attempt-only 入口：

```ts
attemptReplaceOrderWithPermitOwned(
  input: ReplaceOrderAttemptInput,
  permit: TradeMutationPermit,
): Promise<ReplaceBrokerAttemptResult>;
```

契约：

- 调用者必须已经持有对应 order lane 和当前 mutation permit。
- 函数只执行 attached tracked truth 校验、execution fact 复核、授权复核、payload 构造与唯一一次 `permit.invoke(() => ctx.replaceOrder(...))`。
- broker closed-business-error 只能被转换为 `NEEDS_AUTHORITATIVE_QUERY`。
- broker 602013 只能被转换为 `TEMP_BLOCKED_602013`；attempt-only 函数不得在 permit 内写入 retry count、backoff、WAIT_WS_ONLY 或执行第 5 次 query。
- 两类结果必须保持可区分；不得把 602013 归并进 `NEEDS_AUTHORITATIVE_QUERY`、普通 `NOT_EXECUTED` 或通用 throw。
- attempt-only 函数及其任何下游均不得调用 query、throttle、withTradeMutation、settlement 或 ACK。其他现有 broker error 保持原分类与传播语义；普通 route 的 retry 仍由每次重新申请 mutation permit 的现有外部请求重试边界承担，signal merge 仍是单次 broker attempt。

permit callback 返回后，outer orchestration 仍持有同一 order lane，并消费 `ReplaceBrokerAttemptResult`：

```ts
const attemptResult = await rateLimiter.withTradeMutation((permit) =>
  attemptReplaceOrderWithPermitOwned(input, permit),
);

if (attemptResult.kind === 'NEEDS_AUTHORITATIVE_QUERY') {
  const queryResult = await orderStatusQuery.checkOrderState(input.orderId);
  return completeReplaceAfterAuthoritativeQueryOwned(input, attemptResult, queryResult);
}

if (attemptResult.kind === 'TEMP_BLOCKED_602013') {
  return completeReplaceTempBlocked602013Owned(input, attemptResult);
}

return completeReplaceAttemptOwned(input, attemptResult);
```

`completeReplaceAfterAuthoritativeQueryOwned` 必须保持当前语义：

- `OPEN`：执行现有 `applyOpenStateCheckFact`，写入当前 `QUERY_OPEN`/相关 replace outcome，不 settlement、不 ACK terminal snapshot。
- `TERMINAL`：校验 raw execution facts，写入 queried terminal 与 `TERMINAL_CONFIRMED`，执行 Owned terminal settlement；只有 settlement 成功或已结算确认后才 acknowledge replace outcome 与 queried terminal snapshot，并清理 transient replace state。
- `QUERY_FAILED`：保留当前 errorCode/message 与 `QUERY_FAILED` outcome，不 settlement、不 ACK，不把原错误伪装为 OPEN 或 TERMINAL。

`completeReplaceTempBlocked602013Owned` 是独立的 602013 finalization，不复用 closed-business-error 的立即查询分支：

- 读取并校验当前 `replaceTempBlockedCount`、`replaceCapability`、`replaceResumeMode`、`replaceBlockedUntilAt` 与 attached tracked-order owner；非法 retry index 或互相矛盾的状态组合必须在 query/state mutation 前 fail fast，不 clamp、不重置为 0、不落入普通 retry。
- 第 1 至第 4 次分别写入 1/2/4/8 秒 `TEMP_BLOCKED`、`TIME_BACKOFF`、`nextRetryAtMs` 与原 retry evidence，不调用 `orderStatusQuery`。
- 第 5 次先冻结当前 replace-block owner snapshot，再在 permit 已释放且仍持有同一 order lane 时调用 `orderStatusQuery.checkOrderState`。
- 第 5 次 `OPEN`：先执行现有 raw fact 校验与 `applyOpenStateCheckFact`；保护性 SELL 的新累计事实仍须按 direction lane → durable progress → DailyLoss commit 推进，然后仅在 replace-block owner 仍有效时写入 `WAIT_WS_ONLY(reason=OPEN)`。
- 第 5 次 `TERMINAL`：校验 raw execution facts，写入 queried terminal 与 `TERMINAL_CONFIRMED`，执行 Owned terminal settlement；只有 settlement 成功或已结算确认后才 ACK queried terminal 与 replace outcome。
- 第 5 次 `QUERY_FAILED`：保留查询错误，且仅在 replace-block owner 仍有效时写入 `WAIT_WS_ONLY(reason=QUERY_FAILED)`；不 settlement、不 ACK。
- replace-block owner snapshot stale 只阻止旧 finalization 覆盖新的 backoff/capability/resume 决定；OPEN 的权威 raw execution fact 仍须按 merge/durable 规则吸收，TERMINAL 仍须进入权威 settlement。若 order 已脱离 attached tracking，则继续按既有 detached-order 防线丢弃过期局部决定，不把“replace-block owner stale”和“order identity detached”混为一类。

普通 route 与 signal merge 必须共用上述 attempt result、closed-business-error finalization 与 602013 专用 Owned finalization；不得通过 wrapper 或委托保留旧 runner，也不得复制第二套 602013 状态机。

---

## 7. 全链路业务时序

### 7.1 ACTIVE WebSocket progress

```text
SDK callback 同步 admit thunk（调用栈内零业务执行）
→ 后续 microtask/drain 启动 ACTIVE FIFO task
→ order lane(orderId)
→ direction lane(direction)
→ 读取 current fact 并执行 eventFlow / DailyLoss merge
→ 保护性 SELL changed 时执行 beforeAuthoritativeFactCommit
→ repository append progress
→ sync ACK
→ filledOrderFactsById commit
→ DailyLoss recalculate
→ episode progress / refresh side effects
→ order lane 完成
→ FIFO 处理下一事件
```

### 7.2 保护性终态 settlement

```text
ACTIVE FIFO 或 route/recovery
→ order lane(orderId)
→ direction lane(direction)
→ terminal progress durable append
→ DailyLoss fact commit
→ 退出 direction lane
→ 现有 recorder / sell occupancy / closed / tracking 清理
→ snapshot order-state listener Set
→ 按插入顺序逐个 await listener
   → ordinary persistence 在当前注册位置 durable append
   → ordinary 成功后才执行后续 switch / periodic listeners
→ settlement resolve
```

ordinary 仍在本地 settlement 后，不能为了统一形式移到 progress 前。

### 7.3 非保护性终态 settlement

```text
order lane(orderId)
→ 按现有分支顺序执行 recorder / sell occupancy 更新
→ direction lane(direction)
→ 读取 current fact、merge、提交 DailyLoss 非保护性权威事实
→ 退出 direction lane
→ 按现有顺序执行剩余 refresh、closed 与 tracking 清理
→ snapshot order-state listener Set
→ 按插入顺序逐个 await listener
   → ordinary persistence 在当前注册位置 durable append
   → ordinary 成功后才执行后续 switch / periodic listeners
→ settlement resolve
```

非保护性事实不进入 repository，但必须在现有 DailyLoss 调用位置进入 direction lane；不得借加锁重排 recorder、occupancy、refresh、closed 或 tracking 的原业务先后。否则不同订单的同方向累计事实会在 await 边界交错，并可能与 completion 交错。

### 7.4 Protective SELL admission

```text
protective SELL executor outer scope
→ direction lane(direction)
→ reserveOwned(admission token)
→ 退出 direction lane
→ fresh quantity / pending merge decision
→ optional order lane
→ mutation permit 内唯一 broker attempt
→ broker accepted 时 permit 内同步 trackOrder / pending sell publish
→ permit 释放
→ optional query/finalization 与 order lane 释放
→ direction lane(direction)
→ 仅 SAFE_TO_RELEASE 时 releaseOwned(token)
→ 退出 direction lane
```

任何一步变为 unconfirmed submission 或 accepted-order local sync failure 时，token 保留到 fatal stop 后 reset。direction lane 不跨任何行情、broker、query、settlement 或 order lane await。

保护性 timeout follow-up 使用同一 disposition，但 token 可能由 WS eventFlow 提前创建并移交：

```text
WS eventFlow 已持有旧 order lane
→ tracked status 写 closed 前 direction lane reserveOwned(token)
→ 立即退出 direction lane
→ tracked status closed + terminalState.protectiveAdmission=token
→ 后续 terminal fact merge 继承相同 token identity，reserve count 仍为 1
→ route 复用 token，不再次 reserve
→ resolve timeout resolution
→ SETTLE_AND_CONVERT 时 settle old order / clear old tracked / preserve recorder occupancy
→ mutation permit 内 submit follow-up MO
→ accepted 后同步 publish new trackOrder / recorder
→ permit 与 order lane 释放
→ direction lane(direction) SAFE_TO_RELEASE 时 releaseOwned(token)
```

API query/route 的旧 tracked 若仍 open 且没有 token，则在确认 `SETTLE_AND_CONVERT` 后、settlement 前补做一次相同短 reserve；如果最终不是转换分支，不为 API 路径无意义创建 token。上述 `order lane → direction lane` 是既有 settlement/progress 资源方向上的短临界段；completion 不取得 order lane，executor admission 在等待 order 前已释放 direction lane，因此不会形成环。

WS 已移交 token 后，route 始终从最终合并后的 terminal snapshot 取得同一 token identity。非转换 disposition 同样必须显式：`WAIT_RETRY` 保留 token；`SETTLE_FILLED` / `SETTLE_NO_REMAINDER` 在 settlement、durable fact、tracking 与 ACK 全部成功且 order lane 释放后安全 release；任何未收口异常继续保留并传播 fatal。不得因为最终不转换就在读取 resolution 前或 settlement 前提前释放。

### 7.5 Completion

```text
post-trade refresh 请求尝试完成 episode
→ direction lane(direction)
→ 在 lane 内读取最新 isDirectionFlat
→ 在 lane 内读取最新 hasPendingProtectiveOrders
→ 在 lane 内读取最新 hasInFlightProtectiveAdmission
→ prepare episode
→ prepare DailyLoss boundary
→ repository append completion
→ sync ACK
→ commit DailyLoss boundary
→ cooldown
→ commit episode
→ direction lane 完成
```

completion 的线性化边界必须覆盖 `isDirectionFlat`、`hasPendingProtectiveOrders` 与 `hasInFlightProtectiveAdmission` 三项资格读取，并从读取前一直持有 direction lane 到 durable ACK 后的 boundary/cooldown/episode commit 完成。只把读取搬进 lane 仍不充分：若读取后释放 lane，再 await append，新 admission 可以在 durable commit 前插入，形成错误 completion。相反，持 lane 完成 durable commit 时，新 protective SELL 只能排队 admission；它在 completion 后获准时属于后续事实链，不需要回滚已提交 completion。同方向 progress 未完成时 completion 不能越过；不同方向可以各自推进，但最终文件顺序由 repository writer chain 决定。

### 7.6 Route、signal replace 与 recovery

- 所有可能修改 tracked order、closed state、recorder、occupancy 或 DailyLoss 的入口必须返回 Promise。
- route query/replace 先进入 order lane。普通改单由 outer orchestration 申请 mutation permit，permit callback 只调用 attempt-only Owned 入口；callback 返回并释放 permit 后，outer 才能按 attempt result 进入 closed-business-error 的立即权威查询，或进入 602013 专用 Owned finalization。
- signal merge REPLACE 先进入与目标 pending sell 相同的 order lane，再申请 mutation permit；permit 内读取最终行情、重算 merge truth、复核授权并调用 attempt-only Owned replace。callback 返回后仍持有同一 order lane，再消费 attempt result。
- signal closed-business-error 必须先退出 `withTradeMutation` callback，再进入 `orderStatusQuery.checkOrderState`；signal 602013 也必须先退出 callback，再由专用 Owned finalization 保持前四次退避与第五次查询。不可重入 fake RateLimiter 必须能够证明所有 query throttle 都发生在 mutation turn 释放之后。
- 普通 route closed-business-error 使用完全相同的 permit-release-before-query 结构，不得保留旧 runner 的另一套 catch/query 路径。
- attempt-only/permit-owned 函数及其下游调用图中禁止出现 `orderStatusQuery`、`checkOrderState`、`rateLimiter.throttle` 或 `rateLimiter.withTradeMutation`。
- `TEMP_BLOCKED_602013` 不得进入 closed-business-error finalization；`NEEDS_AUTHORITATIVE_QUERY` 也不得改写 602013 retry count、backoff 或 WAIT_WS_ONLY。
- 删除 `replaceOrderPriceWithRunner`、`ReplacePermitRunner` 与 `replaceOrderPriceWithPermit`，不保留兼容 wrapper 或旧入口委托。
- broker 接受新订单后的 trackOrder 保持 permit 内同步一次性发布，不得新增 await 或 order lane 获取。
- raw snapshot 的 acknowledged 标记只能在 settlement 成功后推进。
- replace terminal outcome 只有在 settlement 成功后才能 acknowledge。
- recovery replay 按现有顺序逐个 await，不允许 Promise.all。
- BOOTSTRAPPING cache 不得在异步 replay 期间继续作为 ingress。
- recovery 必须先在同步临界段内把已排序 cached thunks、recovery barrier 与 ACTIVE FIFO ingress 顺序接入同一个 FIFO，再开始 await；该同步段结束前零业务执行，route execution gate 仍关闭。
- recovery barrier 负责在所有 cached events 完成后执行一致性断言；新到 ACTIVE event 排在 barrier 之后。barrier 前所有 event 即使调用 `triggerRoute`，也不得启动 `processRoute`。
- barrier 成功后，recovery owner 只设置 `recoveryReady=true`；不得调用 `bootstrapActiveRoutes()`。后续既有生命周期 owner 调用 `routeRuntime.start()` 时，start 先断言 ready，再设置 running、订阅 quote，并由原有调用点唯一 bootstrap；任何 ready=false 调用在这些状态修改前 fail fast。
- 任一 cached event 或 barrier 失败时，barrier 以 FIFO 唯一根因 reject，recovery 进入既有 catch，清理恢复态、关闭 ingress、重置 `recoveryReady=false` 并回到 STOPPED；不得存在永久 pending barrier，也不得启动 route。stop 与 recovery reset 同样清除 ready。

---

## 8. 失败语义

### 8.1 Repository storage poison

storage poison 覆盖 repository 生命周期内全部文件系统所有权，而不只覆盖 writer chain：

- `openTradingDay` strict scan 所需的文件系统 read/open 失败；目标 daily file `ENOENT` 按协议表示 absent day，不属于失败。
- writable startup/tail repair 的 truncate/sync 失败。
- 首次 APPENDED lazy materialization 的 mkdir/open 失败。
- appendFile 或 durable sync 失败。
- active 或 candidate handle close 失败。
- retention 目录扫描，或其他未被既有单文件 stat/unlink 跳过规则吸收的存储失败。

上述任一 storage failure 首次发生时，repository 缓存唯一 root cause identity 并进入 POISONED。若失败发生在 `FINISHED(dayN).openTradingDay(dayNext)` 的 candidate 构造期间，不能回到 FINISHED 重试，因为底层存储已无法确认可靠；schema、day、canonical ID 与 ID conflict 等内容/一致性错误不属于 storage failure，candidate 被丢弃后 live state 仍保持 `FINISHED(dayN)`，允许在文件修正后重新调用 openTradingDay。

进入 poisoned 后：

- 当前 append reject。
- 已排队但尚未执行的 append 使用同一根因 reject。
- 未来 append 立即使用同一根因 reject。
- 不创建新 writer chain。
- 不重试后继续。
- 不切换到旧同步实现。
- finishTradingDay 与 close 报告失败，不得记录 clean shutdown。
- POISONED 后的 close 仍取得 poison 时登记的尚存 handle cleanup ownership，并只启动一次 best-effort 物理 close；无论该 close 成功或失败，对外都以首次 storage root cause identity reject，repository 不恢复可写、不转为 FINISHED/CLOSED。
- best-effort close 的次生错误只能记录为附加诊断，不能替换或聚合成新的公开错误；重复 close 复用同一 cleanup promise，不重复关闭、不形成自动重试。

以下错误属于一致性或生命周期 fatal，但不伪装成 repository storage poison：

- strict read 中的 invalid JSON、schema、day mismatch 或 ID conflict：openTradingDay 失败，交易 gate 不打开；UNOPENED 打开失败后仍为 UNOPENED，FINISHED 跨日 candidate 打开失败后仍为原 `FINISHED(dayN)`，不得修改 live ownership。
- append 前发现相同 canonical ID 但 payload 冲突：该调用 reject，并由既有 fatal owner 停止生产；writer 不新增另一种局部永久状态。
- retention 中单个 stat/unlink 失败：保持现有语义，记录错误并跳过该项，不影响 finishTradingDay 成功。
- retention 目录扫描或其他未被现有规则吸收的存储错误：repository POISONED，finishTradingDay reject，下一交易日不得打开。
- FINISHED 状态重复 finishTradingDay 直接成功；POISONED 状态重复 finishTradingDay 返回同一根因，不自动重试 retention；POISONED close 按上文只做一次 best-effort handle cleanup，随后仍返回同一根因。
- ordinary order lane 或 direction lane task 失败：错误向调用方传播；lane 本身不永久 poison。

### 8.2 业务错误传播

| 失败点 | 必须保持的业务结果 |
| --- | --- |
| progress append 或 sync | DailyLoss 新权威事实不提交；后续副作用不执行 |
| completion append 或 sync | boundary、cooldown、episode 均不提交 |
| ordinary append 或 sync | 本地 settlement 不回滚；settlement reject；进入 fatal |
| listener 同步 throw 或异步 reject | 后续 listener 不执行；settlement reject |
| ACTIVE FIFO task 或 barrier | FIFO 缓存唯一根因并只 fatal 一次；后续事件闭包不执行；未完成与未来 barrier 同根因 reject |
| order lane task | 当前调用 reject；错误传播给既有 fatal owner；lane 不新增永久状态 |
| direction lane task | 当前调用 reject；错误传播给既有 fatal owner；lane 不新增永久状态 |
| protective SELL 明确未尝试/拒绝/SKIPPED | permit/order scope 结束后经 direction lane 清除 admission；后续 completion 可重新读取资格 |
| protective SELL broker accepted 且本地同步发布成功 | permit 内先同步 trackOrder/pending sell，permit 释放后再经 direction lane 清除 admission；不得出现 pending/admission 同时不可见 |
| protective SELL unconfirmed submission 或 accepted-order local sync failure | admission 保留到 fatal stop 后 reset；不允许 completion 绕过，不设置超时，不猜测 broker 结果 |
| admission token 未知、跨方向或重复释放 | 内部不变量错误 fail fast；不得静默按计数减一 |
| replace closed-business-error | permit callback 只返回 NEEDS_AUTHORITATIVE_QUERY；释放 mutation permit 后，在同一 order lane 内执行权威 query |
| replace 602013 第 1 至第 4 次 | permit callback 只返回 TEMP_BLOCKED_602013；释放 mutation permit 后写入 1/2/4/8 秒退避，不执行 query |
| replace 602013 第 5 次 | permit callback 只返回 TEMP_BLOCKED_602013；释放 mutation permit 后，在同一 order lane 的专用 Owned finalization 中执行权威 query |
| replace 602013 query OPEN | 先校验并合并 raw fact；保护性 SELL 保持 progress durable-first 与 DailyLoss commit；owner 有效时转 WAIT_WS_ONLY(OPEN)，不 settlement、不 ACK terminal snapshot |
| replace 602013 query TERMINAL | Owned settlement 成功或已结算确认后才 ACK replace outcome 与 queried terminal snapshot |
| replace 602013 query QUERY_FAILED | 保留查询错误并在 owner 有效时转 WAIT_WS_ONLY(QUERY_FAILED)；不 settlement、不 ACK |
| replace authoritative query OPEN | 保持现有 OPEN fact/outcome 更新；不 settlement、不 ACK terminal snapshot |
| replace authoritative query TERMINAL | Owned settlement 成功或已结算确认后才 ACK replace outcome 与 queried terminal snapshot |
| replace authoritative query QUERY_FAILED | 保留原 errorCode/message 与 QUERY_FAILED outcome；不 settlement、不 ACK |
| startup strict read | 交易门禁不打开 |
| read-only tool strict read | 工具失败，不修改日志 |
| retention 单项 stat/unlink | 记录并跳过该单项，继续处理其余文件，保持现有语义 |
| retention 未吸收的目录/存储错误 | repository POISONED；finishTradingDay 失败；不自动重试；下一交易日不打开 |

### 8.3 ACK 模糊窗口

`FileHandle.appendFile` 可能通过多次底层 write 写入一条 line，因此 reject 时文件可能只包含非 LF 部分，也可能已经包含完整合法 line 与 LF。文件系统也可能在 line 已写入后使 sync 调用报错，或者进程可能在 sync 成功后、Promise resolve 前终止。方案不引入额外协议猜测 ACK 状态；durable ACK 仅指 `FileHandle.sync()` 成功返回，且其具体持久化保证由 OS、文件系统与设备实现定义。

恢复行为：

- LF 完整且严格合法的行按 committed line 读取。
- progress/completion 由 canonical ID 幂等规则吸收重复尝试。
- 非 LF 尾部按协议截断。
- 完整坏行与 torn tail 并存时先因完整坏行失败，禁止为了 tail repair 修改文件。
- 完整坏行阻断启动。
- ordinary 保持现有本地 settlement 已完成但调用方未观察持久化成功的错误边界，不新增回滚或补偿。

### 8.4 禁止超时提交

任何 durable append 不设置业务超时后继续 commit 的分支。磁盘 Promise 未完成时，相关业务 Promise 必须继续等待；文件系统明确失败时进入 fatal。

---

## 9. 文件与模块变更图

### 9.1 新增生产模块

| 文件 | 职责 |
| --- | --- |
| src/services/mixedTradeLogRepository/recordCodec.ts | 三类 record 的唯一 parse、canonicalize、serialize 与 ID 校验 |
| src/services/mixedTradeLogRepository/jsonlJournal.ts | raw bytes LF 扫描、fatal UTF-8 decode、tail 截断、lazy materialization、appendFile、sync、close |
| src/services/mixedTradeLogRepository/writer.ts | repository 私有单写者 Promise 链与 poison 状态 |
| src/core/trader/orderMonitor/activeOrderEventFifo.ts | 只同步登记 thunk、异步启动 drain 的 ACTIVE FIFO、recovery barrier、唯一 fatal 根因与 barrier rejection |
| src/core/trader/orderMutationLane.ts | 跨 orderMonitor/orderExecutor 共享的 per-order mutation 串行与 drain |
| src/core/trader/tradeFactDirectionLane.ts | 全部 LONG/SHORT 累计事实与 completion 串行及 drain |
| src/core/trader/protectiveOrderAdmissionRegistry.ts | 仅能在 direction lane Owned 临界段访问的 opaque admission token Set；无 timer、I/O 或订单推导 |
| tools/migrateMixedTradeLogs/index.ts | 停机单向 JSON 数组到 JSONL staging 迁移 |
| tools/migrateMixedTradeLogs/verify.ts | 迁移前后严格数量、顺序与 canonical payload 对比 |

### 9.2 修改生产模块

| 文件 | 修改 |
| --- | --- |
| src/services/mixedTradeLogRepository/index.ts | async open、absent file lazy materialization、最小 snapshot、canonical append result、retentionRequired、幂等 finish、retention、close；删除同步全量读改写 |
| src/services/mixedTradeLogRepository/types.ts | Promise API 与单次 snapshot 契约 |
| src/utils/trading/tradeLogPath.ts | 生产扩展名改为 .jsonl |
| src/core/riskController/dailyLossTracker.ts | pre-commit hook 改为 Promise 并在权威 map set 前 await |
| src/core/riskController/types.ts | recordCumulativeExecution Promise 契约 |
| src/core/trader/orderMonitor/settlementFlow.ts | owned settlement；progress、settlement、listener 全链 await；固定 lane 顺序 |
| src/core/trader/orderMonitor/eventFlow.ts | async owned handler；WS timeout 在 tracked status closed 前 reserve；重复/更新 terminal fact 继承同一 token identity，缺 token fail fast；所有 settlement await |
| src/core/trader/orderMonitor/routeProcessor.ts | WS timeout 始终复用最终 terminal snapshot 的同一 token且禁止补 reserve；API route 仅在旧 tracked open 且无 token的 SETTLE_AND_CONVERT 分支 reserve；按最终 disposition release 或 retain |
| src/core/trader/orderMonitor/recoveryFlow.ts | cache → FIFO ingress 同步 handoff 与 recovery barrier；barrier 成功只设置 recoveryReady，失败重置 ready/ingress 并回 STOPPED；recovery settlement 严格顺序 await |
| src/core/trader/orderMonitor/routeRuntime.ts | execution gate 改为 running && recoveryReady；start() 在任何状态修改前断言 recoveryReady，false 时完全未启动并 fail fast，true 时才设置 running/订阅并唯一 bootstrap；stop 重置 running，triggerRoute 在 gate 关闭时 no-op |
| src/core/trader/orderMonitor/orderOps.ts | 累计成交 Promise 链；public/Owned mutation 拆分；唯一 attempt-only broker replace 与 permit 释放后的 OPEN/TERMINAL/QUERY_FAILED finalization；permit 内禁止 query 或反向申请 order lane |
| src/core/trader/orderMonitor/index.ts | SDK callback STOPPED/BOOTSTRAPPING/ACTIVE FIFO 同步分流；runtime recoveryReady；ACTIVE FIFO；listener 串行 await；stop/reset 清 ready 并 drain lanes |
| src/core/trader/orderMonitor/types.ts | owned handler、FIFO/barrier、ReplaceBrokerAttemptResult 与 identity-stable `protectiveAdmission` timeout terminal state 权威定义；protective state 缺 token fail fast |
| src/core/trader/types.ts | void 或 Promise listener、OrderMutationLane、TradeFactDirectionLane 与 ProtectiveOrderAdmissionRegistry interface 的唯一来源 |
| src/core/trader/orderExecutor/submitFlow.ts | protective SELL outer scope 在首次相关 await 前登记 admission；signal merge 使用与普通 route 相同的两阶段 orchestration；trackOrder 保持 permit 内同步发布，permit/order ownership 释放后按 disposition 清 admission |
| src/core/trader/orderExecutor/types.ts | 注入共享 OrderMutationLane、TradeFactDirectionLane、ProtectiveOrderAdmissionRegistry 与 attempt-only Owned replace 契约；直接从 orderMonitor/types.ts import 内部结果 type，不 re-export |
| src/core/trader/orderExecutor/index.ts | 向 submitFlow 注入共享 order/direction lane 与 admission registry |
| src/core/trader/index.ts | 创建唯一 OrderMutationLane、TradeFactDirectionLane 与 ProtectiveOrderAdmissionRegistry 并注入各 owner；透传 listener 与 drain/reset |
| src/app/runtime/createPostGateRuntime.ts | async ordinary listener；repository open；lane 注入与 fatal 绑定 |
| src/app/runtime/createPostTradeConsistencyRuntime.ts | completion 在 direction lane 内一次读取 flat/pending/admission，并持 lane 到 durable-first commit 全部完成 |
| src/app/types.ts | repository、snapshot、cleanup phase 与异步 runtime types |
| src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts | 消费单次 snapshot；await crash-gap completion |
| src/services/liquidationCooldown/tradeLogHydrator.ts | 直接消费 snapshot completion records，不读 repository |
| src/services/liquidationCooldown/types.ts | hydrator 输入改为 records |
| src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts | producer 停止后 drain lanes 并 finishTradingDay |
| src/main/lifecycle/cacheDomains/types.ts | 注入 repository 与 lane lifecycle port |
| src/app/lifecycle/createLifecycleRuntime.ts | 接线 open、finish 与 close |
| src/constants/cleanup.ts | post-trade stop 后新增 repository close phase |
| tools/calculateTradingFees/index.ts | 严格只读 JSONL |
| tools/calculateTradingFees/utils.ts | 从 mixed records 筛选 ordinary records |

### 9.3 删除的生产逻辑

从 mixedTradeLogRepository 删除：

- readFileSync、writeFileSync、fsyncSync、renameSync 路径。
- 每次 append 重新读取整个当日文件。
- 每次 append 重新 parse、validate 和 stringify 全部历史记录。
- JSON 数组 pretty serialization。
- loadCompletionRecords 与 loadExecutionProgressRecords 的重复文件读取。
- append 热路径中的 retention 目录扫描；成功 APPENDED 后设置 retentionRequired，或在 open 已有非空合法文件时恢复该标志，并在 finishTradingDay 执行一次。
- absent day 的 eager 目录/空文件创建。

生产代码中不保留 legacy JSON 数组 reader。

### 9.4 必须核对但不为类型适配而改写的生产 listener

| 文件 | 核对要求 |
| --- | --- |
| src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts | 保持现有同步 void listener；确认 ordinary listener 成功后才执行 |
| src/main/periodicSwitchWakeupRuntime/index.ts | 保持现有同步 void listener；确认 ordinary listener 成功后才执行 |

上述 listener 不需要为了满足 emitter 而包装为 async。它们通过 void 或 Promise 契约直接接入，并必须纳入顺序、同步 throw、异步 reject 与残留调用点测试。

---

## 10. TDD 实施任务

### Task 1：锁定现有业务边界

**修改测试：**

- tests/core/trader/orderMonitor/settlementFlow.business.test.ts
- tests/core/trader/orderMonitor/eventFlow.business.test.ts
- tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts
- tests/app/runtime/createPostTradeConsistencyRuntime.test.ts
- tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts

**新增 characterization：**

1. progress 持久化完成前，DailyLoss 权威事实、episode、refresh、recorder、tracking 不推进。
2. progress 失败时依赖该事实的副作用为零。
3. completion 完成前 boundary、cooldown、episode 不推进。
4. ordinary 失败发生在本地 settlement 后；本地状态不回滚，但 settlement reject。
5. ordinary persistence listener 保持当前注册位置，成功后才执行后续 switch/periodic listeners。
6. listener 按 Set 插入顺序执行，同步 throw 或异步 reject 都中断后续 listener。
7. STOPPED callback 同步忽略，不修改状态且不触发 fatal。
8. crash-gap completion 失败时恢复边界不提交。
9. BOOTSTRAPPING callback 同步缓存，ACTIVE 当前仍同步完成。

**运行：**

```powershell
bun test tests/core/trader/orderMonitor/settlementFlow.business.test.ts tests/core/trader/orderMonitor/eventFlow.business.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/app/runtime/createPostTradeConsistencyRuntime.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts
```

**通过标准：** 新增测试在改生产代码前通过，形成异步重构 oracle。

**提交：**

```text
test: characterize mixed trade log commit boundaries
```

### Task 2：抽取唯一 record codec

**新增：**

- src/services/mixedTradeLogRepository/recordCodec.ts
- tests/services/mixedTradeLogRepository/recordCodec.business.test.ts

**先写失败测试：**

1. ordinary、progress、completion round trip。
2. unknown kind、unknown field、非法数值、非法时间、非法方向失败。
3. canonical ID 与 canonical payload 固定。
4. day mismatch 失败。
5. 相同 ID 相同 payload 与相同 ID 冲突 payload 可区分。
6. JSON.stringify 只作用于单个 canonical record。

**实现：**

- 把 index.ts 内三类 parse、canonicalize 与 ID 逻辑移动到唯一 codec。
- repository、迁移工具和费用工具全部依赖该 codec。
- 不复制第二套 schema。

**运行：**

```powershell
bun test tests/services/mixedTradeLogRepository/recordCodec.business.test.ts tests/services/mixedTradeLogRepository/business.test.ts
```

**提交：**

```text
refactor: extract canonical mixed trade record codec
```

### Task 3：实现严格 JSONL journal

**新增：**

- src/services/mixedTradeLogRepository/jsonlJournal.ts
- tests/services/mixedTradeLogRepository/jsonlJournal.business.test.ts

**先写失败测试：**

1. 新文件创建后可 append 两条 LF 终止记录并严格读取。
2. append Promise 在 FileHandle.sync resolve 前不 resolve。
3. 文件为空时 snapshot 为空。
4. 可写打开必须先严格验证全部 LF-complete prefix，只有 prefix 全部合法后才截断最后 LF 后的 torn bytes，并在截断后 sync。
5. 完整 invalid JSON/schema/day mismatch/ID conflict 行后再跟 torn tail 时，可写打开必须在 truncate 前失败，文件 bytes 完全不变。
6. 非空且一个 LF 都不存在时，空 LF-complete prefix 校验通过后，可写打开截断到 0 并 sync。
7. torn tail 不被 JSON.parse、补全或内容修复。
8. read-only 打开遇到任意非 LF 尾部失败且文件 bytes 不变，包括首条记录即 torn tail。
9. LF 终止的 invalid JSON、invalid schema、day mismatch、ID conflict 全部失败。
10. LF 终止的完整行包含非法 UTF-8 byte 时，writable startup 与 read-only scan 均失败，bytes 不变且不得产生 U+FFFD 替换。
11. 空行、CRLF、raw line segment 内任意 CR byte 或 BOM 按协议失败；JSON 字符串中的转义 `\\r` 正常通过。
12. 通过可控 file-ops fake 模拟 appendFile 只写入 JSON bytes 的任意 prefix 后 reject；本次 append Promise reject，Task 4 再验证 repository storage poison，重启只把非 LF 部分识别为 torn tail。
13. 多字节 UTF-8 字符在任意 byte 中间部分写后 reject；重启不得产生 U+FFFD，合法完整 prefix 保留，残余非 LF tail 仅在 writable open 按协议截断。
14. appendFile 在终止 LF 写入前 reject 时，append Promise reject；重启按 torn-tail 规则恢复。
15. appendFile 已写入完整合法 line 和 LF 后仍 reject 时，按 ACK 模糊窗口处理：重启接受该 committed line；progress/completion 的重复尝试由 canonical ID 返回 UNCHANGED。
16. absent file 的 open 不创建目录、空文件或 handle；首次 append 才 materialize。
17. append 只增加新增 line 的 bytes，不重写历史。
18. close 后 append 失败。

**实现：**

- 使用 node:fs/promises open。
- 使用 FileHandle.appendFile 写完整 line。
- 每次 append 后 await FileHandle.sync。
- file ops 边界允许测试注入，以便确定性模拟 appendFile 多次底层 write 后的部分写与 reject；生产仍只使用 node:fs/promises FileHandle。
- 可写启动先按最后 LF byte offset 划分 LF-complete prefix 与候选 torn tail，完整严格验证 prefix 后才允许截断 tail。
- 完整行从 raw bytes 分割后先拒绝 BOM 与任意 raw CR byte，再使用 fatal UTF-8 decoder；禁止非 fatal decode，但允许 JSON 字符串转义 `\\r`。
- 完整坏行与 torn tail 并存时禁止 truncate；完整 line 已写入但 appendFile reject 时保留 ACK 模糊语义，不增加 commit marker、checksum 或猜测逻辑。
- absent file 保持未 materialized，首次 append 才创建目录和 handle。
- 严格扫描仅发生在 openTradingDay。

**运行：**

```powershell
bun test tests/services/mixedTradeLogRepository/jsonlJournal.business.test.ts
```

**提交：**

```text
feat: add strict durable jsonl trade journal
```

### Task 4：Repository 单写者与 poison

**新增或修改：**

- src/services/mixedTradeLogRepository/writer.ts
- src/services/mixedTradeLogRepository/index.ts
- src/services/mixedTradeLogRepository/types.ts
- tests/services/mixedTradeLogRepository/writer.business.test.ts
- tests/services/mixedTradeLogRepository/business.test.ts

**先写失败测试：**

1. 两个并发 append 的 appendFile 与 sync 严格串行。
2. 第二个任务在第一个 sync resolve 前不进入文件层。
3. progress/completion 相同 ID 相同 payload 返回 UNCHANGED 且不重复写。
4. invalid JSON/schema/day mismatch/canonical ID/ID conflict 与 append 前相同 ID 冲突 payload 都作为内容或一致性失败返回，不标记为 storage poison；UNOPENED 或 FINISHED live state 不被 candidate 改写。
5. lazy materialization mkdir/open、openTradingDay 文件系统 read/open、tail truncate/sync、appendFile/sync、active/candidate handle close、retention 未吸收存储错误中的任一项失败时，repository 缓存唯一 storage root cause；当前、排队、未来 append 均以该 identity reject。目标 daily file `ENOENT` 单独验证为正常 absent day，不得误 poison。
6. poison 后不执行排队闭包。
7. writer 不产生 unhandled rejection。
8. openTradingDay 只严格扫描一次并建立两个 ID index。
9. APPENDED 与 UNCHANGED 都返回 canonical record。
10. absent day 执行 openTradingDay 后零 append：不创建目录/文件、不扫描 retention，finishTradingDay 直接进入 FINISHED。
11. idempotent UNCHANGED：不追加、不新建 handle、不改变目录 bytes/文件集合，也不改变调用前的 retentionRequired。若记录来自 open 的已有非空合法文件，该标志已因崩溃恢复语义为 true，finish 的 retention 不能错误归因于 UNCHANGED。
12. 第一次 APPENDED 在 sync 成功后设置 retentionRequired，并在 finishTradingDay 只执行一次 retention。
13. finishTradingDay 停止接纳、等待 writer；仅 materialized handle 执行最终 sync/close；仅 retentionRequired=true 执行 retention。
14. retention 单个 stat/unlink 失败时记录并跳过该项，继续处理其余文件。
15. retention 目录扫描或未吸收的存储错误使 repository POISONED，finishTradingDay 失败且下一交易日不能打开；openTradingDay 的文件系统 read/open 失败同样直接 POISONED，不保留可重试 FINISHED 状态。
16. finishTradingDay 成功进入 FINISHED；重复调用直接成功且不重复 writer、sync、close 或 retention。
17. POISONED 后重复 finishTradingDay 返回同一根因，不自动重试 retention；第一次 close 对 poison 时登记的存活 handle 只执行一次 best-effort 物理关闭，但无论关闭成功或失败都以原 root cause identity reject，不恢复写入、不进入 CLOSED。重复 close 复用同一 cleanup promise；次生 close 错误只记录诊断且不替换 root cause。
18. close 永久停止 repository 实例。
19. 初始状态为 UNOPENED；第一次 openTradingDay(dayN) 严格扫描一次并进入 ACTIVE(dayN)。
20. ACTIVE(dayN) 重复 openTradingDay(dayN) 返回同一个内存 snapshot，不重新读取文件、不重建 ID index、不改变 materialization 或 retention 状态。
21. ACTIVE(dayN) 在 finish 前 openTradingDay(dayM) 且 dayM 不同直接失败，当前 dayN 状态保持不变。
22. FINISHED(dayN) 可 openTradingDay(dayNext)：严格读取前 live state 仍完整保持 `FINISHED(dayN)`，新日 strict scan/index/snapshot/materialization/writer/retention 初始状态只写入独立空 candidate；全部成功后才一次性替换为 `ACTIVE(dayNext)`。新日 absent/empty 时 candidate 得到空 snapshot 与 retentionRequired=false。dayNext 由 lifecycle 提供，repository 不自行推导交易日历后继。
23. FINISHED(dayN) reopen dayN 或 POISONED/CLOSED 后 open 均 fail-fast。
24. 已有非空且严格合法的 dayN JSONL 在 open 时恢复 retentionRequired=true；随后即使没有新 APPENDED，finishTradingDay 也执行一次 retention，以覆盖 APPENDED durable 后进程崩溃的窗口。
25. absent 或严格合法 empty 文件 open 后 retentionRequired=false，零 append finish 不扫描 retention；不创建 retention marker、phase file 或自动重试状态机。
26. FINISHED(dayN) 打开 dayNext 时，对 invalid JSON/schema/day/canonical ID/ID conflict 分别注入失败：candidate 被丢弃，live state 逐字段保持原 `FINISHED(dayN)` identity/内容，随后修正输入可重试并成功整体切换；不得留下 dayN index 与 dayNext snapshot 混合的半打开状态。
27. FINISHED(dayN) 打开 dayNext 的 candidate strict scan 发生文件系统 read/open 失败时进入 POISONED；若 candidate 已取得 handle，后续 close 仍按测试 17 执行一次 best-effort 物理清理并对外保留原 storage root cause。

**实现：**

- writer chain 只位于 repository。
- successful task 更新内存 ID index。
- sync 成功并返回 APPENDED 时设置 retentionRequired；open 已有非空合法文件时恢复 retentionRequired。UNCHANGED 与 absent/empty 零 append 不 materialize，也不自行触发该标志。
- 用显式状态机实现跨日复用；同日 open 直接返回已保存 snapshot，跨日前必须先 FINISHED。新日先用不引用 dayN live ownership 的独立空 candidate state 完成扫描、索引与全部初始状态构造，成功后单点整体替换；candidate 完成前禁止清空、move-out 或逐字段修改 live `FINISHED(dayN)`。
- repository storage boundary 统一捕获 lazy mkdir/open、openTradingDay 文件系统 read/open、truncate/sync、appendFile/sync、handle close 与 retention 未吸收错误；首次失败缓存唯一 root cause 并 poison repository，不只 poison writer chain。目标 daily file `ENOENT` 必须在该边界内显式分类为协议允许的 absent day。
- schema/day/canonical ID/ID conflict 作为内容或一致性 fatal 返回调用方，不 poison；跨日 candidate 失败时丢弃 candidate 并保留原 FINISHED live state。
- POISONED close 与正常 close 分离：正常 close 可进入 CLOSED；POISONED close 只复用一个 best-effort handle cleanup promise，对外始终 reject 原 root cause，绝不恢复状态或自动重试。
- 移除同步数组 read-modify-write。

**运行：**

```powershell
bun test tests/services/mixedTradeLogRepository
```

**提交：**

```text
refactor: replace atomic json rewrite with poisoned async writer
```

### Task 5：ACTIVE FIFO、order lane 与 direction lane

**新增：**

- src/core/trader/orderMonitor/activeOrderEventFifo.ts
- src/core/trader/orderMutationLane.ts
- src/core/trader/tradeFactDirectionLane.ts
- src/core/trader/protectiveOrderAdmissionRegistry.ts
- tests/core/trader/orderMonitor/activeOrderEventFifo.business.test.ts
- tests/core/trader/orderMutationLane.business.test.ts
- tests/core/trader/tradeFactDirectionLane.business.test.ts
- tests/core/trader/protectiveOrderAdmissionRegistry.business.test.ts

**修改：**

- src/core/trader/types.ts
- src/core/trader/orderMonitor/types.ts

**先写失败测试：**

1. FIFO 中第一个 deferred task 未完成时第二个不执行。
2. `admit()` 返回前 task 调用次数保持 0；task 只能从后续 microtask/drain 开始。
3. FIFO 保持 admit 顺序。
4. FIFO 首个 task 失败后只上报一次 fatal，已排队与未来 task 不执行闭包。
5. enqueueBarrier 排在此前 admit 的 task 之后、此后 admit 的 task 之前，并在 barrier task 完成后 resolve。
6. event task 失败时，已排队 barrier、当前等待 barrier 与未来 enqueueBarrier 全部以同一 Error identity reject，无永久 pending。
7. barrier task 自身同步 throw 或异步 reject 同样 poison FIFO、只上报一次 fatal，并使未来 barrier 同根因 reject。
8. poison 后 drain 结束并以同一根因 reject，不永久 pending。
9. 同 orderId task 严格串行；不同 orderId 不被人为全局锁合并。
10. 同 direction task 严格串行；LONG 与 SHORT 使用独立 lane。
11. order/direction task 失败向调用方传播，但 lane 不新增永久 poison。
12. drain 等待已接纳任务，并允许下一交易日继续复用。
13. 所有组件无容量、超时或永久 close 状态。
14. admission 同方向支持多个 opaque token；任一 token 存在时 hasInFlightOwned=true，全部合法释放后为 false。
15. 未知 token、跨方向 token 与重复 release fail fast；resetAfterDrain 只在调用方已 drain 的生命周期测试中清空，不自动等待或超时释放。

**实现：**

- 只实现明确的 FIFO、两条 lane 和 admission registry；registry 不是调度器或全局业务 coordinator。
- 不创建全局业务 commit coordinator。
- 为后续 wiring 暴露最小 Promise 接口。
- OrderMutationLane 与 TradeFactDirectionLane interface 只定义在 src/core/trader/types.ts。
- ActiveOrderEventFifo interface 只定义在 src/core/trader/orderMonitor/types.ts。
- admit 只链接队列并 queueMicrotask 启动 drain，不在当前调用栈执行闭包。
- FIFO poison 缓存唯一 Error identity，并显式 settle 所有 barrier deferred。
- admission registry 不自行申请 direction lane；所有 Owned 操作由调用方在相同 TradeFactDirectionLane 临界段内执行。

**运行：**

```powershell
bun test tests/core/trader/orderMonitor/activeOrderEventFifo.business.test.ts tests/core/trader/orderMutationLane.business.test.ts tests/core/trader/tradeFactDirectionLane.business.test.ts
```

**提交：**

```text
feat: add explicit order and trade fact sequencing lanes
```

### Task 6：DailyLoss async pre-commit hook

**修改：**

- src/core/riskController/dailyLossTracker.ts
- src/core/riskController/types.ts
- tests/core/riskController/dailyLossTracker.segment.business.test.ts

**先写失败测试：**

1. deferred hook 未完成时 filledOrderFactsById 与 loss offset 不变化。
2. hook resolve 后结果与当前同步实现完全一致。
3. hook reject 时权威事实与方向状态不变化。
4. unchanged fact 不调用 hook。
5. 非保护性无 hook 路径结果不变。
6. 同方向调用由外部 direction lane 保序。

**实现：**

- recordCumulativeExecution 改为 async。
- 在现有 beforeAuthoritativeFactCommit 位置直接 await。
- filledOrderFactsById.set 与后续 recalculate 保持原位置。
- 不增加累计事实 prepare/commit API。

**运行：**

```powershell
bun test tests/core/riskController/dailyLossTracker.segment.business.test.ts
```

**提交：**

```text
refactor: await daily loss authoritative fact persistence
```

### Task 7：Settlement、event、两阶段 replace、route 与 recovery 全链异步化

**修改：**

- src/core/trader/orderMonitor/settlementFlow.ts
- src/core/trader/orderMonitor/eventFlow.ts
- src/core/trader/orderMonitor/orderOps.ts
- src/core/trader/orderMonitor/routeProcessor.ts
- src/core/trader/orderMonitor/recoveryFlow.ts
- src/core/trader/orderMonitor/types.ts
- src/core/trader/orderExecutor/submitFlow.ts
- src/core/trader/orderExecutor/types.ts
- src/core/trader/orderExecutor/index.ts
- src/core/trader/types.ts
- src/core/trader/index.ts
- src/core/trader/protectiveOrderAdmissionRegistry.ts
- tests/core/trader/finalQuoteMutationPermit.business.test.ts
- tests/core/trader/orderMonitorRouteHooks.integration.test.ts
- tests/core/trader/orderMonitor/orderOps.business.test.ts
- tests/core/trader/orderMonitor/routeProcessor.business.test.ts
- tests/core/trader/orderMonitor/settlementFlow.business.test.ts
- tests/core/trader/orderExecutor/protectiveOrderAdmission.business.test.ts
- 对应 business tests

**先写失败测试：**

1. 无 broker mutation 的 progress 路径严格 order lane → direction lane → repository。
2. 所有累计成交 mutation 在 direction lane 内读取 current fact、merge 和提交。
3. 非保护性事实不写 repository，但不得绕过 direction lane。
4. progress deferred 时 recorder、tracking、closed、episode、refresh 均不推进。
5. terminal progress ACK 后才执行本地 settlement。
6. route raw terminal 仅在 settlement resolve 后 acknowledge。
7. replace outcome 仅在 settlement resolve 后 acknowledge。
8. recovery replay 按输入顺序逐个 await。
9. ACTIVE FIFO、route、replace、cancel、recovery 每个 ingress 对同一 order mutation 只获取一次 order lane。
10. handleOrderChangedOwned、settleOrderOwned 与 recordCumulativeExecutionOwned 不再次申请 order lane。
11. deferred owned settlement 可完成，不因同 lane 自重入死锁。
12. route 普通改单与 signal merge REPLACE 都由唯一 outer orchestration 全程持有同一 order lane，并严格执行 mutation permit → release → optional authoritative query 两阶段结构。
13. mutation permit callback 内只允许最终行情、merge truth、授权复核和唯一 broker replace attempt；closed-business-error 只返回 NEEDS_AUTHORITATIVE_QUERY，callback 返回前不得直接或间接 query、checkOrderState、throttle 或再次 withTradeMutation。
14. closed-business-error 测试必须证明 withTradeMutation callback 已返回、mutation turn 已释放，随后才调用 orderStatusQuery.checkOrderState。
15. 使用遇 callback 自重入即确定性失败的 fake RateLimiter，证明 signal merge 与 ordinary route 都不会从 mutation callback 重入同一 sequenceTail。
16. authoritative query 返回 OPEN 时保持现有 applyOpenStateCheckFact、QUERY_OPEN 与 replace outcome 更新，不 settlement、不 ACK terminal snapshot。
17. authoritative query 返回 TERMINAL 时，只有 Owned settlement 成功或已结算确认后才 ACK replace outcome 与 queried terminal snapshot；settlement reject 时不得提前 ACK。
18. authoritative query 返回 QUERY_FAILED 时保留现有 errorCode/message 与 QUERY_FAILED outcome，不 settlement、不错误 ACK。
19. ordinary route closed-business-error 与 signal merge 共用同一 attempt result、permit-release-before-query 和 finalization，不存在另一套 catch/query runner。
20. 602013 第 1、2、3、4 次分别只写 1/2/4/8 秒 `TEMP_BLOCKED`、递增合法 retry evidence，且权威 query 调用次数保持 0。
21. 602013 第 5 次 OPEN：permit 已释放后才 query；先校验/合并 raw fact，保护性 SELL 新事实的 progress append deferred 时 DailyLoss commit 与 WAIT_WS_ONLY 都不得推进；ACK 后 owner 仍有效才写 `WAIT_WS_ONLY(OPEN)`，不 settlement、不 ACK terminal snapshot。
22. 602013 第 5 次 TERMINAL：permit 已释放后 query；Owned settlement 成功或已结算确认后才 ACK replace outcome 与 queried terminal snapshot，settlement reject 时两者均保留未 ACK。
23. 602013 第 5 次 QUERY_FAILED：保留 errorCode/message，owner 有效时写 `WAIT_WS_ONLY(QUERY_FAILED)`；不 settlement、不 ACK。
24. 602013 第 5 次 query await 期间 owner snapshot 变 stale：OPEN raw execution fact 仍按权威 merge/durable 规则处理，但旧 finalization 不得覆盖新的 replace capability/backoff/resume state；TERMINAL 仍按订单权威终态 settlement，不因 owner stale 丢弃终态。
25. 非法 `replaceTempBlockedCount`、非法 resume/capability 组合在任何 query、state mutation 或 broker retry 前 fail fast；不得 clamp、重置或落入普通 retry。
26. 确定性交错一：route 已持有目标 order lane、等待 mutation permit 时，signal merge 只能排队 order lane，不能先占 RateLimiter；释放后两条生产路径均完成。
27. 确定性交错二：其他 mutation 暂持 RateLimiter、signal merge 已持有目标 order lane 等待 permit、route 同 order 排队 lane；释放 permit 后 signal 与 route 均完成，无锁环。
28. executor protective SELL 在 fresh quantity/pending merge/cancel/replace/submit 的第一处 await 前，先经 direction lane 登记 admission；登记结束即释放 lane，broker await 期间 completion 看到 admission 并拒绝完成。
29. WS protective timeout terminal event 在已持 order lane 时，必须在 tracked status 写 closed 前短暂进入 direction lane reserve；status mutation 完成但 route 尚未启动时，completion 仍因 admission 被阻断。
30. WS eventFlow 将同一 token 写入 timeout conversion terminal state；route 读取后复用该 token，registry reserve 调用次数保持 1，不得重复 reserve。
31. 同一 timeout order 多次可合并 terminal update 时 reserve 次数始终为 1，新旧 snapshot 的 `protectiveAdmission` object identity 严格相同，不得覆盖 null或新 token。
32. protective timeout terminal state 缺 token时，eventFlow/route 在 state overwrite、settlement 或 broker attempt 前 fail fast，不得补 reserve 自愈。
33. API query/route 若旧 tracked 仍 open、terminal state 无 token且 resolution=`SETTLE_AND_CONVERT`，才在旧 settlement 前 reserve；已有 token 或非转换 resolution 不新增 token。
34. timeout 旧 settlement 已清除 tracked、recorder placeholder 已保留但 follow-up response deferred 时，completion 必须因 admission 拒绝；不得把 recorder placeholder 当成 admission 的替代品。
35. broker accepted 后 trackOrder/pending sell recorder 同步发布；permit/order ownership 返回后以最终 snapshot 的同一 token release。
36. 多次 terminal update 后最终 disposition 正确消费同一 token：WAIT_RETRY 保留；非转换成功后释放；明确未尝试/拒绝安全释放；unconfirmed/local sync failure 保留并传播 fatal。
37. timeout follow-up 的 order→direction reserve 与 completion/admission 的确定性交错证明：completion 不获取 order lane，executor reserve 在等待 order 前已释放 direction，direction lane 不跨 status mutation/settlement/broker await，因而无 direction ↔ order/RateLimiter 锁环。
38. admission reserve/release 与 order lane/RateLimiter 的交错测试证明：permit 内不 await direction lane，completion 持 direction lane durable commit 时新 admission 只排队。
39. public ingress 各申请一次 order lane；attempt-only/permit-owned 入口不调用 orderMutationLane.run、orderStatusQuery、checkOrderState、rateLimiter.throttle 或 rateLimiter.withTradeMutation。
40. `ReplaceBrokerAttemptResult` 只定义在 src/core/trader/orderMonitor/types.ts，orderExecutor 与 orderMonitor 直接 import type，无重复定义或 re-export。
41. `replaceOrderPriceWithRunner`、`ReplacePermitRunner` 与 `replaceOrderPriceWithPermit` 全部删除，不保留兼容 wrapper、旧入口或委托链。
42. broker 接受新订单后的 trackOrder 在 permit 内同步一次性完成，不新增 lane await，失败仍保持 accepted-order local sync error 语义。
43. 任一 durable 失败沿原入口 Promise 传播。
44. 不出现 void settle、void append 或 fire-and-forget。

**实现：**

- 将所有受影响函数签名改为 Promise。
- 公开 ingress 统一获取 order lane，随后只调用 Owned 后缀的内部流程。
- 已持有 permit 的内部流程禁止再次获取同一 order lane。
- `createTrader` 创建唯一 OrderMutationLane，并注入 orderMonitor 与 orderExecutor。
- 为普通 route 与 signal merge 建立唯一 outer replace orchestration；outer 从申请 order lane 开始直至 attempt result、可选权威 query、事实更新、settlement 与 ACK 全部完成，期间始终持有同一 order lane。
- 第一阶段在 `withTradeMutation` callback 内完成最终行情、merge truth、授权复核和唯一一次 `attemptReplaceOrderWithPermitOwned`；broker closed-business-error 只返回 `NEEDS_AUTHORITATIVE_QUERY`，不得在 callback 内执行任何 query 或 RateLimiter 重入。
- callback 返回、mutation permit 释放后，outer 仍持有 order lane；只有 `NEEDS_AUTHORITATIVE_QUERY` 才调用现有 `orderStatusQuery.checkOrderState`，并严格复用 OPEN / TERMINAL / QUERY_FAILED 的现有事实更新、settlement、错误传播和 ACK 语义。
- `TEMP_BLOCKED_602013` 进入独立 Owned finalization：前四次只验证并写 backoff；第五次冻结 owner snapshot 后才 query。OPEN 的 raw fact durable merge 先于 WAIT_WS_ONLY，TERMINAL 的权威 settlement 不受 owner stale 影响，QUERY_FAILED 只在 owner 仍有效时写阻塞状态。
- executor protective SELL outer scope 在第一处相关 await 前独立 reserve admission；WS timeout eventFlow 在 tracked status 写 closed 前 reserve 并将 token 写入 terminal state，route 必须复用；API route 只在旧 tracked open、无 token且确定转换时 reserve。所有 direction task 立即结束，绝不包裹 status mutation、settlement、RateLimiter 或 broker await。
- timeout token 从旧 protective pending 首次可能不可见之前覆盖到最终 disposition：WAIT_RETRY 保留；非转换终态成功收口后 release；转换路径在新 `trackOrder`/recorder 同步发布或明确未尝试/拒绝后 release；unknown/local sync failure 保留到 fatal stop。
- eventFlow 合并重复/更新 protective timeout terminal fact 时必须从 previous terminal state 继承同一 admission object；route 只消费最终 snapshot 中该 identity。缺 token fail fast，不允许补 reserve、替换 token 或覆盖 null。
- 删除 `replaceOrderPriceWithRunner`、`ReplacePermitRunner` 与 `replaceOrderPriceWithPermit`；不得用旧 wrapper 委托到新 attempt-only/finalization 入口。
- `ReplaceBrokerAttemptResult` 只定义在 `src/core/trader/orderMonitor/types.ts`，所有消费者直接 import type，不 re-export。
- 新订单 broker accepted 后的 trackOrder 保持同步发布，不纳入异步 lane。
- 所有累计成交事实在现有 DailyLoss 调用位置获取 direction lane。
- 只有保护性 SELL changed 分支从 direction lane 继续进入 repository。
- 保持原有业务 if、merge 与 side-effect 顺序。

**运行：**

```powershell
bun test tests/core/trader/orderMonitor/settlementFlow.business.test.ts tests/core/trader/orderMonitor/eventFlow.business.test.ts tests/core/trader/orderMonitor/orderOps.business.test.ts tests/core/trader/orderMonitor/routeProcessor.business.test.ts tests/core/trader/orderMonitor/recoveryFlow.business.test.ts tests/core/trader/orderExecutor/protectiveOrderAdmission.business.test.ts tests/core/trader/finalQuoteMutationPermit.business.test.ts tests/core/trader/orderMonitorRouteHooks.integration.test.ts
```

**提交：**

```text
refactor: await durable persistence across order settlement
```

### Task 8：SDK FIFO 接线与 sequential await listeners

**修改：**

- src/core/trader/orderMonitor/index.ts
- src/core/trader/orderMonitor/recoveryFlow.ts
- src/core/trader/orderMonitor/routeRuntime.ts
- src/core/trader/types.ts
- src/core/trader/index.ts
- src/app/runtime/createPostGateRuntime.ts
- 核对 src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts
- 核对 src/main/periodicSwitchWakeupRuntime/index.ts
- tests/core/trader/orderMonitor/orderEventSequence.business.test.ts
- tests/core/trader/orderMonitor/routeRuntime.business.test.ts
- tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts
- tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts
- tests/main/periodicSwitchWakeupRuntime/business.test.ts

**先写失败测试：**

1. STOPPED callback 同步 no-op，不进入 cache/FIFO，不触发 fatal。
2. BOOTSTRAPPING callback 同步缓存，不进入 async FIFO。
3. ACTIVE callback 同步 admit 后立即返回。
4. ACTIVE callback 的 admit 调用栈结束前 eventFlow 调用次数为 0。
5. bootstrap handoff 在无 await 的同步段内完成 cache snapshot/sort/clear、cached thunk admit、barrier enqueue 与 ACTIVE FIFO ingress 切换，且该同步段结束前 cached handler 调用次数为 0；route execution gate 仍关闭。
6. 第一个 cached event 的 persistence pending 时到达的新 SDK event 排在 recovery barrier 之后，不丢失、不残留在 cache。
7. recovery barrier 在 cached events 后、新 ACTIVE events 前执行一致性断言。
8. ingress 已切 FIFO 但 recovery barrier 未完成时，cached 与新 event 的 `triggerRoute` 调用均不能启动 `processRoute`；route execution gate 保持关闭。
9. recovery barrier 成功只设置 `recoveryReady=true`，不改变 running、不订阅 quote、不调用 bootstrap；直到测试显式调用既有 `routeRuntime.start()` 前 route pass 次数保持 0。
10. `routeRuntime.start()` 在 ready=false 时于任何状态修改前 fail fast；断言失败后 running 仍为 false、quote listener 未注册、bootstrap 次数为 0。
11. 上述提前 start 失败后，正常 recover barrier 设置 ready，再次调用 start 必须成功并唯一执行一次 bootstrap；重复 start no-op，不因先前失败丢失 recovered route 或重复订阅。
12. `routeRuntime.start()` 在 ready=true 时设置 running/订阅并通过原有调用点唯一执行一次 `bootstrapActiveRoutes()`；cached event 不产生额外 wakeup intent 或重复 route pass。
13. cached event reject 使 recovery barrier 以同一根因 reject，recovery catch 清理状态、关闭 ingress、设置 ready=false 并回到 STOPPED，无永久 pending且无 route 启动。
14. recovery barrier 自身 throw/reject 同样 poison FIFO、只 fatal 一次，重置 ready 并使 recovery 回到 STOPPED；失败前后均不启动 route。
15. FIFO fatal 后未来 enqueueBarrier 立即以同一根因 reject。
16. 第一个 ACTIVE event 的 persistence 未完成时第二个 event 不 merge。
17. 同步与异步 listeners 混合注册并按 Set 插入顺序逐个 await。
18. 首次 await 前快照 listener Set；await 期间新增或删除 listener 不改变本次 emission。
19. listener 同步 throw 与异步 reject 都阻止后续 listener。
20. ordinary append 在本地 settlement 后、现有 listener 位置执行。
21. ordinary append reject 时本地 settlement 保留，switch/periodic listeners 不执行，settlement reject 并传播 fatal。
22. 午夜和 shutdown stopRuntimeAndDrain 均重置 running/recoveryReady 并 drain FIFO 与 order lanes；正常 drain 后组件可复用，不新增永久 close 状态。

**实现：**

- SDK callback 中只做 err 分支、STOPPED no-op、BOOTSTRAPPING cache 或 ACTIVE FIFO admit；不得读取或打开 route execution gate。
- SDK callback 向 FIFO 提交 `() => eventFlow.handleOrderChanged(event)` thunk；admit 不得同步调用该 thunk。
- recovery 在同步 handoff 内把 cached thunks、recovery barrier 与新 ACTIVE FIFO ingress 接入同一 FIFO，但 `recoveryReady=false`；await barrier 成功只设置 ready。route 仍由既有生命周期位置调用 `routeRuntime.start()`，并由 start 内原有 bootstrap 调用点唯一启动；reject 沿既有 catch 重置 ready/ingress 并回到 STOPPED。
- routeRuntime.start 在读取 ready 后、写入任何 running/subscription/bootstrap 状态前 fail-fast 校验；失败不得留下需要 reset 的半启动副作用，后续合法 recover + start 仍走同一个唯一 bootstrap 点。
- FIFO 内 await eventFlow.handleOrderChanged；task/barrier 首次失败缓存唯一根因并 settle 全部 barrier Promise。
- emitOrderStateChanged 在首次 await 前复制 listener Set，再按快照顺序 await。
- listener 契约允许 void 或 Promise；ordinary listener 返回 repository Promise，现有 switch/periodic listeners 保持同步 void。

**运行：**

```powershell
bun test tests/core/trader/orderMonitor/orderEventSequence.business.test.ts tests/core/trader/orderMonitor/routeRuntime.business.test.ts tests/core/trader/orderMonitor/eventFlow.business.test.ts tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/main/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts tests/main/periodicSwitchWakeupRuntime/business.test.ts
```

**提交：**

```text
refactor: preserve websocket and listener order across async persistence
```

### Task 9：Completion、启动快照与 cooldown hydration

**修改：**

- src/app/runtime/createPostTradeConsistencyRuntime.ts
- src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts
- src/services/liquidationCooldown/tradeLogHydrator.ts
- src/services/liquidationCooldown/types.ts
- src/core/trader/types.ts
- src/core/trader/protectiveOrderAdmissionRegistry.ts
- tests/app/runtime/createPostTradeConsistencyRuntime.test.ts
- tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts
- tests/services/liquidationCooldown

**先写失败测试：**

1. completion 使用 direction lane → repository。
2. completion 在进入 direction lane 后才读取 isDirectionFlat、hasPendingProtectiveOrders 与 hasInFlightProtectiveAdmission；测试让调用先排队 lane，再在线外改变前两项并在 lane 前登记 admission，确认 prepare 使用 lane 内最新资格且不写入过期 completion。
3. deferred completion append 期间 direction lane 仍被持有：新的 protective admission 与同方向 progress 都只能排队；DailyLoss boundary、cooldown、episode commit 也不得在 ACK 前推进。
4. completion durable commit 完成后才释放 direction lane；随后排队的新 admission 可以登记，但不得触发 append 后 recheck、补偿或回滚既有 completion。
5. progress 与 completion 同方向不能交错，且 completion 资格读取不能越过尚未提交的同方向 progress。
6. admission 存在时即使 flat=true 且 pending=false 也不得 prepare；token safe release 后下一次显式 refresh 才可重新评估，不由 registry 主动触发 completion。
7. LONG 与 SHORT completion 保持各自方向顺序，admission 也按方向隔离。
8. 正常 LF 完整文件的 openTradingDay 只读取一次；发生 torn-tail 截断时按协议 sync 后重读。
9. DailyLoss restore、episode restore 与 cooldown hydration 消费同一 snapshot。
10. snapshot 只保留 progress 与 completion；ordinary 仅严格校验而不常驻。
11. crash-gap completion 使用 idempotent append 返回的 canonical record 构造扩展后的恢复集合，不重读文件，也不由调用方重复 canonicalize。
12. crash-gap completion await durable ACK 后才提交恢复边界。
13. startup strict read 失败时交易门禁不打开。

**实现：**

- settleProtectiveLiquidationEpisodes 改为 async 且方向逐条显式 await；每个 episode 先进入对应 direction lane，再读取 flat/pending/admission 资格并 prepare，并持有该 lane 直到 repository ACK 与 boundary/cooldown/episode commit 全部完成；不接收在线外预计算的资格布尔值。
- loadTradingDayRuntimeSnapshot 接收一次 repository snapshot。
- hydrator 删除 repository 依赖。

**运行：**

```powershell
bun test tests/app/runtime/createPostTradeConsistencyRuntime.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/services/liquidationCooldown
```

**提交：**

```text
refactor: share one durable trade log snapshot across recovery
```

### Task 10：午夜与 shutdown drain

**修改：**

- src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts
- src/main/lifecycle/cacheDomains/types.ts
- src/app/lifecycle/createLifecycleRuntime.ts
- src/app/types.ts
- src/constants/cleanup.ts
- lifecycle 与 cleanup tests
- 核对 src/main/lifecycle/dayLifecycleManager.ts
- tests/main/lifecycle/dayLifecycleManager.test.ts

**先写失败测试：**

1. 午夜顺序固定为停止 producer → order monitor/FIFO/order lane drain（running=false、recoveryReady=false）→ post-trade drain → direction lane drain → admission registry resetAfterDrain → repository finishTradingDay。
2. finishTradingDay 前没有新 append producer。
3. 午夜 drain 不永久关闭 FIFO/order/direction lane；admission registry 只在所有 producer/completion owner 已停且 direction lane 已 drain 后清空，下一交易日可以复用。
4. finishTradingDay 等待 writer chain；仅 materialized handle 执行 sync/close，且仅 retentionRequired=true 执行 retention。
5. retention 单文件 stat/unlink 失败保持记录并跳过的现有语义。
6. retention 未吸收的目录/存储错误使 finishTradingDay 失败并阻断下一交易日 open，不自动重试。
7. finishTradingDay 成功后重复调用直接成功，不重复 writer、sync、close 或 retention。
8. open rebuild 在新 day openTradingDay 与 snapshot restore 成功后才启动 producer。
9. shutdown repository close phase 位于 STOP_POST_TRADE_CONSISTENCY_RUNTIME 之后。
10. shutdown stop/drain FIFO/order/direction lane，reset admission registry，并永久 close repository；FIFO/lanes/registry 不新增永久 close 状态。
11. close 失败使 shutdown 失败，不报告成功。
12. runtime STOPPED 后到达的新 SDK event 同步忽略；finished/closed repository append 仍 fail-fast。
13. 开盘重建后续 domain 首次失败并重试时，同日 openTradingDay 返回已有 snapshot 且文件读取计数不增加；恢复链可重复消费该不可变 snapshot。
14. dayN finish 成功后，lifecycle 提供的不同 dayNext open 在独立空 candidate 中完成 strict scan/index/snapshot 与新日 materialization/writer/retention 初始状态构造；成功前 live repository 始终保持完整 `FINISHED(dayN)`，成功后才整体替换为 `ACTIVE(dayNext)`，再完成新日 restore 后启动 producer。内容/一致性失败保留 FINISHED(dayN) 并可重试，文件系统 read/open 失败进入 POISONED；dayN 未 finish 时跨日 open 失败。
15. 模拟 dayN 已有非空合法 JSONL、进程未执行 finish 即退出；新实例 open 后无新 append，finish 仍执行一次 retention。absent/empty 对照组不扫描 retention。

**实现：**

- 将 repository 与 lane lifecycle port 注入 signal runtime domain。
- 增加明确 cleanup phase，例如 CLOSE_MIXED_TRADE_LOG_REPOSITORY，排序位于 post-trade stop 后。
- 保持现有 producer 停止先后关系，只在正确边界插入 drain/finish。
- admission token 不参与 drain 计数；ambiguous token 仅阻断存活 runtime 的 completion，所有 producer 与 post-trade 停止、direction lane drain 后由 lifecycle 显式 reset，随后启动恢复以 broker snapshot 重建事实。
- open rebuild 重试复用 repository 保存的同日 snapshot；成功完成午夜 finish 后才允许下一交易日 open。repository 跨日切换必须由 candidate 成功后的单点整体替换完成，不得由 lifecycle domain 零散清理，也不得在读取 dayNext 前先清空 dayN live ownership。

**运行：**

```powershell
bun test tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/main/lifecycle/dayLifecycleManager.test.ts tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts tests/app/shutdown/createCleanup.business.test.ts
```

**提交：**

```text
feat: drain and close mixed trade log at lifecycle boundaries
```

### Task 11：单向停机迁移与费用工具

**新增或修改：**

- tools/migrateMixedTradeLogs/index.ts
- tools/migrateMixedTradeLogs/verify.ts
- tests/tools/migrateMixedTradeLogs/index.business.test.ts
- tools/verifyMixedTradeLogPersistence/index.ts
- tests/tools/verifyMixedTradeLogPersistence/index.business.test.ts
- tools/calculateTradingFees/index.ts
- tools/calculateTradingFees/utils.ts
- 对应 fee tests

**先写失败测试：**

1. legacy JSON 数组严格解析后按原顺序写 staging JSONL。
2. 每条记录使用唯一 record codec。
3. staging 输出全部以 LF 结束。
4. 迁移前后 record count、顺序与 canonical payload 逐条一致。
5. 任一 legacy record 非法时，生产目录不变。
6. 任一 staging JSONL 严格验读失败时，生产目录不变。
7. 第一次受控 rename 前 authoritative legacy active 完整保留。
8. 费用工具只读 strict JSONL，统计结果与相同 ordinary records 的旧基线一致。
9. 工具遇到 torn tail 或完整坏行只失败，不修复。
10. staging 或费用工具遇到 LF 完整但含非法 UTF-8 byte 的行时失败，不替换、不跳过。
11. active、staging、backup 不是同一已解析父目录下的直接 sibling，或位于不同 volume 时，在任何 rename 前失败且三者不变。
12. backup 不存在且 authoritative active 是严格合法 legacy 时，固定专用 staging 若为 partial、非法或无法与 active 逐条 canonical 对比，允许删除该纯派生 staging 并从 active 全量重建；删除前不得修改 active。backup 已存在时不得删除、重建或猜测 staging。
13. 预存 backup 与当前目录事实不属于合法组合时 fail fast，不覆盖、不删除、不猜测哪个目录更新。
14. 第一次 rename 前进程终止留下“legacy active + verified staging + no backup”时，下一次运行重新验证后继续迁移。
15. 第一次 rename 后进程终止留下“active 缺失 + legacy backup + verified staging”时，下一次运行重新验证后完成 staging → active。
16. 第二次 rename 后进程终止留下“strict JSONL active + legacy backup + no staging”时，下一次运行重新验读并逐条对比后判定 offline migration equivalence。
17. active、staging、backup 全部不存在时是合法 EMPTY：迁移不创建目录或文件；final release artifact 仅完成 absent repository strict open/close 与空恢复数据解析断言。
18. final release artifact 的离线 persistence verifier 在生产备份副本完成 migration、codec/repository strict open、恢复数据解析断言、费用工具和 close 前，部署检查失败；verifier 不得装配 trader、连接 broker/行情、启动 producer 或修改 broker。
19. 生产第一次 `active → backup` rename 开始后，部署/恢复工具只允许 strict JSONL fix-forward；legacy backup 只读审计，拒绝旧 binary、legacy backup restore、反向转换或任何旧格式启动路径。
20. production writable startup/recovery 开始后即视为 activation committed；active 可包含新 JSONL 事实，不再要求与 legacy backup 等价。生产 composition root 不得导入或调用迁移工具，发布编排在该边界后不得再次执行离线迁移入口。
21. 离线 persistence verifier 的依赖图和行为测试证明它只调用 migration、codec/repository strict open、恢复数据解析断言、费用工具与 close；测试中的 trader/broker/行情装配哨兵调用次数必须为零。
22. 生产 `src` 残留扫描确认不存在对 `tools/migrateMixedTradeLogs` 或 `tools/verifyMixedTradeLogPersistence` 的 import；迁移/验证入口只能由 activation committed 前的离线发布步骤调用。

**实现：**

- 交易进程完全停止后运行。
- active、staging、backup 使用固定且互不嵌套的路径，必须是同一已解析父目录下、同一 volume 上的直接 sibling；工具在读取或转换前先验证路径关系，在任何 rename 前再次验证。不得把系统临时目录或另一盘符作为 staging。
- 在固定专用 staging sibling 转换全部保留文件；任何已有 staging 都不被直接信任。仅当 backup 不存在且 authoritative active 经严格解析确认是合法 legacy 时，无法完成 strict read-only 验读或无法与 active 逐条 canonical 对比的 staging 才可作为纯派生产物删除并全量重建；backup 存在后的任何不匹配或歧义组合一律 fail fast。
- 全部文件通过严格验读和逐条对比后，在停机状态执行 active → backup、staging → active 两步 rename；明确承认两步之间存在 active 缺失窗口。
- 工具每次启动只依据重新验证后的目录事实确定性续跑；不创建 manifest、phase file、兼容 reader 或运行时 fallback，也不以 catch 内即时恢复作为唯一恢复保证。
- 目录三者全部不存在时按 EMPTY 返回，不 materialize active/staging/backup；只允许离线 verifier 对 absent repository 做 strict open/close 和空恢复数据解析断言。
- strict JSONL active 完成 strict read-only 验读、与 legacy backup 逐条 canonical 对比，并通过离线 persistence verifier 前，生产交易 gate 必须保持关闭。该结果只证明 offline migration equivalence，不代表 production activation committed。
- 生产可写 startup/recovery 是 activation committed 边界；进入后 active 只按 strict JSONL 自身事实验证，不再要求匹配 legacy backup。迁移工具只存在于离线工具入口，生产 composition root 不导入或调用它；发布编排在 activation committed 后不得再次执行该入口。
- 生产版本只识别 JSONL。
- 不提供 JSONL 到 JSON 的反向转换。

**运行：**

```powershell
bun test tests/tools/migrateMixedTradeLogs tests/tools/verifyMixedTradeLogPersistence tests/tools/calculateTradingFees
rg -n "migrateMixedTradeLogs|verifyMixedTradeLogPersistence" src
```

预期：测试全部通过，`rg` 无输出。

**提交：**

```text
feat: migrate mixed trade logs one way to strict jsonl
```

### Task 12：完整验证与残留扫描

**执行顺序：**

```powershell
bun format
bun lint
bun type-check
bun test
bun run build
rg -n "readFileSync|writeFileSync|fsyncSync|renameSync" src/services/mixedTradeLogRepository src/core/trader/orderMonitor src/app/runtime
rg -n "loadCompletionRecords|loadExecutionProgressRecords" src tests tools
rg -n "appendTradeRecord\(" src tests tools
rg -n "appendExecutionProgressIdempotent\(" src tests tools
rg -n "appendCompletionIdempotent\(" src tests tools
rg -n "onOrderStateChanged\(" src tests
rg -n "Promise\.all" src/core/trader/orderMonitor src/app/runtime/createPostGateRuntime.ts src/main/monitorQuoteEventRuntime src/main/periodicSwitchWakeupRuntime
rg -n "orderMutationLane\.run|handleOrderChangedOwned|settleOrderOwned|recordCumulativeExecutionOwned|replaceOrderPrice.*Owned" src/core/trader
rg -n "withTradeMutation|TradeMutationPermit|NEEDS_AUTHORITATIVE_QUERY|attemptReplaceOrderWithPermitOwned|completeReplaceAfterAuthoritativeQueryOwned" src/core/trader src/types tests/core/trader
rg -n "replaceOrderPriceWithRunner|ReplacePermitRunner|replaceOrderPriceWithPermit" src tests
rg -n "orderStatusQuery|checkOrderState|rateLimiter\.throttle|rateLimiter\.withTradeMutation" src/core/trader/orderMonitor/orderOps.ts src/core/trader/orderMonitor/routeProcessor.ts src/core/trader/orderExecutor/submitFlow.ts
rg -n "admit\(|enqueueBarrier|queueMicrotask|recoveryBarrier" src/core/trader/orderMonitor tests/core/trader/orderMonitor
rg -n "eventIngress|routeExecution|bootstrapActiveRoutes|triggerRoute" src/core/trader/orderMonitor tests/core/trader/orderMonitor
rg -n "recoveryReady|runtime\.running|bootstrapActiveRoutes" src/core/trader/orderMonitor tests/core/trader/orderMonitor
rg -n "ProtectiveOrderAdmission|reserveOwned|hasInFlightOwned|releaseOwned|RETAIN_UNTIL_RUNTIME_STOP" src/core/trader src/app tests/core/trader tests/app
rg -n "TextDecoder|fatal: true|toString\(['\"]utf8" src/services/mixedTradeLogRepository tests/services/mixedTradeLogRepository tools
rg -n "UNOPENED|ACTIVE|FINISHED|POISONED|CLOSED|retentionRequired|FILE_FINISHED_RETENTION_PENDING|retention.*retry" src/services/mixedTradeLogRepository tests/services/mixedTradeLogRepository tests/main/lifecycle
rg -n "TradeFactCommitCoordinator|commit magic|SHA-256|fallback|legacy reader|dual write|dual read" src tools
rg -n "FILE_FINISHED_RETENTION_PENDING|STOPPED.*fatal|STOPPED.*生命周期错误" src tests tools
rg -n "void .*append|void .*settleOrder|void .*handleOrderChanged|void .*recordCumulativeExecution" src
git diff --check
git status --short
```

**人工审查：**

1. 所有 repository append 调用都 await 或向上返回 Promise。
2. 全局资源顺序符合 executor admission `direction → release → optional order/RateLimiter`、普通订单事实 `order → optional RateLimiter/query → direction → repository`，以及 timeout `SETTLE_AND_CONVERT` 唯一短临界段 `order → direction reserve → release → settlement/broker`；completion 不获取 order，任何 direction turn 都不跨 broker/query/settlement await，也不存在同时持有两个 RateLimiter turn。
3. completion 不获取 order lane。
4. repository 不回调业务组件。
5. ordinary 仍在本地 settlement 后。
6. ordinary persistence 位于现有 listener 注册位置，失败时后续 switch/periodic listeners 不执行。
7. listener 允许 void 或 Promise，未使用 Promise.all。
8. STOPPED callback 保持 no-op。
9. bootstrap cache、recovery barrier 与 ACTIVE FIFO ingress 在同一无 await 临界段接入 FIFO，且该同步段结束前零业务执行；route execution gate 保持关闭。
10. cached/new event 在 recovery barrier 成功前不得启动 route；barrier 成功只设置 recoveryReady，不 bootstrap；routeRuntime.start 在任何状态修改前断言 ready，false 时完全未启动并 fail fast，true 时才以 running && recoveryReady 通过 gate并由原有位置唯一 bootstrap。失败/stop/reset 均清 ready。
11. FIFO task/barrier 首次失败缓存唯一根因，所有未完成与未来 barrier 同根因 reject，无永久 pending。
12. 每个 order ingress 只获取一次 order lane；Owned 函数不重入，持有 TradeMutationPermit 时不反向申请 order lane。
13. signal merge 与 ordinary route 共用唯一两阶段 replace orchestration；closed error 先返回 NEEDS_AUTHORITATIVE_QUERY 并释放 mutation permit，随后仍持 order lane 执行权威 query。
14. attempt-only/permit-owned 函数及其下游调用图中不存在 orderStatusQuery、checkOrderState、rateLimiter.throttle 或 rateLimiter.withTradeMutation；所有扫描命中都必须位于 permit callback 返回后的 outer orchestration。
15. `replaceOrderPriceWithRunner`、`ReplacePermitRunner` 与 `replaceOrderPriceWithPermit` 无生产或测试残留，不存在兼容 wrapper 或旧 runner 委托链。
16. 不可重入 fake RateLimiter 覆盖 signal merge 与 ordinary route；query OPEN、TERMINAL、QUERY_FAILED 分支分别保持既有事实更新、settlement 与 ACK 语义。
17. signal merge 与 route 两条生产改单路径的确定性交错测试无锁环。
18. broker accepted 后 trackOrder 保持 permit 内同步发布，不新增 lane await。
19. executor protective SELL 在第一次相关 await/mutation 前独立登记 admission；WS timeout eventFlow 在 tracked status 写 closed 前登记并移交 terminal state，后续多次 terminal update 继承同一 object identity且 reserve 总数为 1，route 始终复用最终 snapshot token；缺 token fail fast。API route 仅在旧 tracked open、无 token且确认转换时登记。
20. timeout WAIT_RETRY 保留 token；非转换终态成功收口、明确未尝试/拒绝或 accepted+local publish 成功后才清 token；unconfirmed submission/accepted local sync failure 保留到 fatal stop reset，无超时释放、append 后 recheck、补偿或持久化 marker。
21. 正常完整 daily file 在 startup 只读取一次；tail 截断后的协议重读除外。
22. strict scan 使用 fatal UTF-8 decode，非法 byte 不转成 U+FFFD。
23. writable open 在 truncate 前已严格验证全部 LF-complete prefix；完整坏行与 torn tail 并存时 bytes 不变失败。
24. raw line segment 的 CR byte 显式失败、JSON 字符串转义 `\\r` 通过，且实现未擅自要求全行 canonical bytes equality。
25. 部分写测试覆盖 JSON prefix、多字节 UTF-8、LF 前 reject 与完整 LF line 写入后 reject；durability 仅表述为 sync 成功后的 OS ACK。
26. repository 状态覆盖 UNOPENED、ACTIVE(day)、FINISHED(day)、POISONED、CLOSED；ACTIVE 同日 open 不重读，未 finish 跨日失败，FINISHED 允许 lifecycle 提供的不同下一交易日并完整重置上一日内存所有权，repository 不推导交易日历后继。
27. completion 在 direction lane 内读取 flat/pending/admission，并持 lane 到 durable commit 完成；不存在在线外预计算、读取后释放 lane、append 后 recheck 或补偿。
28. absent/empty/zero append 不 materialize 文件且不触发 retention；APPENDED 设置 retentionRequired；open 已有非空合法文件恢复 retentionRequired 以覆盖 finish 前崩溃。
29. retention 恢复不依赖 marker、phase file、自动重试状态机或兼容 reader。
30. production 无 legacy JSON reader、双写、自动探测或同步回退。
31. 没有新增任意 queue、payload 或 timeout 阈值。
32. 没有改变领域 record schema 与 ID。

**提交：**

```text
chore: verify strict async mixed trade log refactor
```

---

## 11. 停机迁移与部署边界

### 11.1 迁移前提

- 选择收盘后窗口。
- 交易 gate 已关闭。
- producer、order monitor、post-trade consistency 均停止。
- 没有第二个交易进程。
- 完整备份 logs/trades。
- 迁移只处理备份副本演练通过后的生产目录。
- 待部署的最终 release artifact 已在生产目录的完整备份副本上运行离线 persistence verifier；verifier 只执行 migration、唯一 codec/repository strict open、恢复数据解析断言、费用工具与 close，不装配 trader、不建立 broker/行情连接、不启动 producer、不修改 broker。不得使用开发态脚本、不同 commit 的 binary 或合成小样替代此门槛。
- active、staging、backup 的路径在调用前固定，且是同一已解析父目录、同一 volume 下的直接 sibling；任一路径穿过不同父目录、不同 volume、嵌套目录或彼此别名时 fail fast。

推荐固定目录角色如下，实际命名可以配置，但一次迁移及其所有续跑必须保持不变：

```text
<parent>/trades                    # active
<parent>/trades.migration-staging  # staging
<parent>/trades.legacy-backup      # backup
```

### 11.2 目录事实状态机

迁移工具不持久化额外 phase；每次运行都必须重新 strict 验证实际目录内容，再只接受以下组合：

| active | staging | backup | 判定与唯一动作 |
| --- | --- | --- | --- |
| 不存在 | 不存在 | 不存在 | 合法 EMPTY；不创建任何目录或文件，仅由离线 verifier 执行 absent repository strict open/close 与空恢复数据解析断言 |
| 合法 legacy | 不存在 | 不存在 | 从 legacy active 构建 staging，完整验读和逐条对比后进入下一组合 |
| 合法 legacy | partial、非法或与 active 不一致 | 不存在 | 第一次 rename 前 active 是唯一 authoritative source；删除固定专用派生 staging，再从 active 全量重建并重新验证 |
| 合法 legacy | 已验证且与 active 逐条一致 | 不存在 | 第一次 rename 前或在其前终止；重新验证后执行 active → backup |
| 不存在 | 已验证且与 backup 逐条一致 | 合法 legacy | 第一次 rename 后终止；重新验证后执行 staging → active |
| 合法 strict JSONL，且与 backup 逐条一致 | 不存在 | 合法 legacy | 第二次 rename 已完成但尚未进入生产可写 startup/recovery；重新验读 active、逐条对比并运行离线 persistence verifier，判定 offline migration equivalence |

这里的“合法 legacy”“合法 strict JSONL”和“已验证 staging”都不是目录名推断，而是本次进程重新完成严格解析、文件集合检查、record count、顺序、canonical ID 与完整 canonical payload 对比后的结果。

`production activation committed` 不是新的目录事实状态。本文明确禁止 marker/manifest，因此当 strict active 尚未产生新记录时，迁移工具不能仅凭目录 bytes 判断可写 recovery 是否已经开始；“激活后不得再运行迁移工具”必须由发布编排的一次性阶段边界和生产 composition root 不接线迁移入口共同保证，不能伪造一个可从目录自动推断的检测逻辑。

除表中组合外全部 fail fast，且不得修改任何目录，包括但不限于：预存 backup 与 legacy active 同时存在、active/staging/backup 三者同时存在、active 缺失但 staging 或 backup 单独存在、strict active 无 legacy backup、目录内混有旧 `.json` 与新 `.jsonl`。唯一允许删除 staging 的状态是“backup 不存在 + authoritative active 是严格合法 legacy + 固定专用 staging 是 partial/非法/不一致”；backup 一旦存在，工具不得覆盖 backup、删除或重建 staging、自动挑选“较新”目录或猜测执行阶段。

### 11.3 单向迁移步骤

1. 停止旧版本；若 active、staging、backup 全部不存在，直接判定 EMPTY，不创建任何目录或文件，转到离线 persistence verifier 的 absent open/close 验证后结束。
2. 严格读取所有保留期内 YYYY-MM-DD.json。
3. 对每条 legacy record 使用唯一 codec 生成 canonical record。
4. 若 backup 不存在、active 是严格合法 legacy 且固定专用 staging 为 partial、非法或与 active 不一致，删除该纯派生 staging；不得修改 active。随后按原文件顺序全量重建 staging/trades/YYYY-MM-DD.jsonl。
5. 每个 staging 文件完成写入后 sync 并 close。
6. 以 strict read-only 模式完整重读所有 staging JSONL。
7. 对每个文件比较 record count。
8. 按 index 比较 record kind、canonical ID 和完整 canonical payload。
9. 只有全部文件全部一致、三条路径仍满足同父目录同 volume sibling 约束，且目录组合仍为“legacy active + verified staging + no backup”时，开始第一次受控 rename active trades 到 backup；从 rename 开始即不可逆，backup 只用于审计和离线等价性证明，不授权回退。
10. 第一次 rename 后重新检查目录事实；只有组合为“active 缺失 + verified staging + matching legacy backup”时，执行第二次受控 rename staging trades 到 active。这是存在 active 缺失窗口的两次独立受控 rename。
11. 第二次 rename 后重新 strict read-only 验读 active，并与 backup 按文件、record count、顺序、canonical ID 和完整 canonical payload 逐条比较；任何失败都保持交易 gate 关闭并 fail fast，只允许修复 strict JSONL active/staging 激活路径，不自动恢复、覆盖或重新启用 legacy 生产路径。
12. 用最终 release artifact 的离线 persistence verifier 对迁移后的 active 执行唯一 codec/repository strict open、恢复数据解析断言、费用工具与 close；不装配 trader、不建立 broker/行情连接、不启动 producer、不修改 broker。这一步在生产目录执行前必须已在生产备份副本完整通过。
13. 此时只得到 offline migration equivalence：证明 strict JSONL active 与 legacy backup 在迁移时等价，但尚未提交生产激活。
14. 启动生产新版本并进入可写 startup/recovery；从这里起 production activation committed，active 可能在 producer 启动前被 crash-gap completion append，之后只以 strict JSONL active 为权威事实，不再要求与 legacy backup 一致。发布编排封闭离线迁移阶段，生产 composition root 不提供迁移入口。
15. openTradingDay、startup snapshot、恢复断言成功且交易 gate 条件满足后，按既有生命周期启动 producer；producer 启动不定义迁移可逆性边界。

仅在上述离线迁移步骤 1–13 内，尤其是两次受控 rename 前后发生进程终止时，才由下一次迁移工具运行按 11.2 的目录事实状态机重新验证并续跑，不依赖旧进程执行补偿。一旦进入步骤 14 的 production activation committed，禁止再运行任何迁移或离线验证入口，只允许 strict JSONL production runtime fix-forward。这样只解决离线两步 rename 的中断续跑，不把迁移状态或旧格式解释能力带入生产 runtime。

### 11.4 不可逆部署边界

- 生产目录第一次受控 rename `active → backup` 开始前，authoritative legacy active 尚未移动；若验证失败，允许保持旧系统停机并修复/重建纯派生 staging，或者放弃本次部署而不修改 active。
- 第一次受控 rename 开始后即不可逆：legacy backup 只作为迁移时 offline equivalence 与审计证据，不再授权启动旧 binary、恢复 legacy backup、把 active 替换为旧目录或运行 JSONL → JSON 转换。此后只能修复 strict JSONL staging/active 并 fix-forward。
- 不可逆点不能依赖 producer 或 append attempt。生产可写 startup/recovery 可能在 producer 启动前追加 crash-gap completion；producer 也可能先产生 broker 事实再暴露本地失败。任何生产可写 startup/recovery 都必须发生在受控两步 rename和离线 verifier 通过之后，并从开始时只接受 strict JSONL fix-forward。
- production activation committed 后，active 可合法包含 legacy backup 中不存在的新 JSONL 事实；不得继续以 canonical equality 要求 active 匹配 backup。离线迁移阶段在发布编排中已经封闭，生产 composition root 不导入迁移工具。
- 不提供反向 converter。
- 不允许把新 JSONL 手工合并回旧 JSON 数组。
- 不执行在线双写或滚动灰度。

### 11.5 离线迁移等价与生产激活判定

**Offline migration equivalence：**

- 活跃 trades 目录只包含目标 JSONL 文件。
- 每个文件以 LF 结束。
- strict read-only 全部通过。
- 迁移前后 record count、顺序与 canonical payload 完全一致。
- 离线恢复数据解析断言中的 progress/completion 数量一致。
- cooldown、DailyLoss boundary 与 episode 恢复测试通过。
- 费用工具结果与迁移前相同 ordinary records 基线一致。
- 非 EMPTY 时，active、staging、backup 的离线最终目录事实为“strict JSONL active + no staging + matching legacy backup”；迁移工具在 production activation committed 前重复运行只重新验证并返回 offline equivalence，不再次 rename。EMPTY 时三者继续全部不存在。
- 最终 release artifact 的离线 persistence verifier 在生产备份副本和生产迁移目录上均完成 codec/repository strict open、恢复数据解析断言、费用工具与 close；生产备份副本上的费用工具结果已与 legacy 基线一致。

**Production activation committed：**

- 生产新版本已开始可写 startup/recovery，并且只识别 strict JSONL。
- 从该时点起 active 是唯一生产事实源，可以包含 crash-gap completion 或后续业务产生的新记录，不再要求匹配 legacy backup。
- legacy backup 保留为只读审计材料；发布编排不得再次执行离线迁移入口，生产 composition root 不接线迁移工具，部署与恢复只允许 strict JSONL-compatible fix-forward。

---

## 12. 验收门槛

### 12.1 正确性

- Task 1 characterization 全部保持。
- progress 与 completion durable-first。
- ordinary local-first、durable-second。
- WS ACTIVE FIFO 顺序不变。
- 同 order mutation 不交错。
- order lane、mutation permit、permit release、可选 query throttle、direction lane 与 repository 无锁序反转；timeout SETTLE_AND_CONVERT 仅允许在旧 order lane 内、broker 前短暂 direction reserve，completion 不取 order，任何 RateLimiter callback 内不存在直接或间接重入。
- signal merge 与 ordinary route 使用同一个两阶段 replace orchestration，outer 在 mutation attempt、permit 释放、可选权威 query、事实更新、settlement 与 ACK 全程持有同一 order lane。
- closed-business-error 在 permit callback 内只产生 NEEDS_AUTHORITATIVE_QUERY；不可重入 fake RateLimiter 证明 checkOrderState/throttle 仅在 callback 返回后执行。
- 权威 query 的 OPEN 分支不 settlement、不 ACK terminal snapshot；TERMINAL 仅在 settlement 成功或已结算确认后 ACK；QUERY_FAILED 不 settlement、不错误 ACK。
- attempt-only/permit-owned 调用图不包含 orderStatusQuery、checkOrderState、throttle 或 withTradeMutation；旧 replace runner、permit wrapper 与委托链无残留。
- 同 direction trade facts 不交错。
- executor protective SELL 在任何相关异步数量/merge/mutation 链路前登记 direction-owned admission；WS timeout eventFlow 在 tracked status closed 前登记，重复/更新 terminal snapshot 保持同一 token identity且 reserve 一次，route 始终复用最终 snapshot token；protective state 缺 token fail fast。API route 仅在旧 tracked open、无 token且确认转换时登记。
- ambiguous submission/local sync failure 保留 admission 并进入 fatal；无 timeout、猜测释放、持久化 token 或 completion 绕过。
- completion 的 flat/pending/admission 资格只在对应 direction lane 内读取，并持 lane 到 durable ACK 后的 boundary/cooldown/episode commit 完成；不能在线外读取、读取后释放 lane、append 后 recheck 或补偿。
- listener Set 插入顺序不变。
- STOPPED callback 继续同步忽略。
- ACTIVE `admit()` 调用栈内零业务执行。
- bootstrap handoff 期间到达的新事件不丢失，并排在 recovery barrier 之后；ingress 切 FIFO 不会提前打开 route execution gate。
- recovery barrier 成功前 cached/new event 均不得启动 route；成功后 recovery 只设置 recoveryReady。routeRuntime.start 必须先断言 ready，false 时 running/subscription/bootstrap 完全不变并 fail fast；后续正常 recover + start 仍只由 start 内唯一 bootstrap。
- cached event 或 barrier 失败时 recovery 关闭 ingress、重置 recoveryReady 并回到 STOPPED；stop/reset 同样清 ready；所有未完成及未来 barrier 同根因 reject，无永久 pending且无 route 启动。
- ordinary listener 失败时后续 switch/periodic listeners 不执行。
- order lane 不发生同 orderId 自重入。
- repository storage poison 覆盖 lazy mkdir/open、openTradingDay 文件系统 read/open、tail truncate/sync、appendFile/sync、handle close 与 retention 未吸收错误，并以首次 root cause identity 拒绝当前、排队和未来写入；目标 daily file `ENOENT` 仍是正常 absent day，schema、day、canonical ID 与 ID conflict 也不伪装为 storage poison。
- absent、empty、UNCHANGED 与零 append 不创建空文件、不触发 retention；至少一条 APPENDED 后在 finish 执行一次 retention；重启打开已有非空合法文件会恢复 retentionRequired，即使本次进程零 append 也补做一次幂等 retention。
- repository 同日 open 幂等且不重读；未 finish 不得跨日；FINISHED(dayN) 打开 lifecycle 提供的不同 dayNext 时，必须保持 live `FINISHED(dayN)` 不变，在独立空 candidate 中完成 strict scan/index/snapshot 与全部新日初始状态，成功后整体替换。内容/一致性失败丢弃 candidate 且仍可从 FINISHED(dayN) 重试，文件系统 read/open 失败进入 POISONED；repository 不自行判断周末或假日后的交易日后继。
- POISONED close 对已登记的存活 handle 只执行一次 best-effort 物理关闭；无论清理成功或失败，对外始终 reject 首次 storage root cause，不恢复写入、不转为 FINISHED/CLOSED、不自动重试。
- 午夜与 shutdown 无未 drain writer。
- 迁移受控两步 rename 前后任意进程终止都能由合法目录事实组合确定性、幂等续跑；不依赖原进程 catch、manifest 或 phase file。
- backup 不存在且 authoritative active 是严格合法 legacy 时，partial/非法/不一致的固定专用 staging 可作为纯派生产物删除并全量重建；backup 存在后的 staging/backup 必须严格验读和逐条 canonical 对比，任何非法或歧义组合在修改目录前 fail fast。
- active、staging、backup 全部不存在是合法 EMPTY；迁移与 verifier 不创建空目录或空文件，只验证 absent repository strict open/close 和空恢复数据解析。
- 第一次生产 `active → backup` rename 开始后只允许 strict JSONL fix-forward，legacy backup 只作审计；production writable startup/recovery 开始即 activation committed，active 不再要求匹配 backup，发布编排封闭离线迁移阶段且生产 composition root 不接线迁移工具。

### 12.2 协议

- 生产只写 YYYY-MM-DD.jsonl。
- 每条 line 是单个 canonical JSON object 加 LF。
- writable startup 先严格验证全部 LF-complete prefix；只有 prefix 全部合法后才截断非 LF tail。
- 完整坏行与 torn tail 并存时文件 bytes 不变并 fail fast。
- read-only 不修复。
- 任意 LF 完整坏行 fail fast。
- 任意 LF 完整非法 UTF-8 行在 writable 与 read-only 都 fail fast，不替换、不修复。
- raw line segment 内任意 CR byte fail fast，CRLF 不被 JSON.parse 的 whitespace 规则吸收；JSON 字符串转义 `\\r` 保持合法。
- 不要求外部输入 line 与 canonical serialization 全字节相等；生产写出仍只使用 `JSON.stringify(canonicalRecord) + "\\n"`。
- 无 binary frame、checksum、header、sequence 或 commit marker。

### 12.3 性能结构

在预置 1、100、1,000、10,000 条历史记录的测试中：

- 正常完整文件由 openTradingDay 严格解析历史一次；tail 截断后允许协议要求的重读。
- 后续 append 不读取历史文件。
- 后续 append 只 schema 校验和 stringify 新 record。
- 新增文件 bytes 等于新 line bytes。
- 不存在全历史 stringify 或 write。
- deferred fake sync 等待期间 zero-delay timer 可以运行。
- append Promise 在 sync resolve 前不能 resolve。
- 部分写测试覆盖普通 JSON bytes、多字节 UTF-8 中间 byte、终止 LF 前 reject，以及完整 line 已写入但 appendFile reject 的 ACK 模糊窗口。
- durability 验收以 `FileHandle.sync()` 成功返回的 OS ACK 为边界，不把单元测试或普通 Windows smoke test 表述为绝对掉电保证。

验收不使用脆弱的固定毫秒 p99 作为正确性判断，也不承诺固定优化百分比。

### 12.4 工程质量

- bun format、lint、type-check、test、build 全部通过。
- git diff --check 通过。
- 无 unhandled rejection。
- 无 fire-and-forget persistence。
- 无 any 绕过 Promise 契约。
- 无兼容层、回退路径或旧格式生产 reader。
- active/staging/backup 必须是同一已解析父目录同 volume sibling；跨父目录、跨卷、嵌套或别名路径在任何 rename 前失败。
- 最终 release artifact 已在生产备份副本运行离线 persistence verifier，且只执行 migration、codec/repository strict open、恢复数据解析断言、费用工具与 close；不装配 trader、不连接或修改 broker、不启动 producer。
- 第一次生产 `active → backup` rename 开始后，部署与恢复只允许 strict JSONL-compatible fix-forward，旧 binary 与 legacy backup 均禁止恢复；production writable startup/recovery 后不再要求 active 匹配 backup，发布编排不得再次执行离线迁移入口且生产 composition root 不接线迁移工具。

---

## 13. 明确非目标

本次不做：

- 不修改 ordinary、progress、completion 的领域字段。
- 不修改 progressId、completionId 或 canonical 冲突规则。
- 不修改 DailyLoss 数学口径、方向隔离、baseline 与 protection boundary。
- 不修改订单归属、pending sell occupancy、买卖 recorder 或 closed 判定。
- 不修改保护性清仓触发、完成、cooldown 与 episode 规则。
- 不修改普通 logger/pino 流。
- 不把 mixed trade log 迁移到 SQLite、数据库服务或远程日志平台。
- 不引入 Worker。
- 不引入全局业务协调器。
- 不引入 group commit。
- 不降低 ordinary durability。
- 不增加多进程写锁或多实例协议。
- 不增加任意 queue、payload、等待时长阈值。
- 不增加旧 JSON 格式兼容、双读、双写、自动探测或同步 fallback。
- 不增加反向迁移。
- 不增加 retention 专用自动重试或新的 lifecycle 错误分类。
- 不增加 FIFO/order/direction lane 的永久 close 状态；最终 shutdown 只需 stop/drain，repository 负责真实资源 close。
- 不把 protective admission 持久化，不增加 lease、marker、timeout 自动释放或跨进程协调；它只是在 direction lane 所有权下维护的进程内 token Set。
- 不用 completion append 后重查、补偿 record、回滚 boundary 或删除已提交 completion 来修复竞态。
- 不自动跳过完整坏行。
- 不尝试修复非 LF 尾部内容。

---

## 14. 实施前自检清单

实施者在开始 Task 4 前必须逐项确认：

- [ ] Task 1 characterization 已在当前基线通过。
- [ ] record codec 是生产、迁移和工具的唯一 schema 来源。
- [ ] JSONL committed 定义仅为 LF 终止 line。
- [ ] repository 只拥有文件顺序，不拥有业务顺序。
- [ ] ACTIVE FIFO、shared order lane、RateLimiter、direction lane 的所有者和 fatal 通道已明确。
- [ ] 固定全局资源顺序区分 executor 独立 reserve 与 timeout order-owned 短 reserve：WS eventFlow 在 tracked status closed 前 order→direction reserve并移交 token；API route 仅在旧 tracked open、无 token且确认转换时 reserve。completion 不获取 order，direction turn 不跨 status mutation/settlement/broker/query await；release 在 order/permit ownership 结束后执行。
- [ ] 同一个 OrderMutationLane 由 createTrader 创建并注入 orderMonitor 与 orderExecutor；唯一 interface 位于 src/core/trader/types.ts。
- [ ] DailyLoss 仅把现有 hook 改为 async await，没有新增 prepare/commit。
- [ ] ordinary 仍在 local settlement 后持久化。
- [ ] completion 仍在 boundary/cooldown/episode commit 前持久化。
- [ ] listener 串行 await，未使用 Promise.all。
- [ ] listener 契约允许 void 或 Promise；现有同步 listener 不被无意义包装为 async。
- [ ] ordinary persistence 保持现有 listener 位置，失败会阻断后续 switch/periodic listeners。
- [ ] SDK callback 不直接调用 async handler。
- [ ] STOPPED callback 同步 no-op；BOOTSTRAPPING 同步 cache；ACTIVE FIFO 同步 admit；SDK ingress gate 与 route execution gate 相互独立。
- [ ] admit 只登记 thunk，调用栈内零业务执行；bootstrap cache、recovery barrier 与 ACTIVE FIFO ingress 在无 await 的同步段内接入 FIFO，同时 route execution gate 保持关闭。
- [ ] cached/new event 在 recovery barrier 成功前调用 triggerRoute 直接 no-op，不记录额外 wakeup intent；barrier 成功只设置 recoveryReady，不 bootstrap。
- [ ] 既有 lifecycle 位置调用 routeRuntime.start；start 在任何状态修改前断言 recoveryReady，false 时保持 running=false、无订阅、零 bootstrap 并 fail fast，true 时才设置 running/订阅并由原有调用点唯一 bootstrap；提前失败后正常 recover+start 仍唯一 bootstrap，重复合法 start 不重复 bootstrap。
- [ ] cached event 或 barrier 失败、stop、clear/reset 都设置 recoveryReady=false、runtime 回到 STOPPED，且失败路径没有 route 启动。
- [ ] FIFO 首次 task/barrier fatal 缓存唯一根因，全部未完成及未来 barrier 同根因 reject，无永久 pending。
- [ ] recovery await barrier 失败沿既有 catch 回到 STOPPED。
- [ ] 每个 order ingress 只获取一次 order lane；Owned 内部函数不重入。
- [ ] 已持有 TradeMutationPermit 的路径不申请 order lane；signal merge 与 ordinary route 的 outer orchestration 先取得 order lane，并持有到 attempt、可选 query、事实更新、settlement 与 ACK 全部结束。
- [ ] permit callback 内只做最终行情/merge truth/授权复核与唯一 broker attempt；closed-business-error 只返回 NEEDS_AUTHORITATIVE_QUERY。
- [ ] orderStatusQuery.checkOrderState 只在 permit callback 返回和 mutation turn 释放后调用；不可重入 fake RateLimiter 已覆盖 signal merge 与 ordinary route。
- [ ] query OPEN 不 settlement、不 ACK terminal snapshot；query TERMINAL 仅 settlement 成功或已结算确认后 ACK；QUERY_FAILED 不 settlement、不错误 ACK。
- [ ] ReplaceBrokerAttemptResult 只定义在 src/core/trader/orderMonitor/types.ts，其他模块直接 import type，无 re-export。
- [ ] replaceOrderPriceWithRunner、ReplacePermitRunner 与 replaceOrderPriceWithPermit 已删除，无兼容 wrapper 或旧 runner 委托链。
- [ ] attempt-only/permit-owned 函数及下游调用图不存在 orderStatusQuery、checkOrderState、rateLimiter.throttle 或 rateLimiter.withTradeMutation。
- [ ] broker accepted 后 trackOrder 保持 permit 内同步一次性发布。
- [ ] executor protective SELL 在第一处 fresh quantity/pending merge/cancel/replace/submit await 前经 direction lane reserve admission，登记后立即释放 lane；completion 在 broker await 期间能看到 token。
- [ ] WS timeout terminal eventFlow 在 tracked status 写 closed 前 reserve，并将同一 token 附着到 terminal state；status mutation 后 route 未启动时 completion 被阻断，route 复用 token且 reserve 次数不增加。
- [ ] 同一 protective timeout 的多次 terminal update 保持 reserve count=1、`protectiveAdmission` object identity 不变；任何缺 token、覆盖 null、新 token替换或补 reserve 都 fail fast。
- [ ] API route 仅在旧 tracked open、terminal state 无 token且 resolution=SETTLE_AND_CONVERT 时 reserve；recorder placeholder 不替代 token。
- [ ] WAIT_RETRY 保留 token；SETTLE_FILLED/SETTLE_NO_REMAINDER 成功收口、safe skip/明确未尝试/拒绝与 accepted+track/recorder 成功后 release；unconfirmed submission 与 accepted local sync failure 保留并进入 fatal。
- [ ] admission 使用 opaque identity，未知/跨方向/重复 release fail fast；无 timeout、marker、compatibility 或自动完成触发。
- [ ] 无任意队列、payload 或 timeout 阈值。
- [ ] repository storage poison 覆盖 lazy materialization mkdir/open、openTradingDay 文件系统 read/open、tail truncate/sync、appendFile/sync、active/candidate handle close 与 retention 未吸收错误，并以首次 root cause identity 拒绝当前、排队与未来 append；目标 daily file `ENOENT` 被明确分类为正常 absent day。
- [ ] schema、day、canonical ID 与 ID conflict 不 poison；lane task 错误沿既有 fatal owner 传播。UNOPENED 内容失败仍为 UNOPENED，FINISHED 跨日 candidate 内容失败仍为原 FINISHED(dayN)。
- [ ] 正常完整 daily file 在 startup 只读一次；tail 截断后才重读。
- [ ] writable 与 read-only tail 规则不同且有测试。
- [ ] writable open 在任何 truncate 前已严格验证全部 LF-complete prefix；完整坏行与 torn tail 并存时 bytes 不变失败。
- [ ] 非空且无 LF 的首条 torn tail 在 writable open 截断到 0，read-only 失败。
- [ ] 完整行使用 fatal UTF-8 decoder；非法 byte 在 writable/read-only 都失败且不产生 U+FFFD。
- [ ] raw line segment 内任意 CR byte 都失败、JSON 字符串转义 `\\r` 通过；未引入全行 canonical bytes equality 要求。
- [ ] appendFile 部分写测试覆盖 JSON prefix、多字节 UTF-8、LF 前失败与完整 LF line 写入后 reject；后者继续使用既定 ACK 模糊与 ID 幂等语义。
- [ ] durability 只表述为 `FileHandle.sync()` 成功后的 OS ACK，不宣称 checksum、frame、普通测试或 API 能提供绝对掉电保证。
- [ ] startup snapshot 只保留 progress/completion，ordinary 只校验不常驻。
- [ ] idempotent append 返回 kind 与 canonical record。
- [ ] listener Set 在首次 await 前完成快照。
- [ ] 午夜和最终 shutdown 都只 stop/drain 可复用 FIFO/lanes；只有 repository 需要永久 close。
- [ ] repository 状态明确为 UNOPENED、ACTIVE(day)、FINISHED(day)、POISONED、CLOSED；ACTIVE 同日 open 返回当前 snapshot 且不重读，未 finish 跨日失败。FINISHED 打开 lifecycle 提供的不同下一交易日时，live FINISHED(dayN) 在 candidate 成功前完全不变；独立空 candidate strict scan/index/initial state 全部成功后才整体替换，repository 不推导交易日历后继。
- [ ] completion 的 isDirectionFlat、hasPendingProtectiveOrders 与 hasInFlightProtectiveAdmission 只在对应 direction lane 内读取，并持 lane 到 durable ACK 后 boundary/cooldown/episode commit 完成；不存在在线外预计算、读取后释放、append 后 recheck 或补偿。
- [ ] absent/empty file lazy materialization；UNCHANGED/zero append 不创建文件、不触发 retention。
- [ ] 成功 APPENDED 设置 retentionRequired；open 已有非空合法 JSONL 恢复 retentionRequired，覆盖 APPENDED 后、finish 前崩溃，且不新增 marker、phase file 或自动重试状态机。
- [ ] finishTradingDay 成功后幂等；未吸收的 retention 存储错误 poison repository，不自动重试。
- [ ] POISONED close 仍通过单一 cleanup promise 对已登记 handle 做一次 best-effort 物理关闭，但始终以原 storage root cause identity reject；次生 close 错误不覆盖根因、不恢复可写、不进入 FINISHED/CLOSED。
- [ ] 迁移是停机、单向、staging 全量校验和受控两步 rename。
- [ ] active、staging、backup 是同一已解析父目录同 volume 的固定 sibling；跨父目录、跨卷、嵌套或别名路径在修改前 fail fast。
- [ ] 迁移工具接受已定义目录事实组合：三目录均不存在的 EMPTY 不 materialize；backup 不存在且 authoritative active 是严格合法 legacy 时可删除并全量重建 partial/非法/不一致的固定专用派生 staging；backup 存在后的任何歧义组合不修改目录并 fail fast。
- [ ] 第一次与第二次受控 rename 前后进程终止的中间事实均可幂等续跑；strict JSONL active 重新验读并通过离线 verifier 前交易 gate 保持关闭。
- [ ] 最终 release artifact 已在生产完整备份副本运行离线 persistence verifier，且只执行 migration、codec/repository strict open、恢复数据解析断言、费用工具与 close；不装配 trader、不连接或修改 broker、不启动 producer。
- [ ] offline migration equivalence 与 production activation committed 已明确分离；第一次生产 `active → backup` rename 开始后只允许 strict JSONL fix-forward，legacy backup 只作审计；production writable startup/recovery 开始后 active 不再要求匹配 backup，发布编排封闭离线迁移阶段且生产 composition root 不接线迁移工具。
- [ ] Task 4 至 Task 10 已安排为同一个部署单元。

---

## 15. 最终实施判定

只有同时满足以下条件，才可将重构标记完成：

1. 所有业务 characterization 未变化。
2. 三类 append 全部异步并获得明确 sync ACK。
3. progress、completion 与 ordinary 各自保持本文定义的原业务边界。
4. BOOTSTRAPPING cache 到 ACTIVE FIFO 的同步 handoff 与 recovery barrier 无事件丢失，且 handoff 同步段内零业务执行；SDK ingress 切 FIFO 与 route execution enable 是两个独立状态迁移。
5. recovery barrier 成功前任何 cached/new event 都不能启动 route；成功后只设置 recoveryReady。routeRuntime.start 在任何状态修改前断言 ready，false 时保持完全未启动并 fail fast；后续正常 recover+start 才以 running && recoveryReady enable route，并由 start 内唯一 bootstrap。失败/stop/reset 清 ready 且零 route 启动。
6. STOPPED no-op、listener 插入顺序与 ordinary 失败短路保持。
7. FIFO task/barrier fatal 只缓存一个根因；cached barrier、当前 barrier 与未来 barrier 同根因 reject，recovery 回到 STOPPED。
8. 每个 order ingress 只获取一次 lane，Owned 流程无自重入；signal merge 与 ordinary route 共用 order lane → mutation permit → release → optional query throttle 的唯一两阶段结构。
9. 任意 RateLimiter callback 内不存在直接或间接的 query/throttle/withTradeMutation 重入；closed error 只返回 NEEDS_AUTHORITATIVE_QUERY，权威 query 仅在 callback 返回后执行。
10. query OPEN、TERMINAL、QUERY_FAILED 分支保持既有事实更新、settlement、错误传播与 ACK 语义；TERMINAL 不在 settlement 成功前 ACK，QUERY_FAILED 不错误 ACK。
11. attempt-only/permit-owned 调用图通过测试与残留扫描确认不包含 orderStatusQuery、checkOrderState、throttle 或 withTradeMutation；旧 runner、permit wrapper 和兼容委托链已删除。
12. broker accepted 后 trackOrder 保持同步发布边界。
13. protective admission 与 completion 通过同一 direction lane 形成单一线性化边界：executor admission 在 order 前独立登记；WS timeout 在 tracked status closed 前登记，terminal fact 后续更新始终继承同一 token identity，route 从最终 snapshot 复用且不重复 reserve；protective state 缺 token fail fast。token 可见性连续到最终 release/retain disposition，ambiguity 时保留到 fatal stop。
14. ACTIVE FIFO、order lane、RateLimiter、direction lane、admission registry 与 repository writer chain 全部完成接线和 drain/reset。
14. 严格 JSONL 协议、fatal UTF-8、raw CR 拒绝、prefix-before-truncate tail 规则、部分写与完整坏行 bytes 不变 fail-fast 均有测试。
15. absent/empty/zero append 不 materialize 或 retention；UNCHANGED 不改变既有 retention 状态；APPENDED 设置 retentionRequired，open 已有非空合法文件恢复该标志以覆盖 finish 前崩溃。
16. 生产代码已彻底移除同步全量 JSON 数组读改写。
17. startup snapshot 与 cooldown hydration 不重复读取。
18. 午夜与 shutdown 在关闭 repository 前停止并 drain 全部 producer。
19. 单向迁移在同父目录同 volume sibling 上完成；受控两步 rename 前后终止、EMPTY、可重建派生 staging、预存 backup、跨卷与非法目录组合测试全部通过，且合法状态可确定性幂等续跑、其他状态修改前 fail fast。
20. 最终 release artifact 已在生产完整备份副本运行离线 persistence verifier，只执行 migration、codec/repository strict open、恢复数据解析断言、费用工具与 close；生产目录 strict active 离线复核完成前 gate 保持关闭，verifier 不装配 trader、不连接或修改 broker、不启动 producer。
21. offline migration equivalence 与 production activation committed 已分离；第一次生产 `active → backup` rename 开始后只允许 strict JSONL-compatible fix-forward，legacy backup 仅作审计；production writable startup/recovery 开始后 active 不再要求匹配 backup，发布编排封闭离线迁移阶段且生产 composition root 不接线迁移工具。
22. 全量格式、静态检查、测试、构建、残留扫描和独立 code review 全部通过。

本文不授权在上述任一条件未满足时采用临时兼容、同步回退、双写或降低 durability 的方式上线。
