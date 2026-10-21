# G5-RA01 独立二审：折叠历史来源、保护完成边界与 durable 自拒绝

## summary

- **verdict：G5-RA01 confirmed，建议保留 major。** 同量 revision／金额／阶段修订把既有 API 折叠历史的来源元数据覆盖为在线来源，确实是 develop 未有的回归。已独立证明：较早 boundary 不必由 fixture 直接指定，它可由真实保护成交 progress／episode 自然产生；真实 settlement 会因此写出缺 BUY baseline 的 JSONL completion，下一次真实 loader 恢复拒绝。
- **scope：只复核 G5-RA01**，不重做 G3 首审，不重新裁决 G5 的 V-C1/C4/C5。两版 DailyLoss 事实合并、在线事件准入、API 重建、保护 progress／episode、settlement、真实文件仓储、loader 恢复及必要重建连接均在本次范围内。
- **confidence：high（代码行为、两版同输入差分、离线真实 owner／durable／loader 链）；生产发生频率、实盘账户与 broker 实际时序为 not assessed。** 不是已发生生产事故的结论。
- 固定 current：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。固定 develop／origin/develop／FETCH_HEAD：`6e239c8a128372bd9b2fb2d79464346792a5e81e`。开始前与最终检查一致；最终 `git status --short` 为空。
- 全程没有修改仓库源码、测试、配置、方案，没有 checkout/reset，没有实盘调用或开启真实交易门禁，没有启动子代理。仅在用户允许的原 TEMP 目录写二审报告、独立探针、输出 JSON 和隔离 JSONL 数据。
- 模型核验边界：用户指定模板沿用 `cliproxyapi / gpt-6.1-sol / max`；本界面未暴露可独立核验的模型 ID／thinking 参数。首审报告所载子进程参数不能替代本次运行环境核验，故不宣称已验证实际服务端模型。

## critical issues

None。已确认的是错误冻结及 durable 自拒绝；没有证据把它升级为已发生严重错单或精确损失金额。

## major issues

### G5-RA01 — confirmed：同量修订丢失历史来源，允许写出自身无法恢复的 completion

- **claim**：同一个订单没有新增成交，合法推进 revision／金额／phase 时，只应更新共享事实裁决允许的累计经济字段和修订水位，不能将 API 折叠历史重新认定为“从零完整”，也不能抹掉已知可信 submittedAt。当前投影却这样做，绕过了已有 boundary 冻结保护。
- **当前根因位置**：`src/domain/risk/dailyLossTracker.ts:412–464`，尤其 `:457` 的 `...incoming`。
  - 在线构造器 `:300–317` 使用 `submittedAtMs: null`、`historyCompleteFromZero: true`。
  - API 构造器 `:350–370` 使用可信原始 submittedAt、`historyCompleteFromZero: false`。
  - 合并先把两者投影到共享 broker 累计事实，正确裁决数量／金额／T／revision／phase；但重新构造 DailyLoss 特有事实时，统一继承 incoming 的来源字段。共享裁决没有证明这些来源字段变得更可信。
