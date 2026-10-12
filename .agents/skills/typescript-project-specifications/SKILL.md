---
name: typescript-project-specifications
description: Use when writing, refactoring, or reviewing TypeScript modules in this repository.
---

# TypeScript 项目规范

## 适用范围与交付

- 编写、重构或审查本仓库 TypeScript 模块时使用本规范；所有规则与必要示例均在本文件中。
- 只读审查：按适用规则判断符合性，不把仅实际改码时要求执行的流程项判为违规。
- 实际改码：落实代码组织与注释要求；交付前必须依次运行 `bun format` → `bun lint` → `bun type-check`，修复全部问题。

## 类型与不可变数据

- 文件名使用 camelCase，`config/` 下文件除外。
- 数据结构用 `type`，属性默认 `readonly`（包括嵌套数据），数组用 `ReadonlyArray<T>`；确需可变状态时才放宽，并明确可变边界。
- 行为契约（层间能力边界、依赖注入契约）用 `interface`，由实现对象满足契约；联合、交叉、映射、条件及函数签名类型用 `type`。
- 禁止重复别名 `type A = B` 和基础类型等价重命名 `type Price = number`，直接使用原类型。允许按需使用品牌类型建立真实类型区分，避免同基础类型的不同语义参数混用，不必给所有基本类型加品牌。
- 禁止 re-export；类型等直接从源模块引用。禁止类型位置内联 `import('...')`，所有类型在文件顶部通过 `import type { X } from '...'` 显式导入。

类型模式（定义放在对应 `types.ts`，使用方从定义处导入）：

```typescript
/** 用户数据，供仓储读写使用。 */
export type User = {
  readonly id: string;
  readonly roles: ReadonlyArray<string>;
};

/** 用户仓储的行为契约，供服务注入。 */
export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
}

/** 显式表达成功数据或预期内错误，供调用方按 success 分支处理。 */
export type Result<T, E = Error> =
  { readonly success: true; readonly data: T } | { readonly success: false; readonly error: E };

/** 经构造边界校验的用户标识，避免与其他字符串标识混用。 */
export type UserId = string & { readonly brand: unique symbol };
```

品牌构造示意：字符串校验通过后返回 `{ success: true, data: value as UserId }`，失败返回 `{ success: false, error }`；调用方先判断 `success` 再使用 `data`，不要直接把普通字符串作为 `UserId` 传入。

## 工厂、依赖与函数式逻辑

- 用工厂函数而非类创建对象；所有依赖通过参数注入，禁止在内部直接创建。由调用方组装依赖，测试时可注入 mock。
- 工厂内部函数若不引用工厂作用域变量（注入依赖、局部状态等），必须提升到模块顶层，避免重复创建；依赖这些变量的闭包留在工厂内部。
- 优先纯函数：无副作用、相同输入得到相同输出。不原地修改输入，使用不可变更新返回新对象/数组，如 `{ ...user, ...updates }`、`[...items, newItem]`，而非 `Object.assign(user, updates)`、`items.push(newItem)`。
- 将复杂逻辑组合为职责单一的小函数；集合变换优先 `map`、`filter`、`reduce`。
- 预期内错误优先用 `Result<T, E>` 显式返回并分支处理，不用异常替代正常分支控制。

## 代码组织

| 内容 | 放置与约束 |
| --- | --- |
| 类型 | `types.ts` 只能包含 `type`、`interface`、`import type`、`export type` 等类型相关定义；禁止常量、函数、类、枚举、Schema 等运行时代码。 |
| 工具 | `utils.ts` 只能包含工具函数及必要实现，禁止 `type`、`interface` 或其他类型声明；依赖类型放相邻 `types.ts` 或公共类型模块，以 `import type` 引入。 |
| 常量 | 统一放在 `src/constants/`，从定义位置引用，禁止分散硬编码或重复定义；`src/constants/index.ts` 只是组织示例，不是唯一允许的文件。 |
| 单元测试 | 统一放项目根目录 `tests/`，目录结构与 `src/` 一一对应；建议命名 `*.test.ts`，不要把不同模块测试堆在一个目录或文件中。 |

- 类型和工具按使用范围放置：仅本模块使用的放本模块 `types.ts` / `utils.ts`；跨模块共享的放使用方的**最近共同父级**对应文件，禁止重复定义。不要将共享内容提升到更高祖先级，也不要将私有内容放进父级公共文件。
- 例如 `src/aaa/bbb` 与 `src/aaa/ccc/ddd` 共享的类型/工具放 `src/aaa/types.ts` / `utils.ts`，不放 `src/types.ts` / `utils.ts`；仅 `bbb` 使用的放 `src/aaa/bbb/`。`src/aaa/bbb/index.ts` 的测试对应 `tests/aaa/bbb/index.test.ts`。
- 工具函数须同时满足：纯函数且无副作用（不改外部状态、不请求网络、不写库、不抛不可预期异常）、无具体业务规则归属、可复用而非只服务单一流程片段、职责单一。符合者必须放适用范围的 `utils.ts`；不符合者放业务模块或工厂/服务，不要因是纯函数就归为工具。纯函数不应以 `create` 开头命名。
- 上表的文件内容限制仅针对固定文件名 `types.ts` / `utils.ts`；下节对 `types/` / `utils/` 目录的要求是注释规范，不将文件内容限制扩展到整个目录。

## 注释

以中文为主，专有名词保留英文；修改业务逻辑必须同步更新相关注释，保持与实现一致。

| 位置/场景 | 要求 |
| --- | --- |
| 新增 `.ts` 模块（含测试） | 必须有 `/** ... */` 文件头，说明模块名与职责/流程；`types.ts`、`utils.ts` 及 `types/`、`utils/` 下文件除外。 |
| `types.ts` / `types/` | 每个类型必须有独立块注释，说明用途、数据来源（如适用）和使用范围，无需文件头。 |
| `utils.ts` / `utils/` | 每个工具函数必须有完整 JSDoc：功能、`@param`、`@returns`，无需文件头。 |
| 关键函数 | 核心业务流程、状态机迁移、风控检查、生命周期与异步队列处理等必须说明做什么、为什么，必要时补充副作用。 |
| 行内注释 | 仅解释复杂业务判断或顺序约束，不复述显然代码。 |
| 测试注释 | 保持轻量，说明场景意图、边界条件和业务期望，不逐条解释显然断言。 |

工具函数 JSDoc 示例：

```typescript
/**
 * 计算两数之和。
 * @param a 第一个数
 * @param b 第二个数
 * @returns 两数之和
 */
export function sum(a: number, b: number): number {
  return a + b;
}
```

## 质量与自检

- 禁止兼容式、补丁式、临时性代码，直接实现完整正确的目标逻辑；清除无用、无效、已弃用代码与临时测试文件。
- 禁止临时或多余注释（如本次修改步骤、与代码无关的说明）。命名必须符合实际行为；语义变化时用正确新命名全量替换，不保留旧命名委托链。
- 完成后按适用范围逐项核对：类型/不可变性 → 工厂/注入/函数式逻辑 → 组织/命名/直接导入 → 注释 → 质量；实际改码还须确认上述三个命令依序通过。
