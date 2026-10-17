# P6 分阶段静态保护网

## 当前门禁

`baseline.stage` 为 **P6**；`src` 与 `tests` 同范围扫描，原 occurrence、计数、cutoff 与 sourcePhysical 截止不变，所有到期债务必须归零。宽契约与旧根目录不得通过重命名、转发或测试目录豁免保活。`numericProbe` 保留历史 `core/trader`、`types/trader` 的真实审计身份；新增测试同时校验原多重集合额度、原截止与当前 `TradeRuntime`/窄能力的金融投影。离线 fixture 的动态加载只允许固定模块 query 隔离，或先经 realpath、source/dist 布局与具名入口校验的测试 loader；不授权任意动态路径。

本轮起点为原始 HEAD `cf54399`、stage P6，已补齐 §14 观测与独立全链路复核，**唯一验证者的五项最终离线门禁通过：3019 pass / 0 fail**。下文 P4.5 的命令、数字、日志及“P5/P6 未执行”均保留为历史时点事实，不替换成本轮结果；当前真实测试索引及本轮证据另见文末。冻结 baseline/unresolved 与 HEAD 哈希一致，未修改或重采；最终文档补证后的两文件 scoped check 交同一验证者执行。本轮不发布、不开门、不连接实盘。

## P4.5 离线验收记录（历史，不作为 P6 完成证明）

`baseline.stage` 为 **P4.5**。截至 P4.5 的能力与物理到期 occurrence 按原冻结记录评估；扫描失败表示源/测试仍有债，定向绿灯不替代最终全量验收。此次仅将 `baseline.json` 顶层 stage 从 P3F 推进为 P4.5，历史 rows/count/cutoff/sourcePhysical* 与全部 allowance 保持原样，不重采 `baseline.json`、`unresolved.json` 或 P0 原始审计数据。单一验证执行者已完成 P4/P4.5 最终离线验收：完整测试 **2881 pass / 0 fail**，九类债务全为 **0**，详见下文与实施计划 §20。P5/P6 未执行且不在本轮范围；本轮不发布、不开门、不连接实盘。

## 保留的检查

