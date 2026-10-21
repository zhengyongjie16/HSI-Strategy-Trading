# OE-005 独立二审：cancel/replace 一般外部拒绝被升级为 submit 式 UNKNOWN fatal

## summary

- **verdict：confirmed，major。** 对同一原始 HTTP 403 请求失败，固定 develop 的改单与超时撤单 owner 正常返回/排空，当前真实 native adapter → orderOps → Monitor route 将其转为 `TradeMutationUnknownError` 并触发全局 termination。此结论来自生产旧/新 Monitor 的同输入运行，不是直接注入中性 `UNKNOWN` 的测试。
- **确认范围**：非程序错误、非已知 closed/602012/602013、非可重试暂态的真实 cancel/replace 请求失败，以 `Object.assign(new Error('HTTP 403 permission denied'), {status:403})` 为实测输入。消息型 `new Error('HTTP 403 forbidden')` 的真实 adapter 分类也相同。
- **不扩大主张**：没有证明实盘已发生；不声称所有 broker code 都可由每种 mutation 返回；不声称直接公共 cancel 自己就一定上报 fatal。直接公共 cancel 是从旧返回 `UNKNOWN_FAILURE` 变为新抛错，其后是否 fatal 取决于真实 caller；本次已确认的 fatal 路径为行情跟价 replace 和 BUY 超时 cancel route。
- 固定基线：`develop = origin/develop = FETCH_HEAD = 6e239c8a128372bd9b2fb2d79464346792a5e81e`；当前 `HEAD = 2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`。
- 模型：本子会话 JSONL `.../pi-codex-subagents/runs/d05757cd87992b122c072242/0f14212a-1f9c-4ef4-b64e-a7a54d86dd0b.jsonl:2-3` 的实际记录仍为 **`cliproxyapi / gpt-6.1-sol / thinking=max`**，没有后续切换。本子代理此前已用进程祖先命令行交叉核实。
- 约束：只读源码、固定 git 对象内存加载、fake SDK 方法拒绝；未创建真实 SDK context、未使用网络/实盘、未 checkout/reset、未修改源码/测试/配置/计划。仅创建本指定报告。前后工作区干净。

## critical issues

None. 未据可用性回归推断未经证实的错单或已发生财务损害。

## major issues

### OE-005｜confirmed：把 cancel/replace 一般非重试外部失败套入 submit UNKNOWN fatal

- **claim**：SDK cancel/replace 抛出普通 HTTP 403 `Error` 时，当前通用 mutation runner 的 `UNKNOWN → throw` 改变旧 owner 的失败政策；这不是中性 DTO 投影或错误文字变化，而是把局部操作失败升级为整个交易程序终止。
- **current evidence**：
  - `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts:189-211,215-231`：实际 SDK replace/cancel catch 进入各自分类函数。
  - `src/infrastructure/longbridge/trade/mutationErrorClassification.ts:139-170,174-190`：403 不命中特殊业务码/暂态，真实 producer 返回 `kind:'UNKNOWN'`，保留 cause。
  - `src/application/orderTracking/orderMonitor/orderOps.ts:299-324`，尤其 `:306`：所有操作的 UNKNOWN 无条件抛 `createTradeMutationUnknownError`。
  - 同文件 `:526-554`（cancel 调用共享 runner）、`:855-872,887-891`（replace 调用共享 runner且不恢复一般失败结果）。
  - `src/application/orderTracking/orderMonitor/routeProcessor.ts:309-348,960-963`：超时 cancel/行情 replace 的拒绝向 route 传播；`routeRuntime.ts:150-172` 将 route 拒绝交 `termination.reportFatalError`。
