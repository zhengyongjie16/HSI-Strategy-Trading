# 单活跃策略独立化：最终可执行实施计划（免注册自动加载）

> **交付性质：实施计划，不是代码修改或完成报告。**
>
> 设计合同：[single-active-strategy-runtime-refactor-plan.md](./single-active-strategy-runtime-refactor-plan.md)。两份文档已同步用户最终确认的免注册方案；本文件是实施执行入口，展开文件级任务、依赖、行为契约和验收门禁。原文中的“已复核”不作为本计划结论的替代证据。
>
> 核验基线：Git `afc2987`，项目版本 `16.8.0`；开始核验时工作区干净。实际实施前重新检查 HEAD、工作区和相关调用链；若有变化，先复核受影响证据，不能把这里的行号当作永久定位。
>
> 原文档阶段只更新计划；本轮按用户批准实施静态 JSON 与简化构建。“最终”指已确认的待执行文档，不表示重构已经实施。真实部署参数未读取、未猜测；生产配置迁移仍是发布阻断项。

> **本轮补充（用户已独立批准，无业务歧义）**：数学全私有化、tools direct leaf/type、固定同步 onCandlestick 正式纳入方案。D1–D5/T01–T34 其余决策和业务不变。历史 S01–S07 记录仅描述上一轮；本轮实施范围见末尾 J01–J05，保留策略参数、env 和暂存区。本轮补充 S01–S07 已完成：A/B/C、独立 review 与 final gates 均通过；这里只核销补充范围，不变更原 WP9 尚未验收的发布事实，不宣称 native 退出问题已修复，也未进行真实 launch。

## 1. 已确认决策与计划优先级

### 1.1 用户明确确认的五项决策

| 编号 | 已确认决策 | 实施约束 |
| --- | --- | --- |
| D1 | 允许策略私有常量的局部规范例外 | 仅具体策略使用的规则常量可放 `src/core/strategy/intradayRegression/` 内；共享常量仍放 `src/constants/`。这是针对 TypeScript skill 常量目录条款的明确例外，不授权其他规范例外。 |
| D2 | 午夜清理保持当前失败行为 | 午夜只改正确的依赖排空顺序。任一步失败停止本轮后续清理；明确外部 API 失败保留现有重试，内部错误进入 fatal。最终退出 cleanup 才逐项捕获错误、继续尝试后续步骤。 |
| D3 | 极小正 delay 保持旧行为 | 在 `Date` 转换前，若原始时间加法没有推进，直接不生成该候选；不创建 pending、不转立即信号、不新增精度下限。不得替换成对转换后的 T0 做严格大于 now 的要求。 |
| D4 | 新增策略无需人工登记 | 删除静态注册设计，按严格 kebab-case ID 可逆映射 camelCase 目录并加载固定入口；接受严格命名和跨平台冲突拒绝规则。不新增中央清单、manifest 或生成式注册表。 |
| D5 | 构建仅 clean + tsc，启动严格 prepare 选中项 | package build 复用 clean 后运行 tsc；静态 JSON 依赖由编译器输出，语义一致而非字节一致。不动态 prepare、不扫描未选目录。启动校验选中路径及配置，先于 SDK context 创建。 |

后续执行以用户明确需求、项目硬规则、上述确认和本计划的精化契约为准。原方案未被本计划修正的交易语义保持不变。发现新冲突时记录“证据—影响—备选方案”，先完成无关的安全工作，再确认有歧义部分；不得自行选择改变交易结果的解释。

### 1.2 第一性原理目标

系统有两个不同责任主体：

1. **策略实例**：从不可变市场/订单事实计算普通买卖意图；拥有为此需要的配置、公式、指标运行态、采样、等待、验证、显示投影和状态清理。
2. **宿主**：拥有真实账户、席位、订单、行情接入、执行权限、风险、恢复、业务门禁和资源生命周期。

因此，策略可以决定“是否想买/卖、何时形成这个意图”，但不能决定“用哪个未经宿主授权的标的、卖多少、是否绕过风控、是否以清仓身份执行”。延迟验证改变的是意图生成时机，不产生第二套下单权限。

成功条件不是目录搬迁，而是：**宿主只认识统一端口；选中实例完整拥有策略状态；新策略遵守相同普通交易契约时，不需修改宿主。**

### 1.3 范围与非目标

- 一个进程只创建一个选中策略实例，跨日复用；策略根下可有多个实现目录，新增目录无需修改任何中心注册文件。
- 本次只迁移现有生产策略。测试中可以增加不同私有配置/指标的 definition，不能据此增加第二套生产策略。
- 扩展范围：唯一 monitor、现有分钟线事实、LONG/SHORT 席位、四种普通动作；同一行情 origin 对每个 action 最多输出一次。
- 不增加多策略并发、热切换、运行期热发现、启动时导入全部策略、人工/生成式注册表、策略账本、策略持久化、跨进程 pending 恢复或生产 supervisor。不增加构建目录扫描。
- 不重定风险顺序、智能平仓、清仓权限、订单恢复、寻标/换标政策。
- fatal/admission/清理依赖修正只覆盖本链路安全收口需要的真实路径，不泛化为通用 owner 平台。

## 2. 核验结果、纠正点与证据边界

### 2.1 直接核验的关键事实

| 事实/结论 | 代码证据（基线位置或函数） | 对执行计划的约束 |
| --- | --- | --- |
| 当前动作计算次序为 BUYCALL、SELLCALL、BUYPUT、SELLPUT | `src/core/strategy/index.ts` 的 `generateSignals` | 保持判断顺序和各动作独立读 clock 的位置；不强制共用一个判断时间。 |
| 原流程先算全部候选，再提交 immediate，最后登记 delayed | `src/main/businessEventProgram/signalPipeline.ts` 的两个分流循环 | 策略内部保留这一批次处理顺序，避免把 timer 登记时读 clock 插进后续动作的判断时间序列。此暂存只在策略私有调用内，不恢复宿主分类接口。 |
| 有效 snapshot 先采样，再显示请求，再进入新信号门禁 | `src/main/businessEventProgram/index.ts:114–165` | `allowNewEvaluation=false` 不等于停止指标/采样；新 pending 创建前已有本轮样本。显示变为返回投影，不再通过显示 owner 决定是否评估。 |
| 小数 delay 接受域大于整数秒 | `src/config/utils.ts:261–275`，`src/core/strategy/index.ts:84–95` | 保留 D3；仅 JSON 结构严格化，不增加秒数精度限制。 |
| 原 DSL 允许完全空的 OR 段被跳过 | `src/config/utils.ts` 的 `parseSignalConfig`，先检查最多三段，再跳过空段 | `\|(K<20)` 属旧接受集合；不能因为新 JSON “严格”就拒绝它。空白段与完全空段按旧 parser 区分。 |
| 日志 formatter 不是无损 DSL 序列化器 | `src/config/utils.ts` 的 `formatSignalConfig` | 数值输出可能出现旧 parser 不接受的指数写法。迁移优先保存已验证原表达式，不用日志字符串反推生产配置。 |
| 验证列表在 profile 编译中按首次出现去重 | `src/services/indicators/profile/index.ts` 的 `compileVerificationIndicatorList` | 保留规范化名称、去重顺序和两侧归属；零 delay 的显式指标仍加入需求/展示编译。 |
| 缓存已标准化 primitive，但没有冻结 | `src/services/quoteClient/candlestickCache.ts:44–105,161–184` | 新建并冻结行情投影，或证明发布边界冻结安全后在发布边界做；不能断言宽 `CandleData` 已是运行时不可变输入。 |
| 实际样本保留值由 post-gate 推导 | `src/app/runtime/createPostGateRuntime.ts` 的 `createIndicatorCache` 装配 | 使用最大两侧 delay + 10 秒 ready + 15 秒余量，不使用 cache 默认 100 秒。 |
| snapshot 风险补价在唯一生产调用前已不可达 | `src/main/asyncProgram/buyProcessor/index.ts:104–138`；`riskCheckPipeline.ts` | 删除依赖而非增加宿主价格缓存；执行行情缺失/无效仍在原处拒买。 |
| 普通 reason 存在文本清仓授权 | `src/core/signalProcessor/sellQuantityCalculator.ts:145–190` | 删除该分支；typed 清仓路径保持。此项是权限契约纠错，不是策略新增清仓功能。 |
| 启动配置显示也消费具体策略结构 | `src/config/validator/index.ts:222–259` | 必须同步迁出 DSL/verification 的解释和展示；不能只清运行期 `marketMonitor`。 |
| 指标数学模块有真实 tools 消费者 | `tools/dailyIndicatorAnalysis/indicatorCalculators.ts:8–30`；`tsconfig.build.json` | 五实现全部迁入私有 runtime；tools 非生产，直引私有 leaf/type，不保留公共数学模块；tools 继续接受开发类型检查，但不进入正式构建产物。 |
| 午夜与最终退出的错误语义不同 | `dayLifecycleManager.ts:58–65,145–169`；`app/shutdown/createCleanup.ts:47–63` | 按 D2 分开实现和测试，不复用一个无条件 best-effort 的午夜清理 helper。 |
| PostTrade 在请求返回后仍 await 订阅回调 | `createPostTradeConsistencyRuntime.ts:399–418` → `createPostGateRuntime.ts:303–308` → Quote reconcile | 先排空 PostTrade 的请求及回调，再停止 Quote；仅检查 stop 调用顺序不足。 |
| PostTrade 同周期多次 drain 可能覆盖等待方 | `createPostTradeConsistencyRuntime.ts` 的单个 `drainResolve` 与 `stopAndDrain` | 同一停止周期复用 drain Promise；同步停生产与异步排空分开，正常重启可建立新周期。 |
| 正常退出监听在业务启动后才安装，回调仅 resolve | `src/app/runApp.ts` 的末尾 `waitForShutdown()`；`runAppDeps.ts` 的 `waitForShutdownSignal` | 在首个业务资源创建前订阅，同步进入正常终止；覆盖装配及初始恢复窗口，不依赖已移除的 watch。 |
| 旧指标 opaque handle 用于宿主持有并回传 | `types/indicatorRuntime.ts`、`types/state.ts`、`businessEventProgram/indicatorPipeline.ts`、`services/indicators/runtime/index.ts` | 当前包装有真实用途；宿主持有边界删除后，迁移真实私有 state，不迁移品牌转换和 unwrap。 |
| cleanup 开始后不可注册 | `src/app/shutdown/createCleanup.ts:28–30` | fatal 期间等待当前资源创建落定并登记晚到资源，然后执行唯一 cleanup；不与装配竞争提前 cleanup。 |
| 生命周期有直接 reopen，队列无终态 close | `dayLifecycleManager.ts:174–197`；两种 task queue 的 push/scheduleLatest | 同步终止 latch 必须进入所有真正放行点；正常 stop 与最终 close 分离。 |

### 2.2 已纳入最终合同的精化条款

