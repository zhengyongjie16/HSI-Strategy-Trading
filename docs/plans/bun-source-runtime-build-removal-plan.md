# Bun 源码运行与构建能力移除重构方案

> 状态：仓库重构与当前 Windows / Bun 环境的离线验收已完成；仓库外部署消费者及实际目标平台验收仍须在发布前确认。§2 和 §11.1 保留方案制定时的事实与历史证据，实施结果见 §11.2。
>
> 复核日期：2026-10-24。复核代码基线：`5f2bc05864971945eea17310fea5d23bbc50623f`。当前验证环境：Windows x64 / Bun 1.4.4；项目声明 TypeScript 6.0.3、Longbridge 5.2.2。
>
> 本方案取代 [Bun 原生高性能构建迁移方案](./bun-native-build-migration-plan.md)。不再新增 Bun 构建器，不实施旧方案中的 `scripts/build.js`、JSON 资源输出或 `--clean-only` 功能。
>
> 不读取真实凭证，不启动真实交易入口，不通过账户查询或实盘操作验证本次重构。

## 1. 最终决策与范围

采用 **Bun 直接运行 TS 源码 + 独立质量检查 + 完整源码版本发布**。彻底取消项目提供的生产 JS/二进制产物生成及 dist 正向运行合同，而不是将 tsc 替换成另一套构建器。

此处“移除构建能力”不包括 Bun 自身的运行时转译，也不意味着禁用 Bun 命令行内置的构建功能；目标是项目不再提供、维护或依赖这些产物生成路径。

### 1.1 必须满足

1. 唯一正式启动命令保持 `bun run start`，实际执行 `bun src/index.ts`。
2. 删除 package 的 `build`、`clean`，不保留别名、空实现或委托到类型检查的兼容壳。
3. 删除生产发射配置和专属构建依赖，不再生成、发布或正向加载项目 dist。
4. 生产策略入口固定为 `src/strategies/<selected>/definition.ts`，同目录 `config.json` 仍是必需的真实文件。
5. 保留完整类型检查、lint、测试及其工具依赖；直接运行 TS 不能代替这些检查。
6. 保留策略选择、配置校验、SDK 接入顺序、交易门禁和资源退出清理，不修改交易算法或订单语义。
7. 构建专属测试删除前，迁移其中仍有价值的源码业务保护，不能仅通过减少测试使重构通过。
8. 保留当前架构边界，不重采冻结基线、不迁移历史额度、不扩大动态导入或 SDK 豁免。
9. 构建产物的正向兼容逻辑零保留：不仅切换默认行为，还要删除旧分支、签名、协议、识别规则及因此失去消费者的内容，详见 §1.3。

### 1.2 明确不做

- 不新增 bundler、单文件 JS、`Bun --compile`、Node SEA 或产物裁剪器。
- 不新增通用资源复制、发布配置 DSL、安装器、容器平台或生产测试开关。
- 不删除所有名含 build/rebuild/cleanup 的业务函数，也不批量删除 `.js` 导入标识符。
- 不删除 TypeScript、`@types/bun`、`@types/node` 或仍被使用的 ESLint/测试依赖。
- 不全局修改 `allowJs`、`checkJs`、模块解析、环境文件加载或应用启动参数。
- 不清理交易数据、日志、认证配置、其他用户改动或无关工具。
- 不批量重写历史计划、审计记录和已经发生的验收结果。

### 1.3 构建产物兼容逻辑零保留

本次清理覆盖一切仅为预生成 JS、dist 或源码/产物双运行合同服务的正向支持，而不是让默认路径走源码后继续保留旧能力。以下均是最终代码必须满足的要求，不能将文档补齐视为已经清理。

