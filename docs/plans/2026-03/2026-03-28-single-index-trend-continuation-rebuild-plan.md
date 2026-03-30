# 单指数日内趋势延续独立版本重构方案

## 1. 文档目的

这次重构不再只是“把策略从均值回归改成趋势延续”，而是同时把程序本身改造成：

1. 单指数。
2. 单实例。
3. 单配置入口。
4. 趋势延续专用。
5. 独立版本，不与旧多标的程序兼容并行。

因此，本方案同时覆盖：

1. 策略重构。
2. 程序形态重构。
3. 配置模型重构。
4. 无用功能删除与代码简化。

---

## 2. 新增需求的影响分析

## 2.1 从“多监控程序”变为“单指数程序”

新增需求的本质不是“把 monitor 数量改成 1”，而是：

1. 程序只服务于唯一的大盘指数场景。
2. 该指数不再作为运行期外部配置项存在。
3. 所有 `MultiMonitor` 形态的抽象都失去存在价值。

这意味着必须删除而不是保留开关：

1. `MultiMonitorTradingConfig`
2. `monitors[]`
3. `monitorContexts Map`
4. 以 `monitorSymbol` 为键的运行时状态分发
5. `_1 / _2 / _3` 形式的配置后缀
6. “扫描 monitor 配置并校验索引连续性”的启动逻辑

## 2.2 从“通用量化程序”变为“趋势延续专用程序”

这次重构不再追求“以后也许还能支持别的标的或别的策略”。

因此必须删除而不是兼容保留：

1. 均值回归主线。
2. 旧摆动指标条件系统。
3. 旧异步延迟验证。
4. 面向多监控场景的通用批量装配逻辑。
5. 与旧策略强耦合、但不再适合新版本的策略性卖出分支。

## 2.3 对配置的直接影响

此次需求变化后，配置层应遵循两个原则：

1. 只保留对“单指数趋势延续程序”有直接业务意义的配置。
2. 所有“因多监控、多策略、旧条件组而存在的配置”全部删除。

因此：

1. 不再配置监控标的。
2. 不再支持 `_1 / _2` 等索引后缀。
3. 不再保留 `signalConfig` 与 `verificationConfig`。
4. 不再保留多 monitor 之间的重复校验与重复日志展示。

这里“不再配置监控标的”的准确含义是：

1. 新版本只服务于唯一固定的基础对象。
2. 该基础对象由程序内部 preset 固定提供。
3. 启动时不再通过环境变量、配置文件或外部参数显式传入该对象代码。

## 2.4 对命名的直接影响

由于该版本是专用程序，但代码与文件命名又不希望过于直白，因此命名应采用中性术语。

推荐统一使用：

1. `baseInstrument` 或 `primaryInstrument` 指代唯一基础监控对象。
2. `strategyRuntime` 指代单实例运行时。
3. `longSeat / shortSeat` 指代执行方向席位。
4. `benchmarkPrice` 或 `referencePrice` 指代基础对象价格。

不建议在代码、目录、文件名中继续扩散：

1. `HSI`
2. `hangseng`

研究来源、历史文档标题与外部论文标题除外。

---

## 3. 最终范围定义

本次重构后的程序固定为：

1. 单一基础指数监控对象。
2. 单一趋势延续主策略。
3. 双方向执行席位。
4. 同时支持静态标的模式与自动寻标模式。
5. 单一配置根对象。
6. 单实例运行时。

以下内容直接移出主线：

1. 多监控对象支持。
2. 监控标的运行期配置。
3. 多 monitor 上下文批量装配。
4. 字符串条件组信号系统。
5. 旧异步延迟验证。
6. 均值回归开仓逻辑。
7. 与旧分批均值回归持仓模式强耦合的智能平仓三阶段逻辑。

保留的内容只限于：

1. 下单执行基础设施。
2. 订单监控与恢复基础设施。
3. 风险控制基础设施。
4. 双席位执行模型。
5. 静态标的模式。
6. 自动寻标与换标基础设施。
7. 保护性清仓、末日保护、交易日生命周期。

---

## 4. 程序形态的最终结论

## 4.1 单实例运行时

重构后的程序不再围绕 `monitorSymbol -> MonitorContext` 组织，而改为单实例运行时：

```text
TradingConfig
-> StrategyRuntime
-> Base Instrument Data Runtime
-> Factor Runtime
-> Signal Planner
-> LongSeat / ShortSeat
-> Execution / Risk / Lifecycle
```

### 4.2 固定基础对象的来源

基础对象不是配置项，也不是运行时入参。

必须固定为：

1. 单一内部 preset。
2. 单一代码入口。
3. 单一数据订阅源。

禁止：

1. 在多个模块硬编码同一个基础对象代码。
2. 通过环境变量重新引入“隐式 monitor 配置”。
3. 在静态模式与自动寻标模式下分别维护不同的基础对象来源。

### 4.3 需要从架构上删除的多实例结构

以下结构应整体删除：

1. `createMultiMonitorTradingConfig`
2. `createMonitorContexts`
3. `monitorContexts: Map<string, MonitorContext>`
4. `lastState.monitorStates: Map<string, MonitorState>`
5. 以 `monitorSymbol` 为队列分流键的批量设计

### 4.4 需要替换成单实例版本的结构

| 旧结构                                     | 新结构                    |
| ------------------------------------------ | ------------------------- |
| `MultiMonitorTradingConfig`                | `TradingConfig`           |
| `MonitorConfig`                            | `StrategyConfig`          |
| `monitorContexts`                          | `strategyRuntime`         |
| `MonitorState`                             | `StrategyState`           |
| `createMonitorContexts()`                  | `createStrategyRuntime()` |
| `SymbolRegistry(monitorSymbol, direction)` | `SeatRegistry(direction)` |

补充约束：

