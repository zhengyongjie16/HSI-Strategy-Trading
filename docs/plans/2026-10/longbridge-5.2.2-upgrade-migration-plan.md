# Longbridge 4.4.3 → 5.2.2 升级迁移与优化方案

> 复核日期：2026-10-22。状态：方案已复核，待实施；不是升级完成记录，也不是生产上线许可。本次交付仅新增本文档，未修改依赖、锁文件、生产代码或测试。

## 1. 目标与结论

将项目使用的 `longbridge` 从精确版本 `4.4.3` 升级到精确版本 `5.2.2`，修复已证实的兼容问题，并收窄基础设施对 SDK 的能力依赖，不改变现有交易业务。

结论：

1. 截至复核时，npm `latest` 仍为 `5.2.2`，npm 发布时间为 **2026-10-19**。官方 changelog 中该版本日期为 **2026-10-16**；两者分别是 npm 发布日期和变更记录日期，不应混为一谈。
2. `4.4.3 → 5.2.2` 包含破坏性变更，不是只修改版本号即可完成的升级。
3. 当前已确认的阻塞为 **7 处测试夹具类型错误和 1 项轮证枚举硬编码测试失败**；未发现必须重写现有生产交易状态机的证据。
4. 生产构建、原生加载和相关业务离线回归通过，不代表真实认证、行情网络、订单回报及重连行为已验证。
5. 推荐方案是“依赖升级 + DTO 适配 + 命名枚举修复 + 私有 SDK 能力契约收窄 + 新状态拒绝测试”，不引入兼容层、第二套 adapter 或新交易能力。

实施时仍以 `5.2.2` 为本方案的固定目标。若届时 npm `latest` 已变化，不自动追随新版本，必须先补充版本差异复核。

## 2. 复核基线与验证证据

### 2.1 基线

- 仓库 HEAD：`0418b60fc62216e4a1ce79055a7f6eda43b2615f`。
- 检查对象是上述 HEAD **叠加复核时工作区的未提交修改**，不是纯 HEAD。
- 复核开始时已有 31 个工作区修改条目，包含持久化路径和测试运行时调整；这些变更不属于本次 SDK 升级，必须保留并与升级变更分离。
- `package.json:21`、`bun.lock:981` 和本地安装包均为 `4.4.3`。
- 本机验证环境：Windows x64、Bun `1.4.4`、Node.js `v24.20.0`。
- `tsconfig.json` 检查范围包含 `src`、`tools`、`tests`、`mock`，复核时共 780 个项目入口文件。
- 文档写作期间，工作区 `package.json` 的 `type-check` 脚本由 `tsc -p tsconfig.json` 改为 `bun check -p tsconfig.json`；该修改不由本任务实施，也未被覆盖。本文的 780 文件结果来自 TypeScript Compiler API，不是对后来修改的脚本的验证；新版脚本必须在实际实施时单独验收。

### 2.2 验证方式

1. 从 npm registry 核验版本、发布时间、发布包和对应 `gitHead`。
2. 比较实际发布包 `index.d.ts`，不以 SDK 主干源码代替已发布的 Node.js 类型契约。
3. 核对 `5.2.2` 主包及 Windows 原生包 tarball 的 SHA-512 integrity。
4. 使用 TypeScript Compiler API，仅将 `longbridge` 的类型解析分别指向两个版本的发布声明，其他项目配置保持不变；确认编译器实际加载了目标声明。
5. 将当前源码及相关测试复制到临时隔离目录，仅切换该目录中的 SDK 包解析，保留原项目依赖不动。
6. 隔离测试未复制真实认证文件；测试子进程移除 Longbridge 凭证相关环境变量，并使用独立日志和数据目录。
7. 不修补隔离副本源码，直接记录升级前后差异；未调用真实行情、交易或 OAuth 网络工厂。

### 2.3 本轮重新执行的结果