- `scanner.ts` / `freeze.test.ts` 使用 TypeScript 模块解析与 checker 检查真实目标、SDK 声明来源、alias、import/type-only/type import/dynamic/require/re-export。SDK import、use、origin、legacy、snapshot 各自按 occurrence **多重集合**冻结，重复调用不能共用一条额度。
- §5.1 层矩阵对生产 `src/*` 独立生效；`tests/application/*` 可装配真实旧协作者，不继承同名生产目录的依赖矩阵，测试 SDK/fixture 和金融门禁不受影响。domain 直接文件/网络/调度模块、真实 ambient fetch/timer 和 logger IO 另作窄能力检查，本地同名纯函数及纯 Logger 类型不因此被禁止。跨旧业务 owner 的值依赖仍消费原阶段额度；函数签名中性不等于获得新 owner 资格。同 owner 的数据函数、SDK-free type query，以及合法 domain/utils/constants 数据能力通过有限类型/实际出口检查，不因函数重命名要求整体 owner 提前迁移；返回业务能力对象的 factory 不据此豁免。非 infra 的真实 SDK-free types/facts 可作为中性类型，不能因此反向依赖旧业务 owner。已有中性 observation 分类保留审计依据，不新增动态白名单。
- 新 infra mapper/port 的 legacy 目标资格只检查实际解析声明、公共返回类型、实际返回结构、嵌套字段和回调。展开直接返回对象、局部 initializer、返回函数和出口调用，拒绝明显的 SDK/any 擦除及返回额外 raw 字段。`unknown` 可用于 JSON/错误输入，但不作为任意中性返回出口；唯一窄例外是完整 mutation 失败结果的原始 `cause` 证据，必须符合 operation/kind/requestAttempted/code/reason 结构约束。实际来源继续核验默认参数、局部别名与实参；享受例外的绑定按 symbol 检查重赋值，参数、局部与 catch 绑定发生重赋值即拒绝，不建立 CFG 或全污点分析。依赖该例外的外部声明调用必须有可检查的中性证据来源，全部实参与接收对象均须安全，不按 built-in 名称放行。不能用 unknown callback 参数掩盖实际传入的 SDK 值。mapper 可接受 adapter 内的 SDK DTO，但不得把 SDK callback 能力带出；不以函数名、文件名或 body hash 批准能力。
- `executionProbe.ts` 保留旧 helper **boolean 构造探针**：实际调用、未被实参替换的 default、静态 factory method、显式 callback 和数组 map。未调用 method/闭包不计构造；production owner 内部执行不在 test fixture 维度递归。递归与参数上下文缓存只保证构造判断不串用，不缓存业务资格。
- HEAD-only helper 冻结仍为 **855 occurrences**，不重采、不改截止。测试可以经 SDK-free port 驱动合法 infra fixture 内部 SDK；原构造 occurrence 仍记录，只在实际跨入 infra fixture 的 seam 公开/实际出口中性且构造位置合法时单独扣除；外围测试装配/观察接口不被当成 SDK seam。caller 目录本身不授予或取消资格；中性 module/owner port 测试与 integration 遵循同一边界检查。纯造值 fixture 是否有必要由行为覆盖及审查判定，不用目录模拟业务场景。`withNativeContext` / `Config` callback 之类公开 SDK 能力不合格，必须先改造真实 fixture。
- P3F 历史收口记录保持不变：当时冻结记录中的 80 个 P3F 前 source files、14 个完整旧 owner roots、镜像目录和 AST import/export 残留均为零。当前继续按原 `sourcePhysicalStage` / `sourcePhysicalDeadline` 检查截至 P4.5 的旧 owner；P5/P6 deferred occurrence（包括 `quoteSubscriptionRuntime` 的 P5 owner）继续保留，不能因 P4.5 绿灯提前关闭。
- `../longbridgeBoundary.test.ts` 不消费历史 allowance，直接要求生产 SDK import/use/origin 仅位于 `infrastructure/longbridge/{trade,market}`；同时拒绝 `SDK_EXPOSURE` 与未通过既有 selected-strategy loader 校验的 `NONLITERAL`。runtime/type-only/dynamic/re-export/require 均有合法 adapter 与非法业务层正反例，变量和无插值模板动态导入不能绕过最终门禁。
- 全仓实际 `TradeContext.new` 创建点必须恰好一个且位于 production trade adapter；不把已迁移的旧 core 路径当不可变业务基线。
- `snapshotProbe.ts` 保留唯一 canonical owner、readonly reader/嵌套事实、能力外泄、第二 writer、cast/Object.assign 等保护；原 snapshot/mirror occurrence 在 P1 到期。
- `numericProbe.ts` / `numericBoundary.test.ts` 保留字段 identity、金融 number/有损投影保护和合法整数/指标边界。投影额度按文件、原函数、表达式逐 occurrence 计数，仅原金融投影可获额度；P1 已闭合字段/投影立即到期，后续金融额度按所属阶段收缩，最迟 P4.5 归零。P2 恢复/持久化原契约的累计金额不允许退回 number 或直接有损投影；revision/时间字段仍为结构 number。`Quote.prevClose` 的真实角色由附加登记补齐，不重写 P0 审计。
- 策略私有身份按 domain/runtime/config/`app/startup/strategyDefinitions` 四根识别；同策略的合法跨根连接仍受层矩阵约束。`strategyDynamicBoundary.test.ts` 执行真实准备器验证 definition/config 分根，入口精确定位为 `src/app/startup/strategyDefinitions/<selected>/definition.ts` 或 `dist/src/app/startup/strategyDefinitions/<selected>/definition.js`，不回退旧 core 路径。
- 非字面量加载只准入两条有限结构连接：runAppDeps 直接向实际声明的 prepareStrategy 注入 `importModule: (href) => import(href)`；真实 loader 的 importStrategyDefinition 使用已声明 StrategyLocation/StrategyFileSystem 参数，经 Node pathToFileURL(location.definitionPath).href 调用 importModule。路径、真实声明及参数 symbol 共同校验，局部同名函数/契约、任意 URL、间接回调或其他 loader 均拒绝；不扩大原 baseline 的动态 occurrence 额度。加载安全仍由真实元信息负例与唯一消费者检查共同验证，不宣称任意数据流证明。

## 明确不做的事

已删除 `semanticNeutral/bodyProof` 全函数解释器、`privateProducerOwnership`、`SdkExecutionEvidence`、全局内建稳定性、时间/同单行来源、循环/累加器、runner/error registry/枚举算法语义证明及专用缓存（包括外部声明 AST/hash 缓存）。同步删除仅为这些证明器语法/缓存服务的 34 组 / 328 个静态 fixture cases；不删除业务测试。当时原 helper boolean 46、numeric 30、strategy 8 个 cases 全保留；这些是历史保留数量，不是当前测试总数，后续字段闭合与有限能力检查正反例另计。

