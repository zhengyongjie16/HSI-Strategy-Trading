# 策略可替换性复核：最终修复方案与实施验收记录

> **交付性质：已完成本地实施验收，非生产发布声明。**
>
> 原复核：[2026-09-19 策略可替换性与交易链路第一性原理复核](../issues/2026-09-19-strategy-replaceability-first-principles-review.md)。本方案反向链接原复核，作为实施入口；本地命令结果不表示上线、Broker、部署或线上行为验证。
>
> **已确认的 H/L/C 输入合同与坏柱政策**：KDJ 只读取 `high`/`low`/`close`。每个 H/L/C 仅在缺失字段、`null`、`undefined`、空白字符串、非数值文本或非有限数时拒绝；非空且可转换为有限数的数值字符串接受，零和负数接受，也不因 H/L/C 区间不一致拒绝；不增加正数或 `low <= close <= high` 约束。`open`、`volume` 不是 KDJ 必需字段。合法输入即使本轮整个窗口 `range === 0` 也推进窗口并保留历史平滑状态，但本轮 K/D/J 为 unavailable，不暴露旧值；恢复有效 range 后继续既有算法，且不取消已有 pending。无效输入和零 range 是不同分支。该政策已选定，不再存在业务确认阻塞；实现、测试和本地验收结果见第 4.4 节。
>
> 实施前已重新检查 HEAD、工作区和相关调用链；本记录不覆盖他人改动。
>
> **策略路径说明（后于本记录实施）：**本文生产/测试路径（`src/core/strategy/intradayRegression/**`、`tests/core/strategy/intradayRegression/**`）是实施时的基线证据。策略功能内聚后当前落点为 `src/strategies/intradayRegression/**` 与 `tests/strategies/intradayRegression/**`，公共契约在 `src/types/strategy.ts`；本文确认的 H/L/C/KDJ 输入政策、可用性传播、triggerTime 语义与验收事实不因路径迁移改变。

## 0. 当前状态、证据和限制

- 本方案依据三代理最终复核结论及本轮对相关 TypeScript、测试和 `package.json` 的事实核对；必要的 runtime snapshot、display、signal 和 verification 消费者也已核对。
- 用户已确认文首的 H/L/C 输入合同与“本轮 KDJ 不可用”政策：缺失、`null`、`undefined`、空白字符串、非数值文本或非有限数拒绝；非空有限数值字符串接受，零、负数及区间不一致均接受，`open`/`volume` 不是 KDJ 必需字段。合法 zero-range 输入仍推进窗口并保留历史平滑状态，但最新轮 K/D/J 不可用；无效输入与 zero-range 分支必须区分。其他合法指标或整个系统不一概禁用，旧 KDJ 不写入当前快照、显示或样本。本次实现、测试和本地验收已完成，真实命令结果见第 4.4 节。
- 前轮已经用 `bun --eval` 直接调用生产 KDJ 函数完成最小复现：20 根 `i=0..19` 的正常柱 `{high:102+i, low:98+i, close:101+i, volume:1000}`，前 18 根后插入坏柱，再追加最后 2 根；无落库、无 Broker。本轮不重跑该复现。
- 前轮结果只证明 KDJ 数值/状态污染，不证明已经发生线上错误订单：正常基线 `91.667/91.667/91.667`；全 `null` 为 `66.113/63.612/71.116`；`{high:1000,low:1,close:NaN}` 为 `38.463/65.060/-14.729`；缺 `high` 的 `{low:115,close:118}` 为 `90.909/91.162/90.404`；各组 `stateChanged=true`。
- 实施前工作区已存在 issue/plan、runtime 和测试等修改；本次未 reset、checkout、`git add`、commit 或删除用户既有内容。`bun format` 可能产生的工作区格式化变更已记录在第 4.4 节。
- 本次最终验证未连接 Broker、生产凭据或部署环境，也未验证线上行为；结论仅限本地 source/dist 组合、构建产物和测试队列证据。
- 已读取 `package.json`。可用脚本为 `format`、`lint`、`type-check`、`test`、`build`；正式 build 是 `bun run clean && tsc -p tsconfig.build.json`。方案中的命令只使用这些已存在的脚本，以及 Bun 原生支持的测试路径参数。

## 1. 目标与非目标

### 1.1 目标

1. 修复 STRAT-001：KDJ 对 H/L/C 的输入校验必须在任何 `index`、deque、rolling window 或 K/D 状态 mutation 之前完成；坏柱不能污染后续有效序列。
2. 完成已确认的本轮不可用政策传播：当前轮 K/D/J 不得从 committed 旧值回填到 snapshot、display、signal 或 verification sample；其他指标仍按既有规则独立可用。
3. 保持策略私有状态所有权：pending、timer、sample、indicator runtime 和 verification 继续属于策略实例；宿主继续拥有席位、订单、持仓、交易门禁、队列和执行权限。
4. 补足对应 signal/verification 回归，覆盖正式 profile：四个 signal 的 D/J、BUY verification 的 D/ADX、SELL verification 的 K；共通 guard 和可用性传播都是 P1 完整必修，不能只修 guard 就宣告完成。
5. 修复 STRAT-004 的验证闭环：增加不同私有 schema/实现的测试策略，真实走 `prepareStrategy → createSelectedStrategy → businessEventProgram → emissionAdapter → STRATEGY_* queue`，并对 source/dist 做最小 `create → onCandlestick → emit → adapter → queue` smoke。
6. 把验证结论限定在当前公共协议内：四种 action、LONG/SHORT 席位和一分钟行情仍是有意的业务边界，不宣称任意语义插件。