| 检查 | 4.4.3 | 5.2.2 |
| --- | --- | --- |
| 同范围 780 文件类型检查 | 0 错误 | 7 处错误，均在测试夹具 |
| SDK 与认证相关测试，22 个文件 | 306 通过，0 失败 | 305 通过，1 失败 |
| 订单追踪、买卖处理、原生边界集成与轮证选择，49 个文件 | 本轮未重复运行 | 609 通过，0 失败 |
| 生产构建 `bun run build` | 本轮未重复运行 | 通过 |
| Windows/Bun 原生加载、关键枚举、Decimal 与 NaiveDate smoke check | 本轮未重复运行 | 通过 |

新版针对性测试合计 **915 项：914 通过，1 失败**。失败已经定位，但尚未修复，不能写成“升级验证全通过”。

这些结果已在包含当前未提交修改的新隔离副本上复现，取代“只依赖早先副本结果”的假设。实施过程中如工作区再次变化，仍需以新的待发布版本重新验收。

### 2.4 未验证范围

- 真实 OAuth 登录、凭证续期、账户权限及券商网络错误形状。
- 实时行情、真实订单回报、改单、撤单及断线重连。
- Linux/macOS 原生二进制运行。
- 全仓测试及所有部署组合。
- 实际升级安装后完整锁文件和各部署平台的安装可复现性。
- 生产性能提升幅度。

## 3. 兼容性复核

### 3.1 订单 DTO 和 Context 的新增成员

实际发布声明中的新增内容：

| 对象 | 新增内容 | 项目影响 |
| --- | --- | --- |
| `Order`、`OrderDetail` | `multiLeg: MultiLegInfo \| null`、`delayedUntil: Date \| null` | 构造普通订单替身时需明确提供 `null` |
| `PushOrderChanged` | `multiLeg: MultiLegInfo \| null` | 完整推送夹具缺字段，类型检查失败 |
| `TradeContext` | `setOnGridOrderChanged`、`allExecutions`、`submitMultileg` | 过宽的完整 Context 夹具被迫要求实现项目未使用的方法 |

`PushOrderChanged` 本次新增的是 `multiLeg`，不要照搬查询 DTO，错误地要求推送必须具有 `delayedUntil`。

类型错误位置：

| 文件 | 复核时行号 | 根因 |
| --- | --- | --- |
| `tests/infrastructure/longbridge/trade/brokerIngressFixture.ts` | 301、1068 | 推送缺少 `multiLeg` |
| 同上 | 413、445、487 | `OrderDetail` 产出路径缺少 `multiLeg`、`delayedUntil` |
| 同上 | 611 | `Omit<TradeContext, ...>` 随 SDK 新增方法而失效 |
| `tests/infrastructure/longbridge/trade/orderFactMapper.test.ts` | 248 | 单独构造的非 HK 推送缺少 `multiLeg` |

这是新增 SDK 能力对完整结构化测试替身造成的契约破坏，不等于普通下单调用签名失效。

### 3.2 `WarrantStatus` 枚举重排

Node.js 发布包中的实际值：

| 成员          | 4.4.3  | 5.2.2 |
| ------------- | ------ | ----- |
| `Unknown`     | 不存在 | 0     |
| `Suspend`     | 0      | 1     |
| `PrepareList` | 1      | 2     |
| `Normal`      | 2      | 3     |

`tests/infrastructure/longbridge/market/quoteFinancialMapper.test.ts:26` 写死 `status: 2`，新版将其解释为 `PrepareList`，从而得到 `NON_NORMAL`，导致唯一已复现的测试失败。

生产请求和响应边界使用命名枚举：

- `src/infrastructure/longbridge/market/warrantRequestMapper.ts:79`。
- `src/infrastructure/longbridge/market/quoteFinancialMapper.ts:59–65`。

因此不需要把生产逻辑改成另一个数字。需要修改测试、检查受影响的枚举消费，并清理重建产物，避免旧版本 `const enum` 内联数值与新版原生包混用。

### 3.3 轮证到期日变为可空

`WarrantInfo.expiryDate` 从 `NaiveDate` 改为 `NaiveDate | null`，用于避免单条异常到期日导致整个轮证列表反序列化失败。

