/**
 * dailyIndicatorAnalysis 入口业务测试
 *
 * 覆盖：
 * - 校验工具使用命令行标的、完成 OAuth 打开提示并请求分钟 K 线
 * - 校验当外部行情边界返回空结果时入口层按预期终止输出
 * - 在临时 cwd 验证 Bun 原生环境先交给认证，再以所得 config 发起行情查询
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from '../../setup/childEnv.js';
import { createSdkModuleMock } from '../../infrastructure/longbridge/trade/sdkModuleMock.js';

/** 在本文件首次 hook 前复制稳定 export 值；Bun module namespace 是 live binding，不作为还原来源。 */
const sdkModuleMock = createSdkModuleMock();
const originalAuthExports = Object.freeze({
  ...(await import('../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js')),
});

function reinstallOriginalModules(): void {
  sdkModuleMock.restore();
  void mock.module(
    '../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js',
    () => ({ ...originalAuthExports }),
  );
}

const authCalls: Array<{
  readonly env: NodeJS.ProcessEnv;
  readonly onOpenUrl?: (url: string) => void;
}> = [];
const quoteContextNewCalls: unknown[] = [];
const candlestickCalls: Array<ReadonlyArray<unknown>> = [];
const logCalls: string[] = [];
const errorCalls: Array<ReadonlyArray<unknown>> = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalArgv = [...process.argv];

async function registerLongbridgeMock(): Promise<void> {
  const quoteContext = {
    candlesticks: async (...args: ReadonlyArray<unknown>) => {
      candlestickCalls.push(args);
      return [];
    },
  };

  sdkModuleMock.install({
    AdjustType: {
      NoAdjust: 'NoAdjust',
    },
    Period: {
      Min_1: 'Min_1',
    },
    QuoteContext: {
      new: (config: unknown) => {
        quoteContextNewCalls.push(config);
        return quoteContext;
      },
    },
    TradeSessions: {
      Intraday: 'Intraday',
    },
  });
}

function registerAuthMock(): void {
  void mock.module(
    '../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js',
    () => ({
      createSdkConfigFromAuth: async (params: {
        readonly env: NodeJS.ProcessEnv;
        readonly onOpenUrl?: (url: string) => void;
      }) => {
        authCalls.push(params);
        params.onOpenUrl?.('https://example.test/oauth');
        return { kind: 'sdk-config' };
      },
    }),
  );
}

async function importToolModule(label: string): Promise<void> {
  await import(
    `../../../tools/dailyIndicatorAnalysis/index.js?daily-indicator-analysis-index-test-${label}-${Date.now()}`
  );
}

beforeEach(() => {
  authCalls.length = 0;
  quoteContextNewCalls.length = 0;
  candlestickCalls.length = 0;
  logCalls.length = 0;
  errorCalls.length = 0;
  console.log = ((...args: ReadonlyArray<unknown>) => {
    logCalls.push(args.map(String).join(' '));
  }) as typeof console.log;

  console.error = ((...args: ReadonlyArray<unknown>) => {
    errorCalls.push(args);
  }) as typeof console.error;
  process.argv = ['bun', 'dailyIndicatorAnalysis', 'HSCEI.HK'];
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.argv = [...originalArgv];
  reinstallOriginalModules();
});

/** SDK identity 在基础设施 helper 内检查；整个恢复过程不调用 factory 或 auth。 */
afterAll(async () => {
  const beforeCalls = {
    auth: authCalls.length,
    quote: quoteContextNewCalls.length,
  };
  reinstallOriginalModules();
  await sdkModuleMock.assertRestored();
  const restoredAuth =
    await import('../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js');
  expect(restoredAuth.createSdkConfigFromAuth).toBe(originalAuthExports.createSdkConfigFromAuth);
  expect({
    auth: authCalls.length,
    quote: quoteContextNewCalls.length,
  }).toEqual(beforeCalls);
});

describe('dailyIndicatorAnalysis index entry flow', () => {
  it('uses the argv symbol, announces OAuth URL, and stops cleanly on empty minute candles', async () => {
    await registerLongbridgeMock();
    registerAuthMock();

    await importToolModule('empty-candles');

    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.env).toBe(process.env);
    expect(quoteContextNewCalls).toEqual([{ kind: 'sdk-config' }]);
    expect(candlestickCalls).toEqual([['HSCEI.HK', 'Min_1', 1000, 'NoAdjust', 'Intraday']]);
    expect(logCalls).toEqual(
      expect.arrayContaining([
        '查询标的: HSCEI.HK',
        '正在获取数据...',
        '请在浏览器中完成 Longbridge OAuth 授权：https://example.test/oauth',
        '未获取到分钟 K 线数据',
      ]),
    );
    expect(errorCalls).toHaveLength(0);
  });

  it('loads native Bun env before passing it to auth and querying minute candles', () => {
    const isolationRoot = mkdtempSync(path.join(tmpdir(), 'daily-indicator-native-env-'));
    try {
      writeFileSync(
        path.join(isolationRoot, '.env.local'),
        'DAILY_INDICATOR_NATIVE_ENV_PROBE=daily-from-env-local\n',
      );
      const preloadPath = path.join(isolationRoot, 'mock-boundaries.ts');
      writeFileSync(
        preloadPath,
        `
          import { mock } from 'bun:test';
          import { createSdkModuleMock } from ${JSON.stringify(
            fileURLToPath(
              new URL('../../infrastructure/longbridge/trade/sdkModuleMock.ts', import.meta.url),
            ),
          )};

          const config = { kind: 'native-env-config' };
          let authenticated = false;
          mock.module(${JSON.stringify(
            fileURLToPath(
              new URL(
                '../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.ts',
                import.meta.url,
              ),
            ),
          )}, () => ({
            createSdkConfigFromAuth: async ({ env }) => {
              if (env !== process.env || env['DAILY_INDICATOR_NATIVE_ENV_PROBE'] !== 'daily-from-env-local') {
                throw new Error('native env must reach auth unchanged');
              }
              authenticated = true;
              console.log('DAILY_AUTH_NATIVE_ENV_OK');
              return config;
            },
          }));
          createSdkModuleMock().install({
            QuoteContext: {
              new: (receivedConfig) => {
                if (!authenticated || receivedConfig !== config) {
                  throw new Error('auth config must reach QuoteContext unchanged');
                }
                return {
                  candlesticks: async (symbol) => {
                    if (symbol !== 'HSCEI.HK') throw new Error('unexpected symbol');
                    console.log('DAILY_NATIVE_MINUTE_QUERY_OK');
                    return [];
                  },
                };
              },
            },
          });
        `,
      );

      // guard 必须先于边界 mock 安装；真实入口仍由 Bun 直接执行。
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          '--preload',
          fileURLToPath(
            new URL('../../infrastructure/longbridge/trade/offlineSdkGuard.ts', import.meta.url),
          ),
          '--preload',
          preloadPath,
          fileURLToPath(new URL('../../../tools/dailyIndicatorAnalysis/index.ts', import.meta.url)),
          'HSCEI.HK',
        ],
        cwd: isolationRoot,
        env: { ...createChildEnv(isolationRoot), NODE_ENV: 'development' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('DAILY_AUTH_NATIVE_ENV_OK');
      expect(stdout).toContain('DAILY_NATIVE_MINUTE_QUERY_OK');
      expect(stdout).toContain('未获取到分钟 K 线数据');
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  }, 35_000);
});