### 1.2 非目标

- 不全局修改 `runtime/utils.ts` 的 `toNumber`，不把 `null/undefined` 转换政策改写给 MFI 或其他指标。
- 不在 cache 或宿主投影层统一丢弃所有 partial candle；不要求 KDJ 因缺 `open` 或 `volume` 而拒绝。
- 不把 committed 旧 KDJ 回填为当前轮有效值；不新增“全动作/全系统不可用”禁令。信号继续使用现有 N-of-M 与缺值语义。
- 新延迟候选若必需 K/D/J 不可用，不注册且不回退立即；pending 不因坏柱或 zero-range 事件自动取消，仍按现有 `passesVerification` 对验证阶段实际选中的 sample 判定：选中 `missing`/`invalid` 才因样本失败，无样本沿既有规则处理；不补样本、不延长 timer、不新增 fatal，nearest 无最大时间差和样本复用现状不变。
- 不新增指标框架、事件总线、策略注册表、公共数学层、宿主 pending 授权表或兼容转发层；可用性元数据只保留在当前策略私有 runtime/snapshot 边界。
- 不修改 `triggerTimeMs` 的时间语义：立即 decision 使用动作评估时的 `now`；延迟 decision 使用 `Date(now + delaySeconds * 1000)` 归一化后的目标 T0；验证目标后 10 秒回调。T0 不是首次评估时间，也不是 callback 时间。
- 不重新检查 delayed SELL 的初始 `hasFilledBuyOrders`，不把它改成持仓或 pending 资格；执行阶段仍由当前 route、gate、持仓、行情和席位版本约束。
- 本方案不执行 STRAT-002 的可选类型收窄，不改动 `timeWakeup` 的末日保护对象投影；STRAT-003 不在本方案范围，不添加公共 `executionIdentity`、删除 `reason` 或未经业务决策改写 retry key。
- 不为 EMA:250 改缓存上限；连续有效增量可以预热 EMA:250，reset/rebuild 按现有生命周期重新预热，正式 profile 当前没有 EMA。
- 不连接真实 Broker，不把 loader/build 已有的资产/prepare 测试误写成实例运行证明，不要求 source 与 dist 重复两套完整业务流程。

## 2. 问题裁决与优先级

| 编号 | 最终裁决 | 优先级 | 本方案处理 |
| --- | --- | --: | --- |
| STRAT-001 | `runtime/utils.ts:10-23` 的 `null/undefined → 0` 与 `runtime/kdj.ts:104-158` 的先 mutation 后 close 校验共同构成可达 KDJ 污染；政策已确认：坏柱本轮 K/D/J 不可用；guard、快照/消费者传播和验收已由本次 G1–G3 结果通过 | P1 | G1–G3 |
| STRAT-004 | 组合验证曾缺少不同策略实际 decision 到 queue；本次 R1–R3 已补足 source/dist 两侧实例 smoke，loader/build 既有资产回归仍通过，已有 event/adapter/delayed SELL 覆盖不被替代 | P2 | R1–R3 |
| STRAT-002 | `signalRuntimeDomain` 只调用 reset，可局部 `Pick` 收窄；`timeWakeup` 末日保护读取 seat/version/orderRecorder 等真实宿主能力，不能只传策略 invalidate；本方案可选但不执行，不阻断本方案 | P3 | 不执行（留作独立变更） |
| STRAT-003 | `reason` 确实参与 sell retry key，但 key 还含 action/trigger/route/数量等维度，clone 保留 reason/time，未证明当前漂移、误合并或错单；本方案范围外，不实施 | P3 | 不在本方案范围 |

### 2.1 必须保留的稳定合同

- 策略只输出普通意图；宿主拥有 symbol、quantity、order type、clearance authorization、Broker 和最终执行权。
- 策略只接 `StrategyDeps` 及公共市场上下文；完整宿主 `MonitorContext` 的存在不等于策略依赖它。
- pending/timer/sample/verification 私有化不变；gate、席位变化、跨日和 shutdown 仍通过公共 lifecycle port 让策略失效或 reset。
- `hasFilledBuyOrders` 是首次候选时宿主从当前保留的已成交 BUY 记录投影出的资格；不含持仓、不含 pending BUY；delayed emission 使用 origin 资格，不回流重查。
- 四种 action、LONG/SHORT、席位身份和一分钟行情继续作为当前普通交易协议。若未来产品需要组合或非四动作语义，另立协议和 adapter。

## 3. 依赖图与文件级工作包

