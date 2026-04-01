# 单指数趋势延续重构二次复核问题记录

**日期**：2026-03-31 **复核范围**：`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md` 对应的当前工作区实现；重点覆盖执行载体适配、买卖执行链路、因子 readiness、TypeScript 项目规范 **复核方法**：从业务不变量出发做二次取证；不假设文档正确，也不假设当前实现正确；只有“证据充分且确有修复必要性”的问题才正式立项

---

## 结论先行

本次二次复核后，上一轮候选问题中，以下四类问题应保留为正式问题：

1. **执行载体阈值存在多真源，配置不能作为唯一业务真源，必须修复**
2. **买入链路未把在途买单纳入占用与风控，存在重复挂单/超配窗口；若已有在途买单必须直接拦截新的买入，必须修复**
3. **20 个交易日同 session 波动率基线预热闭环没有被代码显式保证，启动/开盘重建后的 readiness 依赖 undocumented seed 行为，必须修复**
4. **部分 TypeScript 项目规范问题真实存在，其中 logger 的结构性违规必须修，注释规范缺口应修复**

以下候选项经二次复核后，不作为“已证实且必须修复”的正式问题立项：

1. **午休口径冲突**：当前更准确的结论是“文档表述存在歧义”，不能直接定性为实现错误
2. **工具链/格式化工作流差异**：属于仓库工程流程选择，不构成当前代码逻辑缺陷

---

## 严重问题（必须修复）

### 问题 A：执行载体阈值存在多真源，配置无法作为唯一业务真源

**严重级别**：严重 **涉及文件**：

- `src/main/processMonitor/signalPipeline.ts:93-123`
- `src/core/riskController/warrantRiskChecker.ts:38-41`
- `src/core/riskController/warrantRiskChecker.ts:203-270`
- `src/config/trading/runtime.ts:60-84`
- `src/config/validator/index.ts:564-657`
- `src/app/buildStrategyRuntime.ts:39-50`
- `src/constants/index.ts:367-376`

#### 业务不变量

执行载体距离阈值本质上是一组同源策略参数。只要系统允许用户配置：

1. 牛证买入最小距回收价百分比
2. 熊证买入最大距回收价百分比
3. 牛证清仓距回收价百分比
4. 熊证清仓距回收价百分比

那么买入前的执行载体准入、买入前的牛熊证风控、静态席位的距回收价清仓，就必须使用同一份运行时配置。否则用户改了配置，但不同链路对同一距离给出不同结论，配置契约失效。

#### 二次取证

当前代码已经把这组阈值纳入正式配置模型：

1. `TradingConfig.strategy.instrumentAdaptationRules`
2. `StrategyRuntimeConfig.strategyConfig.instrumentAdaptationRules`
3. `validator` 显式校验买入阈值与清仓阈值的大小关系

但执行链路没有统一消费这份配置：

1. `signalPipeline` 的 Instrument Adaptation Gate 使用 `strategyConfig.instrumentAdaptationRules`
2. `warrantRiskChecker.checkRisk()` 仍使用 `BULL_WARRANT_MIN_DISTANCE_PERCENT` / `BEAR_WARRANT_MAX_DISTANCE_PERCENT`
3. `warrantRiskChecker.checkWarrantDistanceLiquidation()` 仍使用 `BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT` / `BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT`
4. `buildStrategyRuntime()` 创建 `warrantRiskChecker` 时没有注入任何运行时阈值，只能退回常量真源

这说明当前阈值存在两个真源：

1. 运行时配置
2. 常量硬编码

#### 最小反例

反例 1：静态买入阈值被放宽时，信号准入与买入风控会给出相反结论。

例如：

1. `INSTRUMENT_ADAPTATION_RULES_BULL_BUY_MIN_DISTANCE_PCT=0.20`
2. 某牛证距离回收价为 `0.25%`

此时：

1. `signalPipeline` 判定 `0.25 > 0.20`，允许进入买入任务
2. `warrantRiskChecker` 仍按硬编码 `0.35%` 判定，拒绝买入

这不是“更保守也可以接受”的问题，而是**用户配置与实际执行口径不一致**。

反例 2：静态席位清仓阈值被收紧或放宽时，配置不会生效。

