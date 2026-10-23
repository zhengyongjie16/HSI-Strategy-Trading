# 完全移除 dotenv，统一使用 Bun 原生环境加载

> 状态：代码重构已实施，静态检查、全套离线测试与实际构建通过。实施日期：2026-10-23。安全执行存在一项已披露偏差，不能声称全部安全约束均满足；详见 §11。
>
> 分析日期：2026-10-23。代码基线：`08cd21e487940c1a4314f9a11d8116515f41ec40`；实测运行时：Windows / Bun 1.4.3；移除前 dotenv：17.4.2。
>
> 方案阶段仅新增本文，未修改生产代码、测试、依赖或真实环境文件，未连接券商、发起 OAuth 或启动交易。以下分析与原实施要求保留为基线记录；实际实施及验收结果以 §11 为准。行号仅为基线定位提示，以文件和符号为准。

## 1. 决策摘要

**完全删除 dotenv 依赖及所有运行期、测试期引用，由 Bun 在进程启动时加载环境；应用仍然读取和传递 `process.env`。**

采用最小方案：

1. 保留 `package.json` 中 `"start": "bun src/index.ts"`，保留当前 Bun 默认环境文件选择及优先级。
2. 删除五个入口中的 dotenv 导入、调用及直接失去用途的路径代码。
3. 保留 `runApp({ env: process.env })` 和各工具 `createSdkConfigFromAuth({ env: process.env, ... })`，不改配置解析、认证和交易逻辑。
4. 清理四个现有测试文件中的 dotenv 专属 mock、计数器、恢复分支和断言；保留原业务断言与离线保护。
5. 增加一份主入口原生加载契约测试；工具的必要加载验证放回各自测试，不建设通用环境框架。
6. 更新当前使用说明，完成依赖、构建产物及内部引用检查。

**不把全部启动命令改成 `--env-file=.env.local`，也不在 `bunfig.toml` 全局设置 `env = false`。** 当前实际行为不是“只加载 `.env.local`”：Bun 已先执行默认分层加载。强制单文件会丢弃原有其他环境文件中的配置，不能以简化为由暗中改变。

“功能一致”指受支持启动方式下，相同环境输入产生相同业务配置、认证参数、查询参数、业务输出和退出语义；不要求保留 dotenv 的提示行、mock 调用次数、旧 Node 源码运行说明或绕过 Bun 参数的隐式补读。特殊启动方式的明确变化与迁移要求见 §4，不能宣称所有旧命令逐字不变且行为完全等价。

## 2. 再次分析后的事实与证据

### 2.1 dotenv 在当前程序中的真实职责

当前只使用 `dotenv.config()` 将文件键值注入 `process.env`。项目未直接使用其 `parse()`、自定义 `processEnv`、vault 或变量展开功能。

主路径：

```text
Bun 启动并加载环境
  → 静态模块初始化，包括 constants/index.ts 的 IS_DEBUG
  → src/index.ts 再次调用 dotenv.config({ path: '.env.local' })
  → runApp({ env: process.env })
  → buildAppRuntimeEnv / prepareStrategy
  → createPreGateRuntime
  → createTradingConfig / validateAllConfig
  → SDK 配置与客户端创建
```

- `src/index.ts:9–15`：dotenv 加载后传入同一个 `process.env`。
- `src/constants/index.ts:159`：`IS_DEBUG` 在模块求值时读取环境。
- `src/app/runApp.ts`：已有环境快照与依赖组装，不应增加第二套配置 owner。
- `src/app/runtime/createPreGateRuntime.ts`：交易配置校验在客户端创建之前完成，顺序必须保留。
- `src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.ts`：已有认证入口接受 `env`，不负责加载环境文件。

当前正常 Bun 启动下，dotenv 通常只是重复读取；但在 Bun 跳过某文件、显式选择其他文件或脚本从其他目录启动时，它仍可能补入缺失键。因此，“可替代”成立，“直接删除后所有运行方式无差异”不成立。

### 2.2 完整直接影响范围

