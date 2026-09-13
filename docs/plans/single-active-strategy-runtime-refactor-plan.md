# 单活跃策略独立化重构设计合同（免注册自动加载）

> 本文是最终待实施设计合同，不是完成报告。目标是将**当前策略及其延迟验证整体封装为独立个体**，不是重新定义交易策略，也不是建设多策略交易平台。新增策略只新增符合约定的目录，不修改中心注册文件；通过 `ACTIVE_STRATEGY_ID` 选择，构建部署后重启，进程始终只创建并运行一个选中实例。
>
> 实施执行入口：[single-active-strategy-runtime-execution-plan.md](./single-active-strategy-runtime-execution-plan.md)。本合同与执行计划同步用户已确认的 D1–D5：私有常量局部例外、午夜失败保持原语义、极小正delay保持旧行为、严格命名免注册加载、构建全量校验而启动仅校验选中项。文件级任务、精化时序和验收以执行计划为准；两份文档均不表示代码已迁移。

## 1. 需求、业务边界与复核依据

### 1.1 首要验收标准

1. 当前策略的信号规则、DSL、指标用途和参数选择、指标运行态、延迟采样、pending、timer、验证、回流以及策略状态清理，全部属于同一个具体策略实例，并位于其策略目录。
2. 当前环境变量中的策略配置迁入该策略目录的 `config.json`。目标运行时没有环境变量补值、默认策略、双配置源、验证失败转立即信号或旧接口兼容层。
3. **单活跃不等于唯一实现。** 本次只迁移当前策略，不额外实现生产策略；公共接口、加载器、构建工具和宿主不得硬编码只有 `intraday-regression` 才合法。未来只需新增策略目录、设置选择值并重新构建部署，不修改宿主、加载器、资产工具或中心清单。
4. 宿主负责账户、持仓、订单、行情接入、席位、风控、普通任务队列、智能平仓、保护性清仓、末日清仓、执行和恢复。策略输出只是普通买卖意图，不是下单授权。
5. 保持当前生产调用链的业务行为，包括信号条件、两侧延迟配置、采样时间、验证窗口、订单事实门禁、执行时行情、风险顺序及恢复规则。必要的契约纠错必须说明依据和回归验证，不能借重构引入新政策。
6. 配置和内部不变量错误 fail-fast；已有业务允许的行情未就绪、失效结果丢弃、外部请求失败和有界重试保留其所属链路语义。

扩展承诺限定在现有普通交易能力内：唯一 monitor、当前行情输入和四种普通买卖动作，并遵守每个行情 origin 对每种 action 最多输出一次普通意图的公共契约。在该契约内，新的指标、判断公式、策略私有状态和延迟规则不能再要求修改宿主；同一 origin 的多阶段重复意图、新增交易市场、订单副作用类型或改变账户模型不属于本次扩展承诺。

### 1.2 全链路复核结论

以下位置均指重构前源码。只依据实际生产调用链，不以局部 nullable 类型、工厂默认值或测试替身推断生产行为。

| 复核项 | 真实证据与结论 | 本方案处理 |
| --- | --- | --- |
| 策略选择 | 当前 `MonitorContext.strategy` 已是单数。将公共 ID/config 类型绑定单个实现，会迫使未来修改宿主类型 | 公共行为接口不引用具体策略类型；按严格ID可逆映射目录，只动态加载选中definition，无中央登记 |
| 策略规则分散 | `src/config/utils.ts` 包含 DSL 和验证配置解析；`src/services/indicators/profile/` 包含用途规则；`runtime/index.ts` 固定选择 MFI14、KDJ9/3、MACD12/26/9、ADX14 | 具体规则和运行态整体迁入策略，不只移动 compiler 的调用入口 |
| 配置粒度 | `src/core/strategy/index.ts` 和 `src/config/trading/utils.ts` 均为 BUY/SELL 两侧验证配置 | 保持两侧模型，不新增四套 action policy、purpose 或可配置失败策略 |
| 四个表达式 | `src/config/validator/utils.ts` 的 `signalConfigKeys` 校验四个表达式必填 | JSON 保留四个非空表达式；不根据局部 nullable 新增 null 禁用语义 |
| 装配顺序 | `createMonitorContext` 创建 autoSymbolManager 时依赖 MarketDataClient、Trader、OrderRecorder 和 RiskChecker | 完整 context 在这些资源之后创建，不引入半装配 context |
| 时间原语 | `src/types/runtime.ts` 是 `clock.now(): Date` 和 `scheduleTimer(callback, delayMs)` | 直接注入现有 clock/相对 scheduler，不假定存在 `nowMs()` 或绝对调度 API |
| 样本时间 | `businessEventProgram` 在监听事件时记录 `observedAtMs`，latest-only 保留最新事件时间，后续用它写样本 | 保留监听时间；策略动作生成时另读 clock，不强制两者相等 |
| 实际保留窗口 | `createPostGateRuntime` 显式传入最大两侧 delay + 10 秒 ready 窗口 + 15 秒安全余量 | 保持该派生值；不使用 cache 工厂的默认 100 秒 |
| 指标快照的风险依赖 | 唯一生产 `applyRiskChecks` 调用在 `buyProcessor`；调用前已拒绝缺失、非有限或非正的 monitorQuote | 删除该调用链中的 `monitorSnapshot` 依赖和不可达 snapshot 补价，不新增价格缓存 |
| 显示依赖 | `monitorDisplayRuntime`、`marketMonitor` 仍消费具体 `IndicatorSnapshot`/profile | 策略返回中性显示投影，宿主不再解析指标族或展示计划 |
| `indicators1` | 内容消费者仅旧 verifier；SellProcessor 只 clone，类型本来可选 | 删除字段及对应透传，保留 retry clone 的其他必要行为 |
| 安全边界 | 普通信号卖量路径按 reason 文本识别清仓；fatal 分散，lifecycle 存在直接 reopen | 删除文本授权；保留同步 fatal 关门、防重开及终态 admission 保障 |

独立分析复核已确认上述修订方向。生产配置值和部署环境未被读取；本文不猜造实际交易参数。

### 1.3 非目标

不实现多策略同时运行、信号合并、跨策略 barrier、热切换、运行期热发现、启动导入全部策略、人工或生成式 registry、策略级账户账本、策略状态持久化或跨进程 callback 恢复。构建期自动目录发现属于本次范围。策略身份不参与订单、持仓、成交、损益或风险分区。

不重做订单恢复、风险政策、智能平仓、自动寻标、换标状态机或 Broker 语义。真实安全问题不能因控制范围而忽略，但也不能以“策略独立化”为由强制建设完整进程 supervisor、manifest 平台或语义静态分析框架。

## 2. 目录与所有权

### 2.1 目标布局

```text
src/app/startup/prepareStrategy.ts           # 唯一生产加载边界：按ID定位、导入、校验与prepare
src/constants/strategy.ts                   # 共享命名/固定文件名规则，无具体策略清单
src/core/strategy/types.ts                  # 公共：策略无关的事实/输出/生命周期接口
src/core/strategy/utils.ts                  # 中性ID/目录映射及definition校验
src/core/strategy/intradayRegression/
  definition.ts                            # 固定导出strategyDefinition：id、configHref、prepare
  config.json                              # 唯一策略配置资产
  config.ts                                # 严格解析、规范化、校验
  index.ts                                 # 唯一实例工厂；事件与生命周期端口
  types.ts                                 # 私有配置、指标、pending 等类型
  ...                                      # DSL、指标编排、采样、验证、显示等私有模块
```

目录名按 camelCase，与严格 kebab-case ID 按 §3.3 双向对应；当前为 `intraday-regression → intradayRegression`。策略根每个一级子目录都必须是完整策略，不以缺入口为由跳过；公共内容放根级文件或根外中性模块。具体策略可按职责拆私有文件，不要求为每个概念新建目录。旧 `src/core/strategy/index.ts` 通用工厂在切换后删除，不保留转发入口；不创建原方案的 `src/config/strategy.ts`。

以下内容必须位于具体目录：

