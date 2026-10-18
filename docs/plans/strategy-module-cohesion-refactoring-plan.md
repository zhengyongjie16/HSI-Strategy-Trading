# 策略独立功能模块内聚重构方案

> 状态：设计已确认，待实施；本文不是代码迁移完成报告。  
> 已确认决策：具体策略统一放入 `src/strategies/<strategyDirectory>/`，策略私有逻辑不得继续按顶层技术层分散。  
> 分析基线：`beta-V2` 提交 `c36cadb2d7c1a424d9998b7b9db20f01d78819f9`；对照 `develop` 提交 `6e239c8a128372bd9b2fb2d79464346792a5e81e`。分析时已通过远端引用核对两者；实施前须重新确认工作区和提交。  
> 本次交付只新增方案文档，不修改生产代码、测试、架构规则或项目规范。方案中的勾选项均为后续实施任务。源码行号仅作为基线定位提示，以文件和符号为准。

## 1. 目标、结论与非目标

### 1.1 核心目标

把一种策略恢复为一个完整、独立、便于新增和修改的功能单元：

1. 入口、静态配置、配置解析、DSL、指标需求、指标计算、信号规则、延迟验证、私有状态、显示投影及私有常量归属于同一个策略目录。
2. 策略外部仅通过中立契约接入；系统不读取具体策略的指标、样本、pending 或配置结构。
3. 在现有输入输出能力范围内，新增策略只增加策略目录和测试，选择时设置 `ACTIVE_STRATEGY_ID`；不改加载器、中央注册表、宿主行情处理器、订单执行或生命周期实现。
4. 保留当前事件驱动、交易授权、金融数值、错误分类和清理语义，不把目录迁移做成交易行为重写。
5. 静态架构检查、真实 source/dist 加载和测试共同证明边界，而不只证明 TypeScript 可以编译。

**独立不等于单文件，也不等于整个仓库只有一个位置调用策略。** 同一策略可以有多个职责明确的内部文件；宿主在行情、席位和生命周期边界调用公共接口是必要连接，不属于策略逻辑外泄。

### 1.2 已确认的根因

当前日内回归策略有 31 个具体策略文件，分属五个根：

| 根位置 | 文件数 | 职责 |
| --- | --: | --- |
| `src/app/startup/strategyDefinitions/intradayRegression/` | 1 | 具体策略入口 |
| `src/config/strategy/intradayRegression/` | 4 | JSON、解析器、DSL、解析类型 |
| `src/domain/strategy/intradayRegression/` | 22 | 指标、profile、信号、显示、验证规则和样本 |
| `src/runtime/strategy/intradayRegression/` | 3 | 实例、pending/timer、执行类型 |
| `src/constants/strategy/intradayRegression.ts` | 1 | 私有规则常量 |

`develop` 对应实现为 `src/core/strategy/intradayRegression/` 内的 28 个文件。对比确认，候选评估及策略工厂正文、时间校验及 pending owner 正文在两个分支相同；纯验证函数正文也相同。现有策略接口、私有状态 owner、保存 emitter 和延迟输出重新授权在 develop 已经存在，不是本次需要重新创造的能力。

问题在于技术分层替代了功能归属，并被以下机制固化：

- `src/app/startup/prepareStrategy.ts:55`：入口和配置采用两个根目录。
- `src/app/startup/strategyLoaderHelpers.ts` 的 `inspectStrategyLocation`：跨根配对校验。
- `eslint.config.js` 的 `strategyPrivateBoundaryRule`：识别四个私有策略根。
- `tests/architecture/strategyBoundary.test.ts` 的 `privateStrategyOwner`：同样按四根识别。
- `tests/architecture/refactoring/scanner.ts` 的 `selectedStrategyPath`：固化原入口布局。

此外，私有常量在第五个根，却未纳入上述四根策略归属。基线下，宿主导入 `ACTION_RULES` 不会触发策略私有边界错误；已检查到的生产消费者仍在本策略内部，不能将检查缺口描述成已发生的交易错误。

### 1.3 保留而不回退的改进

- 保留 `src/types/strategy.ts`，不把公共契约搬回具体实现根。
- 保留中立 `CandlestickPeriod`，不恢复 develop 公共契约中的 Longbridge `Period`。
- 保留 `signalRules.ts` 命名，不恢复装业务规则的泛化 `utils.ts`。
- 保留纯验证计算与有状态 pending 调度的文件区分。
- 保留当前 app、application、runtime、domain、infrastructure 的其他职责边界。

### 1.4 非目标

不增加多策略并行、运行期热切换、多监控标的、多周期订阅、策略注册中心、基类、通用 DSL 引擎、全局指标服务、统一 timer scheduler、回测平台或新的下单权限。

不改变策略公式、参数值、采样规则、指标缺失语义、时序、交易门禁、订单数量、委托类型、清仓、寻标换标、频控或金融精度。不借机实施其他性能计划。

## 2. 证据、验证结果与实施前置阻塞

### 2.1 已追踪的生产路径

```text
app/runApp
  → prepareStrategy
    → 精确定位选中 definition/config
    → importStrategyDefinition
    → definition.prepare
  → createSelectedStrategy
    → prepared.create
    → 登记 destroy、校验完整实例
  → 注入 MonitorContext

K 线更新
  → runtime/businessEventProgram
    → single-flight / latest-only
    → 冻结行情、席位和新评估门禁快照
    → 创建保存初始 origin 的 emitter
    → strategy.onCandlestick
      → 指标、样本、显示
      → 候选评估
      → immediate emit 或 pending.register
        → 私有 timer
        → 验证规则
        → saved emitter
    → emissionAdapter 复核当前授权并转换为普通交易任务
    → 买卖队列及既有执行链路
```

生命周期连接继续由既有 owner 负责：

- `runtime/seatRuntimeCleanupDispatcher`：席位退出 ACTIVE 或身份变化时调用 `invalidateDirection`。
- `runtime/timeWakeupEvaluationProgram`：离开连续交易时段、进入末日接管时调用 `invalidateAll`。
- `runtime/lifecycle/cacheDomains/signalRuntimeDomain`：停止并 drain 后调用 `resetForTradingDay`。
- `app/runApp` 的 termination 路径：关闭门禁和 admission，作废待验证输出。
- `app/startup/createSelectedStrategy` 与 cleanup：最终调用 `destroy`。

