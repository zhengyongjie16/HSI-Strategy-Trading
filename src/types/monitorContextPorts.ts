/**
 * monitor context 行为端口模块
 *
 * 职责：
 * - 定义 MonitorContext 暴露给调用方的共享行为契约
 * - 作为 types/app/services/main 之间的单一行为边界来源，避免重复同义接口
 */
import type { Position } from './account.js';

/**
 * 席位换标的中性行为契约。
 * 数据来源：application 的唯一周期/距离换标 owner；所有异步推进保留原 caller 授权。
 * 使用范围：MonitorContext、换标 runtime 与 app 装配，不暴露策略、timer 或订单状态。
 */
export interface SeatSwitchWorkflow {
  readonly evaluatePeriodicSwitchDue: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canContinue: () => boolean;
  }) => Promise<SwitchDriveResult>;
  readonly startSwitchOnDistance: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorPrice: string | null;
    readonly positions: ReadonlyArray<Position>;
    readonly canContinue: () => boolean;
  }) => Promise<StartSwitchOnDistanceResult>;
  readonly advancePendingSwitch: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly positions: ReadonlyArray<Position>;
    readonly canContinue: () => boolean;
  }) => Promise<AdvancePendingSwitchResult>;
  readonly hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
  readonly getPeriodicSwitchPendingState: (
    direction: 'LONG' | 'SHORT',
  ) => Readonly<{ pending: boolean }>;
  readonly resetAllState: () => void;
}

/**
 * 距离换标等待唤醒描述。
 * 类型用途：显式表达 pending switch 下一次需要等待的事件源。
 * 数据来源：由 autoSymbolManager 状态机单步推进结果生成。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type SwitchWakeupRequirement =
  | Readonly<{
      kind: 'ORDER_EVENT';
      symbols: ReadonlyArray<string>;
    }>
  | Readonly<{
      kind: 'FRESHNESS';
    }>
  | Readonly<{
      kind: 'SYMBOL_QUOTE';
      symbol: string;
    }>
  | Readonly<{
      kind: 'RETRY_TIMER';
      atMs: number;
    }>;

/**
 * 非空只读数组。
 * 类型用途：表达业务结果至少持有一个后续 owner，不允许构造无人接管的等待状态。
 * 数据来源：由换标状态机在返回 WAIT 时构造。
 * 使用范围：switch drive result 与 runtime handoff 边界。
 */
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/**
 * 距离换标单步推进结果。
 * 类型用途：显式表达本轮推进后已完成、无需动作，或下一次需要等待的事件源。
 * 数据来源：由 autoSymbolManager 状态机单步推进返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type SwitchDriveResult =
  | Readonly<{
      kind: 'NOOP';
    }>
  | Readonly<{
      kind: 'COMPLETED';
    }>
  | Readonly<{
      kind: 'FAILED';
      reason: string;
    }>
  | Readonly<{
      kind: 'WAIT';
      wakeups: NonEmptyReadonlyArray<SwitchWakeupRequirement>;

      /** 首次WAIT已经发布的实际SWITCHING route见证，仅复核owner状态，不授予交易许可。 */
      publishedRoute?: Readonly<{
        direction: 'LONG' | 'SHORT';
        symbol: string;
        seatVersion: number;
        isCurrent: () => boolean;
      }>;
    }>;

/**
 * 距回收价换标启动结果。
 * 类型用途：显式表达本轮是否真正启动换标，以及启动后得到的下一步唤醒需求。
 * 数据来源：由 autoSymbolManager.startSwitchOnDistance 返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type StartSwitchOnDistanceResult =
  | Readonly<{
      started: false;
      direction: 'LONG' | 'SHORT';
      driveResult: Extract<SwitchDriveResult, { kind: 'NOOP' }>;
    }>
  | Readonly<{
      started: true;
      direction: 'LONG' | 'SHORT';
      driveResult: Extract<SwitchDriveResult, { kind: 'WAIT' }>;
    }>;

/**
 * 距回收价 pending switch 推进结果。
 * 类型用途：显式表达本轮是否真正执行了推进；未推进时只能返回 NOOP，已推进时携带状态机单步结果。
 * 数据来源：由 autoSymbolManager.advancePendingSwitch 返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type AdvancePendingSwitchResult =
  | Readonly<{
      advanced: false;
      direction: 'LONG' | 'SHORT';
      stillPending: false;
      driveResult: Extract<SwitchDriveResult, { kind: 'NOOP' }>;
    }>
  | Readonly<{
      advanced: true;
      direction: 'LONG' | 'SHORT';
      stillPending: true;
      driveResult: Extract<SwitchDriveResult, { kind: 'WAIT' }>;
    }>
  | Readonly<{
      advanced: true;
      direction: 'LONG' | 'SHORT';
      stillPending: false;
      driveResult: Exclude<SwitchDriveResult, { kind: 'WAIT' }>;
    }>;

/**
 * 周期换标阻塞来源（有效阻塞值）。
 * 类型用途：用于表达会阻断周期换标的席位占用来源。
 * 数据来源：由 autoSymbolManager 周期换标入口基于订单归属、本地在途订单与 broker 未完成订单判定。
 * 使用范围：MonitorContext 行为端口、autoSymbolManager 与监控任务处理器。
 */
export type PeriodicSeatBlockingReason =
  'ORDER_RECORDER' | 'LOCAL_PENDING_ORDER' | 'BROKER_PENDING_ORDER';