1. §2.1 的私有常量归属依据改为 D1 的本轮明确授权，不能继续引用不可见的历史授权。
2. §5.3 的时间公式前补 D3；有效小数不能被整数限制、最小精度或转换后比较改变。
3. §7.4 的“失败仍继续清理”限定为最终退出；午夜保留 D2。
4. §9 的迁移清单补启动配置显示、工具数学调用和架构检查配置。
5. 原文关于“不变量错误必须暴露”是**目标纠错要求**。旧 runtime 的非法 handle 路径会返回 null，不能将其写成旧实现已保证的事实；目标删除 opaque handle 后，只保留实际可达的私有状态不变量检查，不为复现旧包装而伪造句柄。
6. 迁移基线需要保留原始 DSL 文本，不能用 `formatSignalConfig` 的日志输出充当生产可回读配置。
7. 依 D4/D5，原静态注册及启动全 registry 校验已经被取代；命名映射、按需动态加载、静态 JSON 编译和结构测试须整体切换，不能只删注册文件。
8. 当前 `tsconfig.build.json` 包含 `src/**/*`、保留 `dist/src/` 输出布局，新增策略不需要静态 import 才能参与 tsc 编译；JSON 仍需显式资产同步。动态加载只改变装配发现机制，不改变交易规则。

### 2.3 已运行验证与未评估项

此前文档核验阶段已运行旧实现基线（本次仅修订文档，未重复运行代码测试）：

```powershell
bun test tests/core/strategy tests/main/asyncProgram/delayedSignalVerifier tests/main/asyncProgram/indicatorCache tests/main/businessEventProgram tests/services/indicators
```

结果：**54 pass / 0 fail，180 次断言，10 个文件，退出码 0**。

这不覆盖未来实现，不证明新端口、终态 admission、构建资产或新 JSON 已通过。以下仍需实施/发布证据：

- 新实现全量测试、lint/type-check、构建、结构图和资产检查；
- 真实生产有效策略值、旧环境键显式性、部署打包与单进程保证；
- 真实 Broker 恢复及发布演练。单元测试不能代替生产账户事实。

初版由两名独立代理只读复核重点链路，主代理再次读源码并进行delay数值复现；最终免注册修订又独立复核了命名、动态加载、构建资产和文档一致性。未执行整仓无关审计，未实施目标加载器或运行其测试。删除候选仍须实施时搜索全部实际消费者，不能以本表替代最终残留检查。

## 3. 不可改变的业务合同

### 3.1 信号和配置

- 四个表达式全部显式、非空且可由旧 DSL 规则解析；无 null 禁用语义。
- BUY 两动作共用 buy verification；SELL 两动作共用 sell verification。
- `delaySeconds > 0 && indicators.length > 0` 为 delayed；否则为显式 immediate。
- 不支持 ADX/MACD/EMA 作为信号条件；延迟验证支持集、周期范围、阈值比较、N-of-M、组间 OR 与现状一致。
- 指标缺失按原“不可用/条件不满足”处理，不把缺失补成满足；partial snapshot 不等于整体失败。
- SELL 新候选要求当前 ACTIVE 席位对应方向和 symbol 的已成交买单事实；pending BUY、旧 symbol、反方向不算。
- BUY 新候选不要求存在上述买单。

### 3.2 延迟验证

- 身份为 `symbol + action + T0`；重复 pending 不更新初值、不新增 timer。
- 所需 initial 任一缺失/无效则无候选；不改成 immediate。
- 使用 T0、T0+5 秒、T0+10 秒三个目标点的最近保留样本；等距选时间较新者。
- 不新增容差、不强制三个不同样本、不要求持续每秒采样。
- BUYCALL/SELLPUT 全部后续值严格大于 initial；BUYPUT/SELLCALL 严格小于；ADX 所有动作均严格小于 initial。
- 所有配置指标、全部目标点都通过才 emit；缺失、无效、比较不通过均正常丢弃，不重试验证。
- 通过后的 triggerTime 保留 T0，不使用 callback 到达时间。

### 3.3 执行和安全

- 普通意图不是订单，不携带数量、委托类型、买单关联、清仓授权或 symbol 选择权。
- BUY 继续走现行冷却、频率、价格、末日拒买、牛熊证、浮亏、实时账户持仓、基础风控和最终 mutation gate。
- SELL 继续先 freshness，再席位/执行行情/智能平仓/待成交卖单协调。
- 保护性清仓提交后本地买单记录清空不证明空仓；已有合法 delayed SELL 回流不新增买单记录门禁。
- 普通 reason 只说明原因；typed 末日/保护性/静态清仓不经策略。
- 未匹配 SELL 阻断恢复；未匹配 BUY 只有可信终态、无成交冲突且安全结算后才能继续。撤单请求接受不等于完成。
- 不改变 `isExternalApiRequestError`、freshness abort、行情 MISSING 和所属链路的有界重试分类。

## 4. 目标目录、端口与所有权

### 4.1 目录落点

以下为实施落点，不表示这些文件已经存在。能在同一职责文件内完整表达的内容不额外拆目录。

```text
src/core/strategy/types.ts                    策略无关公共契约
src/core/strategy/utils.ts                    中性的ID/目录映射及definition校验工具
src/constants/strategy.ts                    共享发现约定：ID规则、固定入口/配置文件名
src/core/strategy/intradayRegression/
  definition.ts                              固定导出strategyDefinition：id/prepare
  config.json                                唯一策略配置资产，需真实迁移值
  config.ts                                  严格结构校验、规范化、prepare
  types.ts                                   策略私有配置、候选、实例状态类型
  constants.ts                               D1 授权的私有规则常量
  index.ts                                   唯一实例工厂及生命周期端口
  utils.ts                                   DSL、条件判断等私有纯工具
  display.ts                                 私有配置摘要/指标显示/原因文本
  profile/                                   私有指标用途及编译
  runtime/                                   私有指标编排、真实state、committed/preview
    ema.ts/kdj.ts/mfi.ts/rsi.ts/utils.ts       五个旧实现直迁，无math层
    types.ts                                 现有文件合并六个旧数学类型
  verification/                              私有样本与pending/token/timer/验证
src/app/startup/prepareStrategy.ts             唯一生产加载边界：定位、动态导入、校验与prepare
src/app/runtime/createTerminationRuntime.ts    最小共享终止latch/fatal入口
src/main/businessEventProgram/emissionAdapter.ts
                                             普通decision白名单适配
```

新增类型放最近共同父级或私有子目录 `types.ts`；上述目录不是授权将全部类型塞入顶层。`verification` 内若拆 sampleStore/helper，各自返回端口都只能被策略工厂构造、持有和清理。

### 4.2 数学实现与工具消费固定边界

五个旧实现 ema.ts/kdj.ts/mfi.ts/rsi.ts/utils.ts 全部从 src/services/indicators/runtime 直接迁入 src/core/strategy/intradayRegression/runtime，不增加 math 层、不复制、不留兼容转发/re-export，最终删除整个 src/services/indicators。旧 runtime/types 的六类型 BufferNewPush、EmaStreamState、RsiStreamState、MfiStreamState、KdjStreamState、KDJIndicator 合并现有策略 runtime/types.ts，不建公共源或 alias。ADX/MACD/PSY 与真实 state 直接使用私有 leaf/type；删除 opaque handle、Symbol 品牌转换和 unwrap，不复制包装。

非生产 tools 允许直接引用策略私有计算 leaf 与 import type 私有类型，不经 index/definition/config/logger 导入链新增副作用；不为工具保留公共模块或排除编译。dailyIndicatorAnalysis 仅跟进直接 imports/types，不扩项重构算法/CLI/错误口径；既有工具包装器自身 logger 副作用不扩入本次治理。

该例外绝不适用于 src：生产宿主/公共模块只用中性契约及唯一受限加载边界，生产策略绝不跨策略私有 import，不开放 services → core 全目录例外。CandleData 保持中性行情类型，不随数学迁移，宽类型仍不构成深冻结证明。

### 4.3 公共契约

沿用原方案最小端口语义，公共 `types.ts` 不 import 具体策略目录：

| 契约 | 必需内容 | 禁止内容 |
| --- | --- | --- |
| `StrategyDefinition` | `id: string`、`prepare()`；入口固定命名导出 `strategyDefinition` | 单一实现字面量联合、中央注册、默认配置、具体定义自行扫描或装配其他策略 |
| `PreparedStrategy` | 捕获已校验只读配置的 `create(deps)` | 对外 config/profile、泛型擦除适配、宿主编译能力 |
| `TradingSignalStrategy` | strategyId；onCandlestick；invalidateDirection/All；resetForTradingDay；destroy | onVerified、外部 sample/pending/cache 管理端口、Broker 能力 |
| `StrategyMarketContext` | 标准化只读 candles/元信息、observedAtMs、allowNewEvaluation、ACTIVE seats 的只读最小事实 | recorder、完整订单、持仓、seatVersion、网络能力 |
| `StrategyDecision` | 四动作 action、整数毫秒 triggerTimeMs、可选字符串 reason | symbol、quantity、orderTypeOverride、relatedBuyOrderIds、清仓标记 |
| `StrategyDisplayItem` | label/valueText 文本 | 指标族枚举、profile、交易权限 |
| `StrategyDeps` | 现有 RuntimeClock、RuntimeScheduler、同步 fatal sink；保留日志时注入现有 Logger | 宿主策略状态、订单读取/写能力、私有 verifier 参数 |

日志依赖使用现有 `src/utils/logger/types.ts` 的行为契约，不复制 Logger 类型，不在策略内新建 logger。具体策略可在 create 阶段用注入 logger 输出一次已经验证的私有配置摘要，替代旧 validator 对业务结构的解释；不新增公共配置展示平台。create 不启动 timer、不调用交易 emitter。prepare 保持纯解析/编译，不读文件、不建实例。

数据结构使用 `type`+`readonly`，行为端口使用 `interface`；回调函数类型可以使用 type。避免基础类型等价别名和具体类型联合。若公共 candle 类型与现有公共缓存类型实质重复，选择一个真实中性源类型并收窄缓存输出，而不是 `type A = B`；不以类型断言代替标准化证明。

### 4.4 状态所有权表

| 状态 | 唯一 owner | 重置/销毁时机 |
| --- | --- | --- |
| 配置、已编译 profile | prepared 闭包 → 选中实例 | 进程退出释放，不热读 |
| 增量指标基线与活动柱 preview | 策略实例 | reset/destroy |
| 验证 samples | 策略实例 | reset/destroy；普通 invalidate 不清 |
| pending、timer、token、origin emitter 引用 | 策略实例 | 方向/全部失效、验证终态、reset/destroy |
| origin day/route/version、已见 action 集合 | host emitter 闭包 | 随 origin 及持有它的 pending 释放 |
| 当前行情、席位、订单、持仓、风控 | 原宿主 owners | 原生命周期 |
| 显示 latest-only 请求 | display owner | display stop/reset |
| 最终终止状态和首个 fatal | composition-root 最小终止 owner | 不可逆，进程级 |
| running/inFlight、局部 drain | 各业务 owner | 正常 stop/restart 周期 |

`MonitorContext` 最终只保留唯一 strategy port 和宿主能力；删除 verifier/profile。`MonitorState` 移除 snapshot/runtime 后若只剩重复 monitorSymbol，则整个删除，不制造空壳替身。

### 4.5 免注册命名与目录合同（D4）

