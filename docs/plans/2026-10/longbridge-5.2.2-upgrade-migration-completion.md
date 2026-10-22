# Longbridge 5.2.2 升级迁移实施与验收记录

> 状态：离线实施与 Windows x64 验收完成。本文不是生产上线许可；真实券商网络、目标部署环境和非 Windows 平台仍需按原迁移方案另行验证。

## 1. 交付基线

- 初始仓库 HEAD：`0418b60fc62216e4a1ce79055a7f6eda43b2615f`。
- 初始工作区基线 tree：`37f12f9b3428ebf79518b25430b13d1e6b990140`。
- 实施分支：`refactor/longbridge-5.2.2-migration`。
- 独立 worktree：`D:/Code/HSI-Strategy-Trading-worktrees/longbridge-5.2.2-migration`。
- 已验收代码 tree（不含本文档）：`f0771f19445c8d9147520cd465507d4a224b7fd1`。
- 实施以任务开始时保存的 HEAD 叠加当时 33 项工作区内容为基线；任务期间原 `beta-V2` 的后续提交和合并未吸收到本 worktree。用户将自行处理最终合并。

## 2. 实施结果

### 2.1 依赖

- `longbridge` 由精确版本 `4.4.3` 升级为精确版本 `5.2.2`。
- Windows x64 MSVC、Linux x64/arm64 GNU、macOS x64/arm64 五个平台原生包均锁定为 `5.2.2`。
- 其余 165 个锁定包未变化；未升级 Bun、Node.js、TypeScript 或其他依赖。
- Linux 包仍为 GNU/glibc 目标，不代表支持 musl/Alpine。

### 2.2 SDK 基础设施边界

- 新增基础设施私有 `BrokerSdkContext`，仅包含系统实际使用的 11 个 `TradeContext` 方法，方法类型直接取自 SDK 声明。
- 生产 factory 仍在原位置调用 `TradeContext.new(config)`，并将同一个真实对象原样传给 adapter；没有复制、解构或重新绑定方法，SDK 方法的 `this` 接收者保持不变。
- 中性 `BrokerAccess` 端口、唯一 Context 装配时机、生命周期与清理顺序未改变。
- 测试夹具删除了九个无关 SDK 方法桩和两处完整 `TradeContext` 断言；未伪造 `allExecutions`、多腿单或网格能力。

### 2.3 DTO、Mock 与枚举

- 普通 `Order` / `OrderDetail` 测试对象补充 `multiLeg: null`、`delayedUntil: null`。
- `PushOrderChanged` 仅补充 `multiLeg: null`，没有错误添加 `delayedUntil`。
- 完整夹具、通用工厂、提交后查询/detail、内部订单转 push、非 HK push 和局部 detail 替身均已覆盖。
- 轮证测试改用 `WarrantStatus.Normal`，并验证 `Unknown`、`Suspend`、`PrepareList` 均映射为 `NON_NORMAL`；生产轮证逻辑和到期日政策未改变。
- `OrderStatus.DelayedNotReported` 继续明确拒绝：批准验证返回 `false`，生命周期和详细状态映射均抛出原有契约错误；没有映射为 `OPEN`、普通挂单或终态。

### 2.4 业务不变量

独立端到端复核确认本次差异未改变以下链路：

- 行情 Context、WebSocket 订阅、`realtimeQuote`、一分钟线 seed + push 缓存及乱序/确认状态规则。
- BUY/SELL、LO/ELO/MO、DAY 提交范围和 SDK Decimal 文本精度、容量检查。
- 请求 ACK 不等于订单终态；提交 `UNKNOWN` 仍进入既有 fatal 终止链路，不查询重提、不新增通用重试。
- snapshot/detail/push 的 HK 过滤、非法事实 fail-fast、累计数量与均价事实形成方式。
- 盯单、撤改单、恢复、保护性清仓、末日清仓、冷却、亏损分段和持久化 V1 语义。
- fatal 后关闭门禁、排空处理器、停止盯单和清理行情的既有顺序。

没有引入 execution ledger、延迟单、多腿单、网格、第二套 adapter、新持久化格式或新依赖。

## 3. 实际变更范围

相对保存的基线，共有 16 个已验收代码/配置文件发生变化：

1. `package.json`
2. `bun.lock`
3. `src/infrastructure/longbridge/trade/types.ts`
4. `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts`
5. `src/infrastructure/longbridge/trade/orderValidation.ts`
6. `src/infrastructure/longbridge/trade/orderMapper.ts`
7. `tests/infrastructure/longbridge/trade/brokerIngressFixture.ts`
8. `tests/infrastructure/longbridge/trade/orderFactMapper.test.ts`
9. `tests/infrastructure/longbridge/trade/orderDetailReadAdapter.test.ts`
10. `tests/infrastructure/longbridge/trade/tradeContext.contract.test.ts`
11. `tests/infrastructure/longbridge/trade/orderValidation.test.ts`
12. `tests/infrastructure/longbridge/trade/orderReadMetadata.test.ts`
13. `tests/infrastructure/longbridge/market/quoteFinancialMapper.test.ts`
14. `mock/factories/tradeFactory.ts`
15. `mock/longbridge/tradeContextMock.ts`
16. `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts`

