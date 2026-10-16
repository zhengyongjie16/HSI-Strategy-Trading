# P6 分阶段静态保护网

## 当前门禁

`baseline.stage` 为 **P6**；`src` 与 `tests` 同范围扫描，原 occurrence、计数、cutoff 与 sourcePhysical 截止不变，所有到期债务必须归零。宽契约与旧根目录不得通过重命名、转发或测试目录豁免保活。`numericProbe` 保留历史 `core/trader`、`types/trader` 的真实审计身份；新增测试同时校验原多重集合额度、原截止与当前 `TradeRuntime`/窄能力的金融投影。离线 fixture 的动态加载只允许固定模块 query 隔离，或先经 realpath、source/dist 布局与具名入口校验的测试 loader；不授权任意动态路径。

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

## 离线验证

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
