# Prettier 移除与 Bun 原生格式化迁移方案

- 日期：2026-10-23
- 状态：已在独立 worktree 实施，自动化验收通过；VS Code 实际保存行为按用户确认保留为待人工验证，实施记录见 §10。
- 验证基线：Bun 1.4.4；项目原有 Prettier 3.9.6。
- 目标：移除 `prettier` 格式化引擎及 `.prettierrc`，由 `bun fmt` 统一执行格式化，格式规则收敛到根目录 `bunfig.toml`。
- 范围：格式配置、开发依赖与锁文件、格式脚本、VS Code 工作区配置、直接受影响的现行使用说明。

## 1. 结论与实施决策

该迁移可行，且适合当前已经使用 Bun 执行应用、测试和类型检查的项目。格式化脚本已经切换为 `bun fmt`，本次不是再次替换命令，而是完成依赖、配置和编辑器入口的收口。

采用以下唯一目标方案：

1. 删除 `prettier` 开发依赖，由 Bun 更新 `bun.lock`。
2. 将通用样式和 Markdown 覆盖规则迁入现有 `bunfig.toml` 的 `[fmt]`、`[[fmt.overrides]]`，删除 `.prettierrc`。
3. 接受 Bun 原生模式对文件选择的调整：纳入 TOML，默认不格式化生成的锁文件；不迁移 `*.lock` 的格式覆盖规则。
4. 保留 `format: bun fmt`，增加 `format:check: bun fmt --check`；格式化不再被描述为包含 ESLint 自动修复。
5. 保留 `eslint-config-prettier` 及现有 ESLint 规则顺序。该包不依赖、不加载也不执行 `prettier`，只关闭与格式化冲突的 Lint 规则。
6. 移除 VS Code 工作区对 Prettier 扩展的默认格式化绑定，关闭保存时自动格式化；格式化统一通过项目命令执行，现有 ESLint 保存修复保留。
7. 更新当前操作指引，但不改写历史执行命令、日志或验收结果。

“弃用 Prettier”在本方案中指移除格式化引擎及其执行入口，不要求删除所有名称中含 `prettier` 的静态配置包、历史记录或有效的忽略注释。

### 1.1 不在本次范围内

- 不迁移 ESLint 到其他实现，不删除 `eslint-config-prettier`，不重写现有 Lint 规则。
- 不修改应用运行、交易业务、测试行为、TypeScript 配置或 `build` 构建链。
- 不删除 `typescript`；构建和现有 ESLint 配置仍然需要它。
- 不引入新的 VS Code 扩展、LSP、格式化包装脚本、Git hook 或 CI 平台。
- 不增加导入排序、`package.json` 排序、JSDoc 重排等新格式化行为。
- 不为了迁移执行全仓写入式格式化，不顺手修复无关源码、测试或历史文档。
- 不启动 `start`、`dev`、交易程序或构建产物，不访问交易凭据和生产数据。

## 2. 已核实的现状与证据

### 2.1 当前入口

| 位置 | 当前内容 | 迁移处理 |
| --- | --- | --- |
| `package.json` | `format` 为 `bun fmt`，仍声明 `prettier: 3.9.6` | 保留命令、增加只读检查脚本、卸载依赖 |
| `.prettierrc` | 通用样式、`*.lock` parser 覆盖、Markdown `proseWrap` 覆盖 | 样式迁入 TOML，删除原文件 |
| `bunfig.toml` | 只有 `[test]`，测试根为 `tests`，preload 为 `./tests/setup/testRuntime.ts` | 保持测试段原义，追加格式配置 |
| `.vscode/settings.json` | 全局及六个语言段使用 `esbenp.prettier-vscode`，启用 `prettier.requireConfig` | 清除 Prettier 绑定，停用自动格式化 |
| `eslint.config.js` | 导入并使用 `eslint-config-prettier/flat`，其后覆盖少量项目规则 | 保持引用和顺序，仅澄清相关注释 |
| `README.md` | 仍将 `bun format` 描述为“Prettier + ESLint 自动修复” | 修正命令职责并说明新工作流 |
| `tests/architecture/refactoring/README.md` 等记录 | 包含历史 Prettier CLI 命令及文档检查交接说明 | 按历史事实与现行操作指引分类处理 |

当前根目录未发现 `.prettierignore`、`.editorconfig`，也未发现已配置的自定义 Git hooks 路径或有效本地 hook。此前核查未发现仓库内 GitHub Actions 配置；这些结论不涵盖个人编辑器设置、全局 hook 或远端独立配置的 CI，实施前仍需核对。