- **develop evidence**：
  - `src/utils/apiFailure/index.ts:294-331,340-374`：403 非重试时抛出原 `Error`，不是包装成耗尽暂态的 `ExternalApiRequestError`。
  - `src/core/trader/orderMonitor/orderOps.ts:460-519`：cancel catch 区分已包装外部暂态、retryable/closed 后，一般失败返回 `UNKNOWN_FAILURE`。
  - 同文件 `:684-705,728-801,805-818`：replace 的真实 native 请求经原 wrapper；一般失败到 `:799-801` 更新 `lastPriceUpdateAt`、记录错误并返回 `NOT_EXECUTED`。
  - `src/core/trader/orderMonitor/routeProcessor.ts:417-455`：BUY 超时一般 cancel 失败使用原 backoff，不抛出 route；旧 route runtime 虽也有 fatal owner（`routeRuntime.ts:162-168`），但本输入没有到达该拒绝分支。
- **minimum reachable trigger**：
  1. 同一合法 ACTIVE 席位，订单已附着 Monitor，授权有效、quantity=100、原价=1、ELO。
  2. replace 路径关闭 BUY/SELL timeout，跟价间隔1秒；推进时钟60秒，行情价1.1，native `replaceOrder` 抛原始403。
  3. cancel 路径为 BUY timeout=1秒，推进时钟60秒，以一条行情事件触发 timeout 优先路径；native `cancelOrder` 抛同一原始403。
  4. 无 TypeError、坏金融输入、缺执行事实、closed code、拒绝授权或虚构 UNKNOWN 注入。
- **runtime path**：
  ```text
  SDK方法替身抛HTTP403原Error
    → 真实TradeMutationAdapter catch
    → classifyReplaceRequestError / classifyCancelRequestError → UNKNOWN
    → executeMutationRequest → TradeMutationUnknownError
    → routeProcessor await拒绝 → routeRuntime.reportFatalError
    → RuntimeTermination latch + 同步关门/停生产 → 顶层清理
  ```
- **impact — confirmed**：本地离线同输入中，旧版本 `fatal=false / gate=true / drain正常`；当前 `fatal=true / gate=false / drain拒绝同一fatal对象`。再发第二次合法行情，旧继续跟价/撤单尝试，当前因 termination 不再跟进。两版均未新提交订单或额外查询订单详情。
- **impact — potential**：一次局部撤改权限/请求拒绝会停止其他正常订单跟踪和全局普通交易，要求重新启动/恢复；未证明某次生产故障已造成持仓损失，不量化盈亏。
- **spec evidence**：`docs/architecture/architecture-refactoring-implementation-plan.md:33-35` 的例外明确为 **submit UNKNOWN**；`:35` 末句限定“仅针对 submit 结果不可确认”；`:53` 保留撤单确认语义；`:1582` 更直接要求“cancel/replace 的既有错误分类及重试时机不变”。没有发现授权把该策略扩成所有 mutation 的条款。
- **minimal fix**：修复 adapter/结果契约与共享 operation policy，而非在每个 workflow 捕获全部异常：
  1. 对 cancel/replace 的一般非重试请求失败保留中性事实及原 cause/code；让 tracking owner 返回原 `UNKNOWN_FAILURE` / `NOT_EXECUTED`，replace 同时保留旧 `lastPriceUpdateAt` 的失败节流更新。可用明确一般请求失败标签，或对这两种 operation 的现有 UNKNOWN 恢复旧 owner 政策；不能继续在通用 runner 中把它们当 submit UNKNOWN。
  2. **submit UNKNOWN 继续 fatal且不重提**。程序/金融/契约错误仍原样抛出，不能用广泛 catch 将 TypeError/RangeError/InvariantError 降为普通外部失败。
  3. 保留现有有限暂态重试、closed后的权威查询、602012禁改、602013有限退避与 WAIT_WS_ONLY、ACK≠terminal、原 caller 与 route generation/attached identity；不新增自动查询/持久化/重启恢复协议。
  4. 不在 application 层重新读 SDK cause 文本来猜类别；真实 SDK 分类留在 adapter，失败政策由所属操作 owner 表达。
- **validation**：下文 A/B/C 同输入探针；新增回归应从 raw native Error 经真实 adapter 到真实 Monitor route，断言旧一般失败结果/门禁与 tracking 延续。仅注入中性 UNKNOWN 或验证错误对象字段不足。
- **dimensions**：implementation、project/spec、type design、tests、comments（当前“UNKNOWN 必须先于过期结果暴露”的注释强化了过宽政策，不构成业务授权）。

