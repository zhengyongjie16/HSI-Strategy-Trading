# 自动寻标启动与开盘重建：持仓席位恢复交易状态准入修复方案

- 编写日期：2026-10-22
- 状态：方案已确认，待实施
- 本文范围：问题分析、已确认业务规则、修复设计、实施步骤与验收标准
- 实施状态：尚未修改程序代码或新增回归测试
- 文档性质：单次问题修复计划；引用位置对应分析时的代码，实施时应重新核对

## 1. 目标与已确认决策

### 1.1 修复目标

开启自动寻标时，历史持仓只有在满足原有恢复条件，且本轮状态查询明确返回正常交易状态后，才允许恢复为席位。

核心约束：

> 历史成交归属和正持仓只能证明恢复候选的来源，不能证明该标的当前仍可正常交易。必须在绑定席位之前完成交易状态准入。

本次同时覆盖程序启动和每日开盘重建，避免只修首次启动而留下共用恢复链路的漏洞。

### 1.2 已由用户明确确认的决策

| 事项 | 已确认规则 |
| --- | --- |
| 正常状态白名单 | 只有 SDK 返回 `TradeStatus.Normal` 才允许恢复；所有其他已知状态均拒绝恢复 |
| 请求成功但候选缺少返回行 | 阻断本轮恢复并报错，不继续补席 |
| 状态缺失或应用层无法识别 | 阻断本轮恢复并报错，不默认正常，也不当作已确认非正常 |
| 明确的外部请求失败 | 保留现有关闭交易、等待生命周期重建重试的处理，不新增本地重试系统 |
| 已确认非正常状态 | 不绑定该候选；方向按原规则保持或进入 `EMPTY`，由既有门禁决定是否继续自动寻标 |
| 本次修复范围 | 只新增恢复交易状态限制，不同时实施不可交易残仓隔离 |
| 残仓下游规则 | 保留现有持仓订阅、未归属挂单处理及末日清仓严格保护 |

### 1.3 不改变的业务行为

- 自动寻标关闭时，继续使用静态配置的长短标的；本次不为静态配置新增状态准入。
- 每个方向继续按最近完全成交订单确定历史候选，不改成遍历全部持仓选标。
- 最新历史候选被拒绝后，不新增向更早成交持仓回溯的策略。
- 不将新候选的成交额、距离、到期范围、界内条件等要求强加给历史持仓恢复。
- 不删除、不篡改真实账户持仓、订单、日内亏损和保护性清仓历史事实。
- 保留现有交易时段、早盘延迟、冻结、失败计数和激活流程。
- 不增加运行中已激活席位的持续交易状态监控。
- 不修改 Longbridge SDK，不增加第二套 SDK 客户端、行情状态缓存或轮询任务。

## 2. 当前完整调用链

### 2.1 程序启动

```text
runApp
  ├─ 关闭生命周期交易放行
  └─ loadStartupSnapshot
       └─ loadTradingDayRuntimeSnapshot
            ├─ 初始化订单监控
            ├─ 获取成对账户、持仓快照及原始授权 token
            ├─ 获取并归一化历史订单、当日订单
            ├─ prepareSeatsForRuntime
            │    ├─ getLatestTradedSymbol：按方向确定最近成交标的
            │    ├─ resolveSeatOnStartup：检查港股代码及正持仓
            │    ├─ 将合格候选绑定为 ACTIVATING
            │    └─ 对 EMPTY 席位按启动门禁尝试寻标
            ├─ 处理相关标的、日内亏损及保护性清仓恢复事实
            ├─ 订阅标的行情和监控 K 线
            └─ 返回订单与行情快照
  ├─ 运行时标的验证
  └─ rebuildTradingDayState
       ├─ 重建订单记录与交易日历
       ├─ 重建牛熊证风险、浮亏等事实
       ├─ commitRebuiltSeatActivation：发布 ACTIVE
       └─ 恢复订单追踪等后续步骤
```

