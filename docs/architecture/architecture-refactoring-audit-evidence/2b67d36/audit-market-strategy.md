# 行情→指标→信号→延迟验证→交易队列：只读业务等价性审计（G2）

## summary

- **verdict：在下述实际覆盖范围内，未发现已确认的当前新增业务缺陷；不能据此宣称全仓或所有外部时序完全等价。**
- scope：固定 develop 完整实现与当前实现的行情订阅/缓存、全部现存策略指标/DSL/条件规则、策略私有 pending/sample/timer、普通行情宿主与 emitter、BUY/SELL 队列入口；补查 G2 文件地图列出的显示、monitor quote 和 switch wakeup runtime，以及证明事件接线所必需的启动、生命周期和执行入口。
- confidence：**策略/缓存核心 high；G2 整体 medium**。后者包含向席位换标、清仓、canonical snapshot 和券商提交 owner 的跨组边界，不能将本报告替代这些 owner 的独立审计。
- 固定基线：`develop = origin/develop = 6e239c8a128372bd9b2fb2d79464346792a5e81e`；当前 `beta-V2 HEAD = 2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。开始读取时及最终核对时引用一致；与主代理最终通知的统一 SHA 一致。
- 边界纪律：未 checkout/reset，未启动 `src/index.ts`、真实 QuoteContext/TradeContext 或实际交易；未改源码、测试、配置和架构计划；仅创建本证据报告。最终 `git status --short` 为空。
- 实际模型配置：二审已通过工具进程祖先 `Win32_Process.CommandLine` 和**本子会话** JSONL 双重核实为 **`provider=cliproxyapi / model=gpt-6.1-sol / thinking=max`**；未见后续切换记录。详见 §8.1，此结论取代首审时“元数据不可核实”的暂定说明。
- 已加载四项审计技能及 context-mode；读取 AGENTS 和指定实施计划的相关约束。业务真值始终取固定 develop 源码，不以当前 business skill、现有测试或计划的后补描述反推旧语义。

## critical issues

None. 未确认当前新增 critical 缺陷。

## major issues

None. 未确认当前新增 major 缺陷。

## minor issues

None. 未将旧路径名残留注释、格式偏好或单纯文件拆分计作缺陷。

## 1. 完整链路与已追踪不变量

### 1.1 真实入口与输出链路

```text
prepareStrategy → definition.prepare/config.parse → createSelectedStrategy（唯一实例）
  → createPreGateRuntime / createMarketDataClient
  → loadTradingDayRuntimeSnapshot.subscribeSymbols + subscribeCandlesticks
  → SDK quote/candlestick push
  → quoteClient 标准化、订阅过滤与 K 线缓存更新
      ├─ candlestickUpdated → businessEventProgram latest-only
      │   → 权威缓存快照 + 当前席位事实 + 新评估门禁
      │   → strategy.onCandlestick
      │       → 增量 committed/active preview 指标
      │       → 先写验证样本，再显示，再决定是否新评估
      │       → 四动作规则 → immediate emit / 私有 pending 注册
      │       → T0+10s timer → T0/T0+5s/T0+10s 最近样本验证
      │       → 保存的 emitter（原 day/route/seatVersion）
      │   → emitter 当前门禁/席位复核、字段白名单
      │   → STRATEGY_BUY / STRATEGY_SELL FIFO
      │   → baseProcessor → ordinaryBuy / ordinarySell → orderExecutor
      │   → 跨日/席位/连续交易/最终报价/原 caller 授权检查 → mutation permit
      └─ quoteUpdated → monitorQuoteEventRuntime / tradingRisk / display
          → 距离换标或静态清仓 owner；WAIT 交 switchWakeupRuntime
          → ORDER_EVENT/FRESHNESS/SYMBOL_QUOTE/RETRY_TIMER 重驱
