import type { PersistableTradeRecord } from './trader.js';
import type { ProtectiveLiquidationExecutionProgressInput } from './risk.js';

/**
 * 保护性清仓完成记录中的订单累计基线。
 * 类型用途：冻结完成边界时每笔相关订单的累计数量、累计金额与 revision 身份。
 * 数据来源：DailyLossTracker.prepareProtectionBoundary。
 * 使用范围：settlement 完成记录持久化与启动恢复。
 */
export type ProtectiveLiquidationOrderBaselineV1 = Readonly<{
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  cumulativeQuantity: string;
  cumulativeAmount: string;
  lastExecutionTimeMs: number;
  orderRevisionMs: number;
}>;

/**
 * 保护性清仓完成记录 V1。
 * 类型用途：作为 DailyLoss 分段、冷却与 episode 完成投影的唯一持久化事实。
 * 数据来源：PostTradeSettlementWorkflow 的唯一完成事务。
 * 使用范围：当日 mixed trade log 与启动恢复。
 */
export type ProtectiveLiquidationCompletionRecordV1 = Readonly<{
  recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION';
  schemaVersion: 1;
  completionId: string;
  tradingDayKey: string;
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  boundaryExecutedTimeMs: number;
  orderBaselines: ReadonlyArray<ProtectiveLiquidationOrderBaselineV1>;
}>;

/**
 * 保护性清仓完成事实写入输入。
 * 类型用途：只表达业务事实，由 repository 派生交易日、协议版本、记录类型与 canonical ID。
 * 数据来源：PostTradeSettlementWorkflow 的完成判定及受控 crash-gap 恢复。
 * 使用范围：MixedTradeLogRepository.appendCompletionIdempotent，同步持久化后才提交内存。
 */
export type ProtectiveLiquidationCompletionInput = Readonly<{
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  boundaryExecutedTimeMs: number;
  orderBaselines: ReadonlyArray<ProtectiveLiquidationOrderBaselineV1>;
}>;

/**
 * 保护性清仓订单累计成交进度 V1。
 * 类型用途：在 completion 前持久化单笔保护性卖单的精确累计成交快照。
 * 数据来源：订单事实 owner 在累计成交推进或合法 OPEN 到 TERMINAL 金额修订时生成。
 * 使用范围：mixed trade log 持久化与启动恢复，不增加新的日志格式。
 */
export type ProtectiveLiquidationExecutionProgressRecordV1 = Readonly<{
  recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS';
  schemaVersion: 1;
  progressId: string;
  tradingDayKey: string;
  monitorSymbol: string;
  direction: 'LONG' | 'SHORT';
  symbol: string;
  orderId: string;
  factStage: 'OPEN' | 'TERMINAL';
  cumulativeQuantity: string;
  cumulativeAmount: string;
  lastExecutionTimeMs: number;
  orderRevisionMs: number;
}>;

/**
 * mixed trade log 允许持久化的记录联合。
 * 类型用途：使普通成交、保护性清仓完成与执行进度共享原有追加文件格式。
 * 数据来源：订单状态事件及 settlement 完成事务。
 * 使用范围：唯一 persistence adapter 的严格校验与序列化。
 */
export type MixedTradeLogRecord =
  | PersistableTradeRecord
  | ProtectiveLiquidationCompletionRecordV1
  | ProtectiveLiquidationExecutionProgressRecordV1;

/**
 * mixed trade log 仓储行为端口。
 * 类型用途：单写者拥有普通成交与保护性事实的严格恢复及同步 JSONL 追加。
 * 数据来源：composition root 注入唯一 persistence adapter。
 * 使用范围：订单事件持久化、settlement 与 lifecycle 恢复；不暴露 filesystem 实现。
 */
export interface MixedTradeLogRepository {
  readonly loadCompletionRecords: (
    tradingDayKey: string,
  ) => ReadonlyArray<ProtectiveLiquidationCompletionRecordV1>;
  readonly loadExecutionProgressRecords: (
    tradingDayKey: string,
  ) => ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>;
  readonly appendCompletionIdempotent: (input: ProtectiveLiquidationCompletionInput) => void;
  readonly appendExecutionProgressIdempotent: (
    input: ProtectiveLiquidationExecutionProgressInput,
  ) => void;
  readonly appendTradeRecord: (record: PersistableTradeRecord) => void;
}
