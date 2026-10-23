/**
 * logger 子进程验收夹具
 *
 * 仅在隔离进程替换现有 fs / 标准流边界；不导入 logger、不开放生产测试接口。
 */
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { createChildEnv } from '../../setup/childEnv.js';
import type {
  ControlledFile,
  ControlledFileBoundary,
  FileBoundaryOptions,
  LoggerProcessOptions,
  LoggerProcessResult,
  StandardBoundary,
  WriteCallback,
} from './types.js';

export const loggerImport = `const { logger, shutdownLogger } = await import(${JSON.stringify(
  pathToFileURL(path.resolve(import.meta.dir, '../../../src/infrastructure/logger/index.ts')).href,
)});`;

export const fixtureImport = `const { installControlledFiles, installStandardBoundary, nextTurn, waitUntil } = await import(${JSON.stringify(
  pathToFileURL(import.meta.path).href,
)});`;

/** 显式控制 Date，不伪造 timer；总超时验收始终使用真实 performance 时钟。 */
export const clockSource = `
  const NativeDate = Date;
  let clock = NativeDate.parse('2026-02-13T15:59:59.123Z');
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
`;

/**
 * 使用白名单环境启动真实 logger；父级 watchdog 杀死进程始终判为失败。
 * 同时读取两个管道，避免子进程因父进程未消费输出而产生假背压。
 */
export async function withLoggerProcess(
  body: string,
  assertResult: (result: LoggerProcessResult) => void = () => {},
  options: LoggerProcessOptions = {},
): Promise<void> {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'logger-behavior-'));
  const env = createChildEnv(isolationRoot);
  const logRootDir = env['APP_LOG_ROOT_DIR'];
  assert.ok(logRootDir);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let cleanupChild: (() => Promise<void>) | undefined;
  try {
    const startedAt = performance.now();
    const marker = '\n__LOGGER_PROBE_COMPLETE__\n';
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        '--no-env-file',
        '--eval',
        [
          "import assert from 'node:assert/strict';",
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          'const logRootDir = process.env.APP_LOG_ROOT_DIR;',
          body,
          `process.stdout.write(${JSON.stringify(marker)});`,
        ].join('\n'),
      ],
      cwd: isolationRoot,
      env: {
        ...env,
        DEBUG: options.debug ?? 'false',
        APP_ENABLE_PROCESS_HOOKS: String(options.enableProcessHooks ?? false),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    cleanupChild = async (): Promise<void> => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    };
    let timedOut = false;
    watchdog = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.watchdogMs ?? 10_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(watchdog);
    assert.equal(timedOut, false, `logger 子进程触发父级 watchdog\n${stdout}\n${stderr}`);
    assert.equal(exitCode, options.expectedExitCode ?? 0, `${stdout}\n${stderr}`);
    if (exitCode === 0) {
      assert.ok(stdout.includes(marker), `logger 子进程未完成全部断言\n${stdout}\n${stderr}`);
    }

    assertResult({
      exitCode,
      stdout: stdout.replace(marker, ''),
      stderr,
      logRootDir,
      elapsedMs: performance.now() - startedAt,
    });
  } finally {
    clearTimeout(watchdog);
    if (cleanupChild) {
      await cleanupChild();
    }

    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

/** 让出一轮事件循环，使受控回调的 microtask / stream 生命周期推进。 */
export async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** 只等待边界状态到达，不以固定 sleep 推测 IO 已完成。 */
export async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - startedAt < 2000, `未到达可控 IO 状态：${description}`);
    await nextTurn();
  }
}

/** 用原生 Writable 控制 write / final / destroy 回调，保留真实背压和 close 语义。 */
export function installControlledFiles(options: FileBoundaryOptions = {}): ControlledFileBoundary {
  const files: ControlledFile[] = [];
  const heldWrites = new Set(options.heldWrites);
  const heldFinals = new Set(options.heldFinals);
  const heldDestroys = new Set(options.heldDestroys);
  const originalCreateWriteStream = fs.createWriteStream;

  fs.createWriteStream = ((filePath: fs.PathLike, writeOptions?: unknown) => {
    const name = String(filePath);
    const subDir = path.basename(path.dirname(name));
    const writes: string[] = [];
    const pendingWrites: WriteCallback[] = [];
    const pendingFinals: WriteCallback[] = [];
    const pendingDestroys: WriteCallback[] = [];
    const stream = new Writable({
      highWaterMark: options.highWaterMark ?? 16_384,
      write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
        writes.push(chunk.toString());
        if (heldWrites.has(subDir)) {
          pendingWrites.push(callback);
        } else {
          callback();
        }
      },
      final(callback: WriteCallback): void {
        if (heldFinals.has(subDir)) {
          pendingFinals.push(callback);
        } else {
          callback();
        }
      },
      destroy(error: Error | null, callback: WriteCallback): void {
        if (heldDestroys.has(subDir)) {
          pendingDestroys.push(callback);
        } else {
          callback(error);
        }
      },
    });
    files.push({
      name,
      subDir,
      writes,
      pendingWrites,
      pendingFinals,
      pendingDestroys,
      stream,
      writeOptions,
    });
    return stream as fs.WriteStream;
  });

  return {
    files,
    heldWrites,
    heldFinals,
    heldDestroys,
    restore: () => {
      fs.createWriteStream = originalCreateWriteStream;
    },
  };
}

/** 拦截标准流尾部空写回调，并记录诊断与屏障的顺序；永不关闭全局标准流。 */
export function installStandardBoundary(): StandardBoundary {
  const events: string[] = [];
  const barriers = new Map<string, WriteCallback>();
  const blockedWrites = new Set<string>();
  const originals = [process.stdout.write, process.stderr.write];
  const originalConsoleError = console.error;

  // Bun 的 console.error 原生直写 fd，需独立观察，不能假设它经过 JS 的 stderr.write。
  console.error = (...values: ReadonlyArray<unknown>): void => {
    events.push(`stderr:${format(...values)}\n`);
    originalConsoleError(...values);
  };

  for (const [name, stream] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr],
  ] as const) {
    const originalWrite = stream.write.bind(stream);
    stream.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      events.push(`${name}:${text}`);
      if (text === '') {
        const complete = typeof encoding === 'function' ? encoding : callback;
        assert.ok(complete, '标准流屏障必须使用 write callback');
        barriers.set(name, complete);
        return true;
      }

      let accepted: boolean;
      if (typeof encoding === 'function') {
        accepted = originalWrite(chunk, encoding);
      } else if (encoding === undefined) {
        accepted = originalWrite(chunk, callback);
      } else {
        accepted = originalWrite(chunk, encoding, callback);
      }

      return blockedWrites.has(name) ? false : accepted;
    });
  }

  return {
    events,
    barriers,
    blockedWrites,
    restore: () => {
      process.stdout.write = originals[0]!;
      process.stderr.write = originals[1]!;
      console.error = originalConsoleError;
    },
  };
}
