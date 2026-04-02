# 单指数趋势延续重构四次复核问题记录

**日期**：2026-04-02 **复核范围**：当前工作区实现 + `docs/current-program-business-and-functional-spec.md` + `docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md` **额外前提**：本次复核纳入用户补充口径——**距回收价清仓不应计入保护性清仓冷却计数**。 **边界说明**：按用户要求，测试架构问题本轮不再立项；只保留“二次复核后仍证据充分且有记录必要”的问题。

---

## 结论先行

本次四次复核后，结论相对上一轮有以下调整：

1. **上一轮提出的 critical issue（“距回收价清仓被错误实现为非保护性清仓”）应撤销。**
2. 当前实现把 `LIQUIDATION_DISTANCE_CHECK` 作为**独立风险性清仓路径**处理，而不是保护性清仓完成/冷却/分段边界链路的一部分；在纳入用户补充口径后，这一实现是**有意为之且内部自洽**的。
3. 但当前仓库内两份高层文档对这条语义的定义**存在明确冲突**，因此需要正式记录并修正文档基线。
4. 此外，上一轮提到的 **X2、X3 虽不构成当前运行时错误，但确属单实例重构的收尾遗漏，仍应作为正式问题修复**。

因此，本次四次复核后应保留为正式问题的共有三项：

1. **业务基线文档对“距回收价清仓”语义定义冲突，必须统一**
2. **单实例已成立，但仍保留单元素数组 API 壳，属于重构遗漏，必须修复**
3. **`startupRebuildPending` 分支仍先做运行时标的校验计算再忽略结果，属于重构遗漏，必须修复**

以下候选项经本轮复核后，仍不作为正式问题立项：

1. **`seatMode` / `longSymbol` / `shortSymbol` 的类型不变量表达较弱**：真实存在，但当前更准确地属于类型收敛问题；在已有 fail-fast validator 的前提下，尚不足以按本轮正式问题立项

---

## 正式问题（本轮保留）

### 问题 A：业务基线文档对“距回收价清仓”语义定义冲突，必须统一

**严重级别**：中高 **问题类型**：规格/文档基线冲突 **当前判断**：需要修正文档基线；当前实现本身不按问题立项

#### 1. 冲突位置

**文档 A：当前业务逻辑说明**

`docs/current-program-business-and-functional-spec.md` 明确写到：

- `15.3 保护性清仓的主要触发源`：
  - `未实现亏损超阈值`
  - `执行标的距离回收价进入危险阈值`
  - 证据：`docs/current-program-business-and-functional-spec.md:659-665`
- `15.4 保护性清仓的业务语义`：
  - 完成后会触发交易后刷新、冷却统计和日内亏损分段边界推进
  - 证据：`docs/current-program-business-and-functional-spec.md:666-675`
- `26. 迁移时必须完整保留的功能清单`：
  - 列出了“距回收价保护性清仓”“保护性清仓冷却和恢复”
  - 证据：`docs/current-program-business-and-functional-spec.md:1009-1013`

这份文档的直接语义是：**距回收价危险阈值触发的清仓，属于保护性清仓事件链路的一部分。**

**文档 B：重构方案**

`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md` 则明确给了另一套定义：

- `静态模式继续保留独立的距回收价清仓；自动模式继续由换标和保护性清仓共同覆盖。`
  - 证据：`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:640`
- `风险性清仓路径` 中把三类路径分开：
  1. 保护性清仓：保留独立触发、完成确认、冷却与亏损分段推进链路
  2. 末日保护
  3. 距回收价清仓：仅在静态模式保留独立 `LIQUIDATION_DISTANCE_CHECK` 路径
  - 证据：`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:696-703`
- 同文还明确说：
  - `OPEN_PROTECTION` 不阻断“静态标的距回收价清仓和其他风险任务”
  - 证据：`docs/plans/2026-03/2026-03-28-single-index-trend-continuation-rebuild-plan.md:303-305`

这份方案文档的直接语义是：**静态标的距回收价清仓是独立风险路径，不并入保护性清仓完成/冷却/分段边界链路。**

#### 2. 当前实现站在哪一边

当前代码实现明确站在**重构方案**这一边，而不是业务说明文档 A 这一边。

核心证据：

1. `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts:82-91`
   - 距回收价清仓信号会被显式构造为：
   - `signal.isProtectiveLiquidation = false`

2. `src/core/trader/orderMonitor/settlementFlow.ts:179-185`
   - 只有 `isProtectiveLiquidation && SELL` 才会调用：
   - `protectiveLiquidationEpisodeTracker.recordProtectiveFillProgress(...)`

3. `src/main/asyncProgram/postTradeRefresher/index.ts:148-178`
   - 只有 protective episode tracker 中“进行中的保护性事件”完成后，才会：
   - `dailyLossTracker.startNewProtectionEpisode(...)`
   - `liquidationCooldownTracker.recordLiquidationTrigger(...)`