门禁不证明任意跨函数 taint、金融计算正确性、safe-int 全链路、真实时间来源、同单 row 身份、场景真实性或完整恢复。真实金融数值、时间、同单行和 adapter 行为由现有 adapter 行为测试与代码审查负责；独立金融/snapshot 门禁继续生效。有限返回结构检查不是执行解释器，不为每种控制流追加证明规则。

失败输出按维度列计数与少量 occurrence 示例；完整结果可由 scanner 返回值离线汇总，避免打印整段 fixture/数百 KB 日志。

## P4.5 离线验证（历史命令与结果）

以下命令、stage 描述和结果为 P4/P4.5 历史记录，不代表当前 P6 或本轮新增观测已运行通过。

以显式干净进程环境执行，禁止读取 `.env`、凭证、真实交易日志或求值静态 fixture 中的 SDK；不启动 app、不联网。

```text
bun --no-env-file node_modules/prettier/bin/prettier.cjs --check tests/architecture/refactoring/scanner.ts tests/architecture/refactoring/freeze.test.ts tests/architecture/longbridgeBoundary.test.ts tests/architecture/refactoring/README.md
bun --no-env-file node_modules/eslint/bin/eslint.js tests/architecture/refactoring/scanner.ts tests/architecture/refactoring/freeze.test.ts tests/architecture/longbridgeBoundary.test.ts
bun --no-env-file node_modules/typescript/bin/tsc -p tsconfig.json --pretty false
bun --no-env-file test tests/architecture/refactoring/freeze.test.ts tests/architecture/longbridgeBoundary.test.ts
bun --no-env-file test tests/architecture/refactoring tests/architecture/longbridgeBoundary.test.ts tests/infrastructure/longbridge/trade/decimal.contract.test.ts tests/infrastructure/longbridge/trade/tradeContext.contract.test.ts tests/infrastructure/longbridge/trade/getHistoryOrders.business.test.ts
```

`freeze.test.ts` 在当前 P4.5 stage 下覆盖九类债务：imports、uses、origins、legacy、owners、snapshot、snapshotExposures、violations、helperCalls；均须为零，不能仅以 fixture 正反例通过代替真实源码扫描。上列命令直接使用仓库已有工具入口与实际测试路径，静态检查不重采 baseline。

准备期间只执行 scoped format/lint，不冒充最终验收。全部 owner 停写后，唯一验收执行者已使用 Bun 1.4.2 串行完成：

| 实际命令（顺序） | 退出码 | 结果 |
| --- | --- | --- |
| `bun --no-env-file run format` | 0 | 73.350s；无关文档的本轮排版增量按运行前副本精确撤回 |
| `bun --no-env-file run lint` | 0 | 58.084s |
| `bun --no-env-file run type-check` | 0 | 5.933s |
| `bun --no-env-file run build` | 0 | 2.585s；未启动产物 |
| `bun --no-env-file run test`（首轮） | 1 | 255.642s；2880 pass / 1 fail，唯一失败为 launcher 显式日志根与默认 `tests/logs` 断言冲突 |
| `bun --no-env-file run test`（完整复跑） | 0 | 253.533s；2881 pass / 0 fail，285 files，17464 expect() calls |

复跑仅从验证子进程环境移除 `APP_LOG_ROOT_DIR`，让既有 preload 使用默认 `tests/logs`；保留 `tests/setup/childEnv.ts` 的凭据隔离白名单、独立 HOME/TEMP、显式 `--no-env-file` 与 `BUN_OPTIONS=--no-env-file`。临时 `.env` canary 已验证嵌套 Bun 不自动加载环境文件。没有修改测试断言、业务源码、业务 `.env` 或放宽 baseline；四个已通过门禁不重复启动。`testRuntime.ts` 的既有 offline SDK guard 拒绝 `TradeContext.new`、`QuoteContext.new`、`OAuth.build`，保留离线 Decimal/枚举/Config 契约；这不是 OS 防火墙或通用网络隔离保证。本轮未启动 app/start/dev、未建立真实 SDK 会话、未使用真实凭据或生产交易日志。

复核结论：九类债务均为 0；最终 Longbridge 门禁及 canonical snapshot/ledger/settlement owner 回归通过；47 个冻结 P4 到期源文件及旧入口 AST 引用零残留。`baseline.json` 对 HEAD 的逐字节比较仅顶层 `P3F → P4.5`，`unresolved.json` 无差异，历史 allowance/rows/count/cutoff/sourcePhysical* 与 HEAD-only helper 855 occurrences 不重采。P1 before、P2/P3F 验收记录和历史删除统计不改写成 P4 结果。

