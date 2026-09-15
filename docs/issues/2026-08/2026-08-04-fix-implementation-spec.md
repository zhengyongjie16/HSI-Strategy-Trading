# 订单监控 state-check 事故修复：证据门禁与修订实施规格

- **复核基线**：`develop@9a381658666264297d77609933b5219f89a16bed`
- **声明依赖**：`longbridge@4.4.3`
- **文档状态**：`EVIDENCE_GATED`
- **当前授权**：只允许补证据、建立 4.4.3 clean baseline 和编写修复前 RED；**当前不得直接修改生产代码**
- **分包原则**：G1 只阻断 P0-1；P0-3 通过自身门禁后先实施，P0-2 在 P0-3 监督边界就绪后实施
- **本文作用**：完整替换上一版规格，撤销其中“整体高置信度”“事故证据已核实”“`eventFlow.ts` 零影响”“两处 timer 条件即可消灭自循环”等结论

> 本文不是事故证据，也不授权把未证明的 `history.time` 当作 broker revision。每个生产工作包必须先按本文更新为 `READY_TO_IMPLEMENT`，不得把整篇文档一次性照抄实施。

---

## 0. 分工作包裁决

| 工作包 | 当前状态 | 进入生产实现的前置条件 |
| --- | --- | --- |
| G0：4.4.3 clean baseline | **BLOCKED** | disposable checkout 中 clean/frozen install；wrapper/native 均为 4.4.3；基线命令 fresh 通过 |
| G1：事故与厂商语义证据 | **BLOCKED** | 事故分析、wire/getter capture、timeline、hash、不可变厂商契约证据齐全 |
| G2-P0-3：监督边界 RED | **PENDING，blocked by G0** | 旧实现稳定复现非 Error、双 symbol、scheduler、并发 stop 等失败 |
| P0-3：runtime 监督 | **PENDING，blocked by G0 + G2-P0-3** | 第 5 节设计再次复核通过 |
| G2-P0-2：timer RED | **PENDING，blocked by G0** | bounded fake scheduler 在旧实现稳定检出自旋/错误 owner |
| P0-2：phase timer | **PENDING，blocked by P0-3 + G2-P0-2** | 第 4 节设计再次复核通过；不设“无 P0-3 的中间 GREEN” |
| P0-1：Filled 缺 revision | **PENDING，blocked by G1** | G1 后二选一：`CLOSED_NO_CHANGE`，或进入 G2-P0-1 + 再次设计复核 |

仅对进入编码的 P0 工作包适用：

```text
可复现 baseline -> 旧实现稳定 RED -> 最小实现 -> 定向 GREEN -> 集成 GREEN -> 全仓 GREEN
```

G0/G1 是证据工作包，不要求“RED -> 实现”。G1 不阻断 P0-3，也不阻断在 P0-3 之后实施 P0-2。

---

## 1. 已核实事实、术语与纠错

### 1.1 上位依据和事故 fixture 缺失

上一版引用的文件：

```text
docs/issues/2026-08/2026-08-04-order-monitor-state-check-incident-first-principles-analysis.md
```

在当前 tree、历史提交和全部可达 Git objects 中均不存在。tracked Git objects 中也没有可审计的事故 wire fixture：上一版使用的订单数量和毫秒时间仅来自该规格；相同价格数字在仓库另有无关文档用途。

本机 ignored SDK 日志存在数值相近的非合格线索，但它来自 history endpoint、没有 order-detail history，且其 `updated_at` 不是事故声称的缺失值；它既未入 Git，也不能替代事故证据。

因此撤销：

- “本次已证实形态”；
- “严格继承事故分析第 4/5/6 节”；
- “真实 Filled 样本”；
- “事故分析全文已检查”；
- “测试矩阵已全部覆盖”。

### 1.2 声明版本与实际加载版本不一致

当前仓库：

- `package.json`：`longbridge = 4.4.3`；
- `bun.lock`：wrapper 与平台 native packages 锁定 4.4.3；
- 当前 `node_modules/longbridge`：4.3.3；
- 当前 `node_modules/longbridge-win32-x64-msvc`：4.3.3。

本轮诊断：

- `bun type-check`：通过；
- `bun test tests/core/trader/orderMonitor/`：251 pass / 0 fail。

这些结果只描述错误安装版本下的现状，不能作为 4.4.3 验收。

### 1.3 已发布契约不足以证明 fallback

浮动的公共文档当前只说明：

