/**
 * getHistoryOrders 手工脚本入口与过滤测试。
 *
 * 覆盖：
 * - 导入过滤 helper 不调用认证、context 或查询，也不改变预置环境哨兵。
 * - 禁用文件加载的 CLI 消费预置环境；真实 Bun CLI 消费原生加载的临时环境文件。
 * - 当前持仓识别必须与生产订单记录一致，按低价优先整笔扣减。
 * - 卖出成交价不参与买入订单保留判断。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longbridge';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildEnv } from '../../../setup/childEnv.js';

type TestOrderParams = Readonly<{
  orderId: string;
  symbol?: string;
  stockName?: string;
  side: string | number;
  executedPrice: number;
  executedQuantity: number;
  executedTime: string;
}>;

type TestOrder = Readonly<{
  orderId: string;
  symbol: string;
  stockName: string;
  side: string | number;
  executedPrice: number;
  executedQuantity: number;
  updatedAt: Date;
  currency: string;
}>;

type HistoryOrdersModule = Readonly<{
  applySymbolGroupedFiltering: (allOrders: ReadonlyArray<TestOrder>) => Readonly<{
    filteredOrders: ReadonlyArray<Readonly<{ orderId: string }>>;
  }>;
}>;

const historyOrdersUrl = new URL('../../../../utils/getHistoryOrders.js', import.meta.url);
const offlineGuardPath = fileURLToPath(new URL('offlineSdkGuard.ts', import.meta.url));
const envSentinelKey = 'GET_HISTORY_ORDERS_ENV_SENTINEL';

// 仅替换认证与 SDK 边界；各场景在离线 guard 之后、真实脚本之前注册。
const historyBoundaryMocks = `
  import { mock } from 'bun:test';

  const calls = { auth: [], tradeContext: [], history: [], today: [] };
  mock.module(${JSON.stringify(new URL('../../../../src/infrastructure/longbridge/trade/clientFactory/sdkConfigFactory.js', import.meta.url).href)}, () => ({
    createSdkConfigFromAuth: ({ env }) => {
      calls.auth.push({
        sameEnv: env === process.env,
        envSentinel: env[${JSON.stringify(envSentinelKey)}] ?? null,
      });
      return { kind: 'sdk-config' };
    },
  }));
  mock.module(${JSON.stringify(import.meta.resolve('longbridge'))}, () => ({
    OrderSide: { Buy: 'Buy', Sell: 'Sell' },
    OrderStatus: { Filled: 'Filled' },
    TradeContext: {
      new: (config) => {
        calls.tradeContext.push(config);
        return {
          historyOrders: (...args) => {
            calls.history.push(args);
            return [];
          },
          todayOrders: (...args) => {
            calls.today.push(args);
            return [];
          },
        };
      },
    },
  }));
`;

async function importHistoryOrdersModule(): Promise<HistoryOrdersModule> {
  // @ts-expect-error 手工 JS 脚本没有声明文件；静态路径保留架构扫描与运行时导入校验。
  return (await import('../../../../utils/getHistoryOrders.js')) as HistoryOrdersModule;
}

function runIsolatedBunEval(script: string, env: Readonly<NodeJS.ProcessEnv> = {}): unknown {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'history-orders-test-'));
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--no-env-file', '--preload', offlineGuardPath, '--eval', script],
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...createChildEnv(isolationRoot), ...env },
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 15_000,
    });

    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();

    expect(result.exitCode, stderr).toBe(0);
    expect(stdout.length, 'isolated script must print JSON result').toBeGreaterThan(0);

    return JSON.parse(stdout) as unknown;
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

/** 真实执行 CLI，只在临时 cwd 启用 Bun 原生环境加载，并在退出时回传边界调用。 */
function runNativeHistoryCli(): unknown {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), 'history-orders-native-'));
  try {
    writeFileSync(path.join(isolationRoot, '.env'), `${envSentinelKey}=base-file\n`);
    writeFileSync(path.join(isolationRoot, '.env.local'), `${envSentinelKey}=native-local-file\n`);
    const preloadPath = path.join(isolationRoot, 'history-preload.ts');
    writeFileSync(
      preloadPath,
      `${historyBoundaryMocks}
        const originalLog = console.log;
        const errorCalls = [];
        console.log = () => {};
        console.error = (...args) => errorCalls.push(args);
        process.on('exit', (code) => {
          originalLog(JSON.stringify({ ...calls, errorCalls, exitCalls: [code] }));
        });
      `,
    );
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--preload',
        offlineGuardPath,
        '--preload',
        preloadPath,
        fileURLToPath(historyOrdersUrl),
      ],
      cwd: isolationRoot,
      env: { ...createChildEnv(isolationRoot), NODE_ENV: 'development' },
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 15_000,
    });
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();

    expect(result.exitCode, stderr || stdout).toBe(0);
    expect(stdout.length, 'native CLI must print boundary calls').toBeGreaterThan(0);

    return JSON.parse(stdout) as unknown;
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
}