### 2.2 已执行的检查

| 检查 | 基线结果 | 解释 |
| --- | --- | --- |
| 日内策略规则、配置、实例、pending、加载、宿主、普通执行集成及策略架构定向测试 | 225 pass，0 fail，24 个文件 | 前一轮分析实际运行；不等于全仓测试通过 |
| `bun test tests/build/productionBuild.test.ts tests/helpers/importFixtureModule.test.ts` | 4 pass，1 fail，2 个文件 | 本轮补跑真实 clean + tsc、JSON 资产及加载边界 |
| 独立重跑构建替换性失败用例 | 相同位置再次 EPERM | 不是仅根据一次运行推断 |
| 工作区检查 | 写本文前干净 | 未修改生产代码来取得结果 |

第一组定向范围为：

```powershell
bun test tests/runtime/strategy tests/domain/strategy tests/config/strategy tests/app/startup/prepareStrategy.test.ts tests/app/startup/createSelectedStrategy.test.ts tests/app/startup/strategyDefinitions tests/runtime/businessEventProgram tests/integration/singleActiveStrategyExecution.integration.test.ts tests/architecture/strategyBoundary.test.ts tests/architecture/importBoundary.test.ts tests/architecture/refactoring/strategyDynamicBoundary.test.ts
```

本轮没有执行全仓 lint、type-check 或全量测试；文档格式检查另行记录，不冒充代码重构验收。

### 2.3 前置阻塞 B1：Windows 上已加载源码目录重命名失败

失败用例：`tests/build/productionBuild.test.ts` 的 `independent private schemas run source and clean-build dist from create to decision queue`。

基线 `:629` 在同一测试进程已执行两个 source smoke 后调用：

```typescript
await rename(nodePath.join(f.root, 'src'), nodePath.join(f.root, 'source removed'));
```

Windows / Bun 1.3.14 下两次出现 `EPERM`。观测到两个 source smoke 已运行；本用例随后要求的无源码 dist smoke 未执行，不能计为通过。错误发生于已加载源码目录的重命名；具体文件句柄持有者尚未证实，不把推测写成已确认根因。

后续实施须优先修复测试隔离，不改生产行为：

1. source smoke 在受控子进程中执行，进程结束后才重命名或移除临时工程的 `src`。
2. dist smoke 在新的受控子进程中执行，仍要求原 `src` 路径不存在；共享的计数、断言结果通过明确输出传回父进程，不依赖跨进程 globalThis。
3. 复用 `tests/setup/childEnv.ts` 的受控环境，不继承真实认证配置，不启动应用或 SDK context。
4. 等待子进程退出、收集 exit code，并在 finally 中释放临时资源。
5. 如果隔离后仍失败，继续定位文件占用；不得用固定 sleep、任意重试、Windows skip、复制第二棵源码或保留 `src` 的方式假装完成无源码验证。

B1 解决并通过原行为断言前，不得宣称构建基线或迁移验收全部通过。本次只记录该阻塞，不修改其测试实现。

## 3. 目标模块边界

### 3.1 策略内部与宿主的职责分界

| 策略模块拥有                      | 宿主系统拥有                     |
| --------------------------------- | -------------------------------- |
| 本策略配置 schema、DSL 与参数编译 | 选中哪个策略、加载位置与身份校验 |
| 指标需求、计算、增量基线          | SDK 行情接入、行情缓存与订阅     |
| 信号条件、候选、验证趋势规则      | 交易日、交易门禁与席位真实身份   |
| 指标样本、pending、timer token    | 订单事实、买卖队列与 admission   |
| 通过注入 scheduler 管理私有等待   | 实际时钟、原生定时器及平台适配   |
| 私有状态 reset/destroy            | 生命周期事件与清理顺序           |
| 指标名称、数值文本投影            | 显示调度、报价展示和输出 I/O     |
| 普通四动作 decision               | 数量、委托类型、风控及最终下单   |

首次 SELL 必须存在已成交买单事实，是现有普通信号安全契约的一部分：策略生成候选时检查，宿主验证初始 origin 时也检查。不得为了减少重复判断改变该授权语义。延迟 emit 时不重新查询这一初始买单条件；最终可卖量由执行链路决定。

### 3.2 对外契约维持不变

继续使用 `src/types/strategy.ts` 中的：

- `StrategyCandlestickSnapshot`、`StrategySeatFact`、`StrategyMarketContext`；
- `StrategyDecision`、`StrategyDisplayItem`、`StrategyEmitter`；
- `StrategyDeps`、`TradingSignalStrategy`；
- `PreparedStrategy`、`StrategyDefinition`。

`StrategyDeps` 继续只有 clock、scheduler、logger、onFatalError。`StrategyDecision` 继续只有 action、triggerTimeMs 和可选 reason，不增加 symbol、数量、订单类型或清仓能力。

`onCandlestick` 保持同步，不接受 Promise 返回；允许保存本次 emitter 用于私有延迟验证。配置 prepare 与实例 create 分离，启动只创建一个实例，跨日重置同一实例。

### 3.3 目录结构

```text
src/
├── strategies/
│   └── intradayRegression/
│       ├── definition.ts
│       ├── config.json
│       ├── config.ts
│       ├── dsl.ts
│       ├── constants.ts
│       ├── index.ts
│       ├── types.ts
│       ├── signalRules.ts
│       ├── display.ts
│       ├── indicatorHelpers/
│       │   ├── types.ts
│       │   └── utils.ts
│       ├── indicators/
│       │   ├── index.ts
│       │   ├── indicatorMath.ts
│       │   ├── types.ts
│       │   └── adx.ts / ema.ts / kdj.ts / macd.ts / mfi.ts / psy.ts / rsi.ts
│       ├── profile/
│       │   ├── index.ts
│       │   ├── types.ts
│       │   └── utils.ts
│       └── verification/
│           ├── index.ts
│           ├── pendingVerification.ts
│           ├── sampleRules.ts
│           ├── sampleStore.ts
│           └── types.ts
├── types/strategy.ts
├── app/startup/
│   ├── prepareStrategy.ts
│   ├── strategyLoaderHelpers.ts
│   ├── createSelectedStrategy.ts
│   └── types.ts
├── constants/strategy.ts
└── domain/strategy/
    ├── ordinarySignalGuard.ts
    └── utils.ts
```