- 该策略的 DSL、N-of-M/OR 规则、指标支持集、指标名解释和 profile compiler；
- 固定指标参数、验证时间点、样本保留规则、动作与趋势方向映射；
- 指标增量状态、活动柱 preview、验证样本和 pending；
- 该策略的原因文本、指标展示名称、顺序和格式。

纯数学运算、时间单位、日志等真正中性能力可以复用。当前指标模块若只服务本策略，直接随策略迁入，比建立新的通用指标插件框架更小。不得把“支持哪些信号指标”“如何验证趋势”等政策作为公共 helper 留在目录外。

固定算法规则不必全部变成可配置项；保留为本策略私有规则即可。确需配置的参数放本目录 JSON。依用户明确确认的 D1，仅策略私有常量可放具体策略目录，这是 TypeScript skill 常量目录条款的局部例外；共享常量（包括ID/路径发现规则）仍统一放 `src/constants/`，其他规范不变。

特别处理混合职责常量：`VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS` 实际供买入风险检查冷却使用，仍归宿主，并改为与真实用途一致的名称。只迁移策略验证相关成员，不能将买入风控一起搬进策略。

### 2.2 宿主运行态的最终边界

`MonitorContext` 保留唯一 strategy port 及原有宿主交易能力；移除 `delayedSignalVerifier` 和 `indicatorProfile`。宿主的 `MonitorState` 不再保存具体策略 `lastMonitorSnapshot` 或 `incrementalIndicatorRuntime`。

同步检查 `MonitorState` 的全部消费者：若移除上述两字段后只剩重复的 monitorSymbol，则删除空壳状态及相应初始化/清理引用，直接使用现有唯一 monitor 配置，不为保留旧形状建立替身。

`RunAppDeps`、post-gate、business event、lifecycle 和 cleanup 只能持有统一策略端口，不能持有具体 config、profile、pending、sample store 或 verifier。指标和 delayed 状态不能藏在改名的宿主 runtime、facade 或 delegate 中。

同一实例的状态隔离依靠真实 owner 和闭包，不依靠禁止函数名。策略内部可以有私有工厂和 helper；它们不能被宿主独立构造、注入、启动、清理或接收 `onVerified`。

## 3. 公共端口、选择与配置

### 3.1 最小公共端口

下面给出目标形状；实现中的类型必须按项目规范放置并完成 type-check。公共契约不得 import 任一具体策略目录的类型。

```ts
import type { Period } from 'longbridge';
import type { RuntimeClock, RuntimeScheduler } from '../../types/runtime.js';
import type { SignalType } from '../../types/signal.js';
import type { Logger } from '../../utils/logger/types.js';

type StrategyAction = Exclude<SignalType, 'HOLD'>;

type StrategyCandleValue = number | string | null | undefined;

type StrategyCandle = {
  readonly timestamp?: number;
  readonly open: StrategyCandleValue;
  readonly high: StrategyCandleValue;
  readonly low: StrategyCandleValue;
  readonly close: StrategyCandleValue;
  readonly volume: StrategyCandleValue;
};

type StrategyCandlestickSnapshot = {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly initialized: boolean;
  readonly lastBarTimestamp: number | null;
  readonly lastBarConfirmed: boolean | null;
  readonly candles: ReadonlyArray<StrategyCandle>;
};

type StrategySeatFact = {
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
  readonly hasFilledBuyOrders: boolean;
};

type StrategyMarketContext = {
  readonly candlesticks: StrategyCandlestickSnapshot;
  /** 行情事件被监听到的时间，不是处理完成或判断时间。 */
  readonly observedAtMs: number;
  readonly allowNewEvaluation: boolean;
  readonly seats: ReadonlyArray<StrategySeatFact>;
};

type StrategyDecision = {
  readonly action: StrategyAction;
  readonly triggerTimeMs: number;
  readonly reason?: string;
};

type StrategyDisplayItem = {
  readonly label: string;
  readonly valueText: string;
};

type StrategyEmitter = (decision: StrategyDecision) => void;

type StrategyDeps = {
  readonly clock: RuntimeClock;
  readonly scheduler: RuntimeScheduler;
  readonly logger: Logger;
  readonly onFatalError: (error: unknown) => void;
};

interface TradingSignalStrategy {
  readonly strategyId: string;
  readonly handleMarketEvent: (
    context: StrategyMarketContext,
    emit: StrategyEmitter,
  ) => ReadonlyArray<StrategyDisplayItem> | null;
  readonly invalidateDirection: (direction: 'LONG' | 'SHORT') => void;
  readonly invalidateAll: () => void;
  readonly resetForTradingDay: () => void;
  readonly destroy: () => void;
}

interface PreparedStrategy {
  readonly create: (deps: StrategyDeps) => TradingSignalStrategy;
}

interface StrategyDefinition {
  readonly id: string;
  readonly configHref: string;
  readonly prepare: (rawText: string) => PreparedStrategy;
}
```

`prepare` 在具体目录内完成解析、校验、规范化和私有 profile 编译，返回闭包捕获结果的 `create`。公共 prepared 对象不暴露具体 config/profile；无泛型配置擦除、`any`、具体类型联合或运行期类型断言适配层。配置和 profile 为递归只读值；工厂接收的 clock/scheduler 是基础能力，不持有任何策略 delayed 状态。

`handleMarketEvent` 同步执行，不进行网络或 Broker I/O。返回值仅用于显示；`null` 表示本次没有可显示的策略快照，不表示内部错误被吞掉。同步未处理异常由调用边界进入统一 fatal；异步 timer 的未处理异常由策略通过注入的 fatal sink 报告。

输出按单动作传递，不建立“所有动作必须共用时间”的 envelope。一个事件可以产生多个不同动作，当前策略保持现有动作顺序；同一 origin 每个 action 最多输出一次。没有信号就不调用 emitter，不输出 HOLD。

### 3.2 事实投影与不可变性

宿主从已标准化的本地 K 线缓存读取最新快照。`quoteClient/candlestickCache.ts` 已将 SDK 数值对象转成 primitive；公共策略输入必须表达该实际边界，不能把允许可变 SDK 对象的宽 `CandleData` 类型断言为安全输入。

采用新建只读投影并冻结对象/数组，或在已经证明不会原地修改的行情发布边界冻结一次。两种实现均须验证：策略无法修改缓存、后续行情不会改变已交付快照。不对行情数值制造默认值；缺失/非有限指标输入按现有计算规则处理。

`seats` 只包含当前 ACTIVE 席位。`hasFilledBuyOrders` 由宿主调用当前 symbol/方向的 `getBuyOrdersForSymbol` 得到，只包含已成交买单；pending BUY、相反方向和旧 symbol 不计入。策略不接收完整 recorder、订单列表、seatVersion、持仓、行情请求 capability 或任何交易写能力。

### 3.3 免注册自动定位与精确选择

用户已接受严格命名及跨平台冲突规则（D4），以及“构建全量校验、启动只校验选中策略”（D5）。不创建静态/生成式注册表、manifest 或手工维护的 ID/path 清单。