4. `src/services/liquidationCooldown/index.ts:23-26`
   - 注释已明确：`recordLiquidationTrigger 仅在“保护性清仓事件完成”时调用一次`

5. `src/core/trader/orderMonitor/index.ts:231-259`
   - `hasPendingProtectiveLiquidationOrders(...)` 只看 `trackedOrder.isProtectiveLiquidation === true` 的卖单
   - 这进一步说明“距回收价清仓”并未被纳入 protective pending 集合

结合用户本次明确补充的业务口径：

> 距保护价清仓不应视为清仓冷却计数。

可以确认：

- 当前实现**不是误实现**；
- 当前实现是在贯彻“独立风险性清仓路径”的设计；
- 真正有问题的是两份高层文档没有统一，导致对同一语义给出了互相冲突的业务基线。

#### 3. 为什么这仍然必须记录

虽然这不是代码 bug，但它仍然必须记录，因为它会直接影响后续所有审查、重构和恢复口径判断：

1. 后续 reviewer 很容易依据 `current-program-business-and-functional-spec.md` 把当前实现误判为逻辑错误。
2. 若未来有人只按业务说明文档补功能，可能会错误地把 `LIQUIDATION_DISTANCE_CHECK` 接回 protective episode / cooldown / daily loss segment 链路。
3. 启动恢复、交易日志解释、保护性边界回放等语义都会因为基线不一致而继续产生歧义。

#### 4. 本轮复核结论

- **问题真实存在**
- **证据充分**
- **需要记录并修正文档基线**
- **当前实现本身不按 bug 立项**

#### 5. 修复边界

本问题的修复对象应是**文档基线**，不是立即改代码。

必须二选一并统一全仓口径：

1. **若当前实现与用户口径为准**：
   - 则应修正 `docs/current-program-business-and-functional-spec.md` 中关于“距回收价保护性清仓”的表述；
   - 明确把它改写为：静态模式下的独立风险性清仓路径，不计入保护性清仓冷却计数，不推进保护性分段边界。

2. **若未来决定以旧业务说明文档为准**：
   - 则需要重新设计并改代码，把 `LIQUIDATION_DISTANCE_CHECK` 正式接入 protective episode / cooldown / daily loss segment 链路。

基于当前代码、重构方案与用户补充口径，本轮更合理的结论是：

> **应修正文档 A，使其与当前实现和重构方案保持一致。**

---

### 问题 B：单实例已成立，但仍保留单元素数组 API 壳，属于重构遗漏，必须修复

**严重级别**：中 **问题类型**：重构收尾遗漏 / 接口形状未收敛 **当前判断**：不构成当前运行时错误，但属于应修复的重构遗漏

#### 1. 证据

当前仍保留多实例时代的数组接口形状：

- `src/app/runtime/createPreGateRuntime.ts:46`
  - `createSymbolRegistry([monitorConfig])`
- `src/services/autoSymbolManager/utils.ts:299-304`
  - `createSymbolRegistry(monitors: ReadonlyArray<StrategyRuntimeConfig>)`
  - 内部再强约束 `monitors.length === 1`
- `src/main/utils.ts:63-87`
  - `collectRuntimeQuoteSymbols(monitorConfigs: ReadonlyArray<...>)`
- `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:616-621`
  - `collectRuntimeQuoteSymbols([monitorConfig], ...)`

#### 2. 为什么本轮改为正式问题

上一轮把这条仅作为“噪音”处理，是因为它尚未造成已证实的运行时错误。这个判断在“是否为当前 bug”上没有错，但不足以覆盖你的要求。

从重构完成度角度看，这条确实应当立项，原因是：

1. 重构目标已经明确从多 monitor 收敛到单实例根模型；
2. 当前接口仍保留“数组外壳 + 内部再断言只能有 1 项”的过渡形态；
3. 这说明重构没有在接口边界彻底收口，而是保留了历史结构的影子；
4. 它会持续误导后续维护者，让“单实例是否只是当前实现，还是正式架构边界”变得模糊。

因此它虽然不是当前逻辑错误，但仍属于：

> **重构未完成、边界未彻底收敛的正式遗漏。**

#### 3. 本轮复核结论

- **问题真实存在**
- **证据充分**
- **当前未见已触发的运行时错误**
- **但仍应作为正式问题修复**

#### 4. 修复边界

应把相关接口直接收敛到真实单实例形状，而不是继续保留单元素数组壳。

至少包括：

1. `createSymbolRegistry(...)` 的入参形状
2. `collectRuntimeQuoteSymbols(...)` 的入参形状
3. 相关调用点与注释中的“monitorConfigs / monitors”历史表述

---

### 问题 C：`startupRebuildPending` 分支仍先做运行时标的校验计算再忽略结果，属于重构遗漏，必须修复

