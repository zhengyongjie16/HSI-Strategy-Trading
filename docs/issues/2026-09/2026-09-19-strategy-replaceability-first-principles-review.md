# 策略可替换性与交易链路第一性原理复核

- **复核日期**：2026-09-19
- **范围**：策略装配、行情投影、策略决策、延迟验证、信号适配、买卖队列、卖出重试、生命周期、构建与替换性测试
- **性质**：三代理复核结论的文档校正；本轮只修改文档，不修改生产代码、配置或测试
- **修复方案**：[2026-09-19 策略可替换性最终修复方案](../../plans/2026-09-19-strategy-replaceability-remediation-plan.md)
- **结论状态**：STRAT-001 的数值污染已确认且仍是必要修复；用户已确认坏柱政策为“本轮 KDJ 不可用”，即 H/L/C 缺失或无效时本轮 K/D/J 均不可用。共通 guard、本轮可用性传播和验收仍待实施，不能把代码写成已修复；STRAT-004 是真实的组合验证缺口；STRAT-002、STRAT-003 的原结论需按后文降级和收窄。
- **验证边界**：已读取相关 TypeScript、测试和 `package.json` 脚本；前轮已用 `bun --eval` 直接调用生产 KDJ 函数完成最小复现，本轮不重跑。完整测试、type-check、lint、build 和 Broker/线上验证均未在本轮运行。

## 1. 复核目标与第一性原理

当前系统的业务边界应先从交易事实定义，而不是从“策略目录是否被宿主 import”定义：

1. **策略只产生普通交易意图**：根据不可变的一分钟行情、当前席位事实和宿主传入的评估门禁，输出四种公共动作之一；策略不决定标的、数量、委托类型、清仓授权或订单执行。
2. **宿主拥有交易事实与执行权**：订单记录、持仓、席位版本、交易日、队列、Broker 调用、风险和终止状态均由宿主维护。策略只通过 `StrategyDeps` 获得 clock、scheduler、logger 和 fatal 端口，不获得订单或 Broker 能力。
3. **延迟验证是策略内部状态**：样本、指标 runtime、pending candidate、timer 和验证规则留在策略实例内部；宿主只在生命周期边界调用策略的公共生命周期端口。保留这一所有权，不把 pending/timer 提升到宿主，也不为此引入新框架。
4. **资格事实与执行事实分离**：`hasFilledBuyOrders` 是首次产生候选时由宿主投影的当前已成交 BUY 记录资格，不是持仓、历史成交总表或 pending BUY；延迟 SELL 保留该 origin 资格，执行时仍由适配器、当前席位、行情、持仓和执行门禁约束。
5. **可替换性必须用真实运行链路证明**：仅证明 `prepare()` 能 import，不能证明第二策略能完成 `create → onCandlestick → emit → adapter → queue`。

6. **公共边界是有意的业务协议**：四种 action、LONG/SHORT 席位和一分钟行情是当前普通交易协议，不等于把日内回归策略的 EMA/KDJ/MFI 等私有实现泄漏给宿主。若未来需要组合权重、目标仓位或跨标的篮子，应另立 intent/portfolio 协议，不能在本协议上零散加字段。

本次结论按优先级分开：

- **P1 必须修复**：已能从当前代码和生产配置推出数值污染或不正确交易决策，或在上线前必须补齐的安全修复。
- **P2 替换性验收必修**：当前 loader 并未被证明错误，但没有真实 decision-to-queue 回归就不能宣称“策略可替换”已验证。
- **P3 可选维护**：类型或契约可以更清楚，但没有当前交易错误证据；不得放入本次必要验收门槛。
- **无需修复**：已确认的稳定业务协议、正确的所有权设计，或尚未触发的能力风险；不为“看起来更通用”而改动交易语义。

## 2. 端到端调用链结论

当前生产链路为：

```text
ACTIVE_STRATEGY_ID
  → prepareStrategy
  → strategyDefinition.prepare
  → selected PreparedStrategy.create
  → MonitorContext.strategy
  → CandlestickCache snapshot
  → businessEventProgram
  → strategy.onCandlestick(context, emitter)
  → emissionAdapter
  → STRATEGY_BUY / STRATEGY_SELL queue
  → buyProcessor / sellProcessor
  → 当前席位、持仓、行情与终止门禁
```

复核确认：

- 生产宿主没有按 `intradayRegression` 私有实现散落条件分支；主要动态装配边界仍是 `src/app/startup/prepareStrategy.ts`。
- `src/main/businessEventProgram` 只投影不可变的一分钟行情、席位方向/标的和 `hasFilledBuyOrders`，调用选中策略一次；`emissionAdapter` 再校验 action、时间、origin、席位、交易日和当前门禁，把普通信号送入统一队列。
- 当前策略的 sample、indicator runtime、pending、timer 和验证器仍在 `src/core/strategy/intradayRegression` 闭包内，宿主没有读取这些内部状态。活动柱 preview 会克隆 committed 状态计算，不会直接污染 committed；确认或 shift 时再通过 clone 后的状态持久提交。
- 当前正式 `config.json` 的四个 signal 都实际使用 D/J；BUY verification 是 D、ADX，SELL verification 是 K。因此 KDJ 污染的数值路径可达正式 decision/verification，但这不等于已经证明线上错单。
- 因此当前系统不是“完全任意语义插件”，但已经是“遵守同一普通交易协议的策略实现可替换”架构。下面的问题集中在协议安全性和验证闭合性，而不是要求删除稳定的公共交易协议。

