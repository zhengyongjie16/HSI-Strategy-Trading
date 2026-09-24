/**
 * mixed trade log repository 业务测试。
 *
 * 覆盖严格 JSONL preflight、混合记录恢复、幂等追加、故障封锁与按日期文件数留存。
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

function createRootDir(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-trade-log-'));
  tempDirs.push(rootDir);
  return rootDir;
}

function createStore(rootDir: string): ReturnType<typeof createMixedTradeLogRepository> {
  return createMixedTradeLogRepository({ resolveLogRootDir: () => rootDir });
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createRecordForDay(tradingDayKey: string): ProtectiveLiquidationCompletionRecordV1 {
  const boundaryExecutedTimeMs = Date.parse(`${tradingDayKey}T10:00:00+08:00`);
  const lastExecutionTimeMs = Date.parse(`${tradingDayKey}T09:59:00+08:00`);
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
    schemaVersion: 1,
    completionId: `v1:${tradingDayKey}:HSI.HK:LONG:${String(boundaryExecutedTimeMs)}`,
    tradingDayKey,
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    boundaryExecutedTimeMs,
    orderBaselines: [
      {
        orderId: 'SELL-1',
        symbol: 'BULL.HK',
        side: 'SELL',
        cumulativeQuantity: '40',
        cumulativeAmount: '36',
        lastExecutionTimeMs,
        orderRevisionMs: boundaryExecutedTimeMs,
      },
    ],
  };
}

function createRecord(): ProtectiveLiquidationCompletionRecordV1 {
  return createRecordForDay('2026-07-11');
}

function createProgressRecordForDay(
  tradingDayKey: string,
): ProtectiveLiquidationExecutionProgressRecordV1 {
  const boundaryExecutedTimeMs = Date.parse(`${tradingDayKey}T10:00:00+08:00`);
  const lastExecutionTimeMs = Date.parse(`${tradingDayKey}T09:59:00+08:00`);
  return {
    recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS',
    schemaVersion: 1,
    progressId: `v1:${tradingDayKey}:HSI.HK:LONG:BULL.HK:SELL-1:${String(boundaryExecutedTimeMs)}:40:OPEN`,
    tradingDayKey,
    monitorSymbol: 'HSI.HK',
    direction: 'LONG',
    symbol: 'BULL.HK',
    orderId: 'SELL-1',
    factStage: 'OPEN',
    cumulativeQuantity: '40',
    cumulativeAmount: '36',
    lastExecutionTimeMs,
    orderRevisionMs: boundaryExecutedTimeMs,
  };
}

function createProgressRecord(): ProtectiveLiquidationExecutionProgressRecordV1 {
  return createProgressRecordForDay('2026-07-11');
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

function createTradeRecordForDay(tradingDayKey: string): PersistableTradeRecord {
  const executedAtMs = Date.parse(`${tradingDayKey}T10:00:00+08:00`);
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
    executedAt: `${tradingDayKey}T10:00:00.000+08:00`,
    executedAtMs,
    timestamp: `${tradingDayKey}T10:00:01.000+08:00`,
    isProtectiveClearance: false,
  };
}

function writeJsonl(
  rootDir: string,
  tradingDayKey: string,
  records: ReadonlyArray<unknown>,
): string {
  const logFile = buildTradeLogPath(rootDir, new Date(`${tradingDayKey}T10:00:00+08:00`));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return logFile;
}

function listDailyFiles(rootDir: string): ReadonlyArray<string> {
  const tradesDir = path.join(rootDir, 'trades');
  return fs.existsSync(tradesDir)
    ? fs
        .readdirSync(tradesDir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort((left, right) => left.localeCompare(right, 'en'))
    : [];
}

describe('mixedTradeLogRepository', () => {
  it('creates missing directories on first append and fsyncs only the file, then remains writable', () => {
    const rootDir = path.join(createRootDir(), 'not-created', 'logs');
    const record = createRecord();
    const originalFsyncSync = fs.fsyncSync;
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      expect(fs.fstatSync(descriptor).isFile()).toBe(true);
      originalFsyncSync(descriptor);
    });

    try {
      const store = createStore(rootDir);
      expect(fsyncSpy).toHaveBeenCalledTimes(0);
      expect(fs.existsSync(rootDir)).toBe(false);

      store.appendCompletionIdempotent(toCompletionInput(record));
      expect(fsyncSpy).toHaveBeenCalledTimes(1);
      store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      expect(fsyncSpy).toHaveBeenCalledTimes(2);

      const logFile = buildTradeLogPath(rootDir, new Date(completionBoundaryMs));
      expect(fs.readFileSync(logFile, 'utf8').split('\n')).toEqual([
        JSON.stringify(record),
        JSON.stringify(createTradeRecordForDay('2026-07-11')),
        '',
      ]);
      expect(store.loadCompletionRecords('2026-07-11')).toEqual([record]);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  it('derives completion and execution-progress envelopes and preserves their idempotency conflicts', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const completion = createRecord();
    const progress = createProgressRecord();

    store.appendCompletionIdempotent(toCompletionInput(completion));
    store.appendCompletionIdempotent(toCompletionInput(completion));
    store.appendExecutionProgressIdempotent(toExecutionProgressInput(progress));
    store.appendExecutionProgressIdempotent(toExecutionProgressInput(progress));

    expect(store.loadCompletionRecords('2026-07-11')).toEqual([completion]);
    expect(store.loadExecutionProgressRecords('2026-07-11')).toEqual([progress]);
    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(completion),
        orderBaselines: [{ ...completion.orderBaselines[0]!, cumulativeAmount: '37' }],
      });
    }).toThrow(/completionId conflict/);

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(progress),
        cumulativeAmount: '37',
      });
    }).toThrow(/progressId conflict/);
  });

  it('stores OPEN and TERMINAL progress as distinct immutable facts', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const openRecord = createProgressRecord();
    const terminalRecord: ProtectiveLiquidationExecutionProgressRecordV1 = {
      ...openRecord,
      factStage: 'TERMINAL',
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

  it('allows repeated ordinary trades while sharing the same mixed daily file', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const completion = createRecord();
    const trade = createTradeRecordForDay('2026-07-11');

    store.appendCompletionIdempotent(toCompletionInput(completion));
    store.appendTradeRecord(trade);
    store.appendTradeRecord(trade);

    const logFile = buildTradeLogPath(rootDir, new Date(trade.executedAtMs));
    const rows = fs
      .readFileSync(logFile, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(rows).toEqual([completion, trade, trade]);
  });

  it('starts with a fresh missing log root without creating it', () => {
    const parentDir = createRootDir();
    const rootDir = path.join(parentDir, 'not-created', 'logs');
    const store = createStore(rootDir);

    expect(store.loadCompletionRecords('2026-07-11')).toEqual([]);
    expect(fs.existsSync(rootDir)).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'trades'))).toBe(false);
  });

  it('scans each existing daily file once and serves later recovery reads and appends from cache', () => {
    const rootDir = createRootDir();
    const completion = createRecord();
    writeJsonl(rootDir, '2026-07-11', [completion]);
    const readSpy = spyOn(fs, 'readFileSync');

    try {
      const store = createStore(rootDir);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(store.loadCompletionRecords('2026-07-11')).toEqual([completion]);
      store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      expect(store.loadCompletionRecords('2026-07-11')).toEqual([completion]);
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('uses the strict mixed-record schema during repository preflight', () => {
    const malformedRecords: ReadonlyArray<{
      readonly record: unknown;
      readonly error: RegExp;
    }> = [
      { record: { recordType: 'UNKNOWN' }, error: /unknown recordType/ },
      {
        record: { ...createTradeRecordForDay('2026-07-11'), extra: true },
        error: /unexpected field/,
      },
    ];

    for (const { record, error } of malformedRecords) {
      const rootDir = createRootDir();
      writeJsonl(rootDir, '2026-07-11', [record]);
      expect(() => createStore(rootDir)).toThrow(error);
    }
  });

  it('strictly validates domain inputs before writing', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const completion = createRecord();
    const progress = createProgressRecord();

    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(completion),
        boundaryExecutedTimeMs: Number.NaN,
      });
    }).toThrow(/trading day cannot be resolved|invalid V1 completion record/);

    expect(() => {
      store.appendCompletionIdempotent({
        ...toCompletionInput(completion),
        orderBaselines: [],
      });
    }).toThrow(/invalid V1 completion record/);

    expect(() => {
      store.appendExecutionProgressIdempotent({
        ...toExecutionProgressInput(progress),
        orderRevisionMs: progressExecutionMs - 1,
      });
    }).toThrow(/invalid V1 execution progress record/);
    expect(listDailyFiles(rootDir)).toEqual([]);
  });

  it('rejects old JSON files and same-day dual formats without altering either file', () => {
    const rootDir = createRootDir();
    const logFile = buildTradeLogPath(rootDir, new Date(completionBoundaryMs));
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const legacyFile = logFile.replace(/\.jsonl$/, '.json');
    fs.writeFileSync(legacyFile, JSON.stringify([createRecord()]));
    fs.writeFileSync(logFile, `${JSON.stringify(createRecord())}\n`);

    expect(() => createStore(rootDir)).toThrow(
      /legacy JSON trade log requires manual reconciliation/,
    );
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(JSON.stringify([createRecord()]));
    expect(fs.readFileSync(logFile, 'utf8')).toBe(`${JSON.stringify(createRecord())}\n`);
  });

  it('rejects incomplete, malformed, CRLF, and invalid UTF-8 daily logs during preflight', () => {
    const cases: ReadonlyArray<{ readonly content: Buffer | string; readonly error: RegExp }> = [
      { content: '{"broken":true}', error: /incomplete JSONL final line/ },
      { content: '{broken}\n', error: /invalid JSONL line/ },
      {
        content: `${JSON.stringify(createTradeRecordForDay('2026-07-11'))}\r\n`,
        error: /invalid JSONL line/,
      },
      { content: Buffer.from([0xff, 0x0a]), error: /encoded data|UTF-8|encoding/i },
      {
        content: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(`${JSON.stringify(createTradeRecordForDay('2026-07-11'))}\n`),
        ]),
        error: /invalid JSONL line/,
      },
    ];

    for (const testCase of cases) {
      const rootDir = createRootDir();
      const logFile = buildTradeLogPath(rootDir, new Date(completionBoundaryMs));
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, testCase.content);
      expect(() => createStore(rootDir)).toThrow(testCase.error);
    }
  });

  it('rejects incomplete tagged records and legacy completion payloads during preflight', () => {
    const malformedTaggedRecords: ReadonlyArray<unknown> = [
      { recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION', schemaVersion: 1 },
      { recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS', schemaVersion: 1 },
      { ...createTradeRecordForDay('2026-07-11'), reason: 'PROTECTIVE_LIQUIDATION_COMPLETED' },
    ];

    for (const malformedRecord of malformedTaggedRecords) {
      const rootDir = createRootDir();
      writeJsonl(rootDir, '2026-07-11', [malformedRecord]);
      expect(() => createStore(rootDir)).toThrow();
    }
  });

  it('rejects stale cached files before identical-ID no-op returns', () => {
    const mutations: ReadonlyArray<{
      readonly mutate: (logFile: string) => void;
      readonly error: RegExp;
    }> = [
      {
        mutate: (logFile) => {
          fs.unlinkSync(logFile);
        },
        error: /cached daily file is no longer accessible/,
      },
      {
        mutate: (logFile) => {
          fs.truncateSync(logFile, 0);
        },
        error: /cached daily file changed/,
      },
      {
        mutate: (logFile) => {
          const replacementFile = `${logFile}.replacement`;
          fs.writeFileSync(replacementFile, `${JSON.stringify(createRecord())}\n`);
          fs.unlinkSync(logFile);
          fs.renameSync(replacementFile, logFile);
        },
        error: /cached daily file changed/,
      },
    ];

    for (const mutation of mutations) {
      const rootDir = createRootDir();
      const logFile = writeJsonl(rootDir, '2026-07-11', [createRecord()]);
      const store = createStore(rootDir);
      mutation.mutate(logFile);

      expect(() => {
        store.appendCompletionIdempotent(toCompletionInput(createRecord()));
      }).toThrow(mutation.error);
    }
  });

  it('does not recreate an existing daily path deleted after preflight', () => {
    const rootDir = createRootDir();
    const logFile = writeJsonl(rootDir, '2026-07-11', [createRecord()]);
    const store = createStore(rootDir);
    fs.unlinkSync(logFile);

    expect(() => {
      store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
    }).toThrow(/cached daily file is no longer accessible/);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('rejects cross-day records during the one-time scan', () => {
    const rootDir = createRootDir();
    const mismatched = {
      ...createRecord(),
      completionId: `v1:2026-07-10:HSI.HK:LONG:${String(Date.parse('2026-07-10T10:00:00+08:00'))}`,
      tradingDayKey: '2026-07-10',
      boundaryExecutedTimeMs: Date.parse('2026-07-10T10:00:00+08:00'),
    };
    writeJsonl(rootDir, '2026-07-11', [mismatched]);

    expect(() => createStore(rootDir)).toThrow(/completion trading day mismatch/);
  });

  it('permanently blocks after an uncertain write and leaves the damaged file untouched', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const writeSpy = spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('write result uncertain');
    });
    const record = createRecord();

    try {
      expect(() => {
        store.appendCompletionIdempotent(toCompletionInput(record));
      }).toThrow('write result uncertain');
      const logFile = buildTradeLogPath(rootDir, new Date(completionBoundaryMs));
      expect(fs.readFileSync(logFile, 'utf8')).toBe('');
      expect(() => store.loadCompletionRecords('2026-07-11')).toThrow(/blocked after uncertain/);
      expect(() => {
        store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow(/blocked after uncertain/);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('leaves a partial line untouched and blocks every later operation after an uncertain write', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    let writeCalls = 0;
    const writeSpy = spyOn(fs, 'writeSync');
    const partialWrite = (
      descriptor: number,
      buffer: ArrayBufferView,
      offset: number | null | undefined,
    ): number => {
      writeCalls++;
      if (writeCalls === 1) {
        const partialOffset = offset ?? 0;
        fs.writeFileSync(
          descriptor,
          Buffer.from(buffer as Uint8Array).subarray(partialOffset, partialOffset + 5),
        );
        return 5;
      }

      throw new Error('partial append uncertain');
    };
    writeSpy.mockImplementation(partialWrite as unknown as typeof fs.writeSync);

    try {
      expect(() => {
        store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow('partial append uncertain');
      const logFile = buildTradeLogPath(rootDir, new Date('2026-07-11T10:00:00+08:00'));
      expect(fs.readFileSync(logFile, 'utf8').endsWith('\n')).toBe(false);
      expect(() => {
        store.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow(/blocked after uncertain/);
      expect(writeCalls).toBe(2);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('blocks after file fsync or close errors without retrying the append', () => {
    const rootDir = createRootDir();
    const fsyncStore = createStore(path.join(rootDir, 'fsync'));
    const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('file fsync uncertain');
    });

    try {
      expect(() => {
        fsyncStore.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow('file fsync uncertain');

      expect(() => {
        fsyncStore.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow(/blocked after uncertain/);
    } finally {
      fsyncSpy.mockRestore();
    }

    const closeStore = createStore(path.join(rootDir, 'close'));
    const originalCloseSync = fs.closeSync;
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      originalCloseSync(descriptor);
      throw new Error('file close uncertain');
    });

    try {
      expect(() => {
        closeStore.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow('file close uncertain');

      expect(() => {
        closeStore.appendTradeRecord(createTradeRecordForDay('2026-07-11'));
      }).toThrow(/blocked after uncertain/);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('rejects same-ID completion and progress appends outside the seven-file window', () => {
    const rootDir = createRootDir();
    const dayKeys = [
      '2020-01-01',
      '2020-02-01',
      '2020-03-01',
      '2020-04-01',
      '2020-05-01',
      '2020-06-01',
      '2020-07-01',
      '2020-08-01',
    ];
    for (const dayKey of dayKeys) {
      writeJsonl(rootDir, dayKey, [createRecordForDay(dayKey), createProgressRecordForDay(dayKey)]);
    }

    const store = createStore(rootDir);
    const oldestDayKey = dayKeys[0]!;
    const oldestCompletion = createRecordForDay(oldestDayKey);
    const oldestProgress = createProgressRecordForDay(oldestDayKey);

    expect(() => {
      store.appendCompletionIdempotent(toCompletionInput(oldestCompletion));
    }).toThrow(/outside the latest 7 daily-file window/);

    expect(() => {
      store.appendExecutionProgressIdempotent(toExecutionProgressInput(oldestProgress));
    }).toThrow(/outside the latest 7 daily-file window/);
    expect(listDailyFiles(rootDir)).toHaveLength(8);
  });

  it('retains the latest seven existing date files rather than seven calendar days', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const dayKeys = [
      '2001-05-01',
      '2001-05-15',
      '2001-06-01',
      '2001-06-15',
      '2001-07-01',
      '2001-07-10',
      '2001-07-11',
      '2001-07-12',
    ];

    for (const dayKey of dayKeys) {
      store.appendTradeRecord(createTradeRecordForDay(dayKey));
      store.loadCompletionRecords(dayKey);
      store.loadExecutionProgressRecords(dayKey);
    }

    expect(listDailyFiles(rootDir)).toEqual(dayKeys.slice(1).map((dayKey) => `${dayKey}.jsonl`));
    expect(fs.existsSync(buildTradeLogPath(rootDir, new Date('2026-05-01T10:00:00+08:00')))).toBe(
      false,
    );
  });

  it('keeps a changed retention victim while appending the current daily record', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const dayKeys = [
      '2001-05-01',
      '2001-05-15',
      '2001-06-01',
      '2001-06-15',
      '2001-07-01',
      '2001-07-10',
      '2001-07-11',
    ];
    for (const dayKey of dayKeys) {
      store.appendTradeRecord(createTradeRecordForDay(dayKey));
    }

    const oldestFile = buildTradeLogPath(rootDir, new Date(`${dayKeys[0]}T10:00:00+08:00`));
    fs.appendFileSync(oldestFile, `${JSON.stringify(createTradeRecordForDay(dayKeys[0]!))}\n`);
    const targetFile = buildTradeLogPath(rootDir, new Date('2001-07-12T10:00:00+08:00'));

    expect(() => {
      store.appendTradeRecord(createTradeRecordForDay('2001-07-12'));
    }).not.toThrow();
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(oldestFile, 'utf8').split('\n')).toHaveLength(3);
    expect(listDailyFiles(rootDir)).toHaveLength(8);
  });

  it('keeps durable appends usable across partial retention cleanup failures', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const dayKeys = [
      '2001-05-01',
      '2001-05-15',
      '2001-06-01',
      '2001-06-15',
      '2001-07-01',
      '2001-07-10',
      '2001-07-11',
    ];
    for (const dayKey of dayKeys) {
      store.appendTradeRecord(createTradeRecordForDay(dayKey));
    }

    const firstPrunedFile = buildTradeLogPath(rootDir, new Date(`${dayKeys[0]}T10:00:00+08:00`));
    const secondPrunedFile = buildTradeLogPath(rootDir, new Date(`${dayKeys[1]}T10:00:00+08:00`));
    const originalUnlinkSync = fs.unlinkSync;
    let firstPrunedFileAttempts = 0;
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
      if (filePath === firstPrunedFile && firstPrunedFileAttempts++ === 0) {
        throw new Error('first retention unlink failed');
      }

      if (filePath === secondPrunedFile) {
        throw new Error('second retention unlink failed');
      }

      originalUnlinkSync(filePath);
    });
    const firstTargetDayKey = '2001-07-12';
    const secondTargetDayKey = '2001-07-13';
    const firstTargetFile = buildTradeLogPath(
      rootDir,
      new Date(`${firstTargetDayKey}T10:00:00+08:00`),
    );
    const secondTargetFile = buildTradeLogPath(
      rootDir,
      new Date(`${secondTargetDayKey}T10:00:00+08:00`),
    );

    try {
      const firstTargetRecord = createTradeRecordForDay(firstTargetDayKey);
      const secondTargetRecord = createTradeRecordForDay(secondTargetDayKey);
      store.appendTradeRecord(firstTargetRecord);
      store.appendTradeRecord(secondTargetRecord);

      expect(fs.readFileSync(firstTargetFile, 'utf8')).toBe(
        `${JSON.stringify(firstTargetRecord)}\n`,
      );

      expect(fs.readFileSync(secondTargetFile, 'utf8')).toBe(
        `${JSON.stringify(secondTargetRecord)}\n`,
      );
      expect(fs.existsSync(firstPrunedFile)).toBe(false);
      expect(fs.existsSync(secondPrunedFile)).toBe(true);
      expect(listDailyFiles(rootDir)).toHaveLength(8);
      expect(store.loadCompletionRecords(secondTargetDayKey)).toEqual([]);
      expect(unlinkSpy).toHaveBeenCalledTimes(3);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('fails late appends before writing when the missing target is outside a full seven-file window', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const dayKeys = [
      '2001-05-01',
      '2001-05-15',
      '2001-06-01',
      '2001-06-15',
      '2001-07-01',
      '2001-07-10',
      '2001-07-11',
    ];
    for (const dayKey of dayKeys) {
      store.appendTradeRecord(createTradeRecordForDay(dayKey));
    }

    const lateLog = buildTradeLogPath(rootDir, new Date('2000-01-01T10:00:00+08:00'));
    expect(() => {
      store.appendTradeRecord(createTradeRecordForDay('2000-01-01'));
    }).toThrow(/outside the latest 7 daily-file window/);
    expect(fs.existsSync(lateLog)).toBe(false);
    expect(listDailyFiles(rootDir)).toHaveLength(7);
  });

  it('does not prune a file already requested for recovery', () => {
    const rootDir = createRootDir();
    const store = createStore(rootDir);
    const dayKeys = [
      '2020-01-01',
      '2020-02-01',
      '2020-03-01',
      '2020-04-01',
      '2020-05-01',
      '2020-06-01',
      '2020-07-01',
    ];
    for (const dayKey of dayKeys) {
      store.appendTradeRecord(createTradeRecordForDay(dayKey));
    }

    store.loadCompletionRecords(dayKeys[0]!);

    const nextFile = buildTradeLogPath(rootDir, new Date('2020-08-01T10:00:00+08:00'));
    expect(() => {
      store.appendTradeRecord(createTradeRecordForDay('2020-08-01'));
    }).toThrow(/current or recovery-required day file/);
    expect(fs.existsSync(nextFile)).toBe(false);
  });

  it('builds the JSONL path from the Hong Kong day and rejects invalid dates', () => {
    const rootDir = createRootDir();
    expect(buildTradeLogPath(rootDir, new Date('2026-07-11T16:30:00.000Z'))).toBe(
      path.join(rootDir, 'trades', '2026-07-12.jsonl'),
    );
    expect(() => buildTradeLogPath(rootDir, new Date(Number.NaN))).toThrow(/日志日期无效/);
  });
});
