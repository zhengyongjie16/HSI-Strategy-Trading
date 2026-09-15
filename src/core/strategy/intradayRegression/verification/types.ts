import type { StrategyDecision, StrategyEmitter } from '../../types.js';
import type { RuntimeScheduler } from '../../../../types/runtime.js';
import type { VerificationIndicator } from '../profile/types.js';

/**
 * 延迟验证样本点。
 * 类型用途：表示单个验证指标在某个采样时刻的三态结果。
 * 数据来源：由策略实例基于本轮指标快照投影生成。
 * 使用范围：VerificationSampleStore 与策略私有验证流程内部使用。
 */
export type VerificationSamplePoint =
  | Readonly<{ kind: 'value'; value: number }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid' }>;

/**
 * 延迟验证样本值映射。
 * 类型用途：按验证指标名保存单个采样时刻的三态值，供延迟验证直接消费。
 * 数据来源：由策略实例基于本轮指标快照和 verificationIndicators 投影生成。
 * 使用范围：VerificationSampleStore 与策略私有验证流程内部使用。
 */
export type VerificationSampleValues = Readonly<
  Partial<Record<VerificationIndicator, VerificationSamplePoint>>
>;

/**
 * 延迟验证样本条目。
 * 类型用途：存储单个时间点的延迟验证最小样本，供延迟验证按时间点回溯历史值。
 * 数据来源：由 VerificationSampleStore.push() 创建并存入时间窗口队列。
 * 使用范围：VerificationSampleStore 实现、策略私有验证流程与相关测试辅助共享使用。
 */
export type VerificationSampleEntry = {
  /** 记录时间戳（毫秒） */
  readonly timestamp: number;

  /** 延迟验证样本值 */
  readonly values: VerificationSampleValues;
};

/**
 * 时间窗口样本队列内部结构。
 * 类型用途：VerificationSampleStore 实现内部使用的数据结构，按时间升序保存保留窗口内的样本。
 * 数据来源：由 VerificationSampleStore 实现模块在初始化/运行时维护。
 * 使用范围：仅 VerificationSampleStore 实现内部使用。
 */
export type SampleQueue = {
  /** 当前保留的样本队列，按时间升序排列 */
  entries: VerificationSampleEntry[];
};

/**
 * 私有验证样本存储行为契约。
 * 类型用途：供策略私有验证流程回溯历史指标（getClosest），由策略实例创建并持有。
 * 数据来源：运行时创建，由策略私有验证样本存储模块实现；push 数据来自上游业务事件采样链路。
 * 使用范围：仅当前策略实例私有状态管理使用。
 */
export interface VerificationSampleStore {
  /**
   * 推送新的延迟验证样本。
   * @param values 延迟验证三态样本
   * @param sampleTimestampMs 采样时间戳（毫秒）
   */
  push: (values: VerificationSampleValues, sampleTimestampMs: number) => void;

  /**
   * 获取最接近目标时间的延迟验证样本条目。
   * @param targetTime 目标时间戳（毫秒）
   * @returns 最接近的样本条目，若无可用样本则返回 null
   */
  getClosest: (targetTime: number) => VerificationSampleEntry | null;

  /**
   * 清除所有缓存
   */
  clearAll: () => void;
}

/** 延迟候选只持有策略初值及普通 decision，不持有宿主执行权限。 */
export type DelayedCandidate = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly decision: StrategyDecision;
  readonly initial: Readonly<Record<string, number>>;
  readonly indicators: ReadonlyArray<VerificationIndicator>;
};

/** 当前 pending 的唯一授权：旧回调必须同时命中 entry 与 token。 */
export type PendingEntry = {
  readonly candidate: DelayedCandidate;
  readonly token: object;
  readonly emit: StrategyEmitter;
  readonly timer: ReturnType<RuntimeScheduler['scheduleTimer']>;
};

/** 私有 pending 生命周期端口，只由策略工厂构造持有。 */
export interface PendingVerification {
  readonly register: (candidate: DelayedCandidate, emit: StrategyEmitter) => void;
  readonly invalidate: (direction?: 'LONG' | 'SHORT') => void;
  readonly destroy: () => void;
}
