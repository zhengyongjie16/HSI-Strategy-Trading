/**
 * mixed trade log repository
 *
 * 职责：统一构造、严格解析并序列化普通成交、保护性清仓完成与 execution-progress V1 records，
 * 通过同目录临时文件、fsync 与原子替换串行持久化。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOGGING } from '../../constants/index.js';
import { isRecord } from '../../utils/helpers/index.js';
import { retainLatestLogFiles } from '../../utils/logger/index.js';
import { buildTradeLogPath } from '../../utils/trading/tradeLogPath.js';
import { getHKDateKey } from '../../utils/time/index.js';
import type { PersistableTradeRecord } from '../../types/trader.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../types/risk.js';
import type {
  MixedTradeLogRecord,
  MixedTradeLogRepository,
  MixedTradeLogRepositoryDeps,
  ProtectiveLiquidationCompletionInput,
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
  ProtectiveLiquidationOrderBaselineV1,
} from './types.js';

const COMPLETION_RECORD_TYPE = 'PROTECTIVE_LIQUIDATION_COMPLETION';
const EXECUTION_PROGRESS_RECORD_TYPE = 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS';
const LEGACY_COMPLETION_REASON = 'PROTECTIVE_LIQUIDATION_COMPLETED';
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRADE_RECORD_KEYS = new Set([
  'orderId',
  'symbol',
  'symbolName',
  'monitorSymbol',
  'action',
  'side',
  'quantity',
  'price',
  'orderType',
  'status',
  'error',
  'reason',
  'signalTriggerTime',
  'executedAt',
  'executedAtMs',
  'timestamp',
  'isProtectiveClearance',
]);
const COMPLETION_RECORD_KEYS = new Set([
  'recordType',
  'schemaVersion',
  'completionId',
  'tradingDayKey',
  'monitorSymbol',
  'direction',
  'boundaryExecutedTimeMs',
  'orderBaselines',
]);
const BASELINE_KEYS = new Set([
  'orderId',
  'symbol',
  'side',
  'cumulativeQuantity',
  'cumulativeAmount',
  'lastExecutionTimeMs',
  'orderRevisionMs',
]);
const EXECUTION_PROGRESS_RECORD_KEYS = new Set([
  'recordType',
  'schemaVersion',
  'progressId',
  'tradingDayKey',
  'monitorSymbol',
  'direction',
  'symbol',
  'orderId',
  'factStage',
  'cumulativeQuantity',
  'cumulativeAmount',
  'lastExecutionTimeMs',
  'orderRevisionMs',
]);

function isValidTradingDayKey(value: string): boolean {
  if (!DAY_KEY_PATTERN.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(parsed.getTime()) && getHKDateKey(parsed) === value;
}

function isPositiveDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && value !== '0';
}

function assertExactKeys(
  raw: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
  recordName: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!expected.has(key)) {
      throw new TypeError(`[MixedTradeLogRepository] ${recordName} unexpected field: ${key}`);
    }
  }

  if (Object.keys(raw).length !== expected.size) {
    throw new TypeError(`[MixedTradeLogRepository] ${recordName} fields incomplete`);
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseTradeRecord(raw: unknown): PersistableTradeRecord {
  if (!isRecord(raw)) {
    throw new TypeError('[MixedTradeLogRepository] trade record must be an object');
  }

  if (raw['reason'] === LEGACY_COMPLETION_REASON) {
    throw new Error('[MixedTradeLogRepository] legacy completion reason is not recoverable');
  }

  assertExactKeys(raw, TRADE_RECORD_KEYS, 'trade record');

  if (
    !isNullableString(raw['orderId']) ||
    !isNullableString(raw['symbol']) ||
    !isNullableString(raw['symbolName']) ||
    !isNullableString(raw['monitorSymbol']) ||
    !isNullableString(raw['action']) ||
    !isNullableString(raw['side']) ||
    !isNullableString(raw['quantity']) ||
    !isNullableString(raw['price']) ||
    !isNullableString(raw['orderType']) ||
    !isNullableString(raw['status']) ||
    !isNullableString(raw['error']) ||
    !isNullableString(raw['reason']) ||
    !isNullableString(raw['signalTriggerTime']) ||
    !isNullableString(raw['executedAt']) ||
    typeof raw['executedAtMs'] !== 'number' ||
    !Number.isFinite(raw['executedAtMs']) ||
    raw['executedAtMs'] <= 0 ||
    !isNullableString(raw['timestamp']) ||
    (raw['isProtectiveClearance'] !== null && typeof raw['isProtectiveClearance'] !== 'boolean')
  ) {
    throw new TypeError('[MixedTradeLogRepository] invalid trade record');
  }

  return {
    orderId: raw['orderId'],
    symbol: raw['symbol'],
    symbolName: raw['symbolName'],
    monitorSymbol: raw['monitorSymbol'],
    action: raw['action'],
    side: raw['side'],
    quantity: raw['quantity'],
    price: raw['price'],
    orderType: raw['orderType'],
    status: raw['status'],
    error: raw['error'],
    reason: raw['reason'],
    signalTriggerTime: raw['signalTriggerTime'],
    executedAt: raw['executedAt'],
    executedAtMs: raw['executedAtMs'],
    timestamp: raw['timestamp'],
    isProtectiveClearance: raw['isProtectiveClearance'],
  };
}

function parseBaseline(raw: unknown): ProtectiveLiquidationOrderBaselineV1 {
  if (!isRecord(raw)) {
    throw new TypeError('[MixedTradeLogRepository] order baseline must be an object');
  }

  assertExactKeys(raw, BASELINE_KEYS, 'order baseline');
  const orderId = raw['orderId'];
  const symbol = raw['symbol'];
  const side = raw['side'];
  const cumulativeQuantity = raw['cumulativeQuantity'];
  const cumulativeAmount = raw['cumulativeAmount'];
  const lastExecutionTimeMs = raw['lastExecutionTimeMs'];
  const orderRevisionMs = raw['orderRevisionMs'];
  if (
    typeof orderId !== 'string' ||
    orderId.length === 0 ||
    typeof symbol !== 'string' ||
    symbol.length === 0 ||
    (side !== 'BUY' && side !== 'SELL') ||
    typeof cumulativeQuantity !== 'string' ||
    !isPositiveDecimalString(cumulativeQuantity) ||
    typeof cumulativeAmount !== 'string' ||
    !isPositiveDecimalString(cumulativeAmount) ||
    typeof lastExecutionTimeMs !== 'number' ||
    !Number.isFinite(lastExecutionTimeMs) ||
    lastExecutionTimeMs <= 0 ||
    typeof orderRevisionMs !== 'number' ||
    !Number.isFinite(orderRevisionMs) ||
    orderRevisionMs <= 0 ||
    lastExecutionTimeMs > orderRevisionMs
  ) {
    throw new TypeError('[MixedTradeLogRepository] invalid order baseline');
  }

  return {
    orderId,
    symbol,
    side,
    cumulativeQuantity,
    cumulativeAmount,
    lastExecutionTimeMs,
    orderRevisionMs,
  };
}

function parseCompletionRecord(raw: unknown): ProtectiveLiquidationCompletionRecordV1 {
  if (!isRecord(raw)) {
    throw new TypeError('[MixedTradeLogRepository] completion record must be an object');
  }

  assertExactKeys(raw, COMPLETION_RECORD_KEYS, 'completion record');
  const tradingDayKey = raw['tradingDayKey'];
  const monitorSymbol = raw['monitorSymbol'];
  const direction = raw['direction'];
  const boundaryExecutedTimeMs = raw['boundaryExecutedTimeMs'];
  const completionId = raw['completionId'];
  const rawBaselines = raw['orderBaselines'];
  if (
    raw['recordType'] !== COMPLETION_RECORD_TYPE ||
    raw['schemaVersion'] !== 1 ||
    typeof tradingDayKey !== 'string' ||
    !isValidTradingDayKey(tradingDayKey) ||
    typeof monitorSymbol !== 'string' ||
    monitorSymbol.length === 0 ||
    (direction !== 'LONG' && direction !== 'SHORT') ||
    typeof boundaryExecutedTimeMs !== 'number' ||
    !Number.isFinite(boundaryExecutedTimeMs) ||
    boundaryExecutedTimeMs <= 0 ||
    typeof completionId !== 'string' ||
    completionId !==
      `v1:${tradingDayKey}:${monitorSymbol}:${direction}:${String(boundaryExecutedTimeMs)}` ||
    getHKDateKey(new Date(boundaryExecutedTimeMs)) !== tradingDayKey ||
    !Array.isArray(rawBaselines) ||
    rawBaselines.length === 0
  ) {
    throw new TypeError('[MixedTradeLogRepository] invalid V1 completion record');
  }

  const orderBaselines = rawBaselines.map(parseBaseline);
  if (new Set(orderBaselines.map((baseline) => baseline.orderId)).size !== orderBaselines.length) {
    throw new TypeError('[MixedTradeLogRepository] duplicate order baseline identity');
  }

  return {
    recordType: COMPLETION_RECORD_TYPE,
    schemaVersion: 1,
    completionId,
    tradingDayKey,
    monitorSymbol,
    direction,
    boundaryExecutedTimeMs,
    orderBaselines,
  };
}

function parseExecutionProgressRecord(
  raw: unknown,
): ProtectiveLiquidationExecutionProgressRecordV1 {
  if (!isRecord(raw)) {
    throw new TypeError('[MixedTradeLogRepository] execution progress record must be an object');
  }

  assertExactKeys(raw, EXECUTION_PROGRESS_RECORD_KEYS, 'execution progress record');
  const progressId = raw['progressId'];
  const tradingDayKey = raw['tradingDayKey'];
  const monitorSymbol = raw['monitorSymbol'];
  const direction = raw['direction'];
  const symbol = raw['symbol'];
  const orderId = raw['orderId'];
  const factStage = raw['factStage'];
  const cumulativeQuantity = raw['cumulativeQuantity'];
  const cumulativeAmount = raw['cumulativeAmount'];
  const lastExecutionTimeMs = raw['lastExecutionTimeMs'];
  const orderRevisionMs = raw['orderRevisionMs'];
  if (
    raw['recordType'] !== EXECUTION_PROGRESS_RECORD_TYPE ||
    raw['schemaVersion'] !== 1 ||
    typeof tradingDayKey !== 'string' ||
    !isValidTradingDayKey(tradingDayKey) ||
    typeof monitorSymbol !== 'string' ||
    monitorSymbol.length === 0 ||
    (direction !== 'LONG' && direction !== 'SHORT') ||
    typeof symbol !== 'string' ||
    symbol.length === 0 ||
    typeof orderId !== 'string' ||
    orderId.length === 0 ||
    (factStage !== 'OPEN' && factStage !== 'TERMINAL') ||
    typeof cumulativeQuantity !== 'string' ||
    !isPositiveDecimalString(cumulativeQuantity) ||
    typeof cumulativeAmount !== 'string' ||
    !isPositiveDecimalString(cumulativeAmount) ||
    typeof lastExecutionTimeMs !== 'number' ||
    !Number.isFinite(lastExecutionTimeMs) ||
    lastExecutionTimeMs <= 0 ||
    getHKDateKey(new Date(lastExecutionTimeMs)) !== tradingDayKey ||
    typeof orderRevisionMs !== 'number' ||
    !Number.isFinite(orderRevisionMs) ||
    orderRevisionMs <= 0 ||
    lastExecutionTimeMs > orderRevisionMs ||
    typeof progressId !== 'string' ||
    progressId !==
      `v1:${tradingDayKey}:${monitorSymbol}:${direction}:${symbol}:${orderId}:` +
        `${String(orderRevisionMs)}:${cumulativeQuantity}:${factStage}`
  ) {
    throw new TypeError('[MixedTradeLogRepository] invalid V1 execution progress record');
  }

  return {
    recordType: EXECUTION_PROGRESS_RECORD_TYPE,
    schemaVersion: 1,
    progressId,
    tradingDayKey,
    monitorSymbol,
    direction,
    symbol,
    orderId,
    factStage,
    cumulativeQuantity,
    cumulativeAmount,
    lastExecutionTimeMs,
    orderRevisionMs,
  };
}

/** 由完成业务事实构造唯一 V1 持久化记录。 */
function buildCompletionRecord(
  input: ProtectiveLiquidationCompletionInput,
): ProtectiveLiquidationCompletionRecordV1 {
  const tradingDayKey = getHKDateKey(new Date(input.boundaryExecutedTimeMs));
  if (tradingDayKey === null) {
    throw new TypeError('[MixedTradeLogRepository] completion trading day cannot be resolved');
  }

  return parseCompletionRecord({
    monitorSymbol: input.monitorSymbol,
    direction: input.direction,
    boundaryExecutedTimeMs: input.boundaryExecutedTimeMs,
    orderBaselines: input.orderBaselines,
    recordType: COMPLETION_RECORD_TYPE,
    schemaVersion: 1,
    completionId:
      `v1:${tradingDayKey}:${input.monitorSymbol}:${input.direction}:` +
      String(input.boundaryExecutedTimeMs),
    tradingDayKey,
  });
}