| 现有兼容点 | 必须完整清除的内容 | 目标 |
| --- | --- | --- |
| 策略加载器与定位器 | `.js` 加载器准入、TS/JS 联合参数、按运行布局追加扩展名、旧调用实参与相关注释 | 固定 `definition.ts`；错误扩展名和缺失源码直接失败 |
| smoke 父子进程协议 | `StrategyReplaceabilityMode`、mode 参数/结果字段、旧 CLI 参数及用法、sourceRootByMode/extensionByMode、双模式调用和断言 | 只有源码协议，不接收或输出旧运行布局 |
| 临时工程与构建 runner | 编译入口、dist runner、产物枚举、仅用于构建的配置复制，以及删除后不再使用的函数/类型/导入 | 只保留真实源码验证所需的 fixture |
| 共享 fixture importer | dist 前缀选择、JS 扩展名分支及旧模式的正向准入 | 只允许源码 TS；保留实际消费者所需的精确入口与安全校验 |
| 架构扫描器 | compiled 参数、dist 路径准入、旧双布局 helper 的结构识别规则 | 只识别新的源码门禁，不同时认可新旧两套结构 |
| 测试与使用入口 | compiled 正向 fixture、旧模式期望值、build/clean/start:dist 等过渡入口、仍指导使用的双布局说明 | 无旧产物的正向执行路径或兼容承诺 |

禁止保留 `compiled = false`、恒定为 `.ts` 的旧模式形参、恒为 source 的模式类型/协议字段、缩成单元素的模式映射、忽略旧参数的适配器、空 build 函数或新旧门禁任选其一的识别分支。旧接口应删除，而不是仅由调用方不再使用。

同时追踪并清理由此失去消费者的导出、常量、函数、类型、形参/实参、序列化字段、导入和注释，不以“将来可能用到”为理由留下。这项清理只覆盖本次移除造成的废弃内容，不扩展成无关业务的兼容性或死代码重构。

以下保留项不是构建兼容层：固定的 `definition.ts` 文件名；仍用于真实边界校验/切片的源码路径常量；正常 ESM `.js → .ts` 源码解析；拒绝旧输入的 fail-fast 检查与负例；已到期的历史审计证据。策略私有配置中 `mode: 'threshold'` 等业务字段也不是 smoke 的运行布局协议，不得按标识符名称误删。

## 2. 方案制定时的事实、可行性与前提

| 当前事实 | 证据与含义 |
| --- | --- |
| 正式入口已经是 TS | `package.json` 的 main 为 `src/index.ts`，start 为 `bun src/index.ts`；不是新增一条未经设计的运行方式 |
| 当前构建仍是旧实现 | build 为 `bun run clean && tsc -p tsconfig.build.json`，clean 为 `rimraf dist` |
| 类型检查可以独立执行 | type-check 为 `bun check -p tsconfig.json`；根配置为 `noEmit: true`，覆盖 src/tools/tests/mock |
| 构建依赖可独立删除 | `bun pm why rimraf` 显示只有项目自身的直接开发依赖，没有其他包依赖 rimraf |
| 旧迁移入口未落地 | 当前没有 scripts 目录、`scripts/build.js`、`scripts/build.ts` 或 `tools/build.ts` |
| dist 是本地生成物 | 当前 dist 未被 Git 跟踪；取消构建后仍须一次性清理确认的旧产物 |
| 源码路径已可加载 | 真实源码策略加载、独立 schema 准备和路径安全边界已有可运行测试，见 §11 |
| 双布局仍有活动连接 | 生产定位器、共享 fixture importer、架构扫描器和测试仍支持 source/dist，不能只删 package 命令 |
| 仓库外部署不可由代码推断 | 当前未发现 `.github` 工作流或 tools/utils/IDE 构建调用；仍须确认外部 CI、进程管理与发布系统是否消费 dist |

### 2.1 可行且合理的条件

本项目明确固定 Bun 为生产运行时，且不再要求交付编译 JS 或独立可执行文件时，移除构建是合理的。保留无消费者的 dist、两套策略定位和产物测试，只会增加维护路径。

“Bun 能运行 TS”本身并不意味着所有后端都应该取消构建。本次决策还依赖于源码发布被接受、生产依赖仍被提供，以及外部部署入口同步调整。不承诺本次重构提升业务运行性能。

### 2.2 不能因移除而改变的事实

- Bun 默认运行 TS 不等于执行项目静态类型检查；检查必须在发布前单独通过。
- 源码运行仍需要 bignumber.js、Longbridge 及目标平台匹配的原生包，不是免依赖交付。
- 当前源码的 `.js` specifier 由 Bun/TypeScript 按现有规则解析；不能据此宣称 Node 原生 TS 可直接替代 Bun。
- 选中配置不合法必须先于 SDK 资源创建失败；构建取消后不增加运行时 fallback 或重试。

## 3. 目标命令与文件布局