- 唯一选择输入为原值 `ACTIVE_STRATEGY_ID`，严格匹配 `^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$`；缺失、空白、别名、大小写变化和路径字符均失败，不 trim、不 URL 解码后补救。
- 只将连字符后的首字母大写得到目录：`intraday-regression → intradayRegression`，`rsi14-trend → rsi14Trend`。反向将每个大写字母变为连字符加小写，必须精确还原原 ID。
- `foo-1`、`foo--bar`、尾随连字符等不合法，避免与 `foo1` 等发生映射冲突。目录自身必须通过相同往返校验。
- 跨平台约束：目录名必须保持实际大小写；选中启动拒绝大小写折叠后冲突的策略目录（如 `fooBar` 与 `foobar`），并拒绝 Windows 保留设备目录名（如 `con`、`nul`、`com1`）。不依赖当前操作系统恰好允许创建某个名字。
- `src/core/strategy/` 的每个一级子目录都是具体策略，必须有 `definition.ts` 和 `config.json`。根级公共 types/utils 文件不属于策略候选；共享非策略目录放根外。缺 definition 的目录必须失败，不能当作“不是策略”静默忽略。
- 每个入口直接导出符合公共契约的 `strategyDefinition`，不使用 default/命名导出兼容选择，不通过 barrel 转发。保留 definition.id 作为身份核验，不是第二处登记。
- 配置地址唯一为入口相邻 `new URL('./config.json', import.meta.url).href`；只允许本地 file URL，不接受外部 URL、query/hash 或可配置任意路径。
- 策略根从加载器自己的模块 URL 相对定位，不能来自 env/cwd。用目录枚举返回的真实名称逐段核对选中目录、入口、配置的精确拼写；检查真实路径边界，拒绝候选目录及入口/配置的符号链接或 junction，不以裸字符串前缀代替目录边界检查。未选目录不做构建契约/prepare 校验；tsc 仍会编译 include 与静态依赖（缺失/编译器拒绝的 JSON 可导致编译失败）。选中或未选非法 DSL 可以编译，选中启动 prepare 必须在 SDK context 创建前失败。

共享命名、固定文件名等发现常量放 `src/constants/strategy.ts`，共享纯映射/校验函数放 `core/strategy/utils.ts`，类型放公共 types；D1 仅授权具体策略的私有规则常量，不适用于这些全局发现约定。

### 4.6 加载边界、source/dist 与可信模块（D5）

1. composition root 注入目录/文件元信息检查和动态模块加载能力；准备层不自行创建 SDK/业务资源。模块加载结果先接为 `unknown`，验证固定导出对象、id 字段和 prepare 函数，不用 `as StrategyDefinition`、any 或配置类型擦除绕过检查。
2. 具体 definition 在源码编写时通过 `StrategyDefinition` 编译检查；运行时结构校验不能证明函数体行为安全。prepare 返回结果必须有可调用 create，create 返回实例必须有正确 strategyId 和全部公共方法；保持同步 prepare/create，不默默接受 Promise。可清理实例返回后仍先登记 destroy 再检查其余身份契约；构造未形成可清理实例的错误由构造过程收口自身状态。
3. source 加载器自身是 `.ts` 时，只定位 `definition.ts`；编译后加载器自身是 `.js` 时，只定位 `definition.js`。其他加载形态直接失败，不将“非 ts”一律视为 js。导入前确认目标文件确实存在，避免运行器对缺失 `.js` 的自动解析行为隐式借用源码。
4. 分别使用源码/产物的模块相对策略根；路径转 URL 使用标准 API，不手工拼 `file://`，覆盖 Windows、空格路径和非根 cwd。应用不尝试另一扩展名、另一根目录或默认策略；不加随机 query 绕过模块缓存。非 cwd 测试显式注入 fixture env，不改变 `src/index.ts` 现有 dotenv 装载政策。
5. 只动态 import 选中的入口一次。入口及其传递依赖在模块求值时不得读 JSON、启动 timer、创建实例或执行网络/Broker I/O；create 仍只由 root 调一次。禁止策略间私有依赖和聚合入口，避免选中 A 间接执行 B。
6. 选中入口不存在、导出形状/身份/地址错误、模块求值或传递依赖错误均在 SDK 创建前失败。保留真实 cause 和阶段，不能把所有 import 失败都改写为“未知策略”，更不能换另一个策略继续。
7. 这里只加载可信发布包内的本地程序，不是沙箱或第三方不可信插件平台。发布期间禁止原地并发替换运行中的策略文件；发布包一致性由停机部署和完整构建保障，不新增进程内热加载或文件锁平台。正式构建仅 `bun run clean && tsc -p tsconfig.build.json`，复用 rimraf clean；仅 src 编译闭包，rootDir=./、outDir=./dist，关闭声明/maps，noEmitOnError=true。tsc 自动输出静态 JSON 依赖；无 scripts 构建工具、扫描、动态 prepare、复制或验证框架。

## 5. 必须先固定的算法和时序细节

### 5.1 严格 JSON 的实现步骤

目标顶层仅 `signals`、`verification`；四个大写 action 键；verification 仅 buy/sell，每侧显式 number delaySeconds 和字符串数组 indicators。

实现顺序：

1. parser 接受静态导入的 unknown 对象，检查精确 own 字段、类型、范围、DSL 和指标。
2. 复制规范化为新配置后递归冻结，不修改或冻结共享 JSON import 缓存。
3. 不读取文件、不 parse/stringify 伪原文；原文重复键、严格 UTF8 自检和字节一致保障已获批准撤销。
4. 逐层确认普通数据对象、精确键集合、字段存在性和类型。未知字段、null、缺字段均失败。
5. delay 为 finite JSON number，范围 0–120；不把字符串 number 接受进来，不加整数限制。
6. 四个 DSL 用迁移后的旧语法逻辑解析；数组元素沿旧指标名称/周期规则规范化，非法项失败；去重顺序与旧编译一致。
7. 新建规范化对象和数组，递归冻结；profile 也使用只读对象/数组，不仅给可变 Map/Set 外层套 `Object.freeze`。
8. 编译仅一次，prepare 返回捕获配置/profile 的 create。

保留的 DSL 细节包括负阈值、无括号条件组、N-of-M 默认全满足、最多三段的计数位置，以及旧空 OR 段规则。JSON 的严格边界不能混同于 DSL 新语言设计。

### 5.2 三个时间角色及 D3

同一注入 clock 有三个不同读取位置：

- host 监听分钟线时的 `observedAtMs`，随 latest-only 事件保留，用来采样；
- 每个动作实际生成位置读到的判断时间，用来生成 immediate triggerTime 或 delayed T0；
- delayed timer 登记时读到的当前时间，用来换算相对 delay。

对于 delayed，按以下次序实施：

```text
判断时间来自 clock.now()，先验证 Date 毫秒有效
rawTargetMs = decisionNowMs + delaySeconds × 1000
rawTargetMs 非有限 → fatal
rawTargetMs <= decisionNowMs → 正常无候选（D3，比较在 Date 转换前）
T0 = new Date(rawTargetMs).getTime()
T0 非法 → fatal
readyAt = T0 + 10_000
readyAt 不可表示为有效目标时间 → fatal
registrationNowMs = clock.now().getTime()，验证有效
relativeDelayMs = max(0, readyAt - registrationNowMs)
相对delay不在原生timer可表示范围 → fatal
scheduleTimer(callback, relativeDelayMs)
```

- 不将 epoch readyAt 作为相对参数，不增加长 timer 分段机制。
- 目标已到期以 0 延迟安排一次验证，仍须验证，绝不直接交易。
- `0.0001` 秒可能原始加法推进、Date 截断后 T0 等于 now；仍保留其 delayed 行为。
- `1e-10` 秒在当代 epoch 量级可能原始加法完全未推进；无候选。
- 同步算法保持“按原动作顺序算候选 → immediate 输出 → delayed 登记”。跨 BUY/SELL 队列没有原子事务承诺。

### 5.3 指标、样本和 pending 的提交边界

1. host 跳过不存在/未初始化/空的缓存快照；其余交只读投影。
2. 策略从 committed 基线计算当前活动柱 preview，同一分钟不重复累计；确认/换柱再提交。
3. runtime 候选状态和有效 snapshot 一起提交；无有效数据正常无输出，不拼接新旧状态。
4. 窗口衔接不足允许按权威快照重新 bootstrap；实际可达的 symbol/profile 等私有状态不变量错误不得走该补算路径或返回 null 隐藏。直接使用真实 state，不保留非法 opaque handle 分支，也不为静态类型已排除的伪造句柄新增校验。
5. 相同 cache version 不新增“一律跳过采样”；收到一次可形成快照的事件就按原路径采样一次。
6. 样本仅包含验证所需 value/missing/invalid，push 时按最新 push 时间减 retention 裁剪；读取不额外引入“相对 callback 当前时间的过期容差”。
7. retention 为 `(max(buyDelay, sellDelay) + 10 + 15) × 1000`，包括空指标但配置了较大 delay 的一侧。
8. pending 每项保存 identity、initial、指标列表、T0、timer handle、唯一 token、origin emitter 和所需原因文本。
9. timer callback 先检查 destroyed 和 entry/token 是否仍为当前项，再终态化该项，最后验证和 emit。旧 callback 不得按相同 key 删除新项。
10. clearTimer/取消路径要先使 entry 授权失效；destroy 先置不可逆 latch。清理中单个异常不得使其他 pending 仍有输出授权；异常交共享 fatal/cleanup 错误路径，不能假称全部清理成功。
11. emitter 或 timer 的内部异常进入 fatal；验证条件不通过只是业务丢弃。不得混用两者。

scheduler 沿用原生异步 timer 契约，测试 double 也不得在 scheduleTimer 调用栈内直接执行 callback；测试通过显式推进/释放调度来验证时序，不靠真实睡眠。

## 6. 宿主事件与输出契约

### 6.1 一次行情事件

```text
监听并记录 observedAtMs
 → single-flight/latest-only 更新待处理事件
 → 读取权威缓存
 → 捕获 origin day、allowNewEvaluation、ACTIVE LONG/SHORT route
 → 读取各 ACTIVE symbol/方向的已成交买单布尔事实
 → 构造冻结的行情/seat/context 投影
 → 创建本 origin 的 emitter
 → strategy.onCandlestick(context, emitter) 一次
 → 将返回的中性显示投影交 display owner
```

`onCandlestick` 是唯一固定同步 K 线 hook，返回中性显示投影或 null；不声明 async，不接受 Promise | value，不保留旧方法 alias，不新增 hooks 注册总线或算法步骤 hooks。调用粒度为宿主 singleflight/latestOnly 实际消费的一次权威快照，不是 SDK 每条原始推送都计算，也不是仅确认收线才计算；有效活动柱更新仍推进 preview/采样。

显示门禁与 allowNewEvaluation 保持原差别：禁止新评估不停止指标/采样，返回投影不代表显示放行；宿主按原显示门禁提交/消费请求，不反向阻断策略计算。

`allowNewEvaluation` 由原 ordinarySignalGuard、有效 currentDayKey、非开盘保护共同决定。不开新的宿主 delay policy，不为了显示第二次调用策略。监听时间和用于门禁判断的 clock 时间必须有效；不合法时在同步业务边界报告 fatal，不采样、不创建 origin 或输出。包围策略 onCandlestick 的同步调用边界也必须在返回/上抛前报告内部异常，不能只依赖外层 Promise.catch 稍后才关交易门禁。

