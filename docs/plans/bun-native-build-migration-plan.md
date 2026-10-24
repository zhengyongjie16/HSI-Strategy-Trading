# Bun 原生高性能构建迁移方案

> 状态：待实施。本文仅记录最终迁移方案，不表示构建入口、配置或测试已修改。
>
> 复核日期：2026-10-24。当前代码基线：`4127092aee4ea52edb99d51e0e7942f72a458bc9`。已验证环境：Windows x64 / Bun 1.4.4 / TypeScript 6.0.3 / Longbridge 5.2.2。
>
> 前期隔离原型已验证 Bun 构建及产物运行的可行性；正式脚本、统一清理命令、依赖移除、ESLint 接入和完整验收仍按本文实施。本文交付不修改生产代码，不读取真实凭证，不启动交易程序。

## 1. 最终决策与需求边界

采用 **`scripts/build.js` 统一清理 + Bun 原生类型检查和多文件构建 + 自动 JSON 资源输出**，替换现有 `tsc` 生产构建，并移除 `rimraf` 开发依赖。

正式命令固定为：

```json
{
  "clean": "bun --no-env-file scripts/build.js --clean-only",
  "build": "bun --no-env-file scripts/build.js"
}
```

用户仍只执行：

```sh
bun run build
```

命令成功后即获得完整产物，不需要手动复制 JSON，不增加额外的使用步骤。

### 1.1 必须满足

1. 验收目标是**构建后的应用功能一致且正常运行**，不是生成代码逐字节一致，也不是两个检查器的所有诊断完全相同。
2. 由 Bun 完成全部生产 JS 的转译与构建前类型检查，不采用 TypeScript 混合发射。
3. 由 `scripts/build.js` 统一负责初始清理、独立清理及构建失败清理；构建前必须等待清理成功，失败时不得继续。保留 `bun run clean`，移除 `rimraf`。
4. 正式构建入口使用 JavaScript：`scripts/build.js`，不增加对应的 TS 版本，也不先编译构建脚本。
5. `tools/` 仅用于非生产临时工具，不能存放正式构建所需脚本；本次不修改该目录。
6. 保持 `dist/src` 布局、独立 JSON 文件、动态策略加载及产物启动命令不变。
7. 优先在构建侧解决问题。现有验证未发现必须修改业务代码的阻碍，本次不改 `src/`。
8. 构建失败返回非零状态，并清理本次不完整产物；不回退到 tsc，不保留失败产物继续运行。

### 1.2 明确不做

- 不打成单文件，不生成可执行文件，不启用压缩、代码拆分或字节码模式。
- 不调用 TypeScript Compiler API 解析依赖图或发射 JSON/枚举文件。
- 不替换或硬编码 SDK 枚举，不引入业务兼容层。
- 不新增策略注册表，不修改策略加载器，不执行策略模块来发现资源。
- 不引入新的依赖、通用资源框架、插件系统或双构建回退路径。
- 不为了检查一个 JS 脚本开启全项目 `allowJs` / `checkJs`，不把它加入 `tsconfig.json`。
- 不删除 TypeScript 依赖：ESLint 和现有测试仍使用它。
- 不要求普通 JS 的注释、格式、哈希、堆栈行号与 tsc 相同；不新增 Node 运行支持或 ES2022 降级兼容承诺。

## 2. 当前事实与选择理由

### 2.1 当前构建和加载路径

| 位置 | 当前职责 | 迁移约束 |
| --- | --- | --- |
| `package.json` | build 为 `bun run clean && tsc -p tsconfig.build.json`，clean 为 `rimraf dist`；`type=module` | build/clean 统一调用 ESM 格式的 `scripts/build.js`，删除 `rimraf` 依赖 |
| `tsconfig.build.json` | 生产范围为 `src/**/*`，输出 `dist`，关闭声明和 source map | 保留作为 Bun 生产类型检查配置；输出布局由 Bun CLI 参数明确指定 |
| `src/app/startup/prepareStrategy.ts` | 依据模块 URL、扩展名和相对路径定位策略 | 必须保留独立模块路径和 `dist/src` 布局 |
| `src/app/startup/strategyLoaderHelpers.ts` | 检查真实的 definition 和 `config.json` 文件，再加载唯一策略 | JSON 必须实际存在，不能只内联成 JS 对象 |
| `src/strategies/intradayRegression/definition.ts` | 静态导入同目录 JSON，在 `prepare()` 中校验 | 构建只处理依赖，不执行策略准备或 SDK 工厂 |
| `tests/build/productionBuild.test.ts` | 复制临时工程并执行真实 package 构建命令 | 必须复制新的正式构建入口，保留行为断言 |
| `eslint.config.js` | 全局启用类型感知规则，并忽略 `scripts/**` | 需要取消忽略，增加 JS 专属非类型感知配置 |