关键代码定位：

| 环节 | 文件及分析时行号 |
| --- | --- |
| 启动关闭交易并加载快照 | `src/app/runApp.ts:150` |
| 启动快照加载与 API 失败分支 | `src/application/tradingDayRebuild/startupSnapshot.ts:39` |
| 获取账户持仓、全量订单 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:416`、`:441` |
| 调用席位恢复 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:520` |
| 候选解析与席位发布 | `src/application/tradingDayRebuild/seatPreparation.ts:28` |
| 最近成交候选 | `src/domain/order/orderOwnership.ts:103` |
| 持仓支持规则 | `src/domain/seat/seatPolicy.ts:291` |
| 重建激活 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts:377` |
| ACTIVE 发布实现 | `src/application/seatActivation/rebuiltSeats.ts` |

### 2.2 开盘重建

`executeTradingDayOpenRebuild()` 同样调用 `loadTradingDayRuntimeSnapshot()`，见 `src/application/tradingDayRebuild/openRebuild.ts:54`。

因此，共享修复点是 `prepareSeatsForRuntime()` 及其依赖接线，而不是只在 `runApp` 增加一次检查。

## 3. 当前候选选择与已确认缺陷

### 3.1 候选并非任意持仓

`getLatestTradedSymbol()` 当前执行：

1. 只考虑 `executionStatus === 'FILLED'` 的订单。
2. 根据订单 `stockName` 中的方向标记及配置 `orderOwnershipMapping` 解析 LONG/SHORT。
3. 按 `updatedAt` 取该方向最近一笔匹配的订单，返回其标的。

注意：

- 该函数没有按买卖方向过滤，因此最近完全成交的买单或卖单都可能决定候选。
- 它不是先从订单中筛出仍持仓的标的，再选最新一个。
- 最新候选无法恢复时，现有实现不继续回溯更早的持仓候选。

以上行为不是本次修改目标，应保持不变。

### 3.2 当前恢复准入缺少交易状态

自动寻标开启时，`resolveSeatOnStartup()` 只要求：

```text
候选非空
AND 候选是港股代码
AND 当前存在相同标的且 quantity > 0 的持仓
```

条件成立后，`seatPreparation.ts` 直接发布：

```text
symbol = 历史候选
status = ACTIVATING
```

该链路没有读取或检查交易状态，因此已终止交易、到期、退市或停牌的残留持仓仍可通过恢复准入。

**已确认影响**：非正常交易标的能够被绑定为 `ACTIVATING`。

**潜在后续影响**：如果行情、风险和订单等其他重建资料仍然完整，它还可能最终进入 `ACTIVE`。不能依赖后续接口偶然失败来阻止恢复。

### 3.3 不应使用可用数量替代状态判断

现有恢复检查的是 `quantity`，不是 `availableQuantity`。

只读复现已确认：`quantity = 100`、`availableQuantity = 0` 的历史候选仍会被恢复。

不能简单改成 `availableQuantity > 0`：正常持仓也可能因为挂单占用而暂时没有可用数量。交易状态与可卖数量是不同事实，本次应新增交易状态检查，而不是替换持仓条件。

### 3.4 后续链路没有补充交易状态校验

| 现有检查 | 当前边界 |
| --- | --- |
| 内部 `Quote` | `src/types/quote.ts:7`，不包含交易状态 |
| 运行时标的验证 | `src/config/validator/utils.ts:260`，检查报价存在及必要的每手数量等，不检查交易状态 |
| 牛熊证风险刷新 | `src/application/riskRefresh/warrantRiskRefresh.ts:23`，读取类型和回收价，不检查交易状态 |
| 重建激活 | 发布经过重建的席位，不重新查询证券交易状态 |

## 4. 状态数据来源与技术约束

### 4.1 使用完整证券行情的 `tradeStatus`

仓库依赖 Longbridge Node SDK `4.4.3`。

SDK `QuoteContext.quote(symbols)` 返回的 `SecurityQuote.tradeStatus` 可用于本次准入，并且该请求不要求先订阅。

| SDK 枚举 | 官方业务含义 | 恢复准入 |
| --- | --- | --- |
| `TradeStatus.Normal` | 正常交易 | 允许进入原恢复流程 |
| `TradeStatus.Halted` | 停牌 | 拒绝 |
| `TradeStatus.Delisted` | 退市 | 拒绝 |
| `TradeStatus.Fuse` | 熔断 | 拒绝 |
| `TradeStatus.PrepareList` | 新股待上市 | 拒绝 |
| `TradeStatus.CodeMoved` | 代码变更 | 拒绝 |
| `TradeStatus.ToBeOpened` | 待开盘 | 拒绝 |
| `TradeStatus.SplitStockHalts` | 拆合股暂停交易 | 拒绝 |
| `TradeStatus.Expired` | 已到期，衍生品 | 拒绝 |
| `TradeStatus.WarrantPrepareList` | 轮证待上市 | 拒绝 |
| `TradeStatus.Suspend` | 终止交易 | 拒绝 |

实现应使用 SDK 命名枚举，不硬编码数字。

`Suspend` 与 `Halted` 不同：前者是终止交易，后者是停牌。安装版本的声明注释存在误导，语义应以官方协议和对应版本映射源码为准。

`ToBeOpened` 不能自行当作 `Normal` 的别名；本次按白名单要求拒绝。证券交易状态也不等同于当前是否处于连续交易时段，两者分别判断。

### 4.2 不能直接复用现有 `getQuotes()`

`src/infrastructure/longbridge/market/quoteClient.ts:475–495` 的 `getQuotes()`：

- 强制要求标的已经订阅。
- 从 SDK `realtimeQuote()` 读取行情。
- 映射得到的内部 `Quote` 没有保留 `tradeStatus`。

当前恢复发生在统一行情订阅之前，因此不能为查询状态而提前绑定席位，再借助现有订阅流程取得行情。这会颠倒准入顺序。

### 4.3 不使用轮证候选列表代替状态查询

新候选搜索已有正常状态过滤：

- `src/application/autoSearch/candidateSearch.ts:185–194` 请求 `status: ['NORMAL']`。
- `src/domain/seat/warrantSelection/index.ts:108` 再次要求候选状态为 `NORMAL`。

但这条路径不覆盖历史持仓恢复，而且候选列表还受方向、到期范围、界内条件、成交额和距离等条件限制。

因此：

- 不在候选列表中，不能推出该标的交易状态异常。
- 不应让历史持仓恢复重新满足全部新标的选优条件。
- `WarrantStatus` 与 `TradeStatus` 是不同枚举体系，不能混用数值。

## 5. 修复设计

### 5.1 行情端口新增窄状态读取能力

在 `src/types/marketPorts.ts` 的 `MarketDataClient` 中新增批量状态读取方法，建议命名：

```text
getSecurityTradingStatuses(symbols)
```

职责与约束：

1. 输入为候选标的集合，对外返回按 symbol 索引的只读中性状态结果。
2. SDK 枚举仅在 Longbridge 基础设施层解释；不将 SDK 类型暴露给 application/domain。
3. 业务端只需要区分已确认正常与已确认非正常；缺行、缺状态及未知状态通过错误通道暴露，不默认返回非正常。
4. 实现复用当前唯一 `QuoteContextLike.quote` 能力及既有外部请求错误包装。
5. 按返回行的 symbol 匹配，不依赖返回顺序或数组长度等于请求长度。
6. 空候选集合不发请求；候选应先去重。
7. 不依赖 `subscribeSymbols()`、静态名称、昨收缓存、每手数量或 realtime warmup。
8. 不将请求异常捕获后改成空 Map、正常状态或普通无候选。
9. 不建立跨恢复轮次的交易状态缓存；每次恢复读取当次状态。

当前唯一监控标的只有 LONG、SHORT 两个恢复候选，去重后最多两个标的，一次批量读取即可。本次不为不存在的规模需求引入额外批处理框架。

### 5.2 恢复入口先准备与校验，再同步发布

调整 `prepareSeatsForRuntime()` 的顺序：

```text
检查原 canContinue
  → 计算 LONG/SHORT 历史候选
  → 按原港股、正持仓规则确定恢复候选
  → 自动寻标开启且有候选时，去重后查询交易状态
  → 完整验证本批状态响应
  → 重新检查原 canContinue
  → 同步发布两个方向的恢复结果
       正常候选：ACTIVATING
       已知非正常或原本无候选：EMPTY
  → 按原时间门禁、冻结状态调用启动空席寻标