目标 package scripts 保持为：

```json
{
  "start": "bun src/index.ts",
  "type-check": "bun check -p tsconfig.json",
  "test": "bun --no-env-file test",
  "lint": "eslint .",
  "lint:fix": "eslint . --fix",
  "format": "bun fmt && bun fmt --parser=json-stringify bun.lock"
}
```

不新增 `build`、`clean`、`build:source`、`start:dist` 等过渡入口。

目标生产源码布局：

```text
src/
├── index.ts
└── strategies/
    └── <selected>/
        ├── definition.ts
        ├── config.json
        └── 该策略私有实现
```

磁盘策略入口固定 `.ts`，不回退 `.js`、其他根目录或未选策略。正常源码 import 中的 `.js` 标识符不属于这种磁盘产物支持，继续保留。

## 4. 逐文件删除与调整清单

| 文件/目录 | 处理内容 |
| --- | --- |
| `package.json` | 删除 build/clean 脚本及 rimraf 开发依赖；保留 §3 的其他命令和仍使用的依赖 |
| `bun.lock` | 使用 Bun 随依赖移除同步更新；只清除 rimraf 及失去引用的间接依赖，不升级其他包 |
| `tsconfig.build.json` | 删除，项目不再具有生产发射配置 |
| 项目根 `dist/` | 一次性删除确认的旧构建产物，部署包同样不再携带它；不执行泛化 `git clean` |
| `tsconfig.json` | 仅清除不再需要的 dist 排除项；保留 noEmit、严格检查、types、target/module/lib、JSON 解析和现有检查范围 |
| `.gitignore` | 在旧产物及旧测试路径处理后，删除构建输出块中的 `dist/`、`build/`、`!tests/build/`、`!tests/build/**` |
| `eslint.config.js` | 删除 `dist/**` 专属忽略并同步必要注释；保留类型感知配置和其他无关忽略，不实施旧计划的 scripts JS 覆盖 |
| `src/constants/strategy.ts` | 策略入口常量改为完整文件名 `definition.ts`，更新 source/dist 注释 |
| `src/app/startup/prepareStrategy.ts` | 只接受 TS 加载器，移除按扩展名选择策略的分支；同步唯一定位调用 |
| `src/app/startup/strategyLoaderHelpers.ts` | 移除 extension 模式参数，使用固定文件名，保留全部元信息校验 |
| `tests/build/productionBuild.test.ts` | 按 §6 拆出源码保护，再删除编译/产物专属 suite |
| `tests/build/strategyReplaceabilitySmoke.ts` | 裁剪迁移 source 链路，不直接丢弃业务保护 |
| `tests/build/types.ts` | 迁移仍使用的类型，删除 mode 协议；完成后删除旧 tests/build 目录 |
| `tests/app/startup/prepareStrategy.test.ts` | 改为源码唯一正向 fixture，保留/补充正确失败阶段和拒绝旧布局的用例 |
| `tests/helpers/importFixtureModule.ts` 及其测试 | 改为源码唯一准入，保留七个宿主入口和全部路径门禁 |
| `tests/architecture/refactoring/scanner.ts` | 收紧路径准入及 importer 结构识别，保留源码模块解析 |
| `tests/architecture/refactoring/freeze.test.ts` | 同步源布局与防削弱测试，保留非授权位置拒绝 |
| `tests/architecture/refactoring/strategyDynamicBoundary.test.ts` | 删除 compiled 正向矩阵，保留全部源码边界和 dist 拒绝用例 |
| `tests/architecture/refactoring/README.md` | 更新当前源码唯一合同；历史验收结果保持原义并注明历史时点 |
| 根 `README.md` | 删除当前 build/clean/dist 使用说明，改为源码运行、资源和发布门禁 |
| `docs/plans/bun-native-build-migration-plan.md` | 标记已废弃并链接本文；保留历史方案及原型数字，不再作为实施依据 |

依赖移除使用 `bun --no-env-file remove rimraf`，不手工按 glob/minimatch 等包名猜测可删项。TypeScript 仍被 `eslint.config.js` 和架构扫描器直接使用，不能随 tsc 发射一起移除。

不存在的迁移脚本无需创建或删除；tools/utils 当前没有相关调用，不顺手改动。仅处理本次移除直接造成的废弃内容。

