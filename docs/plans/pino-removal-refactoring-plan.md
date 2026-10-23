# Pino 完全移除与文本日志链路重构方案

> 方案阶段状态（历史）：方案已完成源码复核与独立复核，尚未实施。本文只定义目标实现和验收要求，不代表重构后的代码已经通过验证。
>
> 分析基线：`beta-V2`，提交 `08cd21e487940c1a4314f9a11d8116515f41ec40`；已安装 Pino 10.3.1，复核环境为 Windows / Bun 1.4.3。实施前重新确认工作区；本文行号仅用于定位基线，以文件和符号为准。
>
> 方案阶段交付（历史）：本轮交付仅新增此方案文档。不修改生产代码、测试、依赖或历史审计记录，不启动交易程序，不读取业务环境文件、凭证或生产日志。
>
> 当前实施与验收状态：Pino 移除、文本日志及有界关闭已完成；独立核心/边界复核、169 pass / 0 fail 的分批定向回归、真实 logger 与薄入口跨边界探针、集中检查及 clean build/残留检查均通过。实际结果与未覆盖边界见 §14；不宣称全量测试或量化性能加速。实施基线为 `beta-V2` / `2a367c2fa7384427261d5039c80b5e741ca431ba`，Windows / Bun 1.4.4。

## 1. 目标与结论

完全移除 Pino 依赖及其专属代码，取消完整日志记录的 JSON 中转，保留当前项目实际需要的文本日志能力，并修复受控退出没有真正等待日志关闭的问题。

最终保留：

- 四方法 `Logger` 接口及同步、返回 `void` 的调用方式。
- DEBUG 开关、控制台级别路由、system/debug 文件路由。
- 香港时间、原有文本布局、颜色和 ANSI 处理语义。
- 调用时固定附加数据、安全格式化、重复日志不去重。
- 现有两端 Writable 队列、按日轮转、追加写入和文件保留规则。
- 业务清理完成后的有界日志关闭。

最终删除：

- Pino 实例、multistream、专属配置、API、直接依赖及无用传递依赖。
- 完整日志 JSON 编码、两个 sink 的 JSON 解析及重复格式化。
- 只为 Pino JSON 输入服务的结构校验和解析失败分支。
- 无效的 Pino flush、名不副实的同步关闭函数及错误注释。

**这不是重新实现一个通用日志库。**不增加新依赖、worker、transport 插件、事件总线、自建队列框架、运行时日志配置、采样、去重、同步重放、磁盘重试服务、fsync 协议或统一错误序列化框架。

不改变交易信号、下单、风控、金融数值、终止门禁、清理阶段和原始 fatal 的选择规则；不修改交易恢复使用的 JSONL。

## 2. 已确认事实与证据边界

本节及 §3 保留方案阶段的历史分析基线，以下源码行号、旧实现测试和探针均不是本轮实施后的验收记录；当前实现及验证结果另见 §14。

### 2.1 基线日志链路

```text
业务 logger 方法
  → Pino 固定时间并序列化 { extra } / msg
  → multistream
      → fileStream：JSON.parse → 文件格式化 → system/debug 轮转流
      → consoleStream：JSON.parse → 控制台格式化 → stdout/stderr
```

虽然配置数组先列 console，已安装版本对当前同级目标的实际投递顺序是 **file → console**。该顺序已通过隔离探针确认，重构按实际行为保留。

| 位置 | 已确认事实 |
| --- | --- |
| `src/infrastructure/logger/index.ts:6、593–604` | 唯一生产 Pino import、实例与 multistream 组装。 |
| 同文件 `:461、508` | 控制台与文件分别解析同一条 JSON。 |
| 同文件 `:314–384` | 两端重复转换时间并格式化 extra。 |
| 同文件 `:528–557` | fileStream 等待本条 system/debug 的全部回调后才推进下一条。 |
| 同文件 `:189–200、687–711` | `closeSync()` 只调用异步 end；`cleanupSync()` 没有等待队列。 |
| `node_modules/pino/lib/proto.js` 的 `flush`；`lib/multistream.js` | flush 只转调目标的 flush；当前 multistream 没有该方法，本次调用不提供刷新保障。 |
| `src/app/runApp.ts:361–374` | 业务 cleanup 之后仍有错误或完成日志，不能在 cleanup 阶段内提前关闭 logger。 |
| `src/index.ts:15–29` | 受控错误当前直接 exit(1)，是接入日志等待的最小位置。 |

### 2.2 真实消费者

上一轮使用 TypeScript AST/type checker 核对实际 `Logger` 签名调用，排除 logger 自身后共 **309 处、66 个生产文件**：debug 77、info 81、warn 93、error 58；264 处单参数、45 处双参数，没有三参数及以上调用。

45 处 extra 的实际形态：38 处字符串、1 处诊断字段对象、2 处 `{ error: string }`、2 处 Error、2 处原始 unknown 错误。logger 自身的进程钩子另有两次错误日志。

- `src/types/logger.ts` 仅包含四级方法，没有 Pino 类型。
- 没有业务方使用 child、trace、fatal、bindings、flush 或动态级别 API，无需为它们编写替代实现。
- `src/infrastructure/diagnostics/index.ts:14` 仍需输出 `{ ...fields, operation }` 的紧凑 JSON 文本；移除 Pino 不等于删除结构化附加字段。
- `src/application/orderTracking/orderMonitor/routeProcessor.ts:482、518` 会在记录原始错误后继续抛出或包装该错误。extra 格式化失败不能取代这些业务错误。
- `src/infrastructure/persistence/mixedTradeLogRepository/index.ts` 独立管理交易 JSONL，其 JSON 编解码、fsync、恢复与失败规则不属于本次改动。

