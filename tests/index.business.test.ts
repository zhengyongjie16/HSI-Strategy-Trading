/**
 * src/index 入口业务测试
 *
 * 每个场景在独立子进程内 mock runApp/logger，避免关闭共享 logger 或污染其他测试。
 * 覆盖原始环境对象、错误分类、真实待定关闭与退出码矩阵；不执行交易组装。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from './setup/childEnv.js';

/** 保留真实 process.exit 和待关闭 Promise，用事件顺序证明入口未提前结束。 */
function probeEntry(scenario: {
  readonly appResult: 'success' | 'config' | 'abort' | 'error' | 'null' | 'undefined';
  readonly shutdownResult: boolean | 'reject';
  readonly exitCode?: number;
}) {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'index-business-'));
  try {
    const tracePath = path.join(isolationRoot, 'trace.json');
    const script = `
      import { mock } from 'bun:test';
      import { writeFileSync } from 'node:fs';

      const scenario = ${JSON.stringify(scenario)};
      const trace = [];
      const shutdownError = new Error('shutdown contract failure');
      let businessError;
      switch (scenario.appResult) {
        case 'config':
          businessError = new Error('missing env');
          businessError.name = 'ConfigValidationError';
          break;
        case 'abort':
          businessError = new Error('startup aborted');
          businessError.name = 'AppStartupAbortError';
          break;
        case 'error':
          businessError = new Error('boom');
          break;
        case 'null':
          businessError = null;
          break;
      }

      if (scenario.exitCode !== undefined) process.exitCode = scenario.exitCode;
      const originalExit = process.exit.bind(process);
      process.exit = (...args) => {
        trace.push(args.length === 0 ? 'exit:default' : 'exit:' + String(args[0]));
        return originalExit(...args);
      };
      process.on('exit', (code) => {
        trace.push('process:exit:' + code);
        writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(trace));
      });

      const originalConsoleError = console.error.bind(console);
      console.error = (...args) => {
        trace.push('stderr:' + String(args[0]));
        if (args.length === 2) {
          trace.push(args[1] === businessError
            ? 'error:original-business'
            : args[1] === shutdownError ? 'error:shutdown' : 'error:unexpected');
        } else if (args.length !== 1) {
          trace.push('error:unexpected-args');
        }
        originalConsoleError(...args);
      };

      mock.module(${JSON.stringify(new URL('../src/app/runApp.ts', import.meta.url).href)}, () => ({
        runApp: async ({ env }) => {
          trace.push(env === process.env ? 'runApp:current-env' : 'runApp:replaced-env');
          if (scenario.appResult !== 'success') throw businessError;
        },
      }));
      mock.module(${JSON.stringify(new URL('../src/infrastructure/logger/index.ts', import.meta.url).href)}, () => ({
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        shutdownLogger: () => {
          trace.push('shutdown:start');
          // false/reject 后保留真实活跃句柄；必须由入口结束，不能冒充自然返回。
          if (scenario.shutdownResult !== true) setInterval(() => {}, 1000);
          return new Promise((resolve, reject) => {
            setImmediate(() => {
              trace.push('shutdown:pending');
              setImmediate(() => {
                trace.push('shutdown:' + String(scenario.shutdownResult));
                if (scenario.shutdownResult === 'reject') reject(shutdownError);
                else resolve(scenario.shutdownResult);
              });
            });
          });
        },
      }));

      await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
      trace.push('entry:returned');
    `;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--no-env-file',
        '--preload',
        fileURLToPath(
          new URL('infrastructure/longbridge/trade/offlineSdkGuard.ts', import.meta.url),
        ),
        '--eval',
        script,
      ],
      cwd: isolationRoot,
      env: createChildEnv(isolationRoot),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const stderr = result.stderr.toString();
    expect(result.signalCode, stderr).toBeFalsy();
    expect(result.stdout.toString()).toBe('');
    const trace: unknown = JSON.parse(readFileSync(tracePath, 'utf8'));
    return { exitCode: result.exitCode, stderr, trace };
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

const appOutcomes = [
  { result: 'success', reports: [] },
  { result: 'config', reports: ['stderr:程序启动失败：配置验证未通过'] },
  { result: 'abort', reports: [] },
  { result: 'error', reports: ['stderr:程序异常退出', 'error:original-business'] },
  { result: 'null', reports: ['stderr:程序异常退出', 'error:original-business'] },
  { result: 'undefined', reports: ['stderr:程序异常退出', 'error:original-business'] },
] as const;

const shutdownErrorReports = ['stderr:日志关闭异常', 'error:shutdown'];

describe('src/index entry flow', () => {
  for (const app of appOutcomes) {
    for (const shutdownResult of [true, false, 'reject'] as const) {
      it(`${app.result} waits for shutdown ${shutdownResult} before returning or exiting`, () => {
        const result = probeEntry({
          appResult: app.result,
          shutdownResult,
          ...(app.result === 'success' ? {} : { exitCode: 23 }),
        });
        const hasFailed = app.result !== 'success' || shutdownResult === 'reject';
        const expectedExitCode = hasFailed ? 1 : 0;
        expect(result.exitCode, result.stderr).toBe(expectedExitCode);
        expect(result.trace).toEqual([
          'runApp:current-env',
          ...app.reports,
          'shutdown:start',
          'shutdown:pending',
          `shutdown:${shutdownResult}`,
          ...(shutdownResult === 'reject' ? shutdownErrorReports : []),
          ...(hasFailed ? ['exit:1'] : [shutdownResult ? 'entry:returned' : 'exit:default']),
          `process:exit:${expectedExitCode}`,
        ]);

        if (shutdownResult === 'reject') {
          expect(result.stderr).toContain('日志关闭异常');
          expect(result.stderr).toContain('shutdown contract failure');
        }

        if (app.reports.length === 0 && shutdownResult !== 'reject') {
          expect(result.stderr).toBe('');
        }
      }, 20_000);
    }
  }

  for (const shutdownResult of [true, false]) {
    it(`successful app preserves an existing exitCode after shutdown ${shutdownResult}`, () => {
      const result = probeEntry({ appResult: 'success', shutdownResult, exitCode: 23 });
      expect(result.exitCode, result.stderr).toBe(23);
      expect(result.stderr).toBe('');
      expect(result.trace).toEqual([
        'runApp:current-env',
        'shutdown:start',
        'shutdown:pending',
        `shutdown:${shutdownResult}`,
        shutdownResult ? 'entry:returned' : 'exit:default',
        'process:exit:23',
      ]);
    }, 20_000);
  }
});