### 2.2 已完成的隔离验证

以下是方案形成前的实测，不是正式迁移验收结果：

- `bun fmt --doctor` 识别 `.prettierrc`，报告当时 847 个候选文件均可原生格式化，并提示可移除 `prettier`；该命令明确不检查所有编辑器、CI 和 Git hook 引用。
- 在临时副本中，Bun 1.4.4 与项目 Prettier 3.9.6 分别格式化后，787 份副本的最终内容逐字节一致。
- 在不含 `node_modules` 的两组临时副本中，分别使用 `.prettierrc` 与等值 `bunfig.toml` 配置；排除这两份配置文件后，比较的 786 份文件无内容差异，原生配置再次执行 `bun fmt --check` 退出 0。
- 原生配置的候选文件相对兼容模式减少 `.prettierrc` 和 `bun.lock`，增加 `bunfig.toml`。即使保留 `*.lock` override，根目录默认遍历也未纳入 `bun.lock`；显式传入 `bun.lock` 时仍可处理。
- 已安装包的依赖声明核查未发现其他包要求 `prettier`；`eslint-config-prettier` 的 peer dependency 为 ESLint，不包括 Prettier。

上述内容对比覆盖源码、测试、mock 和相关根目录文件，未展开格式化 `docs/`、`tools/`。文件数是当时样本统计，不是未来验收必须硬编码匹配的数量。临时目录均已清理，原工作区未被格式化或卸载依赖。

## 3. 目标配置与行为契约

### 3.1 `bunfig.toml` 作为唯一格式规则来源

目标内容如下；实施时与文件最新内容精确合并，不覆盖其他并行工作新增的配置：

```toml
[test]
root = "tests"
preload = ["./tests/setup/testRuntime.ts"]

[fmt]
semi = true
singleQuote = true
tabWidth = 2
trailingComma = "all"
endOfLine = "lf"
printWidth = 100
bracketSpacing = true
arrowParens = "always"
quoteProps = "as-needed"
jsxSingleQuote = false

[[fmt.overrides]]
files = ["*.md"]
options = { proseWrap = "never" }
```

说明：

- 使用 `[fmt]`，不是 `[format]`；不同文件规则使用数组表 `[[fmt.overrides]]`。
- 原 `.prettierrc` 中的十项通用规则全部显式保留，不借迁移调整项目样式。
- `*.md` 不含路径分隔符，按 Bun 的 override 语义匹配各级目录中的 Markdown 文件名，维持原 `proseWrap: never` 意图。
- `printWidth` 是格式化换行参考宽度，不是保证所有行不超过 100 字符的 Lint 限制。
- 不启用 `sortImports`、`sortPackageJson` 等新功能；其默认关闭状态保持不变。
- 不将格式规则迁入 `tsconfig.json` 或 `eslint.config.js`，也不长期保留第二份 `.prettierrc`。

### 3.2 锁文件与忽略规则

本次明确删除旧 `*.lock` override，而不是照搬后误认为仍然自动格式化锁文件。

- `bun.lock` 由 `bun remove`、`bun install` 等包管理命令维护。
- 不对锁文件运行 JSON 重序列化、手工删节点或格式化补丁。
- 不强制将 `bun.lock` 重新加入普通源码格式检查范围。
- 保留现有 `.gitignore`；不把 ESLint 的忽略列表机械复制到格式化配置，两者职责与目标文件不同。
- 当前没有额外格式忽略需求，不新增空的 `.prettierignore` 或 `ignorePatterns`。
- 如果实施前发现真实且直接相关的额外忽略规则，迁入 `[fmt].ignorePatterns` 并验证匹配结果，而不是保留 Prettier 专用配置作为隐式第二来源。

移除 `.prettierrc` 后，Bun 原生模式会扩大部分语言支持，并按仓库中的 `.gitignore` 层级处理忽略规则，而兼容模式只读取当前目录的 `.gitignore`。因此必须对比候选文件集合，不能只对比已选中文件的输出。

TOML 纳入格式化是本方案接受的变化。若项目未来增加 Svelte 或其他语言，需按当时实际文件类型核对支持范围，不为当前不存在的文件提前添加兼容开关。

### 3.3 脚本与版本基线

`package.json` 保留原有其他脚本，仅形成以下格式入口：