原方案列出 12 个文件，实施时增加了四项直接相关变化：

- `mock/longbridge/tradeContextMock.ts`：其提交与 push 路径独立生产 SDK DTO，不能只修通用工厂。
- `tests/infrastructure/longbridge/trade/orderDetailReadAdapter.test.ts`：局部 `OrderDetail` 替身补齐新版字段。
- `src/infrastructure/longbridge/trade/orderMapper.ts`：新版枚举触发 switch 穷尽检查，显式加入 `DelayedNotReported` 的既有拒绝分支。
- `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts`：全量 `lint:fix` 产生一处空行，用户已明确同意保留；无业务或测试语义变化。

本文档为第 17 个交付文件，仅记录实施与验收结果。

## 4. 验收结果

### 4.1 静态检查与构建

按项目顺序执行，均退出 0：

1. `bun --no-env-file lint:fix`
2. `bun --no-env-file type-check`，实际脚本仍为 `bun check -p tsconfig.json`
3. `bun --no-env-file run build`，包含原有 clean

### 4.2 完整测试

最终无过滤执行 `bun --no-env-file test`：

- 321 个测试文件。
- 3549 项通过，0 项失败，0 项跳过，0 项 todo。
- 23245 次 `expect()` 调用。
- `tests/config/longbridgeOAuthConfig.business.test.ts` 的 9 项测试全部通过。

第一次完整测试曾因外部验证 launcher 覆盖 `APP_LOG_ROOT_DIR`，与运行时默认路径测试冲突而出现 1 项失败。该问题经独立诊断确认不属于 SDK 或仓库代码回归；移除外部 launcher 的路径覆盖、保留凭据白名单与离线 SDK 防护后，未修改源码或断言，最终完整测试全绿。

### 4.3 冻结安装与原生检查

在全新的 Windows x64 外部目录中执行：

- `bun --no-env-file install --frozen-lockfile`：退出 0，未复用 worktree 的 `node_modules`。
- 安装版本：`longbridge@5.2.2`、`longbridge-win32-x64-msvc@5.2.2`。
- 原生 smoke：版本、Decimal `0.1 + 0.2 = 0.3`、高精度文本、NaiveDate、轮证状态值、`DelayedNotReported = 18` 及新增 DTO getter 均通过。
- 未创建 SDK Context，未调用认证、行情或交易网络接口。
- `bun.lock` SHA-256 在冻结安装前后均为 `1AB363407A4152DB68EE2254B52C7C703278898CE20224D2B76424F61DDAB903`。

### 4.4 独立复核

不同只读复核成员分别完成：

- 方案逐项落实、类型/架构边界、依赖锁、DTO 生产者、测试价值和残留引用检查。
- 从应用装配、行情、轮证、下单、ACK/UNKNOWN、订单事实、盯单/恢复到 fatal cleanup 的端到端交易链路检查。

两次复核均未发现本次迁移引入的已确认缺陷。该结论仅覆盖静态实现与离线验证范围。

## 5. 已知边界与上线前条件

以下内容未由本次离线交付验证，不能据此直接放行生产：

- Linux/macOS 目标平台的冻结安装和原生加载。
- 真实 OAuth、凭证续期、行情、订单回报、撤改单、网络错误形状和断线重连。
- 最终服务环境的 `LONGBRIDGE_QUOTE_TRANSPORT`；必须确认未设置或明确为 `ws`。
- 共享账户中的 HK 订单不得依赖本系统尚未支持的延迟单、多腿单等能力。
- 真实部署时的单交易实例、恢复、交易门禁、受控联调和回滚条件。

## 6. 证据与合并说明

完整证据保存在：

`C:/WINDOWS/TEMP/longbridge-5.2.2-baseline-8db217832e1540cfac1b5a195f6b4670`

最终测试及 Windows 冻结安装证据：

`final-test-install/attempt-02`

实施和验收阶段没有提交、推送、合并或变基；交付阶段在独立分支创建一个英文迁移提交，未推送、合并或变基。该提交通过迁移增量的临时 index 构建，不包含任务开始前已有的工作区修改。

`tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts` 在保存的基线上只有一处经用户批准的格式空行，但该文件同时包含任务前已有修改。为避免把既有修改带入迁移提交，该空行不单独进入提交；用户当前 `beta-V2` 已具有等价格式。完整的 17 文件基线补丁仍保留该差异。

交付补丁以任务开始时保存的基线 tree 为父级，仅包含本次迁移增量；由于原 `beta-V2` 在任务期间另有提交和合并，应用补丁或提交时应由用户在当前分支审查冲突和并行业务变化，不应直接把整个旧 worktree 覆盖到新分支。
