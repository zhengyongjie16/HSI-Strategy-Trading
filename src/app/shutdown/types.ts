import type { CleanupPhase } from '../../types/cleanup.js';

/**
 * 退出清理控制器。
 * 类型用途：表达 createCleanup 返回的显式资源清理能力。
 * 数据来源：由 createCleanup 创建。
 * 使用范围：仅 app 顶层装配与测试使用。
 */
export interface CleanupController {
  readonly register: (step: CleanupStep) => void;
  readonly execute: () => Promise<void>;
}

/**
 * 单个 cleanup 步骤。
 * 类型用途：描述资源释放动作、业务顺序阶段与日志名称。
 * 数据来源：由资源 acquisition owner 在取得真实 disposer 后创建。
 * 使用范围：仅 CleanupController.register 使用。
 */
export type CleanupStep = Readonly<{
  phase: CleanupPhase;
  step: string;
  handler: () => Promise<void> | void;
}>;

/**
 * 已登记的 cleanup 步骤。
 * 类型用途：在公开 cleanup 步骤上附加稳定登记顺序，用于同阶段排序。
 * 数据来源：由 createCleanup.register 在资源登记时生成。
 * 使用范围：仅 app/shutdown/createCleanup 内部使用。
 */
export type RegisteredCleanupStep = CleanupStep &
  Readonly<{
    sequence: number;
  }>;

/**
 * 退出清理失败条目。
 * 类型用途：记录单个 cleanup 步骤失败的步骤名与原始错误。
 * 数据来源：由 createCleanup 在执行各清理步骤时收集。
 * 使用范围：仅 app cleanup 装配链路内部使用。
 */
export type CleanupFailure = Readonly<{
  step: string;
  error: unknown;
}>;
