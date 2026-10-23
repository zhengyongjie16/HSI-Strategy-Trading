/**
 * meanDeviationAnalysis 入口业务测试
 *
 * 覆盖：
 * - 校验入口读取命令行参数、完成 OAuth 提示并抓取最近 N 个交易日
 * - 校验入口层输出终端表格而不是提前终止
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
const historyCandlestickCalls: Array<ReadonlyArray<unknown>> = [];
const logCalls: string[] = [];
const errorCalls: Array<ReadonlyArray<unknown>> = [];
const processExitCalls: Array<string | number | null | undefined> = [];

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;
const originalArgv = [...process.argv];

async function registerLongbridgeMock(params?: {
  readonly dailyCandles?: ReadonlyArray<{ readonly timestamp: Date }>;
}): Promise<void> {
  const quoteContext = {
    candlesticks: async (...args: ReadonlyArray<unknown>) => {
      candlestickCalls.push(args);
      return (
        params?.dailyCandles ?? [
          { timestamp: new Date('2026-06-21T16:00:00.000Z') },
          { timestamp: new Date('2026-06-22T16:00:00.000Z') },
        ]
      );
    },
    historyCandlesticksByDate: async (...args: ReadonlyArray<unknown>) => {
      historyCandlestickCalls.push(args);
      const startDate = String(args[4]);
      if (startDate === '2026-06-22') {
        return [
          {
            close: { toString: () => '10' },
            volume: 100,
            timestamp: new Date('2026-06-22T01:30:00.000Z'),
          },
          {
            close: { toString: () => '11' },
            volume: 200,
            timestamp: new Date('2026-06-22T01:31:00.000Z'),
          },
        ];
      }

      return [
        {
          close: { toString: () => '10' },
          volume: 100,
          timestamp: new Date('2026-06-23T01:30:00.000Z'),
        },
        {
          close: { toString: () => '9' },
          volume: 200,
          timestamp: new Date('2026-06-23T01:31:00.000Z'),
        },
      ];
    },
  };

  sdkModuleMock.install({
    AdjustType: {
      NoAdjust: 'NoAdjust',
    },
    Period: {
      Day: 'Day',
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
    `../../../tools/meanDeviationAnalysis/index.js?mean-deviation-analysis-index-test-${label}-${Date.now()}`
  );
}

beforeEach(() => {
  authCalls.length = 0;
  quoteContextNewCalls.length = 0;
  candlestickCalls.length = 0;
  historyCandlestickCalls.length = 0;
  logCalls.length = 0;
  errorCalls.length = 0;
  processExitCalls.length = 0;
  console.log = ((...args: ReadonlyArray<unknown>) => {
    logCalls.push(args.map(String).join(' '));
  }) as typeof console.log;

  console.error = ((...args: ReadonlyArray<unknown>) => {
    errorCalls.push(args);
  }) as typeof console.error;

  process.exit = (code?: string | number | null) => {
    processExitCalls.push(code);
    throw new Error(`process.exit:${String(code)}`);
  };
  process.argv = ['bun', 'meanDeviationAnalysis', '--symbol', '981.HK', '--days', '2'];
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
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

describe('meanDeviationAnalysis index entry flow', () => {
  it('uses argv options, loads recent trading days, and prints the metrics table', async () => {
    await registerLongbridgeMock();
    registerAuthMock();

    await importToolModule('success');

    expect(authCalls).toHaveLength(1);
    expect(authCalls[0]?.env).toBe(process.env);
    expect(quoteContextNewCalls).toEqual([{ kind: 'sdk-config' }]);
    expect(candlestickCalls).toEqual([['981.HK', 'Day', 2, 'NoAdjust', 'Intraday']]);
    expect(historyCandlestickCalls.map((args) => args.map(String))).toEqual([
      ['981.HK', 'Min_1', 'NoAdjust', '2026-06-22', '2026-06-22', 'Intraday'],
      ['981.HK', 'Min_1', 'NoAdjust', '2026-06-23', '2026-06-23', 'Intraday'],
    ]);

    expect(logCalls).toEqual(
      expect.arrayContaining([
        '开始分析标的: 981.HK',
        '最近交易日数量: 2',
        '请在浏览器中完成 Longbridge OAuth 授权：https://example.test/oauth',
      ]),
    );
    expect(logCalls.some((line) => line.includes('向上最大偏离'))).toBeTrue();
    expect(
      logCalls.some(
        (line) =>
          line.includes('2026-06-22') &&
          line.includes('3.1250%') &&
          line.includes('11.0000') &&
          line.includes('10.6667') &&
          line.includes('09:31') &&
          line.includes('0.0000%') &&
          line.includes('10.0000') &&
          line.includes('09:30') &&
          line.includes('1.5625%'),
      ),
    ).toBeTrue();

    expect(
      logCalls.some(
        (line) =>
          line.includes('2026-06-23') &&
          line.includes('0.0000%') &&
          line.includes('10.0000') &&
          line.includes('09:30') &&
          line.includes('-3.5714%') &&
          line.includes('9.0000') &&
          line.includes('9.3333') &&
          line.includes('09:31') &&
          line.includes('1.7857%'),
      ),
    ).toBeTrue();
    expect(logCalls.some((line) => line.includes('向上当前价'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('向下均价'))).toBeTrue();
    expect(logCalls.some((line) => line.includes('分钟数'))).toBeFalse();
    expect(errorCalls).toHaveLength(0);
    expect(processExitCalls).toHaveLength(0);
  });

  it('loads native Bun env before passing it to auth and querying daily and minute candles', () => {
    const isolationRoot = mkdtempSync(path.join(tmpdir(), 'mean-deviation-native-env-'));
    try {
      writeFileSync(
        path.join(isolationRoot, '.env.local'),
        'MEAN_DEVIATION_NATIVE_ENV_PROBE=mean-from-env-local\n',
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
              if (env !== process.env || env['MEAN_DEVIATION_NATIVE_ENV_PROBE'] !== 'mean-from-env-local') {
                throw new Error('native env must reach auth unchanged');
              }
              authenticated = true;
              console.log('MEAN_AUTH_NATIVE_ENV_OK');
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
                  candlesticks: async (symbol, period, days) => {
                    if (symbol !== '981.HK' || days !== 1) throw new Error('unexpected daily query');
                    console.log('MEAN_NATIVE_DAILY_QUERY_OK');
                    return [{ timestamp: new Date('2026-06-21T16:00:00.000Z') }];
                  },
                  historyCandlesticksByDate: async () => {
                    console.log('MEAN_NATIVE_MINUTE_QUERY_OK');
                    return [{
                      close: { toString: () => '10' },
                      volume: 100,
                      timestamp: new Date('2026-06-22T01:30:00.000Z'),
                    }];
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
          fileURLToPath(new URL('../../../tools/meanDeviationAnalysis/index.ts', import.meta.url)),
          '--symbol',
          '981.HK',
          '--days',
          '1',
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
      expect(stdout).toContain('MEAN_AUTH_NATIVE_ENV_OK');
      expect(stdout).toContain('MEAN_NATIVE_DAILY_QUERY_OK');
      expect(stdout).toContain('MEAN_NATIVE_MINUTE_QUERY_OK');
      expect(stdout).toContain('2026-06-22');
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  }, 35_000);

  it('fails fast when no recent trading days are returned', async () => {
    await registerLongbridgeMock({ dailyCandles: [] });
    registerAuthMock();

    let importError: unknown = null;
    try {
      await importToolModule('empty-trading-days');
    } catch (error: unknown) {
      importError = error;
    }

    expect(importError).toBeInstanceOf(Error);
    if (!(importError instanceof Error)) {
      throw new Error('预期入口导入失败');
    }

    expect(importError.message).toBe('process.exit:1');

    expect(historyCandlestickCalls).toHaveLength(0);
    expect(errorCalls).toHaveLength(1);
    expect(String(errorCalls[0]?.[1])).toContain('标的 981.HK 未获得最近交易日数据');
    expect(processExitCalls).toEqual([1]);
  });
});
