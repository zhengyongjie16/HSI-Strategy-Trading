/**
 * getHistoryOrders 手工脚本过滤测试
 *
 * 覆盖：
 * - 导入过滤 helper 不应读取 .env.local 或污染测试进程环境。
 * - CLI 直接执行时仍应加载 .env.local。
 * - 当前持仓识别必须与生产订单记录一致，按低价优先整笔扣减。
 * - 卖出成交价不参与买入订单保留判断。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide } from 'longbridge';

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

type ImportSideEffectProbeResult = Readonly<{
  calls: number;
  helperType: string;
  probe: string | null;
}>;

type CliExecutionProbeResult = Readonly<{
  authCalls: ReadonlyArray<boolean>;
  dotenvCalls: ReadonlyArray<Readonly<{ path: string }>>;
  errorCalls: ReadonlyArray<ReadonlyArray<unknown>>;
  exitCalls: ReadonlyArray<number | string | null>;
  historyCalls: ReadonlyArray<ReadonlyArray<unknown>>;
  probe: string | null;
  todayCalls: ReadonlyArray<ReadonlyArray<unknown>>;
  tradeContextCalls: ReadonlyArray<unknown>;
}>;

async function importHistoryOrdersModule(label: string): Promise<HistoryOrdersModule> {
  return (await import(
    `../../utils/getHistoryOrders.js?get-history-orders-business-test-${label}-${Date.now()}`
  )) as HistoryOrdersModule;
}

function runIsolatedBunEval(script: string): unknown {
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  expect(result.exitCode, stderr).toBe(0);
  expect(stdout.length, 'isolated script must print JSON result').toBeGreaterThan(0);

  return JSON.parse(stdout) as unknown;
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
  it('importing filtering helper does not load .env.local or mutate process env', () => {
    const result = runIsolatedBunEval(`
      import { mock } from 'bun:test';

      const calls = [];
      const envProbeKey = 'GET_HISTORY_ORDERS_IMPORT_SIDE_EFFECT_PROBE';
      mock.module('dotenv', () => ({
        default: {
          config: (options) => {
            calls.push(options);
            process.env[envProbeKey] = 'mutated-by-dotenv-config';
          },
        },
      }));

      const module = await import('./utils/getHistoryOrders.js?import-side-effect=' + Date.now());
      console.log(JSON.stringify({
        calls: calls.length,
        helperType: typeof module.applySymbolGroupedFiltering,
        probe: process.env[envProbeKey] ?? null,
      }));
    `) as ImportSideEffectProbeResult;

    expect(result.helperType).toBe('function');
    expect(result.calls).toBe(0);
    expect(result.probe).toBeNull();
  });

  it('direct CLI execution still loads .env.local before creating the trade context', () => {
    const result = runIsolatedBunEval(`
      import { mock } from 'bun:test';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';

      const originalLog = console.log;
      const authCalls = [];
      const dotenvCalls = [];
      const errorCalls = [];
      const exitCalls = [];
      const historyCalls = [];
      const todayCalls = [];
      const tradeContextCalls = [];
      const envProbeKey = 'GET_HISTORY_ORDERS_IMPORT_SIDE_EFFECT_PROBE';

      mock.module('dotenv', () => ({
        default: {
          config: (options) => {
            dotenvCalls.push(options);
            process.env[envProbeKey] = 'mutated-by-dotenv-config';
          },
        },
      }));

      mock.module(pathToFileURL(path.resolve('src/config/auth/index.js')).href, () => ({
        createSdkConfigFromAuth: (params) => {
          authCalls.push(params.env === process.env);
          return { kind: 'sdk-config' };
        },
      }));

      mock.module('longbridge', () => ({
        OrderSide: { Buy: 'Buy', Sell: 'Sell' },
        OrderStatus: { Filled: 'Filled' },
        TradeContext: {
          new: (config) => {
            tradeContextCalls.push(config);
            return {
              historyOrders: (...args) => {
                historyCalls.push(args);
                return [];
              },
              todayOrders: (...args) => {
                todayCalls.push(args);
                return [];
              },
            };
          },
        },
      }));

      console.log = () => {};
      console.error = (...args) => {
        errorCalls.push(args);
      };
      process.exit = (code) => {
        exitCalls.push(code);
      };
      process.argv = ['bun', path.resolve('utils/getHistoryOrders.js')];

      await import('./utils/getHistoryOrders.js?cli-entry=' + Date.now());
      originalLog(JSON.stringify({
        authCalls,
        dotenvCalls,
        errorCalls,
        exitCalls,
        historyCalls,
        probe: process.env[envProbeKey] ?? null,
        todayCalls,
        tradeContextCalls,
      }));
    `) as CliExecutionProbeResult;

    expect(result.dotenvCalls).toHaveLength(1);
    expect(result.dotenvCalls[0]?.path.endsWith('.env.local')).toBeTrue();
    expect(result.probe).toBe('mutated-by-dotenv-config');
    expect(result.authCalls).toEqual([true]);
    expect(result.tradeContextCalls).toEqual([{ kind: 'sdk-config' }]);
    expect(result.historyCalls).toEqual([[{ status: ['Filled'] }]]);
    expect(result.todayCalls).toEqual([[{ status: ['Filled'] }]]);
    expect(result.errorCalls).toHaveLength(0);
    expect(result.exitCalls).toEqual([0]);
  });

  it('deducts sold quantity by low-price whole-order policy without using sell price', async () => {
    const { applySymbolGroupedFiltering } = await importHistoryOrdersModule('filtering');

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