## 3. 问题总览

| 编号 | 问题 | 最终判定 | 优先级 | 本方案位置 |
|---|---|---|---|---|
| STRAT-001 | 无效 K 线会污染 KDJ 状态 | 已确认；正式配置可达；坏柱政策已确认是本轮 K/D/J 不可用；共通 guard、可用性传播和验收仍待执行 | P1 | 第 4 节、方案 G1–G3 |
| STRAT-002 | 生命周期域的某些依赖类型可以更窄 | 原结论部分错误：`signalRuntimeDomain` 可做局部 `Pick` 维护；`timeWakeup` 的末日保护依赖不能仅收窄为策略端口 | P3 | 第 4 节 STRAT-002、方案 O1 |
| STRAT-003 | `reason` 参与卖出重试 key | 事实成立，但 key 还含 trigger/action 等字段；未证明当前漂移、误合并或错单。身份策略尚未定案 | P3 | 第 4 节 STRAT-003、方案 O2 |
| STRAT-004 | 缺少第二策略实际产生 decision 并通过宿主队列的组合回归 | 缺口成立；不是 loader 缺陷，也不是从零开始的测试缺失 | P2 | 第 4 节 STRAT-004、方案 R1–R3 |

## 4. 已确认问题与必要修复边界

### STRAT-001：无效 K 线污染 KDJ 状态

**状态**：confirmed / P1 必须修复；用户已确认“本轮 KDJ 不可用”；实现与验收尚未执行，也未证明已经线上错单

#### 业务不变量与修复边界

KDJ 的一根输入 K 线只要求其实际计算所需的 `high`、`low`、`close` 可用；缺少 `open` 不应因此拒绝 KDJ。任一所需字段无效时，必须在 commit 前原子返回，不能改变 KDJ 的窗口索引、最高/最低值 deque、RSV 窗口或 K/D 状态。

用户已明确：当当前轮 K 线的 H/L/C 任一缺失或无效时，**本轮 K、D、J 三者全部不可用**。即使 committed 中保留上一份 KDJ，也不能把旧值冒充当前轮有效值进入指标快照、显示、信号判断或验证样本。该不可用范围只针对当前 KDJ 家族；其他指标仍按各自既有 partial-data、预热和 N-of-M 语义处理，不把整个系统或全部动作一概标为不可用。

`runtime/utils.ts:10-23` 当前 `toNumber(null | undefined)` 返回 `0`，这是污染的直接诱因之一；本修复**不**全局改变 `toNumber`，也不把其他指标的 partial-data 政策改成 KDJ 政策。`runtime/kdj.ts:104-158` 必须先完成 H/L/C 的转换与验证，再进行 `index`、high/low deque 或 close 相关状态的任何 mutation。

#### 证据与运行路径

1. `src/services/quoteClient/candlestickCache.ts:94-107,247-250` 对记录进行结构归一化和缓存，但没有保证 OHLC 每个字段都是可用于每一种技术指标的有限数。
2. `src/main/businessEventProgram/utils.ts:19-41` 的行情投影保留 `null`、`undefined` 和非有限值，不用 0 补齐，也不在宿主层统一丢弃 partial candle；这不是本问题要改变的层。
3. `src/core/strategy/intradayRegression/runtime/utils.ts:10-23` 的 `toNumber(null | undefined)` 返回 `0`；不能因此全局改 helper，因为其他指标已有各自的缺失值政策。
4. `src/core/strategy/intradayRegression/runtime/kdj.ts:104-158` 的 `commitKdjCandle()` 先递增 `state.index`，再把转换后的 `high`/`low` 写入 deque；`close` 只在 deque 已更新后才检查有限性。
5. 正式 `src/core/strategy/intradayRegression/config.json` 的四个 signal 均含 D/J，BUY verification 是 `D`/`ADX`，SELL verification 是 `K`。因此 KDJ 污染能进入正式 signal/verification decision，而不是只影响未启用的测试指标。
6. 当前 `src/core/strategy/intradayRegression/runtime/index.ts` 的 preview/committed 分离只保证 clone 不直接改 committed；`buildSnapshotFromCommitted()` 仍会读取 committed 的旧 KDJ，尚未把“当前轮 KDJ 输入被拒绝”传播到快照。`display.ts`、`utils.ts`、`verification/utils.ts` 和 `verification/index.ts` 是必须核对的本轮可用性消费者。

当前错误路径为：

```text
缺失/无效 H/L/C
  → CandleData / projectCandlesticks 保留 partial 值
  → runtime/utils.toNumber 将缺失值变成 0
  → commitKdjCandle 先更新 index/deque，之后才检查 close
  → K/D/J 被污染
  → intradayRegression 评估正式 signal / verification
  → StrategyDecision
  → emissionAdapter
  → queue
```

修复后的必要传播路径为：