/** 由累计成交业务事实构造唯一 V1 持久化记录。 */
function buildExecutionProgressRecord(
  input: ProtectiveLiquidationExecutionProgressInput,
): ProtectiveLiquidationExecutionProgressRecordV1 {
  const tradingDayKey = getHKDateKey(new Date(input.lastExecutionTimeMs));
  if (tradingDayKey === null) {
    throw new TypeError(
      '[MixedTradeLogRepository] execution progress trading day cannot be resolved',
    );
  }

  return parseExecutionProgressRecord({
    monitorSymbol: input.monitorSymbol,
    direction: input.direction,
    symbol: input.symbol,
    orderId: input.orderId,
    factStage: input.factStage,
    cumulativeQuantity: input.cumulativeQuantity,
    cumulativeAmount: input.cumulativeAmount,
    lastExecutionTimeMs: input.lastExecutionTimeMs,
    orderRevisionMs: input.orderRevisionMs,
    recordType: EXECUTION_PROGRESS_RECORD_TYPE,
    schemaVersion: 1,
    progressId:
      `v1:${tradingDayKey}:${input.monitorSymbol}:${input.direction}:${input.symbol}:` +
      `${input.orderId}:${String(input.orderRevisionMs)}:${input.cumulativeQuantity}:` +
      input.factStage,
    tradingDayKey,
  });
}