| 类别 | 文件 | 作用 |
| --- | --- | --- |
| 主入口 | `src/index.ts` | 相对 cwd 加载 `.env.local`，启动 app |
| 分析工具 | `tools/dailyIndicatorAnalysis/index.ts` | 相对 cwd 加载，再认证并查询分钟 K 线 |
| 分析工具 | `tools/meanDeviationAnalysis/index.ts` | 相对 cwd 加载，再认证并查询日线/分钟线 |
| 手工脚本 | `utils/getHistoryOrders.js` | 进入 main 时按脚本位置加载项目 `.env.local` |
| 手工脚本 | `utils/getWarrants.js` | 顶层按脚本位置加载项目 `.env.local` |
| 测试 | `tests/index.business.test.ts` | 主入口 mock、环境转交、错误退出 |
| 测试 | `tests/tools/dailyIndicatorAnalysis/index.business.test.ts` | 工具参数、认证、SDK 与输出 |
| 测试 | `tests/tools/meanDeviationAnalysis/index.business.test.ts` | 工具查询、计算输出及失败处理 |
| 测试 | `tests/infrastructure/longbridge/trade/getHistoryOrders.business.test.ts` | 导入安全、CLI 查询及订单过滤 |
| 依赖 | `package.json`、`bun.lock` | 根依赖声明与锁定包 |

`getWarrants` 当前没有对应入口业务测试，需要补一项有实际价值的离线入口检查；不要借此重写其筛选算法。

### 2.3 已执行的分析验证

以下是方案阶段的事实，不是移除依赖后的验收结果：

| 检查 | 实际结果 |
| --- | --- |
| 原生机制隔离验证 | 前一轮用临时目录进行 7 次 Bun 调用，确认默认/显式加载、父环境优先级、变量展开、test 模式和禁用加载 |
| 旧 `Bun + dotenv` 与纯 Bun 比较 | `NODE_ENV` 未设置、development、production 的默认启动均一致；比较了静态 import 捕获值和启动后的合成环境键 |
| 包脚本路径比较 | 临时 package 中保留 `bun <entry>` 结构，新旧启动结果一致 |
| 父环境覆盖 | 两条路径都保留父进程的同名值，结果一致 |
| 公开配置模板差分 | 将 `.env.example` 放进临时目录作为 `.env.local`，逐项比较 49 个配置键，零差异；叠加父环境覆盖后仍零差异 |
| 缺少默认 `.env.local` | 两条路径均继续执行，文件缺失本身没有替代应用配置校验 |
| 缺少显式 `--env-file` | 本机 Bun 1.4.3 实测退出码 0；不能把该参数当作“文件必存在”校验 |
| 直接相关基线测试 | 4 个文件，9 pass、0 fail、59 个 expect 断言；使用 `--no-env-file`、`createChildEnv` 和现有离线 guard |

基线测试范围：

```text
tests/index.business.test.ts
tests/tools/dailyIndicatorAnalysis/index.business.test.ts
tests/tools/meanDeviationAnalysis/index.business.test.ts
tests/infrastructure/longbridge/trade/getHistoryOrders.business.test.ts
```

未读取真实 `.env.local`，未验证部署系统中的隐藏启动命令或实际密钥格式；公开模板一致不等于所有私有配置均已验证。未运行全量测试、完整 lint/type-check 或迁移后的构建。

文档交付检查：代码围栏成对、章节齐备、无行尾空白，临时实验目录已清理。尝试 `bun --no-env-file fmt --check <本文>` 时，当前 Bun 返回 `Script not found "fmt"`，因此不声称格式器检查通过，也不为此次文档交付安装额外格式化依赖；该限制不影响已完成的环境实验和基线测试。

## 3. 必须保持不变的业务契约

1. 配置键、字符串值、缺失/空字符串区分，以及布尔、数字、金融文本的解析规则不变。
2. `ACTIVE_STRATEGY_ID` 的显式选择、旧策略键拒绝规则、策略参数 JSON 归属不变。
3. OAuth/API-key 选择、认证参数、SDK 扩展配置透传和原认证错误语义不变。
4. `process.env` 继续作为入口传参对象；不全面替换为 `Bun.env`，不新增配置镜像、缓存或全局状态。
5. `IS_DEBUG` 等顶层环境读取在应用模块初始化时已能读到启动配置。
6. 配置与策略校验先于真实 SDK 接入；缺失或非法配置仍按原规则拒绝启动，不添加默认策略、默认凭证或失败降级。
7. 主入口 `ConfigValidationError`、`AppStartupAbortError`、未知异常的日志和退出处理不变。
8. 下单、撤单、风控阈值、数值精度、订单过滤、行情计算、事件协作、生命周期及清理顺序均不变。
9. 工具 argv、查询参数、结果表格/JSON、成功退出和失败退出不变；只允许 dotenv 自身提示行消失。

保证这些契约靠“启动环境边界检查 + 原业务测试”，不靠复制交易算法生成新的期望，也不靠访问真实账户验证。

## 4. 目标环境加载契约与已知差异

### 4.1 正常启动：保留 Bun 默认规则

在项目根目录运行 `bun start` 或 `bun src/index.ts`。Bun 在应用模块执行前按原生规则加载，文件优先级由低到高为：