function createOrder(params: TestOrderParams): TestOrder {
  return {
    orderId: params.orderId,
    symbol: params.symbol ?? 'BULL.HK',
    stockName: params.stockName ?? 'HSI RC',
    side: params.side,
    executedPrice: params.executedPrice,
    executedQuantity: params.executedQuantity,
    updatedAt: new Date(params.executedTime),
    currency: 'HKD',
  };
}

describe('getHistoryOrders symbol-grouped filtering', () => {
  it('importing the helper leaves auth, context, queries and the environment sentinel untouched', () => {
    const result = runIsolatedBunEval(
      `
        ${historyBoundaryMocks}
        const module = await import(${JSON.stringify(historyOrdersUrl.href)} + '?import-side-effect');
        console.log(JSON.stringify({
          ...calls,
          helperType: typeof module.applySymbolGroupedFiltering,
          envSentinel: process.env[${JSON.stringify(envSentinelKey)}] ?? null,
        }));
      `,
      { [envSentinelKey]: 'unchanged-import-sentinel' },
    );

    expect(result).toEqual({
      auth: [],
      tradeContext: [],
      history: [],
      today: [],
      helperType: 'function',
      envSentinel: 'unchanged-import-sentinel',
    });
  }, 20_000);

  it('CLI execution with --no-env-file passes preset environment to auth and queries filled orders', () => {
    const result = runIsolatedBunEval(
      `
        ${historyBoundaryMocks}
        const originalLog = console.log;
        const errorCalls = [];
        const exitCalls = [];
        console.log = () => {};
        console.error = (...args) => errorCalls.push(args);
        process.exit = (code) => exitCalls.push(code);
        process.argv = ['bun', ${JSON.stringify(fileURLToPath(historyOrdersUrl))}];

        await import(${JSON.stringify(historyOrdersUrl.href)} + '?cli-preset-env');
        originalLog(JSON.stringify({ ...calls, errorCalls, exitCalls }));
      `,
      { [envSentinelKey]: 'preset-environment' },
    );

    expect(result).toEqual({
      auth: [{ sameEnv: true, envSentinel: 'preset-environment' }],
      tradeContext: [{ kind: 'sdk-config' }],
      history: [[{ status: ['Filled'] }]],
      today: [[{ status: ['Filled'] }]],
      errorCalls: [],
      exitCalls: [0],
    });
  }, 20_000);

  it('real Bun CLI passes native-loaded environment to auth before querying orders', () => {
    expect(runNativeHistoryCli()).toEqual({
      auth: [{ sameEnv: true, envSentinel: 'native-local-file' }],
      tradeContext: [{ kind: 'sdk-config' }],
      history: [[{ status: ['Filled'] }]],
      today: [[{ status: ['Filled'] }]],
      errorCalls: [],
      exitCalls: [0],
    });
  }, 20_000);

  it('deducts sold quantity by low-price whole-order policy without using sell price', async () => {
    const { applySymbolGroupedFiltering } = await importHistoryOrdersModule();

    const { filteredOrders } = applySymbolGroupedFiltering([
      createOrder({
        orderId: 'BUY-LOW',
        side: OrderSide.Buy,
        executedPrice: 1,
        executedQuantity: 100,
        executedTime: '2026-07-09T01:00:00.000Z',
      }),
      createOrder({
        orderId: 'BUY-HIGH',
        side: OrderSide.Buy,
        executedPrice: 2,
        executedQuantity: 100,
        executedTime: '2026-07-09T01:01:00.000Z',
      }),
      createOrder({
        orderId: 'SELL-ABOVE-ALL-BUYS',
        side: OrderSide.Sell,
        executedPrice: 5,
        executedQuantity: 100,
        executedTime: '2026-07-09T01:02:00.000Z',
      }),
    ]);

    expect(filteredOrders.map((order) => order.orderId)).toEqual(['BUY-HIGH']);
  });
});