```text
W0 基线/工作区/证据复核（政策已确认，不再等待业务选择）
 ├─ G1 共通 KDJ 原子 guard + 持久数学状态不变
 │   └─ G2 当前轮可用性传播与 snapshot/消费者接线（P1 必修）
 │       └─ G3 坏值矩阵、正式 profile 和端到端验收
 └─ R1 第二策略 fixture 设计
     └─ R2 source/dist 最小 decision-to-queue smoke
         └─ R3 组合验收与构建回归

O1 signalRuntimeDomain 局部 Pick（可选但本方案不执行）
O2 retry identity 业务决策与后续实现（不在本方案范围）
```

G1 与 G2 共同构成 STRAT-001 的完整 P1 修复：G1 只保证 KDJ 持久数学状态不被坏柱污染，G2 才保证当前轮不会把旧 KDJ 传播成有效输出；只完成 G1 不得宣告 STRAT-001 修复或通过最终验收。

### W0：基线、工作区和调用链

**目的**：保护已有改动，固定实施前事实，不把本轮文档验证当代码基线。

**步骤**：

1. 实施前重新运行 `git status --short --branch`，记录现有工作区；任何已有修改先避让，不 reset、checkout 或覆盖。
2. 重新读取 `runtime/utils.ts`、`runtime/kdj.ts`、`runtime/index.ts`、`runtime/types.ts`、正式 `config.json`、`config.test.ts`、`display.ts`、策略 `utils.ts`、`verification/utils.ts`、`verification/index.ts`、`prepareStrategy`/`createSelectedStrategy`、business event/adapter 和 package scripts；若 HEAD 已变化，重新核对调用链和行号。
3. 记录前轮 KDJ 复现为历史证据，不把本轮重复运行写成必要步骤；除非实施者需要确认环境，否则不连接数据库或 Broker。
4. 固定可复现测试输入、state 深比较方式、正式 profile 断言和 source/dist fixture 的临时根目录；测试不得依赖真实凭据。
5. 将已确认政策作为实现基线：被拒绝的 H/L/C 使当前轮 K/D/J 不可用且旧 KDJ 不可输出；合法 zero-range 输入仍推进窗口、保留历史平滑状态但当前轮不可用，恢复有效 range 后继续既有算法；实现/验收未完成前不得写“已修复”或“已发布”。

**产出/门禁**：工作区边界、代码基线、受影响文件、可用性传播点和测试入口明确；未完成 W0 不得把后续结果写成发布证据。

### G1：KDJ 原子输入修复与数学状态门禁（P1，必修）

**生产文件与条件**：

- `src/core/strategy/intradayRegression/runtime/kdj.ts`：在 `commitKdjCandle()` 入口局部数值化并验证 KDJ 实际所需 H/L/C；只拒绝缺失、`null`、`undefined`、空白字符串、非数值文本或非有限数，接受非空且可转换为有限数的数值字符串、零、负数及区间不一致，不增加正数或 `low <= close <= high` 约束。任一被拒绝值必须在 `index`、high/low deque、rolling window、RSV、K/D 任何 mutation 之前返回拒绝结果或等价状态；`open`/`volume` 不参与该必需输入校验。
- `src/core/strategy/intradayRegression/runtime/index.ts`：确认 bootstrap、active preview、同 timestamp 替换、confirmed commit 和 shift commit 均经过同一 guard。其他指标可以按已有 partial-data 规则更新，但不能把它们的结果当作 KDJ 接受。
- `src/core/strategy/intradayRegression/runtime/utils.ts`：只作为现状证据和共享调用审查点；不得全局改变 `toNumber(null | undefined) === 0`。

**必须保持**：

1. 只检查 KDJ 需要的 high/low/close；缺 `open` 或 `volume` 不拒绝 KDJ，也不要求 cache 或宿主统一丢弃 partial candle。
2. 被拒绝的 H/L/C 返回前 KDJ 状态深相等：`index`、四个 deque、RSV/K 窗口及其 sum、`lastK`/`lastD`、`hasKdjValue` 均不变。合法输入但整个窗口 `range === 0` 属于不同分支：仍推进 accepted window、保留历史平滑状态，却将最新轮标为 unavailable；KDJ 数学状态不变不等于当前轮输出仍可用，后续由 G2 处理。
3. 恢复有效 range 后从未被污染的状态继续既有算法，只按实际 accepted bars 满足预热/就绪；不得用被拒绝柱补计数、用 zero-range 伪造 K/D/J 或盲目置 ready。历史无效输入不设置永久屏蔽 latch，zero-range 也不取消既有 pending。
4. MFI、ADX、EMA、RSI、PSY、MACD 等其他指标的 partial-data 政策不被顺带改变；坏柱不作为策略内部 fatal，fatal 仍只用于已有的内部不变量/调度错误。

**G1 门禁**：代码只触及必要的 KDJ 输入合同、guard/返回信息和调用接线；明确区分被拒绝输入与已接受但 zero-range 的窗口推进，没有 cache 全局过滤、全局 helper 改语义、新框架或宿主公共 availability 协议。G1 通过后仍必须完成 G2。

### G2：当前轮 KDJ 可用性传播与 verification 消费者接线（P1，必修）

**文件级检查/修改条件**：