1. 启动读取一次 `ACTIVE_STRATEGY_ID` 原值，严格匹配 `^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$`；缺失、空白、别名、大小写变体、连续/尾随连字符、路径字符均失败。不 trim，不默认选择，不 URL 解码后补救。
2. 连字符后首字母大写得到 camelCase 目录；每个大写字母反向转换必须还原原 ID。`foo-1` 非法，不能与 `foo1` 指向同目录。实际目录名必须规范；构建拒绝大小写折叠冲突与 Windows 保留设备名，避免跨平台身份变化。
3. 根由加载器自身 `import.meta.url` 相对定位，不能使用 cwd/env 指定任意根。用目录元信息核对真实拼写、选中项相关名字冲突、入口和资产文件；做真实路径边界检查，拒绝候选目录及definition/config的symlink/junction。启动可枚举必要名字，但不检查无关未选目录内容或导入它们。
4. source 模式只定位 `definition.ts`，dist 模式只定位 `definition.js`；模式由定位模块自身明确 `.ts`/`.js` 扩展名决定，其他形态失败。导入前确认该精确文件存在；不尝试另一扩展名、cwd或源码根，不以运行器扩展名补全作为fallback。使用标准路径/URL API处理Windows、空格和非根cwd。
5. 只动态 import 选中入口一次，固定命名导出为 `strategyDefinition`。动态结果先作为 unknown 校验对象/id/configHref/prepare；prepare返回须含同步create，实例须符合全部公共方法和strategyId；不使用any、类型断言、default导出兼容或Promise替身适配。实例可清理时仍返回即登记destroy，再核验其余契约。
6. definition 的 `configHref` 必须精确指向自身相邻 `new URL('./config.json', import.meta.url).href`，只接受规范本地file URL，无query/hash。仅读取该原文一次、prepare一次、create一次；选择ID、目录ID、definition.id和实例identity一致。
7. 入口及其传递依赖求值无副作用：不读JSON、不启动timer、不监听事件、不访问网络、不创建实例。禁止策略间私有依赖和聚合barrel，不能通过选中A间接执行B；日志作为现有Logger依赖注入，不在策略内部创建。
8. 加载、传递依赖、导出形状、身份、配置错误均在SDK创建前失败，保留真实cause和阶段，不能一律伪装成“未知策略”或回退其他实现。未选策略模块/配置错误不通过启动全量加载影响选中项，但仍阻断正式全量build。
9. 动态加载只面向可信本地发布包，不是沙箱；新增策略需要构建部署和重启。发布包不能运行期原地并发替换文件，不增加热切换或模块缓存绕过机制。不另设kind/capability标签。

具体路径校验、依赖注入、构建资产落点和测试按执行计划 §4.5–§4.6、WP1/WP7 落实。非根cwd测试显式提供fixture env，不改变现有dotenv装载政策。

### 3.4 当前策略的 JSON 契约

目标顶层只包含 `signals` 和 `verification`，结构为：

```text
signals:
  BUYCALL: 非空、可解析的当前信号 DSL
  SELLCALL: 非空、可解析的当前信号 DSL
  BUYPUT:  非空、可解析的当前信号 DSL
  SELLPUT: 非空、可解析的当前信号 DSL
verification:
  buy:
    delaySeconds: 有限 JSON number，0–120
    indicators:  显式数组；可以为空
  sell:
    delaySeconds: 有限 JSON number，0–120
    indicators:  显式数组；可以为空
```

这是 schema 说明，不是可部署配置。不得用猜测表达式或占位符生成生产资产。

所有字段必须显式存在；未知字段、重复 object key、null、错误类型和非法 DSL/指标都失败。保留 raw text 以检出重复键（包括转义后相同的 key）；可使用标准 JSON 解析配合原文结构检查，不需要建立通用配置语言或完整 AST 平台。不能仅靠正则匹配 key，也不能在 key 已被覆盖后假称完成重复检测。

指标名称、周期范围、DSL 组数、阈值、组内 N-of-M 和组间 OR 均保持当前解析规则。验证列表去重及顺序保持当前口径。解析返回新建规范化配置，递归冻结；运行时不重读文件、不重新编译 profile。

当前策略内部归类保持：

| 显式配置                            | 当前策略结果 |
| ----------------------------------- | ------------ |
| delaySeconds > 0 且 indicators 非空 | DELAYED      |
| delaySeconds = 0 或 indicators 为空 | IMMEDIATE    |
| 缺失、非法、类型错误                | 启动失败     |

该归类是已存在的明确业务规则，不是失败后的降级。即使 delay 为 0，显式配置的指标仍按现有 profile 规则参与指标需求/展示编译；不能顺手删掉这些计算需求。无需在 JSON 重复四份 policy、purpose、固定 failureBehavior 或冗余 mode。

保留现行 delay 数值精度：旧 parser 接受范围内有限数值，不额外限制必须整数秒。依 D3，正 delay 的原始加法若因浮点精度没有推进时间，在 Date 转换前正常不生成候选，不登记pending、不转immediate；不能改成转换后要求T0严格大于now。T0 使用现行Date毫秒转换口径，最终时间必须有效，不新增精度下限。

### 3.5 旧配置的一次性迁移

迁移四个 `SIGNAL_*` 和四个 `VERIFICATION_*` 键。步骤：

1. 从待迁移部署导出经旧版本解析、验证后的有效策略值，并记录来源版本和原始键是否显式配置。只导出策略值，不携带认证密钥。
2. 将有效值显式写入目标 JSON，形成资产后才进入正式构建验收。已核实的旧有效默认值可以物化；这不是允许新运行时缺参补值。保留验证通过的原始DSL，不用可能输出指数数值的日志formatter反推表达式；只有结构化输入时用可回读序列化及往返测试。不能从仓库示例猜生产参数。
3. 新 JSON 严格解析后，与旧有效配置进行决策、验证及展示回放对比。两侧配置保持两侧，不重新制定四套政策。
4. 新运行时按 key presence 拒绝残留旧策略环境键，包括显式空白值；不合并 env 与 JSON。
5. 更新 `.env.example`、README、直接相关部署模板、fixture 和 mock。旧程序回滚所需 env 随旧发布包独立保存，不留下生产兼容 parser。

生产值尚未提供会阻断部署，但不阻断用确定 fixture 完成架构和行为测试；不增加与需求无关的逐 action 书面签字流程。

## 4. 启动与资源装配

### 4.1 正确顺序

```text
runApp：取得统一 env 快照
  → 严格ID映射选中目录、校验路径、动态导入唯一definition并校验固定导出
  → 读选中 JSON，prepare：严格校验并编译私有配置/profile
  → 解析不含策略字段的全局交易配置，完成认证配置校验
  → 准备共享交易 gate、clock/scheduler、终止 owner/fatal sink 和 cleanup
  → 安装正常退出订阅，同步回调接入终止 owner，取得幂等释放函数
  → 调用 selected prepared.create 一次
  → 立即登记该实例唯一、幂等的 strategy destroy cleanup
  → 创建 SDK/MarketData/Trader/风险等宿主资源，各自登记 cleanup
  → 创建完整 MonitorContext，注入已经创建的同一 strategy
  → 装配 queue、processor、事件/时间/lifecycle owners
  → startup snapshot 与 recovery/rebuild
  → 成功才放行普通业务；可恢复外部失败按现行生命周期重试
```

共享交易 gate 初始关闭，只有 recovery/rebuild 成功且终止门禁未关闭才可放行。全局状态的初始化可为提前创建 gate 作必要拆分，但不得为提前创建完整 context 引入空 Trader、可选 recorder、默认 factory 或二次绑定的假完成对象。

prepare/create 的唯一生产调用点是 composition root；`createMonitorContext` 不解析配置、不编译 profile、不调用策略 factory。完成创建后释放临时 prepared 引用，不把它带进 post-gate 或运行期 context。

策略工厂在构造阶段不启动 timer、不 emit；它只建立私有状态和端口。若内部构造在返回前失败，由该构造过程收口自己的已创建状态；不得返回半实例或重试其他策略。

### 4.2 部分装配失败

配置失败必须发生在 SDK、行情和交易资源创建之前。策略实例返回后立即注册清理，再检查实例 identity 等返回值契约；检查失败同样销毁该实例。后续任何失败均使用同一个 cleanup 计划，不能遗漏策略 timer，也不能把宿主资源塞进 strategy.destroy。

每个资源返回后立即登记自身清理。若在异步创建资源期间已发生 fatal 或正常最终退出，立即同步关闭交易与业务 admission；composition root 必须等当前资源创建落定，登记成功返回的晚到资源并停止后续装配，然后才执行唯一 cleanup。不得启动晚到资源或继续创建后续业务 owner，也不得以启动装配与终止通知 Promise 竞争的方式提前进入 cleanup。**终止业务 admission 不等于禁止登记已创建资源的 cleanup。** 现有 cleanup 执行开始后禁止继续登记，保留该边界并以装配串行收口满足清理要求，不引入 seal 协议或动态清理注册平台。

创建返回先登记清理再检查终态；下一次创建/start/reopen 前，以及 startup snapshot、初始 rebuild、Quote reconcile、初次时间唤醒等相关 await 返回后都复核终态。恢复函数内部真实放行点同样使用共享终止授权，不能只靠外层返回后的检查。晚到资源不得绕过已关闭的终态重新放行。