```json
{
  "packageManager": "bun@1.4.4",
  "scripts": {
    "format": "bun fmt",
    "format:check": "bun fmt --check"
  }
}
```

这是目标字段片段，不是替换整个 `package.json` 的内容。

- `format` 只格式化，不执行 ESLint；需要修复 Lint 时单独运行 `bun run lint:fix`。
- `format:check` 是只读格式检查，不执行类型检查或测试。
- 不新增名为 `fmt` 的同名脚本，避免与 Bun 的脚本优先解析交互。
- `packageManager` 声明团队基准版本，不等于自动安装、切换或强制校验正在执行的 Bun。
- 实施与验收环境使用已验证的 Bun 1.4.4，并记录 `bun --version`；后续升级 Bun 时一并复核格式差异。
- 不把“支持 `fmt` 的最低版本”误当作“所有后续版本必然输出一致”；不引入运行时版本回退脚本。

### 3.4 VS Code：明确采用命令式格式化

本方案不承诺在移除 Prettier 后原样保留保存自动格式化。当前未验证一个能够按本项目配置调用 `bun fmt` 的编辑器 provider，因此采用最小且可验证的工作流：

- 工作区关闭保存自动格式化，日常执行 `bun run format` 或 `bun fmt <明确文件>`。
- 保留现有 ESLint 保存修复；Lint 修复不等于完整格式化。
- 不在项目中继续绑定 Prettier，也不将未经验证的扩展 ID 写成默认 formatter。

`.vscode/settings.json` 的相关字段目标如下，其他编辑器、终端、主题与 ESLint 设置保持原样：

```json
{
  "editor.defaultFormatter": null,
  "editor.formatOnSave": false,
  "[javascriptreact]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "[css]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "[jsonc]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "[typescript]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "[javascript]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "[json]": {
    "editor.defaultFormatter": null,
    "editor.formatOnSave": false
  },
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  }
}
```

额外处理：

1. 删除 `prettier.requireConfig`，并清除本工作区其他实际存在的 `prettier.*` 执行设置。
2. 不只删除语言级绑定而留下 `formatOnSave: true`；显式设为 `null`/`false`，避免这些现有语言段再次继承个人 Prettier 默认值。
3. 个人编辑器可能有其他语言级覆盖或第三方保存动作；在本项目工作区核查有效设置，并按需禁用 Prettier 扩展。不能声称仓库设置能约束所有个人扩展行为。
4. 用户级卸载扩展不属于依赖迁移的自动操作，不修改用户全局 VS Code 配置。
5. 若后续要求恢复保存自动格式化，单独选择并验证调用 `bun fmt --stdin-filepath` 的集成，包括未保存缓冲区、cwd、换行和错误处理；不混入本次迁移。

### 3.5 保留 ESLint 冲突消解配置

`eslint.config.js` 继续导入并使用 `eslint-config-prettier/flat`，位置保持不变，现有项目规则继续在其后覆盖。

将“以下规则须在 Prettier 之后”等容易误解的注释改为准确含义，例如“以下规则须在 eslint-config-prettier 配置之后，以覆盖其关闭设置”。不得声称 ESLint 仍在运行 Prettier。

不为了依赖名称整洁而内联第三方规则清单，也不在本次迁移中重新启用已关闭的排版规则。

## 4. 逐文件改动清单

| 文件 | 必须实施的改动 |
| --- | --- |
| `bunfig.toml` | 按 §3.1 增加格式规则，测试配置不变 |
| `.prettierrc` | 在配置成功迁入后删除 |
| `package.json` | 删除 `prettier`；增加 `format:check` 和版本基线声明；保留 `format` 与其他依赖、脚本 |
| `bun.lock` | 由包管理器更新，清除不再被引用的 Prettier 引擎；不手工编辑 |
| `.vscode/settings.json` | 按 §3.4 停用 Prettier 自动格式化入口，保留 ESLint 保存修复 |
| `eslint.config.js` | 仅澄清冲突消解配置附近的注释，不改规则行为 |
| `README.md` | 修正命令职责，补充格式检查、Bun 版本和编辑器工作流 |
| 本方案 | 实施后记录实际变更、验证结果、文件选择差异与未完成事项 |

实施前定向复查这些含旧命令的说明：

- `tests/architecture/refactoring/README.md`
- `docs/architecture/architecture-refactoring-implementation-plan.md`
- `docs/plans/strategy-module-cohesion-refactoring-plan.md`