```text
当前轮 H/L/C 无效
  → KDJ commit guard 拒绝并保持持久 KDJ 数学状态
  → 仅更新当前轮 KDJ 可用性元数据，输出快照不暴露旧 KDJ
  → display / N-of-M signal / verification sample 均看到 K/D/J unavailable
  → 既有 pending 保留；新候选按现有缺值与初始验证规则处理
```

这不是“指标最后返回 null”就能抵消的单点问题：无效 `high`/`low` 已经改变了窗口结构，后续有效 K 线仍会使用被污染的 deque；无效 `close` 也可能在本柱部分状态已提交后才退出。修复后必须同时完成数学状态 guard 和当前轮可用性传播；只修 guard、仍让快照读取旧 KDJ，不能宣称 STRAT-001 已修复。

同时要区分活动柱 preview 与 committed：活动柱 preview 会从 committed clone 计算，确认或 shift 时也会通过 clone 后的状态持久提交。坏柱 preview 不得污染 committed，但也不得因为 clone 隔离而继续把 committed 的旧 KDJ当成本轮有效值。

#### 影响判定与已完成复现

这是当前生产配置可达的数值污染和交易决策风险，但不是线上错单的证据。前轮代理已用 `bun --eval` 直接调用生产 `kdj` 函数复现，无落库、无 Broker；本轮不重跑。20 根正常基线为 `i=0..19` 的 `{high:102+i, low:98+i, close:101+i, volume:1000}`，在前 18 根后插入坏柱，再追加最后 2 根。结果如下（K/D/J）：

| 序列 | 结果 | `stateChanged` |
|---|---:|---:|
| 20 根正常基线 | `91.667 / 91.667 / 91.667` | — |
| 插入全 `null` 坏柱 | `66.113 / 63.612 / 71.116` | `true` |
| 插入 `{high:1000, low:1, close:NaN}` | `38.463 / 65.060 / -14.729` | `true` |
| 插入缺 `high` 的 `{low:115, close:118}` | `90.909 / 91.162 / 90.404` | `true` |

该复现只证明数值和状态污染，不证明已发生线上错误订单。不能把责任转移到 cache 层：当前系统允许不同指标按自身规则处理 partial data，宿主统一丢弃所有缺失字段会改变既有策略语义。

#### 无歧义的最小修复方向：共通 guard 与本轮可用性传播

在 `src/core/strategy/intradayRegression/runtime/kdj.ts` 的 `commitKdjCandle()` 入口先完成整根 K 线的输入检查：

- 只检查 KDJ 实际需要的 `high`、`low`、`close`，按 KDJ 既有有限值/结构不变量判断；不因缺 `open` 拒绝，也不要求 cache 层统一丢弃 partial candle。
- 任一字段无效时直接返回；返回前不得递增 `index`，不得修改任何 deque、rolling window 或 K/D 状态。可用的最小实现可以返回局部接受/拒绝结果，供 runtime 标记当前轮可用性，但不得引入通用指标框架。
- 不全局修改 `runtime/utils.ts` 的 `toNumber`，不改变 MFI 等其他指标的缺失值政策，不新增宿主公共规则。
- `runtime/index.ts` 的 bootstrap、active preview、同 timestamp 替换、confirmed commit 和 shift commit 均通过同一原子 guard；其他指标即使按自身规则更新，也不能改写 KDJ 的拒绝结论。

随后在策略私有 runtime 边界完成必要的本轮传播：

- `runtime/types.ts`/`runtime/index.ts` 只增加表达“当前输出对应的 KDJ 输入是否被接受”的最小私有元数据（或等价内部状态），不把 availability 抽成宿主通用协议；`IndicatorCommittedState.kdjState` 仍只保存数学状态。
- `buildSnapshotFromRuntime()` 在当前轮 H/L/C 被拒绝时必须抑制 `IndicatorSnapshot.kdj`，不能让 `buildSnapshotFromCommitted()` 的旧值漏出；若继续使用现有 `kdj: null` 合同即可，不必新增公共字段。
- `display.ts` 和 `utils.ts` 必须通过现有 `getIndicatorValue`/有限值检查自然省略或跳过 K/D/J；不能从 committed 状态补回旧值。其他合法指标照常显示和参加 N-of-M：K/D/J 只按“不可用条件项”计数，不添加全动作禁令。
- `index.ts` 的新候选仍按现有流程：信号组先按可用指标数和 N-of-M 判断；若延迟验证所需初始指标包含当前不可用的 K/D/J，则 `getIndicatorValue()` 得到缺值、候选不注册，不能回退为立即信号。若该 signal/verification 不依赖不可用 KDJ，其他合法指标仍按现有语义运行。
- `verification/utils.ts`/`verification/index.ts` 必须保持样本三态和验证消费者语义：坏轮 K/D/J 只能投影为已有的 `missing`/`invalid` 非 value，不得写旧值；当前实现中 `snapshot.kdj === null` 会走 `missing`，`passesVerification()` 对 `point.kind !== 'value'` 直接失败。不得为此补样本、延长 timer 或新增 fatal。
- 既有 pending 不因一个坏柱自动取消。timer 仍按现有一次性注册/终态化语义运行；选中的坏样本使验证沿现有 missing/invalid 失败并不 emit，缺样本仍按现有 `passesVerification()` 失败，不新增重试。若当前轮按既有无有效价格规则直接返回 `null`，也不得借此新增取消或 fatal。