Bun 的 `--target=bun` 选择运行环境，并不等同于 tsc 的 `target=ES2022`。本方案以现有 Bun 运行环境上的功能验收为准。

### 2.2 为什么需要一个小型构建入口

本机 Bun 1.4.4 已支持 `--no-bundle` 和 `--check`，但仅传入 TS 入口时，不会自动复制其中引用的 JSON。

已排除以下做法：

| 做法 | 排除原因 |
| --- | --- |
| 只构建 `src/index.ts` 并打包 | 动态发现的策略未必进入静态入口闭包；模块相对位置也发生变化 |
| 将 JSON 作为普通入口 | 实测输出 `config.js`，不满足加载器的独立 JSON 文件要求 |
| `--no-bundle` 配合 `.json:file` | 本机 Windows 验证触发 Bun 崩溃，不能作为正式方案 |
| 全目录复制所有 JSON | 会包含未使用的配置或半成品，不必要地扩大产物范围 |
| TypeScript 依赖图、JSON emitter、枚举混合发射 | 为保留编译器实现细节增加成本，不符合本次功能一致和高性能目标 |

`scripts/build.js` 仅负责构建生命周期：清理、组织原生构建和补齐资源输出，不是第二套编译器或通用清理工具。

### 2.3 SDK 枚举不再作为混合编译理由

前期验证中，生产代码实际使用的 18 个 SDK 枚举、86 个成员、152 处引用，其声明值与实际运行时值全部一致。

Bun 会保留一些被 tsc 内联消除的 SDK 导入边。这是模块实现差异，不自动等同于应用功能错误：

- 源码本来就通过 Bun 启动，使用 SDK 运行时枚举。
- 正常生产入口已有 SDK 静态加载链。
- 业务资源创建仍由原工厂和门禁控制；不得将 SDK 模块加载等同于已调用 OAuth 或创建交易 context。
- 生成 JS 的离线业务验证未发现相关功能回归。

因此全部 JS 统一由 Bun 发射。SDK 或 Bun 升级后重新运行离线边界与产物测试，不为数值或加载边形式保留 tsc 分支。其他平台原生包及 native 初始化内部行为不在已完成验证的保证范围内。

### 2.4 为什么可以移除 rimraf

当前 `rimraf` 仅用于 `package.json` 的 `clean` 命令；`bun pm why rimraf` 确认只有项目自身这一项直接开发依赖，没有其他包依赖它。现有命令只删除固定的 `dist`，没有使用过滤、通配匹配等扩展能力。

