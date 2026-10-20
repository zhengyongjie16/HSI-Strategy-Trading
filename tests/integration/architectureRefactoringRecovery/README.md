# P0 基准与 P2 离线恢复验收

运行：`bun test tests/integration/architectureRefactoringRecovery`。

只使用手工脱敏数据。临时目录为 `os.tmpdir()/hsi-p0-offline-recovery-*`，仅删除用例自己创建的目录；不读取真实交易日志、`.env`，不启动 app、不连接券商。

## 原文本与独立 oracle

- `fixtures/progress.jsonl`：两个不同 ID 的同 revision、同累计数量 OPEN/TERMINAL progress；44→45 是明确提供的权威终态金额修正，不是精度补偿。executionTime=T、revision=T+30 秒。
- `fixtures/completion.jsonl`：人工冻结的旧 V1 completion，含 BUY 5/50、SELL 5/45 baseline。历史恢复不依赖候选生成的 completion 作为唯一依据。
- `fixtures/recovery.json`：模拟全量权威订单和固定时钟。金融字段为原文本；状态/方向编码是现有 RawOrder 内部契约，不测试 SDK mapper。
- `fixtures/earlierConflict.jsonl`：更早、不同 ID、schema 合法的 progress，累计数量 6/金额 54 与当前 API 5/45 冲突。较新 progress 单独完整恢复成功；加入较早记录后 repository 成功读取三条，真实 loader 必须失败，不允许 latest-only 吞掉旧冲突，全部原字节保持。
- 人工账：买入 5×10=50、卖出 5×9=45，亏损 -5；completion 后分段归零。累计 BUY 更新到 10×11=110、SELL 更新到 10×8.5=85；扣 baseline 后新段买 60、卖 40，亏损 -20。期望为固定手算值，不调用被测 numeric/tracker 生成。
- 5 分钟冷却起点 02:30:00Z，恢复时间 02:31:00Z，剩余 240000ms。

复制原 JSONL 到隔离目录。读取/loader 冲突失败断言字节不变，crash-gap 只允许追加且旧前缀完全不变，完整重启不再追加。禁止 format JSONL。schema、去重、legacy 的纯 repository 重复用例已移除，沿用既有 repository 单测；本目录保留真实 loader 恢复冲突与原字节保护。

## 真实覆盖与明确限制

完整恢复路径真实运行 repository、loader、seat preparation/registry/dispatcher、DailyLossTracker、episode、cooldown/hydrator、rebuild、order recorder/filtering、risk cache 与 orderMonitor/recovery。broker、账户/持仓读取、行情/日历、clock、显示和 append IO failure 是离线边界。MonitorContext 的未参与策略成员只是结构装配，不使用替身 tracker/episode/settlement。

恢复链路使用 monitor 自身的真实 runtime 与 settlement store，没有另建独立 settlement store。loader 按原顺序逐条恢复全部 progress、已有 completion 及全部 in-progress episode 后，同步调用唯一 `PostTradeSettlementWorkflow.completeProtectionRecovery`；loader 不自行判 flat/prepare/append/commit。owner 读取 canonical paired snapshot 与未终结 protective 方向，完成同步 completion 事务；恢复模式不调用在线 `recordLiquidationTrigger`，随后日志 hydrate 只回放一次冷却。分段增长用例直接向 recovered DailyLossTracker 输入中性累计事实；时间/revision 用例连接真实 recorder、Daily 与 repository，验证同单覆盖和历史文本不变。恢复主链不依赖运行期 completion 消费；triggerLimit=2 用例在真实重启后以中性事实提供下一事件，由同一 live settlement owner 提交完成。不把此计数回归、恢复调用或人工 refresh nudge 当作自然 push→settlement wiring 证明。

覆盖完整 loader/rebuild 双次恢复、冻结历史 completion、同 owner crash-gap 一次完成、BUY/SELL baseline、分段损益、分钟冷却水合、同 revision OPEN→TERMINAL、早期不同 ID 的 API 冲突、baseline 冲突、精确事实缺失、completion IO 失败不提交，以及零成交 protective OPEN 阻断完成/不自行创建 episode。新增 LONG/SHORT 全部 episode 恢复后一次 owner 调用、hydrate 单次且在线冷却触发为零；generation/day-cut/termination 失效时 owner 返回 false，loader 按原 receipt 返回 SUPERSEDED/ABORTED，不 hydrate、不取 quotes、不推进 ready。