选择顶层 `strategies`，因为完整策略同时具有纯计算、配置准备和受控运行态；不能把它整体塞入纯 domain，也不应重新在策略内部复制 app/domain/runtime/config 四层。

`src/strategies/` 不新增 registry、index 聚合出口、shared 指标层或类型转发文件。每种策略的固定入口为自己的 `definition.ts`。

### 3.4 依赖规则

| 来源 | 允许 | 禁止 |
| --- | --- | --- |
| 同一策略内部 | 直接导入本策略文件；中立数据/契约；已存在的纯数值和辅助工具 | 其他策略私有文件 |
| 策略实例与 pending | 通过 `StrategyDeps` 使用时钟、scheduler、日志及 fatal | 直接调用原生 timer、环境读取、文件/网络 I/O，导入宿主实现或 SDK |
| 策略纯计算/配置/显示投影 | 本策略数据与纯函数、中立类型、纯工具 | timer/emitter 的执行能力、logger I/O、宿主状态或执行能力 |
| app/runtime/application/domain/infrastructure 等宿主生产模块 | 公共 `src/types/strategy.ts`；加载器经既定路径导入选中 definition | 静态导入任意策略私有文件，包括 definition、types、JSON、constants |
| 测试 | 对应策略单元测试可直接导入私有实现；集成测试装配真实 owner | 以测试专用导出改变生产 API |
| 已存在的离线分析工具 | 保留明确的数学叶子模块及类型直接消费 | 导入 definition、配置、策略实例、pending 或扩大成一般宿主权限 |

当前策略对五根之外的直接依赖仅涉及 `src/types/{strategy,data,runtime}.ts` 和 `src/utils/{helpers,numeric}/index.ts`。本次无需增加新的跨功能运行时依赖。规则按目录归属和能力定义，不为 `intradayRegression` 写专属注册名单；通用 ID 新增时无需修改规则。

这是可信本地代码的静态隔离与窄端口约束，不是恶意插件安全沙箱，也不新增任意跨过程能力证明框架。

## 4. 生产文件完整迁移表

以下缩写只用于本表：

- A：`src/app/startup/strategyDefinitions/intradayRegression/`
- C：`src/config/strategy/intradayRegression/`
- D：`src/domain/strategy/intradayRegression/`
- R：`src/runtime/strategy/intradayRegression/`
- T：`src/strategies/intradayRegression/`

| 源文件 | 目标文件 | 处理 |
| --- | --- | --- |
| A `definition.ts` | T `definition.ts` | 保留定义和 prepare/create，改用本目录相对导入 |
| C `config.json` | T `config.json` | 内容不变 |
| C `config.ts` | T `config.ts` | 解析、冻结规则不变 |
| C `dsl.ts` | T `dsl.ts` | 语法和接受集合不变 |
| C `types.ts` | T `types.ts` | 合入解析类型，见下文 |
| D `types.ts` | T `types.ts` | 保留原策略领域类型 |
| D `signalRules.ts` | T `signalRules.ts` | 数值比较和条件语义不变 |
| D `display.ts` | T `display.ts` | 显示投影不变 |
| D `indicatorHelpers/types.ts` | T `indicatorHelpers/types.ts` | 移动 |
| D `indicatorHelpers/utils.ts` | T `indicatorHelpers/utils.ts` | 移动 |
| D `indicators/adx.ts` | T `indicators/adx.ts` | 移动 |
| D `indicators/ema.ts` | T `indicators/ema.ts` | 移动 |
| D `indicators/index.ts` | T `indicators/index.ts` | bootstrap/update/snapshot 行为不变 |
| D `indicators/indicatorMath.ts` | T `indicators/indicatorMath.ts` | 移动 |
| D `indicators/kdj.ts` | T `indicators/kdj.ts` | 移动 |
| D `indicators/macd.ts` | T `indicators/macd.ts` | 移动 |
| D `indicators/mfi.ts` | T `indicators/mfi.ts` | 移动 |
| D `indicators/psy.ts` | T `indicators/psy.ts` | 移动 |
| D `indicators/rsi.ts` | T `indicators/rsi.ts` | 移动 |
| D `indicators/types.ts` | T `indicators/types.ts` | 移动 |
| D `profile/index.ts` | T `profile/index.ts` | profile 编译不变 |
| D `profile/types.ts` | T `profile/types.ts` | 移动 |
| D `profile/utils.ts` | T `profile/utils.ts` | 移动 |
| D `verification/index.ts` | T `verification/index.ts` | 保留纯 `passesVerification` |
| D `verification/sampleRules.ts` | T `verification/sampleRules.ts` | 移动 |
| D `verification/sampleStore.ts` | T `verification/sampleStore.ts` | 保留实例私有样本，不改存储算法 |
| D `verification/types.ts` | T `verification/types.ts` | 保留样本和候选类型，合入 pending 类型 |
| R `index.ts` | T `index.ts` | 策略工厂及状态 owner 不变 |
| R `pendingVerification.ts` | T `verification/pendingVerification.ts` | 保留私有 timer/token、saved emitter |
| R `types.ts` | T `verification/types.ts` | 合入 pending 类型，见下文 |
| `src/constants/strategy/intradayRegression.ts` | T `constants.ts` | 数值、顺序和动作映射不变 |

### 4.1 两处 types.ts 冲突的确定处理

禁止按目录复制覆盖同名类型文件。

1. C `types.ts` 的 `ComparisonOperator`、`ParsedCondition`、`ParsedConditionGroup` 合入 T `types.ts`。它们服务于根目录的 DSL/config，与根目录其他策略数据类型就近组织；不提升到 `src/types`。
2. R `types.ts` 的 `PendingEntry`、`PendingVerification` 合入 T `verification/types.ts`。该文件以 `import type` 引入 `StrategyEmitter` 和 `RuntimeScheduler`，不放运行时代码。
3. 所有消费者直接从目标定义文件导入，不保留旧路径 alias、re-export 或委托层。
4. `assertValidTime` 暂保留在迁移后的 `verification/pendingVerification.ts`，由实例入口直接导入；不为此次搬迁另造通用时间工具。

按此映射，31 个源文件归入 29 个目标文件；减少的两个仅为类型文件归并，不是删除业务能力。具体实施若基线已变化，应重新核对，不强求固定数量掩盖新增文件。

