# G6 基础设施／配置只读审计（已交接，候选待独立复核）

## summary

- verdict: 已以固定 develop 源码差分复现 2 项启动快照准入候选；这是本代理完成独立自查的候选，不是已完成二次复核的最终缺陷。G6 120 文件已分级记录：A65 已深读／B3 等价 diff 核对／T52 契约结构已审但消费者未全深入；详见覆盖表。
- scope: G6 的 config/constants/types/utils、Longbridge 适配器、共享缓存、日志与持久化、显示、限流，以及证明问题所需的直接调用链。
- confidence: medium
- current: `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`，`beta-V2`。
- develop: `6e239c8a128372bd9b2fb2d79464346792a5e81e`（基线代理已 fetch 核实 develop/origin/develop/FETCH_HEAD 一致）。
- actual environment: Windows x64；Node `v24.20.0`；Bun `1.4.2`；`PI_PROVIDER=cliproxyapi`、`PI_MODEL=gpt-6.1-sol`、`PI_REASONING_LEVEL=max`，符合模板要求。
- constraints: 仓库源／测试／配置未修改；使用四项指定技能与架构实施计划作为约束参考，业务真值以固定 develop 源码及用户“不能漂移”要求为准。详细报告仅写本文件。

## critical issues

None. 尚未完成他代理二次复核，不声明最终缺陷。

## major issues

### INF-C1（候选；已自查；待另一代理独立复核）— history/today 去重之前提前校验成交完整性，陈旧 history 可阻断本应采用完整 today 的启动

- claim: current 把成交完整性校验推进到了每一条 history 的 SDK 映射阶段；develop 的 history 结构校验允许 nullable `executedPrice` 和 `updatedAt`，先完成 history/today 的 today 优先去重，再由业务重建校验实际采用的成交事实。因此，当同一订单的 history 为不完整旧观察、today 为完整权威观察时，current 在读取 today 之前即抛 TypeError，不能完成 develop 可完成的恢复。
- current evidence:
  - `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:120-136`：`mapSnapshotOrder` 将每条记录传给 `mapBrokerOrder`。
  - `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:142-156`：每条 HK 记录均立即映射，不等待择优去重。
  - `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:178-199`：history 映射发生在 `todayOrders()` 之前。
  - `src/infrastructure/longbridge/trade/orderMapper.ts:101-109`：在途正成交缺价或正成交缺独立 `updatedAt` 立即 TypeError。
  - `src/application/orderTracking/recorder/orderApiManager.ts:9-12` 与 `src/domain/order/orderSnapshotPolicy.ts:29-35,50-91`：today 覆盖 history 的规则仍存在，但只有两组映射均成功后才能执行。
- develop evidence (`6e239c8`):
  - `src/core/orderRecorder/orderApiManager.ts:118-125`：允许 nullable 成交价及 nullable/omitted `updatedAt` 的结构校验。
  - 同文件 `146-164`：保留缺失金融／更新时间，不在 SDK 读取阶段做正成交完整性裁决。
  - 同文件 `197-202,255-296`：先读完两组，today 无条件优先，再返回去重后的记录。
  - `src/core/orderRecorder/utils.ts:155-164,214-224`：实际采用的重建成交仍严格校验；本候选不是要求绕过有效订单的成交完整性门禁。
- runtime path: app 的 `src/app/runtime/createTradeRuntime.ts:75-79` 注入唯一 snapshot port → `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:441` 调用 recorder.fetchAllOrdersFromAPI → recorder → snapshot adapter → history.map → orderMapper 提前抛错；无法进入 today 读取／去重和后续 recovery。`TypeError` 不是可重试外部失败，不能由 startup 的外部 API pending 策略恢复（`src/application/tradingDayRebuild/startupSnapshot.ts:85-94`）。
- trigger: 同一 orderId，history 正成交但 `updatedAt:null`，today 有有效独立更新时间；或者 history 为在途部分成交且 `executedPrice:null`，today 为带价完整终态。SDK 4.4.3 的 `Order`/`OrderDetail.updatedAt` 与 executedPrice 本来允许 null；不假定 SDK 返回完全原子的 history/today 快照。
- impact: potential — 能复现 current 相比 develop 的启动／开盘重建中断；真实 broker 在何时返回这种异步双观察组合未在线验证。没有发生错误交易的证据。
- minimal fix: 保留 SDK 结构验证与非 HK 过滤，但将“本应由获选订单承担”的正成交完整性裁决放到 today/history 选择之后。不要补造时间、价格、金额，不要把异常吞掉或跳过实际获选的非法成交。可在同一 infra read 边界先保留原生结构／完成与原规则相同的选择，再映射获选记录；不新建第二订单账。
- validation / evidence:
  - 已用只读内存加载器执行 develop 的原 `createOrderAPIManager` 与原 `classifyOrdersForRebuild`，以及 current 原 adapter。加载器使用 TypeScript.transpileModule，仅将 require 递归导向 `git show <fixedSHA>:<path>`，没有在仓库落地旧源码或测试。
  - case missingRevision: develop calls=`[history,today]`, executedBuys=1；current calls=`[history]`, TypeError `executed order lacks independent broker revision`。
  - case missingOpenPrice: develop calls=`[history,today]`, executedBuys=1；current calls=`[history]`, TypeError `invalid cumulative execution quantity/price`。
  - 二次验证应补：同源重复择新、history 不完整但 today 完整、history 完整但 today 不完整（仍拒绝获选非法项）、没有 today 覆盖（仍拒绝）、非 HK 先过滤、getter/外部请求错误身份不变、启动与开盘重建门禁。