## 5. 生产加载合同收口

### 5.1 固定文件名

`STRATEGY_DEFINITION_FILE_NAME` 的值由 `definition` 改为 `definition.ts`，含义同步改为完整固定文件名，不新增 SourceMode 等恒定模式类型。

### 5.2 准备器与定位器

- `prepareStrategy()` 保留本地 file URL、无 query/hash 的约束，并明确拒绝非 `.ts` 加载器。
- 根目录仍依据模块位置推导，不依赖 cwd 或环境变量；保留仅用于离线夹具的 `loaderModuleHref`。
- `inspectStrategyLocation()` 收口为 rootPath、directoryName、fs 三个参数，不再接受扩展名。
- 定位器直接检查完整固定文件名，不在 TS 缺失时尝试 JS。
- 同步唯一生产调用方，清除相关类型位置、测试参数和注释中的双布局合同。

必须保留精确大小写、链接/junction 拒绝、realpath 越界拒绝、definition/config 同根、ID/导出结构校验、同步 prepare 契约以及真实 cause。

### 5.3 不变的业务顺序

现有 `src/index.ts → runApp → DEFAULT_RUN_APP_DEPS.prepareStrategy → 策略准备` 的源码入口不变。选中项 prepare、create 的身份与次数、SDK 接入前失败、交易门禁和资源释放语义均不变化。

JSON 语法/依赖导入失败仍属于 `Strategy:import`；JSON 已导入但私有 schema/DSL 校验失败仍属于 `Strategy:prepare`。不能用统一捕获或跳过掩盖差异。

应用的 createCleanup、交易日清理和业务 build/rebuild 函数不属于本次构建删除。

## 6. 构建测试拆分与源码验证迁移

### 6.1 旧四组测试的去留

| 原保护 | 处理 |
| --- | --- |
| build 命令、JS/JSON 产物清单、JSON-only rebuild、新增/删除源码后的输出变化 | 删除，属于不再提供的产物能力 |
| 无效业务配置仍可编译、移走源码后运行 dist、删除 dist JSON 后失败 | 删除编译/dist 断言；源码配置失败保护迁入现有加载测试 |
| 独立私有 schema 的 source/dist 完整事件链 | 迁移 source 半边，删除 build、dist 和移走源码的步骤 |
| clean/noEmitOnError、类型错误/缺 imported JSON 不保留旧入口 JS | 删除；发布前类型检查与源码缺配置检查仍保留 |

不要仅改测试名称后继续执行构建，也不为替代旧断言建立一个新 Bun 构建器。

### 6.2 最小迁移目录

```text
tests/integration/strategyReplaceability/
├── replaceability.integration.test.ts
├── smoke.ts
└── types.ts
```

这是原三文件的裁剪搬迁，不是新增测试框架。类型留在该 suite 最近共同目录，不提升到全局测试类型。

父进程 fixture 仅保留复制 src、提供现有生产依赖的 node_modules junction、空 cwd、写入测试策略和临时目录清理。不再复制 package/tsconfig 用于构建，不创建 dist，不保留 build/add/load/files 等仅服务编译的函数或 dist runner。

搬迁时同步项目根、preload、共享 importer、createEventHarness 和源码类型的相对路径。复用现有定义模板与事件 harness，不复制业务算法来制造新期望。

### 6.3 删除双模式协议

- 子进程参数由 `<root> <source|dist> <case JSON>` 改为 `<root> <case JSON>`。
- 删除 `StrategyReplaceabilityMode`、运行布局 mode 参数/结果字段、sourceRootByMode 和 extensionByMode，以及它们的全部调用实参、参数校验、序列化/解析、期望值、用法提示和双模式注释；不影响私有策略 schema 的业务 mode 字段。
- 源码路径固定为 root/src 下的真实 `.ts`；删除要求 source 不存在的 dist 专属检查。
- 每个私有 schema 仅运行一个源码子进程，不保留恒为 source 的兼容壳；旧 `<root> <source|dist> <case JSON>` 调用必须失败，不能通过忽略旧参数维持旧协议。
- 保留结果行标记、PID、definitionPath、importedPaths、调用计数及全部业务观察字段。

### 6.4 必须保住的真实行为