### 2.3 方案阶段已执行验证与未验证部分

- 上一轮对当前 logger 运行独立子进程业务测试：**3 pass / 0 fail，17 次断言**。本轮源码未变，不无故重复执行。
- 本轮隔离探针确认 file → console 顺序；慢 debug 下外层 fileStream 的共同回调屏障；write 返回 true 不等于写完成；空写回调屏障；destroy 后异步 continuation 仍可能继续。
- 本轮临时 extra 格式化原型与旧链路对照 28 类样本，24 类文本相同；差异为循环对象键顺序、顶层 BigInt、嵌套 BigInt、序列化失败提示，均在 §6 明确处理。
- 独立复核确认外层 finish 不会自动关闭内层流、提前 end 不能保证 drain，以及 Bun 的模块 mock 隔离风险。
- 探针没有写入生产代码，也不是重构后的正式测试。尚未执行新实现、全量回归或性能复测，不承诺不存在任何未来实现缺陷。
- 用户提供的性能对照支持删除 JSON 中转的方向，但本文不重新证明其数字，不推导整套交易系统的加速比例。

## 3. 本次复核对初版结论的修正

| 初版表述 | 最终决策 | 原因 |
| --- | --- | --- |
| 格式化上移后可删除 fileStream，直接写两个轮转流 | **保留现有 fileStream**，只删除解析、重复格式化，改为接收已准备文本 | 它还承担 system/debug 共同回调屏障。慢 debug 时直接扇出会提前推进 system，改变原排队行为。 |
| `shutdownLogger(): Promise<void>` 足够 | 使用最小 `Promise<boolean>` 关闭结果 | 必须区分关闭完成与失败/超时；不销毁全局标准流时，仅返回一个 Promise 不能保证自然退出不受残留管道写入影响。 |
| 可以概括为 logger 中不再有 JSON.parse | 两个 sink 和完整记录中转不再 parse；允许 extra 的标量 JSON 结果局部 parse | Date、boxed primitive 和 toJSON 可能产生字符串等标量。原生转换比手写解码器、手调 toJSON 或深拷贝更简单，见 §6。 |
| 沿用入口测试的全局 mock 即可 | 入口测试在独立子进程内 mock logger/shutdown | `mock.restore()` 不撤销 `mock.module()`；query import 不隔离静态依赖，不能关闭测试套件共享的真实 logger。 |

这些修正收紧实现边界，不增加交易层改动，也不增加新的队列或框架。

## 4. 必须保持的外部行为

| 行为 | 重构要求 |
| --- | --- |
| 公开接口 | 继续导出原 logger 单例；保留 `(msg: string, extra?: unknown) => void` 四方法。 |
| DEBUG | 仍仅 `DEBUG=true` 启用，且在取时间、访问 extra、格式化或入队前返回。 |
| 控制台路由 | DEBUG/INFO 到 stdout，WARN/ERROR 到 stderr。 |
| 文件路由 | 所有启用级别到 system；仅 DEBUG 额外到 debug。 |
| 文件创建 | 保留现有日志根目录配置与初始化时目录创建语义；DEBUG 关闭时不创建 debug 流。 |
| 文本 | `[LEVEL] 香港时间 消息[ extra]\n`，级别名称、空格、换行和颜色位置不变；控制台 reset 仍位于消息之后、extra 之前。 |
| ANSI | 文件移除现有规则匹配的实际颜色控制码；不解码、删除 JSON 的 `\u001b` 或 inspect 的 `\x1B` 等可见转义文本。 |
| 顺序 | 保持 file → console 投递；各队列 FIFO；file 内保留 system/debug 共同回调屏障。不承诺不同物理输出设备的全局完成顺序。 |
| 重复日志 | 相同消息调用两次仍输出两次，不采样、不合并、不去重。 |
| 时间快照 | 每次调用只确定一次日志时间，两端共享，不使用队列消费时间替换日志行时间。 |
| 轮转日期 | 继续按 DateRotatingStream 实际处理写入时的香港日期决定目标文件，不顺便改成按日志记录时间分文件。 |
| 文件保留 | 追加 `.log`，system/debug 各自最多保留 7 个日文件；保留原已存在文件与即将新建文件的计数规则。 |
| 运行期背压 | 保留现有文件 5000ms、控制台 3000ms 的 drain 超时政策；logger 不变成等待 IO 的异步业务 API。 |
| 外部 IO 失败 | 保持日志旁路报告、继续释放回调的政策，不新增业务 fatal 或自动重试。 |
| 内部错误 | 不用整段 catch 静默吞掉内部契约或编程错误；安全处理只覆盖 unknown extra 和既有外部 IO 边界。 |

## 5. 目标实现：保留现有队列，删除中转

```text
logger.debug/info/warn/error
  → 检查 DEBUG 开关和关闭状态
  → 固定 time，extra 格式化一次
  → 生成 readonly 文本记录
      { level, consoleLine, fileLine }
  → fileStream.write(record)
      → system.write(fileLine)
      → 若为 DEBUG，debug.write(fileLine)
      → 等本条所有回调落定后推进下一条
  → consoleStream.write(record)
      → 根据 level 写 stdout/stderr
      → 沿用 drain/timeout 推进
```

### 5.1 入口和类型

- 四个公开方法调用同一个内部 `writeLog`；不增加参数重载、printf 插值、child logger 或字符串协议。
- 日志记录只保留级别和最终两端字符串，类型定义放 `src/infrastructure/logger/types.ts`；不再携带原始 extra。
- `LogObject` 与 `isLogObject` 随 Pino JSON 输入一起删除。内部记录由受控代码构造，无需为它新建 runtime schema。
- 保留现有 `LOG_LEVELS` 数值，仅更新 Pino 专属注释；不为了移除依赖重新设计级别模型。
- `readonly` 已足够，不对每条日志深拷贝或 Object.freeze。
- 这是基础设施内部的格式化与流写入，不包装成业务事件链路。