#### 已确认的本轮不可用政策（不再是待决策门槛）

用户已确认：**无效 K 线出现时，本轮 KDJ 不可用**。这里的“本轮”是当前缓存事件所代表的最新 bar（活动或已确认），不是把历史上所有坏柱永久传播为全局禁用。

- H/L/C 任一缺失、非有限或无法通过 KDJ 既有结构检查时，本轮 K、D、J 一并不可用；缺 `open` 不触发该政策。
- 指标快照和两种显示投影不得把 committed 的旧 KDJ冒充本轮有效值；坏轮没有 K/D/J 有效 display，也不能把旧值写进验证 sample。
- 信号沿现有 N-of-M 和缺值语义处理：K/D/J 是不可用条件项，其他合法指标仍可满足同一条件组的最少项数；不新增“所有 action/整个系统禁用”的规则。
- 新延迟候选若其 initial verification 必需 K/D/J 不可用，不注册且不回退立即；没有该依赖的候选不受无依据的全局阻断。
- 已有 pending 不自动取消。坏轮在能生成 snapshot 时按现有三态样本写入非 value；timer 到期后的缺样本/invalid 判定沿现有验证逻辑，不补样本、不延长 timer、不新增 fatal。
- KDJ 的持久数学状态拒绝坏柱后保持不变；当前轮可用性元数据和对外输出可以更新为不可用。后续有效柱从未被污染的状态继续计算，仍须满足 KDJ 预热/就绪条件，不能盲目置 ready。

#### 活动柱、确认、shift 与 bootstrap 的输出/状态矩阵

| 场景 | committed KDJ 数学状态 | 当前轮 KDJ 输出/可用性 | 交易链路语义 |
|---|---|---|---|
| 同 timestamp 活动柱坏 → 好 | 两次 preview 都不写回 committed；坏柱不改变基线 | 坏时 K/D/J 不可用；好柱替换 active bar 后从同一未污染基线重算，只有实际 ready 才可用 | 坏样本不写旧值；好样本按新快照采样。pending 不因坏轮取消，新评估仍受现有 `allowNewEvaluation`/N-of-M 约束 |
| 同 timestamp 活动柱好 → 坏 | 好 preview 从未持久化；坏 preview 不会继承好 preview 的数学写入 | 坏时 K/D/J 不可用，不显示旧的好 preview，也不把它作为本轮有效值 | 既有 pending 保留；新候选按缺值语义，不把坏轮降级为立即 |
| 活动柱确认且该柱坏 | KDJ guard 拒绝，committed KDJ 数学状态不变；其他指标按各自已有规则处理 | 当前已确认最新 bar 仍标记 K/D/J 不可用；不回显旧 KDJ | 不新增 fatal/取消；若整体快照无有效价格则沿现有 `onCandlestick()` 返回 null 语义 |
| 活动柱确认且该柱有效 | 从未污染的 committed 基线提交；active 清空 | 只有 `readKdjValue()` 实际就绪且有限时才输出 K/D/J | 采样/信号按现有流程，仍不跳过预热 |
| shift：上一活动柱坏，当前新柱有效 | 上一坏柱被当历史输入再次经过 guard，仍不改变 KDJ 数学状态 | 当前新柱从未污染基线 preview；历史坏柱不无条件永久屏蔽当前有效柱，当前仍按 accepted bars 的预热/就绪输出 | 当前 sample/decision 只按当前新柱；既有 pending 不因上一坏柱自动取消 |
| shift/bootstrap：当前最新柱坏，或历史柱坏但当前柱有效 | 当前坏柱的 KDJ commit 被拒绝；历史坏柱只影响其自身，不设永久屏蔽 latch | 最新坏柱本轮不可用；历史坏柱之后的有效当前柱可恢复计算，但仍须满足有效样本预热 | 不把历史坏柱等同当前轮；其他指标继续按原 partial 规则 |

#### 必须验证

- 全 `null`、全 `undefined`、`NaN`、`Infinity`、缺少单一 H/L/C 字段，以及缺 `open` 但 H/L/C 有效的 K 线均覆盖；无效输入不改变 `index`、四个 deque、RSV/K/D 窗口、窗口和、K/D 值及 `hasKdjValue`。
- 无效 K 线前后的有效序列与 golden baseline 完全一致；对比 committed 数学状态和当前轮可用性元数据，确认两者可分别变化。
- 覆盖 active preview 同 timestamp 的坏→好、好→坏；confirmed bad/good；shift 中历史坏柱与当前坏柱；bootstrap 中历史坏柱/当前坏柱。断言输出、display、sample 和 committed 边界，不把 preview 结果当成 committed。
- 信号测试覆盖 K/D/J 缺失时的 N-of-M：其他合法指标达到最少项数仍按现有规则评估，不能误加全动作禁令；KDJ 是 delayed initial verification 必需项时不注册、不回退立即。
- 验证测试断言坏轮 K/D/J sample 不是 `value`，已有 pending 不被自动取消；`passesVerification()` 对 missing/invalid/无样本继续失败，不新增补采样、延长 timer 或 fatal。
- 当前正式 profile 的四个 D/J signal、BUY `D`/`ADX` verification 和 SELL `K` verification 覆盖回归；现有 `config.test.ts` 的正式 profile 断言继续保留。
- `MFI`、ADX、EMA、RSI、PSY、MACD 等允许不同缺失值或预热政策的指标不被这次修复意外改变；不得用 cache 全局丢 partial 或全局修改 `toNumber` 来“通过”测试。

