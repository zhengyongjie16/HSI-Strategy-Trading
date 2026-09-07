# 当前标的多策略运行时、日内回归策略专属延迟验证与宿主就绪屏障重构方案

> 状态：已确认，待实施
>
> 本文是在当前 `src/`、`tests/`、配置文件和既有方案基础上，经多轮独立分析、复核、反向审查与最终确认后形成的实施方案。本文只描述目标架构、业务边界、实施顺序和验收要求，不代表代码已经完成重构。
>
> 本文的“日内回归策略”是当前 MFI/KDJ/RSI/PSY 等多指标条件策略及其可选延迟验证的正式业务名称。本期不新增 VWAP、滚动均值、标准差、Z-Score、Bollinger 等统计型回归指标。

## 决策摘要

本方案已经确认以下规则，实施时不得重新解释：

1. 当前多指标阈值策略整体归为唯一的 `intradayRegression`（日内回归）策略。
2. 同一个 monitor 最多配置一个日内回归策略实例。
3. 延迟验证是日内回归策略的内部业务能力，其他策略不得声明、调用或继承延迟验证。
4. 宿主可以提供指标样本缓存、timer、scheduler、取消和生命周期端口，但不得持有延迟验证的业务判断规则。
5. 多策略首期固定按配置顺序串行评估；不实现并行评估、策略状态持久化或可靠投递 outbox。
6. 普通信号按 `evaluationId + direction + operation` 建立宿主就绪屏障。
7. 未声明某个动作的策略不参与该动作槽位；已声明但本轮未触发的策略结算为 `NO_SIGNAL`。
8. `READY`、`PENDING`、`NO_SIGNAL` 是一次评估中某个策略动作槽位的结果，不是策略实例的全局状态。
9. `READY + PENDING` 必须等待 pending 结束；`NO_SIGNAL + PENDING` 也必须等待全部 pending 进入终态，最终不释放信号。
10. 只有同一动作槽位的所有参与策略最终均为 `READY`，宿主才可以合并候选并生成共享交易信号。
11. 普通触发时间以固定 `evaluationAtMs` 为基准；同槽位有 delayed READY 时保留其 T0，否则为 evaluationAtMs，host adapter 不得重打时间戳。
12. 不同 `evaluationId` 独立收敛，新 K 线不自动取消已创建的旧 evaluation 或其 pending。
13. 同方向同动作的多个 READY 候选合并为一个共享意图，不累加数量；同一方向的 OPEN/CLOSE 是相互独立的动作槽位，各自只等待本槽位参与策略，不互相等待、否决或仲裁；两者同时成立时分别进入既有买/卖队列。
14. 普通席位授权使用 `runtimeEpoch + direction + seatVersion + symbol`；不引入无真相源的 seatInstanceId。
15. 保护性清仓、末日清仓、静态距回收价清仓不受普通策略就绪屏障阻塞。

## 1. 目标与范围

### 1.1 目标

在当前单一监控标的、共享账户和共享席位的交易运行时内，支持多个静态配置的策略实例，并形成一个完整的普通策略信号决策链路：

- 当前 MFI/KDJ/RSI/PSY 多指标条件策略正式归为 `intradayRegression`；
- 同一 monitor 最多一个日内回归策略实例；
- 日内回归策略可配置多个信号因子，并可选择立即结果或策略内部延迟验证；
- 其他策略只能输出立即候选，不拥有 `PENDING` 或延迟验证能力；
- 所有策略按配置顺序串行评估；
- 每次有效 monitor snapshot 生成独立 `evaluationId`；
- 宿主以 `evaluationId + direction + operation` 建立动作槽位屏障；
- 每个动作槽位的参与策略全部结算后，才在该动作槽位内进行跨策略候选合并；不同动作槽位不相互仲裁或阻塞；
- 所有策略共享行情、指标计算、席位、订单、持仓、现金、风控、损益和执行事实；
- 现有买入风控、卖出智能平仓、订单执行、订单监控、成交结算、自动寻标、保护性清仓、末日清仓和交易日生命周期继续由宿主统一负责。

### 1.2 明确不在本次范围内

本期不实现以下能力：

- 多个监控标的或多套独立 monitor runtime；
- 同一 monitor 配置多个日内回归策略实例；
- 策略级持仓、订单成本、P&L、DailyLoss、浮亏或仓位预算；
- 策略级独立 Trader、OrderRecorder、PositionCache、风控器或买卖处理器；
- 运行时热切换、动态增删策略或第三方插件加载；
- 并行策略评估；
- 策略自身状态持久化、snapshot/restore、event cursor 或 state repository；
- decision store、durable outbox、崩溃后的普通候选可靠重放；
- 重启时恢复 timer、indicator cache、延迟 pending、就绪屏障或未入队候选；
- 新增真正统计型 `extremeReversion` 策略及其 VWAP/Z-Score/滚动统计指标；
- 订单簿、Depth、Broker Queue 等新的验证数据源。

首期允许进程重启时丢弃尚未完成的普通 evaluation、屏障和延迟 pending；共享订单、持仓和风险事实仍按既有领域规则恢复。

### 1.3 术语

- **策略实例**：由静态 descriptor 创建的一组策略参数、策略实现和运行时身份。
- **日内回归策略**：当前多指标阈值策略的正式业务名称，不表示本期新增统计回归公式。
- **动作槽位**：`direction + operation`，对应四类普通动作。
- **参与策略**：在 descriptor 中显式声明支持某个动作槽位的策略。
- **`READY`**：策略已形成当前动作槽位的有效候选，可参与宿主最终合并。
- **`PENDING`**：日内回归策略已经形成延迟 intent，宿主已 reserve 并正在/已经登记其专属验证 runtime。
- **`NO_SIGNAL`**：策略已完成当前槽位判断但没有候选，或延迟验证失败；这是正常的否决终态。
- **`CANCELLED`**：lifecycle scope 使对应 slot、direction 或 runtime 失效；不是正常业务 `NO_SIGNAL`。
- **`ABORTED`**：runtime 内部错误触发的 fatal 终态；不是策略 slot outcome。
- **屏障**：宿主收集同一 evaluation、同一动作槽位全部参与策略结果的 transient 协调状态。

## 2. 源码事实与架构裁决

### 2.1 当前实现不是多策略运行时

当前生产链路只有一套策略资源：

```text
TradingConfig.monitor
  -> MonitorContext
  -> 一个 strategy
  -> 一个 IndicatorUsageProfile
  -> 一个 IndicatorCache
  -> 一个 DelayedSignalVerifier
  -> 一组买卖队列
```

已确认的证据：

- `src/types/config.ts` 中 `TradingConfig.monitor` 为单数配置；
- `src/types/state.ts` 中 `MonitorContext` 只有一个 `strategy`、一个 `indicatorProfile` 和一个 `delayedSignalVerifier`；
- `src/app/context/createMonitorContext.ts` 只调用一次 `strategyFactory`，只编译一次 profile，只创建一个 verifier；
- `src/app/runtime/createPostGateRuntime.ts` 只按单一 `verificationConfig` 推导缓存窗口；
- `src/main/businessEventProgram/signalPipeline.ts` 只调用一次 `strategy.generateSignals()`；
- `src/main/asyncProgram/delayedSignalVerifier/` 只有一张 pending Map 和一组广播 callback。

因此本次目标是扩展现有单 monitor 宿主内的策略集合，而不是复制 monitor、账户、订单、风险或席位运行时。

### 2.2 当前策略的实际职责

当前唯一策略实现为：

```text
src/core/strategy/index.ts
createMultiIndicatorTradingStrategy
```

它实际负责：

- MFI、KDJ、RSI、PSY 等信号因子条件；
- 条件组之间的 OR；
- 组内最少满足 N 项的 N-of-M 求值；
- BUYCALL、SELLCALL、BUYPUT、SELLPUT 四种动作候选；
- 生成阶段的卖出买单存在性检查；
- immediate/delayed 分类；
- `triggerTime` 计算；
- 初始验证指标值捕获；
- 策略原因文本生成。

它不应负责：

- 最终订单数量；
- 智能平仓选单；
- 订单类型；
- 账户、现金、持仓和牛熊证风险；
- 席位版本授权；
- 订单提交、撤单和改单；
- 保护性清仓或末日清仓。

### 2.3 当前延迟验证的实际位置

当前延迟验证链路为：

```text
K 线更新
  -> signalPipeline
  -> strategy.generateSignals()
  -> delayedSignalVerifier.addSignal()
  -> pendingSignals Map + timer
  -> performVerification()
  -> verifiedCallbacks 广播
  -> registerDelayedSignalHandlers
  -> 直接进入买卖队列
```

当前存在的结构性问题：

- pending key 只有 `symbol:action:triggerTime`，没有 strategy/evaluation owner；
- verifier 只有一张全局 Map，未来多个策略会相互覆盖；
- verified callback 是广播式，策略 A 的结果无法精确路由到自己的决策；
- `performVerification()` 在宿主 async 模块中持有 T0/T+5/T+10、动作方向和 ADX 特殊规则；
- `signalPipeline` 和 indicator profile 仍从 monitor 级 `verificationIndicatorsBySide` 重新推导验证指标；
- 验证失败仅删除 pending 并记录日志，宿主无法收到明确的 `NO_SIGNAL` 结算；
- immediate 候选和 delayed 候选当前都可绕过跨策略屏障直接入队；
- `timeWakeupEvaluationProgram`、席位清理、午夜清理和 shutdown 都是单 verifier 调用点。

### 2.4 架构裁决

本次必须区分两类边界：

1. **策略业务语义边界**：由日内回归策略拥有。包括因子、延迟开关、延迟规则、初始指标、验证结果和 pending 的业务含义。
2. **宿主交易决策协调边界**：由宿主拥有。包括 evaluation 关联、动作槽位屏障、策略结果收集、同槽位候选合并、席位和生命周期校验、Signal 构造与入队。

宿主拥有屏障并不等于宿主拥有延迟验证。屏障只收集策略已经提交的结果，不计算验证规则，也不制造 delayed intent。

### 2.5 可行性与合理性

该设计在现有架构上可行，理由是：

- 当前策略的核心求值基本是同步纯计算，适合改造成候选结果输出；
- 现有 indicator runtime/cache、席位版本和交易执行链路已经具备共享宿主边界；
- 延迟验证本身已经是异步链路，可以改为“策略拥有 policy/runtime，宿主接收结算结果”；
- `evaluationId`、`strategyId`、`intentId` 可以补足当前缺失的因果和 owner 关联；
- 所有策略最终共享同一订单和持仓事实，不需要复制交易资源。