构造/接线的内部错误先同步报告 fatal，再执行 cleanup。恢复性外部失败按原链路分类，不因装配顺序改变就一律升级 fatal。正常退出先置终态不占用首个 fatal 槽，装配落定或排空期间发生的真实内部错误仍须报告，不因已终止而吞掉。

## 5. 普通事件、指标和延迟验证

### 5.1 事件链路

```text
分钟线更新事件
  → 宿主在监听时读取 observedAtMs
  → single-flight/latest-only 保存最新待处理事件及其 observedAtMs
  → 读取最新权威 K 线缓存；缺失/未初始化/空则不调用策略
  → 捕获 origin day/ACTIVE seat route，投影只读行情和订单事实
  → strategy.handleMarketEvent(context, eventEmitter) 一次
      → 推进私有指标增量状态，构建本次 snapshot
      → 若不能形成当前策略有效 snapshot，正常无输出
      → 按 observedAtMs 无条件写一次私有验证样本
      → 生成中性显示投影
      → 新判断 gate 关闭则不评估、不建 pending、不调用当前 emitter
      → 否则按原顺序评估动作：立即输出或登记私有 pending/timer
  → 宿主将显示投影交显示 owner
  → 普通 decision 统一经 host adapter 进入 STRATEGY_BUY/STRATEGY_SELL
```

`allowNewEvaluation` 使用现行 ordinarySignalGuard、有效 currentDayKey 和非开盘保护条件。host 不计算、传递或解释 delay policy。

每次策略成功形成 snapshot，都先采样，再检查新判断门禁；没有 pending、开盘保护期及本轮将创建 pending 的情况都不能跳过采样。显示失败不能被当成验证失败；显示链路按既有职责运行。

### 5.2 指标推进与输入失败

把当前 profile、runtime orchestration 和真实运行态类型迁入策略。策略内部直接持有私有 state；删除旧公共 opaque indicator handle 及仅为宿主持有/回传服务的 Symbol brand、双重断言转换和 unwrap，不在私有目录复制包装。旧包装在现有 MonitorState 边界有真实用途，但目标删除该边界后不再需要。保留已确认柱的 committed 基线与活动柱 preview：同一分钟反复更新不能重复累计，确认/换柱后再提交。

- 有效价格但部分指标尚未成熟，仍可形成 partial snapshot；N-of-M 按当前可用指标数量和条件结果处理。
- 没有可形成 snapshot 的有效数据时，不采样、不新判断、不 emit；不请求另一路 Quote 伪造策略 snapshot。
- 不新增“相同 cache version 一律跳过”的业务规则。当前 runtime 相同 version 可返回既有运行态；是否收到事件、是否产生一次样本按现行缓存发布和事件处理语义回归。
- 缓存已处理的早到/重复/确认后未确认事件继续按缓存规则忽略。实际可达的 symbol/profile 等私有状态不变量错误和内部异常必须暴露，不能返回 null 掩盖；不要求保留或伪造已删除的 opaque handle 分支。
- 当前在缓存窗口衔接不足时按权威 K 线重新 bootstrap 的确定性计算路径可以保留；它不同于用旧指标替代失败结果。不得把真正不变量错误送进该路径。
- 候选指标状态与其 snapshot 在策略内一起提交，失败不得拼接新旧状态；不要求全宿主引入 `IndicatorRuntimeOutcome` 平台。

### 5.3 保持三个时间角色

| 时间 | 所属来源 | 用途 |
| --- | --- | --- |
| observedAtMs | host 在行情监听时读取；随 latest-only 待处理事件保存 | 验证样本时间戳 |
| 本动作判断时间 | strategy 在现有动作生成位置调用注入的 clock.now() | immediate triggerTime；delayed T0 的起点 |
| timer 登记时的当前时间 | strategy 在调度换算时调用同一 clock.now() | 将 readyAt 转成相对 delayMs |

这三者可以不同。策略有权使用注入的 clock/scheduler；不直接调用系统时钟而绕开注入。宿主不把 callback 到达时间写成信号 triggerTime，也不强制同一事件的所有动作共用时间。

当前策略按现行 `Date` 转换语义计算：

```text
immediate triggerTime = 本动作判断时间
rawTargetMs = 本动作判断时间 + delaySeconds × 1000
rawTargetMs 非有限 → fatal
rawTargetMs <= 本动作判断时间 → 正常无候选（D3，发生在Date转换前）
T0 = Date(rawTargetMs) 的有效毫秒值
readyAt = T0 + 10_000
timerDelayMs = max(0, readyAt - clock.now().getTime())
scheduleTimer(callback, timerDelayMs)
```

监听时间、判断时间、最终 T0/readyAt/输出时间必须为有效时间；派生值非法时不调度、不 emit，并进入 fatal。相对 timer 参数须符合原生 timer 的可表示范围，绝不把 epoch readyAt 直接传给 setTimeout。配置上限仍为 120 秒；不新增长周期 timer 分段机制。

已经到期时以 0 延迟安排一次验证，是正常 deadline 处理，不是立即交易 fallback。验证失败仍丢弃。保持原批次顺序：先按原动作次序计算全部候选，再输出immediate，最后登记delayed；不要把timer登记读clock插入后续动作判断序列。

### 5.4 策略私有 delayed 状态

- BUY 两动作使用 buy 配置，SELL 两动作使用 sell 配置，保持当前策略映射。
- SELL origin 必须有该 ACTIVE 席位、该方向、该 symbol 的已成交买单事实；BUY 不要求该事实。
- initial values 来自本次策略 snapshot。任一需要的初始指标缺失/无效，不登记 pending，也不转立即信号。
- pending 去重保持当前身份语义：`symbol + action + T0`；同一身份已 pending 时忽略重复。symbol 是输入中的只读事实，不是策略的下单选标权限。
- 每项保存自己的初始值、指标列表、T0、timer handle、唯一 token 及 origin emitter。seatVersion 留在 host emitter 的 route 闭包中，不复制到策略 pending。
- 缓存保留窗口保持实际生产装配：`(max(buy.delaySeconds, sell.delaySeconds) + 10 + 15) × 1000`。将这条计算迁入策略，不改成默认 100 秒；即使某侧因空指标为 immediate，也保持现有最大 delay 推导口径。
- 样本保留 value/missing/invalid 信息；按现有 push 时裁剪规则维护窗口。读取保留窗口内距离 T0、T0+5秒、T0+10秒最近的条目；等距选时间较新的条目，不增加容差、不要求三点一定对应三个不同条目。
- BUYCALL/SELLPUT 的后续值严格高于 initial；BUYPUT/SELLCALL 严格低于 initial；ADX 对所有动作均严格低于 initial。所有配置指标、全部三点均须通过。
- 缺样本、缺指标、无效值或比较不通过均正常丢弃；不重建另一个 signal、不重试验证、不降级 immediate。
- timer callback 先检查 destroyed 和 token 身份，再使当前 pending 终态化，然后验证。通过才使用保存的 origin emitter 输出，triggerTime 仍为 T0。
- callback 或 emitter 未处理异常经 fatal sink 报告，不能作为普通 verification failure 继续运行。

只迁移 helper 而保留宿主 pending/timer/cache/onVerified，视为未完成。测试须直接创建策略实例，不能通过旧 verifier 间接证明新 owner。

## 6. 输出适配与执行链路

### 6.1 统一 host emission adapter

每次策略调用创建一个 origin emitter，捕获当时 currentDayKey、允许新判断与否、LONG/SHORT ACTIVE route（direction + symbol + seatVersion）。它可由策略私有 pending 保存，**handleMarketEvent 返回不使该 emitter 自动失效**。

host 不检查策略 pending token，不建立 pending 授权表或 delayed 回调接口。token 有效性由策略负责；host 只检查自己掌握的 origin/current 事实。

每个 decision 的处理顺序：