## minor issues

None. 不把字段/错误文案差异单独立项。

## 1. 关键反证核查

### 1.1 HTTP403 是否在 externalApi 边界就已 fatal？——rejected

真实 current `src/infrastructure/externalApi/index.ts:39-75` 与 develop `src/utils/apiFailure/index.ts:340-374` 均执行：

```text
请求 catch → isProgramError? → 非retryable则 throw 原error
           → 只有允许重试且耗尽，才 createExternalApiRequestError
```

当前 `src/infrastructure/externalApi/errorClassification.ts:18-30,173-201` 的 permission/forbidden 等将输入判为不重试；这里的 `FAIL_FAST` 是**本次请求不重试**，不是调用全局 termination。wrapper 没有 `reportFatalError`，旧上层 owner 仍可消费该原始错误返回普通失败结果。

**独立 probe A**：直接调用两个真实 wrapper，注入同一个 `Error('HTTP403...')` 请求拒绝：

| 版本 | 请求次数 | 捕获对象严格等于原cause | error.name | 是否包装为ExternalApiRequestError |
| --- | ---: | --- | --- | --- |
| develop | 1 | true | Error | false |
| current | 1 | true | Error | false |

不能从“外部API FAIL_FAST”跳跃推断“旧版本最终也会 fatal”。fatal 与否必须继续读 owner catch；旧一般403正是在该处被正常收口。

另外，当前 mutation port 并不先绕道新 externalApi wrapper再调用 SDK；真实 `tradeMutationAdapter` 单次请求已 catch 结果，有限重试由 `orderOps.executeMutationRequest` 负责。probe A验证的是旧包装行为/反证问题，probe B才验证当前实际执行链。

### 1.2 develop 是否稍后还是 fatal？——对本次两个真实route输入 rejected

- 旧 replace catch `orderOps.ts:799-801` 返回 `NOT_EXECUTED` 后，上层 `index.ts:218-223` 正常 resolve；跟价 route 没有再次把日志或这个返回值抛为 fatal。
- 旧 BUY timeout cancel 的 `UNKNOWN_FAILURE` 到 `routeProcessor.ts:417-455` 后进入 `applyCancelRetryBackoff`，不是 route 拒绝。
- 两版 route runtime 都会把**真正的未处理拒绝**交 termination；差别是新通用 runner创造了旧一般失败没有的拒绝。
- probe B不只看第一次返回：第二个合法行情/超时时点旧仍继续尝试且 gate=true，最终 drain正常；当前第一次就锁存fatal，第二次没有继续调用 broker方法。

限定：直接公共 `monitor.cancelOrder` 的新抛错被本探针调用方显式捕获后，当前 termination 仍未置位。这说明“公共 cancel 一抛就自身自动 fatal”是过宽说法。本 finding 的全局fatal后果有真实route证据，不依赖这个过宽说法。

### 1.3 plan §1.1 是否授权所有 mutation UNKNOWN fatal？——rejected

- `plan:35` 明确标题及正文均为 submit，且末句“该决策仅针对 submit 结果不可确认，不改变 cancel/replace 的既有 ACK、终态确认、602013 与 WAIT_WS_ONLY 协议”。
- `plan:1582` 进一步明确“submit UNKNOWN按§1.1统一为fatal；…cancel/replace的既有错误分类及重试时机不变”。
- 因此没有“为了更安全，把所有 mutation未知错误都终止”这一可用授权。即使新的选择可讨论，也不能作为此次等价重构的已批准政策。

## 2. 独立双实现 Monitor 实验 B

### 测试结构与防止假阳性