### 4.2 明确不迁移的文件

- `src/types/strategy.ts`：公共端口。
- `src/constants/strategy.ts`：通用 ID、入口文件名、旧环境键拒绝等发现规则。
- `src/domain/strategy/utils.ts`：ID 与目录名转换。
- `src/domain/strategy/ordinarySignalGuard.ts`：宿主共享普通交易准入规则。
- `src/app/startup/{prepareStrategy,strategyLoaderHelpers,createSelectedStrategy,types}.ts`：通用加载和实例化。
- `src/runtime/businessEventProgram/**`：行情宿主、origin 和输出授权。
- 席位、时间、生命周期、交易执行及显示运行时：原有职责不变。

所以不得整体删除 `src/domain/strategy/`，也不得因为名称含 strategy 就把上述文件一起搬入具体策略。

## 5. 加载、配置和构建契约

### 5.1 单根定位

`prepareStrategy` 保留在 `src/app/startup/`，根路径改为相对加载器模块 URL 的：

```typescript
new URL('../../strategies/', moduleUrl);
```

对应源码和产物：

```text
src/strategies/<name>/definition.ts
src/strategies/<name>/config.json

dist/src/strategies/<name>/definition.js
dist/src/strategies/<name>/config.json
```

不以 cwd、环境中的任意路径或扫描探测决定目录；不兼容旧双根布局，不在 `.ts/.js` 之间回退。

`inspectStrategyLocation` 删除 `configRootPath` 参数，改成同一个选中策略目录内检查 definition 和 config。调用方、函数签名、测试 fixture 同步变更；`StrategyLocation` 仍只需 strategyId 与 definitionPath，不新增配置缓存。

### 5.2 必须保留的加载约束

- 必须显式设置合法 kebab-case `ACTIVE_STRATEGY_ID`。
- 旧策略环境键即使为空也按 presence 拒绝；不新增默认策略。
- ID 与 camelCase 目录名精确映射，拒绝路径注入、保留设备名与大小写冲突。
- 加载器是无 query/hash 的本地 file URL，扩展名必须是 `.ts` 或 `.js`。
- 选中目录和两个固定文件的类型、精确文件名、realpath 边界及 symlink/junction 检查保留。
- 只导入选中 definition 一次、prepare 一次，不预加载其他策略或统一校验其业务配置。
- 命名导出仍为 `strategyDefinition`，其 ID 必须与目录推导一致。
- prepare/create 拒绝 Promise/thenable，异常保留阶段和 cause。
- create 返回身份匹配的完整端口；继续先登记可用 destroy，再验证其余实例契约。
- prepare/create 均在 SDK 接入前完成；不改变 app 启动顺序。

### 5.3 策略私有配置

`definition.ts` 静态导入 `./config.json`，调用本策略 `./config.ts`，闭包捕获规范化配置，再委托本策略工厂。

不把 JSON schema、DSL、指标清单或 profile 提升到通用加载器；不从 `.env` 读取策略私有参数；不改成运行期 fs 读取。保留严格字段校验、延迟范围、名称归一化、冻结新对象而非原始静态 JSON 的语义。

新策略仍必须提供自己的 `config.json`，其 schema 可以完全不同，不强制使用 intradayRegression 的 parser、profile 或验证机制。

### 5.4 构建资产

基线 `package.json` 的 build 为 `bun run clean && tsc -p tsconfig.build.json`；build include 是 `src/**/*`，并启用 `resolveJsonModule`。新根仍在现有编译范围内，静态 JSON 由 tsc 输出，**预期不需要新增复制脚本或策略资产扫描器**。

必须用真实构建测试验证，而不是凭该推断省略验收：

- source/dist 布局均精确加载；移除源码后仍可加载产物。
- 只改 JSON 后重新构建，产物语义变化正确。
- 增删策略后 clean 能清除陈旧 definition/config。
- 编译错误、缺失被导入 JSON 时不得继续使用旧 JS 产物。
- 构建不调用 prepare；合法 JSON 中的业务配置错误只在选中策略启动时拒绝。
- 未选策略不在运行时求值，不等于编译器忽略其静态依赖；静态导入的坏 JSON/类型错误仍可导致构建失败。
- 保留无关 cwd、路径含空格及非 ASCII 字符的验证。

## 6. 架构门禁同步迁移

### 6.1 策略归属与依赖检查

修改 `eslint.config.js` 的 `strategyPrivateBoundaryRule` 和 `tests/architecture/strategyBoundary.test.ts` 的归属识别：

```text
src/strategies/<directory>/... → owner = <directory>
```

统一覆盖入口、配置、常量、类型及实现。宿主向策略内部、策略 A 向策略 B 的运行时和 type-only 依赖均拒绝。单活跃动态加载能力继续仅存在于受审查的 `app/runAppDeps` 注入与 prepare/import helper 调用链，不能放宽成任何动态 import 都合法。

保留并扩展 import/export、type import、字面量动态 import 和 require 等已有扫描覆盖；不得只查文件名字符串而遗漏真实模块边。入口可以导入自己的 index/config；公共层不得反向依赖新的 `strategies` 根。

同步文件：

- `tests/architecture/importBoundary.test.ts`
- `tests/architecture/strategyBoundary.test.ts`
- `tests/architecture/refactoring/strategyDynamicBoundary.test.ts`
- `tests/architecture/refactoring/scanner.ts` 的 `selectedStrategyPath` 及相关调用验证
- `tests/architecture/refactoring/freeze.test.ts` 中 source/dist 精确入口 fixture
- `tests/helpers/importFixtureModule.ts` 及其测试的 definition 路径正则

### 6.2 纯计算和运行能力不能因搬出 domain 而失去约束

基线扫描器部分能力检查依赖 `src/domain/` 前缀，新目录不自动继承这些检查。必须把策略内部仍为纯计算的角色纳入相同强度的约束，而不是给整个 `strategies` 根原生 I/O 权限。

当前纯角色包括：config/DSL、constants、signalRules、display、indicatorHelpers、indicators、profile、verification 的纯规则与样本存储。它们不直接访问文件、网络、环境、实际 clock/timer、logger 输出，也不调用 emitter。实例 `index.ts` 与 `verification/pendingVerification.ts` 可以通过注入依赖组织策略私有状态，但不得调用 ambient timer 或 SDK。

