# Test Layering Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构当前测试分层，删除低价值与重复测试，收缩 mock/helper 表面积，同时保留并强化核心业务链路与关键边界保护。

**Architecture:** 以 `tests/integration/**` 作为核心链路层，保留结果导向的主流程保护；将 `business.test.ts` 收敛为关键边界层，删除同语义重复覆盖；将 mock/helpers 收缩为最小支撑契约层，去掉 mock 自证和仅服务低价值测试的公共能力。实施过程中必须先建立替代护栏，再允许删除原测试；所有“删文件”动作都要由当前代码中的等价或更高层测试事实支撑，而不是基于猜测。

**Tech Stack:** Bun, TypeScript, bun:test

---

## File Map

### 核心链路层（默认保留）

- `tests/integration/full-business-simulation.integration.test.ts`
- `tests/integration/buy-flow.integration.test.ts`
- `tests/integration/sell-flow.integration.test.ts`
- `tests/integration/doomsday.integration.test.ts`
- `tests/integration/protective-liquidation.integration.test.ts`
- `tests/integration/main-program-strict.integration.test.ts`（只允许收缩低价值 case，不允许整文件删除）
- `tests/architecture/importBoundary.test.ts`

### Lifecycle 测试资产（必须先盘点，再决定保留/收缩）

- `tests/main/lifecycle/dayLifecycleManager.test.ts`
- `tests/main/lifecycle/integration.test.ts`
- `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- `tests/main/lifecycle/rebuildTradingDayState.test.ts`
- `tests/main/lifecycle/startupFailureState.test.ts`
- `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/orderDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/riskDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/seatDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`

### Regression / Chaos 测试资产（必须全量盘点）

- `tests/regression/risk-pipeline-regression.test.ts`
- `tests/regression/order-monitor-regression.test.ts`
- `tests/chaos/candlestick-websocket-out-of-order.test.ts`
- `tests/chaos/websocket-out-of-order.test.ts`
- `tests/chaos/api-flaky-recovery.test.ts`

### 配置与支撑文件

- `tests/config/tradingConfig.failfast.business.test.ts`
- `tests/config/periodicSwitchConfig.business.test.ts`
- `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts`
- `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- `tests/core/trader/orderMonitor.business.test.ts`
- `tests/services/quoteClient/business.test.ts`
- `mock/factories/quoteFactory.ts`
- `mock/factories/tradeFactory.ts`
- `mock/factories/types.ts`
- `mock/longbridge/decimal.ts`
- `tests/helpers/testDoubles.ts`
- `tests/helpers/configEnvFactory.ts`

---

## Locked Guardrails

- 核心不可删除清单统一记录在本节，后续任务必须以这里为准，不得只存在于口头备注。

| 文件 | 保留边界 | 替代护栏 | 允许操作 |
| --- | --- | --- | --- |
| `tests/integration/full-business-simulation.integration.test.ts` | positionCache -> strategy -> orderMonitor -> refresh 的最小业务闭环 | 无；它本身就是主闭环护栏 | 仅允许最小重写，不允许删除 |
| `tests/integration/buy-flow.integration.test.ts` | 买入风控通过/拒绝与执行门控 | 无等价更高层替代 | 仅允许去重，不允许删除 |
| `tests/integration/sell-flow.integration.test.ts` | 卖量来源与改单路径 | 无等价更高层替代 | 仅允许去重，不允许删除 |
| `tests/integration/doomsday.integration.test.ts` | 收盘前限制与清仓路径 | 无等价更高层替代 | 仅允许去重，不允许删除 |
| `tests/integration/protective-liquidation.integration.test.ts` | protective liquidation 成交后的状态推进 | 无等价更高层替代 | 仅允许去重，不允许删除 |
| `tests/integration/main-program-strict.integration.test.ts` | strict gate 主程序短路/放行边界 | 暂无等价更高层替代 | 仅允许收缩低价值 case，不允许整文件删除 |
| `tests/architecture/importBoundary.test.ts` | 架构边界不可回退 | 无等价替代 | 不允许删除 |

- 若后续任务要突破本清单，必须先在本节补充“替代护栏文件 + 保留理由 + 删除理由”，再执行代码改动。

## Decision Ledger

- 本节是 retain / shrink / delete 决策的唯一落点。
- 每次准备删除或迁移测试前，先在这里追加：原文件、决策、理由、替代护栏文件、对应验证命令。
- 若此处没有记录，不得删除对应测试。

### Lifecycle Inventory (Task 2)