- `src/core/strategy/intradayRegression/runtime/types.ts`、`runtime/index.ts`：在策略私有 runtime 中保存“当前输出对应的 KDJ 输入是否被接受”的最小元数据（或等价内部状态）；`IndicatorCommittedState.kdjState` 只保存持久数学状态。最新轮 availability（包括合法但 zero-range 时的 unavailable）必须与历史平滑/数学状态分开表达；不要把 availability 抽成宿主通用协议。
- `runtime/index.ts` 的 `buildSnapshotFromRuntime()`/相关 snapshot builder：当前轮 H/L/C 被 guard 拒绝，或合法输入使整个窗口 `range === 0` 时，必须抑制 `IndicatorSnapshot.kdj`，不能让 `buildSnapshotFromCommitted()` 把上一份 KDJ 漏出。若继续使用现有 `kdj: null` 合同已能表达 unavailable，不新增公共字段；如确需内部 marker，只在策略私有边界使用。
- 当前轮定义为缓存事件所代表的最新 bar（活动或已确认），最新轮 availability 不等于历史 KDJ 数学状态是否已有值。同 timestamp 活动柱被替换时，availability 必须随新 bar 重算：坏→好不得继承坏标记，好→坏不得继承好 preview；合法 zero-range→有效 range 也必须恢复既有算法。preview 始终从 committed clone 计算，不把前一 preview 写回 committed。
- confirmed/shift/bootstrap 要区分“当前最新柱”与历史输入：确认的坏当前柱或合法 zero-range 当前柱均抑制本轮 K/D/J；shift 中被确认的坏上一柱只被 guard 跳过，合法 zero-range 历史柱推进窗口但不伪造当前值，后续有效 range 当前柱仍从未污染且保留历史平滑状态的基础上计算；bootstrap 中历史坏柱不永久屏蔽有效当前柱。有效当前柱仍要通过 `readKdjValue()` 的实际有限值/预热条件。
- `src/core/strategy/intradayRegression/display.ts`、策略 `utils.ts`：沿现有 `getIndicatorValue` 和有限值检查省略/跳过 K/D/J；不能从 committed 补回旧值。其他合法指标可继续显示和参加现有 N-of-M，不添加全动作或全系统禁令。
- 策略 `index.ts`：signal 条件继续按当前可用指标和 N-of-M/缺值语义评估；若延迟验证的 initial 指标集合必需 K/D/J 而本轮不可用，候选不注册且不回退立即。若候选不依赖不可用 KDJ，其他合法指标仍按现有规则运行。
- `verification/utils.ts`：核对 `projectVerificationSampleValues()` 不会把 committed 旧 KDJ写成 `value`。若保持 `snapshot.kdj === null`，当前代码会投影既有 `missing`；若增加策略私有 present/invalid marker，只能映射到已有 `missing`/`invalid` 非 value，不扩展样本协议。
- `verification/index.ts`/`verification/sampleStore.ts`：保持现有 nearest-sample、三点和一次性 timer 语义。`passesVerification()` 只按验证阶段实际选中的 sample 判定：选中 `missing`/`invalid` 时沿现有规则失败，无样本仍沿既有无样本规则处理；坏柱或合法 zero-range 本身不自动取消已有 pending，不补样本、不延长 timer、不新增 fatal。nearest 无最大时间差和样本复用现状不变，只有生命周期已有 invalidate/reset 才能取消 pending。

**G2 输出合同**：被拒绝输入轮以及合法 zero-range 最新轮的 K/D/J 均不得进入 snapshot、display、signal 有效值或 verification sample value；其他指标不随之被清空。最新轮 availability 必须与历史 KDJ 平滑状态区分，后者仍由 G1 保护；恢复有效 range 后继续既有算法。

### G3：坏柱矩阵、正式 profile 和完整 P1 验收

**输入与行为验收矩阵**（以下为实施条件；本次结果见第 4.4 节）：

| 情形 | 输入/窗口处理 | 最新轮 K/D/J | 历史状态、pending 与证据边界 |
| --- | --- | --- | --- |
| 缺失字段、`null`、`undefined`、空白字符串、非数值文本、`NaN`/`Infinity` | 拒绝；必须在 `index`、deque、rolling window、RSV、K/D mutation 前返回，不计为 accepted bar | 若该柱是最新柱则 unavailable，不暴露旧值；若为历史柱只跳过该柱 | KDJ 数学状态深相等；事件本身不取消 pending |
| 非空且可转换为有限数的数值字符串 | 转换后接受，按既有算法处理 | 由实际 range/预热决定，不因字符串类型拒绝 | 纳入 accepted-only 对照，不改变其他指标政策 |
| 零、负数、H/L/C 区间不一致 | 接受；不加正数或 `low <= close <= high` 约束 | 仍由实际 range/预热决定 | 不得误走 invalid 分支 |
| H/L/C 有效但缺 `open` 或 `volume` | KDJ 接受，不把二者当必需字段 | 按 H/L/C 的实际结果 | 不要求 cache/宿主统一丢弃 partial candle |
| 合法输入使整个窗口 `range === 0` | 接受并推进窗口，保留历史平滑状态 | 当前轮 unavailable，不暴露历史旧值 | 与 invalid 输入区分；不取消 pending；恢复有效 range 后继续既有算法 |
| 含拒绝输入的序列及 accepted-only 对照 | 对照只移除被拒绝柱，保留合法数值字符串、零/负数、区间不一致和 zero-range 柱 | 分别断言最新轮 availability，不从历史状态借值 | 比较 accepted window、持久数学状态、预热/恢复输出；zero-range 不得当作 rejected |
| verification pending 的样本选择 | 只按验证阶段实际选中的 sample 判定 | selected `missing`/`invalid` 按现有规则失败 | nearest 无最大时间差、sample reuse、不补样本/不延长 timer 现状不变；无样本沿既有规则处理 |
| source/dist 组合证据 | 同一临时工程内 source/dist 分别以模块、策略实例和 queue capture 真实走 `create → onCandlestick → emit → adapter → queue`；dist 阶段先移走 source | 不以 loader/资产断言代替实例 emit 证据 | 一侧 smoke 不替代另一侧；分别记录、独立通过后才汇总 |