实现以现有 AST/符号检查为基础，按策略相对文件角色定义，不按具体策略 ID 注册。角色分类采用以下确定规则：

1. 除下面的精确例外外，策略内其他实现文件默认受纯角色约束。新命名的纯辅助模块自动受保护，不需要中央登记，也不能落入未分类的放行区。
2. 精确相对路径 `definition.ts` 是装配入口，允许导入本策略配置和实例工厂；它不因此获得直接 I/O、原生 timer 或模块求值时启动运行行为的权限。
3. 精确相对路径 `index.ts` 与 `verification/pendingVerification.ts` 是受控运行角色，可使用注入依赖。这里只匹配策略根下的实例 `index.ts`，不能把 `indicators/index.ts`、`profile/index.ts`、`verification/index.ts` 或整个 verification 目录放宽。
4. 纯模块不能反向导入 definition、实例或 pending 调度实现；`types.ts` 仍只能承载类型，其 type-only 公共 scheduler/emitter 契约引用不授予运行能力。
5. 上述相对路径约定适用于所有策略 ID，角色文件按需要实现，不要求无延迟策略创建空 pending 文件。新的状态协调先内聚在既有运行角色；若未来确实需要新的运行能力文件形态，应作为显式边界设计变更评估，不用策略 ID 白名单或任意文件默认放行解决。

不建立全局泛化静态证明引擎；至少保证当前迁移的纯模块不失去已有检查。增加一个不同策略 ID、含新命名纯辅助模块的正反 fixture：正常同策略纯调用无须修改规则即可通过，该辅助模块反向依赖受控运行角色或直接 I/O 必须失败。

### 6.3 SDK、金融精度与历史冻结约束

- `src/strategies/**` 必须处于 SDK-free 范围，Longbridge 的 runtime 和 type-only import 都不得漏检；从中性外壳间接暴露 SDK 类型也必须继续被拒绝。基线 scanner 的深层 `SDK_EXPOSURE` 只匹配 application/domain/runtime，需要显式包含新策略根。
- 策略指标仍按既有 number 递推；信号阈值继续使用原精确比较，延迟验证保留现有比较语义。不得因目录变化将指标误归成订单金融公式，也不得把策略目录变成任意金融计算豁免区。
- 检查 `tests/architecture/refactoring/{scanner,numericProbe,snapshotProbe,executionProbe}.ts` 对根目录、owner 和动态路径的判断。只有实际受影响的分类需要调整，禁止为了通过扫描扩大合法 owner 或金融转换白名单。
- `tests/architecture/refactoring/baseline.json`、`unresolved.json` 的历史审计额度、截止阶段及证据不得重采样或清零；旧路径作为历史证据、负向 fixture 可以保留。
- 继续验证公共类型不反向导入策略私有类型、`types.ts` 无运行时代码、`utils.ts` 无本地类型声明、生产无 test-only hook。

### 6.4 数学叶子与工具消费

只定向更新两个已确认的直接消费者：

- `tools/dailyIndicatorAnalysis/indicatorCalculators.ts`
- `tools/dailyIndicatorAnalysis/types.ts`

它们继续直接使用新目录下既有 ema/kdj/mfi/rsi/indicatorMath 等数学叶子和类型；不导入完整策略入口、profile、pending 或静态配置。保留 `strategyBoundary.test.ts` 对叶子传递依赖与模块求值无副作用的检查，不因为迁移让工具加载策略实例或 SDK。

### 6.5 复核确认的扫描器改动点及非空覆盖

进一步复核确认：不是所有探针都需要改写，必须区分“扫描已经覆盖新根”与“扫描后的角色分类遗漏”。

| 位置或符号 | 基线情况 | 本次要求 |
| --- | --- | --- |
| `eslint.config.js` 的层矩阵（约 :557–580） | 按顶层技术目录匹配，新根不会自动匹配 | 增加策略依赖方向与内部角色检查，不将同 owner 视为任意互引许可 |
| `scanner.ts` 的 `forbiddenDomainIo` / `forbiddenLayer`（约 :270–307） | 直接依赖旧层名 | 纳入策略纯角色及策略对宿主实现的限制 |
| `scanner.ts` 的 `SDK_EXPOSURE`（约 :1558–1565） | 深层类型检查只覆盖部分旧根 | 纳入策略新根，补间接 SDK 类型暴露负例 |
| `scanner.ts` 的 ambient IO/logger、import-equals、动态入口分支（约 :1570–1595、:1672–1677、:1759–1776） | 还存在独立的 domain 前缀判断 | 同步使用正确纯角色范围；不能只修改 `forbiddenDomainIo` 一个函数 |
| `scanner.ts` 的 `selectedStrategyPath`（约 :317–332） | 动态入口固定旧布局 | 改为精确新 definition，拒绝旧入口及私有叶子 |
| `scanner.ts` 对 fixture importer 的守卫（约 :231–267） | 审查精确 helper 调用边界 | B1 子进程隔离不能破坏该边界；新增 smoke 辅助文件仍纳入 tests 扫描 |
| `freeze.test.ts` 的 `src`/`tests` 枚举 | 全树递归，本身能包含新根 | 证明目标策略 TS 确实进入扫描，不能仅以零违规推断已覆盖 |
| `numericProbe.ts` / `numericBoundary.test.ts` | 从整个 src 建 Program，公共契约字段按符号身份检查 | 不重写探针；补新根金融事实非法投影的负例及合法指标 number 正例 |
| `snapshotProbe.ts` / `executionProbe.ts` | 全树扫描，按事实契约、owner、测试 helper 识别 | 不扩大 owner 或 SDK fixture 例外；补新路径负例证明原保护仍有效 |

31 个源文件为 30 个 TS 和 1 个 JSON，目标归并后为 28 个 TS 和 1 个 JSON。静态 TS 扫描应确认目标 28 个文件被实际分析；JSON 则由加载边界与真实构建验证。若实施基线变化，按实际映射计算预期集合，不用固定计数代替文件身份核对。

补充的正反例要求：