1. 单实例重构不改席位生命周期状态机语义，继续沿用现有 `EMPTY / SEARCHING / SWITCHING / ACTIVATING / ACTIVE`。
2. 文档中的“可交易席位”“已就绪席位”统一指代码状态 `ACTIVE`，不是新增 `READY` 状态。
3. `ACTIVATING` 继续保留为激活屏障阶段：席位已绑定新标的，但 admission、行情与风险缓存初始化尚未完成，不能生成或执行交易信号。

### 4.5 双席位仍然是核心结构

单实例不等于单方向。

本方案明确保留：

1. `longSeat`
2. `shortSeat`
3. 双方向持仓、风控、冷却、订单记录与席位版本

被删除的只是：

1. monitor 维度。
2. 多实例 monitor 分发层。

因此键空间收敛原则应改为：

1. 能直接升为程序级单例的，收敛为 `program-global`。
2. 能仅用 `direction` 表达的，不再保留 `monitorSymbol`。
3. 与当前或历史交易标的、订单链路、换标状态直接相关的，继续保留 `symbol` / `orderId` 维度。

不再继续保留的只是：

1. `monitorSymbol + direction` 这种为多 monitor 分发服务的默认主键。

### 4.6 静态标的与自动寻标同时支持

新版本仍然支持两种交易标的模式，但这两种模式只是在 `SeatRegistry` 初始化与更新路径上分叉，不影响上层因子与信号架构。

#### 静态标的模式

1. 启动时直接绑定 `longSeat / shortSeat` 的静态交易标的。
2. 之后不经过自动寻标与换标状态机。

#### 自动寻标模式

1. 启动时允许席位为空。
2. 通过现有候选筛选、距离换标、周期换标机制维护 `longSeat / shortSeat`。

约束：

1. 同一运行实例只选择一种席位模式，不在运行期动态切换。
2. 无论哪种模式，基础对象与上层因子完全相同。

### 4.7 对队列与处理器的影响

对买卖与监控任务队列，原则是“能去掉 monitor 维度就去掉 monitor 维度”。

因此：

1. 单实例版本的任务数据不再需要 `monitorSymbol` 字段作为业务主键。
2. 仅保留方向、席位版本、交易标的、时间戳等真正必要字段。
3. 队列、日志与恢复流程里的“按监控标的分组”逻辑应全部删除。

---

## 5. 最终策略架构

新程序固定为以下主链路：

```text
基础对象 1m / 5m / 15m K线 + 成交量 + session 信息
-> Primitive Metrics
-> Volatility Regime
-> Trend Classification
-> Structure Detection
-> Confirmation
-> Signal Planner
-> Instrument Adaptation Gate (entry only)
-> BUYCALL / SELLCALL / BUYPUT / SELLPUT
-> Execution / Risk / Lifecycle
```

## 5.1 各层职责

| 层级 | 输出 | 责任 |
| --- | --- | --- |
| Primitive Metrics | EMA / MACD / ATR / RV / VWAP 原始统计 | 提供高层因子原料 |
| Volatility Regime | `contracting / normal / expanding / extreme` | 判断是否值得做趋势单 |
| Trend Classification | `trend_up / trend_down / range` | 给方向，不给波动率 |
| Structure Detection | OR、午前推进、午后续推、结构评分 | 判断趋势推进窗口 |
| Confirmation | VWAP 同侧、ER、EMA/MACD、一致性 | 拦截低质量结构 |
| Signal Planner | 开平仓意图与理由 | 直接产出信号 |
| Instrument Adaptation Gate | 开仓载体适配结果 | 只决定是否允许 `BUYCALL / BUYPUT` 执行 |

## 5.2 为什么交易标的不参与 alpha

需求已经明确：策略以监控对象因子为主，交易标的与策略无关。

因此职责必须拆开：

1. 基础对象决定市场方向与状态。
2. 交易标的只决定“当前这个执行载体是否适合承接该方向”。
3. 若交易标的不适配，则放弃对应方向的新开仓，不允许反向污染因子结论。

---

## 6. 因子体系的最终定义

## 6.1 Session 模型

程序必须是 `session-aware`。

固定 session：

1. `09:30-12:00`
2. `13:00-16:00`
3. 半日市视为仅上午 session

固定噪音窗口：

1. `09:30-09:50` 只建结构，不开新趋势仓
2. `13:00-13:15` 只观察午后重估，不直接承接上午末尾信号

### 6.1.1 时间门禁分层

这三个时间机制保留，但职责必须严格分层，不能混用：

1. `Strategy Noise Windows` 只负责拦截新的趋势信号，不负责风险任务、保护性清仓、末日清仓、自动寻标或距离换标。
2. `OPEN_PROTECTION` 是程序级运行时门禁，只负责暂停策略信号生成，并继续拦截周期换标；它不阻断自动寻标、距离换标、浮亏监控、静态标的距回收价清仓和其他风险任务。
3. `autoSearchOpenDelayMinutes` 只作用于早盘空席位自动寻标，不影响策略信号、午盘、风险任务和卖出链路。

### 6.1.2 因子就绪与预热契约

1. `FactorRuntime` 每个处理时点都必须输出 `FactorSnapshot`，但 snapshot 必须显式携带 readiness；`not-ready` 是合法状态，不允许隐式补齐。
2. 任一强制因子未就绪时，`Signal Planner` 不得生成策略性开平仓信号；只能输出 `HOLD / no-op`，不能临时降级窗口。
3. `MOM_15 / MOM_30 / MOM_60` 与 `ER_15 / ER_30` 只使用当前交易日连续交易时段数据，不拼接上一交易日，也不跨午休把非交易时间当成可用样本。
4. 因 `MOM_60` 是趋势分类的强制窗口，早盘趋势开仓最早从 `10:30` 开始；`09:50-10:29` 只更新结构、确认与 readiness，不做新的趋势开仓。
5. 启动与开盘重建必须预热两类数据：当前交易日的分时样本，用于恢复 `MOM / ER / ATR / VWAP / OR` 状态；过去 `20` 个交易日的同 session 波动率基线，用于 `VolQuantile`。
6. 若预热不完整，程序不得通过“借前一日数据”或“临时降级为 15m/30m 模式”来伪造 readiness；策略运行时保持 not-ready，直到必需数据恢复完成。

