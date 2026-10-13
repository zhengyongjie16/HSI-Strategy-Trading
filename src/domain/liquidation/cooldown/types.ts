import type { LiquidationCooldownConfig } from '../../../types/config.js';

/** 启动恢复传入的已完成保护性清仓时间；仅写入方向级冷却投影，不代表新 completion。 */
export type RecordCooldownParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
};

/** settlement 在 completion durable append 后提交一次触发；规则不自己判定最终完成。 */
export type RecordLiquidationTriggerParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
  readonly triggerLimit: number;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
};

/** application 从 durable completion 模拟出的当前周期计数，仅用于启动恢复。 */
export type RestoreTriggerCountParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly count: number;
};

/** 买入检查显式提供参考时点；domain 不读取隐式时钟，也不以无效时间回退系统当前时间。 */
export type GetRemainingMsParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly cooldownConfig: LiquidationCooldownConfig | null;
  readonly currentTimeMs: number;
};

/** 跨日清理确定需要删除的 half-day/one-day 方向；minutes 冷却由原调用方保留。 */
export type ClearMidnightEligibleParams = {
  readonly directionsToClear: ReadonlySet<'LONG' | 'SHORT'>;
};

/** Map-backed 冷却与触发计数投影；不接仓储、logger、timer 或最终完成事务。 */
export interface LiquidationCooldownTracker {
  readonly recordLiquidationTrigger: (params: RecordLiquidationTriggerParams) => void;
  readonly recordCooldown: (params: RecordCooldownParams) => void;
  readonly restoreTriggerCount: (params: RestoreTriggerCountParams) => void;

  /** 纯查询，不删除过期冷却或触发计数。 */
  readonly getRemainingMs: (params: GetRemainingMsParams) => number;
  readonly clearMidnightEligible: (params: ClearMidnightEligibleParams) => void;
  readonly resetAllTriggerCounts: () => void;
}

/** application 读取 completion 后提供的成交时点；用于纯触发周期模拟。 */
export type CooldownCandidate = {
  readonly executedAtMs: number;
};
