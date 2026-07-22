import type { PersistableTradeRecord } from '../../types/trader.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../types/risk.js';

/**
 * 保护性清仓完成记录中的订单累计基线。
 * 类型用途：冻结完成边界时每笔相关订单的累计数量、累计金额与 revision 身份。
 * 数据来源：DailyLossTracker.prepareProtectionBoundary。
 * 使用范围：完成记录持久化与启动恢复。
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
 * 数据来源：PostTradeConsistencyRuntime 完成协调器。
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
 * 类型用途：只表达业务事实，由 repository 统一派生交易日、协议版本、记录类型与 canonical ID。
 * 数据来源：PostTradeConsistencyRuntime 或启动 crash-gap 完成协调器。
 * 使用范围：MixedTradeLogRepository.appendCompletionIdempotent。
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
 * 数据来源：SettlementFlow 在累计成交真实推进或合法 OPEN 到 TERMINAL 金额修订时生成。
 * 使用范围：mixed trade log 持久化与启动恢复。
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
 * mixed trade log 中允许持久化的记录联合。
 * 类型用途：确保普通成交与保护性清仓完成事实共享同一文件读改写边界。
 * 数据来源：订单状态事件或 PostTradeConsistencyRuntime。
 * 使用范围：MixedTradeLogRepository 内部序列化。
 */
export type MixedTradeLogRecord =
  | PersistableTradeRecord
  | ProtectiveLiquidationCompletionRecordV1
  | ProtectiveLiquidationExecutionProgressRecordV1;

/**
 * mixed trade log repository 依赖。
 * 类型用途：注入日志根目录，隔离文件系统路径策略。
 * 数据来源：createPostGateRuntime 或测试。
 * 使用范围：MixedTradeLogRepository 工厂。
 */
export type MixedTradeLogRepositoryDeps = Readonly<{
  resolveLogRootDir: () => string;
}>;

/**
 * mixed trade log repository 契约。
 * 类型用途：串行拥有普通成交与 completion record 的严格读取和原子追加。
 * 数据来源：createMixedTradeLogRepository。
 * 使用范围：订单事件持久化、PostTradeConsistencyRuntime 与 lifecycle 恢复。
 */
export interface MixedTradeLogRepository {
  loadCompletionRecords: (
    tradingDayKey: string,
  ) => ReadonlyArray<ProtectiveLiquidationCompletionRecordV1>;
  loadExecutionProgressRecords: (
    tradingDayKey: string,
  ) => ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1>;
  appendCompletionIdempotent: (input: ProtectiveLiquidationCompletionInput) => void;
  appendExecutionProgressIdempotent: (input: ProtectiveLiquidationExecutionProgressInput) => void;
  appendTradeRecord: (record: PersistableTradeRecord) => void;
}