## 6.2 波动率 Regime

输出：

1. `contracting`
2. `normal`
3. `expanding`
4. `extreme`

输入建议：

1. `RV_5 / RV_30 / RV_60`
2. `ATR_short / ATR_long`
3. session 内历史分位数

用法：

1. `normal / expanding` 才允许趋势开仓。
2. `contracting` 不开新趋势仓。
3. `extreme` 不追击。

## 6.3 趋势分类

核心采用多窗口时间序列动量一致性。

建议定义：

1. `MOM_15 = ln(P_t / P_{t-15m})`
2. `MOM_30 = ln(P_t / P_{t-30m})`
3. `MOM_60 = ln(P_t / P_{t-60m})`
4. `zMOM_h = MOM_h / sqrt(RV_h + ε)`
5. `TrendScore = w15 * zMOM_15 + w30 * zMOM_30 + w60 * zMOM_60`

分类规则：

1. 至少 `2/3` 窗口同号。
2. `|TrendScore|` 达阈值。
3. 满足则输出 `trend_up` 或 `trend_down`，否则输出 `range`。
4. 当前版本不提供早盘 `15m/30m` 临时替代 `15m/30m/60m` 的降级分类器。

## 6.4 推进效率 ER

方向与质量必须分离。

建议定义：

`ER_n = |P_t - P_{t-n}| / Σ|P_i - P_{i-1}|`

用法：

1. `TrendScore` 解决方向。
2. `ER` 解决推进是否顺畅。
3. `TrendScore` 高但 `ER` 低，视为噪音趋势，不开仓。

## 6.5 Session VWAP

`VWAP` 在本方案中是趋势确认锚，不是回归中心。

必须维护：

1. `VWAP_am`
2. `VWAP_pm`
3. `VWAP_day`
4. `activeSessionVWAP`
5. `activeSessionVWAPSlope`

开仓要求：

1. 做多时价格在 `activeSessionVWAP` 上方，且斜率不走坏。
2. 做空时价格在 `activeSessionVWAP` 下方，且斜率不走坏。
3. `VWAP` 附近来回穿越时不开趋势仓。

## 6.6 Opening Structure

OR 只保留为结构层。

固定口径：

1. `09:30-09:50` 建立 `orHigh / orLow`
2. `09:50` 之后才允许把 OR 用作结构参考
3. 关注 `outsidePersistence / retestHold / failedBreakout`

## 6.7 午后延续因子

午后不是上午的机械续写，必须单独建因子。

建议定义：

1. `R_am`
2. `MiddayHold`
3. `R_pm_start`
4. `PMConfirm`

只有当：

1. 上午方向清晰，
2. 午休后未破坏结构，
3. 午后前段重新同向推进，

才允许做第二段趋势延续。

## 6.8 EMA / MACD 的最终位置

`EMA / MACD` 保留，但只作为确认器。

它们的职责只有两个：

1. 避免高层趋势与低阶结构冲突。
2. 为 `Signal Planner` 提供附加否决或加分理由。

补充边界：

1. `futures lead-lag / basis` 不并入当前阶段 2 的现货内核。
2. 原因不是它们不重要，而是它们依赖稳定的 `HSIF` 实时/历史数据、session 对齐和主连/换月规则。
3. 在数据栈未补齐时强行纳入，只会把数据缺陷误当成策略噪音，破坏当前 `spot-first` 版本闭环。
4. 因此这组因子与 `HSIF` 数据接入共同进入下一阶段实施；若后续期权数据也补齐，可共享同一衍生品数据建设阶段，但不是这两个因子的前置条件。

## 6.9 首版默认参数落值

以下数值作为 **阶段 1 / 阶段 2 的首版默认值** 直接写入方案，不再保留“后续再猜”的空白配置。

口径约束：

1. 能直接被研究支持的，直接采用研究支持的量级。
2. 研究只支持方向、不直接给 cutoff 的，采用最短路径工程外推，但必须与现有业务风控口径闭合。
3. 这些值是 **首版默认值**，不是回放后再调优的结果；后续只能通过 `12.4` 的 replay / walk-forward / 消融去调整。

证据等级：

1. `A`：权威研究或官方资料直接支持该窗口、结构或制度事实。
2. `B`：权威研究直接支持机制与方向，但 **不直接给出同一 exact cutoff**；文档中的具体值属于研究约束下的工程默认值。
3. `C`：属于现有业务风控或执行约束，外部官方资料只支持产品风险事实，不直接给出同一 exact cutoff。

最终复核结论：

1. 当前文档中的数值可以作为 **可用且合理的首版默认值**。
2. 但不能把全部 exact cutoff 都表述为“主流且已被研究直接验证的共识值”。
3. 真正满足 `A` 级标准的，主要是 session 时段、香港开盘前 `20` 分钟异常、`30m/60m` 日内动量窗口、开盘信息对尾盘延续的预测、CBBC 的 MCE 风险与 CTS 交易时段。
4. 其余大部分 exact cutoff 仍应被视为 `B/C` 级默认值，而不是学术文献里的直接结论。

### 6.9.1 `REGIME_THRESHOLDS`

证据等级：`B`