| 原文件 | 决策 | 理由 | 替代护栏文件 | 验证命令 |
| --- | --- | --- | --- | --- |
| `tests/main/lifecycle/dayLifecycleManager.test.ts` | `shrink` | 保留状态机独有边界：跨日顺序、午夜清理失败重试、`pendingOpenRebuild` 门禁条件、开盘逆序重建；删除 idle/no-op、空 domain、纯 async smoke 等重复度高且不承载独特业务语义的 case。 | `tests/main/lifecycle/dayLifecycleManager.test.ts`（保留后的状态机护栏）、`tests/main/lifecycle/integration.test.ts` | `bun test tests/main/lifecycle/dayLifecycleManager.test.ts tests/main/lifecycle/integration.test.ts tests/main/lifecycle/cacheDomains/*.test.ts` |
| `tests/main/lifecycle/integration.test.ts` | `shrink` | 仅保留 1 条跨日到开盘重建的端到端链路，以及 1 条“未满足开盘条件时不得重建”的高价值边界；单独的午夜顺序/逆序执行已由 `dayLifecycleManager.test.ts` 更直接覆盖。 | `tests/main/lifecycle/dayLifecycleManager.test.ts`、`tests/main/lifecycle/integration.test.ts`（保留后的 2 条用例） | `bun test tests/main/lifecycle/dayLifecycleManager.test.ts tests/main/lifecycle/integration.test.ts` |
| `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` | `retain` | 覆盖启动快照加载、历史 K 线预热、protective liquidation 恢复等独有重建语义，本轮无等价更高层替代。 | 不适用（自身保留） | `bun test tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` |
| `tests/main/lifecycle/rebuildTradingDayState.test.ts` | `retain` | 覆盖交易日历预热、持仓浮亏重建、fail-fast 前缀等统一开盘重建语义，本轮无等价替代护栏。 | 不适用（自身保留） | `bun test tests/main/lifecycle/rebuildTradingDayState.test.ts` |
| `tests/main/lifecycle/startupFailureState.test.ts` | `retain` | 独有地保护启动失败后切入 `OPEN_REBUILD_FAILED` / `pendingOpenRebuild` 的恢复入口，不进入本轮删除范围。 | 不适用（自身保留） | `bun test tests/main/lifecycle/startupFailureState.test.ts` |
| `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts` | `retain` | `globalStateDomain` 负责真实的跨日全局状态清空与 `runTradingDayOpenRebuild` 触发，是 cacheDomains 中不可替代的状态护栏。 | 不适用（自身保留） | `bun test tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts` |
| `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts` | `shrink` | 仅删除 `openRebuild` no-op 不抛错 case；真正有业务价值的是 `midnightClear` 对运行时订阅与缓存重置的断言。 | `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`（保留后的午夜清理护栏）、`tests/main/lifecycle/integration.test.ts` | `bun test tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts tests/main/lifecycle/integration.test.ts` |
| `tests/main/lifecycle/cacheDomains/orderDomain.test.ts` | `shrink` | 仅删除 `openRebuild` no-op 不抛错 case；保留午夜清理重置 trader 运行态的业务断言。 | `tests/main/lifecycle/cacheDomains/orderDomain.test.ts`（保留后的午夜清理护栏）、`tests/main/lifecycle/integration.test.ts` | `bun test tests/main/lifecycle/cacheDomains/orderDomain.test.ts tests/main/lifecycle/integration.test.ts` |
| `tests/main/lifecycle/cacheDomains/riskDomain.test.ts` | `shrink` | 仅删除 `openRebuild` no-op 不抛错 case；保留午夜风控冷却清理与 minutes 模式边界，这两者承载独有业务语义。 | `tests/main/lifecycle/cacheDomains/riskDomain.test.ts`（保留后的午夜清理护栏）、`tests/main/lifecycle/rebuildTradingDayState.test.ts` | `bun test tests/main/lifecycle/cacheDomains/riskDomain.test.ts tests/main/lifecycle/rebuildTradingDayState.test.ts` |
| `tests/main/lifecycle/cacheDomains/seatDomain.test.ts` | `shrink` | 仅删除 `openRebuild` no-op 不抛错 case；保留午夜席位清空、版本推进与快照同步断言。 | `tests/main/lifecycle/cacheDomains/seatDomain.test.ts`（保留后的午夜清理护栏）、`tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` | `bun test tests/main/lifecycle/cacheDomains/seatDomain.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts` |
| `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts` | `retain` | 同时覆盖 midnight drain/release 与 openRebuild restart/markFresh，是唯一验证信号运行时恢复顺序的护栏，不进入本轮删除范围。 | 不适用（自身保留） | `bun test tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts` |

### Regression / Chaos Inventory (Task 4)

| 原文件 | 决策 | 理由 | 替代护栏文件 | 验证命令 |
| --- | --- | --- | --- | --- |
| `tests/regression/risk-pipeline-regression.test.ts` | `migrate_then_delete` | 两条语义都属于 `riskCheckPipeline` 的业务边界，不需要保留独立 regression 层；迁入后由同层 business 护栏直接覆盖。 | `tests/core/signalProcessor/riskCheckPipeline.business.test.ts` | `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/regression/risk-pipeline-regression.test.ts` |
| `tests/regression/order-monitor-regression.test.ts` | `migrate_then_delete` | 浮点阈值边界、禁追高边界、超时撤单不重复执行都属于 `orderMonitor` 运行态契约，应回收到 business 层统一保护。 | `tests/core/trader/orderMonitor.business.test.ts` | `bun test tests/core/trader/orderMonitor.business.test.ts tests/regression/order-monitor-regression.test.ts` |
| `tests/chaos/candlestick-websocket-out-of-order.test.ts` | `migrate_then_delete` | 更老 timestamp 乱序 push 与 confirmed 幂等都属于 `quoteClient` candlestick 缓存语义，迁入业务层后 chaos 文件不再提供额外价值。 | `tests/services/quoteClient/business.test.ts` | `bun test tests/services/quoteClient/business.test.ts tests/chaos/candlestick-websocket-out-of-order.test.ts` |
| `tests/chaos/websocket-out-of-order.test.ts` | `migrate_then_delete` | BOOTSTRAPPING 阶段旧 WS 事件不得回退终态，本质是 `orderMonitor` 恢复态护栏，迁入业务层即可保留完整语义。 | `tests/core/trader/orderMonitor.business.test.ts` | `bun test tests/core/trader/orderMonitor.business.test.ts tests/chaos/websocket-out-of-order.test.ts` |
| `tests/chaos/api-flaky-recovery.test.ts` | `split_migrate_then_delete_if_equivalent` | 文件包含两条独立语义：refresh backlog 合并恢复应迁入 `postTradeRefresher`，超时撤单失败后的 backoff 重试且继续等待 WS 终态应迁入 `orderMonitor`；只有两条都形成等价护栏后才删除原 chaos 文件。 | `tests/main/asyncProgram/postTradeRefresher/business.test.ts`、`tests/core/trader/orderMonitor.business.test.ts` | `bun test tests/main/asyncProgram/postTradeRefresher/business.test.ts tests/core/trader/orderMonitor.business.test.ts tests/chaos/api-flaky-recovery.test.ts` |

