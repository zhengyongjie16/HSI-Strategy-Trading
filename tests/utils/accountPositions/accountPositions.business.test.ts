/**
 * 账户与持仓专用双读取业务测试
 *
 * 覆盖场景意图：混合失败的内部优先与原始身份、fatal 上报时点、已开始请求排空、
 * 同步 throw 不丢兄弟请求、纯外部失败原样透传与重试配置透传。
 */
import { describe, expect, it } from 'bun:test';

import { readAccountAndPositionsBothSettled } from '../../../src/utils/accountPositions/index.js';
import {
  createAccountSnapshotDouble,
  createPositionDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';

describe('readAccountAndPositionsBothSettled', () => {
  it('returns both reads and forwards the retry config only when both requests succeed', async () => {
    const account = createAccountSnapshotDouble(88_000);
    const positions = [
      createPositionDouble({ symbol: 'BULL.HK', quantity: 100, availableQuantity: 100 }),
    ];
    const receivedParams: unknown[] = [];
    const trader = createTraderDouble({
      getAccountSnapshot: async (params) => {
        receivedParams.push(params);
        return account;
      },
      getStockPositions: async (params) => {
        receivedParams.push(params);
        return positions;
      },
    });

    const result = await readAccountAndPositionsBothSettled({
      trader,
      retryConfig: { retries: 0, delayMs: 0 },
      reportFatalError: () => {},
    });

    expect(result.account).toBe(account);
    expect(result.positions).toBe(positions);
    expect(receivedParams).toEqual([
      { retryConfig: { retries: 0, delayMs: 0 } },
      { retryConfig: { retries: 0, delayMs: 0 } },
    ]);
  });

  it('waits for the still pending internal failure after an earlier external failure and throws the internal error', async () => {
    const externalError = await createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('temporary'),
    });
    const internalError = new TypeError('positions contract broken');
    const positionsRelease = Promise.withResolvers<undefined>();
    const fatalErrors: unknown[] = [];
    let positionsStarted = 0;
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        throw externalError;
      },
      getStockPositions: async () => {
        positionsStarted += 1;
        await positionsRelease.promise;
        throw internalError;
      },
    });

    let settled = false;
    const promise = readAccountAndPositionsBothSettled({
      trader,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Bun.sleep(0);
    expect(positionsStarted).toBe(1);
    expect(fatalErrors).toEqual([]);
    // 内部请求未落定前不得提前结束排空。
    expect(settled).toBe(false);

    positionsRelease.resolve();
    let caught: unknown = 'unset';
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(internalError);
    expect(fatalErrors).toEqual([internalError]);
  });

  it('reports fatal at the internal failure point and drains the later external sibling', async () => {
    const internalError = new TypeError('account contract broken');
    const externalError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('temporary'),
    });
    const positionsRelease = Promise.withResolvers<undefined>();
    const fatalErrors: unknown[] = [];
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        throw internalError;
      },
      getStockPositions: async () => {
        await positionsRelease.promise;
        throw externalError;
      },
    });

    const promise = readAccountAndPositionsBothSettled({
      trader,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    await Bun.sleep(0);
    // 内部失败当下即上报，不等待外部兄弟请求结束。
    expect(fatalErrors).toEqual([internalError]);

    positionsRelease.resolve();
    let caught: unknown = 'unset';
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(internalError);
    expect(fatalErrors).toEqual([internalError]);
  });

  it('rethrows a pure external failure with its original identity and reports no fatal', async () => {
    const externalError = await createExternalApiRequestError({
      operation: 'TradeContext.stockPositions',
      attempts: 1,
      cause: new Error('positions api down'),
    });
    const fatalErrors: unknown[] = [];
    const trader = createTraderDouble({
      getStockPositions: async () => {
        throw externalError;
      },
    });

    let caught: unknown = 'unset';
    try {
      await readAccountAndPositionsBothSettled({
        trader,
        reportFatalError: (error) => {
          fatalErrors.push(error);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(externalError);
    expect(fatalErrors).toEqual([]);
  });

  it('still starts and drains the sibling request when one read throws synchronously', async () => {
    const syncError = new Error('positions getter threw synchronously');
    const accountRelease = Promise.withResolvers<undefined>();
    const account = createAccountSnapshotDouble(66_000);
    const fatalErrors: unknown[] = [];
    let accountStarted = 0;
    const trader = createTraderDouble({
      getAccountSnapshot: () => {
        accountStarted += 1;
        return accountRelease.promise.then(() => account);
      },
      getStockPositions: () => {
        throw syncError;
      },
    });

    let settled = false;
    const promise = readAccountAndPositionsBothSettled({
      trader,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Bun.sleep(0);
    expect(accountStarted).toBe(1);
    expect(fatalErrors).toEqual([syncError]);
    // 已启动的账户请求仍必须被排空后才能结束。
    expect(settled).toBe(false);

    accountRelease.resolve();
    let caught: unknown = 'unset';
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(syncError);
    expect(fatalErrors).toEqual([syncError]);
  });

  it.each([
    { label: 'null', rejectedValue: null as unknown },
    { label: 'undefined', rejectedValue: undefined as unknown },
  ])(
    'preserves the $label rejection identity instead of replacing it with a fallback error',
    async ({ rejectedValue }) => {
      const fatalErrors: unknown[] = [];
      const trader = createTraderDouble({
        getAccountSnapshot: async () => {
          throw rejectedValue;
        },
      });

      let caught: unknown = 'unset';
      try {
        await readAccountAndPositionsBothSettled({
          trader,
          reportFatalError: (error) => {
            fatalErrors.push(error);
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(rejectedValue);
      expect(fatalErrors).toEqual([rejectedValue]);
    },
  );
});