但这不是简单改名。立即候选不再允许在宿主屏障打开前入队，且 `NO_SIGNAL + PENDING` 必须等待全部 pending 终态，这会改变当前信号发射时序，必须作为明确的业务变化实施和测试。

## 3. 目标架构

### 3.1 总体结构

```text
唯一 StrategyPlan
  -> 静态策略目录与严格配置校验
  -> 聚合所有策略的指标需求
  -> 共享 IndicatorRuntime / IndicatorProfile / 可选 SampleCache
  -> StrategyRuntimeSet（固定 serial）
  -> 每次事件建立 evaluationId
  -> 各策略按动作槽位提交结果
  -> Host EvaluationActionBarrier
       -> 每个动作槽位独立等待本槽位全部参与策略终态
       -> 本槽位 READY 全通过 / 否决 / 取消
  -> CandidateMerger
       -> 同方向同动作候选合并
  -> Host Signal Adapter
  -> 共享 buy/sell task queue
  -> 现有 BuyProcessor / SellProcessor
  -> 现有风险、Trader、OrderExecutor、OrderMonitor、Settlement
```

日内回归延迟路径为：

```text
IntradayRegressionStrategyRuntime
  -> IntradayRegressionVerificationPolicy
  -> IntradayRegressionVerificationRuntime
       -> 注入共享 sample cache / timer / cancel infrastructure
       -> pending validation
       -> settle READY 或 NO_SIGNAL
  -> Host EvaluationActionBarrier
```

宿主不会出现一个对所有策略开放的 `DelayedCapability` 或通用验证业务 API。

### 3.2 共享与隔离矩阵

| 能力/数据 | 范围 | 是否按策略隔离 | 说明 |
|---|---|---:|---|
| 当前 monitor K 线源 | monitor | 否 | 所有策略使用同一数据源 |
| 指标计算 runtime | monitor | 否 | 按全部策略需求并集计算 |
| 指标 profile | monitor | 物理共享 | 策略只能收到自身需求的只读投影 |
| indicator sample cache | monitor 时间轴 | 否 | 仅为日内回归验证保存所需样本 |
| 策略配置 | strategy instance | 是 | 静态、不可变 |
| `strategyId` / `intentId` | strategy/evaluation | 是 | owner、路由、去重、审计 |
| 日内回归验证 policy | 日内回归策略 | 是 | 唯一延迟业务语义 owner |
| delayed pending/timer | 日内回归策略/evaluation | 是 | 非持久化、按 intent 隔离 |
| evaluation/action barrier | monitor/evaluation/slot | 否 | 宿主协调状态，不按策略持有 |
| LONG/SHORT 席位 | monitor direction | 否 | 继续由宿主共享管理 |
| OrderRecorder | monitor/account | 否 | 不按 strategyId 分账 |
| PositionCache | monitor/account | 否 | 不按 strategyId 分账 |
| DailyLoss/P&L/浮亏 | monitor/account | 否 | 不按 strategyId 分账 |
| 买入/卖出风险限制 | monitor/account | 否 | 继续使用现有处理器 |
| 买卖任务队列 | monitor | 否 | 统一屏障后共享入队 |
| broker mutation | account | 否 | 继续由现有执行层收口 |
| 真实订单/成交事实 | account/monitor | 否 | 不产生策略级账本 |
| strategy provenance | transient intent/optional audit | 是 | 只记录贡献者，不改变交易事实 |

### 3.3 策略身份与评估身份

每个策略实例必须拥有稳定、唯一的：

```text
strategyId
```

每个被业务事件实际消费的共享 snapshot 必须生成：

```text
evaluationId
```

每个已声明的策略动作槽位（包括最终为 `NO_SIGNAL` 的槽位）必须生成：

```text
intentId
```

普通 evaluation、候选和 pending 必须携带以下不可变事实：

```text
runtimeEpoch
tradingDayKey
monitorSymbol
direction
operation
seatVersion
evaluationAtMs
```

普通席位授权 token 固定为 `runtimeEpoch + direction + seatVersion + symbol`：`SymbolRegistry` 是 seat symbol 与 seatVersion 的唯一真相源；此处 `symbol` 指 LONG/SHORT 席位标的，不是 `monitorSymbol`，且它是匹配条件而不是代际身份。`runtimeEpoch` 由宿主运行时单例持有，在一个活动 runtime 内稳定；仅在交易时段结束、停机、跨日清理或重建切换前失效/递增，绝不按 evaluation 创建。

这些身份用于：

- 屏障关联；
- 延迟 pending 路由；
- callback 归属；
- 同一 evaluation 内去重和冲突记录；
- 迟到结果丢弃；
- transient provenance 和可选审计。

它们不得作为以下事实的分区键：

- OrderRecord 买单成本和数量；
- PositionCache；
- PendingSellInfo 共享占用；
- DailyLoss、浮亏和持仓上限；
- 共享订单和成交结算。

### 3.4 关键不变量

- 同一 evaluation 的所有策略收到相同的 immutable evaluation facts：runtimeEpoch、evaluationId、evaluationAtMs、席位快照和共享仓位视图；每个策略只收到自己的私有指标投影；
- 每个策略每个已声明动作槽位一次 evaluation 只能提交一个终态或一个 pending；
- 屏障未释放前任何普通候选不得进入买卖队列；
- 迟到、重复、取消后的结果不得重新打开屏障；
- 只有策略拥有的日内回归 runtime 可以创建延迟 pending；
- 普通策略不得通过配置、类型、回调或状态间接获得延迟能力；
- 保护性、末日和静态风险清仓仍由专用宿主路径负责；
- 共享订单和持仓事实永远不按 strategyId 拆分。

## 4. 策略契约设计

### 4.1 策略输入

策略只接收不可变、只读的评估 DTO：

```ts
type StrategyEvaluationInput = Readonly<{
  readonly runtimeEpoch: number;
  readonly evaluationId: string;
  readonly evaluationAtMs: number;
  readonly marketFacts: Readonly<{
    readonly price: number;
    readonly changePercent: number | null;
  }>;
  readonly seatSnapshot: Readonly<{
    readonly longSymbol: string | null;
    readonly shortSymbol: string | null;
    readonly longSeatVersion: number;
    readonly shortSeatVersion: number;
  }>;
  readonly sharedPositionView: SharedPositionView;
  readonly strategyIndicators: Readonly<Record<string, number | null>>;
}>;
```

宿主在 evaluation 开始时捕获有限的 `evaluationAtMs`；它不是可变 `Date`，也不是 K 线 `observedAtMs`。整个 DTO（包括 `SharedPositionView`）只能携带有限 primitive 值；所有时间字段使用 `...AtMs: number`，不得携带可变 `Date`、`Map`、`Set` 或可写引用。`strategyIndicators` 是宿主按该策略 requirements 构造的唯一指标输入，不是整个 monitor 的 union profile；完整 `IndicatorSnapshot` 只留在宿主、指标 runtime、cache 与 display 路径，策略无法观察其他策略为计算而引入的指标或周期。策略给出的 `reasonCode` 只能来自自身投影；如需完整 snapshot display，只能由宿主在结果离开策略后补充，且不得回传给策略。

`SharedPositionView` 可以提供：

- 当前 LONG/SHORT 是否有共享持仓；
- 当前方向的共享买单摘要；
- 成交数量、价格和时间；
- 当前可用数量摘要。

不能提供：

- `recordLocalBuy`；
- `recordLocalSell`；
- `clearBuyOrders`；
- `refreshOrders...`；
- `submitSellOrder`；
- Trader、broker 或任何共享账本写入接口。

### 4.2 动作槽位与显式参与者

动作槽位固定为：

```text
LONG  + OPEN  -> BUYCALL
LONG  + CLOSE -> SELLCALL
SHORT + OPEN  -> BUYPUT
SHORT + CLOSE -> SELLPUT
```

每个策略 descriptor 必须显式声明：

```text
declaredSlots
```

`declaredSlots` 是 barrier 参与者的唯一真相源，且每个 descriptor 必须至少声明一个槽位。对于 `intradayRegression`，有效（非 null）的 `signalFactors` action keys 必须与 `declaredSlots` 完全相同；缺失、额外、重复或不一致均为 pre-gate 配置错误。未来 strategy kind 必须在自己的严格 params schema 中定义与 `declaredSlots` 的对应关系，不能留给运行时推断。

未声明某槽位的策略为 `EXCLUDED`，不参与该槽位、不产生否决。

已声明某槽位的策略必须在每次评估中提交以下之一：

- `READY`：立即候选已经成立；
- `PENDING`：日内回归策略已形成延迟 intent，宿主正在或已经原子登记延迟验证；
- `NO_SIGNAL`：已完成判断但条件未满足、共享卖出买单前置不存在或验证失败。

策略不得通过“本次不返回结果”逃避参与者结算。缺少已声明槽位结果属于契约错误，不得让宿主永久等待。

### 4.3 策略结果

策略结果不得直接是可执行 `Signal`，而是以 `status` 为判别字段的只读 `StrategySlotOutcome` 联合：

```text
type StrategySlotOutcome = ReadyOutcome | PendingOutcome | NoSignalOutcome

SlotIdentity
  runtimeEpoch + evaluationId + strategyId + intentId + direction + operation + symbol + seatVersion

READY
  identity: SlotIdentity
  status: READY
  candidate: ReadyCandidate

PENDING
  identity: SlotIdentity
  status: PENDING
  pendingValidation: PendingValidation

NO_SIGNAL
  identity: SlotIdentity
  status: NO_SIGNAL
  reasonCode
```

`READY` 必须携带 candidate 且必须对应捕获时 ACTIVE 的非空 seat symbol；`PENDING` 必须携带 pendingValidation 且同样要求非空 ACTIVE seat symbol；`NO_SIGNAL` 不得携带二者，可携带冻结的 null symbol。`ReadyCandidate` 只包含 `origin: IMMEDIATE | DELAYED_VERIFIED`、`triggerTimeMs`、`reasonCode` 及必要 provenance；初始 READY 只能是 `IMMEDIATE`，`DELAYED_VERIFIED` 只能由同一 pending 成功结算时的宿主构造，策略不得伪造。identity 与宿主捕获的 seat token 只存在于 `SlotIdentity`，避免外层与 candidate 身份不一致。策略只能回显 input 中冻结的 runtimeEpoch/席位事实；lifecycle 按 frozen evaluation context 校验其相等性，任何不一致都是契约错误；校验通过后仅存储宿主构造的 canonical identity，绝不信任策略自行作出的授权判断。