### Mock / Contract Inventory (Task 5)

| 原文件 / 导出面 | 决策 | 理由 | 替代护栏文件 | 验证命令 |
| --- | --- | --- | --- | --- |
| `tests/mock-contract/quoteContext.contract.test.ts` | `delete` | 用例全部在验证 mock 自身 seed / emit / failure rule / subscription 语义；真实高价值消费者已经由 `tests/services/quoteClient/business.test.ts`、`tests/services/autoSymbolFinder/business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts` 覆盖，不再保留独立 contract 层。 | `tests/services/quoteClient/business.test.ts`、`tests/services/autoSymbolFinder/business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts` | `bun test tests/services/quoteClient/business.test.ts tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts` |
| `tests/mock-contract/tradeContext.contract.test.ts` | `delete` | 用例聚焦 trade mock 自证：seedTodayExecutions / seedAccountBalances / topic subscription / failure injection；真实业务消费者仅需要 submit/orderDetail/history/today/stockPositions/orderChanged 语义，已由 integration、`orderMonitor.business`、`orderApiManager.test.ts` 覆盖。 | `tests/integration`、`tests/core/trader/orderMonitor.business.test.ts`、`tests/core/orderRecorder/orderApiManager.test.ts` | `bun test tests/integration tests/core/trader/orderMonitor.business.test.ts tests/core/orderRecorder/orderApiManager.test.ts` |
| `tests/mock-contract/decimal.contract.test.ts` | `delete` | `decimalEquals` 与 `decimalToNumberSafe` 仅被 contract 测试消费，没有业务测试价值；真实测试仅依赖 `toMockDecimal` 构造 Decimal。 | `tests/services/autoSymbolFinder/business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts`、`tests/helpers/testDoubles.ts` | `bun test tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts tests/core/trader/orderMonitor.business.test.ts` |
| `mock/factories/quoteFactory.ts#createPushQuoteEvent` | `delete` | 仅被已删除的 quote contract 使用；真实业务测试未消费 quote push 工厂。 | `tests/services/quoteClient/business.test.ts`（继续使用 candlestick push） | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/quoteFactory.ts#createCandlestick` | `retain` | 被 `tests/services/quoteClient/business.test.ts` 用于历史回补与缓存合并边界，属于高价值业务测试依赖。 | 不适用（自身保留） | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/quoteFactory.ts#createPushCandlestickEvent` | `retain` | 被 `tests/services/quoteClient/business.test.ts` 用于乱序 push / confirmed 幂等边界，属于高价值业务测试依赖。 | 不适用（自身保留） | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/quoteFactory.ts#createWarrantQuote` | `delete` | 仅被 quote contract 使用；当前真实业务测试未消费 warrantQuote seed 工厂。 | 无（无真实消费者） | `bun test tests/services/quoteClient/business.test.ts tests/services/autoSymbolFinder/business.test.ts` |
| `mock/factories/quoteFactory.ts#createWarrantInfo` | `delete` | 已有 `tests/main/recovery/seatPreparation.business.test.ts` / `tests/services/autoSymbolFinder/business.test.ts` 本地 helper，就近构造更贴近真实消费字段；公共工厂不再保留。 | `tests/main/recovery/seatPreparation.business.test.ts`、`tests/services/autoSymbolFinder/business.test.ts` | `bun test tests/main/recovery/seatPreparation.business.test.ts tests/services/autoSymbolFinder/business.test.ts` |
| `mock/factories/quoteFactory.ts#createTradingDaysResult` | `delete` | 仅被 quote contract 使用；`quoteClient.business.test.ts` 已直接就地构造 tradingDays seed。 | `tests/services/quoteClient/business.test.ts` | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/quoteFactory.ts#createSecurityQuote` | `delete` | 仅被 quote contract 使用；真实业务测试已在 `quoteClient.business.test.ts` 本地构造最小 quote fixture。 | `tests/services/quoteClient/business.test.ts` | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/quoteFactory.ts#createSecurityStaticInfo` | `delete` | 仅被 quote contract 使用；真实业务测试已在 `quoteClient.business.test.ts` 本地构造最小 staticInfo fixture。 | `tests/services/quoteClient/business.test.ts` | `bun test tests/services/quoteClient/business.test.ts` |
| `mock/factories/tradeFactory.ts#createOrder` | `retain` | 被 `tests/core/trader/orderMonitor.business.test.ts` 用于成交后剩余数量转市价单场景，属于高价值业务依赖。 | 不适用（自身保留） | `bun test tests/core/trader/orderMonitor.business.test.ts` |
| `mock/factories/tradeFactory.ts#createPushOrderChanged` | `retain` | 被 integration 与 `orderMonitor.business` 广泛消费，用于订单状态推进主链路。 | `tests/integration`、`tests/core/trader/orderMonitor.business.test.ts` | `bun test tests/integration tests/core/trader/orderMonitor.business.test.ts` |
| `mock/factories/tradeFactory.ts#createExecution` | `delete` | 仅被 trade contract 使用；当前真实业务测试无消费者。 | 无（无真实消费者） | `bun test tests/core/orderRecorder/orderApiManager.test.ts tests/integration` |
| `mock/factories/tradeFactory.ts#createAccountBalance` | `delete` | 仅被 trade contract 使用；当前真实业务测试无消费者。 | 无（无真实消费者） | `bun test tests/core/orderRecorder/orderApiManager.test.ts tests/integration` |
| `mock/factories/tradeFactory.ts#createStockPositionsResponse` | `retain` | 被 `tests/integration/sell-flow.integration.test.ts` 使用，承载 quantity 仅来自 availableQuantity 的高价值链路。 | 不适用（自身保留） | `bun test tests/integration/sell-flow.integration.test.ts` |
| `mock/factories/types.ts` 导出集合 | `downscope` | 保留 `CandlestickParams`、`PushCandlestickEventParams`、`OrderFactoryParams`、`PushOrderChangedParams`、`StockPositionsResponseParams` 给仍存工厂使用；删除仅服务已删工厂的 `PushQuoteEventParams`、`WarrantQuoteParams`、`WarrantInfoParams`、`TradingDaysResultParams`。 | 对应保留工厂文件 | `bun test tests/services/quoteClient/business.test.ts tests/core/trader/orderMonitor.business.test.ts tests/integration/sell-flow.integration.test.ts` |
| `mock/longbridge/decimal.ts#toMockDecimal` | `retain` | 被 `tests/helpers/testDoubles.ts`、`tests/services/autoSymbolFinder/business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts` 及 mock 工厂消费，属于仍有业务价值的公共能力。 | 不适用（自身保留） | `bun test tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts` |
| `mock/longbridge/decimal.ts#decimalEquals` | `delete` | 仅被 decimal contract 测试消费，无真实业务消费者。 | 无（无真实消费者） | `bun test tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts` |
| `mock/longbridge/decimal.ts#decimalToNumberSafe` | `delete` | 仅被 decimal contract 测试消费，无真实业务消费者。 | 无（无真实消费者） | `bun test tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts` |
| `mock/longbridge/quoteContextMock.ts` 导出面 | `downscope` | 真实消费者盘点后，仅 `seedQuotes` / `seedRealtimeQuotes` / `seedStaticInfo` / `seedCandlesticks` / `seedTradingDays` / `seedWarrantList` / `emitCandlestick` / `flushAllEvents` / `getCalls` 被 `quoteClient.business`、`autoSymbolFinder.business`、`seatPreparation.business`、`tests/helpers/testDoubles.ts` 使用；`seedWarrantQuotes`、`getSubscribedSymbols`、`getSubscribedCandlestickKeys` 在仓库内已无真实消费者，且原用途只剩已删除 contract 测试，因此收缩导出面。 | `tests/services/quoteClient/business.test.ts`、`tests/services/autoSymbolFinder/business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts`、`tests/helpers/testDoubles.ts` | `bun test tests/services/quoteClient/business.test.ts tests/services/autoSymbolFinder/business.test.ts tests/main/recovery/seatPreparation.business.test.ts tests/core/riskController/warrantRiskChecker.business.test.ts` |
| `mock/longbridge/tradeContextMock.ts` 导出面 | `downscope` | 真实消费者仅依赖 submit/orderDetail/history/today/stockPositions/orderChanged、topic 订阅副作用与 call-log；`seedTodayExecutions`、`seedAccountBalances`、`getSubscribedTopics` 在仓库内无测试或业务调用，原语义仅服务已删除 trade contract，因此与 `mock/longbridge/types.ts` 一并收缩。 | `tests/integration`、`tests/core/trader/orderMonitor.business.test.ts`、`tests/core/orderRecorder/orderApiManager.test.ts` | `bun test tests/integration tests/core/trader/orderMonitor.business.test.ts tests/core/orderRecorder/orderApiManager.test.ts tests/main/recovery/seatPreparation.business.test.ts` |
| `mock/longbridge/types.ts` 中 Quote/Trade mock 扩展接口 | `downscope` | `QuoteContextMock` / `TradeContextMock` 的扩展签名需与真实消费者一致；`seedWarrantQuotes`、`getSubscribedSymbols`、`getSubscribedCandlestickKeys`、`seedTodayExecutions`、`seedAccountBalances`、`getSubscribedTopics` 均无仓库内消费者，保留只会继续暴露无价值公共 API。`warrantQuote` / `todayExecutions` / `accountBalance` / `subscribe` 等真实业务合同仍保留在 `QuoteContextContract` / `TradeContextContract`，不影响运行态依赖。 | `tests/services/quoteClient/business.test.ts`、`tests/core/orderRecorder/orderApiManager.test.ts`、`tests/core/trader/orderMonitor.business.test.ts`、`tests/main/recovery/seatPreparation.business.test.ts` | `bun test tests/integration tests/services/quoteClient/business.test.ts tests/core/orderRecorder/orderApiManager.test.ts tests/core/trader/orderMonitor.business.test.ts tests/main/recovery/seatPreparation.business.test.ts tests/services/autoSymbolFinder/business.test.ts tests/core/riskController/warrantRiskChecker.business.test.ts` |