- test coverage boundary: 现有 `tests/infrastructure/longbridge/trade/orderSnapshotReadFixture.ts:18-25,45-52` 只用零成交的完整双来源订单验证 today 优先；`tests/infrastructure/longbridge/trade/orderFactMapper.test.ts:109-113` 单独断言正成交缺更新时间应拒绝。两者未覆盖“被覆盖的旧观察不应阻断完整获选观察”的组合。
- dimensions: implementation, architecture/project-spec, type-boundary placement, tests。
- second review status: pending；请主代理将此候选交另一代理独立执行反例与根因复核，再决定是否进入最终 findings。

### INF-C2（候选；已自查；待另一代理独立复核）— 无成交且已关闭的 Unknown-side 订单由 develop 的显式忽略改为全局启动失败

- claim: develop 特意区分“无法归属的 OPEN／正成交订单”和“无法归属、零成交的 TERMINAL 订单”：前者拒绝，后者不承载成交与挂单占用而忽略。current 的 snapshot 结构校验仍允许 `OrderSide.Unknown`，但随后的统一 `mapBrokerOrder` 无条件拒绝 Unknown，不再能到达旧零成交终态忽略分支。
- current evidence: `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:65-77,95-115,142-152` 接受 Unknown 枚举后调用 mapper；`src/infrastructure/longbridge/trade/orderMapper.ts:73-80` 在读取 lifecycle/quantity 前无条件抛 `unknown SDK execution side`；`src/types/trade.ts:13` 的 BUY/SELL 窄事实也不能表达这种原先应被丢弃的观察。
- develop evidence: `src/core/orderRecorder/orderApiManager.ts:73-84,115,146-164` 允许并保留 Unknown；`src/core/orderRecorder/utils.ts:203-209,222-237` 的中文契约和实现明确允许忽略零累计成交、未知方向的 TERMINAL 订单，但拒绝未知方向的 OPEN／非零成交。`src/core/riskController/dailyLossTracker.ts:648-653` 在归属计算前同样跳过未知方向或无有效成交项。
- runtime path: 启动／开盘重建 → recorder.fetchAllOrdersFromAPI → snapshot.fetchSnapshots → mapScopedOrders → mapBrokerOrder 立即 TypeError → `src/application/tradingDayRebuild/startupSnapshot.ts:85-94` 非外部错误直抛；当前真实路径根本到不了业务的无经济事实忽略逻辑。
- trigger: history 或 today 包含合法 HK 标的、有效 identity/时间/数量、`side=OrderSide.Unknown`、`status=Canceled`、executedQuantity=0、executedPrice=null；不要求伪造未来未知 status 或缺失 symbol。
- impact: potential — 只读差分已证明旧“无成交／无开放资源”的可忽略记录变为启动阻断；真实 broker 是否会产生该已定义枚举组合未在线确认。不能因为新类型更窄，就自动把旧明确业务允许的输入判为内部损坏。此项是否属于用户允许的“更优 fail-fast”须由独立复核按旧显式豁免裁决，不在本报告中宣称最终缺陷。
- minimal fix: 在 SDK snapshot ingress 根据原零成交＋TERMINAL＋Unknown-side 的精确条件丢弃该无经济事实记录；仍拒绝 Unknown-side OPEN 或正成交，绝不默认 BUY/SELL。保留正常中性 OrderFact 的 BUY/SELL 不变量。
- validation: 同一只读原源码加载器使用真实 SDK Decimal/枚举。develop createOrderAPIManager 成功后，原 classifyOrdersForRebuild 返回四组空数组；current 原 fetchSnapshots 抛 `TypeError: [orderMapper] unknown SDK execution side`。应补三个状态矩阵：Unknown＋terminal＋0 允许忽略；Unknown＋open＋0 拒绝；Unknown＋任意生命周期＋正成交拒绝。加启动链路反例，不只测 mapper。
- coverage boundary: `orderValidation.test.ts`／pending adapter 对 Unknown 的拒绝测试不能替代 snapshot 的旧零成交终态豁免；pending 来源的严格成员政策不应无条件推广到 history 的零资源终态。
- dimensions: implementation, type design, project/spec, tests, comments（注释仍称“保留原批准成员”，但原 snapshot 的显式豁免已不可达）。
- second review status: pending。

## minor issues

None. 不把风格、纯注释缺项或仅测试使用的导出自动列为缺陷。

## positive findings