- develop 完整源码由 `git show 固定SHA:path` 经 Bun.Transpiler 内存加载，旧 `createOrderMonitor`、`orderOps`、wrapper、routeProcessor、routeRuntime 真实运行，不复制旧算法。
- 当前使用真实生产 `createOrderMonitor` 和 `createTradeMutationAdapter`，传入**同一 native方法替身**；替身抛 raw Error，不返回中性 `UNKNOWN`。
- 两边均使用真实 `RuntimeTermination`，其 closeTradingGate 回调更新同一 gate；这样能观察真实 fatal latch，而不是只统计 `logger.error`。production root 的对应接线见 `src/app/runApp.ts:65-93`、`src/runtime/lifecycle/terminationRuntime.ts:33-61`。
- 账户/经济/席位 ancillary 使用现成测试替身及真实 hold registry；没有终态或成交输入，实验不主张覆盖财务账。量价只使用两版均可精确表示的100、1、1.1、1.2，排除金融精度升级的干扰。
- 初始化、空快照恢复到 ACTIVE、startRuntime、trackOrder均走真实 Monitor API，订单确实attached；两版 raw请求次数均为1说明正常走进了SDK边界。
- 所有quote/timeout使用可控本地时钟；SDK context从未创建。SDK enum/Decimal只在正常旧路径/当前真实adapter做普通序列化，没有HTTP/真实账户访问。

### 结果

两版同一个 cause：

```typescript
Object.assign(new Error('HTTP 403 permission denied'), { status: 403 })
```

| 场景 | develop | current |
| --- | --- | --- |
| ELO SELL跟价，第一条行情1.1 | replace=1，fatal=false，gate=true | replace=1，fatal=true，gate=false |
| 再过60秒行情1.2 | replace总数=2，仍无fatal | replace总数仍=1，termination阻止继续 |
| BUY超时1秒，时钟+60秒后quote触发timeout优先路径 | cancel=1，fatal=false，gate=true | cancel=1，fatal=true，gate=false |
| 再过60秒quote | cancel总数=2，仍无fatal | cancel总数仍=1 |
| 两个route最终stop/drain | resolve | reject，与fatal对象严格同一 |
| 真实native请求之外的submit/detail查询 | 均0 | 均0 |
| 直接公共cancel（不经自动route） | resolve `{kind:'UNKNOWN_FAILURE',errorCode:null}` | throw `TradeMutationUnknownError`；被caller捕获后没有自动fatal |

当前两个route fatal均保留 `requestAttempted=true`、准确 operation及 `error.cause === 原403对象`。价格/数量未错误改写；确认的是失败范围升级，而非本次已经发出错误新单。

探针 exit 0。附录给出可运行完整版本；报告写入后，已从**本报告原文提取附录完整脚本再次执行**，exit 0，输出 `result:'raw SDK403 route difference confirmed'`，上述六项scenario及wrapper断言均通过。没有使用首审附录 A4 或复用首审探针结果作证；首审文本只作为待反证的主张。

### harness 准备中的失败（不混计为业务缺陷）

最初在BUY超时探针中同时手动触发全部已到期timer，当前首fatal发布前，多个同轮timer造成route dirty重驱，测得请求数2而不是预设1，断言失败。为隔离此次候选，最终用**一条quote触发原timeout优先路径**，两版第一轮raw cancel均1。未将前一次多唤醒现象立为新问题，也未改生产代码。成功结果只取最终明确受控的输入序列。

## 3. 真实 adapter 控制实验 C

全部从native方法直接 throw，再经 `createTradeMutationAdapter`，不是注入中性标签：

| 原始cause | cancel结果 | replace结果 | 原cause身份 |
| --- | --- | --- | --- |
| Error + `status:403` | UNKNOWN | UNKNOWN | 保留 |
| 仅文本 `HTTP 403 forbidden` | UNKNOWN | UNKNOWN | 保留 |
| Error + `status:503` | RETRYABLE_EXTERNAL_ERROR | RETRYABLE_EXTERNAL_ERROR | 保留 |
| 结构化 `code:602012` | 未据此声称真实cancel可达 | REJECTED/UNSUPPORTED_BY_TYPE | 保留 |
| TypeError | 原样抛TypeError | 原样抛TypeError | 保留 |

