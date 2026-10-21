# 平台／时间／重建辅助模块覆盖补齐报告

## summary

- **verdict：**已补齐指定九个运行模块的关键实现、分支及错误出口深读证据，并核对固定 develop 与直接生产 caller；本补齐范围内**未发现新的已确认缺陷，也未形成需要另行提交的新平台候选**。这不撤销相邻 seat/order 已有候选，不是全链二审或全仓通过结论。
- **scope：**仅覆盖 `audit-coverage-ledger.md:152–158,172–173` 中交办的九项，以及证明其输入、输出、失败归属所需的直接调用边界。未重做 G0/G1/G3/G4/G6 全链。
- **confidence：medium。**对下列静态分支、旧来源及直接 wiring 的证据充分；未进行本轮动态测试、真实 SDK／文件系统故障注入或生产恢复演练。
- **固定版本：**current/HEAD=`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop=`6e239c8a128372bd9b2fb2d79464346792a5e81e`。核验时 `develop=origin/develop=FETCH_HEAD=merge-base(HEAD,develop)`，分支为 `beta-V2...origin/beta-V2 [ahead 1]`，受审工作树及 index 无变更。恢复后没有 fetch、checkout、reset 或 merge。
- **实际模型：**本进程 PID `35960`、parent `36880`，可见 CLI 显式为 `--provider cliproxyapi --model gpt-6.1-sol --thinking max`。会话 `c97d1070-6870-4893-afb7-d29f532e9af3.jsonl` 的 model event=`c6ee7930`（2026-10-20T11:51:45.565Z），thinking event=`d618144c`（同日 11:51:45.566Z）；本次核验读取到的 129 条 assistant message 模型均为 `cliproxyapi/gpt-6.1-sol`，nonmatching=0。这里只证明本地实际启动／会话配置，不证明代理后端路由。
- **执行纪律：**本补齐只读源码、旧版本、测试源码及既有报告；未运行测试，未启动应用／SDK，未导入生产 logger 或仓储模块，未创建探针脚本。唯一主动交付写入为本 TEMP 报告；未改覆盖账本、源码、测试、配置或计划。此前交叉复核曾更新 ignored `tests/logs` 的执行偏差仍以 `audit-cross-g0-g2.md` 为准，本补齐未清理、回滚或抹去该记录。

## critical issues

None. 本次没有新增已确认 critical finding。

## major issues

None. 本次没有新增已确认 major finding；`signalBuilder.executionOrigin` 触达的既有 seat/order 政策候选不在此重新裁决。

## minor issues

None. 不把继承自 develop 的局限、来源索引纠偏或风格偏好包装成本次重构新增缺陷。

## positive findings

1. 九个模块均有下文明确的“实际读范围—旧来源—关键分支—真实 caller—未深入边界”，不是用 import、AST 统计、相邻 owner 已读或测试通过替代实现阅读。
2. 保留原有边界：行情收集包含非 ACTIVE 但仍占用的 symbol，消费快照则只暴露 ACTIVE symbol；两者不能合并为同一个过滤规则。
3. 同 symbol 的 activation carryover、显式交易日历和严格交易时长、纯 planner 与 timer owner 分离、仓储 durable 先于相关 committed 回调的接缝均有直接源码依据。
4. 没有把 `executionOrigin` 写成无业务作用的字段，也没有把仓储删除旧时间先后假设写成零行为差异。

## 1. 方法与结论口径

- 当前模块按下表全文阅读；直接 caller 只读相关调用、输入构造及消费／错误分支，不据此宣称 caller 整文件完成深读。
- 旧行为以固定 develop 源码为真值。对等价主体逐函数／类做去注释 TypeScript AST 打印比较，并查看全部非等价 diff；**AST 相同只是防漏辅助，不单独构成 D 证据**。
- 必要依赖另外核对：`isSeatActive/hasSeatSymbol`、日期枚举／HK 日期转换、`TIME/LIFECYCLE/LOGGING` 等相关常量、日志配置解析、仓储日文件路径。未根据当前 business skill 反推 develop 本来就应有新语义。
- 覆盖账本的 D 定义是“明确阅读关键实现、状态和错误出口”，不是逐状态穷举，也不是执行覆盖率。本报告可作为九项具有明确 D 证据的补充；未直接修改账本、JSON 派生数据、唯一主责或全仓统计，亦不替剩余十三项作结论。
- 本轮没有新疑点需要最小动态探针，因此按任务要求不为计数重跑测试。下文所有测试定位均是静态索引，不是本轮执行结果。

## 2. 九文件实际阅读与旧来源账本

当前列的行号均基于固定 HEAD；`develop:` 后的路径／行号均基于固定旧 SHA。

| 编号 | 当前文件及实际读范围 | 已核实旧来源／必要拆分 | 深读重点与直接 caller |
| --- | --- | --- | --- |
| P1 | `src/application/tradingDayRebuild/quoteSymbols.ts:1–62`，两个函数全部分支 | `develop:src/main/utils.ts:1–70`；运行集合函数 `:13`、私有集合函数 `:46` | monitor／席位／positions／orderHold 合并；loader `:545–560` |
| P2 | `src/application/tradingDayRebuild/seatActivationCarryover.ts:1–101`，WeakMap 与三个导出全部 | `develop:src/main/lifecycle/seatActivationCarryover.ts:1–101` | capture／空快照保留／resolve／clear；seat domain `:57–66`、rebuild `:395–429` |
| P3 | `src/application/tradingDayRebuild/tradingCalendarPrewarmer.ts:1–275`，主流程和全部九个 helper | `develop:src/main/lifecycle/tradingCalendarPrewarmer.ts:1–263`；日期枚举另来自 `develop:src/main/lifecycle/utils.ts:11–41` | 需求窗口／一年上限／缺失日期分块／半日／失败发布；rebuild `:339–360` |
| P4 | `src/domain/tradingSession/index.ts:1–289`，六个导出和两个内部函数 | `develop:src/utils/time/index.ts:125–422` 中对应八个函数；另核对其日期依赖 | 连续时段／开盘保护／分钟数／duration／due-at；时间评估、执行、订单 timeout、周期换标 |
| P5 | `src/runtime/timeWakeupPlanner/index.ts:1–35`，两个函数全部 | `develop:src/main/timeWakeupPlanner/index.ts:1–35`，原文相同 | 非有限／过去／等于 now／空候选；evaluation `:73–82` 与 timer consumer |
| P6 | `src/application/seatSwitch/signalBuilder.ts:1–63`，方向映射和完整 builder | `develop:src/services/autoSymbolManager/signalBuilder.ts:1–79`；旧数量函数 `:36–51` 的当前 owner 为 `domain/seat/switchPolicy.ts:66–78` | nullable 字段、注入 clock、seatVersion、executionOrigin；seatSwitch 装配及状态机两处构造 |
| P7 | `src/domain/seat/seatSnapshot.ts:1–53`，两个导出全部 | `develop:src/utils/seat/snapshots.ts:1–55` | ACTIVE symbol／双方版本／名称回退／移除旧未消费 seatState 输出；monitor context、risk routing |
| P8 | `src/infrastructure/logger/index.ts:1–753`，含模块初始化、class、streams 和 hooks 全部 | `develop:src/utils/logger/index.ts:1–747`；配置解析旧 `utils/runtime` → 当前 `config/runtime` | retention、轮转、drain、格式、console/file 分流、DEBUG、退出路径 |
| P9 | `src/infrastructure/persistence/mixedTradeLogRepository/index.ts:1–954`，schema、scanner、append、工厂内全部方法 | `develop:src/services/mixedTradeLogRepository/index.ts:1–954`；日路径 helper 当前 `tradeLogPath.ts:17` ↔ 旧 `utils/trading/tradeLogPath.ts:12` | 严格读取／指纹／幂等／uncertain write 锁定／retention；组合根、progress、completion、恢复、audit |

**来源纠偏（不是代码 finding）：**

- P1 的两个函数都来自 **`develop:src/main/utils.ts`**。旧 `src/main/lifecycle/utils.ts` 只有日期枚举，不能承接 P1 的 `collectRuntimeQuoteSymbols` 深读证据。既有 `audit-lifecycle.md:124,179` 对该旧来源的文字不准确，应由汇总者修订索引，而非继续沿用。
- P4 真正主体为旧 `src/utils/time/index.ts`，不是 lifecycle utils。覆盖账本 `:45–47` 已记录此纠偏，本报告确认而不重复制造一项发现。
- P7 真正主体为旧 `src/utils/seat/snapshots.ts`。旧 `src/main/asyncProgram/monitorTaskProcessor/helpers/seatSnapshot.ts` 是任务席位有效性校验，属于当前 `domain/seat/seatIdentity.ts` 的来源链，不能混作 P7 的整文件证据。
- P9 的日路径 helper 精确函数对照为 **current `src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.ts:17` ↔ develop `src/utils/trading/tradeLogPath.ts:12`**；这是必要依赖对照，不额外计为第十个补齐模块。

## 3. 逐文件关键生产分支证据

### P1. `application/tradingDayRebuild/quoteSymbols.ts`

**实际阅读：**当前 `:1–62` 全文；旧 `main/utils.ts:1–70` 全文；当前 loader 调用段 `loadTradingDayRuntimeSnapshot.ts:537–560`，旧 loader `main/lifecycle/loadTradingDayRuntimeSnapshot.ts:291–305`。

**分支与不变量：**

1. 当前 `:45–62` 总是先加入唯一 monitor symbol，再读取 LONG/SHORT 席位；有非空 symbol 即加入，**没有 ACTIVE 限制**。这服务于重建相关事实集合，不是交易准入。
2. `:22–35` 对 positions 和 orderHoldSymbols 分别过滤空 symbol，再加入 Set；重复席位／持仓／订单不会产生重复 symbol，也不修改输入集合。
3. monitor 参数只收窄为实际使用的 `monitorSymbol`。旧私有 helper `main/utils.ts:52–57` 允许无 registry 时仅返回 monitor；当前删掉此分支，但旧生产入口 `collectRuntimeQuoteSymbols` 的 registry 已必传，唯一旧 loader `:292–297` 也实际传入。没有可见生产 caller 使用被删除的空参路径。
4. 两版外层收集函数的运行体相同；私有 helper 的唯一运行差异是上述不可见生产路径的空参处理。

**直接生产 caller／消费：**唯一当前 caller `loadTradingDayRuntimeSnapshot.ts:545–550` 传配置、真实 registry、`canonicalView.positions` 和 `orderHoldRegistry.getHoldSymbols()`；随后 `:551–560` 复制集合并移除 monitor，用于 prepared daily-loss 重算。因此不能仅凭模块名把它描述为“立即订阅／立即下单”。旧 loader `:292–305` 同样收集后删 monitor 再重算。

**未深入边界：**position／orderHold 上游 HK 市场隔离、全部持仓读取真实性、daily-loss 算法和 quote subscription owner 不在此重审；本 helper 不自行实施这些政策。没有将“收集所有 position symbol”误报为本次新增市场范围回归。

### P2. `application/tradingDayRebuild/seatActivationCarryover.ts`

**实际阅读：**当前和旧文件各 `:1–101`；当前 `runtime/lifecycle/cacheDomains/seatDomain.ts:52–76`、`rebuildTradingDayState.ts:378–438`；旧 `main/lifecycle/rebuildTradingDayState.ts:210–228`。

**分支与不变量：**

1. `:12–21` WeakMap 以 registry 实例隔离，内部再按 LONG/SHORT 分离；不是跨 runtime 共用的一份 symbol 全局缓存。
2. `capture:31–64` 仅保存 ACTIVE 且 symbol 非空、`lastSeatActivatedAt` 非 null 且有限的席位。没有据注释额外假设这里还校验正数或日期归属。
3. `:59–61` 本次捕获为空且已有快照时保留旧快照，避免非交易日／未恢复 ACTIVE 的重复午夜清理抹掉原基线；有有效新捕获时整体替换，而不是无条件合并旧方向。
4. `resolve:75–92` 必须同 registry、同方向、同 symbol 才返回时间；不存在／换 symbol 返回 null；`clear:99–101` 仅删本 registry。
5. 三个函数运行体与固定 develop 相同。导入的 `isSeatActive` 从旧 `utils/seat/guards.ts:9–21` 迁至当前 `domain/seat/seatPolicy.ts:18–30`，判据仍为 ACTIVE 且非空 symbol。

**直接生产 caller／消费：**seat domain `:57–66` 在任何 reset/清席位前，按 `invalidateSeatActivationCarryover` 先 clear 或 capture，再 reset switch、清 warrant cache 与席位。rebuild `:395–399` 仅对本次席位解析 carryover，缺失则用本次显式 `now.getTime()`；在 activation commit、恢复 tracking、展示及授权复核后，`rebuildTradingDayState.ts:429` 才 clear 并返回 COMMITTED。失效／throw 不偷清待后续重试的基线。

**未深入边界：**本轮不重新证明 lifecycle 何时设置 invalidate 标志、activation 提交的整套授权算法、跨进程重启持久化或全部日切状态组合。WeakMap 只保存本进程事实，不是 durable recovery。

### P3. `application/tradingDayRebuild/tradingCalendarPrewarmer.ts`

**实际阅读：**当前 `:1–275` 和旧 `main/lifecycle/tradingCalendarPrewarmer.ts:1–263`；当前 rebuild `:330–373,429–438`，旧 rebuild `:263–284`；日期枚举旧 lifecycle utils `:11–41` ↔ 当前 `utils/time/index.ts:135` 的完整同体函数。

**分支与不变量：**

1. `:89–136` 只从已绑定 LONG/SHORT symbol 的仍持仓买单取有限的最早 executedTime；不要求 ACTIVE，也不从已平仓历史订单任意扩大窗口。方向分别传 `true/false`，没有交换 LONG/SHORT。
2. `:54–63` 有最早持仓事实则以其为起点，否则回看 14 天，终点前看 7 天；`assertCalendarLookbackRange:140–157` 超出 365 天能力范围抛带 code/details 的错误，不静默截短并伪装完整日历。相关 `LIFECYCLE/TIME` 常量已与旧版核对一致。
3. `:65–85` 从旧 map 复制，仅查询缺失 dateKey；全部异步补齐成功后，若同日 cachedTradingDayInfo 存在，以其覆盖当天，再替换 `tradingCalendarState.tradingCalendarSnapshot`。查询失败时局部 nextSnapshot 不发布。
4. `hydrate:162–187` 对每段 await `getTradingDays`；半日列表成员同时算交易日；两列表均无此日则记非交易日，不把未知结果任意当正常全日。
5. `split:193–240` 只合并**同月且相邻自然日**，跨月或缓存造成的缺口均拆段；`isConsecutiveDateKey:244–254` 日期无效返回 false；`resolveDateFromHKDateKey:264–275` 无法解析则抛明确 invalid-date-key 错误。
6. 与旧版的运行差异是 `lastState` 拆为专用 `tradingCalendarState`；其余九个 helper 同体。日期枚举算法也同体，未把目录移动当成日期算法变更。

**直接生产 caller／消费：**唯一 caller `rebuildTradingDayState.ts:351–356` 位于订单重建／名称同步之后、风险缓存与 activation 之前；await 后 `:358–359` 重新核验本轮授权，失效不继续激活。组合根 `createPostGateRuntime.ts:197–209` 建单一 calendar state，loader `:398` 和 runtime 使用同 owner；周期换标 `:750–754` 在每次 due-at 计算时读其当前 snapshot，不复制一份过期日历。

**未深入边界：**交易所／SDK 返回日历的实际正确性、全部一年以上持仓业务政策、并发人为修改 calendar map、完整 open-rebuild token 协议未重做。prewarmer 本身不持有交易 permit；成功写入 calendar 不等于 activation 或 snapshot ready 已发布。

### P4. `domain/tradingSession/index.ts`

**实际阅读：**当前 `:1–289` 全部八个函数；旧 `utils/time/index.ts` 对应函数起始分别 `:125,156,185,216,265,305,384,414`；日期依赖与相关 TIME 常量，以及下列所有直接可见生产调用／注入边界。

**分支与不变量：**

1. `isInContinuousHKSession:20–41` 只判断时间：上午 `[09:30,12:00)`，正常日下午 `[13:00,16:00)`；半日仅上午。它不替 caller 判断是否交易日。
2. `morning:51–70`／`afternoon:80–101` 对非有限或非正分钟数返回 false，采用含起点不含终点；上午／下午入口条件不同。全局是否连续交易、是否半日由 caller 组合，不能假定 helper 自带所有门禁。
3. `getTradingMinutesSinceOpen:111–147` 以正常日口径按分钟累计：开盘前 0，午休固定 150，正常收盘后 330；**不区分半日市**，与旧函数及其注释相同，不能误写成严格跨日日历时长。
4. `calculateTradingDurationMsBetween:160–192` 非有限／逆序／等时输入为 0；按 HK 自然日分段，只累计显式日历交易日的会话 overlap，半日无午盘；缺日历段记 0 增量，不合成交易日。
5. `calculateTradingDurationDueAtMs:200–242` 目标非正／非有限返回 null；跳过已明确的午休、收盘后和非交易日，但**遇任一缺失日期事实立即返回 null**。这与上项“缺失段不累计”的 API 合同不同，不可互换。
6. `resolveSessionRangesByDay:251–272` 与 `calculateOverlapMs:281–289` 保持半开区间与不重复累计。六个导出和 overlap 的去注释 AST 相同；session-range helper 的唯一 AST 差异是 `TradingCalendarDayInfo` → `TradingDayInfo` 类型名，运行语句相同。
7. `getHKTime` 对非空显式 Date 的运算、HK day-start 解析及 TIME 保持原语义；`getHKDateKey` 由旧私有 buildHKDateKey 改调当前 getRequiredHKDateKey，后者内联同样的格式构造。没有把 helper 名称／拆分变化误判成交易日算法变化。

**直接生产 caller／消费（已核相关分支）：**

- `runtime/timeWakeupEvaluationProgram/index.ts:286,325–338` 用 `isTradingDayToday && continuous` 计算 canTrade，保护窗口又受 canTrade、配置及半日条件限制。
- `application/orderExecution/index.ts:360–372` 同时要求实时连续门禁与显式 currentTime 会话；`application/doomsdayClearance/index.ts:782–790` 在原 dayEpoch／lifecycle 下重新取 now 判 live。
- `application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:534–538` 组合连续时段和早盘 delay；`application/autoSearch/index.ts:122–126`、`runtime/autoSearchWakeupRuntime/index.ts:253–261` 分别跳过／安排 delay 结束唤醒。
- `application/autoSearch/candidateSearch.ts:184` 消费已开盘分钟数；`app/runtime/createPostGateRuntime.ts:383` 注入该能力，未换成日历 duration。
- `domain/order/orderRecordPolicy.ts:136–150` 对 heldTradingMs 采用**严格大于** timeout；`application/seatSwitch/switchStateMachine.ts:1596–1604` 则在 elapsed 不小于 interval 后继续周期检查，两种阈值归 caller，不在共享函数中偷偷归一。
- `app/runtime/createPostGateRuntime.ts:750–755` 将 due-at 注入 periodic wakeup，并读取当时同一 calendar snapshot；状态机的 duration 能力由 `application/seatSwitch/index.ts:92–93` 注入。

**未深入边界：**策略／寻标使用分钟数的经济公式、周期换标完整状态机、订单 timeout 后的选单及卖出政策、全局门禁全部状态转换和 SDK 日历真实性不在此重复审计。未穷举超出 JavaScript Date 有效范围或非生产恶意输入。

### P5. `runtime/timeWakeupPlanner/index.ts`

**实际阅读：**当前／旧文件全部 `:1–35`（原文相同），当前 planner types `:1–36`、evaluation `:73–82,214–247`、time runtime `:55–173` 的计划消费和生命周期分支。

**分支与不变量：**`isFutureCandidate:8–10` 仅接纳有限且 `atMs > nowMs`；`plan:18–35` 复制数组再过滤／排序，取最早候选；空／全部失效返回 `{hasWork:false,nextWakeupAtMs:null}`，否则返回 true＋数值时间。等于 now 的候选不被当成未来；没有原地重排输入，也不在纯 planner 中执行交易／设置 timer。

**直接生产 caller／消费：**唯一直接 caller `timeWakeupEvaluationProgram/index.ts:73–82` 使用同轮显式 currentTime；评估入口 `:215–222` 先收集下一 HK 日边界，API 外部失败 `:235–247` 增补 retry 候选后仍走同一 planner。`timeWakeupRuntime/index.ts:55–94` 检查有限时间，用 bounded one-shot；计划在消费时已过期则请求重评估／置 dirty，而不是等待一个无效 timer。`:101–145` 单 owner dirty-drain，`:148–173` start 等 initial evaluation、stop 撤 timer、stopAndDrain 等在途。planner 丢弃 atMs==now 不等于系统丢失“现在应执行”的业务评估。

**未深入边界：**本轮不重做所有候选生成公式、时钟回拨、bounded timer 长延时实现或所有 time/lifecycle 联动；这些 runtime 段落只证明当前 planner 输出真实被消费，而非宣布整条时间链新增二审通过。

### P6. `application/seatSwitch/signalBuilder.ts`

**实际阅读：**当前 `:1–63`、旧 `services/autoSymbolManager/signalBuilder.ts:1–79`；当前 `seatSwitch/index.ts:46–96`、状态机 `:1023–1073,1384–1428`、执行 purpose 绑定 `orderExecution/index.ts:47–86`；旧数量 helper 移出及当前注入边界。

**分支与不变量：**

1. `resolveDirectionSymbols:16–25` 保持 LONG→BUYCALL/SELLCALL、SHORT→BUYPUT/SELLPUT，不反转方向。
2. `createSignalBuilder:32–63` 对名称使用 `quote?.name ?? symbol`，quantity 和 orderTypeOverride 用 nullish 规则归 null；不把合法 0 当成缺参，也不在 builder 擅自计算、取整或修正数量。seatVersion 直接随信号携带；triggerTime 每次由注入 clock.now() 获取。
3. 新增 `executionOrigin` 可选透传：缺省不生成该字段，存在则按原值传递。**这不是纯日志／无语义变化的 DTO 平移。**执行器 `resolveSignalOrderPurpose:47–86` 会据此绑定 ORDINARY、SWITCH_MOVE、SWITCH_REBUY 等目的，且校验动作；protective 信号不能同时携带其他 origin。
4. 旧 `calculateBuyQuantityByNotional:36–51` 不在本文件继续保留。当前 `seatSwitch/index.ts:22,85` 从 `domain/seat/switchPolicy.ts:66–78` 注入状态机；当前是权威金额／价格字符串和安全整手边界，旧为 number＋旧 numeric helper，不能只写“数量函数无差异搬家”。本补齐只核实没有漏接，不再次裁决整个精度升级或回补预算。

**直接生产 caller／消费：**`seatSwitch/index.ts:56,84–86` 统一创建并注入 builder／方向映射；状态机方向映射 `:704`，卖出 `:1040–1049` 明确 SWITCH_MOVE，回补 `:1398–1407` 明确 SWITCH_REBUY，均传原 seatVersion；`:1052–1061`、`:1409–1422` 在执行前仍核对原 switch 授权。builder 不持有 permit，也不因此成为交易授权入口。

**已有政策边界，不作新确认：**`orderExecution/submitFlow.ts:643–665` 的 SWITCH_MOVE 真实进入独立新卖单分支，涉及旧普通 SELL 是否合并及回补预算范围。该事项在既有 `audit-seat-selection.md` G3-C1 中已有候选，本补齐既不把它降格成“仅 origin 字段”，也不因 builder 正确传参就确认或驳回候选；最终裁决仍归既有 seat/order 独立二审。

**未深入边界：**完整 SELL merge／replace、取消与晚到终态、拒单／零成交／fatal、实际 ACK 经济操作归属、回补资金公式，以及 `switchPolicy` 全部业务规则。没有以本文件全读替这些链路签字。

### P7. `domain/seat/seatSnapshot.ts`

**实际阅读：**当前 `:1–53`、旧 `utils/seat/snapshots.ts:1–55`，`domain/seat/types.ts:1–16`、ACTIVE guard，全部直接生产导出消费者的相关段落。

**分支与不变量：**

1. `resolveMonitorContextSeatSnapshot:15–28` 同步读取双方状态和版本；仅 ACTIVE 且非空 symbol 暴露 longSymbol/shortSymbol，其余返回 null，不写 registry。
2. `resolveMonitorContextSymbolNames:37–53` 对 ACTIVE symbol 取 quote name，缺失／null 回退代码；没有可消费 symbol 时名称为空串；monitor name 独立回退 monitor code。nullish 判定不改成 truthiness。
3. 旧快照 `utils/seat/snapshots.ts:18–28` 还返回 `seatState.long/short` 原状态引用；当前删除该输出，是**内部返回形状收窄**，不能宣称逐字段完全相同。
4. 已对固定 develop 搜索该导出的所有生产 caller：除了本文件内名称解析，外部只有旧 `main/tradingRiskEventRuntime/routingIndex.ts:61–79`，实际仅读 ACTIVE symbol 与 seatVersion；没有消费被删的 seatState。名称解析运行体同旧；ACTIVE guard 同旧。因此没有找到返回形状收窄造成的生产行为回归，且减少向消费者暴露可变 registry 对象。

**直接生产 caller／消费：**当前 `app/context/createMonitorContext.ts:64–81,96–102` 构造／刷新名称；`application/tradingDayRebuild/rebuildTradingDayState.ts:65` 同样只取派生名称；`runtime/tradingRiskEventRuntime/routingIndex.ts:62–80` 按 ACTIVE symbol 建风险路由并携带对应方向版本。不能把“仍占用 symbol 但未 ACTIVE”的席位通过本函数加入风险执行路由。

**未深入边界：**registry 全状态机、risk route 注册冲突和后续执行授权、外部未见的任意 raw API 消费者均未在此批准。本次不是旧 monitor task helper 的 seat-identity 校验审计。

### P8. `infrastructure/logger/index.ts`

**实际阅读：**当前 `:1–753` 和旧 `utils/logger/index.ts:1–747` 的完整运行体；当前／旧配置 helper、相关 LOGGING／级别／颜色常量、显式 Date 格式依赖及直接导入边界。

**分支与不变量：**

1. `retainLatestLogFiles:36–87` 只处理扩展名匹配且 stat 为文件的项，stat 失败跳过；按文件名排序，已存在当日日文件按覆盖保留数、新文件预留一席；unlink 失败只报告。当前与旧函数同体，不扩张为交易 JSONL 的 retention owner。
2. `DateRotatingStream:115–278` 构造时创建 system/debug 目录；`_write:136–184` 先等日期轮转，文件 backpressure 等 drain 或 timeout，写入／流不可用按既有 logger 合同报告并放行回调；`_checkRotate:206–232` 用同一 Promise 串行化，`_doRotate:239–277` 先等旧流 finish/error，再开当日日 append 流。没有读到新的交易门禁或 retry owner。
3. `createDrainHandler:402–430` 用 resolved 标记保证 drain／timeout 只调用一次完成回调；timeout 移除 listener，正常 drain 清 timer。`writeWithDrainTimeout:442–455` 对 console 同样防永久阻塞。
4. `formatForFile:314–342`／`formatForConsole:351–383` 保留 HK 时间、level、结构化 extra／inspect 回退及文件消息去 ANSI；`consoleStream:458–499` WARN/ERROR→stderr、其余→stdout，解析／格式失败有原样错误路径而不依赖本 logger 递归。
5. `fileStream:502–579` 系统日志接收有效级别输出，DEBUG 启用且 level 恰为 DEBUG 时另写 debug stream；Promise.all 等此次流回调。`streams/pino/logger:582–675` 保留 DEBUG 开关、extra 封装与多流配置。两版 pino 声明均为 `^10.3.1`，未由源码迁移引入另一 logger 协议。
6. `cleanupSync:687–711` 一次性清理；hooks `:713–753`：beforeExit/exit 清理，uncaughtException 记录后 exit(1)，unhandledRejection **只记录而不立即退出／清理**。不得根据相邻概述或函数注释声称 rejection 已执行同步清理。
7. **耐久界限：**`closeSync:189–200` 实际调用流 `.end()` 并不等待，不是同步 fsync；`cleanupSync` 的名称／注释不构成“强制退出前文件已可靠落盘”的保证。这是两版同体既有局限，本补齐未证明实际丢日志，也不据此制造本次新增 finding。
8. 所有模块级非 import 运行语句、全部顶层函数及整个 class 去注释 AST 与旧版相同；完整 diff 仅模块说明、路径与 Logger 类型拆分。迁移依赖另核：`resolveLogRootDir` 当前 `config/runtime/index.ts:63` ↔ 旧 `utils/runtime/index.ts:59`、`shouldInstallGlobalProcessHooks` 当前 `:83` ↔ 旧 `:79` 的函数体相同。

**直接生产 caller／装配：**生产直接 import 已核为 `app/runAppDeps.ts:15`、`app/runtime/createPreGateRuntime.ts:15`、`app/shutdown/createCleanup.ts:8`、`infrastructure/display/accountDisplay/index.ts:6`、`infrastructure/display/marketMonitor/index.ts:8`、`infrastructure/longbridge/market/quoteClient.ts:45`、`infrastructure/longbridge/trade/orderReadErrorClassification.ts:8`；其他用例通过 Logger 能力注入。日志根显式配置优先，否则 app=`logs`、test=`tests/logs`；hooks 显式覆盖优先，否则 app 开／test 关。业务 durable ledger 不经此 best-effort 流保证提交。

**未深入边界：**pino／Node 原生 stream 在硬退出、磁盘耗尽、极端 backpressure、实际信号顺序下的行为；所有业务日志文本逐字比对；真实文件系统轮转／retention 故障；是否需要另立 stronger logger durability 需求。为避免目录／日志副作用，本轮没有 import 或运行该模块。

### P9. `infrastructure/persistence/mixedTradeLogRepository/index.ts`

**实际阅读：**当前和旧模块全文 `:1–954`，含所有 schema 常量、25 个顶层函数和工厂内 load／append／retention／block 方法；日路径 helper；下列真实生产 append／load／绑定边界。完整 diff 已单独收敛核读，未用被截断的大输出代替差异结论。

**schema 与扫描分支：**

1. `assertExactKeys:101–115` 拒绝未知及缺失字段；ordinary trade `:121–174` 校验既有 nullable 字段与正有限 executedAtMs，并阻断 legacy completion reason；不是把所有 ordinary trade 的字符串字段又擅自收紧成 HK 整数校验。
2. completion `:221–268` 固定 V1、合法 HK 日键、monitor／方向、boundary 同日、确定性 completionId、非空 baselines 与不重复 orderId；baseline `:177–218` 保留规范正十进制数量／金额、正有限 execution/revision 和 BUY/SELL 约束。
3. progress `:271–337` 固定 V1、OPEN/TERMINAL、同日 execution、确定性 progressId、正累计量／金额与正有限 revision。`parseMixedRecord:398–412` 按两种已知 recordType 分派，未知 tag 拒绝，否则进 ordinary schema；不能用未标记旧记录伪装 V1 完成事实。
4. `readDailyLog:516–546` 单次严格读取：非空、最终 LF、每行非空且无 CR、fatal UTF-8 decode、JSON 完整、schema/day 一致；不截断尾行或自动修复损坏。`scan:548–598` 根缺失只返回、不创建；目录类型不符、旧 `.json`、非法 `.jsonl` 日期文件名、非普通文件、读取前后 fingerprint 改变均抛错。`rememberRecord:470–498` 同 V1 ID 同规范 payload 去重，异 payload 冲突。

**追加／失败／幂等分支：**

5. `appendJsonlRecord:601–682` 新文件用 `wx`、旧文件 `r+`；检查 offset 安全及打开 descriptor fingerprint，循环处理 partial write，零写入报错；随后 file fsync、大小／身份复核、close。close 错误也不被吞；不是“append 调用返回即可当作完成”。**只证明 file fsync 路径，不声称目录 fsync／断电原子性。**
6. 工厂 `:697–864` 先只读 preflight，缓存日状态与 fingerprint。已缓存文件后续被删除／换写／无法读取，`assertCachedFileCurrent:723–754` 锁定仓储；`appendRecord:792–864` 持久化后再核路径指纹、再 remember／更新缓存。uncertain write 首次抛原错，后续 `assertUsable:715–721` 阻断所有 load／append 并以 cause 保留原错；不自动重试可能已写的一行。
7. `appendCompletionIdempotent:879–898` 和 `appendExecutionProgressIdempotent:913–934` 在同 ID no-op **之前**仍检查 retention window 和已有文件 fingerprint；同 ID 异 payload 报冲突；普通 trade `:936–945` 则每次追加，不能把 V1 幂等规则错套成所有 ordinary trades 全局去重。
8. `getState:756–764` 将当前请求日记为 recovery-required；load `:866–877,900–911` 有状态时复核指纹并返回新数组，无文件则 []，不随意创建日文件或重读全目录。

**留存分支：**

9. `resolvePrunedDayKeys:766–789` 保留最新七个**存在／目标日文件**，不是七个自然日；目标落在窗口外先拒绝。若将删除当前 HK 日或 recovery-required 日也先拒绝，不能为了接受晚到事实先删恢复依据。
10. `appendRecord:833–859` durable append／缓存更新后才清旧文件；victim 指纹改变则保留，unlink 的 ENOENT 清缓存，其他 cleanup 失败只延后清理，不反向否认已成功持久化的当前事实。相关分支与旧版相同。

**与 develop 的真实差异（保留，不写成零行为变化）：**

11. 除 import／类型迁移，唯一运行差异位于 baseline 和 progress parser：旧 `services/mixedTradeLogRepository/index.ts:204,313` 的 `lastExecutionTimeMs > orderRevisionMs` 拒绝被删除；当前 baseline `:190–207`、progress `:294–319` 分别检查两种时间的合法性，不再强加先后排序。故相同合法 durable 事实若 execution 晚于订单 revision，旧版拒绝、新版接受。
12. 这是既有 d2aa590 修复链中的明确事实合同变化，不是所有 guard 都由重构新加，也不是放宽 schema／数量／归属／交易门禁。其余 23 个顶层函数以及整个 repository 工厂去注释 AST 同旧；模块级 schema／运行初始化语句也同旧。build path 当前 `tradeLogPath.ts:17` ↔ 旧 `utils/trading/tradeLogPath.ts:12` 的函数体相同。

**直接生产 caller／提交顺序：**

- `app/runtime/createPostGateRuntime.ts:178–180` 只创建一份仓储；`:314–315` 把同一 progress appender 注入 order monitor，`:406` 交 loader，`:442` 交普通 audit；`createPostTradeConsistencyRuntime.ts:32–45` 将同一仓储绑定 completionPersistence。
- `application/orderTracking/orderMonitor/settlementFlow.ts:83–116` 仅需 protective progress 的真实分支调用 appender；`:104–112` 先 append，再 `onProtectiveProgressCommitted`。这里核的是 appender 的提交边界，不重做整个订单经济事实状态机。
- `application/postTradeSettlement/index.ts:171–199` 先检查 current episode／flat／pending protective，再 `:186–191` appendCompletion，随后才 commit loss boundary、cooldown trigger 和 episode completion。
- `application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:448,452` 读取当日 completion/progress；`application/protectiveLiquidation/tradeLogHydrator.ts:21–39` 从显式当前时间解析 HK 日、读取同仓储并拒绝 monitor mismatch。仓储接受不排序的两种合法时间，不等于 loader 后续经济归属校验可以跳过。
- `application/orderTracking/tradeAudit/index.ts:91` 同步 append ordinary record，组合根 `createPostGateRuntime.ts:438–446` 接入 audit listener 与 fatal reporter；没有改走 best-effort logger。
- `parseMixedRecord` 当前生产调用只见本模块 scanner `:540`，未见注释所称“交易费用 JSONL 读取”的外部生产 caller。因此不拿这段注释虚构额外消费覆盖，也不因 export 无外部 src caller 就断言整个 parser dead code。

**未深入边界：**本轮不再运行真实磁盘／fsync／close 故障探针；未证明 OS／硬件断电保证、所有文件系统 TOCTOU、完整历史 durable V1 逐条对账、所有重启恢复／日切经济一致性。d2 的跨层 execution/revision 合同仍应由统一 validation／recovery 审计闭合，局部 parser 正确接受不构成全链通过。

## 4. 既有回归保护定位（仅静态阅读／索引，未运行）

| 范围 | 已定位的现有测试与关键场景 | 本轮可据此主张的内容 |
| --- | --- | --- |
| carryover | `tests/runtime/lifecycle/cacheDomains/seatDomain.test.ts:137,216`；`tests/application/tradingDayRebuild/rebuildTradingDayState.test.ts:807,849,893` | 存在非交易日保留、失败日失效、同／不同 symbol 恢复等回归入口；不计为本轮 pass |
| calendar | `tests/application/tradingDayRebuild/rebuildTradingDayState.test.ts:414,458,495,758` | 已平仓历史不扩窗、仍持仓老单扩窗、自然月分块、错误 identity 的既有保护位置 |
| session | `tests/domain/tradingSession/index.business.test.ts:36,46,58,68–128,135–256` | 时段／保护／午休／半日／周末、due-at 日历缺口；部分仅核场景名及关键断言，不宣称整文件测试审计 |
| planner | `tests/runtime/timeWakeupPlanner/business.test.ts:10,21,33,50` | 最早未来、过去／等于 now、NaN/Infinity、no-work 的现有源码断言 |
| seat snapshot | `tests/domain/seat/seatSnapshot.business.test.ts:15,58,95` | ACTIVE 名称／非就绪／ACTIVATING 不暴露 symbol 的现有断言 |
| logger | `tests/infrastructure/logger/logger.business.test.ts:62–125` | routing／结构化 extras／文件去 ANSI、rejection 不退出、uncaught exit(1) 的测试源码已读；未启动其中 subprocess |
| mixed repository | `tests/infrastructure/persistence/mixedTradeLogRepository/business.test.ts:166,197,247,276,294,342,355–463,476–578,609–752` | 已核场景索引及相关源码，覆盖严格 preflight、晚于 revision 的 progress、uncertain write、no-op 指纹、retention 等；不是本轮实测结果 |
| signal builder 边界 | `tests/integration/distanceSwitchIndependentSell.integration.test.ts` 已有真实状态机链路由既有首审／交叉报告记录 | 本轮不借旧通过结果重裁独立卖单／回补政策，也不以测试依赖包含 builder 代替本次全文阅读 |

没有为了 D 数量新跑 trivial 测试；没有声称九文件测试全部执行、lint/type-check/build 或统一 gates 在本轮通过。

## 5. 七维复核结论与限定

| 维度 | 本补齐实际检查 | 结论／边界 |
| --- | --- | --- |
| implementation | 九文件关键输入、正常／空／异常分支、状态保存、异步 await 和直接消费 | 未发现新的已确认平台缺陷；origin 和时间 parser 两类非零语义差异单列，不掩盖 |
| project/spec | 按既定架构职责检查 domain 纯规则、application 用例、runtime timer、infrastructure IO；固定旧行为优先 | 未把继承 Node Writable 的 logger class 当成新增业务对象；该 stream 例外在当前 `logger/index.ts:111–114` 已解释；未执行只读任务不需要的 lint:fix |
| type design | 收窄 monitor 参数／registry capability、nullable 字段、planner 联合返回、snapshot readonly 派生、unknown JSON schema | 只对真实生产 caller 的可见输入闭合；没有声称 readonly 等于运行时深冻结或任意 raw API 均安全 |
| tests | 静态定位真实负向／边界保护，区分旧执行结果与本轮行为 | 本轮未运行测试／探针；既有测试不是等价真值，文件全读也不等于分支覆盖率 |
| comments | 核对 carryover／时长／origin／logger close／parseMixedRecord 说明 | 明确保留 logger 非 fsync、rejection 非 cleanup、parser 无外部费用 caller 的事实限制；不为历史注释偏差生成低价值重构 finding |
| dead code | 导出／工厂属性与全部直接可见生产消费搜索；检查删去旧私有空参和旧 snapshot seatState 的消费 | 九模块有生产消费者；不因为某 helper 仅内部使用就误判整模块无用；没有删除建议 |
| simplification | 检查纯函数边界、数量规则迁出、状态 snapshot 输出缩小及是否新增 façade | 保留有业务／耐久作用的分层，不为行数提出额外抽象或清理；不将“更短”当等价证明 |

## not assessed

- 其余十三个 E/B-only 模块、全仓 D 统计、完整 G0/G1/G3/G4/G6 二审：不在本任务范围，不能由本报告外推已完成。
- 相邻买卖政策：普通 SELL 合并／独立 owner、回补预算、protective 隔离、取消／拒单／零成交／fatal 的最终授权裁决继续归已有专项二审；P6 只补构造器及必要边界证据。
- 统一 validation：本轮没有执行 tests、type-check、lint、build 或新增动态探针；此前其他报告的执行结果不转记为本轮新验证。
- 生产外部边界：未连接真实 SDK／账户／交易所日历；未做真实持久化目录损坏、磁盘耗尽、断电、硬退出日志保证或生产恢复／回退演练。
- 竞争穷举：直接 caller 的授权／生命周期 owner 只读必要调用段，没有穷举任意跨日／重入／外部文件 mutation 调度，也未重复批准整条状态机。
- 工作树之外：工具宿主自身会话／缓存写入不属于源码行为审计；此前 ignored tests/logs 偏差未回滚，亦没有事前全量 ignored-artifact 快照，不能声称整个 run 零落盘副作用。

## recommended next actions

1. 由主代理把本报告的九条实际分支证据合并至 coverage ledger／派生账本；保留唯一主责、原 E/B 历史与未评估边界，不仅把“9”加到统计上。
2. 修正 P1 的旧来源为 `develop:src/main/utils.ts`，P7 主体为旧 `utils/seat/snapshots.ts`；P4 已纠偏继续保留。不要把日期枚举或 seat-identity helper 错算为这些模块的深读证据。
3. 不以 P6 的构造器覆盖取消既有 seat/order 候选，不以 P9 局部接受合法时间替代 d2 跨层恢复验证。若后续出现新候选，先记录证据、交另一审查者独立复核，不能先确认再补二审。
4. 本任务不要求额外重跑。若统一 validation 另行获准运行 logger／仓储相关测试，显式隔离 TEMP 日志／持久化根，检查 preload，而不是把 `--no-env-file` 当作无 IO 保证。

---

静态源码核验快照：2026-10-20T17:56:45.613Z；报告写入后的 refs／工作区复核：2026-10-20T18:02:50.037Z，固定值未变。九项账本机械核验为 rows=9、unique=9、sections=9、missing=[]、extra=[]、无待填占位，九个工作树文件均与固定 HEAD 一致。报告首次后置核验命令因嵌套 PowerShell 变量转义失败 exit 1，报告本身写入成功；随后独立只读核验成功，该命令问题不是生产代码／测试失败。本报告没有改写原 coverage ledger。
