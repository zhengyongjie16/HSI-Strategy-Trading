# 架构审计：独立离线验证与测试业务保护对比

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

## summary

- **verdict：两版有效 typecheck、只读 lint、全量测试均通过；不能据此声称全量行为等价。** 已独立复现保护边界准入、冷却恢复等业务结果差分，并确认部分旧测试被反向 oracle 替换；这些候选尚未收到另一代理二次复核结论，**不列为最终缺陷**。
- **固定行为基线：** `develop = origin/develop = FETCH_HEAD = 6e239c8a128372bd9b2fb2d79464346792a5e81e`。本代理先用本地同 SHA 导出，后收到协调代理 fetch 成功确认；不存在中途改换基线。目标 `beta-V2 HEAD = 2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；重点历史提交 `d2aa59054abac546f506b27df45f161afcfc6578`，其父为 `90773316ed38b413d8ac4437e9bbe18414da7d4a`。
- **scope：** 安全验证启动器、两版 package/config/test preload 与嵌套进程隔离、两版完整 typecheck/lint/test、测试声明/断言变更索引、关键业务 oracle 对比、TEMP 差分复现。生产源码仅为核实这些测试语义而定向深读；不接管其余六组代码链路审计。§7 列出逐文件实际阅读级别与未深入部分。
- **confidence：** 有效命令结果、固定 SHA、离线隔离、四项已运行差分 high；业务差分能否作为用户无漂移要求下的最终缺陷 medium，须 G4/G5/G3 二审与跨链归并；全仓等价性 not assessed。
- **实际本地运行配置：** 通过本代理工具进程祖先链读取，`node.exe PID 42396` 显式 `--provider cliproxyapi --model gpt-6.1-sol --thinking max`。证据 `validation/model-runtime-flags.json`。环境变量本身未提供 model/thinking；不使用全局默认值冒充实际配置，也不声称已验证代理服务后台真实路由。
- 已读四项技能 `code-review` / `typescript-project-specifications` / `core-program-business-logic` / `lazy-senior-developer`，另读 context-mode、根 AGENTS 和用户指定实施计划的相关验证/冻结章节。**技能、当前方案和新测试都不能覆盖 develop 行为真值；已有错误约束的历史来源与修复授权必须分别判断。**

## critical issues

None. 本验证分工尚无完成第二独立复核的最终 critical finding；这不是认定候选无风险。

## major issues

None as finalized. 下列 §4 候选已有可运行证据或明确旧新 oracle 对照，待相应链路代理二次复核，不以本报告单方面定性。

## minor issues

None. 不报告纯覆盖率、风格或单纯断言数量意见。

## 1. 安全前置检查及执行边界

### 1.1 先读取 scripts，未执行写代码命令

两版 `package.json` 的对应脚本相同：

```text
type-check = tsc -p tsconfig.json
lint       = eslint .
test       = bun test
build      = bun run clean && tsc -p tsconfig.build.json
start      = bun src/index.ts
dev        = cross-env RUN_MODE=dev bun start
lint:fix   = eslint . --fix
format     = prettier --write . && eslint . --fix
```

只执行前三项的只读/测试验证；**没有执行仓库 format、lint:fix、build、clean、start、dev，也没有启动构建产物**。全量测试自带的 productionBuild 用例在其 TEMP fixture 内运行构建/移动 fixture 源码，不是在原仓库构建或移动源文件；已先读 `tests/build/productionBuild.test.ts:377-401,500-624` 确认。

`tsconfig.json` 为 `noEmit: true`，包含 src/tools/tests/mock，严格类型选项开启。未进行依赖安装、升级或 lockfile 改写。

### 1.2 两版 Git 导出副本与依赖

- 当前工作目录：`validation/current/`，`git archive` 精确导出当前 SHA，823 tracked 文件。
- 旧版工作目录：`validation/develop-baseline/`，同方式导出固定 develop SHA，525 tracked 文件。
- 原仓库仅作为 Git 对象及既有 `node_modules` 来源；TEMP 内创建 junction，**不复制 `.env.local`、凭据、生产日志或原工作区忽略文件**。没有读取业务 `.env.local` 内容。
- 共用已安装依赖：Bun **1.4.2**、Node **24.20.0**、TypeScript **6.0.3**、ESLint **10.8.0**、typescript-eslint **8.65.0**、longbridge **4.4.3**、dotenv **17.4.2**、pino **10.3.1**；当前新增 bignumber.js **9.3.1**。基线依赖与当前重叠部分版本一致；旧版使用当前已安装包集合的超集，不声称重新 lockfile 安装的干净依赖复现实验。
- tracked 导出文件的逐文件 SHA-256 在执行前后相同：current 823/823 未变，baseline 525/525 未变。证据 `*-manifest-before.json`、`*-manifest-after.json`、`current-mutation-check.json`、`develop-baseline-mutation-check-corrected.json`。
- 原工作树前后 `git status --porcelain=v1` 均为空，最终 `git diff --check` exit 0。未 checkout/reset/merge；未修改任何仓库生产源码、测试、配置、文档。

### 1.3 不读凭据、不连接真实 SDK 的离线环境

- 仅继承 `SystemRoot/WINDIR/PATHEXT/ComSpec/NUMBER_OF_PROCESSORS/PATH`；HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG_CONFIG_HOME、XDG_CACHE_HOME、TEMP/TMP/TMPDIR 都指向本证据目录下隔离根。
- 显式 `NODE_ENV=test`、`APP_RUNTIME_PROFILE=test`、`APP_ENABLE_PROCESS_HOOKS=false`；不继承凭据、代理设置、DEBUG 或原运行时注入参数。
- Bun 入口使用 `--no-env-file`，有效环境的 `BUN_OPTIONS=--no-env-file`。不设置 `APP_LOG_ROOT_DIR`，让测试 preload 默认指向**TEMP 副本的** `tests/logs`，避免破坏 `tests/config/runtime/runtime.business.test.ts:19` 的既有默认值断言。
- 当前 `tests/setup/testRuntime.ts:10` 首先加载 `tests/infrastructure/longbridge/trade/offlineSdkGuard.ts`；guard 用 `mock.module` 同时保护具名/default 导出，拒绝 `TradeContext.new`、`QuoteContext.new`、`OAuth.build`；`mock.restore()` 不恢复原生网络工厂。
- develop 本来没有 guard；仅对旧测试进程显式 preload 当前 guard 的 TEMP 精确副本 `validation-offline-sdk-guard.ts`，不改旧文件。保留原生 Decimal/枚举，阻断会话工厂。旧版因此是在额外安全启动器下验证，不冒称逐字节相同的进程环境。
- 先检查所有可见测试子进程入口，当前 build/history/logger/numeric 使用 `--no-env-file` 与隔离 env，history/index/tools 的 dotenv 用 mock；cleanup 子进程只读 cleanup/logger。旧版 process/network 边界扫描未发现生产测试调用 todayExecutions，实际 native 工厂通过测试 mocks/外部 guard 阻断。
- **限制：SDK factory/session 阻断不是 OS 网络隔离，也不是独立网络抓包证据。** 没有启动实盘 app、OAuth 会话或 SDK 网络工厂；没有进行真实交易/行情/账户 API 请求。

## 2. 有效命令、退出码、数量与耗时

所有命令在下表 cwd 的 TEMP 导出副本串行执行；耗时为 wall clock。current 与 baseline 不并发跑门禁。原始 stdout/stderr 与 JSON 元数据保留，没有只截取绿色总计。

| 版本 / cwd | 实际有效命令 | exit | Wall | 有效数量 / 输出 | 元数据（相对证据根） |
| --- | --- | --: | --: | --- | --- |
| current | `bun --no-env-file run type-check` | 0 | **7.682s** | `tsc -p tsconfig.json`，0 TS diagnostics | `validation/current-type-check.json` |
| current | `bun --no-env-file run lint` | 0 | **92.477s** | `eslint .`，0 lint diagnostics | `validation/current-lint.json` |
| current | `bun --no-env-file run test` | 0 | **305.161s** | **3288 pass / 0 fail；317 files；19669 expect() calls**；Bun 304.69s | `validation/current-test.json` |
| develop-baseline | `bun --no-env-file run type-check` | 0 | **4.926s** | `tsc -p tsconfig.json`，0 TS diagnostics | `validation/develop-baseline-type-check-corrected.json` |
| develop-baseline | `bun --no-env-file run lint` | 0 | **56.187s** | `eslint .`，0 lint diagnostics | `validation/develop-baseline-lint-corrected.json` |
| develop-baseline | `bun --no-env-file test --preload <TEMP>/validation-offline-sdk-guard.ts` | 0 | **54.733s** | **1992 pass / 0 fail；187 files；7638 expect() calls**；Bun 54.53s | `validation/develop-baseline-test-corrected.json` |
| TEMP 差分（首个有效修正版） | `bun --no-env-file test --preload <TEMP>/validation-offline-sdk-guard.ts <TEMP>/behavior-probe.test.ts` | 0 | **0.106s** | 3 pass / 0 fail / 12 expect；Bun 62ms | `validation/behavior-probe-corrected.json` |
| TEMP 差分（新增冷却场景后） | 同上，扩展至4项 | 0 | **0.109s** | **4 pass / 0 fail / 16 expect**；Bun 65ms | `validation/behavior-probe-extended.json` |
| 原工作树只读检查 | `git diff --check` | 0 | 0.066s | 无输出 | `validation/final-readonly-checks.json` |
| 原工作树只读检查 | `git status --porcelain=v1` | 0 | 0.062s | 空，工作区干净 | 同上 |
| 原工作树 refs | `git rev-parse HEAD develop origin/develop FETCH_HEAD` | 0 | 0.044s | 与冻结 SHA 完全一致 | 同上 |

`<TEMP>` 统一表示 `C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020`。

**不得误加嵌套总数：** current stderr 先出现精确数值子进程 `10 pass / 0 fail / 4089 expect / 1 file`，后出现最终顶层 **3288/0/19669/317**；上表只取最终顶层，不把嵌套10再加上去。`exact.test.ts:337-380` 的父测试还断言子进程 exit、10/0 与最少4089断言。

**日志中的 error 不等于失败用例：** current stderr 的 `first retention unlink failed`、`second retention unlink failed` 来自 `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts:685,689` 的故障注入；相应 `keeps durable appends usable across partial retention cleanup failures` 用例通过。最终 `(fail)` 数为0，不能把这些预期日志误报为门禁失败。

### 2.1 无效尝试、失败与纠正，全部保留

1. **旧版首轮3次 exit0 是空跑，已排除。** `validation-runner.cjs` 首次给旧版 `BUN_OPTIONS` 拼入 `--preload` 后，`bun --no-env-file run <script>` 仅打印 `Usage: bun run` 并退出0，没有执行脚本：typecheck 0.068s、lint 0.066s、test 0.059s。原文件 `develop-baseline-{type-check,lint,test}.{json,stdout.log,stderr.log}` 保留，但绝不算通过。用 `validation-supplement.cjs` 将 `BUN_OPTIONS` 降回 `--no-env-file`，测试显式 CLI preload 后才取得上表有效结果。原异常解释在 `validation/baseline-initial-attempt-invalid.json`。
2. **差分探针首跑 exit1，2 pass / 1 fail / 12 expect，0.177s。** 业务断言已完成，但日志追加调用了当前 owner 已移除的 `getExecutionTimeEvidence`，导致探针自身 TypeError。仅在 TEMP 删除这一诊断调用，再跑3/3有效；后因审到新的冷却场景才扩展4/4。原首跑日志保留，不冒称产品失败，也不隐藏失败。
3. 测试索引脚本首轮使用 shell PATH 下 GNU tar，Windows `C:` 路径被当作远端，tar exit128 / Node脚本exit1。改用 `C:/Windows/System32/tar.exe` 并判断导出完整性后，索引脚本exit0。只涉及 TEMP 导出，无仓库改写。
4. 后台工具1秒超时只是 detach，实际命令由长期 runner 完整执行并落盘；不把工具轮询timeout当作测试timeout或杀进程结果。

## 3. 测试覆盖对比方法：对比业务保护，不做纯覆盖率意见

### 3.1 可复查索引

TEMP `compare-test-contracts.cjs` 用 TypeScript AST 遍历 test/it/describe，记录标题、文件行、inline expect语法数、去空白callback哈希，产出 `test-comparison/*-inventory.json`、`develop-to-head.{json,md}`、`focus-to-head.{json,md}`。

| 静态测试声明视角                 | develop → HEAD | d2aa590父提交 → HEAD |
| -------------------------------- | -------------: | -------------------: |
| 旧版静态 test/it declarations    |           1688 |                 2381 |
| 当前静态 declarations            |           2458 |                 2458 |
| 标题匹配的旧声明                 |           1489 |                 2316 |
| 未匹配旧标题（删除或重命名候选） |            199 |                   65 |
| 新增/重命名标题                  |            969 |                  142 |
| 匹配且callback去空白哈希相同     |            323 |                 2071 |
| 同名但inline expect语法数更少    |             58 |                   58 |

这些都**不是行为等价或覆盖率**：each/循环会展开，helper中的断言不会计入调用点；同名并不代表语义相同；旧新标题不匹配不等于删失保护。develop匹配中有4项同名歧义，未自动认定映射。

额外 AST 遍历206个旧测试源码文件与388个当前测试源码文件，未发现 `it/test/describe.skip/todo/only` 调用；只证明可见标准API未跳过，不排除动态条件注册。证据 `test-comparison/skip-todo-only-check.json`。

### 3.2 计数下降但未构成保护删失的实证

- **部分成交后取消/拒绝：** 旧两项各7个inline expect，当前调用点各0个，实际共享 `assertSellPartialFillSettlesOnce`（`tests/application/orderTracking/orderMonitor/orderMonitor.business.test.ts:4180-4302`）仍断言单次经济卖出、关联BUY-1、三次原始事实/水位、本地成本120/100、pending释放、hold关闭、snapshot generation不重复与termination未触发。不能机械报“7→0删光断言”。
- **PendingCancel/WaitToCancel不重复撤单：** 当前同文件 `:1320-1404` 把重复场景移入helper，仍断言native cancel始终1、detail0与无执行事实。零inline断言不是零验证。
- **指标rounding：** 旧 `tests/core/strategy/intradayRegression/runtime/incremental.business.test.ts:189-220` 在 `toEqual(fullSnapshot)` 后逐字段再断言；当前 `tests/strategies/intradayRegression/indicators/incremental.business.test.ts:187-209` 保留完整 `toEqual`、删除重复字段断言。未以9→2报告保护减弱；但该oracle两边都调用当前全量指标实现，本身不是旧版独立金样。
- **post-trade drain/rebuild：** 旧两个标题未匹配，当前 `tests/application/postTradeSettlement/postTradeSettlement.business.test.ts:1397-1440` 保留invalid baseline不清pending、显式rebuild后fresh；`postTradeSettlement.concurrency.test.ts:272-330` 保留真实issued sibling IO完成前drain不返回。仅做职责镜像核对，不声称整个新snapshot/subscription链已证明等价。

### 3.3 历史execution ledger测试的删除不能直接认定为丢保护

`2b67d36` 删除 `executionLedgerAdapter.test.ts`、`naturalExecutionIngress.test.ts`、`neutralOrderQuery.test.ts`、旧 `domain/order/orderEconomics.test.ts` 等独立execution-ledger测试，也把todayExecutions mock能力移除。**develop真实eventFlow/state-check本来把order updatedAt作为本地账务时间，并无todayExecutions驱动启动。** 因此，删掉重构中间态新增的ledger契约可能是在恢复旧来源，不能拿其数量指控回归。

当前 `tests/infrastructure/longbridge/trade/orderFactMapper.test.ts:32-47,156-239` 明确断言SDK高精度原文、`executionTimeMs=updatedAtMs`、query/detail/push一致、非HK在严格映射前过滤；旧时间约束历史根因见 §5。是否覆盖全部原生来源/异常/恢复，仍由G4/G6审计。

## 4. 已独立自查的候选与二审请求（不是最终缺陷）

详细交接在 `validation-peer-review-request.md`。截至本报告写入，未收到另一代理二审结论；以下 **confirmed指可复现的差分/测试变化，不指已确认生产缺陷**。

### V-C1：已封存保护边界前同量高revision，旧抑制被改成权威准入/durable

- **claim：** 当前测试已不再保护develop“completed boundary前同量修订不改变权威事实、不触发durable”的语义，反而要求相反结果。
- **evidence：** `develop:src/core/riskController/dailyLossTracker.ts:975-977` 在 `lastExecutionTimeMs <= currentBoundary` 时、durable callback之前返回false/false。`current:src/domain/risk/dailyLossTracker.ts:882-951` 不再有此阻断，`:928-949` 构建candidate、调用durable并发布事实；`:191-196` 仅在daily经济投影上过滤边界前事实。
- **测试变化：** `tests/domain/risk/dailyLossExecutionBoundary.test.ts:20-52` 的 `SUPPRESSED/false/durable=0` 改为 `ADMITTED/true/durable=1`；`tests/application/orderTracking/recorder/executionFactBoundary.business.test.ts:121-154` 改为recorder成本更新与stale新增；`tests/application/orderTracking/orderMonitor/settlementFlow.business.test.ts:759-913` 把45→46修订从O/durable/H/stale不变改为保留权威/落盘/刷新。该反向oracle变更落在重点 `2b67d36`。
- **independent validation：** TEMP probe第一项直接导入两版真实DailyLoss，BUY100 price1，T时封存，再T+30000同量price1.1：旧`false/false,durable0`；新`ADMITTED,true/false,durable1`，两版loss都0。故“daily loss没变/全绿”不能证明该准入等价。
- **runtime path：** 当前settlementFlow `:64-117,181-202` 把Daily准入作为recorder beforeCommit的发布许可；closed观察在eventFlow `:98-207` 仍可进入同一事实owner。protective SELL可随有效新revision触发progress持久化。**develop settleOrder的本地记录及refresh顺序与Daily返回并不完全相同，不能据局部Daily差分误称develop整个O/H都不变。**
- **impact：** confirmed行为差分；potential — 保护完成后权威金额、durable记录、recorder/refresh将按新语义继续推进，涉及恢复一致性和新段基线。没有宣称已造成实盘损失。
- **minimal fix/corrective decision：** 请G4/G5二审确认用户是否批准这个例外；无授权时保留develop准入语义且保留terminal资源收口。如业务确要改为“只冻结投影不冻结权威”，需独立需求确认，不能由新测试/新skill自行授权。
- **validation required：** 同输入在WS tracked/closed、protective durable failure、完整recovery、后续新段增量各路径对照；需另一子代理复核后定severity。
- **dimensions：** implementation, project/spec, tests。类型层只是新admission表达，不是证明语义获授权。

### V-C4／B01：末日旧SELL处理策略变更（已独立复核，用户已授权，非问题）

- **claim/evidence：** `develop:src/core/trader/orderExecutor/submitFlow.ts:600-660` 先取当前pending SELL、cancel全部、CANCEL_CONFIRMED后返回WAITING_FOR_AUTHORITATIVE_TERMINAL，权威终态移除pending后才读仓/submit。`current:src/application/orderExecution/submitFlow.ts:579-605` 则capture可卖量guard、读fresh available、直接submit，不撤旧SELL。
- **旧测试：** `develop:tests/integration/doomsday.integration.test.ts:377-525` 要求terminal前stockPositions/submit为0、重复调用cancel只1次，pending移除后卖500。
- **新测试：** `current:tests/integration/doomsday.integration.test.ts:462-546` 让cancel/replace调用直接throw，要求旧普通/保护性/市价/多个SELL完全不变，available40立刻新增40（available0则skip）。两套全量都通过**各自不同预期**，不是只改类型/注入。
- **runtime path/impact：** close-5专用清仓入口经submitFlow；confirmed下单计划差分，potential — 临近收盘旧SELL仍可能保留原价格和占用，末日可实际提交量及等待策略不同。未声称该风险在所有盘口都会漏平仓。
- **相关owner变化：** develop doomsdayProtection `:506-546` 在全accepted后虚裁cachedPositions/更新positionCache/清本地buy；当前doomsdayClearance `:488-490` 只invalidateAccount、不把提交当成交。后者可能是canonical owner设计的必要转移，但需要确认外部行为及后续唤醒，而不是仅用新“保留本地订单”测试声明等价。
- **处置／验证记录：** G4/G5已独立复核该差分并归并为B01；用户现已明确确认授权，保留当前末日策略，不作为问题、major或验收阻塞，不要求恢复旧撤单规则。已有同输入及边界验证保留于订单、风险证据报告。
- **历史归因：** 定向blame显示不撤旧SELL的核心行主要来自 `3ed3517` 等较早重构提交，**不是2b67d36新引入**；本任务比较的是develop到HEAD，不把所有差分错误归罪重点提交。

### V-C5：过期冷却重启后首次保护性完成，旧立即冷却、新不激活（请G5二审）

- **claim/evidence：** develop `src/services/liquidationCooldown/tradeLogHydrator.ts:61-77` 先restoreTriggerCount，后跳过已过期cooldown起点；当前 `src/application/protectiveLiquidation/tradeLogHydrator.ts:66-85` 在restore前就跳过过期cycle。
- **independent validation：** TEMP probe第4项直接使用两版hydrator+tracker，10:00/01/02三次完成，limit3、cooldown5min，10:10重启，两版remaining都0；重启后第一次保护性完成：**develop remaining300000，新版0**。`validation/behavior-probe-extended.stdout.log` 保留数值。
- **tests：** 当前新增 `tests/application/protectiveLiquidation/tradeLogHydrator.business.test.ts:51-96` 明确要求过期restart从零重数3次。旧同模块只有active cooldown240000ms和monitor mismatch两项，缺少过期restart检查，故这是新oracle填补旧缺测，不能由其“新增”性质证明无漂移。
- **impact：** confirmed可交易/冷却结果差分；potential — 用户以旧行为为真值时，相同恢复日志后的买入阻断时长不同。当前行为可能是在修旧bug，**修旧缺陷是否允许也需单独授权**，不能反过来把旧实现已有逻辑说成重构新增bug。
- **minimal fix/validation：** G5先核验日志、limit、live完成链与授权记录。若严格等价保留旧结果；若用户批准修旧缺陷，登记例外并保留“过期/恰好到期/已进入新cycle”正负例。定向blame该新early-continue来自 `8464691`，非两个重点提交。
- **dimensions：** implementation, tests, project/spec。

### V-C6：invalid SELL_OUT原集成负向oracle被fresh-flat成功场景替代（测试保护候选，请G3二审）

- 旧 `tests/integration/terminalSwitchFinalization.integration.test.ts:232-247` 对持仓100且旧标的quote0，期望 `FAILED/INVALID_QUOTE:SELL_OUT` 和 `EMPTY/null`。
- 新同文件 `:57,203,339-354` 改为“只有authoritative final positions flat才完成”：`readSwitchPositions: async () => []`，尽管canonical snapshot仍有OLD_BULL100；期望COMPLETED、NEW_BULL/ACTIVATING、mutation0。
- 已主动搜索替代测试，找到 `tests/integration/distanceSwitchIndependentSell.integration.test.ts:909-931`：invalid quote时先WAIT/SWITCHING，随后OLD权威成交且fresh flat才COMPLETED，无额外submit；因此不是简单“旧标题消失就没测”。但尚未找到**fresh仍正持仓、invalid quote最终失败/保守处理**对旧runtime场景的直接同输入回归。
- 这项仅为保护与语义对齐请求，不认定新实现不安全或必须EMPTY；应由G3区分新的权威持仓核验是否为必要修复，证明仍有真实正持仓时不会错误换标。最小验证是同输入的真实fresh-positive＋invalid-price场景，而非追求覆盖率数字。

## 5. 已复现但不提升为缺陷的内部契约差分及历史校正

### V-C2：executionTime晚于revision被放行 —— 不是“重构新增旧判断”

- develop本来已有 `executedTimeMs <= orderUpdatedAtMs`，例如旧DailyLoss `:281-298`、orderFactMerge `:121-126`、旧mixedTradeLogRepository baseline/progress解析。旧两时间通常同来自order updatedAt，本地账务代理不是独立交易所执行时间。
- 重构中间态引入独立execution ledger/time后，这个假设才失效；`d2aa590` 移除跨事实先后约束，相关旧throw测试改为accept。HEAD的 `2b67d36` 又删掉execution-ledger驱动，`orderMapper.ts:139` 恢复order updatedAt代理。
- TEMP probe第二项给T+1000、revisionT：旧false/durable0，新ADMITTED/advance/durable1，证明内部契约确不同，但**不据此声称真实原生mapper当前会产生T>revision或放行伪造实盘成交**。
- 观察到当前 `tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts:1921-1990` 验证历史新ledger progress可恢复T>revision；repository `:177-339` 也不再拒绝该顺序。完整durable/恢复/结算互通由G4/G5/G6审计；本验证只执行既有全量测试并深读指定断言，不重复伪称全链已审。
- 差分目的：辨认oracle改写及历史输入变化。不能回加已不成立的跨事实顺序约束来“修复”等价，也不能把一次内部probe当成实盘回归证据。

### V-C3：内部非法成本记录由吞零变fail-fast

- 旧 `src/core/orderRecorder/utils.ts:49-68` calculateOrderStatistics把NaN/Infinity price视0并计入有效qty；旧costAveragePrice测试例如zero+valid得到0.5。
- 当前 `src/domain/order/orderRecordPolicy.ts:30-64` 校验正cost、安全qty、时间，`tests/application/orderTracking/recorder/costAveragePrice.test.ts:77-94` 将六种旧非法数据oracle改为throw。
- probe第三项用内部storage setter注入zero100+valid100：旧0.5、新throw。**这只是内部非法状态行为差分。** 旧正式addBuyOrder/非零rebuild入口本来已拒绝不完整价格/时间，不证明正常券商订单现在不可用；不列生产缺陷或泛泛缺测意见。

## positive findings

- 两版完整验证都有真实脚本输出与最终测试总计，不把工具exit0或中间嵌套数字当通过；发现Bun帮助页空跑后保留原始证据并重新取得有效结果。
- 当前既有SDK guard和childEnv隔离可安全复用；没有为审计改源码/测试或调用真实SDK。Bun精确数值子进程仍跑原10项/4089断言并由父用例核验。
- 多项表面“断言减少”实为helper提取或完整toEqual后的重复删除，已逐项查证而未误报。
- 当前raw execution仍有反向保护，例如 `ordinaryRawExecutionFacts.business.test.ts:352-398` 拒绝执行时间倒退与revision倒退，`:423-461` 旧revision数量推进在runtime/recorder/daily/route前无污染；并未为了T/revision独立性取消所有单调性保护。
- 冷却新过期restart测试、flat换标测试、末日不改旧SELL测试都诚实表达了新预期；问题是它们是否被用户授权及是否保留旧约束，而不是测试是否“绿色”或数量多寡。

## 6. 测试保护矩阵与未完成映射

| 业务保护 | 已实际核对的测试证据 | 结论边界 |
| --- | --- | --- |
| 已完成保护边界不准入旧T同量revision | 旧/新Daily boundary、recorder boundary、settlement45→46、sealedBoundary integration | 已证实oracle反转，V-C1待G4/G5二审 |
| 累计数量/revision/执行时间单调 | ordinaryRawExecutionFacts与executionFact源码 | 旧revision增量/时间倒退负向保护仍在；不等同全部API/WS/恢复一致 |
| 正成交durable失败前不污染 | dailyLossExecutionBoundary第二项、settlement/read测试diff；全量执行 | 仍有测试，但删去旧getExecutionTimeEvidence断言；未完整再审持久化事务链 |
| 取消/拒绝部分成交只结算一次 | orderMonitor共享helper | 保护未因inline expect7→0消失 |
| SDK原文、order updatedAt代理、非HK push过滤 | orderFactMapper全部；orderMapper全部 | 对所读mapper成立，不覆盖所有adapter |
| 完整precision数值子进程 | exact.test.ts父子结果及full suite | 10/0/4089子断言真实运行；不由金融精度测试推导业务等价 |
| 末日先撤旧SELL/等终态 | 旧doomsday377-525与新462-546；两版submitFlow | 预期发生业务改变，V-C4 |
| 冷却active恢复、过期restart | 旧新hydrator tests、真实owner probe | active240000ms保留；过期restart下一次完成不同，V-C5 |
| invalid SELL_OUT对正持仓的保守终结 | terminalSwitch旧新、distanceSwitchIndependentSell909 | 新增flat-positive条件检查存在，但旧同输入负向oracle未完成映射，V-C6 |
| rebuild pending清理与issued IO drain | postTradeSettlement1397/并发272 | 已找到真实职责镜像，不把旧标题未匹配算删测 |
| 策略incremental/full指标rounding | 新旧incremental189 | 完整toEqual保留；不是独立旧金样 |

全量静态标题差集已落盘，**199个旧未匹配标题并未全部逐一人工判定**；其中doomsday、terminalSwitch、成本、日损候选已深入，其他生命周期、席位、策略、工具等交给各主责代理。不能把“没有skip”“测试数增加1296”写成无回归结论。

## 7. 实际读取并分析的生产文件清单

下表的“深读”只指列出的业务区段已经读源码并结合调用/测试分析；**不表示全文件或全组等价通过**。“diff/符号核对”不算深读覆盖。已按主代理地图定位G4/G5/G6相关路径，未扩成全图106KB读取。

### 7.1 当前生产文件（14个，分组供协调代理归并）

| 主责组 / 文件 | 实际深读范围 | 实际分析内容与未深入处 |
| --- | --- | --- |
| G4 `src/domain/order/executionFact.ts` | 全文1-176 | 单一累计量/amount/T/revision/phase裁决；未独立遍历所有调用者 |
| G4 `src/domain/order/orderFactMerge.ts` | 1-275；d2相关diff | 原始事实完整性/保护SELL/弱OPEN；276-677归一化与其余分支未深入 |
| G4 `src/domain/order/orderRecordPolicy.ts` | 全文1-298 | cost统计、非法事实、rebuild分流、profit/timeout规则；仅对所引用旧实现核对，不声称全调用链等价 |
| G4 `src/application/orderTracking/recorder/orderStorage.ts` | 1-210 | 内存存储、getCostBasis、pending开始部分；211-466未深入 |
| G4 `src/application/orderTracking/orderMonitor/settlementFlow.ts` | 全文1-459 | Daily beforeCommit、durable、episode、closed资源；与旧版关键区段对照 |
| G4 `src/application/orderTracking/orderMonitor/eventFlow.ts` | 1-230 | closed/tracked ingress、ownership、弱观察与事实提交；231-455其余runtime/bootstrapping未深入 |
| G4 `src/application/orderExecution/quantityResolver.ts` | 全文1-303 | HK目标数量/fresh sell读仓与caller授权、notional/lot；未逐一比对旧每个数量调用者 |
| G4 `src/application/orderExecution/submitFlow.ts` | 570-639；其余定向关键词 | 末日专用路径及市场门禁；其余完整提交/permit/merge未深入 |
| G5 `src/domain/risk/dailyLossTracker.ts` | 140-224、250-524、820-1019 | loss投影/事实构造/merge、准入/回调/恢复片段；其余重建/边界prepare/commit未完整深读 |
| G5 `src/application/protectiveLiquidation/tradeLogHydrator.ts` | 全文1-102 | cycle恢复顺序，实际差分probe |
| G5 `src/domain/liquidation/cooldown/index.ts` | 全文1-143 | trigger/cooldown/查询，真实probe；rules.ts仅由执行消费、未源码深读 |
| G5 `src/application/doomsdayClearance/index.ts` | 1-529；其余关键词 | ownership/window/可用仓位/accepted后事实，530-847重试及撤买后半未完整深读 |
| G6 `src/infrastructure/longbridge/trade/orderMapper.ts` | 全文1-321 | SDK原文、quantity、T、status/type、non-HK push，与旧观察来源核对 |
| G6 `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | 170-339；d2 diff | V1 baseline/completion/progress字段与T/revision约束；append/fsync/retention其余部分未深入 |

### 7.2 develop生产对照文件与级别

| 文件（固定基线SHA） | 级别 / 实际范围 |
| --- | --- |
| `src/core/riskController/dailyLossTracker.ts` | 深读268-337、938-1092、1225-1251；715-925定向符号/注释，核实原准入与T<=revision |
| `src/core/orderRecorder/utils.ts` | 全文1-269；cost统计、合法生产入口、rebuild分类 |
| `src/core/orderRecorder/orderStorage.ts` | 深读1-220；getCostAveragePrice约322后方法定向读取；其余未深入 |
| `src/core/orderRecorder/index.ts` | 仅createDailyLossOrderAnalysisDeps等符号段及probe实际导入，非全文件深读 |
| `src/core/trader/orderMonitor/orderFactMerge.ts` | 深读1-250；其余合并后半未深入 |
| `src/core/trader/orderMonitor/settlementFlow.ts` | 深读1-250、375-774；251-374与收尾未完整深入 |
| `src/core/trader/orderExecutor/submitFlow.ts` | 深读590-694；其余关键词/符号核对 |
| `src/core/doomsdayProtection/index.ts` | 深读455-559；其余未深入 |
| `src/services/liquidationCooldown/tradeLogHydrator.ts` | 全文1-94，真实probe |
| `src/services/liquidationCooldown/index.ts` | 全文，真实probe |
| `src/services/mixedTradeLogRepository/index.ts` | 深读160-334；其余未深入 |
| `src/core/trader/orderMonitor/eventFlow.ts` | 定向来源scan（例如111、134）；不算深读 |
| `src/core/trader/orderMonitor/orderOps.ts` | 定向来源scan（170、191）；不算深读 |
| `src/core/trader/orderMonitor/recoveryFlow.ts` | 定向来源scan（446、474）；不算深读 |

### 7.3 仅历史diff或执行消费、不冒充深读覆盖

- d2时 `src/domain/order/orderEconomics.ts`（HEAD已删除）、`executionFact.ts`/`orderFactMerge.ts`/`dailyLossTracker.ts`/`mixedTradeLogRepository/index.ts` 的相关diff与对应测试；差分目的为明确改的是原约束还是新来源。
- 两版 `src/utils/time/index.ts`、新 `src/domain/order/orderAnalysis.ts`、logger/numeric依赖由真实probe/test执行导入，**没有逐文件源码深读，不列等价覆盖**。
- current剩余G0/G1/G2/G3全部生产链路、G4/G5/G6上述未深入段，不因全量测试跑过就算本代理已审；以对应代码链代理报告为准。

### 7.4 实际深入的测试/验证文件（不是生产覆盖计数）

- 安全环境：`package.json`、`bunfig.toml`、`tsconfig.json`、`eslint.config.js`（仅头部规则）、`tests/setup/{testRuntime,childEnv}.ts`、`tests/infrastructure/longbridge/trade/{offlineSdkGuard,sdkModuleMock}.ts`、build productionBuild、logger、getHistoryOrders、cleanup、numeric exact子进程入口；旧同类文件定向比对。
- 业务oracle：两版dailyLossExecutionBoundary / dailyLossDurableDuplicate / dailyLossTracker.segment变更、executionFactBoundary / costAveragePrice、settlementFlow boundary、ordinaryRawExecutionFacts、orderMonitor helper、orderFactMapper、sealedBoundarySettlementAdmission、doomsday integration、terminalSwitchFinalization、distanceSwitchIndependentSell、tradeLogHydrator、cooldown business、postTradeSettlement business/concurrency、incremental indicators、loadTradingDayRuntimeSnapshot的T>revision恢复场景。
- 其余全部测试做AST声明索引/定向diff，不代表逐项深入阅读。

## not assessed

- **第二独立复核（历史边界）：** 首审交接时V-C1/V-C4/V-C5/V-C6尚待另一代理确认，后续状态以总报告为准；其中V-C4已归并为B01并由用户明确授权，非问题。
- **全仓等价：** 368 current生产文件/七组的完整语义审查不在本验证分工；本报告仅14个当前文件的指定区段，不把全量测试当等价证明。
- **真实账户与历史恢复：** 未读取生产V1日志、凭据、真实订单/positions，未做券商对账、真实候选/回退版恢复、实盘/仿真实际SDK会话；计划中生产发布阻断项不由离线绿灯解除。
- **OS网络隔离：** 没有防火墙/抓包证明，只做白名单env、no-env-file、SDK factory/session guard与测试mock。
- **依赖重装复现/其他平台：** 未按两版lock重新安装；共用现有node_modules，未在Linux/其他Bun版本验证。
- **完整type design/architecture/comments/dead code/simplification：** typecheck与所读契约片段已检查；未对全生产类型组织、动态出口、所有注释、所有消费边界做审计。仅因guard注释或某导出没在probe用到不得列dead code。七维中这些未全面评估，不能由lint通过替代。
- **测试金样完整性：** 199个旧未匹配标题和全部同名callback差异未逐项人工裁决。旧新Financial精度变化的授权与用户确认口径由主代理结合原指令判断；本报告不把修浮点误差自动判为业务漂移，也不把更精确自动视为授权。
- **模型后端：** 核实本地显式启动参数，不核验cliproxyapi后台最终模型route。

## recommended next actions

1. 原交接中的V-C1／V-C5／V-C6最终复核结论以总报告为准；V-C4（末日旧SELL）已归并为B01，用户明确授权、非问题，无需再裁决授权或恢复旧策略。
2. 以本报告§7精确段落与主代理全文件地图汇总覆盖；不要把AST索引、全量测试执行、导入消费计作源码深读，也不要把不同组的同一候选重复计数。
3. 保留TEMP证据与四项可运行差分作为审计依据；若实现后续变化，只复测实际风险路径并按项目必需检查执行。本文没有改实现，不需要为审计报告再跑一次全量门禁。
4. 在二审及真实历史/回退恢复等生产阻断闭合前，不给“全量等价/可发布/可开交易门”结论。

## 证据文件导航

- 主报告：`audit-validation.md`（本文）。
- 候选交接：`validation-peer-review-request.md`。
- 安全启动器：`validation-runner.cjs`、`validation-supplement.cjs`；外部SDK阻断：`validation-offline-sdk-guard.ts`。
- 可运行差分：`behavior-probe.test.ts`；有效扩展结果 `validation/behavior-probe-extended.{json,stdout.log,stderr.log}`。
- 两版有效命令及原始日志：`validation/current-{type-check,lint,test}.*`；`validation/develop-baseline-{type-check,lint,test}-corrected.*`。
- 非有效首轮解释：`validation/baseline-initial-attempt-invalid.json`；所有原日志未删除。
- 环境/快照/不变性：`validation/*-environment.json`、`*-manifest-*.json`、`*-mutation-check*.json`、`baseline-confirmed.json`、`final-readonly-checks.json`、`model-runtime-flags.json`。
- 测试对照：`compare-test-contracts.cjs`、`test-comparison/{summary,develop-baseline-inventory,pre-focus-inventory,current-inventory,develop-to-head,focus-to-head,skip-todo-only-check}.json`，同目录md标题差集可定向查阅。

**最终边界：门禁真实通过，但存在已复现且待二审的业务oracle差分；没有用“全绿”替代等价性证明，没有修改仓库源文件或发起真实SDK/实盘请求。**