冻结覆盖数组、每根 candle、seats 元素和 context。不能只冻结数组却允许策略改 candle.close；后续缓存更新也不能回写已经交付的快照。primitive 中的 number/string/null/undefined 保持原值；NaN/Infinity 的现行下游算法语义由策略处理，不在投影时用 0 伪造有效行情。

### 6.2 emitter 明确执行顺序

emitter 可以被私有 pending 长期保存，onCandlestick 返回不使其失效。

1. 若进程已最终终止，迟到 callback 清局部引用并 no-op，不重新启动任何业务。
2. 校验 decision 为普通对象，精确字段为 action、triggerTimeMs、可选 reason；字段值正确，时间为可精确映射有效 Date 的整数毫秒。精确字段检查考虑自身键，不只检查可枚举字符串键而放过额外 Symbol/非枚举授权字段。
3. origin 必须在新判断获准时创建，day 有效，action 对应完整 ACTIVE origin route；同 origin 重复 action 为内部契约错误。记录本 action 已输出，不能因第一次当前门禁失效而允许第二次冒充新输出。
4. 对合法 origin，当前 day、普通 gate、ACTIVE 状态、symbol 或 seatVersion 已变化则正常丢弃，不把当前失效当作缺少 origin。
5. host 按白名单新建普通 Signal，绑定 origin 对应且仍有效的当前 symbol/name、seatVersion、动作、Date 和 reason；可选 reason 缺失时省略字段以符合 exactOptionalPropertyTypes。
6. 进入中性 `STRATEGY_BUY`/`STRATEGY_SELL` 队列，检查明确的 admission 返回值。终态拒绝无通知；非终态 owner/queue 状态矛盾为内部错误。

内部契约错误必须在该 decision 入队之前同步报告 fatal；不等待 Promise catch 才关闭门禁。同步调用边界可以继续上抛同一错误用于收口，但共享 owner 只能锁存第一个主错误。已合法入队的前序动作不伪造回滚；最终 gate 阻止其后不再获准的订单副作用。

**不得新增：** execution quote 读取、sizing/risk、即时/延迟分类、SELL 回流买单记录门禁、开盘保护对既有回流的独立拒绝政策、host pending 授权表。

### 6.3 显示与风险拆依赖

- `monitorDisplayRuntime` 仅持有中性 latest-only 请求；`marketMonitor` 不再解释具体指标族或 displayPlan。
- 策略决定指标标签、顺序、格式和缺失展示；宿主保留实时报价、名称、涨跌幅和缓存 K 线时间来源。
- 启动 `config/validator` 保留全局交易配置校验/显示，但移除四 DSL 和两侧验证的解析/摘要逻辑。具体摘要由策略使用注入 logger 解释一次，宿主只显示选中 id 与初始化状态。
- 删除 `BuyRiskCheckContext.monitorSnapshot`，收窄 monitorQuote 为已校验非空行情；风险入口防内部误用时 fail-fast，不从旧指标补价。
- 删除 `Signal.indicators1` 及 retry clone 对它的复制；clone 的 triggerTime/route/关联买单等其他业务字段保留。
- 删除 reason 文本清仓分支并同步注释；专用清仓命令与提交路径不变。

## 7. 启动、终态与生命周期实施算法

### 7.1 composition root 装配顺序

1. 取得一次统一 env 快照；用 key presence 拒绝八个旧策略键，包括空字符串值。
2. 按 §4.5/§4.6 校验 ACTIVE_STRATEGY_ID、推导选中目录，确认入口精确路径后动态 import 一次；验证固定导出、ID。启动不全量导入或校验未选策略。选中 definition 内部 `import config from './config.json'`；同步零参数 `prepare(): PreparedStrategy` 消费该对象，返回闭包 create 延后创建实例。宿主只校验相邻 config.json 元信息，不读取内容。导入允许 Decimal 等库模块求值，但不创建 SDK context 或网络。
3. 解析不含策略结构的全局交易/认证配置。以上失败都发生在 SDK 创建前。
4. 准备初始关闭的 gate、clock/scheduler、共享终止 owner 和 cleanup 计划；立即安装正常退出订阅，早于 selected prepared.create 和首个 SDK/业务资源创建。将旧 `waitForShutdownSignal` 的晚安装 Promise 接口改为注入同步回调的订阅接口，返回幂等释放函数；主流程仅等待共享终止 owner 的通知。
5. selected prepared.create 一次；实例返回立即登记唯一 strategy destroy cleanup，然后核验 strategyId/返回端口契约。
6. 逐个创建 SDK、行情、Trader、recorder、风险等宿主资源，返回后立即登记其 cleanup。
7. 使用完整资源和同一 strategy 引用创建 MonitorContext；context 不调用策略 factory。
8. 装配 queue、processors、事件/时间/lifecycle owners，注入共享终止授权。
9. 按原 startup snapshot/recovery/rebuild 流程恢复事实；成功且终态仍未关闭才放行。
10. prepared 不进入运行期 context/post-gate 依赖；运行期不再 prepare/create。

创建期间发生 fatal 或正常最终退出：同步关门并停已知生产者，但等当前 await 创建落定；若资源成功晚到，仍登记 cleanup，随后停止后续装配，再运行唯一 cleanup。晚到资源不得启动，其 admission 不得绕过已关闭的共享终态。每次创建返回先登记清理再检查终态；后续创建/启动前及 startup snapshot、初始 rebuild、Quote reconcile、初次时间唤醒等 await 返回后均复核终态，不放行、不 reopen。恢复函数内部真实放行点也必须使用共享终止授权，不能只在外层返回后检查。不能 `Promise.race(装配, 终止通知)` 后直接清理。构造返回前失败由该工厂收口自己的内部状态，不返回半资源。

正常退出订阅保留到唯一 cleanup 尝试结束，并在外层 finally 幂等释放，覆盖正常退出、fatal、启动失败及 cleanup 抛错；重复退出请求不启动第二份 cleanup，也不在清理中途撤掉监听而让后续普通退出信号绕过收口。此合同覆盖应用已建立 termination/cleanup 后的受控退出，不承诺捕获 SIGKILL 或监听建立前的进程强制终止。

### 7.2 最小 termination owner

新增模块只承担三个事实：不可逆终止 latch、首次 fatal 的有无和值、通知主流程的唯一等待入口。主错误用显式存在状态表示，不能以 truthy 或 `error === null` 作为“尚无错误”的唯一判断，因为 `unknown` 可以是 null/undefined。

首次 fatal 的同步部分，顺序固定：

1. 锁存原始错误并置最终终止状态。
2. 设置 `isTradingEnabled=false`，让最终 Broker mutation 授权也能观察终态。
3. close 已创建的 trade/monitor producer admission。
4. 尝试所有已创建事件/timer/候选生产者的同步停生产操作；单个失败不阻断其他同步 stop，也不覆盖主错误。
5. 通知 runApp；主流程在装配落定后进入既有分阶段异步 cleanup。

通知和日志不得先于 1–3。正常退出的订阅回调必须在当前调用栈同步置终止 latch、执行相同关门/停生产，然后才通知主流程；不得只 resolve Promise 再等待微任务关门，也不伪造 fatal。正常退出后的真实创建/恢复/排空内部错误仍按原分类报告并锁存首个 fatal；无主错误但 cleanup 失败时按原 runApp 规则报告。

受影响 owner 保留 running/inFlight/drain 等局部资源状态，移除并列的 primary fatal 真相与多个互相竞争的 fatal 等待。禁止用一个泛化 owner 注册/封印/监督平台替代这里的最小接线。

### 7.3 admission 和迟到生产者

trade queue、monitor queue 增加不可重开 `close()`，push/scheduleLatest 返回明确 boolean 接纳结果；close 后零队列 mutation、零通知，pop/clear 可继续清理。全部调用方消费返回结果或明确说明终态 no-op 的处理，不保留“void push 默认成功”的误解。

逐个闭合：

| 生产者 | await/timer 后必须复核 | 失效处理 |
| --- | --- | --- |
| strategy emitter | origin 契约、当前 day/gate/ACTIVE route、终态 | 旧事实正常丢弃，非法契约 fatal |
| SellProcessor quote retry | 捕获 retry entry 身份、owner、普通 gate、signal route/day、终态 | 删除当前自己的 retry 状态，no-op；不删除后来的同 key 新项 |
| MonitorTaskProcessor SEAT_REFRESH retry | 捕获 entry 身份、ACTIVATING symbol/version、所属恢复授权、终态 | 失效 no-op，不要求 ACTIVE |
| SeatActivationDispatcher | 当前激活批次/身份、终态、恢复授权 | 不入旧激活任务 |
| PeriodicSwitchWakeupRuntime | 当前计划/token、席位基线、适用门禁、终态 | 取消旧计划 |
| AutoSearch/seat 事件间接生产者 | 对应寻标/席位身份和授权、终态 | 不写旧结果，不继续排程 |
| processors start/restart | 终态且 queue admission 一致 | 不重新注册 onTaskAdded、不恢复调度 |
| lifecycle/rebuild/reopen | 放行前、相关 await 返回后都检查终态 | 不重新启动 owners、激活席位或开启交易 |

正常午休/跨日 stop 不调用不可逆 close；正常恢复任务不能被普通 ACTIVE gate 错误拦死。已提交 Broker 副作用不承诺撤销，在途任务仍受原最终 mutation gate 保护。

### 7.4 生命周期矩阵

| 场景 | 策略动作 | 宿主动作 |
| --- | --- | --- |
| 开盘保护 | 继续指标和采样；不新评估；既有 pending 可验证 | allowNewEvaluation=false，不单独拒绝既有回流 |
| 午休/普通 gate 关闭/末日接管 | invalidateAll，清 pending/token/timer，不清指标/sample | 停普通授权；专用清仓仍按原规则 |
| 方向离开 ACTIVE/身份变化 | 同步 invalidateDirection | registry mutation 返回前完成；另一方向不受影响 |
| 午夜 | 顺序排空后 resetForTradingDay | 不 destroy、不最终 close；失败按 D2 |
| 开盘重建 | 同一实例首个新事件重建指标 | 恢复事实成功且非终态才启动普通 owners |
| fatal/正常最终退出 | 先 invalidateAll，排空后唯一 destroy | 同步最终关门、异步分阶段 cleanup |

destroy 后 onCandlestick/invalidate/reset/迟到 callback 都先检查终态，零采样、零输出、零重排。reset 不能撤销 destroy。同步方向取消是事件驱动接线，不改成未来某轮轮询清理。

### 7.5 排空依赖和 D2

正常成功路径的依赖拓扑：

```text
关闭交易与适用 producer admission
 → 停事件/定时调度，取消策略候选，中断 freshness 等待
 → 排空业务 owners/processors 和订单监控
 → 停并排空 PostTrade 的请求与 onPositionsCommitted 回调
 → 排空其他 quote reconcile/retain/release 调用方
 → stopAndDrain QuoteSubscriptionRuntime
 → 最终退出：唯一 strategy.destroy；午夜：strategy.resetForTradingDay
 → 清对应宿主 queue/cache 与其他生命周期事实
```