候选不允许包含：

- `HOLD`；
- `quantity`；
- `orderTypeOverride`；
- `relatedBuyOrderIds`；
- `isProtectiveLiquidation`；
- 末日清仓或保护性清仓命令；
- 由策略自行决定的 `seatVersion` 授权结果。

宿主在最终屏障释放和当前事实校验之后，才构造普通 `Signal`。

### 4.4 日内回归策略专属结果

日内回归策略是唯一可以在某个槽位返回 `PENDING` 的策略。

同一个日内回归策略、同一个 evaluation、同一个动作槽位只能二选一：

```text
立即配置且条件成立 -> READY
延迟配置且条件成立 -> PENDING
```

不得同时产生立即候选和延迟候选。延迟验证通过后，原 pending 结算为 `READY`；验证失败、缺样本或样本无效结算为 `NO_SIGNAL`。scheduler 注册失败、verifier 内部异常等内部错误不得伪装为 `NO_SIGNAL`，必须走宿主 abort/fatal 路径。

其他策略：

- 不包含延迟配置字段；
- 输出只能是 `READY` 或 `NO_SIGNAL`；
- 不能返回 `PENDING`；
- 不能调用日内回归验证 runtime。

### 4.5 策略纯度与执行边界

策略评估期间不得：

- 调用 Trader 或 broker；
- 写入 OrderRecorder、PositionCache、DailyLoss 或风险缓存；
- 直接向 buy/sell task queue 入队；
- 直接构造可执行 Signal；
- 自行检查或写入最终订单数量；
- 自行执行保护性清仓或末日清仓。

卖出候选仍可以保留“共享买单存在才有资格生成”的业务门槛，但只能读取宿主提供的只读摘要；执行阶段必须重新读取最新持仓、订单、行情和可卖数量。

## 5. 日内回归策略专属延迟验证

### 5.1 业务 owner

以下规则全部属于 `IntradayRegressionStrategyRuntime`：

- 是否启用延迟；
- 买卖侧 delay 秒数；
- 验证指标列表；
- 初始指标值捕获；
- `triggerTime`；
- T0、T0+5 秒、T0+10 秒样本选择；
- 普通指标按动作方向的比较；
- ADX 的统一下降规则；
- 缺失/无效样本的失败语义；
- 验证成功或失败向宿主提交什么结果。

宿主不得从 monitor 级旧配置重新推导上述规则，也不得在回调层重算验证条件。

### 5.2 物理结构

建议将现有通用 verifier 的业务逻辑收敛到日内回归策略边界：

```text
src/core/strategy/intradayRegression/
  strategy
  types
  requirements
  verificationPolicy
  verificationUtils

src/main/strategyRuntime/
  strategyRuntimeSet
  evaluationActionBarrier
  candidateMerger
  intradayRegressionVerificationRuntime
```

timer、scheduler、sample cache 和生命周期取消可以继续位于 async/composition 层，但只能作为注入的基础设施端口使用。

不保留向所有策略公开的：

```text
DelayedCapability
StrategyVerificationIntent
registerDelayedCapability()
```

现有 `src/main/asyncProgram/delayedSignalVerifier/` 如果继续保留路径名，也必须改造成只服务日内回归策略的内部 runtime；不能继续作为 monitor 级通用业务服务。

### 5.3 验证时序

日内回归策略形成延迟 intent 后：

```text
策略捕获 evaluationAtMs、triggerTimeMs、初始指标
  -> EvaluationActionBarrier 预校验并 reserve REGISTERING entry
  -> 日内回归 verification runtime arm timer
  -> entry 变为 SCHEDULED，并作为 PENDING 提交到对应 slot
  -> readyAtMs 到达
  -> 读取 T0、T0+5s、T0+10s
  -> 执行策略自己的 verificationPolicy
  -> 成功：向原 evaluation/slot 结算 READY(candidate)
  -> 业务失败：向原 evaluation/slot 结算 NO_SIGNAL(reason)
  -> 宿主重新计算该槽位屏障
```

`submitInitialOutcome(PENDING)` 必须同步进入内部 `registerPending` 事务：先写入 barrier reservation 与内部 `REGISTERING` entry，才调用 scheduler。callback 可以在 `scheduleTimer()` 返回前到达，但在 `REGISTERING` 期间只能记录 provisional outcome，绝不能 release。scheduler 正常返回后：若 entry 仍 live，则写入 handle 并转为 `SCHEDULED`；若已有 provisional outcome，则立即清理返回 handle，再提交该 outcome；若已取消则清理 handle。scheduler throw 时丢弃 provisional outcome 并 `abortRuntime(error)`，因此“同步 callback 后 throw”也不会先释放或入队。verifier 内部异常同样必须使普通 evaluation 进入宿主 abort/fatal 路径，不能留下 PENDING。

验证结果不得直接写入买卖队列。通过后的 `READY` 必须回到原 evaluation 的宿主屏障，等待同槽位其他参与策略完成后，才进入该槽位候选合并；它不等待、否决或影响同方向另一动作槽位。

### 5.4 当前验证语义

除下述已明确的 trigger-time 归一化外，本次迁移必须保持当前日内回归策略的验证样本与比较行为：

- 当前实现会为每个动作单独调用 `clock.now()`；为满足同一 evaluation 固定时间事实这一新契约，本方案有意改为宿主在 evaluation 开始时捕获一次 `evaluationAtMs`。立即 READY 的 `triggerTimeMs` 固定为 `evaluationAtMs`；延迟 intent 的 `triggerTimeMs` 固定为 `evaluationAtMs + delaySeconds × 1_000`，`readyAtMs = triggerTimeMs + VERIFICATION.READY_DELAY_SECONDS × 1_000`；callback、settlement、合并和 adapter 均不得重新读取时钟或改写这些毫秒值；
- `delayedVerification` 仅在 `delaySeconds > 0` 且验证指标非空时生效；`delaySeconds = 0` 或空指标必须按当前语义产生 immediate READY/NO_SIGNAL，不得创建 PENDING、timer 或 cache；
- 目标时间为 T0、T0+5 秒、T0+10 秒；每个目标时间独立从当前 retention window 读取最接近的缓存样本，无时间容差；
- 最近样本可早于或晚于目标时间；等距时选择较晚样本；同一缓存样本允许命中多个目标时间。这是允许的，行情长期不变化时不要求三个不同样本；
- `BUYCALL`、`SELLPUT` 的普通验证指标三个目标查询结果均严格高于初始值；
- `BUYPUT`、`SELLCALL` 的普通验证指标三个目标查询结果均严格低于初始值；
- ADX 无论动作方向均要求三个目标查询结果严格低于初始值；
- 任一目标查询没有保留样本，或任一指标缺失/无效，验证失败；
- 失败不回退成立即信号；
- 开盘保护阻止新普通评估，但不取消已经存在的 pending；
- 末日接管、跨日、席位退出、停机和销毁取消相关 pending；
- 回流前重新校验交易门禁、symbol、席位 ACTIVE 和 seatVersion。

### 5.5 pending、结算与去重

每个 pending 必须携带：

```text
runtimeEpoch
evaluationId
strategyId
intentId
direction
operation
symbol
seatVersion
triggerTimeMs
readyAtMs
initialIndicators
verificationIndicators
policyId
```

去重 key 至少包含：

```text
strategyId + evaluationId + intentId
```

不得继续只使用：

```text
symbol + action + triggerTime
```

同一 evaluation 内重复登记同一 intent 必须幂等忽略；不同 evaluation 即使 symbol、action、triggerTime 相同，也必须独立收敛。

`EvaluationActionBarrier` 是每个 evaluation 的内部状态机；`OrdinaryEvaluationLifecycle` 独占全部 barrier 的集合和唯一外部入口。初始 outcome、pending 登记和 settlement 都经 lifecycle 按 identity 路由到其 barrier；只有 lifecycle 可以发起跨 slot/evaluation 的失效，任何调用方都不得持有 barrier、pending Map 或 timer。所有 pending 结果必须通过同一幂等入口：

```text
settlePending(
  pendingIdentity,
  READY(candidate) | NO_SIGNAL(reasonCode) | CANCELLED(reasonCode),
)
```

正常业务失败只能产生 `NO_SIGNAL`；席位/生命周期失效产生 `CANCELLED`；scheduler throw、verifier 内部异常和 coordinator 不变量错误通过 `abortRuntime(error)` 进入 fatal，不伪装为业务 settlement。每次入口都比较完整 SlotIdentity（含 `runtimeEpoch + direction + seatVersion + symbol`）；重复、过期或授权 token 不匹配的结果只记录并丢弃，绝不重新创建屏障、候选或交易任务。

本期不增加未定义的 pending/evaluation 业务 deadline：`readyAtMs` 是验证计划时刻而非超时。RuntimeScheduler 必须在未被 clear 时回调一次或在注册时抛出；静默丢失 callback 属内部 runtime 契约违反，不引入任意 fallback timeout 改变当前验证语义。

### 5.6 指标需求、profile 与 cache

`services/indicators/profile` 必须拆分两层：

1. **共享计算需求**：所有策略信号因子和日内回归验证指标的并集，用于 indicator runtime/profile/cache 初始化。
2. **策略私有验证 policy**：只保留在日内回归策略 runtime 内，包含验证指标、delay 和比较规则。

当前 monitor 级 `verificationIndicatorsBySide.buy/sell` 不得继续作为策略语义来源。

共享前提：

- 同一 monitor；
- 同一 K 线周期和时间轴；
- 同一指标算法和周期版本；
- union requirements 在首次 bootstrap 前确定；
- cache retention 覆盖日内回归最大 delay、READY_DELAY、安全余量和必要样本窗口。

如果日内回归没有有效延迟配置：

- 不创建验证 timer；
- 不创建其 pending；
- 不创建仅供验证的 sample cache；
- indicator runtime 仍可因普通信号或展示需求计算所需指标。

未来若出现不同 monitor、不同周期或不同时间轴，必须重新分区 cache，不能继续共享当前无 symbol/周期维度的单队列。

## 6. 宿主评估、就绪屏障与同槽位候选合并

### 6.1 一次事件生成一个 evaluation

对每个实际开始处理的有效 K 线事件：

