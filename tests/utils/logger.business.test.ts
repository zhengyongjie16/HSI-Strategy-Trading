/**
 * logger 模块业务测试
 *
 * 功能：
 * - 验证 logger facade 的安装与重置行为
 * - 验证 logger runtime 的进程 hook 注册边界
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import {
  createLoggerRuntime,
  installLogger,
  logger,
  retainLatestLogFiles,
  resetLogger,
} from '../../src/utils/logger/index.js';
import type { Logger, LoggerProcessLike } from '../../src/utils/logger/types.js';

function createProcessLikeDouble(): {
  readonly processLike: LoggerProcessLike;
  readonly handlers: Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>;
  readonly exitCodes: number[];
} {
  const handlers = new Map<string, Array<(...args: ReadonlyArray<unknown>) => void>>();
  const exitCodes: number[] = [];
  const processLike: LoggerProcessLike = {
    on(event, listener) {
      const registeredHandlers = handlers.get(event) ?? [];
      registeredHandlers.push(listener);
      handlers.set(event, registeredHandlers);
      return processLike;
    },
    exit(code?: number) {
      exitCodes.push(code ?? 0);
    },
  };

  return {
    processLike,
    handlers,
    exitCodes,
  };
}

function createLoggerRuntimeDepsDouble() {
  return {
    createWritable: ({
      write,
    }: {
      readonly write: (
        chunk: Buffer,
        encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) => void;
    }) =>
      new Writable({
        write(chunk, encoding, callback) {
          write(chunk, encoding, callback);
        },
      }),
    createPinoLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      flush: () => {},
    }),
    fs: {
      createWriteStream,
      existsSync,
      mkdirSync,
      readdirSync,
      statSync,
      unlinkSync,
    },
    joinPath: (...parts: ReadonlyArray<string>) => path.join(...parts),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

describe('logger module', () => {
  afterEach(() => {
    resetLogger();
  });

  it('routes facade calls to the installed logger and can be reset', () => {
    const calls: string[] = [];
    const installedLogger: Logger = {
      debug: (msg: string, extra?: unknown) => {
        calls.push(`debug:${msg}:${extra === undefined ? 'none' : 'extra'}`);
      },
      info: (msg: string, extra?: unknown) => {
        calls.push(`info:${msg}:${extra === undefined ? 'none' : 'extra'}`);
      },
      warn: (msg: string, extra?: unknown) => {
        calls.push(`warn:${msg}:${extra === undefined ? 'none' : 'extra'}`);
      },
      error: (msg: string, extra?: unknown) => {
        calls.push(`error:${msg}:${extra === undefined ? 'none' : 'extra'}`);
      },
    };

    installLogger(installedLogger);
    logger.debug('debug message');
    logger.info('info message', { a: 1 });
    logger.warn('warn message');
    logger.error('error message', new Error('boom'));

    resetLogger();
    logger.info('after reset');

    expect(calls).toEqual([
      'debug:debug message:none',
      'info:info message:extra',
      'warn:warn message:none',
      'error:error message:extra',
    ]);
  });

  it('registers process hooks once when hook installation is enabled', () => {
    const tempRootDir = mkdtempSync(path.join(tmpdir(), 'logger-runtime-'));
    const processLike = createProcessLikeDouble();

    try {
      const runtime = createLoggerRuntime({
        env: {
          APP_RUNTIME_PROFILE: 'test',
          APP_ENABLE_PROCESS_HOOKS: 'true',
          APP_LOG_ROOT_DIR: tempRootDir,
          DEBUG: 'false',
        },
        processLike: processLike.processLike,
        deps: createLoggerRuntimeDepsDouble(),
      });

      runtime.registerProcessHooks();
      runtime.registerProcessHooks();

      expect(processLike.handlers.get('beforeExit')).toHaveLength(1);
      expect(processLike.handlers.get('exit')).toHaveLength(1);
      expect(processLike.handlers.get('uncaughtException')).toHaveLength(1);
      expect(processLike.handlers.get('unhandledRejection')).toHaveLength(1);
      expect(processLike.exitCodes).toEqual([]);

      runtime.cleanupSync();
    } finally {
      rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  it('invokes exit(1) when an uncaught exception hook is triggered', () => {
    const tempRootDir = mkdtempSync(path.join(tmpdir(), 'logger-runtime-'));
    const processLike = createProcessLikeDouble();

    try {
      const runtime = createLoggerRuntime({
        env: {
          APP_RUNTIME_PROFILE: 'test',
          APP_ENABLE_PROCESS_HOOKS: 'true',
          APP_LOG_ROOT_DIR: tempRootDir,
          DEBUG: 'false',
        },
        processLike: processLike.processLike,
        deps: createLoggerRuntimeDepsDouble(),
      });

      runtime.registerProcessHooks();
      const uncaughtHandler = processLike.handlers.get('uncaughtException')?.[0];
      if (uncaughtHandler === undefined) {
        throw new Error('missing uncaughtException handler');
      }

      uncaughtHandler(new Error('boom'));

      expect(processLike.exitCodes).toEqual([1]);

      runtime.cleanupSync();
    } finally {
      rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  it('skips process hook registration when hook installation is disabled', () => {
    const tempRootDir = mkdtempSync(path.join(tmpdir(), 'logger-runtime-'));
    const processLike = createProcessLikeDouble();

    try {
      const runtime = createLoggerRuntime({
        env: {
          APP_RUNTIME_PROFILE: 'test',
          APP_ENABLE_PROCESS_HOOKS: 'false',
          APP_LOG_ROOT_DIR: tempRootDir,
          DEBUG: 'false',
        },
        processLike: processLike.processLike,
        deps: createLoggerRuntimeDepsDouble(),
      });

      runtime.registerProcessHooks();

      expect(processLike.handlers.size).toBe(0);
      expect(processLike.exitCodes).toEqual([]);

      runtime.cleanupSync();
    } finally {
      rmSync(tempRootDir, { recursive: true, force: true });
    }
  });

  it('retains only the latest json logs through the injected fs boundary', () => {
    const tempRootDir = mkdtempSync(path.join(tmpdir(), 'logger-retain-'));
    const logDir = path.join(tempRootDir, 'trades');

    try {
      const createdDir = mkdirSync(logDir, { recursive: true });
      expect(createdDir === undefined || typeof createdDir === 'string').toBeTrue();
      writeFileSync(path.join(logDir, '2026-03-29.json'), '[]', 'utf8');
      writeFileSync(path.join(logDir, '2026-03-30.json'), '[]', 'utf8');
      writeFileSync(path.join(logDir, '2026-03-31.json'), '[]', 'utf8');

      retainLatestLogFiles(
        {
          fs: {
            createWriteStream,
            existsSync,
            mkdirSync: (dirPath: string, options: { readonly recursive: boolean }) => {
              mkdirSync(dirPath, options);
            },
            readdirSync,
            statSync,
            unlinkSync,
          },
          joinPath: (...parts: ReadonlyArray<string>) => path.join(...parts),
          stderr: process.stderr,
        },
        logDir,
        2,
        'json',
        '2026-03-31.json',
      );

      expect(readdirSync(logDir).sort((left, right) => left.localeCompare(right))).toEqual([
        '2026-03-30.json',
        '2026-03-31.json',
      ]);
    } finally {
      rmSync(tempRootDir, { recursive: true, force: true });
    }
  });
});