```

**生产接线证据**：`src/app/runApp.ts:113-145,228-250,324-349`；`src/app/runtime/createPostGateRuntime.ts:418-429,530-578,638-681`；`src/app/runtime/createAsyncRuntime.ts:47-60,86-112`。策略、宿主、worker、生命周期均引用同一组 `tradingTimeState` / `lifecycleState` 对象，而不是拆分后复制的瞬时布尔值。启动先完成时间唤醒首轮评估再启动普通 K 线 owner：`src/runtime/lifecycle/startupRuntime.ts:20-42`。

### 1.2 与 develop 的具体对照

下表 develop 路径全部指固定 SHA；不是根据当前注释作出的推断。**时间术语**：候选评估 clock 为 `Tcreate`；立即信号的 `triggerTimeMs=Tcreate`；延迟信号的 `T0=triggerTimeMs=Date(Tcreate+delaySeconds×1000).getTime()`。以下三目标和 ready 时间都以这个延迟目标 T0 为准，不是从登记当下 Tcreate 再加 10 秒。

| 不变量 | 当前精确证据 | develop 精确证据 | 审核结论 |
| --- | --- | --- | --- |
| K 线先验证本地已 seed；旧 timestamp 不回退，confirmed=true 不被同 timestamp false 覆盖，重复 confirmed 不涨版本/不发事件 | `src/infrastructure/longbridge/market/candlestickCache.ts:153-226`；`quoteClient.ts:389-430` | `src/services/quoteClient/candlestickCache.ts:260-335`；`src/services/quoteClient/index.ts:393-433` | 规则保留；数值/时间标准化从旧缓存文件直接抽出到 mapper，不将金融文本精度变动回写指标 OHLCV |
| 宿主 single-flight/latest-only，只保留最新 observedAt，处理时读权威缓存；不以缓存版本额外取消策略采样 | `src/runtime/businessEventProgram/index.ts:34-41,105-120,130-154` | `src/main/businessEventProgram/index.ts:34-41,104-119,129-153` | 仅状态依赖拆分；原丢弃中间排队通知的策略未新增 |
| 未确认活动柱只 preview；confirmed/shift 才推进 committed，不重复累计同一活动柱 | `src/strategies/intradayRegression/indicators/index.ts:268-309,339-480` | `src/core/strategy/intradayRegression/runtime/index.ts:268-309,339-484` | 数学路径保留，局部 runtimeState 别名被消除，无新重算策略 |
| EMA/RSI/PSY/MFI/KDJ/MACD/ADX 按画像按需计算，原 seed/warmup/三位展示舍入保留 | 当前 `indicators/{ema,rsi,psy,mfi,kdj,macd,adx,indicatorMath}.ts`（见覆盖清单） | 旧 `runtime/{ema,rsi,psy,mfi,kdj,macd,adx,utils}.ts` | 六个数学文件函数体除 import 完全一致；MACD 仅删除未读的外层 fastPeriod 字段，真正 fast EMA state 的 period 仍保留；400 次直接双实现快照相同 |
| DSL 1–3 组、OR、组内 N-of-M、严格大于/小于；缺某指标只使该条件不满足，不机械拒绝整动作 | `src/strategies/intradayRegression/dsl.ts:124-229`；`signalRules.ts:89-159,273-323` | `src/core/strategy/intradayRegression/dsl.ts:124-229`；`utils.ts:88-158,272-322` | parser/config/profile 主体保留；普通条件仍经 decimalGt/Lt，验证仍用原 number 比较，没有悄悄互换 |
| 样本先提交，`allowNewEvaluation=false` 只阻止新候选，已有 pending 不因此被清空 | `src/strategies/intradayRegression/index.ts:149-194` | `src/core/strategy/intradayRegression/index.ts:149-194` | 原顺序不变；开盘保护不是 pending 结果额外拒绝条件 |
| 动作顺序 BUYCALL→SELLCALL→BUYPUT→SELLPUT；每动作在原位置读 clock；SELL 初始需要已成交买单 | `src/strategies/intradayRegression/constants.ts:15-44`；`index.ts:42-56` | `src/core/strategy/intradayRegression/constants.ts:15-44`；`index.ts:42-56` | 相同；没有通过删除订单记录检查扩大首次卖出候选集合 |
| 延迟目标为 now+delay；原始加法未前进时跳过，随后才 Date 截断；触发时间保存 T0 而不是 timer 回调时间 | `src/strategies/intradayRegression/index.ts:67-106` | `src/core/strategy/intradayRegression/index.ts:67-106` | 相同；0.0001/0.5/5/60/120 秒组合直接差分通过 |
| pending 去重身份为 symbol/action/T0；callback 必须同时命中 token；先删除 pending，再验证/emit；失效先撤授权再 cancel timer | `src/strategies/intradayRegression/verification/pendingVerification.ts:26-49,56-84` | `src/core/strategy/intradayRegression/verification/index.ts:53-76,83-111` | 仅将 passesVerification 抽出，没有新增宿主 pending 镜像、timer 重试或旧 callback 复活 |
| 三时点最近样本；等距离取较晚 timestamp；全部指标/时点必须存在有效值；ADX 全动作下降，BUYCALL/SELLPUT 其他指标上升，另两动作下降 | `src/strategies/intradayRegression/verification/index.ts:6-34`；`sampleRules.ts:62-87` | `src/core/strategy/intradayRegression/verification/index.ts:12-36`；`verification/utils.ts:61-86` | 相同；没有新增最大采样距离、回调时钟过期或连续三条事件要求 |
| emitter 形状/初始授权错误 fatal；同 origin 每 action 消费一次，并在当前门禁检查前记 consumed；当前 gate/day/seat 失效则静默丢弃 | `src/runtime/businessEventProgram/emissionAdapter.ts:19-87` | `src/main/businessEventProgram/emissionAdapter.ts:19-86` | 相同；SELL 使用 origin 的初始 hasFilledBuyOrders，不重新查询 |
| 策略不能提供 symbol/quantity/protective/orderType 等执行字段；宿主按白名单构造队列载荷 | `src/runtime/businessEventProgram/utils.ts:52-109`；`emissionAdapter.ts:61-77` | `src/main/businessEventProgram/utils.ts:52-109`；`emissionAdapter.ts:60-76` | 未把策略中立输出扩成下单能力；type 和运行时边界同时存在 |
| FIFO 保留信号身份与 triggerTime；诊断时间不改写业务信号；observer 异常不能改变 admission/通知 | `src/runtime/asyncProgram/tradeTaskQueue/index.ts:39-77,92-111` | `src/main/asyncProgram/tradeTaskQueue/index.ts:50-71`（旧无诊断元数据） | 新队列私有诊断状态不参与过期、去重或门禁 |
| 非保护性信号跨交易日或无有效 triggerTime 执行阶段丢弃；不是任意毫秒 TTL | `src/domain/order/executionPolicy.ts:51-57`；`src/application/orderExecution/index.ts:531-543` | `src/core/trader/orderExecutor/utils.ts:55-61`；旧 executor 的对应逐信号门禁 | 原过滤口径保留；未自行增加“同日等待太久即过期”的新语义 |
| 席位退出同步取消该方向 pending、清方向队列；跨日先停生产/drain，再 reset 同一策略实例 | `src/runtime/seatRuntimeCleanupDispatcher/index.ts:15-40`；`src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts:80-106` | `src/main/seatRuntimeCleanupDispatcher/index.ts` 对应清理；`src/main/lifecycle/cacheDomains/signalRuntimeDomain.ts:80-106` | 未引入新实例替代跨日重置；旧 emitter 当前 gate/route 仍二次阻断 |

### 1.3 失败归属、重试与副作用边界

- 行情 native 请求的有限重试仍在 `src/infrastructure/externalApi/index.ts:39-75`；`getQuotes` 明确配置零内部重试：`quoteClient.ts:493-500`，与 develop `src/services/quoteClient/index.ts:482-489` 一致。策略 timer 并不是行情重试，也不重试 emit。
- 普通 BUY external read 失败只结束本次信号；内部错误向 FIFO fatal 抛出：`src/application/ordinaryBuy/index.ts:120-125`。普通 SELL 显式 `QUOTE_MISSING` 才签发有限 quote retry，receipt supersession 在 owner 内重选，不虚构缺价：`src/application/ordinarySell/index.ts:74-101,267-287`；runtime 只管理 timer→FIFO：`src/runtime/asyncProgram/sellProcessor/index.ts:53-97`。此处追踪到执行入口，但买量/智能平仓经济计算属于 G4/G5 深入边界。
- Quote retain 的普通事件 mutation 失败进入 fatal；awaited position/activation 准入失败交还对应 owner；每个已成功 SDK 阶段立即提交 committed，不回滚已发生的订阅事实：`src/runtime/quoteSubscriptionRuntime/index.ts:188-267,333-357,451-465`。检查了后继普通命令不能接管 POSITION_HOLD 首次准入或偷偷复耗其失败预算。
- monitor quote 与 switch wakeup 的四类事件、dirty 重入、retain ack 后旧代次复核、stop/drain 吸收新增 release 均追踪：`monitorQuoteEventRuntime.ts:542-691,790-912`；`switchWakeupRuntime.ts:648-824,843-1050`。已读实际 application 距离 executor，未仅因 runtime 返回 WAIT 就假定方案正确。
- 最终订单副作用使用原 caller 闭包，重新检查当前席位、交易日事实、连续时段、目的和版本；最终报价在 mutation permit 内读取后再授权：`src/application/orderExecution/index.ts:341-468,488-584`；`submitFlow.ts:316-343`。**本报告不对其余 submit/replace/cancel 全部经济分支独立背书**。

## 2. 自查排除的候选（不是当前 findings）

以下候选均在提交前用 develop 源码排误报。严重级别只是“若为本次新增且业务禁止时”的风险估计，不计入本报告当前缺陷数。

### MS-C01：最近样本没有最大距离/回调时间 TTL

- 状态：**基线已有，排除为架构新回归**；估计严重级别 major（若另有业务要求禁止遥远样本）。
- 当前：`src/strategies/intradayRegression/verification/sampleRules.ts:38-51,62-87`；`sampleStore.ts:5-13`；`verification/index.ts:13-16`。
- develop：`src/core/strategy/intradayRegression/verification/utils.ts:37-50,61-86`；`verification/sampleStore.ts:5-13`；`verification/index.ts:18-21`。
- 最小触发：候选已登记，后续行情稀疏，队列仍有一个更近但距离目标较远的有效样本；timer 晚触发时 query 不按 callback 当前时钟重新裁剪。
- 真实链路：K 线采样→仅 push 裁剪 retention→timer→每个 T0+offset 选最近条目→严格比较初值→保存 emitter。
- 影响：潜在使用较远样本，但**旧实现行为完全相同**；不能添加容差/超时保护后声称是纯重构修复。
- 根因修复方向：本审计不建议改业务。若用户未来批准更严格采样新需求，应在共享采样查询/验证契约一次性定义容差和 late timer 语义。
- 验证：附录 A 差分；`bun test tests/strategies/intradayRegression/verification`。
- 现有测试边界：sampleRules/verification 已验证 nearest/tie 和缺值；它们不能证明产品需要新的时间容差。覆盖不足不是新增需求授权。
- lenses：implementation、tests、comments。

### MS-C02：开盘保护中，已登记的延迟 SELL 仍可能输出，且不重查买单记录

- 状态：**基线已有且链路一致，排除**；估计严重级别 major（仅假定保护期应阻止已有 pending 时）。
- 当前：`src/strategies/intradayRegression/index.ts:49,171-176`；`src/runtime/businessEventProgram/index.ts:46-54`；`emissionAdapter.ts:25-48`。
- develop：`src/core/strategy/intradayRegression/index.ts:49,171-176`；`src/main/businessEventProgram/index.ts:46-53`；`emissionAdapter.ts:25-47`。
- 最小触发：T0 初始存在已成交买单并登记 SELL；后续买单记录被移除、openProtectionActive 变 true，但普通 lifecycle/canTrade/day/seatVersion 仍合法；验证通过。
- 真实链路：初始 seat hasFilledBuyOrders 锁存 origin→保护期 onCandlestick 继续采样但不新评估→pending timer 使用原 emitter→origin 校验而非再次查订单→当前普通 gate/seat 复核→SELL queue。
- 影响：输出可能存在，但并非本次扩大候选或去掉门禁；最终可卖量仍由 SELL owner/executor 决定。
- 根因修复方向：无需本次修复；将保护期加入 emitter 或复查初始订单会改变 develop 行为。
- 验证：已运行 `tests/runtime/businessEventProgram/strategyIntegration.test.ts` 中真实 pending 场景及 `tests/integration/delayedStrategySell.integration.test.ts`。
- 现有测试边界：已有真实策略与宿主集成明确覆盖该行为；不使用这些新测试作为需求来源，结论来自上列旧源码。
- lenses：implementation、project/spec、tests、types。

### MS-C03：相同缓存版本继续采样/同方向多次 T0，不是全局 action 去重

- 状态：**基线已有，排除**；估计严重级别 major（仅假定业务应全局抑制重复候选时）。
- 当前：`src/runtime/businessEventProgram/index.ts:105-120`；`src/strategies/intradayRegression/index.ts:171-190`；`verification/pendingVerification.ts:59-60`；`src/runtime/businessEventProgram/emissionAdapter.ts:15,29-33`。
- develop：`src/main/businessEventProgram/index.ts:104-119`；`src/core/strategy/intradayRegression/index.ts:171-190`；`verification/index.ts:86-87`；`src/main/businessEventProgram/emissionAdapter.ts:15,29-33`。
- 最小触发：连续通知最终读到同一缓存版本，clock 为不同毫秒；同方向条件连续满足。
- 真实链路：宿主仅压缩积压通知→每次被选中调用仍写样本/评估→symbol/action/T0 仅抑制相同身份 pending→每 origin/action 只 emit 一次→不同 origin 可以分别入队→执行层买入频率 owner 再控制实际尝试。
- 影响：多个候选/样本并非新增重复下单漏洞；不得用“更严格去重”擅自改变信号频率。
- 根因修复方向：本次无需修复；若未来改信号节流应由业务明确指定 owner、窗口、SELL 与 BUY 的区别。
- 验证：`tests/runtime/businessEventProgram/business.test.ts:8-28`、附录 A 的策略事件差分均已运行。
- 测试边界：单层队列测试不能证明最终频率或重复提交安全，本报告仅追踪到最终授权/频率消费入口，交 G4 复核订单提交全链路。
- lenses：implementation、types、tests、simplification。

### MS-C04：RSI 退化返回 100、MFI 缺成交量当 0 等隐藏兜底

- 状态：**基线已有，排除**；估计严重级别 major（若新业务明确禁止此数学定义）。
- 当前：`src/strategies/intradayRegression/indicators/rsi.ts:88-99`；`mfi.ts:109-119`；`indicatorMath.ts:12-28`。
- develop：`src/core/strategy/intradayRegression/runtime/rsi.ts:88-99`；`mfi.ts:109-119`；`utils.ts:11-27`。
- 最小触发：平盘 RSI 导致非有限 raw value，或有效 H/L/C 但成交量缺失。
- 真实链路：标准化 candle→对应指标 commit/read→profile snapshot→条件规则/验证初值。
- 影响：相应指标边界值是既有数学口径，非重构为了放行信号新增的 fallback；KDJ 对缺失/非有限 H/L/C 的拒绝也没有被这类宽转换替换。
- 根因修复方向：保留旧行为；不能在本次架构审计直接改数学定义。
- 验证：指标源函数体对照、400 次快照直接差分以及 indicators 测试目录。
- 测试边界：有限随机样本不证明所有极值计算；源级 body 对照是此处主要证据。
- lenses：implementation、comments、tests。

## 3. 非字节相等但有可证明收益的架构差异

这些差异单独列明，不用“新架构正确”代替旧行为对照，也不把它们都称作完全等价。**二审口径校正**：存在收益的设施/owner 实现差异，不自动构成业务需求变更；应继续追到可观察的交易、放行、数量或经济结果才判断业务漂移。下列 metadata 一致性和 WAIT 存活差异是实现对照证据，不是要求用户批准每个内部时序变化。§8 已独立追查 WAIT 在末日、午休与停机的真实授权边界：未确认增加普通交易权限，也未确认改变这些接缝的交易数量结果。

1. **行情读取入口捕获 metadata，移除退订竞争造成的伪零价。**
   - 旧：`src/services/quoteClient/index.ts:474-520`，await realtime 后读取 cache，退订并发可使 `prevClose ?? 0`、name/lotSize 丢失。
   - 新：`src/infrastructure/longbridge/market/quoteClient.ts:468-529`，首个 await 前捕获已验证 staticInfo/prevClose；`requirePrevClose` 位于 `363-371`。
   - 已运行同一离线竞争：开始合法 getQuotes→realtime 挂起→unsubscribe→realtime 返回。旧输出 `{name:null,prevClose:0,lotSize:null,price:101.1}`；新输出 `{name:"Captured Name",prevClose:"99.2",lotSize:100,price:"101.1"}`。
   - 收益：返回的是同次合法读取的完整元数据，不把在途退订误造成金融事实 0。此改变不授权旧信号交易；宿主/用例/executor 原席位与 gate 闭包仍逐层验证。对应现有回归 `tests/infrastructure/longbridge/market/quoteClient.test.ts:763` 已运行。
2. **金融 quote 原文与指标 primitive 投影分离。**
   - 旧 quote builder `src/services/quoteClient/index.ts:302-316,336-350` 经 SDK Decimal→number；新 `quoteClient.ts:289-307,325-342` 经 `quoteFinancialMapper.ts:12-38` 保真文本。K 线标准化则保留旧 toNumber 算法，见 `candlestickMapper.ts:5-35`。
   - 收益：quote 经济计算不再经过浮点桥；指标 OHLCV、warmup、舍入/条件比较的业务口径不跟随金融精度迁移重新定义。未以金融新精度倒推新的指标阈值规则。
   - 边界：没有声称 arbitrary malformed SDK 字段/超出 SDK Decimal 表示域的配置异常集合都与旧实现逐字相同；见 not assessed。
3. **Quote 订阅 mutation 后重投影当前 truth，并按所属入口隔离首次准入。**
   - 旧：`src/main/quoteSubscriptionRuntime/index.ts:129-151,256-260`，单次计算差集后跨 await 使用；新：`src/runtime/quoteSubscriptionRuntime/index.ts:138-267` 循环重读、保护当前事实、保留部分成功 ack，ORDINARY/POSITION_HOLD/NONE 权限分开。
   - 收益：真实持仓/席位在 SDK await 间改变时，不让旧差集退订当前被需要的标的，也不让无关命令偷重试 awaited owner 的首次订阅。
   - 验证：failureOwnership 单测和 `quoteSubscriptionFailureOwnership.integration.test.ts` 已运行。不是仅按新增代码行数评价复杂性；这几类状态分别对应可触发的不同失败责任，未确认无业务价值的额外框架。
4. **switch WAIT 保留 owner 与推进授权分离，补在途订单事件空隙。**
   - 旧：`src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:178-195` 将末日接管同时视作销毁 route；`802-814` 只查询已安装的 ORDER_EVENT 索引。
   - 新：`src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:177-196` 只暂停接管期间推进；`843-864` 对仍有效在途 route 锁存当前席位订单事件；`1007-1049` 只接收原 epoch/真实 publishedRoute 的 WAIT。
   - 收益：真实已发布的 WAIT/已接单不能因为返回时授权已失效而失去唤醒 owner；新授权并不因此获得补票，真正 advance 仍被 purpose/gate/receipt/seat 阻断，stop/day-cut 仍释放 retain/timer。
   - 边界：这是可观察的 owner 保留差异，不称“完全无差别”；它的合理性取自“已提交工作不能丢归属”和最终门禁检查，而非只引用计划。已检查现有 lunch/takeover/old seat/retain races 回归，未运行实际交易。
5. **删除已无业务消费的 MACD 外层 fastPeriod 及类型别名。**
   - 当前 `indicators/macd.ts:24-33,44-54` 对照旧 `runtime/macd.ts:24-34,45-56`；真正 fastEmaState.period 仍在 create/clone 中。
   - profile 的 DisplayIndicatorItem 原等价别名被直接用 ProfileIndicator 替代；没有缩减显示计划内容或顺序。属于有依据简化，不是减少指标种类。

## 4. 历史修复复查

### d2aa59054abac546f506b27df45f161afcfc6578

- 实际改动仅见 `src/application/orderTracking/orderMonitor/settlementFlow.ts` 的保护性终态事实验证，删除 `executedTimeMs > orderUpdatedAtMs` 拒绝条件；当前保留于 `:263-272` 的检查仍要求真实数量、金额、执行时间和 revision，不把合法独立时间关系当失败。
- **根因校正**：develop 本来就有两时间相对顺序判断；旧两者实际同源于 order updatedAt。重构引入独立执行时间后该假设才成为错误；不能报告为重构新增了该判断。
- G2 的 pending/指标/采样不直接改于此提交。已追查它对订单事实和策略 SELL 初始 buy-record 消费的接口影响，运行真实 delayed strategy、ordinary raw execution、recorder boundary 和 recovery 集成。
- 分类：**历史修复在本链路未发现重新引入；保护性 settlement 所有候选/金额覆盖/崩溃恢复是否完整，仍由 G4/G5 深入审计，不在此宣称已全部证明。**

### 2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144

- 与 G2 接线相关的 app 改动为 `createPostGateRuntime.ts:307` 不再把 orderEconomics 注入 broker reader；策略文件、普通行情宿主和 K 线算法本次未变。
- 已读取 recorder 的修改：`src/application/orderTracking/recorder/index.ts:255-263` 直接交还原 API facts，不再用当前经济证据包装旧查询；策略 `hasFilledBuyOrders` 读取仍从正式 owner 的 `getBuyOrdersForSymbol`，不是恢复文档的新假定。
- 已运行受该提交修改的 `delayedStrategySell.integration.test.ts`、`singleActiveStrategyExecution.integration.test.ts`，以及 `strategyRecoveryStartup.integration.test.ts` 和相关原始执行事实测试。
- 分类：**本范围未确认修复残留引起的信号/队列漂移；execution 驱动启动、全局数量整数化、混合市场范围三个根因的完整闭环属于 G0/G1/G4/G5/G6 的交叉审计边界。**不把集成测试通过当作这些根因全量修复证明。

## 5. 七个 review lenses

| lens | 实际核对与结果 |
| --- | --- |
| implementation | 完整追踪订阅 ack、cache seed/push、latest-only、committed/preview、样本先提交、pending token、原 origin emitter、queue admission、worker、最终 caller 授权；未确认新增逻辑错误。上列 MS-C01–04 已回到 develop 排误报。 |
| project/spec | 用固定 develop 行为优先，计划仅作“不能扩功能/owner边界/精度分离”约束。策略未获得 Broker/queue/risk 能力；state 拆分接线共享原对象；具体策略常量未被宿主导入。未以旧代码仍在旧目录、或新目录命名正确代替链路证明。 |
| type design | 读 StrategyMarketContext/Decision/Emitter、市场 port、样本三态、方向路由、Buy/Sell task 映射。生产输出白名单运行时复核，策略不能伪造 quantity/protective/seatVersion。指标私有 mutable state 有 clone/commit 边界；readonly 文本本身不是冻结证明，缓存 candle 与策略投影确有 Object.freeze。 |
| tests | 查测试具体场景与关键断言，四批离线测试和双实现差分通过；未用通过数量等同业务等价。现有测试不覆盖真实 SDK callback 调度/恢复重放的所有排列，也不证明极端浮点全集。未确认需要作为缺陷提交的独立关键缺测根因。 |
| comments | 核对“先样本后评估”“旧 emitter origin”“consume 在 current gate 前”“timer token 先失效”“retained WAIT 不代表推进授权”等关键 why 与实现一致；少量旧模块名/lastState @param 残留不影响行为，不以噪音凑 minor。 |
| dead code | 对 G2 的导出做全生产 TypeScript AST 标识符消费初筛（143 个导出符号），唯一仅一次出现为 strategyDefinition；随后追踪 loader 固定字符串 `STRATEGY_DEFINITION_EXPORT_NAME` / Reflect.get，确认动态消费，不能删除。其余私有返回属性也追踪宿主/lifecycle 直接消费者；未提出 A 级未消费候选。外部/dynamic 导出普遍性证明不在此次扫描能力范围。 |
| simplification | 已确认 MACD 未读元数据/类型别名消除、验证纯函数从 pending owner 分出不增业务状态；Quote mutation 的投影范围、dirty、committed 各自对应真实异步失败责任，不按行数判过度设计。未确认无业务价值的额外抽象。 |

## 6. 实际生产文件覆盖清单

### 覆盖等级

- **深读**：实际读取函数/类型正文并追调用和状态流；不是只搜索路径。
- **等价 diff 核对**：固定 SHA 的完整 diff/去 import 注释 AST 正文对照，并对非等价 body 分支复读。40 个可一一对应 G2 TS 文件中，22 个去 import/注释后声明与正文相同；另 18 个差异逐项检查；另有 1 个 JSON 和 1 个抽出的 verification/index.ts，共 42。
- **边界读取**：为证明接线读具体区段，不宣称这些文件其余全部业务分支已深读。

### 6.1 G2 地图 42/42：全部已深读并作来源/diff 核对

**共享门禁/重试（3）**

- `src/application/quoteRetry.ts`
- `src/domain/strategy/ordinarySignalGuard.ts`
- `src/domain/strategy/utils.ts`

**行情事件/显示/wakeup runtime（10）**

- `src/runtime/monitorDisplayRuntime/index.ts`
- `src/runtime/monitorDisplayRuntime/types.ts`
- `src/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts`
- `src/runtime/monitorQuoteEventRuntime/setUtils.ts`
- `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts`
- `src/runtime/monitorQuoteEventRuntime/types.ts`
- `src/runtime/quoteSubscriptionRuntime/index.ts`
- `src/runtime/quoteSubscriptionRuntime/types.ts`
- `src/runtime/tradingQuoteDisplayRuntime/index.ts`
- `src/runtime/tradingQuoteDisplayRuntime/types.ts`

**现存全部策略文件（29）**

- `src/strategies/intradayRegression/config.json`
- `src/strategies/intradayRegression/config.ts`
- `src/strategies/intradayRegression/constants.ts`
- `src/strategies/intradayRegression/definition.ts`
- `src/strategies/intradayRegression/display.ts`
- `src/strategies/intradayRegression/dsl.ts`
- `src/strategies/intradayRegression/index.ts`
- `src/strategies/intradayRegression/indicatorHelpers/types.ts`
- `src/strategies/intradayRegression/indicatorHelpers/utils.ts`
- `src/strategies/intradayRegression/indicators/adx.ts`
- `src/strategies/intradayRegression/indicators/ema.ts`
- `src/strategies/intradayRegression/indicators/index.ts`
- `src/strategies/intradayRegression/indicators/indicatorMath.ts`
- `src/strategies/intradayRegression/indicators/kdj.ts`
- `src/strategies/intradayRegression/indicators/macd.ts`
- `src/strategies/intradayRegression/indicators/mfi.ts`
- `src/strategies/intradayRegression/indicators/psy.ts`
- `src/strategies/intradayRegression/indicators/rsi.ts`
- `src/strategies/intradayRegression/indicators/types.ts`
- `src/strategies/intradayRegression/profile/index.ts`
- `src/strategies/intradayRegression/profile/types.ts`
- `src/strategies/intradayRegression/profile/utils.ts`
- `src/strategies/intradayRegression/signalRules.ts`
- `src/strategies/intradayRegression/types.ts`
- `src/strategies/intradayRegression/verification/index.ts`
- `src/strategies/intradayRegression/verification/pendingVerification.ts`
- `src/strategies/intradayRegression/verification/sampleRules.ts`
- `src/strategies/intradayRegression/verification/sampleStore.ts`
- `src/strategies/intradayRegression/verification/types.ts`

**对应 develop 文件映射**：runtime 上述同名文件从 `src/main/` 读取；策略从 `src/core/strategy/intradayRegression/` 读取，`indicators/` 对应旧 `runtime/`，`indicatorMath.ts` 对应旧 `runtime/utils.ts`，`signalRules.ts` 对应旧策略 `utils.ts`；新 `verification/index.ts` 和 `pendingVerification.ts` 对应旧 `verification/index.ts` 两部分；`sampleRules.ts` 对应旧 `verification/utils.ts`。共享门禁来自 `src/main/ordinarySignalGuard/index.ts`，策略 ID 工具来自 `src/core/strategy/utils.ts`，quoteRetry 来自 `src/utils/quoteRetry/index.ts`。非精确 diff 部分均已另外追查，不把 rename score 当等价证明。

### 6.2 直接行情设施、宿主与队列：额外已深读

- `src/infrastructure/longbridge/market/quoteClient.ts`（全文分段）
- `src/infrastructure/longbridge/market/candlestickCache.ts`
- `src/infrastructure/longbridge/market/candlestickMapper.ts`
- `src/infrastructure/longbridge/market/marketEnumMapper.ts`
- `src/infrastructure/longbridge/market/marketMetadataMapper.ts`
- `src/infrastructure/longbridge/market/quoteFinancialMapper.ts`
- `src/infrastructure/longbridge/market/types.ts`
- `src/infrastructure/longbridge/market/warrantListReadAdapter.ts`
- `src/infrastructure/longbridge/market/warrantRequestMapper.ts`
- `src/infrastructure/longbridge/market/warrantListCache/index.ts`
- `src/infrastructure/longbridge/market/warrantListCache/types.ts`
- `src/runtime/businessEventProgram/index.ts`
- `src/runtime/businessEventProgram/emissionAdapter.ts`
- `src/runtime/businessEventProgram/utils.ts`
- `src/runtime/businessEventProgram/types.ts`
- `src/runtime/asyncProgram/tradeTaskQueue/index.ts`
- `src/runtime/asyncProgram/tradeTaskQueue/types.ts`
- `src/runtime/asyncProgram/taskNotifications.ts`
- `src/runtime/asyncProgram/processor.ts`
- `src/runtime/asyncProgram/buyProcessor/index.ts`
- `src/runtime/asyncProgram/sellProcessor/index.ts`
- `src/types/strategy.ts`
- `src/types/marketPorts.ts`
- `src/types/data.ts`
- `src/types/quote.ts`
- `src/types/signal.ts`
- `src/types/runtime.ts`
- `src/utils/numeric/index.ts`（仅指标比较，不等于 exact.ts 全部经济运算已审）
- `src/infrastructure/externalApi/index.ts`
- `src/infrastructure/time/index.ts`
- `src/constants/strategy.ts`

对应基线还实际读取/对照了 `src/services/quoteClient/{index,candlestickCache,utils,types}.ts`、`src/main/businessEventProgram/{index,emissionAdapter,utils,types}.ts`、`src/main/asyncProgram/{buyProcessor/index,sellProcessor/index,tradeTaskQueue/index}.ts`，以及 `src/utils/numeric/index.ts`。行情文本迁移不是仅靠当前测试确认。

### 6.3 为闭合接线/取消/最终门禁额外阅读的文件（注明深度）

**已深读，范围为该文件所列功能**

- `src/app/startup/prepareStrategy.ts`
- `src/app/startup/createSelectedStrategy.ts`
- `src/app/startup/strategyLoaderHelpers.ts`
- `src/app/runtime/createAsyncRuntime.ts`
- `src/app/context/createMonitorContext.ts`
- `src/app/lifecycle/createLifecycleRuntime.ts`
- `src/runtime/lifecycle/startupRuntime.ts`
- `src/runtime/lifecycle/terminationRuntime.ts`
- `src/runtime/lifecycle/cacheDomains/signalRuntimeDomain.ts`
- `src/runtime/lifecycle/cacheDomains/marketDataDomain.ts`
- `src/runtime/lifecycle/cacheDomains/globalStateDomain.ts`
- `src/runtime/seatRuntimeCleanupDispatcher/index.ts`
- `src/runtime/seatRuntimeCleanupDispatcher/queueCleanup.ts`
- `src/runtime/tradingGateEventRuntime/index.ts`
- `src/runtime/tradingRiskEventRuntime/tradingRiskEventRuntime.ts`
- `src/runtime/tradingRiskEventRuntime/routingIndex.ts`
- `src/runtime/tradingRiskEventRuntime/routeValidation.ts`
- `src/runtime/tradingRiskEventRuntime/types.ts`
- `src/application/ordinaryBuy/index.ts`
- `src/application/ordinarySell/index.ts`
- `src/application/seatSwitch/distanceSwitch.ts`
- `src/domain/seat/seatIdentity.ts`
- `src/domain/order/executionPolicy.ts`
- `src/domain/order/quoteReadiness.ts`
- `src/infrastructure/display/marketMonitor/index.ts`

**边界读取/定向 diff，不宣称其全业务已审**

- `src/app/runApp.ts`：策略创建、终止 stopProducers、businessEventProgram 注入、启动次序。
- `src/app/runtime/createPreGateRuntime.ts`：唯一 market/cache 创建与缓存 TTL 注入。
- `src/app/runtime/createPostGateRuntime.ts`：共享 state 对象、Quote runtime、monitorContext、交易用例和行情事件 runtime 装配。
- `src/runtime/timeWakeupEvaluationProgram/index.ts:270-407`：canTrade/openProtection/takeover 对策略 invalidateAll 和 gate event 的顺序；与旧 `src/main/timeWakeupEvaluationProgram/index.ts` 定向 diff。
- `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:660-785`：真实 quote/candle 订阅入口及 receipt 校验；其他历史恢复算法由 G1/G4/G5 审。
- `src/application/orderExecution/index.ts:330-655`：跨日、当前席位/目的、caller closure、executeSignals 入口和结果事实映射。
- `src/application/orderExecution/submitFlow.ts:240-450`：mutation permit 内最终行情/授权/频率/买量调用入口；其余撤改单/合单分支不在此全审。
- `src/application/staticLiquidation/index.ts`：候选、snapshot/receipt/quote 授权、ack 与 WAIT 返回；财务阈值和完整恢复责任由 G5 审。
- `src/application/postTradeSettlement/readinessGate.ts:65-209`：receipt current/markFresh/waitForFresh；未重审 settlement 全部事务。
- `src/application/accountPositionSnapshot/index.ts`：getView/isCurrent/invalidate、commit 和 generation 的相关实现；未重审全部批调度/混合市场过滤。
- `src/application/orderTracking/recorder/index.ts`：getBuyOrdersForSymbol 消费接口、原 API facts 返回与 2b67d36 diff；未代替 G4 对经济投影全审。
- `src/application/orderTracking/orderMonitor/settlementFlow.ts:245-300`：d2aa590 当前真实执行时间验证。
- develop `src/services/autoSymbolFinder/index.ts:35-45,129-207`：轮证列表旧请求/cache/TTL/inFlight 源语义；候选排序不是本组完整覆盖。

## positive findings

1. 原策略同步调用/私有异步 timer 与宿主当前授权边界被保留：保存的是 emitter 而不是交易能力，已失效 token 不能重放。
2. 指标 active preview 与正式 commit 的隔离没有因目录重构丢失；三态验证样本不把缺失或无效值补成 0 放行。
3. 真实接线没有遗留“旧 verifier 正在处理，新策略也在处理”的双 owner：策略唯一实例从 prepare/create 注入；宿主只负责 origin 和普通信号适配。
4. subscribe/unsubscribe 部分成功事实、retained owner 和失败责任被明确区分，旧命令跨 await 重投影不是无依据 fallback。
5. 队列诊断采集是旁观者，异常隔离不影响 FIFO admission、signal.triggerTime 或消费者通知。

## not assessed

- **外部 broker 实际调度**：没有生产凭据，也禁止真实交易；未验证 Longbridge native 回调在网络重连、重订阅 seed 之前推送的全部排列。这些不以 mock 契约测试冒充真实证明。
- **异常/非业务输入全集**：未知 SDK period、伪造 Decimal、超出 SDK Decimal 表示域的阈值、任意畸形 timestamp 的错误集合未与旧实现做穷举。只在有真实可达依据时才可升格为缺陷，不能以推测性输入新增兜底。
- **混合市场/整数数量完整性**：涉及 2b67d36 的非港股事实过滤、全局数量整数化和金额投影不由 G2 独立证明；需 G4/G5/G6 交叉核对。
- **席位和清仓经济算法**：已读距离启动与 WAIT 交接，但 `seatSwitch` 内全部计划阶段、智能平仓/浮亏/日损/末日清仓、订单 merge/replace/cancel 的经济副作用归属由相应组负责。
- **源码动态外部消费**：已追 fixed strategyDefinition 动态加载，但不证明所有可能外部工具/下游 API 都没有消费其他导出；没有建议删除不确定 dead code。
- **并发穷举**：没有做所有快照刷新、retained release、交易时段边界、SDK ack 排列的模型检验。有限差分和现有测试只覆盖具体场景，不是全量等价的形式证明。

## 7. 可运行验证与实际结果

运行环境：仓库 cwd `D:/Code/HSI-Strategy-Trading`，Bun `1.4.2 (744846f84)`。未运行格式化或 lint:fix；`type-check` 的 tsconfig `noEmit:true`，不产生构建文件。

### T1：行情/策略/宿主/订阅/队列核心

```powershell
bun test tests/strategies/intradayRegression tests/infrastructure/longbridge/market tests/runtime/businessEventProgram tests/runtime/quoteSubscriptionRuntime tests/runtime/asyncProgram/tradeTaskQueue tests/runtime/lifecycle/cacheDomains/signalRuntimeDomain.test.ts tests/integration/delayedStrategySell.integration.test.ts tests/integration/singleActiveStrategyExecution.integration.test.ts tests/integration/quoteSubscriptionFailureOwnership.integration.test.ts
```

结果：exit 0；**243 pass / 0 fail / 1672 assertions / 33 files / 3.98s**。

### T2：普通交易队列入口与最终报价授权

实际命令：

```powershell
bun test tests/application/orderExecution/finalQuoteMutationPermit.business.test.ts tests/application/orderTracking/orderMonitor/originalExecutionBoundary.business.test.ts tests/application/ordinaryBuy tests/application/ordinarySell tests/runtime/asyncProgram/buyProcessor tests/runtime/asyncProgram/sellProcessor tests/domain/strategy/ordinarySignalGuard.test.ts
```

结果：exit 0；**99 pass / 0 fail / 484 assertions / 10 files / 372ms**。

注意：命令内 `originalExecutionBoundary.business.test.ts` 不是现存文件，Bun 将不存在的 filter 忽略，**不能把该项声称为已测**。随后 T3 使用实际存在的 `ordinaryRawExecutionFacts.business.test.ts` / `executionFactBoundary.business.test.ts` 验证相关边界。此处保留实际执行记录而不是事后美化命令。

### T3：G2 补齐 runtime/历史原始执行/恢复

```powershell
bun test tests/runtime/monitorQuoteEventRuntime tests/runtime/monitorDisplayRuntime tests/runtime/tradingQuoteDisplayRuntime tests/runtime/seatRuntimeCleanupDispatcher tests/runtime/tradingRiskEventRuntime tests/application/orderTracking/orderMonitor/ordinaryRawExecutionFacts.business.test.ts tests/application/orderTracking/recorder/executionFactBoundary.business.test.ts tests/integration/strategyRecoveryStartup.integration.test.ts
```

结果：exit 0；**143 pass / 0 fail / 1078 assertions / 9 files**。报告生成后按上述完整命令再次核对，结果相同，耗时 **1.63s**。

### T4：策略加载与启动次序

```powershell
bun test tests/app/startup/prepareStrategy.test.ts tests/app/startup/createSelectedStrategy.test.ts tests/domain/strategy tests/runtime/lifecycle/startupRuntime.test.ts
```

结果：exit 0；**66 pass / 0 fail / 123 assertions / 4 files**。报告生成后按上述完整命令再次核对，结果相同，耗时 **361ms**。

上述四批代表性命令合计 551 个测试（不按唯一案例去重；不重复计入之后的核对运行）；**不是全仓测试，也不是以计数替代业务审计**。

### T5：静态类型与只读状态

```powershell
bun run type-check
git status --short
git rev-parse HEAD develop origin/develop
```

结果：type-check exit 0，输出 `$ tsc -p tsconfig.json`；status 空；SHA 与 summary 一致。

### T6：直接旧/新实现差分（无需 checkout、无需写 fixture）

结果：exit 0，输出：

```json
{"baseline":"6e239c8a128372bd9b2fb2d79464346792a5e81e","indicatorSnapshots":400,"strategyCases":24,"eventsPerStrategyCase":80,"cacheChecks":400,"baselineModules":24,"result":"all deepEqual"}
```

复现脚本见附录 A；使用 Bun transpiler 把 `git show SHA:path` 的 TS 在内存递归转换为 data URL，仅运行纯策略/缓存和 fake scheduler，未创建 SDK context。覆盖所有七类指标、活动/确认/shift、缺 H/缺 volume、旧事件、四动作、空验证集、微小小数延迟、按方向取消、跨日 reset/destroy 和旧 timer 失效。

### T7：入口 metadata 竞争对照

离线注入同一个 deferred realtime SDK 替身，两个实现分别执行 subscribe→getQuotes 挂起→unsubscribe→resolve。exit 0，结果：

```json
{"develop":{"name":null,"prevClose":0,"lotSize":null,"price":101.1},"current":{"name":"Captured Name","prevClose":"99.2","lotSize":100,"price":"101.1"}}
```

验证该项是明确列出的改进差异，而不是将不同输出伪称字节等价。现有对应生产回归位于 `tests/infrastructure/longbridge/market/quoteClient.test.ts:763`。

### 验证准备过程中的失败及处理

- 最初尝试 Bun.plugin 虚拟命名空间在 Windows `bun --eval` 加载基线，返回 cannot find baseline module；这是审计 harness 加载失败，不是生产缺陷。改用附录 A 的 data URL 内存加载后成功。
- `JSON.parse(tsconfig.json)` 因 JSONC 注释失败，随后直接检查 `noEmit:true` 并运行 tsc 成功；不将解析失败误报为配置损坏。
- 外部 evidence map 使用 ctx_execute_file 触发工作区访问限制；之后仅用 read 定向读取 G2 的 53 行，未整份加载 106KB 地图。

## recommended next actions

1. 主代理汇总时将本组结论写作“G2 42 文件已覆盖、未确认新增缺陷”，不要转换成“全架构全量等价已证明”。
2. 独立复核者可优先复核 §3 的 quote mutation/WAIT owner 改进差异与 §2 的四个排误报候选；本组没有待二次确认后才能定级的当前缺陷。
3. 与 G3/G4/G5/G6 对齐 not assessed 的经济/恢复/市场范围边界，特别是 2b67d36 三个根因；若其他组提供真实可达反例，再按共享根因开新 finding，不围绕症状新增 fallback。
4. 不按本报告执行任何源码清理或行为加固。nearest 容差、pending 保护期、全局信号去重的改变均需要另行业务授权。

## 8. 二审：G0 高风险接缝独立交叉复核

### 8.1 本子代理实际模型配置：已核实

本节是在用户指出可用核实路径后完成的**本会话本地证据**，不是借 baseline 代理或模板配置推定。

1. 由当前工具子进程执行 `Get-CimInstance Win32_Process`，沿 `ParentProcessId` 追溯到本子代理 RPC 进程：
   - 祖先链关键部分：PowerShell PID **51856** → Bun PID **33940** → context-mode Bun PID **33288** → 子代理 Node PID **48196**。
   - PID 48196 的命令行入口为 `@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc`，实际包含：
     ```text
     --provider cliproxyapi --model gpt-6.1-sol
     --session C:\Users\65459\.pi\agent\pi-codex-subagents\runs\d05757cd87992b122c072242\0f14212a-1f9c-4ef4-b64e-a7a54d86dd0b.jsonl
     --thinking max
     ```
   - 该路径关联的是**当前子会话**，不是只在全机搜索一个符合模板的其他进程。
2. 只读解析同一 JSONL（仅打印配置事件，不加载会话正文）：
   - `:2`，`2026-10-20T11:52:57.858Z`，`type=model_change`，`provider=cliproxyapi`，`modelId=gpt-6.1-sol`。
   - `:3`，同一时刻，`type=thinking_level_change`，`thinkingLevel=max`。
   - 在本次核对读取到的全部事件中，这两类事件各一条，**没有后续模型或 thinking level 切换**。

结论：本子代理本地运行配置已确认符合 **`cliproxyapi/gpt-6.1-sol max`**。这是本地客户端配置证据，不额外声称已经审计代理服务器内部路由；任务没有要求访问远端路由实现。

核实过程有一次 shell 方言误用：直接将 PowerShell 传给 ctx_batch 的 shell 执行器，产生语法错误；改为 `ctx_execute` 内显式 `powershell.exe -NoProfile -NonInteractive -Command ...` 后成功。错误没有改变模型配置或仓库。

### 8.2 二审范围、独立性与固定基线

- 对照读取 `audit-global-wiring.md:63-105` 的注册顺序与普通行情结论，以及 `:153,198-209` 的 stop/drain 和订单接缝说明；**结论没有直接继承为真**，重新沿当前生产调用链与固定 develop 核对。
- 固定 SHA 不变：当前 `2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`；develop/origin/develop `6e239c8a128372bd9b2fb2d79464346792a5e81e`。二审开始、结束的 `git status --short` 均为空。
- 只复核两处：**行情/订单初始化注册顺序**、**已发布 WAIT 的归属与后继推进授权**。没有重新运行 G2 首审的全指标/全缓存差分、551 测试批次、type-check 或全仓测试。
- “更优”的证据标准：证明存在可达的异步交错，现实现保留已提交工作归属、避免 lost wakeup/重复提交；同时不能把 keeper、当前新快照或新席位当成旧调用的新 mutation 票。不是按代码更多、注释更严或测试更多作判断。

### 8.3 接缝一：行情与订单初始化注册顺序

**二审判定：G0 的排除成立。没有发现初始化先订阅后装监听造成的新丢单，也没有因启动早行情新增普通交易准入。**

#### A. 资源创建不等于订阅/业务启动

- 当前 `src/infrastructure/longbridge/trade/clientFactory/index.ts:13-29` 只获取私有认证配置并返回延迟工厂；交易 context 仍由 `src/infrastructure/longbridge/trade/brokerAccessAdapter.ts:26-29` 在 `createTradeRuntime` 的原 try 内同步创建。
- `src/app/runtime/createPreGateRuntime.ts:62-79` 先创建唯一行情 client；该 client 创建时就安装 native 行情回调，但**不自动 subscribeSymbols/subscribeCandlesticks**。`src/app/runtime/createTradeRuntime.ts:50-110` 只装配账户、recorder、orderPushPort、monitor、executor；创建 orderPushAdapter 不调用 SDK subscribe，也不安装 order callback，见 `src/infrastructure/longbridge/trade/orderPushAdapter.ts:13-30`。
- develop 对应 `src/app/runtime/createPreGateRuntime.ts` 的 `buildMarketDataClient`、`src/app/runtime/createPostGateRuntime.ts:338` 的 buildTrader，以及 `src/core/trader/index.ts:44-47` 明确相同的“工厂不负责初始化 WS/恢复”。没有将认证或 adapter 创建误当首次订阅。

#### B. 订单：audit 注册 → BOOTSTRAPPING → native callback → Private subscribe → 恢复回放

| 阶段 | 当前证据 | develop 证据 | 独立核对 |
| --- | --- | --- | --- |
| 注册同步订单审计，并立即登记 disposer | `src/app/runtime/createPostGateRuntime.ts:438-452` | 同路径 `:443-458` | 早于 runApp 后续调用 startup loader；只是抽出 listener，不是延后到 worker start |
| loader 才初始化 Private 订阅 | `src/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.ts:412-414` | `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:248` | factory 完成之后，调用点没有提前到 audit 注册前 |
| 先 BOOTSTRAPPING，再 callback，再 await subscribe | `src/application/orderTracking/orderMonitor/index.ts:609-634` | `src/core/trader/orderMonitor/index.ts:432-465` | 即使 SDK 在 subscribe 返回前同步/异步送事件，也已有 consumer 和 boot buffer |
| boot 按 orderId 保存最新事实，恢复 owner 回放 | `src/application/orderTracking/orderMonitor/recoveryFlow.ts:143-198,538-553`；`eventFlow.ts:425-445` | `src/core/trader/orderMonitor/recoveryFlow.ts:132-180,499-514` | 保留既有 latest-per-order/水位协议；不是凭空承诺每条 native 历史事件都逐条审计 |
| 真正恢复 tracking | `src/application/tradingDayRebuild/rebuildTradingDayState.ts:417-427` | 旧同职责重建 owner | 正式 recovery 在 boot buffer 之后，audit listener 已存在；startRuntime 不代替首次 private 初始化 |

关键负向边界：`orderMonitor/index.ts:582-605` 在 STOPPED/finalized/termination 时先拒绝，再 decode；`initializeSubscription` 重复调用不会把 ACTIVE 降回 BOOTSTRAPPING，teardown 等在途订阅落定再退订。没有利用启动竞态重放到新生命周期。

已阅读并定向运行真实现存测试 `orderMonitor.business.test.ts:3311-3362`：先 initialize、注入较新 Filled、再恢复较旧 New snapshot，最终无 pending sell 且 recorder 保存真实数量/金额/执行时刻。它证明 boot replay 关键业务，不覆盖所有 broker 推送排列，也不作为旧需求来源。

#### C. 行情：native cache listener 早装，业务 listener 晚启，行为与 develop 一致

- native `setOnCandlestick` / `setOnQuote` 当前位于 `quoteClient.ts:390,432`，旧位于 `src/services/quoteClient/index.ts:390,432`；都在显式 subscribe 之前。
- loader 行情订阅当前 `loadTradingDayRuntimeSnapshot.ts:747-779`、旧 `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts:547-562`：先订阅 symbols，再订阅唯一 monitor 的 K 线并 seed，再 getQuotes。当前 `quoteClient.ts:768-782`、旧 `services/quoteClient/index.ts:761-772` 都在 subscribe 返回后，**同一同步段**发布本地订阅事实并 seed；没有在两者中间引入 await。
- 业务 runtime 只在 startup baseline 成功后启动，`src/runtime/lifecycle/startupRuntime.ts:20-42`；TimeWakeup 首轮评估完成后才 `businessEventProgram.start()`。宿主 `businessEventProgram/index.ts:126-155` 只订阅后续更新，不合成启动事件、不主动对已有 snapshot 发一次策略评估。这是旧语义，不是本次漏了新回放要求。
- 因此必须区分：**早到的已接入 K 线可更新本地缓存**，不意味着启动门禁前触发策略/普通交易；动态 quote 仍从 SDK realtime 读取，并非新增应用层动态 quote 缓存。没有把“先装业务 listener 才不丢数据”作为错误修复方向。

**独立双实现探针 S1（内存加载固定 develop，未落盘）**：fake SDK 在 subscribe 内先推一条、返回 seed 后在业务 listener 注册前再推一条、最后注册 listener 后再推一条。两个真实 quoteClient 均得到：

```text
native-candle-listener → native-quote-listener → subscribe-start
→ subscribe-seed-return → seed-committed → early-push-cached → business-listener
最终 version=3，candles=3，observedEvents=1，latestClose=103
```

两个实现对本地订阅尚未提交、seed 返回前的 push 都不接入；返回后、业务 owner 尚未启动的 push 都更新缓存但不补发历史业务事件。**这明确复现了既有边界，不将 seed 前 push 的 SDK 实际可否出现冒充已验证。**探针 exit 0，断言两实现输出相同。

### 8.4 接缝二：WAIT keeper 不等于推进/下单授权

**二审判定：所审三个窗口中，“已发布 WAIT 保留 owner”是有证据的 ownership 改善，未确认新增普通交易权限；不因内部 retain/timer 存活差异将其一概列为需求变更。**

#### A. 确实存在什么变化

- develop `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts:178-195` 在末日接管时删除 route；当前 `src/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.ts:177-196` 将“终止 owner”与“禁止普通推进”分开：termination/lifecycle 关闭才终止，接管则关执行门。
- develop 在 advance await 后先检查 gate，`switchWakeupRuntime.ts:738-767`；关闭时不安装返回的新 WAIT。当前 `:772-806` 对当前 route 的**真实 WAIT 先更新唤醒归属**，再因 gate 关闭返回。
- 这改变的是 owner/index/timer/quote retain 的存活与接棒，不是新增执行目的、信号动作或交易数量算法。必须追完以下层次才能判定是否越权。

#### B. 发布前不补票；发布后仅接收真实原 route 的 keeper

1. 当前 `src/application/seatSwitch/switchStateMachine.ts:499-637` 的 findCandidate、pending-order read 及发布前最终同步段都检查原 caller `canContinue`、原 ACTIVE symbol/seatVersion。跨 await gate/receipt/positions 失效就 NOOP，不会用当前新 snapshot 或新 ACTIVE 补票继续旧准入。
2. 真正 `enterSwitchingSeat` 后同步构建、存入 publishedState，`:640-684` 返回 publishedRoute 见证与初始 WAIT，**此段不做 cancel、SELL 或 REBUY**。见证只查询原 state identity、SWITCHING/symbol/version，不替换原 caller 授权。
3. `monitorQuoteEventRuntime.ts:653-688` 仅在 runtime 仍运行、原 dayEpoch 相同、publishedRoute 当前且席位确为该 SWITCHING identity 时 handoff；即使旧 ACTIVE closure 因自己刚提交的状态迁移失效，也不否认已发布事实。未发布、被新 map/席位替换、跨日或已停机的结果不能挂接到当前新 route。
4. 接收方 `switchWakeupRuntime.ts:1007-1049` 再检查 running/termination/lifecycle、原 epoch、context identity、publishedRoute 与 seatVersion，只登记 wakeups；handoff 本身不调用 advance/executeSignals。

**可达收益证据**：真实 publication fixture 的两项定向测试分别在 publication 前后越过 15:55：
- **前**：席位仍 ACTIVE，gate 失效后没有发布、handoff、advance 或 mock broker 调用。
- **后**：席位已 SWITCHING，keeper 被原 epoch owner 接收，timer 可存在；手动触发 timer 后 advance=0、mock broker=0，原 publishedRoute 仍可识别；day-cut/stop 后资源清空，重交旧 handoff 被拒绝。

这比单看“闭包 false 仍返回 WAIT”更有力：它区分已经提交的归属事实与下一次 mutation 许可，不保留假 route，也不丢真 route。

#### C. 后继推进有独立门禁，且只使用本轮原 receipt/选定 snapshot

- `switchWakeupRuntime.ts:648-687,705-769` 在 freshness 前后检查 running、lifecycle、canTrade、接管窗口和 route；`:545-555` 生成的 canContinue 还绑定该次 receipt、选定 positions token 与 dayEpoch。
- receipt/组件失效只向真实 freshness owner 等待，`:563-571` 不凭同一个 ready 水位无限本地轮询，也不把 keeper 变成新 receipt。
- 每个 state machine await 后继续检查 `canContinue && isCurrentSwitchStateValid(state)`；真实 SELL ACK 才绑定原 issued state，`switchStateMachine.ts:1056-1081,1855-1876`；真实 REBUY ACK 绑定旧 state 后，原票失效时只返回 ORDER_EVENT/FRESHNESS WAIT，`:1413-1430`。**承认 ACK 已经发生不等于再发一单**，后续重新调用仍需新一轮合法 route 授权。

#### D. 三个窗口逐项可达结果

| 窗口/交错 | develop | 当前 | 二审交易权限判断 |
| --- | --- | --- | --- |
| 午休前 advance 已在途，午休后返回 WAIT | 原 gate 关门后不装新 WAIT，但原 route 保留；午后 gate 打开重驱 | 原 route 保留并接收真实新 WAIT；午休中事件/timer 不推进；午后 gate 打开重驱 | 双方午休都不准继续 mutation；午后都按当前合法授权继续，不新增普通权限 |
| 正常日 15:55 / 半日市 11:55 接管前发布，接管后返回 | 原 owner 删除或拒收 | 保留原 WAIT keeper，普通执行 gate 关闭 | 窗口中 quote/order/fresh/timer 都不能重新 advance；keeper 无末日专用执行能力 |
| lifecycle `isTradingEnabled=false`、stop/stopAndDrain、termination | 停 owner 并撤授权 | 同样立即撤 running/lifecycle 授权；drain 等已在途结算，释放新增 retain/release | 等待 ACK/释放资源不能授权新普通单；晚 callback 不复活，旧 epoch 不跨日接棒 |

**时间边界特别核对**：接管窗口函数在 16:00（半日 12:00）退出，不应把“窗口已退出”读成“普通新单自动恢复”。即使 `tradingTimeState.canTrade` 暂未被 TimeWakeup 改写，最终 executor 仍按真实 clock 检查当前交易日、连续时段与目的，见下一段；本报告没有用可能滞后的 canTrade 作为唯一新单安全证明。此证明专指 submit/replace 的最终 executor 授权，不借此概括所有直接 cancel：换标 `CANCEL_PENDING` 通过 `switchStateMachine.ts:819-832` 把原 canContinue 传入 `SIGNAL_AUTHORIZED`，`orderMonitor/orderOps.ts:250-271` 在每次 attempt 调原授权。在本次指定的午休、接管窗口和 lifecycle/stop 期间，该原 closure 为 false；收盘后 TimeWakeup 延迟的所有本地推进/直接撤单排列没有被本节冒称已穷举，仍属完整订单 owner 交叉边界。

#### E. 最终 broker mutation 是第二层不可绕过的目的/时段边界

- `seatSwitch/signalBuilder.ts:35-57` 只提供 `SWITCH_MOVE` / `SWITCH_REBUY` 来源；状态机 `:1056-1060,1413-1418` 调的是 `orderExecutor.executeSignals` 并传原 caller closure，没有 `executeDoomsdayClearanceSignals` 能力升级。
- `src/application/orderExecution/index.ts:594-608` 明确将这些命令解析为 ORDINARY；`:341-430` 每次按当前交易日事实、真实连续时段、接管窗口、买入截止重新判目的；普通换标在接管中不能冒充末日清仓。正常日 15:45/半日市 11:45 后 BUY 已由同一最终门禁拒绝，keeper 不改变数量或拒买规则。
- `:439-468` 必须同时通过原 caller、当前 symbol/direction/seatVersion；`submitFlow.ts:322-346` 在 mutation permit 内及最终行情 await 后再次授权。收盘后、午休中、lifecycle/stop 后即使收到晚 ACK 或 retained quote，也没有新的 broker submit 票。
- 固定 develop 的 `src/core/trader/orderExecutor/index.ts:279-355,398` 已有同类真实时钟/目的检查。因此这里不是用新文档创造一套旧业务没有的窗口准入，而是在现有最终边界前保留真实等待归属。

#### F. 停机/跨日实际接线，不只验证 runtime 局部 stop

- `src/app/runApp.ts:65-93` 的 termination 同步关闭 lifecycle、queue admission 并 stop switch owner，先撤执行权，异步 cleanup 再 drain。
- `src/runtime/lifecycle/dayLifecycleManager.ts:206-228` 先关交易、同步发起新 dayEpoch clear；`cacheDomains/signalRuntimeDomain.ts:80-106` 先 abort freshness，排空上游 monitor，再 drain switch，最后订单/settlement/subscription；不是 Quote owner 先停后让旧 WAIT 再 retain。
- `switchWakeupRuntime.ts:930-999` stop 解绑全部事件、取消 timer；drain 等 active route 后再清理返回期间新增 wakeups/retain，循环等 quote mutations；旧 timer 还有 route/state/handle 身份复核。原 WAIT 在 day-cut 后 handoff 的 epoch 校验失败。

### 8.5 二审独立探针与定向验证（没有重复全量测试）

**S2：固定 develop 与当前 switchWakeupRuntime 的独立内存探针**。同一 fake snapshot/event bus/manager 注入到两个真实 runtime；manager 在 await 之后再次调用真实 runtime 签发的 canContinue，只有 true 才累加受测 mutation。不是拿测试新语义定义旧行为，也不是运行真实交易。

| 探针 | develop | 当前 |
| --- | --- | --- |
| 午休中在途 callback 的 mutation | 0 | 0 |
| 午休中 quote/order 事件造成额外 advance | 0 | 0 |
| 午后 gate 恢复后该 route 合法 mutation | 1 | 1 |
| 接管窗口内 callback 的 mutation | 0 | 0 |
| 接管窗口内 quote/order/fresh 造成额外 advance | 0 | 0 |
| 接管后保留返回的 retry timer | 0 | 1（触发仍被 gate 阻断） |
| lifecycle 关闭后 mutation；drain 后 listeners/timers | 0；0/0 | 0；0/0 |

S2 exit 0。额外 listener 数当前为 5、旧为 4，是 sell-operation 事件接棒，不是新交易动作；表中 mutation 是 fake manager 的受权操作计数，不能当实盘 broker 数量。真实 state machine 的发布前后、ACK 与最终门禁另由上文源码及下列定向测试交叉证明。

S2 准备时第一次把当前依赖名 `orderMonitor` 直接用于旧 runtime，旧接口要求 `trader`，harness 报 TypeError；补同一 fake owner 的旧名引用后成功，未更改生产代码。该 harness 故障不计业务差异。

**二审仅运行以下名称过滤测试**（八条命令；全部 exit 0）：

```powershell
bun test tests/application/orderTracking/orderMonitor/orderMonitor.business.test.ts -t "replays bootstrapping filled|retries private topic subscription|stopRuntimeAndDrain 后忽略|clearTrackedOrders 后到|重复 initialize"
bun test tests/infrastructure/longbridge/market/quoteClient.test.ts -t "publishes standardized candlestick update notifications"
bun test tests/application/tradingDayRebuild/loadTradingDayRuntimeSnapshot.test.ts -t "subscribes candlesticks for the unique monitor"
bun test tests/runtime/monitorQuoteEventRuntime/monitorQuoteEventRuntime.business.test.ts -t "does not hand WAIT|still hands off ordinary distance|does not publish or hand off|keeps an actual published"
bun test tests/runtime/monitorQuoteEventRuntime/switchWakeupRuntime.business.test.ts -t "through lunch|lunch aborts|continuation before stop|lifecycle gate|doomsday takeover begins|ignores old events and retry"
bun test tests/application/seatSwitch/switchStateMachine.business.test.ts -t "non-empty initial WAIT|SELL真实ack|takeover begins"
bun test tests/application/orderExecution/finalQuoteMutationPermit.business.test.ts -t "does not mutate when the execution gate closes"
bun test tests/application/orderExecution/submitFlow.errorClassification.business.test.ts -t "submits DOOMSDAY_CLEARANCE only"
```

结果分别为 **5、1、1、4、8、4、1、1 pass**，合计 **25 pass / 0 fail / 178 assertions**。被名称过滤的其余用例没有在本次二审执行，不重复计作首审测试或全仓验证。

S1/S2 均仅 `git show 固定SHA:path` → Bun 内存转译/data URL → 注入 fake 依赖；无 checkout、无落地旧源码、无连接券商。探针的精确命令与 stdout 保留在 §8.1 指定本子会话 JSONL 的 toolCall/toolResult 中；S1 以 `native handlers precede subscription`、S2 以 `closed-window business actions blocked in both` 可定向检索。实际失败的两个 harness 准备调用与成功结果没有混计。

### 8.6 二审结论与覆盖限制

- **新增 confirmed finding：0**。支持 G0 在本组相关两个接缝上的排除结论。
- **初始化顺序**：行情 native listener、订单 audit/native callback 和 boot replay 的先后与 develop 可达语义一致；晚启业务 owner 不等于晚装缓存/事实 listener，也没有新增启动普通交易。
- **WAIT owner**：保留真实已发布 route、接收在途真实 ACK 后的 WAIT、安装新事件索引，是可证明的 ownership/liveness 改善；不能因为多存活一个 timer/retain 就自动定为业务需求变更。已沿最终 executor 验证 keeper 没有给普通换标新增末日/午休/停机下单权限。
- **仅在真正业务结果变化时单列**：本二审未确认上述接缝导致额外普通交易、窗口错误放行或交易数量变化，因此不新增“需求变更”项。§3 的 owner/metadata 实现对照保留为证据，而非一概要求另行批准的业务漂移。
- **置信度与未评估**：两个指定接缝源码链路 high、有限交错验证 medium；未实盘验证 SDK subscribe 内部调度，未穷举所有 phase/quote/settlement 排列，也未将本次拓展为完整换标经济算法或订单恢复审计。S2 对 fake mutation 的结论不能替代整个真实 state machine 的全状态形式证明。

**二审新增实际读取的生产边界**：`src/application/orderTracking/orderMonitor/orderOps.ts:190-490`（重点为原授权传递与 permit，不是全文件订单经济逻辑）；`src/app/runtime/createTradeRuntime.ts`；`src/infrastructure/longbridge/trade/clientFactory/index.ts`；`src/infrastructure/longbridge/trade/brokerAccessAdapter.ts`；`src/infrastructure/longbridge/trade/orderPushAdapter.ts`；`src/application/orderTracking/orderMonitor/index.ts:580-690`；`eventFlow.ts:425-445`；`recoveryFlow.ts:130-215,404-564`；`src/application/tradingDayRebuild/rebuildTradingDayState.ts:395-437`；`src/application/seatSwitch/index.ts`；`switchStateMachine.ts:499-746,1015-1120,1370-1495,1650-1916`（授权/发布/ACK/推进分支深读，未声称全 1916 行经济逻辑全审）；`signalBuilder.ts`；`src/domain/liquidation/doomsday/index.ts`；`src/runtime/lifecycle/dayLifecycleManager.ts` 的关门/epoch 提交相关分支。其余重新复读文件已在 §6 清单列出。

## 附录 A：无落盘的基线/当前差分脚本

在仓库根 PowerShell 执行（仅 stdout；不会改仓库）：

```powershell
@'
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Period} from 'longbridge';
const BASE='6e239c8a128372bd9b2fb2d79464346792a5e81e';
const transpiler=new Bun.Transpiler({loader:'ts'}), urls=new Map();
function load(p) {
  if (urls.has(p)) return urls.get(p);
  let s=transpiler.transformSync(execFileSync('git',['show',BASE+':'+p],{encoding:'utf8'}));
  s=s.replace(/((?:from\s*|import\s*)['"])([^'"]+)(['"])/g,
    (all,a,spec,z)=>a+(spec.startsWith('.')
      ? load(path.posix.normalize(path.posix.join(path.posix.dirname(p),spec)).replace(/\.js$/,'.ts'))
      : import.meta.resolve(spec))+z);
  const u='data:text/javascript;base64,'+Buffer.from(s).toString('base64');
  urls.set(p,u); return u;
}
const oldS=await import(load('src/core/strategy/intradayRegression/index.ts'));
const oldC=await import(load('src/core/strategy/intradayRegression/config.ts'));
const oldI=await import(load('src/core/strategy/intradayRegression/runtime/index.ts'));
const oldK=await import(load('src/services/quoteClient/candlestickCache.ts'));
const newS=await import('./src/strategies/intradayRegression/index.ts');
const newC=await import('./src/strategies/intradayRegression/config.ts');
const newI=await import('./src/strategies/intradayRegression/indicators/index.ts');
const newK=await import('./src/infrastructure/longbridge/market/candlestickCache.ts');
let random=19;
const rng=()=>((random=(Math.imul(random,1664525)+1013904223)>>>0)/4294967296);
const candle=i=>{
  const c=100+Math.sin(i*.3)*7+rng();
  return {timestamp:1700000000000+i*60000,open:c-.5,high:c+1,low:c-1,
    close:c,volume:1000+Math.floor(rng()*1000)};
};
const snapshots=[];
let candles=Array.from({length:65},(_,i)=>candle(i)), confirmed=null;
for(let j=0;j<400;j++) {
  if(j%5===0){candles=[...candles,candle(65+Math.floor(j/5))].slice(-100);confirmed=false;}
  else if(j%5===4) confirmed=true;
  else {
    const v={...candles.at(-1),close:100+rng()*6};
    if(j%37===0)v.high=null;
    if(j%41===0)v.volume=null;
    candles=[...candles.slice(0,-1),v];
  }
  snapshots.push({symbol:'HSI.HK',version:j+1,initialized:true,
    lastBarTimestamp:candles.at(-1).timestamp,lastBarConfirmed:confirmed,candles});
}
const rule='(RSI:6>0,PSY:12>0,MFI>0,K>0,D>0,J>-100)/1';
const allSignals={BUYCALL:rule,SELLCALL:rule,BUYPUT:rule,SELLPUT:rule};
const full=['EMA:2','PSY:12','K','D','J','MACD','DIF','DEA','ADX'];
const input={signals:allSignals,verification:{buy:{delaySeconds:0,indicators:full},
  sell:{delaySeconds:0,indicators:['K']}}};