实验 exit 0，每个native方法各调用一次，adapter本身不重试/不查单。该控制实验排除了“403只是程序错误”“所有异常都被new adapter同样处理”等替代解释。TypeError的控制只验证当前内部错误保留，不把旧宽catch可能吞内部错误的历史问题混入OE-005。

## 4. 定向现有测试与缺口

只运行两条名称过滤命令，不重跑全仓或G2首审：

```powershell
bun test tests/infrastructure/longbridge/trade/tradeMutationAdapter.test.ts -t "replace unrecognized failure|cancel unrecognized request failure|replace known transient|cancel transient|internal SDK contract failures"
bun test tests/application/orderTracking/orderMonitor/orderOps.business.test.ts -t "UNKNOWN stays fatal"
```

结果：分别 **7 pass / 0 fail / 28 assertions**、**2 pass / 0 fail / 16 assertions**，均exit0。

这些通过**不能反证OE-005**：

- `tradeMutationAdapter.test.ts:440-512` 验证当前producer对一般失败给UNKNOWN，未与旧owner一般失败结果对照。
- `orderOps.business.test.ts:2689-2799` 直接返回中性UNKNOWN，并要求即使detach也fatal；它证明新政策按预期实现，不证明该政策是旧业务行为或已被plan授权。
- 需补的有价值回归是raw HTTP403→真实adapter→真实Monitor自动route，并断言一般失败后全局门禁不关闭、旧订单仍被跟进、replace失败节流/timeout backoff保留；同时对照submit UNKNOWN仍fatal。不能只增加另一组UNKNOWN对象字段断言。

## 5. 七维复核与范围

| lens | 本次独立二审结果 |
| --- | --- |
| implementation | 从native拒绝、两套错误分类、retry/permit到真实跟价/timeout route、termination均追到；confirmed共享policy扩张。 |
| project/spec | 以固定develop行为为oracle；plan:35、53、1582只授权submit UNKNOWN，不授权cancel/replace新fatal。 |
| type design | `TradeCancelResult`/`TradeReplaceResult`把一般非暂态请求失败与不可确认UNKNOWN合并，共享runner再赋fatal；修复需中性事实与operation政策分离，不把SDK解析重新推给application。 |
| tests | 真实producer/真实Monitor同输入新增反证；现有中性UNKNOWN测试只保护新行为，缺旧一般失败oracle。 |
| comments | adapter标题已限定submit拒绝，但通用runner注释“UNKNOWN必须暴露”不分operation；这不能当需求授权。 |
| dead code | 本任务不做独立未消费导出扫描；所涉分类/helper/type都有真实生产调用，不建议删除。 |
| simplification | 修共享结果语义/owner政策即可，不建议各workflow增加吞错catch、特殊403分支或新恢复owner。 |

### 实际读取的生产文件/区段

**当前完整/核心读取**：

- `src/infrastructure/longbridge/trade/mutationErrorClassification.ts`
- `src/infrastructure/longbridge/trade/tradeMutationAdapter.ts`
- `src/infrastructure/externalApi/index.ts`
- `src/infrastructure/externalApi/errorClassification.ts`
- `src/utils/apiFailure/index.ts`
- `src/application/orderExecution/tradeMutationErrors.ts`
- `src/types/tradeMutationPorts.ts`
- `src/runtime/lifecycle/terminationRuntime.ts`（复用此前已深读并复核其本次真实运行）

**当前定向链路读取**：

- `src/application/orderTracking/orderMonitor/orderOps.ts:250-330,495-609,674-938`
- `src/application/orderTracking/orderMonitor/index.ts:1-230,250-465,690-854`
- `src/application/orderTracking/orderMonitor/routeProcessor.ts:110-255,280-385,540-655,765-980`
- `src/application/orderTracking/orderMonitor/routeRuntime.ts:95-225,245-400`
- `src/domain/order/orderTrackingPolicy.ts`
- `src/application/orderTracking/orderHoldRegistry.ts`
- `src/runtime/timer/index.ts`
- `src/app/runApp.ts:65-93`（全局fatal实际装配，非重新全审app）

**固定develop实际读取/内存执行**：