### 5.2 两端 Writable

- consoleStream/fileStream 改成接收内部文本记录的 objectMode Writable。
- 删除 Buffer 解码、完整记录 JSON.parse、输入结构校验、重复时间转换和 extra 格式化。
- fileStream 继续保留原有 system/debug 回调等待，不新增 Promise 链队列或额外调度器。
- objectMode 的 highWaterMark 单位与原字节流不同，但本模块仍沿用原同步 logger 接口；不将该变化宣称为新增内存上限或端到端背压能力。
- 两端仍独立处理，不因为控制台慢而让业务 await 文件或控制台。

### 5.3 调用时快照

以下行为必须有回归保护：

```typescript
const data = { status: 'before' };
logger.info('状态', data);
data.status = 'after';
```

两端都应记录 `before`。浅复制外层 record 不够，必须在调用内完成 extra 文本生成。不得在各 sink 中重新访问 extra 或再次调用 toJSON。

## 6. extra：原生能力优先，不复刻 Pino

### 6.1 明确的格式化规则

| 输入或 JSON 转换结果 | 输出约定 |
| --- | --- |
| 顶层 undefined/null | 不追加。 |
| 顶层字符串 | 使用当前 inspect 标量规则，保留单引号/双引号选择和转义表示。 |
| 有限 number、boolean | 保持旧文本；`-0` 输出 `0`。 |
| 顶层 NaN/Infinity/-Infinity | 不追加，保持旧链路最终转 null 后被省略的行为。 |
| 顶层 function/Symbol | 不追加。 |
| 普通对象/数组 | 原生 JSON 紧凑文本，保留普通对象属性顺序、数组顺序；不改成 inspect 排版。 |
| 对象内 undefined/function/Symbol、非有限数字 | 遵循原生 JSON 的对象字段省略、数组 null 和非有限数 null 规则。 |
| Error | 保持 JSON 的可枚举字段行为；普通 Error 通常是 `{}`，自有可枚举字段仍输出。不顺便添加 stack/cause 协议。 |
| Date、boxed primitive、正常 toJSON | 使用原生 JSON 转换；对象/数组结果直接作为文本，标量结果按上面的标量规则输出。 |
| 真正的循环引用 | 替换为 `"[Circular]"`，不抛出到业务调用方。 |
| 重复但非循环的引用 | 两处都正常输出，不能误标为循环。 |
| 顶层/嵌套 BigInt | 转为保真十进制字符串：顶层按字符串显示，嵌套为 JSON 字符串。 |
| getter、toJSON 或 JSON 序列化抛异常 | 输出固定的 `'[Unserializable]'` 附加文本，原消息及后续业务错误传播不受替换。 |

空字符串 extra 不是缺失，仍应显示 `''`；字符串 `"null"` 不等于 null。

### 6.2 最小实现路径

1. 对常见顶层原始值直接处理，不做 JSON 往返。
2. 对对象/数组及 BigInt 使用一次 `JSON.stringify`，replacer 只负责祖先路径循环识别与 BigInt 转字符串。
3. 使用当前祖先路径而不是全局 WeakSet；`{ a: shared, b: shared }` 不构成循环。祖先数组只是一次同步格式化的局部遍历状态，不修改输入对象。
4. 原生 JSON.stringify 自己调用 toJSON；不提前手动调用、不在失败后再尝试第二轮 JSON.stringify。
5. stringify 返回 undefined 或文本 `null` 时不追加；结果以 `{` 或 `[` 开头时直接使用该最终文本。
6. 只有 JSON 标量结果才局部 `JSON.parse` 后按标量规则格式化，例如 Date 的字符串结果。不得解析对象/数组来重新格式化，也不得恢复完整日志 JSON 信封。
7. 序列化异常直接使用固定提示，不再 inspect 原始坏对象，不执行未知 customInspect，也不引入一套备用对象遍历器。

这样保留必要安全性，同时避免 JSON 深拷贝、自定义字符串解码器、通用 serializer 插件与多层 fallback。安全边界只承诺捕获抛出的异常，不能中断无限循环的 getter/toJSON 或同步阻塞；不为此添加 worker/watchdog。

### 6.3 明确接受的显示差异

以下不是交易行为变化，但必须写进实现验收说明，不能宣称所有 unknown 值逐字节等价：

- 旧 Pino 的循环/BigInt fallback 可能排序、按内部深度/宽度限制裁剪；新实现不复刻这些私有规则，循环对象键顺序或复杂内容显示可能不同。
- 旧链路会把超大 BigInt 经 JSON 数字解析变成不精确 number；新实现用字符串保真，不模拟该有损行为。业务金融值本来由调用方提供十进制文本，不改变其数据或计算。
- 无法序列化时改用简短固定提示，不保留 Pino 的内部错误文案。
- 不复刻有副作用的 toJSON/getter 在旧 fallback 中可能被重复访问的行为；新方案只进行一轮原生序列化。

普通文本、字符串 extra、诊断对象、现有 Error 可枚举字段和路由要求保持一致。

## 7. 轮转流与关闭资源所有权

继续使用现有 DateRotatingStream；不将此次修改扩大为类改工厂、目录重组或轮转算法重写。

为真正关闭补齐必要的 Writable 生命周期：