---

### STRAT-002：生命周期域依赖类型的局部收窄

**状态**：原结论部分错误；P3 可选维护，不阻断本次修复或策略替换验收

#### 事实与边界

- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:101` 实际只调用 `monitorContext.strategy.resetForTradingDay()`；这里可以把 `SignalRuntimeDomainDeps` 的策略字段局部收窄为 `Pick<TradingSignalStrategy, 'resetForTradingDay'>`（或等价命名端口）。这是维护性改善，不是当前交易错误。
- `src/main/timeWakeupEvaluationProgram/index.ts:419-440` 的末日保护路径把完整对象传给 `cancelPendingBuyOrders` 和 `executeClearance`。后者读取席位/version、`orderRecorder` 等真实宿主事实，不能把这段依赖错误地简化成 `invalidateAll`；`timeWakeup` 本轮不改。
- 策略本身只接 `StrategyDeps` 和公共市场上下文；宿主的 `monitorContext` 含有交易能力，并不表示策略依赖了完整 `MonitorContext`。
- 当前没有证据表明这些生命周期代码已经读取策略私有指标、订单写能力或 runtime 状态。需要防的是未来误扩展，不是修复已确认的错单。

#### 最小可选工作

- 仅对 `signalRuntimeDomain` 的真实调用点做局部 `Pick`，装配层传递 `monitorContext.strategy` 的窄视图；保持午夜 reset、termination latch、取消顺序和 destroy 顺序不变。
- `timeWakeup` 保持现状。若另立治理任务，必须先按末日保护函数真实读取的 seat/version/orderRecorder/position/trader 能力做宿主 projection，不能套用策略生命周期端口，也不能只传 `invalidateAll`。
- 不删除策略 lifecycle port，不把 pending/timer 提升到宿主，不引入事件总线或通用框架。

#### 可选验证

类型检查和现有 seat cleanup、末日保护、午夜 reset、shutdown/fatal 顺序测试应继续通过；这项维护不得成为本方案的必修验收门槛，也不能借机宣称 `timeWakeup` 已经完成最小能力投影。

---

### STRAT-003：`reason` 参与卖出重试 key，但身份政策尚未定案

**状态**：事实成立；未证明当前重试漂移、误合并或错单；P3 可选工作，不放入本次必要验收门槛

#### 证据与运行路径

1. `src/core/strategy/types.ts` 的 `StrategyDecision.reason?` 由 `src/main/businessEventProgram/emissionAdapter.ts` 原样复制到普通 `Signal`。当前策略的 reason 包含指标结果、显示文本、初始事实和延迟验证目标，主要是说明文本。
2. `src/main/asyncProgram/sellProcessor/index.ts` 的 `buildSellRetryKey()` 确实包含 `signal.reason`，但 key 同时包含 action、symbol、seatVersion、quantity、orderTypeOverride、protective 标记、related buy order IDs 和 `triggerTime`；不能把它描述成“只靠 reason 去重”。
3. `cloneSellSignal()` 保留 reason、triggerTime 和相关订单 ID。`emissionAdapter` 还对同一 origin/action 做重复保护；同 origin/action 的重复输出不是由 retry key 兜底。
4. reason 不是清仓授权，也不决定数量；清仓类型和执行权限仍由宿主白名单、专用路径和执行门禁控制。

运行路径确实包含：

```text
策略 decision.reason
  → emissionAdapter
  → Signal.reason
  → buildSellRetryKey 的一个维度
  → retryStates Map
  → 缺行情时定时重入队