| 字段                   | 默认值 | 说明                                       |
| ---------------------- | ------ | ------------------------------------------ |
| `atrShortPeriod`       | `5`    | `ATR_short = ATR(5)`                       |
| `atrLongPeriod`        | `30`   | `ATR_long = ATR(30)`                       |
| `rvQuantileWindowDays` | `20`   | 与过去 `20` 个交易日同 session 时段比较    |
| `trendOnVolExpansion`  | `1.20` | `VolExpansion > 1.20` 视为进入趋势可交易区 |
| `trendOffVolExpansion` | `0.90` | `VolExpansion < 0.90` 视为收缩             |
| `extremeVolExpansion`  | `1.80` | 极端扩张，不追击                           |
| `trendOnVolQuantile`   | `0.70` | `VolQuantile > 0.70` 允许趋势开仓          |
| `trendOffVolQuantile`  | `0.40` | `VolQuantile < 0.40` 视为收缩              |
| `extremeVolQuantile`   | `0.95` | `VolQuantile >= 0.95` 视为极端波动         |

分类规则固定为：

1. `extreme`：`VolExpansion >= 1.80` 或 `VolQuantile >= 0.95`
2. `contracting`：`VolExpansion < 0.90` 且 `VolQuantile < 0.40`
3. `expanding`：`VolExpansion > 1.20` 且 `VolQuantile > 0.70`
4. 其余为 `normal`

### 6.9.2 `TREND_SCORE_THRESHOLDS`

证据等级：`B`

| 字段                           | 默认值 | 说明                                       |
| ------------------------------ | ------ | ------------------------------------------ |
| `w15`                          | `0.25` | 15m 保留为短期再加速确认，不主导方向       |
| `w30`                          | `0.35` | 30m 对应最稳定的日内早段动量窗口           |
| `w60`                          | `0.40` | 60m 给更高权重，避免被微结构噪音主导       |
| `classificationThreshold`      | `0.80` | 趋势分类阈值                               |
| `entryThreshold`               | `0.90` | 开仓阈值                                   |
| `exitThreshold`                | `0.35` | 趋势衰减退出阈值                           |
| `reverseInvalidationThreshold` | `0.50` | 若反向 `TrendScore` 超过该值，视为方向失效 |

固定规则：

1. 先要求 `MOM_15 / MOM_30 / MOM_60` 至少 `2/3` 同号。
2. `|TrendScore| >= 0.80` 才允许输出 `trend_up / trend_down`。
3. `|TrendScore| >= 0.90` 才允许进入 `Signal Planner` 开仓。
4. `|TrendScore| < 0.35` 视为趋势衰减退出。
5. 若 `TrendScore` 反向且 `|TrendScore| >= 0.50`，直接按趋势失效处理。

### 6.9.3 `ER_THRESHOLDS`

证据等级：`B`

| 字段                 | 默认值 | 说明                                   |
| -------------------- | ------ | -------------------------------------- |
| `er15EntryMin`       | `0.40` | 15m 推进必须明显高于噪音               |
| `er30EntryMin`       | `0.35` | 30m 允许略低于 15m，但仍需保持趋势性   |
| `er15ExitMax`        | `0.25` | 15m 明显衰减                           |
| `er30ExitMax`        | `0.20` | 30m 明显衰减                           |
| `strongTrendErFloor` | `0.45` | 作为“高质量推进段”标签，不单独触发交易 |

固定规则：

1. 开仓要求 `ER_15 >= 0.40` 且 `ER_30 >= 0.35`。
2. 若 `ER_15 < 0.25` 或 `ER_30 < 0.20`，视为推进失真，允许退出。
3. 若 `ER_15 >= 0.45` 且 `ER_30 >= 0.45`，可在日志中标记为 `strong_trend_leg`。

### 6.9.4 `VWAP_CONFIRM_RULES`

证据等级：`B`

| 字段                   | 默认值 | 说明                                                 |
| ---------------------- | ------ | ---------------------------------------------------- | ------------------------- | -------------------------------------- |
| `distanceBandAtr`      | `0.10` | `                                                    | Price - activeSessionVWAP | < 0.10 \* ATR_15` 视为贴近 VWAP 噪音带 |
| `slopeWindowBars`      | `5`    | 用最近 `5` 根 `1m` bar 估计 `activeSessionVWAPSlope` |
| `maxCrossCountLast10m` | `2`    | 最近 `10` 分钟穿越 VWAP 超过 `2` 次视为震荡          |

固定规则：

1. 做多要求 `Price >= activeSessionVWAP + 0.10 * ATR_15`。
2. 做空要求 `Price <= activeSessionVWAP - 0.10 * ATR_15`。
3. 做多要求 `activeSessionVWAPSlope > 0`；做空要求 `< 0`。
4. 最近 `10` 分钟跨越 VWAP 次数 `> 2` 时，不开趋势仓。

### 6.9.5 `OPENING_STRUCTURE_RULES`

证据等级：`A/B`

| 字段                           | 默认值 | 说明                                   |
| ------------------------------ | ------ | -------------------------------------- |
| `orWindowMinutes`              | `20`   | 香港开盘前 `20` 分钟只建结构，不追趋势 |
| `breakoutScoreMin`             | `0.80` | `BreakoutScore = distance / ATR_15`    |
| `outsidePersistenceWindowBars` | `5`    | 突破后的观察窗口                       |
| `outsidePersistenceMin`        | `0.60` | 区间外停留比例下限                     |
| `retestToleranceAtr`           | `0.20` | 回踩容忍带                             |
| `confirmBars`                  | `2`    | 需要至少 `2` 根 `1m` 同向确认 bar      |

固定规则：

1. `09:30-09:50` 只建立 `orHigh / orLow`。
2. `09:50` 后，只有当 `BreakoutScore >= 0.80`，且后续 `5` 根 `1m` bar 中至少 `3` 根留在区间外，才视为有效突破。
3. 回踩 `OR` 边界时，允许 `0.20 * ATR_15` 以内的容忍，不允许重新稳定回到区间内部。
4. 若突破后 `5` 分钟内出现 `2` 根 `1m` bar 重新收回区间，记为 `failedBreakout`。