- `src/utils/apiFailure/index.ts`
- `src/core/trader/orderMonitor/{index,orderOps,routeProcessor,routeRuntime,utils,recoveryFlow}.ts`（上述关键区段人工复读；其他转译依赖只用于真实执行，不冒称全部深审）
- 旧正常量价及cancel/replace错误解析的transitive imports由git对象加载，不落盘。

参考/fixture：指定plan §1.1、§4.4相关边界及`:1582`；首审report OE-005；`mock/factories/configFactory.ts`、`tests/helpers/testDoubles.ts`；两个上述现存测试和Monitor测试中的装配契约。未采纳它们的新业务期望替代旧source。

## positive findings

- 当前cause/operation/requestAttempted证据完整，便于可靠识别本次错误没有丢失请求身份。
- 原closed权威确认、602012/602013、暂态标签仍有专门分支；最小修复无须推翻它们。
- route drain保留同一失败对象，首fatal锁存不会被清理次错覆盖；问题在于不该进入fatal的普通失败被提前升级，而非termination实现本身失效。

## not assessed

- 没有连接真实券商，未声称所有Longbridge生产Error字段组合/HTTP拒绝发生频率已实证；实测输入属于生产分类器明确支持的HTTP状态/错误文本域。
- 未穷举全部cancel caller、replace合单路径、恢复时撤不匹配订单的后果。本finding已经有两个完整自动route的全局影响证据；不据此声称每个公共cancel caller都fatal。
- 未比较暂态重试耗尽、unknown submit的全部经济后果；它们不是本次403一般失败的反证。
- 未把上述harness初始多timer请求数作为另一缺陷，也未做全面并发模型检验。
- 本报告不提出将所有原始Error吞掉的修复，不承担旧基线内部错误catch的另案审计。

## recommended next actions

1. 将 **OE-005标记独立二审confirmed（major）**，合并cancel/replace同一根因，不按route拆成多个finding。
2. 按operation修复中性一般失败与submit UNKNOWN的政策分界，恢复旧普通失败返回/节流/timeout backoff；保护现有内部错误fail-fast、closed确认和特殊码状态机。
3. 落实raw native403→真实Monitor route的负向回归，并同步调整现有过宽“所有mutation UNKNOWN必须fatal”的测试期望；不要靠catch/log隐藏错误。
4. 若团队希望另行批准cancel/replace结果不可确认的新全局终止政策，应作为独立业务/可靠性决策明确其覆盖错误域，不能套用本次只针对submit的例外。

## 附录 A：可运行独立同输入探针

在仓库根PowerShell执行。仅内存转译/本地fake SDK方法，无文件写入或网络调用。完整程序同时检查externalApi、两个自动route和直接公共cancel。

