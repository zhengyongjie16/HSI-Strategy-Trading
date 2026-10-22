import type {
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
} from '../../../types/tradeLog.js';

/**
 * 单日日文件的仓储私有恢复缓存；普通成交只扫描、不缓存。
 * 可变集合仅由单写者 adapter 在严格扫描或同步持久化成功后更新。
 */
export type DailyLogState = {
  readonly completionRecords: ProtectiveLiquidationCompletionRecordV1[];
  readonly completionPayloadById: Map<string, string>;
  readonly progressRecords: ProtectiveLiquidationExecutionProgressRecordV1[];
  readonly progressPayloadById: Map<string, string>;
};

/** 日文件的 O(1) 外部变更指纹；追加前拒绝删除、截断、替换或外部修改后的陈旧缓存。 */
export type DailyLogFileFingerprint = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedTimeNs: bigint;
  readonly changedTimeNs: bigint;
};

/** adapter 工厂只接交易日志目录；具体 filesystem durable append 留在此基础设施边界。 */
export interface MixedTradeLogRepositoryDeps {
  readonly tradesDir: string;
}