1. 买入与卖出测试策略使用真正不同的私有 schema，不依赖日内策略 parser，不需中心登记。
2. 真实文件发现与导入后，依次执行 prepare → create → 行情事件 → emitter → 真实决策队列 → destroy。
3. 选中策略的各阶段次数保持精确；未选策略不 import/prepare/create，不以仅有一个队列任务替代完整断言。
4. 保留 task type/action、symbol/name、seatVersion、原触发时间和 reason，以及对侧队列为空、行情/展示次数、上下文和无 fatal 断言。
5. 失败和成功都先 stopAndDrain，再执行原 cleanup；创建/销毁次数与清理顺序不变。
6. 保留子进程隔离、白名单环境、`--no-env-file`、testRuntime preload、管道消费和退出回收。

### 6.5 复用现有分层保护

- `prepareStrategy.test.ts` 已覆盖选中项唯一导入/prepare、缺配置、坏 JSON/缺依赖及两个独立 schema。删除 JS 正向矩阵，保留 TS 缺失不回退 JS，并补入实际私有 parser 拒绝错误 DSL/额外字段的参数化场景。
- `runApp.business.test.ts` 已覆盖 prepare 失败时仅发生 subscribe → prepare → unsubscribe，SDK 资源未触碰；不新增重复的整套 app fixture。
- `createSelectedStrategy.test.ts` 的创建/销毁保护以及现有 config/DSL 测试继续复用。
- `singleActiveStrategyExecution.integration.test.ts` 等现有测试不能替代独立私有 schema 的文件加载到真实队列整链，因此原 source smoke 必须迁移。

## 7. 共享 importer 与架构门禁同步

### 7.1 保留并收紧共享 importer

`tests/helpers/importFixtureModule.ts` 仍被 prepareStrategy 源码测试及迁移后的 smoke 使用，不能随 tests/build 删除。

将其布局与扩展名固定为 `src/` 和 `.ts`；可以保留用于切片和校验的局部固定常量，但不保留模式参数或二选一分支。保留 realpath(root/file)、file URL、无 query/hash、精确根目录、扩展名、入口白名单及策略 definition 形状的完整校验。

迁移后的 source smoke 仍消费以下七个宿主入口，故必须保留 importer 与 scanner 中一致的精确集合，不新增、泛化或缩减到无法验证原链路：

```text
app/startup/prepareStrategy
app/startup/createSelectedStrategy
app/shutdown/createCleanup
runtime/businessEventProgram/index
runtime/asyncProgram/tradeTaskQueue/index
runtime/lifecycle/terminationRuntime
domain/seat/symbolRegistry
```

helper 自测只保留源码正向布局，继续覆盖越界、private leaf、旧路径、链接和非法 URL，可保留少量 dist/JS 拒绝用例。

### 7.2 同步 scanner 与防削弱测试

- `guardedFixtureImport()` 当前精确识别 helper 的两个 source/dist 声明。必须删除旧双布局结构的识别，只认可新的固定源码门禁，并继续要求全部 URL/realpath/root/入口门禁、准确函数身份与动态 import 形状。禁止保留 oldShape/newShape 二选一的兼容识别。
- 同步 `freeze.test.ts` 的逐项门禁变异测试、七入口集合检查、重复/排列校验。不能放宽成只按 helper 文件名或一个函数名授权动态 import。
- `freeze.test.ts` 中把 importer 文本放入 `tests/build/strategyReplaceabilitySmoke.ts` 的 fixture 只是在验证非授权位置不能继承豁免，不是真实 smoke 调用方。改用普通非授权测试路径，保留拒绝断言。
- `selectedStrategyPath()` 删除 compiled 参数，只接受精确的 root/src/strategies/<selected>/definition.ts；保留目录名规则与规范化完整路径相等检查。
- 同步 `strategyDynamicBoundary.test.ts` 和 freeze 中的双布局 fixture，只删除 compiled 正向半边，不删除 source 的配置同根、链接、越界、大小写、缺配置、其他策略和 private leaf 拒绝场景。
- 保留至少一个旧 dist 合法入口如今被拒绝的用例；这不是继续支持 dist。为 helper/scanner 加入针对旧双布局声明的拒绝或变异负例：即使其他 URL/realpath 门禁完整，恢复旧 dist/JS 选择也不得重新取得动态导入授权。