**实际测试文件/范围**（按现有组织实施，未新增重复测试框架）：

- `tests/core/strategy/intradayRegression/runtime/invariants.test.ts` 或相邻 runtime business test：覆盖缺失、全 `null`、全 `undefined`、空白字符串、非数值文本、`NaN`、`Infinity`、可转换为有限数的非空数值字符串、零/负数、H/L/C 区间不一致、缺 `high`/`low`/`close` 各一、缺 `open` 或 `volume` 但 H/L/C 有效，以及整个窗口 `range === 0`；深比较被拒绝输入与 accepted zero-range 的 KDJ state、窗口推进和最新轮 availability。
- `tests/core/strategy/intradayRegression/runtime/incremental.business.test.ts`：覆盖 active preview 同 timestamp 的坏→好、好→坏、zero-range→有效 range，confirmed bad/good/zero-range，shift 中历史坏柱与当前坏柱，bootstrap 的历史坏柱/当前坏柱；分别断言最新轮 availability 与历史 committed 平滑状态，snapshot K/D/J、display、committed 边界、窗口推进和后续有效 range 柱的 readiness。
- `tests/core/strategy/intradayRegression/index.test.ts`：覆盖被拒绝输入或 zero-range 使 K/D/J 不可用时 N-of-M 仍只按现有可用项数求值；延迟 initial 必需 KDJ 时无 timer、无立即 fallback；pending 仅在验证阶段实际选中 `missing`/`invalid` sample 时按现有规则失败，坏柱/zero-range 本身不自动取消既有 pending。
- `tests/core/strategy/intradayRegression/verification/index.test.ts`、`verification/utils.test.ts`：断言被拒绝输入轮和 zero-range 最新轮的 K/D/J sample 不是 `value`，现有 selected `missing`/`invalid`/无样本判定仍按既有规则处理，不新增 retry/fatal；确认 sample store 不把旧 snapshot 当本轮样本，并保留 nearest 无最大时间差与 sample reuse。
- 对含拒绝输入的每条序列补充 accepted-only 对照：对照仅移除被拒绝 H/L/C 的柱，保留合法数值字符串、零/负数、区间不一致和合法 zero-range 柱；比较实际 accepted window、持久数学状态、预热/恢复输出，并单独断言最新轮 availability 不借用历史值。zero-range 不得被归入拒绝输入对照，必须验证其推进窗口、保留历史平滑状态且不伪造本轮 K/D/J。
- `tests/core/strategy/intradayRegression/config.test.ts`：保留现有正式 profile 断言；补强正式 asset 的四个 D/J signal、BUY `D`/`ADX`、SELL `K` 覆盖，不把全指标数学 fixture 当生产 profile。

**非回归**：MFI、ADX、EMA、RSI、PSY、MACD 仍按各自 partial-data/预热政策；cache 不统一丢 partial，`toNumber` 不全局改义，`open`/`volume` 不变成 KDJ 必需字段；不重查 delayed SELL 的 origin `hasFilledBuyOrders`，不新增全系统禁用。无效输入与合法 zero-range 的窗口/availability 语义必须保持可区分。

**G3 门禁**：只有 G1 输入合同与 guard、G2 最新轮可用性/历史状态区分、消费者矩阵、accepted-only 对照和正式 profile 回归全部通过，STRAT-001 才能标记为实施完成；“只因 state 不变”或只证明历史状态不变不构成通过。本次第 4.4 节结果满足该门禁。

### R1：第二策略 fixture 与组合边界

**实际组合测试 fixture**：`tests/build/productionBuild.test.ts` 使用动态临时工程与现有 event harness/queue doubles；不修改生产注册表。

**fixture 要求**：