- [`OrderDetail.updatedAt`](https://longbridge.github.io/openapi/nodejs/classes/OrderDetail.html#updatedat)：`Last updated time`；
- [`OrderDetail.history`](https://longbridge.github.io/openapi/nodejs/classes/OrderDetail.html#history)：`Order history details`；
- [`OrderHistoryDetail.time`](https://longbridge.github.io/openapi/nodejs/classes/OrderHistoryDetail.html#time)：`Occurrence time`。

这些 latest 链接只用于说明当前文案，**不是 G1 的不可变证据**。公共契约没有保证：

1. history occurrence 就是最终 Filled 状态转换对应的 revision；
2. occurrence 可无损替代缺失的 API `updatedAt`；
3. occurrence 与 API/WS `updatedAt` 具有相同单位、精度、相等值和冲突语义；
4. Filled history 唯一、完整、有序；
5. history quantity 是单笔量、累计量还是状态快照量；
6. 该语义对改单、多次成交和不同订单类型都成立。

“同一时钟、可以比较”仍不足以推出“可以替代同一 revision”。

### 1.4 P0-1 的影响面大于上一版声明

- `eventFlow.ts` 会读取 `queriedTerminalStateByOrderId` / `latestReplaceTerminalByOrderId`，并按 `status + orderUpdatedAtMs` 确认 cache；它不是零影响消费者。
- API terminal 与 WS terminal 可并发。较弱事实先结算可能使较强事实失去结算机会，或留下孤立 evidence。
- 只虚拟增加一个 required TERMINAL 字段，当前产生 **43 条 TypeScript 诊断，涉及 5 个文件**：
  - `orderStatusQuery.ts`：1；
  - `orderOps.business.test.ts`：7；
  - `recoveryFlow.business.test.ts`：2；
  - `routeProcessor.business.test.ts`：32；
  - `terminalSnapshotFacts.business.test.ts`：1。
- `{ equals() }` 不能证明值是 SDK `Decimal`；原生比较伪对象会抛 N-API 类型恢复错误。

撤销“只影响一个 fixture”“字段自动透传无害”和“`eventFlow.ts` 明确零改动”。

### 1.5 P0-2 是投影与消费不一致

当前 projector 独立投影 timeout、cancel、replace、quote；processor 按 phase/优先级每轮最多执行一个动作。只要 timer 已到而 processor 当前不能消费，成功 pass 后就可能按相同过去时间重挂。

确定性例子：

```text
602013 第一档 replace backoff = 1s
生产默认 priceUpdateInterval = 5s
REPLACE_RETRY 在 1s 到期
processor 因价格更新间隔未到而 no-op
projector 重挂相同过去时间 -> setTimeout(0)
```

WAIT_WS_ONLY、cancel backoff、跨 timeout 的 replace/quote、零/NaN remaining、closed/MO/converted 和多订单竞争都必须进入同一 policy。

### 1.6 P0-3 必须监督整个 order-monitor runtime fatal 域

上一版会：

- 把 `throw null` 当成无错误；
- 让 string/object/undefined 绕过 Error latch；
- 遗漏 reconcile、schedule/cancel、timer segment callback 异常；
- 只冻结失败 symbol；
- 重复上报 fatal；
- 并发 stop 重复 reset；
- STOPPING 期间允许 start；
- 依赖未被类型保证的“`onFatalError` 不抛错”。

已有“在途普通 Error + stop”测试在旧实现上也通过，不是 RED。

### 1.7 规范术语

- **现场 capture**：真实 4.4.3 wrapper/native 对真实 wire 响应的 getter 输出；静态 JSON 不能重新构造 N-API `OrderDetail`。
- **boundary replay double**：自动化测试根据 getter fixture 构造的 adapter 边界 double；必须使用真实 4.4.3 `Decimal`/`Date`，但不得称为 native 反序列化。
- **事故复现**：证明事故输入和旧行为，属于 G1 evidence；不等于修复验收 RED。
- **回归 RED**：针对拟议修复，在旧实现稳定失败、修复后通过，属于 G2。
- **owner tuple**：决定 timer 的业务 phase、orderId、kind、due 和必要 version/identity。
- **已发出 broker mutation**：已经进入 `permit.invoke(() => SDK mutation)`；只在 RateLimiter 队列中不算已发出。
- **primary error**：本运行代 first-observed 的归一化 Error；reporter 与 drain 必须使用同一对象。
- **secondary error**：primary 之后发生的 reporter/cleanup/并发错误，只进入结构化诊断，不替换 primary。

---

## 2. 强制门禁

### 2.1 G0：4.4.3 clean baseline

必须在 disposable checkout/container 中执行；安装前 `node_modules` 必须不存在，且不得使用 link、override 或 `NAPI_RS_NATIVE_LIBRARY_PATH`：

```text
bun install --frozen-lockfile
```

顺序固定：

1. 记录 OS、CPU、Bun、commit；
2. 在无 `node_modules` 的 disposable checkout frozen install；
3. 实际 import `longbridge`，执行 `Decimal` native smoke；
4. 记录 wrapper 入口、平台 native package 入口和最终 `.node` 路径；
5. 断言 wrapper/native 均严格为 4.4.3；
6. 在**未改实现**的 checkout 执行 baseline；
7. 证明 source、manifest、lockfile 未被安装/测试修改。

Windows x64 至少记录并断言：

```text
longbridge@4.4.3
longbridge-win32-x64-msvc@4.4.3
require.resolve('longbridge')
require.resolve('longbridge-win32-x64-msvc')
new Decimal('1').equals(new Decimal('1')) === true
```

baseline 至少包含：

```text
bun type-check
bun run lint
bunx prettier --check .
bun run build
bun test tests/core/trader/orderMonitor/
bun test tests/core/trader/orderMonitor/orderMonitor.business.test.ts tests/core/trader/orderMonitorRouteHooks.integration.test.ts tests/integration/orderMonitorDailyLossMonotonic.integration.test.ts
bun test
```

G0 未通过时停止所有生产实现与“4.4.3 已验证”表述。

### 2.2 G1：事故与厂商语义 evidence

G1 只收证据，不要求回归 RED。必须提交：

1. 缺失的事故分析文件；
2. 脱敏原始 `/v1/trade/order` wire JSON；
3. 同一响应经真实 4.4.3 wrapper/native 的现场 getter capture；
4. 请求、撤单/改单错误、orderDetail、WS、cache、结算的单调时间线；
5. fixture SHA-256、采集平台、wrapper/native 版本、脱敏规则；
6. 修复前事故复现及零副作用/错误传播观察；
7. 每项禁止范围的事故或系统不变量依据；
8. 不可变的 4.4.3 tag/commit 源码、归档厂商答复或带 hash 的版本化契约。

建议目录：

```text
tests/fixtures/longbridge/4.4.3/order-detail-filled-missing-updated-at/
  wire.sanitized.json
  sdk-getters.sanitized.json
  timeline.sanitized.json
  SHA256SUMS
```

现场 capture 与自动化 replay 必须分开：

- `sdk-getters.sanitized.json` 记录 native getter 事实；
- 自动化测试用 fixture builder 建 boundary replay double；
- builder 使用实际 4.4.3 `Decimal` 和 `Date`；
- 除非另建真实 native HTTP replay harness，不得声称测试 JSON 被 N-API 重新反序列化。

厂商证据必须明确回答：

- 对该 Filled 终态，history time 是否就是最终状态转换 revision，或可无损替代缺失 `updatedAt`；
- 与 API/WS `updatedAt` 的单位、精度和相等值语义；
- 秒级时间是否可能让不同 revisions 同值；
- history quantity 的语义；
- 改单、多次成交、不同订单类型下的适用范围；
- 这是服务端契约，而不只是 TypeScript 类型；
- `orderDetail` 单次请求的硬超时/取消语义；当前 `wrapExternalApiRequest` 只限制重试次数，不能为永不 settle 的 native request 提供上界。

#### G1 分支裁决

- 不能证明**可替代同一 revision**：P0-1 在 Longbridge 4.4.3、当前服务契约和本次修复范围内标记 `CLOSED_NO_CHANGE`，继续 fail-closed；未来新契约必须新开规格复核。
- 能证明可替代：进入 G2-P0-1、补第 3 节 RED 并再次复核；仍不得立即编码。

### 2.3 G2：回归 RED

G2 只适用于将进入生产实现的 P0：

- P0-3：必须先有非 Error、双 symbol、scheduler、reentrant/concurrent stop 等旧实现稳定 RED；
- P0-2：必须先有 bounded due-drain 检出的旧实现稳定 RED；实现验收依赖 P0-3；
- P0-1：仅 G1 进入 fallback 分支时需要成功路径与冲突路径 RED；`CLOSED_NO_CHANGE` 分支豁免实现 RED。

以下不算 RED：

- 旧实现已经通过的普通 Error stop 场景；
- 直接预置 terminal cache、绕过 adapter/orderOps 的“端到端”测试；
- fake timer 只执行一次 due 快照；
- 只检查 runtime `timerHandles` 而不检查 scheduler pending timer。

---

## 3. P0-1：条件化设计

### 3.1 `CLOSED_NO_CHANGE` 分支

若 G1 不能证明 revision 可替代性，保持当前语义：

- `detail.updatedAt` 无有效 raw revision 时，`orderUpdatedAtMs = null`；
- 累计成交推进且 revision 缺失时继续抛错；
- 不结算、不写 trade log、不推进 DailyLoss、不清 evidence；
- 不读取 history 作为 fallback；
- 不新增 `filledHistoryTimeMs`、`historyTimeMs` 或公共 occurrence helper；
- 不需要实现本节后续 API/WS 仲裁。

### 3.2 fallback 分支的严格 adapter 规则

只有 G1 明确证明 occurrence 可无损替代最终 Filled revision，才允许在 `orderStatusQuery` adapter 边界产出现有 canonical `orderUpdatedAtMs`。不得把来源字段传播给所有消费者；字段 JSDoc 必须改为“adapter 验证后的 canonical broker revision”，不能谎称总是 raw `updatedAt`。

入口必须是 fixture 证明的**精确 sentinel**。当前预期仅允许：

```text
detail.updatedAt === null
```

`undefined`、错误类型、非法 Date、`Date(0)`、负值或 getter 抛错一律 fail-closed，且不得启动 history fallback。

history 规则：

1. `closedReason === 'FILLED'`；
2. `history` 可完整读取为数组；
3. 数组中恰好一条 Filled row，且该 row 完全匹配；存在第二条 Filled（即使数量不同）即拒绝；
4. 任一条目的 status/getter 无法安全读取，整个 fallback 拒绝，不能只跳过疑似冲突 sibling；
5. Filled row time 是正有限 `Date`；
6. 顶层 submitted quantity、顶层 cumulative executed quantity、history quantity 均为正值 SDK `Decimal`，三者数值相等；
7. 顶层 executed price 与 history price 均为正值 SDK `Decimal`，二者数值相等；
8. 任一 native 调用/比较异常使整个 fallback 返回 null；
9. helper 保持 `orderStatusQuery.ts` 模块私有。

安全 Decimal 边界示意：

```ts
function sdkDecimalEquals(left: unknown, right: unknown): boolean {
  if (!(left instanceof Decimal) || !(right instanceof Decimal)) return false;
  try {
    return Decimal.prototype.equals.call(left, right);
  } catch {
    return false;
  }
}
```

仍须在 G0 的真实 4.4.3 实例上定稿；`Object.create(Decimal.prototype)` 虽可能通过 `instanceof`，native call 必须被 catch 并判不匹配。

### 3.3 API 查询在途与 WS 的唯一仲裁机制

fallback 分支必须实现 **per-order in-flight arbitration token**；不得用“WS 先结算、晚到 API 再丢 cache”的事后策略：

1. 决定启动 state-check 后、在 throttle/orderDetail 等任何 `await` 之前，同步登记 `{orderId, token, trackedIdentity, generation}`；
2. token 存在时，WS 以及其他 terminal settlement gateway 都不得做经济结算；WS terminal 保存为该 token 的 pending evidence，其他 gateway 必须 join/交给同一仲裁入口；
3. orderDetail 成功/失败后，由一个仲裁入口原子读取 API 结果、pending WS、tracked identity 和 generation；
4. API 查询失败时，释放 token，并把 pending WS 交回正常路径；
5. API/WS 同时存在时，按 G1 的 canonical revision/precision 规则双向比较，不能按 arrival order；
6. OPEN/TERMINAL 竞争只允许“revision 不早于 OPEN 的 TERMINAL”胜出；TERMINAL 之后出现同 revision或更新 revision 的 OPEN 是生命周期冲突并 fatal；
7. 不同 terminal reason（例如 Filled 与 Canceled/Rejected）视为不可证明冲突，必须在任何结算前 fatal；
8. 同 revision 下累计量不得回退，数量/价格冲突 fatal；
9. API 弱/WS 强和 API 强/WS 弱使用同一对称规则；
10. 只结算被选中的同一 evidence，随后按 identity ack 两个 cache/buffer；
11. stale token、已失效 generation、已替换 tracked identity 或 stop/fatal 后返回的查询不得写 cache；
12. `finally` 必须释放 token；不得新增 poller；若 G1 不能证明 native request 的硬完成上界或安全取消语义，则 fallback 分支不获批准，不能靠有限 retry 次数假定请求有界；
13. token 期间再次 state-check 必须 join/拒绝，不能建立两个 owner；
14. 任何仲裁不变量冲突必须经 P0-3 的统一 `reportFatal` 进入同一 runtime latch，不能只向某个公开调用者抛错后让 runtime 继续。

若该 token 会阻塞当前保护性 durable-first 语义，必须在 RED 中暴露并重新审查；不得静默把 WS 部分事实丢失。

### 3.4 P0-1 fallback 验收（仅条件分支）

必须覆盖：

1. 现场 getter fixture + boundary replay builder，驱动 `orderDetail double -> orderStatusQuery -> orderOps -> settlement`；禁止直接预置 cache；
2. raw `updatedAt` 正常时完全忽略 history；只有 `null` sentinel 可进入 fallback；
3. `Date(0)`、非法 Date、错误类型、getter 抛错不得进入 fallback；
4. history 缺失、空、多条 Filled、有效 Filled + 不匹配 Filled、有效 Filled + 抛错 sibling 全部拒绝；
5. `Filled 40/100` 拒绝；
6. number、string、鸭子对象、prototype fake、native 比较抛错全部拒绝；
7. API 强/WS 弱、WS 强/API 弱、API 查询在途/WS 先到两个排列；
8. terminal reason、same-revision quantity/price、precision collision 冲突；
9. 恰好一次结算，且 cache/buffer/tracked lifecycle 无孤儿；
10. trade log、DailyLoss、refresh、event、cache clear 必须在真正装配这些依赖的集成层可观察；
11. 所有失败变体零经济副作用、零 evidence 误删。

现有 routeProcessor harness 的 DailyLoss、refresh、event 多为 no-op，且没有 `cacheManager`；不得用它证明全链路。

---

## 4. P0-2：per-order policy + single route timer

> P0-2 的“不收敛即 fatal”依赖 P0-3。可以先写 RED，但生产实现和 GREEN 验收必须在 P0-3 完成后进行。

### 4.1 两级投影算法

第一层纯函数为每笔订单解析 phase，并返回至多一个 candidate。第二层为整个 symbol route 只注册一个 next timer：

1. 若存在 `due <= now` candidates：
   - timeout/cancel candidates 优先于 replace/quote；
   - 同类按 processor 的 `submittedAt -> orderId` 顺序；
2. 若没有已到期 candidate：选择最早 future due；同时间用相同优先级；
3. timer 回调只触发一次 generic TIMER pass；成功后重新计算下一 owner；
4. 当前选中 owner 若被并发到达的更高优先级 terminal/timeout owner抢先处理，允许再次成为 next candidate，但必须证明另一 owner 已发生有限进展；
5. TIMER pass 若没有任何 owner tuple/订单 identity/lifecycle 进展，必须 fatal；
6. 连续 immediate passes 的上界由本轮实际变化的 owner 数限定，测试以 `maxSteps` 检出自旋。

projector 与 processor 必须复用同一纯 eligibility/priority policy，禁止复制条件。

### 4.2 per-order phase 表

按以下顺序裁决：

| phase | candidate | 规则 |
| --- | --- | --- |
| terminal snapshot 已就绪 | 无 mutation timer | 写 snapshot 必须 edge-trigger route；解析、remaining 或 settlement 失败一律 fatal，不再借用 cancel backoff |
| WAIT_WS_ONLY / cancel 已确认但无 terminal snapshot | 无 | 只等 WS；清 timeout/cancel/replace/quote owner |
| remaining 非有限或 `<0` | 无 | tracked quantity 已损坏，直接 fatal，不得静默停表 |
| ordinary closed、MO、converted，或 remaining `===0` | 无 mutation timer | 若仍携带 cancel/replace/quote owner，说明迁移未原子清理，fatal |
| cancel backoff | `CANCEL_RETRY` | 仅 timeout 启用、timeout 已到且订单可处理时成立；count>0；due=`max(timeoutAt,nextCancelAttemptAt)`；其他组合 fatal |
| timeout 已到、无 cancel backoff | `BUY_TIMEOUT` / `SELL_TIMEOUT` | due=`max(timeoutAt,nextCancelAttemptAt)`；nextCancel 必须为可解释有限值；禁止 replace/quote |
| timeout 未到 | 真实可执行且严格早于 timeout 的 replace/quote；否则 timeout | due 与 timeout 相等时 timeout 优先 |
| timeout 禁用 | 一个真实可执行 replace/quote，或无 | count>0 属不一致并 fatal；禁止凭过去时间制造空 wakeup |

所有 candidate 的 due 必须是正有限值；无效 timeout/retry 时间直接 fatal。WS 将 remaining 推到 0、关闭订单或切换 WAIT_WS 时，必须在同一同步状态提交中清除不再合法的 owner tuple，然后才 edge-trigger projector。

### 4.3 effective due 与 replace handoff

replace due：

```text
max(replaceBlockedUntilAt, lastPriceUpdateAt + priceUpdateIntervalMs)
```

只有以下条件都成立才可成为 candidate：

- `replaceCapability === 'TEMP_BLOCKED_BY_STATUS'`；
- `replaceResumeMode === 'TIME_BACKOFF'`；
- 尚未进入 cancel/timeout/WAIT_WS；
- remaining 正有限；
- cached quote 通过与 processor 相同的 readiness/price-diff guard；
- timeout 启用时 due 严格早于 timeout。

REPLACE_RETRY due 时：

- quote ready 且仍需改价：尝试 mutation；结果必须清 owner、推进 future owner、WAIT_WS 或 fatal；
- price diff 已消失：清除 expired replace block，回到 SUPPORTED；
- quote 缺失：**原子清除 expired replace block并初始化 future QUOTE_RETRY**；不能留下过去 replace owner；
- quote 无效但非 missing：清 replace owner并等待新 QUOTE/timeout，不做 hidden retry。

### 4.4 quote retry 真值表

`quoteRetryNextAt + quoteRetryAttempts` 是 owner 真值；`quoteRetryExhausted` 成为受校验的派生状态：

| 状态      | 合法组合                                                 |
| --------- | -------------------------------------------------------- |
| IDLE      | `attempts=0, nextAt=null, exhausted=false`               |
| SCHEDULED | `1 <= attempts <= MAX, nextAt=正有限值, exhausted=false` |
| EXHAUSTED | `attempts > MAX, nextAt=null, exhausted=true`            |

其他组合 fatal。现有“`exhausted=true` 但 `nextAt` 非空仍投影”的测试必须改为不变量失败测试。

quote due 至少为：

```text
max(quoteRetryNextAt, lastPriceUpdateAt + priceUpdateIntervalMs)
```

每次 due 后必须按 readiness 明确迁移：MISSING 推进 future nextAt 或进入 EXHAUSTED；READY 被消费并 reset；INVALID 清 scheduled owner、回到 IDLE，只等待新的真实 QUOTE 或 timeout；内部状态不满足真值表时 fatal。EXHAUSTED 无 timer，只等待真实 QUOTE 或 timeout。

### 4.5 terminal settlement 裁决

本工作包选择明确的 fail-fast 方案，不新增 `SETTLEMENT_RETRY` timer：

- snapshot 无法规范化；
- queried remaining 不明确；
- `settleOrder(...).handled === false`；
- closed/no-remaining 但本地生命周期未收口；

以上全部 fatal。当前借用 `applyCancelRetryBackoff` 的 terminal settlement 分支必须删除/改写；现有期待该隐式 retry 的测试必须改成 fatal 断言。未来若要 retry，必须新开规格定义独立 owner、due、上限和幂等，不得借 `CANCEL_RETRY` 名义实现。

### 4.6 owner notification 必须 edge-trigger

只在 owner tuple **实际变化**时通知：

- route pass 内写入：不自行 trigger dirty；由本 pass 成功结束后的 reconcile 消费；
- route pass 外写入：订单仍 identity-attached、runtime ACTIVE 时，状态完整提交后触发一次 notification request；
- stale continuation、STOPPED/BOOTSTRAPPING/FAILED/STOPPING 不产生有效 wake；
- 幂等 reset/重复赋相同值不通知。

必须覆盖的 pass 外迁移：

- track 新订单；
- 外部 `replaceOrderPriceWithPermit` 写/清 602013 owner；
- 公共 cancel confirmed 写 WAIT_WS_ONLY；
- WS 原子清 cancel/replace/quote owner；
- terminal snapshot 写入。

测试中的“恰好一次”指同一 owner tuple 迁移产生一次 notification request，不排斥并发 WS 等独立合法 wakeup。

### 4.7 P0-2 RED / 验收

fake scheduler 必须提供 `drainDueTimers(maxSteps)`：循环执行全部 `atMs <= now` callback，每次后排空 microtasks；超限报 `timer spin`。同时检查 route handle 与 scheduler pending timer。

至少覆盖：

1. 新单只有 future timeout，无 `CANCEL_RETRY@now`；
2. cancel backoff 残留 timeout/replace/quote 时只选 `CANCEL_RETRY`；
3. count>0 但 timeout 未到、禁用、closed/MO/remaining=0 时 fatal；
4. 1s replace backoff + 5s price interval：1s 不触发，5s 恰好推进；
5. replace/quote 跨 timeout：timeout 接管；
6. WAIT_WS_ONLY 四类 timer 全无；
7. remaining=0、ordinary closed、MO、converted 无 timer且 owner 已原子清理；remaining 为负/NaN 时 fatal；
8. terminal snapshot + remaining=0 由事件结算一次；失败立即 fatal；
9. due replace 的 missing/invalid/no-diff 三种最终 owner tuple；
10. quote truth table 全组合及 exhaustion；
11. 外部 replace、公共 cancel 的 edge notification；
12. 两笔以上 overdue 订单按 route priority 逐笔有限收敛；
13. selected owner 被并发高优先级 terminal 抢占后仍有限收敛；
14. 无进展 TIMER pass 由 P0-3 fatal，不再重挂；
15. 连续 drain 后 wakeup/pending timer 稳定。

---

## 5. P0-3：统一 fatal 域、permit preflight 与可重入 drain

### 5.1 生命周期

routeRuntime 私有生命周期：

```text
STOPPED -> ACTIVE -> STOPPING -> STOPPED       (clean stop)
                 \-> FAILED -> STOPPING -> TERMINATED  (fatal)
```

- ACTIVE 时 `start()` 幂等；只有 STOPPED 可开始新运行代；
- FAILED/STOPPING/TERMINATED 时 start fail-fast；
- fatal 实例 drain 后为 TERMINATED，**不得原实例 restart**；生产恢复必须由上层重建 order monitor/runtime；
- 只有 clean stop 后允许 restart；
- STOPPED 下 stop 是不 reset、不推进 generation 的成功 no-op。

这与上层永久 fatal latch 一致；若未来要复用 fatal 实例，必须把上层 fatal reset/recreate 协议另开规格。

### 5.2 统一 reportFatal 与 first-observed 规则

`RouteRuntime` 增加统一 `reportFatal(cause, stage)`；以下内部 fatal 都走它：

- route process/reconcile/scheduler；
- timer callback/segment；
- `orderMonitor/index.ts` WS eventFlow callback 捕获的内部异常；
- start subscribe/bootstrap 异常；
- stop/unsubscribe/timer cleanup 异常。

公开 API 调用直接返回给调用者的业务错误不自动属于 runtime fatal；一旦代码把它定义为内部不变量错误，就必须走统一入口。

规则：

1. 任意 cause 立即经 `toError` 归一化；
2. first-observed Error 成为 primary；
3. primary 先锁存，再同步 quiesce；
4. `onFatalError(primary)` 每运行代恰好一次；
5. reporter/cleanup/后续 route 错误进入 `secondaryErrors`，不替换 primary；
6. 每个 secondary 通过唯一结构化出口记录：

```text
logger.error('[订单监控] route runtime secondary failure', {
  stage,
  primaryMessage,
  secondaryMessage
})
```

测试 mock 此 logger 并断言 stage/count。不得用 AggregateError 替换 drain/reporter 使用的 primary 对象。

### 5.3 幂等 quiesceRunOnce

ACTIVE->FAILED 和 ACTIVE->STOPPING 共用同一 `quiesceRunOnce` owner：

- `runtime.running=false`；
- 取消 quote subscription；
- 每个 route generation 仅失效一次；
- best-effort 清全部 timer、dirty、pending wakeup；
- 清理所有 route，即使某个 cancel 抛错也继续；
- primary 已存在时 cleanup 错误记 secondary；clean stop 中第一个 cleanup 错误成为 primary；
- FAILED->STOPPING 不重复失效 generation；
- normal stop/fatal 造成的 stale generation 是 fulfilled cancellation，不是新 fatal。

start 的 subscribe/bootstrap 若抛错：锁存 primary、进入 FAILED、完成 quiesce，并同步抛同一 primary；不能回滚成看似健康的 STOPPED。

### 5.4 supervisor 必须先发布 placeholder，再执行 route body

不得“先调用 `runRoute()`，后 add，再用外层 catch latch”。必须：

1. 创建 deferred supervised task；
2. **先**把其 promise 加入 `activeRoutePromises` 并注册双分支删除；
3. 再执行包住 `processRoute + lifecycle/generation 复核 + reconcile` 的 async body；
4. 同一个 async continuation 的 `catch` 内同步调用 `reportFatal`，然后以 primary reject deferred；不得再隔一个 `.catch()` 微任务；
5. 成功时 resolve deferred。

这样同步 throw、`onFatalError -> stopAndDrain` 重入和相邻 symbol 微任务都能观察当前 supervised task，且 A 的 failure continuation 在让出控制前已 poison runtime。

route body 结束规则：

- ACTIVE + 同 generation + 全成功：reconcile、复位 inFlight、按 dirty collapse 补跑；
- stop/fatal 导致 stale：清本 route pending 状态并 fulfilled cancellation；
- 任一真实异常：不 reconcile、不 rerun，交给同 continuation catch。

### 5.5 scheduler 全覆盖

监督范围包含：

- `processRoute`；
- 成功路径 reconcile；
- timer cancel/首次 schedule；
- 超长 timer 递归 segment；
- callback 内 `now()`、`scheduleTimer()`、`onDue`。

routeRuntime 必须给 scheduler callback 统一 try/catch wrapper；active promise 外的 timer 异常直接 `reportFatal`。

### 5.6 fatal 后禁止排队 mutation 获得 permit

只允许已经进入 `permit.invoke` 的 broker 请求安全收口。仅在 RateLimiter 队列中、尚未调用 SDK 的动作必须被撤销。

为 route-owned cancel/replace/timeout follow-up submit 引入 execution token，并在**每次 permit 内、`permit.invoke` 之前**复核：

- runtime lifecycle 仍 ACTIVE；
- `runtime.running`；
- route generation/token；
- order 仍 identity-attached；
- mutation authorization。

buy timeout、sell timeout、route replace、timeout follow-up submit 都必须传该 preflight；不能只在排队前检查。最终复核与 `permit.invoke` 必须位于同一 callback 且中间无 `await`。fatal/stop 后 permit 才释放时返回 `CANCEL_NOT_STARTED`/`NOT_EXECUTED`/`PRECHECK_SKIPPED`，broker 调用数必须为 0。

已经进入 `permit.invoke` 的请求不强制取消；其 promise 继续 drain，并只执行现有“远端事实已发生”所需的安全收口。不得由此启动新的 follow-up mutation。

因此 P0-3 影响面必须包含 `routeProcessor.ts`、`orderOps.ts` 和相关 types。

### 5.7 可重入 single-flight stopAndDrain

不能直接 `drainPromise = drainOnce()` 后才发布 owner，因为 `drainOnce` 会在首个 await 前执行外部 callback。必须先发布 deferred：

```text
if 已有 drain owner -> 返回其 promise
if STOPPED -> 返回 clean resolved promise
创建 deferred
同步保存 drain owner/deferred promise
切换 STOPPING
随后异步执行 quiesce + drain
```

要求：

- unsubscribe/clearTimer/onFatalError 重入 stop 时看到已发布 owner；
- 并发 stop 在 routeRuntime 和公开 `OrderMonitor.stopRuntimeAndDrain` 层都返回同一 promise；外层不得用 `async` 再包装，应直接返回 routeRuntime promise；
- STOPPING 后不新增 supervised task；
- 等待已发布的全部 supervised promises；
- 每 route 只 reset 一次；generation invalidation 幂等；
- 无 primary：进入 STOPPED并成功；
- 有 primary：进入 TERMINATED，所有并发/后续 stop 返回同一个 rejected drain promise 和同一 Error；
- clean stop 完成后才清 drain owner，顺序上的第二次 stop为 no-op success。

### 5.8 P0-3 RED / 验收

至少覆盖：

1. `throw null/undefined/string/object/Error`；
2. catch 同 continuation poison：相邻 symbol continuation 不得在 failure 后启动 mutation；
3. 两 symbol 同时失败只登记 first-observed primary；
4. route B 已排队 permit、A fatal、随后释放 permit：B broker 调用为 0；
5. 已进入 `permit.invoke` 的请求可以完成安全收口，但不启动 follow-up；
6. schedule/clear/reconcile/segment callback 异常统一 fatal；
7. process primary 后 cleanup/reporter 异常只进结构化 secondary logger；
8. clean stop 首个 cleanup 错误成为 primary并继续 drain；
9. supervisor placeholder 已在 set 时，同步 process throw或 reporter 重入 stop；
10. promise 在途、fatal 已登记、promise 已删三个 stop 时点结果一致；
11. 普通并发 stop及 unsubscribe/clearTimer 内重入 stop返回同一 promise；
12. generation/reset 只执行一次；STOPPED stop不推进；
13. ACTIVE start幂等，STOPPING/FAILED/TERMINATED start失败；
14. clean stop后可 restart；fatal drain后必须由上层重建；
15. start subscribe/bootstrap 抛错进入 FAILED；stop cleanup继续完成；
16. WS eventFlow 内部异常也只通过同一 fatal latch 上报一次；
17. fatal/stop 后无 schedule/reconcile/dirty rerun。

---

## 6. 影响面与禁止“零改动”预判

上一版零改动清单作废。当前预期：

| 工作包 | 必须审计的生产文件 |
| --- | --- |
| P0-1 fallback（条件分支） | `orderStatusQuery.ts`、`orderFactMerge.ts`、`orderOps.ts`、`eventFlow.ts`、`routeProcessor.ts`、`index.ts`、相关 types/cache/settlement ack |
| P0-2 | `routeRuntime.ts`、`routeProcessor.ts`、`orderOps.ts`、`eventFlow.ts`、`index.ts`、`routingIndex.ts`、相关 types |
| P0-3 | `routeRuntime.ts`、`routeProcessor.ts`、`orderOps.ts`、`eventFlow.ts`、`index.ts`、`routingIndex.ts`、timer callback 装配、相关 types |

规则：

- 可抽取目录私有共享 policy；
- 不因追求少改文件而跳过真实消费者；
- 不顺手重写 settlementFlow、WS reconnect、恢复或交易日重建；RED 若证明必须修改，先更新规格；
- 正常 fixture 不得用 `as unknown` 隐藏 required 字段；只有明确的运行时损坏测试可用 `Reflect.set`。

---

## 7. 实施顺序

### A. G0（所有生产包共同前置）

1. disposable clean checkout；
2. frozen install 4.4.3；
3. wrapper/native/path/Decimal smoke；
4. 未改实现 baseline；
5. 保存 fresh 输出和 clean status。

### B. 可并行的证据/RED

- G1：在 G0 环境采集 native getter、补事故分析与不可变厂商证据；
- G2-P0-3：写监督边界 RED；
- G2-P0-2：先升级 bounded scheduler，再写 timer RED。

G1 不阻塞 P0-3。P0-2 RED 可先写，但其实现等待 P0-3。

### C. 生产实现

1. 再次复核 P0-3 -> 标记 READY -> 实现并 GREEN；
2. 再次复核 P0-2 -> 标记 READY -> 实现并 GREEN；
3. G1 裁决 P0-1：
   - 无证明：标记 `CLOSED_NO_CHANGE`；
   - 有证明：写 G2-P0-1、再次复核，再实现。

### D. 集成与全仓验证

各包定向 GREEN 后，执行第 8 节全部验证。任何失败阻断对应包完成。

---

## 8. 验证命令与证据

### 8.1 G0/最终共同命令

```text
bun type-check
bun run lint
bunx prettier --check .
bun run build
bun test tests/core/trader/orderMonitor/
bun test tests/core/trader/orderMonitor/orderMonitor.business.test.ts tests/core/trader/orderMonitorRouteHooks.integration.test.ts tests/integration/orderMonitorDailyLossMonotonic.integration.test.ts
bun test
git diff --check
git diff --name-only
git status --short --untracked-files=all
```

`bun run format` 会写文件，不是 baseline/最终只读检查。实现过程中可对 allowlist 内文件执行 formatter，最终使用 `prettier --check`。

### 8.2 额外证据命令/检查

Windows x64 的版本/path/smoke 至少执行等价于：

```text
bun -e "const w=require('./node_modules/longbridge/package.json');const n=require('./node_modules/longbridge-win32-x64-msvc/package.json');const {Decimal}=require('longbridge');const x={wrapper:w.version,native:n.version,wrapperEntry:require.resolve('longbridge'),nativeEntry:require.resolve('longbridge-win32-x64-msvc'),decimalSmoke:new Decimal('1').equals(new Decimal('1'))};console.log(x);if(x.wrapper!=='4.4.3'||x.native!=='4.4.3'||!x.decimalSmoke)process.exit(1)"
sha256sum -c tests/fixtures/longbridge/4.4.3/order-detail-filled-missing-updated-at/SHA256SUMS
```

其他平台替换为实际 native package；`nativeEntry` 必须解析到实际加载入口/`.node`，不能只打印 optionalDependencies 声明。没有 `sha256sum` 时使用输出等价且失败码非零的 Bun hash 校验脚本。

报告还必须包含：

- wrapper/native package.json 实际版本；
- `require.resolve('longbridge')` 与平台 native package；
- 实际加载 `.node` 路径和 Decimal smoke；
- `SHA256SUMS` 校验结果；
- `git diff --name-only` 与工作包 allowlist 对比；
- `git diff -- package.json bun.lock` 为空（除非依赖修复本身经批准）；
- 对正式 evidence 目录执行 targeted ignored 检查，例如：

```text
git status --short --ignored -- docs/issues/2026-08 tests/fixtures/longbridge/4.4.3
```

- commit SHA、每条命令 exit code、focused/integration/full-repo 测试数。

`git status --short` 默认不显示 ignored，不能单独证明 evidence 已纳入版本控制。focused suite 不能称为“全量验证”。

---

## 9. 明确禁止项

1. 禁止用 `Date.now()`、submitted/tracked 时间、0、进程时间补 broker 事实；
2. 禁止 `history.at(-1)`、最大时间、数组顺序、任意状态或不匹配 history；
3. 禁止在未证明“可替代同一 revision”前把 occurrence 写成 revision；
4. 禁止为 OPEN、PartialFilled、Canceled、Rejected 扩展 history 推断；
5. 禁止用 history 回填价格或数量；
6. 禁止 Decimal 鸭子类型和未捕获 native 比较；
7. 禁止引入来源字段绕过 G1 并扩大消费者面；
8. 禁止未知即删除 terminal evidence；
9. 禁止周期轮询、隐藏 retry、无限补偿、静默 rollback；
10. 禁止借 `CANCEL_RETRY` 隐藏 settlement retry；
11. 禁止无进展后重挂相同过去 timer；
12. 禁止以合法 rejection 值作为无错误 sentinel；
13. fatal 后不得启动新的 order-monitor route-owned broker mutation；已进入 `permit.invoke` 的请求只允许按第 5.6 节安全收口；外部公开 mutation 仍必须服从其上层 fatal/gate 契约；
14. 禁止只冻结单 symbol 而让新 route 继续；
15. 禁止 STOPPING 期间 restart 或并发 stop 各自 reset；
16. 禁止 reporter/cleanup 覆盖 primary；
17. 禁止原实例从 TERMINATED restart；
18. 禁止直接预置 cache 的单元测试冒充 adapter 端到端；
19. 禁止把 boundary replay double 称为 native 反序列化；
20. 禁止用旧实现已通过的场景冒充 RED；
21. 禁止依赖仍为 4.3.3 时声称 4.4.3 已验证；
22. 禁止把 focused 结果表述为全仓通过。

---

## 10. 分包完成定义

### G0 完成

- disposable clean install；
- wrapper/native/path/smoke 全为 4.4.3；
- 未改实现 baseline fresh；
- source/lock/status 可审计。

### P0-3 完成

- G2-P0-3 旧红新绿；
- 统一 fatal 域、permit preflight、placeholder supervisor、reentrant drain 全部满足；
- clean stop 可 restart，fatal 实例 TERMINATED；
- focused/integration/full-repo/type/lint/format-check/build 全绿。

### P0-2 完成

- P0-3 已完成；
- G2-P0-2 旧红新绿；
- single route timer 在 bounded drain 中有限收敛，无 starvation；
- terminal settlement 失败不再隐式 retry；
- focused/integration/full-repo/type/lint/format-check/build 全绿。

### P0-1 完成

二选一：

- `CLOSED_NO_CHANGE`：G1 不能证明可替代，记录裁决并保持 fail-closed；无需 fallback RED、API/WS token 或生产改动；
- fallback：G1 证明精确替代语义，G2-P0-1 旧红新绿，in-flight token 双向仲裁无弱事实先结算/孤立 evidence，全部验证全绿。

### 整体事故工作关闭

- G0 完成；
- P0-3、P0-2 完成；
- P0-1 已进入上述任一完成分支；
- 事故分析、capture、timeline、hash 和 fresh 验证报告均已提交；
- 工作区只包含审核通过的 allowlist 变更。

在相应工作包满足门禁前，正确动作仍是补证据、写稳定 RED 和重新复核，而不是直接放宽 raw-fact gate。