处理原则：

- 当前可执行的格式检查指导改用 `bun fmt --check <明确文件>`，必要时保留现有 `--no-env-file` 安全选项。
- 历史日志、历史验收表、过去实际执行的命令和退出码保持原样。
- 对同时包含历史事实与易被误用的旧交接命令的文档，优先增加简短的“当前格式检查入口”说明，明确旧命令只用于描述当时环境，不覆盖原执行证据。
- `docs/architecture/architecture-refactoring-audit-evidence/` 下的审计记录，以及 `docs/plans/2026-09/2026-09-19-strategy-replaceability-remediation-plan.md` 中已经执行的历史命令，不作机械替换。
- 不以全仓搜索出现 `prettier` 为失败标准；必须区分引擎调用、静态 ESLint 配置、忽略注释和历史事实。
- 当前定向搜索未发现 `tools/` 中的 Prettier 引擎调用；不因此扩展修改无关工具。

## 5. 实施顺序

### 步骤 1：记录工作区与验证基线

1. 重新确认实际文件内容和 Bun 版本，不直接依赖本文记录的行号或文件数量。
2. 记录 `git status`，保护已有未提交改动；本工作区存在其他业务与文档改动，不能使用 `git reset --hard`、`git clean` 或整文件还原覆盖它们。
3. 对将修改的配置和文档保留实施前内容或精确 patch，用于核对本次增量。
4. 在配置和依赖尚未修改时，运行 `bun fmt --doctor`、`bun fmt --list-files` 和只读的 `bun fmt --check`，保存各自退出码、候选文件列表及格式不符/解析失败的具体文件清单。以此区分迁移前已存在的问题、迁移新增问题和新增检查范围；非零退出码不得省略或解释为通过。检查输出保存在仓库外，不提交机器路径日志。
5. 搜索实际脚本、编辑器、hook 和 CI 中的 Prettier 调用；没有 CI/hook 时不创建新的系统。
6. 与当前并行任务协调格式化和 Lint 修复的写入窗口，避免同时修改同一文件。

### 步骤 2：完成原生配置与编辑器迁移

1. 精确合并 `bunfig.toml`，保留 `[test]` 和其他当前设置。
2. 删除 `.prettierrc`，不保留文件兼容层、旧配置别名或自动回退。
3. 调整格式脚本、版本基线、VS Code 设置及 ESLint 注释。
4. 运行新的 `bun fmt --doctor` 和 `bun fmt --list-files`。
5. 对候选列表做前后差集，确认新增 TOML、删除旧配置和跳过锁文件等变化符合预期；其他差异逐项说明，不能只比较总数量。
6. 对选择范围内的文件先做只读检查，不立即全仓格式化。

### 步骤 3：卸载依赖并核对锁文件

在项目根目录执行：

```powershell
bun remove prettier
```

随后确认：

- `package.json` 不再声明 `prettier`；`eslint-config-prettier`、ESLint、TypeScript 和业务依赖保留。
- `bun.lock` 的改动限于本次依赖删除及必需元数据，不出现无关依赖升级。
- 依赖树不存在仍需执行 Prettier 的插件或消费者。
- `bun fmt --doctor` 不再要求安装 Prettier，不出现插件 fallback 或 unsupported 提示。
- 如锁文件发生不明的大面积变化，停止实施并查明原因，不接受顺带更新。

依赖卸载不授权修改生产环境或运行中的交易程序；也不运行全量 `bun update`。

### 步骤 4：同步直接受影响的说明

更新 §4 中的现行操作说明，解释以下命令职责：

```powershell
# 写入式格式化，默认范围较大，日常运行前确认工作区
bun run format

# 只读检查
bun run format:check

# 有明确文件范围时，优先定向格式化
bun fmt package.json bunfig.toml .vscode/settings.json

# Lint 修复与格式化分离
bun run lint:fix
```

上述是操作方式说明，不是要求执行者在脏工作区依次运行所有写入命令。

### 步骤 5：定向格式化与验收

1. 仅格式化本次实际修改的配置和 Markdown 文件，使用明确路径列表。
2. 不用可能为空的命令替换生成文件参数；`bun fmt` 无参数会处理当前目录，空列表不是无操作。
3. 不使用 `--staged`，避免格式化同时重新暂存用户已有内容。
4. 执行 §6 的验证，审查最终 diff；通过后再报告迁移完成。
5. 所有临时样本、检查输出和安装验证目录均清理，不新增永久迁移工具。

