---
name: code-review
description: This skill should be applied when conducting structured, read-only code reviews of files or modules; it is particularly useful when a user requests a review of a PR or diff, or when multiple review perspectives need to be coordinated through a single point of human oversight.
---

# Code Review

## Overview

这是一个手动调用的代码审查主入口。它不承载所有专项审查细则，而是从 `reference/` 中读取 reviewer profile 与统一输出协议，然后组织只读子代理完成多视角审查并汇总结果。

核心原则：**主入口负责编排，reviewer 负责分析，所有参与者都保持只读。**

## When to Use

- 你想手动发起一次结构化代码审查
- 目标是单文件、模块、diff、commit 或 PR
- 你希望统一组织实现质量、项目规范、类型设计、注释、死代码、测试覆盖等多个维度
- 你需要一个统一的最终报告，而不是多份互相重叠的 reviewer 输出

不适用：

- 直接修改、重构、删除代码
- 直接执行 dead code cleanup
- 只想做一次极轻量的口头点评且不需要编排
- 单纯实现功能而非审查

## Hard Limits

- 默认只分析，不修改任何代码、注释、配置或测试
- 所有 reviewer profile 都是只读角色，不具有执行权限
- `dead-code-reviewer` 只提供候选、证据、风险与建议，不执行删除
- 没有足够上下文时，相关 reviewer 必须返回 `not assessed`，不得强行给出确定性结论
- 主 skill 负责去重、合并与统一严重级别，不能直接拼接子报告了事
- 每次审查默认启用全部七个 reviewer；专项关注点只用于补充审查上下文，不用于增减 reviewer

## Inputs to Gather First

在启动审查前，先明确：

- 审查对象：file / module / diff / commit / PR
- 审查范围：具体路径、模块边界、提交范围
- 上下文：是否有 plan、spec、PR 描述、测试上下文
- 关注点：comments / types / dead code / tests / simplification / project rules
- 输出边界：默认只读、仅提供反馈

## Reviewer Context

在派发前，为全部 reviewer 预加载可取得的相关上下文：

- `project-spec-reviewer`：项目规范；目标为 TypeScript 时还包括 `typescript-project-specifications`；计划一致性审查还需要 plan/spec。
- `implementation-reviewer`：目标代码与基本任务上下文。
- `code-simplification-reviewer`：可见实现代码，以及近期改动或明确目标范围（如有）。
- `comment-reviewer`：注释表面与文档性代码。
- `type-design-reviewer`：类型定义、接口边界与类型密集表面。
- `dead-code-reviewer`：可搜索的使用链路、导出关系与调用证据。
- `test-coverage-reviewer`：diff、测试文件与测试上下文。

缺少上述特定上下文时，reviewer 仅对无法可靠判断的部分返回 `not assessed`，而不是强行补判断。

## Execution Flow

1. 明确审查对象、范围与上下文
2. 读取 `reference/report-format.md`
3. 为全部 reviewer 预加载可取得的相关上下文
4. 读取全部 reviewer profile 文件
5. 为每个 reviewer 派发一个只读子代理
6. 要求每个子代理严格遵循统一输出协议
7. 收集子代理结果，合并重复问题，统一严重级别，并为每个合并问题保留 `sources`
8. 生成最终汇总报告，并明确 `not assessed` 与后续建议

## Output Contract

所有子代理与主 skill 最终输出都必须遵循统一结构。详细模板见 `reference/report-format.md`。

最终汇总报告固定包含：

- `summary`
- `critical issues`
- `major issues`
- `minor issues`
- `positive findings`
- `not assessed`
- `recommended next actions`

## Common Mistakes

- 因为范围小或上下文不足而跳过 reviewer
- 没有 plan 还强行做计划一致性判断，而不是返回 `not assessed`
- 把 `dead-code-reviewer` 当成删除执行器
- 把 `code-simplification-reviewer` 当成改代码执行器
- 直接拼接多个 reviewer 输出而不去重
- 在上下文不足时用“应该”“大概”“看起来”替代 `not assessed`