1. `.env`。
2. `.env.development` / `.env.production` / `.env.test`，按 `NODE_ENV` 选择。
3. `.env.local`，但 `NODE_ENV=test` 时不默认读取。
4. 对应的 `.env.development.local` / `.env.production.local` / `.env.test.local`。

已有父进程环境值优先于文件值，包括显式提供的空值；空值行为必须纳入实施验收，不在程序里自行补齐。

保留正常默认模式，才能继续使用当前已经由 Bun 加载的多文件配置。不要新增目录向上搜索、路径猜测、失败重试或第二解析器。

### 4.2 显式文件、外部环境与非根 cwd

需要明确文件来源时，直接对执行入口的 Bun 使用参数：

```powershell
# 根目录，明确选择一个文件；这不是默认 start 的替代实现
bun --env-file=.env.local src/index.ts

# 仅使用已有进程环境
bun --no-env-file src/index.ts

# 从其他目录运行工具，明确环境文件与脚本的绝对路径
bun --env-file="D:/project/.env.local" "D:/project/utils/getHistoryOrders.js"
```

也可用 `--cwd` 将工作目录明确设为项目根，再使用正常相对路径。带空格路径必须正确引用，并在隔离测试中验证。

删除后，`--env-file` 只选择指定文件，不再由入口悄悄补读 `.env.local`；`--no-env-file` 禁止默认文件加载，不再被 dotenv 绕过。没有另加 `--env-file` 时，纯外部环境部署依赖现有校验确认配置完整。

不要依赖给外层 `bun run` 加参数就能控制脚本内层 Bun。实测临时包的 `start = bun native.mjs` 时，外层 `bun --no-env-file run start` 仍由内层执行默认加载。需要可控的文件选择时，文档给出直接入口命令，不增加专用 launcher。

本机还实测了裸 Bun 内层脚本：脚本自身包含 `--no-env-file` 时合成文件键未出现，包含 `--env-file=.env.local` 时仅出现指定文件键。不要将“外层一定会把默认文件键全部继承给内层”作为未经验证的规则；验收实际发布命令，而非推测 shell 行为。

### 4.3 测试模式与原有补读行为

旧代码即使在 `NODE_ENV=test` 或使用其他显式文件时，也可能由 `dotenv.config()` 补入 `.env.local` 的缺失键；移除后不再补读。这是环境加载职责归一后的明确变化：

- 正式业务不要依赖 `NODE_ENV=test` 隐式读取真实本地凭证。
- 特殊部署若确实采用 test 模式，必须显式选择所需文件并在离线环境比对最终配置；不改变全局默认加载以照顾此路径。
- 测试默认使用隔离环境与 `--no-env-file`；原生加载测试只允许读取临时合成文件。
- `--no-env-file` 不会清除父进程已存在的环境变量；只加这个参数不足以证明测试没有凭证。
- `tests/setup/testRuntime.ts` 在 JS preload 阶段设置 `NODE_ENV`，不能代替进程启动前的文件加载隔离。

如果实际生产启动依赖上述补读，先改启动配置并验证等价，再发布；不要在应用里恢复一段兼容读取。

### 4.4 解析、缺失文件和输出

- Bun 会展开 `$VAR`；字面量 `$` 依其规则转义。正常 Bun 默认路径早已有此行为，不是此次新引入。
- 对过去绕过 Bun 加载、只由 dotenv 解析的路径，变量展开、引号、多行、转义等必须用脱敏样例验证；禁止打印密钥或整个 `process.env`。
- 文件缺失不新加统一 fatal，也不吞掉后续配置错误。保留既有“由策略、交易和认证校验判断配置是否完整”的语义。
- Bun 代替 dotenv 后，其注入提示、tips 和相关静默开关不再存在。业务日志不变，测试不要求恢复该提示。
- `DOTENV_*` / `DOTENV_CONFIG_*` 不再是本项目的环境加载开关，不加入兼容映射；部署若仍依赖它们，改用 Bun 参数并验证。

### 4.5 Node 与 import 行为

源码入口统一以 Bun 执行，不新增 Node 分支或调用 `process.loadEnvFile()` 的双运行时兼容层。`utils/getHistoryOrders.js` 的 Node 使用说明应修正；其源码导入 `.js` 路径而目标仅有 `.ts` 的现状，本来就不能据该说明保证普通 Node 直接运行。

不顺便引入 `import.meta.main` 或导出 `runX`：

- 两个分析工具、`getWarrants`、主入口目前都在模块加载后执行主流程；删除 dotenv 不使其变为无副作用模块。
- `getHistoryOrders` 已有 argv 路径入口保护，继续保留。
- 现有动态 import 测试依赖这些入口行为；改入口结构属于另一项重构。