1. 保留 `businessEventProgram` 现有 single-flight/latest-only 语义；
2. 共享 indicator runtime 只推进一次；
3. 生成宿主内部的不可变 snapshot，并为每个策略构造私有指标投影；
4. 生成单调的 `evaluationId` 和固定 `evaluationAtMs`；
5. 冻结当前 LONG/SHORT 席位快照、`runtimeEpoch + direction + seatVersion + symbol` 授权事实和参与策略集合；
6. 按配置顺序串行调用所有策略；
7. 每个已声明动作槽位都必须有显式结果；
8. 每个动作槽位只在自身屏障满足后独立进行候选合并、门禁复核和入队；其他动作槽位的 READY、PENDING 或 NO_SIGNAL 不影响它。

尚未开始处理的 K 线事件可以被 latest-only 折叠。已经创建的 evaluation 不因新 K 线自动取消；不同 evaluation 不互相满足、覆盖、合并或去重。

### 6.2 串行评估

首期没有 `mode` 配置字段，所有策略固定按 `strategyPlan.strategies[]` 顺序串行执行：

```text
strategy[0] -> strategy[1] -> ... -> strategy[n]
```

规则：

- 每个策略收到相同的 immutable evaluation facts 与自己的私有指标投影；
- 后一个策略不能读取前一个策略的可变状态或候选输出；
- serial 只约束策略评估顺序，不约束延迟 callback 到达顺序；
- serial 不代表 broker 全局 FIFO；买卖处理器继续按现有独立队列工作；
- 任一策略内部异常时，本 evaluation 不得部分入队，并进入既有 fatal/error 通道。

并行评估不属于本期配置或实现。未来如重新引入，必须另行证明异步 route、stop/drain、latest-only、错误收口和结果顺序不变。

### 6.3 动作槽位屏障

屏障 key 为：

```text
evaluationId + direction + operation
```

屏障参与者是在该 evaluation 开始时冻结的、显式声明该槽位的策略集合。

每个参与者的结果为：

```text
READY | PENDING | NO_SIGNAL
```

未声明策略为 `EXCLUDED`，不计入成员数量。

屏障释放条件：

```text
所有参与者均已进入终态
且所有参与者均为 READY
```

`NO_SIGNAL` 不会让该槽位屏障提前结束；如果该槽位还有 pending，宿主仍等待全部 pending 结算。全部结算后，只要存在 `NO_SIGNAL`，该槽位最终抑制，不释放候选；其他动作槽位不受影响。

### 6.4 屏障真值表

双策略在同一 evaluation、同一方向和同一动作槽位的结果：

| 策略 A | 策略 B | 屏障行为 | 最终结果 |
|---|---|---|---|
| `READY` | `READY` | 全部终态 | 合并为一个共享候选 |
| `READY` | `PENDING` | 等待 B | B 成功后继续；B 失败后不释放 |
| `READY` | `NO_SIGNAL` | 若无其他 pending 则完成；否则继续等待 | 最终不释放 |
| `PENDING` | `PENDING` | 等待全部 | 全部成功才释放 |
| `PENDING` | `NO_SIGNAL` | 仍等待 pending 终态 | 最终不释放 |
| `NO_SIGNAL` | `NO_SIGNAL` | 全部终态 | 不释放 |
| `EXCLUDED` | `READY` | A 不参与 | B 可按单参与者结果继续 |
| `EXCLUDED` | `EXCLUDED` | 无参与者 | 不创建普通信号 |

这套逻辑意味着：

- 一个立即策略已经 `READY`，仍必须等待日内回归策略的 `PENDING`；
- 日内回归验证失败后结算 `NO_SIGNAL`，不会回退成立即信号；
- 一个策略 `READY`、另一个策略 `NO_SIGNAL`，即使 pending 已全部收口，也不生成信号；
- `NO_SIGNAL + PENDING` 仍等待全部终态，以保证 timer、callback 和屏障计数完整收口。

### 6.5 状态 owner、取消与 abort scope

策略初始 outcome 只有 `READY | PENDING | NO_SIGNAL`；它们不承载生命周期或内部错误。`EvaluationActionBarrier` 只应用单个 evaluation 的内部事件；`OrdinaryEvaluationLifecycle` 是唯一外部路由和 lifecycle owner，并维护以下 scope：

- **slot cancellation**：只关闭指定 action slot；不会影响同方向另一 OPEN/CLOSE slot；
- **direction cancellation**：席位退出、symbol 变更或 seatVersion 代际变化时关闭该方向全部 slot；
- **runtime cancellation**：交易时段结束、末日接管、跨日和 stop 时关闭全部普通 evaluation；
- **runtime abort**：scheduler/verifier/coordinator 内部错误立即关闭 admission/release、使当前 runtime epoch 失效并进入既有 fatal 通道。

`quiesce` 的 scope 必须是判别联合：`{ kind: 'slot', evaluationId, direction, operation }`、`{ kind: 'direction', direction }` 或 `{ kind: 'runtime' }`。不得仅凭 symbol/action 模糊清理；queue envelope 以 evaluationId 和授权 token 精确匹配该 scope。

唯一允许的迁移为：

| 当前状态 | 事件 | 新状态 |
|---|---|---|
| 未提交 | 初始 READY / NO_SIGNAL | 对应 slot 终态 |
| 未提交 | `registerPending` reserve | `REGISTERING` |
| `REGISTERING` | 同步 `settlePending(READY / NO_SIGNAL)` | `REGISTERING` + provisional outcome，尚不 release |
| `REGISTERING` | scheduler 正常返回 | 无 provisional outcome 则内部 `SCHEDULED`（对 barrier 暴露为 `PENDING`）；有 outcome 则提交对应 slot 终态 |
| `SCHEDULED` | `settlePending(READY / NO_SIGNAL)` | 对应 slot 终态 |
| `REGISTERING` | scheduler throw | runtime `ABORTED`，丢弃 provisional outcome |
| `REGISTERING` / `SCHEDULED` | `quiesce(scope)` | `CANCELLED(reason)` |
| 任一 live ordinary state | `abortRuntime(error)` | runtime `ABORTED`，不再 release |
| 任一终态、过期 identity 或完整授权 token 不匹配 | 任意重复/迟到事件 | no-op |

`READY` 只表示候选已完成，不表示交易门禁或 broker 授权；`NO_SIGNAL` 是正常业务否决。`CANCELLED(reasonCode)` 只由 lifecycle scope 结算，且 scope 必须显式携带。`ABORTED` 是 runtime abort 事件，不是策略 slot outcome；quiesce 必须移除仍在队列中的匹配 `kind: 'ORDINARY'` envelope，绝不清除专用清仓任务。processor 在所有 freshness/卖量计算完成后、调用 `trader.executeSignals` 前必须以 envelope 执行一次 `lifecycle.canExecuteOrdinary` 检查；quiesce 先赢则零 trader 调用，已进入 `trader.executeSignals` 的 broker request 无法回写或撤回。一个 evaluation 在其已创建 slot 全部 release、抑制或 cancellation 后结束。任何事件都必须携带原始 identity 和完整授权 token。

### 6.6 同方向 OPEN/CLOSE 槽位独立性

同一 `evaluationId`、同一方向的 OPEN 与 CLOSE 是不同动作槽位，不建立方向级仲裁器。

规则：

1. 每个动作槽位只等待自身参与策略的结算；
2. 某一槽位自身的 `PENDING`、`NO_SIGNAL`、slot cancellation 或候选合并不影响另一槽位；仅 §6.5 定义的 direction/runtime quiesce 可同时失效多个槽位；
3. `BUYCALL` 与 `SELLCALL` 独立，`BUYPUT` 与 `SELLPUT` 也独立；
4. 同方向 OPEN 与 CLOSE 在同一 evaluation 均产生有效候选时，各自完成门禁复核后分别构造普通 Signal 并写入既有买/卖队列；
5. LONG 与 SHORT 同样独立。

买入和卖出处理器已使用独立队列，因此本层不定义 OPEN/CLOSE 优先级，也不因另一动作存在 pending 或候选而延迟、取消或 fail-closed。

### 6.7 同槽位候选合并

最终进入 `CandidateMerger` 的必须是已通过该动作槽位屏障的 READY 候选：

- 同一方向、同一动作的多个策略候选合并为一个共享意图；
- 合并不累加数量；
- 每个已释放动作槽位只创建一个共享 Signal；
- contributor strategy IDs 只能进入 provenance/审计；
- `quantity` 由现有 BuyProcessor/SellProcessor 根据共享事实计算；
- CLOSE 的关联买单由现有 OrderRecorder 和卖出协调逻辑确定；
- 不跨 evaluation 或不同动作槽位合并或去重。

CandidateMerger 通过 `ReadyCandidate.origin` 判断来源：同槽位若有 `DELAYED_VERIFIED` contributor（首期至多一个日内回归策略），最终共享意图使用其 `triggerTimeMs`；否则使用 `evaluationAtMs`。CandidateMerger 不得重新取当前时间。延迟候选不得在验证前被合并成一个会绕过策略验证的立即意图；它只能先以 PENDING 参与本槽位屏障，验证成功后再以 READY 候选进入本槽位合并。

### 6.8 Signal 构造与共享执行

当某个动作槽位屏障释放并完成该槽位候选合并后，宿主才：

1. 重新读取普通交易门禁；
2. 校验当前席位为 ACTIVE；
3. 校验 symbol 与席位一致；
4. 校验捕获的 `runtimeEpoch + direction + seatVersion + symbol` 仍有效；
5. 由 host adapter 将方向/动作转换为普通 Signal，并仅在此边界把有效 `triggerTimeMs` 转为 `Date`；
6. 创建 `kind: 'ORDINARY'` 的共享 task-queue provenance envelope，携带 `evaluationId + runtimeEpoch + direction + operation + seatVersion + symbol`，以便 lifecycle 精确按 slot/direction/runtime 清理；专用清仓任务保持其既有独立 kind，envelope 不向 broker 传递策略级交易事实；
7. 写入共享 buy/sell task queue。

BuyProcessor/SellProcessor 在现有风控、freshness、卖量和 seat 校验完成后，必须在实际调用 `trader.executeSignals` 前用 envelope 调用 `OrdinaryEvaluationLifecycle.canExecuteOrdinary`；任何由普通任务派生的 retry 也必须保留同一 envelope，并在重新入队前执行该检查。检查失败只丢弃普通任务/retry，不影响专用清仓路径。

随后继续使用既有：