1. 检查普通对象的精确字段，仅允许 action、triggerTimeMs、可选字符串 reason。action 必须是四种普通动作；时间必须是可精确映射为有效 Date 的整数毫秒。
2. 禁止使用未获准事件的 emitter；动作必须对应 origin 时已捕获的完整 ACTIVE route。同一 origin 重复 action、缺失 origin day/route 或非法字段是内部契约错误，在该 decision 的入队前 fatal。
3. 已有合法 origin 的输出，若当前 day/gate/ACTIVE route/symbol/seatVersion 失效，正常丢弃。不把席位退场后的 delayed 回流误报成缺 origin。
4. 由 host 新建普通 Signal：当前 symbol/name、action、`new Date(triggerTimeMs)`、reason、seatVersion。不得复制策略对象、quantity、orderTypeOverride、relatedBuyOrderIds 或保护性清仓标记。
5. 分 BUY/SELL 进入中性 `STRATEGY_BUY`/`STRATEGY_SELL` 队列；当前开盘保护本身不新增为回流拒绝条件，其他 ordinary gate 继续检查。

adapter 不读取 execution Quote，不做 sizing/risk，不判断来源是 immediate 还是 delayed，也不新增 SELL 回流时的买单记录门禁。当前策略的 SELL 买单事实约束只在生成阶段执行（见 §5.4）；合法 origin 的既有意图按上述当前门禁和席位身份检查后入队。

依据：现有 `registerDelayedSignalHandlers` 在门禁和席位校验后直接分流；`unrealizedLossMonitor` 在保护性清仓提交成功后立即调用 `clearBuyOrders`，不等待实际空仓。因此本地买单记录为空不能证明持仓已清空，也不能在 `SellProcessor.waitForFresh` 之前据此丢弃既有 SELL。后续继续由卖出处理器等待刷新、读取最新可用持仓、计算卖量并协调待成交卖单；智能平仓关闭时保留按可用持仓全卖的语义。本次不新增“保护性清仓取消既有普通 SELL”的政策。

这是逐 decision 提交，不承诺一个事件的全部 action 或 BUY/SELL 跨队列原子性。后续非法 decision、push/通知错误可能发生在先前合法入队之后；立即 fatal，不伪造回滚。队列消费者不得在通知回调中同步执行 Broker I/O，仍由既有异步 processor 消费。

### 6.2 删除无业务消费者的旧字段

删除 `Signal.indicators1`、普通信号写入及 SellProcessor clone 对该字段的复制；同步更新 mock、fixture、类型和注释。仅保留策略 pending 的私有 initial values。

保留 SellProcessor retry clone 本身，以及 triggerTime、相关买单等实际需要复制的字段。测试不能以“仍能复制空指标 map”要求恢复旧字段。

### 6.3 买入、卖出和清仓

买入继续：风险检查冷却 → 频率/清仓冷却/价格/末日拒买/牛熊证/浮亏预筛 → 实时账户与持仓 → 基础风控 → 最新执行行情及最终 mutation gate。策略身份不改变上述权限。

`buyProcessor` 当前在调用 `applyRiskChecks` 前已检查 monitorQuote 存在且价格有限、为正；全生产调用仅此一处。因此同步移除 `BuyRiskCheckContext.monitorSnapshot`、传参和风险管道中的 snapshot 补价，契约直接接收已校验的实时 monitorQuote。不要为消除旧指标类型再创造宿主价格缓存。行情缺失/无效仍在原执行链路拒绝当前买入，不转用旧策略价格；内部错误调用该窄契约应 fail-fast。

卖出继续等待成交后刷新、复核席位、读取执行行情并按现有智能平仓规则计算卖量。行情 retry state 必须保存 signal route/identity，callback 在重入队前检查同一 retry state、owner、当前 ACTIVE symbol/version 和终态 admission；失效即清理 no-op。

删除 `sellQuantityCalculator.ts` 通过 `reason.includes('末日保护程序')` 授权全量卖出的分支。普通 reason 只用于说明。末日、保护性和静态清仓继续使用已有 typed command/专用路径，不经过普通策略，也不等待其 pending。

### 6.4 显示链路

策略在本次指标处理后返回只读 `StrategyDisplayItem[]`，负责指标名称、顺序、数值格式和缺失指标的展示选择。宿主仅保留显示调度、最新行情查询和通用文本输出。

`monitorDisplayRuntime` 的 latest-only state 改为中性显示请求；`marketMonitor` 的监控显示部分不再 import 具体 snapshot/profile、编译指标族 displayPlan 或解释 RSI/EMA/KDJ。监控名称、实时价格、涨跌幅和 K 线时间仍由宿主事实展示，保持现有来源，不用策略文本代替行情。

交易标的报价、持仓与风险显示不迁移。显示投影不能成为交易授权或第二个策略业务回调；也不为显示再次调用策略。stop/reset 时显示 owner 清自己的缓存，策略清自己的指标状态。

启动时 `src/config/validator/index.ts` 对两侧verification及四个DSL的摘要也须迁出宿主；具体策略可在create阶段用注入Logger输出一次已验证的私有配置摘要，不启动timer或交易emitter。宿主仍显示全局交易配置与选中策略状态。

## 7. 生命周期、fatal 与 admission

### 7.1 策略生命周期接线

| 场景 | 宿主调用 | 策略内部效果 |
| --- | --- | --- |
| 开盘保护进入/持续 | 继续投递行情，allowNewEvaluation=false | 继续指标与采样，不新判断；既有 pending 可以验证回流 |
| 普通 gate 关闭、午休、末日接管 | invalidateAll | 同步取消普通 pending/timer/token；不影响专用清仓 |
| 某方向退出 ACTIVE/身份改变 | 同步 seat cleanup listener 调用 invalidateDirection | 只取消该方向候选；不清另一方向 pending 或共享市场指标基线 |
| 午夜跨日 | 按 §7.4 的依赖顺序排空后 resetForTradingDay，再清对应宿主缓存 | 清 pending、timer、sample、增量指标和策略私有显示状态，不 destroy |
| 开盘重建 | 复用同一策略实例，成功后恢复事件 owners | 不重建策略，不恢复旧日 pending；首个新事件重新建立指标基线 |
| fatal/最终退出 | 先关 admission、invalidateAll；排空后执行唯一 destroy registration | destroy 设置不可逆 latch，并释放全部私有状态与 callback 引用 |

`SymbolRegistry` 的 state/truth listener 同步分发。方向取消必须在 mutation 返回前完成，不能只依靠未来异步 cleanup。已入队任务仍由 processor 和 Broker 的 seatVersion 门禁阻断。

`invalidateAll` 不清样本和指标；跨日 reset 才清。所有操作幂等；destroy 后 handleMarketEvent、invalidate/reset 以及迟到 timer 首先检查终态，零采样、零输出、零重排。不得让旧 callback 删除相同 key 下后来创建的新 pending，必须比较 token/entry identity。

### 7.2 最小共享 fatal 入口

保留一个 composition-root 持有的共享 fatal/终止门禁，注入受影响 owners。不要求为此引入完整 owner 注册状态机或 seal 平台，但以下结果必须成立：

1. 首次未处理程序错误，在任何 await、日志或 Promise 通知前锁存原始错误并同步设置 `isTradingEnabled=false`，关闭最终 admission。
2. 先关闭已创建队列的 producer admission，再停止产生新业务的事件监听、调度和策略候选；每个同步 stop 都应尝试，单个失败不能阻断其他 stop。此处不提前执行 QuoteSubscriptionRuntime 的资源停止；它须按 §7.4 等待 PostTrade 及其他订阅协调生产者排空后再 stopAndDrain。
3. 通知 runApp 的唯一 fatal 等待入口，按 §4.2 等当前装配落定并登记晚到资源后，执行既有分阶段 cleanup；不能由多个 owner 竞争不同 primary error。
4. 所有 reopen、lifecycle tick/rebuild、席位激活和 processor restart，在真正放行前及相关 await 后检查终止状态。fatal/最终退出后不得重新启动业务。
5. 保留每个 owner 的局部 running/inFlight 状态以服务 stop/drain；删除重复的 primary-fatal 真相，而不是删除局部资源状态。
6. 现有 `isExternalApiRequestError`、freshness abort、行情 MISSING 和业务有界 retry 先按所属链路分类，可恢复失败不能统一升级 fatal。