[Bun 官方目录删除指南](https://bun.com/guides/runtime/delete-directory)支持使用 `node:fs/promises.rm` 配合 `recursive: true`、`force: true`。这是 Bun 实现的标准文件 API，不需要另装 Node，也不增加依赖。初始、独立和失败清理均复用这一能力即可；文件占用等错误的处理边界见 §4.4，最小探针证据及其限制见 §8。

## 3. 目标目录和命令契约

```text
scripts/
└── build.js                 # 正式构建与清理入口，不进入产物
src/                         # 生产应用源码，不修改
tools/                       # 非生产临时工具，不参与本次迁移
dist/
└── src/
    ├── index.js
    ├── app/startup/prepareStrategy.js
    └── strategies/intradayRegression/
        ├── definition.js
        └── config.json
```

正式使用入口为 `bun run build`，直接进入脚本的默认构建模式，依次完成清理、Bun 类型检查/构建和 JSON 输出。package 不再额外串联 `bun run clean`，避免重复初始清理。直接执行 `bun --no-env-file scripts/build.js` 也具有完整 clean-build 语义。

`bun run clean` 调用同一脚本的 `--clean-only` 模式，只清理产物，不检查类型或执行构建；不新增第二份清理脚本。脚本读取 `process.argv.slice(2)`，只接受无参数或单个 `--clean-only`；其他参数组合必须在任何删除操作前报错并非零退出，不把参数错误误当成构建请求。

构建脚本根据自身位置推导根目录，例如 `path.resolve(import.meta.dirname, '..')`，清理目标固定为该根目录下的 `dist` 绝对路径，不接受用户传入删除路径。内部路径不依赖调用者 cwd，子进程明确使用该根目录作为 cwd。从其他 cwd 直接调用时使用脚本绝对路径，不删除调用者 cwd 下的同名目录。

成功后的启动方式保持：

```sh
bun dist/src/index.js
```

这是正式部署启动命令，不是迁移验收时可以直接执行的实盘测试命令。

## 4. `scripts/build.js` 的实现规格

脚本保持单文件，职责限定为构建生命周期；`--clean-only` 只复用其中的产物清理能力。使用 ESM、顶层 `await` 或一个明确的主函数，不新增泛化构建模块、配置 DSL、独立清理模块或对外运行时接口。

### 4.1 枚举生产 TS 入口

仅在默认构建模式、初始清理成功后，使用 `Bun.Glob` 在项目根目录枚举 `src/**/*.ts`：

- 只收集文件，排除 `.d.ts` 转译入口，排序后使用稳定的相对路径。
- 覆盖所有生产模块，尤其是不能从主入口静态遍历到的策略 definition。
- 不将 `scripts/`、`tools/`、`tests/`、`mock/`、`node_modules/` 或日志数据目录作为生产入口。
- 没有生产入口时直接失败，不能把空构建当作成功。

当前工程的生产模块形态为 `.ts`，入口枚举与现有 `src/**/*` 生产范围一致。不要误以为 `--tsconfig-override` 会替代入口枚举；今后改变生产目录或文件种类时，应同步更新这一明确契约，而非预先编写通用 tsconfig 文件选择器。

### 4.2 执行原生构建

使用 `Bun.spawn()` 参数数组，执行当前 Bun 二进制 `process.execPath`，不拼接 Shell 命令，也不依赖终端展开通配符：

```text
<process.execPath> --no-env-file build
  --no-bundle
  --check
  --tsconfig-override <root>/tsconfig.build.json
  --target=bun
  --format=esm
  --root <root>
  --outdir <root>/dist
  <全部生产 TS 相对路径>
```

- 不启用 minify、splitting、sourcemap、compile 或环境变量内联。
- `--check` 使用全部入口及其依赖，不只检查主入口；静态导入的类型依赖仍参与检查。
- `tsconfig.build.json` 继续承载生产检查的严格选项、类型范围与解析配置。它不是 Bun 自动执行 tsc 发射选项的承诺。
- 不再额外执行一次 `bun check` 或 `tsc --noEmit`，避免同一次构建重复检查。
- 透传错误诊断，正确消费或继承子进程管道，等待进程退出；非零退出码立即失败。
- 脚本和构建子进程均明确禁用自动环境文件加载，不引入 `--env` 或 `define` 注入应用环境。

`--no-env-file` 不会清除父进程已经存在的环境变量。脚本不得读取、复制或打印真实凭证，离线测试仍需使用白名单子进程环境，不能仅凭这个参数声称整条进程链没有环境输入。

### 4.3 扫描实际运行依赖并输出 JSON

在 JS 构建成功后执行：

1. 按入口与产物的对应关系读取生成 JS。
2. 使用一个 `Bun.Transpiler({ loader: 'js', target: 'bun' })` 实例调用 `scanImports()`。
3. 收集 `.json` 运行时导入，包括静态导入和字面量动态导入。
4. 相对对应源模块所在目录调用 `Bun.resolveSync()`，解析源 JSON 的真实位置。
5. 验证其为生产 `src/` 内的本地资源，按项目相对路径去重；解析失败或越界直接报错，不改为猜测路径或复制其他目录。
6. 使用 `Bun.file()` 读取、`Bun.write()` 写入相同相对路径下的 `dist` 文件。

例如：

```text
src/strategies/intradayRegression/config.json
→ dist/src/strategies/intradayRegression/config.json
```

资源写入采用直接、可等待的顺序流程即可，当前只有一个生产 JSON。不要为了并发复制极少量资产增加调度器；如果实施时使用并发写入，必须先等待全部写任务结束，再处理失败清理，避免删除 dist 后仍有在途写入重建半成品。

JSON 内容原样输出，不调用策略 parser、不执行 DSL 校验、不冻结或改写配置对象。资源为标准 JSON；可读性及导入错误必须通过构建检查和加载验收暴露，不能把资源复制成功等同于策略配置有效。

| 资源情形                                 | 目标行为                                             |
| ---------------------------------------- | ---------------------------------------------------- |
| 被生成 JS 静态导入的 JSON                | 复制并可从 dist 加载                                 |
| `import('./config.json')` 字面量动态导入 | 同样复制                                             |
| 仅用于类型且已从 JS 删除的 JSON 导入     | 不输出该资源；仍服从构建类型检查                     |
| 未引用的坏 JSON / 半成品目录             | 不读取、不解析、不复制，不使构建失败                 |
| 缺失的静态导入 JSON                      | 构建失败，不产生可用旧产物                           |
| 运行时计算路径、文件系统任意读取         | 本次不提供自动发现能力；现有生产 JSON 不使用这种方式 |
| 源码范围外的 JSON                        | 明确失败，不默默复制 node_modules、工具或数据目录    |

当前策略 `config.json` 既是加载器要求的文件，也是 definition 的实际运行时导入，因此会被该流程收集。动态加载 definition 本身则由“全部 TS 入口均发射”解决，两者不能混为一谈。

### 4.4 清理生命周期、失败与退出

使用一个模块内的 `cleanDist()`，统一服务初始清理、`--clean-only` 和构建失败清理。其内部等待 Bun 支持的标准文件 API，不创建额外清理子进程：

```javascript
await rm(distDir, { recursive: true, force: true });
```

`rm` 从 `node:fs/promises` 导入，`distDir` 为 §3 中固定的项目 `dist` 绝对路径。

执行顺序固定为：

1. 验证参数并确定模式；无效参数不得清理或构建。
2. 执行并等待初始 `cleanDist()`。失败时直接报告并非零退出，不启动构建，也不再进入构建失败分支重复尝试清理。
3. 若为 `--clean-only`，清理成功后直接返回；脚本不枚举 `src/`，不主动读取或校验 tsconfig，也不创建构建专用对象、启动编译子进程或处理资源。即使源码缺失或有类型错误，独立清理也不受影响。
4. 默认模式才执行入口枚举、Bun 类型检查/构建及 JSON 输出；成功后保留完整 `dist`，不在 `finally` 中无条件删除产物。
5. 进入构建流程后，入口枚举、类型检查、转译、扫描、解析、读取或写入失败时，先等待已启动的构建/写入操作结束，再调用同一个 `cleanDist()` 删除旧产物或半成品；不递归调用 `build`，不启用另一个编译器重试。

错误与退出约束：

- `force: true` 只允许目标不存在，不代表忽略权限、文件占用等错误。初始清理和独立清理遇到这些错误都必须失败；不默默继续、不改用 Shell 命令或移动删除，也不为复刻 rimraf 的平台专用策略增加重试或 fallback。
- 保留主要构建错误，失败清理本身若再失败，也必须单独明确报告，整体仍非零退出；不能在清理失败时宣称产物已删除。
- 必须等待清理结束后退出，不能先调用 `process.exit()` 截断异步工作。
- 不在每个文件上增加兜底、跳过、降级或重试。

成功构建时可输出 JS 数量、JSON 数量和耗时摘要。摘要是诊断信息，不成为业务协议或测试中固定的产物数量断言。

## 5. 逐文件迁移清单

| 文件 | 修改内容 |
| --- | --- |
| `scripts/build.js` | 按 §4 新增正式 JS 构建与清理入口，包含默认构建、`--clean-only` 和共享 `cleanDist()`；文件头说明职责，关键资源与清理逻辑保留必要中文注释 |
| `package.json` | 按 §1 修改 build/clean 命令并移除 `rimraf` 开发依赖；保留 start/type-check/test 等其他命令和其他依赖 |
| `bun.lock` | 由 Bun 随依赖移除同步更新，清除 `rimraf` 及其不再被任何包使用的间接依赖；保留共享依赖和其他包版本 |
| `eslint.config.js` | 取消 `scripts/**` 忽略，新增仅作用于 `scripts/**/*.js` 的非类型感知 JS 检查，见 §6 |
| `tests/build/productionBuild.test.ts` | 临时工程复制 `scripts/build.js`，更新 build/clean 命令断言、名称和注释，保留原功能断言并扩展清理与资源用例 |
| `tests/infrastructure/logger/processFixture.ts` | 如保留产物对照验收，将硬编码 logger `.ts` 运行 URL 改为 `.js`；Bun 源码模式仍可解析到 TS，必须同时验收 |
| `tests/app/shutdown/createCleanup.business.test.ts` | 同上，将子进程中的 cleanup `.ts` 运行入口改为 `.js`，不改变断言或 cleanup 行为 |
| `README.md` | 更新 build/clean 常用命令及“单活跃策略与构建资产”说明，删除现行构建依赖 tsc 或 rimraf 的陈述 |

明确保持不变：

- `tsconfig.json`：不新增 scripts include，不开启 `allowJs` / `checkJs`。
- `tsconfig.build.json`：不为构建脚本扩大生产范围；类型检查配置继续使用现有文件。
- `bunfig.toml`：不全局关闭应用环境加载，不改变测试 preload。
- `src/`、`tools/`、`utils/`：不修改业务实现或临时工具。

依赖调整仅限移除 `rimraf` 及其失去引用的间接依赖。使用 `bun --no-env-file remove rimraf` 同步更新 `package.json` 与 `bun.lock`，审查锁文件差异，不手工删除共享依赖，不顺带升级其他包；TypeScript 及 ESLint 等依赖继续保留。

历史计划文档描述的是当时基线，不需要为了清除 tsc 或 rimraf 字样而批量修改；仅同步当前生效的命令、说明和测试连接。

## 6. JavaScript 构建入口的 ESLint 配置

只取消 `scripts/**` 忽略还不够。当前全局配置启用了 `projectService: true` 和 TypeScript 类型感知规则，而新的 JS 文件故意不属于 TypeScript 项目。

处理方式：

1. 从最终全局 ignores 中移除 `scripts/**`，保留其他忽略项。
2. 在现有通用配置之后增加 `files: ['scripts/**/*.js']` 的局部覆盖。
3. 使用已有 `tseslint.configs.disableTypeChecked` 关闭该范围内需要类型信息的规则及项目服务。
4. 应用 `js.configs.recommended`，明确启用正常 JS 可靠性检查，例如 `no-undef`。
5. 仅声明脚本实际使用的 Bun/Node 全局变量，不新增 globals 依赖，不直接继承 tests/tools 的宽松配置。

与现有 `defineConfig` 兼容的覆盖形态为：

```javascript
{
  files: ['scripts/**/*.js'],
  extends: [tseslint.configs.disableTypeChecked, js.configs.recommended],
  languageOptions: {
    sourceType: 'module',
    globals: {
      Bun: 'readonly',
      process: 'readonly',
      console: 'readonly',
    },
  },
}
```

若实现使用额外的运行时全局，只声明实际使用者；优先使用现有 Node 模块 import。其他非类型感知项目规则继续生效，不为方便编写脚本大范围关闭规则。

本轮已在**内存配置**中验证上述合并方向：`scripts/build.js` 不再被忽略，`project=false`、`projectService=false`、`no-undef` 为 error，简单 Bun/Node 全局调用无诊断。尚未落地 ESLint 配置，也未对最终构建脚本执行 lint；实施后仍需验证实际文件。

## 7. 测试迁移与验收

### 7.1 原有构建契约全部保留

修改临时工程 fixture 时，创建 `scripts/` 并只复制 `scripts/build.js`，不复制整个 tools 目录。继续执行临时工程真实的 `bun run build`；清理用例同样执行真实的 `bun run clean`，不得在测试中实现一套替代构建器或清理器。

更新首项测试的旧命令断言和 clean + tsc 标题，明确断言 §1 中的新 build/clean 命令；将 `noEmitOnError` 相关说明改为实际的“类型检查失败、构建失败后无产物残留”行为，而不是假称 Bun 使用了 tsc emitter。

保留以下覆盖：

1. JSON 内容更新后的重新构建和正确加载。
2. 策略新增后可加载，删除后旧产物消失。
3. 构建不执行 `prepare()`；业务 schema/DSL 错误仍由所选策略启动时校验。
4. 未选策略零执行，未导入的坏 JSON 不阻断构建。
5. 移走原 src 后，实际 dist 布局仍可加载策略，不回退源码。
6. 删除产物中必需 JSON 后，启动按原边界失败。
7. source/dist 均能完成独立策略的 prepare → create → 行情事件 → 决策队列 → destroy。
8. 无主入口引用的生产 TS 发生类型错误时，构建同样失败。
9. 缺失导入 JSON 时构建失败，不能保留之前成功构建的入口 JS。

### 7.2 只补充有价值的清理与资源检查

复用现有临时工程机制，集中覆盖清理契约，不为内部函数增加生产测试接口：

- `bun run clean` 删除嵌套产物；目录不存在或连续执行时成功。移走源码或制造类型错误后仍可独立清理，不创建新产物。
- 默认构建会删除预置旧产物，不依赖 package 在脚本外先执行一次 clean；已有策略删除后旧产物消失的断言继续保留。
- 在非项目 cwd 用绝对路径执行脚本的 `--clean-only`，只删除项目 `dist`，保留调用者 cwd 下的同名目录及项目内非产物文件。
- 无效参数非零退出，且保留预置产物，证明参数校验先于删除。
- 以真实文件系统失败验证初始清理失败后不进入类型检查、构建或资源写入；Windows 可使用隔离文件的独占占用，不通过生产开关模拟失败。

资源场景扩展或增加一项集中检查：

- 嵌套路径 JSON 与字面量动态 JSON 均能从产物导入。
- 标准 JSON 的中文、数组、null 和 `__proto__` 自有属性保持原运行值。
- 类型专用 JSON 不再输出，且运行功能不依赖它。
- 未引用坏 JSON 不输出。
- 已发射 JS 后的资源处理失败仍返回非零并删除半成品；通过隔离的真实文件失败或明确的测试边界构造，不增加生产测试接口。
- 空格/中文工程路径、非项目 cwd 的加载、稳定的源/产物布局继续覆盖。

不把 JS 格式、哈希、SDK import 数量或 365 这一当前文件数量作为长期业务断言。也不复制业务算法来制造新期望。

### 7.3 源码与生成 JS 的离线对照

常规回归继续保留上述实际 dist smoke；本次正式迁移及今后 Bun/SDK 升级，另外执行一次较完整的源码/产物对照。

对照方法：

1. 将可信源码、测试及测试直接依赖复制到隔离工程，不复制真实 `.env.local`、业务数据或日志。
2. 使用相同测试和输入先运行源码基线，再执行新构建。
3. 保留原源码供只读 AST 检查；将运行时使用的生产目录替换为生成 JS，明确检查其中没有 TS 文件，防止 Bun 回退源码。
4. 已知 logger 和 cleanup 测试的硬编码运行入口按 §5 改为 `.js`，两种模式都需要验证。
5. `tests/app/lifecycle/lifecycleChecklist.wiring.test.ts` 的 `sourceNodes()` 属于仅读取原 TS 的静态检查。在隔离夹具中将它的读文件路径指向保留源码，运行时 import 仍指向 JS；不得把 AST 检查误标为 JS 运行验证，也不向生产代码增加路径切换或回退。
6. 对两种运行对象使用同一组业务断言；不通过删除失败断言使产物通过。
7. 与“移走 src 后加载真实 dist”的构建 smoke 结合，分别证明业务行为和部署目录契约。

前期对照覆盖的目录为：

```text
tests/app
tests/application
tests/config
tests/domain
tests/infrastructure
tests/integration
tests/runtime
tests/strategies
tests/utils
```

这不是整个仓库测试集合，不能据此声称所有 architecture、tools、根级入口等测试都已通过。正式迁移还必须执行完整 `bun --no-env-file test`。

隔离工程需要保留测试直接依赖的辅助文件，例如 `tools/dailyIndicatorAnalysis/`、`tools/utils.ts` 和 `utils/` 手工脚本；这些是测试输入，不会成为生产构建入口。Windows 下使用真实规范大小写的工程路径，避免 file URL 大小写差异使 `mock.module` 未命中。

### 7.4 离线安全约束

- 子进程使用现有 `tests/setup/childEnv.ts` 的白名单环境，禁止继承真实认证变量。
- 使用 `--no-env-file` 和现有 `tests/setup/testRuntime.ts` / SDK 离线 guard。
- 不创建真实 QuoteContext、TradeContext 或 OAuth，不访问账户，不进行实盘试单。
- guard 保护已知工厂，不是操作系统网络沙箱；不得借此运行未审查的应用入口。
- 不直接执行真实环境下的 `bun dist/src/index.js` 作为构建验收。

## 8. 已有验证证据及其边界

以下是前期隔离原型结果，不是本文尚未实施的正式迁移验收结果：

| 项目 | 实际结果 |
| --- | --- |
| Bun 原生多文件 JS + JSON 资源处理 | 365 个 JS、1 个运行所需 JSON；未调用 TypeScript Compiler API |
| 构建契约 | 4 项通过，53 个断言，包括移走源码后从 dist 加载 |
| 选定源码业务测试 | 296 个文件，3007 项通过，19130 个断言 |
| 同组生成 JS 业务测试 | 3007 项通过，19130 个断言；运行生产目录为 0 TS / 365 JS；测试入口和静态 AST 读取按 §7.3 适配 |
| JSON 专项 | 嵌套路径、字面量动态导入、`__proto__`、类型专用资源省略、未引用坏 JSON 省略均通过 |
| SDK 枚举 | 所用 18 个枚举 / 86 个成员的声明值和运行时值一致；未创建网络 context |
| JavaScript ESLint 方向 | 本轮内存配置检查通过，不需要修改 tsconfig |

清理方案另有 Windows / Bun 1.4.4 下的隔离最小探针证据：

- 标准 `rm` 可处理不存在的目录、嵌套产物、中文/空格路径及重复清理，并保留产物目录之外的相邻文件。
- §1 的真实 package 命令可将 `--clean-only` 原样传入脚本；从其他 cwd 通过绝对路径启动参数探针时，脚本位置可正确推导真实项目根目录，不要求临时工程存在 `src/`。Windows 路径比较使用 `realpath`，不把大小写拼写差异当成不同物理目录。
- Windows 文件被独占占用时，`rm` 明确以 `EBUSY` 失败，`await` 阻止后续写入；释放占用后可以清理。

这些探针只验证文件 API、命令参数及路径契约，不是正式 `scripts/build.js` 的完整分流、失败清理或构建集成验收；§7 的正式测试仍须落地并通过。

### 8.1 性能基线

Windows / Bun 1.4.4，预热一次，再交替测量各五次，完整原型流程的中位数为：

| 方案                                        | 中位耗时 |
| ------------------------------------------- | -------: |
| 原 `clean + tsc`                            |  2757 ms |
| 纯 Bun 原型：清理、检查、JS 构建、JSON 输出 |   635 ms |

原型耗时减少约 77%，约 4.3 倍速度。**该原型已在脚本内用标准文件 API 清理，与本方案的清理归属一致；但正式 `scripts/build.js` 的位置、模式分流及完整实现尚未落地，635 ms 仍不是最终命令链的已测结果，不能直接作为交付承诺。**

实施后必须重测实际 `bun run build`（调用 `bun --no-env-file scripts/build.js`），计入 package 命令、脚本/子进程启动、初始清理、类型检查、所有文件输出和资源复制。不能拿 Bun CLI 显示的内部转译时间代替完整构建时间，也不能在外部预先清理后将脚本内部清理成本排除。

### 8.2 尚未完成

- 正式 `scripts/build.js`、build/clean 命令、`rimraf` 依赖移除与锁文件同步、ESLint 配置及测试改动尚未落地；最小探针不能替代这些交付。
- 最终迁移版本的全量 lint、type-check、全部测试及完整性能复测尚未执行。
- Linux/macOS 或其他架构的 Longbridge 原生包与运行产物尚未验收。
- 未完成真实部署或实盘运行验证，也不以实盘操作作为本次构建迁移的验证手段。
- 不保证 Bun 与 TypeScript 检查器对所有未来代码给出完全相同的诊断；保留严格检查和业务验收，而非检查器实现一致性。

## 9. 实施顺序

### 步骤一：确认基线与环境

- 检查工作区，保留用户已有改动，记录实施时 commit、Bun 版本和依赖版本。
- 先使用已验证的 Bun 1.4.4 完成迁移，不把同时升级 Bun/SDK 混入本次变更。
- 确认实际部署平台；其他平台在该平台执行离线验收，不能复用 Windows 结果冒充验证。

### 步骤二：新增唯一正式构建入口

- 新增 `scripts/build.js`，按 §4 实现，根目录从脚本位置推导。
- 保持业务 `src/` 不变，不创建 `tools/build.ts`、`scripts/build.ts` 或另一套生产构建器。
- 默认构建先等待初始清理，`--clean-only` 清理后直接返回；构建失败时复用同一清理函数，不重复初始清理，不截断异步清理。

### 步骤三：接入 package、依赖移除与 JavaScript lint

- 按 §1 修改 package build/clean，两者调用同一脚本，不再串联外部 clean。
- 使用 `bun --no-env-file remove rimraf` 更新依赖列表与锁文件；确认共享依赖和其他包版本未被误删或升级。
- 按 §6 配置 ESLint，并确认该文件不再被忽略。
- 不修改 tsconfig，不新增依赖，不删除 TypeScript 等仍在使用的依赖。

### 步骤四：同步构建测试与产物验收

- 更新临时工程复制清单和实际 build/clean 命令断言。
- 保留原有 4 项行为保护，补充 §7.2 的清理与必要 JSON 场景。
- 完成源码/生成 JS 对照，处理的是测试运行入口，不修改业务行为来迁就构建器。

### 步骤五：更新当前使用说明

README 明确：

- `bun run build` 由脚本内部一次完成 clean、Bun 类型检查/转译和 JSON 输出；`bun run clean` 只清理产物，不执行构建，不再依赖 rimraf。
- JSON 按生成 JS 的实际运行依赖复制，不由 tsc 发射，也不保证输出类型专用资源。
- 构建不会运行策略 `prepare()`，构建成功不等于所选业务配置合法。
- 布局和启动命令不变，策略增删和源码/JSON 修改后仍须重新完整构建。
- 构建脚本仅构建及清理时需要，不成为 dist 运行模块；不把环境文件或日志数据装入产物。

### 步骤六：执行质量与性能验收

实际改码后按项目规则先后运行。下列测试命令必须在 §7.4 的白名单隔离环境中执行；显式使用 `--no-env-file`，不能用会绕过 package test 脚本的裸 `bun test` 代替：

```sh
bun lint:fix
bun type-check
bun --no-env-file test
bun run clean
bun run build
```

检查自动修复 diff，只接受本次相关变化；另外完成 §7.3 的离线产物对照和 §8.1 的完整命令性能复测。

如需在终端核对脚本单独的 lint 覆盖，使用已安装的 ESLint 检查 `scripts/build.js`；不能出现 ignored-file 或 project-service 找不到项目的警告。

### 步骤七：收口引用并发布完整产物

- 搜索 package、README、测试中的旧 `clean + tsc`、`rimraf dist` 命令和仅属于旧方案的描述，修正当前生效引用；确认依赖列表和锁文件不再保留 rimraf 及仅由其引入且已失去引用的依赖。
- 不批量重写历史计划，不改无关 tools/docs 内容。
- 发布前停旧进程并完成原有清理；只发布成功构建的完整产物，禁止原地替换运行中的文件。
- 保留生产依赖及目标平台匹配的 Longbridge 原生包；`--no-bundle` 不会把 node_modules 打入 dist。
- 环境和认证配置仍由原启动机制提供，不由构建流程生成或打包。
- 若验收发现真实功能回归，暂停发布并定位根因；不加入自动 tsc fallback。只有确认构建侧不能解决且确实需要时，才另行明确业务源码修改范围。

## 10. 完成标准

- [ ] 正式入口为 `scripts/build.js`，不存在为此新增的 TS 构建入口或 tools 构建文件。
- [ ] package build 使用 `bun --no-env-file scripts/build.js`，clean 使用同一脚本的 `--clean-only` 模式，不再外部串联 clean。
- [ ] `rimraf` 已从开发依赖和锁文件移除，失去引用的间接依赖已清理，共享依赖及其他版本保持不变。
- [ ] 独立 clean 不执行类型检查或构建，源码缺失/有错误、产物不存在及重复清理均符合契约；无效参数在删除前失败，非项目 cwd 调用不误删其他目录。
- [ ] 全部生产 JS 均由 Bun 输出，不调用 tsc 或 TypeScript Compiler API 构建。
- [ ] JS 脚本通过非类型感知 ESLint；未修改 tsconfig 来纳入该脚本。
- [ ] 生产布局保持 `dist/src`，需要的 JSON 可直接加载，不需要手动复制。
- [ ] 动态策略发现、唯一策略准备、未选策略零执行及源码移除后的 dist 加载均通过。
- [ ] 初始清理失败不进入构建；类型/构建/资源处理失败均在等待在途操作结束后清理并非零退出，正常可清理条件下没有旧产物或半成品残留；清理失败明确报告且不覆盖主要错误。
- [ ] 全量项目检查与离线产物业务验收通过；不把纯 AST 检查冒充生成代码运行覆盖。
- [ ] 对最终命令链完成公平性能复测并记录结果，确认仍有实际收益。
- [ ] README 与测试连接已更新，生产业务代码和非生产工具未被顺手修改。
- [ ] 目标平台依赖与离线启动边界完成验收，未通过真实交易验证构建。

**最终原则：用 Bun 承担高性能构建，以离线运行功能验收代替编译器输出形式一致性；JSON 自动处理属于构建内部步骤，不增加人工操作或业务兼容代码。**
