# 验证子代理：候选二次复核请求（原始交接，最终状态见总报告）

> **B01授权更新**：用户已明确确认B01／V-C4／OE-003为已授权业务改动。该项不是问题，不设严重性等级，不构成验收阻塞，无需再次授权或恢复旧末日策略。本次仅校正分类和建议，保留原始行为差分与验证事实；其他事项以最终总报告为准。

基线已由主代理 fetch 后统一冻结：develop / origin/develop / FETCH_HEAD `6e239c8a128372bd9b2fb2d79464346792a5e81e`，目标 `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。与本次两版快照完全一致。用户要求 develop 是行为真值，不能由当前 business skill 或测试改写旧语义。

## V-C1：已完成保护性清仓边界前，同量高 revision 从抑制变为权威准入/落盘

- 本人独立自查已完成；需要日损/结算链路代理二次复核，不要尚未复核就称最终缺陷。
- develop `src/core/riskController/dailyLossTracker.ts:975-977`：`merge.nextFact.lastExecutionTimeMs <= currentBoundary` 时，在 durable callback、filledOrderFactsById.set 前返回 false/false。
- 当前 `src/domain/risk/dailyLossTracker.ts:882-951`，重点`:928-949`：不再有此边界抑制；构造 candidate 并调用 durable，然后发布权威事实；冻结 daily projection 保持 0 不代表权威/durable 不变。
- `2b67d36` 将 `tests/domain/risk/dailyLossExecutionBoundary.test.ts:20-52` 的 SUPPRESSED/false/durable=0 改为 ADMITTED/true/durable=1。
- 同提交还改 `tests/application/orderTracking/recorder/executionFactBoundary.business.test.ts:121-154`，以及 `tests/application/orderTracking/orderMonitor/settlementFlow.business.test.ts:759-913`，从 O/durable/H/stale 不变改为 recorder 45→46、落盘和刷新。
- TEMP `behavior-probe.test.ts` 第一项直接导入两版真实 DailyLoss：同一 BUY100，T 时冻结，T+30000 同量 price1→1.1，old durable=0/false，new durable=1/ADMITTED/true，dailyLoss均0。
- 可运行证据 `validation/behavior-probe-corrected.json`、`.stdout.log`、`.stderr.log`：exit0，3 pass/0 fail，12 expect。原探针首跑多余日志调用了已移除API而失败，已在TEMP修正；原日志未删除。
- 待二审重点：此变化在 WS closed/tracked 及 durable 恢复真实调用链的风险、是否违反用户无漂移要求；不能只凭新增测试/新 skill 认定授权，也不要错误地把 develop O 更新语义简化成全部不变（develop settleOrder 的本地记录和 refresh 与 Daily 返回存在不同顺序）。

## 非最终问题 V-C2 / V-C3：仅证明内部契约差分，需界定真实可达性

1. `d2aa590` 去掉 `executedTimeMs <= orderUpdatedAtMs` 和 durable baseline/progress 的相同约束，旧测试 throw 改 accept；第二项探针 old false/durable0，新 ADMITTED/advance/durable1。但当前原生 SDK mapper 正量 `executionTimeMs=updatedAtMs`，develop 也是 revision代理；不能据此声称真实逐笔成交被错误接纳。要复核历史日志/恢复路径才可提升。
2. 成本内部 setter 注入零成本记录：develop getCostAveragePrice 返回0.5，当前 getCostBasis throw；新 `costAveragePrice.test.ts:77-94` 明确将旧无效输入 oracle 改为 fail-fast。第三项探针证实，但真实成交生产准入原本已拒绝零价格，属于内部非法状态差分，尚无外部正常路径缺陷证据。

## V-C4／B01（已独立复核，已授权、非问题）：末日保留旧SELL、仅新增available

以下为初审交接时的差分证据；后续G4/G5已完成复核，用户已明确授权，原二审请求不再是未完成项。

- develop `src/core/trader/orderExecutor/submitFlow.ts:600-660` 对 `getPendingSellOrders(symbol)` 全部 cancel，CANCEL_CONFIRMED 后 `WAITING_FOR_AUTHORITATIVE_TERMINAL`，待 pending 移除才读仓/submit。
- 当前 `src/application/orderExecution/submitFlow.ts:579-605` 不查/撤旧 SELL，captureSellAvailabilityGuard 后直接读取 available 并提交。
- 旧 `tests/integration/doomsday.integration.test.ts:377-525` 要求 cancel=1、terminal前stockPositions=0/submit=0；新同文件 `:462-546` 把 cancel/replace stub设为throw，期望 available40立刻submit40、已有SELL完全不变（available0则skip）。这是反向 oracle，不是只改注入路径。
- 已独立核对两版源码和测试，两个全量套件都通过各自不同的预期。尚未进行统一输入的独立 submitFlow probe；不把目前证据扩写成已发生漏平仓。
- 另有 accepted 后清本地买单/缓存变为只 invalidate account：develop `src/core/doomsdayProtection/index.ts:518-546`；current `src/application/doomsdayClearance/index.ts:488-490`。可能是 canonical snapshot 下必要的 owner 转移，但非测试名称移动即可证明等价，请二审实际结算/后续唤醒能否保留旧外部行为。

## V-C5（请 G5 风险二审）：旧冷却过期重启后的下一次保护性完成行为不同

- develop `src/services/liquidationCooldown/tradeLogHydrator.ts:66-77` 先 restoreTriggerCount，再判 cooldown过期；current `src/application/protectiveLiquidation/tradeLogHydrator.ts:69-85` 在 restoreTriggerCount 前直接跳过过期cycle。
- 当前新增 `tests/application/protectiveLiquidation/tradeLogHydrator.business.test.ts:51-96` 明确要求10:00/01/02三次完成→10:10重启→重新数满3次才冷却。旧只有 active240000ms 与monitor拒绝测试，没有过期重启负向保护。
- 扩展探针 `behavior-probe.test.ts` 第4项：三次记录0/1/2min、triggerLimit3/minutes5、10min重启后两版remaining都0；随后第一次保护性完成old remaining=300000，new=0。真实hydrator+tracker，不是复制算法。
- `validation/behavior-probe-extended.json` exit0 / 0.109s，4 pass/0 fail/16 expect；扩展stdout含4个差分。
- 可能是修旧缺陷，但按用户无漂移要求不能自行授权。请区分行为真差分与是否允许修旧缺陷/风险方向，未二审不标最终缺陷。

## V-C6（请 G3 席位二审，测试保护候选）：原 invalid-quote SELL_OUT 集成 oracle 被 flat-success 替代

- develop `tests/integration/terminalSwitchFinalization.integration.test.ts:232-247` 要求 FAILED/INVALID_QUOTE:SELL_OUT + symbol=null/status=EMPTY。
- current 同文件 `:326-355` 改 COMPLETED + NEW_BULL/ACTIVATING；`readSwitchPositions: async () => []` 在`:203`固定fresh flat，而canonical snapshot仍OLD_BULL100（`:106-115`）。新测试标题已诚实改为flat条件，并多了mutation0检查。
- 不据此判实现错；需要G3确认在真实fresh positive + invalid price路径是否有等效可运行负向回归。当前按标题/断言搜索尚未找到直接保留原整条runtime场景；不能把标题未匹配直接当删测。

## 有效门禁摘要

- 当前 typecheck exit0 7.682s；lint exit0 92.477s；test exit0 305.161s / 3288 pass 0 fail / 317 files / 19669 expect。
- develop 有效 typecheck exit0 4.926s；lint exit0 56.187s；test exit0 54.733s / 1992 pass 0 fail / 187 files / 7638 expect。
- 旧启动器的3个exit0是Bun帮助页空跑，已明确排除；已改为 `bun --no-env-file test --preload <TEMP guard>` 获得有效旧版全量结果。
- 当前823及旧版525 tracked导出文件逐文件哈希未变，原工作树git status为空。
- 所有测试只在TEMP Git导出副本运行，原始日志在 validation/；未启动 app/start/dev 或实盘。