### 7.3 不得误删的源码解析

scanner 当前扫描 src/tests 的 TS，不遍历 dist。以下能力不是编译产物支持：

- 相对导入和 `@/` 标识符中的 `.js → .ts` 源码身份解析；
- `ts.resolveModuleName`、类型导入、静态/动态 import、require 与边界识别；
- 固定 `.js?case=...` 测试模块的缓存隔离解析；
- selected loader 的真实声明/参数 symbol 校验，以及单策略根、角色和层矩阵约束。

不得为了消灭 `.js` 或 build 字样而删除这些检查，也不能删除 scanner、框架测试或整个架构目录。

## 8. 历史冻结证据与文档处理

### 8.1 baseline/unresolved 保持不变

当前 `baseline.json` 为 P6，helperCalls 855 条、stagedViolations 33 条。其中旧 productionBuild 文件有四条 P3F helper 历史记录和两条 P6 violation 历史记录。`excess()` 在 cutoff 到达时即拒绝，这六条当前有效额度均为零；消费者不要求历史文件仍存在。

因此本次不需要删除历史行或刷新清单。保持 `baseline.json`、`unresolved.json`、stage、cutoff、evidence 和原身份不变，不将额度搬到新 suite，不根据当前扫描结果重建基线。如果新测试位置暴露真实违规，修正调用链或门禁，而不是追加允许额度。

### 8.2 当前使用说明与历史记录分离

- 根 README 删除 build/clean、生产发射配置和 dist 启动说明，改为“单活跃策略与源码发布”。
- 明确 JSON 是源目录中的真实运行资源；源码、JSON、策略增删后完整发布并重启，不进行进程内热替换。
- 架构 README 更新当前 source-only 合同；旧 P6 验收数字和 build 通过记录属于历史证据，注明历史时点而不伪造新结果。
- 旧 Bun 构建迁移计划标记已废弃并链接本文；保留其原型证据不表示要继续实施。
- 其他历史计划和审计文档不因包含 build/dist 字符串而批量重写。只有仍指导当前使用的直接引用需要同步。

## 9. 源码发布合同与风险

### 9.1 发布内容

```text
release/
├── src/                 # 含完整策略目录和 JSON
├── package.json
├── bun.lock
├── tsconfig.json
└── node_modules/        # 若已在兼容环境安装生产依赖
```

不发布 dist、构建配置、测试或无关工具。若生产依赖尚未准备，可在目标/兼容环境执行 `bun install --production --frozen-lockfile`。在此之前，质量检查环境应安装完整开发依赖，不能先裁掉 TypeScript/ESLint 再要求它们执行检查。

这是运行依赖的交付选择，不新增项目安装器或容器构建功能。不得依赖 Bun 自动下载或开发机缓存作为发布完整性的保证。

### 9.2 部署前提

- 固定经验证的 Bun 与 SDK 版本，本次不混入升级。
- 原生 SDK 必须匹配系统、CPU 架构和 libc；不能复制 Windows 的 node_modules 到 Linux，也不能假定 GNU 包可直接用于 Alpine/musl。
- 平台原生包可能通过 optionalDependencies 分发，不能因为名称中有 optional 就统一省略。
- 运行凭证、环境和持久数据由部署提供，不把真实 `.env.local`、账户数据或日志复制进发布包。
- 保持现有 start 的环境加载行为，不为取消构建改变 Bun 自动环境加载或在生产命令强加测试参数。

### 9.3 风险与对应控制

| 风险 | 控制 |
| --- | --- |
| 直接运行绕过类型错误门禁 | 发布前执行完整 type-check，失败不发布；不把启动成功当作类型检查 |
| 源码/JSON 或策略目录遗漏 | 交付完整版本，在隔离环境验证源码发现、配置及真实事件链 |
| 外部流程仍执行 build 或启动 dist | 实施前盘点外部 CI、进程管理、发布和回滚配置并同步 |
| 旧 dist 仍被误启动 | 一次性清理遗留产物、停止旧启动入口，新版本不保留双路径 |
| 为搬迁测试而削弱架构保护 | 同步结构门禁及变异负例，baseline/unresolved 不变，失败不加豁免 |
| 原生依赖只在开发平台可用 | 在实际目标平台离线验证 SDK 模块与源码链路，不用实盘操作验证 |
| 发布期间文件混用 | 停止旧进程后切换完整版本；回滚按完整版本进行，不在新版本增加 dist fallback |
| 并行改动混入或被覆盖 | 实施前重新记录工作区，只接受本次关联差异，不回退或清理其他工作 |