1. 私有 config 使用与 `intradayRegression` 不同的最小 schema，例如一个只含测试阈值/固定 action 的本地配置；不 import KDJ、EMA、MFI、intradayRegression profile 或 production config。
2. `definition.prepare()` 消费自己的 config，`create(deps)` 只返回完整公共 `TradingSignalStrategy` port；`onCandlestick()` 在可控 context 下发出一个普通 BUY 或 SELL decision，生命周期方法可 no-op。
3. 组合边界必须真实经过 `prepareStrategy → createSelectedStrategy → businessEventProgram → emissionAdapter → STRATEGY_* queue`，不能仅直接调用 adapter 或只断言 loader 返回 selection。
4. 断言只创建/调用选中的策略一次；未选策略不 import/prepare/create；fixture 不需要新增中央 registry、manifest 或生产文件。

### R2：source/dist 最小 decision-to-queue smoke

source 与 dist 是相互独立的真实 decision-to-queue 证据边界：source smoke 只证明 source 装载路径，dist smoke 只证明正式构建产物路径；loader/资产测试或一侧 smoke 不能替代另一侧实例实际 emit 的证据。两种模式在同一临时工程中使用 source/dist 分别模块、策略实例和 queue capture，并分别记录结果；dist 阶段先移走 source，只有两侧独立通过后，R3 才能汇总为 source/dist 组合结论。

1. source 模式在同一临时工程定位 `definition.ts`，使用 source 模块/策略实例和独立 queue capture 创建不同 schema 策略并走一次真实 event；断言 `onCandlestick` 一次、decision 实际通过 adapter、对应 BUY/SELL queue 有预期 action/symbol/seatVersion/triggerTime/可选 reason。该条只作为 source decision-to-queue 证据；`triggerTimeMs` 按真实语义断言：立即 decision 使用动作评估时的 clock `now`，延迟 decision 使用 Date 截断后的目标 T0，不写首次评估时间或 timer callback 时间。
2. dist 模式先使用正式 `bun run build` 产物，在同一临时工程先移走 source，再用 dist 模块/策略实例和另一份 queue capture 定位对应 `definition.js` 和相邻 `config.json`，独立重复同一最小链路一次；只把该次实例真实 emit 到 queue 作为 dist 证据，不复制完整行情/订单/Broker 流程，也不把 source 结果代替 dist 结果。
3. 保留现有 `tests/build/productionBuild.test.ts` 的 JSON 资产、clean + tsc、增删策略、未选坏配置隔离、selected prepare 失败和 source 移走后 dist 加载断言；新增 source/dist smoke 各自只补“该装载模式的实例真的 emit decision”，不重写 loader，也不把 loader/资产断言升级为另一侧的真实 decision-to-queue 证明。
4. 组合测试只使用现有 event harness/queue/termination doubles，不建立 SDK context，不连接 Broker，不依赖生产凭据。

### R3：组合验收

- 必须分别证明 source 与 dist 各自完成 `create → onCandlestick → emit → adapter → queue`；一侧的真实 decision-to-queue 证据不能替代另一侧。
- 必须证明不同私有 schema 且不含当前策略私有指标类型的策略仍可处理 decision。
- 必须证明当前四 action/seat/minute 协议仍是唯一公共边界；不把结果扩写为任意语义插件。
- 必须保留当前策略的 pending/timer 私有性、delayed SELL origin 资格、triggerTime 语义和宿主执行权限。

### O1：STRAT-002 局部类型维护（可选但本方案不执行，不阻断）

- 若单独实施，只修改 `src/main/lifecycle/cacheDomains/types.ts` 与必要装配调用点，使 `signalRuntimeDomain` 只获得 `Pick<TradingSignalStrategy, 'resetForTradingDay'>` 或等价端口。
- 不修改 `src/main/timeWakeupEvaluationProgram/index.ts`、`src/main/timeWakeupEvaluationProgram/types.ts` 的末日保护依赖；其 `cancelPendingBuyOrders/executeClearance` 读取席位/version/orderRecorder/position/trader 等真实宿主能力。
- 运行现有 lifecycle/seat cleanup/午夜/shutdown/fatal 相关测试和 type-check；失败不应被本方案其他工作掩盖。

### O2：STRAT-003 retry identity 治理（不在本方案范围）

- 本方案不实施 STRAT-003；以下仅记录未来独立变更的边界，不纳入本方案门禁或验收。先由业务明确每个获准 emission 是独立执行任务还是业务等价合并；没有该决策不得扩展公共 `StrategyDecision`。
- 现状中 `reason`、triggerTime、route、相关买单等字段继续由 clone/retry envelope 保留；不能只删 reason，不能把 reason 作为清仓授权。
- 若未来实施，身份由宿主任务边界和 retry envelope 定义，测试覆盖不同文本、同/不同业务身份、迟到 callback、跨日和终止；该工作不进入本方案 P1/P2 门禁。

## 4. 真实验收与回归命令

以下命令来自已读取的 `package.json`；本次已按要求真实执行并记录退出码。结果仅表示本地代码、构建产物和测试 harness 通过，不替代生产发布或 Broker 验证。

### 4.1 实施 TypeScript 后的顺序

```text
bun format
bun lint
bun type-check
```

`bun format` 是项目现有脚本（`prettier --write . && eslint . --fix`），会修改文件；本次已按顺序运行，具体影响见第 4.4 节。更新本方案文档后仅对该 Markdown 文件运行了定向 Prettier 与 `git diff --check`，未重复整仓测试。