真实重启后再次断言分钟冷却剩余 `240000ms`。triggerLimit=2 用例验证首轮和重启均恢复部分计数 `[1]`、无冷却及零在线触发；下一真实 settlement completion 恰好触发一次冷却，重复 baseline 不再触发或追加，剩余时间从 `300000ms` 递减到 `240000ms`，证明未双计。

不声称真实历史对账、候选/指定回退版本恢复、SDK 高有效位 mapper、所有跨订单择新排序、半日/跨日冷却全模式或静态清仓目的隔离。

## 订单边界与覆盖范围

P1 已接入真实中性 order observation/port 边界。本目录通过 `architectureRefactoringP1Native/trade/brokerIngressFixture.ts` 取得离线 broker read/mutation 入口，再装配真实 recorder 与 monitor；SDK fixture 留在对应 adapter 测试边界，不在恢复测试伪造 SDK-shaped 对象。本目录仍侧重 loader/rebuild 和冻结 durable 恢复，不因此宣称覆盖所有自然 push→settlement→completion 交错。

## 时间归属目标断言

原 fixture 的 API query 事实只携带订单 updatedAt/revision=T+30 秒代理时间，真实 T 由 durable progress（T）恢复。Loader 在 daily 全量重算前用 known 累计状态归一 API：同量保留 durable T，增量使用本次原始 updatedAt 代理，无 known 才用订单 updatedAt；相同 query 事实不重复经济投影、progress 或 submit。

已完成 boundary 之后，旧 boundary 的 `projection` 不重复（不重复完成/冷却/资源/结算），但 **recorder 权威修订、revision 与 durable 保存继续发生**：同日权威 facts 仍会 merge、进入候选、写 durable callback 并 publish，供后续单调检查与新 boundary 使用；**old baseline 本身不改，新 boundary 取修订后的 facts**。`uninitialized` / 跨日 / `invalid` 的抑制保持原样；保护 SELL 的 durable 义务（写前持久化、完成边界）不变。历史 payload/ID/revision、baseline 与原始 fixture 字节保持不变。

边界修订 oracle（真实链）：封存后 `10/90 -> 10/120 -> rev-only` 保存修订且 T 不变，后 `20/110` 拒绝；双边界 B1（A90 冻结）保留 same-qty 80 修订、B2（A80 冻结）之后 `20/170` 与 BUY 成本 100 的 loss 为 `-10`，无 B2 的原 B1 案例仍为 `-20`；ONLINE、真实 SeatActivation 与 RESTART（包括 B2 再次恢复）三者一致。真正 completion 后 durable 写失败时 recorder / Daily / progress / token / refresh / episode / completion 均不变，retry 一次写、重复不额外。

## P2 金融精度定向验证

原 fixture 四份字节和 SHA-256 保持冻结；低位变体仅从原 OPEN 行复制到用例专属临时目录，不变 schema/ID/revision。成对反例为同 revision/quantity 的旧 OPEN 金额 `44.9999999999999999` 或 `45.0000000000000001` 与 API TERMINAL `45`，无独立 durable TERMINAL 证据时双向 fail-fast，不推进 completion/cooldown/ready，不改原文本。偏低反例修复前会被共享在线 OPEN→TERMINAL 裁决及单向 restore 检查吞掉；根因在 loader 恢复边界修正，没有修改共享在线裁决。

正例为原 durable TERMINAL 对同 revision/quantity/金额的独立确认、金额完全一致及更高 revision 权威修订；正常在线合法修订沿既有测试保留。新增反例为真实 repository 可读取的 TERMINAL 与当前 OPEN/API 的 orderId、amount、symbol、direction、quantity、revision 或 execution time 不匹配，均不能成为独立证据，阻断前不调用 completion owner/hydrate、不取 quotes且原文本保持。BUY baseline 与 API 的 `49.9999999999999999` / `50.0000000000000001` 双向冲突仍按原精确 baseline 规则拒绝。

高有效位用例通过中性金融事实装配，真实 loader/rebuild/repository/tracker/settlement 冻结 BUY `50.0000000000000002`、SELL `45.0000000000000001` baseline，重启不再追加；后续分段固定手工账为 BUY `60.0000000000000001`、SELL `40.0000000000000003`，精确亏损 `-19.9999999999999998`。该用例验证恢复消费链，不冒充 SDK 高有效位 mapper 证明。

整数账本属于“原有效行为保持”，冲突/缺证据属于“历史恢复阻断”，时间/revision 分离属于事实契约回归。新生成金额文本不要求与旧 number 投影字节相同；不覆写旧期望、不添加容差/尾零、不改 ID/revision。候选及指定回退版本的真实完整历史恢复仍是未来发布门禁，离线 fixtures 不能替代。