## 10. 实施顺序与验证

### 步骤一：确认基线和部署消费者

记录实施时 HEAD、工作区和版本，保护已有改动。确认源码发布是正式合同，并查清仓库外 build/dist 消费者；不能以仓库没有工作流推断线上没有这些依赖。

### 步骤二：收口生产源码定位

按 §5 修改三个生产文件与唯一调用方，更新加载测试；不动交易流程或普通 ESM specifier。

### 步骤三：迁移 source 验证并同步架构门禁

按 §6 建立裁剪后的三文件 suite，保留真实事件队列断言。与 §7 的 helper/scanner/freeze/边界测试同步收口，避免只删测试或只放宽 scanner。确认源码保护完整后才删除旧 tests/build 三文件。

### 步骤四：删除构建配置、依赖和遗留产物

删除 build/clean、生产发射配置，使用 Bun 移除 rimraf 并审查锁文件。仅清理确认的项目根旧产物，先处理 dist 和旧 tests/build，再移除其忽略/排除配置，避免暴露大量旧文件参与 lint。不要删除 node_modules、数据或日志来代替精确清理。

### 步骤五：同步当前文档与部署合同

按 §8–§9 更新 README、架构当前规则和外部启动步骤。核对旧计划已被明确废止；不得增加另一个构建工具作为替代。

### 步骤六：执行与改动相称的质量验收

实际改码后按顺序运行：

```sh
bun run lint:fix
bun run type-check
bun --no-env-file run test
```

测试须通过现有 package 脚本和 §11 的白名单隔离环境执行，保留 preload/offline SDK guard。全量检查仅在实施后执行，不把本次文档复核冒充正式验收。检查自动修复 diff，只接受关联变更；没有新改动、失败或未解决疑点时不重复完整检查。

修改期间可针对 prepareStrategy、importFixtureModule、新 integration suite 和 architecture 测试定位问题，不能用定向通过代替最终必要检查，也不能删除失败断言或扩大历史额度。

### 步骤七：收口引用与发布

核对 package、配置、生产定位、测试与当前文档的内部连接，不再执行构建命令。验收对象是源码发布包；在目标平台完成离线模块与策略加载检查后，按完整版本部署，不直接运行真实 src/index.ts 作为离线验收。

残留搜索应区分活动能力、拒绝旧布局的负例与历史证据：允许后两者保留 build/dist 字符串，但活动命令、模式参数、发射配置或 dist 正向入口必须消失。不以全仓字符串零匹配为完成标准。

按 §1.3 的矩阵逐项追踪生产代码、父子进程协议、共享夹具、scanner 和调用方，将每一处匹配归类为“已删除”或“仍有明确源码/拒绝性/历史用途”。确认没有旧接口、恒定兼容壳、未使用导出/参数或旧识别规则；不能仅检查默认分支和目录是否消失。此项可用现有搜索与类型/lint 检查完成，不新增通用清理框架。

行为验收还必须证明：旧 JS/dist 入口在求值前被拒绝、缺 TS 不尝试 JS、旧 smoke 参数协议失败、旧双布局 helper 不再通过 scanner 授权，而正常源码导入及现有七入口链路继续通过。

## 11. 已有证据与尚未覆盖

### 11.1 方案制定时的文档复核证据

在本文复核基线和 Windows / Bun 1.4.4 下，使用 `tests/setup/childEnv.ts` 构造独立 HOME/TEMP/日志目录与白名单环境，经实际 package test 脚本运行：

```text
tests/app/startup/prepareStrategy.test.ts
tests/architecture/refactoring/strategyDynamicBoundary.test.ts
```

结果：**57 pass、0 fail、130 个断言**。子进程使用 `--no-env-file`，现有 testRuntime preload 引入离线 SDK guard；临时目录已清理。没有执行构建或真实交易入口。

这些是重构前已有加载/边界测试，包含当时尚存的双布局场景。它们证明源码运行基础和既有保护可执行，不证明 source-only 改造、源码 smoke 搬迁、依赖删除或最终部署已经完成。