1. `freeze.test.ts` 在新策略纯路径下拒绝文件/网络、真实 ambient fetch/timer 和 logger I/O；保留 `node:path`、`node:util`、纯 Logger 类型以及局部同名纯函数等合法例。
2. `longbridgeBoundary.test.ts` 在新根覆盖已有 SDK import 语法与间接类型暴露，不把 strategies 加入 trade/market adapter 例外。
3. `importBoundary.test.ts` 拒绝宿主导入私有常量/类型/JSON、跨策略依赖、纯计算反向导入 definition/实例/pending，允许正常同策略装配。
4. `eslintLocalRules.test.ts` 同步迁移 `.ts`、`.d.ts` 和工具 fixture 路径；确认用例命中预期规则，而不是 parser 配置错误。
5. `numericBoundary.test.ts` 证明新路径对真实公共 Quote/AccountSnapshot 的非法金融投影仍失败，指标递推、DSL 阈值、时间和既有合法 quantity 的 number 规则仍通过。
6. snapshot 非 owner 写入、测试 helper 间接构造 SDK 的拒绝例在新路径仍有效。不为这两个探针新造实现框架。

基线 numeric 审计中的 `contractFields`、`numericSites` 没有命中本次五处现行私有策略根的记录，不需要为目录迁移改写其历史额度。纯角色识别不得将整个 `verification/**` 视为有调度权限；只有其中 `pendingVerification.ts` 承担该职责。合并后的 `verification/types.ts` 使用公共 scheduler 类型是 type-only 契约依赖，不等于运行时调度。

## 7. 测试迁移与同名冲突

### 7.1 单元测试映射

目标统一为 `tests/strategies/intradayRegression/`，与生产模块对应：

| 当前测试/辅助文件 | 目标相对路径 |
| --- | --- |
| `tests/app/startup/strategyDefinitions/intradayRegression/definition.test.ts` | `definition.test.ts` |
| `tests/config/strategy/intradayRegression/config.test.ts` | `config.test.ts` |
| `tests/config/strategy/intradayRegression/dsl.business.test.ts` | `dsl.business.test.ts` |
| `tests/config/strategy/intradayRegression/fixtures.ts` | `configFixtures.ts` |
| `tests/config/strategy/intradayRegression/types.ts` | `types.ts`，合入 ConfigFixture |
| `tests/domain/strategy/intradayRegression/fixtures.ts` | `indicatorFixtures.ts` |
| `tests/domain/strategy/intradayRegression/signalRules.business.test.ts` | `signalRules.business.test.ts` |
| `tests/domain/strategy/intradayRegression/indicatorHelpers/**` | `indicatorHelpers/**` |
| `tests/domain/strategy/intradayRegression/indicators/**` | `indicators/**` |
| `tests/domain/strategy/intradayRegression/profile/**` | `profile/**` |
| `tests/domain/strategy/intradayRegression/verification/**` | `verification/**` |
| `tests/runtime/strategy/intradayRegression/index.test.ts` | `index.test.ts` |
| `tests/runtime/strategy/intradayRegression/pendingVerification.test.ts` | `verification/pendingVerification.test.ts` |
| `tests/runtime/strategy/intradayRegression/fixtures.ts` | `runtimeFixtures.ts` |
| `tests/runtime/strategy/intradayRegression/types.ts` | `types.ts`，合入 Harness、TimerEntry |

三个 fixture 各自保留职责，禁止相互覆盖或为减少文件合成超级 fixture。所有直接消费者修正 import；公共测试 helper 不得再转发这些策略私有 fixture。

`tests/domain/strategy/ordinarySignalGuard.test.ts` 保留，因为其生产文件没有迁移。

### 7.2 留在原位置但必须检查的消费者

- `tests/app/startup/{prepareStrategy,createSelectedStrategy}.test.ts`
- `tests/app/runAppTerminationMatrix.business.test.ts`
- `tests/build/productionBuild.test.ts`
- `tests/helpers/importFixtureModule{,.test}.ts`
- `tests/architecture/{eslintLocalRules,importBoundary,strategyBoundary,typeOrganization,longbridgeBoundary}.test.ts`
- `tests/integration/delayedStrategySell.integration.test.ts`
- `tests/integration/distanceSwitchIndependentSell.integration.test.ts`
- `tests/integration/distanceSwitchTimeoutRebuy.integration.test.ts`
- `tests/integration/perf02PersistentChain.integration.test.ts`
- `tests/integration/postTradeDrainLifecycle.integration.test.ts`
- `tests/integration/singleActiveStrategyExecution.integration.test.ts`
- `tests/integration/lifecycle/strategyReset.integration.test.ts`

这些文件的职责没有随策略迁移；只修改必要的私有实现/fixture 引用和明确布局断言。还需搜索 `mock/` 和其他测试中的间接 fixture 消费，不把本清单当作无需搜索的白名单。

### 7.3 新增或修改策略的行为证明

复用已有 `prepareStrategy.test.ts` 的不同 schema 测试和 `productionBuild.test.ts` 的两种独立策略 fixture，适配为单目录，而不是新增正式示例策略或另一套重复测试。

必须证明：

1. 新建 `<name>/definition.ts`、`config.json` 与其实现就能按 ID 选中。
2. 新策略不导入 intradayRegression parser/指标/pending。
3. 只选中一个策略，另一策略 import/prepare/create 计数为零。
4. source 与干净构建 dist 都经过真实 prepare → create → onCandlestick → queue → destroy。
5. 宿主实现与架构规则不因策略 ID 新增而修改。
6. 缺少本目录 JSON 必须失败；旧双根位置存在同名 JSON 也不能作为回退。
7. 常量、类型、JSON 与私有实现一样受到宿主/其他策略导入保护。

## 8. 必须保持的业务不变量

