/**
 * mixed trade log repository 业务测试。
 *
 * 覆盖混合记录不丢失、completionId 幂等、严格旧事实阻断与原子写失败清理。
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMixedTradeLogRepository } from '../../../src/services/mixedTradeLogRepository/index.js';
import type {
  ProtectiveLiquidationCompletionInput,
  ProtectiveLiquidationCompletionRecordV1,
  ProtectiveLiquidationExecutionProgressRecordV1,
} from '../../../src/services/mixedTradeLogRepository/types.js';
import type { ProtectiveLiquidationExecutionProgressInput } from '../../../src/types/risk.js';
import type { PersistableTradeRecord } from '../../../src/types/trader.js';
import { buildTradeLogPath } from '../../../src/utils/trading/tradeLogPath.js';

const tempDirs: string[] = [];
const completionBoundaryMs = Date.parse('2026-07-11T10:00:00+08:00');
const progressExecutionMs = Date.parse('2026-07-11T09:59:00+08:00');

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createRecord(): ProtectiveLiquidationCompletionRecordV1 {
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
    schemaVersion: 1,
    completionId: `v1:2026-07-11:HSI.HK:LONG:${String(completionBoundaryMs)}`,
    tradingDayKey: '2026-07-11',
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    boundaryExecutedTimeMs: completionBoundaryMs,
    orderBaselines: [
      {
        orderId: 'SELL-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '40',
        cumulativeAmount: '36',
        lastExecutionTimeMs: progressExecutionMs,
        orderRevisionMs: completionBoundaryMs,
      },
    ],
  };
}

function createProgressRecord(): ProtectiveLiquidationExecutionProgressRecordV1 {
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS',
    schemaVersion: 1,
    progressId: `v1:2026-07-11:HSI.HK:LONG:BULL.HK:SELL-1:${String(completionBoundaryMs)}:40:OPEN`,
    tradingDayKey: '2026-07-11',
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    symbol: 'BULL.HK',
    orderId: 'SELL-1',
    factStage: 'OPEN',
    cumulativeQuantity: '40',
    cumulativeAmount: '36',
    lastExecutionTimeMs: progressExecutionMs,
    orderRevisionMs: completionBoundaryMs,
  };
}

function toCompletionInput(
  record: ProtectiveLiquidationCompletionRecordV1,
): ProtectiveLiquidationCompletionInput {
  return {
    monitorSymbol: record.monitorSymbol,
    direction: record.direction,
    boundaryExecutedTimeMs: record.boundaryExecutedTimeMs,
    orderBaselines: record.orderBaselines,
  };
}

function toExecutionProgressInput(
  record: ProtectiveLiquidationExecutionProgressRecordV1,
): ProtectiveLiquidationExecutionProgressInput {
  return {
    monitorSymbol: record.monitorSymbol,
    direction: record.direction,
    symbol: record.symbol,
    orderId: record.orderId,
    factStage: record.factStage,
    cumulativeQuantity: record.cumulativeQuantity,
    cumulativeAmount: record.cumulativeAmount,
    lastExecutionTimeMs: record.lastExecutionTimeMs,
    orderRevisionMs: record.orderRevisionMs,
  };
}

function createTradeRecord(): PersistableTradeRecord {
  return {
    orderId: 'BUY-1',
    symbol: 'BULL.HK',
    symbolName: null,
    monitorSymbol: 'HSI.HK',
    action: 'BUYCALL',
    side: 'BUY',
    quantity: '100',
    price: '1.23',
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: null,
    signalTriggerTime: null,
    executedAt: '2026-07-11T10:00:00.000+08:00',
    executedAtMs: Date.parse('2026-07-11T10:00:00+08:00'),
    timestamp: '2026-07-11T10:00:01.000+08:00',
    isProtectiveClearance: false,
  };
}

function listTempFiles(rootDir: string): ReadonlyArray<string> {
  const tradesDir = path.join(rootDir, 'trades');
  return fs.existsSync(tradesDir)
    ? fs.readdirSync(tradesDir).filter((fileName) => fileName.endsWith('.tmp'))
    : [];
}

describe('mixedTradeLogRepository', () => {
  it('derives the completion protocol envelope from domain input', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-domain-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createRecord();

    store.appendCompletionIdempotent({
      monitorSymbol: record.monitorSymbol,
      direction: record.direction,
      boundaryExecutedTimeMs: record.boundaryExecutedTimeMs,
      orderBaselines: record.orderBaselines,
    });
    expect(store.loadCompletionRecords(record.tradingDayKey)).toEqual([record]);
  });

  it('derives the execution-progress protocol envelope from domain input', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-progress-domain-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createProgressRecord();

    store.appendExecutionProgressIdempotent({
      monitorSymbol: record.monitorSymbol,
      direction: record.direction,
      symbol: record.symbol,
      orderId: record.orderId,
      factStage: record.factStage,
      cumulativeQuantity: record.cumulativeQuantity,
      cumulativeAmount: record.cumulativeAmount,
      lastExecutionTimeMs: record.lastExecutionTimeMs,
      orderRevisionMs: record.orderRevisionMs,
    });
    expect(store.loadExecutionProgressRecords(record.tradingDayKey)).toEqual([record]);
  });

  it('appends the same completion once and rejects a conflicting payload with the same id', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createRecord();

    store.appendCompletionIdempotent(toCompletionInput(record));
    store.appendCompletionIdempotent(toCompletionInput(record));
    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(record),
        orderBaselines: [{ ...record.orderBaselines[0]!, cumulativeAmount: '37' }],
      });
    }).toThrow(/completionId conflict/);
    expect(store.loadCompletionRecords('2026-07-11')).toEqual([record]);
  });

  it('appends the same execution progress once and rejects a conflicting payload with the same id', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-progress-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createProgressRecord();

    store.appendExecutionProgressIdempotent(toExecutionProgressInput(record));
    store.appendExecutionProgressIdempotent(toExecutionProgressInput(record));

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(record),
        cumulativeAmount: '37',
      });
    }).toThrow(/progressId conflict/);
    expect(store.loadExecutionProgressRecords('2026-07-11')).toEqual([record]);
  });

  it('stores OPEN and TERMINAL as distinct immutable facts at the same revision and quantity', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-progress-stage-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const openRecord = createProgressRecord();
    const terminalRecord = {
      ...openRecord,
      factStage: 'TERMINAL' as const,
      cumulativeAmount: '38',
      progressId: openRecord.progressId.replace(/:OPEN$/, ':TERMINAL'),
    };

    store.appendExecutionProgressIdempotent(toExecutionProgressInput(openRecord));
    store.appendExecutionProgressIdempotent(toExecutionProgressInput(terminalRecord));
    expect(store.loadExecutionProgressRecords('2026-07-11')).toEqual([openRecord, terminalRecord]);
    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(terminalRecord),
        cumulativeAmount: '39',
      });
    }).toThrow(/progressId conflict/);
  });

  it('strictly validates completion domain facts before deriving the protocol envelope', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-schema-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createRecord();

    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(record),
        boundaryExecutedTimeMs: Number.NaN,
      });
    }).toThrow(/trading day cannot be resolved|invalid V1 completion record/);

    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(record),
        monitorSymbol: '',
      });
    }).toThrow(/invalid V1 completion record/);

    expect(() => {
      store.appendCompletionIdempotent({ ...toCompletionInput(record), orderBaselines: [] });
    }).toThrow(/invalid V1 completion record/);
  });

  it('strictly validates execution-progress domain facts before deriving the protocol envelope', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-progress-schema-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createProgressRecord();

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(record),
        lastExecutionTimeMs: Number.NaN,
      });
    }).toThrow(/trading day cannot be resolved|invalid V1 execution progress record/);

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(record),
        orderRevisionMs: progressExecutionMs - 1,
      });
    }).toThrow(/invalid V1 execution progress record/);

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(record),
        cumulativeQuantity: '0.0',
      });
    }).toThrow(/invalid V1 execution progress record/);

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(record),
        cumulativeAmount: '0.00',
      });
    }).toThrow(/invalid V1 execution progress record/);
  });

  it('rejects the legacy completed reason instead of restoring it as a completion fact', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const logFile = buildTradeLogPath(rootDir, new Date('2026-07-11T04:00:00.000Z'));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      JSON.stringify([{ reason: 'PROTECTIVE_LIQUIDATION_COMPLETED' }]),
      'utf8',
    );
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });

    expect(() => store.loadCompletionRecords('2026-07-11')).toThrow(/legacy completion reason/);
  });

  it('rejects a completion whose trading day differs from the loaded file', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const logFile = buildTradeLogPath(rootDir, new Date('2026-07-11T04:00:00.000Z'));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const mismatched = {
      ...createRecord(),
      completionId: `v1:2026-07-10:HSI.HK:LONG:${String(Date.parse('2026-07-10T10:00:00+08:00'))}`,
      tradingDayKey: '2026-07-10',
      boundaryExecutedTimeMs: Date.parse('2026-07-10T10:00:00+08:00'),
    };
    fs.writeFileSync(logFile, JSON.stringify([mismatched]), 'utf8');
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });

    expect(() => store.loadCompletionRecords('2026-07-11')).toThrow(/trading day mismatch/);
  });

  it('strictly rejects malformed trade records and unknown typed records', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const logFile = buildTradeLogPath(rootDir, new Date('2026-07-11T04:00:00.000Z'));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });

    fs.writeFileSync(logFile, JSON.stringify([{ ...createTradeRecord(), extra: true }]), 'utf8');
    expect(() => store.loadCompletionRecords('2026-07-11')).toThrow(/unexpected field/);

    fs.writeFileSync(logFile, JSON.stringify([{ recordType: 'UNKNOWN' }]), 'utf8');
    expect(() => store.loadCompletionRecords('2026-07-11')).toThrow(/unknown recordType/);
  });

  it('preserves a completion record when the same mixed-log repository appends a trade record', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const completionRecord = createRecord();
    const tradeRecord = createTradeRecord();

    store.appendCompletionIdempotent(toCompletionInput(completionRecord));
    store.appendTradeRecord(tradeRecord);

    const logFile = buildTradeLogPath(rootDir, new Date(tradeRecord.executedAtMs));
    expect(JSON.parse(fs.readFileSync(logFile, 'utf8'))).toEqual([completionRecord, tradeRecord]);
  });

  it('preserves a trade record when the same mixed-log repository appends a completion', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const completionRecord = createRecord();
    const tradeRecord = createTradeRecord();

    store.appendTradeRecord(tradeRecord);
    store.appendCompletionIdempotent(toCompletionInput(completionRecord));

    const logFile = buildTradeLogPath(rootDir, new Date(tradeRecord.executedAtMs));
    expect(JSON.parse(fs.readFileSync(logFile, 'utf8'))).toEqual([tradeRecord, completionRecord]);
  });

  it('removes the temporary file when writing the replacement fails', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('write failed');
    });

    try {
      expect(() => {
        store.appendCompletionIdempotent(toCompletionInput(createRecord()));
      }).toThrow('write failed');
      expect(listTempFiles(rootDir)).toEqual([]);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('removes the temporary file when fsync fails', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('fsync failed');
    });

    try {
      expect(() => {
        store.appendCompletionIdempotent(toCompletionInput(createRecord()));
      }).toThrow('fsync failed');
      expect(listTempFiles(rootDir)).toEqual([]);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  it('removes the temporary file and preserves the original log when rename fails', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protective-completion-'));
    tempDirs.push(rootDir);
    const store = createMixedTradeLogRepository({
      resolveLogRootDir: () => rootDir,
    });
    const record = createRecord();
    store.appendCompletionIdempotent(toCompletionInput(record));
    const logFile = buildTradeLogPath(rootDir, new Date('2026-07-11T04:00:00.000Z'));
    const original = fs.readFileSync(logFile, 'utf8');
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });

    try {
      expect(() => {
        store.appendTradeRecord(createTradeRecord());
      }).toThrow('rename failed');
      expect(fs.readFileSync(logFile, 'utf8')).toBe(original);
      expect(listTempFiles(rootDir)).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
