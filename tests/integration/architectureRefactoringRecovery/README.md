# P0 离线恢复基准

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

恢复链路使用 monitor 自身的真实 runtime 与 settlement store，没有另建独立 settlement store。分段增长用例直接向 recovered DailyLossTracker 输入中性累计事实；时间/revision 用例连接真实 recorder、Daily 与 repository，验证同单覆盖和历史文本不变。这些用例**不证明 monitor 正成交事件自然传递到 post-trade completion**；post-trade 虽装配为 refresh sink，本目录不启动其运行期 completion 消费，不把人工 refresh nudge 当生产 wiring 证明。

覆盖完整 loader/rebuild 双次恢复、冻结历史 completion、crash-gap 一次完成、BUY/SELL baseline、分段损益、分钟冷却水合、同 revision OPEN→TERMINAL、早期不同 ID 的 API 冲突、baseline 冲突、精确事实缺失、completion IO 失败不提交，以及零成交 protective OPEN 阻断完成/不自行创建 episode。

不声称真实历史对账、候选/指定回退版本恢复、SDK 高有效位 mapper、所有跨订单择新排序、半日/跨日冷却全模式或静态清仓目的隔离。

## 订单边界与覆盖范围

P1 已接入真实中性 order observation/port 边界。本目录通过 `architectureRefactoringP1Native/trade/brokerIngressFixture.ts` 取得离线 broker read/mutation 入口，再装配真实 recorder 与 monitor；SDK fixture 留在对应 adapter 测试边界，不在恢复测试伪造 SDK-shaped 对象。本目录仍侧重 loader/rebuild 和冻结 durable 恢复，不因此宣称覆盖所有自然 push→settlement→completion 交错。

## 时间归属目标断言

原 fixture 保持 executionTime=T、API updatedAt/revision=T+30 秒。当前测试断言恢复事实采用 durable 可信 T，revision 独立保留 T+30；相同 query 事实不重复经济投影、progress 或 submit。已完成 boundary 的同量修订继续按原规则 SUPPRESSED，历史 payload/ID/revision、baseline 与原始 fixture 字节保持不变，不用 updatedAt 补造成交时间。

## 未来 Decimal 差分

保留原 fixtures 文本，候选及指定回退版本分别运行恢复入口，对照人工 oracle、baseline 和冲突/原文本保护断言。新生成金额文本不要求与旧 number 投影字节相同；应新增独立精确 oracle 登记误差修正，不覆写旧期望、不添加容差/尾零、不改 ID/revision。本整数账本是“原有效行为保持”，冲突/缺证据是“恢复阻断”，时间/revision 分离是事实契约回归，并非精度误差修正证明。真实历史发布门禁仍独立存在。