当前项目使用 SDK 请求端的到期范围过滤，生产 mapper 不消费返回的 `expiryDate`，所以没有直接的空值解引用迁移项。本次不新增本地到期日筛选，也不改变候选筛选规则。未来如消费该字段，必须先定义缺失日期的业务政策，不能默认成一个有效日期。

### 3.4 新订单状态 `DelayedNotReported`

新版新增 `OrderStatus.DelayedNotReported = 18`，表示时间条件订单尚在监控、未报送交易所。现有状态的枚举值未因此重排。

本项目当前：

- `src/infrastructure/longbridge/trade/orderValidation.ts` 的批准成员与生命周期表不接纳此状态。
- `src/infrastructure/longbridge/trade/orderMapper.ts` 的详细状态映射也不接纳此状态。
- 普通下单未设置 `delayedUntil`。
- 同账户外部创建的 HK 延迟单仍可能通过订单快照或推送进入边界。

本次保持既有拒绝政策：快照验证不放行，推送按现有非法事实错误链路处理。旧版会把该服务端状态视为未知状态并拒绝，因此这不是已确认的新生产故障。

**不得只增加一条 `OPEN` 映射就声称支持延迟单。** 若确有需求，应另外设计状态映射、提交时间、撤改单、超时、占用和重启恢复语义；在那之前，部署账户的受管理 HK 订单不应依赖该能力。

### 3.5 其他上游破坏性变更

| 变更 | 当前项目判断 |
| --- | --- |
| `optionChainInfoByDate` 返回 `OptionChainContract[]`，不再返回 `StrikePriceInfo[]` | 当前未调用；牛熊证列表不是该期权链接口 |
| `FundPosition.symbol` 改为 `counterId` | 当前生产读取股票持仓，不消费基金持仓 |
| 部分基本面 API 移除或使用新的参数类型 | 当前未使用 |
| `AgentContext.conversationStreamed` 增加位置参数 | 当前未使用 |

本表是与项目相关的迁移摘要，不是 SDK 全量发行说明。不要为未使用的接口编写迁移层。

固定版本的 `Config`、`Decimal`、`NaiveDate`、`PushCandlestickEvent`、`TradeSessions` 和 `PushCandlestickMode` 去除注释后的声明未变；这仅证明类型契约没有变化，不证明所有网络运行时行为相同。

## 4. 业务不变量和范围控制

升级必须保持：

1. 现有 BUY/SELL、LO/ELO/MO、DAY 提交范围；读取端原本支持的订单类型也不随意收窄。
2. 唯一行情/交易 Context 的装配时机、生命周期和清理顺序。
3. WebSocket 推送、`realtimeQuote`、一分钟线 INTRADAY 订阅以及 seed + push 缓存路径。
4. 现有未确认柱、确认收线、乱序及旧席位事件处理规则。
5. 原生 Decimal 仅在 SDK 边界使用，金融文本保真和独立容量检查不变。
6. 以订单累计数量和均价等已批准字段形成事实，不引入 execution ledger。
7. 请求 ACK 不等于订单终态；提交 `UNKNOWN` 仍按既有终止规则处理，不查询重提、不新增通用重试。
8. 外部业务失败仍由原所属链路处理；内部契约错误仍 fail-fast。
9. 不修改保护性清仓、末日清仓、亏损分段、买入冷却和启动恢复政策。
10. 不迁移持久化数据格式，不回填历史订单，不修改已有 frozen V1 数据语义。

本次不接入延迟单、多腿单、网格、基金、HTTP-only 主行情或第二套 SDK adapter；不新增依赖。

## 5. 按文件实施方案

### 5.1 依赖精确升级

修改 `package.json` 和 `bun.lock`：

```powershell
bun add --exact longbridge@5.2.2
```

要求：

- 只升级 Longbridge 及它的平台原生包，不执行全量依赖更新。
- 检查锁文件中其他依赖变化是否由本次升级必然引起；与当前未提交 `package.json` 修改分开判断。
- 部署使用冻结锁文件安装；不能只复制 JavaScript 主包而遗漏平台原生包。
- `5.2.2` 的 npm 原生包目标仍为 Windows x64 MSVC、Linux x64/arm64 GNU、macOS x64/arm64。不要把 Linux GNU 的兼容性修复理解为恢复了 Node.js musl/Alpine 原生包支持。
- 不同时调整 TypeScript、Bun、Node 或 `isolatedModules` 等编译选项。