## 5. 逐文件实施方案

### 5.1 主入口与分析工具：纯删除

`src/index.ts`：

- 删除 dotenv import 与 `dotenv.config({ path: '.env.local' })`。
- 文件头改为“消费由 Bun 启动时准备的环境，调用 app 组装入口”。
- 保留静态 `runApp` import、传参、try/catch 及三个错误分支，不改为动态 import。

`tools/dailyIndicatorAnalysis/index.ts`、`tools/meanDeviationAnalysis/index.ts`：

- 各删除 dotenv import 与 config 调用。
- 不改 `main`、argv、认证、行情查询、指标计算、输出和退出逻辑。
- 不增加环境 helper、依赖注入参数或新配置类型。

### 5.2 手工脚本：删除后清理真实无用代码

`utils/getHistoryOrders.js`：

- 删除 dotenv import、`loadLocalEnv()` 定义与 main 中的调用。
- 删除仅用于加载路径的 `__dirname`。
- **保留** `path`、`fileURLToPath`、`__filename`，它们仍用于文件末尾的 argv 入口判断。
- 保留过滤 helper 导出、主流程及所有 JSDoc 业务类型。
- 将使用说明改为项目根目录下的 `bun utils/getHistoryOrders.js`；非根 cwd 的规则由 README 统一说明。

`utils/getWarrants.js`：

- 删除 dotenv import、config 调用及对应“加载环境变量”注释。
- 删除仅为该调用存在的 `node:path`、`node:url` 导入和 `__dirname`。
- 其他逻辑和当前 Bun 用法不变。

### 5.3 现有测试：删除库耦合，不删除业务保护

| 测试文件 | 删除/替换 | 必须保留 |
| --- | --- | --- |
| `tests/index.business.test.ts` | dotenv 调用数组、注册函数、重置、每场景注册与断言；修改场景标题 | app 调用一次、env 对象 identity、配置错误日志/退出码、未知错误原对象；console/exit 恢复 |
| daily 工具入口测试 | dotenv 原始 exports、重装 mock、计数器及恢复验证分支 | SDK/auth exports 恢复、identity/次数验证、argv、OAuth 提示、精确查询参数、空行情正常结束 |
| mean 工具入口测试 | 同上 | 最近交易日/分钟线参数、表格数值与列、无交易日错误、退出码、所有全局恢复 |
| history 脚本测试 | dotenv mock、fake mutation、dotenvCalls/probe 专属字段及断言 | 离线子进程、认证 env identity、config 转交、两类订单查询、退出码、低价优先整笔扣减 |

补充要求：

1. history 导入安全用例不能整段删除，也不能留下一个永远零调用的不存在模块 mock。改为证明过滤 helper 可导入、导入时 auth/context/query 均未调用、测试哨兵环境键未被修改。
2. history 现有 `--no-env-file` CLI 用例只证明“消费预置环境执行查询”，重命名说明，不能再把它当作 Bun 文件加载证据。
3. daily/mean 的 SDK/auth mock 恢复链保持完整；删除 dotenv 分支不等于删除 `mock` import 或整个恢复函数。
4. 主入口补 `AppStartupAbortError` 的窄断言：退出码 1，不重复打印未知异常。它直接保护本次触及入口的既有分支，不扩展异常框架。
5. 原订单过滤用例仍要求只保留 `BUY-HIGH`；原分析指标的准确数值和输出列断言不得弱化成“有输出”。

### 5.4 新增验证：小范围、真实原生加载

新增 `tests/index.environment.test.ts`，专门验证主入口启动环境契约：

- 使用临时 cwd、合成环境文件和现有 `createChildEnv`。
- 将 `createChildEnv` 的 `NODE_ENV=test` 按用例显式覆盖；需要默认 `.env.local` 的用例使用 development 或移除该键。
- 通过测试专用 preload 在导入真实主入口前 mock `runApp`，读取传入 env 和真实 `IS_DEBUG`；不运行 app 组装/SDK。
- 真正启动 Bun 子进程并执行源码入口，不能 mock Bun 环境加载或仅在父测试中手工写 `process.env` 冒充加载验证。
- 包脚本路径用临时 package 保持 `bun <entry>` 命令结构；同时核对项目正式 `start` 未改变，避免只验证一段脱离项目的示例。
- helper 留在本测试中；复用现有 `createChildEnv`，不新增通用进程启动库。测试类型如确有需要放既有适用 `types.ts`，不为一行参数制造类型层。

工具的加载和认证连接证据放各自测试：