具体落地在 `src/constants/cleanup.ts`、`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts` 及其真实调用点；全局 domain 的恢复顺序仍沿现有机制，不机械把所有 start 与 stop 逆序对应。

- **午夜**：任何步骤失败，停止本轮后续步骤。外部错误依原 lifecycle 重试；内部错误上抛 fatal。不能把“尝试了 drain”视为 drain 成功，不能未排空就 reset 或清依赖事实。
- **最终退出**：每个阶段错误记录为 secondary 并继续尝试后续清理，不用某一步失败跳过所有剩余资源；失败的 drain 不能记为成功。同步 admission/候选授权已先关闭。只要生产者 drain 成功，必须证明 Quote stop 完成后零旧 mutation；若 drain 本身失败，明确报告清理失败，不宣称依赖排空已验收成功。
- PostTrade 同停止周期复用排空 Promise，等在途请求及回调结尾才 resolve；正常 start 后下一停止周期使用新状态。
- fatal sink 只同步停生产，不无等待启动一份 drain 再让 cleanup 创建第二份。
- Quote start 前的显式 reconcile 在 startup/rebuild 中仍合法，不能用简单 `running=false` 一律拒绝来掩盖顺序问题。

## 8. 分阶段工作包与可编译切换

### 8.1 执行依赖

```text
WP0 基线与迁移输入
 ├→ WP1 公共端口/配置准备 → WP2 策略私有所有权
 ├→ WP3 终止/admission 基础 → WP4 生产者/清理依赖
 └→ WP7 静态 JSON 编译配置（实现依赖 WP1）
WP1 + WP2 + WP3 + WP4 → WP5 宿主完整接线
WP5 → WP6 删除旧契约/执行与显示闭合
WP1 + WP7 + WP6 → WP8 集成/结构/资产验收
WP8 + 真实部署配置 → WP9 发布门禁
```

每包可独立开发、单测，但 **WP1–WP7 最终集成是同一不可拆发布单元**。开发分支暂存的新纯模块不是运行时兼容层；生产接线切换后立即删除旧 owner。任何中间版本不得以双实例、双配置源或旧接口转发方式发布。

先做终态基础是为了给新异步 emitter 提供可靠宿主授权；不允许用“以后再做安全”先上线新策略。

### WP0：固定基线与迁移输入

**输入**：本计划 D1–D5、当前源码/配置 parser、旧测试。

**步骤**：

1. 记录 HEAD、工作区和相关文件变更；工作区已有修改不覆盖。
2. 重跑本计划 §2.3 旧测试，记录真实退出码；失败先定位是既有问题还是环境问题，不伪造基线。
3. 固定确定性 fixtures：四表达式、两侧 delay/list、K 线序列、orders/seats、clock 读数序列、scheduler 可控 callback。
4. 补价值明确的基线：D3 四种精度情况、空 OR 段、零 delay 显式指标、动作生成/登记顺序、最近样本并列。
5. 向部署方取得旧版本已经解析校验的有效策略值、源版本、原键是否显式存在；只接收策略值，不收认证密钥。
6. 有原始有效 DSL 时保留它；只有结构化条件时，实施一个能回读的十进制 DSL 序列化并做往返测试，不能使用日志 formatter。真实值到位后在 WP1/WP2 阶段形成正式 config.json，供 WP7/WP8 校验和构建；不能等到 WP9 才首次生成构建必需资产。

**产出**：fixtures/基线记录/迁移输入清单。未有真实值时允许继续 fixture 开发，但 `config.json` 生产资产与 WP9 阻塞，不写占位交易参数。

**完成门禁**：基线行为明确、D3 用测试表达、生产值缺口被显式记录。

### WP1：公共端口、免注册加载与严格准备

**文件**：`core/strategy/types.ts`、中性 `core/strategy/utils.ts`、`constants/strategy.ts`；新增 `app/startup/prepareStrategy.ts` 及相邻类型；具体 `definition.ts/config.ts/types.ts/constants.ts`；`app/runAppDeps.ts`、`app/types.ts` 的必要依赖契约。不创建 `src/config/strategy.ts` 或其替代注册表。

**步骤**：

1. 定义 §4.3 公共契约和固定导出名，禁止 import 具体配置类型。
2. 实施 §4.5 严格 ID/目录双向映射、精确大小写、跨平台名字和路径边界；纯映射与文件 I/O 分开，供启动定位使用。
3. root 准备 helper 注入 env、文件/目录能力及动态 importer，而不是 definitions 数组；按 §4.6 只定位并导入选中入口，导出先以 unknown 校验，保留 import 原因。
4. 实施 §5.1 JSON/parser/profile 只读准备；静态导入后 prepare 一次，不增加 env fallback、配置 manifest 或生成清单。
5. 测试非法选择、目录/入口缺失、路径/大小写/身份错误、传递依赖失败、旧 key presence 和严格 JSON；未选策略放置会抛错的测试入口，选中其他策略时不得触发它。
6. 在临时策略根新增不同 schema/私有指标的测试目录，不改中心文件即可选中运行；source/dist 模式分别验证。具体策略模块也应由 tsc 检查公共定义契约。

**完成门禁**：动态加载和 prepare 无 SDK context 创建/网络/timer/create；未选模块零求值；不存在中央登记或 fallback；无 any、配置断言适配、重复类型别名。

### WP2：当前策略整体所有权迁移

**文件**：`core/strategy/index.ts/utils.ts` 的相关逻辑、`config/utils.ts` 策略 parser、`services/indicators/profile/`、`runtime/index.ts`、`utils/indicatorHelpers/` 的政策、旧 verifier/cache 逻辑，目标均按 §4 落点。

**步骤**：

1. 按 §4.2 将五实现直迁私有 runtime、六类型合并现有 runtime/types；tools 直引私有 leaf/type，删除整个 services/indicators，无 math 层/复制/兼容转发。
2. 迁移指标编排、私有 profile 和真实 runtime state；删除旧 opaque handle、品牌转换及 unwrap，不迁移包装层。固定参数选择放策略内部，保留数学舍入、invalid、partial 和 committed/preview 行为及真实状态不变量。
3. 迁入 sample store，删除其默认 retention；由已验证两侧配置唯一推导。
4. 迁入 pending/timer/token、方向取消、reset/destroy；宿主不能持有或注入这些状态对象。
5. 将旧 generateSignals 转为私有候选计算，再内部提交 immediate/登记 delayed；对外仅 emitter。
6. 按 §5.2 保留 clock 读取和 D3；异常时间/内部状态走 fatal，不作为无行情。
7. 迁入原因文本、指标显示、配置摘要；新工厂注入基础依赖，构造不启动 timer/emit。
8. 直接创建新策略实例测试，不用旧 verifier 作为新策略代理。

**完成门禁**：策略独立测试覆盖 §10 的指标/时间/验证/生命周期行；生产宿主只能经公共 port 操作；非生产 tools 按 §4.2 直引 leaf/type；旧 services/indicators 整个目录不存在。

### 补充工作包 S：实施与补充验收已完成

本包正式并入 WP2/WP5/WP6/WP8，保持同一发布单元，原 D1–D5 和 T01–T34 其他业务不变。C-docs 文档确认及后续 A/B/C 实施、独立 review、最终门禁现均已完成。本轮不修改策略参数和 env；原真实配置迁移/发布门禁保留，不据此在补充重构中改写已有参数。以下 S01–S07 均为**已完成/补充验收通过**，证据见本节记录；不等于原主方案全部发布门禁完成。

| ID | 已完成工作与验收要求 |
| --- | --- |
| S01 | 五实现直迁 runtime、六类型合并现有 runtime/types；无 math 层/复制/alias/re-export/兼容文件。src/services/indicators 整个目录不存在，src/tools/tests/mock 旧路径引用清零（负向结构测试文字除外）。 |
| S02 | dailyIndicatorAnalysis 与直接工具消费者私有 leaf/type 正例；不经入口/config/logger 新增副作用，不保留公共模块，既有包装器 logger 不扩项。 |
| S03 | 架构生产规则仅 src：宿主/公共模块不得依赖策略私有模块，生产策略绝不跨策略私有 import；tools 正例不放宽生产边界。CandleData 仍中性。 |
| S04 | 固定同步 onCandlestick 全量替换契约、工厂、加载校验、宿主调用、mock/tests/注释；无旧方法 alias、hooks 注册总线、算法步骤 hooks、async 或 Promise 联合返回适配。 |
| S05 | 宿主监听→singleflight latestOnly→权威快照深冻结/origin emit→一次 hook；被合并的原始推送不计算，活动柱仍计算而非仅收线；allowNewEvaluation 与显示门禁差别及原采样集合保持。 |
| S06 | 数学 golden/基线对拍与 T01–T34 保持；独立动作 clock/D3、pending 保存原 emit、方向/全部取消、reset/destroy、fatal 同栈不变。旧基线已不可运行时使用固定 fixture/记录，不恢复兼容代码。 |
| S07 | 离线按 format→lint→type-check→test→build 记录真实退出码，含工具正例、旧目录不存在及 source/dist fixture；禁止运行真实 src/index.ts/dist/src/index.js 交易入口或使用生产凭据。未执行/失败不得记通过。 |

#### 补充验收记录（S01–S07）

以下为本轮 A/B/C、独立 review 和最终门禁的已报告证据，本次文档恢复不重复执行代码测试或真实启动。证据目录：`C:WINDOWSTEMPhsi-final-gate-T9qRTT`。

| 范围 | 实际验收结果 |
| --- | --- |
| S01、S06：数学迁移等价 | 五 math 实现与六 types 经独立 AST 对照 index 基线等价；192025 项值/状态对拍通过。 |
| S02、S03：工具与生产边界 | C 架构测试 71 pass；私有 leaf/type 工具正例及 src 生产边界通过，既有工具包装器 logger 不扩项。 |
| S04、S05：同步 K 线 hook | B 完成 18 个代码文件替换；旧方法 alias 不存在，旧事件方法名和旧 import 源在代码中均为零；独立 review 未发现确认缺陷，S01–S06 已核销。 |
| S07：历史最终顺序门禁 | format → lint → type-check → test → build 严格顺序执行，各退出码均为 0；全量测试 2342 pass / 0 fail，181 files，8145 expect。 |
| S01、S07：源码/产物闭合 | source/dist 旧 services/indicators 均不存在；新私有五 leaf 与 types 齐全；JSON 字节一致；source/dist prepare 检查均退出 0，未调用 create。 |

**结论：S01–S07 补充实施与验收已完成。** 这不核销原主方案 WP9 的真实部署、单进程、恢复/回滚等未验收事实；不表示 native 正常退出问题已修复或已验收，也不表示执行过真实 launch。原方案历史状态保留为历史记录，不用于否定本节已完成的补充证据，也不据本节推定全部发布门禁通过。

### WP3：共享终止入口与最终 queue admission

**文件**：新增 `app/runtime/createTerminationRuntime.ts`；`app/runApp.ts`、`app/runAppDeps.ts`、`app/types.ts`；`main/asyncProgram/tradeTaskQueue/`、`monitorTaskQueue/` 及公共类型；`main/asyncProgram/utils.ts` 等 processor 公共驱动。