- `_final`：自身已接收的写入处理完毕后，结束底层文件流并等待其写入结束和关闭。没有创建过文件时直接完成，不为关闭动作新建空日志文件。
- `_destroy`：取消本实例持有的 drain 等待，销毁自有底层流；同时覆盖轮转中正在关闭的旧流。
- 优先使用标准 `stream/promises.finished` 等能力观察完成与错误，不轮询 writableLength、不固定 sleep。
- 现有 `_doRotate` 在等待旧流前把 `_fileStream` 置空。实现时调整引用所有权，让旧流在整个关闭等待期间仍可被 destroy 触达；不需要另建全局流注册表。
- `_checkRotate/_doRotate/_write` 的 await 返回后、创建新文件前、实际写入前检查销毁状态，防止关闭超时后 continuation 重新打开文件或写入。
- 保留正常轮转、保留清理与运行期外部错误政策，不新增恢复重试。

**write 返回 true、write callback、drain、finish、close 各有不同含义。**不能以任意一个“流可以继续写”的信号替代整条关闭协议。

## 8. 日志关闭协议

### 8.1 独立能力，不扩张业务 Logger

在 `src/infrastructure/logger/index.ts` 独立导出：

```typescript
export function shutdownLogger(): Promise<boolean>;
```

含义：

- `true`：本次关闭协议正常完成，包括自有队列、底层文件流和标准流屏障。
- `false`：关闭期间出现外部 IO 失败或达到总超时，不能宣称本次完整排空。
- 结果不证明历史每一条日志成功，更不等于 fsync 后物理持久化。
- 内部契约或编程错误仍 reject，不伪装成外部 IO 的 false；先尽力取消自有工作，再由进程入口报告并结束。

同一次 logger 生命周期只执行一次关闭，多次调用返回同一个已发布 Promise 及结果。不加入全局 `Logger` 接口，不扩张业务依赖、RunAppDeps 或所有测试替身。

关闭开始后不再接受新正常日志，不重开文件，也不提供 restart/flush-then-resume。生产接入点必须先完成业务停产和清理。关闭后的有效级别日志调用属于内部生命周期契约错误，应 fail-fast，不静默丢弃；已禁用的 DEBUG 仍提前返回。进程钩子在 logger 已关闭时直接使用独立 stderr 报告，不能递归写已关闭队列，也不能因关闭状态丢掉退出动作。

### 8.2 正常关闭顺序

1. 同步标记关闭并发布共享 Promise，建立单个总超时。
2. 对 consoleStream/fileStream 发起 end，让已接收条目继续处理；不能先 end 下游。
3. fileStream 排空后再结束 system/debug；DateRotatingStream 通过 `_final` 等待其底层文件流完成和关闭。可由 fileStream 的 final 向下传递结束，不增加第三套关闭流程。
4. 等待两个输出队列及全部自有文件资源完成。任一外部关闭失败仍尝试其余资源，不因首个失败提前漏掉另一端。
5. **所有自有文件关闭/错误报告都落定后**，才在 stdout/stderr 上提交写回调屏障，例如空字符串 write callback；这也覆盖入口直接 console.error 的最终错误输出。
6. 成功则清理总 timer、观察器和本模块临时监听，返回 true。

不对 process.stdout/process.stderr 调用 end 或 destroy。console 队列 finish 不等于底层标准流已处理全部数据；file 关闭期间还可能报告 stderr，因此标准流屏障必须放在共同尾部。

### 8.3 单总超时与真正中止

在 `LOGGING` 中增加一个关闭总超时常量，建议 **5000ms**，从首次 shutdown 开始计算，覆盖全部阶段；不按每条日志或每个流重置。

超时或无法继续关闭时：

- 幂等销毁自有 console/file 队列和轮转流，释放本模块的 drain listener、timer 与等待回调。
- 旧文件流、当前文件流、正在轮转的引用都必须可触达；destroy 后的异步 continuation 不再创建新资源。
- drain、错误、关闭、超时、中止共用一次性结算，不能重复调用 Writable callback。
- 对取消与迟到回调完成结算/错误消费，不能制造未处理 rejection 或错误事件。
- 标准流写回调报告错误后，底层仍可能随后发出 error；不能在错误回调中提前移除唯一 error 监听，留下未处理错误。
- 独立 stderr 尽力报告一次关闭失败或超时，不调用已关闭的 logger，不重试、不再无限等待该诊断。
- 返回 false；不再无界等待 destroy 的底层系统调用完成。

**禁止只用 Promise.race 返回，却让后台轮转继续开文件。**这里只需要每个既有串行流管理自己的当前等待与取消，不需要通用取消框架、全局活动任务集合或第二队列。

总超时保证的是事件循环正常推进时的有界异步等待，不能打断同步阻塞或卡死的系统调用。stdout/stderr 属于全局资源，失败后仍可能保留待写句柄，由进程入口按 §9 决定结束；不能声称仅 logger 内部返回 false 就保证进程自然退出。

## 9. 入口与进程钩子

### 9.1 src/index.ts 是唯一受控退出接入点

保持当前由 Bun 启动时加载环境变量的方式、`runApp({ env: process.env })` 调用及三类错误输出。原方案的 dotenv 初始化要求已过时，本轮不得恢复 dotenv 初始化或依赖：

- ConfigValidationError：只输出“程序启动失败：配置验证未通过”。
- AppStartupAbortError：不追加通用错误输出。
- 其他值：输出“程序异常退出”及原始值。

改动仅为：catch 不提前 exit，用显式失败标志保存结果；在 finally 中等待 shutdownLogger，最后按矩阵结束。不能用 `if (error)` 判断失败，因为原始 fatal 可以是 null/undefined。