同步停止生产与异步等待排空必须区分，不能在 fatal sink 中无等待调用一次 `stopAndDrain()`，再由 cleanup 创建另一份互相覆盖的 drain 等待。现有 PostTrade 仅保存单个 `drainResolve`；应拆分同步禁调度与异步排空，或在同一停止周期复用 drain Promise，确保重复停止的所有等待方均能收口。正常跨日停止仍可重新启动，不得把普通 stop 变为永久终态。

正常退出订阅必须在 termination/cleanup 建立后、策略及首个 SDK/业务资源创建前安装。将旧 `waitForShutdownSignal` 的晚安装 Promise 接口替换为接收同步回调并返回幂等释放函数的订阅接口；SIGINT/SIGTERM 回调在当前调用栈先置终态、关闭 gate/admission、停生产，再通知主流程，不能只 resolve Promise 等待微任务关门，不伪报 fatal。主流程只等待共享终止入口；装配中退出按 §4.2 等待当前创建落定及登记晚到资源，再执行唯一 cleanup。

订阅保留至 cleanup 尝试结束，外层 finally 在正常退出、启动失败、fatal、cleanup 抛错时均释放；清理期间重复信号只幂等请求正常终止，不提前移除监听、不启动第二份清理，也不新增第二次信号强制退出政策。该受控退出不承诺捕获 SIGKILL 或监听安装前的进程强制终止。

构造错误先 report，再按 §4.2 收口装配并执行 cleanup。已有主错误时清理错误仅作 secondary；没有主错误而 cleanup 失败时，按现行 runApp 规则报告清理失败，不能吞掉。

### 7.3 队列终态与生产者

trade queue 和 monitor queue 增加不可重开的最终 close。关闭后 push/scheduleLatest 零 mutation、零通知，并返回明确的未接纳结果；pop/clear 仍可用于清理。正常跨日、午休和 processor stop/restart 不永久 close。

最终退出/fatal 同步 close 后，processor 不得重新注册 onTaskAdded 或恢复调度。以下生产者必须逐一接通 admission：

- 普通 strategy emitter 的 BUY/SELL push；
- SellProcessor 行情 retry；
- MonitorTaskProcessor 的 SEAT_REFRESH retry；
- SeatActivationDispatcher 的激活任务；
- PeriodicSwitchWakeupRuntime 的周期任务；
- AutoSearch/seat 事件间接调度。

异步等待或 timer 之后，生产者在入队前复核自己的有效性和适用授权；交易信号检查普通 gate/route，recovery/激活任务检查自身权限，不能错误要求它们已处于 ACTIVE 普通交易态。最终关闭后的迟到回调清自己的状态并 no-op；如果当前 owner/queue 状态互相矛盾，则作为内部契约错误报告。

队列 close 不是跨队列事务，也不是清空在途 Broker I/O。已经提交的订单副作用不承诺撤销。

### 7.4 清理所有权

保留 `CLOSE_TRADING_GATE` 第一阶段，后续按实际生产者与依赖关系执行 stop/drain/clear，而不是机械沿用现有停止顺序：

```text
关 gate 与 producer admission
  → 停止事件/timer/调度，取消策略候选，中断 freshness 等待
  → 排空业务 owners/processors，停止并排空订单监控
  → 停止并排空 PostTradeConsistencyRuntime 及其 onPositionsCommitted 回调
  → 确认其他订阅协调调用方均已排空，再停止并排空 QuoteSubscriptionRuntime
  → 最终退出执行唯一 strategy.destroy；午夜执行 resetForTradingDay（不 destroy）
  → 清宿主 queue/cache，释放对应场景的各自资源
```

依赖顺序依据：`createPostTradeConsistencyRuntime` 在持仓请求返回后仍会调用 `onPositionsCommitted`，生产接线会进入 `QuoteSubscriptionRuntime.reconcilePositionHoldFromCurrentTruth` 并排入订阅 mutation。当前 `signalRuntimeDomain.midnightClear` 和 `src/constants/cleanup.ts` 均先停 Quote、后停 PostTrade，可能在 Quote 停止完成后重新写入订阅。因此午夜清理、正常退出和 fatal cleanup 均须改为先排空这些生产者，再停止订阅协调 owner；PostTrade 的 drain 必须等待在途请求及其回调完成，不能仅取消后续 timer 就宣告排空。

优先修正停止顺序，不新增通用 supervisor 或备用清理链路。不得用 `running=false` 一律拒绝 reconcile 来替代顺序修复：启动和开盘重建在订阅 owner 启动监听前仍需显式 reconcile。最终终止 admission 与正常重建授权继续按 §7.2 区分；Quote 停止完成后不得再有旧生产者产生订阅 mutation。

strategy handler 只销毁该实例；宿主资源各由自己的 owner 清理，不互相代行。依D2，只有最终退出cleanup逐阶段捕获错误并继续尝试后续清理，保留主错误，失败的drain不得记为成功。正常午夜任一步失败即停止本轮后续domain：明确外部API错误沿原lifecycle重试，内部错误fatal；未排空不能继续reset或清依赖事实。strategy-only registration在实例返回后立即登记，正常退出、fatal和部分装配失败均只调用一次destroy。

跨日不 destroy，保留既有 lifecycle domain 的业务分层；signal runtime 内部采用上述修正后的依赖顺序清理，重建仍按原有事实恢复和显式 reconcile 流程执行，不机械逆序调用所有 start。不得为保留旧 `CLEAR_INDICATOR_CACHE` phase 而留下空 handler；相关 phase/type/调用随 owner 一起更新。

## 8. 资产、启动和部署

### 8.1 一次性构建与启动

当前 `build` 为 clean + tsc，`start` 直接启动源码；JSON 不会因普通 tsc 编译自动进入 dist。必须补齐资产，但不强制生产 start 增加 supervisor 或 manifest。

新增最小资产工具，自动枚举 `src/core/strategy/` 每个一级子目录；所有目录都是候选，非法名字、大小写冲突、路径越界、缺definition/config、无策略均使构建失败，不因缺文件静默跳过。共享内容放根级文件或根外。项目根/输出根由工具模块位置和实际tsconfig布局解析，不依赖cwd，不维护或生成ID/path清单。

- 全部候选元信息预检后 clean → tsc → 核对并动态导入各编译definition.js → 验证固定导出/id/相邻产物configHref → 读取对应源JSON原文一次并交该编译prepare验证 → 将同一原文完整写入/原子替换到相邻产物地址；全部成功才退出0。构建使用编译定义，目标JSON复制前不存在也不影响纯prepare，不允许其自行读文件。
- 当前实际布局为 `dist/src/core/strategy/<目录>/definition.js` 和相邻config.json，入口为 `dist/src/index.js`；不是dist/core。source与dist启动各自只有一个本地地址，无扩展名或源码fallback。构建从源码资产复制到产物是显式构建步骤，不是运行时补值。
- 全部策略在构建阶段prepare但不create、不访问SDK或认证配置；应用运行时只import/read/prepare选中项。验证和复制使用同一原文，不能二次读文件引入不一致。每轮构建的资产校验用独立进程，防模块缓存验证上一轮定义；不以随机URL query绕过缓存。
- `start` 可保留明确的源码入口；另行验证 dist 入口。若调整入口，package scripts 和部署说明必须一致，不得找不到 dist 后回退源码。
- 运行进程持有启动时的不可变配置，不做热重读。生产配置变更经停机/重启生效；外部文件改动不是运行期 fallback 触发器。

### 8.2 开发循环的最小正确行为

不假设 `readFile(configHref)` 或动态import会被Bun模块watcher完整跟踪。本仓库不提供 watch 命令（`dev:watch`/`build:watch`/`test:watch` 及 `concurrently` 已移除）；源码或策略资产变更后显式执行完整 build（clean → tsc → 资产校验与同步）并全部成功才启动，不得继续运行过期 dist 或旧产物配置；缺入口的半成品策略目录、删除或非法的策略配置使构建非零退出，失败构建的产物不得当作可启动资产使用。已有选择配置文件变化沿停机/重启生效，不热读运行中env。

开发循环不使用 watcher，也不要求 production start、宿主 owners 或部署平台为此新增 supervisor。不能通过 touch 假模块、随机 URL query、源码路径 fallback 或继续保留过期 dist 来掩盖 JSON-only 未生效。

