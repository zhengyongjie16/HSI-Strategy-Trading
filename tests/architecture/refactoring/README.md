# P1 分阶段静态保护网

`baseline.stage` 为 **P1**。P1 cutoff 当期失效；扫描失败表示源/测试仍有债，不是阶段出口证明。`baseline.json`、`unresolved.json` 和 P0 原始审计数据不由当前工作树重新采样，不能扩大 allowance 或延长 cutoff。

## 保留的检查

- `scanner.ts` / `freeze.test.ts` 使用 TypeScript 模块解析与 checker 检查真实目标、SDK 声明来源、alias、import/type-only/type import/dynamic/require/re-export。SDK import、use、origin、legacy、snapshot 各自按 occurrence **多重集合**冻结，重复调用不能共用一条额度。
- §5.1 层矩阵独立生效；domain 直接文件/网络/调度模块、真实 ambient fetch/timer 和 logger IO 另作窄能力检查，本地同名纯函数及纯 Logger 类型不因此被禁止。跨旧业务 owner 的值依赖仍消费原阶段额度；函数签名中性不等于获得新 owner 资格。同 owner 的数据函数、SDK-free type query，以及合法 domain/utils/constants 数据能力通过有限类型/实际出口检查，不因函数重命名要求整体 owner 提前迁移；返回业务能力对象的 factory 不据此豁免。非 infra 的真实 SDK-free types/facts 可作为中性类型，不能因此反向依赖旧业务 owner。已有中性 observation 分类保留审计依据，不新增动态白名单。
- 新 infra mapper/port 的 legacy 目标资格只检查实际解析声明、公共返回类型、实际返回结构、嵌套字段和回调。展开直接返回对象、局部 initializer、返回函数和出口调用，拒绝明显的 SDK/any 擦除及返回额外 raw 字段。`unknown` 可用于 JSON/错误输入，但不作为中性返回出口；不能用 unknown callback 参数掩盖实际传入的 SDK 值。mapper 可接受 adapter 内的 SDK DTO，但不得把 SDK callback 能力带出；不以函数名、文件名或 body hash 批准能力。
- `executionProbe.ts` 保留旧 helper **boolean 构造探针**：实际调用、未被实参替换的 default、静态 factory method、显式 callback 和数组 map。未调用 method/闭包不计构造；production owner 内部执行不在 test fixture 维度递归。递归与参数上下文缓存只保证构造判断不串用，不缓存业务资格。
- HEAD-only helper 冻结仍为 **855 occurrences**，不重采、不改截止。测试可以经 SDK-free port 驱动合法 infra fixture 内部 SDK；原构造 occurrence 仍记录，只在实际跨入 infra fixture 的 seam 公开/实际出口中性且构造位置合法时单独扣除；外围测试装配/观察接口不被当成 SDK seam。caller 目录本身不授予或取消资格；中性 module/owner port 测试与 integration 遵循同一边界检查。纯造值 fixture 是否有必要由行为覆盖及审查判定，不用目录模拟业务场景。`withNativeContext` / `Config` callback 之类公开 SDK 能力不合格，必须先改造真实 fixture。
- 全仓实际 `TradeContext.new` 创建点必须恰好一个且位于 production trade adapter；不把已迁移的旧 core 路径当不可变业务基线。
- `snapshotProbe.ts` 保留唯一 canonical owner、readonly reader/嵌套事实、能力外泄、第二 writer、cast/Object.assign 等保护；原 snapshot/mirror occurrence 在 P1 到期。
- `numericProbe.ts` / `numericBoundary.test.ts` 保留字段 identity、金融 number/有损投影保护和合法整数/指标边界。投影额度按文件、原函数、表达式逐 occurrence 计数，仅原金融投影可获额度；P1 已闭合字段/投影立即到期，后续金融额度按所属阶段收缩，最迟 P4.5 归零。`Quote.prevClose` 的真实角色由附加登记补齐，不重写 P0 审计。`strategyDynamicBoundary.test.ts` 保留真实策略入口路径约束。

## 明确不做的事

已删除 `semanticNeutral/bodyProof` 全函数解释器、`privateProducerOwnership`、`SdkExecutionEvidence`、全局内建稳定性、时间/同单行来源、循环/累加器、runner/error registry/枚举算法语义证明及专用缓存（包括外部声明 AST/hash 缓存）。同步删除仅为这些证明器语法/缓存服务的 34 组 / 328 个静态 fixture cases；不删除业务测试。当时原 helper boolean 46、numeric 30、strategy 8 个 cases 全保留；这些是历史保留数量，不是当前测试总数，后续字段闭合与有限能力检查正反例另计。

门禁不证明任意跨函数 taint、金融计算正确性、safe-int 全链路、真实时间来源、同单 row 身份、场景真实性或完整恢复。真实金融数值、时间、同单行和 adapter 行为由现有 adapter 行为测试与代码审查负责；独立金融/snapshot 门禁继续生效。有限返回结构检查不是执行解释器，不为每种控制流追加证明规则。

失败输出按维度列计数与少量 occurrence 示例；完整结果可由 scanner 返回值离线汇总，避免打印整段 fixture/数百 KB 日志。

## 离线验证

以显式干净进程环境执行，禁止读取 `.env`、凭证、真实交易日志或求值静态 fixture 中的 SDK；不启动 app、不联网。

```text
bun --no-env-file node_modules/prettier/bin/prettier.cjs --write tests/architecture/refactoring/{scanner,executionProbe,freeze.test,helperExecution.test,types}.ts tests/architecture/refactoring/README.md
bun --no-env-file node_modules/eslint/bin/eslint.js tests/architecture/refactoring/{scanner,executionProbe,freeze.test,helperExecution.test,types}.ts
bun --no-env-file node_modules/typescript/bin/tsc -p tsconfig.json --pretty false
bun --no-env-file test tests/architecture/refactoring
```

只 scoped format/lint，不运行全仓 format。before、删除测试统计与最终运行结果保存在仓外 `D:/Temp/hsi-p1-reassessment-20261010/gate/`。源债如实留红，不通过放宽冻结获得绿灯。