| 业务结果 | 关闭结果 | 入口行为 |
| --- | --- | --- |
| 正常 | true | 自然返回，不新增成功关闭时的 exit(0)。 |
| 失败 | true/false | 日志关闭尝试落定后 exit(1)，保持原业务失败。 |
| 正常 | false | 调用无参数 `process.exit()`，保留已有 exitCode，通常为 0；避免残留标准流句柄无限拖住退出。 |

最后一项只用于日志关闭失败/超时，不把日志设施外部故障升级成交易 fatal，也不改变已有非零 exitCode。`shutdownLogger` 本身不负责进程退出。

如果 shutdown Promise 因内部契约/编程错误 reject，入口用独立 stderr 报告该关闭错误并退出 1：已有业务失败仍保留此前报告的原始错误和失败结果；没有业务失败也不能静默成功。该分支与外部 IO 失败返回 false 分开处理，不在 finally 中用一个不区分来源的 catch 把所有问题降级。

不修改 `runApp`、`createCleanup`、`CLEANUP_PHASE_ORDER`、terminationRuntime 或信号准入链路，不新增 logger cleanup 阶段。受控 fatal 仍由 runApp 先关交易与队列准入、等待业务资源落定，然后入口等待日志。

### 9.2 钩子语义保持区分

| 路径 | 最终处理 |
| --- | --- |
| beforeExit | 仅注册一次，复用同一个 shutdown Promise；false 时按已有 exitCode 结束；内部 reject 用独立 stderr 报告后退出 1，不制造无人处理的异步 listener rejection。不依赖事件系统等待 listener 的 Promise，而由实际关闭 IO/总 timer 维持等待。 |
| exit | 删除无效异步清理，不在这里承诺落盘。 |
| uncaughtException | 保持尽力报告后同步 exit(1)，不 await shutdown。 |
| unhandledRejection | 保持仅报告，不 shutdown、不新增 termination、不主动退出。 |
| APP_ENABLE_PROCESS_HOOKS=false | 不安装任何上述钩子；显式 shutdown 仍可使用。 |

不能把 uncaughtException 改成 async listener 后等待关闭：process.emit 不等待它，异常后代码可能继续执行，违背当前立即终止语义。保留现有“unreachable 不得执行”的测试。

自然结束的 beforeExit 是补充，不替代入口显式等待。直接 process.exit、真正未捕获异常、SIGKILL、掉电及静态 import 求值失败不保证完整日志；不为覆盖这些路径引入同步重放或交易层改造。

## 10. 文件级改动清单与依赖清理

| 文件 | 实施内容 |
| --- | --- |
| `src/infrastructure/logger/index.ts` | 删除 Pino、JSON 中转及解析校验；统一同步格式化；保留并改造两个 sink；补齐流关闭/取消与 shutdown；修正钩子。 |
| `src/infrastructure/logger/types.ts` | 删除旧 LogObject，定义最小 readonly 文本记录；不增加泛化 LoggerContext 或 transport 类型体系。 |
| `src/constants/index.ts` | 更新 Pino 注释、修正 drain 注释，增加单个关闭总超时常量；保留级别数值及现有配置。 |
| `src/types/logger.ts` | 四方法契约不变；只纠正“由 createLogger 工厂返回”的不准确注释。 |
| `src/index.ts` | 延后受控 exit，finally 等待日志关闭，按关闭结果处理残留句柄。 |
| `eslint.config.js` | 修正入口父目录模式拦截精确例外的问题，只允许既定的 `./infrastructure/logger/index.js`，不放宽其他 infrastructure 模块或架构测试。 |
| `package.json`、`bun.lock` | 由包管理器移除 Pino 和不再需要的传递包，不手工猜测删除共享依赖。 |
| `tests/infrastructure/logger/logger.business.test.ts` | 保留现有行为测试，补充文本快照、序列化边界及进程钩子行为；沿用子进程隔离。 |
| `tests/infrastructure/logger/rotation.business.test.ts`、`shutdown.business.test.ts` | 分别验证轮转/保留及流顺序、关闭等待、失败与总超时。 |
| `tests/infrastructure/logger/processFixture.ts`、`types.ts` | 仅供隔离子进程控制现有文件/标准流边界，不增加生产测试接口。 |
| `tests/index.business.test.ts` | 使用隔离子进程内的完整 mock，验证错误分类、关闭等待与退出矩阵，不能 shutdown 真实共享 logger。 |
| `docs/plans/performance-optimization-audit.md` 的 PERF-03 | 实施后定向纠正失效的“已完成”实现描述和旧路径，并链接本方案的实际验收结果；不借机重写其他性能计划。 |
| 本文 | 实施完成后追加真实验证记录，不提前把待验收项标为通过。 |

必要的少量格式化测试可以放在 logger 对应 tests 目录；不要为了测试公开内部实现、创建可插拔日志工厂或增加生产控制参数。现有纯时间/路径工具继续复用，不将日志特有格式化强行提到全局 utils。

实施依赖步骤使用 `bun remove pino`，检查 package/lock 实际差异及依赖图。Pino 的私有传递包只有在无其他消费者时才消失；不新增 safe-stable-stringify 等包作为变相保留。

重新 clean build，检查生成的 dist 不再 import Pino。不要将旧产物误认为运行代码已完成清理，也不要直接运行产物连接交易服务。

清理范围包括当前源码、测试、运行配置、依赖及当前有效文档。历史审计证据、冻结 baseline、本文对旧实现的分析可以继续提及 Pino；不能为了全文零命中篡改历史或放宽架构门禁。

## 11. 实施顺序

### 第一步：锁定行为样例