### 8.3 恢复与发布

保持现有恢复模块业务判断：`seatPreparation`、`orderOwnershipParser`、`orderMonitor/recoveryFlow`。匹配挂单按原规则恢复；不匹配 SELL 阻断恢复。策略 ID 不进入这些判断。

不匹配 BUY 请求撤单，仅在取得可信终态、启动快照与权威终态均无成交冲突且安全结算成功时继续恢复。撤单请求已接受但终态未确认、撤单失败、缺少权威终态或存在成交冲突，均按现有 `recoveryFlow` 阻断本次恢复、清理恢复状态并转入 STOPPED。上述分支当前抛出普通程序错误，启动或开盘重建沿现有错误分类上抛并退出，不在原恢复流程中继续等待 WS，也不新增自动重试。只有按现有链路分类为明确外部 API 请求失败的异常才保留所属恢复重试语义；本次不改写恢复失败政策。

发布顺序：真实JSON与全部策略构建验收完成 → 停止旧进程并等待订单/资源安全收口 → 部署完整程序、策略目录、ACTIVE_STRATEGY_ID和JSON资产 → 新进程校验选中项 → 原有recovery/rebuild成功 → 放行唯一策略。发布前参数变更须返回受影响构建/回放验证，不直接改已验收资产上线。pending、timer、samples、普通queue不跨进程恢复；真实账户事实按原机制连续。

部署方负责单进程下单及发布包一致性。失败后的部署级原子回滚可以恢复完整旧程序和旧 env；这不是应用内选择旧策略/旧配置的 fallback。新旧程序都不得在运行期互相补值。

## 9. 实施工作包与引用闭合

以下工作包可分别开发，但接口生产者、消费者和旧 owner 的最终切换必须形成同一可编译变更，不发布双实现或半接线版本。

### 9.1 基线与新策略内部

- 固定当前有效配置、四表达式、两侧延迟、N-of-M、指标增量、ADX、nearest/tie-break、采样时间和派生保留窗口。
- 新增具体 definition/config/parser/工厂；迁入当前 `core/strategy` 规则、`services/indicators` 策略编排、DSL/指标 helper、验证常量及 verifier/cache 行为。
- 策略工厂自身拥有全部状态；保留必要纯数学实现，不为尚不存在的复用创建平台。`tools/dailyIndicatorAnalysis/indicatorCalculators.ts` 实际复用EMA/KDJ/MFI/RSI数学与类型，按执行计划保留这些中性模块并更新直接imports，不能排除tools编译或残留旧re-export掩盖。
- 更新私有类型和头注释，具体策略测试迁入 `tests/core/strategy/intradayRegression/`，目录与源码对应。

### 9.2 宿主接口、显示与风险切换

- 新建公共端口、严格命名映射和唯一动态加载边界，修改 `runApp`、`RunAppDeps`、pre/post-gate 和 `createMonitorContext`；注入I/O/importer，不注入definitions数组。不创建静态/生成式注册文件。
- `businessEventProgram` 从宿主指标/延迟流水线改为中性行情投影及一次策略调用；`signalPipeline` 删除或缩为统一 emission adapter，不能保留分类委托链。SELL 买单事实约束保留在当前策略生成阶段，adapter 不新增回流记录门禁；既有意图继续进入 freshness 与卖量计算链路。
- 删除 `MonitorContext` 的 verifier/profile 和宿主策略 snapshot/runtime 状态；检查 `src/types/state.ts`、`src/types/services.ts`、`src/types/monitorContextPorts.ts`、helpers 初始化、lifecycle/globalStateDomain 和 cleanup。
- `monitorDisplayRuntime`、`marketMonitor` 及其类型改用中性显示数据；具体 displayPlan 和指标读取迁入策略。
- 删除 BuyRiskCheckContext 的 monitorSnapshot、buyProcessor 传参、riskCheckPipeline 的不可达补价。收窄 monitorQuote 契约，保留买入前行情拒绝行为。
- 删除 Signal.indicators1 和仅针对该字段的 clone/mock/fixture；移除 reason 文本授权，不改 typed 清仓语义。

### 9.3 生命周期与安全接线

- timeWakeupEvaluationProgram、signalRuntimeDomain、seatRuntimeCleanupDispatcher 改调策略 invalidate/reset；最终 cleanup 只登记一次 destroy。
- 接通统一 fatal/终止 gate、所有 reopen 路径及队列终态；受影响 owners 共享主错误入口，不保留并列 primary-fatal drain。
- 检查 sell/monitor retry、激活/周期/寻标生产者和 stop/restart，正常跨日不能误永久关闭队列。
- 同步修正 `src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` 与 `src/constants/cleanup.ts` 的停止顺序：订单监控和业务生产者排空后，先排空 PostTrade 及其 `onPositionsCommitted` 回调，再停止 QuoteSubscriptionRuntime。核对 `createPostTradeConsistencyRuntime`、`createPostGateRuntime` 的回调接线及 quote reconcile/retain/release 调用方，确保没有订阅 owner 停止后的迟到 mutation；保留启动和重建显式 reconcile。
- 原有 freshness、重建、风险和订单 I/O 的错误分类保持，不因统一入口吞掉或错误升级外部失败。

### 9.4 删除与部署收口

目标生产路径必须删除：

- `src/main/asyncProgram/delayedSignalVerifier/`；
- `src/main/asyncProgram/indicatorCache/`；
- `src/app/wiring/registerDelayedSignalHandlers.ts`；
- 旧 `createMultiIndicatorTradingStrategy`、默认/可选旧 strategyFactory、immediate/delayed 返回接口；
- `IMMEDIATE_*`/`VERIFIED_*` 普通任务分类和旧策略 env parser/类型/导出。

旧 verifier/cache 测试在行为移植后删除；共享目录中只用于该策略的 profile/runtime/types/helpers 同步移动或删除，不留 re-export。混合工具文件只迁移本次相关函数，其余通用配置和宿主工具保留。

`src/types/indicatorProfile.ts`、`src/types/signalConfig.ts` 及 `src/types/quote.ts` 的具体指标结构，按最终消费者归入私有目录；删除 `src/types/indicatorRuntime.ts` 的公共 opaque handle，不建私有句柄替身，不以测试引用保留生产公共契约。同步检查 `src/constants/index.ts` 的相关类型 import 和混合常量成员。

更新资产工具、package scripts、`.env.example`、README、直接相关部署引用及 `mock/`。不扩展修改无关 docs/tools。

## 10. 验收与发布门禁

### 10.1 必要行为测试