## Migration Mapping Ledger

- 本节是 regression / chaos / mock-contract 语义迁移映射的唯一落点。
- 每次迁移前，先在这里追加：原测试语义、目标测试文件、目标断言点、验证命令。
- 只有在映射已落地且新护栏先通过后，才允许删除原 case。

### Regression / Chaos Mapping (Task 4)

| 原测试语义 | 目标测试文件 | 目标断言点 | 验证命令 |
| --- | --- | --- | --- |
| `risk-pipeline-regression`: 风险检查阶段不应消耗 `buyThrottle` 槽位 | `tests/core/signalProcessor/riskCheckPipeline.business.test.ts` | 连续两次 risk pipeline 通过后，再调用 `buyThrottle.canTradeNow('BUYCALL')` 仍返回 `canTrade: true` | `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts` |
| `risk-pipeline-regression`: 混合批次中 buy 实时拉取失败时，sell 仍按缓存上下文通过 | `tests/core/signalProcessor/riskCheckPipeline.business.test.ts` | buy signal 因实时账户/持仓拉取失败被拒绝，sell signal 继续使用 `cachedAccount` / `cachedPositions` 通过 | `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts` |
| `candlestick-websocket-out-of-order`: 更老 timestamp 的乱序 push 不得覆盖更新行情 | `tests/services/quoteClient/business.test.ts` | older timestamp push 后 snapshot 的 `version`、`candles`、`lastBarTimestamp` 保持不变 | `bun test tests/services/quoteClient/business.test.ts` |
| `candlestick-websocket-out-of-order`: 同 timestamp confirmed 重放保持幂等，且后续 stale 非 confirmed push 不得回退 | `tests/services/quoteClient/business.test.ts` | confirmed replay 不递增 `version`，stale rollback push 不改变 `candles` 且 `lastBarConfirmed` 保持 `true` | `bun test tests/services/quoteClient/business.test.ts` |
| `order-monitor-regression`: 浮点阈值边界 | `tests/core/trader/orderMonitor.business.test.ts` | `0.059 -> 0.058` 边界触发一次 `replaceOrder`，`0.059 -> 0.0581` 不追加触发 | `bun test tests/core/trader/orderMonitor.business.test.ts` |
| `order-monitor-regression`: 禁追高边界 | `tests/core/trader/orderMonitor.business.test.ts` | `allowBuyOrderTrackingAboveInitialPrice=false` 且市场价高于初始价时，不发生 `replaceOrder` | `bun test tests/core/trader/orderMonitor.business.test.ts` |
| `order-monitor-regression`: 超时撤单不重复执行 | `tests/core/trader/orderMonitor.business.test.ts` | 首次 timeout 成功发起 `cancelOrder` 后，再次轮询不再重复撤单，也不提前 `submitOrder` | `bun test tests/core/trader/orderMonitor.business.test.ts` |
| `api-flaky-recovery`: refresh backlog 合并恢复 | `tests/main/asyncProgram/postTradeRefresher/business.test.ts` | 首次账户刷新失败后，第二次 enqueue 与 backlog 合并；恢复后只需一次成功刷新即可更新缓存与浮亏数据 | `bun test tests/main/asyncProgram/postTradeRefresher/business.test.ts` |
| `api-flaky-recovery`: 超时撤单失败后的 backoff 重试，成功后继续等待 WS 终态 | `tests/core/trader/orderMonitor.business.test.ts` | 首次 `cancelOrder` 失败不触发 `submitOrder`；backoff 后重试成功，仍保持 pending sell，直到 WS 终态前不重复提交市价单 | `bun test tests/core/trader/orderMonitor.business.test.ts` |
| `websocket-out-of-order`: BOOTSTRAPPING 阶段旧事件不得回退终态 | `tests/core/trader/orderMonitor.business.test.ts` | 先接收 Filled，再接收更旧 PartialFilled，再执行 snapshot recovery 后仍保留 terminal filled 摘要且无 pending sell | `bun test tests/core/trader/orderMonitor.business.test.ts` |