```

#### 影响判定与字段语义

当前策略的稳定 reason、时间和动作组合使复核没有证明已经发生 retry 漂移、错误合并或错误订单。展示文本和执行状态存在语义耦合风险，但不能把风险写成已发生的交易故障，也不能仅凭此删除 reason。

字段语义应在文档和类型注释中写清楚：

- `StrategySeatFact.hasFilledBuyOrders` 是首次评估时宿主从当前 `OrderRecorder` 保留的、尚未被卖出覆盖的 BUY 记录投影出的资格事实；它不是持仓、历史成交总表或 pending BUY。延迟 SELL 保存 origin 资格，回流时不重查该初始条件；当前 route/gate、持仓、行情和执行门禁仍会重新约束执行。
- `StrategyDecision.triggerTimeMs` 对立即 decision 是该动作评估时读取的 `now`；对延迟 decision 是 `Date(now + delaySeconds * 1000)` 归一化后的验证目标 T0。它不是首次评估时间，也不是 timer callback 时间；验证目标后 10 秒才执行验证回调，字段语义不能因此改写。
- `reason` 是可选展示说明，不能授权清仓、决定数量、改变普通/保护性分类或隐式成为策略权限。

这些语义当前运行正确；本轮只要求把它们写清楚，不借文档改动当前时间或延迟 SELL 资格语义。

#### 可选后续方向（先决策，后实现）

不要现在扩展公共 `StrategyDecision` 增加 `executionIdentity`，也不要只删除 `reason`。先由业务明确每次获准 emission 是：

- **独立执行任务**：每个获准 emission 都有独立宿主任务边界，retry envelope 保留该任务的稳定身份、时间和业务事实；或
- **业务等价合并**：明确哪些字段代表同一业务任务，再由宿主任务边界和 retry envelope 采用可证明的等价身份。

若后续选择实施，身份应由宿主任务边界定义并在 retry envelope 中保留，不能让策略自由文本承担身份；现有 triggerTime、route、相关买单等业务字段仍按实际语义保留。若没有该业务决策，本项只补充字段说明和固定现状测试，不改执行语义。

#### 可选验证

可在单独变更中验证 reason 不影响清仓授权/数量/执行分类、clone 保留时间和文本、同 origin/action 防重、缺行情 retry 的终止/跨日行为，以及所选独立或合并政策的 identity 测试。该项不阻断 KDJ 修复或第二策略 decision-to-queue 验收。

---

### STRAT-004：第二策略没有完成真实 decision-to-queue 的替换性回归

**状态**：confirmed verification gap / P2；补齐前不能宣称当前普通协议内的策略替换已验证

#### 证据与运行路径

- `tests/app/startup/prepareStrategy.test.ts:366-426` 已创建临时 `newSchema/definition.ts`，验证真实静态 JSON、prepare、create、destroy 和选中模块隔离；但该策略的 `onCandlestick()` 固定返回 `null`，没有发出 `StrategyDecision`。
- `tests/build/productionBuild.test.ts:83-139` 验证真实 `clean + tsc`、相邻 JSON、增删策略、dist 加载和 selected prepare 失败；测试 helper 生成的新增策略 `create()` 故意抛出 `create must remain deferred`，因此它不验证 dist 产物的实际实例运行。
- `tests/main/businessEventProgram/fixtures.ts` 已有无指标的 `event-test` 宿主事件 fixture；`emissionAdapter.test.ts` 已覆盖四动作和延迟 SELL 回流，`tests/main/businessEventProgram/strategyIntegration.test.ts` 与 `tests/integration/delayedStrategySell.integration.test.ts` 已覆盖当前策略的真实 pending/SELL 协议。缺口不是从零没有组合测试，而是没有**不同私有 schema/实现**完成 `prepare → create → onCandlestick → emit → adapter → queue`。
- `tests/core/strategy/intradayRegression/config.test.ts` 已断言正式 profile（四个 signal 的 D/J、BUY D/ADX、SELL K）；fixture 的全指标 profile 是数学覆盖用途，不应被当成生产配置缺失。

#### 影响判定

这不是生产 loader 已经错误的证据，也不是已有 loader/build 测试失效。`ACTIVE_STRATEGY_ID → prepareStrategy → definition/config → createSelectedStrategy` 的实现链路当前没有被证明有缺陷，构建测试也已经覆盖 JSON 资产、增删策略和 selected prepare 失败。

缺口在于回归测试只证明了“可以加载/准备”或“可以创建并销毁”，没有证明策略替换真正跨过了宿主最容易重新耦合的边界：

```text
second strategy
  → create
  → onCandlestick
  → emit decision
  → validateDecision / emissionAdapter
  → STRATEGY_* queue
```

如果未来宿主重新读取 `intradayRegression` 的私有 profile、假设特定动作或依赖特定 lifecycle side effect，现有测试可能仍然通过。

#### 最小修复方向

增加一个仅存在于测试 fixture 的第二策略，要求：

- 使用与 `intradayRegression` 不同的私有配置 schema 或最小配置；只实现公共 `TradingSignalStrategy` port，不 import 当前策略私有模块。
- `onCandlestick()` 在可控输入下发出一个普通 BUY 或 SELL decision，并返回最小显示投影；`invalidate*`、`resetForTradingDay`、`destroy` 可使用 no-op，验证宿主不依赖 pending/timer/indicator 私有能力。
- 让 fixture 通过 `prepareStrategy → createSelectedStrategy → businessEventProgram → emissionAdapter → STRATEGY_* queue`，断言只调用选中策略一次、decision 被正确校验并进入对应 queue；不得用直接调用 adapter 代替完整组合。
- source 与 dist 各做一次最小真实 `create → onCandlestick → emit → adapter → queue` smoke 即足够，不重复两套完整业务流程；不连接真实 Broker、不运行真实交易入口。
- 保留现有 loader/build 的 JSON 资产、增删策略、未选项隔离和 prepare 失败断言。fixture 的全指标 profile 继续作为数学覆盖，不把它误报为正式配置缺测；正式 profile 断言已存在，若改动应只做命名/边界补强。

#### 必须验证

- 第二策略 source 和 dist 均能完成最小真实 `create → onCandlestick → emit → adapter → queue`，并断言对应 BUY/SELL queue 的任务内容。
- 第二策略使用不同私有 schema、没有 `EMA/KDJ/MFI` 等当前策略私有类型时，宿主仍能创建和处理 decision；不需要修改中心注册表，未选策略仍不被 import/prepare/create。
- 组合测试不引入 Broker、生产凭据或真实交易入口；构建测试继续验证 JSON 资产和失败清理。

## 5. 已复核但当前不应作为生产缺陷修复的问题

### 5.1 `hasFilledBuyOrders` 不是把 `OrderRecorder` 泄漏给策略

完整链路为：

```text
OrderRecorder 终态成交记录
  → getBuyOrdersForSymbol()
  → businessEventProgram 只投影为 boolean
  → StrategySeatFact.hasFilledBuyOrders
  → 当前策略首次 SELL 资格判断