## 6. 验证方案与验收标准

### 6.1 必须完成的检查

| 验证项 | 方法 | 通过标准 |
| --- | --- | --- |
| 原生配置加载 | `bun fmt --doctor` | 使用 `bunfig.toml`，所需文件由 Bun 原生处理，无 Prettier fallback |
| 文件选择 | 比较迁移前后的 `bun fmt --list-files` | 每个新增/减少路径都有符合 §3.2 的解释，无意外漏检源码 |
| 格式规则保持 | 在仓库外临时目录验证 TS、JSON、Markdown 和 TOML 的样本 | 单引号、分号、缩进、换行、尾随逗号、宽度及 Markdown 覆盖符合目标 |
| 格式稳定性 | 格式化样本后再次执行 `bun fmt --check` | 退出 0，重复格式化不再产生变化 |
| 修改文件格式 | `bun fmt --check <本次实际修改的可格式化文件>` | 退出 0，不将已删除 `.prettierrc` 或锁文件列入目标 |
| 无 Prettier 安装 | 在无旧 `node_modules` 的临时验收副本中，用当前锁文件执行 `bun install --frozen-lockfile` | 安装成功，未安装 `prettier`，格式化与 ESLint 配置可加载 |
| ESLint 集成 | `bun run lint:fix`，审查其写入增量 | 退出 0，保留的 `eslint-config-prettier` 不要求 Prettier 引擎 |
| 类型检查 | 在上述 Lint 修复之后执行 `bun run type-check` | 退出 0，无配置迁移引起的新错误 |
| 测试配置保持 | 解析并比较 `bunfig.toml` 中原 `[test]` 配置 | root/preload 与实施前一致，不因 TOML 表位置改变归属 |
| 编辑器入口 | 检查工作区设置，并人工核验保存行为 | 不再调用 Prettier 自动格式化；ESLint 保存修复仍按原设置执行 |
| 引用与差异 | 定向搜索旧调用，执行 scoped `git diff --check` | 无现行旧调用，无空白错误，无无关文件改动 |

临时安装验收副本不带业务 `.env`、凭据、运行数据或生产日志；如依赖包安装需要网络，只允许正常包获取，不运行应用入口或连接交易服务。

`bun run lint:fix` 会写文件，执行前应保留其可能触及文件的精确基线，或在包含当前待交付改动的隔离副本中执行。若产生与本迁移无关的修复，必须区分既有问题和新增问题，不借本次迁移提交。不得从 HEAD 整文件还原来清理这些增量。

由于仅迁移开发工具配置，不默认执行构建和全量业务测试，也不为格式化器编写长期低价值单元测试。若实施中触及 TS 逻辑、测试 preload 或发现未解决的相关疑点，先明确影响范围，再补充相称的验证。

### 6.2 全仓格式检查与既有格式债务

新增 `format:check` 后，应运行一次只读全仓检查并记录结果：

```powershell
bun run format:check
```

- 原生配置带来的新增格式差异与此前已存在的格式问题分别列出。
- 不因为全仓检查失败就全仓运行 `bun fmt`，不为了通过检查新增忽略规则或放宽样式。
- 若发现与迁移无关的既有债务，报告具体文件及基线证据，单独确定清理范围；在门禁仍失败或问题未解决时，不宣告完整迁移验收通过。
- 本次方案文档的交付不代表上述全仓门禁已经通过。

### 6.3 编辑器验证边界

人工保存行为未实际验证时，应明确记录“待人工验证”，不能用 JSON 检查通过代替编辑器行为验证。接受命令式格式化后，保存文件不再自动获得完整排版是预期结果，不是需要添加 Prettier fallback 的故障。

### 6.4 残留分类

允许保留：

- `eslint-config-prettier` 包及其导入。
- 历史执行证据、迁移说明中的 Prettier 名称。
- 若存在、且 Bun 仍支持的 `prettier-ignore` 注释；不因名称而删除忽略语义。

必须移除或更新：

- `prettier` 引擎依赖及失去用途的锁文件节点。
- `.prettierrc` 和其他实际承担格式规则来源的 Prettier 配置。
- 当前脚本中的 Prettier CLI、`node_modules/prettier` 路径、编辑器默认 provider 绑定。
- 把 `bun format` 错误描述为同时执行 Prettier 和 ESLint 的当前说明。

## 7. 风险与回退

