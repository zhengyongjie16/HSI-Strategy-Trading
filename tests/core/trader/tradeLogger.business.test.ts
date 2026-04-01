/**
 * tradeLogger 业务测试
 *
 * 覆盖当前职责：
 * - 运行时装配后通过 facade 写入交易日志
 * - reset 后恢复为空实现，避免跨用例泄漏
 * - 写盘时使用注入的 env/fs/path 边界
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '../../../src/utils/logger/types.js';
import { getHKDateKey } from '../../../src/utils/time/index.js';
import {
  createTradeLoggerRuntime,
  installTradeLogger,
  recordTrade,
  resetTradeLogger,
} from '../../../src/core/trader/tradeLogger.js';
import type { TradeRecord } from '../../../src/types/trader.js';

function createLoggerDouble(): {
  readonly logger: Logger;
  readonly calls: ReadonlyArray<{ readonly level: string; readonly msg: string }>;
} {
  const calls: Array<{ readonly level: string; readonly msg: string }> = [];
  return {
    logger: {
      debug: (msg: string) => {
        calls.push({ level: 'debug', msg });
      },
      info: (msg: string) => {
        calls.push({ level: 'info', msg });
      },
      warn: (msg: string) => {
        calls.push({ level: 'warn', msg });
      },
      error: (msg: string) => {
        calls.push({ level: 'error', msg });
      },
    },
    calls,
  };
}

function createTradeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    orderId: 'ORDER-001',
    symbol: 'HSI.BULL',
    symbolName: 'HSI Bull',
    baseInstrumentSymbol: 'HSI.HK',
    action: 'BUYCALL',
    side: 'BUY',
    quantity: '100',
    price: '1.23',
    orderType: 'ELO',
    status: 'FILLED',
    error: null,
    reason: null,
    signalTriggerTime: '2026/03/31/10:00:00',
    executedAt: '2026/03/31/10:01:00',
    executedAtMs: Date.parse('2026-03-31T02:01:00.000Z'),
    timestamp: null,
    isProtectiveClearance: false,
    ...overrides,
  };
}

describe('tradeLogger module', () => {
  afterEach(() => {
    resetTradeLogger();
  });

  it('writes normalized trade records through the installed runtime and resets cleanly', () => {
    const tempRootDir = mkdtempSync(path.join(tmpdir(), 'trade-logger-'));
    const { logger, calls } = createLoggerDouble();

    try {
      const runtime = createTradeLoggerRuntime({
        deps: {
          env: {
            APP_RUNTIME_PROFILE: 'test',
            APP_LOG_ROOT_DIR: tempRootDir,
            DEBUG: 'false',
          },
          fs: {
            createWriteStream,
            existsSync,
            mkdirSync: (dirPath: string, options: { readonly recursive: boolean }) => {
              mkdirSync(dirPath, options);
            },
            readdirSync,
            readFileSync: (filePath: string, encoding: BufferEncoding) =>
              readFileSync(filePath, encoding),
            statSync,
            unlinkSync,
            writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => {
              writeFileSync(filePath, data, encoding);
            },
          },
          joinPath: (...parts: ReadonlyArray<string>) => path.join(...parts),
          logger,
          stderr: process.stderr,
        },
      });

      installTradeLogger(runtime.recordTrade);
      recordTrade(createTradeRecord());

      const logFile = path.join(tempRootDir, 'trades', `${getHKDateKey(new Date())}.json`);
      expect(existsSync(logFile)).toBeTrue();

      const parsedAfterInstall: unknown = JSON.parse(readFileSync(logFile, 'utf8'));
      if (!Array.isArray(parsedAfterInstall)) {
        throw new TypeError('expected trade log to be an array');
      }

      expect(parsedAfterInstall).toHaveLength(1);
      expect(parsedAfterInstall[0]).toMatchObject({
        orderId: 'ORDER-001',
        symbol: 'HSI.BULL',
        timestamp: expect.any(String),
        executedAtMs: Date.parse('2026-03-31T02:01:00.000Z'),
      });
      expect(calls).toEqual([]);

      resetTradeLogger();
      recordTrade(
        createTradeRecord({
          orderId: 'ORDER-002',
        }),
      );

      const parsedAfterReset: unknown = JSON.parse(readFileSync(logFile, 'utf8'));
      if (!Array.isArray(parsedAfterReset)) {
        throw new TypeError('expected trade log to be an array');
      }

      expect(parsedAfterReset).toHaveLength(1);
    } finally {
      rmSync(tempRootDir, { recursive: true, force: true });
    }
  });
});