```

必要约束：

- 在整批状态查询与验证成功之前，不为任一方向发布本轮恢复席位。
- 不采用“先发布 LONG，再查询 SHORT”的顺序，否则 SHORT 状态异常时会留下部分发布。
- 状态读取异常时，不调用后续启动寻标；由上层既有恢复失败处理接管。
- 状态查询返回后继续使用原始快照授权，不把新 token 套到旧候选结果上。
- 授权失效时不发布旧席位、不继续寻标，保持现有 supersession/abort 语义。
- 内部数据或契约错误不得因授权过期而被吞掉；沿用现有先验证事实、再处理过期结果的边界。
- 正常恢复与拒绝恢复后的计数、冻结等字段，沿用原有对应分支的处理。

### 5.3 候选解析职责与命名

现有 `resolveSeatOnStartup()` 实际只具备配置、港股范围和持仓支持的纯规则能力，不应在其中执行网络请求。

建议将其明确为候选解析职责，并重命名为 `resolveStartupSeatCandidate()`：

- 自动寻标关闭：仍返回有效的静态配置标的。
- 自动寻标开启：只返回有正持仓支持的港股历史候选。
- 候选结果不代表已经通过交易状态准入，不允许绕过 application 层状态校验直接绑定。
- 所有导入、测试、架构检查及相关注释同步替换，不保留旧名称兼容转发层。

这样既保留纯业务规则与 I/O 的边界，也避免函数名称继续暗示它已完成全部恢复决策。

### 5.4 依赖接线

- `PrepareSeatsForRuntimeDeps` 注入窄状态读取能力及所需日志能力。
- `loadTradingDayRuntimeSnapshot()` 将已存在的 `marketDataClient` 对应读取方法传入。
- 不在恢复用例内部创建 SDK 客户端。
- 不新增独立恢复状态管理器、事件总线或定时重试器。
- 继续通过既有 `symbolRegistry.updateSeatState()` 发布席位变更，由原有事件订阅者消费；不绕过现有状态所有者直接改字段。

### 5.5 失败分类

| 情况 | 判定与处理 |
| --- | --- |
| 返回 `Normal` | 按原规则恢复为 `ACTIVATING`，不是立即放行交易 |
| 返回其他已知枚举值 | 记录拒绝原因，不绑定该标的；方向按原规则进入 `EMPTY` |
| 成功响应中缺少请求标的 | 状态未取得，报错并阻断本轮恢复；不能解释为退市或无持仓 |
| 返回行缺少状态，或状态为 null/undefined | 状态契约不完整，报错并阻断 |
| 应用层实际看到未知状态值 | 无法确认状态，报错并阻断 |
| 非法字段类型或损坏对象 | 按契约错误直接暴露，不包装成可忽略业务失败 |
| 明确的外部请求失败 | 保留原外部错误分类，由启动或生命周期恢复机制处理 |
| 查询成功但原快照授权失效 | 不发布、不继续寻标，交原上层失效分支处理 |

已知非正常状态与状态未知必须区别处理。前者可以按空席位补席；后者按用户确认必须阻断恢复。

### 5.6 寻标与日志

拒绝恢复历史候选本身不是一次寻标失败，不增加当日寻标失败次数。

后续只有实际完成寻标且没有候选时，才由 `StartupSeatSearch` 按既有规则计数和冻结。时间门禁不满足或方向被冻结时，继续跳过寻标。

日志至少应区分：

- 监控标的、方向、被拒绝的历史候选、已确认非正常状态。
- 目标标的缺行或状态未知导致恢复阻断。
- 外部状态查询请求失败，由原恢复 owner 输出重试相关日志。

不使用“已删除持仓”“已安全清仓”等与实际操作不符的表述。

## 6. 明确保留的残仓下游行为

拒绝恢复席位，不代表删除持仓，也不代表该持仓已经获得独立隔离或风控管理。

### 6.1 持仓行情订阅

真实持仓仍参与运行时订阅集合。

- 非正常标的若仍有完整行情资料，不会仅因本次拒绝绑定而必然导致订阅失败。
- 若券商不再返回必要静态信息或 `prevClose`，现有 `subscribeSymbols()` 会拒绝接入并抛错。
- 仅缺少 realtime 报价时，`getQuotes()` 的既有行为是返回 null。

证据：`src/infrastructure/longbridge/market/quoteClient.ts:513–520`、`:553–595`。

“缺少必要资料会失败”已由代码确认；具体终止交易标的是否缺少资料，尚未实盘验证。

### 6.2 未完成订单恢复

订单恢复要求订单与当前可匹配席位一致，规则不变：

- 未完成 SELL 无法匹配席位：直接阻断恢复。
- 未完成 BUY 无法匹配席位：尝试撤单，并严格核验权威终态及成交事实；不能仅凭撤单请求成功继续恢复。

证据：`src/application/orderTracking/orderMonitor/recoveryFlow.ts:420–530`。

因此，不删除 orders 不意味着不会触发现有撤单行为；本次拒绝绑定后，下游仍按其原有规则工作。

### 6.3 末日清仓

当末日保护启用、交易门禁允许且进入清仓窗口时，若存在正可用数量的港股持仓，且无法归属当前有效席位，现有代码会在生成清仓信号前抛错。

- 不是仅跳过该残仓；该轮其他正常席位持仓也可能尚未提交清仓。
- 错误会沿既有时间运行时致命错误路径停止运行。
- `availableQuantity = 0` 不触发这一项正可用未归属持仓检查。

证据：

- `src/application/doomsdayClearance/index.ts:88–111`、`:354–367`
- `src/runtime/timeWakeupRuntime/index.ts:43–46`、`:112–118`

用户已确认本次保留这些严格保护，不为了让新席位运行而静默忽略残仓。

## 7. 预计改动范围与实施步骤

### 7.1 主要文件

| 文件或范围 | 预计改动 |
| --- | --- |
| `src/types/marketPorts.ts` | 声明窄交易状态读取契约及必要的中性结果类型 |
| `src/infrastructure/longbridge/market/quoteClient.ts` | 复用现有 SDK quote 能力完成状态查询，返回完整校验后的中性结果 |
| 对应 market 映射模块 | 只在基础设施层解释 SDK 状态枚举，按职责选择现有文件或最小必要文件 |
| `src/application/tradingDayRebuild/types.ts` | 增加恢复状态读取及日志依赖 |
| `src/application/tradingDayRebuild/seatPreparation.ts` | 先解析候选、批量查状态、完整验证，再发布席位 |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | 注入共享读取能力 |
| `src/domain/seat/seatPolicy.ts` | 明确候选职责并同步命名、注释 |
| `tests/` 对应模块、共享替身及直接受影响的 `mock/` | 补充状态事实、关键回归测试及接口适配 |

不修改普通买卖、末日清仓、挂单恢复或残仓订阅政策来绕过本次新增准入。

### 7.2 实施顺序

1. 重新核对真实调用方、市场端口实现和测试替身，确认代码未发生使方案失效的变化。
2. 实现基础设施层状态读取与完整性校验。
3. 调整候选解析命名、恢复依赖和共同入口发布顺序。
4. 接通 loader 注入，覆盖启动与开盘重建两条真实路径。
5. 添加能直接验证关键行为的测试，更新受影响测试替身。
6. 搜索并清理旧函数名、旧依赖契约、调用方、导出、测试、注释和直接受影响的文档引用。
7. 执行与改动范围相称的测试，以及项目必需检查。

不新增兼容层，不保留旧名字的转发函数，不顺带重构无关模块。

## 8. 回归测试与验收标准

### 8.1 必须验证的行为

| 场景 | 预期 |
| --- | --- |
| 有历史归属、有正持仓、状态为 Normal | 恢复为 `ACTIVATING`，不跳过后续激活流程 |
| 状态为 Suspend | 不绑定该终止交易标的 |
| Expired、Delisted、Halted 等其他已知非正常状态 | 均拒绝恢复，可使用参数化测试覆盖已知枚举 |
| 已知非正常候选被拒，且允许寻标 | 方向进入原空席寻标流程，可绑定新候选为 `ACTIVATING` |
| 已知非正常候选被拒，但处于非交易时段、早盘延迟或冻结状态 | 保持 `EMPTY`，不绕过原门禁 |
| 成功响应缺少候选行 | 报错；本轮两个方向均未提前发布，未继续寻标 |
| 状态缺失、未知或非法类型 | 报错，不默认正常、不静默跳过 |
| 外部状态请求失败 | 保留外部错误身份，由既有恢复流程处理；不继续寻标 |
| 正常状态响应返回前原快照失效 | 不写席位、不启动后续寻标 |
| 两方向状态响应乱序 | 按 symbol 匹配，不串方向 |
| 无恢复候选、无正持仓或自动寻标关闭 | 不发无意义状态查询；原有行为不变 |
| 正常标的总持仓为正但可用数量为零 | 仍可恢复，不误用可用数量作为交易状态 |
| 最新候选非正常，但更早还有持仓候选 | 不引入历史回溯新策略 |
| 启动与开盘重建 | 都经过同一状态准入，不存在只覆盖启动的遗漏 |
| 被拒标的仍在持仓或订单事实中 | 不删除真实事实，保留既有残仓保护 |
| 拒绝恢复后没有实际寻标 | 不因恢复拒绝增加寻标失败计数 |

### 8.2 建议测试落点

- `tests/infrastructure/longbridge/market/quoteClient.test.ts` 及对应映射测试：未订阅读取、状态映射、缺行/缺状态、错误分类。
- `tests/domain/seat/seatPolicy.business.test.ts`：候选解析原业务规则保持不变。
- `tests/application/tradingDayRebuild/seatPreparation.business.test.ts`：恢复白名单、两方向发布顺序、拒绝后补席、状态未知阻断和授权失效。
- `tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts`：真实依赖接线、账户订单事实保留。
- 启动/开盘重建相关集成测试：共同入口未遗漏，外部失败仍关闭交易并使用原恢复政策。

优先复用现有测试设施，不为覆盖率增加重复内部步骤断言。

### 8.3 实施后必须执行

1. 运行与修改范围直接相关的单元、业务及必要集成测试。
2. 按项目规范依次执行 `bun lint:fix` → `bun type-check`。
3. 若自动修正产生相关新改动，补跑受影响测试。
4. 检查最终差异及旧引用，不将未实现或未通过验证的项目标记为完成。

### 8.4 分析阶段已完成的检查

本次只读分析运行了以下现有测试：

```text
bun test \
  tests/domain/seat/seatPolicy.business.test.ts \
  tests/application/tradingDayRebuild/seatPreparation.business.test.ts \
  tests/application/autoSearch/startupSeatSearch.test.ts \
  tests/integration/autoSearchPolicyConsistency.integration.test.ts