### Task 1: 固定核心链路保护集

**Files:**

- Review: `tests/integration/full-business-simulation.integration.test.ts`
- Review: `tests/integration/buy-flow.integration.test.ts`
- Review: `tests/integration/sell-flow.integration.test.ts`
- Review: `tests/integration/doomsday.integration.test.ts`
- Review: `tests/integration/protective-liquidation.integration.test.ts`
- Review: `tests/integration/main-program-strict.integration.test.ts`
- Review: `tests/architecture/importBoundary.test.ts`

- [ ] **Step 1: 逐个阅读核心链路测试，记录每个文件保护的业务结果**

目标记录：

- `full-business-simulation`：positionCache 单一持仓来源闭环
- `buy-flow`：买入风控/执行门控
- `sell-flow`：卖量来源/改单行为
- `doomsday`：收盘前限制与清仓
- `protective-liquidation`：保护性清仓成交后的状态推进
- `main-program-strict`：strict gate 的主程序短路/放行边界

- [ ] **Step 2: 将不可删除清单写入本计划的 `Locked Guardrails` 章节，并补充每个文件的保留理由**

要求：

- 不删除上述 6 个核心 integration 文件
- `main-program-strict` 只允许删除低价值 case，不允许整文件删除
- `importBoundary` 作为架构护栏保留
- 每个文件都要在 `Locked Guardrails` 中有“文件路径 + 保留理由”记录，作为后续删除审计依据

- [ ] **Step 3: 运行核心链路 smoke，确认基线可用**