### 5.2 收窄私有 SDK Context 契约

修改：

- `src/infrastructure/longbridge/trade/types.ts`。
- `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts`。
- `tests/infrastructure/longbridge/trade/brokerIngressFixture.ts`。

在现有基础设施 `types.ts` 中增加行为接口，方法类型直接取自 SDK：

```typescript
import type { TradeContext } from 'longbridge';

/** 交易基础设施实际消费的同一 SDK Context 能力，不向业务公共端口暴露。 */
export interface BrokerSdkContext {
  readonly setOnOrderChanged: TradeContext['setOnOrderChanged'];
  readonly subscribe: TradeContext['subscribe'];
  readonly unsubscribe: TradeContext['unsubscribe'];
  readonly historyOrders: TradeContext['historyOrders'];
  readonly todayOrders: TradeContext['todayOrders'];
  readonly orderDetail: TradeContext['orderDetail'];
  readonly submitOrder: TradeContext['submitOrder'];
  readonly replaceOrder: TradeContext['replaceOrder'];
  readonly cancelOrder: TradeContext['cancelOrder'];
  readonly accountBalance: TradeContext['accountBalance'];
  readonly stockPositions: TradeContext['stockPositions'];
}
```

实施细节：

1. 合并现有 import，不新增重复导入或 re-export。
2. `createBrokerAccessAdapter` 参数改为 `BrokerSdkContext`；返回的中性 `BrokerAccess` 不变。
3. `createBrokerAccessFactory` 仍在原位置调用 `TradeContext.new(config)`，将真实对象原样交给 adapter。
4. 夹具 `context` 使用同一接口，不再使用 `Omit<TradeContext, 'todayExecutions' | 'historyExecutions'>`。
5. 删除夹具 `brokerAccess` 和 `ports` 两个调用点的 `as TradeContext`。
6. 删除夹具因完整 SDK 类型才保留的九个无关方法桩：`cashFlow`、`fundPositions`、`marginRatio`、`usQueryOrders`、`usOrderDetail`、`usAssetOverview`、`usRealizedPl`、`orderDetailAttached`、`estimateMaxPurchaseQuantity`。
7. 保留仍被真实请求失败断言使用的 `unexpected` 函数，不因删除桩而误删。
8. 不添加 `allExecutions`、`submitMultileg` 或网格订阅的虚假实现。
9. 不复制、解构或重新绑定 SDK 方法，保持调用接收者 `this` 和请求行为。

这项优化修复的是“项目只依赖 11 个方法，却要求测试实现整个 SDK”的共享契约根因。只收窄测试而继续断言成完整 `TradeContext` 不是完整方案。

接口仅允许基础设施内部及对应基础设施测试消费；不移到 `src/types`、domain 或 application，不扩大公共端口，也不修改架构冻结白名单来掩盖 SDK 泄漏。

### 5.3 补齐完整订单夹具

修改：

- `tests/infrastructure/longbridge/trade/brokerIngressFixture.ts`。
- `tests/infrastructure/longbridge/trade/orderFactMapper.test.ts`。

具体动作：

- 两处 `PushOrderChanged` 产出补 `multiLeg: null`。
- 共享 `detailFields` 补 `multiLeg: null`、`delayedUntil: null`，核对初始 detail、`createDetailFrame` 和 `parseFrozenV1Orders` 都从该基线继承。
- `orderFactMapper.test.ts` 单独构造的非 HK push 补 `multiLeg: null`，即使运行时会先过滤，也应满足声明的 DTO 契约。
- 不新增 `any`、双重断言或可选属性来躲过新版字段要求。
- 不改变时间、金融值、推送顺序、getter 错误注入或 `toJSON` 的既有测试用途。

`null` 的含义是“该普通订单没有这类属性”，不代表新增对多腿/延迟单的处理。为普通历史夹具补字段只发生在测试 DTO 生成阶段，不改写 frozen V1 历史数据格式。