**步骤**：

1. 设计最小终止 latch 和唯一终止通知，区分正常退出与首个 fatal，不新增策略 supervisor；将进程信号适配为同步正常终止回调，并提供幂等释放订阅。
2. 接入 gate、已创建 queues、同步 stop callbacks；终态检查覆盖原始 undefined/null thrown error。
3. queue close 不可逆，push/scheduleLatest 明确返回接纳结果，正常 clear/stop 不 close。
4. 让 processor start/restart/通知驱动尊重终态，保持异步消费，不在通知栈执行 Broker I/O。
5. 各 owner fatal 报告连接同一入口，移除并列 primary 真相；保留局部资源状态。
6. 写同步性测试：fatal 或正常退出回调后不推进微任务就检查 gate/admission 已关；正常退出不制造主错误，重复请求不重复 cleanup；重复 fatal 不覆盖主错误；一个同步 stop 抛错不阻断其他 stop。

**完成门禁**：终态后 push/notify/restart 零业务 mutation；正常 stop/restart 可恢复；runApp 只有一个主 fatal 入口。

### WP4：生产者身份、午夜/退出清理与防重开

**文件**：SellProcessor、MonitorTaskProcessor、SeatActivationDispatcher、PeriodicSwitch/AutoSearch wakeup 及实际 seat 生产者；`dayLifecycleManager.ts`；`createPostTradeConsistencyRuntime.ts`；`createPostGateRuntime.ts`；`signalRuntimeDomain.ts`；`constants/cleanup.ts`；QuoteSubscriptionRuntime 的直接调用方。

**步骤**：

1. 按 §7.3 表逐项追踪全部 push/scheduleLatest/retry 注册；callback 捕获 entry 身份，防旧 callback 删除新 retry。
2. lifecycle/rebuild 真正放行前和 await 后检查终态，连通席位激活和 owners restart；不得只在 tick 开头检查。
3. PostTrade 拆同步 stopScheduling 与幂等 drain，或等效复用同周期 Promise；排空包含 onPositionsCommitted。
4. 完整列出 quote reconcile/retain/release 生产者，排空它们后再停 Quote。
5. 午夜和最终 cleanup 分别修正顺序，保留 D2 的不同错误边界。
6. 以挂起 Promise 的方式验证依赖，不以 spy 调用先后替代异步完成证明。

**完成门禁**：所有 §7.3 行都有实际调用方证据和针对性测试；午夜外部失败不执行后续 domain；正常 rebuild/start 前 reconcile 仍通过。

### WP5：composition root 与中性事件接线

**文件**：`app/runApp.ts`、`runAppDeps.ts`、`app/types.ts`、`runtime/createPreGateRuntime.ts`、`createPostGateRuntime.ts` 及 Deps 文件、`createAsyncRuntime.ts`、`context/createMonitorContext.ts`、`businessEventProgram/`、`seatRuntimeCleanupDispatcher/`、`timeWakeupEvaluationProgram/`、`app/lifecycle/`。

**步骤**：

1. 按 §7.1 调整装配：准备在 SDK 前、create 唯一、返回即登记 destroy、完整 context 后置。
2. 统一实例引用注入 context/event/lifecycle；删除可选旧 factory/默认 factory/二次绑定。
3. business event 不再持有 indicatorCache/profile/runtime，改只读投影 + 一次策略调用 + 显示投影提交。
4. 新 emissionAdapter 按 §6.2 顺序校验/丢弃/入队；非法 decision 当场关闭 gate。
5. 接同步方向取消、ordinary gate invalidateAll、午夜 reset、最终 destroy。
6. 按 §7.1 在首个业务资源创建前安装正常退出订阅；处理创建 await 中 fatal/正常退出的晚到资源登记，并复核初始恢复各 await 后的终态，不能让 cleanup 先跑或继续启动；所有退出路径在 cleanup 尝试结束后 finally 释放订阅。
7. 用装配 spies 证明 selected prepare/create 各一次、context 引用相同、未选定义零调用、失败也恰好 destroy 一次。

**完成门禁**：生产普通链路只调用新 port；sample/pending/verifier 不在任何宿主 deps 中；完整 context 无空资源。

### WP6：执行/显示/配置去耦与旧路径删除

**文件**：`types/config.ts`、`signalConfig.ts`、`indicatorProfile.ts`、`indicatorRuntime.ts`、`quote.ts`、`state.ts`、`services.ts`、`monitorContextPorts.ts`、`signal.ts`；config trading/validator/utils；`monitorDisplayRuntime/`、`marketMonitor/`、signalProcessor、buy/sellProcessor；helpers、lifecycle domains、constants、mock、相关 tests。

**步骤**：

1. 移除全局配置的 signal/verification 业务字段、parser、校验与具体显示；旧键只保留明确拒绝清单。
2. 删除 context verifier/profile、宿主 snapshot/runtime。检查 MonitorState 空壳、全局初始化/清理及 helpers。
3. 删除风险 snapshot 依赖及补价、Signal.indicators1、clone 该字段；保留 SELL retry clone 本身。
4. 删除 reason 文本授权，回归 typed 清仓和普通智能平仓。
5. 完成运行期/启动显示拆依赖，策略文本不替代宿主报价事实。
6. 删除旧 verifier/cache 目录、registerDelayedSignalHandlers、旧工厂/分类返回接口及 IMMEDIATE/VERIFIED 任务种类；普通任务统一 STRATEGY_*。
7. 将旧行为测试移入新 owner 对应 tests；测试不再保留旧生产 API 的兼容要求。
8. 拆混合常量：原 VERIFIED_SIGNAL_COOLDOWN_SECONDS 仍是宿主买入风险冷却，改为准确名称并全量替换；不要搬进策略。
9. 同步 ESLint/import boundary 和 architecture tests，生产规则仅作用于 src；保留宿主/公共模块与跨策略私有依赖禁令，不开 services → core 全目录例外。移除误将 tools 作为生产边界的断言，增加 tools 私有 leaf/type 正例及旧目录不存在检查。

**完成门禁**：无旧 owner、无 re-export/别名转发、无具体策略数据流经宿主；工具和测试能从真实源模块引用数学类型。

### WP7：静态 JSON 与正式构建

**文件**：package.json、tsconfig.json、tsconfig.build.json、tests/build/productionBuild.test.ts、README。删除 scripts 全部构建文件及其专属测试/类型，不新增 copy/validate 框架，不修改 env。

1. 正式命令为 `bun run clean && tsc -p tsconfig.build.json`，clean 复用 rimraf；package 命令按项目根 cwd 执行，不另要求构建工具支持任意 cwd。
2. build 仅 src include 与静态依赖闭包，rootDir=./、outDir=./dist，noEmitOnError=true；关闭 declaration/declarationMap/sourceMap，保留纯类型源生成的空 JS。开发 noEmit 仍含 tools/tests/mock，不含已删除 scripts。
3. definition 静态导入相邻 config.json，tsc 自动输出依赖 JSON。只保证深层配置语义一致，不保证空白、转义或字节一致；不扫描目录、不 import/prepare/create 编译定义。
4. 无关未选目录的 schema/DSL/元信息不阻断 build；tsc 自己拒绝的源/静态 JSON 错误仍使编译失败。选中启动严格 metadata、契约与 prepare，先于 SDK context 创建，无 fallback。
5. JSON-only 修改、新增静态导入与删除策略分别验证重建/clean；编译失败 clean + noEmitOnError 不留陈旧 JS。隔离 dist、任意运行 cwd、移走 source 后仍使用自身相邻 JSON，缺资产失败。
6. 源码/配置变化后 dist 必须 rebuild + restart；直接源码运行也必须 restart，无热加载。Bun/tsc JSON 语法接受集合不同属于工具边界，不恢复重复键、严格 UTF8 自检或自定义 JSON validator。

**完成门禁**：真实配置语义比较和离线重建测试通过；build 成功不等同于配置已 prepare 或已可发布，WP9 真实部署验收保持独立。

### WP8：集成、结构与全量验收

**输入**：WP1–WP7 最终接线完成，不存在半迁移生产路径。

**步骤**：

1. 执行 §10 行为矩阵，重点保留可控时序的端到端测试。
2. 执行 §11 残留/模块图检查，每项命中按 owner 归类；生产旧路径必须真正不存在。
3. 按顺序执行 format → lint → type-check，再全量测试、build、资产检查；发现新改动后只重跑受影响项及规定必要检查。
4. 独立代理只读复核最终 diff/调用链，返回检查文件、确认发现、未发现项、建议验证、置信度。
5. 修复确认问题并复跑相关验证。未解决项不能标完成，不能以旧54项基线代替目标验收。

**完成门禁**：所有适用行为/结构/命令证据通过；若真实 JSON 缺失则明确“架构实现可验证、正式 build/发布未完成”，WP9 不得开始。

### WP9：一次性迁移与发布

1. 复核 WP1/WP2 已生成、WP8 已构建的真实 JSON 及来源；所有字段显式，已核实的旧默认值物化。若发布前参数发生变化，先回到配置校验和受影响的 WP7/WP8 验证，不直接替换已验收资产上线。
2. 核验配置迁移回放记录：新 prepare 后四动作、两侧列表、delay、编译指标/显示与旧有效值一致，决策/验证回放结果满足约定。
3. 从新部署 env 删除八个旧策略键，仅添加精确 ACTIVE_STRATEGY_ID；旧发布的 env 随旧包独立保存用于部署级回滚，不进入新运行时。
4. 停旧进程并等待安全收口；部署完整程序、策略目录、ACTIVE_STRATEGY_ID、JSON 和构建资产。新增策略只新增目录并设置选择值，无需修改中心文件，但仍必须 clean + tsc 构建通过后重启。
5. 新进程严格校验并完成原 recovery/rebuild 后放行；部署方证明只有一个下单进程。
6. 失败回滚完整旧包与旧 env，不将新旧程序/配置混用。pending/timer/sample/普通队列不跨进程恢复。

**完成门禁**：真实配置来源、构建包、单进程、恢复演练和回滚演练均有记录；不得用“文档写了”代替部署证明。

## 9. 文件迁移与删除检查表