- logger 实现相对 develop 去除路径/类型 import 差异后等价；未把迁移本身当作重构收益或缺陷。
- mixedTradeLogRepository 主体等价，`executionTime <= revision` 限制删除按 d2aa590 的真实时间语义变化审查；develop 已有旧比较，不误报为新加校验。
- 当前账户 mapper 允许跨市场小数持仓；卖出目标另用 SDK 数量原文证明安全整数。snapshot/pending/push 在严格数量校验前过滤明确非 HK，保留 2b67d36 的市场范围修复。
- warrantList cache 对 clear 后迟到 promise 使用身份围栏，阻止旧请求写回和删除新 in-flight；TTL、filter 次序及并发去重可追溯到 develop 原缓存。
- submit/replace/cancel 只返回中性请求结果；UNKNOWN 不被提升成可重提请求，内部 TypeError/RangeError 保留 fail-fast，SDK Decimal 出站进行原文往返容量证明。

## not assessed

- 在线 Longbridge 账户／订单接口未调用；不声称 broker 在某一特定时间一定返回候选组合。
- 他代理二次复核未完成。
- T52 文件全部业务消费者及跨组 owner 的完整语义未由本代理深入，详见清单／未深入边界；不能用 340 项测试通过证明全量业务等价。

## validation

1. scoped test: `bun test tests/config tests/infrastructure tests/utils tests/application/orderExecution/rateLimiter.business.test.ts`，外置 `APP_LOG_ROOT_DIR` 到审计 temp 目录，防止写仓库。第一次 340 pass / 1 fail；唯一失败是 `tests/config/runtime/runtime.business.test.ts:18` 硬编码要求日志根为仓库 tests/logs，与只读外置日志环境冲突，不计生产回归。
2. 仅排除该明确环境断言后重跑：340 pass / 0 fail（43 files；不据此声明全量等价）。持久化测试中的 retention unlink error 为预期故障注入，测试本身通过。
3. 单独在外部 cwd＋显式 preload 运行 runtime 配置测试：4 pass / 0 fail，初次唯一失败确认为审计日志路径隔离差异。
4. 只读差分 harness 复现 INF-C1 两个独立输入，以及 INF-C2 的零成交 Unknown-side 终态输入，结果见候选；完整可复运行代码见报告附录。

## recommended next actions

1. 独立二次复核 INF-C1、INF-C2；要求使用同一 SHA 的原源码而非本报告复刻的算法。
2. 若确认，修复边界顺序而非放松有效成交校验，增加双来源陈旧观察组合回归。
3. 汇总时严格区分已深读／等价 diff 核对／未深入；本报告不授予全量等价结论。

## 实际生产文件覆盖清单（固定 current SHA；120/120 有记录，不等于 120/120 业务语义全证）

- **A 已深读**：阅读本文件的实现或核心事实契约，并对涉及本组的直接链路分析；不自动表示每个跨域消费者均深入。
- **B 等价 diff 核对**：使用 git 的固定 develop/current 内容，逐项比较迁移路径、类型 import、函数体差异；实现未改动的主体不冒称整文件重新深读。
- **T 契约结构已审、消费者未全深入**：读取／AST 提取类型字段、判别联合、readonly、SDK 泄漏、金融 number、类型运行时代码等；语义正确性须结合 G1–G5 的 owner 链路，不能视为全消费者证明。
- 对照基线地图 G6：A=65、B=3、T=52；无遗漏记录。部分已读 helper 的旧迁出业务函数由相应业务组负责，见边界。

### 配置

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/config/auth/index.ts:1` | A |
| `src/config/auth/types.ts:1` | T |
| `src/config/auth/utils.ts:1` | A |
| `src/config/runtime/index.ts:1` | A |
| `src/config/trading/index.ts:1` | A |
| `src/config/trading/types.ts:1` | T |
| `src/config/trading/utils.ts:1` | A |
| `src/config/types.ts:1` | T |
| `src/config/utils.ts:1` | A |
| `src/config/validator/index.ts:1` | A |
| `src/config/validator/types.ts:1` | T |
| `src/config/validator/utils.ts:1` | A |

### 常量

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/constants/cleanup.ts:1` | A |
| `src/constants/diagnostics.ts:1` | A |
| `src/constants/financialConfig.ts:1` | A |
| `src/constants/index.ts:1` | A |
| `src/constants/orderOwnership.ts:1` | A |
| `src/constants/orderReadMetadata.ts:1` | A |
| `src/constants/strategy.ts:1` | A |
| `src/constants/tradeRateLimit.ts:1` | A |