### 5.4 同步通用订单 Mock

修改：

- `mock/factories/tradeFactory.ts`。
- `tests/infrastructure/longbridge/trade/tradeContext.contract.test.ts`。

动作：

- `createOrder` 补 `multiLeg: null`、`delayedUntil: null`。
- `createPushOrderChanged` 补 `multiLeg: null`。
- 在现有 infra 契约测试中，直接断言这些字段为 `null`。
- 在现有“无 execution ledger 能力”测试中补充 `allExecutions` 不存在的断言。

复核发现这些通用工厂已有 `as unknown as Order` / `PushOrderChanged`，会掩盖新增字段遗漏，所以不能仅凭 7 处编译诊断判断所有 Mock 已适配。本轮只修复新增字段及其检查，不顺手重构所有旧 Mock，也不声称工厂已经全部获得严格结构类型校验。

### 5.5 修复轮证枚举测试

修改 `tests/infrastructure/longbridge/market/quoteFinancialMapper.test.ts`：

- 导入 `WarrantStatus`。
- 用 `WarrantStatus.Normal` 替换 `status: 2`，不是替换成 `status: 3`。
- 增加一组行为断言：`Normal → NORMAL`，`Unknown / Suspend / PrepareList → NON_NORMAL`。
- 保留原金融文本独立 oracle 和容量截尾检查。

不需要修改 `quoteFinancialMapper.ts` 或 `warrantRequestMapper.ts` 的正常状态逻辑，也不新增到期日缺失的本地 fallback。

### 5.6 显式记录不支持延迟单

修改：

- `src/infrastructure/longbridge/trade/orderValidation.ts`，仅修正“穷尽 SDK 生命周期”的注释。
- `tests/infrastructure/longbridge/trade/orderValidation.test.ts`。
- `tests/infrastructure/longbridge/trade/orderReadMetadata.test.ts`。

新增或合并到现有用例的断言：

- `isValidatedOrderStatus(OrderStatus.DelayedNotReported)` 为 `false`。
- `classifyBrokerOrderStatusLifecycle(OrderStatus.DelayedNotReported)` 抛错。
- `mapBrokerOrderStatus(OrderStatus.DelayedNotReported)` 抛错。

测试说明改为覆盖“本系统明确支持的状态与拒绝政策”，不继续声称穷尽全部 SDK 状态。生产默认拒绝分支无需为本次升级额外增加兼容处理。

### 5.7 变更范围汇总

| 文件 | 预期变化 |
| --- | --- |
| `package.json`、`bun.lock` | 固定版本及对应平台包 |
| `src/infrastructure/longbridge/trade/types.ts` | 私有 11 方法行为接口 |
| `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts` | 使用窄接口，不改运行时装配 |
| `src/infrastructure/longbridge/trade/orderValidation.ts` | 准确描述支持范围的注释 |
| `tests/infrastructure/longbridge/trade/brokerIngressFixture.ts` | DTO 字段、窄接口、删除无关桩及两处断言 |
| `tests/infrastructure/longbridge/trade/orderFactMapper.test.ts` | 单独 push 的新增字段 |
| `mock/factories/tradeFactory.ts` | 普通订单和推送新增字段 |
| `tests/infrastructure/longbridge/trade/tradeContext.contract.test.ts` | 新字段及无 ledger 能力断言 |
| `tests/infrastructure/longbridge/market/quoteFinancialMapper.test.ts` | 命名状态枚举及非正常状态断言 |
| `tests/infrastructure/longbridge/trade/orderValidation.test.ts` | 延迟状态拒绝及注释 |
| `tests/infrastructure/longbridge/trade/orderReadMetadata.test.ts` | 延迟状态详细映射拒绝 |

按当前代码预计涉及 12 个文件。实施时允许处理直接相关的遗漏引用，但不得扩展到无关的持久化、策略或 Mock 重构。

## 6. 升级收益与暂缓优化

### 6.1 直接获得的 SDK 修复