- **develop 反证**：`src/core/riskController/dailyLossTracker.ts:517–545` 的同量高 revision 分支使用 `...current`；同 revision 的 OPEN→TERMINAL 金额修订在 `:453–476` 同样保留 `...current`。因此来源完整性和原始 submittedAt 保留。旧 `:1073–1104` 会在无法重建边界前快照时拒绝 freeze。
- **后续条件**：当前 `src/domain/risk/dailyLossTracker.ts:1057–1077` 只在“找不到边界前 snapshot、历史不完整、最后执行时间晚于边界”时拒绝 freeze。false 被覆盖为 true 后，缺 BUY 的空基线被接受；`:1139–1157` 恢复时则重新根据 raw API 的 false 及可信 submittedAt，拒绝同一份 completion。
- **runtime path**：SDK API snapshot → mapper／execution normalization → Daily prepare/publish 与 recorder rebuild → 在线 existing/tracked 事件 → recorder／Daily 累计事实共同准入 → 来源覆盖 → 真实保护 progress／episode → canonical flat 且无 pending protective → settlement Daily prepare → 同步 append completion → commit boundary／cooldown／episode → 新工厂重新读 JSONL＋原始订单 → loader 的 Daily 恢复预检拒绝。
- **impact — confirmed**：真实 owner 链在没有充分边界证据时提交 completion、完成 episode；durable completion 漏掉本应无法证明为零的 BUY 基线。新实例加载同一日志和最终 API 订单，抛出 `cannot reconstruct protection boundary baseline: orderId=BUY`，并且发生在 hold／seat 等后续发布之前。
- **impact — potential**：不充分证据进入经济分段及冷却投影，后续重启／受控重建阻断。未证明某笔实盘已算错多少损失，也不把“漏 BUY baseline”解释为每种经济输入必然产生同一风险偏移错误。
- **minimal fix**：在 DailyLoss 的共享合并结果投影处，保留已有事实的来源证据，至少确保 `executionAdvanced=false` 时不被 incoming 的默认来源覆盖。继续采用唯一 broker merge 的经济／时间／phase 裁决；不通过拒收合法 revision 来修补，也不为恢复删除严格检查。
- **validation**：两版同输入差分及真实 owner→JSONL→loader 探针均已独立执行，详见下文；长期回归应覆盖 API false → 同量修订 → 较早自然保护边界仍拒绝写 completion，以及所有成功写出的 completion 能由相同 final orders＋progress 恢复。
- **dimensions**：implementation、project/spec、type design、tests；来源注释／约束需明确，但不另立同根因 finding。

## 子项裁决

| 子项 | verdict | 独立依据及限定 |
|---|---|---|
| 同量 revision-only 把 false 覆盖为 true | **confirmed** | 两版真实 DailyLoss 工厂、同经济输入；旧仍拒绝较早 freeze，当前 ADMITTED 后返回空 baseline。 |
| 已知可信 submittedAt 被同量更新覆盖为 null | **confirmed** | 两个构造器＋唯一投影 `...incoming` 直接证明；旧 `...current` 保留。它是同一来源丢失根因的一部分，不另算第二个缺陷。 |
| 同 revision 的纯 phase 修订也应保留来源 | **confirmed** | 同量同金额 OPEN→TERMINAL 独立差分：旧拒绝，当前 ADMITTED／空 baseline。没有新增成交，不能恢复缺失的零点历史。 |
| 同量金额修订也暴露同一根因 | **confirmed** | 高 revision 的合法 100→90 金额修订，旧拒绝，当前空 baseline；不把合法金额修订本身判错。 |
| 每条同量观察都会丢来源 | **rejected** | 同 revision／同金额／同 phase 的完全重复，两版都维持拒绝；当前 DUPLICATE 早退，不执行新投影。 |
| 较早 boundary 必须人工传入、生产代码不能自然产生 | **rejected** | 真实保护 partial progress → 重启 loader 恢复 episode → 同量取消保留原 T → 普通 SELL 实际成交使 canonical flat；S 从 episode 推导较早 boundary。 |
| 较早 boundary 在生产实现路径中可达 | **confirmed（实现可达性）** | 真实 loader、正常席位恢复约束、真实 order monitor、真实执行器、S 和文件仓储均接受该合成但契约合法的序列。不是证明 broker 曾在实盘产生该序列。 |
| 真实 settlement 可写出缺 BUY 的 durable，且重启自拒绝 | **confirmed** | 使用真实 `createMixedTradeLogRepository` 写文件，不是 append double；新实例／新 Daily／新 repo 运行真实 loader，读取到同一 completion 后拒绝。 |
| 首审直接指定 boundary 的模块 probe 已足以证明生产到达 | **rejected（证明力度不足）** | 该 probe 可以证明合并／freeze 差分，不能单独证明边界来源。本次另建自然边界链，不把重跑原 probe 计作独立生产验证。 |
| 所有数量推进分支均是本次新增回归 | **rejected** | develop `:493–507`、`:555` 起也采用 incoming。此次只确认无新增成交的修订分支回归，不改写旧缺口归因。 |
| 已发生实盘事故、真实出现频率、精确资金损失、应升 critical | **insufficient** | 没有接入 broker／实盘资料；不得把合成输入可达性扩写为生产事故事实。 |

