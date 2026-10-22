# 订单驱动启动恢复回归修复方案

> **文档状态：设计与原批次实施历史记录；F03 本轮修复、全链路二审及独立复验已完成；未实盘验证**
>
> **F03 最终全仓离线总览（最新）**：**320 files／3420 tests：3418 pass／2 fail，22767 assertions，330.48s**；两项失败均在干净基线中重现，非 F03 新增，**不能称全仓全绿**，详见 §14.2。普通同量终态沿用 known 价额、正量终态缺价映射 `null` 的旧前提已撤销；`Filled + Q=0` 也已由 mapper／domain 两处 guard 首次拒绝。Monitor 公共 operation 与 seatActivation 的 fatal 时序问题已最小修复，原两位 reviewer 独立复验全部关闭。规则见 §5.1、§6.1–§6.3、§13.1；完整证据及未覆盖边界见[审计 F03 本轮补记](./architecture-refactoring-full-chain-audit.md#f03-implementation-verification)。本轮仅 F03，不代表 F05 或全报告已修。
>
> - 以下原批次记录供维护与回溯使用，**不是当前全仓验证结论**，以后续明确确认／复审结论为准。
> - 原批次结果（详见 §10、§13.4）：A reviewer 同轮 **APPROVE 且原 P1 关闭**（195 pass / 11 files + 真实链路 / terminal / crossday probes）；B 优化 **APPROVE**（75 pass / 9 files + 9 probes）；此前的 final-review-financial 同轮 APPROVE（A/B/C 全闭）、final-review-boundaries APPROVE W4 两项、W2 原三项关闭均保留为历史记录。
> - 原批次统一全量：**3288 pass / 0 fail / 317 files**（套件 4 项 build pass），取代当时的 3284 快照；不替代本轮 F03 最终全仓结果。
> - 原批次验收时未实盘验证、未提交，HEAD 为 `d2aa59054abac546f506b27df45f161afcfc6578`；这些均为历史快照，不作为当前代码状态。
> - 原批次的“已修／已关闭”指当时工作区状态；代码／文件统计不作为永久实时值。
> - 原批次文档更新仅涉及本文件与 `tests/integration/architectureRefactoringRecovery/README.md`，当时未改业务或测试代码、未重跑测试／构建／lint、未读 `.env`、未启动应用或实盘、未 commit；本轮文档收尾范围见 §16.4。

| 项目 | 值 |
| --- | --- |
| 仓库 | `D:/Code/HSI-Strategy-Trading` |
| 当前分支 | `beta-V2` |
| F03 本轮基线 HEAD | `353b621f46120dc20bf7aec57949c3f73234a83f` |
| 对照分支 | `develop` @ `6e239c8a128372bd9b2fb2d79464346792a5e81e`（前置远端验证时为最新；本文不声称此刻仍为最新） |
| 回归引入点 | `4a148b3`，其直接父为 `develop` |
| 原批次工作区快照 | 178 项（152 M / 10 D / 16 untracked），当时未提交；**非当前实时值** |
| F03 验收状态 | 本轮修复与两位 reviewer 独立复验关闭；全仓有两项既有失败，检查通过，详见 §14.2；**未实盘** |
| 目标业务语义 | 回到旧 `develop` 的**订单驱动（order-driven）**语义 |

---

## 1. 摘要

### 1.1 结论

本次回归的根因不是单一的"碎股数量转换"问题，而是 `4a148b3` 引入的 **execution（逐笔成交）驱动路径** 与 **全局 `safeQuantityNumber` 收紧** 两处叠加：

1. 启动重建生命周期新增了 `historyExecutions` / `todayExecutions` 调用，把**美国（US）标的**的碎股成交明细（如 `SNDK.US` 0.0006）送入本地 `mapBrokerExecutions`，在 `safeQuantityNumber` 处抛 `RangeError`，导致启动/重建整体失败。
2. 历史订单里本来就存在同样的碎股，因此**只绕过 execution 明细仍然失败**。正确的收敛是**作用域分工**，不是整体放宽、也不是整体收紧：
   - **策略订单路径**：对**全体纳管 HK 订单**执行严格整数契约（`safeQuantityNumber`），**不是**只校验当前席位或只校验目标订单；
   - **专用卖出读取**（`sellPositionReadAdapter`）：只对**本次目标 HK** 的原始 qty/available **文本**走 strict，同行的 US 与非目标字段不走 strict。
   - 上述两条是不同作用域，不能互相替代：把"卖出读取仅目标 strict"误读为"全体只做宽校验"会丢掉订单侧的整数证明；把订单侧严格性套到账户/成交全体会再次引发本次崩溃。
3. 由此进一步暴露了完整 `KnownExecutionBaseline`（durable 恢复基线）与在线/重算经济规则之间的分叉：baseline 边界冻结时机、baseline-only 普通 BUY 的合法性、`executionHistory` 组聚合与在线共享裁决不一致（A/B/C）。

### 1.2 目标形态（一句话）

**以订单事实（OrderFact / BrokerOrderExecutionFact）为唯一经济事实来源，完全不消费 execution 明细，完全隔离 US 交易能力，同时保留精准金额、累计单调/幂等、成交占用、保护 SELL 写前持久化与完成边界、当日亏损、事件顺序与 fail-closed 恢复语义。**

### 1.3 三句话交付定义

- 启动路径：`historyOrders` + `todayOrders`（保留既有顺序与去重），零 execution 明细调用。
- 经济规则：单点在 `domain/order` 的 pure 裁决（`mergeExecutionFact`）+ 完整 owner（`mergeBrokerOrderExecutionFact`），历史预检与在线/重算复用同一套规则，不新造第二套。
- 账户隔离：HK 才是交易域；US 仅做持仓与必要估值展示，任何 US 侧 pending/push/恢复都不得触发撤改、详情读取、订单阻断或交易动作。

---

## 2. 范围与非目标

### 2.1 在范围内

- 修复 `historyOrders`/`todayOrders` 驱动的启动、重建、快照、pending、push、status query 路径。
- 统一订单事实契约（`OrderFact`、`BrokerOrderExecutionFact`、推送 decoder、详情读取、broker access、merge 裁决）。
- 订单时间（`executionTimeMs`/`updatedAtMs`）与状态推进的单一规则集。
- 正成交终态本次原始量价／金额的首次准入（不沿用 known 价额）与保护 SELL 的写前校验边界。
- HK scope（市场判定）与 US 全面交易隔离。
- 账户精度：有限、非负、小数文本的安全转换与展示。
- Durable baseline 恢复、完整历史预检、KEEP_KNOWN 语义、fail-closed 冲突处理。
- A/B/C 的目标设计、反例与**修复闭环**（§10，已关闭，保留作回归规格）。
- 删除**逐笔明细链路**及其**专用注入/证据链**（execTime 证据、economics/ledger 端口与适配器、推送旁路类型）与对应 fixture/mock。
- **不得**把上述删除理解为删除**累计经济事实**（`BrokerOrderExecutionFact` 的累计合并与发布）、**纯金额精确运算**（`exactMultiply`）、或 durable 的 progress/completion——这些是保留语义。

### 2.2 明确非目标（不得自行扩大）

- **不为 US 提供支持**：不新增美股交易、不改 US 成交语义、不做 US 逐笔还原。
- 不新增 `ledger`、不新增 `evidence store`、不新增多模式 `compat` 层。
- 不回滚整个架构（保留现有事件驱动骨架与持久化设计，只收敛回归点）。
- 不吞异常，不对策略 qty 做四舍五入，不清历史日志（`logs/` 任何文件都不删不改）。
- 不新增 fallback/降级来掩盖未知 phase、未知金额、未知时间。
- 不扩展 short（做空）支持：账户负数数量按**当前非负合同**处理，不因本次改动引入负持仓语义。

### 2.3 硬约束（违反即视为回归）

- 保留精准金额（字符串精确乘法），禁止浮点近似。
- 保留累计单调与幂等（重复观测不产生重复经济效果/重复 revision）。
- 保留成交占用（hold registry / 资源占用）语义。
- 保留保护 SELL 的**写前持久化**与**完成边界**。
- 保留当日亏损（daily loss）计算与 segment 口径。
- 保留事件顺序、stop、boot cache、既有错误语义。
- 任何无法用真实事实证明的 phase/amount/time，一律 fail-closed，不得假造。

---

## 3. 根因分析

### 3.1 现场证据（SDK 日志）

`logs/sdk/trade/2026-10-19.log`：

| 日志位置 | 内容                     | 含义                               |
| -------- | ------------------------ | ---------------------------------- |
| 第 45 行 | `historyOrders` = 42     | 历史订单 42 条，含 US 混合账户订单 |
| 第 47 行 | `todayOrders` = 0        | 当日订单为空                       |
| 第 49 行 | `historyExecutions` = 38 | 新增的逐笔成交明细请求             |

- API 返回码 `code 0`（请求本身成功），失败发生在**本地**。
- 首个失败项：第 33 条成交记录 `SNDK.US`，`qty = 0.0006`；另有 `YANG` 0.036、`MSOS` 0.2、`GDXD` 0.026 同类碎股。
- 本地 `mapBrokerExecutions` → `safeQuantityNumber` 抛 `RangeError`：严格数量契约不接受无法证明为原始整数的碎股小数。
- **关键推论**：`historyOrders` 里存在同样的碎股，所以"只绕过 execution 明细"这个局部修法仍然失败。必须同时把严格转换的**作用域拆清**：会话/成交明细侧不再对非交易市场做严格整数校验（并从启动作业中移除）；订单侧对**全体纳管 HK 订单**保持严格整数；只有专用卖出读取才仅对本次目标 HK 原文 strict。

### 3.2 与旧 develop 的差异

| 维度 | 旧 `develop`（正确基线） | 回归版（`4a148b3` 之后） |
| --- | --- | --- |
| 数据来源 | 仅 `historyOrders` + `todayOrders` | 追加 `historyExecutions` + `todayExecutions` |
| 数量转换 | `qty` 做 finite 数值转换，随后再做归属（HK/席位）筛选 | 进入严格 `safeQuantityNumber`（要求原始整数证据） |
| 经济事实 | 订单事实单点合并 | 订单事实 + 逐笔成交 + economics/ledger 多套注入 |
| 启动失败面 | 订单读取失败才失败 | 任意市场（含 US）的碎股成交即可让启动失败 |

### 3.3 根因归纳（按可修复层级）

1. **数据源越界**：交易域本应只看订单，却引入 execution 明细，把非交易市场的精度问题带进启动关键路径。
2. **严格性作用域错误**：`safeQuantityNumber` 本身是**正确**的实现（不可证明的原始整数就必须拒绝），错在**应用范围**——既被当成对账户/成交的全局校验，又没有把两种正确作用域分开：**全体纳管 HK 订单 → 严格整数**，**专用卖出读取 → 仅本次目标 HK 原文 strict**。
3. **市场隔离缺失**：US 订单/成交未经市场判定就进入 HK 的经济、恢复、撤改与阻断逻辑。
4. **经济规则分叉**：durable baseline（冻结边界）、在线累计执行、当日重算、历史组聚合各自算一遍，出现 A/B/C 三类不可接受语义。
5. **恢复完整性顺序错误**：部分恢复路径在"经济发布之后"才做完整性校验，导致"半发布"状态与"已发布但无法恢复"的矛盾。

---

## 4. 目标架构

### 4.1 入口与生命周期

| 入口 | 允许行为 | 明确禁止 |
| --- | --- | --- |
| startup / rebuild | `historyOrders` + `todayOrders`（**保留既有读取顺序与去重语义，优先保持不变**）；订单级经济合并；durable baseline 恢复 | 调用 `historyExecutions` / `todayExecutions`（任何生命周期都不允许） |
| status query | 仅 `orderDetail`（`603001`、retry、authorization 的旧规则原样保留） | 新增成交明细会话、新增 economics 注入 |
| push | 一次**延迟 decode**，decode 本身无 IO；market guard 之后**只 decode 一次** | decode 前后重复解析、guard 前产生副作用、为非 HK 构造经济事实 |

### 4.2 数据流（目标）

```
SDK orders (history/today)
  └─ orderMapper: raw → OrderFact（精确金额、严格时间）
       ├─ snapshot: 只取 HK 订单 → BrokerOrderExecutionFact
       ├─ pending : 只取 HK 订单，US pending 不产生任何 mutation
       └─ push    : guard(HK) → decode 一次 → OrderFact

BrokerOrderExecutionFact ── mergeExecutionFact(known, observed) ──> BrokerFact | null(stale)
                          └─ mergeBrokerOrderExecutionFact（完整 owner wrapper）
                                  ├─ recorder / orderTracking（online 经济、成交占用）
                                  ├─ dailyLossTracker（segment 口径、baseline 冻结边界）
                                  └─ durable baseline（V1 schema，写前事务 + fsync）
```

### 4.3 分层职责

- `domain/order`：纯裁决（是否接受、是否 stale、金额是否冲突、phase 是否允许），无 IO、无 now()。
- `application/*`：编排经济发布、资源占用、通知与恢复顺序；拥有"发布前必须完成的校验"责任。
- `infrastructure/longbridge/trade`：SDK 适配、字段映射、市场判定后的过滤、精度转换的窄点应用。
- `app/runtime`：装配；不得再创建 economics / execution ledger。

---

## 5. 契约（冻结接口与数据）

### 5.1 `OrderFact`（冻结字段）

| 字段              | 类型（冻结）     | 语义                                     |
| ----------------- | ---------------- | ---------------------------------------- |
| `executedPrice`   | `string \| null` | 精确价格文本；不可用时 `null`            |
| `executedAmount`  | `string \| null` | 精确金额文本；不可伪造成 `"0"`           |
| `executionTimeMs` | `number \| null` | 成交时间；无真实事实必须 `null`          |
| `updatedAtMs`     | `number`         | 本次观测时间代理（**不是**逐笔成交时间） |

生成规则（必须逐条满足）：

1. **raw 正量 + 有效正价** → `executedAmount` = `exactMultiply(qty, price)`，字符串精确乘法，禁止 `Number` 运算、禁止四舍五入。
2. **raw 正量 + terminal + 本次缺／零／无效价额** → mapper **第一次就拒绝**，domain 同样拒绝；不得映射缺价事实后继承 known 价额，不重试、不补查、不等待第二次消息或 closed 兜底。
3. **正量 OPEN + 缺／零／无效价额** → 直接拒绝（fail-fast），不构造事实。
4. **真实 zero 量且非 Filled** → `executedAmount = "0"`、`executionTimeMs = null`；零成交非 Filled 终态仍可正常关闭，Filled 零成交拒绝。
5. **正量必须有有效 `updatedAtMs`**；不得用 `now()` 或 `submittedAt` 兜底。
6. **zero 量** 可用真实 `submittedAt` 作为初始 revision 水位。

### 5.2 `BrokerOrderExecutionFact`（归一经济事实）

- `amount` 必须是 `string`（不允许 `number`、不允许 `null`）。
- `positive` 情形必须同时具备 **正 amount** 与**有效 `executionTimeMs`**。
- 不携带逐笔明细、不携带独立 execTime 证据对象（该证据体系已删除）。

### 5.3 推送解码

- `OrderPushDecoder.decode(): OrderFact | null`。
- 返回 `null` **仅**允许"合法结构的非 HK 标的"，表示"本域不处理"；坏结构必须 throw，不能用 `null` 掩盖。
- 删除 `inspect()` / `ReadFact` / `PriceEvidence` 一整套旁路类型。
- 时序：guard（HK 判定，纯字符串，无 IO）→ decode **一次**。

### 5.4 详情读取

- `read(orderId): Promise<OrderFact>`。
- `orderId` 结构错误或非 HK → 拒绝。
- 不返回成交明细，不返回 economics。

### 5.5 BrokerAccess

- 不再提供 economics / ledger 创建能力。
- snapshot 依赖只保留 **limiter**（限流）。
- 删除独立 execTime 证据注入与 economics 注入。
- 简单金额一律 `exactMultiply` 直接计算，不再走"证据链"。

### 5.6 合并裁决（唯一经济规则入口）

```ts
// domain/order/executionFact.ts
mergeExecutionFact(
  known: KnownExecutionBaseline | undefined,
  observed: BrokerOrderExecutionFact,   // 完整 BrokerFact
): BrokerOrderExecutionFact | null      // null = stale，不采用

// 完整 owner 包装
mergeBrokerOrderExecutionFact(...)
```

- `mergeExecutionFact` 是 **shared pure 裁决**：stale 判定、revision 单调、qty 单调、phase 迁移、金额冲突全在此处。
- `mergeBrokerOrderExecutionFact` 是 wrapper，负责完整 owner 语义（谁持有、谁发布、谁落 durable），**不得**另写一套判定。
- 严禁把"raw same-qty 保留 T"这条**输入侧**规则拿来抹掉已持久化事实中的矛盾（见 §6 规则 10/11）。

---

## 6. 关键流程与规则

### 6.1 时间与状态推进（统一规则集）

1. raw 的 `updatedAt` 只是**观测代理**，不是逐笔成交时间。
2. 首次 positive 且**无 known** → 取本次 `updatedAtMs` 作为 `knownT`。
3. qty **增加** → 取本次 T；revision 与 qty 都**不得倒退**；正 amount 只做**增量**累加。
4. **same qty** 的状态/合法金额修订 → **保留 `knownT`**；revision 独立推进。
5. 重复观测 → 幂等：无经济变化不得产生新 revision、不得重复发布。
6. `oldRev` **非增** → 不覆盖；`oldRev` **增** → 拒绝。
7. **same rev 或 new rev 且量下降**、共享 owner → **必须拒绝**；不得用 `KEEP_KNOWN` 吞掉冲突。
8. 旧入站**弱 `OPEN → OPEN`**：仅限 **同 rev + qty 降 + amount 不增加 + T 不推进**；允许按过滤处理，但**不得**借此扩展经济 owner 或 recovery 范围。
9. Known 正量必须 `amount > 0` 且 T 有效；**不可**用 raw 去补损坏的 known；`phase: null` **只**允许给旧 baseline。
10. **same rev + same qty + same phase + amount 冲突 → 拒绝**；唯一例外是**已证明的 `OPEN → TERMINAL`**，此时允许最终金额修订。
11. 共享事实裁决的 **`TERMINAL → OPEN` 仍拒绝**；仅 closed 入站可按 §6.2 窄范围丢弃完整同证据迟到 OPEN，不放宽 domain 阶段规则；完整旧 revision 非增量仍按既有 stale 处理，`phase-null` **不得**授权特例。

### 6.2 正成交终态原始证据与 closed 入站（F03 最新准则）

- **异常正成交终态第一次就 fatal（已实施）**：普通 BUY／SELL 与保护 SELL 均必须由本次原始数量、正价、正金额和有效 revision／时间自证；缺失／零／无效量价或金额不得继承 known 价格、金额完成结算。同 order、同 qty、known 完整也不能授权沿用，因为同量仍可能发生金额修订。mapper 与 domain 已删除缺价／known 补价豁免，`Filled + Q=0` 也已由两处 guard 在写终态、结算前首次拒绝；不重试、不补查、不等第二条或 closed 兜底。
- **closed 仅窄范围丢弃迟到 OPEN**：仅在已无 tracking、已有 TERMINAL 事实，且本次证据完整、broker 身份（orderId／symbol／side 及归属）匹配、同 revision、同累计数量、同累计金额时，在入站丢弃；不重开资源、不重复 terminal／settle／hold／经济消费。其他坏证据首次拒绝，其余阶段回退仍由共享裁决拒绝，完整旧 revision 非增量的既有 stale 处理不变。
- 保留真实零成交非 Filled 正常关闭、证据完整的合法同量金额修订（含 closed 后的新 revision），以及 `T=null` 时本次有效 revision 代理模型；不能把所有 closed 事件一律丢弃。
- **fatal 时序二审闭环**：Monitor 公共 operation 等待 fanout 等其他 I/O 后才 fatal、seatActivation 等待 `finally release` 后才 fatal 的问题已最小修复；两者复用现成 termination，先关双 gate 再排空，首错与外部 API 失败政策不变。原两位 reviewer 独立复验全部关闭，F03 无剩余代码发现。
- **历史前提更正**：原方案“普通同量终态可凭完整 known 沿用价额”已撤销；原 F03 的第一次 tracked 借 known 结算、第二次 closed fatal 是历史缺陷表现，不是应保留的第一次成功行为。本轮工作区实施与最终离线结果见[审计 F03 本轮补记](./architecture-refactoring-full-chain-audit.md#f03-implementation-verification)，不据历史结果宣告本轮全仓全绿。

### 6.3 保护 SELL

- 当 **known 有成交** 或 **raw 本次有成交**时，`cancel` / `reject` / `expire` / `filled` 都必须携带**本次 raw 的正 qty + 正价 + 正金额 + 有效 `updatedAtMs`**。
- 统一的本次原始数量、价格、金额及有效 revision 准入，**先于 stale／known／已终态过滤，以及任何资源／经济／durable 副作用**；缺证据收口已删除，不得恢复。
- **纯 zero** 不得制造经济 progress，也不得制造 completion。

### 6.4 zero 与 close

- **无 rev 的 zero close**：只承认 **known 完整 zero**；**不能**清空 known positive，也**不能**借 oldRev 包装出伪 zero。
- **closed 但 recorder 仍有 known** 的新 rev 金额修订：仍然必须做**经济更新 / rev-only 水位**；**不得**因为 tracking 停止而忽略；但**不得**重复 settle 资源、hold、冷却、completion。

### 6.5 其他保留语义

- `distanceSwitch` 预算 **600 / 300** 保持不变。
- 事件顺序、stop、boot cache、既有错误类型与错误信息语义保持不变。
- 当日亏损 segment 口径保持不变（除 §10-A 的 baseline 冻结缺陷）。

### 6.6 startup / rebuild

- 顺序与去重：`historyOrders` + `todayOrders`，**优先保持既有顺序与去重**（不因本次修复改变合并优先级）。
- 历史预检（经济发布**之前**完成，见 §9.3）通过后才允许经济发布与 durable 写入。
- 任何 stale 情形可 **THROW** 保守阻断（严禁部分应用）。

---

## 7. 删除与保留

### 7.1 删除（工作区已删除、**未提交**；不得恢复）

| 对象 | 路径 | 状态 |
| --- | --- | --- |
| 订单经济（旧） | `src/domain/order/orderEconomics.ts` | 工作区已删除（`D`，未提交） |
| economics 类型 | `src/types/orderEconomics.ts` | 工作区已删除（`D`，未提交） |
| execution ledger 类型 | `src/types/orderExecutionLedger.ts` | 工作区已删除（`D`，未提交） |
| ledger 适配器 | `src/infrastructure/longbridge/trade/executionLedgerAdapter.ts` | 工作区已删除（`D`，未提交） |
| 推送旁路类型 | `inspect` / `ReadFact` / `PriceEvidence` | 工作区已删除（未提交）；当前快照下 src 内残留引用为 0 |
| execution 明细调用 | `historyExecutions` / `todayExecutions` | 当前快照下 src 内残留引用为 0（需在最终门禁复检） |
| fixtures / mock ledger | 对应 mock 与 fixture | 工作区已删除（未提交）；有价值断言迁移到订单事实测试 |

> 说明：本节删除的是**逐笔明细链路**与**专用注入/证据链**；`BrokerOrderExecutionFact` 的累计经济、精确金额运算、durable progress/completion **不在删除范围**。

### 7.2 保留（不得删改语义）

- V1 durable schema、canonicalIDs、progress、completion、写前事务、`fsync`、幂等冲突处理、crash gap 阻断。
- 订单事实的精准金额、单调/幂等、成交占用。
- 保护 SELL 写前持久化与完成边界。
- 当日亏损、事件顺序、stop、boot cache、错误语义。
- historical execution 日志（`logs/` 只读保留，不清理）。
- 安全 oracle 测试：可迁移布局，**不得**删除断言来换绿。

---

## 8. 账户与市场隔离

### 8.1 HK scope（`src/utils/marketScope.ts`）

```ts
isHongKongSymbol(symbol: unknown): symbol is string
```

- 合法 HK → `true`；合法非 HK → `false`；**坏结构 → throw**。
- **不**做 `trim`、**不**做大小写修复（不做"宽容修正"）。
- 这是**市场判断**，不是 ticker 可交易性校验：允许 `A-Z0-9_-` 以及内部点（以支持类别股与既有测试）；真正的合法性校验由**调用方**负责。

应用顺序（关键）：

- `snapshot` / `pending` / `push`：在**严格金融转换之前**、**boot cache 之前**排除非 HK。
- `recovery` / `reconcile` / `hold`：HK 范围与上述一致。
- **不得**只按"当前席位"过滤 HK 旧单（旧席位的 HK 订单仍需进入恢复与持有范围）。

### 8.2 US 隔离清单

| 区域                                        | US 行为                                      |
| ------------------------------------------- | -------------------------------------------- |
| pending BUY / SELL                          | 不 cancel、不 replace、不读 detail、不 block |
| 配置 / candidate / seat / submit / doomsday | 全部隔离，不产生 US 交易动作                 |
| 快照与展示                                  | 保留 US 全账户持仓与必要 quote 估值展示      |
| available lookup                            | HK-only                                      |
| 目标 qty / lot 提交                         | 严格校验（HK 才进入该路径）                  |

注意：**"报价集合"不等于"交易授权"**——展示用 quote 不得成为下单依据。

### 8.3 HK 旧席位规则（保留）

- HK 错席 BUY 的**原撤单**逻辑保留。
- HK 错席 SELL 的**阻断**逻辑保留。

### 8.4 账户精度（`accountMapper` / `accountPositionSnapshot`）

- 两层都要求 **finite、非负、小数**；**禁止**全局用 `safeQuantityNumber` 放宽/收紧。
- `Number` 不是"原始整数证明"：不得以 `Number` 值反推可安全使用。
- `sellPositionReadAdapter`：**仅针对本次目标 HK** 的原始 qty/available **文本**先 `safeQuantityNumber` 再做 map；同行的 US 字段与非目标字段**不**走 strict。
- 反例（必须被拒绝，不得四舍五入成 100 后售出）：
  - `99.99999999999999999`
  - `100.00000000000000001`
- `accountDisplay`：普通文本用 `String(number)`，**不**量化、**不**把指数展开、**不**用 `toFixed(20)`。
  - `1e21` 必须不因指数形式 throw。
  - `1e-21 * 1e21` 市值 = 1。
- 只有在**最终 formatDecimal** 处才允许舍入；不得声称能从 `number` 还原原始全部精度。

---

## 9. Durable 恢复设计

### 9.1 保留的持久化契约

- V1 schema、canonicalIDs、progress、completion、写前事务、`fsync`、幂等冲突、crash gap 阻断：全部保留，**不删日志、不改日志格式**。
- `oldT > revision` 的情形**已允许**，不能恢复 `develop` 旧 parser 的限制。

### 9.2 baseline 语义

- baseline 的 **phase 未知**时：**不得**伪造成 `OPEN` 或 `TERMINAL`。
- 普通 BUY 允许**只有 baseline、没有 protective SELL progress**（这是合法形态）。

### 9.3 完整历史预检（发布前）

必须校验的维度（缺一不可）：

- identity、direction、symbol、qty、revision、phase、amount、T。

判定规则：

- 同 rev、qty 与 phase 相同但 **T 矛盾** → 拒绝；**结果与输入顺序无关**。
- 历史不同 rev、same qty、T 非倒退 → 兼容（这**不等于**新 raw same-qty 可以推进 T）。
- startup stale 可 **THROW** 保守阻断，**不允许部分应用**。
- 预检必须全部完成于**经济发布之前**；不得"先 publish 再发现完整性错误"。
- 正量 raw 的 `amount = null` **不得**借 baseline 金额"洗白"（durable 不含完整 raw 价格，无法证明）。

### 9.4 `SEAT_REFRESH`

- 完整 known 走 `KEEP_KNOWN`；但**冲突不能被吞**（冲突必须显式失败）。

### 9.5 允许的过渡形态

- 既有 loader-local map 可作为**临时恢复过程**（`loadTradingDayRuntimeSnapshot` 内的本地聚合）。
- 但它**不能**成为第二账本，也**不能**演化为 evidence service。

### 9.6 恢复能力的诚实边界

- 不读逐笔明细，就无法精确还原跨日的每一笔成交；恢复只能是**订单级语义**，这是被接受的取舍。
- 历史 T 与 revision 分离是可接受的设计，但**矛盾不得被吞**。
- 缺少真实事实或不安全恢复时，保持 fail-closed；**不假造** phase / amount / T。

---

## 10. 审查发现与修复闭环（已关闭）

> **当前状态：原 3 项 P1（A/B/C）+ 后续新增 P1（D）均已关闭（closed）**；另有优化批次已复审（§10.5）。
>
> 本节保留**设计历史**：原始目标 / 反例 / 正确设计（写于未修复时）+ 逐项新增的"实际落地"与"验证结果"。**反例不得因已关闭而删除**——它们是回归测试的规格来源。
>
> 阅读约定：下文"修复前：…"描述的是**当时缺陷行为**，不是现状；"验收（目标）"已由 §13.3 / §13.4 的最终离线验收覆盖。

### 10.1 A：baseline 冻结只在 restore 当刻生效

**目标**：已提交的 boundary / per-order baseline 在同一交易日内**不得**随后续 snapshot 重选；在线记录与当日重算必须复用**冻结 baseline**；只有出现**真实新 boundary** 时才按既有事务更新。**不新增 store。**

**缺陷位置**：`src/domain/risk/dailyLossTracker.ts` 中 `buildDirectionBaselines` 在在线 `recordCumulativeExecution` 与同日 recalc 时会**重选最高 rev** 覆盖边界。

**反例（必须变成测试）**：

1. SELL 冻结 boundary：qty 10、amt 90、T = boundary。
2. 随后恢复 same qty、new rev、amt 80、T = same。
3. boundary 之后 BUY 10、cost 100。
4. SELL 增量 qty 20、amt 170、T = after。

期望：该 segment 卖出额 = `170 - 90 = 80`，loss = `-20`。修复前：结果为 `-10`，因为 baseline 在 later snapshot 被重选为 `80`。

**正确设计**：

- boundary 一旦提交（写前事务 + fsync 成功），即成为该日该 direction/per-order 的冻结基准，只读。
- online `recordCumulativeExecution` 与 same-day recalc 都从冻结 baseline 读取，不再自行 `max(rev)` 选择。
- 真实新 boundary（例如新交易日/新 per-order 边界）才走既有事务更新路径。
- 不引入新的持久化结构、不引入第二账本。

**验收（目标）**：完整 startup → 继续成交 → `SEAT_REFRESH` 全程始终 `-20`；无重复 completion、无重复冷却。

**实际落地**：

- `dailyLossTracker` 在线路径（`recordCumulativeExecution`）**不再重选**已提交 baseline；同日 recalc 与"显式相同 boundary"一律**复用冻结的 per-order 值**。
- 只有真实新 boundary 才按既有事务更新；未新增 store、未新增账本。

**验证（已关闭）**：完整 startup → 后续成交 → **两次真实 `SEAT_REFRESH`（90 → 80 → 170）** 全程 loss 保持 `-20`；completion 与 cooldown 均不重复触发；financial reviewer 同轮 **APPROVE**。

### 10.2 B：baseline-only 普通 BUY 被误拒

**目标**：经校验的 baseline **本身就是**冻结边界的依据，**无需**另有 progress；**不伪 phase**；所有恢复所需检查必须发生在**经济发布之前**。

**缺陷位置**：`restoreBoundary` 抛出 `persisted baseline does not match boundary fact`（`dailyLossTracker.ts`）。

**反例（必须变成测试）**：

1. V1 baseline：qty 10、amt 100、rev R、T 有效，**无 progress**。
2. API 返回 same qty、rev R+1、amt 100（合法）或 amt 90（合法减额）。
3. 修复前：history 预检通过，daily publish 之后 `restoreBoundary` 抛错。

**正确设计**：

- 只有 baseline、没有 progress 的普通 BUY 是**完整可恢复形态**，必须成功恢复。
- 恢复所需的一致性检查（baseline ↔ boundary fact ↔ durable）必须**全部前置**到经济发布之前完成。
- 无 progress 的 rev-only 推进与合法减额必须成功；缺失事实或真实冲突必须在**任何副作用之前**拒绝。

**验收（目标）**：无 progress + rev-only、无 progress + 合法减额两条用例均成功；缺失/冲突用例在副作用前拒绝（断言无半发布）。

**实际落地**：

- V1 `phase-null` baseline **自身即可作为冻结边界依据**，不要求存在 progress 的精确副本，且**不造 phase**。
- 复用现有 prepare/publish 结构；hold / seat 之前只做**纯预检**（无副作用）。
- 在**正式私有候选**内完成 progress / baseline / 双方向财务验证与计算，全部通过后才**同步 publish**（避免先发布再发现不一致）。

**验证（已关闭）**：baseline-only BUY 的 rev-only 与 100→90 **完整 startup 成功**；非法历史在**副作用前拒绝**；LONG 合法 / SHORT 坏也不产生半发布。financial reviewer 同轮 **APPROVE**。

### 10.3 C：`executionHistory` 组聚合与在线规则分叉

**目标**：`latestAmountOfGroup`（**修复中已删除**）当时**先压成 final 再跨组比较**，与在线共享经济规则不一致。改为**先按可证明的 phase 顺序逐步验证，再形成 final**；`phase-null` 不授权；**不新增**一套组聚合经济规则，改用**已有 pure 裁决 + 最小历史 time 校验**组合。

**缺陷位置**：`src/domain/risk/executionHistory.ts` 的 `latestAmountOfGroup`（修复时该函数与跨组 final 金额比较一并删除）。

**反例组（必须全部变成测试）**：

- 被**错误接受**：`R1 q5 a100 OPEN` → `R2 q10 a90 OPEN` → `R2 q10 a110 TERM`（中间出现量增额降）。
- 被**错误拒绝**：`R1 q5 a100 OPEN` → `R2 q10 a110 OPEN` → `R2 q10 a90 TERM`（最后是同 rev `OPEN → TERMINAL` 的合法最终金额修订）。

**正确设计**：

- 按 rev/phase 的可证明顺序逐步应用 `mergeExecutionFact` 的同一裁决，任一步不合法即整体拒绝。
- final 金额必须由逐步合法序列自然形成，而不是"取组内极值"。
- `phase-null` 不得作为放宽条件。
- 所有输入排列（顺序无关性）都要测；并必须与在线路径结果一致。

**验收（目标）**：两个反例组在**所有排列**下给出与在线一致的结果；不引入兼容 shim。

**实际落地**：

- 删除 `latestAmountOfGroup` 与**跨组 final 金额比较**；不再用"取组内极值"形成金额。
- 已证明的 `OPEN` / `TERMINAL` 阶段**逐步共享同一 `mergeExecutionFact` 裁决**（不另写一套组聚合经济规则）；连续 `phase-null` 仅保留最小历史 qty/amount 验证，**不造 phase**。
- 同 rev 但 T 矛盾 → 拒绝；历史跨 rev、同量、T 非倒退 → 兼容。

**验证（已关闭）**：两个三记录序列 × **全部 6 种排列** + **online 对照** + **loader（启动）路径**分别验证：非法序列被拒、合法序列被接受；不引入 compat shim。

### 10.4 D（后续新增 P1）：边界前 T 的 SUPPRESSED 连权威修订一起吞掉

**目标**：已提交 boundary 之后，同日同量 / 同 T 的修订只应抑制**经济 projection**（不重复完成 / 冷却 / 资源 / 结算），但必须保留 recorder 权威事实的 merge、revision 推进与 durable 保存，供后续单调检查与新 boundary 使用。

**缺陷（历史）**：边界前 T 的 SUPPRESSED 逻辑把 recorder 的权威修订与 rev 一并丢弃，导致：

- `10/90 -> 10/120` 这类**合法**修订被丢，而后 `20/110` **非法**序列反而可能通过；
- 同一序列在"二边界 vs 单边界 / 有 refresh vs 无 refresh"下 loss 结果不一致。

**反例（规格保留，不得删除）**：

1. 封存（boundary）后 `10/90 -> 10/120 -> rev-only`：T 不变、权威金额修订必须保存；`20/110` 必须拒绝。
2. 双边界 B1/B2：B1 以 A90 冻结，same-qty 80 修订须保存；B2 以 A80 冻结；B2 之后 `20/170` 与 BUY 成本 100 → loss `-10`；无 B2 的原 B1 案例仍为 `-20`。

**正确设计**：

- boundary 仅抑制**经济 projection**；同日权威 facts 仍 **merge**、进入**候选**、写 **durable callback**、**publish**。
- **old baseline 不改**；**新 boundary 取修订后 facts**。
- `uninitialized` / 跨日 / `invalid` 的抑制保持原样；保护 SELL 的 durable 义务（写前持久化、完成边界）保留。

**实际落地**：按上述实现（投影抑制与事实保存分离）；已完成保护 SELL 仅补关资源、不额外 refresh；普通 terminal 与进行中 protective episode 仍有必要 refresh；真实经济变化引发的刷新不取消。

**验证（已关闭）**：真实 oracle 覆盖封存后 `10/90 → 10/120 → rev-only`（T 不变且保存）/ `20/110` 拒绝；B1 A90 冻结 + same-qty 80 修订保存；B2 A80 冻结后 `20/170` 与 BUY 成本 100 → loss `-10`；**ONLINE / 真实 SeatActivation / RESTART（包含 B2 再次恢复）三者一致**；无 B2 的原 B1 案例 loss `-20` 保留。真正 completion 后 durable 失败时 recorder / Daily / progress / token / refresh / episode / completion 均不变，retry 一次写、重复不额外。A reviewer 同轮 **APPROVE**（195 pass / 11 files + 真实链 / terminal / crossday probes）。

### 10.5 优化批次（结构收敛，无行为回归）

**目的**：去掉已无必要的生产包装与重复选择逻辑，降低规则分叉面，避免“看似两套入口”的误用。

- **删除生产包装**：`recalculateFromAllOrders` 生产包装方法/接口已删除；src / mock / tests 无残留（历史删除说明保留，不作为当前现存 API）。
- **测试专用 helper**：`tests/helpers/dailyLossRecalculation.ts` 提供最小 prepare + publish helper，**仅测试使用**；生产 startup / seat 仍严格保持**两阶段**（prepare → publish），不得依赖该 helper。
- **排序与选择单一化**：`assertExecutionHistory` 在**完整验证后直接返回已排序 latest**，loader 直接复用；删除重复排序 selector `selectLatestExecutionHistorySnapshot`。
- **保留点（勿误读）**：后续结合 API final 的**完整校验仍保留**；不要把该恢复链路写成“整个恢复只有一次排序”——历史组仍须按相位逐步验证。
- **注释清理**：3 个 trade 适配器的过时注释已清理（不改行为）；`accountDisplay` 展示层**不改**。

**验证（B 优化复审）**：**APPROVE**（75 pass / 9 files + 9 probes）。

### 10.6 二轮最小精简（已复审，无行为回归）

**范围**：仅 `src/domain/order/executionFact.ts` 与 loader（`loadTradingDayRuntimeSnapshot`）；**no tests / types / API 更改**。

- **删除**：两处恒定校验参数、重复负额判断、不可达的 `sameT` fallback helper。
- **loader 结构收敛**：合并 identity + snapshots 分组 map、删除 known 派生 map → **少 2 个 Map、少一轮派生遍历**。
- **体量**：本轮相对实施前工作区 **+20 / −40，净减 20 行**。
- **保留（不得合并）**：两次完整 history 验证、两次 prepare、freshness 校验；语义不同的阶段**不合并**。

**复审与验证（原批次历史）**：独立 minimality 与金融 review **均 APPROVE**；旧 / 新差分的返回与错误比较**全部 0 差异**；金融定向 **161 pass**。当时全量 **3288 pass / 0 fail / 317 files**、`typecheck` / `eslint` / `diff --check` 均 0、套件 4 项 build pass；验证前后**两个受审文件 SHA256 与 review 一致**。当时未实盘、未 commit；不替代 §14.2 的 F03 最终结果。

---

## 11. 模块变更地图

> 行号易变，此处只给路径与职责，不写精确行号。

### 11.1 broker infrastructure / longbridge / trade

| 文件 | 变更要点 |
| --- | --- |
| `src/infrastructure/longbridge/trade/orderMapper.ts` | raw → `OrderFact`；精确金额、严格时间；正成交 terminal 缺／零／无效价额首次拒绝（F03），不构造缺价 `null` 事实 |
| `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts` | HK-only 过滤在严格转换/boot cache 之前；产出 `BrokerOrderExecutionFact` |
| `src/infrastructure/longbridge/trade/pendingOrdersAdapter.ts` | US pending 无 mutation；HK 旧席位规则保留 |
| `src/infrastructure/longbridge/trade/orderPushAdapter.ts` | `decode(): OrderFact \| null`；删除 inspect/ReadFact/PriceEvidence |
| `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts` | `read(orderId)`；ID 错/非 HK 拒绝 |
| `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts` | 移除 economics/ledger 创建；snapshot deps 仅 limiter |
| `src/infrastructure/longbridge/trade/accountMapper.ts` | finite/非负/小数；不放宽全局 |
| `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts` | 仅本次目标 HK 文本走 `safeQuantityNumber` |
| `src/infrastructure/longbridge/trade/clientFactory/index.ts` | 装配收敛，不再注入 economics/execTime 证据 |
| `src/infrastructure/display/accountDisplay/index.ts` | `String(number)`，指数安全，最终 formatDecimal 才舍入 |

### 11.2 app runtime

| 文件 | 变更要点 |
| --- | --- |
| `src/app/runtime/createTradeRuntime.ts` | 移除 economics/ledger 装配；execution 明细端口不进入运行时 |
| `src/app/runtime/createPostGateRuntime.ts` | 同上；保持事件顺序/stop/boot cache |

### 11.3 types（端口与数据）

| 文件 | 变更要点 |
| --- | --- |
| `src/types/trade.ts` | `OrderFact` 冻结字段 |
| `src/types/brokerAccessPorts.ts` | 无 economics/ledger；snapshot deps 仅 limiter |
| `src/types/brokerClientFactory.ts` | 同上装配签名 |
| `src/types/orderPushPorts.ts` | `decode()` 单入口 |
| `src/types/orderDetailReadPorts.ts` | `read(orderId): Promise<OrderFact>` |
| `src/types/orderSnapshotReadPorts.ts` | HK-only + 归一经济事实 |
| `src/types/orderReadMetadata.ts` / `orderRecorder.ts` | recorder 元数据与完整 owner 语义 |
| `src/types/risk.ts` | baseline/segment 口径与 A/B/C 相关契约 |
| 已删除 | `src/types/orderEconomics.ts`、`src/types/orderExecutionLedger.ts` |

### 11.4 W2：经济裁决与追踪

| 文件 | 变更要点 |
| --- | --- |
| `src/domain/order/executionFact.ts` | shared `mergeExecutionFact` + wrapper `mergeBrokerOrderExecutionFact` |
| `src/domain/order/orderFactMerge.ts` | 合并语义、stale |
| `src/domain/order/executionProjection.ts` | 投影（不引入第二账本） |
| `src/domain/order/types.ts` / `orderRecordPolicy.ts` | 记录策略与 phase 规则 |
| `src/application/orderTracking/**`（`orderMonitor/*`、`recorder/*`、`orderHoldRegistry`） | 在线经济、hold、settlement、closed 修订 |

### 11.5 W3：恢复与经济历史

| 文件 | 变更要点 |
| --- | --- |
| `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | startup 恢复与预检；无 execution 明细 |
| `src/application/tradingDayRebuild/executionNormalization.ts`（新增） | 归一经济事实与校验 |
| `src/application/seatActivation/**` | `SEAT_REFRESH` KEEP_KNOWN（冲突不吞） |
| `src/domain/risk/dailyLossTracker.ts` | baseline/segment（A、B 修复点：冻结 per-order 基准 + phase-null baseline 即边界依据；**D 修复点**：边界仅抑制经济 projection，同日权威 facts 仍 merge / 候选 / durable callback / publish）；无生产包装 `recalculateFromAllOrders`（已删除） |
| `src/domain/risk/executionHistory.ts`（新增） | 历史组逐步相位裁决（C 修复点；`latestAmountOfGroup` 已删除）；`assertExecutionHistory` 完整验证后直接返回**已排序 latest**，不再由调用方重复排序 |
| `tests/helpers/dailyLossRecalculation.ts`（仅测试） | 最小 prepare + publish helper；生产仍两阶段，不得依赖 |
| `src/types/risk.ts`、`persistence` 直接引用 | 契约同步 |

### 11.6 W4：市场与精度

| 文件 | 变更要点 |
| --- | --- |
| `src/utils/marketScope.ts`（新增） | `isHongKongSymbol` |
| `src/infrastructure/longbridge/trade/accountMapper.ts` | 账户精度 |
| `src/application/accountPositionSnapshot/index.ts` | 快照精度与 HK 范围 |
| `src/infrastructure/display/accountDisplay/index.ts` | 展示精度/指数 |
| `src/config/validator/utils.ts` | 配置侧市场/精度校验 |
| `src/domain/seat/seatPolicy.ts` / `warrantSelection/index.ts` | candidate 隔离 |
| `src/application/orderExecution/submitFlow.ts` / `quantityResolver.ts` | 目标 qty/lot 严校、HK-only |
| `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts` | HK 文本安全转换 |
| `src/application/doomsdayClearance/index.ts` | US 隔离 |

### 11.7 测试与 fixture

- 删除 ledger / mock ledger 相关 fixture；有价值断言迁移为订单事实测试。
- 新增（untracked）测试：`tests/utils/marketScope.test.ts`、`tests/infrastructure/longbridge/trade/{accountMapper,orderDetailReadAdapter,sellPositionReadAdapter,mixedAccountSnapshotScope.business}.test.ts`、`tests/domain/{order/orderFactMerge.business,risk/executionHistory}.test.ts`、`tests/application/tradingDayRebuild/executionNormalization.test.ts`、`tests/application/seatActivation/executionNormalizationFailure.business.test.ts`、`tests/application/orderExecution/submitFlow.hkScope.business.test.ts`、`tests/integration/recalculationOrders.ts`。
- 测试专用 helper：`tests/helpers/dailyLossRecalculation.ts`（最小 prepare + publish，**仅测试**；生产仍两阶段）。
- 离线集成验收说明：`tests/integration/architectureRefactoringRecovery/README.md` 已同步新边界语义（边界后仅抑制**经济 projection**；权威修订 / rev / durable 保存供后续单调检查与新 boundary；跨日仍原抑制；保护 SELL durable 义务不变）。
- `docs/` 与 `tools/` 只做与本次直接相关的引用检查，不扩展到无关内容。

---

## 12. 实施计划与责任边界

### 12.1 原批次终态（历史）

- 原批次已完成实施、多轮独立复审（financial / boundaries / A / B）与当时的统一离线验收（§13.4）；F03 最新状态见 §14.2。
- 当时未实盘验证、未提交 commit，HEAD 为 `d2aa59054abac546f506b27df45f161afcfc6578`；非当前 HEAD 声明。

### 12.2 实际执行顺序（历史记录，已按序完成）

1. **核实际 partial 状态**：consolidation worker 上一次尝试因 API 429 失败、**未产生改动**（历史事实，保留以备回溯）；以工作区实际 diff 为准。
2. **集中收敛 A/B/C**（§10.1–§10.3），单批次完成。
3. **定向真实链路测试**（订单驱动启动 + 恢复 + 在线/重算一致性）。
4. **final-review-financial 独立只读复审** → 同轮 **APPROVE**；boundaries reviewer 之前已 **APPROVE W4 两项**。
5. **W5 统一门禁**（当时 3284）→ 全绿。
6. **新增 P1-D 与优化批次**（用户授权）：边界抑制语义修复（§10.4）+ 结构收敛（§10.5）；A reviewer 同轮 **APPROVE**（原 P1 关闭，195 pass / 11 files + 真实链 / terminal / crossday probes），B 优化 **APPROVE**（75 pass / 9 files + 9 probes）。
7. **原批次最终统一串行复验**：`tsc` / `eslint` / 全量 **3288 pass / 0 fail / 317 files** / `diff --check` 均通过（§13.4）。
8. 原批次复审无 blocker 后做总结；该批次最终状态保留为历史记录。

### 12.3 协作约束（对后续维护仍适用）

- 主 agent **仅调度**，不直接改代码；实施由单一 consolidation worker 持有，避免并发抢文件。
- 其他已结束批次的 worker **不并行抢同一批文件**。
- 不新增 compat shim，不自动 commit，不切分支。
- 若出现**未决业务选择**（会实质改变交易结果且无法从现有事实判定），聚焦提问用户；**不自行放宽**。

---

## 13. 测试与验收矩阵

> 全部为**离线**检查；不需要 env/credentials；不启动应用、不连实盘。

### 13.1 功能矩阵

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 混合账户（HK + US）实际 4 只碎股（`SNDK.US` 0.0006、`YANG` 0.036、`MSOS` 0.2、`GDXD` 0.026） | 启动/重建成功；US 不进入 HK 经济 |
| 2 | US pending push | 零 mutation（不 cancel/replace/detail/block） |
| 3 | 坏 symbol 结构 | throw（不 trim/case 修复） |
| 4 | HK 旧席位 | BUY 原撤单、SELL 阻断，行为不变 |
| 5 | execution API 调用计数 | `historyExecutions` / `todayExecutions` = **0** |
| 6 | detail `orderId` 错误 / 非 HK | 拒绝 |
| 7 | 时间矩阵 | 首次 positive 取 updatedAt；same qty 保 knownT；rev 独立推进；oldRev 非增不覆盖/增拒 |
| 8 | phase 矩阵 | `OPEN→TERMINAL` 允许最终金额修订；共享裁决 `TERMINAL→OPEN` 拒，closed 仅丢弃 §6.2 的完整同证据迟到 OPEN；phase-null 不授权 |
| 9 | qty 矩阵 | same/new rev 量降共享 owner 拒；qty 增取本次 T |
| 10 | price／amount 矩阵（F03，本轮离线证据见[补记](./architecture-refactoring-full-chain-audit.md#f03-implementation-verification)） | 正成交 terminal 缺／零／无效量价或金额首次 fatal；`Filled + Q=0` 已由 mapper／domain 两处 guard 首拒；不继承 known、不重试／补查；OPEN 正量缺价拒；精确乘法；真实零成交非 Filled 正常关闭 |
| 11 | 保护 SELL | 本次 raw 正 qty + 正价 + 正金额 + 有效 T；统一原始量价／金额及 revision 准入先于 stale／known／已终态过滤和资源／经济／durable 副作用；不得恢复缺证据收口 |
| 12 | bare zero close | 只认 known 完整 zero；不清 known positive、不借 oldRev 包装 |
| 13 | closed 但 recorder known 的新 rev 修订 | 经济更新 / rev-only 水位；不重复 settle/hold/冷却/completion |
| 14 | 目标 qty 原始小数 | 严格校验；99.99…9 / 100.00…1 不得成 100 |
| 15 | display 指数 | `1e21` 不 throw；`1e-21 * 1e21` 市值 1 |
| 16 | legacy / current V1 / `oldT > revision` / no-phase / stale | 全部按 §9 语义 |
| 17 | 100→90 progress | full startup 可 replay |
| 18 | A/B/C 反例 + **所有输入排列** | 已覆盖：§10 实际落地/验证（6 排列 + online 对照 + loader） |
| 18a | D：封存后合法同量金额修订 / 非法量增额降 | `10/90 -> 10/120 -> rev-only` 保存且 T 不变；`20/110` 拒 |
| 18b | D：B1/B2 双边界与三路一致 | B2 后 loss `-10`、无 B2 原 B1 仍 `-20`；ONLINE / SeatActivation / RESTART（含 B2 再次恢复）一致 |
| 18c | D：completion 后 durable 写失败 | recorder / Daily / progress / token / refresh / episode / completion 均不变；retry 一次写、重复不额外 |
| 19 | 故障注入 | 故障前**无半发布**（经济/durable 一致） |
| 20 | 全量回归 | 全量测试 + 架构约束检查 |

### 13.2 原 W5 命令（历史，离线、无凭证）

```bash
# W5 原批次实际执行（离线、无凭证）
bunx tsc -p tsconfig.json --noEmit      # exit 0
bunx eslint .                           # exit 0
bun test --no-env-file --no-install     # 3288 pass / 0 fail / 317 files
git diff --check                        # exit 0
```

- 原计划的 `bun run --no-env-file --no-install type-check|lint` 与上面 `bunx` 直调等价；原 W5 **历史串行结果**见 §13.4。
- 原 W5 未设 `APP_LOG_ROOT_DIR`；F03 最新全仓使用临时日志根与 `OfflineSdkGuard`（§14.2）。显式日志根触发的既有测试冲突已在干净基线复现，不能以去掉环境变量后的控制通过替代本轮最终全仓结果。

### 13.3 验收口径

- 安全 oracle 不得被削弱（不允许"删断言换绿"）。
- A/B/C 必须有反例测试，且反例与在线路径结果一致。
- 复审由**独立只读** reviewer 完成；本次 `REQUEST CHANGES` 已清除（A/B/C 关闭），后续任何新变更仍需独立复审后方可宣布验收。

### 13.4 原批次验收结果（历史快照）

> 下表仅记录原订单驱动修复批次，**不是本轮 F03 最终全仓结果**；最新结果见 §14.2 与[审计 F03 补记](./architecture-refactoring-full-chain-audit.md#f03-implementation-verification)。

| 项目 | 结果 |
| --- | --- |
| W5 `tsc` | `bunx tsc -p tsconfig.json --noEmit` → **exit 0** |
| W5 `eslint` | `bunx eslint .` → **exit 0** |
| W5 全量测试 | `bun test --no-env-file --no-install` → **3288 pass / 0 fail / 317 files**；套件 4 项 build pass |
| W5 diff 检查 | `git diff --check` → **exit 0** |
| A reviewer（原 P1 + 新增 D） | 同轮 **APPROVE**，原 P1 关闭；**195 pass / 11 files** + 真实链路 / terminal / crossday probes |
| B reviewer（优化） | **APPROVE**；**75 pass / 9 files** + **9 probes** |
| 二轮最小精简（本轮，§10.6） | 独立 minimality + 金融 review 均 **APPROVE**；旧 / 新差分 **0 差异**；金融定向 **161 pass**；受审两文件 SHA256 验证前后一致（已覆盖在本快照内） |
| financial 复审（历史轮次，仍有效） | 同轮 **APPROVE**；**240 pass / 12 files / 1484 assertions** + probes，无新 P0/P1/P2 |
| boundaries 复审（历史轮次，仍有效） | **APPROVE W4 两项**；**32 probes** |
| 残余引用 | src 对 `todayExecutions` / `historyExecutions` / `ledger` / `economics` / `evidence` 专用符号 **0 命中**；`recalculateFromAllOrders` / `selectLatestExecutionHistorySnapshot` 在 src / mock / tests **0 残留** |
| 环境 | `APP_LOG_ROOT_DIR` **未设**；无凭证、无实盘、未启动应用 |
| 代码状态 | HEAD `d2aa590…`；工作区 **178 项（152 M / 10 D / 16 untracked）**= 验收快照（不含非本任务的 AGENTS.md 单行策略改动）；**无 commit** |

> 以上为**原批次历史离线验收快照**，不构成“实盘已验证”或“未来无缺陷”的承诺。当时 3284 被 3288 取代，原批次二轮最小精简（§10.6）已覆盖在该快照内；两者都不能替代本轮 F03 的 **3418 pass／2 fail**。

---

## 14. 当前状态（最终）

### 14.1 原批次修复台账（历史）

> 注：本表记录**原订单驱动修复批次的验收状态**。“已修／关闭”指当时工作区变更与对应审查项关闭，不代表已提交；F03 本轮状态见 §14.2。

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| W2 | same/new rev 量降拒绝；无 rev zero 不能否认 known positive；knownT 完整 | 工作区已修；**原三项（量降 / 无 rev zero / knownT 完整）已复审关闭**（未提交） |
| W3 | 100→90 progress 可 replay；same-rev 两 phase 异 T 预检通过；execution 明细移除与归一化 | **原始反例已修且恢复模块复审通过**；A/B/C 已于同轮 financial **APPROVE** 关闭 |
| W4 | 原始 target qty 安全整数/display 展开；closed 经济合法修订恢复；durable 故障下全投影原状 + retry once | 工作区已修；**已列明审查项经复审关闭（仅 W4 两项）**（未提交） |
| W1 | 随修复恢复 | 当时已恢复，已纳入原批次全量（0 fail） |
| D（后续新增 P1） | 边界仅抑制 projection；同日权威 facts 仍 merge / 候选 / durable callback / publish；old baseline 不改、新 boundary 取修订 facts；跨日 / invalid / uninitialized 抑制保留 | **已关闭**：A reviewer 同轮 **APPROVE**（195 pass / 11 files + 真实链 / terminal / crossday probes）；真实 oracle 与 B1/B2 双边界均一致（未提交） |
| 优化（Opt） | 删 `recalculateFromAllOrders` 生产包装；测试专用 `tests/helpers/dailyLossRecalculation.ts`；`assertExecutionHistory` 直接返回已排序 latest 并删重复 selector；3 适配器注释清理（display 不改） | **已复审 APPROVE**（75 pass / 9 files + 9 probes）（未提交） |

### 14.2 F03 最终验证（最新快照）

- **全仓离线**：`bun --no-env-file test --preload ./tests/setup/testRuntime.ts`，启用 `OfflineSdkGuard`，使用临时 `APP_LOG_ROOT_DIR`；**320 files／3420 tests：3418 pass／2 fail，22767 assertions，330.48s**，不是全仓全绿。
- **失败基线复核**：干净 HEAD `353b621f46120dc20bf7aec57949c3f73234a83f` 临时快照的 852 个归档文件已逐 blob 核对，相同 Windows／Bun 1.3.14 下两项均重现，非 F03 新增。`tests/config/runtime/runtime.business.test.ts` 的硬编码默认日志根与显式 `APP_LOG_ROOT_DIR` 冲突，去掉环境变量的控制通过；`tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts:393` 的非法 UTF-8 已拒绝，实际 `Invalid byte sequence` 与测试 regex 不匹配。未修改这些无关测试。
- **检查与复审**：`lint:fix`、非修改 `lint`、`type-check`、`git diff --check` 通过；原两位 reviewer 对 §6.2 的首拒、closed 窄丢弃及 fatal 时序修复均已独立复验关闭，F03 无剩余代码发现。
- **边界**：未连接真实券商，未做“坏 callback → 实际 OS 进程 exit”的单体端到端；源码 `fatal → cleanup → exit(1)` 链已完整追踪。本轮仅覆盖 F03，不声称 F05 或全报告完成；较早定向批次不相加，详见[审计 F03 补记](./architecture-refactoring-full-chain-audit.md#f03-implementation-verification)。
- 账户负数数量仍按非负合同处理，**不**扩展 short 支持。

#### 14.2.1 历史验证（保留，**不作当前结论**）

- 原订单驱动批次 W5 的 **3288 pass／0 fail／317 files** 保留于 §13.4，不是 F03 本轮结果。
- 曾出现 `3225 pass / 0 fail`，但当时 review 发现反例，**当时未批准**——“全绿历史”**不等于**当期验收。
- 中间快照曾为 `3263 pass / 1 fail`（317 files），唯一失败为 `monotonicNeutralPhase` 断言；该失败在后续原 W5 快照中已消失。
- 原批次 **3284 pass**（317 files）后来被 3288 取代；两者均不得作为当前结论。
- W1 曾单独定向 `3 pass / 0 fail`，后纳入原批次全量。
- financial 曾多轮 `REQUEST CHANGES`（A/B/C），原批次验收时已同轮 APPROVE；请求修改仅作过程记录。

### 14.3 结论

**F03 本轮实施、全链路二审与原两位 reviewer 的独立复验均已完成，无剩余 F03 代码发现**；最终全仓仍有两项干净基线可重现的既有失败（§14.2），不宣告全仓全绿。原批次 A/B/C、W2/W4、P1-D 与优化验收记录保留为历史，不扩展为 F05 或全报告完成。因此：

- 不得据此宣称“实盘已验证”“坏 callback 至真实 OS 进程退出的单体端到端已验证”或“未来无 bug／无忧”；
- 生产启用仍需按 §15.1 / §15.3 谨慎推进。

---

## 15. 风险、能力边界与发布建议

### 15.1 能力边界（必须诚实声明）

- 不读逐笔明细 → **无法**精确还原跨日每笔成交；恢复只保证**订单级**语义。
- 历史 T 与 revision 分离是**被接受**的设计取舍，但矛盾**不得**被吞。
- 缺真实事实或无法安全恢复时，保持 fail-closed；**不假造** phase / amount / T。

### 15.2 主要风险（已关闭项仍作为回归风险保留）

| 风险 | 影响 | 缓解 / 现状 |
| --- | --- | --- |
| A（**已关闭**） | 若冻结 baseline 逻辑被改回"重选最高 rev"，当日亏损会偏移（`-10` vs `-20`） | 冻结 baseline + online/recalc 复用；双 `SEAT_REFRESH`（90→80→170）反例测试已入套 |
| B（**已关闭**） | 若回退为"必须有 progress"，baseline-only 普通 BUY 启动即失败并可能半发布 | 预检前置 + 私有候选内完成验证后才同步 publish；反例测试已入套 |
| C（**已关闭**） | 若重新引入组内极值/跨组 final 比较，会接受非法序列、拒绝合法序列 | 逐步共享 `mergeExecutionFact` + 最小历史校验；6 排列 + online 对照已入套 |
| D（**已关闭，新增 P1**） | 若把边界后同量修订再次连 rev 一并丢弃，会吞合法金额修订、影响新 boundary 与同日 loss（例：B2 后 `-10` vs `-20`） | 边界仅抑制 projection，权威 facts 仍 merge / 候选 / durable callback / publish；双边界 B1/B2 + RESTART 已入套 |
| 精度放宽 | 99.99…9 被卖成 100，超卖 | 窄点严格文本转换（保留） |
| US 泄漏 | 对 US pending 撤改/阻断 | 全链路 HK guard，market 判定前置（保留） |
| 测试换绿 | 安全 oracle 缺失 | 只迁移不删断言（保留） |
| **未实盘验证** | 历史离线全绿或本轮离线结果均**不能**代表真实撮合、时延、断线重连、券商侧异常下的行为 | 生产启用前保留观察期与回滚点（§15.3） |

### 15.3 发布建议

- 发布前：备份 durable 数据并**只读保留**；离线重放历史；F03 最新离线结果与边界以 §14.2 为准，§13.4 仅为原批次历史。
- **不得**自动清理日志、不得降级、不得以实盘试启动代替验证。
- 因**未实盘验证**：生产启用应谨慎推进（小规模/观察期/保留回滚点），不把历史全绿或本轮离线结果当作生产就绪证明。
- 出现未决业务选择时，聚焦用户决策，不擅自放宽契约。

---

## 16. 附录：关键代码与证据路径

> 行号随改动变化较大，以下只列**路径与定位锚点**（函数名/日志行内容），不写当前精确行号。

### 16.1 代码锚点（当前工作区）

| 主题 | 路径 | 锚点 |
| --- | --- | --- |
| 共享裁决 | `src/domain/order/executionFact.ts` | `mergeExecutionFact`、`mergeBrokerOrderExecutionFact` |
| 合并/投影 | `src/domain/order/orderFactMerge.ts`、`src/domain/order/executionProjection.ts` | stale / 投影规则 |
| 订单映射 | `src/infrastructure/longbridge/trade/orderMapper.ts` | `OrderFact` 构造、精确乘法 |
| 快照读取 | `src/infrastructure/longbridge/trade/orderSnapshotReadAdapter.ts` | HK guard → 归一事实 |
| pending | `src/infrastructure/longbridge/trade/pendingOrdersAdapter.ts` | US 无 mutation |
| push | `src/infrastructure/longbridge/trade/orderPushAdapter.ts` | `decode()` |
| detail | `src/infrastructure/longbridge/trade/orderDetailReadAdapter.ts` | `read(orderId)` |
| broker access | `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts` | 无 economics/ledger，deps=limiter |
| 客户端装配 | `src/infrastructure/longbridge/trade/clientFactory/index.ts` | 装配收敛 |
| 账户映射 | `src/infrastructure/longbridge/trade/accountMapper.ts` | finite/非负/小数 |
| 卖出读取 | `src/infrastructure/longbridge/trade/sellPositionReadAdapter.ts` | 目标 HK 文本 strict |
| 展示 | `src/infrastructure/display/accountDisplay/index.ts` | `String(number)`/指数 |
| 运行时 | `src/app/runtime/createTradeRuntime.ts`、`src/app/runtime/createPostGateRuntime.ts` | 装配移除 economics |
| startup 恢复 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts` | 预检 + 恢复 |
| 归一化 | `src/application/tradingDayRebuild/executionNormalization.ts` | 事实校验 |
| 追踪/录制 | `src/application/orderTracking/orderMonitor/{eventFlow,recoveryFlow,orderOps,orderStatusQuery,settlementFlow,types}.ts`、`src/application/orderTracking/recorder/index.ts` | 在线经济/保护 SELL |
| 席位刷新 | `src/application/seatActivation/index.ts` | `KEEP_KNOWN` |
| 当日亏损 | `src/domain/risk/dailyLossTracker.ts` | `buildDirectionBaselines`、`recordCumulativeExecution`、冻结 per-order baseline（A 已落地）；`persisted baseline does not match boundary fact`（B 的历史报错点，已修复） |
| 历史组裁决 | `src/domain/risk/executionHistory.ts` | 逐步 phase 裁决 + 最小历史 qty/amount 校验；`latestAmountOfGroup` **已删除**（C）；`assertExecutionHistory` 直接返回已排序 latest（selector 已删除） |
| 市场判定 | `src/utils/marketScope.ts` | `isHongKongSymbol` |
| 账户快照 | `src/application/accountPositionSnapshot/index.ts` | 精度 + HK 范围 |
| 提交/数量 | `src/application/orderExecution/submitFlow.ts`、`src/application/orderExecution/quantityResolver.ts` | 目标 qty 严校、HK-only |
| 配置校验 | `src/config/validator/utils.ts` | 市场/精度校验 |
| 末日清仓 | `src/application/doomsdayClearance/index.ts` | US 隔离 |
| 端口类型 | `src/types/{trade,brokerAccessPorts,brokerClientFactory,orderPushPorts,orderDetailReadPorts,orderSnapshotReadPorts,orderReadMetadata,orderRecorder,risk}.ts` | 冻结契约 |

### 16.2 已删除对象（工作区删除、未提交；不得复活）

- `src/domain/order/orderEconomics.ts`
- `src/types/orderEconomics.ts`
- `src/types/orderExecutionLedger.ts`
- `src/infrastructure/longbridge/trade/executionLedgerAdapter.ts`
- 推送侧 `inspect` / `ReadFact` / `PriceEvidence`

### 16.3 develop 证据与现场日志

| 证据 | 位置/取法 |
| --- | --- |
| 旧订单驱动实现（对照目标语义） | `git show develop:src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts`、`git show develop:src/infrastructure/longbridge/trade/orderMapper.ts`（按需逐点对照） |
| 回归引入点 | `4a148b3`（直接父为 `develop`） |
| develop 基线 | `6e239c8a128372bd9b2fb2d79464346792a5e81e` |
| 原订单驱动验收基线（历史） | `d2aa59054abac546f506b27df45f161afcfc6578` |
| F03 本轮基线 | `353b621f46120dc20bf7aec57949c3f73234a83f` |
| SDK 日志 | `logs/sdk/trade/2026-10-19.log` — 第 45 行 `historyOrders=42`、第 47 行 `todayOrders=0`、第 49 行 `historyExecutions=38`；首个失败成交在返回序列第 33 条 `SNDK.US qty=0.0006`，另有 `YANG 0.036`、`MSOS 0.2`、`GDXD 0.026` |
| 失败栈 | 本地 `mapBrokerExecutions` → `safeQuantityNumber` → `RangeError`（API `code 0`，非远端错误） |
| 离线集成验收说明 | `tests/integration/architectureRefactoringRecovery/README.md`（边界后仅抑制 projection；权威修订 / rev / durable 保存） |

### 16.4 只读核对说明

- 首次撰写时：仅做了路径与符号存在性的最小只读核对（`git status`、`git ls-files`、路由符号 grep、关键文件存在性），**未**运行测试/构建/lint、**未**修改业务或测试代码、**未**读取 `.env`、**未**启动应用或实盘、**未**切分支或 commit。
- 原批次最终状态更新时：仅回读与静态自检本文，**未**重跑测试／构建，**未**修改业务或测试代码；原验收数据保留于 §13.4。
- F03 文档收尾：仅核对并精确更新本文及两份全链路审计文档，未改 src／tests／skills，未重跑测试／构建／lint；只做文档一致性、链接与 `git diff --check` 检查，最终事实引用已确认的 §14.2 证据。