- 确认 HEAD、工作区和实际调用形态，复用本轮证据。
- 在删除依赖前记录常见 extra 的旧输出预期及必要差异，不把依赖 Pino 的对照代码留作永久测试。
- 完善子进程测试环境，复用 `tests/setup/childEnv.ts` 的 `createChildEnv` 白名单及临时目录；在白名单结果上显式添加 `BUN_OPTIONS=--no-env-file`，同时保留 CLI `--no-env-file`，覆盖嵌套 Bun，不继承凭证、不连接 SDK。

### 第二步：替换日志热路径

- 实现一次 extra 格式化和两端文本准备。
- 将现有两个 sink 改为文本记录输入，保留 file → console、共同文件回调屏障和 FIFO。
- 删除 Pino 实例、配置、解析、校验和专属错误分支。
- 确认正常输出、重复日志、DEBUG 禁用不访问 extra、调用后修改对象不影响输出。

### 第三步：补齐关闭并接入入口

- 补齐 DateRotatingStream 的 final/destroy、轮转引用与等待取消。
- 实现单次、有界、返回完成标志的 shutdown。
- 在 src/index.ts 接入，不修改交易 cleanup/termination。
- 保留 uncaught/rejection 的不同语义，隔离入口测试。

### 第四步：移除依赖、残留与失效描述

- 执行包管理器移除，检查直接和传递依赖。
- 清理当前源码、类型、注释、测试标题及有效文档中的旧接线。
- 不保留兼容开关、双实现路径、Pino 委托层或临时 benchmark 文件。

### 第五步：集中验证

- 代码落定后执行 §12 必需检查。
- 仅失败、出现新改动或仍有未解决疑点时扩大或重复检查。
- 任何失败未解决，不能宣布实施完成；更新本文记录实际结果和剩余边界。

## 12. 验证矩阵与验收门槛

### 12.1 日志行为检查

| 场景 | 必须验证的行为 |
| --- | --- |
| 四级与 DEBUG 开关 | 输出级别、stdout/stderr、system/debug 正确；禁用 DEBUG 时不触发 getter/toJSON，也不创建 debug 流。 |
| 文本等价 | 忽略时间差异后，普通消息、字符串 extra、诊断对象、Error 可枚举字段两端输出与基线一致；颜色/reset、空格、换行不变。 |
| 快照与安全格式化 | 调用后修改嵌套对象不影响两端；toJSON 正常路径只执行一次；循环不抛错、重复引用不误判。 |
| 原始值与特殊值 | 空字符串、false、0、-0、null、NaN、数组省略项、Date/toJSON 标量、BigInt 与失败提示遵守 §6。 |
| 顺序与慢端 | file 先于 console 投递；每端 FIFO；慢 debug 未回调前不推进下一条 system；重复消息不合并。 |
| 轮转与保留 | 香港午夜切换、既有文件追加、7 文件保留、debug 独立规则保持；不将日志时间误用作轮转日期。 |

### 12.2 关闭与失败检查

- 记录足够多条日志后立即显式 shutdown，退出后检查文件条数、顺序及最后一条，不只断言 end 被调用。
- 可控慢写证明 shutdown 不会在队列或底层文件尚未完成时返回 true。
- 重复 shutdown 共用结果，不重复 end、不重开文件；关闭后有效级别日志 fail-fast，不触碰已结束队列，进程钩子仍有独立报告路径。
- file 的关闭错误诊断先于标准流屏障；两端普通输出和入口直接 stderr 都被纳入等待。
- 延迟 drain、error、close 及超时均只结算一次；不能留下活跃 timer、重复 callback、未处理 rejection 或错误事件。
- 在轮转等待旧文件时触发总超时，释放迟到回调后也不创建新文件；旧流不能因引用置空而遗漏。
- 外部关闭失败仍尝试其他输出；false 不被当作成功排空。
- 标准流阻塞的故障场景验证总等待有界及入口最终退出；不靠外部测试 timeout 杀进程冒充实现成功。
- 真实时间测试使用合理容差，不用严格毫秒断言制造不稳定；内部延迟用受控回调，不大量 sleep。

### 12.3 入口与业务回归

入口在独立子进程内 mock runApp/logger，使用 `tests/setup/childEnv.ts` 的白名单临时根，在 `createChildEnv` 结果上显式添加 `BUN_OPTIONS=--no-env-file` 并保留 CLI `--no-env-file`，不加载或 mock dotenv，避免 Bun 模块 mock 污染其他测试。不能假设 mock.restore 或 query import 会恢复共享模块。

必须覆盖：成功+true 自然返回；成功+false 保留已有 exitCode；三类业务失败在关闭之后退出 1；null/undefined 原始错误；AppStartupAbortError 不追加通用错误；关闭 Promise 未落定时不能提前退出；关闭内部 reject 不被当成外部故障吞掉、不替换已报告的原业务错误。

保留现有 uncaught 后不可达、rejection 后继续输出的子进程测试。无需让强退路径等待文件完整落盘来“修过”测试。

回归范围：

- `tests/infrastructure/logger/logger.business.test.ts`
- `tests/infrastructure/logger/rotation.business.test.ts`
- `tests/infrastructure/logger/shutdown.business.test.ts`
- `tests/index.business.test.ts`
- `tests/infrastructure/diagnostics/index.test.ts`
- `tests/app/runApp.business.test.ts`
- `tests/app/runAppTerminationMatrix.business.test.ts`
- `tests/app/shutdown/createCleanup.business.test.ts`
- `tests/runtime/lifecycle/terminationRuntime.test.ts`
- `tests/architecture/importBoundary.test.ts`
- `tests/architecture/typeOrganization.test.ts`