- daily/mean 各补一个临时 cwd、真实 Bun 加载、mock auth/SDK 的窄成功场景；断言文件哨兵在认证调用时已存在，查询参数继续由原测试保护。
- history 复用其隔离子进程能力，增加真实主模块执行且原生加载的场景；保留 import helper 的独立安全用例。按需对本地 helper 增加最小参数，不建立全仓 runner。
- 新增 `tests/infrastructure/longbridge/trade/getWarrants.business.test.ts`，与已有手工查询脚本测试归属一致：真实 Bun CLI、mock auth/QuoteContext，返回空列表；断言 env 转交、argv 的 symbol/bull/bear 选择、warrantList 参数和成功退出。再用 auth 失败断言原错误输出/退出码 1；不为提高覆盖率重复完整筛选算法。

这些测试只 mock 应用或外部服务边界。现有 offline guard 必须先安装；真实 OAuth、行情/交易工厂在漏 mock 时应失败关闭，不允许回退到网络。

### 5.5 依赖、文档与产物

- 从 `package.json` 删除 dotenv；不要顺带升级其他包或修改启动脚本。
- 用 Bun 更新 `bun.lock` 和安装状态，确认 dotenv 没有直接/传递引用。锁文件变更应只涉及移除及工具必要元数据，不接受无关批量升级。
- 不添加 dotenv 替代包，不保留临时兼容依赖或用于对比的旧包 alias。
- README 增加一处环境加载说明：正常根目录启动、父环境优先级、test 例外、原生变量展开、非根 cwd、显式文件与纯外部环境模式。
- README 测试示例使用 `bun --no-env-file test`，同时说明正式验收还要隔离父环境；不把此命令描述成自动清空父凭证。
- `.env.example` 的业务键值不变；如确需说明原生加载，只补最少注释，不改格式或配置值。
- 清理旧 dist 后重新 build，检查 `dist/src/index.js` 不再导入 dotenv，不手改产物。

历史材料不是运行期依赖：

- `docs/architecture/architecture-refactoring-audit-evidence/...` 中旧版本和测试记录保留事实。
- `docs/plans/2026-09/single-active-strategy-runtime-*.md` 的“当时不改变 dotenv”是历史范围约束，不应批量改写。本文明确在环境加载职责上取代旧约束。
- `docs/plans/performance-optimization-audit.md` 关于当时 Bun 已预加载的结论仍属基线证据。
- 零残留标准适用于依赖与可执行代码；本文、版本历史和审计记录中的名称不属于未完成迁移。

## 6. 严格验证矩阵

### 6.1 环境与入口行为

| 编号 | 场景 | 验收要求 |
| --- | --- | --- |
| E1 | 根目录正常默认启动 | 与基线有效配置一致，主入口恰好传入当前 `process.env` |
| E2 | `.env`、环境专属文件、`.env.local`、环境 local 文件同名冲突 | 保留 Bun 当前分层优先级，不隐式缩减为单文件 |
| E3 | 父环境与文件同名，含父环境空字符串 | 保留父环境值；缺失与空值仍由原校验区分 |
| E4 | `DEBUG=true/false` 与静态 import | `IS_DEBUG` 在模块求值时已反映正确值，无晚加载窗口 |
| E5 | `.env.example` 脱敏模板 | 49 个既有配置键语义与基线一致，不打印值；未来模板变化以新基线重测 |
| E6 | 合成引号、空值、注释、转义美元及变量引用 | 默认 Bun 路径与旧组合一致；不新增 dotenv 解析副本 |
| E7 | 默认环境文件缺失、父环境完整 | 不增加文件必需检查，仍消费外部环境 |
| E8 | 关键配置缺失/非法 | 原策略/配置校验拒绝，SDK 工厂调用数为零；错误分类和退出语义保持 |
| E9 | `NODE_ENV=test` | 不默认补读 `.env.local`；需要的测试数据只能来自 fixture/显式输入 |
| E10 | 显式 `--env-file` | 只加载所选文件，不由应用补读默认文件；只断言应用契约，不假设缺失文件必然 fatal |
| E11 | `--no-env-file`、无显式文件 | 临时 `.env*` 中的哨兵不进入应用；父环境仍保留 |
| E12 | 非根 cwd、带空格路径 | 显式绝对 env/script 路径或 `--cwd` 正常；不自动寻找脚本旁真实凭证 |
| E13 | package `start` 与直接入口 | 两种正式支持路径有效配置一致；不假设外层参数可控制内层 Bun |
| E14 | 五个入口实际连接 | app/auth 收到原生加载的环境，argv、查询参数与退出码保持 |

