# 交易持久化目录重构与迁移方案

- 日期：2026-10-22
- 状态：方案已复核，尚未实施代码重构或数据迁移
- 目标：弃用 `logs/trades/`，改用 `data/trades/`；将 `data/` 确立为应用持久化数据根目录。
- 范围：路径配置、仓储装配、交易留存常量、直接消费工具、测试隔离、相关说明与一次性目录迁移。

## 1. 复核结论

方案方向正确。现有交易文件不仅用于审计，还承载保护性清仓恢复所需的成交进度、完成边界和订单累计基线，不能继续作为普通诊断日志管理。

本次采用最小且完整的改动：

1. 新增独立数据根解析，交易仓储不再依赖日志根。
2. 将交易留存常量从日志常量中分离，但不改变留存行为。
3. 同步真实调用方、费用工具、测试与项目说明。
4. 停机完成一次性目录切换；应用运行时不承担迁移职责。

复核后明确以下收敛：

- 当前旧目录为空，不执行无意义的文件备份、哈希校验或迁移演练；只有实际发现历史文件时才执行有数据迁移流程。
- 保留既有仓储、记录格式、恢复链路与业务事件协作，不引入新的持久化框架或业务状态来源。
- 路径解析保持纯函数；仓储仍在构造时只读扫描、首次追加时按需创建目录，不新增目录初始化服务。
- 测试显式隔离数据根；`--no-env-file` 不能清除父进程已设置的环境变量，不能单独作为隔离保证。
- 费用工具改用数据根解析后，其入口测试必须同步设置并恢复临时数据根，不能只修改 `cwd`。

## 2. 已核实的现状与依据