### 11.2 实施与离线验收结果

在同一 HEAD 基线和 Windows x64 / Bun 1.4.4 下完成本方案的仓库变更：

- 删除 build/clean、生产发射配置及确认的旧 dist；锁文件仅移除 rimraf、glob、lru-cache、minipass、package-json-from-dist、path-scurry，其余包条目未变化。
- 固定策略源码入口，删除双布局协议与正向兼容分支；源码整链迁至 `tests/integration/strategyReplaceability/`，补齐旧输入拒绝和失败清理检查。
- 使用 `tests/setup/childEnv.ts` 白名单环境与隔离 HOME/TEMP/日志目录，按序完成 `lint:fix → type-check → test`，保留 `--no-env-file` 和现有 preload：**3628 pass、0 fail、23537 个断言、326 个测试文件**。
- 临时完整源码发布包包含 src/JSON/package/lock/tsconfig，复用当前平台已安装依赖；从空 cwd 离线验证 Longbridge 原生模块、BigNumber、实际日内策略 prepare/create/cleanup，不包含 dist，不运行真实应用入口。该检查不替代目标平台依赖安装与验收。
- `baseline.json`、`unresolved.json` 与 HEAD 无差异；交易算法、SDK 创建顺序、交易门禁和订单/退出实现未修改，相关现有测试随全量检查通过。
- 已审计活动命令、生产定位、测试协议、importer/scanner 与调用方；旧布局匹配已归类为拒绝性说明/测试或历史证据，普通 `.js → .ts` 和业务配置编译逻辑保留。独立只读全链路复核未发现已确认缺陷。

### 11.3 尚未覆盖

- 未在其他服务器系统/架构验收本次源码发布合同，也未确认仓库外流水线和实际线上入口。
- 未执行生产环境或实盘验证，不将此类操作作为完成要求。
- 离线 guard 是可信测试工厂边界，不是操作系统网络沙箱，不能借此运行未审查入口。

## 12. 完成标准

- [x] 正式入口保持 Bun 运行 TS，package 不再提供 build/构建 clean 或兼容别名。
- [x] 生产发射配置和项目构建器不存在，不生成、交付或正向消费 dist。
- [x] rimraf 及失去引用的间接依赖已移除，共享包和其他版本未被误删或升级。
- [x] 策略入口固定 definition.ts；JS 加载器、缺 TS 时回退 JS、旧根和 dist 均拒绝。
- [x] source/dist 协议、模式类型和 compiled 正向矩阵已移除，源码路径安全及 cause/错误阶段保护完整。
- [x] §1.3 的所有正向兼容点逐项清理，无恒定模式参数/字段、单元素兼容映射、过渡入口、空实现或因移除失去消费者的内容。
- [x] 旧 CLI 运行布局协议、旧 JS/dist 入口及旧双布局 helper 结构均被明确拒绝，没有新旧 scanner 规则并存的兼容授权。
- [x] 两个独立私有 schema 的真实源码发现到队列/销毁整链仍存在并通过，未改成手工调用后直接 enqueue。
- [x] 共享 importer 的七入口与 definition 门禁、scanner 的结构识别和防削弱测试同步且未放宽。
- [x] 普通 `.js → .ts` 源码解析、层边界、SDK 边界和真实声明身份检查保持有效。
- [x] baseline/unresolved 无本次差异，stage/cutoff/历史证据不变，没有新增动态导入或 SDK/helper 额度。
- [x] 严格 noEmit 检查、TypeScript/类型声明、lint/测试依赖、运行资源及业务 cleanup 保留。
- [x] 必需质量检查及当前 Windows / Bun 环境的源码发布离线检查通过，未使用真实交易测试。
- [ ] 发布前确认实际目标平台的原生依赖及源码链路离线验收通过；失败不发布。
- [x] 当前仓库说明已同步，旧构建迁移计划不再待实施；历史验收未被伪造改写。
- [ ] 发布前确认仓库外 CI、进程管理、发布及回滚入口均已同步。
- [x] 保留其他工作区与暂存改动，不混入业务重构、升级、通用工具或新的构建平台。

**最终原则：删掉没有交付需求的构建链，保留使源码发布可靠的检查、资源、依赖和业务保护；减少运行合同，而不是减少交易安全保证。**