§13.4.2 精度矩阵的输入/配置、安全整数、数量/预算、比率阈值、累计金额/日损益、progress/baseline、V1 durable、指标与金融显示行为，以及 mock/脱敏 fixtures 的完整 loader/rebuild、crash-gap、冷却和冲突阻断，均纳入本轮完整测试；迁移后测试路径与逐项证据见[实施计划 §20](../../../docs/architecture/architecture-refactoring-implementation-plan.md#20-p4-实现记录p45-最终离线验证通过)。**这不等于真实历史 V1＋权威订单逐条对账，也不等于精度迁移后候选版/指定回退版完整恢复**；两项仍为未来生产发布阻断门禁。P5/P6 的 lifecycle/rebuild、最终目录及宽契约清理未执行。

文档补证后，`bun --no-env-file node_modules/prettier/bin/prettier.cjs --check docs/architecture/architecture-refactoring-implementation-plan.md tests/architecture/refactoring/README.md` 与 `git diff --check` 均 exit 0，日志为 `09-doc-format-check.log`、`10-diff-check.log`。

本机临时日志位于 `C:/WINDOWS/TEMP/p4-final-verification-3IJh3L/`：`01-format` 至 `05-test` 保留首轮 `.log/.result.json`，`06-test-default-log-root.log/.result.json` 保留完整复跑，`07-debts.log` 保留九类汇总；这些临时文件不是仓库长期审计归档。

## P6 后剩余工作与当前验收边界

本轮唯一交付文档为本 README 与[实施计划](../../../docs/architecture/architecture-refactoring-implementation-plan.md)。P0–P4/P4.5 历史事实保持原义，P5/P6 现有实现与当前 stage 按当前源码、测试和本轮最终证据核对，不用改写历史“未执行”掩盖阶段差异。

### 已确认观测口径（已补审并通过离线动态验证）

- 复用现有 logger 的结构化事件供聚合，不新增 exporter、指标服务、额外 timer 或第二业务 owner；诊断失败不得覆盖主体错误或改变业务结果。
- snapshot 按实际已发 batch 统计，保留实际来源 `sources` 集合；同时旧 epoch / generation 时 epoch 优先，只计一次丢弃；participant superseded 后重新入队，累计各段 pending 等待，不混入 IO 时长。
- settlement 连续 stale 从首次起计，包含重试等待；滞后是未 ready 耗时及 readiness receipt 消费 token 与当前 snapshot token 是否不同，不对 commitRevision / settlementVersion 等不同序列作减法。
- terminal 在首次权威确认时记录；首个先到 ACK 仅配对一次，无 ACK 或 terminal 先到不造 duration。
- activation 按完整 ACTIVATING → ACTIVE/退出周期计时，包含重试等待；retain/release 阶段分别记录，不把 ACTIVE 后 release 混入激活完成耗时。
- 覆盖 BUY、SELL、MONITOR 三队列，以及 startup/open rebuilt 和原开盘重试边界；单次 snapshot commit、开始或重试中间态不冒充完整 rebuilt。

完整口径与非干扰约束见实施计划 §14。原独立 `fullchain-coverage-review` 的结论仍为关键链无已证实缺陷，且**未覆盖当时并行观测、未动态运行**；不倒改其范围。本轮另完成 snapshot、settlement、order、seat/queue/lifecycle、diagnostics wiring 五组独立补审：snapshot 的唯一 sources 集合去重 finding 已修并复核关闭，其余未发现已确认缺陷。动态通过另由唯一验证者完整执行证明，不以 review 代替。

### §13 / §17 当前真实测试索引

下列实际职责镜像已纳入唯一验证者通过的本轮完整测试；逐条矩阵与当前观测断言见实施计划 §13.7，历史精度证据仍保留于 §20.1，实际执行依据统一见 §21。旧阶段列出的来源路径/建议文件名不按当前可执行命令使用，也不把历史数字改写成本轮结果。

| 条款 | 当前职责镜像入口 |
| --- | --- |
| §13.2 / §17.1 snapshot 与消费覆盖 | `tests/application/accountPositionSnapshot/{index,componentAuthorization}.test.ts`；`tests/integration/accountPositionConsistency/{orderEconomicCoverage,accountAwaitReplay,settlementSourceRegistration,sealedBoundarySettlementAdmission}.test.ts`。 |
| §13.3 / §17.2 readiness、派生防旧写与 completion | `tests/application/postTradeSettlement/{postTradeSettlement.business,postTradeSettlement.concurrency,readinessGate}.test.ts`；`tests/integration/postTradeSettlementOwner.integration.test.ts`。 |
| §13.4 / §17.3 mutation、query/push/recovery | `tests/infrastructure/longbridge/trade/{tradeMutationAdapter,orderFactMapper}.test.ts`；`tests/application/orderExecution/submitFlow.errorClassification.business.test.ts`；`tests/application/orderTracking/orderMonitor/{orderOps.business,recoveryFlow.business,terminalSnapshotFacts.business,openStateAmountRevision.business}.test.ts`。 |
| §13.4.1 / §17.3 目的隔离 | `tests/integration/{staticSellProtectiveIsolation,sharedSellProtectiveIsolation}.integration.test.ts`；`tests/application/orderExecution/finalQuoteMutationPermit.business.test.ts`。 |
| §13.4.2 / §17.3、§17.5 金融/V1/离线恢复 | §20.1 原精度矩阵；`tests/integration/architectureRefactoringRecovery/recovery.integration.test.ts`；`tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts`；`tests/application/postTradeSettlement/postTradeSettlement.financial.test.ts`。 |
| §13.5 / §17.3 activation 与 startup/open rebuild | `tests/application/seatActivation/{orderReadFence.business,seatRefreshCatchUp.business,seatRefreshRelease.business,rebuiltSeats}.test.ts`；`tests/application/tradingDayRebuild/{startupRebuild,openRebuild}.test.ts`；`tests/integration/{seatRefreshDayEpoch,startupSettlementReadiness,rebuildSettlementReadiness,strategyRecoveryStartup}.integration.test.ts`。 |
| §13.5 / §17.4 lifecycle、cleanup、self-drain | `tests/app/lifecycle/{lifecycleChecklist,lifecycleChecklist.wiring}.test.ts`；`tests/runtime/lifecycle/dayLifecycleManager.test.ts`；`tests/runtime/lifecycle/cacheDomains/signalRuntimeTermination.test.ts`；`tests/app/shutdown/createCleanup.business.test.ts`；`tests/app/runAppTerminationMatrix.business.test.ts`；`tests/integration/postTradeDrainLifecycle.integration.test.ts`。 |
| §17.3 / §17.5 交易、策略、寻标、换标与末日 | `tests/integration/{buyFlow,sellFlow,protectiveLiquidation,doomsday,singleActiveStrategyExecution,periodicAutoSymbolChain,autoSearchPolicyConsistency,terminalSwitchFinalization}.integration.test.ts`；`tests/runtime/timeWakeupEvaluationProgram/business.test.ts`。 |
| §13.6 / §17.4 静态边界与 P6 截止债务 | `tests/architecture/refactoring/{freeze,helperExecution,numericBoundary,strategyDynamicBoundary}.test.ts`；`tests/architecture/{longbridgeBoundary,importBoundary,typeOrganization}.test.ts`；本节门禁不替代业务行为验证。 |
| §14 / §17.6 logger / snapshot | `tests/infrastructure/diagnostics/index.test.ts`；`tests/application/accountPositionSnapshot/observability.test.ts`；真实 batch、sources 集合、epoch 优先、participant 累计 pending、IO settled 与失败非干扰。 |
| §14 / §17.6 settlement / order | `tests/application/postTradeSettlement/{readinessGate,protectionRecovery}.test.ts`；`tests/application/orderTracking/orderMonitor/orderObservation.business.test.ts`；`tests/integration/architectureRefactoringP1Native/trade/nativeSubmitObservation.test.ts`；连续 stale/token、同步 completion、首次权威 terminal/ACK 与原错误身份。 |
| §14 / §17.6 seat / queue / lifecycle | `tests/runtime/seatDiagnosticRuntime/business.test.ts`；`tests/application/seatActivation/seatRefreshRelease.business.test.ts`；`tests/runtime/asyncProgram/{tradeTaskQueue,monitorTaskQueue}/diagnostics.test.ts`；`tests/application/tradingDayRebuild/startupRebuild.test.ts`；`tests/runtime/lifecycle/dayLifecycleDiagnostics.test.ts`；完整 activation、retain/release、三队列和实际 startup/open rebuilt / 原重试。 |

### 本轮最终离线验收证据（五项门禁通过）

已读取并核实唯一验证者 `offline-final-verifier` 的 `FINAL-VALIDATION-REPORT.md` 与 `architecture-evidence.json`。证据根为 `C:/WINDOWS/TEMP/hsi-p6-final-validation-20261016-180854/`；原始 HEAD `cf543994945b8351d2ce5e848ab3a2159ce0af9c`，Bun 1.4.2，所有实现/文档 owner 显式停写后各门禁仅串行执行一次，无失败复跑：

| 顺序 | 实际命令                           | 退出码 | Wall 耗时 |
| ---- | ---------------------------------- | ------ | --------- |
| 1    | `bun --no-env-file run format`     | 0      | 79.631s   |
| 2    | `bun --no-env-file run lint`       | 0      | 64.639s   |
| 3    | `bun --no-env-file run type-check` | 0      | 6.396s    |
| 4    | `bun --no-env-file run test`       | 0      | 268.934s  |
| 5    | `bun --no-env-file run build`      | 0      | 3.096s    |

完整顶层测试为 **3019 pass / 0 fail，311 files，18455 expect() calls**，Bun 测试时长 268.50s；嵌套 fixture 数字不累加或替代顶层汇总。精确命令/参数/时间/退出码见 `summaries/*.json`，直接写入的 stdout/stderr 见 `raw/`；逐项原始日志路径和安全边界见实施计划 §21。

| 闭合项 | 已核实证据 |
| --- | --- |
| §14 观测与非干扰 | 新增独立补审已完成，sources 去重 finding 已关闭；真实 owner 的当前断言通过，不再借旧 fullchain review 证明并行改动。 |
| format 精确快照 | format 前复制 815 files / 18,365,055 bytes，覆盖 tracked 与非忽略 untracked，停写工作树共 175 个修改/新增文件；环境文件、凭据、日志不读取。Prettier write＋ESLint fix 的 `format-delta.json` 为 0 byte 变化、0 个需还原文件；五门禁/scan 后、最终文档补证前的 815 文件仍与快照相同，Git status 未变。 |
| P6 九类债务与最终边界 | 只读 scanner 覆盖 750 source/test TS，imports / uses / origins / legacy / owners / snapshot / snapshotExposures / violations / helperCalls 全为 0；完整测试中最终 Longbridge runtime/type/dynamic/NONLITERAL 边界通过，唯一观察到的 TradeContext source 为 `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts`。 |
| 冻结与物理残留 | stage 仍为 P6，baseline/unresolved 的初始快照、门禁后 current 与 HEAD SHA-256 一致，原 occurrence/额度/截止未改未重采；178 个冻结到期旧源路径及直接镜像均无残留，`src/{core,main,services}` / `tests/{core,main,services}` 六个旧根物理不存在。 |
| 离线环境 | 系统变量白名单＋隔离 HOME/TEMP 等目录，所有 Bun 使用 `--no-env-file` 且保留 `BUN_OPTIONS=--no-env-file`；launcher 无 `APP_LOG_ROOT_DIR`，使用 preload 默认 `tests/logs`。既有 SDK guard 拒绝 `TradeContext.new` / `QuoteContext.new` / `OAuth.build`，不是 OS 网络隔离；未启动 app/start/dev、构建产物或真实 SDK 会话，未读业务 `.env`、生产日志或真实凭据。 |
| §17 收口 | 离线项按当前证据闭合；未来生产阻断保留未勾选。本轮补齐 P0–P6 剩余离线任务，不虚构 P7，不改写历史 P4.5 数字或历史 P5/P6 未执行事实。 |
| 最终文档检查 | 门禁后、最终补证前的 `git diff --check` 已 exit 0；本次补证后交同一唯一验证者仅执行两文件 scoped prettier check 与 `git diff --check`，此处不提前宣称后续结果，不无故重跑全量门禁。 |

本机临时证据根保留原始执行依据，但不是仓库长期审计归档。最终文档 owner 停写后交验证者执行：

```text
bun --no-env-file node_modules/prettier/bin/prettier.cjs --check docs/architecture/architecture-refactoring-implementation-plan.md tests/architecture/refactoring/README.md
git diff --check
```

**离线实施与最终门禁已通过，不等于生产发布许可。未来生产发布阻断仍未验证：**真实原始 V1＋权威订单逐条对账，以及精度迁移后候选版/指定回退版完整恢复。mock/脱敏 fixtures、静态 review、完整离线测试或 V1 schema 可读均不替代这两项；本轮不发布、不开门、不连接实盘。