E9–E12 涉及 §4 中明确废弃的隐式补读，不以旧 mock 次数作为一致性判据。若部署依赖该行为而尚未完成启动命令迁移，视为发布阻塞，不以测试通过掩盖。

### 6.2 业务回归与构建

保持并运行：

- 四个既有入口测试及新增原生加载/手工工具测试。
- `tests/config/`，特别是金融文本、认证配置、fail-fast 和宿主配置边界。
- `tests/app/startup/prepareStrategy.test.ts`、`createSelectedStrategy.test.ts` 及现有 app 装配相关测试。
- `tests/infrastructure/longbridge/trade/` 中认证、配置工厂与 SDK 边界测试。
- `tests/integration/singleActiveStrategyExecution.integration.test.ts`、`strategyRecoveryStartup.integration.test.ts`、`startupSettlementReadiness.integration.test.ts` 等现有集成，再运行完整离线测试套件。
- 正式 build 与 `tests/build/productionBuild.test.ts`，保留 source/dist 和静态 JSON 资产检查。

不重写交易逻辑来适应测试。出现未通过项必须定位，不删除失败断言、放宽期望或只重跑成功子集。

### 6.3 安全执行要求

1. 不运行真实 `bun start`、工具或 OAuth 作为验收；所有入口 smoke 都在隔离子进程中拦截 app/auth/SDK。
2. 子进程只继承 `createChildEnv` 允许的系统键，临时 HOME、缓存、日志目录全部隔离。
3. `--no-env-file` 用于普通回归；加载测试主动开启原生加载，但 cwd 和文件只能在临时根。
4. mock/preload 必须先于实际入口静态导入。测试构建不能为了注册 mock 而先导入会请求 SDK 的工具入口。
5. 不输出整个环境、凭证、token cache 或真实文件内容；只回传哨兵、布尔结果、键名和业务断言结果。
6. 临时文件在 `finally` 清理；超时/失败不启动真实服务，不遗留后台进程。

### 6.4 检查顺序

实施前先记录 git 状态、Bun 版本和定向基线；实施后在隔离环境中按下列顺序执行。命令示意以项目根目录为 cwd，正式执行需配合上面的环境白名单，不另建生产 launcher。

```powershell
# 项目规定的必需检查顺序
bun lint:fix
bun type-check

# 先验证此次直接改变的契约
bun --no-env-file test tests/index.business.test.ts tests/index.environment.test.ts tests/tools/dailyIndicatorAnalysis/index.business.test.ts tests/tools/meanDeviationAnalysis/index.business.test.ts tests/infrastructure/longbridge/trade/getHistoryOrders.business.test.ts tests/infrastructure/longbridge/trade/getWarrants.business.test.ts

# 完整离线回归，包含配置、SDK 边界、业务集成和临时工程构建测试
bun --no-env-file test

# 清理并重新生成仓库实际 dist，不能被临时工程构建测试替代
bun run build
```

`tests/build/productionBuild.test.ts` 在临时工程内执行构建并清理临时目录，只能证明构建流程与隔离产物正确，不会刷新仓库的旧 `dist`。因此交付前仍须在仓库执行一次上述 build，确认 clean + tsc 成功且 `dist/src/index.js` 不含旧导入；不手工编辑产物。此后只有失败、新改动或未解决疑点才触发相关重跑。

最后：

- 检查 lint 自动修复没有带入无关重构。
- 检查 production/test/utils/tools、package、锁文件、dist 中的 dotenv 引用。
- 检查新的未使用 import、路径变量、类型字段、mock 恢复分支和过时场景标题。
- 用受控安装验证锁文件可复现，且全套测试不再依赖残留 `node_modules/dotenv`；安装过程仍禁止读取真实凭证或触发业务。
- 报告实际命令、退出码、通过/失败数量、未验证边界，不以“静态看起来安全”代替验收。

## 7. 实施工作包

### WP1：固定基线与迁移前提

- 重新确认五个入口、四个测试及锁文件引用没有变化。
- 记录已有脚本、Bun 版本、定向测试结果。
- 核对部署实际 cwd、NODE_ENV、是否依赖显式文件补读或 Node；只记录启动方式，不读取或输出密钥。
- 发现 §4 的特殊依赖时，先明确目标启动命令和脱敏等价样例；交易配置差异未解释前不得发布。

### WP2：一次完成代码与测试脱钩

- 按 §5 删除生产调用和无用路径代码。
- 同步移除测试中的 dotenv mock/恢复，不保留过渡层。
- 保留业务断言，增加原生加载和缺口测试。
- 移除 package 依赖并更新锁文件；新测试的期望使用固定合成数据，不在运行时重新加载旧 dotenv 做 oracle。