- `BuyProcessor` 风险优先流水线；
- `SellProcessor` freshness、智能平仓和 HOLD 语义；
- 订单提交、撤单、改单和盯单；
- 保护性清仓、末日清仓和静态风险清仓；
- 成交事实、订单记录、损益和持仓刷新。

## 7. 配置模型与装配

### 7.1 唯一配置模型

`MonitorConfig` 不再在根部同时保存：

```text
signalConfig
verificationConfig
strategyPlan
```

改为只保存一个静态策略计划：

```text
MonitorConfig
  ├── monitorSymbol
  ├── LONG/SHORT 席位与自动寻标
  ├── targetNotional / maxPositionNotional
  ├── 风控、冷却、订单类型、末日保护
  └── strategyPlan
       └── strategies[]
```

首期 `strategyPlan` 固定为串行语义，不增加 `mode` 字段：

```ts
type StrategyPlan = Readonly<{
  readonly strategies: ReadonlyArray<StrategyDescriptor>;
}>;
```

数组顺序就是串行评估顺序。

### 7.2 日内回归 descriptor

当前策略的规范化 descriptor 为：

```text
{
  id: string,
  kind: "intradayRegression",
  declaredSlots: readonly StrategyActionSlot[],
  params: {
    signalFactors: ...,
    delayedVerification?: ...
  }
}
```

`declaredSlots` 位于 descriptor 顶层，是参与者集合的唯一权威来源且不能为空；`intradayRegression` 的有效 `signalFactors` keys 必须与其完全一致。`signalFactors` 包含现有四类动作和条件组；`delayedVerification` 只属于该 descriptor 的参数，且仅在 delay 大于零、验证指标非空时产生延迟能力。

同一 monitor 最多一个 `kind: "intradayRegression"` descriptor。其他 descriptor 必须是立即策略，且其 params schema 中不存在：

```text
verification
verificationConfig
delayedVerification
delaySeconds
```

未来增加其他策略时，必须以显式判别联合和静态目录接入；未实现的策略 kind 不得进入 parser 白名单。

### 7.3 外部配置入口

外部只保留一个结构化入口：

```text
STRATEGY_PLAN_JSON
```

读取后必须：

1. 解析 JSON；
2. 严格校验未知字段、必填字段和类型；
3. 转换为不可变 `StrategyPlan`；
4. 解析为静态策略 descriptor；
5. 在 pre-gate 完成全部能力和需求验证。

不得使用：

```ts
JSON.parse(raw) as StrategyPlan
```

生产配置切换只有四种状态：

| `STRATEGY_PLAN_JSON` | 以下任一旧键 | 行为 |
|---|---|---|
| 有效且非空 | 均不存在或空白 | 接受新模型 |
| 有效且非空 | 任一存在 | fail-fast：mixed 配置 |
| 不存在或空白 | 任一存在 | fail-fast：legacy-only 配置 |
| 不存在或空白 | 均不存在或空白 | fail-fast：缺少策略计划 |

旧键集合必须精确为：`SIGNAL_BUYCALL`、`SIGNAL_SELLCALL`、`SIGNAL_BUYPUT`、`SIGNAL_SELLPUT`、`VERIFICATION_DELAY_SECONDS_BUY`、`VERIFICATION_DELAY_SECONDS_SELL`、`VERIFICATION_INDICATORS_BUY`、`VERIFICATION_INDICATORS_SELL`。如需要迁移，只允许独立的一次性离线 converter 读取该集合；生产 parser/validator 不保留旧读取路径或 fallback。converter 必须保持四动作映射、BUY verification 对应 `BUYCALL`/`BUYPUT`、SELL verification 对应 `SELLCALL`/`SELLPUT`，以及空指标、`delay=0`、旧缺失 delay 默认 60 秒的现有语义。

### 7.4 配置校验

pre-gate 必须 fail-fast 校验：

1. strategy plan 存在且为 object；
2. strategies 为非空数组；
3. strategy ID 非空、格式合法且唯一；
4. kind 存在于静态策略目录；
5. params 按 kind 使用严格判别联合校验；
6. 未知字段拒绝；
7. 日内回归 descriptor 数量不超过一个；
8. 非日内回归策略出现延迟字段直接拒绝；
9. 日内回归信号因子、周期、阈值、delay 和验证指标合法；`delay=0` 或空验证指标必须规范化为 immediate-only；
10. 每个 descriptor 的 `declaredSlots` 非空、明确、无重复，并满足其 kind 的 factor/slot 对应关系；
11. 所需指标、周期、历史深度和数据源可用；
12. 仅接受 JSON-only 配置；mixed、legacy-only 和 neither 均为配置错误；
13. 不因配置错误静默删除策略或回退到其他策略；
14. 不支持的 future kind 不得被当作立即策略占位运行。

### 7.5 装配顺序

```text
createPreGateRuntime
  -> createTradingConfig
  -> parse StrategyPlan
  -> validate StrategyPlan
  -> resolve static strategy definitions
  -> calculate per-strategy requirements
  -> validate and freeze declared slots
  -> create immutable assembly plan

createPostGateRuntime
  -> create one shared account/trader/risk/order resource set
  -> aggregate indicator requirements
  -> compile shared profile/runtime
  -> create optional sample cache
  -> create IntradayRegressionStrategyRuntime（若配置存在）
  -> create StrategyRuntimeSet
  -> create EvaluationActionBarrier host component
  -> create shared MonitorContext
  -> register lifecycle and seat cleanup hooks
  -> start business event and processors
```

只创建一套：

- Trader；
- OrderRecorder；
- RiskChecker；
- PositionCache；
- MonitorContext；
- 买卖处理器；
- monitor 级指标 runtime。

### 7.6 禁止运行时热切换

- StrategyPlan 在进程构造阶段确定；
- 运行时不提供 `setStrategy`、`replaceStrategy`、`reloadStrategy`；
- 不允许运行中重新读取环境变量或 JSON 改变参与者集合；
- barrier 的参与者集合在每次 evaluation 开始时冻结；
- 配置变化必须通过进程重启生效；
- 本期不建立策略配置 fingerprint 的持久化恢复协议。

## 8. 瞬时状态与生命周期

### 8.1 首期无策略持久化状态

本期策略实现以无状态策略为前提。以下都是进程内 transient 状态，不进入持久化：

- `READY/PENDING/NO_SIGNAL` 槽位结果；
- EvaluationActionBarrier；
- pending validation；
- timer、Promise、callback；
- held immediate candidate；
- indicator sample cache；
- runtimeEpoch、evaluationId 和捕获的席位授权 token；
- 尚未入队的普通 Signal。

因此本期不新增：

```text
StrategyStateRepository
StrategyStateEnvelope
DecisionStore
DurableOutbox
```

未来若引入真正的 stateful strategy，必须另立方案，明确其 state scope、状态版本、恢复顺序和 crash 语义，不能从本方案的 transient 状态推导。

### 8.2 Evaluation 独立收敛

每个 evaluation 的屏障和 pending 只属于它自身：

- 新 evaluation 不会自动满足旧 evaluation；
- 旧 evaluation 不会写入新 evaluation 的 slot；
- 新 K 线不会自动取消已创建 pending；
- 同 symbol/action/triggerTime 的不同 evaluation 不互相 dedupe；
- 旧 evaluation 最终入队前仍需重新过当前门禁和 seatVersion；
- 进程重启、跨日和 runtime epoch 变化会使所有旧 evaluation 失效。

这是对当前“新 K 线不自动删除既有 delayed pending”行为的明确保留。

### 8.3 普通门禁与屏障的关系

- 生命周期交易开关关闭时，不创建新的普通 evaluation 或不开放其释放；
- 开盘保护期间阻止新普通策略评估；已有日内回归 pending 不因开盘保护统一取消；
- pending 回流时继续经过普通门禁，门禁不满足则该 evaluation 不得入队；
- 末日清仓接管后，普通候选、屏障和日内回归 pending 不再产生交易副作用；
- 保护性清仓、末日清仓和静态风险清仓仍走其专用宿主路径，不等待普通屏障。

### 8.4 唯一 lifecycle owner 与席位切换

`createPostGateRuntime` 必须创建一个 app-owned `OrdinaryEvaluationLifecycle`，并注入 `timeWakeupEvaluationProgram`、`seatRuntimeCleanupDispatcher`、`signalRuntimeDomain`、`runApp` cleanup 与日内回归 runtime。它初始处于 quiesced 状态；普通门禁和必要 runtime 就绪后才激活第一个 epoch。除该 owner 外，任何调用点不得直接操作 barrier、pending Map、timer 或 held candidate。

其唯一的线性化 API 是：

```text
activateRuntime()
submitInitialOutcome(outcome)
settlePending(identity, outcome)
canExecuteOrdinary(envelope)
quiesce(scope, reason)
abortRuntime(error)
```

`quiesce` 必须按以下顺序执行：关闭对应 scope 的 admission/release → runtime scope 失效 runtimeEpoch，direction scope 使捕获的席位授权 token 不再 live → 将相关 pending/slot 以 `CANCELLED(reason)` 收口 → 取消匹配的验证 timer 与 ordinary task retry timer → 移除 scope 匹配的 held candidate 与 ordinary task envelope → 使正在运行和后续 callback 只能通过 token 检查后 no-op。`abortRuntime(error)` 必须先以 `{ kind: 'runtime' }` 执行同一清理序列，再进入既有 fatal 通道。`submitInitialOutcome` 与 `settlePending` 只接受仍有效的 identity/token，并路由到所属 barrier；内部 `registerPending` 不对其他调用方暴露。`canExecuteOrdinary(envelope)` 仅在普通门禁打开、envelope runtimeEpoch 仍为 active、且当前 ACTIVE seat 的 direction/version/symbol 均匹配时返回 true。拒绝结果不得重建状态、入队或调用 trader。重复 `quiesce`、stop 与午夜重试必须幂等。

`seatRuntimeCleanupDispatcher` 必须消费每个 `SeatStateChangedEvent`，比较 previous/next status、symbol、previousVersion 与 nextVersion；不再仅处理 `ACTIVE -> 非 ACTIVE`。对任何 ACTIVE 退出、symbol 重绑、ACTIVE 状态下的 version bump 或新授权激活，事件 listener 的第一项清理操作必须是 `quiesce({ kind: 'direction', direction }, SEAT_CHANGED)`；queue/held candidate 清理由 owner 在该事务内完成，listener 不得再直接操作它们。会移除、重绑或重新授予 ACTIVE 席位授权的 mutation 必须使用 `updateSeatStateWithVersionBump`；普通 `updateSeatState` 只可用于 previous/next 均非 ACTIVE 的状态推进，或保持 ACTIVE symbol 和授权版本不变的元数据更新。旧候选即使同 symbol 重新激活也不能重新获得授权。LONG 与 SHORT 分别清理，不因一侧换标阻塞或清除另一侧有效 evaluation。