function parseMixedRecord(raw: unknown): MixedTradeLogRecord {
  if (isRecord(raw) && raw['recordType'] === COMPLETION_RECORD_TYPE) {
    return parseCompletionRecord(raw);
  }

  if (isRecord(raw) && raw['recordType'] === EXECUTION_PROGRESS_RECORD_TYPE) {
    return parseExecutionProgressRecord(raw);
  }

  if (isRecord(raw) && raw['recordType'] !== undefined) {
    throw new TypeError('[MixedTradeLogRepository] unknown recordType');
  }

  return parseTradeRecord(raw);
}

function resolveLogFile(rootDir: string, tradingDayKey: string): string {
  if (!isValidTradingDayKey(tradingDayKey)) {
    throw new TypeError(`[MixedTradeLogRepository] invalid trading day key: ${tradingDayKey}`);
  }

  return path.join(rootDir, 'trades', `${tradingDayKey}.json`);
}

function readMixedRecords(logFile: string): MixedTradeLogRecord[] {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new TypeError('[MixedTradeLogRepository] trade log root must be an array');
  }

  return parsed.map(parseMixedRecord);
}

function collectCompletionRecords(
  records: ReadonlyArray<MixedTradeLogRecord>,
): ProtectiveLiquidationCompletionRecordV1[] {
  const completions: ProtectiveLiquidationCompletionRecordV1[] = [];
  const payloadById = new Map<string, string>();
  for (const record of records) {
    if (!('recordType' in record) || record.recordType !== COMPLETION_RECORD_TYPE) {
      continue;
    }

    const payload = JSON.stringify(record);
    const existingPayload = payloadById.get(record.completionId);
    if (existingPayload !== undefined && existingPayload !== payload) {
      throw new Error(`[MixedTradeLogRepository] completionId conflict: ${record.completionId}`);
    }

    if (existingPayload === undefined) {
      payloadById.set(record.completionId, payload);
      completions.push(record);
    }
  }

  return completions;
}