### WP3：验证、文档与收口

- 执行 §6 检查，处理本次引入的所有失败。
- 更新 README 和脚本用法，记录已废弃补读/Node 路径。
- 清理并验证 dist、依赖图、测试导入、mock 和文档连接。
- 只有全部验收项满足后才能将本文状态改为已实施，并追加真实结果。

## 8. 非目标与禁止引入的复杂度

- 不新增 env loader、配置 service、事件链、factory、wrapper CLI 或 Bun/Node 探测分支。
- 不手写 `.env` parser，不加 dotenv-expand，不保留旧库 fallback。
- 不为找不到文件自动改 cwd、搜索仓库根、切换文件或给配置补默认值。
- 不批量更换 `process.env`，不更改现有业务配置读取接口。
- 不顺手改 `import.meta.main`、工具 runner、认证框架、日志架构、指标或订单算法。
- 不全局禁用 Bun 加载后再逐入口重建复杂规则。
- 不批量更新其他依赖，不改真实 `.env.local`，不删除历史审计事实。
- 不为覆盖率增加重复业务测试；新增测试只证明原生启动边界、五个入口连接和此次移除造成的真实风险。

## 9. 完成标准

- [x] package 和锁文件中没有 dotenv，依赖图不存在残留；可执行源码/测试不再 import、require 或 mock 它。
- [x] 五个入口只消费 Bun 已准备的 process.env，无自行读取 env 文件或兼容补读。
- [x] 正常 start 的文件层次、父环境优先级、静态读取时序通过隔离检查，公开模板与固定基线一致；不代表真实凭证已验证。
- [x] 用户确认仅在项目根目录常规 Bun 启动，不依赖特殊补读或 Node；目标命令和差异已记录。
- [x] 原业务断言保留，新增原生加载检查、全套离线测试、规定静态检查和实际构建通过。
- [x] src/dist 无旧依赖，README 与脚本命令一致，SDK/auth mock 恢复及离线 guard 完整。
- [ ] 无真实网络、交易、OAuth、密钥读取或非临时数据写入，无无关代码/依赖升级。**不标记通过：一次安装曾报告自动加载真实 .env.local，详见 §11.3。**
- [x] 交付报告区分已验证和未验证，不外推到其他平台、运行时或部署环境。

## 10. 参考

