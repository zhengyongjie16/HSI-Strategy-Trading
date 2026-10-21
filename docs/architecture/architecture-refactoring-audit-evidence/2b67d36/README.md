# 架构审计证据索引

## 最终结论入口

阅读 [全链路审计总报告](../../architecture-refactoring-full-chain-audit.md)。

- 受审版本：`2b67d36479ed2f3b5f46df9e5bc9fa18f88ab144`（beta-V2）。
- 对照基线：`6e239c8a128372bd9b2fb2d79464346792a5e81e`（审计时最新远端 develop）。
- 最终确认：8项实现／失败协议问题（1 critical、7 major）；B01已由用户明确授权，非问题、不设严重性等级、不构成验收阻塞；4类其他范围差异单列。
- 所有最终问题均经过独立二次复核；首审报告中的“候选／待复核”是原交接状态，不应覆盖总报告和后续二审的最终裁决。
- 本目录只新增审计证据，不修复或修改生产代码、测试、配置与原架构方案。

## 确认问题与独立证据

| 最终编号 | 主题 | 首审／发现 | 独立二审 |
|---|---|---|---|
| F01、F03 | 同毫秒在线BUY遗漏；closed-order重复／弱观察fatal | [订单审计](audit-order-execution.md) | [订单事实二审](audit-recheck-order-facts.md) |
| F02 | 历史来源覆盖、completion自恢复失败 | [风险审计](audit-risk-account.md) | [保护边界二审](audit-recheck-risk-boundary.md) |
| F04 | cancel／replace错误范围扩大 | [订单审计](audit-order-execution.md) | [mutation错误二审](audit-recheck-mutation-errors.md) |
| F05 | 择优／消费范围前过度校验 | [基础设施审计](audit-infra-config.md)、[席位审计](audit-seat-selection.md) | [入口二审](audit-recheck-ingress.md) |
| F06、F07 | 换标预算缩减；无本次ACK仍fatal | [席位审计](audit-seat-selection.md) | [换标二审](audit-recheck-switch.md) |
| F08 | lifecycle恢复遗漏周期唤醒 | [生命周期审计](audit-lifecycle.md) | [生命周期二审](audit-recheck-lifecycle.md) |
| D01、D02 | 封存准入、过期冷却（范围登记，非已确认新算法缺陷） | [验证审计](audit-validation.md) | [订单审计](audit-order-execution.md)、[风险审计](audit-risk-account.md) |
| D03、D04 | UNKNOWN和金融精度范围 | [范围登记](audit-spec-drift-register.md) | [验证补充](validation-coverage-supplement.md)及领域报告 |

## 已授权业务变更（非问题）

**B01／V-C4／OE-003：末日保留旧SELL、不撤不改不合并，仅按最新available新增清仓单。** 用户已明确确认该业务改动获得授权，因此撤销原major、待授权和验收阻塞分类，不要求恢复旧策略。旧新行为差分及验证保留在订单、风险和范围登记报告中；其他8项问题的结论不变。

## 全仓覆盖和合理改进

- [基线和迁移地图](audit-baseline-map.md)：368个current／263个develop文件定位；历史根因校正。
- [最终覆盖账本](audit-coverage-ledger.md)、[机器可读账本](coverage.json)：245个运行模块均有明确D阅读证据，122个纯类型及1个JSON另列；保留原始等级和补充前历史。D不等于穷尽等价证明。
- [平台9模块补审](audit-coverage-supplement-platform.md)、[订单13模块补审](audit-coverage-supplement-orders.md)。
- [总装配审计](audit-global-wiring.md)、[行情策略审计](audit-market-strategy.md)、[G0/G2交叉二审](audit-cross-g0-g2.md)：可保留的安全和所有权改进、模型本地配置核实及边界。
- [验证二审请求原稿](validation-peer-review-request.md)：原始候选交接；被后续证实／收窄／排除的内容以最终二审为准。

## 验证和证据保留边界

两版有效typecheck、只读lint、全量测试均通过：current3288／develop1992。完整命令、有效／无效首跑、断言数量、SDK离线guard、依赖复用、源快照哈希与限制见[验证报告](audit-validation.md)。不能将两套不同oracle各自通过当作新旧等价证明。

本目录归档22份证据Markdown及覆盖JSON；不少独立报告附完整探针源码。初次归档仅规范化了 `audit-risk-account.md` 的末尾多余空行；本次随后依据用户对B01的直接授权更新了相关报告分类和建议，故这些文档不再宣称与TEMP原稿逐字节一致。覆盖JSON、其中的原报告哈希和引用行号仍记录原始审计证据，不表示授权更新后的文档哈希或行号；源码覆盖、探针结果和其他问题判定未改变。单独的探针文件、离线SDK guard、Git导出副本、原始日志和实际隔离JSONL仍在本机：

`C:/Users/65459/AppData/Local/Temp/hsi-architecture-audit-20261020/`

TEMP工件尚不是永久回归测试套件；其绝对路径、已安装依赖及固定Git对象是复跑前提。需要跨机或长期复跑时，应另行保存、迁移这些工件及环境。复跑可能覆盖TEMP结果或写测试日志，必须先保留证据并显式隔离日志根。“只读”只承诺不改受审代码、测试、配置与方案，不承诺文件系统零写入。原始报告保留其本机路径和当时执行限制，未为归档重写历史证据。