function collectExecutionProgressRecords(
  records: ReadonlyArray<MixedTradeLogRecord>,
): ProtectiveLiquidationExecutionProgressRecordV1[] {
  const progressRecords: ProtectiveLiquidationExecutionProgressRecordV1[] = [];
  const payloadById = new Map<string, string>();
  for (const record of records) {
    if (!('recordType' in record) || record.recordType !== EXECUTION_PROGRESS_RECORD_TYPE) {
      continue;
    }

    const payload = JSON.stringify(record);
    const existingPayload = payloadById.get(record.progressId);
    if (existingPayload !== undefined && existingPayload !== payload) {
      throw new Error(`[MixedTradeLogRepository] progressId conflict: ${record.progressId}`);
    }

    if (existingPayload === undefined) {
      payloadById.set(record.progressId, payload);
      progressRecords.push(record);
    }
  }

  return progressRecords;
}

function writeAtomic(logFile: string, records: ReadonlyArray<MixedTradeLogRecord>): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const tempFile = `${logFile}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(tempFile, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(records, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempFile, logFile);
    renamed = true;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // 保留原始持久化异常；临时文件仍会在下方清理。
      }
    }

    if (!renamed) {
      fs.rmSync(tempFile, { force: true });
    }
  }
}

function retainTradeLogs(logFile: string): void {
  retainLatestLogFiles(
    path.dirname(logFile),
    LOGGING.MAX_RETAINED_LOG_FILES,
    'json',
    path.basename(logFile),
  );
}

/** 创建进程内唯一、同步串行的 mixed trade log repository。 */
export function createMixedTradeLogRepository(
  deps: MixedTradeLogRepositoryDeps,
): MixedTradeLogRepository {
  function loadCompletionRecords(
    tradingDayKey: string,
  ): ReadonlyArray<ProtectiveLiquidationCompletionRecordV1> {
    const records = collectCompletionRecords(
      readMixedRecords(resolveLogFile(deps.resolveLogRootDir(), tradingDayKey)),
    );
    for (const record of records) {
      if (record.tradingDayKey !== tradingDayKey) {
        throw new Error(
          `[MixedTradeLogRepository] completion trading day mismatch: file=${tradingDayKey} record=${record.tradingDayKey}`,
        );
      }
    }

    return records;
  }

  function appendCompletionIdempotent(
    input: ProtectiveLiquidationCompletionInput,
  ): 'APPENDED' | 'UNCHANGED' {
    const normalizedRecord = buildCompletionRecord(input);
    const logFile = resolveLogFile(deps.resolveLogRootDir(), normalizedRecord.tradingDayKey);
    const mixedRecords = readMixedRecords(logFile);
    const existing = collectCompletionRecords(mixedRecords).find(
      (candidate) => candidate.completionId === normalizedRecord.completionId,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(normalizedRecord)) {
        throw new Error(
          `[MixedTradeLogRepository] completionId conflict: ${normalizedRecord.completionId}`,
        );
      }

      return 'UNCHANGED';
    }

    retainTradeLogs(logFile);
    writeAtomic(logFile, [...mixedRecords, normalizedRecord]);
    return 'APPENDED';
  }

  function loadExecutionProgressRecords(
    tradingDayKey: string,
  ): ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1> {
    const records = collectExecutionProgressRecords(
      readMixedRecords(resolveLogFile(deps.resolveLogRootDir(), tradingDayKey)),
    );
    for (const record of records) {
      if (record.tradingDayKey !== tradingDayKey) {
        throw new Error(
          `[MixedTradeLogRepository] progress trading day mismatch: file=${tradingDayKey} record=${record.tradingDayKey}`,
        );
      }
    }

    return records;
  }

  function appendExecutionProgressIdempotent(
    input: ProtectiveLiquidationExecutionProgressInput,
  ): 'APPENDED' | 'UNCHANGED' {
    const normalizedRecord = buildExecutionProgressRecord(input);
    const logFile = resolveLogFile(deps.resolveLogRootDir(), normalizedRecord.tradingDayKey);
    const mixedRecords = readMixedRecords(logFile);
    const existing = collectExecutionProgressRecords(mixedRecords).find(
      (candidate) => candidate.progressId === normalizedRecord.progressId,
    );
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(normalizedRecord)) {
        throw new Error(
          `[MixedTradeLogRepository] progressId conflict: ${normalizedRecord.progressId}`,
        );
      }

      return 'UNCHANGED';
    }

    retainTradeLogs(logFile);
    writeAtomic(logFile, [...mixedRecords, normalizedRecord]);
    return 'APPENDED';
  }

  function appendTradeRecord(record: PersistableTradeRecord): void {
    const normalizedRecord = parseTradeRecord(record);
    const logFile = buildTradeLogPath(
      deps.resolveLogRootDir(),
      new Date(normalizedRecord.executedAtMs),
    );
    const mixedRecords = readMixedRecords(logFile);
    retainTradeLogs(logFile);
    writeAtomic(logFile, [...mixedRecords, normalizedRecord]);
  }

  return {
    loadCompletionRecords,
    loadExecutionProgressRecords,
    appendCompletionIdempotent,
    appendExecutionProgressIdempotent,
    appendTradeRecord,
  };
}