### 6.9.6 `PM_CONTINUATION_RULES`

证据等级：`B`

| 字段                         | 默认值  | 说明                                 |
| ---------------------------- | ------- | ------------------------------------ |
| `amMoveZMin`                 | `0.80`  | 上午推进至少达到 `0.8 sigma`         |
| `middayHoldMin`              | `0.60`  | 午休后至少保留上午推进的 `60%`       |
| `pmReExpansionTrendScoreMin` | `0.90`  | 午后重新同向扩张的 `TrendScore` 下限 |
| `pmReExpansionEr15Min`       | `0.35`  | 午后重新推进时的最小效率要求         |
| `pmConfirmCutoffTime`        | `13:30` | 午后延续最早在 `13:30` 后确认        |

固定规则：

1. `R_am = ln(P_12:00 / P_09:50)`。
2. 上午只在 `|R_am| / sqrt(RV_am + ε) >= 0.80` 时，才认为“上午方向清晰”。
3. `MiddayHold` 固定定义为 `13:15` 时仍保留上午净推进的至少 `60%`。
4. 只有当 `13:15-13:30` 再次同向推进，且 `TrendScore >= 0.90`、`ER_15 >= 0.35`、价格位于 `VWAP_pm` 同侧时，才允许做午后第二段。

### 6.9.7 `INSTRUMENT_ADAPTATION_RULES`

证据等级：静态模式 `C`，自动寻标模式 `C`

这一组不属于 alpha 参数，而属于执行载体风险阈值。数值不以论文拟合，而以产品机制和现有业务风控口径闭合。

静态模式固定保留现有业务值：

| 字段                         | 默认值  |
| ---------------------------- | ------- |
| `bullBuyMinDistancePct`      | `0.35`  |
| `bearBuyMaxDistancePct`      | `-0.35` |
| `bullLiquidationDistancePct` | `0.30`  |
| `bearLiquidationDistancePct` | `-0.30` |