| 旧位置/符号 | 最终处理 | 必查消费者 |
| --- | --- | --- |
| `core/strategy/index.ts` 旧 factory、`types.ts` 旧返回分类 | 删除旧 factory；types 改公共 port，具体逻辑私有化 | createMonitorContext、RunAppDeps、testDoubles、mock |
| config utils 的 DSL/verification parser/formatter | 相关政策迁入策略；全局 env 业务解析删除 | trading utils、validator index/utils、config tests、迁移资料 |
| services/indicators/profile | 全部策略私有 | context、显示、runtime、类型 |
| services/indicators/runtime/index | 编排及真实 state 迁入策略；删除 opaque handle、品牌转换/unwrap，不保留转发 | indicatorPipeline、runtime tests、公共 state |
| 数学 ema/kdj/mfi/rsi/utils 与 runtime/types | 五实现直迁私有 runtime；六类型合并现有 runtime/types；删除整个 services/indicators，无 math 层/复制/转发 | dailyIndicatorAnalysis 私有 leaf/type 直引、数学对拍、生产边界 |
| utils/indicatorHelpers | 指标名/用途/快照读取私有化；真实中性函数留原通用源 | config、marketMonitor、runtime、verifier/cache、其他风险展示 |
| types/indicatorProfile、indicatorRuntime、signalConfig | profile/config 数据迁私有；删除公共 opaque indicatorRuntime，不建私有句柄替身；删除无剩余消费者的原文件 | constants/index、types/config/state/quote、mock/tests |
| types/quote 的具体 snapshot | 迁私有；KDJIndicator 归私有 runtime/types，CandleData 仍中性 | marketMonitor、tools KDJ 类型、riskCheckContext |
| main/asyncProgram/delayedSignalVerifier、indicatorCache | 删除整个旧 owner 及旧 tests；行为测试归新 owner | post-gate、RunAppDeps、business event、lifecycle、cleanup |
| app/wiring/registerDelayedSignalHandlers | 删除 | runApp、app tests |
| MonitorState 的 snapshot/runtime | 删除；空壳整体删除 | context/init/helpers、globalStateDomain、buyProcessor |
| Signal.indicators1 | 删除，不保留可选兼容字段 | factory、verifier、SellProcessor clone、fixtures/mock |
| `IMMEDIATE_*`/`VERIFIED_*` 普通任务 | 全量改为 STRATEGY_BUY/SELL | queue types、switch/processor、通知、日志、tests |
| VERIFIED_SIGNAL_COOLDOWN_SECONDS | 宿主风险冷却重命名，保留数值/语义 | signalProcessor/riskCheckPipeline 及 constants 类型 |
| CLEAR_INDICATOR_CACHE 等旧 cleanup phase | 随 owner 删除/改为正确阶段 | constants/cleanup、phase types、注册、tests |
| sell reason.includes 清仓分支 | 删除并修正文档注释 | 普通卖出/智能平仓 tests；typed 清仓不改 |
| 分散 primary fatal/reopen | 唯一 root fatal；各 owner 保留局部状态 | app/main/core 中全部放行与 restart 路径 |
| 旧方案的 `src/config/strategy.ts`/definitions 清单 | 不创建；若实施分支已创建则删除，无兼容转发或生成替代 | startup、RunAppDeps、资产工具、architecture tests、直接部署说明 |

`docs/`、`tools/` 仅检查本次直接影响引用。对应设计合同已同步最终免注册要求，不能同时保留“新增需登记”的有效指令；文档中明确标为删除对象的旧符号不算生产残留。README、直接部署说明和执行命令必须更新，不能继续指导用户运行已删除接口。

## 10. 验收矩阵：测试归属、输入与明确结果

测试目录与 src 对应；下表新文件名为建议落点，可合并同一业务 fixture 的测试，但不能删掉关键行为断言。测试无需追求逐函数/覆盖率数字。

| ID | 建议归属 | 场景与必须断言 |
| --- | --- | --- |
| T01 | `tests/app/startup/prepareStrategy.test.ts` | 严格 ID、路径、固定导出、同步 prepare、legacy env、cause、无 fallback；未选模块零 import/prepare/create，坏未选 JSON 不影响选中启动。 |
| T02 | `tests/core/strategy/intradayRegression/config.test.ts` | unknown 对象精确 own schema/type/range/DSL/指标；规范化副本递归冻结，不修改或冻结共享 JSON 缓存对象。不再保证原文重复键和严格 UTF8 自检。 |
| T03 | 同上 | 0、120、正常小数；负值、越界、非有限表示失败；空指标/零delay immediate；零delay显式指标仍进入profile/display。 |
| T04 | 同上/迁移测试 | `\|(K<20)`、原三段计数与空白段差异、N-of-M/OR/负阈值保持；小阈值DSL往返不被日志指数形式破坏。 |
| T05 | `tests/core/strategy/intradayRegression/runtime/` | 同柱重复更新、确认/换柱、乱序忽略后输入、窗口bootstrap、partial、舍入均与基线一致。 |
| T06 | 同上 | 无有效数据正常null；实际可达的symbol/profile等私有状态不变量错误不伪装null、不触发bootstrap，不提交新旧混合状态；不要求伪造已删除的opaque handle。 |
| T07 | `tests/main/businessEventProgram/` | latest-only 丢旧事件保留最新 observedAt；策略只调用一次；同版本事件不额外过滤采样；策略改输入不能影响缓存或旧快照。 |
| T08 | `tests/core/strategy/intradayRegression/` | 无pending/开盘保护/本轮新pending都先采样；allowNewEvaluation=false不新评估；展示不需要第二次策略调用。 |
| T09 | 同上 | 动作独立clock、判断/登记读数顺序、relative timer正确；T0回流不改为callback时间。 |
| T10 | 同上 | D3：零、普通小数、加法推进但Date截断同毫秒、加法完全未推进；最后一种零pending/零emit，前一种不误丢弃。 |
| T11 | 同上 | initial缺失/无效无pending、不immediate；BUY/SELL两侧映射、identity去重、max两侧+25秒窗口。 |
| T12 | `tests/core/strategy/intradayRegression/verification/` | nearest、等距新样本、三个目标可命中同条；ADX特殊方向、严格比较、任一失败即丢弃。 |
| T13 | 同上/策略工厂 | callback先终态化；取消后同key新entry不被旧callback删除；destroy后旧timer、onCandlestick/reset均零副作用。 |
| T14 | `tests/main/businessEventProgram/emissionAdapter.test.ts` | 非法动作/字段/时间/重复action/缺origin route是入队前fatal；额外清仓字段不能进入Signal；先前合法入队不伪造回滚。 |
| T15 | 同上 | 保存emitter异步回流；当前day/gate/route变化正常丢弃；开盘保护本身不拦既有回流；终态后零入队/通知。 |
| T16 | 策略 + emitter + sellProcessor 集成 | 生成SELL有filled BUY；清仓提交后清记录但route/gate仍有效，验证通过仍入队；freshness挂起时无提交；刷新后智能平仓关闭且有可卖量、协调允许时按最新事实执行。另测route/gate失效丢弃。 |
| T17 | `tests/main/asyncProgram/buyProcessor/`、signalProcessor | monitorQuote缺失/非正/非有限仍拒买；无snapshot补价；内部窄契约误用fail-fast；原风险顺序与最终行情门禁不变。 |
| T18 | `tests/core/signalProcessor/` | 普通reason包含“末日保护程序”不能绕过智能平仓；typed清仓继续按专用路径；clone除indicators1外必要字段保持。 |
| T19 | `tests/main/monitorDisplayRuntime/`、`tests/services/marketMonitor/` | 新指标展示只需策略改投影；host名称/报价/涨跌幅/K线时间来源不变；stop清显示请求。 |
| T20 | `tests/app/`、context tests | prepare/create各一次、引用同一、完整资源先于context；返回后identity失败也destroy一次；配置错误SDK零创建。 |
| T21 | `tests/app/` 装配集成及退出订阅适配 | 断言订阅早于策略/首个业务资源创建；分别挂起资源create、初始rebuild/Quote reconcile/初次时间唤醒，再触发fatal或正常退出；当前调用栈gate/admission已关。释放后晚到资源先登记再唯一cleanup，无后续创建/启动/reopen，已创建strategy恰好destroy一次。正常退出无伪造主错误，退出后才发生的真实创建/恢复内部错误仍保留；正常退出/fatal/启动失败/cleanup失败均释放订阅，清理期间重复信号不启动第二份cleanup。 |
| T22 | termination + queues + processors | 首fatal同步gate/close；重复fatal不覆盖；null/undefined thrown值可区分；单stop失败仍尝试其他；close后零mutation/notify，普通stop/restart可恢复。 |
| T23 | sell/monitor/seat/wakeup tests | 每类producer迟到callback检查entry/route/终态；旧callback不删新项；ACTIVATING任务不要求先ACTIVE；终态processor不重新订阅。 |
| T24 | `tests/main/lifecycle/`、seat cleanup | 同步方向取消在registry mutation返回前完成；另一方向pending保留；跨日同实例reset清样本/指标/pending；rebuild await后fatal不得reopen。 |
| T25 | PostTrade + lifecycle + shutdown 集成 | 挂起positions请求，分别午夜/正常退出/fatal后释放；记录回调完成→PostTrade drain完成→Quote stop完成，之后无旧mutation。 |
| T26 | `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts` | 同一停止周期多次drain全部完成；正常restart后的下一stop仍完成；start前显式Quote reconcile仍可用。 |
| T27 | `tests/main/lifecycle/`、shutdown tests | 午夜外部错误停止后续domain并安排原retry；午夜内部错误fatal；最终cleanup错误继续尝试但不覆盖主错误，不把失败drain记成功。 |
| T28 | recovery/orderMonitor tests | 未匹配BUY：仅请求接受/终态未知、可信零成交安全结算、快照/终态成交冲突、明确外部API失败；断言恢复结果、普通owners启动、退出/retry分类。未匹配SELL仍阻断。 |
| T29 | `tests/architecture/strategyBoundary.test.ts` | 生产宿主仅由prepareStrategy动态加载选中入口；src 公共类型/宿主无私有策略依赖，生产策略之间无私有import/聚合barrel；tools 私有leaf/type直引为正例，services/indicators整个目录不存在；旧owner及静态/生成注册表不存在；宿主无IndicatorIncrementalRuntime，私有实现无旧opaque品牌转换/unwrap包装链。 |
| T30 | architecture + app integration | 临时策略根新增不同schema/私有指标目录，不改任何中心文件即可选择运行；只import选中模块且只create一次；构造/销毁身份正确。不永久增加第二套生产策略。 |
| T31 | `tests/build/productionBuild.test.ts` | 真实 clean + tsc 输出 src JS 和静态 JSON，语义一致；无构建 prepare/create；dist 任意 cwd 且移走 source 后仍加载相邻资产，缺 JSON 拒绝。 |
| T32 | 离线重建集成 | JSON-only、新增静态 JSON 依赖、删除策略 clean 清除旧产物；编译失败 noEmitOnError 无残留 JS。非法 DSL 可编译但选中 prepare 必须失败，不以 build 成功代替启动校验。 |
| T33 | mapping/startup 测试 | 选中 ID 双向映射、实际大小写、保留名、symlink/junction、realpath 边界保持；无未选目录构建校验。 |
| T34 | `tests/app/startup/prepareStrategy.test.ts` | source仅.ts、dist仅.js且目标缺失先失败；非法加载器扩展名、Windows/空格/非根cwd路径正确分类；导出/prepare结果/实例错误和Promise替身失败，传递依赖错误保留cause，无default兼容、路径回退或第二次import。 |

T21 的信号替身必须在订阅时才绑定回调，并验证释放；不能只用测试预先创建、可在订阅前 resolve 的 Promise 掩盖生产晚监听。使用离线信号源和可控资源，不恢复已移除的 watch，也不连接真实 Broker。

T16、T21、T25–T28 必须用可控 Promise/scheduler 和实际结果分类验证；不能只断言 mock 方法“被调用过”。日志字符串相同不代表订单副作用/恢复语义相同。

## 11. 结构检查与验证命令

### 11.1 残留搜索