- 轮证异常到期日和未知状态不会再轻易令整个列表解析失败，直接贴合自动寻标场景。
- Context 释放时停止后台重连，减少遗留任务及其资源占用。
- 进程内共享 HTTP 连接池、DNS/TLS 资源。
- 更多可选响应字段可以正确处理显式 JSON `null`；应用层仍保留自己的事实校验。
- Linux GNU 原生构建降低对较新 glibc 的依赖；实际目标系统仍需独立加载验证。

项目已复用 Context，不是高频创建大量 Context 的场景，因此不夸大连接池共享或重连修复的收益；也不为利用它们改成频繁重建 Context。

### 6.2 主行情保持 WebSocket

本次不启用 `QuoteTransport.Http`，原因是主链路需要推送、订阅及 `realtimeQuote`；HTTP transport 只影响部分请求/响应查询，不能替代这些能力。

**复核补充：配置代码不显式传 `quoteTransport`，不代表部署环境无法改变它。** `5.2.2` 的 `Config.fromApikey` / `Config.fromOAuth` 会自行读取 `LONGBRIDGE_QUOTE_TRANSPORT`，而项目当前中性配置读取器没有管理该字段。

上线必须检查真实服务进程的最终环境（含启动器、服务配置和环境文件注入）：

- 该变量未设置，使用 SDK 默认 `ws`；或明确为 `ws`。
- 为 `http` 或其他未批准值时，先处理配置，不按本方案直接放行上线。
- 本轮没有读取用户真实认证配置，因此未确认实际部署是否存在该变量。

本次不新增 HTTP 配置抽象。未来如有独立纯拉取任务，再单独设计配置校验、枚举映射、错误分类及限流；HTTP 路径的错误形状和客户端限流并不与 WebSocket 完全相同。

### 6.3 不采用的新能力

延迟单、多腿单、网格、基金、附加单扩展和 `allExecutions` 都不是本次升级的前置要求。它们需要独立业务设计，不作为“顺便优化”接入。

官方主干的 `Unreleased` 修复不能当作 `5.2.2` 已有能力，例如期权链 HTTP 路径的后续修复；本项目未用该接口，不据此扩大本次迁移。

### 6.4 效果观察

使用现有日志和进程监测对照相近负载下的轮证查询失败、启动/重建耗时、驻留内存和重连情况。不新增监控平台，不承诺未经测量的性能比例。

## 7. 执行与验收流程

### 7.1 保存并确认基线

1. 记录待升级代码版本、工作区状态、运行时版本和依赖版本。
2. 保留现有未提交工作，不自动 reset、stash、覆盖或混合提交。
3. 若基线相较本文复核对象变化，先重跑受影响的旧版检查，区分既有失败与升级失败。
4. 在隔离分支/工作目录实施，使用独立测试数据和日志根；不复制真实认证文件。

不能直接运行 `bun start` 或 `bun dev` 作为离线验证。`RUN_MODE=dev` 不等于券商模拟盘。

### 7.2 完成迁移并做静态检查

依次完成第 5 节改动后执行：

```powershell
bun lint:fix
bun type-check
bun run build
```

每一步非零退出必须先处理，不继续宣告后续结果合格。`lint:fix` 之后检查 diff，不能把无关格式修复或用户已有修改混入升级。实施时核对 `type-check` 脚本的实际内容；当前工作区已改为 `bun check -p tsconfig.json`，不能假定其结果与本文 TypeScript Compiler API 检查等价，也不能为了消除 SDK 报错擅自回改这项并行变更。

`build` 已包含 clean。SDK 使用 `const enum`，必须清理并重建，不复用旧 `dist` 或其他旧编译缓存，也不放宽类型检查来绕过夹具错误。

### 7.3 测试安排

最终验收运行一次完整测试：

```powershell
bun test
```

开发定位阶段可使用以下范围；已通过且没有新改动时，不机械重复运行同一组测试：

```powershell
bun test tests/infrastructure/longbridge tests/config/auth
bun test tests/application/orderTracking tests/runtime/asyncProgram/buyProcessor tests/runtime/asyncProgram/sellProcessor tests/integration/architectureRefactoringP1Native tests/domain/seat/warrantSelection
bun test tests/architecture/refactoring
```

