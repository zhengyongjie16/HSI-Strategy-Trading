# 全仓性能分析与优化计划

> 审计阶段状态（历史）：只读审计结论与待实施计划，当时尚未实施优化。审计方式：6 个分区审查代理与 2 个独立复核代理协作；主代理负责调度、证据归并和结论汇总。证据边界：未运行性能基准、CPU/GC profile 或实盘测试。收益排序依据静态调用链、复杂度、触发频率和工程风险，不代表实测加速比例。行号为审计时位置，实施前应重新核对对应函数和真实调用链。
>
> **PERF-03 当前进展：**Pino 移除、文本日志及有界关闭已实施并完成独立验收；实际验证与限制见 PERF-03 及 [Pino 移除方案 §14](./pino-removal-refactoring-plan.md#14-当前实施与集成记录)。这不改变其他审计项的历史记录，也不代表已量化性能收益。
>
> **策略路径迁移注：**本文 `src/core/strategy/intradayRegression/**` 路径是审计基线的历史证据，不作为当前落点。策略功能内聚后按以下对应关系定位：指标编排/数学 → `src/strategies/intradayRegression/indicators/`，验证与样本 → `verification/`，条件求值与延迟模式 → `signalRules.ts`/`profile/`，实例、pending 与展示 → `index.ts`、`verification/pendingVerification.ts`、`display.ts`，配置 → 同目录 `config.json`。审计时行号与文件名不迁移、不重算；实施优化前以实际函数与调用链重新核对。

## 1. 总体结论

当前程序已有较好的事件驱动、增量计算和异步合并基础。继续追求极致性能，最有价值的方向不是减少几个 `await`，而是：

1. 消除成交持久化的全量读写放大和事件循环阻塞。
2. 减少高频 K 线与行情链路的对象分配、重复投影和日志处理。
3. 降低延迟验证随事件频率增长的样本扫描与定时器成本。
4. 消除重复外部请求及嵌套重试，同时修正缓存失效竞争。
5. 在订单规模增长时，复用单次业务事务内的分类、排序和统计结果。

### 1.1 系统定位与性能边界

从当前实现看，这是基于 Longbridge SDK、行情推送、分钟 K 线更新、延迟验证和券商限流的事件驱动量化交易系统。它具有高频事件处理需求，但不能直接等同于交易所共址、微秒级下单的 HFT 系统。

应用优化可以改善处理吞吐和尾延迟，但不能消除券商网络延迟、策略等待和合法限流。

本文所称“收益”均指延迟、吞吐、资源消耗收益，不代表策略盈利收益。

### 1.2 证据分类

- **已确认开销**：代码中存在对应重复工作、分配、同步操作或复杂度。
- **潜在瓶颈**：是否影响生产性能，仍依赖实际事件率、订单规模、磁盘与网络延迟。
- **已确认实现风险**：存在可达的竞争条件或危险执行顺序，不代表已在实盘发生损失。
- **未评估**：缺少运行数据、外部契约或 SDK 内部证据，不能作确定结论。

## 2. 覆盖范围

独立代理使用文件系统与 Git 清单核验，生产源码为 263 个文件：262 个 TypeScript、1 个 JSON。

| 范围             |  文件数 | 审查重点                               |
| ---------------- | ------: | -------------------------------------- |
| `src/index.ts`   |       1 | 启动入口                               |
| `src/app/`       |      20 | 组装、成交后一致性、生命周期、清理     |
| `src/config/`    |      11 | 配置解析、校验                         |
| `src/constants/` |       3 | 频率、窗口、限流参数                   |
| `src/core/`      |      85 | 策略、指标、订单、交易、风控、末日保护 |
| `src/main/`      |      73 | 事件运行时、队列、显示、刷新、恢复     |
| `src/services/`  |      28 | 行情客户端、寻标换标、持久化、展示     |
| `src/types/`     |      14 | 共享契约及运行时边界                   |
| `src/utils/`     |      28 | 日志、数值、时间、缓存、刷新门禁       |
| **合计**         | **263** | 全部生产目录均有代理负责               |

同时定向检查了相关测试及根运行配置。发现或阅读测试文件不代表执行测试通过。

审计期间：

- 未检查 `docs/`、`tools/` 内容；本文为审计完成后按用户要求新增的文档。
- 未读取真实环境密钥，未连接实盘。
- `dist/` 不作为第二套源代码重复审查。
- 独立复核时工作树无修改。

## 3. 按预期收益排序

| 排名 | 编号 | 优化项 | 主要收益 | 生效条件 | 成本 / 风险 |
| --: | --- | --- | --- | --- | --- |
| 1 | PERF-01 | 成交日志由全量读改写走向增量耐久化 | 全局尾延迟、磁盘写放大、CPU | 成交密集、部分成交多、单日日志大 | 高 / 高 |
| 2 | PERF-02 | K 线标准化对象结构共享，避免逐事件全量投影冻结 | 分配率、GC、策略入口吞吐 | 活动柱更新频繁 | 中 / 中 |
| 3 | PERF-03 | 文本日志一次准备、多端输出，移除 Pino/整条 JSON 中转 | CPU、GC、事件循环负载 | 行情显示日志密集 | 中 / 低至中 |
| 4 | PERF-04 | 延迟验证样本改为 head-index 队列，优化最近点查询 | CPU、数组搬移、验证尾延迟 | 样本率和候选数较高 | 中 / 中 |
| 5 | PERF-05 | 移除 warrantQuote/warrantList 嵌套重试 | 故障期延迟、请求放大 | 持续可重试失败 | 低至中 / 中 |
| 6 | PERF-06 | 订单缓存版本化失效及同代请求去重 | 外部调用数、等待时间、正确性 | 并发读、频繁缓存失效 | 中 / 高 |
| 7 | PERF-07 | 智能平仓复用一次订单快照与排序 | CPU、Decimal 运算、扫描 | 买单多、第三阶段启用 | 中 / 中高 |
| 8 | PERF-08 | 订单 route 按成员变化缓存排序 | quote 热路径 CPU | 同标的在途订单较多 | 中 / 中 |
| 9 | PERF-09 | 席位刷新按一次快照分组并复用分类 | 激活/换标延迟、本地 CPU | 历史订单量大 | 中 / 中高 |
| 10 | PERF-10 | 延迟候选共享唤醒调度器 | timer、闭包和回调管理 | pending 候选较多 | 中高 / 中 |
| 11 | PERF-11 | 席位刷新账户/持仓读取受控并行 | 激活等待时间 | 网络延迟占主导 | 中 / 中高 |
| 12 | PERF-12 | 指标 preview 工作区优化 | 短命对象、GC | profile 证明 clone 占比高 | 中高 / 高 |
| 13 | PERF-13 | 展示行情读合并、静态清仓提前排除无候选 | SDK 调用及转换次数 | 显示并发、无持仓事件多 | 低至中 / 中 |
| 14 | PERF-14 | 缓存稳定 Decimal 输入、缩减时间格式化 | 热路径常数开销 | 高频风控/日志 | 中 / 中高 |
| 15 | PERF-15 | 恢复索引、队列清理与状态快照微优化 | 恢复耗时、积压时内存 | 大日志、大队列 | 低至中 / 中 |

### 3.1 排序适用条件

- 下单很少、行情非常密集时，PERF-02、PERF-03、PERF-04 可高于 PERF-01。
- 成交密集或磁盘慢时，PERF-01 通常更值得优先处理。
- 订单数始终很少时，PERF-07、PERF-08、PERF-09 应后移。
- 收益排序不等于实施顺序；正确性修正、验证依赖和工程风险应先于大规模性能改造。

## 4. 高收益优化项

### PERF-01：成交日志同步全量读改写

**判定：**同步全量开销已确认；是否为当前第一瓶颈仍需实测。属于全局尾延迟的高价值候选。

#### 证据

`src/services/mixedTradeLogRepository/index.ts`：

- `:416-426`：同步读取并解析整个文件。
- `:479-503`：完整序列化、写临时文件、`fsyncSync`、`renameSync`。
- `:537-606`：各类追加操作沿上述路径执行。

相关接线：

- `src/app/runtime/createPostGateRuntime.ts:441-452`：普通终态成交记录。
- `src/app/runtime/createPostTradeConsistencyRuntime.ts:214-225`：持久化完成后提交业务状态。

#### 实际触发路径

```text
普通订单终态
→ settlementFlow
→ app listener
→ appendTradeRecord

保护性清仓累计成交推进
→ 持久化 execution progress
→ 提交内存成交事实

保护性清仓完成确认
→ 持久化 completion
→ 推进分段与冷却
```

#### 开销与影响

单日已有 R 条记录时，每次新增记录仍处理完整历史，单次成本随文件大小增长。若连续追加 n 条、单条大小近似固定，累计读写字节量呈近似二次增长。

同步操作阻塞同一个事件循环，可能同时影响行情回调、订单回报、风控唤醒、队列消费和定时器执行。

#### 最小优化

第一层，较小改造：

1. 按交易日维护已解析记录与幂等索引。
2. 原子写成功后才发布新缓存状态。
3. 减少重复解析和幂等全表扫描。
4. 将 retention 移至成功写入之后，避免写失败前先删历史文件。

这一层不能消除全量序列化与全量写入，只减少部分 CPU 和读取成本。

第二层，降低写放大：

1. 采用 append-only journal 或分段日志。
2. 内存索引执行幂等检查。
3. 定期生成恢复快照并压缩日志。
4. 保留可验证的持久化提交边界。

#### 语义与风险

不能把保护性成交记录改成 fire-and-forget，也不能直接去掉 fsync。必须保留：

> 先耐久化精确成交事实，再提交相关内存状态和后续副作用。

异步持久化可以避免主事件循环阻塞，但必须相应改造提交协议并等待 durable acknowledgment，不能只替换函数而不等待。

#### 验证

- 分别测量解析、序列化、写入、fsync、rename 耗时。
- 记录文件大小、事件循环延迟和订单事件完成时间。
- 对不同日志规模做离线基准。
- 注入写失败、fsync 失败、rename 失败及进程中断。
- 验证重启幂等、成交分段、progress/completion 顺序。
- 验证“已有历史日志 + 新文件写失败”时不会提前删除历史文件。

### PERF-02：K 线逐事件全量投影冻结

**判定：**开销和调用链明确；高频事件场景下具有较好的收益/风险比。

#### 证据

- `src/services/quoteClient/candlestickCache.ts:273-301`
- `src/main/businessEventProgram/utils.ts:19-38`
- `src/main/businessEventProgram/index.ts:34-40,79,131-148`
- `src/constants/index.ts:62-67`：窗口上限 200 根。

#### 实际路径

```text
接受 K 线更新
→ cache 复制 candle 引用数组
→ businessEventProgram 遍历完整窗口
→ 为每根 candle 新建策略对象
→ 逐对象 freeze
→ 进入策略
```

cache 主要复制引用数组，并非每次深拷贝全部旧 candle；strategy projection 则确实为完整窗口重新创建对象并冻结。

一分钟 K 线不等于一分钟只处理一次，同一活动柱可以收到多次更新。

#### 最小优化

1. 在数据边界生成规范化、只含 primitive 字段的不可变 candle。
2. 复用未变化历史 candle 的对象。
3. 策略复用已经冻结且与 SDK 脱离的记录。
4. 第一阶段保留长度不超过 200 的数组复制，优先消除全量对象投影。

不建议首先引入复杂的持久化向量或全新增量事件协议。

#### 已排除的低收益方案

单纯增加 `WeakMap<snapshot, projection>` 预计命中率很低：正常路径每次发布新 snapshot，且通常只投影一次，不能解决主要分配。

#### 验证

- 活动柱替换、窗口推进后旧快照仍不变。
- 不暴露 SDK/Decimal 可变引用。
- 保持乱序、确认收线、reset/reseed 行为。
- 检查对象 identity、冻结状态及生命周期隔离。
- 比较每事件分配字节数、GC 次数和策略入口耗时。

### PERF-03：文本日志一次准备与有界关闭

**历史基线：**原审计确认 console/file 对同一条 Pino JSON 记录重复解析和格式化；此前“保留 Pino、入口 parse 一次、cleanupSync 不等待排空”的描述不再代表当前实现。旧行为探针仅作历史证据，不作为本次实现验收。

**当前实施与验收状态：**在 `beta-V2` / `2a367c2fa7384427261d5039c80b5e741ca431ba`、Windows / Bun 1.4.4 的实施工作区，logger 已改为同步准备文本后按 file → console 投递两个 objectMode 队列，四方法 Logger 及业务调用方式不变；Pino 及无外部消费者的 13 包依赖闭包已由包管理器移除，lock 包数 167 → 154，保留包条目无其他语义变更。`shutdownLogger(): Promise<boolean>` 接入薄入口 finally，替代无效的同步关闭承诺。独立复核、定向回归、集中检查及 clean build/残留检查均已通过；实际批次和证据边界见 [Pino 移除方案 §14](./pino-removal-refactoring-plan.md#14-当前实施与集成记录)。

**判定：**当前实现不再对完整日志做 JSON 编解码，时间与 extra 只准备一次；实际吞吐、分配和尾延迟收益仍需目标环境 profiling，不宣称固定加速比例。

#### 当前实现证据

- `src/infrastructure/logger/index.ts` 的 `writeLog`：DEBUG 禁用提前返回；调用时固定时间与 extra，生成 readonly `PreparedLogRecord`，按 file → console 写入。
- 同文件 `formatExtra`：对象采用一轮原生 JSON 序列化，处理循环、BigInt 与固定失败提示；仅 Date/toJSON 等标量结果局部 parse，不恢复整条日志 JSON 信封。已接受的显示差异见方案 §6.3，不宣称所有 unknown 值逐字节等价。
- 同文件 `fileStream` / `consoleStream`：只路由最终文本，各自 FIFO；file 保留本条 system/debug 共同回调屏障，不是无等待的直接扇出。
- 同文件 `DateRotatingStream` / `shutdownLogger`：补齐自有文件 final/destroy、总超时取消及尾部标准流屏障。外部 IO 失败返回 false，内部契约/编程错误 reject；不销毁全局 stdout/stderr，不承诺 fsync 或强退完整落盘。
- `src/index.ts`：继续消费 Bun 启动时已准备的环境变量，不恢复 dotenv；业务清理后等待 logger，再按原始失败与关闭结果决定退出。
- `src/infrastructure/display/marketMonitor/index.ts` 的 `renderTradingQuote` / `renderMonitorIndicators`：仍输出行情和指标；重复调用保留重复日志，不新增去重。

#### 开销边界

历史基线每条完整记录的 JSON 编码、双端 parse、重复时间/extra 格式化已从当前链路删除。对象 extra 为保持紧凑 JSON 文本仍需一次安全序列化，最终文本分配与实际文件/终端 IO 仍存在。

显示 runtime 的 latest-only 只会合并积压，不等同于日志采样或相同内容去重。同步四方法接口也不等于端到端 await IO 或新增队列内存上限。

#### 当前实现范围

1. 直接准备两端文本，不保留 Pino 兼容链路或完整记录解析入口。
2. 保留 level lookup、香港时间、ANSI、文件/控制台路由及调用时 extra 快照。
3. 保留既有两个队列、file → console 投递、文件共同回调屏障和运行期背压政策。
4. 保留按实际消费日轮转、追加与 system/debug 各 7 个日文件的规则。
5. 增加业务清理后的单次有界关闭；总超时取消自有工作，不把外部日志失败升级为交易 fatal。

#### 非等价可选项

降低行情展示频率、仅变化时输出、生产关闭部分展示日志，都改变当前可观测行为，需要单独决策，不能混入本次重构。

#### 验证与限制

- 当前测试路径为 `tests/infrastructure/logger/logger.business.test.ts`、`rotation.business.test.ts`、`shutdown.business.test.ts` 及 `tests/index.business.test.ts`，不再依赖真实 Pino 字节；分别覆盖文本/extra/进程钩子、轮转/保留、顺序/慢端/关闭及入口退出矩阵。
- 最终测试与环境复验使用 `tests/setup/childEnv.ts` 的 `createChildEnv` 白名单，随后显式添加 `BUN_OPTIONS=--no-env-file`，同时保留 CLI `--no-env-file` 和临时输出根；logger/入口 mock 位于隔离子进程，未读取业务 `.env` 或连接 SDK。顶层 flag 未传入嵌套 Bun 的合成探针失败已由 6 组正/负对照复现并解决，不是产品缺陷，也未修改生产脚本；详情及保留的历史证据见方案 §14.3。
- 最终验证代理本人执行 logger/入口/diagnostics/两项架构测试，共 105 pass / 0 fail / 321 expect；独立边界 reviewer 另执行生命周期、清理、runApp、终止矩阵及交易日志持久化回归，共 64 pass / 0 fail / 392 expect。两批合计 169 pass / 0 fail，不把子进程 `node:assert` 计作 Bun expect。独立核心/边界复核及真实 logger + 薄入口的 4 项跨边界探针均通过，未发现阻断项；具体结果见方案 §14.4–14.5。
- 若量化性能，使用不入库的离线临时脚本，在相同 Bun/输出条件下对固定数量的相同四方法调用比较历史基线与当前实现，并等待关闭完成；分别测量 CPU/墙钟、分配/GC 与 event-loop delay，不只测方法返回，也不外推整套交易系统收益。
- 集成与新环境复验均按 lint:fix → type-check 顺序通过（788 个文件）；clean build 通过，源码及 clean dist 的旧接线残留为 0。extra 标量局部 parse、冻结架构基线中的历史符号和交易 `fs.closeSync` 不属于待清理残留。
- `shutdownLogger` 的成功只代表当前关闭协议完成，不证明历史每条日志成功或物理持久化；直接 process.exit、uncaughtException、静态 import 失败、SIGKILL 和掉电不保证完整日志。本次未运行实盘/SDK，未验证其他操作系统或 fsync 耐久性；未运行全仓全量测试，也没有量化性能加速。仅需量化收益时才做上述同条件离线复测，不要求无条件重测。

### PERF-04：延迟验证样本队列线性操作

**判定：**数据结构改进方向明确，优先于复杂指标状态复用。

#### 证据

- `src/core/strategy/intradayRegression/verification/utils.ts:35-50`：队首裁剪使用 splice。
- 同文件 `:61-86`：最近样本全表扫描。
- `src/core/strategy/intradayRegression/verification/index.ts:12-24`：每个候选查询三个目标时间点。
- `src/core/strategy/intradayRegression/index.ts:122-126`：保留窗口计算。

#### 规模与复杂度

当前配置保留约 85 秒样本。设实际有效样本率为 r：

```text
Q ≈ 85 × r
```

r 是实际处理后的事件率，不是原始推送率，也不是固定每分钟一次。

每个候选验证的样本查询约为 O(3Q)。持续产生候选时，样本增长和候选增长会放大 CPU 需求。

#### 最小优化

1. 使用 head-index + 定期 compact，避免频繁搬移数组。
2. 在可证明时间有序时使用二分最近点查询。
3. 优化前明确时间回拨、乱序和重复 timestamp 的处理契约。

类型约定升序不等于运行时保证升序，当前观察时间来自 clock。不能直接假设时间永远单调，也不能擅自引入未定义的丢弃或降级行为。

#### 必须保持

- 三个目标点。
- 不限制最近样本距离。
- 同一样本可服务多个目标点。
- 等距和重复时间点选择规则。
- 缺失指标导致验证失败的语义。

#### 验证

- 新旧实现逐结果对拍。
- 高频样本、大队列、边界等距、乱序和时间回拨。
- 记录队列长度、每秒验证次数和查找耗时。

### PERF-05：warrantQuote/warrantList 嵌套重试

**判定：**已独立确认；故障期收益明确，健康运行时收益有限。

#### 证据

- `src/services/quoteClient/index.ts:689-695`：已包装重试。
- `src/core/riskController/warrantRiskChecker.ts:339-345`：外层再次包装。
- `src/services/autoSymbolFinder/index.ts:143-146`：外层再次包装。
- `src/constants/index.ts:160-163`：每层最多初次加两次重试。
- `src/utils/apiFailure/index.ts:294-374`：包装后的 transient message 仍可能被外层判定为可重试。

#### 请求放大

持续、逐层都被认定可重试的失败下：

```text
3 次外层尝试 × 3 次内层尝试 = 9 次底层调用
```

默认固定退避等待合计约 2.4 秒，另加 SDK 请求耗时。这是静态条件上界，不是实测延迟。不可重试错误或中途成功不会达到该上界。

#### 最小优化

- 由一个边界拥有重试职责，优先保留 quoteClient 的统一外部边界。
- 移除风险检查器和自动寻标器的重复重试层。
- 保持错误分类、operation 和 attempts 观测准确。

#### 验证

通过真实包装链接入 fake SDK，分别验证持续 transient failure、中途成功、不可重试业务错误和 TypeError。

优化后持续失败预算应为预期单层次数，而不是 9 次。

### PERF-06：订单缓存失效竞争与请求去重

> 订单路径迁移注：下文源码行号保留审计时的历史证据。P4.3 后 `core/trader/orderCacheManager`、`core/trader/orderMonitor`、`core/orderRecorder` 的当前落点分别为 `application/orderTracking/orderCacheManager`、`application/orderTracking/orderMonitor`、`application/orderTracking/recorder`，纯投影/选单规则见 `domain/order`；本次目录迁移不代表已实施本审计的性能优化。

**判定：**已确认实现竞争条件；实际发生频率和交易影响未测量。正确性优先于性能收益。

#### 证据

`src/core/trader/orderCacheManager.ts`：

- `:126-158`：缓存检查及异步请求。
- `:197-199`：请求完成后无条件写入缓存。
- `:207-212`：清缓存只清字段，没有 generation。

清缓存调用来自提交、撤单、改单等路径。

#### 可达时序

```text
旧请求开始
→ 订单事实发生变化，clearCache()
→ 旧请求返回
→ 旧结果重新填入缓存
→ 后续读取命中失效前数据
```

同时存在并发 miss 未合并、不同 symbol 请求组合重复查询和乱序响应覆盖风险。

#### 最小优化

1. 建立 invalidation generation。
2. 请求携带 generation 和发布 token。
3. 旧代结果不得重新发布为有效缓存。
4. 只合并满足相同新鲜度要求的同代请求。
5. 明确 forceRefresh 能否加入已有请求，不能机械全局 single-flight。
6. 后续评估全量 todayOrders 快照与本地 symbol 过滤。

“禁止写回旧缓存”与“当前调用者不得收到旧事实”是不同要求；实施前应逐调用链明确，不能只修缓存发布而忽略返回值的新鲜度。

#### 验证

使用 deferred Promise 复现：

- 请求开始 → clear → 旧请求返回。
- 两个 force refresh 乱序返回。
- 同代并发读取。
- 不同 symbol 集合。
- clear 后读取必须得到满足新鲜度要求的事实。

## 5. 订单与状态处理优化

### PERF-07：智能平仓共用一次选择快照

#### 证据与路径

- `src/core/signalProcessor/utils.ts:139-205`
- `src/core/orderRecorder/orderStorage.ts:560-624`

当前可能依次执行成本均价统计、盈利订单筛选、超时订单筛选。各阶段重复获取买单、扫描占用、过滤、排序和 Decimal 汇总。

#### 最小优化

在一次智能平仓调用中准备：

```text
买单集合
+ 成本统计
+ 待卖占用集合
+ 确定性排序后的可用订单
```

各阶段复用该快照，不做跨业务时点全局缓存。

#### 收益与风险

第三阶段启用且买单较多时收益明显；订单少或整体盈利直接结束时收益有限。

必须保留低价、成交时间、orderId 排序、整单不拆分、阶段剩余额度、占用排除及 Decimal 精度。

#### 验证

以最终选单和数量做行为对拍，不只验证函数调用次数。覆盖阶段二与阶段三不重复选单、超时边界、待成交占用和数量上限。

### PERF-08：订单 route 排序由事件驱动改为成员变化驱动

#### 证据

- `src/core/trader/orderMonitor/routeProcessor.ts:275-299,943-955`
- `src/core/trader/orderMonitor/routeRuntime.ts:269-331,355-362`

每轮复制、查找、过滤并排序同标的 tracked orders，约 O(K log K)。quote、订单事件和 timer 均可触发 route。已有 dirty-collapse，但持续高频 quote 仍会持续推进新一轮。

#### 最小优化

- 按 route 维护稳定排序的 order ID 视图。
- attach、detach、恢复、generation 变化时更新或失效。
- quote 更新只读取该视图。

#### 验证与收益边界

检查新增、删除、恢复、同时间订单稳定顺序和 stop/restart。

先测每个 route 的 K 和排序占比，不能仅因存在 sort 就认定为瓶颈。K 很小时维护索引可能不划算。

### PERF-09：席位刷新重复扫描全量订单

#### 证据

- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:313-364`
- `src/core/orderRecorder/index.ts:128-145,319-348`
- `src/core/riskController/dailyLossTracker.ts:648-699,849-856`

一次刷新中，相关 symbol 预检、目标重建、亏损重算和归属诊断多次扫描同一订单快照。

#### 最小优化

- 为单次 SEAT_REFRESH 创建临时分组和分类结果。
- 预检与目标重建复用结果。
- 保留完整事实验证与原子候选提交。
- 不跨任务缓存这些结果。

#### 收益与验证

主要改善激活/换标，非每个 quote 热路径。订单历史较大时价值较高，但不减少必须的新鲜订单 API 请求。

验证大订单量基准、malformed execution、未知状态、归属失败和 seatVersion 中途变化。

### PERF-10：延迟候选共享最早到期 timer

#### 证据

`src/core/strategy/intradayRegression/verification/index.ts:83-111`：不同目标时刻候选分别持有 timer、闭包和 Map entry。

当前延迟 60 秒，额外采样 10 秒。若每秒实际产生 c 个候选，稳定 pending 规模约为：

```text
P ≈ 70 × c
```

此为条件估算，不是运行数据。

#### 最小优化

- 优先队列管理候选。
- 每个策略实例只维护最早到期唤醒。
- 到期后按原顺序处理应执行项。

#### 约束

降低 timer 管理成本不等于消除候选内存。不能未经业务确认按动作合并候选，因为不同候选有不同初始值和目标时间。

#### 验证

高频持续触发、同刻到期、取消、方向失效、实例隔离和旧 timer token 失效。

### PERF-11：账户与持仓读取受控并行

#### 证据

- `src/main/asyncProgram/monitorTaskProcessor/helpers/refreshHelpers.ts:49-62`：先账户、后持仓。
- `src/utils/accountPositions/index.ts:51-82`：其他路径已有并行与 all-settled 处理。

#### 最小优化候选

两个独立读取并行启动，但：

- 仍分别经过 limiter。
- 两个请求都被观察和排空。
- 双成功且 canContinue 仍有效才提交。
- 不并行化整个席位激活链路。

理论上部分等待可从两个请求耗时之和降为重叠后的较大值，实际收益受 limiter 与网络延迟限制。

#### 风险与验证

并行改变失败时是否发出第二个请求，不是无条件的一行替换。使用 deferred 测试验证异常、取消、兄弟请求排空和原子提交。

## 6. 需实测后决定的项目

### PERF-12：指标 preview clone

#### 证据

- `src/core/strategy/intradayRegression/runtime/index.ts:94-103,476-491`
- `src/core/strategy/intradayRegression/runtime/mfi.ts:87-98`
- `src/core/strategy/intradayRegression/runtime/kdj.ts:45-57`

未确认活动柱在 committed 指标状态的副本上计算，避免污染确认基线。

独立复核确认：

- 不是每次重算 200 根历史。
- 不是整个 runtime 的通用深拷贝。
- 只维护配置要求的指标 families。
- MFI/KDJ 可变窗口需要复制，其他状态多为标量。

#### 可探索方向

专用 preview 计算、可复用内部工作区或严格 copy-on-write。

这些方案交易语义风险高于 K 线标准对象共享。必须先证明 clone 是主要热点，再以逐事件全量对拍检查 committed 状态始终未污染。

#### 验证

活动柱重复更新、确认收线、窗口 shift、无效 OHLCV、恢复重建及随机事件序列差分测试。

**建议优先级：低于 K 线投影、日志和样本队列。**

### PERF-13：行情读取去重与静态清仓预筛

#### 证据

- `src/services/quoteClient/index.ts:474-507`
- `src/main/tradingQuoteDisplayRuntime/index.ts:107-181`
- `src/main/monitorDisplayRuntime/index.ts:57-84`
- `src/main/monitorQuoteEventRuntime/staticLiquidationExecutor.ts:171-258`

#### 重要边界

getQuotes 调用 SDK realtimeQuote，不能把每次调用直接算作 HTTP 请求或认定消耗服务端配额。SDK 内部传输成本和供应商计费/限流口径未评估。

#### 优化空间

- LONG/SHORT 展示并发读取相同 monitor symbol。
- 展示 runtime 之间共享同批 in-flight 结果。
- 静态清仓明显无候选方向时提前返回，减少 SDK 读取和转换。

#### 约束与验证

- 不暴露共享可变 Map。
- 不直接合并买入预筛和最终提交前行情读取。
- 不引入全局 TTL 缓存替代执行时最新事实。
- 提前返回保留 freshness、WAIT 和持仓变化唤醒语义。
- fake SDK 验证并发调用计数、失败传播、stop 与生命周期失效。

### PERF-14：Decimal、时间和状态快照常数优化

| 项目 | 证据 | 建议 | 优先级 |
| --- | --- | --- | --- |
| 稳定数值反复转 Decimal | `src/utils/numeric/index.ts:11-28,71-190` | 风控状态刷新时准备稳定 Decimal 输入，新价格只转一次 | 中 |
| 日期工具生成未使用字段 | `src/utils/time/index.ts:9-36,57-59,87-89` | 分离 date-only、clock-only、完整日志格式化 | 中低 |
| fresh 路径 Promise 与 status 对象 | `src/utils/refreshGate/index.ts:124,156-164` | 评估共享 fulfilled Promise、标量查询或不可变状态缓存 | 低 |
| 同一快照多动作重复 reason | `src/core/strategy/intradayRegression/index.ts:57`、`utils.ts:196-207` | 单次评估内惰性生成一次 | 低 |

不要用 JS 浮点替代金融 Decimal 计算。应减少重复构造，而不是降低金额、数量或阈值精度。

验证需覆盖严格阈值、Decimal 输入等价性、香港日界线、无效 Date、fresh/stale/abort 和 reason 精确格式。

仅在分配 profile 支持时，这些项目才应早于算法和 I/O 改造。

### PERF-15：恢复、队列及其他低优先级项目

#### 恢复与启动

- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:430-454`：逐保护性订单扫描 progress，约 O(E×P)。可建立 orderId 到 latest progress/baseline 的索引。
- 恢复与冷却 hydration 存在重复读取同一 mixed log 的机会，可共享经过校验的恢复快照，但必须处理恢复中新增完成记录。
- 配置解析和校验存在重复，只在启动发生且键数量较小。
- source 与 dist 启动方式差异主要影响冷启动，不是交易期吞吐重点。

验证恢复结果、crash-gap 判定、幂等与大规模恢复耗时。实施前重新定位恢复文件实际路径，避免依赖行号不变。

#### 队列与订阅

- `src/main/asyncProgram/monitorTaskQueue/index.ts:121-162`：latest replacement 使用 tombstone，连续替换可保留无效任务直到消费或整理。实际积压显著时考虑可删除节点结构，保持替换后排到队尾。
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts:76-88`：席位退出扫描多个队列，属于边沿事件。
- `src/main/quoteSubscriptionRuntime/index.ts:45-53,341-352`：retain 查询可用反向引用索引优化，但当前 owner/symbol 规模较小。

验证 FIFO、方向和 seatVersion 隔离、removeTasks、clearAll、stop/drain 及订阅失败回滚。

#### 风控与末日保护

- 浮亏检查已缓存 R1/N1，quote 判断不是每次遍历全部买单。
- 基础仓位限制主要是小规模 Decimal 运算。
- 末日保护围绕少数方向和当前持仓处理。
- 成交后一致性刷新已有 pending 合并与 in-flight 门禁。

可评估让成交刷新携带受影响方向以减少局部重算，但不能跳过账户/持仓刷新、保护性完成判断或全量纠偏。

#### 条件求值

`src/core/strategy/intradayRegression/utils.ts` 的可用性检查和实际求值存在重复遍历。当前条件数量小，可后期编译 accessor 或合并求值，收益预计低于数据投影与日志。

## 7. 必须保留的现有优化与业务约束

以下设计已有明确价值，不应为了表面性能而回退：

1. 事件驱动和一次性定时唤醒。
2. single-flight、latest-only、dirty-collapse。
3. 指标增量状态，而非逐事件全量重算历史。
4. KDJ 单调队列及有界窗口。
5. 队列 headIndex，避免每次 shift。
6. 订单路由 Map 索引。
7. 部分账户/持仓路径的并行 all-settled。
8. 成交后 freshness 门禁、seatVersion、generation 和最终下单前复查。
9. 行情订阅变更串行化及失败回滚。
10. 自动寻标列表的 TTL 和 in-flight 去重。

### 7.1 禁止作为性能优化的行为

- 缩短策略延迟验证。
- 跳过最终风控。
- 复用过时持仓。
- 合并必须保留身份的订单或候选。
- 丢弃权威订单事件。
- 降低持久化强度。
- 擅自缩短 limiter 间隔或提高预算。
- 以浮点替代需要精确计算的 Decimal。

### 7.2 限流与重试预算需核实

读取重试目前存在“单次 admission 内多次 attempt”的结构，例如：

- `src/core/trader/accountService.ts:33-38,74-81`
- `src/core/orderRecorder/orderApiManager.ts:272-290`

仓库 limiter 常量及注释不能替代券商真实限流契约。应记录每次 attempt 与 admission 时间，核对真实预算规则，而不是通过绕过 limiter 提速。

若外部契约要求每次 attempt 计费，应在每次 attempt 前取得相应预算。当前是否违反券商契约未评估，不报告为已确认生产缺陷。

## 8. 独立复核纠正与安全前置项

### 8.1 排除的初步判断

| 初步判断 | 最终处理 |
| --- | --- |
| 所有 getQuotes 都是 HTTP 请求 | 排除；它是 SDK realtimeQuote 调用 |
| 指标每次更新重算全部 200 根 K 线 | 排除；正常路径采用增量指标状态 |
| snapshot WeakMap 一定显著降低投影成本 | 排除；正常新快照只投影一次，命中率预计很低 |
| 每个 timer 都可以按动作直接合并 | 排除；不同候选的目标时刻和初始值不同 |
| dotenv 晚于静态 import 必然使当前启动配置失效 | 排除该历史假设；Bun 启动默认加载环境文件，当前薄入口直接消费 process.env，不依赖 dotenv 初始化，本次不得恢复该依赖 |

### 8.2 安全前置项

1. **订单缓存旧请求覆盖失效状态的竞争**：纳入 PERF-06，优先处理。
2. **交易日志 retention 在新文件成功写入之前执行**：纳入 PERF-01，防止写失败时提前删除历史文件。

性能改造不能掩盖或加剧这些风险。

## 9. 实施路线

### 阶段一：建立离线性能基线

使用 fake SDK 和可重复事件回放，不启动实盘。

| 指标                                  | 用途                 |
| ------------------------------------- | -------------------- |
| 原始事件数、实际处理数、合并数        | 判断背压与实际触发率 |
| K 线处理 p50/p95/p99                  | 定位策略入口延迟     |
| 订单事件到完成结算 p95/p99            | 定位同步持久化影响   |
| event-loop delay/utilization          | 区分计算、阻塞和排队 |
| 分配字节/事件、GC pause               | 验证快照和日志优化   |
| samples、pending、timer 数            | 判断延迟验证规模     |
| SDK attempt 数与 limiter admission 数 | 识别重试和重复请求   |
| freshness 等待时间                    | 识别成交刷新瓶颈     |
| route 订单数、排序次数和耗时          | 决定是否维护有序视图 |
| 日志字节量及 fsync 分位数             | 决定持久化改造深度   |

回放场景：

- 高频活动柱更新。
- 持续满足信号条件。
- 连续部分成交。
- 大量历史订单。
- SDK 暂时失败。
- 慢磁盘与单日日志规模增长。

### 阶段二：去重、结构共享与安全修正

建议顺序：

1. 修正订单缓存失效竞争。
2. 移除嵌套重试。
3. 修正日志 retention 顺序。
4. K 线规范化对象共享。
5. Logger 单次解析、多端输出。
6. 延迟样本 head-index 改造。
7. 减少成交日志重复解析。

先执行可明确验证、根因清晰的变更，不同时重写多个高风险链路。

### 阶段三：按基线推进较大改造

仅在数据支持时实施：

- 增量耐久化日志。
- 延迟验证索引与共享调度器。
- 智能平仓事务内快照。
- route 有序成员视图。
- 席位刷新分类复用与受控并行。
- 指标 preview 专用实现。

### 9.1 验收标准

每项优化必须同时满足：

> 性能改善 + 业务结果等价 + 错误语义不退化 + 生命周期正确。

- 重点看 p99 与突发负载，不只看函数平均耗时。
- 每个阶段只引入少量可归因变更。
- 使用差分回放验证信号、订单选择、数量、状态迁移和错误分类。
- 涉及持久化时增加故障注入与重启恢复验证。
- 涉及异步状态时增加 deferred Promise 的竞争时序测试。
- 实际 TypeScript 改码后按项目要求依次运行 bun format、bun lint、bun type-check，并运行与改动范围相称的行为测试。
- 本文仅为计划，以上验证尚未执行，不能据此宣称通过。

## 10. 未评估项与置信度

未评估：

- 生产实际 quote/K 线事件率、成交率、队列峰值与订单规模。
- CPU profile、分配 profile、GC pause 和端到端延迟。
- Longbridge SDK realtimeQuote 的内部成本、网络行为与服务端配额口径。
- 部署磁盘 fsync 尾延迟、进程外并发访问和断电持久性保证。
- 真实生产环境变量及外部部署配置。
- docs/tools 内容及其中可能存在的独立运行工具。

置信度：

- 代码路径与静态复杂度：高。
- 优化方向与等价性约束：中至高。
- 实际收益排序及加速幅度：中；必须以基线修正，不提供未经测量的百分比或倍数。

## 11. 最终建议

若只能选择三个主攻方向：

1. 成交持久化的全量读写与同步阻塞。
2. K 线快照和行情日志的高频分配。
3. 延迟验证样本的数据结构。

同时将嵌套重试和订单缓存失效竞争作为先行的小范围工作处理。

这比重写整个框架、删除 await、统一改可变对象、全面替换 Decimal，或直接迁移到其他语言，更有可能获得可验证且不破坏交易语义的性能提升。