| 风险 | 处理方式 |
| --- | --- |
| CLI 已迁移但编辑器仍用扩展内置 Prettier | 同步工作区设置，核查有效语言级配置，不把卸载 npm 包当作编辑器停用 |
| 删除 `.prettierrc` 后选择范围变化 | 对比实际文件列表，明确接受 TOML 与锁文件策略，不以相同总数代替检查 |
| Bun 版本升级改变排版 | 固定验收版本并记录版本声明；升级时单独检查格式差异 |
| 忽略未支持的插件 | 发现真实插件需求时停止并重新评估，不用 `--allow-unsupported` 隐藏行为变化 |
| 改写历史验收命令导致证据失真 | 只更新当前指引；历史命令、日志与退出码不改 |
| 全仓格式化/Lint 修复覆盖并行改动 | 明确写入范围和基线，只还原本次增量，不做破坏性仓库重置 |

回退仅针对本次开发工具迁移，不是交易程序回退：

1. 使用实施前精确内容或本次独立提交的反向补丁，恢复依赖、锁文件、配置和编辑器设置。
2. 同时恢复 `package.json` 与匹配的 `bun.lock`，再安装依赖；不要只恢复锁文件中的单个包节点。
3. 若恢复 `.prettierrc`，同步移除本次新增 `[fmt]`/override，避免双配置来源。
4. VS Code 与文档恢复到相同工具链状态，不留下一半原生、一半 Prettier 的入口。
5. 不执行 `git reset --hard`、`git clean` 或无差别 `git restore`；已有业务修改和其他任务文件必须保持。
6. 不在项目代码中长期保留“Bun 失败时自动调用 Prettier”的兼容层。

## 8. 完成清单

以下记录对应 2026-10-23 的独立实施，实际结果与验证边界见 §10。

- [x] `prettier` 引擎依赖已移除，锁文件变更范围已审查。
- [x] `.prettierrc` 已删除，原有有效样式已迁入 `bunfig.toml`。
- [x] 不再保留无实际用途的 `*.lock` 格式覆盖，包管理器独占生成锁文件维护职责。
- [x] `[test]` 行为保持不变，未混入格式配置。
- [x] `format`、`format:check` 和 Bun 版本基线已明确。
- [x] VS Code 不再绑定 Prettier，配置已核对，命令式格式化的行为变化已说明。
- [ ] VS Code 实际保存行为待用户人工验证；用户已接受该验收边界，不冒充已验证。
- [x] `eslint-config-prettier` 保留，相关注释准确，Lint 规则顺序不变。
- [x] 当前操作指引已更新，历史验收证据未改写。
- [x] 文件选择差异已逐项确认，无意外漏检。
- [x] 无旧 `node_modules` 的安装与格式化验收通过。
- [x] 定向及全仓只读格式检查、隔离 `lint:fix` 与随后类型检查通过；既有无关 Lint 排版增量未回流，边界见 §10.4。
- [x] 最终 diff 无无关格式化、依赖升级或业务变更；两项额外定向格式化均经用户确认。
- [x] 临时样本、验收副本和检查输出清理完成。
- [x] 实际命令、退出码、编辑器验证边界及与本方案的偏差已记录。

## 9. 官方依据

以下资料用于核对 Bun 1.4.4 对应能力；在线文档可能继续更新，实际行为以本方案记录的版本和实施时验证为准。