## 独立证据 A：两版同输入事实合并

新建的 `recheck-risk-boundary-differential.ts` 没有调用首审探针。current 直接导入真实工厂；develop 从固定 SHA 读取并通过 TypeScript CommonJS 内存 loader 加载真实工厂及其过滤／归属／转换依赖，没有 checkout、复制旧逻辑或覆写当前模块。仅 logger 以无副作用能力替代。

共同经济输入：当日 API BUY，委托 200、累计成交 100、累计金额 100，submittedAt=`T−1000`，API 最后执行代理及 revision=`T+2000`，初始 OPEN。目标 boundary=`T+1000`。两版初始 freeze 都拒绝。

| 在线观察 | develop | current |
|---|---|---|
| 完全重复 | 仍拒绝 | DUPLICATE，仍拒绝 |
| 同量同额，revision→`T+3000` | 仍拒绝 | ADMITTED、无 execution advance、空 baseline |
| 同量同额同 revision，OPEN→TERMINAL | 仍拒绝 | ADMITTED、空 baseline |
| 同量，revision→`T+3000`，金额→90 | 仍拒绝 | ADMITTED、空 baseline |

这里直接调用 freeze 是有意的模块差分，**本节不据此声称较早 boundary 已生产可达**。生产边界来源由下一节独立证明。

### 为什么应保留来源

`historyCompleteFromZero=false` 表示已见累计值之前的历史不可从当前快照还原。一次无新增成交的 revision／phase 更新并没有补回缺失历史；反而通常仍是同一累计值。可信 submittedAt 是订单创建时间证据，也不会因后来一条缺该字段的观察而失效。

当前共享 merge 已正确保留同量更新的 known T：`src/domain/order/executionFact.ts:124–157`。但该函数的输入／输出只有 broker 经济事实，没有 `submittedAtMs` 和 `historyCompleteFromZero`。不能把“共享 merge 合法接受”误读为“DailyLoss 的来源也已经被共享 merge 升级”。

## 独立证据 B：不手工指定完成 boundary 的真实链路

### B1：晚到保护全成单，作为简短控制组

- API 重建 BUY100，累计执行代理=`T+2000`，保护 SELL 查询暂为零成交 pending。
- 收到 BUY 同量高 revision（实验组）或不收到（控制组）。
- 随后收到真实 SDK fixture 映射的保护 SELL Filled100，订单 updatedAt=`T+1000`。账户 read port 返回 flat；真实 monitor 清除 pending，记录 progress／episode；真实 S 推导并尝试完成。
- 没有 BUY revision 的控制组：prepare 拒绝、completion=0、termination 锁存。
- 加 BUY revision 的实验组：completion=1，只有保护 SELL baseline；新 loader 重启拒绝 BUY。

这一组允许查询快照与迟到推送不同步；单独使用它仍会留下 broker 查询时序的疑问，因此增加了 B2，不把本组作为唯一生产可达依据。

### B2：已有真实 progress，经重启 loader 恢复，取消保护余单后由真实执行器平余仓

设 `T=2026-03-13T02:00:00Z`。以下时间均来自合成 SDK 委托／推送字段或时钟端口，**没有调用 prepareProtectionBoundary、restoreInProgressEpisode 或 completeProtectionRecovery 去直接指定一个待完成时间**。生产 loader 内部自己的恢复调用不算 fixture 绕过。

1. **前一进程，T+900：** API 有 BUY100／金额100，原 BUY 的执行代理 T；有保护 SELL100 pending，提交于 T+500。用真实 recorder rebuild、Daily prepare/publish、真实 monitor 恢复追踪。
2. **T+1000：** SDK fixture 发送保护 SELL 部分成交50／金额45。真实 monitor／Daily 准入，通过真实 repository 写出 OPEN progress，`lastExecutionTimeMs=T+1000`；没有 completion。停止该实例。
3. **新进程，T+2500：** API BUY 仍成交100／金额100，但其最终订单 revision 为 T+2000；普通 BUY 没有 protective durable history，API 归一代理变成 T+2000，Daily 来源为 false。保护 SELL 为 partial50，其已有真实 progress 把执行 T 保持在 T+1000。canonical 仓位50、available0；保护 SELL 仍 pending。
   - **执行真实 `createLoadTradingDayRuntimeSnapshot`，结果 COMMITTED。** 它实际读取前一实例 JSONL、校验 progress、恢复 Daily 和 in-progress episode；不会因仓位未平／保护 pending 而生成 completion。
   - 随后按真实重建所用接口做 recorder REBUILD、`commitRebuiltSeatActivation`、`recoverOrderTrackingFromSnapshot`，再进入正常 S。没有跳过 pending SELL 的席位匹配要求。
