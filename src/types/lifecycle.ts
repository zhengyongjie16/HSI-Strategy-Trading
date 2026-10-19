/**
 * 生命周期状态。
 * 类型用途：表示 7x24 跨日缓存治理的阶段性状态（ACTIVE / MIDNIGHT_CLEANING / MIDNIGHT_CLEANED / OPEN_REBUILDING / OPEN_REBUILD_FAILED），用于 生命周期状态与门禁判断。
 * 数据来源：lifecycle 模块内部状态机更新。
 * 使用范围：仅本文件内部使用，不对外导出；外部通过 LifecycleMutableState.lifecycleState 的联合值读取并比较字面量。
 */
type LifecycleState =
  'ACTIVE' | 'MIDNIGHT_CLEANING' | 'MIDNIGHT_CLEANED' | 'OPEN_REBUILDING' | 'OPEN_REBUILD_FAILED';

/**
 * 唯一生命周期可变状态，由 app 创建一次并注入现有 manager。
 * manager、启动恢复与 fatal 关门直接写同一对象；读方仅获 Readonly/Pick，不得复制为门禁镜像。
 */
export type LifecycleMutableState = {
  currentDayKey: string | null;
  lifecycleState: LifecycleState;
  pendingOpenRebuild: boolean;
  isTradingEnabled: boolean;
};