| 领域 | 必须证明 |
| --- | --- |
| 选择/装配 | ID精确映射；非法ID、选中路径/导出/身份/配置错误在SDK前失败；未选模块零import/read/prepare/create；实例仅创建一次，资源先于完整context，部分失败无泄漏 |
| 策略独立性 | 临时根新增不同schema/私有指标的测试策略目录，不改中心文件即可选择运行；宿主/公共类型无具体策略静态依赖，策略间无私有import或聚合入口 |
| 配置保持 | 四表达式必填；两侧 0–120 数值范围；空列表/零延迟为显式立即语义；非法配置不补值；已核实旧有效值可显式迁移；无虚构生产参数 |
| 指标 | 当前 committed/preview、确认/换柱、窗口衔接、partial snapshot、N-of-M 与原行为一致；同版本处理不擅自改变采样集合；内部异常不伪装无信号 |
| 时间 | latest-only 使用最新监听 observedAt；动作生成时间与其可以不同；多动作时间不强制相等；T0/ready/相对 timer 正确；不把绝对 epoch 传入 timer |
| delayed | 策略直接创建测试；覆盖 initial、去重、两侧映射、派生窗口、nearest/等距、三点/ADX、失败丢弃、延迟通过的原 T0 输出 |
| 生命周期 | 开盘保护继续采样不新判断，已有 pending 可回流；方向失效不影响另一方向；跨日清指标/sample/pending 但不换实例；destroy 与旧 token 迟到 callback 零副作用 |
| emitter | 无 Broker 能力；非法对象拒绝；origin 缺失是契约错误、当前 route 失效正常丢弃；异步保存 emitter 可回流；SELL 生成阶段有 filled BUY，回流时记录已清但 route/gate 有效仍入队；输出不携带指标/数量/清仓授权 |
| risk/display | 实时报价缺失仍拒买，不依赖策略快照；新增指标只改策略显示投影，宿主仍展示同源实时报价；显示不授权交易 |
| queue/fatal | 同步关门、防reopen、终态后零入队/通知、正常跨日可restart；各producer收口；最终退出单个stop/cleanup错误不阻断其他清理，不覆盖主错误；午夜保留D2中断/分类重试 |
| 清理依赖 | 午夜、正常退出和 fatal 均先排空 PostTrade 在途请求及订阅回调，再停止 Quote；Quote 停止完成后无旧生产者订阅 mutation；启动/重建仍可在监听 start 前显式 reconcile |
| 清仓/recovery | 任意普通 reason 不授权清仓；typed 清仓不变；既有延迟 SELL 不因清仓提交后清空记录而提前丢弃，智能平仓关闭时仍经过 freshness 按最新可用持仓处理；匹配/不匹配 BUY/SELL 恢复矩阵不变；strategyId 不分账 |
| 资产 | 全目录自动发现；缺入口/配置、跨平台名字冲突和未选坏配置均阻断build；编译prepare与资产同原文且零create；隔离dist/非cwd无源码fallback；首次build期间新增目录和JSON-only变更均不漏报，不用旧资产 |
| 加载边界 | ID/目录可逆且精确拼写；拒绝symlink/junction、错误URL/扩展名；固定导出及同步prepared/instance验证；传递依赖错误保留cause；构建全量校验、启动仅选中校验有分别的证据 |

以下关键边界必须使用可控时序和明确结果分类直接验证：

1. 生成延迟 SELL 时存在已成交买单；保护性清仓提交后清空本地记录但未证明空仓；验证通过时 route/gate 仍有效，adapter 必须入队。执行阶段挂起 freshness，确认刷新前不提交；刷新后在智能平仓关闭且存在可卖持仓、待成交卖单协调允许的条件下继续原有执行。另保留 route/gate 失效时丢弃的负向场景。
2. 挂起 PostTrade 的持仓请求后分别触发午夜清理、正常退出和 fatal，再释放请求；记录 `onPositionsCommitted`、PostTrade drain 与 Quote stop 的完成顺序，确认 Quote 停止完成后不再产生订阅 mutation。同一停止周期重复请求停止，所有 drain 等待均须完成；正常重建后再次 start/stop 仍成功。另验证开盘重建在 Quote 监听 start 前显式 reconcile 仍成功。不能只断言 stop 方法被依次调用而不等待其异步完成。
3. 正常退出订阅早于策略/首个业务资源创建；分别挂起资源创建、初始 rebuild、Quote reconcile、初次时间唤醒，触发 fatal 或正常退出，不推进微任务即断言终态/gate/admission 已关。释放后晚到资源先登记再唯一 cleanup，资源/已创建策略各清理一次，无后续创建/start/reopen；纯正常退出无伪造 fatal，之后发生的真实内部错误仍保留。cleanup 挂起期间重复信号不重入清理；正常退出、启动失败、fatal、cleanup 失败均释放订阅。信号替身在订阅时才绑定回调，不使用可保存订阅前历史触发的预建 Promise 掩盖晚监听；采用离线替身，不恢复 watch。
4. 不匹配 BUY 分别覆盖撤单请求已接受但终态未知、可信零成交终态且安全结算成功、快照或权威终态存在成交事实，以及明确外部 API 请求失败；同时断言恢复结果、普通 owner 是否启动、是否退出及是否安排生命周期重试，保持 §8.3 的既有错误分类。

最重要的扩展测试不是提供第二套生产策略，而是在临时策略根新增一个遵守公共交易能力、使用不同私有配置和指标计算的目录，不修改任何中心文件就能选择、加载并创建，证明宿主零修改。只验证切换硬编码ID或修改隐藏清单不构成通过。

### 10.2 结构和残留检查

采用三类互补证据：

1. 生产/旧测试路径存在性检查，确认旧 owner 真正删除。
2. 有界import/module graph检查：生产宿主仅由prepareStrategy的受限动态加载边界装配，构建工具是独立阶段的全量加载入口；公共类型/事件/执行/显示/lifecycle不依赖具体目录，禁止跨策略私有import/barrel。静态import/type/export及字面量/计算动态import均纳入；受准入口核验URL构造/导入前路径检查，并以实际求值计数补足静态图。
3. 构造次数、引用身份、cancel/reset/destroy 及迟到回调行为测试。

不要求开发能证明“任意改名的等价 owner”不存在的语义分析系统；结构规则和运行行为须共同复核。针对原路径执行搜索并逐项归类：

```powershell
rg -n "delayedSignalVerifier|indicatorCache|registerDelayedSignalHandlers|onVerified" src tests mock
rg -n "createMultiIndicatorTradingStrategy|DEFAULT_STRATEGY_FACTORY|TradingSignalStrategyFactory|immediateSignals|delayedSignals|IMMEDIATE_BUY|IMMEDIATE_SELL|VERIFIED_BUY|VERIFIED_SELL" src tests mock
rg -n "indicators1|lastMonitorSnapshot|incrementalIndicatorRuntime|verificationIndicatorsBySide|IndicatorUsageProfile|IndicatorSnapshot" src tests mock
rg -n "SIGNAL_BUYCALL|SIGNAL_SELLCALL|SIGNAL_BUYPUT|SIGNAL_SELLPUT|VERIFICATION_DELAY_SECONDS_BUY|VERIFICATION_DELAY_SECONDS_SELL|VERIFICATION_INDICATORS_BUY|VERIFICATION_INDICATORS_SELL" src tests mock tools .env.example README.md
rg -n "IndicatorIncrementalRuntime|indicatorRuntimeStateBrand|toIndicatorIncrementalRuntime|unwrapIndicatorRuntime" src tests mock
rg -n "waitForShutdownSignal|SIGINT|SIGTERM" src/app tests/app
rg -n "isTradingEnabled\s*=\s*true|failFatal|fatalError|drainFatalError|onFatalError" src/app src/main src/core
rg -n "\.(push|scheduleLatest)\(|onTaskAdded|scheduleTimer" src/main src/app
```

具体指标/profile 名称允许存在于策略私有目录；旧环境键仅允许拒绝旧键测试、一次性迁移资料和必要迁移说明。宿主风险冷却仍保留真实宿主职责，不应被名称搜索误删。每项残留须有实际消费者证据，不能单凭 grep 无命中宣布完成。

### 10.3 验证命令与状态

实施前可运行旧 strategy/verifier/cache、business event、indicator runtime 和 context 测试记录基线；它们不证明目标实现已完成。迁移后只运行仍存在且归属正确的测试目录，例如：

```powershell
bun test tests/core/strategy tests/main/businessEventProgram tests/main/monitorDisplayRuntime tests/services/marketMonitor
bun test tests/app tests/main/lifecycle tests/main/seatRuntimeCleanupDispatcher tests/main/timeWakeupEvaluationProgram
bun test tests/main/asyncProgram tests/core/signalProcessor tests/main/recovery tests/core/trader/orderMonitor
bun format
bun lint
bun type-check
bun test
bun run build
```

新增结构测试放现有 architecture 测试体系，并由完整 `bun test` 执行；最终命令不得继续指定已删除的旧 verifier/cache 测试目录。实际目录调整时同步更新命令，不能用不存在路径当作通过记录。

另外执行 clean-dist/临时 cwd 下 JSON-only 更新、删除、非法输入后重新构建的检查。format/lint/type-check 按项目要求顺序运行；不为纯文档修订运行会改写全仓的 format。

当前状态：D1–D5已确认，免注册自动加载已同步本设计合同和最终执行计划；生产代码尚未迁移。执行入口为配套execution-plan，发布必须具备目标测试、引用清理、完整校验和构建资产证据；部署配置、单进程及恢复演练由真实部署证明。不得以最终文档、旧实现测试通过或回滚可用代替目标验收。