4. **T+3000：** 实验组发送 BUY100／金额100／Filled、仅 revision 推进的 SDK 观察；控制组不发。真实 closed-existing 事件路径被接受，recorder 中 BUY 的 T 仍是 T+2000、revision 在实验组变为 T+3000。此时仍有仓位50、保护 pending，不会提前完成。
5. **T+3200：** 保护 SELL 同量50取消。共享 merge 保留既有执行时间 T+1000，revision 推进到 T+3200，真实 monitor 追加 TERMINAL progress。进行中 episode 的 latestExecutedTimeMs 仍是 T+1000。
6. **T+3500：** 账户提供剩余 quantity=available=50。使用 fixture 提供的**真实生产执行器**提交普通 ELO SELL50，真实返回 ACK `ORDINARY`，native mutation 为唯一一次 SUBMIT50／价格1；不是直接手写 recorder／monitor 成交。SDK／API 能力均为内存 fixture，没有真实网络 submit。
7. **T+4000：** SDK 发送该普通 SELL Filled50／价格1；账户真实 read-port fixture 返回 flat。普通 SELL 不推进保护 episode 的时间。真实 O／Daily 登记 stale，S 刷新账户和持仓；最终 flat／无 pending protective 条件均由真实模块判断。
8. **S 自行推导 boundary=T+1000：** `episode.prepareCompletion` 用的正是 latest protective execution，不是当前时钟 T+4000、取消 revision T+3200 或普通卖出 T+4000。
   - 控制组：BUY 仍是折叠历史，S 在 prepare 抛“无法精确冻结”，completion=0。
   - 实验组：BUY 来源已被覆盖，S 成功写 completion；baseline 只有 PL50／金额45，缺 BUY。普通 SELL 是 boundary 后创建／执行，不把其正常零基线遗漏与 BUY 的错误遗漏混为一谈。
9. **再启一个全新实例，T+5000：** 用同一实际 JSONL、最终 BUY／PL／ORDINARY API 订单、全新 Daily／recorder／episode／repo，执行真实 loader。得到：

```text
[DailyLossTracker] cannot reconstruct protection boundary baseline: orderId=BUY
loadedCompletions=1, loadedProgress=2
holdsSeed=0, seatsDispatch=0, recoveryCalls=0, hydrateCalls=0
```

**因此，不能以“当前最终持仓已经 flat，所以较早边界不可能存在”反驳本项。** flat 是完成资格；boundary 是最后一次保护成交的时间。正常的保护单同量取消与后续普通平仓，使两者不相等，在当前生产规则下合法。若另有业务授权要求用其他完成时间，应另行裁决；本次没有建议篡改该规则来掩盖来源缺失。

### B2 的可达性与未证明的事

- API 的 `executionTimeMs` 是 updatedAt 代理，不等于实物成交一定发生于该时间。BUY 已在保护部分卖出前获得100仓位，与重启后其 API revision=`T+2000` 并不矛盾；前一进程已知 T 不会自动 durable 到普通 BUY，重启后得到折叠代理恰是该保护的用武之地。
- 现有输入契约、mapper、共享 merge、pending／seat 匹配、真实执行器和 S 门禁未拒绝该序列；这证明**实现可达性**。没有读取 broker 历史，故没有证明 Longbridge 在真实账户的此类 revision 更新频率，或本案时序已经发生。
- 初始 API 及账户、时钟、行情、ACK 由离线 SDK fixture 提供；`createLoadTradingDayRuntimeSnapshot`、合并／记账／settlement、文件仓储均是真实实现。没有声称运行了完整 app 进程的全部启动、风险刷新和跨 owner 并发交错。

