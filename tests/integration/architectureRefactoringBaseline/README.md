# P0.2 历史观测与 P1 snapshot 回归

`snapshotWriterInterleaving.test.ts` 已将三个历史 writer 探针替换为真实 `AccountPositionSnapshot` owner 的无条件目标断言：paired 失败不半提交、午夜取消旧 seat 请求且迟到结果不回填、已发 settlement 与 pending seat 串行执行且过期 paired 结果不提交。输入使用内部中性账户/持仓事实，金融字段为十进制文本，不构造 SDK fixture。运行：`bun test tests/integration/architectureRefactoringBaseline`。以下静态/protective 内容仍是历史观测，不代表 P1 已完成 P3F 验收。

## 静态/protective 历史观测（非目标）

已删除 `staticProtectiveIsolation.test.ts`：该新增业务 consumer 经 broker/helper 构造 SDK fixtures，不符合 P0 起的测试边界。删除不是缺陷修复或隔离目标验收；不搬目录、不包装 fixtures、不放宽白名单。

既有离线运行证据保留在仓库外：

- `C:/WINDOWS/TEMP/hsi-p0-p02-probes/behavior-check.log`：包含原始命令、退出码、283 pass / 0 fail（15 files），以及删除前四个静态场景的诊断；仅代表当时运行结果，不能视为当前仓库的可执行测试数量。

精确观测输入：时钟 `2026-07-10T02:00:00.000Z`；原 `BULL.HK` protective ELO 委托总量 1500，初始累计成交 0 或 500；分别以运行中追踪和恢复追踪执行，共四种组合。静态新增需求 1000，静态 cache total/available 均为 1000；broker mock total/available 均为 2500。500 场景先投递旧单累计 500、价格 1、时间 `nowMs+1`；静态执行后向同一旧 orderId 投递累计 2500、价格 1、时间 `nowMs+2`。

四种组合均观察到：broker `replaceOrder` 一次，未建立新 tracking identity；旧 protective orderId 的 durable cumulative quantity 达到 2500，episode 最后执行时间推进为 `nowMs+2`。这是可达的跨目的污染证据，**不是正确目标**；该观测没有证明可信终态隔离、非空关联买单、撤单窗口增量或完整 settlement completion。

**P3F deadline：**静态 owner 与共享执行最小闭合切面必须在中性 fact/port 收口后，由新的独占 worker 重建 §13.4.1 全链路验收，同步接通所需 P4.1/P4.2/P4.3 最小切片；不能仅迁入口后推迟修正。目标是跨 protective 扩量 REPLACE 为零，可信撤单终态和本地结算后重读可卖量，按原数量策略提交非 protective 新身份；静态成交不推进 protective progress/episode，旧真实 episode 的合法最终完成仍由唯一 settlement owner 判定并按既有提交顺序完成。

## 既有基线引用

- `tests/application/staticLiquidation/staticLiquidationExecutor.business.test.ts`：静态入口、门禁和本地清理；其 executeSignals 替身不代表隔离全链路。
- `tests/application/orderExecution/orderExecutor.protectiveLiquidation.business.test.ts`：保护性目的与执行授权。
- `tests/integration/protectiveLiquidation.integration.test.ts`：真实 tracking 成交 progress 与刷新需求。
- `tests/app/runtime/createPostTradeConsistencyRuntime.test.ts`：completion 持久化、daily boundary/cooldown/episode 顺序及失败禁止提交。
- `tests/runtime/asyncProgram/monitorTaskProcessor/business.test.ts`：activation preflight、席位失效及完成状态。
- `tests/runtime/lifecycle/cacheDomains/signalRuntimeTermination.test.ts`、`tests/integration/postTradeDrainLifecycle.integration.test.ts`：具名 stop/drain 顺序。

以上基线引用不豁免任何新增业务测试的 SDK fixture 边界。completedBoundary 前/等于 boundary 的同量高 revision 保持已确认旧规则；不新增渠道策略；flat 依据权威 total，不用 available cache 替代。
