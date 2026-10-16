/**
 * 日志基础设施业务测试
 *
 * 在独立进程中锁定真实 pino/file 输出和进程钩子，避免修改测试进程的全局 logger 状态。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const loggerModuleUrl = pathToFileURL(
  path.resolve(import.meta.dir, '../../../src/infrastructure/logger/index.ts'),
).href;

/** 在临时日志目录运行真实 logger 子进程，并在断言完成后清理其输出。 */
function withLoggerProcess(
  body: string,
  enableProcessHooks: boolean,
  assertResult: (
    result: Readonly<{
      exitCode: number;
      stdout: string;
      stderr: string;
      logRootDir: string;
    }>,
  ) => void,
): void {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'logger-adapter-test-'));
  const logRootDir = path.join(isolationRoot, 'logs');
  try {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--no-env-file',
        '-e',
        `const { logger } = await import(${JSON.stringify(loggerModuleUrl)});\n${body}`,
      ],
      cwd: isolationRoot,
      env: {
        ...process.env,
        APP_LOG_ROOT_DIR: logRootDir,
        APP_RUNTIME_PROFILE: 'test',
        APP_ENABLE_PROCESS_HOOKS: String(enableProcessHooks),
        DEBUG: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assertResult({
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      logRootDir,
    });
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

describe('logger adapter', () => {
  it('keeps stdout/stderr routing, structured extras and ANSI-free file output', () => {
    withLoggerProcess(
      [
        "logger.debug('hidden-debug');",
        "logger.info('adapter-info', { value: 7 });",
        String.raw`logger.warn('\u001b[33madapter-warning\u001b[0m');`,
      ].join('\n'),
      false,
      ({ exitCode, stdout, stderr, logRootDir }) => {
        expect(exitCode).toBe(0);
        expect(stdout).toContain('adapter-info {"value":7}');
        expect(stdout).not.toContain('adapter-warning');
        expect(stdout).not.toContain('hidden-debug');
        expect(stderr).toContain('adapter-warning');
        const systemDir = path.join(logRootDir, 'system');
        const fileName = readdirSync(systemDir)[0];
        expect(fileName).toBeDefined();
        const file = readFileSync(path.join(systemDir, fileName ?? ''), 'utf8');
        expect(file).toContain('adapter-info {"value":7}');
        expect(file).toContain('adapter-warning');
        expect(file).not.toContain('\u001B[');
      },
    );
  });

  it('keeps unhandled rejection reporting non-exiting when hooks are enabled', () => {
    withLoggerProcess(
      [
        "const reason = Object.assign(new Error('original-rejection'), { marker: 'original-rejection' });",
        "process.emit('unhandledRejection', reason, Promise.resolve());",
        "logger.info('after-rejection');",
      ].join('\n'),
      true,
      ({ exitCode, stdout, stderr }) => {
        expect(exitCode).toBe(0);
        expect(stdout).toContain('after-rejection');
        expect(stderr).toContain('未处理的 Promise 拒绝');
        expect(stderr).toContain('original-rejection');
      },
    );
  });

  it('keeps uncaught exception reporting followed by exit code one', () => {
    withLoggerProcess(
      [
        "const original = Object.assign(new Error('original-uncaught'), { marker: 'original-uncaught' });",
        "process.emit('uncaughtException', original); logger.info('unreachable');",
      ].join('\n'),
      true,
      ({ exitCode, stdout, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stdout).not.toContain('unreachable');
        expect(stderr).toContain('未捕获的异常');
        expect(stderr).toContain('original-uncaught');
      },
    );
  });
});