## 关键调用链及精确证据

| 环节 | current 证据 | 本次核实内容 |
|---|---|---|
| API 中性映射 | `src/infrastructure/longbridge/trade/orderMapper.ts:117–142` | 金额由原始价量产生；正成交 T 为订单 updatedAt 代理；保留原始 submittedAt。 |
| API 来源 | `src/domain/risk/dailyLossTracker.ts:350–370` | 来源 false，可信 submittedAt；不是在线历史。 |
| 在线来源／合并 | 同文件 `:300–317,412–464` | 在线默认 true/null；经济 merge 后 `...incoming` 覆盖来源。 |
| 已关闭订单仍接受修订 | `src/application/orderTracking/orderMonitor/eventFlow.ts:95–205` | recorder 已有事实即可走 existing 路径；归属／价量校验保留；调用同一累计 owner，不重建终态资源。 |
| broker 经济裁决 | `src/domain/order/executionFact.ts:78–157` | 同量修订保留 known T；phase regression／经济冲突继续拒绝。 |
| recorder／Daily 同步准入 | `src/application/orderTracking/orderMonitor/settlementFlow.ts:150–205` | recorder commit 的回调调用 Daily；不是两个彼此无关的测试 ledger。 |
| protective durable／episode | 同文件 `:77–148` | progress 用 Daily 裁决后的可信执行时间写入；episode 来源为真实保护成交。 |
| boundary 的自然来源 | `src/domain/liquidation/episode/index.ts:83–105` | flat 且无 pending 才可完成，返回 inProgress.latestExecutedTimeMs。 |
| 正常完成事务 | `src/application/postTradeSettlement/index.ts:140–199` | 双重当前身份／flat／pending 复核 → Daily prepare → append completion → commit boundary → cooldown／episode。 |
| 文件落盘 | `src/infrastructure/persistence/mixedTradeLogRepository/index.ts:792–820,879–932` | completion/progress 幂等接口实际调用 JSONL append；实验用自有 TEMP root，新工厂重读。 |
| loader 恢复预检 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:487–521` | progress＋baseline＋API final 归一／历史校验；Daily 纯预检在 seed holds／seat 前。 |
| 正式发布／保护恢复 | 同文件 `:703–738` | Daily publish 后恢复进行中 episode，调用真实 protection recovery；B2 第一次重启实跑经过，最后一次自拒绝发生在到达此处之前。 |
| 重建接线 | `src/application/tradingDayRebuild/rebuildTradingDayState.ts:99–103,377–421` | O REBUILD、席位激活提交、monitor 恢复顺序与 B2 使用的真实接口相符；未宣称 B2 跑完整风险刷新 workflow。 |
| 激活兄弟入口 | `src/application/seatActivation/index.ts:380` 起 Daily prepare 及其同步提交段 | 同根因可由 API 重建产生；本次没有单独跑完整 SEAT_REFRESH 复现。 |

### 旧实现归因限制

- 两版工厂同输入执行已经证实**无新增成交的修订**差分；旧 `...current` 保留来源，拒绝同样较早 freeze。
- develop 数量真正增长时已有 incoming 覆盖，不将该旧缺口计为本次新增。对数量增长是否也必须保留来源，可后续另开历史问题，不在这项修复里未经论证扩大政策。
- 本次完整 owner／JSONL／loader 闭环执行的是 current；没有宣称运行了 develop 完整 app 或旧 durable 全链。current 中“唯一多一条 BUY revision”的控制／实验对照，与旧/新真实工厂差分共同提供因果证据。

## 最小修复与验证建议

1. **修共享根因，而不是下游补丁**：DailyLoss 重建 nextFact 时把来源元数据与 broker 经济裁决区分。已有事实且没有 execution advance 时保留已有 `historyCompleteFromZero`、已知 `submittedAtMs`；只更新共享 merge 授权的经济字段、水位和 snapshot。
2. 不把“已收到一次累计观察”当作完整历史。只有额外可验证的完整历史恢复才可提升来源可信度；不要仅凭 ADMITTED／phase TERMINAL 提升。
3. 保留 prepare 和恢复拒绝。不能填0 baseline、借别单金额、把 boundary 挪成 now、删 durable 记录或忽略 BUY 来使恢复通过。已有可疑 durable 的处理需要按真实历史对账，不能由此次只读审计自动修库。
4. 增加参数化回归：API false/可信 submittedAt → duplicate／revision-only／amount／OPEN→TERMINAL。duplicate 保持幂等，合法修订仍准入，但没有补充历史时较早 freeze 应继续拒绝。
5. 保留 B2 一类真实 owner 闭环：保护 partial progress → loader → 同量取消 → 普通 SELL ACK/成交／canonical flat → S。失败时 completion=0；成功 completion 必须能被全新 loader 和同一 final orders＋progress 恢复。
6. 同时保留正常在线完整历史、已有准确 durable baseline、可信 submittedAt 严格晚于 boundary 的恢复正向场景，避免为修本项而全局禁止合法同量更新或删除零基线证明。

## 验证记录与复现

外部目录：
`C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`

### 独立探针

```powershell
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/recheck-risk-boundary-differential.ts
bun run C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/recheck-risk-boundary-probe.ts
```

- 两份最终探针均实际运行 **exit=0，stderr=0 bytes**。不是未执行示例。
- differential：4种观察 × 2版本，共8组断言；探针 SHA256：`b5fbc460ba969148c8f89f4ea3d144d1ecc8ac9cc0f38f777b400e4100fd8072`。
- production-chain probe：晚到全成单／partial恢复后普通平仓，各自有无 BUY revision，共4组链路；实验组均写缺 BUY completion并重启拒绝，控制组均不写completion。探针 SHA256：`33b039ab431040227abc193695b3385a7642d30a6059336e646a2b7042c6b541`。
- 原始输出：`recheck-risk-boundary-differential.json`、`recheck-risk-boundary-probe.json`。最终一轮实际 JSONL root：`recheck-risk-boundary-data-1792517390554/`，其中包含各隔离 case。再次运行会创建新的毫秒后缀目录，不覆盖仓库或已有记录。
- B1 两组 native mutation 均0；B2 两组均恰好1次内存 SDK SUBMIT50／价格1，无 native cancel／replace。保护 cancel 是输入的权威 SDK 终态观察，不冒充本探针实际调用 broker cancel。

### 相称的离线回归

```powershell
bun test tests/domain/risk/dailyLossTracker.segment.business.test.ts tests/domain/risk/dailyLossDurableDuplicate.test.ts tests/domain/risk/dailyLossRebuildPreparation.test.ts tests/domain/liquidation/episode/protectiveLiquidationEpisodeTracker.business.test.ts tests/integration/dailyLossAmountRevision.integration.test.ts tests/integration/orderMonitorDailyLossMonotonic.integration.test.ts tests/application/postTradeSettlement tests/integration/architectureRefactoringRecovery
```

实际：**188 pass / 0 fail / 1096 expect() calls / 12 files / 722ms，exit=0**。没有与 G3 或首审重叠测试相加，也没有重跑两版全量 typecheck／lint 后声称等价。现有回归全绿不消除本项独立差分。

### 现有测试的保护与缺口

- `tests/domain/risk/dailyLossTracker.segment.business.test.ts:815` 起正确验证“折叠跨边界 BUY 缺 completion baseline 时恢复拒绝”。
- 同文件 `:1116` 起的同量终态水位测试从**在线**记录创建事实，来源本来就是 true；`:1329` 起金额修订测试同样在线起步。它们没有覆盖 API false 经一次无成交更新被提升的组合。
- `tests/application/postTradeSettlement/protectionRecovery.test.ts:32–55` 的完成时间来自 fixture 恢复 episode，可测事务顺序，但不能单独证明较早 boundary 自然来源。本次没有照搬这个时间注入方式作为生产可达证据。
- 本次定向阅读／搜索和188项测试未提供上述组合的长期保护；这是本次范围结论，不声称全仓绝无任何类似测试。

## minor issues

None。没有另立风格、重复注释或未经证明的 dead code 问题。

## positive findings

- 共享 broker merge 保留同量 known T、拒绝经济和 phase 倒退，是应保留的正确约束，问题不在“接受合法 revision”本身。
- S 在真实持仓 flat／无保护 pending 后，还复核 token、seat identity 和 episode，再同步 append→commit，避免在等待中以旧资格完成。本次没有为复现绕过这些检查。
- loader 的纯 Daily 恢复预检在 holds／seat 发布之前，确实将可疑 durable 拒绝在半发布之前；不应为让故障数据启动而删除它。
- 同 revision／同量／同金额／同 phase 重复幂等，独立控制组证明并非每次观察都会抹来源。

## 七维审查与覆盖边界

| 维度 | 本次结论 |
|---|---|
| Implementation | 已深读两版 DailyLoss 构造、合并、freeze／restore 关键分支，以及当前事件→O/Daily→progress／episode→S→durable→loader 对应路径；确认同根因一项。 |
| Project and Spec | 加载仓库指令及适用 skills；旧源码为等价真值，当前类型、测试、注释和事实一致性政策不能授权“缺失历史变完整”。未修改方案。 |
| Type Design | DailyLossOrderFact 同时携带来源和经济事实，broker merge 只覆盖后者；readonly 不阻止 object spread 覆盖来源。建议明确保留规则，不要求引入新框架或复杂类型体系。 |
| Tests | 8组两版差分、4组真实 owner链、188项相关回归；指出 API来源×同量修订×自然早边界组合缺口。 |
| Comments | `dailyLossTracker.ts:1045` 声明无法精确还原应阻断，与现象矛盾；不是建议删注释，而是修复来源保真。来源合并的 why 需保留。未审全仓注释。 |
| Dead Code | 相关导出有真实生产消费者，`prepareProtectionBoundary` 的生产调用在 S `:167`；未发现该范围可确认的 dead code，不建议删除。未做动态注册／反射穷尽。 |
| Simplification | 在既有 DailyLoss 投影点修来源，继续复用共享累计裁决及既有 S/loader；无证据建议新增 reconciliation 框架、删安全 gate 或合并 owners。 |

本次**深读的是上述具名函数／关键分支**，不是全文件或全 G5 的覆盖承诺。`mixedTradeLogRepository` 深读 append／load／文件指纹相关分支；完整留存／损坏恢复策略未穷尽。`rebuildTradingDayState`、`seatActivation`、app runtime 装配及 fixture 为必要局部阅读／连接核对；自动加载的依赖不冒称人工全量深读。旧源码除 DailyLoss 及其归属／转换依赖外，未完整重跑旧 app。

## not assessed

- Longbridge 真实数据中 Filled 订单同量高 revision 的出现频率、查询一致性及该序列是否发生过；无实盘日志／账户接入。
- 完整 app 进程的全部启动/停机、风险检查、错误分层及所有并发交错；离线链使用真实核心 owners 和合成外部端口，不是生产演练。
- 已有真实 durable 的逐笔资金恢复或自动迁移；此次没有改库或提出绕过校验。
- 原有数量推进分支的来源完整性历史缺口；已明确排除本次新增归因，若要修需单独论证。
- 当前闭环错误之外的精确 loss/cooldown 数值后果、严重资金损失及 critical 评级；不得仅由一份缺 baseline 的 completion 推断。
- 此次未执行两版完整 typecheck／lint／full test；只读二审没有运行 `lint:fix`。

## recommended next actions

1. 主代理可将 **G5-RA01 的代码回归、自然边界实现可达性、真实 durable／loader 自拒绝**标为已获独立复核；保留“无生产事故证据”限定，不再仅写待他人验证的局部 probe。
2. 如获实施授权，在 DailyLoss 事实合并投影处保留来源元数据，先落上述组合回归；不要以禁止合法 revision 或更改 boundary 时间替代根因修复。
3. 发布前按真实历史对账普通 BUY／SELL 与 protective progress／completion；离线可复现不替代实际 durable 恢复验收。

> 本报告独立于首审生成。没有修改 `audit-risk-account.md` 的首审／候选状态，以免替主代理改写其它组交付；主代理可据此统一更新总报告。