### SDK market

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/infrastructure/longbridge/market/candlestickCache.ts:1` | A |
| `src/infrastructure/longbridge/market/candlestickMapper.ts:1` | A |
| `src/infrastructure/longbridge/market/marketEnumMapper.ts:1` | A |
| `src/infrastructure/longbridge/market/marketMetadataMapper.ts:1` | A |
| `src/infrastructure/longbridge/market/quoteClient.ts:1` | A |
| `src/infrastructure/longbridge/market/quoteFinancialMapper.ts:1` | A |
| `src/infrastructure/longbridge/market/types.ts:1` | T |
| `src/infrastructure/longbridge/market/warrantListCache/index.ts:1` | A |
| `src/infrastructure/longbridge/market/warrantListCache/types.ts:1` | T |
| `src/infrastructure/longbridge/market/warrantListReadAdapter.ts:1` | A |
| `src/infrastructure/longbridge/market/warrantRequestMapper.ts:1` | A |

### SDK trade

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/infrastructure/longbridge/trade/accountMapper.ts:1` | A |
| `src/infrastructure/longbridge/trade/accountReadAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/clientFactory/index.ts:1` | A |
| `src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.ts:1` | A |
| `src/infrastructure/longbridge/trade/clientFactory/types.ts:1` | T |
| `src/infrastructure/longbridge/trade/mutationErrorClassification.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderMapper.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderPushAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderReadErrorClassification.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/orderValidation.ts:1` | A |
| `src/infrastructure/longbridge/trade/pendingOrdersAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts:1` | A |
| `src/infrastructure/longbridge/trade/types.ts:1` | T |

### 显示／日志／持久化／外部错误／时间

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/infrastructure/diagnostics/index.ts:1` | A |
| `src/infrastructure/diagnostics/types.ts:1` | T |
| `src/infrastructure/display/accountDisplay/index.ts:1` | A |
| `src/infrastructure/display/marketMonitor/index.ts:1` | A |
| `src/infrastructure/display/marketMonitor/priceDisplayInfo.ts:1` | A |
| `src/infrastructure/display/marketMonitor/types.ts:1` | T |
| `src/infrastructure/display/marketMonitor/utils.ts:1` | A |
| `src/infrastructure/externalApi/errorClassification.ts:1` | A |
| `src/infrastructure/externalApi/index.ts:1` | A |
| `src/infrastructure/externalApi/types.ts:1` | T |
| `src/infrastructure/logger/index.ts:1` | B |
| `src/infrastructure/logger/types.ts:1` | T |
| `src/infrastructure/persistence/mixedTradeLogRepository/index.ts:1` | B |
| `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts:1` | A |
| `src/infrastructure/persistence/mixedTradeLogRepository/types.ts:1` | T |
| `src/infrastructure/time/index.ts:1` | A |

### 公共 types

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/types/account.ts:1` | A |
| `src/types/accountPosition.ts:1` | A |
| `src/types/accountReadPorts.ts:1` | T |
| `src/types/apiFailure.ts:1` | T |
| `src/types/brokerAccessPorts.ts:1` | A |
| `src/types/brokerClientFactory.ts:1` | A |
| `src/types/cleanup.ts:1` | T |
| `src/types/config.ts:1` | T |
| `src/types/data.ts:1` | T |
| `src/types/diagnostics.ts:1` | A |
| `src/types/display.ts:1` | T |
| `src/types/events.ts:1` | T |
| `src/types/lifecycle.ts:1` | T |
| `src/types/logger.ts:1` | T |
| `src/types/marketPorts.ts:1` | A |
| `src/types/monitor.ts:1` | T |
| `src/types/orderCancellation.ts:1` | T |
| `src/types/orderDetailReadPorts.ts:1` | T |
| `src/types/orderExecutionPorts.ts:1` | T |
| `src/types/orderHold.ts:1` | T |
| `src/types/orderPushPorts.ts:1` | T |
| `src/types/orderReadMetadata.ts:1` | T |
| `src/types/orderRecorder.ts:1` | T |
| `src/types/orderSnapshotReadPorts.ts:1` | T |
| `src/types/orderTracking.ts:1` | T |
| `src/types/periodicSwitch.ts:1` | T |
| `src/types/quote.ts:1` | T |
| `src/types/quoteSubscription.ts:1` | T |
| `src/types/rateLimit.ts:1` | T |
| `src/types/risk.ts:1` | T |
| `src/types/riskCheck.ts:1` | T |
| `src/types/runtime.ts:1` | T |
| `src/types/seat.ts:1` | T |
| `src/types/seatSwitch.ts:1` | T |
| `src/types/settlement.ts:1` | T |
| `src/types/signal.ts:1` | T |
| `src/types/strategy.ts:1` | T |
| `src/types/timeControlPlane.ts:1` | T |
| `src/types/timer.ts:1` | T |
| `src/types/trade.ts:1` | A |
| `src/types/tradeLog.ts:1` | T |
| `src/types/tradeMutationPorts.ts:1` | A |
| `src/types/tradingCalendar.ts:1` | T |
| `src/types/unrealizedLoss.ts:1` | T |
| `src/types/warrantRisk.ts:1` | T |

### 工具／timer