核心验收行为：

| 范围           | 必须成立                                             |
| -------------- | ---------------------------------------------------- |
| 原生 Decimal   | 精度、截尾/下溢拒绝和文本转换保持不变                |
| 轮证列表       | 使用命名枚举，Unknown 不当成 Normal，原筛选/缓存不变 |
| 订单查询与推送 | 普通 DTO 完整，字段保真，非 HK 过滤不变              |
| 订单状态       | 延迟状态仍拒绝，不默认当成普通挂单或终态             |
| Context        | 同一真实对象和原接收者，无多余工厂、无 ledger 能力   |
| 买卖与盯单     | 提交/撤改/部分成交/恢复行为及失败分类不变            |
| K 线           | seed、确认收线、乱序与重复更新规则不变               |
| 架构           | SDK 契约留在 infra，不放宽冻结基线                   |

通用工厂的新增字段需有直接断言，不能依赖旧双重断言提供编译期保证。不为无关 SDK 新 API 添加覆盖率测试。

### 7.4 安装与原生平台检查

在干净、与部署目标一致的环境中执行：

```powershell
bun install --frozen-lockfile
bun -e 'const sdk = require("longbridge"); const assert = require("node:assert/strict"); assert.equal(require("longbridge/package.json").version, "5.2.2"); assert.equal(new sdk.Decimal("0.1").add(new sdk.Decimal("0.2")).toString(), "0.3"); console.log("Longbridge 5.2.2 native smoke passed");'
```

该 smoke check 不调用认证或网络工厂。Windows 验证不能替代 Linux/macOS 验证；部署平台缺少所需原生包或加载失败时不得上线。

### 7.5 遗留检查

实施完成前定向检查：

- `4.4.3` 的活动依赖和旧构建产物是否残留；历史分析文档不应机械替换成新版。
- 轮证状态裸数字、完整 `Omit<TradeContext, ...>`、夹具两处 `as TradeContext` 是否已消除。
- 普通订单和推送所有生产者是否补齐新版字段。
- 接口调用方、导入、测试、注释与内部装配路径是否一致。
- 本次删除方法桩后是否只清除了真正不再使用的导入和定义。
- 未使用的新 SDK 方法是否意外进入业务层或测试业务口径。
- 锁文件变化是否局限于本次依赖升级，现有未提交工作是否被保留。

对 `docs/` 和 `tools/` 仅检查本次直接涉及的引用，不全目录顺手清理。没有主动改变业务逻辑，就不迁移历史订单、数据库或数据目录。

## 8. 受控联调、上线与回滚

### 8.1 上线前置条件

- 第 7 节静态、完整测试、构建、安装及部署平台 smoke check 全部通过。
- 明确保持 WebSocket transport，确认最终环境未意外切换为 HTTP。
- 确认受管理账户的 HK 订单不依赖本系统尚未支持的延迟/多腿等能力。
- 保存上一个可部署版本的代码、锁文件和构建产物；回退目标必须兼容当前持久化格式。
- SDK 升级与并行的数据目录/持久化变更分开发布或明确各自回滚边界，不能回退整个工作区误撤其他改动。

### 8.2 联调

仅在明确可用的券商测试账户、沙箱或另行批准的受控环境中验证真实交易能力，不因测试需要向生产账户下单。

检查认证、行情订阅、分钟线、轮证列表、订单推送、撤改单及重连。请求成功/ACK、终态和成交事实必须分别观察。

没有沙箱时，离线回放与只读联调可以完成各自覆盖范围，但必须保留“真实交易尚未验证”的结论，不能自动视为上线条件满足。必要时由业务负责人确认生产验证安排。

### 8.3 上线切换