实施时在 PowerShell 执行；`rg` 未安装时用 `Get-ChildItem -Recurse -File | Select-String` 的等价有界搜索。`rg` 无匹配退出码 1 不是构建失败，但也不单独等于结构验收通过。

```powershell
rg -n "delayedSignalVerifier|indicatorCache|registerDelayedSignalHandlers|onVerified" src tests mock
rg -n "createMultiIndicatorTradingStrategy|DEFAULT_STRATEGY_FACTORY|TradingSignalStrategyFactory|immediateSignals|delayedSignals|IMMEDIATE_BUY|IMMEDIATE_SELL|VERIFIED_BUY|VERIFIED_SELL" src tests mock
rg -n "indicators1|lastMonitorSnapshot|incrementalIndicatorRuntime|verificationIndicatorsBySide|IndicatorUsageProfile|IndicatorSnapshot" src tests mock
rg -n "SIGNAL_BUYCALL|SIGNAL_SELLCALL|SIGNAL_BUYPUT|SIGNAL_SELLPUT|VERIFICATION_DELAY_SECONDS_BUY|VERIFICATION_DELAY_SECONDS_SELL|VERIFICATION_INDICATORS_BUY|VERIFICATION_INDICATORS_SELL" src tests mock tools .env.example README.md
rg -n "IndicatorIncrementalRuntime|indicatorRuntimeStateBrand|toIndicatorIncrementalRuntime|unwrapIndicatorRuntime" src tests mock
rg -n "waitForShutdownSignal|SIGINT|SIGTERM" src/app tests/app
rg -n "isTradingEnabled\s*=\s*true|failFatal|fatalError|drainFatalError|onFatalError" src/app src/main src/core
rg -n "\.(push|scheduleLatest)\(|onTaskAdded|scheduleTimer|reconcilePositionHoldFromCurrentTruth|retain|release" src/main src/app
Test-Path src/services/indicators # 必须为 False；不能仅靠无 import 推断目录删除
rg -n "services/indicators" src tools tests mock # 仅负向结构测试文字可留
rg -n "indicatorHelpers|KDJIndicator|formatSignalConfig" tools/dailyIndicatorAnalysis src tests mock
rg -n "concurrently|dev:watch|build:watch|test:watch|--watch" package.json README.md
```

逐项分类：

- 具体 snapshot/profile 在 src 仅归策略私有实现，直接测试与非生产 tools 的 leaf/type 消费按 §4.2 分类；六数学类型不保留公共源，CandleData 仍中性，不能一刀切字符串删除。
- 旧 env 键只允许“拒绝旧键”逻辑/测试、迁移说明或一次性资料，不允许新运行时读取补值。
- 架构负向测试可以包含旧路径字符串，但生产文件必须不存在，不能为了测试保留生产导出。
- fatalError 名称可在唯一主owner或局部结果容器合理存在；搜索后核对所有权，不因命名命中认定多主fatal。
- 直接部署模板按实际发现文件追加搜索，不扫描无关 docs/tools。

补 bounded import graph/ESLint 测试，生产规则只作用于 src；tools 私有 leaf/type 单独作为正例，不套用生产禁令。检查运行时代码和 `import type`、静态导出及字面量/计算动态 import；只匹配一条 import 字符串不足。`app/startup/prepareStrategy.ts` 是唯一生产宿主动态装配边界，其 importer 由 composition root 注入；相关模块范围内不得在其他宿主位置另开任意策略加载路径。构建不加载 definition；测试fixture作为明确范围处理。受准加载边界单独检查URL构造与导入前路径验证。禁止策略间私有imports/聚合barrel、中央静态/生成清单；结合实际选中模块求值计数验证，不能用静态图无边断言动态隔离已经通过。

增加针对性搜索：`src/config/strategy.ts`、`strategyDefinitions`、`ACTIVE_STRATEGY_ID`、`strategyDefinition`、`import(`、`definition.ts`、`definition.js`。逐项检查运行/构建/测试归属；`SymbolRegistry` 是原有席位状态owner，不能与已删除的策略registry混淆而误删。

### 11.2 实施后的命令顺序

先执行实际存在的相关测试目录。迁移后不要再传已删除的旧 verifier/cache 路径：

```powershell
bun test tests/core/strategy tests/main/businessEventProgram tests/main/monitorDisplayRuntime tests/services/marketMonitor
bun test tests/app tests/main/lifecycle tests/main/seatRuntimeCleanupDispatcher tests/main/timeWakeupEvaluationProgram
bun test tests/main/asyncProgram tests/core/signalProcessor tests/main/recovery tests/core/trader/orderMonitor
```

新增 tools/architecture 测试以最终实际路径执行；完整 `bun test` 必须包含它们。

TypeScript 实施交付的必需检查按规范顺序运行：

```powershell
bun format
bun lint
bun type-check
bun test
bun run build
```

PowerShell 中逐条检查 `$LASTEXITCODE`，失败停止后续“通过”记录并修复。format 会改写仓库，实施者须复核 diff，不能混入无关自动改动。本次纯文档交付不运行该改写命令。

之后执行离线 clean-dist/临时 cwd/JSON-only 重建矩阵；记录命令、退出码、读取的 fixture 标识与构建产物校验结果。严禁用真实下单入口和生产凭据做构建/资产测试。

### 11.3 完成标准

以下全部满足才可宣告重构完成：

- [x] S01–S07 补充验收全部有证据：五实现/六类型迁移与旧目录清零、tools direct leaf/type 正例、仅 src 生产边界、同步 onCandlestick 与原数学/业务对拍；本项已通过，不核销以下原主方案发布门禁。
- [ ] D1–D5 已落实，未新增未获授权的交易政策；新增策略只新增目录，无中央人工/生成登记，构建仅 clean + tsc与启动选中校验均有证据。
- [ ] 单选、一次 read/prepare/create、相同实例引用和唯一 destroy 有运行证据。
- [ ] 指标/采样/pending/timer/验证/显示政策都归策略；宿主无旧所有者或兼容委托链。
- [ ] 动作/时间/两侧配置/SELL事实门禁与执行风险顺序回归通过。
- [ ] origin adapter 白名单与终态/route授权闭合，reason 不授权清仓。
- [ ] 所有异步生产者、reopen、processor restart 与最终 mutation gate 接通终态。
- [ ] 午夜 D2、PostTrade→Quote 排空、重复 drain、fatal/正常退出的提前监听、同步关门、装配/初始恢复收口及监听释放均有受控时序测试。
- [ ] 配置、类型、调用方、导出、mock/tests、直接 tools/docs 连接全部清理；无 re-export。
- [ ] 新模块符合 camelCase、工厂/DI、readonly、types/utils职责、中文注释及常量规则（仅 D1 例外）。
- [ ] format → lint → type-check、全量测试、正式 build、离线资产/重建检查通过。
- [ ] 独立复核无未解决确认问题；部署输入与发布证据完整，或明确保持发布阻塞，不虚报完成。

## 12. 执行记录模板与当前状态

每个工作包使用以下最小记录，不另建复杂流程平台：

```text
工作包：WPx
基线与输入：HEAD / 已确认决策 / fixture 或真实配置来源
修改文件：生产 / 类型 / 测试 / 构建与直接文档
旧调用方到新owner映射：逐项列出
不变量与错误分类：保持项 / 明确纠错项
验证：命令、退出码、关键时序断言
独立复核：确认发现、处理结果、未评估项
阻塞项：缺失事实、失败检查、需要用户决策
状态：未开始 / 进行中 / 完成（不得在失败或部分实施时标完成）
```

**当前状态：** 本轮补充 S01–S07 已完成：A/B/C、独立 review 与 final gates 均通过；这里只核销补充范围，不变更原 WP9 尚未验收的发布事实，不宣称 native 退出问题已修复，也未进行真实 launch。以下原计划状态仅为历史记录，不代表当前 staged 实现完成度，须按实际 HEAD/证据复核并保留已有修改。 D1–D5 已由用户确认，免注册自动加载已纳入最终执行计划及对应设计合同；重点调用链和命名/构建边界已复核。此前旧相关测试54项通过，不代表目标实现通过。本文件是待验收计划；当前分支既有生产代码、JSON、动态加载器、宿主接线、终态队列和构建资产改动的完成度需由实际验证确认，不在 C-docs 阶段宣告完成；开发 watch 已按用户决定从仓库移除（含 `concurrently` 依赖），不再作为交付目标；正式构建/发布仍需真实配置与全部目标验收证据。

## 静态 JSON 与简化构建执行补充（现行合同）

用户已批准替代原 D5 和原文资产合同；上文历史验收记录不构成本轮已撤销保障。

- [x] J01 completed：definition 静态 JSON、同步零参数 prepare、对象精确校验与副本深冻；交易 runtime/hooks/createDeps 不变。
- [x] J02 completed：宿主移除配置内容 I/O，保相邻 metadata、选中隔离、thenable/cause 和 SDK 前失败。
- [x] J03 completed：删除 scripts 构建工具；clean + tsc、noEmitOnError、开发检查仍含 tools/tests/mock。
- [x] J04 completed：更新 fixtures、启动/配置/真实编译重建测试；语义比较而非字节比较。
- [x] J05 completed：README、残留检查、format → lint → type-check → 全 test → build；独立 review 另行进行。

配置源码修改后：dist 必须 rebuild 并 restart；直接源码运行也必须 restart，不提供 hot reload。停机完整部署约束和 WP9 真实发布门禁不变。

### 本轮执行证据（静态 JSON / 简化构建）

- 已执行 format → lint → type-check → 全 test → build，各退出码 0；1902 pass / 0 fail，180 files，6890 expect。相较历史数量减少包含已撤销的重复键原文矩阵及旧脚本专属测试，不将删除的保障假称保留。
- `tests/build/productionBuild.test.ts` 三个真实 src 隔离工程测试通过：package clean + tsc、真实 JSON 语义比较、JSON-only、新增导入、删除策略 clean、坏 DSL/未知 schema 编译成功而选中 prepare 失败、未导入坏 JSON 隔离、源码移走及缺 dist JSON、编译失败 noEmitOnError。启动另有真实 invalid JSON/missing dependency cause 与相邻 JSON 大小写/链接拒绝。
- 实际 dist：260 JS + 1 JSON，均位于 dist/src；无 scripts/tools/tests/mock/declaration/maps。TypeScript 非 declaration 闭包 261 文件，全部 src；JSON 深语义相等，不要求字节相等。
- 残留检查 src/tests/两原计划/README/package/tsconfig：旧配置 URL 字段、配置 read-text 端口、raw-text prepare 和旧脚本路径引用均为 0；构建脚本目录与旧脚本专属测试目录已删除。相邻 config.json metadata 校验仍在。
- 暂存区基线 SHA256：`1bb19ec00e0b6a938d3f277e084b6c87e465f299ce156ade3b8e7d0abb0426c2`，执行后保持一致。非凭据文件基线与门禁日志位于系统临时目录 `strategy-baseline-PmLz49`；全 format 的 13 个无关文件副作用逐字节恢复，原策略 JSON 参数未改。未 stage/reset/checkout/commit，未改 env，未启动实际应用或 SDK context/网络。
- 独立 review 由主代理后续安排；此处 completed 只核销本 writer 实现和门禁，不宣称独立 review、真实发布或 WP9 已完成。