| current 生产文件 | 阅读等级 |
| --- | --- |
| `src/runtime/timer/index.ts:1` | B |
| `src/utils/apiFailure/index.ts:1` | A |
| `src/utils/display/index.ts:1` | A |
| `src/utils/error/index.ts:1` | A |
| `src/utils/helpers/index.ts:1` | A |
| `src/utils/marketScope.ts:1` | A |
| `src/utils/numeric/exact.ts:1` | A |
| `src/utils/numeric/index.ts:1` | A |
| `src/utils/numeric/types.ts:1` | T |
| `src/utils/time/index.ts:1` | A |
| `src/utils/time/types.ts:1` | T |


## 按链路已核对的实际行为与 develop 来源

| 链路 | current（已读） | develop（已读／等价 diff） | 本组结果及边界 |
| --- | --- | --- | --- |
| 配置 → 认证 → 唯一 SDK Config | config/auth/{index,utils}.ts → clientFactory/{sdkConfigFactory,index}.ts → brokerAccessAdapter.ts；createPreGateRuntime 的实际装配读取／搜索 | config/auth/{index,utils}.ts、app/runtime/createPreGateRuntime.ts、core/trader/index.ts | OAuth/APiKey、可选 callback port、extra 缺省 omission、错误身份、延迟 TradeContext.new 顺序已核对；未调用 OAuth/券商网络。 |
| 交易配置 → 阈值／订单类型 | config/{utils,trading,validator}/、constants/{financialConfig,index,tradeRateLimit}.ts | 同路径配置及 constants/index.ts | 默认 10000/100000/0、方向单位、严格区间、LO/ELO/MO、开盘保护等核对；计划明确的金额输入 10+3／普通十进制／half-even 目标不直接列回归。策略发现与 legacy env keys 的消费者由 G2 负责。 |
| SDK 账户 → accountQuery → snapshot → 显示 | accountMapper.ts、accountReadAdapter.ts、application/accountQuery/index.ts、accountPositionSnapshot/index.ts:1-210、accountDisplay/index.ts | core/trader/accountService.ts、services/accountDisplay/index.ts、types/account.ts | 首账户、渠道明细、小数跨市场持仓、金融文本、positionValue 差额、数量显示指数展开已分析；snapshot 其余事务并发状态机由 G1/G5 分工，不宣称本组全读。 |
| SDK history/today → 去重 → 重建 | orderSnapshotReadAdapter.ts、orderMapper.ts、application/orderTracking/recorder/orderApiManager.ts、domain/order/orderSnapshotPolicy.ts、loadTradingDayRuntimeSnapshot 的读取/normalize 段、startupSnapshot/startupRebuild/openRebuild | core/orderRecorder/{orderApiManager,utils}.ts、main/lifecycle/loadTradingDayRuntimeSnapshot.ts、core/orderStatusLifecycle/index.ts | INF-C1/C2；getter 故障、已有结构校验、today 优先、同源择新、非 HK 过滤均作为排除误报条件。重建后每个业务 owner 的副作用由 G1/G3/G4/G5 独立负责。 |
| pending/cache/SELL 权威可卖读取 | pendingOrdersAdapter.ts、sellPositionReadAdapter.ts、application/orderTracking/orderCacheManager.ts、createTradeRuntime.ts | core/trader/{orderCacheManager,accountService,rateLimiter}.ts、相关 types/services.ts | 非 HK 前置过滤；账户数量可小数，卖出目标原文仍证明整数；30s cache、强刷、排序 key、限流路径已分析；不将 orderCache 的旧 clear/in-flight 行为自动列为本次新增。 |
| orderDetail／push → tracking | orderDetailReadAdapter.ts、orderPushAdapter.ts、orderReadErrorClassification.ts、orderMapper.ts、orderValidation.ts、application/orderTracking/orderMonitor/orderStatusQuery.ts | core/trader/orderMonitor/{orderStatusQuery,eventFlow,utils}.ts | 延迟 decode 保留先 guard 再解码；603001 只表示查询失败；不把 ACK 当 terminal。tracking 详细路由／所有经济合并副作用由 G4；本组不声称全路径追踪。 |
| submit/replace/cancel → external error／限流 | tradeMutationAdapter.ts、mutationErrorClassification.ts、tradeMutationErrors.ts、application/orderExecution/rateLimiter.ts、infrastructure/time/index.ts、createTradeRuntime.ts | core/trader/orderExecutor/submitFlow.ts:64-87、core/trader/orderMonitor/utils.ts、core/trader/rateLimiter.ts、utils/apiFailure/index.ts | 单次请求标签、结构化 6 位 submit 拒绝、602012/602013/closed 与 UNKNOWN、SDK 文本往返、单 FIFO/permit 配额已核对；最终授权与 quantityResolver 全域行为在 G4。 |
| 行情 → 静态/昨收/K 线/日历缓存 → 通知 | quoteClient.ts、candlestick{Mapper,Cache}.ts、market{Enum,Metadata}Mapper.ts、types/marketPorts.ts | services/quoteClient/{index,candlestickCache,utils,types}.ts、types/services.ts | 订退订成功／失败 metadata 一致性、初始 seed／同时间 replace／confirmed 单调、per-symbol 缓存、日历 TTL、有限重试已核对；指标算法／host 丢弃与订阅 runtime 的全部事件并发由 G2。 |
| warrantList/read cache → 选标／风险刷新 | warrantRequestMapper.ts、warrantListReadAdapter.ts、warrantListCache/**、quoteFinancialMapper.ts；application/autoSearch/candidateSearch.ts:155-232；application/riskRefresh/warrantRiskRefresh.ts | services/autoSymbolFinder/{index,utils}.ts、quoteClient/index.ts | 位置参数/enum/filter 数组次序、issuer null/undefined、TTL=3000、clear 之后 in-flight identity fencing、事实缺失含义；领域选优公式由 G3/G5。 |
| 显示 → pino → JSONL 日志 | display/{accountDisplay,marketMonitor}/**、logger/index.ts、persistence/mixedTradeLogRepository/**、types/tradeLog.ts | services/{accountDisplay,marketMonitor,mixedTradeLogRepository}/**、utils/logger/index.ts、utils/trading/tradeLogPath.ts | 显示终态格式及金融运算不回流；logger 主体等价；V1 schema/ID/规范文本/同 ID 冲突/append 同步耐久/retention 主体等价；未做真实历史逐条对账或候选回退演练。 |
| 公共 numeric/time/helper → 消费边界 | utils/numeric/{exact,index}.ts、time/index.ts、apiFailure/index.ts、marketScope.ts、runtime/timer/index.ts | utils/{numeric,time,apiFailure,helpers,error,display,timer}/** | 独立 exact 后端、整数商、交叉乘、一次显示舍入、安全数量出口；指标仍 number；纯 time 显式时间注入、formatError 等价改写。迁出的交易会话业务规则由 G1；本组未复审其所有调用方。 |

## 排除误报与历史回归复核

1. **d2aa590**：完整 SHA 为 `d2aa59054abac546f506b27df45f161afcfc6578`。develop 本来就有 `lastExecutionTimeMs > orderRevisionMs` 拒绝逻辑；旧执行时间及 revision 均来自订单 updatedAt，不能误记为“重构新增校验”。重构期间引入独立 execution 时间后该假设不成立，此提交删除仓储两处限制。current 2b67d36 又回到订单驱动观察、同量保留 known T，但当前删除的时间大小约束未重新破坏允许的 durable 事实。此项不报缺陷；未来真实历史／回退版本可恢复性未评估。
2. **2b67d36**：复核涉及的主要 infra 修正是删除 execution-ledger 启动依赖、保留账户小数持仓而非全局安全整数化、严格数值映射前隔离非 HK 订单，以及 SELL 目标单独用原文证明数量整数。不能用今天不存在的旧 execution 驱动路径继续报回归；当前 snapshot/pending/push 的非 HK 过滤确实存在。
3. **正常金融改造**：schema 保留不是数值字节等价；current 的 string 金融事实、10+3 金额配置输入与 half-even 终态输出属于计划明确精度目标。未将这类实现差异单独定性为漂移；也不借计划授权放松其它旧门禁。
4. **旧 helper 接口变化**：toHongKongTimeIso/toHongKongTimeLog 不再自行读墙钟；实际生产直接调用均显式传 Date，未发现因删除默认值导致的当前可达调用失败。formatError 的 isError 包装内联为 instanceof 语义等价。
5. **非生产导出／dead code**：全生产字面引用扫描筛出 OPEN_ORDER_READ_STATUSES、createBrokerAccessAdapter、parseMixedRecord 的“无外文件提及”，但三者都有文件内真实使用；不列 dead code。`constants/orderReadMetadata.ts` 的 lifecycle helper 也被 seatSwitch/domain 实际消费，不能只凭测试引用多就说生产未用。动态工具消费未完整排除，删除建议均不提出。
6. **SDK nullable 字段**：不把“所有正成交 missing revision 应允许”当建议；只有被 today 覆盖的旧观察（INF-C1）与旧明确无成交终态豁免（INF-C2）是本报告候选。实际获选非法成交仍需拒绝。
7. **未证实的外部输入**：SDK 类型未说明负持仓是否可达/如何表示空头；未借负数假设新增混合账户缺陷。账户 mapper 与 snapshot 要求非负的真实业务范围需另有券商事实后才下结论。

## 七维审查结果与未深入边界

- **implementation**：重点链路见上表；INF-C1/C2 已独立自查、仍待另一代理二次复核。没有实盘错误交易的事实证据。
- **project/spec**：读取 AGENTS、四技能、实施计划；重点约束是 no-drift、SDK 隔离、owner、内部错误不能伪装外部重试、V1 不改写。当前 skill 不覆盖 develop 业务真值；cleanup 的全流程执行顺序/策略 env 消费交 G0/G1/G2。
- **type design**：G6 全部 60 个类型文件（45 个公共 types 加邻近 types.ts）做结构分析；未发现 types.ts 运行时代码、公共 SDK import/re-export 或当前金融事实 number 字段泄漏。字段名带 price 的 number 是 `orderMonitorPriceUpdateInterval`，配置 defaultValue 是技术数值，不是金融投影。T=52 文件的所有业务消费者没有由本代理逐一深读；其真实安全语义须汇总相应 owner 审计，不能以结构扫描替代。
- **tests**：检查关键 mapper/cache/配置/SDK fixture 的断言与覆盖边界；未通读全部 43 测试文件。340 pass 不证明全量等价，INF-C1/C2 正是测试未覆盖的旧契约组合。runtime 环境测试单独在外部 cwd＋显式 preload 运行也 4 pass/0 fail，证明初次唯一失败是审计只读环境差异。
- **comments**：涉及范围注释作为线索而不是业务真值；对“保留原语义”逐项看 develop。常量残留空 JSDoc/措辞重复等不形成真实行为或维护阻断，不为凑数量报 minor。
- **dead code**：只做可见静态消费排除；未发现足以建议删除的 A 级候选。SDK 工具动态消费等为 C 边界，不做无证据删除建议。
- **simplification**：认可 SDK 枚举／DTO 私有、数值纯算术单后端、logger/persistence 平移不添 façade；没有提出与行为修复无关的重构。

### G6 以外实际读取的生产文件／片段（不计入 G6=120）

- **装配／限流／账户**：`src/app/runtime/createTradeRuntime.ts`（深读）；`src/app/runtime/createPreGateRuntime.ts`（装配/caching 片段与消费搜索）；`src/application/orderExecution/rateLimiter.ts`（深读并与 develop 对比）；`src/application/orderExecution/tradeMutationErrors.ts`（深读）；`src/application/orderExecution/index.ts:1-260`（目的契约片段，不是全读）；`src/application/accountQuery/index.ts`（深读）；`src/application/accountPositionSnapshot/index.ts:1-210`（金融不可变边界/错误观察片段）。
- **缓存／恢复／查询**：`src/application/orderTracking/orderCacheManager.ts`（深读）；`src/application/orderTracking/recorder/orderApiManager.ts`（深读）；`src/domain/order/orderSnapshotPolicy.ts`（深读）；`src/application/orderTracking/orderMonitor/orderStatusQuery.ts`（深读）；`src/domain/order/executionFact.ts`（与历史 T/revision 约束相关段）；`src/domain/order/orderReadLifecycle.ts`（深读）；`src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts`（读取/normalization/调用边界与恢复片段，未全深读 775 行）；`src/application/tradingDayRebuild/{startupSnapshot,startupRebuild,openRebuild,quoteSymbols}.ts`（候选入口/退出与行情需求边界）；`src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts:1-160`（消费旧 time helper 的片段）。
- **席位／风险**：`src/domain/order/orderOwnership.ts`（常量消费与归属边界深读）；`src/application/riskRefresh/warrantRiskRefresh.ts`（SDK 中性 port 消费深读）；`src/application/autoSearch/candidateSearch.ts:155-232`（warrantList 调用参数／授权边界）；`src/runtime/lifecycle/cacheDomains/seatDomain.ts:49-66`（cache clear 直接调用搜索）。
- **develop 已读对照**：除上表外还读取了 `src/core/riskController/dailyLossTracker.ts` 的 direction/无有效成交忽略段、`src/core/trader/orderHoldRegistry.ts` 的 seed/持有集合段；它们只用于排除候选的错误影响叙述，不宣称完整风险／hold 审计。

### 明确未深入

- G1–G5/G0 的所有状态机、策略算法、行情宿主路由、席位全部消费者、最终执行授权、损益／episode／日切事务，不因本组读取相邻片段而重复声称覆盖。
- G6 的 T 类契约所有生产/动态消费者的闭合证明；B 类主体的逐字整文件重读（已用等价 diff 证明变更面，不声称重审所有旧潜在问题）。
- 真实 broker 组合输入发生频率、真实旧 V1 与权威订单逐条对账、生产发布/回退、SDK 在线 OAuth/context 创建、文件系统崩溃级 fsync 保证；无实盘调用、无发布、无修复。
- 未运行仓库修改式 lint:fix/build clean/format；只读审计没有实施改码，不把未执行这些改码流程计违规。

## 交接状态

- 详细报告为本文件；G6 分级记录 120/120，A65／B3／T52。
- 交主代理独立二次复核：INF-C1、INF-C2；本代理不把待复核候选标为最终 confirmed 缺陷。severity 栏为候选若成立时建议等级。
- 固定 SHAs 复核保持一致；最后一次 `git status --short` 无输出。无仓库源／测试／配置修改。

## 附录：只读原源码差分复现（可由独立复核者直接运行）

以下在仓库根目录用 PowerShell 运行；只读取两个固定 SHA 的原源码并用已安装 TypeScript 做内存 CommonJS 转译，不写源／测试／配置，不创建 SDK context／网络连接。金融输入使用已安装真实 SDK Decimal。它不加载整套启动组装，启动异常传播证据另见 current/develop path:line。

```powershell
$code = @'
const cp = require('child_process');
const path = require('path');
const root = process.cwd();
const OLD = '6e239c8a128372bd9b2fb2d79464346792a5e81e';
const CURRENT = '2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144';
Object.assign(process.env, {
  APP_RUNTIME_PROFILE: 'test', APP_ENABLE_PROCESS_HOOKS: 'false',
  APP_LOG_ROOT_DIR: 'C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/infra-test-logs',
});
const req = require('module').createRequire(root + '/package.json');
const ts = req('typescript');
const cache = new Map();
function load(ref, p) {
  const key = ref + ':' + p;
  if (cache.has(key)) return cache.get(key).exports;
  const source = cp.execFileSync('git', ['show', ref + ':' + p], { cwd: root, encoding: 'utf8' });
  const module = { exports: {} };
  cache.set(key, module);
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const localRequire = q => q.startsWith('.')
    ? load(ref, path.posix.normalize(path.posix.join(path.posix.dirname(p), q)).replace(/\.js$/, '.ts'))
    : req(q);
  new Function('require', 'module', 'exports', '__dirname', '__filename', js)(
    localRequire, module, module.exports, root + '/' + path.posix.dirname(p), root + '/' + p,
  );
  return module.exports;
}
(async () => {
  const sdk = req('longbridge');
  const previous = load(OLD, 'src/core/orderRecorder/orderApiManager.ts');
  const previousRules = load(OLD, 'src/core/orderRecorder/utils.ts');
  const current = load(CURRENT, 'src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts');
  const currentMerge = load(CURRENT, 'src/domain/order/orderSnapshotPolicy.ts');
  const d = value => new sdk.Decimal(value);
  const complete = {
    orderId: 'DUP', symbol: 'BULL.HK', stockName: 'BULL', remark: '',
    side: sdk.OrderSide.Buy, status: sdk.OrderStatus.Filled, orderType: sdk.OrderType.ELO,
    price: d('1'), quantity: d('100'), executedPrice: d('1'), executedQuantity: d('100'),
    submittedAt: new Date(1000), updatedAt: new Date(3000),
  };
  const missingRevision = { ...complete, updatedAt: null };
  const missingOpenPrice = {
    ...complete, status: sdk.OrderStatus.PartialFilled,
    executedQuantity: d('20'), executedPrice: null, updatedAt: new Date(2000),
  };
  const zeroUnknownTerminal = {
    ...complete, side: sdk.OrderSide.Unknown, status: sdk.OrderStatus.Canceled,
    executedQuantity: d('0'), executedPrice: null,
  };
  for (const [name, history, today] of [
    ['INF-C1-missingRevision', [missingRevision], [complete]],
    ['INF-C1-missingOpenPrice', [missingOpenPrice], [complete]],
    ['INF-C2-zeroUnknownTerminal', [zeroUnknownTerminal], []],
    ['control-both-complete', [complete], [complete]],
    ['control-selected-today-invalid', [complete], [missingRevision]],
    ['control-no-override-invalid', [missingRevision], []],
  ]) {
    const makeContext = () => {
      const calls = [];
      return { calls,
        historyOrders: async () => { calls.push('history'); return history; },
        todayOrders: async () => { calls.push('today'); return today; },
      };
    };
    const oldContext = makeContext(), newContext = makeContext();
    const rateLimiter = { throttle: async () => {} };
    const result = { name };
    try {
      const rows = await previous.createOrderAPIManager({ ctx: oldContext, rateLimiter }).fetchAllOrdersFromAPI();
      const classified = previousRules.classifyOrdersForRebuild(rows);
      result.develop = { calls: oldContext.calls, executedBuys: classified.executedBuyOrders.length };
    } catch (error) { result.develop = { calls: oldContext.calls, error: String(error) }; }
    try {
      const rows = await current.createOrderSnapshotReadAdapter(newContext, { rateLimiter }).fetchSnapshots();
      result.current = { calls: newContext.calls,
        selectedRows: currentMerge.mergeAndDeduplicateOrders(rows.historyOrders, rows.todayOrders).length };
    } catch (error) { result.current = { calls: newContext.calls, error: String(error) }; }
    console.log(JSON.stringify(result));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'@
bun --no-env-file --eval $code
```

已执行的输出：

- INF-C1-missingRevision：develop `[history,today]`, executedBuys=1；current `[history]`, TypeError missing independent revision。
- INF-C1-missingOpenPrice：develop `[history,today]`, executedBuys=1；current `[history]`, TypeError invalid cumulative execution quantity/price。
- INF-C2-zeroUnknownTerminal：develop 返回四组空业务分类；current TypeError unknown SDK execution side。
- control-both-complete：develop accepted，current accepted 且去重后 1 条。
- control-selected-today-invalid：develop 与 current 均拒绝；不能借修复使用旧 history 覆盖非法 today。
- control-no-override-invalid：develop 与 current 均拒绝；不能借修复忽略获选的非法正成交。

独立复核应按实际 SDK／原业务允许输入再判定影响等级，而不是只因可以构造 fixture 就宣称线上必然发生。
