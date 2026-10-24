/**
 * mixed trade log repository
 *
 * 职责：统一严格校验、恢复并追加普通成交、保护性清仓完成与 execution-progress V1 JSONL 记录。
 */
import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { TRADE_PERSISTENCE } from '../../../constants/common.js';
import { isRecord } from '../../../utils/helpers/index.js';
import { buildTradeLogPath } from './tradeLogPath.js';
import { getHKDateKey } from '../../../utils/time/index.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../../types/risk.js';
import type {
  PersistableTradeRecord,
  MixedTradeLogRecord,
  MixedTradeLogRepository,
  ProtectiveLiquidationCompletionInput,
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
  ProtectiveLiquidationOrderBaselineV1,
} from '../../../types/tradeLog.js';
import type {
  DailyLogFileFingerprint,
  MixedTradeLogRepositoryDeps,
  DailyLogState,
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
    orderRevisionMs <= 0
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

/**
 * 严格校验并规范化一条混合交易日志记录，供仓储扫描与交易费用 JSONL 读取共用。
 * @param raw JSON 解析得到的未知记录
 * @returns 通过完整 schema 校验的规范记录
 */
export function parseMixedRecord(raw: unknown): MixedTradeLogRecord {
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

function resolveLogFile(tradesDir: string, tradingDayKey: string): string {
  if (!isValidTradingDayKey(tradingDayKey)) {
    throw new TypeError(`[MixedTradeLogRepository] invalid trading day key: ${tradingDayKey}`);
  }

  return buildTradeLogPath(tradesDir, new Date(`${tradingDayKey}T00:00:00+08:00`));
}

function createEmptyDailyLogState(): DailyLogState {
  return {
    completionRecords: [],
    completionPayloadById: new Map(),
    progressRecords: [],
    progressPayloadById: new Map(),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}

function fingerprintFromStats(stats: BigIntStats, filePath: string): DailyLogFileFingerprint {
  if (!stats.isFile()) {
    throw new Error(`[MixedTradeLogRepository] expected daily log file: ${filePath}`);
  }

  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedTimeNs: stats.mtimeNs,
    changedTimeNs: stats.ctimeNs,
  };
}

function readFileFingerprint(filePath: string): DailyLogFileFingerprint {
  return fingerprintFromStats(fs.lstatSync(filePath, { bigint: true }), filePath);
}

function sameFileFingerprint(
  left: DailyLogFileFingerprint,
  right: DailyLogFileFingerprint,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedTimeNs === right.modifiedTimeNs &&
    left.changedTimeNs === right.changedTimeNs
  );
}

function sameFileIdentity(left: DailyLogFileFingerprint, right: DailyLogFileFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function rememberRecord(state: DailyLogState, record: MixedTradeLogRecord): void {
  if ('recordType' in record && record.recordType === COMPLETION_RECORD_TYPE) {
    const payload = JSON.stringify(record);
    const existing = state.completionPayloadById.get(record.completionId);
    if (existing !== undefined && existing !== payload) {
      throw new Error(`[MixedTradeLogRepository] completionId conflict: ${record.completionId}`);
    }

    if (existing === undefined) {
      state.completionPayloadById.set(record.completionId, payload);
      state.completionRecords.push(record);
    }

    return;
  }

  if ('recordType' in record) {
    const payload = JSON.stringify(record);
    const existing = state.progressPayloadById.get(record.progressId);
    if (existing !== undefined && existing !== payload) {
      throw new Error(`[MixedTradeLogRepository] progressId conflict: ${record.progressId}`);
    }

    if (existing === undefined) {
      state.progressPayloadById.set(record.progressId, payload);
      state.progressRecords.push(record);
    }
  }
}

function assertRecordMatchesDay(record: MixedTradeLogRecord, tradingDayKey: string): void {
  const recordDayKey =
    'recordType' in record ? record.tradingDayKey : getHKDateKey(new Date(record.executedAtMs));
  if (recordDayKey !== tradingDayKey) {
    let recordName = 'trade';
    if ('recordType' in record) {
      recordName = record.recordType === EXECUTION_PROGRESS_RECORD_TYPE ? 'progress' : 'completion';
    }

    throw new Error(
      `[MixedTradeLogRepository] ${recordName} trading day mismatch: file=${tradingDayKey} record=${recordDayKey}`,
    );
  }
}

/** 启动 preflight 单次读取并严格扫描整份日文件，不容忍任何损坏行。 */
function readDailyLog(logFile: string, tradingDayKey: string): DailyLogState {
  const bytes = fs.readFileSync(logFile);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (bytes.length === 0 || !text.endsWith('\n')) {
    throw new Error(`[MixedTradeLogRepository] incomplete JSONL final line: ${logFile}`);
  }

  const state = createEmptyDailyLogState();
  const lines = text.slice(0, -1).split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 || line.includes('\r')) {
      throw new Error(`[MixedTradeLogRepository] invalid JSONL line ${index + 1}: ${logFile}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error: unknown) {
      throw new SyntaxError(
        `[MixedTradeLogRepository] invalid JSONL line ${index + 1}: ${logFile}`,
        { cause: error },
      );
    }

    const record = parseMixedRecord(raw);
    assertRecordMatchesDay(record, tradingDayKey);
    rememberRecord(state, record);
  }

  return state;
}

function scanTradeLogDirectory(
  tradesDir: string,
  dailyStates: Map<string, DailyLogState>,
  fingerprintsByDayKey: Map<string, DailyLogFileFingerprint>,
): void {
  let entries: ReadonlyArray<string>;
  try {
    const stats = fs.lstatSync(tradesDir);
    if (!stats.isDirectory()) {
      throw new Error(`[MixedTradeLogRepository] expected trade log directory: ${tradesDir}`);
    }

    entries = fs.readdirSync(tradesDir);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }

  const legacyFileName = entries.find((entry) => entry.endsWith('.json'));
  if (legacyFileName !== undefined) {
    throw new Error(
      `[MixedTradeLogRepository] legacy JSON trade log requires manual reconciliation: ${path.join(tradesDir, legacyFileName)}`,
    );
  }

  const dailyFileNames = entries
    .filter((name) => name.endsWith('.jsonl'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const entry of dailyFileNames) {
    const tradingDayKey = entry.slice(0, -'.jsonl'.length);
    if (!isValidTradingDayKey(tradingDayKey)) {
      throw new TypeError(`[MixedTradeLogRepository] invalid daily log file name: ${entry}`);
    }

    const logFile = path.join(tradesDir, entry);
    const beforeRead = readFileFingerprint(logFile);
    const state = readDailyLog(logFile, tradingDayKey);
    const afterRead = readFileFingerprint(logFile);
    if (!sameFileFingerprint(beforeRead, afterRead)) {
      throw new Error(
        `[MixedTradeLogRepository] daily log changed during startup scan; manual reconciliation required: ${logFile}`,
      );
    }

    dailyStates.set(tradingDayKey, state);
    fingerprintsByDayKey.set(tradingDayKey, afterRead);
  }
}

/** 只追加一行并 fsync/close 文件；任一结果不确定都由仓储锁定到重启。 */
function appendJsonlRecord(
  logFile: string,
  bytes: Buffer,
  existingFingerprint: DailyLogFileFingerprint | undefined,
): DailyLogFileFingerprint {
  const startPositionBigInt = existingFingerprint?.size ?? 0n;
  if (startPositionBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`[MixedTradeLogRepository] daily log exceeds safe append offset: ${logFile}`);
  }

  const descriptor = fs.openSync(logFile, existingFingerprint === undefined ? 'wx' : 'r+');
  let failure: unknown;
  let hasFailure = false;
  let appendedFingerprint: DailyLogFileFingerprint | undefined;
  try {
    const openedFingerprint = fingerprintFromStats(
      fs.fstatSync(descriptor, { bigint: true }),
      logFile,
    );
    if (
      existingFingerprint === undefined
        ? openedFingerprint.size !== 0n
        : !sameFileFingerprint(openedFingerprint, existingFingerprint)
    ) {
      throw new Error(
        `[MixedTradeLogRepository] daily log changed before append; manual reconciliation required: ${logFile}`,
      );
    }

    let offset = 0;
    const startPosition = Number(startPositionBigInt);
    while (offset < bytes.length) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        startPosition + offset,
      );
      if (written <= 0) {
        throw new Error('[MixedTradeLogRepository] append returned no bytes');
      }

      offset += written;
    }

    fs.fsyncSync(descriptor);
    appendedFingerprint = fingerprintFromStats(fs.fstatSync(descriptor, { bigint: true }), logFile);
    const expectedSize = startPositionBigInt + BigInt(bytes.length);
    if (
      appendedFingerprint.size !== expectedSize ||
      (existingFingerprint !== undefined &&
        !sameFileIdentity(appendedFingerprint, existingFingerprint))
    ) {
      throw new Error(
        `[MixedTradeLogRepository] daily log changed during append; manual reconciliation required: ${logFile}`,
      );
    }
  } catch (error: unknown) {
    failure = error;
    hasFailure = true;
  }

  try {
    fs.closeSync(descriptor);
  } catch (error: unknown) {
    if (!hasFailure) {
      failure = error;
      hasFailure = true;
    }
  }

  if (hasFailure) {
    throw failure;
  }

  if (appendedFingerprint === undefined) {
    throw new Error(`[MixedTradeLogRepository] append metadata missing: ${logFile}`);
  }

  return appendedFingerprint;
}

function compareDayKeysDescending(left: string, right: string): number {
  if (left > right) {
    return -1;
  }

  if (left < right) {
    return 1;
  }

  return 0;
}

/** 创建时只读 preflight 所有既有日文件；进程内后续读取由缓存提供。 */
export function createMixedTradeLogRepository(
  deps: MixedTradeLogRepositoryDeps,
): MixedTradeLogRepository {
  const tradesDir = deps.tradesDir;
  const dailyStates = new Map<string, DailyLogState>();
  const fingerprintsByDayKey = new Map<string, DailyLogFileFingerprint>();
  scanTradeLogDirectory(tradesDir, dailyStates, fingerprintsByDayKey);
  let recoveryRequiredDayKey: string | null = null;
  let blockedError: unknown;
  let isBlocked = false;

  function blockRepository(error: unknown): never {
    blockedError = error;
    isBlocked = true;
    throw error;
  }

  function assertUsable(): void {
    if (isBlocked) {
      throw new Error('[MixedTradeLogRepository] blocked after uncertain persistence failure', {
        cause: blockedError,
      });
    }
  }

  function assertCachedFileCurrent(tradingDayKey: string): DailyLogFileFingerprint {
    const expectedFingerprint = fingerprintsByDayKey.get(tradingDayKey);
    if (expectedFingerprint === undefined) {
      return blockRepository(
        new Error(
          `[MixedTradeLogRepository] cached daily-file fingerprint missing: ${tradingDayKey}`,
        ),
      );
    }

    let actualFingerprint: DailyLogFileFingerprint;
    try {
      actualFingerprint = readFileFingerprint(resolveLogFile(tradesDir, tradingDayKey));
    } catch (error: unknown) {
      return blockRepository(
        new Error(
          `[MixedTradeLogRepository] cached daily file is no longer accessible; manual reconciliation required: ${tradingDayKey}`,
          { cause: error },
        ),
      );
    }

    if (!sameFileFingerprint(expectedFingerprint, actualFingerprint)) {
      return blockRepository(
        new Error(
          `[MixedTradeLogRepository] cached daily file changed; manual reconciliation required: ${tradingDayKey}`,
        ),
      );
    }

    return actualFingerprint;
  }

  function getState(tradingDayKey: string): DailyLogState | undefined {
    if (!isValidTradingDayKey(tradingDayKey)) {
      throw new TypeError(`[MixedTradeLogRepository] invalid trading day key: ${tradingDayKey}`);
    }

    // 快照恢复一次只处理一个交易日；下一日读取即释放前一日的留存保护。
    recoveryRequiredDayKey = tradingDayKey;
    return dailyStates.get(tradingDayKey);
  }

  function resolvePrunedDayKeys(targetDayKey: string): ReadonlyArray<string> {
    const candidates = new Set(dailyStates.keys());
    candidates.add(targetDayKey);
    const descendingDayKeys = [...candidates].sort(compareDayKeysDescending);
    const retainedDayKeys = new Set(
      descendingDayKeys.slice(0, TRADE_PERSISTENCE.MAX_RETAINED_DAILY_FILES),
    );
    if (!retainedDayKeys.has(targetDayKey)) {
      throw new Error(
        `[MixedTradeLogRepository] target day is outside the latest ${TRADE_PERSISTENCE.MAX_RETAINED_DAILY_FILES} daily-file window: ${targetDayKey}`,
      );
    }

    const prunedDayKeys = [...dailyStates.keys()].filter((dayKey) => !retainedDayKeys.has(dayKey));
    const currentDayKey = getHKDateKey(new Date());
    const protectedDayKey = prunedDayKeys.find(
      (dayKey) => dayKey === recoveryRequiredDayKey || dayKey === currentDayKey,
    );
    if (protectedDayKey !== undefined) {
      throw new Error(
        `[MixedTradeLogRepository] retention would remove a current or recovery-required day file: ${protectedDayKey}`,
      );
    }

    return prunedDayKeys;
  }

  /** 先持久化完整行并更新缓存；留存外文件的文件系统错误只延后清理。 */
  function appendRecord(
    record: MixedTradeLogRecord,
    tradingDayKey: string,
    verifiedFingerprint?: DailyLogFileFingerprint,
  ): void {
    const prunedDayKeys = resolvePrunedDayKeys(tradingDayKey);
    const logFile = resolveLogFile(tradesDir, tradingDayKey);
    const fileExists = dailyStates.has(tradingDayKey);
    try {
      const prunedFiles = prunedDayKeys.map((dayKey) => {
        const expectedFingerprint = fingerprintsByDayKey.get(dayKey);
        if (expectedFingerprint === undefined) {
          throw new Error(
            `[MixedTradeLogRepository] missing cached fingerprint for retention victim: ${dayKey}`,
          );
        }

        return { dayKey, expectedFingerprint };
      });
      const existingFingerprint = fileExists
        ? (verifiedFingerprint ?? assertCachedFileCurrent(tradingDayKey))
        : undefined;

      if (!fileExists) {
        fs.mkdirSync(tradesDir, { recursive: true });
      }

      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      const descriptorFingerprint = appendJsonlRecord(logFile, bytes, existingFingerprint);

      const pathFingerprint = readFileFingerprint(logFile);
      if (!sameFileFingerprint(descriptorFingerprint, pathFingerprint)) {
        throw new Error(
          `[MixedTradeLogRepository] daily log path changed after append; manual reconciliation required: ${logFile}`,
        );
      }

      const state = dailyStates.get(tradingDayKey) ?? createEmptyDailyLogState();
      rememberRecord(state, record);
      dailyStates.set(tradingDayKey, state);
      fingerprintsByDayKey.set(tradingDayKey, pathFingerprint);

      for (const { dayKey, expectedFingerprint } of prunedFiles) {
        const prunedLogFile = resolveLogFile(tradesDir, dayKey);
        try {
          const actualFingerprint = readFileFingerprint(prunedLogFile);
          if (!sameFileFingerprint(expectedFingerprint, actualFingerprint)) {
            console.error(
              `[MixedTradeLogRepository] retention victim changed; keeping file: ${dayKey}`,
            );
            continue;
          }

          fs.unlinkSync(prunedLogFile);
          dailyStates.delete(dayKey);
          fingerprintsByDayKey.delete(dayKey);
        } catch (error: unknown) {
          if (hasErrorCode(error, 'ENOENT')) {
            dailyStates.delete(dayKey);
            fingerprintsByDayKey.delete(dayKey);
            continue;
          }

          console.error(
            `[MixedTradeLogRepository] failed to prune retention victim; keeping file: ${dayKey}`,
            error,
          );
        }
      }
    } catch (error: unknown) {
      blockRepository(error);
    }
  }

  function loadCompletionRecords(
    tradingDayKey: string,
  ): ReadonlyArray<ProtectiveLiquidationCompletionRecordV1> {
    assertUsable();
    const state = getState(tradingDayKey);
    if (state === undefined) {
      return [];
    }

    assertCachedFileCurrent(tradingDayKey);
    return [...state.completionRecords];
  }

  function appendCompletionIdempotent(input: ProtectiveLiquidationCompletionInput): void {
    assertUsable();
    const record = buildCompletionRecord(input);
    // A matching ID remains an append attempt and must still satisfy today's retention window.
    resolvePrunedDayKeys(record.tradingDayKey);
    const state = dailyStates.get(record.tradingDayKey);
    const verifiedFingerprint =
      state === undefined ? undefined : assertCachedFileCurrent(record.tradingDayKey);
    const existingPayload = state?.completionPayloadById.get(record.completionId);
    const payload = JSON.stringify(record);
    if (existingPayload !== undefined) {
      if (existingPayload !== payload) {
        throw new Error(`[MixedTradeLogRepository] completionId conflict: ${record.completionId}`);
      }

      return;
    }

    appendRecord(record, record.tradingDayKey, verifiedFingerprint);
  }

  function loadExecutionProgressRecords(
    tradingDayKey: string,
  ): ReadonlyArray<ProtectiveLiquidationExecutionProgressRecordV1> {
    assertUsable();
    const state = getState(tradingDayKey);
    if (state === undefined) {
      return [];
    }

    assertCachedFileCurrent(tradingDayKey);
    return [...state.progressRecords];
  }

  function appendExecutionProgressIdempotent(
    input: ProtectiveLiquidationExecutionProgressInput,
  ): void {
    assertUsable();
    const record = buildExecutionProgressRecord(input);
    // A matching ID remains an append attempt and must still satisfy today's retention window.
    resolvePrunedDayKeys(record.tradingDayKey);
    const state = dailyStates.get(record.tradingDayKey);
    const verifiedFingerprint =
      state === undefined ? undefined : assertCachedFileCurrent(record.tradingDayKey);
    const existingPayload = state?.progressPayloadById.get(record.progressId);
    const payload = JSON.stringify(record);
    if (existingPayload !== undefined) {
      if (existingPayload !== payload) {
        throw new Error(`[MixedTradeLogRepository] progressId conflict: ${record.progressId}`);
      }

      return;
    }

    appendRecord(record, record.tradingDayKey, verifiedFingerprint);
  }

  function appendTradeRecord(record: PersistableTradeRecord): void {
    assertUsable();
    const normalizedRecord = parseTradeRecord(record);
    const tradingDayKey = getHKDateKey(new Date(normalizedRecord.executedAtMs));
    appendRecord(normalizedRecord, tradingDayKey);
  }

  return {
    loadCompletionRecords,
    loadExecutionProgressRecords,
    appendCompletionIdempotent,
    appendExecutionProgressIdempotent,
    appendTradeRecord,
  };
}