例如：

1. `INSTRUMENT_ADAPTATION_RULES_BULL_LIQUIDATION_DISTANCE_PCT=0.15`
2. 静态席位当前持有牛证，`LIQUIDATION_DISTANCE_CHECK` 被调度

最终仍会走 `warrantRiskChecker.checkWarrantDistanceLiquidation()`，实际使用的还是硬编码 `0.30%`。这会让配置值被静默忽略。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

原因不是“实现风格不统一”，而是：

1. 配置层已经承诺这组阈值可配置
2. 运行时执行层没有兑现该承诺
3. 用户一旦覆盖 env，程序行为就会与配置说明分裂

#### 修复边界

必须收敛为**单一运行时配置真源**：

1. 买入前执行载体准入
2. 买入前牛熊证风控
3. 静态席位距回收价清仓

全部统一读取 `StrategyRuntimeConfig.strategyConfig.instrumentAdaptationRules`，不能继续保留常量真源。

---

### 问题 B：买入链路未对在途买单建立占用语义，存在重复挂单与超配窗口

**严重级别**：严重 **涉及文件**：

- `src/services/factors/runtime/signalPlanner.ts:46-124`
- `src/core/signalProcessor/riskCheckPipeline.ts:172-252`
- `src/core/trader/orderExecutor/buyThrottle.ts:32-75`
- `src/core/trader/orderExecutor/submitFlow.ts:79-166`
- `src/core/trader/orderExecutor/submitFlow.ts:316-326`
- `src/core/trader/orderMonitor/index.ts:266-267`
- `src/core/trader/orderMonitor/quoteFlow.ts:544-583`
- `src/core/riskController/positionLimitChecker.ts:63-141`

#### 业务不变量

对当前单指数、双席位、趋势延续模型来说，单席位单标的的入场动作必须满足：

1. 只要存在同席位同标的的在途买单（未终态且未完全成交的买单），后续新的买入必须直接拦截，不再按“空仓可开仓”语义继续提交
2. 当前问题范围内不存在“在途期间允许继续并发加仓”的正式业务定义，因此不能保留“边走边合并”或“继续补单”的自由裁量空间
3. 不能仅依赖时间节流来避免重复挂单

当前文档和实现都没有给出“允许同席位同标的无上限连续并发买单”的正式业务定义。

#### 二次取证

当前链路只把“已持仓”当作 entry/exit 分界线：

1. `signalPlanner.hasOpenPosition()` 只看 `positionCache.get(symbol)?.quantity > 0`

这意味着**待成交买单不算已持仓**。只要订单尚未成交，策略层仍会持续生成新的买入动作。

后续执行链路也没有补上“在途买单占用”：

1. `riskCheckPipeline` 的买入保护首先只看 `trader.canTradeNow()`，本质是时间节流
2. `buyThrottle` 只记录“上次买入尝试时间”，完全不感知 pending buy 是否仍未终态
3. `submitFlow` 只为卖单实现了 pending sell 合并；买单分支直接 `resolveBuyQuantity()` 后提交
4. `OrderMonitor` 对外只暴露 `getPendingSellOrders()` / `hasPendingSellOrders()`，没有 buy 对应查询接口
5. `positionLimitChecker` 只看已持仓市值，不把 pending buy notional 纳入限制

#### 最小反例

假设做多席位当前无持仓，趋势因子持续允许开多：

1. `t0` 生成 `BUYCALL`，提交买单 A
2. 买单 A 因价格原因长时间 pending，`positionCache` 仍为 `0`
3. 超过 `buyIntervalSeconds` 后，下一轮主循环再次生成 `BUYCALL`
4. 风险检查仍可能通过，因为：
   - `canTradeNow` 只看时间，窗口已过
   - `positionLimitChecker` 看不到 A 的 pending notional
   - 提交层没有 pending buy 拦截或合并
5. 系统提交买单 B

于是同一席位、同一标的、同一方向会出现多笔并发买单。若随后集中成交，实际暴露将超过“单次入场”语义。

#### 排除性验证

本次二次复核专门检查了是否存在其他补偿机制，结论是否定的：