业务回归只确认原退出顺序、首错与门禁不变，不修改测试来允许新的交易行为。

### 12.4 必需命令与静态检查

实际修改 TypeScript 后按项目规范先后执行 `bun lint:fix` → `bun type-check`。以下为离线命令模板，须在 `createChildEnv` 白名单及隔离临时目录环境下运行，并在白名单结果上显式添加 `BUN_OPTIONS=--no-env-file`；CLI `--no-env-file` 同时保留，不能假定顶层 flag 会传给嵌套 Bun。真实问题与复验结果见 §14.3。

```powershell
bun --no-env-file run lint:fix
bun --no-env-file run type-check
bun --no-env-file test tests/infrastructure/logger/logger.business.test.ts tests/infrastructure/logger/rotation.business.test.ts tests/infrastructure/logger/shutdown.business.test.ts tests/index.business.test.ts tests/infrastructure/diagnostics/index.test.ts tests/app/runApp.business.test.ts tests/app/runAppTerminationMatrix.business.test.ts tests/app/shutdown/createCleanup.business.test.ts tests/runtime/lifecycle/terminationRuntime.test.ts tests/architecture/importBoundary.test.ts tests/architecture/typeOrganization.test.ts
bun --no-env-file run build
git diff --check
```

测试使用离线环境及已有 SDK guard，临时输出根不得指向生产日志。构建只生成产物，不启动 app。

检查当前运行源码、依赖声明、锁文件和产物中没有 Pino import/API/专属配置残留；logger 两个 sink 中没有 JSON.parse。extra 的标量局部 parse 是明确允许的实现，不以“JSON.parse 全仓零命中”为目标。

若必需检查暴露共享模块 mock、类型边界或其他相关问题，先修复实际根因，再执行对应回归；不能通过删断言、放宽规则或重采冻结 baseline 取得绿灯。以上是验收要求而非已执行命令清单，实际结果以 §14 为准；是否扩大到全量，应由实际变更与未解决疑点决定。

性能复测不是业务正确性的替代。若需要量化，使用独立临时进程、相同输出条件，并等待关闭结束；不能只计 logger 方法返回，也不能把本模块耗时变化外推为整体交易系统收益。

## 13. 完成定义与当前交付边界

实施完成必须同时满足：

- Pino 及无消费者的传递依赖已移除，生产代码和产物不再依赖它。
- 四方法 Logger 和所有交易调用方保持不变；交易 JSONL、cleanup 阶段和 termination 无语义改动。
- 两个既有队列保留必要顺序与背压行为，原始 extra 不进入异步队列。
- §6 的必要行为与明确差异有可运行检查，不复刻 Pino 私有框架。
- 正常关闭贯通所有层，超时能中止自有工作且入口不会被残留标准流无限拖住。
- 原始错误、退出码、uncaught/rejection 语义不变。
- 必需检查通过，当前有效注释/文档与实现一致，无兼容路径、临时测试或冻结基线改写。

方案阶段仅完成源码与方案复核、隔离行为探针和方案文档，当时没有执行上述重构。该历史边界不改写为实施验收；当前实施与独立验收结果记录如下，已完成本方案范围内验收，但不把设计复核或定向回归等同于“所有新问题已被排除”。

## 14. 当前实施与集成记录

### 14.1 基线与修改边界

- 当前实施基线：`beta-V2` / `2a367c2fa7384427261d5039c80b5e741ca431ba`，Windows / Bun 1.4.4；不同于 §2 的 Windows / Bun 1.4.3 分析基线。
- 核心、入口与对应测试由先行实施代理交接；集成阶段仅负责 `package.json`、`bun.lock`、`eslint.config.js`、本文及性能审计的 PERF-03 和直接相关引用，不另改生产/测试逻辑。最终文档收口仅更新这两份文档的直接相关内容。
- 用户原先暂存的是新增方案，index blob 为 `fadcc4141c79c546eca6f9f4c210a64be820d98c`。集成及最终文档收口仅在工作区更新文档，不 reset、stage、commit 或覆盖该暂存版本。
- 不读取真实 `.env`、凭证或生产日志，不启动真实交易应用、构建产物或 SDK；跨边界探针仅运行真实 logger 与薄入口，并 mock runApp。

### 14.2 已落地实现与依赖

- 当前 `src/infrastructure/logger/index.ts` 由 `writeLog` 同步固定时间及 extra，生成 `PreparedLogRecord`，按 file → console 写入既有 objectMode 队列；sink 不再解析完整 JSON 记录，file 队列仍等待本条 system/debug 回调屏障。
- `formatExtra` 使用一轮原生 JSON 序列化处理对象、循环及 BigInt；仅 Date/toJSON 等标量结果允许局部 `JSON.parse`。§6.3 的明确显示差异继续适用，不宣称任意 unknown 值逐字节等价。
- `shutdownLogger(): Promise<boolean>` 复用单个 Promise，等待自有文件关闭和尾部 stdout/stderr 屏障；总超时取消自有工作，外部 IO 失败返回 false，内部错误 reject。入口 finally 等待关闭，继续消费 Bun 已准备的环境变量，不恢复 dotenv；交易 cleanup/termination 不属于集成修改范围。
- 入口 ESLint 的 infrastructure 限制改用只排除 `logger/index.js` 的精确正则，避免父目录 glob 使否定例外失效。其他入口限制及架构测试未放宽。
- 已执行 `bun --no-env-file remove --offline --ignore-scripts pino`，退出码 0。包管理器移除闭包 13 包：`pino`、`@pinojs/redact`、`atomic-sleep`、`on-exit-leak-free`、`pino-abstract-transport`、`split2`、`pino-std-serializers`、`process-warning`、`quick-format-unescaped`、`real-require`、`safe-stable-stringify`、`sonic-boom`、`thread-stream`；移除前未发现闭包外包消费者。
- 锁文件语义比较：167 → 154 个包，新增 0、保留的 154 个包条目（含版本、依赖和校验值）变更 0。Bun 同时将包数组改为紧凑排版，文本 diff 较大不代表升级；未手工照单删除锁条目。
- 静态检查与 clean build 后的产物检查均已完成：当前受检源码/测试及 clean dist 中 Pino 导入、旧 API/专属接线、LogObject/isLogObject、cleanupSync 残留为 0。extra 标量局部 parse 是允许项；冻结架构基线的历史符号及交易链路 `fs.closeSync` 不是残留，不删除或改写。