### 8.5 交易时段、末日、午夜和停机

普通交易时段结束（包括午休）或进入末日接管时，`timeWakeupEvaluationProgram` 必须调用 `quiesce({ kind: 'runtime' }, SESSION_ENDED | DOOMSDAY_TAKEOVER)`；这关闭普通 release、取消全部相关 pending、移除全部 ordinary task envelope，并不影响专用清仓路径。在初始启动及每次 `canTrade: false -> true` 的连续交易时段边沿，仅对仍 quiesced 的 lifecycle，在门禁已开启且必要 runtime 已就绪后调用一次 `activateRuntime()`，创建新的 active runtimeEpoch 再开放 admission；不得复用旧 epoch、pending、candidate 或 timer。开盘保护只抑制新评估，不创建新 epoch，也不取消 active runtime 的 pending。

午夜清理顺序：

```text
OrdinaryEvaluationLifecycle.quiesce({ kind: 'runtime' }, MIDNIGHT)
  -> 停止/排空普通事件 source
  -> 清理普通策略任务、indicator cache、transient barrier/candidate
  -> 进入现有 open rebuild
  -> rebuild 成功后才创建新的 active runtime epoch 并开放 admission
```

午夜重试不得重复推进同一已失效 epoch，也不得恢复旧 callback。停机或 fatal 通过相同 owner 执行 `quiesce({ kind: 'runtime' }, STOP)` 或 `abortRuntime(error)`；新增 cleanup phase `QUIESCE_ORDINARY_EVALUATIONS = 5`，严格位于 `CLOSE_TRADING_GATE = 0` 与 `ABORT_FRESHNESS_WAITING = 10` 之间，且先于 `STOP_TIME_WAKEUP_RUNTIME = 20`。该 phase 即使后续 cleanup 失败也保持普通 admission/release 关闭。

### 8.6 一次性验证的收口契约

本期不引入任意 pending/evaluation deadline，也不以 timer 晚到改变当前样本验证语义。可验证的收口路径为：

- 正常 READY、NO_SIGNAL、缺样本或无效样本 settlement；
- 可重入 scheduler 的原子登记、同步 callback 和 returned handle 清理；
- scheduler 注册失败或 verifier/coordinator throw 的 `abortRuntime(error)`；
- seat change、末日、跨日、stop 和 fatal 的 `quiesce`；
- 完整 identity/授权 token 检查、幂等 settlement 与 late result 丢弃。

正常 `NO_SIGNAL + PENDING` 保留既定规则：只在同一动作槽位内等待全部 pending 终态，最终不释放；它不影响其他槽位。静默丢失 scheduler callback 违反 RuntimeScheduler 的一次性回调契约，是内部 runtime 故障，而非业务 `NO_SIGNAL` 或新建 fallback deadline 的理由。

## 9. 需要修改的模块边界

### 9.1 必改模块

| 模块 | 主要工作 |
|---|---|
| `src/core/strategy/types.ts` | 输入、slot、候选、结果和 requirements 契约 |
| `src/core/strategy/` | 将 `createMultiIndicatorTradingStrategy` 收敛为 `IntradayRegressionStrategy` |
| `src/core/strategy/intradayRegression/` | 日内回归因子、延迟 policy 和纯验证函数 |
| `src/types/config.ts` | StrategyPlan、descriptor、策略参数类型 |
| `src/types/state.ts` | MonitorContext 改为持有 StrategyRuntimeSet 和宿主屏障端口 |
| `src/types/monitorContextPorts.ts` | 删除单一通用 verifier port，增加策略 runtime/barrier/lifecycle 端口 |
| `src/types/runtime.ts` | 将 RuntimeScheduler 明确为“一次 callback 或注册 throw”的基础设施契约；调用方仍须支持同步 callback |
| `src/types/indicatorProfile.ts` | 从 monitor 级验证语义改为聚合计算需求模型 |
| `src/config/trading/` | 唯一 StrategyPlan parser |
| `src/config/validator/` | descriptor、declaredSlots、唯一日内回归和能力边界校验 |
| `src/services/indicators/profile/` | 从旧 signal/verification config 改为 requirements union 编译 |
| `src/app/types.ts` | pre/post gate 传递 assembly plan 和 runtime set |
| `src/app/runtime/createPreGateRuntime.ts` | 解析和校验 StrategyPlan |
| `src/app/runtime/createPostGateRuntime.ts` | 聚合 profile/cache，创建 runtime set、barrier 和唯一 OrdinaryEvaluationLifecycle |
| `src/app/context/createMonitorContext.ts` | 从单 strategy/单 verifier 改为 runtime set |
| `src/app/runApp.ts` | 装配、启动、重建和 cleanup 接入策略 set/lifecycle owner |
| `src/main/businessEventProgram/index.ts` | 生成 evaluation input、调用串行策略集合 |
| `src/main/businessEventProgram/indicatorPipeline.ts` | 按 union requirements 推进共享指标和样本 |
| `src/main/businessEventProgram/signalPipeline.ts` | 结果归一化、屏障、最终 Signal adapter 和门禁 |
| `src/main/businessEventProgram/types.ts` | evaluation、slot、barrier 和 settlement 事件类型 |
| `src/main/strategyRuntime/` | StrategyRuntimeSet、EvaluationActionBarrier、CandidateMerger、OrdinaryEvaluationLifecycle |
| `src/main/asyncProgram/delayedSignalVerifier/` | 移除通用业务语义，改为日内回归专属验证 runtime 或删除旧模块 |
| `src/main/asyncProgram/indicatorCache/` | union requirements、可选 cache 和窗口计算 |
| `src/app/wiring/registerDelayedSignalHandlers.ts` | callback 改为带 owner 的结果结算，不得直接入队 |
| `src/main/timeWakeupEvaluationProgram/` | 改为调用 OrdinaryEvaluationLifecycle quiesce，禁止直连 pending/barrier |
| `src/main/lifecycle/cacheDomains/` | 午夜、重建、epoch 和 transient barrier 清理统一经 lifecycle owner |
| `src/main/seatRuntimeCleanupDispatcher/` | 消费所有 SeatStateChangedEvent；按 status/symbol/version token 变化调用 lifecycle owner，再清理方向工作 |
| `src/main/asyncProgram/tradeTaskQueue/` | 屏障后共享入队、携带授权 token 的 provenance envelope，以及 lifecycle 按 scope 清理旧 ordinary task |
| `src/main/asyncProgram/utils.ts` / buy/sell processor | 在 `trader.executeSignals` 前及普通 retry 重新入队前按 envelope 调用 lifecycle.canExecuteOrdinary；向 lifecycle 提供 scope 化 retry timer 取消；拒绝则丢弃普通任务 |
| `src/app/types.ts` / `src/constants/cleanup.ts` / `src/app/shutdown/createCleanup.ts` | 新增 `QUIESCE_ORDINARY_EVALUATIONS = 5`，位于 gate-close(0) 与 freshness abort(10) 之间 |
| `tests/` 相关旧测试与测试替身 | 全量迁移单策略、单 profile、单 verifier 假设 |

特别不能遗漏：

- `src/main/timeWakeupEvaluationProgram/index.ts` 中交易时段结束和末日接管的 verifier 取消；
- `src/services/indicators/profile/index.ts` 的 `compileIndicatorUsageProfile` 入口；
- `src/types/monitorContextPorts.ts` 的 `DelayedSignalVerifierPort` 与 `src/types/runtime.ts` 的 RuntimeScheduler 契约；
- `src/app/runApp.ts` 的启动、重建、注册 callback 和销毁路径；
- `src/app/runtime/createPostGateRuntime.ts` 的 cache retention 和 cleanup；
- `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` 的午夜清理；
- `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` 的方向清理。

### 9.2 首期不应改变业务语义的模块

除非类型迁移确实要求调整接口，否则以下模块继续保留现有业务语义：

- `src/main/asyncProgram/buyProcessor/`；
- `src/main/asyncProgram/sellProcessor/`；
- `src/core/signalProcessor/`；
- `src/core/trader/orderExecutor/`；
- `src/core/trader/orderMonitor/`；
- `src/core/orderRecorder/`；
- `src/core/riskController/`；
- `src/core/doomsdayProtection/`；
- `src/main/tradingRiskEventRuntime/`；
- `src/main/monitorQuoteEventRuntime/`；
- `src/services/autoSymbolManager/`。

它们继续负责共享账户事实、最终执行授权、风险清仓、订单监控、成交结算和席位管理。

### 9.3 旧配置与引用清理矩阵

实施完成前必须清理以下四类残留；历史计划/归档仅可在实施清单中显式 allowlist，不能以全仓宽泛前缀扫描误报。

| 类别 | 精确检查对象 | 处理要求 |
|---|---|---|
| 配置模型、parser、validator | `MonitorConfig.signalConfig`、`MonitorConfig.verificationConfig`、`SignalConfigSet`、`VerificationConfig`、`SingleVerificationConfig`、`parseSignalConfigFromEnv`、`parseSignalConfig`、`parseVerificationDelay`、`parseVerificationIndicators` | 删除生产类型、parser、validator 和日志中的旧模型；唯一保留严格 StrategyPlan parser |
| 旧环境键 | `SIGNAL_BUYCALL`、`SIGNAL_SELLCALL`、`SIGNAL_BUYPUT`、`SIGNAL_SELLPUT`、`VERIFICATION_DELAY_SECONDS_BUY`、`VERIFICATION_DELAY_SECONDS_SELL`、`VERIFICATION_INDICATORS_BUY`、`VERIFICATION_INDICATORS_SELL` | 生产、测试 fixture、`.env.example` 与活跃 README 均零生效引用；仅离线 converter 可按 §7.3 读取 |
| 注入、profile 与策略语义 | `monitor.signalConfig`、`monitor.verificationConfig`、`config.signalConfig`、`verificationIndicatorsBySide`、`compileIndicatorUsageProfile`、`createMonitorContext`、post-gate cache retention | 改为 descriptor requirements union 和策略私有投影；不保留 monitor 级验证业务语义 |
| 旧 runtime 与 lifecycle | `MonitorContext.strategy`、`MonitorContext.delayedSignalVerifier`、`DelayedSignalVerifierPort`、`generateSignalId`、`verifiedCallbacks`、`registerDelayedSignalHandlers`、`cancelAll`、`cancelAllForDirection` | 改为 StrategyRuntimeSet、owner 定向 settlement 和 OrdinaryEvaluationLifecycle；禁止 callback 直接入队 |
| 席位和测试替身 | `seatInstanceId`、单 strategy/verifier 测试替身、旧 export 断言 | 删除无真相源的 instance id；改为 runtimeEpoch + direction + seatVersion + symbol，并同步更新测试 |