1. `orderHoldRegistry` 只维护“哪些 symbol 存在未终态订单”，主要用于行情订阅与换标判断，不参与买入风控
2. `signalPipeline` 没有针对 pending buy 的过滤
3. `BuyProcessor` 执行前只做席位版本和行情复核，不做 pending buy 复核

因此这不是“已有其他模块兜底，只是上轮没看到”的误报。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

这是实际交易风险问题，不是单纯的实现偏好差异。

#### 修复边界

必须建立正式的“在途买单占用”语义，并把“存在在途买单即直接拦截新的买入”收敛为不可绕过的硬规则：

1. 策略层可以额外做 entry 过滤，但这只能是前置优化，不能替代正式硬边界
2. 买入风险检查与/或提交层必须至少有一处不可绕过的硬拦截
3. 只要检测到在途买单，就直接拒绝新的买入提交；不允许继续保留 pending buy 合并或再次补单语义

不能继续只靠时间节流来“碰运气”避免重复挂单。

---

### 问题 C：20 个交易日同 session 波动率基线预热闭环没有被代码显式保证

**严重级别**：严重 **涉及文件**：

- `src/services/factors/runtime/intradayMomentum.ts:258-316`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:298-314`
- `src/types/services.ts:62-135`
- `src/services/quoteClient/index.ts:601-648`
- `src/constants/index.ts:82-83`

#### 业务不变量

当前因子链路把 `rvQuantileWindowDays=20` 的同 session 历史波动率基线当成 regime readiness 的硬前提。只要程序希望在“启动后”或“开盘重建后”具备可用的日内策略能力，就必须**显式保证**这份 20 日历史基线可得，不能依赖未声明的 SDK seed 行为。

否则系统将出现一种危险状态：

1. 程序逻辑上要求 20 日基线
2. 启动链路没有显式取回这 20 日基线
3. readiness 长期不满足
4. 策略当天整日无法进入正常信号链路

这虽然是 fail-closed，但它依然是业务闭环不完整。

#### 口径澄清：这里需要的到底是什么 K 线

这里需要的**不是 `20` 根日级 K 线**，也不能把它理解成“拿到 `20` 天收盘价就够了”。

原因很直接：当前代码对波动率基线的计算口径是：

1. 只消费 `candlesByPeriod.min1`
2. 先按 `dayKey + session + cutoffMinuteOfDay` 切出“当前交易日 / 历史交易日”在**同一 session、同一时点截面**上的 1 分钟 bars
3. 再对每个交易日该 session 截面里的最近 `31` 根 `1m` bars 计算 `RV30`
4. 最后把“当前交易日的 `RV30`”与“过去 `20` 个交易日同 session、同 cutoff 的 `RV30` 序列”做分位比较，得到 `VolQuantile`

因此，问题 C 真正需要的是：

1. **过去 `20` 个交易日的 `1m` 历史分时 K 线样本**
2. 且这些样本必须能按当前所处 session（AM / PM）和当前分钟截点进行对齐比较

更准确地说，它也不是一个“必须预热整整 `20` 天全量 `1m` K 线文件”的字面要求；代码真正依赖的是：

1. 当前交易日分时样本，用于恢复 `MOM / ER / ATR / VWAP / OR`
2. 过去 `20` 个交易日、与当前 session 同步对齐的 `1m` 波动率基线样本，用于计算 `RV30` 分位

但从**启动后任意时点都能立即满足 readiness**这个运行目标出发，预热能力的正确抽象应当是：

1. 能显式拿回并缓存过去 `20` 个交易日的 `1m` 历史分时数据
2. 至少要足以覆盖 AM / PM session 在各自 cutoff 下的同 session 比较需求

#### 获取这些 K 线的作用是什么

这些 K 线不是为了“多拿一点历史看看走势”，而是服务两个完全不同的因子职责：

1. **当前交易日分时样本**：恢复当日的 `MOM_15 / MOM_30 / MOM_60`、`ER_15 / ER_30`、`ATR`、`VWAP`、`OR` 等状态，这是趋势分类、结构检测、确认层的输入
2. **过去 `20` 个交易日同 session 的 `1m` 样本**：构造 `RV30` 历史分布，计算 `VolQuantile`，再与 `ATR short / ATR long` 共同决定 `Volatility Regime`

这两类作用不能混淆：

1. 前者解决“今天盘中当前结构和趋势状态是什么”
2. 后者解决“今天此刻的 session 内波动率，相比过去 `20` 个交易日同一 session、同一时间截面，处在什么分位”

所以问题 C 的正确表述应当是：

1. 不是缺少 `20` 根日级 K 线
2. 而是缺少**过去 `20` 个交易日同 session 对齐的 `1m` 历史波动率基线预热保证**
3. 当前实现只做了 `subscribeCandlesticks()` seed，但没有显式保证这份 `1m` 历史基线一定足量可得

#### 方案收敛：采用“完整 20 日 `1m` 显式历史预热”

本问题不再保留“按当前 session 最小化预热”或“依赖实时 K 线自然补齐”的实现空间，修复方案必须收敛为：

1. 在**启动初始化**和**开盘重建**两个缓存生命周期入口，各执行一次完整的 `20` 个交易日 `1m` 历史 K 线预热
2. 预热目标不是只拿到“刚好够当前 AM / PM 的最小截面”，而是直接拿到**完整 `20` 个交易日的完整盘中 `1m` 样本**
3. 香港完整交易日按当前 session 定义为 `330` 根 `1m` bars（AM `150` + PM `180`）
4. 仅“过去 `20` 个历史交易日”的基线窗口上限是 `330 * 20 = 6600` 根，但真正的运行时缓存还必须同时保留**当前交易日**分时样本，因此总窗口上限约为 `6600 + 330 = 6930` 根
5. 以当前 `TRADING.CANDLE_COUNT = 7000` 的容量上限，现有工程实现可以覆盖上述“`20` 个历史交易日 + 当前交易日”的总窗口
6. 若保持当前 Longbridge 历史 K 线接口单次返回上限与本地缓存容量不变，工程实现可以推导为多批拉取；在当前参数下可落为约 `7` 批、总预算约 `7000` 根，但这属于**实现推导值**，不是额外的业务不变量

选择这条方案，而不是“只补当前 session 所需最小样本”的原因是：

1. 当前因子运行时消费的是统一的 `min1` 本地缓存，而不是 session 专用缓存
2. 当前交易日的 `MOM / ER / ATR / VWAP / OR` 与过去 `20` 日的 `VolQuantile` 共同依赖同一份 `1m` 数据底座
3. 若只做最小 session 预热，会把预热逻辑绑死在“当前启动时刻属于 AM 还是 PM”，导致生命周期与缓存语义复杂化
4. 直接预热完整 `20` 日 `1m` 样本后，AM / PM 切换、盘中推进、开盘后任意时点的 readiness 口径都使用同一份稳定缓存，不再需要额外分支

#### 为什么不能继续依赖当前实时 K 线获取链路

当前实时链路只能作为**订阅 seed + 盘中增量更新**使用，不能再被视为满足 `20` 日 `1m` 基线的正式来源，原因是：

1. `subscribeCandlesticks()` 返回的 seed 根数没有业务保证
2. `getRealtimeCandlesticks()` 读取的是 SDK 内部实时缓存，同样没有“必然覆盖 `20` 个历史交易日 + 当前交易日，总计约 `6930` 根 `1m`”的契约
3. 当前 `TRADING.CANDLE_COUNT = 7000` 只是应用层缓存容量上限，不代表启动时 SDK 一定已经持有或返回足量历史
4. 一旦启动或开盘重建后拿到的 seed 少于所需窗口，当天靠实时 push 只会继续补充最新 bars，无法补齐缺失的前序交易日历史

因此，**当前实时获取的 K 线不足以覆盖 `20` 日 `1m` K 线基线要求**，必须引入显式历史拉取链路。

#### 二次取证

当前代码中，regime readiness 的硬条件是：

1. `computeSessionRv30Quantile()` 统计同 session 历史样本数
2. `requiredBaselineDays = floor(rvQuantileWindowDays)`
3. 只有 `historicalSampleCount >= requiredBaselineDays` 才认为 `regimeReady=true`

这不是软建议，而是代码里的硬门槛。

但启动/开盘重建链路只做了：

1. `resetRuntimeSubscriptionsAndCaches()`
2. `subscribeCandlesticks(baseInstrumentSymbol, period)`

当前 `MarketDataClient` 接口只暴露：

1. `subscribeCandlesticks`
2. `getRealtimeCandlesticks`
3. `getCandlestickSnapshot`
4. `resetRuntimeSubscriptionsAndCaches`

没有任何显式历史 K 线预热接口。仓库内也没有对 `historyCandlesticksByOffset` / `historyCandlesticksByDate` 之类历史拉取能力做适配。

与此同时，`quoteClient.subscribeCandlesticks()` 只是直接调用 `ctx.subscribeCandlesticks(...)` 后把返回值 seed 到本地缓存，并未对 seed 根数建立任何业务保证。`TRADING.CANDLE_COUNT = 7000` 只是**缓存容量上限**，不是**启动时实际拿到的历史样本下限**。

#### 最小反例

假设系统在 `2026-03-31 09:20` 启动：

1. 生命周期加载先 `resetRuntimeSubscriptionsAndCaches()`
2. 然后只调用 `subscribeCandlesticks()` 重新 seed
3. 如果 SDK 此次 seed 只返回最近 `N` 根 K 线，且不足以覆盖 `20` 个交易日的同 session 样本
4. 当天盘中 push 只会继续补充“当前交易日”的 bars，不会凭空补齐前 20 个交易日
5. 因为缓存在启动时已经重置，当天同 session 历史样本数将始终停留在 seed 提供的上限

于是：

1. `historicalSampleCount < rvQuantileWindowDays`
2. `regimeReady=false`
3. `overallReady=false`
4. 当天策略链路会持续处于 not-ready

这不是理论上“可能几分钟后自然恢复”的短暂问题，而是**一旦 seed 不够，当天靠实时推送无法自行修复**。

#### 复核结论

- **问题真实存在**
- **证据充分**
- **必须修复**

这里“真实存在”的含义不是“已经确认生产事故”，而是：

1. 当前实现没有显式保证自身所依赖的数据不变量
2. 策略 readiness 的硬门槛与启动预热实现之间存在结构性缺口
3. 这个缺口会在任意一次 seed 不足时直接导致当天整日 not-ready

因此它已经是实现缺陷，而不是单纯的设计风险。

#### 修复边界

本问题的修复方案已经收敛，不再保留“修改 readiness 定义以迁就当前数据能力”的路线。必须按以下边界实现：

1. 为 `MarketDataClient` 增加显式历史 `1m` K 线拉取能力，基于 Longbridge 历史 K 线接口按批次获取
2. 在启动初始化与开盘重建链路中，把“完整 `20` 日 `1m` 历史 K 线预热”作为正式硬步骤接入，并保证预热窗口能够覆盖“`20` 个历史交易日 + 当前交易日”所需的 `1m` 样本
3. 历史 K 线写入应用层缓存时必须使用**回填/合并语义**，不能复用当前会整体替换快照的 seed 语义；否则后续 `subscribeCandlesticks()` 返回的较短 seed 会把预热历史覆盖掉
4. `5m / 15m` 不要求补 `20` 日历史，但必须显式保证**当前交易日样本**在第一次指标流水线运行前可用，不能只对 `1m` 做保证
5. 预热历史数据落地后必须验证：缓存按 timestamp 升序、已去重、同时覆盖当前交易日与至少 `20` 个历史交易日键；否则不得放行
6. 若历史预热失败、根数不足、去重后仍无法覆盖 `rvQuantileWindowDays=20` 所需样本，则启动/开盘重建必须保持 fail-closed，不得伪造 readiness

不能继续依赖未声明的 `subscribeCandlesticks()` seed 行为来碰运气满足 20 日基线。

---

## 重要问题（应修复）

### 问题 D：TypeScript 项目规范存在真实缺口，其中 logger 为结构性违规，注释规范存在明确漏项

**严重级别**：重要 **涉及文件**：

- `src/utils/logger/index.ts:109`
- `src/utils/logger/index.ts:405`
- `src/utils/logger/index.ts:741-768`
- `src/config/auth/utils.ts:26-69`
- `.codex/skills/typescript-project-specifications/SKILL.md`

#### 规范基线

按 `typescript-project-specifications`，以下规则是明确要求：

1. 使用工厂函数而非类来创建对象
2. 所有依赖通过参数注入，禁止在内部直接创建
3. 新增 `.ts` 模块（除 `types.ts`、`utils.ts`、`types/`、`utils/` 下文件外）必须有文件头注释
4. `utils.ts` / `utils/` 下每个工具函数必须有完整 JSDoc，包含 `@param`、`@returns`

#### 二次取证

##### D1. logger 的结构性违规真实存在

`src/utils/logger/index.ts` 当前同时存在以下事实：

1. 使用 `class DateRotatingStream extends Writable`
2. 在模块顶层直接读取 `process.env`
3. 在模块顶层直接创建 `DateRotatingStream`
4. 在模块顶层注册 `process.on('beforeExit' | 'exit' | 'uncaughtException' | 'unhandledRejection')`

这与 skill 中的以下规则直接冲突：

1. “使用工厂函数而非类来创建对象”
2. “所有依赖通过参数注入，禁止在内部直接创建”

这里不存在“仓库已有正式例外”的证据，因此这是标准的、可判定的结构性违规。

##### D2. 注释规范缺口也真实存在

`src/config/auth/utils.ts` 中多个工具函数没有完整 JSDoc，例如：

1. `parseBooleanEnvValue`
2. `parseCallbackPort`
3. `isAuthMode`
4. `readOptionalLanguage`
5. `readOptionalPushCandlestickMode`

`src/config/auth/utils.ts` 中这些工具函数位于 `utils.ts` 文件，按 skill 规则应提供完整 JSDoc，因此这里属于可以直接判定的规范缺口。

#### 复核结论

##### logger

- **问题真实存在**
- **必须修复**

原因不是个人风格偏好，而是本次验收目标明确包含“是否符合 `typescript-project-specifications`”。在该目标下，logger 当前不能视为合格。

此外，logger 还是基础设施模块。导入即执行副作用与内部依赖创建会放大：

1. 生命周期边界不清晰
2. 测试隔离困难
3. 副作用难以装配和替换

##### 注释规范缺口

- **问题真实存在**
- **应修复**

这部分不是运行时逻辑缺陷，但若验收目标包含 skill 合规性，它就是明确的规范缺口。

---

## 已排除或暂不立项的问题

### X1：午休口径文档与实现冲突

#### 二次结论

**本轮不作为“已证实且必须修复”的正式问题立项。**

#### 原因

当前实现确实让 PM 的 `MOM/ER` 使用当日午休前后的连续 trading bars；对应测试也显式锁定了该行为：

- `tests/services/factors/runtime/index.business.test.ts:392-478`

但计划文档中的原句是：

> `MOM_15 / MOM_30 / MOM_60` 与 `ER_15 / ER_30` 只使用当前交易日连续交易时段数据，不拼接上一交易日，也不跨午休把非交易时间当成可用样本。

更严格地解读，这句话禁止的是“把午休非交易时间补成样本”；而当前实现并没有把午休时间本身当成 bars，只是把 AM 与 PM 的交易 bars 连续连接后计算 trading-bar 动量。

因此更准确的结论是：

1. 文档表述存在歧义
2. 不能仅凭该文句直接判定当前实现错误
3. 若后续要处理，更合适的是先澄清业务定义，再决定改文档还是改实现

### X2：工程检查边界与格式化工作流差异

#### 二次结论

**不作为问题立项。**

#### 原因

1. 当前仓库 `bun test`、`bun lint`、`bun type-check` 全部通过
2. `typescript-project-specifications` 中关于 `bun format` / `bun lint` / `bun type-check` 的顺序约束，主要适用于“本次实际改 TS 代码并交付”的场景
3. 仓库当前 `package.json` 的格式化/修复流程属于工程流程选择，不构成当前代码逻辑错误

---

## 建议的后续处理顺序

1. 先统一执行载体阈值真源，因为这是配置契约与实际执行口径直接分裂的问题
2. 再补在途买单占用语义，因为这是直接的交易风险问题
3. 然后补齐历史 K 线预热契约，确保启动/开盘重建闭环成立
4. 最后按 `typescript-project-specifications` 收敛 logger 与注释规范问题
