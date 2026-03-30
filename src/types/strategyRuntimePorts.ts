/**
 * StrategyRuntime 行为端口模块
 *
 * 职责：
 * - 定义 StrategyRuntime 暴露给调用方的共享行为契约
 * - 作为 types/app/services/main 之间的单一行为边界来源，避免重复同义接口
 */
import type { Position } from './account.js';

/**
 * 自动换标管理器行为契约。
 * 类型用途：约束 StrategyRuntime.autoSymbolManager 的可调用方法。
 * 数据来源：由 autoSymbolManager 模块实现并注入。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export interface AutoSymbolManagerPort {
  maybeSearchOnTick: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
  }) => Promise<void>;
  maybeSwitchOnInterval: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;
  }) => Promise<void>;
  maybeSwitchOnDistance: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorPrice: number | null;
    readonly positions: ReadonlyArray<Position>;
  }) => Promise<void>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
  resetAllState: () => void;
}