- [Bun 1.4.4 发布说明](https://bun.com/blog/bun-v1.4.4)
- [Bun Formatter](https://bun.com/docs/format)
- [从 Prettier 迁移到 Bun](https://bun.com/guides/format/migrate-from-prettier)
- [bunfig.toml：Formatter](https://bun.com/docs/runtime/bunfig#formatter)
- [bunfig.toml：Overrides](https://bun.com/docs/runtime/bunfig#format-overrides)
- [Prettier VS Code：本地版本与扩展内置版本](https://github.com/prettier/prettier-vscode#prettier-resolution)

## 10. 实施记录（2026-10-23）

### 10.1 隔离基线与实际范围

- 实施分支为 `refactor/bun-fmt-migration`，独立 worktree 目录名为 `bun-fmt-migration`。原分支 `beta-V2` 未切换，原 HEAD 与暂存区未改动。
- 从原 HEAD `0418b60fc62216e4a1ce79055a7f6eda43b2615f` 复制当时工作区的 858 个已跟踪及非忽略未跟踪文件，逐文件校验内容，形成独立基线提交 `d9b1f47e9a3de846274d03ca63c66c45bef034c3`。该提交包含用户已有修改，不能把它们计为本次迁移增量；迁移 diff 以该提交为基准。
- Bun 实际版本为 `1.4.4`。配置、依赖、脚本、编辑器及 §4 指定现行说明均已迁移，未修改运行、构建、业务配置或测试 preload。
- 用户另行明确授权：定向格式化既有 `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`，以及新增检查范围中的 `.codex/config.toml`。前者仅回调块排版，后者仅缩进与末尾换行，不改变测试行为或 Codex 权限值。
- 不执行全仓写入式格式化，不启动应用、构建产物或 SDK 会话。隔离安装/验收副本不带业务环境文件、凭据或运行数据；验证子进程使用系统变量白名单、隔离 HOME/TEMP 及 `BUN_OPTIONS=--no-env-file`。

### 10.2 迁移前后文件选择与格式债务

| 阶段 | 实际命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 迁移前 | `bun --no-env-file fmt --doctor` | 0 | 加载 `.prettierrc`，848 个文件均可原生处理，提示可以移除 Prettier |
| 迁移前 | `bun --no-env-file fmt --list-files` | 0 | 848 个候选文件，完整列表在仓库外保存并用于差集比较 |
| 迁移前 | `bun --no-env-file fmt --check` | 1 | 仅 `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts` 格式不符，无解析失败 |
| 配置迁移后、定向修正前 | `bun --no-env-file fmt --doctor` / `bun --no-env-file fmt --list-files` | 各 0 | 使用 `bunfig.toml`，候选仍为 848 个 |
| 配置迁移后、定向修正前 | `bun --no-env-file fmt --check` | 1 | `.codex/config.toml`、`bunfig.toml`、`README.md` 及上述既有测试文件需格式化，无解析失败 |
| 定向修正后 | `bun --no-env-file run format:check` | 0 | `All 848 files are formatted.` |

候选集合变化逐项为：

- 新增 `.codex/config.toml` 与 `bunfig.toml`：原生模式纳入现存 TOML 文件，不只有根配置文件。
- 减少 `.prettierrc`：已删除旧规则来源。
- 减少 `bun.lock`：由包管理器维护，不再通过旧 `*.lock` override 纳入默认格式化。
- 其余候选路径完全一致，没有源码或测试意外漏检；不能仅从总数相同得出此结论。

上述测试文件属于迁移前既有格式债务；`.codex/config.toml` 属于新增检查范围的既有排版；`bunfig.toml`、`README.md` 属于本次修改文件的待格式化内容。它们已分别归因，并只对明确文件列表运行 `bun fmt`，未新增忽略规则或放宽样式。

### 10.3 依赖与配置语义核对

`bun --no-env-file remove prettier` 退出 0。Bun 将旧锁文件的展开排版改写为包管理器原生紧凑排版，文本由 1623 行变为 370 行；发现大面积文本变化后先停止并做 JSONC 结构比较，确认语义只删除：

1. 根 workspace 的 `devDependencies.prettier`。
2. `packages.prettier` 包节点。

其余版本、校验值、依赖关系及元数据完全一致。没有手工编辑、重序列化或格式化锁文件；`eslint-config-prettier`、ESLint、TypeScript 与业务依赖均保留。

其他可运行语义核对均通过：

- TOML 解析比较确认 `[test].root`、`[test].preload` 不变，十项通用样式和 Markdown 覆盖准确迁入，没有额外格式功能。
- `.codex/config.toml` 解析值完全一致；VS Code 仅预定的 formatter、formatOnSave 与 Prettier 配置字段变化，ESLint 保存动作及其他设置不变。
- TypeScript parser 的 token 序列及去注释转译结果确认 `eslint.config.js` 和获准格式化的测试文件逻辑完全一致，ESLint 配置顺序未变。
- 仓库外 TS、TSX、JSON、嵌套 Markdown 样本分别使用旧 `.prettierrc` 与新 `bunfig.toml`，共同文件的输出逐字节一致；另验证 TOML 格式化前后语义不变。
- 样本明确验证单/双引号、分号、2 空格、LF、尾逗号、100 列换行参考、嵌套 Markdown 的 `proseWrap=never`，并验证导入和 package 字段不排序。样本 `fmt --check` 退出 0，再格式化内容不变。
- 临时语义检查最初使用独立词法扫描器，未处理模板字符串恢复，误把后续注释纳入 token，退出 1；改为 TypeScript parser 提供的 token 树后退出 0，并增加去注释转译内容比较。该失败来自临时检查器，不是项目代码回归；未因此修改业务逻辑。

### 10.4 安装、Lint、类型与定向测试

以下在无旧 `node_modules` 的仓库外隔离验收副本中执行，不在原工作区运行写入式 Lint：

| 实际命令或检查 | 退出码 | 结果 |
| --- | --- | --- |
| `bun --no-env-file install --frozen-lockfile` | 0 | 安装 159 个包，锁文件指纹不变 |
| 直接加载 `eslint.config.js`、解析 Prettier 可用性并扫描已安装依赖声明 | 0 | ESLint 配置可加载；Prettier 不可解析，未发现要求引擎的 runtime/peer/optional 消费者；静态配置包仅要求 ESLint peer |
| `bun --no-env-file fmt --doctor` | 0 | 使用 `bunfig.toml`，848 个文件均原生处理，无安装 Prettier、fallback 或 unsupported 提示 |
| `bun --no-env-file fmt --check package.json bunfig.toml .vscode/settings.json` | 0 | 干净安装环境中的格式检查正常 |
| `bun --no-env-file run lint:fix` | 0 | 完整 Lint 修复检查通过；写入增量仅一处既有空行，见下文 |
| 随后 `bun --no-env-file run type-check` | 0 | 781 个文件，无类型错误 |
| `bun --no-env-file test tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts` | 0 | 11 pass / 0 fail，51 个断言；既有离线 SDK guard 生效 |
| 撤回隔离副本无关空行后，再执行 `bun --no-env-file run type-check` | 0 | 精确交付代码内容仍为 781 个文件，无类型错误 |

`lint:fix` 仅在隔离副本的 `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts` 两个既有断言之间补一行空白。该内容与基线一致，属于既有 Lint 排版问题，不是迁移引入；按 §6.1 未带回交付 worktree，并从隔离副本按精确文件内容撤回。**因此这里记录的是隔离 `lint:fix` 成功，不声称未修复基线已经通过只读 `bun lint`。**

任务期间只读比对还观察到原工作区同一文件新增了相同空行；本次所有项目写入均限定在独立 worktree 或隔离副本，没有回滚或同步该外部变化。原分支、HEAD、暂存区指纹和状态路径集合保持原样。

本次没有交易逻辑变化，依方案不执行构建和全量业务测试；针对唯一格式化的测试文件额外运行了上述离线检查，没有扩展业务重构范围。

### 10.5 最终审查与验收边界

- 当前操作说明已更新；三个含历史命令的指定文档仅增加当前入口说明，旧命令、日志、数字和退出码原样保留。历史审计目录和 2026-09 历史计划未改写。
- 定向检查未发现额外现行 Prettier CLI、插件消费者或编辑器绑定；保留静态 ESLint 配置及历史事实。仓库内未发现相关 CI/hook 配置，当前 Git hook 路径无有效本地 hook；不据此推断个人全局设置或远端 CI 状态。
- 独立只读复审未发现已确认缺陷。生产源码、mock、TypeScript 配置和测试 preload 没有本次增量；全部变更仅限方案文件及两项已授权格式清理。
- 补写记录后曾有一次定向格式化的 cwd 落在原工作区：虽然绝对文件参数只写入本 worktree 的方案文档，但未按目标原生配置执行；随后检查退出 1，仅本方案排版不符。改从正确 worktree 根目录定向格式化后复检通过，未格式化原工作区文件。
- 最终 11 个修改文件的显式 `bun --no-env-file fmt --check <文件列表>`、全仓 848 个候选文件的只读 `bun --no-env-file run format:check` 和 scoped `git diff --check -- <变更路径>` 均退出 0；完整列表包含本方案，排除已删除配置和生成锁文件的格式检查。
- 用户已确认接受 VS Code 实际保存行为**待人工验证**。静态配置核对不替代 UI 验证；应在此 worktree 打开 VS Code，核对有效语言设置，确认显式保存不再触发 Prettier，ESLint 保存修复仍按原设置运行。不得用其他个人扩展行为作为恢复 Prettier fallback 的理由。
- 临时样本、干净安装副本、校验脚本、原始检查输出及隔离运行目录已清理；未向仓库新增永久迁移工具，后续可使用当前命令重新验证。