```

证据：`src/core/trader/orderMonitor/settlementFlow.ts:621-668,691-744`、`src/core/orderRecorder/index.ts:356-361`、`src/main/businessEventProgram/index.ts:46-87`、`src/core/strategy/intradayRegression/index.ts:31-55`。

策略拿不到 `OrderRecorder`、订单列表、持仓对象或写能力；它只读取一个宿主事实投影。当前 SELL 规则要求候选首次评估时存在已成交 BUY 事实，属于稳定业务门禁，不应因为字段名称含有订单语义就改成通用持仓接口。

延迟候选保存 origin 事实并在验证通过时使用原 emitter（`src/core/strategy/intradayRegression/verification/index.ts:83-107`），是为了避免保护性清仓提交后本地 BUY 记录被清理而误杀已经合法产生的 delayed SELL。重新读取当前 BUY 记录反而会改变既有交易语义。

需要做的是字段级语义说明，不是开放订单记录给策略，也不是在 delayed 回流时重新检查 BUY 资格；这不改变当前 origin 资格协议。

### 5.2 策略拥有 pending/timer 与生命周期方法不是错误耦合

`src/core/strategy/types.ts:109-133` 要求完整的 `TradingSignalStrategy` lifecycle port，`src/core/strategy/intradayRegression/index.ts:121-127,201-216` 在策略内部维护 pending/timer 并响应 invalidate/reset/destroy。这符合“延迟验证状态归策略所有”的第一性原则。

独立复核未发现 seat cleanup、time wakeup、midnight reset、shutdown 或 fatal 链路中存在已确认的顺序错误：

- seat cleanup 先 `invalidateDirection` 再清风险和方向队列；
- gate 关闭和末日接管先 `invalidateAll`；
- 午夜先停止/排空业务 owner，再 `resetForTradingDay`；
- shutdown 先关 admission、撤销 pending，cleanup 后才 destroy；
- timer/emitter/cancel 异常进入统一 fatal 链路。

可选维护是 STRAT-002 的局部类型收窄，不是删除生命周期端口、把 pending 提升到宿主，或为无状态策略增加兼容层；本轮不把它作为阻断项。

### 5.3 四种 action、LONG/SHORT、席位和一分钟行情是当前公共业务协议

证据：`src/core/strategy/types.ts:78-80`、`src/types/signal.ts:7-28`、`src/main/businessEventProgram/emissionAdapter.ts:24-26,73-75`。

它们确实限制了“任意语义策略插件”，但在当前系统目标中是普通交易协议，而非当前策略私有实现泄漏。只要产品目标仍是同一股票/指数席位和普通买卖执行模型，不应把它们列为必须修复的耦合。

如果未来要接入组合权重、目标仓位、跨标的篮子或非四动作策略，应另立中性 portfolio/intent 协议与 adapter；不能通过给现有 `StrategyDecision` 添加零散可选字段来兼容两套语义。

### 5.4 `triggerTimeMs` 当前时间语义不改，只补字段说明

`src/core/strategy/intradayRegression/index.ts:54-106` 对立即 decision 使用该动作评估时的 `now`；对 delayed decision 使用 `Date(now + delaySeconds * 1000)` 的归一化目标 T0。验证目标后 10 秒才运行 callback/验证，`src/main/businessEventProgram/emissionAdapter.ts:69` 仍将 `triggerTimeMs` 转成 Signal 的触发时间。

因此 `triggerTimeMs` 不是延迟候选的首次评估时间，也不是 callback 时间；不能把当前时间语义改成首次评估或 callback 时刻。只在 STRAT-003 的文档/字段注释中写清楚，不改实现。

### 5.5 EMA:250 与 200 根缓存是能力风险，不是当前已触发的死锁

证据：`src/constants/index.ts:62-68` 将缓存上限设为 200；EMA 支持范围和 seed 逻辑见 `src/core/strategy/intradayRegression/indicatorHelpers/utils.ts:139-147`、`src/core/strategy/intradayRegression/runtime/utils.ts:72-81`。

`EMA:250` 冷启动时确实没有足够历史，不能立即 ready；但在持续接收约 50 根有效 K 线后可以成熟，并非永远无法计算；reset/rebuild 会按当前设计重置并重新预热。当前正式 `config.json` 没有 EMA，使用的是 MFI/KDJ/ADX、RSI:6 和 K/D/J verification，因此当前生产配置没有触发该能力缺口。

若产品将“任意支持周期都必须冷启动 ready”定义为硬合同，应另行把历史窗口改为“最大声明周期 + 活动柱”或建立显式历史能力协商；在该业务决定明确前，不应为了一个未启用周期改动 cache 上限。

### 5.6 loader、build 和 source/dist 资产链路没有确认实现缺陷

`src/index.ts:12-15 → src/app/runApp.ts:116 → src/app/startup/prepareStrategy.ts:43-67 → strategyLoaderHelpers.ts:69-138` 的加载链路对 ID、路径、definition 导出、config 和 prepare 做了运行时校验。

`package.json:7-14` 的正式构建为 clean + tsc；`tests/build/productionBuild.test.ts` 已覆盖 JSON 语义同步、JSON-only 重建、新增/删除策略、未选坏配置隔离、selected prepare 失败、source 移走后 dist 加载和缺 JSON 失败。

本次没有证据要求修改 loader/build。需要补的是 STRAT-004 的“dist 产物实例实际输出 decision”验证，而不是给 loader 加中央策略注册表、fallback 或兼容层。

### 5.7 默认全指标 fixture 是测试表达问题，不是正式策略配置错误

`tests/core/strategy/intradayRegression/fixtures.ts:20-61` 的默认 fixture 主动启用 MFI/KDJ/MACD/ADX、RSI/EMA/PSY，并被数学/runtime 覆盖使用；正式策略通过 `config.json` 解析，配置并不继承该 fixture。

它会误导审查者把数学全覆盖误读成生产画像，但不能证明生产策略实际启用了 EMA；`tests/core/strategy/intradayRegression/config.test.ts` 已有正式 profile 断言。若后续改动，只需补清 fixture 命名或边界表达，不应修改正式策略配置来迎合测试 fixture。

## 6. 未确认/不纳入本次问题清单

- `RuntimeScheduler.scheduleTimer()` 的“callback 必须异步执行”前提（`src/types/runtime.ts:17-20`）目前只在生产实现使用原生 `setTimeout`，未证明存在生产故障；可补 JSDoc 和 scheduler contract test，但暂不定性为已确认交易缺陷。
- Broker 实际执行、生产凭据、真实部署和单进程发布未在本次静态复核中验证；本文不把静态证据写成生产发布通过。
- 不遵守完整 `TradingSignalStrategy` port 的动态 JS 策略不纳入；当前 loader/TypeScript 运行时契约要求完整方法是有意的 fail-fast 行为。

## 7. 修复后验收门禁与命令

### 7.1 必修门禁

1. 已确认的“本轮 KDJ 不可用”政策必须完整接线：当前 H/L/C 坏柱时 K/D/J 不进入 snapshot、display、signal 有效值或 verification sample value；旧 KDJ 不得冒充当前轮；这不是只做 guard 的验收。
2. KDJ H/L/C 原子校验、数学状态不变、后续有效序列 golden、active preview/confirmed/shift/bootstrap 可用性传播和 verification 消费者回归均通过；测试同时证明缺 `open` 不会被误拒绝，且不改变 MFI 等其他指标政策。
3. N-of-M 缺值语义、延迟 initial KDJ gate、既有 pending/sample/timer 语义和正式 profile（四个 D/J signal、BUY `D`/`ADX`、SELL `K`）回归通过；不新增全动作禁令、不回退立即、不自动取消 pending、不补样本/延长 timer/fatal。
4. 第二策略 source/dist 均完成最小真实 `create → onCandlestick → emit → adapter → queue`；现有 loader/build、当前策略 pending/SELL 和正式 profile 回归继续通过。
5. 按 `package.json` 已确认的真实脚本执行 `bun lint`、`bun type-check`、受影响测试和 `bun run build`；实际改动 TypeScript 时按项目规范先执行 `bun format`。
6. 验收报告明确区分：当前四动作/席位/一分钟协议内的可替换性、任意策略语义插件能力，以及真实 Broker/部署验证。

### 7.2 明确不作为本次门禁

- STRAT-002 的 `signalRuntimeDomain` 局部 `Pick` 是可选维护；`timeWakeup` 的末日保护 projection 不在本次改动。
- STRAT-003 的 retry identity 只有在业务先决定“独立任务还是业务等价合并”后才实施；不能因为本计划而添加 `executionIdentity`、删除 reason 或改 key 语义。
- 不因坏柱状态不变就假称交易语义已经正确；不擅自 fatal、取消 pending、补样本、延长 timer 或全面禁交易。

本轮文档提交本身未运行上述测试、type-check、lint 或 build；前轮只完成了直接生产 KDJ 函数的数值污染复现，无落库、无 Broker。实现和验收仍待后续代码变更，不得把本文当作代码已修复。

**最终判断**：当前架构的核心所有权方向是正确的，不能把所有公共交易协议都误报为策略耦合；P1 是已确认但尚未实现/验收的 KDJ 输入污染与本轮可用性传播，P2 是第二策略 decision-to-queue 验证缺口，P3 是局部生命周期类型维护和待决策的 retry 身份治理。原问题与待实施方案已互相链接，不能把计划当作已实施报告。