Run: `bun test tests/integration/full-business-simulation.integration.test.ts tests/integration/buy-flow.integration.test.ts tests/integration/sell-flow.integration.test.ts tests/integration/doomsday.integration.test.ts tests/integration/protective-liquidation.integration.test.ts tests/integration/main-program-strict.integration.test.ts tests/architecture/importBoundary.test.ts`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-02-test-layering-refactor.md
git commit -m "docs: lock test layering baseline"
```

### Task 2: 先做 lifecycle 全量盘点，再执行收敛

**Files:**

- Review: `tests/main/lifecycle/dayLifecycleManager.test.ts`
- Review: `tests/main/lifecycle/integration.test.ts`
- Review: `tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts`
- Review: `tests/main/lifecycle/rebuildTradingDayState.test.ts`
- Review: `tests/main/lifecycle/startupFailureState.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/globalStateDomain.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/orderDomain.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/riskDomain.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/seatDomain.test.ts`
- Review: `tests/main/lifecycle/cacheDomains/signalRuntimeDomain.test.ts`

- [ ] **Step 1: 为每个 lifecycle 文件写出 retain / shrink / delete 决策与理由**

决策模板：

- `retain`：独有业务边界，不能删
- `shrink`：保留关键边界，删除重复 case
- `delete`：语义已被等价或更高层护栏覆盖

- [ ] **Step 2: 先在 `Decision Ledger` 记录 lifecycle 的 retain / shrink / delete 决策，再执行任何删除或收敛**

要求：

- 每个准备删除或收缩的文件都要先写：原文件、决策、理由、替代护栏文件、验证命令
- Ledger 未落地前，不允许删除 case 或文件

- [ ] **Step 3: 仅对确认高重复的文件执行收敛**

首批目标：

- `tests/main/lifecycle/dayLifecycleManager.test.ts`
- `tests/main/lifecycle/integration.test.ts`
- `tests/main/lifecycle/cacheDomains/marketDataDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/orderDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/riskDomain.test.ts`
- `tests/main/lifecycle/cacheDomains/seatDomain.test.ts`

保留原则：

- `dayLifecycleManager.test.ts` 保留状态机独有边界：跨日顺序、失败重试、pendingOpenRebuild 条件、开盘逆序重建
- `integration.test.ts` 只保留 1 条端到端链路 + 1 条高价值边界
- cacheDomains 中仅验证 `openRebuild` no-op 不抛错的 case 可以删

- [ ] **Step 4: 明确不进入本轮删除范围但必须保留的 lifecycle 护栏**

默认保留：

- `loadTradingDayRuntimeSnapshot.test.ts`
- `rebuildTradingDayState.test.ts`
- `startupFailureState.test.ts`
- `globalStateDomain.test.ts`
- `signalRuntimeDomain.test.ts`

除非后续盘点证明有等价替代护栏，否则不删不并。

- [ ] **Step 5: 运行 lifecycle 目标测试验证收敛后仍覆盖核心边界**

Run: `bun test tests/main/lifecycle/dayLifecycleManager.test.ts tests/main/lifecycle/integration.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/main/lifecycle/rebuildTradingDayState.test.ts tests/main/lifecycle/startupFailureState.test.ts tests/main/lifecycle/cacheDomains/*.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/main/lifecycle/dayLifecycleManager.test.ts tests/main/lifecycle/integration.test.ts tests/main/lifecycle/loadTradingDayRuntimeSnapshot.test.ts tests/main/lifecycle/rebuildTradingDayState.test.ts tests/main/lifecycle/startupFailureState.test.ts tests/main/lifecycle/cacheDomains/*.test.ts
git commit -m "test: simplify lifecycle layering"
```

### Task 3: 合并配置测试，消除碎片配置文件

**Files:**

- Modify: `tests/config/tradingConfig.failfast.business.test.ts`
- Delete: `tests/config/periodicSwitchConfig.business.test.ts`
- Delete or shrink: `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts`
- Test: `tests/config/tradingConfig.failfast.business.test.ts`

- [ ] **Step 1: 在 `tradingConfig.failfast.business.test.ts` 增加表驱动 case，覆盖 `SWITCH_INTERVAL_MINUTES` 与 buy chase control 的关键边界**

必须覆盖：

- static 模式忽略 `SWITCH_INTERVAL_MINUTES`
- auto 模式合法值通过
- auto 模式非法值 fail-fast
- buy chase control 的显式开关边界

- [ ] **Step 2: 运行新增 case，先确认新主文件独立通过**

Run: `bun test tests/config/tradingConfig.failfast.business.test.ts`

Expected: PASS

- [ ] **Step 3: 删除已被主文件完整吸收的碎片测试文件**

删除条件：

- 原文件中的业务语义已在主文件逐条映射
- 删除后不丢失 validator/fail-fast 的边界

- [ ] **Step 4: 运行配置测试集确认无漏测**

Run: `bun test tests/config/*.business.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/config/tradingConfig.failfast.business.test.ts tests/config/periodicSwitchConfig.business.test.ts tests/config/orderMonitorBuyChaseControlConfig.business.test.ts
git commit -m "test: consolidate trading config coverage"
```

### Task 4: 全量盘点 regression / chaos，再迁移独特语义

**Files:**

- Review/possibly modify: `tests/regression/risk-pipeline-regression.test.ts`
- Review/possibly modify: `tests/regression/order-monitor-regression.test.ts`
- Review/possibly modify: `tests/chaos/candlestick-websocket-out-of-order.test.ts`
- Review/possibly modify: `tests/chaos/websocket-out-of-order.test.ts`
- Review/possibly modify: `tests/chaos/api-flaky-recovery.test.ts`
- Review/possibly modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- Review/possibly modify: `tests/core/trader/orderMonitor.business.test.ts`
- Review/possibly modify: `tests/services/quoteClient/business.test.ts`

- [ ] **Step 1: 先在 `Decision Ledger` 记录 regression / chaos 每个文件的 retain / migrate / delete 决策**

必须覆盖全部 5 个文件，不能只处理其中 2 个。要求：

- 每个文件都要写：原文件、决策、理由、替代护栏文件、验证命令
- Ledger 未落地前，不允许删除原 case 或原文件

- [ ] **Step 2: 先补独特语义，再删原文件或原 case**

迁移前置必补 case：

- 将 `risk-pipeline-regression.test.ts` 中以下语义显式迁入 `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`：
  - 风险检查阶段不应消耗 `buyThrottle` 槽位
  - 混合批次中，buy 实时拉取失败时，sell 仍按缓存上下文通过
- 将 `candlestick-websocket-out-of-order.test.ts` 中“更老 timestamp 的乱序 push 不得覆盖更新行情”显式迁入 `tests/services/quoteClient/business.test.ts`，若该语义尚未存在。
- 将 `order-monitor-regression.test.ts` 的独特语义逐条映射到 `tests/core/trader/orderMonitor.business.test.ts`：
  - 浮点阈值边界
  - 禁追高边界
  - 超时撤单不重复执行这些都属于 order monitor 运行态行为，不迁入 `settlementFlow.business.test.ts`。
- 将 `api-flaky-recovery.test.ts` 的独特语义拆分迁移：
  - “refresh backlog 合并恢复” 迁入 `tests/main/asyncProgram/postTradeRefresher/business.test.ts`
  - “超时撤单失败后的 backoff 重试，成功后继续等待 WS 终态” 迁入 `tests/core/trader/orderMonitor.business.test.ts`；若当前无法形成等价护栏，则保留原 chaos case，不删除该语义
- 将 `websocket-out-of-order.test.ts` 中“BOOTSTRAPPING 阶段旧事件不得回退终态”的语义显式迁入 `tests/core/trader/orderMonitor.business.test.ts` 后，才允许收缩或删除原 case。

- [ ] **Step 3: 先只运行迁入目标文件，确认新护栏独立通过**

Run: `bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/core/trader/orderMonitor.business.test.ts tests/services/quoteClient/business.test.ts tests/main/asyncProgram/postTradeRefresher/business.test.ts`

Expected: PASS

- [ ] **Step 4: 删除已无独特价值的 regression / chaos 文件或 case**

删除标准：

- 业务语义已迁入更合适的边界层
- 删除动作有明确映射表支撑
- 删除后仍保留对应业务边界护栏

- [ ] **Step 5: 删除后再跑 regression / chaos 全组验证，确认旧护栏移除后仍通过**

Run: `bun test tests/regression tests/chaos tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/core/trader/orderMonitor.business.test.ts tests/services/quoteClient/business.test.ts tests/main/asyncProgram/postTradeRefresher/business.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
# 仅添加当前仍存在的实际文件；若某目录已删空，改为逐文件 add
 git add tests/regression tests/chaos tests/core/signalProcessor/riskCheckPipeline.business.test.ts tests/core/trader/orderMonitor.business.test.ts tests/services/quoteClient/business.test.ts tests/main/asyncProgram/postTradeRefresher/business.test.ts
 git commit -m "test: fold duplicate regression and chaos coverage"
```

### Task 5: 移除 mock 自证型 contract 测试，收缩公共 mock API

**Files:**

- Delete or shrink: `tests/mock-contract/quoteContext.contract.test.ts`
- Delete or shrink: `tests/mock-contract/tradeContext.contract.test.ts`
- Delete or shrink: `tests/mock-contract/decimal.contract.test.ts`
- Modify: `mock/factories/quoteFactory.ts`
- Modify: `mock/factories/tradeFactory.ts`
- Modify: `mock/longbridge/decimal.ts`
- Review/possibly modify: `mock/longbridge/quoteContextMock.ts`
- Review/possibly modify: `mock/longbridge/tradeContextMock.ts`

- [ ] **Step 1: 先在 `Decision Ledger` 记录 mock / contract 收缩决策，再对 mock 工厂与 decimal 模块做全导出引用盘点，形成 retain / delete / downscope 清单**

至少覆盖：

- `mock/factories/quoteFactory.ts` 全部导出
- `mock/factories/tradeFactory.ts` 全部导出
- `mock/factories/types.ts` 全部导出
- `mock/longbridge/decimal.ts` 全部导出
- `mock/longbridge/quoteContextMock.ts` 的导出面
- `mock/longbridge/tradeContextMock.ts` 的导出面

重点关注但不限于：

- `createPushQuoteEvent`
- `createSecurityQuote`
- `createSecurityStaticInfo`
- `createWarrantQuote`
- `createWarrantInfo`
- `createTradingDaysResult`
- `createExecution`
- `createAccountBalance`
- `decimalEquals`
- `decimalToNumberSafe`

- [ ] **Step 2: 若这些导出没有被高价值业务测试使用，将其下沉到就近测试文件或直接删除**

要求：

- 不保留“为了测试 mock 本身而暴露”的公共 API
- 若某导出仍被 integration/business 使用，则保留

- [ ] **Step 3: 将三份 contract 测试压缩为最小必要契约，或直接删除无业务价值 case**

优先策略：

- 能删则删
- 若必须保留，只保留最小 smoke：创建 mock、执行 1 个核心 API、验证主流程依赖的基础能力存在

- [ ] **Step 4: 基于 Step 1 的全导出盘点结果，生成受影响测试清单并执行，确认公共能力未误删**

最低必须覆盖：

- `tests/integration`
- `tests/services/quoteClient/business.test.ts`
- `tests/core/orderRecorder/orderApiManager.test.ts`
- `tests/core/trader/orderMonitor.business.test.ts`
- `tests/main/recovery/seatPreparation.business.test.ts`
- `tests/services/autoSymbolFinder/business.test.ts`
- 以及 Step 1 盘点中命中的其它真实消费者

Run: `bun test tests/integration tests/services/quoteClient/business.test.ts tests/core/orderRecorder/orderApiManager.test.ts tests/core/trader/orderMonitor.business.test.ts tests/main/recovery/seatPreparation.business.test.ts tests/services/autoSymbolFinder/business.test.ts`

Expected: PASS；若 Step 1 发现更多消费者，需把它们补入本命令后再执行

- [ ] **Step 5: 若最终保留任何 `tests/mock-contract/*.test.ts`，把保留下来的 contract smoke 一并跑通**

Run: `bun test tests/mock-contract/*.test.ts`

Expected: PASS（仅当仍保留 contract 文件时执行）

- [ ] **Step 6: Commit**

```bash
# 仅添加当前仍存在的实际文件；若 contract 目录已删空，不要使用空通配符
 git add tests/mock-contract mock/factories/quoteFactory.ts mock/factories/tradeFactory.ts mock/longbridge/decimal.ts mock/longbridge/quoteContextMock.ts mock/longbridge/tradeContextMock.ts
 git commit -m "test: trim mock contract surface"
```

### Task 6: 基于真实使用频次瘦身 `testDoubles.ts`

**Files:**

- Modify: `tests/helpers/testDoubles.ts`
- Review/possibly modify: `tests/app/runApp.test.ts`
- Review/possibly modify: `tests/app/createLifecycleRuntime.wiring.test.ts`
- Review/possibly modify: `tests/main/processMonitor/signalPipeline.business.test.ts`
- Review/possibly modify: `tests/main/asyncProgram/sellProcessor/business.test.ts`

- [ ] **Step 1: 先统计 `testDoubles.ts` 各导出的真实引用频次，再决定删改范围**

要求：

- 不把高频 helper 误判为低频
- `createStrategyRuntimeConfigDouble` 当前是高频 helper，不作为首批删除候选

- [ ] **Step 2: 仅处理真正的薄包装或低频 helper**

优先候选：

- 与 `mock/factories/signalFactory.ts` 重叠、且经 Step 1 统计后确认为低频的信号构造 helper
- 仅被 1~2 个文件使用的装配层 doubles
- 纯转调且无额外语义的局部 helper

补充限制：

- `createSignalDouble` 当前不是首批默认删除候选，只有在 Step 1 统计确认其已低频且存在等价替代时才可处理

- [ ] **Step 3: 仅在当前测试存在脆弱实现耦合时才重写断言**

要求：

- 先确认文件中是否真的存在 `getCalls()` 或过强调用序断言
- `tests/app/runApp.test.ts` 与 `tests/app/createLifecycleRuntime.wiring.test.ts` 不预设一定要改，只有在审查后确认脆弱时才动
- 若当前断言已经是关键时序/业务结果断言，则保持不动

- [ ] **Step 4: 运行依赖这些 helper 的目标测试，确认重写后语义仍正确**

Run: `bun test tests/app/runApp.test.ts tests/app/createLifecycleRuntime.wiring.test.ts tests/main/processMonitor/signalPipeline.business.test.ts tests/main/asyncProgram/sellProcessor/business.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/testDoubles.ts tests/app/runApp.test.ts tests/app/createLifecycleRuntime.wiring.test.ts tests/main/processMonitor/signalPipeline.business.test.ts tests/main/asyncProgram/sellProcessor/business.test.ts
git commit -m "test: localize low-value doubles"
```

### Task 7: 按实际触达范围做最终验证

**Files:**

- Verify only: `tests/app/**/*.ts`
- Verify only: `tests/architecture/**/*.ts`
- Verify only: `tests/integration/**/*.ts`
- Verify only: `tests/config/**/*.ts`
- Verify only: `tests/main/lifecycle/**/*.ts`
- Verify only: `tests/regression/**/*.ts`
- Verify only: `tests/chaos/**/*.ts`
- Verify only: `tests/core/signalProcessor/**/*.ts`
- Verify only: `tests/core/trader/**/*.ts`
- Verify only: `tests/services/quoteClient/**/*.ts`
- Verify only: `tests/main/processMonitor/**/*.ts`
- Verify only: `tests/main/asyncProgram/**/*.ts`
- Verify only: `mock/**/*.ts`
- Verify only: `tests/helpers/**/*.ts`

- [ ] **Step 1: 运行受影响测试分组，确认删改后仍然通过**

Run: `bun test tests/app tests/architecture tests/integration tests/config tests/main/lifecycle tests/regression tests/chaos tests/core/signalProcessor tests/core/trader tests/services/quoteClient tests/main/processMonitor tests/main/asyncProgram`

Expected: PASS

- [ ] **Step 2: 运行格式化**

Run: `bun format` Expected: PASS

- [ ] **Step 3: 运行 lint**

Run: `bun lint` Expected: PASS

- [ ] **Step 4: 运行 type-check**

Run: `bun type-check` Expected: PASS

- [ ] **Step 5: 再次运行核心护栏保护集，确认主业务闭环与架构边界未被破坏**

Run: `bun test tests/integration/full-business-simulation.integration.test.ts tests/integration/buy-flow.integration.test.ts tests/integration/sell-flow.integration.test.ts tests/integration/doomsday.integration.test.ts tests/integration/protective-liquidation.integration.test.ts tests/integration/main-program-strict.integration.test.ts tests/architecture/importBoundary.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests mock docs/superpowers/plans/2026-04-02-test-layering-refactor.md
git commit -m "refactor: rebuild test layering"
```

---

## Notes for Execution

- 所有删除动作都必须先证明存在等价或更高层替代护栏。
- 不允许保留兼容性/过渡性旧测试；一旦确认新边界成立，旧测试直接删除。
- 若某 regression / chaos 文件仍包含独特业务价值，不整文件删除，而是迁移到更合适的边界层后再删除原 case。
- 改动测试与 mock/helper 时，遵守 `typescript-project-specifications`：不引入 `any`，不写临时注释，不保留无意义 helper 包装。
- 执行时优先使用多个子代理并行处理独立任务域，但必须在每个任务完成后做主会话复审与冲突检查。
- 执行前若用户要求在 worktree 中实施，应先切换到独立 worktree；否则保持当前工作区实施。