| 编号 | 不变量 | 主要现有保护范围 |
| --- | --- | --- |
| I01 | 只创建唯一选中实例；prepare/create 在 SDK 前失败；部分实例可销毁 | app startup、termination matrix、build |
| I02 | 一分钟线 confirmed 基线与 active preview 分离；乱序/版本处理不变 | indicators incremental/invariants、perf02 集成 |
| I03 | 每次有效事件先推进指标、采样、显示，再判断 allowNewEvaluation | 策略 index 测试、businessEventProgram |
| I04 | 分组 OR、组内 N-of-M、缺失指标按原规则处理，不要求所有指标齐全 | DSL、profile、signalRules |
| I05 | SELL 候选首次检查已成交买单；延迟 emit 不重复查询该初始条件 | 策略 index、emissionAdapter、延迟 SELL 集成 |
| I06 | 正延迟且有验证指标才等待；缺少初始指标直接丢弃，不降级立即执行 | config、index、pending 测试 |
| I07 | 保持动作 clock 读取位置、整批候选评估、先 immediate 后登记 delayed 的顺序 | 策略 index 时序测试 |
| I08 | target 后 10 秒验证；使用 target/target+5秒/target+10秒最近缓存样本，允许共用样本，无额外时间差上限 | verification、sampleStore/sampleRules |
| I09 | 严格趋势比较、ADX 始终要求下降；样本缺失/无效/不满足即丢弃，无重试 | verification 规则测试 |
| I10 | pending 按 symbol/action/target 去重；先终态化再验证/emit；token 阻断旧回调 | pendingVerification、策略 index |
| I11 | 失效先移除所有选中授权再取消 timer；单个取消失败不能保留其他授权 | 策略 index、pendingVerification |
| I12 | emitter 保留初始 day/route；实时复核交易日、门禁、ACTIVE、symbol、seatVersion；同 origin/action 只消费一次 | businessEventProgram/emissionAdapter |
| I13 | invalidateDirection/All 只清 pending；reset 清 pending/指标/样本；destroy 永久且幂等 | 策略 index、strategyReset、termination |
| I14 | 午休、末日接管、席位变化、跨日和最终退出的实际调用顺序不变 | timeWakeup、seat cleanup、lifecycle、termination |
| I15 | 内部契约/状态错误 fail-fast；正常门禁失效静默丢弃，不混淆失败类型 | emitter、index、startup、集成 |
| I16 | 策略不能修改数量、委托类型、清仓目的或绕过执行门禁 | 公共契约、singleActiveStrategyExecution 集成 |
| I17 | 样本保留时长、显示顺序与格式、指标数学精度不变 | pending、profile、indicator、显示回归 |

不得为了“看起来统一”将所有失效方法合并为一个 reset，或改变纯计算/候选评估的时钟读取顺序。timer 仍由策略独占，通过注入 scheduler 调用；不新增宿主 pending 表。

## 9. 规范和文档冲突处理

### 9.1 项目规范的具体调整

实施时更新 `AGENTS.md` 的结构说明，加入 `src/strategies/` 及“具体策略功能内聚，系统执行能力保持外置”的边界。

`.agents/skills/typescript-project-specifications/SKILL.md` 当前“常量统一放在 src/constants”与本次私有常量内聚目标冲突。只做明确且有限的例外：

> 跨模块共享常量继续集中在 `src/constants/`；具体策略私有规则常量放 `src/strategies/<name>/constants.ts`，不得被宿主或其他策略导入。

不放宽其他模块常量规则，不因本次规划修改业务知识库中的交易规则。实际修改 skill 时还须遵循 writing-skills 的适用流程；本次仅在方案中列明，未修改该文件。

### 9.2 与旧架构方案的关系

本方案替代以下文档中“具体策略必须按 domain/runtime/config/app 分散”的组织决策，其他架构和交易约束仍有效：

- `docs/architecture/architecture-refactoring-design.md` 的目标目录/策略职责分配与常量组织说明（基线约 :361、:482）。
- `docs/architecture/architecture-refactoring-implementation-plan.md` 的 §4.1.1、策略 owner 映射、P3F 策略迁移及对应测试归属要求（基线约 :369、:388、:1371、:1394）。
- `tests/architecture/refactoring/README.md` 中四根策略私有身份及 definition/config 分根契约。

实施时在旧方案对应位置添加明确的策略布局被本方案替代说明或定向更新当前规范，不重写历史审计事实、不删掉其他 owner 的门禁。

### 9.3 当前使用说明与历史记录分类

必须更新 README 的策略入口、JSON 链接、单根校验及项目目录中策略归属，保证新增策略说明只需进入一个目录。

定向检查下列计划中的可执行路径引用：

- `docs/plans/intradayRegressionThreePriceBacktest.md`
- `docs/plans/performance-optimization-audit.md`
- `docs/plans/2026-09/` 中直接讨论策略替换/运行时的旧计划

历史评估中指向旧提交的证据路径可以保留，并注明其基线；仍作为未来实施指引的路径应更新或添加替代说明。不得全仓机械替换历史 `core/strategy` 字符串，也不得把本方案中的“源路径映射”、负向测试和冻结审计证据误判为需要删除的残留。

## 10. 实施阶段与交付切面

执行顺序为 R0 → R1 → R2 → R3。R1/R2 是同一个最终迁移切面的组成部分，交付时必须同时闭合，不能以保留旧入口的方式制造中间兼容版本。

### R0：确认基线、解决 B1、确定规则

- [ ] 核对分支、提交和用户现有改动，不覆盖无关工作。
- [ ] 解决 §2.3 的构建测试进程隔离阻塞，原 source/dist 行为断言全部通过。
- [ ] 核对 31 文件清单、两组共五个类型声明归并、三个 fixture 重名处理。
- [ ] 明确新根依赖矩阵、纯计算角色及私有常量规范例外。
- [ ] 保持原算法配置基线，不引入新的业务失败语义。

出口：真实构建基线不再有 B1，迁移清单和门禁调整范围可执行。若 B1 未解决，后续可继续分析，但不能通过最终验收。

### R1：完整功能迁移及加载闭合

- [ ] 按 §4 迁移生产文件、归并类型，修正所有直接 imports。
- [ ] definition 改为本策略相对配置与实例导入。
- [ ] prepare/helper 改为单根同目录检查，删除配置根参数及双根分支。
- [ ] 保持公共类型、通用 guard/ID helper、宿主和执行 owner 不动。
- [ ] 按 §7 迁移测试、重命名 fixture 并修正集成消费者。
- [ ] 修正源码/产物 fixture、工具数学叶子引用。
- [ ] 删除旧具体策略文件，不留 re-export、wrapper、fallback 或旧策略根双读取。

出口：新布局的 source 加载、配置、策略行为和宿主集成通过，纯移动与类型归并以外没有业务正文变化。

### R2：架构门禁、构建和文档闭合