残留检查必须按上述精确标识符扫描 `src/`、`tests/`、`mock/`、`.env.example` 和活跃 README；历史资料必须在 allowlist 内，不能作为生产兼容残留保留。

## 10. 分阶段实施顺序

### 阶段 0：冻结业务规则和当前行为基线

先固定：

- 当前四动作映射；
- 条件组 OR/N-of-M；
- signal factor 缺失/无效的当前结果；
- immediate/delayed 分类；
- triggerTime 和初始指标；
- T0/T+5/T+10 和 ADX 规则；
- 开盘保护、末日接管、seatVersion；
- 共享买单和卖出前置；
- 买入风控、卖出智能平仓和 HOLD；
- 当前 verifier、时间唤醒、午夜和席位清理行为。

至少核对并迁移：

- `tests/core/strategy/index.test.ts`；
- `tests/core/strategy/utils.business.test.ts`；
- `tests/main/businessEventProgram/signalPipeline.business.test.ts`；
- `tests/main/asyncProgram/delayedSignalVerifier/business.test.ts`；
- `tests/app/context/createMonitorContext.business.test.ts`。

### 阶段 1：配置模型与正式命名

- 建立唯一 StrategyPlan；
- 将当前策略命名收敛为 `IntradayRegressionStrategy`；
- 删除 monitor 根部双配置真相源；
- 增加最多一个日内回归实例校验；
- 明确其他策略为立即-only；
- 用 JSON-only/mixed/legacy-only/neither 四态校验替换旧 parser；
- 仅提供独立离线 converter，不保留运行时兼容 fallback；
- 更新 `.env.example`、活跃 README、配置 validator、fixture 和配置测试。

### 阶段 2：纯策略契约与单策略 runtime

- 新增只含 primitive 的 `evaluationAtMs`、私有指标投影和 strategy-local reasonCode 的 immutable `StrategyEvaluationInput`；
- 引入非空 declaredSlots 作为参与者唯一真相源；
- 引入带完整授权 token 的判别联合 `READY/PENDING/NO_SIGNAL` slot outcome 与 candidate origin；
- 将可变 OrderRecorder 改为只读共享视图；
- Signal 构造从策略移到宿主；
- 只装配一个策略 runtime set；
- 在单策略场景先让屏障保持等价行为。

验收：单一日内回归 descriptor 与阶段 0 的因子、四动作和延迟行为一致。

### 阶段 3：指标需求与共享 profile/cache

- 将 `compileIndicatorUsageProfile` 改为接收策略 requirements；
- 聚合全部策略指标需求并集；
- 每个策略接收自己的指标投影；
- 日内回归验证样本使用专属 policy；
- cache retention 使用日内回归最大窗口；
- 无延迟时不创建验证 cache/timer；
- 清理 monitor 级 `verificationIndicatorsBySide` 语义泄漏。

### 阶段 4：宿主 evaluation/action barrier

- 生成 `evaluationId`、runtime epoch 与完整席位授权 token；
- 固定参与者集合；
- 维护四个动作槽位，并通过 lifecycle facade 路由到内部 barrier；
- 实现 `READY/PENDING/NO_SIGNAL` 收集；
- `NO_SIGNAL + PENDING` 仅在同一动作槽位内等待全部终态；
- 同一动作槽位的所有参与策略 READY 才释放该槽位；
- 原子 pending register、取消、late callback 和 duplicate settle 全部有明确收口；
- 屏障未释放前零普通队列入队。

先以单策略和测试替身验证真值表，再接入多个立即策略。

### 阶段 5：日内回归专属延迟 runtime

- 将 T0/T+5/T+10、ADX 和比较规则迁入日内回归策略 policy；
- 取消通用 delayed capability；
- callback 改为原 evaluation/intent 定向 settlement；
- 验证失败结算 `NO_SIGNAL`；
- 样本缺失、取消和销毁均定向结算；scheduler/verifier 内部错误经 abortRuntime 进入 fatal；
- `registerDelayedSignalHandlers` 不得直接入队；
- 接入时间唤醒、午夜、席位和 shutdown 清理。

### 阶段 6：多策略串行、动作槽位独立与候选合并

- StrategyRuntimeSet 按配置顺序评估；
- 未声明动作不参与；
- 不同策略 READY 候选在同槽位合并为一个共享意图；
- 不累加数量、不拆分共享账本；
- 同方向 OPEN/CLOSE 槽位独立：一方 pending、NO_SIGNAL 或 READY 不阻塞、取消或仲裁另一方；
- LONG/SHORT 独立；
- immediate 策略只等待同槽位日内回归 pending；
- 延迟失败不得回退立即入队。

### 阶段 7：生命周期、旧引用清理与全量回归

- 接入唯一 lifecycle owner、`QUIESCE_ORDINARY_EVALUATIONS = 5` cleanup phase、午休 reopen 和 open rebuild 前后的 runtime 关闭/开启；
- 验证所有席位授权 token 变化、末日、交易时段结束、午夜重试、停机和 fatal；
- 清理所有单 strategy、单 verifier、旧 profile、旧配置和旧测试替身；
- 验证共享买卖、风险、订单和成交语义不变；
- 运行格式、lint、类型检查、定向测试和全量测试。

### 后续另案

以下必须独立立项，不得回填到本方案首期：

- strategy state persistence / restore；
- durable decision store/outbox；
- parallel evaluation；
- true statistical extreme/mean reversion；
- 同 monitor 多个日内回归策略实例；
- 策略级预算、仓位和 P&L 归因；
- 同日重启继续验证旧 pending；
- 多 monitor、多周期或多数据源隔离；
- 运行时热切换策略。

## 11. 错误处理与 fail-fast 规则

### 11.1 配置和契约错误

以下错误必须在 pre-gate 或策略结果归一化阶段直接暴露：

- unknown strategy kind；
- strategy ID 重复；
- 日内回归实例超过一个；
- 非日内回归 descriptor 出现延迟字段；
- params 缺失、越界或未知字段；
- requirements 无法满足；
- declaredSlots 非法；
- 策略缺少已声明槽位结果；
- 非日内回归策略返回 `PENDING`；
- candidate 缺少 strategy/evaluation/intent identity；
- candidate 方向、动作或字段非法；
- candidate 携带数量、保护性清仓或 broker 执行字段。

不能通过静默删除错误策略、回退旧配置或把错误转换成 `NO_SIGNAL` 来继续交易。

### 11.2 策略内部错误

- 策略内部不变量错误进入既有 fatal/error 通道；
- serial 中任一策略异常时，本 evaluation 禁止部分入队；
- 已创建 pending 的 scheduler/verifier/coordinator 内部异常必须调用 `abortRuntime(error)`，由 lifecycle owner quiesce 后进入既有 fatal/error 通道；
- 不能用 `allSettled` 静默吞掉策略异常；
- 不能把未提交结果当作无限期 `PENDING`。

### 11.3 正常业务否决

以下情况可按正常业务结果结算为 `NO_SIGNAL` 或在最终门禁安全丢弃：

- 信号条件未满足；
- 已声明槽位但指标无效；
- SELL 槽位没有共享买单资格；
- 日内回归延迟验证失败；
- 缺样本或样本无效；
- 最终普通门禁关闭；
- seatVersion 或 symbol 已失效；
- 执行阶段行情、持仓或可卖数量不可用。

但以下不能伪装成 `NO_SIGNAL`：

- 配置错误；
- 策略契约错误；
- 屏障计数不变量错误；
- 迟到结果重新打开已关闭 evaluation；
- 共享状态被策略写入；
- 内部 runtime 状态错误。

### 11.4 取消和迟到结果

- 只有 `OrdinaryEvaluationLifecycle` 可以执行 quiesce；调用点不得各自清 Map、timer 或 barrier；
- quiesce 必须先关闭 admission/release，再使完整授权 token 不再 live、结算/取消 timer 和清理队列；
- 取消后的 callback 只记录并丢弃；
- 重复 settlement 必须幂等；
- 迟到结果不得创建新 Signal、重新打开屏障或进入队列；
- seat change 只影响该方向；runtime quiesce/abort 才影响所有普通 slot，OPEN/CLOSE 独立性不被破坏。

## 12. 测试与验收矩阵

### 12.1 当前策略行为基线

- 四种 Longbridge action 映射；
- MFI/KDJ/RSI/PSY 因子；
- 条件组 OR/N-of-M；
- SELL 生成时共享买单前置；
- immediate/delayed 分类；
- triggerTime 和初始指标；
- T0/T+5/T+10；
- ADX 特殊规则；
- 缺失/无效指标失败；
- 开盘保护、末日接管和 seatVersion；
- 买入风控顺序；
- 卖出智能平仓和 HOLD；
- 最终执行行情和门禁复核。

### 12.2 配置和装配

- StrategyPlan 非空、ID 唯一、kind 合法；
- 同一 monitor 配置两个日内回归实例时 pre-gate fail-fast；
- 非日内回归策略带延迟字段时 fail-fast；
- 空、重复或未声明动作不进入参与者集合；`intradayRegression` 的 declaredSlots 与有效 signalFactor keys 不一致时 fail-fast；
- 当前多指标配置只转换为一个日内回归 descriptor；
- JSON-only、mixed、legacy-only、neither 与空白旧键按 §7.3 四态矩阵验证；
- 旧 monitor.signalConfig/verificationConfig、parser、validator 不存在生效路径；
- 只创建一个 MonitorContext、Trader、OrderRecorder、RiskChecker 和共享 indicator runtime；
- 只创建一个日内回归验证 runtime；
- 无延迟配置、`delay=0` 或空验证指标时均不创建验证 timer/cache；
- runtime set 创建顺序和 descriptor 顺序一致。

### 12.3 策略纯度和 serial