### 4.2 受影响回归

```text
bun test tests/core/strategy/intradayRegression
bun test tests/app/startup/prepareStrategy.test.ts tests/app/startup/createSelectedStrategy.test.ts
bun test tests/main/businessEventProgram tests/integration/delayedStrategySell.integration.test.ts
bun test tests/build/productionBuild.test.ts
```

这些是 Bun 原生测试路径，不是新增 package script；若新增组合测试文件，应把其真实路径加入同一组，而不是编造别名。

### 4.3 构建与最终整仓回归

```text
bun run build
bun test
```

`bun run build` 必须继续等价于 package 中的 clean + `tsc -p tsconfig.build.json`；不新增 Broker 启动命令、不以真实账户作为 build/test 依赖。整仓 `bun test` 是最终回归，不因 targeted test 通过而省略。

### 4.4 本次最终命令结果（真实退出码）

所有下列命令均记录到本次验证日志，真实退出码均为 `0`：

| 顺序 | 命令 | 结果与统计 |
| --: | --- | --- |
| 1 | `bun format` | 通过；`prettier --write .` 与 `eslint . --fix` 完成。格式化前后纳入快照的 115 个路径哈希发生变化（主要是工作树换行/格式归一化）；相对实施前新增可见内容差异的路径为 `docs/issues/2026-09/2026-09-19-strategy-replaceability-first-principles-review.md`、`tests/core/orderRecorder/costAveragePrice.test.ts`、`tests/core/trader/orderExecutor/orderExecutor.protectiveLiquidation.business.test.ts`、`tests/main/lifecycle/cacheDomains/riskDomain.test.ts`。`git diff --check` 后续通过。`bun format` 未删除或覆盖既有改动。 |
| 2 | `bun lint` | 通过，无 lint 诊断。 |
| 3 | `bun type-check` | 通过，`tsc -p tsconfig.json`。 |
| 4 | `bun test tests/core/strategy/intradayRegression` | 通过：70 pass，0 fail，11 files，530 expect calls。 |
| 5 | `bun test tests/app/startup/prepareStrategy.test.ts tests/app/startup/createSelectedStrategy.test.ts` | 通过：50 pass，0 fail，2 files，78 expect calls。 |
| 6 | `bun test tests/main/businessEventProgram tests/integration/delayedStrategySell.integration.test.ts` | 通过：49 pass，0 fail，4 files，231 expect calls。 |
| 7 | `bun test tests/build/productionBuild.test.ts` | 通过：4 pass，0 fail，1 file，79 expect calls；覆盖 clean + tsc、JSON 资产、策略增删、selected prepare 失败和 source/dist 实例 decision-to-queue。 |
| 8 | `bun run build` | 通过，实际执行 `bun run clean && tsc -p tsconfig.build.json`。 |
| 9 | `bun test` | 通过：1955 pass，0 fail，184 files，7255 expect calls。 |
| 10 | `git diff --check` | 通过，退出码 `0`；仅有 Windows 换行提示，无 whitespace error。 |

受影响 targeted 测试合计 `173 pass / 0 fail`；整仓最终回归为 `1955 pass / 0 fail`。本次未重跑前轮 KDJ `bun --eval` 复现，前轮证据仍见第 0 节。

### 4.5 全链路、工作区与清理核对

- `lastKdjAvailable` 仅保留在 `runtime/index.ts` 的 bootstrap/shift/confirm/preview 接线和 `runtime/types.ts` 私有运行态；`commitKdjCandle` 的生产消费者为 runtime，直接分析/不变量消费者为 `tools/dailyIndicatorAnalysis/indicatorCalculators.ts` 与 `tests/core/strategy/intradayRegression/runtime/invariants.test.ts`；`readKdjValue` 的 snapshot 消费与上述测试/分析工具均已检索，无旧的残留消费路径。
- `buildSnapshotFromRuntime`/`buildSnapshotFromCommitted` 通过当前轮 `kdjAvailable` 抑制旧 KDJ；display、signal 与 verification 继续通过 `getIndicatorValue`/`projectVerificationSampleValues` 消费 `null`/missing 语义。全链路 grep 未发现额外 stale consumer。
- 测试树未发现 `.skip`/`.only`（含 `test`、`it`、`describe`、`suite` 形式）。`tests/build/productionBuild.test.ts` 在 `git status --untracked-files=all` 中可见为 `??`，未被忽略；`.gitignore` 的 `!tests/build/**` 允许该路径。
- 默认 `bun run build` 后 `dist` 保留正式编译输出（263 files，策略目录仅 `intradayRegression`），未遗留 `privateBuySchema`、`privateSellSchema`、`alpha`、`unfinished`、`buildFailure` 或 `source removed` fixture；测试临时工程根目录清理后为 0。
- 本地证据未覆盖 Broker 委托、生产凭据、部署、线上错单/错误率，也不宣称内部浮点逐位相同；source/dist 证据是在同一临时工程内分开模块、实例和 queue capture，dist 阶段移走 source，不是两个物理 fixture 根目录。

## 5. 风险、回滚和完成标准