**严重级别**：中 **问题类型**：重构收尾遗漏 / 实现边界不干净 **当前判断**：不构成当前业务错误，但属于应修复的重构遗漏

#### 1. 证据

在 `src/app/runApp.ts:106-139` 中：

1. 启动快照加载后，会先构建 `runtimeValidationCollector`
2. 然后执行 `runtimeValidationResult = validateRuntimeSymbols(...)`
3. 但若 `startupSnapshot.startupRebuildPending` 为 `true`，又会直接：
   - 打日志：`启动快照失败，跳过运行时标的验证，等待生命周期重建恢复`
   - 实际上并不使用上一步校验结果去中止启动

也就是说，当前实现行为是：

- **语义上跳过校验**
- **实现上仍先把校验算了一遍**

#### 2. 为什么本轮改为正式问题

这条问题上一轮被我降成“噪音”，是因为它不会造成错误启动决策：

- `startupRebuildPending=true` 时，程序仍会进入等待开盘重建恢复分支；
- 不会因为该校验失败而错误中止。

但从重构质量和实现完整性看，它确实属于遗漏：

1. 日志语义与执行路径不完全一致；
2. 会让阅读者误以为该分支仍依赖运行时标的校验；
3. 体现出“启动快照失败恢复分支”的边界没有被彻底整理干净；
4. 这不是业务 bug，但确实是重构未收尾的实现残留。

因此它应从“仅噪音”提升为：

> **需要修复的正式重构遗漏。**

#### 3. 本轮复核结论

- **问题真实存在**
- **证据充分**
- **不会导致当前错误运行**
- **但仍应作为正式问题修复**

#### 4. 修复边界

应让 `startupRebuildPending` 分支的实现与语义完全对齐：

1. 要么在该分支下不再提前做运行时标的校验计算；
2. 要么调整结构，让“跳过校验”的边界更明确，不留下“先算再忽略”的残留路径。

---

## 本轮撤销的问题

### 撤销项：上一轮关于“距回收价清仓实现错误”的 critical issue

#### 撤销原因

上一轮把以下现象视为实现错误：

- `src/main/asyncProgram/monitorTaskProcessor/handlers/liquidationDistance.ts:90` 中 `signal.isProtectiveLiquidation = false`

在仅参考 `docs/current-program-business-and-functional-spec.md` 的情况下，这个判断表面上成立；但本轮复核纳入：

1. 用户明确业务口径：**距保护价清仓不应计入冷却**；
2. 重构方案文档对该路径有独立定义；
3. 保护性事件完成/冷却/分段链路的当前实现与该独立定义完全一致。

因此应撤销上一轮的实现级问题判断。

#### 修正后的正确表述

更准确的表述应为：

- **当前实现没有证据显示“做错了”；**
- **真正的问题是高层文档之间的业务基线冲突。**

---

## 已复核但本轮仍不立项的问题

### X1：`seatMode` / `longSymbol` / `shortSymbol` 的类型不变量表达较弱

#### 复核结论

**本轮仍不立项。**

#### 原因

这条问题在类型设计层面是真实存在的：

- `src/types/config.ts` 中 `StrategyConfig` 没有建成强判别联合；
- `src/config/trading/runtime.ts:105-107` 会把 `null` 投影成空字符串；

但继续复核后可以确认：

1. 外部配置属于信任边界，本项目已经用 `validateAllConfig()` 做了严格 fail-fast 校验：`src/config/validator/index.ts:1092-1126`
2. `SEAT_MODE=static` / `SEAT_MODE=auto` 的互斥关系，当前已在 validator 中被强约束：`src/config/validator/index.ts:922-978`
3. 运行时逻辑主要依赖 `seatMode` / `autoSearchEnabled` 与 symbol registry 的真实状态，不是直接依赖“空字符串是否存在”来决定关键业务语义

因此这更准确地属于：

- 类型收敛不足
- 架构收尾改进项

而不是当前主业务闭环错误。

---

## 本轮最终结论

本次四次复核后，正式结论如下：

1. **上一轮的 critical implementation issue 撤销。**
2. **当前实现对“距回收价清仓”的处理，与用户补充口径和重构方案是一致的。**
3. **本轮需要正式记录的问题共有三项：**
   - 文档基线冲突
   - 单元素数组 API 壳未收口
   - `startupRebuildPending` 分支的先算后忽略残留路径
4. 其余候选项虽有一定收敛空间，但当前仍不足以作为本轮正式问题立项。

---

## 建议的后续动作

1. 先统一文档基线：明确“静态标的距回收价清仓”是否独立于保护性清仓事件链路。
2. 收敛单实例接口边界，移除单元素数组 API 壳。
3. 清理 `startupRebuildPending` 分支中“先算再忽略”的残留实现路径。
4. 在文档统一前，后续所有 review / plan / 验收都应以当前实现口径和本文件结论为准，避免重复误判。