自动寻标模式首版默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoSearchOpenDelayMinutes` | `5` | 沿用现有开盘延迟口径 |
| `autoSearchPrimaryDistanceBull` | `0.80` | 比静态买入风控更保守，给换标留缓冲 |
| `autoSearchPrimaryDistanceBear` | `-0.80` | 镜像 |
| `switchDistanceRangeBull` | `0.60,1.50` | 低于 `0.60` 先换标，避免逼近 `0.30` 清仓线 |
| `switchDistanceRangeBear` | `-1.50,-0.60` | 镜像 |
| `autoSearchMinTurnoverPerMinuteBull` | `300000` | 首版只做高流动性候选 |
| `autoSearchMinTurnoverPerMinuteBear` | `300000` | 镜像 |
| `autoSearchExpiryMinMonths` | `6` | 首版默认避开过短寿命标的 |

约束：

1. 自动寻标的 `primaryThreshold` 必须严格落在 `switchDistanceRange` 内部。
2. `switchDistanceRange` 的危险侧必须先于静态风控阈值触发，不能等到 `0.35 / -0.35` 才换标。
3. 静态模式继续保留独立的距回收价清仓；自动模式继续由换标和保护性清仓共同覆盖。

---

## 7. 信号定义

## 7.1 开仓信号

`BUYCALL` 与 `BUYPUT` 对称。

### BUYCALL

同时满足以下条件：

1. 不在开盘或午后重估噪音窗口。
2. `Regime ∈ {normal, expanding}`。
3. `Trend Classification = trend_up`。
4. `TrendScore` 高于开仓阈值。
5. `ER_15` 与 `ER_30` 达标。
6. 价格位于 `activeSessionVWAP` 上方。
7. `VWAP slope > 0`。
8. OR 结构未显示 `failedBreakout`。
9. `EMA / MACD` 不逆向。
10. `Instrument Adaptation Gate = pass`。

### BUYPUT

完全镜像。

## 7.2 卖出信号

卖出不再采用旧摆动指标和平滑分阶段策略。

这里必须区分两类链路：

1. 策略性卖出：由趋势/结构失效触发，统一按方向全平。
2. 风险性清仓：保护性清仓、末日保护、静态标的距回收价清仓，继续保留独立触发与执行路径。

统一约束：

1. 所有 `SELLCALL / SELLPUT` 与风险性清仓都直接进入卖出执行链路。
2. 它们不经过 `Instrument Adaptation Gate` 的开仓适配否决。

### SELLCALL

满足任一条件即全量退出可用持仓：

1. 价格有效失守 `activeSessionVWAP`。
2. `TrendScore` 回落到退出阈值以下。
3. `ER` 明显衰减。
4. OR 或午后延续结构被破坏。

### SELLPUT

完全镜像。

### 风险性清仓路径

以下链路不并入 `Signal Planner` 的趋势退出条件，而继续保留独立语义：

1. 保护性清仓：保留独立触发、完成确认、冷却与亏损分段推进链路。
2. 末日保护：保留独立时间窗与全平语义。
3. 距回收价清仓：仅在静态标的模式保留独立 `LIQUIDATION_DISTANCE_CHECK` 路径；自动寻标模式下不再单独运行该链路，而继续由距离换标、保护性清仓、末日保护与买入风险门禁共同覆盖相关风险语义。

## 7.3 延迟验证的最终处理

旧异步 `delayed verification` 直接删除。

理由：

1. 新策略只在确认后的因子快照上生成开仓信号。
2. 旧延迟验证只是对同一趋势信息做二次滞后确认。
3. 这会拖慢入场并削弱日内趋势前段收益。
4. 对本方案而言，正确做法是把确认前置到 `Signal Planner`，而不是保留异步等待链路。

---

## 8. 交易标的适配层

该层只做 `entry tradability gate`，且只作用于 `BUYCALL / BUYPUT`。

输出建议：

1. `warrantTypeCheck`
2. `callPriceCheck`
3. `distanceCheck`
4. `finalTradability`

### 8.1 牛熊证分支

本版本的执行载体固定为牛熊证。

静态模式与自动寻标模式的差别只在“标的如何绑定”，不在“执行载体类型”：

1. `SEAT_MODE=static`：固定绑定一对牛证 / 熊证。
2. `SEAT_MODE=auto`：通过自动寻标维护一对牛证 / 熊证。

因此该适配层只校验当前席位牛熊证是否适合承接新的趋势开仓。必须通过：

1. 标的类型正确。
2. 回收价有效。
3. 基础对象价格有效。
4. 距回收价阈值通过。
5. 若候选来自 `warrantList`，继续复用流动性门槛。

### 8.2 位置约束

交易标的适配层必须放在 `Signal Planner` 之后、最终信号出队之前。

但约束必须写死：

1. 只拦截新的 `BUYCALL / BUYPUT`。
2. 不拦截 `SELLCALL / SELLPUT`。
3. 不拦截保护性清仓、末日保护、静态标的距回收价清仓。

### 8.3 与双席位和两种席位模式的关系

该层与席位模式解耦：

1. 静态标的模式下，适配层面向当前静态绑定标的运行。
2. 自动寻标模式下，适配层面向当前席位已绑定标的运行。
3. 上层因子不需要知道当前席位是静态绑定还是自动寻标得到。

---

## 9. 配置模型的最终重构

## 9.1 旧配置中必须删除的内容

以下配置全部删除：

1. `MONITOR_SYMBOL`
2. 所有 `_1 / _2 / _3` 后缀
3. `originalIndex`
4. `signalConfig`
5. `verificationConfig`
6. `SIGNAL_BUYCALL*`
7. `SIGNAL_SELLCALL*`
8. `SIGNAL_BUYPUT*`
9. `SIGNAL_SELLPUT*`
10. `SMART_CLOSE_ENABLED`
11. `SMART_CLOSE_TIMEOUT_MINUTES`

## 9.2 保留配置的作用域

新版本配置必须显式区分：

1. `global`：整个程序共享。
2. `shared trading/risk config`：单实例共享的一组交易与风控阈值。
3. `direction runtime state`：按方向独立维护的运行态计数、冷却、损益偏移与席位状态。

不允许把“方向运行态独立”误写成“配置必须按方向拆成两份”，否则会在无业务需求的情况下引入额外配置模型。

| 配置 | 作用域 | 说明 |
| --- | --- | --- |
| `DOOMSDAY_PROTECTION` | `global` | 整个程序共享 |
| `OPEN_PROTECTION` | `global` | 整个程序共享 |
| `BUY_ORDER_TIMEOUT / SELL_ORDER_TIMEOUT` | `global` | 买卖超时语义不同，不能强行合并 |
| `ORDER_MONITOR_PRICE_UPDATE_INTERVAL` | `global` | 整个程序共享 |
| `ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE` | `global` | 整个程序共享 |
| `TRADING_ORDER_TYPE / LIQUIDATION_ORDER_TYPE` | `global` | 整个程序共享 |
| `ORDER_OWNERSHIP_MAPPING` | `global` | 单程序版本共享 |
| `TARGET_NOTIONAL` | `shared trading/risk config` | 保持单实例共享配置 |
| `MAX_POSITION_NOTIONAL` | `shared trading/risk config` | 保持单实例共享配置 |
| `MAX_UNREALIZED_LOSS` | `shared trading/risk config` | 保持单实例共享配置 |
| `BUY_INTERVAL_SECONDS` | `shared trading/risk config` | 配置共享，运行态按方向独立节流 |
| `LIQUIDATION_COOLDOWN` | `shared trading/risk config` | 配置共享；触发与完成按方向记账，买入门禁继续按双方向共享口径拦截 |
| `LIQUIDATION_TRIGGER_LIMIT` | `shared trading/risk config` | 配置共享；运行态触发计数按方向独立 |

## 9.3 单实例版本保留的配置

以下配置保留，但全部改为单实例根配置，不再有 monitor 维度：

1. `SEAT_MODE`
2. 静态模式下的 `LONG_SYMBOL / SHORT_SYMBOL`
3. 自动寻标模式下的 `AUTO_SEARCH_* / SWITCH_*`
4. `TARGET_NOTIONAL`
5. `MAX_POSITION_NOTIONAL`
6. `MAX_UNREALIZED_LOSS`
7. `BUY_INTERVAL_SECONDS`
8. `LIQUIDATION_COOLDOWN`
9. `LIQUIDATION_TRIGGER_LIMIT`
10. `ORDER_OWNERSHIP_MAPPING`
11. `DOOMSDAY_PROTECTION`
12. `OPEN_PROTECTION`
13. `BUY_ORDER_TIMEOUT_ENABLED / BUY_ORDER_TIMEOUT_SECONDS`
14. `SELL_ORDER_TIMEOUT_ENABLED / SELL_ORDER_TIMEOUT_SECONDS`
15. `ORDER_MONITOR_PRICE_UPDATE_INTERVAL`
16. `ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE`
17. `TRADING_ORDER_TYPE / LIQUIDATION_ORDER_TYPE`

约束：

1. `SEAT_MODE=static` 时必须显式提供 `LONG_SYMBOL / SHORT_SYMBOL`。
2. `SEAT_MODE=auto` 时必须显式提供自动寻标与换标配置。
3. 两种模式的配置不可同时生效。

## 9.4 新增的策略配置

新增配置只围绕新策略因子：

1. `REGIME_THRESHOLDS`
2. `TREND_SCORE_THRESHOLDS`
3. `ER_THRESHOLDS`
4. `VWAP_CONFIRM_RULES`
5. `OPENING_STRUCTURE_RULES`
6. `PM_CONTINUATION_RULES`
7. `INSTRUMENT_ADAPTATION_RULES`

核心原则：

1. 配置表达的是因子规则，而不是字符串条件组。
2. 配置必须直接映射到 `FactorSnapshot -> DecisionSnapshot`。
3. 若 `12.4` 的 replay / walk-forward 尚未产出新结果，则默认值必须直接采用 `6.9`，不允许留空或运行时猜测。

## 9.5 隐藏多实例键空间的清理要求

除了配置与 app 装配层，以下内部结构也必须同步去除 monitor 维度：

1. 冷却与触发计数。
2. 日内损益偏移。
3. 订单归属中的 monitor ownership 字段。
4. 风险缓存中的 monitor 外层分片。
5. 任务 payload 中仅用于多 monitor 分发的 monitor 字段。
6. 生命周期恢复快照中的多 monitor 外层容器。

统一要求：

1. 能用 `direction` 建模的，不再保留 `monitorSymbol`。
2. 与交易标的、订单链路、换标状态直接相关的状态，继续保留 `symbol` / `orderId` 维度。
3. truly global 的状态直接升为程序级单例。

---

## 10. 代码简化与删除清单

## 10.1 启动与配置层

必须删除：

1. `createMultiMonitorTradingConfig`
2. monitor 扫描与索引连续性校验
3. monitor 级配置日志输出
4. 多 monitor 运行时校验

## 10.2 运行时装配层

必须删除：

1. `createMonitorContexts`
2. monitor context 批量装配
3. `monitorContexts` Map
4. `monitorStates` Map

替换为：

1. 单一 `createStrategyRuntime`
2. 单一 `StrategyState`
3. 单一 `RuntimeContext`
4. 单一基础对象 preset 解析入口

## 10.3 策略与信号层

必须删除：

1. 旧条件组求值器
2. 旧延迟验证器接入链路
3. 旧信号配置编译器

替换为：

1. `Factor Runtime`
2. `Signal Planner`
3. `Instrument Adaptation Gate`

## 10.4 卖出执行层

必须删除：

1. 三阶段智能平仓策略
2. 与其强耦合的配置与日志分支

统一为：

1. 趋势失效全平
2. 保护性清仓全平
3. 末日保护全平
4. 静态标的距回收价清仓全平（仅 `SEAT_MODE=static` 保留独立路径；`SEAT_MODE=auto` 不单独运行）

## 10.5 保留但要重构为单实例键模型的模块

以下模块虽然保留业务能力，但其内部键空间必须去除 monitor 维度：

1. 风险冷却与损益跟踪
2. 订单记录与订单归属
3. 任务队列 payload
4. 生命周期重建快照
5. 席位与版本状态

---

## 11. 建议新增模块

| 模块 | 职责 |
| --- | --- |
| `src/types/factor.ts` | `FactorSnapshot / DecisionSnapshot / TrendState / Regime` |
| `src/types/runtime.ts` | 单实例 `StrategyRuntime` 与 `StrategyState` |
| `src/services/factors/runtime/volatilityRegime.ts` | 波动率状态 |
| `src/services/factors/runtime/trendClassifier.ts` | 趋势分类 |
| `src/services/factors/runtime/intradayMomentum.ts` | 多窗口动量与 ER |
| `src/services/factors/runtime/sessionVwap.ts` | session-aware VWAP |
| `src/services/factors/runtime/openingStructure.ts` | OR 结构 |
| `src/services/factors/runtime/confirmation.ts` | 确认层 |
| `src/services/factors/runtime/signalPlanner.ts` | 开平仓判定 |
| `src/services/factors/runtime/instrumentAdaptation.ts` | 交易标的适配 |

下一阶段预留模块：

| 模块 | 职责 |
| --- | --- |
| `src/services/factors/runtime/futuresLeadLag.ts` | `HSIF` 与基础对象的短窗领先关系 |
| `src/services/factors/runtime/basis.ts` | `HSIF` 与基础对象的 basis / basis z-score |
| `src/services/marketData/derivativesSessionBridge.ts` | `HSIF` session 对齐、主连/换月与时间戳对齐 |

---

## 12. 分阶段实施

## 12.1 阶段 0：独立版本切割

完成：

1. 文档与命名切换到单指数独立版本语义。
2. 删除多 monitor 入口与配置解析前提。
3. 确定单实例运行时与单配置根对象。

## 12.2 阶段 1：程序形态瘦身

完成：

1. 删除 `MultiMonitor` 相关类型、状态、装配与日志。
2. 删除 monitor 级队列分流。
3. 删除旧延迟验证接线。
4. 删除智能平仓分支。
5. 按职责把内部 map key 从 `monitorSymbol + direction` 收敛为 `direction`、`symbol`、`orderId` 或程序级单例。

## 12.3 阶段 2：趋势策略内核

完成：

1. `1m / 5m / 15m` 基础对象直连订阅
2. 当前交易日分时样本预热 + 过去 `20` 个交易日同 session 波动率基线预热
3. `Regime + TrendScore + ER + Session VWAP + OR + PM Continuation`
4. readiness-aware `Signal Planner`
5. `Instrument Adaptation Gate`

## 12.4 阶段 3：增强与验证

完成：

1. session-aware replay
2. walk-forward
3. 因子消融
4. 交易标的适配分层统计

当前阶段只验证现货主链路；跨市场增强不并入本阶段。

## 12.5 阶段 4：`HSIF /` 跨市场增强

完成：

1. 补齐 `HSIF` 的实时行情、`1m` 历史 K 线、交易时段与主连/换月规则。
2. 建立 `HSI/代理现货 <-> HSIF` 的统一时间戳与 session 对齐层。
3. 引入 `futures lead-lag` 与 `basis` 两个因子，放入 `Confirmation` 的高优先级子层。
4. 独立评估“现货主链路版本”与“`HSIF` 增强版本”的增益差异。
5. 若后续期权数据也补齐，可在同一衍生品数据阶段继续评估期权侧增强，但不作为 `lead-lag / basis` 的前置条件。

进入条件：

1. `HSIF` 数据源稳定，且 `1m` 级别时间戳可与基础对象稳定对齐。
2. 已明确午休 session、半日市与主连/换月口径。
3. 阶段 3 已能独立证明当前现货内核在 replay / walk-forward 下成立。

---

## 13. 验收标准

重构完成后，必须同时满足：

1. 程序不再支持多 monitor。
2. 配置不再出现 `_1 / _2` 后缀。
3. 配置中不再需要填写监控标的。
4. 双席位模式仍然保留并可独立运转。
5. 静态标的模式与自动寻标模式都可成立，但同一实例只启用其中一种。
6. 新开仓不再依赖旧条件组。
7. 新开仓不再依赖旧延迟验证。
8. 智能平仓三阶段不再保留。
9. 每个时点都能输出带 readiness 的 `FactorSnapshot`；未就绪因子必须显式标记，且未就绪时不得生成策略信号。
10. 日志能明确说明信号被拦截在 `regime / trend / structure / confirmation / instrumentAdaptation` 的哪一层。
11. 交易标的适配结果不会反向污染基础对象趋势判断。
12. 交易标的适配层只作用于 `BUYCALL / BUYPUT`，不得拦截卖出与风险性清仓。
13. 内部键空间不再残留 `monitorSymbol` 维度。

---

## 14. 最终判断

在新增需求下，逻辑最正确且最符合目标的方案只有一个：

1. 把程序改成单指数独立版本。
2. 把策略改成日内趋势延续专用版本。
3. 删除所有多监控、多策略、旧条件组、旧延迟验证遗留结构。
4. 删除与旧分批均值回归模式强耦合的智能平仓逻辑。
5. 只保留对单指数趋势程序仍有直接业务意义的执行、风控、生命周期与寻标能力。

若不这样做，程序会继续停留在：

`单指数需求 + 多标的程序壳 + 旧策略兼容残留`

这种逻辑不闭合、复杂度又过高的中间状态。

补充：

当前版本先完成 `spot-first` 的单指数趋势闭环；`HSIF lead-lag / basis` 与衍生品数据接入作为下一阶段增强，不反向阻塞本阶段成立。

---

## 15. Sources

### 研究

1. Huang, _The first 20 min in the Hong Kong stock market_  
   https://arxiv.org/abs/cond-mat/0006145
2. Tang and Lui, _Intraday and intraweek volatility patterns of Hang Seng Index and index futures_  
   https://www.sciencedirect.com/science/article/abs/pii/S0927538X02000690
3. Moskowitz, Ooi, Pedersen, _Time Series Momentum_  
   https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf
4. Gao, Han, Li, Zhou, _Intraday Momentum: The First Half-Hour Return Predicts the Last Half-Hour Return_  
   https://smallake.kr/wp-content/uploads/2015/01/SSRN-id2440866.pdf
5. Onishchenko, Zhao, Kuruppuarachchi, Roberts, _Intraday time-series momentum and investor trading behavior_  
   https://www.sciencedirect.com/science/article/abs/pii/S2214635021001015
6. Baltussen, Da, Lammers, Martens, _Hedging Demand and Market Intraday Momentum_  
   https://www.sciencedirect.com/science/article/pii/S0304405X21001598
7. Admati, Pfleiderer, _A Theory of Intraday Patterns: Volume and Price Variability_  
   https://academic.oup.com/rfs/article/1/1/3/1601212
8. Schweickert, _Price discovery in equity markets: A state-dependent analysis of spot and futures markets_  
   https://www.sciencedirect.com/science/article/pii/S037842662300033X
9. Karathanassis et al., _Spot–Futures Price Adjustments in the Nikkei 225_  
   https://www.mdpi.com/1911-8074/16/2/117

### Longbridge 官方文档

1. https://longportapp.github.io/openapi/nodejs/classes/QuoteContext.html
2. https://open.longbridge.com/docs/quote/pull/candlestick
3. https://open.longbridge.com/docs/quote/pull/history-candlestick
4. https://open.longbridge.com/docs/quote/pull/static
5. https://open.longbridge.com/docs/quote/pull/warrant-quote
6. https://open.longbridge.com/docs/quote/pull/trade-session
7. https://open.longbridge.com/docs/quote/pull/trade-day

### 港交所官方资料

1. HKEX, _Trading Mechanism of Closing Auction Session in the Securities Market_  
   https://www.hkex.com.hk/-/media/HKEX-Market/Services/Trading/Securities/Overview/Trading-Mechanism/Trading-Mechanism-of-CAS-in-the-Securities-Market.pdf
2. HKEX, _Introduction to Callable Bull / Bear Contracts_  
   https://www.hkex.com.hk/-/media/HKEX-Market/Products/Securities/Structured-Products/Product-Sheet/2025-Feb/HKEX_CBBC_infosheet_en.pdf

### 当前代码结构参考

1. [src/config/trading/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/trading/index.ts)
2. [src/app/createMonitorContexts.ts](/D:/code/Longbridge-Quantitative-Trading/src/app/createMonitorContexts.ts)
3. [src/services/quoteClient/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/index.ts)
4. [src/services/autoSymbolFinder/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/services/autoSymbolFinder/index.ts)
5. [src/core/riskController/warrantRiskChecker.ts](/D:/code/Longbridge-Quantitative-Trading/src/core/riskController/warrantRiskChecker.ts)