const co=oldC.parseStrategyConfig(input),cn=newC.parseStrategyConfig(input);
assert.deepEqual(co,cn);
let ro=null,rn=null;
for(const snap of snapshots){
  ro=ro===null?oldI.bootstrapIndicatorRuntime({symbol:'HSI.HK',cacheSnapshot:snap,indicatorProfile:co.profile})
    :oldI.updateRuntimeForCandlestickSnapshot({runtime:ro,cacheSnapshot:snap});
  rn=rn===null?newI.bootstrapIndicatorRuntime({symbol:'HSI.HK',cacheSnapshot:snap,indicatorProfile:cn.profile})
    :newI.updateRuntimeForCandlestickSnapshot({runtime:rn,cacheSnapshot:snap});
  assert.deepEqual(oldI.buildSnapshotFromRuntime(ro),newI.buildSnapshotFromRuntime(rn));
}
let strategyCases=0;
for(const delay of [0,0.0001,0.5,5,60,120]) for(const indicators of [[],['K'],['ADX'],full]){
  const cfg={...input,verification:{buy:{delaySeconds:delay,indicators},sell:{delaySeconds:delay,indicators}}};
  function run(S,C){
    let now=Date.parse('2026-10-20T02:00:00Z'),seq=0;
    const timers=new Map(),trace=[];
    const deps={clock:{now:()=>new Date(now)},scheduler:{
      scheduleTimer:(cb,ms)=>{const id=++seq;timers.set(id,{cb,at:now+ms});trace.push(['timer',id,ms]);return id;},
      clearTimer:id=>{timers.delete(id);trace.push(['clear',id]);}},
      logger:{debug(){},info(){},warn(){},error(){}},onFatalError:e=>{throw e}};
    const s=S.createIntradayRegressionStrategy(C.parseStrategyConfig(cfg),deps);
    for(let i=0;i<80;i++){
      now+=1000;
      const context={observedAtMs:now,candlesticks:snapshots[i],allowNewEvaluation:i%4===0,seats:[
        {direction:'LONG',symbol:'BULL.HK',hasFilledBuyOrders:i%3!==0},
        {direction:'SHORT',symbol:'BEAR.HK',hasFilledBuyOrders:true}]};
      trace.push(['display',s.onCandlestick(context,d=>trace.push(['emit',d]))]);
      if(i===32)s.invalidateDirection('LONG');
      if(i===52)s.resetForTradingDay();
      for(const[id,t]of [...timers])if(t.at<=now&&timers.delete(id))t.cb();
    }
    s.destroy();for(const t of timers.values())t.cb();return trace;
  }
  assert.deepEqual(run(oldS,oldC),run(newS,newC));strategyCases++;
}
const ok=oldK.createCandlestickCacheStore({maxCandles:70});
const nk=newK.createCandlestickCacheStore({maxCandles:70});
const norm=s=>({...s,period:'MIN_1'});
assert.deepEqual(norm(oldK.seedCandlestickSeries({store:ok,symbol:'HSI.HK',period:Period.Min_1,candles:snapshots[0].candles})),
  newK.seedCandlestickSeries({store:nk,symbol:'HSI.HK',period:'MIN_1',candles:snapshots[0].candles}));
let cacheChecks=0;
for(let i=0;i<snapshots.length;i++){
  const candlestick=i%17===0?snapshots[0].candles[0]:snapshots[i].candles.at(-1);
  const a=oldK.applyCandlestickPush({store:ok,symbol:'HSI.HK',period:Period.Min_1,candlestick,isConfirmed:snapshots[i].lastBarConfirmed===true});
  const b=newK.applyCandlestickPush({store:nk,symbol:'HSI.HK',period:'MIN_1',candlestick,isConfirmed:snapshots[i].lastBarConfirmed===true});
  assert.deepEqual(norm(a),b);cacheChecks++;
}
console.log(JSON.stringify({baseline:BASE,indicatorSnapshots:snapshots.length,strategyCases,
  eventsPerStrategyCase:80,cacheChecks,baselineModules:urls.size,result:'all deepEqual'}));
'@ | bun run -
```

**解释边界**：脚本对 baseline 的 imports 递归替换只用于离线读取旧实现，不改任何 git 对象或当前源码；结果证明的是所给输入/事件序列的相同输出，不是任意输入或所有调度的形式化等价。