### 5.1 主要风险

1. **当前轮可用性传播与数学状态脱节**：只保护 KDJ state 仍可能让 snapshot/display/sample 读到 committed 旧值；G2 必须与 G1 一起验收，不能用 state 深相等掩盖输出语义错误。
2. **KDJ 修复改变数值时序**：正式 D/J signal、BUY D/ADX 和 SELL K verification 会从污染值回到未污染值；这可能改变决策数量或时机，是预期安全影响，不得用“测试只看 state”掩盖。
3. **active preview 与 confirmed/shift 边界错位**：同 timestamp 坏→好/好→坏、坏历史柱和当前坏柱若共用永久 latch，会错误屏蔽后续有效柱；测试必须分别断言 preview、committed 和当前可用性。
4. **source/dist 测试错位**：只测 source 会漏掉资产/扩展名问题，只测 dist 会漏掉测试 fixture 的直接模块问题；R2 只做一个最小链路的两种装载模式，避免重复完整流程。
5. **边界范围膨胀与证据过度外推**：STRAT-002 本方案不执行，STRAT-003 不在本方案范围；source 与 dist 的真实 decision-to-queue 证据必须分隔，无 Broker 的测试只能证明各自组合和 queue，不能证明真实委托、部署或线上错误率。

### 5.2 回滚原则

- 不回滚或覆盖他人工作区；每个代码变更按文件和测试门禁独立提交/审阅。
- 若 G1 guard 或 G2 可用性传播失败，修正/回滚对应代码或测试 fixture，不把半成品标成修复，不添加 cache 全局过滤、loader fallback、中央 registry 或 Broker 旁路。
- 若 R2 source/dist smoke 失败，回滚/修正测试 fixture 或装配边界，不扩大公共策略协议。
- STRAT-002 的 O1 本方案不执行；STRAT-003 的 O2 不在本方案范围，均不进入本方案回滚或必修门禁。若未来独立实施失败，应单独修正或撤回，不降低 G1–G3/R1–R3 的必修门禁。

### 5.3 完成标准

本方案只有同时满足以下条件，才能标记为“实施完成”（仍不等于生产发布通过）：

1. 已确认的输入合同与本轮不可用政策已按文档接线：被拒绝的 H/L/C 输入以及合法 zero-range 最新柱的 K/D/J 不可用，旧 KDJ 不进入 snapshot、display、signal 有效值或 verification sample value；非空有限数值字符串、零/负数、区间不一致及缺 `open`/`volume` 均按合同处理；此项不再等待业务选择。
2. G1 已在 KDJ commit 前原子校验 H/L/C；无效输入不改变 KDJ state，合法 zero-range 仍推进窗口并保留历史平滑状态，缺 `open`/`volume` 不误拒绝，未全局改 `toNumber`，未改 cache partial 政策或其他指标。
3. G2/G3 的 runtime snapshot 可用性传播、active preview/confirmation/shift/bootstrap 矩阵、N-of-M、delayed initial gating、pending/sample 消费者和正式 profile 回归全部通过；不擅自 fatal、取消 pending、补样本、延长 timer 或全面禁交易。
4. R1–R3 source/dist 两侧分别通过最小真实 decision-to-queue；loader/build 既有资产回归未退化；`triggerTimeMs` 仍按真实 now/T0 语义；无 Broker/生产凭据依赖。
5. 按第 4 节顺序的 format、lint、type-check、受影响测试、build 和整仓 test 均有真实退出码记录；不得把“未运行”写成通过。
6. 交付报告明确列出仍未验证的 Broker、部署、线上和任意语义插件范围，并链接本方案与原 issue；当前文档不得把实现/验收待执行写成代码已修复。

## 6. 明确未决项（不包含坏柱政策选择）

- **STRAT-001 实现与验收**：政策已确认，G1–G3 已由本次 runtime、signal、verification、正式 profile 和整仓测试通过；P1 可标记为本地实施验收完成，不等于生产发布。
- **STRAT-004 组合验收**：R1–R3 已由 source/dist 两侧真实 decision-to-queue smoke 和 `productionBuild.test.ts` 通过；结论限于当前四 action、LONG/SHORT 席位和一分钟行情公共协议。
- **STRAT-003（本方案范围外）**：不在本方案实施或验收；未来若独立立项，再决定独立 emission 还是业务等价合并及 retry identity，当前不增加公共字段。
- **STRAT-002 timeWakeup projection**：若未来治理，需按末日保护真实宿主能力另立方案；本方案不修改。
- **EMA:250 冷启动合同**：若产品未来要求首次事件即 ready，另立历史窗口/能力协商决策；当前连续增量可预热，正式 profile 未启用 EMA。

> **完成状态声明**：本文件记录的 G1–G3/R1–R3 已完成本地实施验收，且第 4.4 节列出本次真实命令和退出码；原 issue 仍记录前轮 KDJ 最小复现。该状态不表示上线、Broker、部署或线上验证，不宣称内部浮点逐位相同，也不把同一临时工程内分开的 source/dist 模块、实例和 queue capture 写成两个物理 fixture 根目录。
