/**
 * dailyIndicatorAnalysis 入口业务测试
 *
 * 覆盖：
 * - 校验工具使用命令行标的、完成 OAuth 打开提示并请求分钟 K 线
 * - 校验当外部行情边界返回空结果时入口层按预期终止输出
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createSdkModuleMock } from '../../infrastructure/longbridge/trade/sdkModuleMock.js';

/** 在本文件首次 hook 前复制稳定 export 值；Bun module namespace 是 live binding，不作为还原来源。 */
const originalDotenvExports = Object.freeze({ ...(await import('dotenv')) });
const sdkModuleMock = createSdkModuleMock();
const originalAuthExports = Object.freeze({
  ...(await import('../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js')),
});

function reinstallOriginalModules(): void {
  void mock.module('dotenv', () => ({ ...originalDotenvExports }));
  sdkModuleMock.restore();
  void mock.module(
    '../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js',
    () => ({ ...originalAuthExports }),
  );
}

const dotenvConfigCalls: unknown[] = [];
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

function registerDotenvMock(): void {
  void mock.module('dotenv', () => ({
    default: {
      config: (options: unknown) => {
        dotenvConfigCalls.push(options);
      },
    },
  }));
}

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
  dotenvConfigCalls.length = 0;
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

/** SDK identity 在基础设施 helper 内检查；整个恢复过程不调用 factory、auth 或 dotenv。 */
afterAll(async () => {
  const beforeCalls = {
    auth: authCalls.length,
    quote: quoteContextNewCalls.length,
    dotenv: dotenvConfigCalls.length,
  };
  reinstallOriginalModules();
  await sdkModuleMock.assertRestored();
  const restoredDotenv = await import('dotenv');
  const restoredAuth =
    await import('../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js');
  expect(restoredDotenv.default.config).toBe(originalDotenvExports.default.config);
  expect(restoredAuth.createSdkConfigFromAuth).toBe(originalAuthExports.createSdkConfigFromAuth);
  expect({
    auth: authCalls.length,
    quote: quoteContextNewCalls.length,
    dotenv: dotenvConfigCalls.length,
  }).toEqual(beforeCalls);
});

describe('dailyIndicatorAnalysis index entry flow', () => {
  it('uses the argv symbol, announces OAuth URL, and stops cleanly on empty minute candles', async () => {
    registerDotenvMock();
    await registerLongbridgeMock();
    registerAuthMock();

    await importToolModule('empty-candles');

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
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
});