```powershell
@'
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {OrderSide,OrderType} from 'longbridge';
import {createOrderMonitor as CurrentMonitor} from './src/application/orderTracking/orderMonitor/index.ts';
import {createTradeMutationAdapter} from './src/infrastructure/longbridge/trade/tradeMutationAdapter.ts';
import {wrapExternalApiRequest} from './src/infrastructure/externalApi/index.ts';
import {scheduleBoundedOneShotAt} from './src/runtime/timer/index.ts';
import {createOrderHoldRegistry} from './src/application/orderTracking/orderHoldRegistry.ts';
import {createTerminationRuntime} from './src/runtime/lifecycle/terminationRuntime.ts';
import {createTradingConfig} from './mock/factories/configFactory.ts';
import {createOrderRecorderDouble,createDailyLossTrackerDouble,
  createProtectiveLiquidationEpisodeTrackerDouble,createSymbolRegistryDouble}
  from './tests/helpers/testDoubles.ts';
const BASE='6e239c8a128372bd9b2fb2d79464346792a5e81e';
const transpiler=new Bun.Transpiler({loader:'ts'}),urls=new Map();
function load(p){
  if(urls.has(p))return urls.get(p);
  if(p==='src/utils/logger/index.ts')return 'data:text/javascript;base64,'+
    Buffer.from('export const logger={debug(){},info(){},warn(){},error(){}};').toString('base64');
  let s=transpiler.transformSync(execFileSync('git',['show',BASE+':'+p],{encoding:'utf8'}));
  s=s.replace(/((?:from\s*|import\s*)['"])([^'"]+)(['"])/g,
    (all,a,spec,z)=>a+(spec.startsWith('.')
      ?load(path.posix.normalize(path.posix.join(path.posix.dirname(p),spec)).replace(/\.js$/,'.ts'))
      :import.meta.resolve(spec))+z);
  const u='data:text/javascript;base64,'+Buffer.from(s).toString('base64');urls.set(p,u);return u;
}
const {createOrderMonitor:OldMonitor}=await import(load('src/core/trader/orderMonitor/index.ts'));
const OldAPI=await import(load('src/utils/apiFailure/index.ts'));
const tick=async()=>{for(let i=0;i<200;i++)await Promise.resolve()};
const cause=Object.assign(new Error('HTTP 403 permission denied'),{status:403});
const wrapper=[];
for(const[name,wrap]of[['develop',OldAPI.wrapExternalApiRequest],['current',wrapExternalApiRequest]]){
  let attempts=0,caught;
  try{await wrap({operation:'TradeContext.cancelOrder',request:async()=>{attempts++;throw cause}})}
  catch(e){caught=e}
  assert.equal(attempts,1);assert.equal(caught,cause);
  wrapper.push({name,attempts,sameError:caught===cause,errorName:caught.name,
    wrappedAsExternal:OldAPI.isExternalApiRequestError(caught)});
}
async function scenario(version,kind){
  let nowMs=Date.parse('2026-10-20T02:00:00Z'),seq=0,gate=true,closed=0,stopped=0;
  const timers=new Map(),listeners=new Set();let replace=0,cancel=0,reads=0,submits=0;
  const logger={debug(){},info(){},warn(){},error(){}};
  const termination=createTerminationRuntime({closeTradingGate:()=>{gate=false;closed++},
    closeProducerAdmission:()=>{},stopProducers:[()=>stopped++],onSecondaryError:()=>{}});
  const ctx={submitOrder:async()=>{submits++;throw Error('unexpected submit')},
    replaceOrder:async()=>{replace++;throw cause},cancelOrder:async()=>{cancel++;throw cause},
    setOnOrderChanged(){},subscribe:async()=>{},unsubscribe:async()=>{},
    orderDetail:async()=>{reads++;throw Error('unexpected detail')}};
  const defaults=createTradingConfig();
  const tradingConfig={...defaults,global:{...defaults.global,
    buyOrderTimeout:{enabled:kind==='cancel-route',timeoutSeconds:1},
    sellOrderTimeout:{enabled:false,timeoutSeconds:180},orderMonitorPriceUpdateInterval:1}};
  const rateLimiter={throttle:async()=>{},
    withTradeMutation:async f=>f({invoke:async op=>op()})};
  const deps={logger,termination,now:()=>new Date(nowMs),
    scheduleTimer:(cb,ms)=>{const id=++seq;timers.set(id,{cb,at:nowMs+ms});return id},
    clearTimer:id=>timers.delete(id),scheduleBoundedOneShotAt,
    wait:async()=>{},requestExternalApi:wrapExternalApiRequest,rateLimiter,ctx,
    tradeMutationPort:createTradeMutationAdapter(ctx),
    orderPushPort:{setOnOrderChanged(){},subscribePrivate:async()=>{},unsubscribePrivate:async()=>{}},
    orderDetailReadPort:{read:async()=>{reads++;throw Error('unexpected detail')}},
    cacheManager:{clearCache(){},getPendingOrders:async()=>[]},
    marketDataClient:{onQuoteUpdated:f=>(listeners.add(f),()=>listeners.delete(f)),
      getQuotes:async()=>new Map()},
    orderRecorder:createOrderRecorderDouble(),orderHoldRegistry:createOrderHoldRegistry(),
    dailyLossTracker:createDailyLossTrackerDouble(),
    protectiveLiquidationEpisodeTracker:createProtectiveLiquidationEpisodeTrackerDouble(),
    persistProtectiveLiquidationExecutionProgress:()=>{throw Error('unexpected durable')},
    postTradeConsistencyRuntime:{recordSettlementRefreshNeed(){},
      getStatus:()=>({started:true,currentVersion:0,staleVersion:0})},
    tradingConfig,symbolRegistry:createSymbolRegistryDouble(),
    isContinuousTradingAllowed:()=>gate,diagnostics:{record(){},observe(){}}};
  const monitor=(version==='develop'?OldMonitor:CurrentMonitor)(deps);
  await monitor.initialize();await monitor.recoverOrderTrackingFromSnapshot([]);monitor.startRuntime();
  const selling=kind!=='cancel-route';
  monitor.trackOrder({orderId:'RECHECK-403',symbol:'BULL.HK',
    side:version==='develop'?(selling?OrderSide.Sell:OrderSide.Buy):(selling?'SELL':'BUY'),
    executionSide:selling?'SELL':'BUY',price:version==='develop'?1:'1',
    initialSubmittedPrice:version==='develop'?1:'1',quantity:100,isLongSymbol:true,
    monitorSymbol:'HSI.HK',isProtectiveLiquidation:false,
    orderType:version==='develop'?OrderType.ELO:'ELO'});
  await tick();
  const quote=(price)=>{const q={symbol:'BULL.HK',name:null,
    price:version==='develop'?price:String(price),prevClose:version==='develop'?1:'1',
    timestamp:nowMs,lotSize:100};for(const f of listeners)f({symbol:'BULL.HK',quote:q})};
  let publicResult=null,publicError=null;
  if(kind==='cancel-public'){
    try{publicResult=await monitor.cancelOrder('RECHECK-403',{kind:'ORDER_FACT'})}
    catch(e){publicError=e}
  }else{nowMs+=60000;quote(1.1);await tick()}
  const firstAttempt={replace,cancel};
  if(kind!=='cancel-public'){nowMs+=60000;quote(1.2);await tick()}
  const fatal=termination.getFatalState();let drainError=null;
  try{await monitor.stopRuntimeAndDrain()}catch(e){drainError=e}
  const error=publicError??(fatal.hasFatalError?fatal.error:null);
  const result={version,kind,firstAttempt,replace,cancel,submits,reads,publicResult,
    errorName:error?.name??null,operation:error?.operation??null,causeSame:error?.cause===cause,
    fatal:fatal.hasFatalError,gate,closed,stopped,drainReject:drainError!==null,
    drainSame:drainError!==null&&fatal.hasFatalError&&drainError===fatal.error};
  if(kind==='cancel-public'){
    assert.equal(cancel,1);assert.equal(fatal.hasFatalError,false);
    if(version==='develop'){assert.equal(publicResult.kind,'UNKNOWN_FAILURE');assert.equal(publicError,null)}
    else assert.equal(publicError.name,'TradeMutationUnknownError');
  }else{
    assert.equal(kind==='replace-route'?replace:cancel,version==='develop'?2:1);
    assert.equal(fatal.hasFatalError,version!=='develop');assert.equal(gate,version==='develop');
    assert.equal(drainError!==null,version!=='develop');
    if(version!=='develop'){assert.equal(drainError,fatal.error);assert.equal(error.cause,cause)}
  }
  assert.equal(submits,0);assert.equal(reads,0);await monitor.teardown();return result;
}
const results=[];
for(const kind of['replace-route','cancel-route','cancel-public'])
  for(const version of['develop','current'])results.push(await scenario(version,kind));
console.log(JSON.stringify({baseline:BASE,wrapper,results,result:'raw SDK403 route difference confirmed'}));
'@ | bun run -
```

旧logger替换为无副作用sink只隔离审计输出；未替换旧错误分类、orderOps、route或termination算法。当前diagnostics为旁观者，不参与mutation/门禁事实。探针不为真实经济账/券商延时提供覆盖承诺。