1. 优先在非交易时段操作，关闭交易放行，按既有生命周期停止旧进程。
2. 确认没有未收敛的提交、撤单和改单结果；已获确认、可按既有规则恢复的挂单不等于必须全部撤销。
3. 如果存在无法确认的提交结果，保持停止并由既有故障处置处理，不用“重启后重提”解决。
4. 保证同账户只有一个能交易的实例，不采用两个真实交易实例并行比对的灰度方式。
5. 部署冻结依赖和新构建，保留最新持久化事实。
6. 新版按原严格恢复路径重建订单、账户、持仓和风险事实；恢复成功前不得放行。
7. 观察首个实际交易时段及相关生命周期转换，没有足够证据时不声称重连和跨日路径全部验证完成。

### 8.4 回滚

触发示例：原生加载失败、行情/订单无法正确解析、恢复无法完成、出现未解释的状态/成交事实偏差。

步骤：

1. 关闭交易放行并停止产生新请求，按既有规则处理在途操作；不能通过回滚绕开未确认提交问题。
2. 保留当前订单、成交、保护性清仓进度等最新持久化事实及故障日志。
3. 只回退 SDK 升级变更、依赖和对应构建，避免夹带撤销其他已生效的业务/持久化改动。
4. 使用相匹配的锁文件重新安装/部署旧版，清除新旧混用的构建产物。
5. 旧版依据最新本地事实和券商事实进行严格恢复；失败则继续禁止交易并调查。

**不能把交易数据恢复到升级前快照来“回滚代码”。** 这会丢失升级后已发生的交易事实。若并行变更已改变数据格式，必须先证明旧代码可读；不能盲目切回更早版本。

## 9. 完成标准与当前状态

实际实施时逐项验收：

- [ ] 依赖与原生平台包锁定为 `5.2.2`，没有无关依赖升级。
- [ ] 新增 DTO 字段覆盖完整夹具和通用 Mock。
- [ ] 使用私有 11 方法契约，生产入口与夹具一致，没有掩盖缺失能力的断言。
- [ ] 轮证状态不再写死旧数字，Unknown 不被放行。
- [ ] 延迟订单状态明确拒绝且有测试，未擅自扩展业务。
- [ ] 未引入 execution ledger 或额外 Context。
- [ ] lint、完整类型检查、构建及完整测试通过。
- [ ] 目标平台冻结安装和原生 smoke check 通过。
- [ ] 最终部署 transport 为 WebSocket，真实联调范围与缺口已记录。
- [ ] 上线、恢复、单实例约束和回滚流程已确认。
- [ ] 用户原有改动保留，差异局限于批准范围。

当前状态：已完成方案复核与文档整理；已复现的 7 处类型错误和 1 项测试失败尚未修复，以上实施验收项不能预先勾选。

## 10. 证据来源

1. [npm registry：dist-tags、版本与发布时间](https://registry.npmjs.org/longbridge)。
2. [npm：4.4.3 发布元数据](https://registry.npmjs.org/longbridge/4.4.3)。
3. [npm：5.2.2 发布元数据](https://registry.npmjs.org/longbridge/5.2.2)。
4. [4.4.3 实际发布包](https://registry.npmjs.org/longbridge/-/longbridge-4.4.3.tgz) 与 [5.2.2 实际发布包](https://registry.npmjs.org/longbridge/-/longbridge-5.2.2.tgz)：用于声明对比。
5. [5.2.2 Windows x64 原生包元数据](https://registry.npmjs.org/longbridge-win32-x64-msvc/5.2.2)。
6. [5.2.2 发布 gitHead 对应 changelog](https://github.com/longbridge/openapi/blob/edae6a85164b4795211ee9e08ceaeb78986bbf6f/CHANGELOG.md)。
7. [同一 gitHead 的 Node.js 配置绑定](https://github.com/longbridge/openapi/blob/edae6a85164b4795211ee9e08ceaeb78986bbf6f/nodejs/src/config.rs)：环境变量自动读取与 `extra` 覆盖规则。
8. 本文列出的本地源码、夹具及当前工作区隔离验证结果。文件行号仅对应复核时版本，实施时以符号和实际调用链定位。

解释优先级：实际 npm 发布包和固定版本声明优先于搜索摘要；固定版本 changelog 优先于主干未发布内容；本地运行证据必须注明环境和范围，不以类型兼容替代生产运行验证。