- [ ] 私有 owner 改为单根，包含常量/JSON/类型，补齐正反边界 fixture。
- [ ] 迁移纯计算能力约束，保持 SDK、金融精度、类型组织门禁覆盖。
- [ ] 更新 selectedStrategyPath、fixture importer、source/dist 动态入口测试。
- [ ] 用真实 clean + tsc 验证 JSON、增删策略、独立 schema 和无源码产物加载。
- [ ] 更新规范、README、直接相关架构说明；保留历史冻结证据。
- [ ] 对旧路径搜索结果逐条分类，清除实际消费边，不按字符串数量机械删历史。

出口：架构、构建、类型与相关文档一致，无新增白名单漏洞或弱化的测试。

### R3：最终验证及交付

- [ ] 依次运行 `bun format` → `bun lint` → `bun type-check`，检查格式命令没有带入无关修改。
- [ ] 完成 §11 的定向行为、架构、构建及完整测试验证。
- [ ] 独立复审真实调用链、所有迁移 import、配置资产及残留目录。
- [ ] 输出实际文件变更、验证命令和结果、未解决事项；未通过不宣告完成。

部署时先停止旧进程并完成清理，再完整构建部署并启动；不在线替换策略文件，不热重载。回滚使用完整已验证版本包，不在程序中保留旧布局兼容开关。

## 11. 验证命令与验收矩阵

### 11.1 代码质量必需顺序

```powershell
bun format
bun lint
bun type-check
```

这组命令用于实际代码实施。当前仅新增方案文档，不运行会重写全仓的 `bun format` 来伪造重构验证；当前文档单独做格式检查。

### 11.2 迁移后的定向验证

```powershell
# 策略自身、通用加载及宿主连接
bun test tests/strategies tests/app/startup/prepareStrategy.test.ts tests/app/startup/createSelectedStrategy.test.ts tests/runtime/businessEventProgram tests/domain/strategy/ordinarySignalGuard.test.ts

# 席位、时间、跨日与终止连接
bun test tests/runtime/seatRuntimeCleanupDispatcher tests/runtime/timeWakeupEvaluationProgram tests/runtime/lifecycle tests/app/runAppTerminationMatrix.business.test.ts tests/integration/lifecycle/strategyReset.integration.test.ts

# 真实交易链路和原性能语义回归
bun test tests/integration/delayedStrategySell.integration.test.ts tests/integration/distanceSwitchIndependentSell.integration.test.ts tests/integration/distanceSwitchTimeoutRebuy.integration.test.ts tests/integration/perf02PersistentChain.integration.test.ts tests/integration/postTradeDrainLifecycle.integration.test.ts tests/integration/singleActiveStrategyExecution.integration.test.ts

# 全部架构门禁，不只跑策略私有边界
bun test tests/architecture

# 真实 source/dist 构建与受控动态加载；包含 B1 修复后的断言
bun test tests/build/productionBuild.test.ts tests/helpers/importFixtureModule.test.ts
```

实施前核对目录是否因其他提交变化，测试命令不得在无匹配测试时视为通过。构建测试操作临时工程，不创建 SDK context。构建测试已经验证正式 build 命令时，不为相同证据重复执行整仓构建。

最终迁移影响生产根目录、通用架构规则和共享 fixture，应再运行一次 `bun test` 作为完整收口。定向检查是失败定位阶段，全量是最终集成阶段；全部通过后没有新改动或疑点不反复重跑。若任何检查失败，先归因、修复或明确阻塞，不更新历史基线来掩盖。

### 11.3 残留检查

在 `src/`、`tests/`、`mock/`、两个直接工具文件、ESLint 配置和当前说明中搜索：

```text
app/startup/strategyDefinitions
config/strategy/intradayRegression
runtime/strategy/intradayRegression
domain/strategy/intradayRegression
constants/strategy/intradayRegression
```

对非具体 intradayRegression 的旧策略根模板、动态字符串、source/dist fixture 也要检查。使用 AST/实际模块解析验证消费边；单靠 grep 不能证明动态加载正确。

允许保留：旧路径拒绝用例、历史基线证据、明确标注基线的报告、本方案迁移表。禁止保留：生产导入、运行时路径选择、正向 fixture、README 当前操作指南中的旧布局。

### 11.4 完成定义

只有下列条件全部满足，才算架构修复完成：

- [ ] 具体策略实现和配置集中于 `src/strategies/<name>/`，测试集中于对应 tests 目录。
- [ ] 同一策略只有一个实例/指标/样本/pending owner，宿主不持有第二份策略状态。
- [ ] 新增独立 schema 策略无需修改宿主、加载器或策略 ID 白名单。
- [ ] 公共契约和现有事件/生命周期连接不变，I01–I17 均有有效回归保护。
- [ ] 宿主/跨策略导入私有常量、类型、JSON 与实现均被拒绝。
- [ ] 纯计算、SDK 和金融门禁没有因为新根而漏检，冻结额度未放宽。
- [ ] 两种 source/dist 布局、无源码产物加载、配置及增删策略构建全部通过，B1 已解决。
- [ ] 旧实现及有效引用清理完毕，没有兼容层、转发出口和热更新路径。
- [ ] 规范、架构说明和当前使用文档一致，历史证据被正确区分。
- [ ] 必需质量命令和最终测试通过，实际结果已记录。

## 12. 后续新增策略的最短操作流程

在当前单监控标的、一分钟线、普通四动作契约内：

1. 创建 `src/strategies/newStrategy/`。
2. 提供 `definition.ts` 和静态 `config.json`，实现本策略私有 prepare、实例及必要内部文件。
3. definition 的 ID 为 `new-strategy`，返回现有 `TradingSignalStrategy`；不需要延迟验证的策略不必复制日内策略的 pending/指标结构，但必须实现正确的生命周期端口。
4. 在 `tests/strategies/newStrategy/` 增加能验证实际行为的测试，配置 schema 与指标按本策略自行定义。
5. 设置 `ACTIVE_STRATEGY_ID=new-strategy`，完成质量检查和完整构建后重启。

修改现有策略时，阈值在该目录 config，条件规则在 signalRules，指标支持涉及该目录 parser/profile/indicators，验证机制在该目录 verification。允许有真实职责划分的多文件修改，但不要求开发者跨宿主技术层拼装同一个策略。

若未来策略需要多周期、多标的或新的执行意图，应单独评估公共契约扩展；本方案不预先加入相关能力，也不承诺这些需求仅靠新增目录即可实现。