- [Bun 官方环境变量文档](https://bun.com/docs/runtime/environment-variables)：默认加载、显式文件、禁用加载、变量展开和读取接口；查询于 2026-10-23。
- [dotenv 17.4.2 实现](https://github.com/motdotla/dotenv/blob/v17.4.2/lib/main.js)：当前版本的加载与默认不覆盖行为。
- 仓库 `AGENTS.md`、TypeScript 项目规范：根因修改、清理相关调用、fail-fast、不添加兼容层及必需检查顺序。

本次本机实测优先于对其他版本行为的猜测。后续升级 Bun 时，应保留本方案的原生加载契约测试，不保留 dotenv 作为兼容保险。

## 11. 实施与验收记录（2026-10-23）

### 11.1 实施范围与确认

- 用户已确认：仅在项目根目录采用常规 Bun 启动，不依赖 test 模式补读、显式文件后补读、非根 cwd 隐式寻址或 Node 源码执行。
- 三个实施子代理分别负责主入口、两个分析工具、两个手工脚本；独立调用链审计、命令隔离实验和只读复核共同收口。
- 五入口仅删除 dotenv 及专用路径代码。保留静态导入、原始入口 env 转交、app 内已有 runtimeEnv 快照、校验顺序、认证、argv、查询、业务计算和退出分支。
- 四份原测试移除 dotenv 耦合；新增主入口原生加载与 getWarrants 测试，各工具增加原生加载到 auth 的连接检查。E1–E14 的代码与测试证据已逐项审阅。
- 既有 createPreGateRuntime.minimalGate 测试补充“缺失认证键/非法交易金额 → ConfigValidationError → 客户端工厂、行情创建、交易日查询均为零”。
- 完整隔离回归发现原 runtime 配置测试错误地把日志根写死为仓库 tests/logs，与既有 preload 保留显式路径的行为不符。改为两个真实隔离 preload 用例，分别验证默认路径和显式路径、强制 test 档位/禁用 hooks，以及目录创建；未改生产实现或放宽业务断言。
- package 只移除 dotenv；锁文件仅删除对应 7 行，其他包版本、校验和和平台元数据不变。Bun 更新曾重新格式化锁文件并去掉两项 libc 元数据，已保留原格式/元数据，最终冻结安装验证通过。
- README 更新加载规则、直接入口命令、非根 cwd、测试隔离与迁移边界；.env.example 的 49 个配置键和值、正式 start、bunfig.toml 均未修改。既有 pino 方案与历史审计记录未改写，原暂存内容未重置。

### 11.2 实际检查与结果

运行平台：Windows / Bun 1.4.3（c6da4a4d3）。普通验收使用 createChildEnv 白名单环境和临时 HOME/缓存/日志；为验收进程固定设置 BUN_OPTIONS=--no-env-file，避免包脚本内层 Bun 重新加载默认文件。原生加载测试自行构造子环境，不继承该开关，仅在临时 cwd 加载合成文件。

| 检查 | 实际执行 | 结果 |
| --- | --- | --- |
| 修改前基线 | bun --no-env-file test（§2.3 四文件） | exit 0；9 pass / 0 fail / 59 expect |
| 最终静态检查，依序执行 | bun --no-env-file run lint:fix → bun --no-env-file run type-check | 均 exit 0；784 files 无类型错误 |
| 六份入口/环境测试 | bun --no-env-file test（§6.4 六文件） | exit 0；31 pass / 0 fail / 176 expect |
| 日志隔离契约修复 | bun --no-env-file test tests/config/runtime/runtime.business.test.ts | exit 0；5 pass / 0 fail / 18 expect |
| 最终完整离线套件 | bun --no-env-file test | exit 0；3577 pass / 0 fail；323 files；23391 expect；268.88s |
| 仓库实际构建 | bun --no-env-file run build | exit 0；真实执行 bun run clean && tsc -p tsconfig.build.json |
| 冻结锁可复现安装 | 临时目录仅复制 package.json/bun.lock，执行 bun install --frozen-lockfile --ignore-scripts | exit 0；156 packages；锁文件未变化；无 dotenv |
| 产物与残留 | 扫描 src/tests/tools/utils/dist、package、lock 与安装状态 | dotenv/loadLocalEnv 代码引用 0；node_modules/dotenv 不存在 |
| diff 检查 | git diff --check | exit 0 |

首次完整套件为 3575 pass / 1 fail，唯一失败即 §11.1 的硬编码日志路径；定位并修正后重新依序通过静态检查与完整套件。开发期 lint/type 错误和子进程超时也已修正，未删除失败断言或只重跑成功子集。

最终 dist 共 366 个文件，全部位于 dist/src；旧 dist/tools 已由 clean 清除，策略静态 JSON 存在。src/index.ts 与 dist/src/index.js 均保留 runApp({ env: process.env })。完整套件包含配置、策略启动、SDK 边界、现有业务集成及 productionBuild source/dist 检查；独立审查再次确认产物残留问题关闭，当前范围无未解决的已确认代码缺陷。

### 11.3 安全执行偏差与处理

一次在仓库 cwd 执行的 bun --no-env-file install --ignore-scripts 虽然使用白名单环境，仍由 Bun 1.4.3 报告加载 .env.local。这不符合方案“真实文件不读取”的要求；发现后已立即告知用户，未主动查看或展示文件内容/环境值，未启动交易应用、查询工具、真实 SDK 工厂或 OAuth，安装生命周期脚本已禁用。不能据此宣称全过程完全没有真实环境文件读取，也不推断文件中是否含有效凭证。

随后只在临时合成目录实验：此版本 install 对 --no-env-file、BUN_OPTIONS 或临时 env=false 的保护均不可靠，因此不再在仓库 cwd 执行安装。冻结安装已移到只含公开清单/锁文件的临时目录。对于运行/检查脚本，合成哨兵验证确认固定 BUN_OPTIONS=--no-env-file 可约束内层 Bun，最终 lint/type/test/build 使用该隔离方式；未修改生产脚本或全局禁用正常加载。

没有执行真实交易、账户查询或 OAuth，未主动打印凭证或全量环境；真实 .env.local 未被编辑。安装涉及正常依赖下载，不能将“未连接券商业务服务”扩大为“全过程无任何网络”。临时测试目录均清理；仓库 node_modules、锁文件和 dist 的必要更新属于本次交付，不应表述为完全没有非临时写入。

### 11.4 未验证边界

- 未读取真实配置内容进行新旧逐值比较，未验证真实账户、token cache、交易或部署进程。
- E5/E6 是公开模板及合成数据的固定预期验证，不使用已移除库作为运行时 oracle。
- E8 由入口错误分类、真实配置校验/零 SDK 调用与既有 app 集成共同覆盖，不冒称启动了真实完整交易系统。
- 结论仅限本机 Windows / Bun 1.4.3 和用户确认的启动方式；其他版本、平台及隐藏部署命令不在本次实测范围。
