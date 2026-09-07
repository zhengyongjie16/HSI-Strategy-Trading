---
name: code-review
description: Conduct structured, read-only, evidence-based code reviews of files, modules, diffs, commits, and PRs. Use when asked to review, audit, inspect, or assess code correctness, project/spec compliance, architecture, type design, comments, dead code, simplification, or test coverage. Produce prioritized findings with file/line evidence, runtime impact, minimal fixes, validation, and explicit not-assessed gaps. Do not use for implementing changes or performing cleanup.
---

# Code Review

## Core Contract

执行一次统一的第一性原理审查：直接检查全部适用维度，按根因输出一份报告。

- **只读**：不得修改代码、注释、配置或测试；dead code 仅列候选，不执行删除。
- **证据优先**：没有具体证据不得列为已确认缺陷；上下文不足写入 `not assessed`。
- **发现优先**：先报告会影响行为、安全、可靠性或维护成本的问题；不为凑数量输出风格偏好。
- **范围克制**：审查用户指定范围及证明结论所需的直接调用链，不扩展成无关的整仓审计。

## Workflow

1. **确定范围**
   - 明确 target（file/module/diff/commit/PR）、基线、任务意图、plan/spec、关注点与测试上下文。
   - 可从仓库可靠推断时直接推进；只有歧义会实质改变结论时才询问。

2. **加载约束**
   - 读取目标范围适用的仓库指令、架构约定和 plan/spec。
   - TypeScript 审查必须加载 `typescript-project-specifications`；涉及交易业务语义时加载 `core-program-business-logic`。
   - 没有 plan/spec 时，不做方案一致性的确定性结论。

3. **追踪真实路径**
   - 阅读目标与 diff，并搜索所有相关调用方、导出消费者、配置连接和测试。
   - 从入口追到受影响行为；Bug 或共享函数必须确认各调用路径，dead code 必须追到真实消费边界。
   - 仅在本次变更直接影响引用时检查 `docs/` 或 `tools/`。

4. **完成七维审查**
   - 逐项应用下方 Review Lenses。维度不适用、范围不可见或证据不足时记录原因，不猜测。

5. **验证与归并**
   - 每项发现核对位置、运行时路径、风险、最小修复和验证方式。
   - 同一根因只保留一项，采用能够反映真实影响的最高严重级别，并列出涉及维度。

6. **输出报告**
   - 严格使用下方 Output Contract；先列 findings，再列正向项和未评估项。

## Review Lenses

### 1. Implementation

检查逻辑正确性、状态与错误路径、边界条件、职责和架构契合度。识别流程分散、重复职责、脆弱分支、无依据 fallback、过度设计及真实维护风险；不要把单纯“可写得更短”当作正确性问题。

### 2. Project and Spec

检查仓库规则、适用 skill、模块边界、命名和 plan/spec 一致性。每个违规结论必须引用具体约束；缺少 plan/spec 时仅评估可见项目规则，并将方案一致性列入 `not assessed`。

### 3. Type Design

检查类型是否表达业务不变量、非法状态是否仍可表示、边界是否过宽、封装或可变性是否泄漏，以及编译期约束是否能合理替代约定。不要机械地把全部运行时校验迁移到类型层，也不要用复杂类型换取很小收益。

### 4. Tests

检查关键行为、错误路径、边界和负向场景的回归保护；判断测试是否验证行为而非实现细节。每个缺测建议都要说明能防止的真实回归及现有测试为何不足；不为 trivial 代码或覆盖率数字机械补测。

### 5. Comments

检查注释和文档性代码是否准确、仍与实现一致、解释重要的 why，并能长期维护。指出误导、过时或重复显然代码的注释，以及确实缺失的关键背景；不要追求注释数量。

### 6. Dead Code

检查未消费导出、仅转发导出、未被上游使用的工厂返回属性、纯透传包装器，以及无用类型、常量和变量。必须搜索静态与可见动态消费边界（注册表、字符串协议、反射、外部 API 等），并标记证据：

- **A**：消费链已完整排除，候选可信。
- **B**：大概率无用，但仍有明确不确定性。
- **C**：动态或外部边界使其无法可靠判断；放入 `not assessed`，不得建议直接删除。

测试引用不自动等于生产消费，也不自动代表无价值。

### 7. Simplification

仅建议不改变行为且有真实收益的简化：删除冗余抽象、重复结构、过深嵌套或无价值间接层。区分维护收益与审美偏好；不以行数更少代替清晰度，不提出会改变接口、边界或语义的“简化”。

## Evidence Rules

每条 finding 必须包含：

- **claim**：可验证的缺陷或风险主张。
- **evidence**：精确到 `path:line` 或函数/类型，并引用必要代码或项目规则。
- **runtime path**：该代码如何被触发、状态如何流动；纯静态问题说明契约传播路径。
- **impact**：实际错误或潜在风险，并标记 `confirmed` 或 `potential`；不得把潜在风险写成已发生事实。
- **minimal fix**：修复共享根因的最小方案，不给无关重构。
- **validation**：能够直接验证关键行为的测试或检查。
- **dimensions**：涉及的 Review Lenses。

证据不足、目标表面不可见或需要未提供的外部事实时，写入 `not assessed`。禁止用“应该没问题”“看起来可能”“大概已覆盖”代替。

## Severity

- **critical**：明确逻辑错误、高风险安全/交易缺陷、核心不变量或架构边界被破坏，可能造成严重错误行为或让严重回归漏过。
- **major**：重要但非立即致命；关键边界、类型、测试、注释或结构问题显著损害可靠性和维护性。
- **minor**：真实但非阻塞的轻度冗余、噪音或一致性问题。纯偏好不报告。

严重级别依据影响和可达性，不依据改动大小。位置相同但风险不同的问题不得强行合并。

## Output Contract

```markdown
## summary

- verdict: <一句话结论>
- scope: <实际检查范围>
- confidence: high | medium | low

## critical issues

- [<path:line> | <symbol>] <title>
  - claim: ...
  - evidence: ...
  - runtime path: ...
  - impact: confirmed | potential — ...
  - minimal fix: ...
  - validation: ...
  - dimensions: implementation, types, ...

## major issues

<同上；没有则写 None.>

## minor issues

<同上；没有则写 None.>

## positive findings

- <仅记录有证据且值得保留的做法；没有则写 None.>

## not assessed

- <dimension or area>: <缺少的上下文或无法可靠判断的原因；没有则写 None.>

## recommended next actions

1. <按风险和依赖排序，不重复粘贴 finding>
```

没有确认问题时，明确写“未发现已确认缺陷”，同时保留范围、置信度和未评估项；不得用无证据的 “LGTM” 替代报告。

## Final Self-Check

输出前确认：

- 未修改任何文件，未执行 cleanup。
- 已检查目标的调用方和运行时/契约路径，而非只看局部片段。
- 七个维度均已评估或明确列为 `not assessed`。
- 每项问题都有证据、影响判定、最小修复和验证方式。
- 已按根因去重，严重级别与真实风险一致。
- 未把风格偏好、低价值测试或不确定 dead code 包装成缺陷。
- 未按维度启动多个并行子代理。