```

结果：32 pass、0 fail、100 expect() calls。

另外通过现有纯函数复现了正持仓、零可用数量的历史候选仍会恢复。

这些是现状基线验证，**不是新修复已通过验收的证据**；当前尚未实现交易状态限制。

## 9. SDK 信任边界与未验证事项

### 9.1 Longbridge 4.4.3 的状态默认化边界

对应版本 Rust 实现包含：

```rust
trade_status: TradeStatus::try_from(quote.trade_status).unwrap_or_default(),
```

协议默认值为 Normal。因此，某些原始未知状态可能在到达 JavaScript 层之前已被 SDK 转为 Normal；protobuf 原始字段缺失也存在零默认值边界。

本次可承诺：

- 只允许应用实际收到的 SDK `TradeStatus.Normal` 通过。
- 应用边界实际可见的缺行、缺状态或未知状态会阻断恢复。

本次不能承诺：

- 识别已经被 SDK 内部默认化、与真实 Normal 无法区分的原始异常值。

本次按已确认范围不修改 SDK。若未来要求协议层未知值也必须严格拒绝，需要单独评估 SDK 修复或能保留原始状态的读取能力，不能靠应用层增加无依据 fallback 实现。

### 9.2 其他未验证事项

- 未访问用户账户，未核实实际问题标的的 tradeStatus、可用数量、挂单与行情权限。
- 未验证每一种非正常交易状态在实际 Longbridge 订阅接口中的返回行为。
- 查询后证券状态可能继续变化；本方案只处理本轮启动/开盘恢复准入，不是运行期持续可交易性保证。
- 正常交易状态不保证账户具有下单权限，也不保证当前市场开市或订单一定成交。

## 10. 参考来源

### 10.1 本地依赖与接口

- `package.json`：Longbridge 依赖版本 `4.4.3`。
- `node_modules/longbridge/index.d.ts:1736–1752`：`QuoteContext.quote()`。
- `node_modules/longbridge/index.d.ts:2458–2487`：`SecurityQuote`。
- `node_modules/longbridge/index.d.ts:6722–6745`：`TradeStatus`。
- `src/infrastructure/longbridge/market/types.ts:66–71`：已存在的内部 `QuoteContextLike.quote` 能力。

### 10.2 官方文档及对应版本源码

- [行情命名词典：TradeStatus](https://open.longbridge.com/zh-CN/docs/quote/objects)
- [获取证券实时行情](https://open.longbridge.com/zh-CN/docs/quote/pull/quote)
- [获取轮证列表](https://open.longbridge.com/zh-CN/docs/quote/pull/warrant-filter)
- [Longbridge v4.4.3 Node 交易状态映射](https://github.com/longbridge/openapi/blob/v4.4.3/nodejs/src/quote/types.rs#L61-L88)
- [Longbridge v4.4.3 SecurityQuote 转换](https://github.com/longbridge/openapi/blob/v4.4.3/rust/src/quote/types.rs#L453-L472)
- [Longbridge v4.4.3 quote 请求实现](https://github.com/longbridge/openapi/blob/v4.4.3/rust/src/quote/context.rs#L507-L520)

## 11. 实施完成检查清单

- [ ] 仅正常交易的历史持仓候选可以绑定席位。
- [ ] 已知非正常与状态未知的失败语义严格区分。
- [ ] 状态未知时两个方向均未提前发布，且没有继续寻标。
- [ ] 异步查询使用原快照授权，失效结果不落地。
- [ ] 启动与开盘重建共同覆盖。
- [ ] 静态配置、候选选择、计数冻结及时间门禁保持原行为。
- [ ] 未删除真实持仓或订单，未削弱残仓订阅、挂单和末日保护。
- [ ] 所有受影响调用方、测试替身、旧名称和注释均已同步。
- [ ] 关键回归测试通过。
- [ ] `bun lint:fix` → `bun type-check` 依序通过。
- [ ] 最终说明已实现范围、验证结果及 SDK 信任边界。