- 所有策略收到同一 runtimeEpoch、evaluationId、evaluationAtMs、席位快照和共享 primitive 事实，但只收到各自私有指标投影；DTO 不暴露完整 IndicatorSnapshot、Date/Map/Set 或其他策略的指标 display；
- serial 严格按配置数组顺序调用；
- 策略不能调用 Trader、broker 或共享账本写接口；
- 缺失已声明槽位结果被识别为契约错误；
- 任一策略异常时本 evaluation 零普通队列入队；
- 判别联合拒绝 READY 无 candidate、PENDING 带 candidate、NO_SIGNAL 带 pending 等非法组合；READY/PENDING 对 null 或非 ACTIVE seat 的结果被拒绝；
- 策略回显的 runtimeEpoch、symbol、seatVersion、direction 或 operation 与 frozen evaluation context 不一致时 fail-fast；
- 同一 evaluation 不产生重复结果；
- 未来异步接口不得在本期引入并行 broker mutation。

### 12.4 动作槽位屏障

必须覆盖三态真值表：

- A READY、B READY：只生成一个共享候选；
- A READY、B PENDING：零入队，等待 B；
- A READY、B NO_SIGNAL：若有 pending 仍等待，最终零入队；
- A NO_SIGNAL、B PENDING：等待 B 终态，最终零入队；
- A/B PENDING：全部成功才释放；
- A/B NO_SIGNAL：零入队；
- 未声明动作：不参与；
- 无参与策略：不生成信号。

还必须验证：

- 同一 evaluation 不同 slot 状态不互相覆盖；
- LONG/SHORT 方向独立；
- 同方向 OPEN/CLOSE 槽位独立：一方 pending、NO_SIGNAL 或 READY 不影响另一方释放；
- 同方向 OPEN/CLOSE 同时 READY 时，各自只生成一个共享 Signal 并分别进入既有买/卖队列；
- 所有 READY 只释放一次；重复、过期或完整授权 token 不匹配 settlement 为无副作用 no-op；
- slot cancellation 仅关闭同一 evaluation 的同一 action slot，direction/runtime quiesce 的 scope 与已释放任务门禁语义明确；
- `NO_SIGNAL + PENDING` 只在同一槽位内等待全部终态后正确清理资源。

### 12.5 日内回归延迟验证

- 只有日内回归策略能进入 PENDING；
- 同一策略同一槽位不会同时产生立即和延迟结果；
- 不同 evaluation 的 pending 不互相覆盖；
- owner、evaluation、intent、`runtimeEpoch + direction + seatVersion + symbol` 全部正确路由；初始 READY 只能为 `IMMEDIATE`，同一 pending 成功结算才可构造 `DELAYED_VERIFIED`；
- T0/T+5/T+10 和 ADX 规则与基线一致；每个目标使用无容差的最近保留样本，允许未来样本、等距取较晚样本及同一样本命中多个目标；
- 验证成功结算 READY；
- 验证失败、缺样本、无效样本结算 NO_SIGNAL；
- 失败不回退立即信号；
- 通过后回到原 evaluation 屏障，不直接入队；
- callback 不广播到其他策略；
- 同步 callback、返回 handle 后的已结算清理、scheduler throw、scheduler callback 后 throw 均恰好一次 settlement/abort；callback 后 throw 场景零 release、零入队、零 pending 泄漏；
- 重复 callback、迟到 callback、取消后的 callback 不产生副作用；
- READY → barrier → merger → adapter → queue 保留相同 triggerTimeMs；混合 immediate/delayed READY 时由 `DELAYED_VERIFIED` origin 选择延迟 T0 为 canonical triggerTime；固定时钟断言当前 per-action clock 归一化为一次 evaluationAtMs 的明确计划变化；
- `destroy` 后 timer、pending、callback 全部释放。

### 12.6 Evaluation 独立性与生命周期

- 新 evaluation 不取消旧 pending；
- 相同 symbol/action/triggerTime 的不同 evaluation 不互相 dedupe；
- ACTIVE 退出、symbol 重绑、ACTIVE 内 version bump、新授权激活、同 symbol ABA 与跨 runtime 相同 seatVersion 均经完整授权 token 失效旧 evaluation；
- 交易时段结束（包括午休）和末日接管经 lifecycle owner 取消全部日内回归 pending 与 queued ordinary task；初始启动与每个 `canTrade: false -> true` 边沿各恰好一次 activateRuntime；午休 reopen 只创建新 runtimeEpoch，绝不恢复旧工作或执行旧 queue entry；
- 开盘保护阻止新 evaluation，但不统一取消既有 pending；
- 午夜 quiesce 必须先于 source stop、队列和 cache 清理；重试不重复推进已失效 epoch；
- callback 正在执行时发生 seat/time/stop cancellation 后，settle 被拒绝且零入队；queued envelope 在 quiesce 后被移除；processor 已取任务但尚未调用 trader 时，canExecuteOrdinary 必须拒绝且零 trader 调用；普通 retry timer 在 quiesce 后触发时不得重新入队；
- stop/fatal 后 callback 不能重新入队，`QUIESCE_ORDINARY_EVALUATIONS = 5` 早于 freshness abort(10) 和 time-wakeup stop(20)；
- 重启不恢复 barrier、READY candidate、pending 或 timer；
- open rebuild 完成前不启动普通策略事件。

### 12.7 共享订单、风险和清仓

- 策略 A OPEN 后策略 B 可读取共享买单和持仓；
- 多策略同动作只生成一个共享意图；
- 不按 strategyId 拆分 OrderRecorder、Position、DailyLoss、浮亏或持仓上限；
- SELL 仍由共享 SellProcessor 计算卖量；
- 重复 CLOSE 不重复占用相同共享持仓；
- 买入风控、卖出智能平仓和执行时行情读取不改变；
- 保护性清仓、末日清仓和静态风险清仓不被普通屏障阻塞，也不因 ordinary lifecycle quiesce 被从共享队列清除。

### 12.8 旧引用和类型检查

实现完成后全仓扫描：

```text
monitor.signalConfig
monitor.verificationConfig
MonitorContext.strategy
monitorContext.delayedSignalVerifier
generateSignalId
verificationIndicatorsBySide
compileIndicatorUsageProfile
cancelAll
cancelAllForDirection
SIGNAL_
VERIFICATION_
```

删除无效、过时和兼容性残留代码及测试。实施 TypeScript 代码后按项目规范依次运行：

```text
bun format
bun lint
bun type-check
```

再运行相关定向测试和完整测试套件。

## 13. 已确认业务决策

本节不再保留“待业务确认”的旧分支：

1. 当前多指标阈值策略正式归为日内回归策略；
2. 同一 monitor 最多一个日内回归策略实例；
3. 延迟验证只属于日内回归策略，其他策略不可使用；
4. 宿主只提供延迟验证所需的底层 timer、sample cache、取消和生命周期基础设施，不拥有验证业务规则；
5. 首期固定串行评估；
6. 首期无策略持久化、无 outbox、无 parallel；
7. 屏障按 `evaluationId + direction + operation` 建立；
8. 未声明动作不参与屏障；
9. 已声明但未触发为 `NO_SIGNAL`；
10. `READY + PENDING` 等待 pending；
11. `NO_SIGNAL + PENDING` 仍等待全部 pending 终态，最终不产生信号；
12. 只有同一动作槽位的全部参与策略最终 READY 才释放该动作槽位；
13. 不同 evaluation 独立收敛，新 K 线不自动替换旧 pending；
14. 同方向同动作候选合并为一个共享意图，不累加数量；
15. 同方向 OPEN/CLOSE 是独立动作槽位；同一 evaluation 同时成立时分别进入既有买/卖队列，不互相等待、否决或仲裁；
16. LONG/SHORT 方向独立；
17. 保护性清仓、末日清仓和静态风险清仓不受普通屏障阻塞；
18. 普通 delayed 失败不回退为立即信号；
19. 普通触发时间使用 immutable milliseconds；同槽位混合 immediate/delayed READY 时，延迟 T0 是唯一 canonical triggerTime；
20. `EvaluationActionBarrier` 是每个 evaluation 的内部状态机；`OrdinaryEvaluationLifecycle` 是 outcome/pending 的唯一外部路由及取消/abort 的唯一 lifecycle owner；
21. 本期不增加业务 deadline；timer 晚到仍按当前保留样本验证，scheduler 失败走 fatal 而非业务否决；
22. 重启不恢复普通 evaluation、屏障、pending、timer 或未入队候选。

## 14. 方案最终判定

本方案在现有系统上可行，且符合当前业务边界。最终模型为：

```text
一个 monitor
+ 一个日内回归策略（最多一个实例）
+ 其他立即-only 策略
+ 共享指标计算和交易事实
+ 串行策略评估
+ evaluation/action 宿主就绪屏障
+ 日内回归策略专属延迟验证
+ 按动作槽位独立候选合并和入队
+ 共享买卖、风控、订单和生命周期
+ 不按策略拆分持仓、订单和损益
+ 首期无策略持久化、无 outbox、无 parallel
```

必须遵循以下五条铁律：

1. **延迟验证的业务语义只存在于日内回归策略，不存在通用宿主 delayed capability。**
2. **策略独立判断，但普通信号不能独立绕过宿主屏障；策略的 READY/PENDING/NO_SIGNAL 由宿主按 evaluation 和动作槽位收敛。**
3. **只有某个动作槽位屏障全部满足时，宿主才能为该槽位构造普通 Signal 并入对应共享队列；其他动作槽位不构成前置条件。**
4. **普通 evaluation 的 admission/release、pending settlement、取消和 abort 只能经 OrdinaryEvaluationLifecycle 路由至内部 barrier；迟到结果必须成为 no-op。**
5. **所有共享交易事实、风险、订单和清仓逻辑继续由宿主和既有执行层统一维护，不按 strategyId 分账。**

任何以下实现均不符合本方案：

- 直接循环调用多个旧 `generateSignals()` 并分别入队；
- 让 immediate 候选绕过屏障；
- 让 delayed callback 直接写买卖队列；
- 把 T0/T+5/T+10 或 ADX 规则重新放回通用宿主 verifier；
- 为每个策略复制完整 MonitorContext、Trader 或账户事实；
- 将 strategyId 作为持仓、订单、成本或损益分区键；
- 将 `NO_SIGNAL + PENDING` 在同一动作槽位内提前当作完成；
- 让一个动作槽位等待、否决或仲裁同方向另一动作槽位；
- 保留旧配置与新 StrategyPlan 双真相源；
- 在首期偷偷引入策略状态持久化、outbox 或 parallel。