### 14.3 集成检查与环境复验

- 交接记录为 logger 局部 23 项通过及新增场景通过、入口 20 项通过；这些是先行实施结果，不与 §14.4 的最终验证重复计数，也不把 §2.3 的旧测试/探针当作新验收。
- 集成入口限制探针：在白名单环境和隔离临时 home/temp/logs 下以 `bun --no-env-file` 运行 ESLint API，不求值业务模块，13 pass / 0 fail。既定 runApp/logger 精确模块允许，logger 目录本身、相邻文件、其他 infrastructure 模块及带后缀的伪例外仍被拦截；未修改架构测试。
- 集成集中检查按顺序完成：`bun --no-env-file run lint:fix` 退出码 0（约 67.8 秒），随后 `bun --no-env-file run type-check` 退出码 0（约 3.4 秒；788 个文件无类型错误）。lint:fix 未改动任何文件，没有范围外机械修正。新环境复验再次按 lint:fix → type-check 顺序通过（788 个文件），clean build 亦通过。
- 环境问题与解决：首次合成探针确实发现顶层 `--no-env-file` 未传递给嵌套 Bun，并发生失败；独立代理以 6 组正/负对照复现并解决隔离问题。最终受保护环境是在 `createChildEnv` 白名单结果上显式添加 `BUN_OPTIONS=--no-env-file`，同时保留 CLI `--no-env-file`。这是验证启动环境问题，不是产品缺陷；没有为此修改生产脚本，原失败证据保留。
- 最终验证及新环境复验使用上述受保护环境、临时输出根和 SDK guard；只生成 clean build 产物，不运行交易应用。源码与 clean dist 的旧接线残留为 0；当前 node_modules 中上述 13 包均不存在。集成及复验的 `git diff --check` / `git diff --cached --check` 均退出码 0，index 未变。

### 14.4 最终定向回归与独立复核

最终验证代理本人执行的正式测试批次 A：

| 范围 | pass | fail | expect |
| --- | ---: | ---: | ---: |
| logger 目录 | 27 | 0 | 47 |
| `tests/index.business.test.ts` | 20 | 0 | 98 |
| diagnostics | 2 | 0 | 5 |
| importBoundary | 41 | 0 | 88 |
| typeOrganization | 15 | 0 | 83 |
| **批次 A 合计** | **105** | **0** | **321** |

- 独立边界 reviewer 另执行批次 B：terminationRuntime 4、createCleanup 16、runApp 24、runAppTerminationMatrix 9、createPostGateRuntime.tradeLogPersistence 11，共 **64 pass / 0 fail / 392 expect**。两批正式测试合计 **169 pass / 0 fail**；子进程 `node:assert`、合成探针及下述跨边界探针不虚算为 Bun expect 或追加到该测试总数。
- 独立核心 reviewer 的 4 项真实文件/TypeError/EPIPE 探针通过，未发现阻断项。独立边界 reviewer 精确检查 44 个基础设施路径，新增仅 `logger/index.js` 可从入口导入，规则未放宽。
- 309 处 logger 调用、涉及 66 个文件全部零改动；`logger.warn` 回调已独立核对。四个同步 `void` 接口不变，runApp/cleanup/termination 及交易 JSONL 边界不变。

### 14.5 真实 logger 与薄入口跨边界探针

以下 4 项使用真实 logger 与薄入口，mock runApp，不启用真实交易；均由最终验证代理执行并通过，不计入 §14.4 正式测试数：

| 场景 | 实际结果 |
| --- | --- |
| 成功路径连续 100 条日志 | 文件日志完整，进程自然退出 0。 |
| 原始 fatal 为 `undefined` | 原始失败保留，日志完整，退出 1。 |
| 标准流持续挂起 | 命中真实 5000ms 共享总超时，有界退出并保留既有 exitCode 23，不靠外部 watchdog 杀进程冒充通过。 |
| beforeExit 关闭内部 TypeError | 内部错误单独报告，退出 1。 |

### 14.6 验收结论与交付限制

- 本方案范围内实施、独立复核、定向业务/架构回归、clean build 及残留检查已完成，无阻断项；不是全仓全量测试通过的声明。
- 没有量化性能加速或新的性能复测数字。只有需要量化收益时才按 §12.4 做同条件离线测量，不要求无条件复测；文档收口未改代码，不重跑已完成的 169 项测试或 lint/build。
- 未运行实盘或 SDK，未验证其他操作系统、掉电、强退或 fsync 耐久性。shutdown 成功只表示本次关闭协议完成，不保证历史每条日志成功或物理持久化。
- 文档收口后的定向 diff 检查及全工作区 `git diff --check` / `git diff --cached --check` 均通过；§14.1 原暂存 blob 及 index entries SHA256 `4efcab8106c65490bc62bea925f57f07027fe12ef9fb5c649e0816c287d5f874` 保持不变，没有 reset、stage 或 commit。