| 位置 | 当前行为 | 本次影响 |
| --- | --- | --- |
| `src/config/runtime/index.ts` / `resolveLogRootDir` | 正常运行默认 `logs/`，测试默认 `tests/logs/`，支持 `APP_LOG_ROOT_DIR` | 增加独立的数据根解析，不改变日志解析 |
| `src/app/runtime/createPostGateRuntime.ts` | 创建唯一交易仓储，注入 `resolveLogRootDir` | 改为注入数据根 |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` | 扫描并追加 `<root>/trades/*.jsonl`，使用日志留存常量 | 全部文件操作改用数据根，交易留存常量独立 |
| `src/types/tradeLog.ts` | 定义普通成交、保护性清仓执行进度和完成记录 | 契约与格式保持不变 |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | 从仓储读取完成记录与执行进度，参与恢复 | 仓储注入切换即可，不修改恢复业务逻辑 |
| `src/application/protectiveLiquidation/tradeLogHydrator.ts` | 用完成记录恢复触发计数及有效冷却 | 行为不变 |
| `tools/calculateTradingFees/index.ts` | 硬编码读取 `logs/trades/2026-01-21.jsonl` | 使用新的数据根，其他计算行为不变 |
| `tests/setup/testRuntime.ts`、`tests/setup/childEnv.ts` | 目前只配置独立日志根 | 补充数据根隔离 |

2026-10-22 复核时，本工作区默认路径的磁盘现状为：

- `logs/trades/` 存在，但没有文件或子目录。
- `data/trades/` 不存在。
- 此结论仅描述检查时的工作区默认路径，不代表其他部署或自定义根目录；实际实施前必须重新核实。
- 工作区存在其他未提交改动，包括恢复链路和仓储测试。实施时保留这些改动，只精确修改本方案所需位置。

本次未运行交易程序，也未验证外部部署的进程状态、备份或挂载配置。

## 3. 目标契约

### 3.1 目录职责

```text
项目根目录/
├── data/                         # 跨进程重启保留的应用业务数据
│   └── trades/
│       └── YYYY-MM-DD.jsonl       # 现有混合交易记录，按香港交易日切分
├── logs/                         # 诊断与运行日志
│   ├── system/
│   ├── debug/
│   └── sdk/
└── src/infrastructure/persistence/  # 持久化实现代码，不存放运行数据
```

`data/` 不承接诊断日志、临时文件和可丢弃缓存。未来有真实持久化需求时再按业务职责增加子目录；本次不预建 `orders/`、`risk/`、`seats/` 等目录，也不拆分现有混合交易记录。

### 3.2 配置规则

新增 `RUNTIME.DATA_ROOT_DIR_ENV_KEY: 'APP_DATA_ROOT_DIR'` 和 `resolveDataRootDir(env)`。

| 配置情形                         | 结果                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `APP_DATA_ROOT_DIR` 为非空白路径 | 去除首尾空白，按 `cwd` 解析为绝对路径；绝对路径保持其含义 |
| 未配置或值为空白，档位为 app     | `<cwd>/data`                                              |
| 未配置或值为空白，档位为 test    | `<cwd>/tests/data`                                        |

复用现有运行档位判断：显式 `APP_RUNTIME_PROFILE` 优先，其次按 `BUN_TEST` 推断，其他情况为 app；不新增另一套档位规则。

- `APP_DATA_ROOT_DIR` 指向根目录，例如 `data`，不是 `data/trades`。
- `APP_LOG_ROOT_DIR` 与 `resolveLogRootDir` 保留，只服务诊断日志。
- 不从日志根推导数据根，不因配置日志根而改变交易数据位置。
- 不增加旧环境变量别名、自动回退或为单一仓储增设额外根目录配置。
- SDK 的 `LONGBRIDGE_LOG_PATH` 维持原有配置方式，不并入本次数据根解析。

### 3.3 必须保持的业务不变量

- 三类记录的字段、版本、金额文本、ID 和序列化格式不变。
- 香港交易日文件名及日期校验不变。
- 唯一仓储写入者、同步追加、文件同步落盘、文件指纹校验和幂等冲突规则不变。
- 保护性执行进度与完成事实仍先持久化，再更新相应内存投影。
- 损坏文件、旧格式、事实冲突和不确定写入失败仍按既有规则处理，不降级为空记录继续运行。
- 目录不存在仍保留现有空仓储语义；防止漏迁由发布前核验负责，不新增每次启动检查旧路径的兼容逻辑。
- 不修改订单执行、日内亏损、冷却、席位、生命周期或事件协作逻辑。

## 4. 代码改动清单

### 4.1 运行配置与交易留存常量

修改 `src/constants/index.ts`、`src/config/runtime/index.ts`：

1. 添加数据根环境变量常量及解析函数。
2. 保留现有日志配置函数和相关行为。
3. 新增交易专属常量 `TRADE_PERSISTENCE.MAX_RETAINED_DAILY_FILES = 7`。
4. 交易仓储不再引用 `LOGGING.MAX_RETAINED_LOG_FILES`；日志组件仍使用原常量。

这里的 7 指最新 7 个日文件，不是固定 7 个自然日。保持现有目标日窗口校验、当前日/恢复所需日保护和清理失败处理；不修改留存算法、不增加留存环境变量、不把交易留存策略泛化到整个 `data/`。

### 4.2 仓储与装配

修改：

- `src/infrastructure/persistence/mixedTradeLogRepository/types.ts`
- `src/infrastructure/persistence/mixedTradeLogRepository/index.ts`
- `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts`
- `src/app/runtime/createPostGateRuntime.ts`

具体要求：

1. `MixedTradeLogRepositoryDeps.resolveLogRootDir` 直接替换为 `resolveDataRootDir`，不保留旧属性或委托别名。
2. 装配层注入 `() => resolveDataRootDir(env)`。
3. 仓储扫描、日文件解析、追加和留存清理使用同一数据根。
4. 路径函数的 `logRootDir` 参数及对应注释改为 `dataRootDir`，目标为 `<dataRootDir>/trades/YYYY-MM-DD.jsonl`。
5. 保留 `MixedTradeLogRepository`、`buildTradeLogPath`、文件名及记录类型名称。此处 Log 表示追加式业务记录，不代表必须属于诊断日志目录。
6. 不修改 `src/types/tradeLog.ts` 的行为端口，不要求 application/domain 层感知文件路径。

不新增通用路径服务、仓储基类、迁移状态机、格式版本或数据库依赖。

### 4.3 费用工具

修改 `tools/calculateTradingFees/index.ts`、`tools/calculateTradingFees/types.ts`：

- 用 `resolveDataRootDir(process.env)` 取得根目录，再构造 `trades/2026-01-21.jsonl` 路径。
- 更新默认路径及数据来源注释。
- 保持当前日期选择、金额解析、收费规则、输出格式和仅统计普通成交行的规则不变。
- 不为此次目录切换新增 CLI 参数、日期发现或通用工具配置层。

同步修改 `tests/tools/calculateTradingFees/index.business.test.ts`：

- 仓储写入隔离的临时数据根。
- 导入工具入口前将 `APP_DATA_ROOT_DIR` 指向同一临时根。
- 在 `finally` 中恢复原值；原先未设置时删除该环境变量，并保留现有 `cwd`、控制台和临时目录清理。
- 不再假设修改 `cwd` 足以覆盖全局 preload 设置的数据根。

### 4.4 测试装配与隔离

修改 `tests/setup/testRuntime.ts`、`tests/setup/childEnv.ts`：

- preload 为数据根提供 `tests/data` 默认值，按现有模式支持受控测试启动器显式指定的隔离根。
- 子进程环境构造器创建独立 `data` 目录，并显式设置 `APP_DATA_ROOT_DIR`；不继承生产数据根。
- 保留现有凭据隔离、离线 SDK guard 和进程钩子控制，不扩展为新的测试启动框架。
- 执行验证的父进程必须覆盖或清除生产数据根变量；不能因为档位为 test 就忽略显式路径的优先级。

全量更新受影响的仓储构造参数、mock 和路径 fixture，包括：

- `tests/config/runtime/runtime.business.test.ts`
- `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts`
- `tests/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.test.ts`
- `tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts`
- `tests/app/runAppTerminationMatrix.business.test.ts`
- `tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts`
- `tests/tools/calculateTradingFees/index.business.test.ts`
- 下列受影响的 `tests/integration/` 测试：
  - `accountPositionConsistency/sealedBoundarySettlementAdmission.test.ts`
  - `architectureRefactoringRecovery/recovery.integration.test.ts`
  - `orderProjectionProtectionRecovery.integration.test.ts`
  - `postTradeSettlementOwner.integration.test.ts`
  - `protectiveBaselineSettlement.integration.test.ts`
  - `staticSellProtectiveIsolation.integration.test.ts`

上述清单来自当前调用搜索；实施结束时再次搜索，补齐新增调用方。仅使用 logger 的测试继续使用日志根，不进行全仓机械替换。

### 4.5 项目说明与忽略规则

- `.env.example`：增加可选的、注释形式的数据根配置说明，注明默认值与相对路径基准；不修改用户的 `.env.local`。
- `.gitignore`：增加 `/data/`、`/tests/data/`，避免忽略无关测试 fixture 中的同名目录；保留现有日志忽略规则。
- `README.md`：将交易持久化数据与日志分开说明，记录新路径、环境变量及独立的 7 日文件留存口径。
- 只修改直接失效的文档引用；本方案中的旧路径迁移说明、历史审计基线等不因字符串匹配而机械改写。

## 5. 一次性目录迁移

### 5.1 通用前置条件

1. 先完成代码改动及离线验证，再安排停机切换。
2. 停止应用和其他写入者，停用会拉起旧版本的自动重启安排；迁移期间新旧程序均不得写入。
3. 根据实际配置确定旧 `<logRoot>/trades` 与新 `<dataRoot>/trades`，确认二者不同；不得只检查工作区默认路径。
4. 重新列出目录内容，确认目标无冲突、权限可用；两个目录都已有数据时停止，不自动覆盖、合并或去重。

### 5.2 当前空目录场景

如果复核时的现场仍然成立：旧目录为空，目标不存在或为空：

1. 创建 `data/trades/`（自定义配置时使用对应目标）。
2. 再次确认旧目录为空后删除旧空目录，不使用递归强制删除绕过检查。
3. 确认部署配置指向数据根，旧程序不会再启动。
4. 完成目录切换；不存在需要迁移的历史记录。

不新增迁移脚本，不生成空备份或哈希清单。新安装环境仍由仓储首次追加时按需创建目录，无需额外初始化命令。

### 5.3 实际发现历史文件时

仅在源目录确实有历史文件时执行：

1. 对既有文件做停机备份，备份和校验清单位于仓储扫描目录之外，也不依赖会被清理的日志目录。
2. 将源文件原样复制到空目标，保留文件名及原始字节，不重写 JSONL、不调整顺序、不转换旧格式。
3. 比对完整文件集合、逐文件字节数及 SHA-256；迁移所有既有日文件，不因当前留存数为 7 而在迁移阶段裁剪。
4. 使用新版 `createMixedTradeLogRepository` 对目标做既有的只读启动扫描；不启动 app、不连接 SDK、不追加验证记录。
5. 检查目标权限；不能将只读扫描通过等同于写权限已确认。
6. 所有检查通过后移除原目录，保留独立备份，随后才允许新版程序正常启动。

发现旧格式 `.json`、损坏日文件、内容冲突、来源不明的文件或校验失败时，保持停机并停止迁移。由人工确认既有事实，不静默丢弃，也不增加自动修复逻辑。只读扫描只能验证仓储格式与内部约束，不能替代正常启动时既有的业务恢复校验。

### 5.4 切换与回退约束

- 不允许先启动新版程序，再补迁旧文件。仓储允许空目录，启动前遗漏搬迁会使恢复流程看不到既有事实。
- 新版程序只使用新目录，不扫描旧目录，不执行自动搬运或回退读取。
- 代码版本和数据路径必须配套切换，禁止新旧实例并行写入。
- 如需回退，先停机。若新版已产生新记录，必须以最新完整数据为依据，不能直接覆盖为切换前备份；未确认数据连续性前不得启动旧版。
- 回退属于人工部署操作，不为其保留运行时兼容层。

## 6. 验证方案

### 6.1 必要行为检查

优先扩展现有测试，不建立重复测试体系：

| 验证项 | 关键期望 |
| --- | --- |
| 数据根解析 | app/test 默认值、相对/绝对路径、空白值、显式覆盖及现有档位优先级正确 |
| 两类根独立 | 修改日志根不改变数据根，修改数据根不改变日志根 |
| 仓储与装配 | 三类记录使用新数据根；不在日志根创建 trades；业务事件仍连接同一仓储 |
| 重启恢复 | 重新创建仓储可恢复进度与完成记录；相关恢复、亏损分段及冷却测试保持通过 |
| 香港日期与严格失败 | 日期边界、旧格式拒绝、损坏记录拒绝、幂等与故障封锁规则不变 |
| 留存 | 仍是最新 7 个日文件窗口；当前日/恢复所需日保护及清理行为不变 |
| 工具与隔离 | 费用工具读取显式数据根、仅计算普通成交；测试不写生产数据，临时环境变量得到恢复 |

保持既有高价值回归即可；不为属性改名、常量搬迁或每个路径调用点新增重复测试。

### 6.2 执行顺序

在独立验证进程中准备环境：

- 显式设置 `APP_RUNTIME_PROFILE=test`、`APP_ENABLE_PROCESS_HOOKS=false`。
- 显式将 `APP_LOG_ROOT_DIR`、`APP_DATA_ROOT_DIR` 指向当前工作区的 `tests/logs`、`tests/data`，需要独立运行时由受控启动器指定临时根。
- 测试使用 `--no-env-file`，子进程沿用现有隔离环境构造器；不依赖宿主的生产路径或凭据。

按顺序执行，任一步失败先解决，不跳过：

```text
bun lint:fix
bun type-check
bun --no-env-file test tests/config/runtime tests/infrastructure/persistence/mixedTradeLogRepository tests/app/runtime/createPostGateRuntime.tradeLogPersistence.test.ts tests/tools/calculateTradingFees
```

随后运行第 4.4 节列出的终止装配、启动恢复及相关集成测试。logger 的既有业务测试用于确认日志路径未受影响。只扩展到此次影响的测试；相关检查通过后，没有新改动、失败或未解决疑点时，不重复或扩大验证。

正常 lint 自动修复若产生变化，检查 diff 确认没有夹带无关修改；不得覆盖已有未提交工作。验证不通过 `bun start`、`bun dev` 或真实交易会话完成。

### 6.3 遗留引用检查

搜索并人工分类以下引用，而非要求全仓字符串为零：

- `resolveLogRootDir`：允许配置、logger 及日志测试保留；仓储依赖和交易装配不得再使用。
- `APP_LOG_ROOT_DIR`：允许日志相关配置保留；不得作为交易数据根。
- `logs/trades`、`logs\\trades` 及分段拼接 `'logs', 'trades'`：生产路径和工具读取必须清除；迁移说明或有意的负向测试可以保留。
- `LOGGING.MAX_RETAINED_LOG_FILES`：仅诊断日志使用，交易仓储改用独立常量。
- `buildTradeLogPath`、`createMixedTradeLogRepository`：检查所有调用参数、mock、fixture 和路径断言已切换。

只检查和修改被本次路径切换实际影响的导出、调用、配置、测试、文档及工具，不顺带重构其他模块。

## 7. 实施阶段与完成标准

### 阶段 A：完成代码切换

- [ ] 数据根配置与日志根完全独立。
- [ ] 仓储和装配只接受新的数据根依赖，无旧属性别名。
- [ ] 交易留存常量独立，原算法和数值保持不变。
- [ ] 工具、测试隔离、相关引用和项目说明同步更新。

### 阶段 B：完成离线验证

- [ ] `bun lint:fix`、`bun type-check` 与相关测试通过。
- [ ] 新目录落盘与恢复行为通过现有仓储/业务测试验证。
- [ ] 日志路径未改变，测试没有写入生产数据根。
- [ ] 已检查遗留依赖，未引入兼容层或无关改动。

### 阶段 C：完成现场迁移

- [ ] 重新确认实际根目录、目录内容及所有写入者已停止。
- [ ] 当前空目录按最小步骤切换；如有历史数据，完整性检查和只读扫描均通过。
- [ ] 旧交易目录已移除，新旧程序没有并行写入。
- [ ] 需要时已有独立备份与明确回退边界，切换后的记录不会被旧备份覆盖。

完成定义：交易持久化仅依赖新的数据根，默认路径为 `data/trades/`；诊断日志继续使用日志根；旧目录不再参与运行；迁移不丢失记录，业务协议与恢复语义保持不变。

本文件是复核后的实施方案，不代表上述检查、代码修改或迁移已经执行。
