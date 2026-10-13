/**
 * 牛熊证异步刷新用例测试。
 * 验证中性 market port 的成功发布、原 captured 授权、精确事实保留和原失败分类；不依赖 SDK fixture。
 */
import { describe, expect, it } from 'bun:test';
import { createWarrantRiskRefresh } from '../../../src/application/riskRefresh/warrantRiskRefresh.js';
import { createWarrantRiskChecker } from '../../../src/domain/risk/warrantRiskChecker.js';
import { createRiskChecker } from '../../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../../src/domain/risk/unrealizedLossChecker.js';
import type { MarketQuoteContext, MarketWarrantQuote } from '../../../src/types/marketPorts.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { createMarketDataClientDouble, createLoggerDouble } from '../../helpers/testDoubles.js';

describe('warrant risk refresh business boundaries', () => {
  it.each(['BULL', 'CALL'])(
    'does not restore cleared risk state when a late %s query loses its original authorization',
    async (category) => {
      const checker = createWarrantRiskChecker({
        onInvalidCallPrice: () => {},
        onWarrantInfoSet: () => {},
      });
      checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
      checker.setWarrantInfoFromCallPrice('BEAR.HK', '20000', false);
      const query = Promise.withResolvers<ReadonlyArray<MarketWarrantQuote>>();
      const started = Promise.withResolvers<undefined>();
      const authorization = { revision: 1 };
      const capturedRevision = authorization.revision;
      let guardCalls = 0;
      let queryCalls = 0;
      let publications = 0;
      let successLogs = 0;
      const refresh = createWarrantRiskRefresh({
        warrantRiskChecker: {
          publishWarrantInfo: (info, isLong) => {
            publications += 1;
            checker.publishWarrantInfo(info, isLong);
          },
        },
        logger: {
          ...createLoggerDouble(),
          info: () => {
            successLogs += 1;
          },
        },
        marketDataClient: {
          getQuoteContext: async () => ({
            warrantList: async () => [],
            warrantQuote: () => {
              queryCalls += 1;
              started.resolve();
              return query.promise;
            },
          }),
        },
      });
      const pending = refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => {
        guardCalls += 1;
        return authorization.revision === capturedRevision;
      });
      await started.promise;
      authorization.revision += 1;
      checker.clearLongWarrantInfo();
      query.resolve([{ symbol: 'BULL.HK', category, callPrice: '19000' }]);
      expect(await pending).toEqual({ status: 'INVALIDATED' });
      expect(guardCalls).toBe(1);
      expect(queryCalls).toBe(1);
      expect(publications).toBe(0);
      expect(successLogs).toBe(0);
      expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toBeNull();
      expect(checker.getWarrantDistanceInfo(false, 'BEAR.HK', '20000')).toMatchObject({
        distanceDenominator: '20000',
      });
    },
  );

  it('keeps the final guard and publication in one synchronous segment without a microtask gap', async () => {
    const events: string[] = [];
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: {
        publishWarrantInfo: (info, isLong) => {
          events.push('publish');
          checker.publishWarrantInfo(info, isLong);
        },
      },
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'BULL', callPrice: '20000' }],
        }),
      },
    });
    expect(
      await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => {
        events.push('guard');
        queueMicrotask(() => {
          events.push('microtask');
        });
        return true;
      }),
    ).toEqual({ status: 'ok', isWarrant: true });
    expect(events).toEqual(['guard', 'publish', 'microtask']);
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toMatchObject({
      distanceDenominator: '20000',
    });
  });

  it('rethrows a broken authorization callback without converting it to a reportable query failure', async () => {
    const brokenGuard = new Error('captured authorization contract broken');
    let publications = 0;
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: {
        publishWarrantInfo: () => {
          publications += 1;
        },
      },
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'BULL', callPrice: '20000' }],
        }),
      },
    });
    let failure: unknown = null;
    try {
      await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => {
        throw brokenGuard;
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(brokenGuard);
    expect(publications).toBe(0);
  });

  it('publishes exact API financial text to the same state read by RiskChecker without crossing directions', async () => {
    const warrantRiskChecker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    const riskChecker = createRiskChecker({
      warrantRiskChecker,
      positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: null,
        onMissingData: () => {},
      }),
    });
    riskChecker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    riskChecker.setWarrantInfoFromCallPrice('BEAR.HK', '20000', false);
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker,
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async (symbols) => {
            expect(symbols).toEqual(['BULL.HK']);
            return [{ symbol: 'BULL.HK', category: 'Bull', callPrice: '20000.000000000000000001' }];
          },
        }),
      },
    });
    expect(await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => true)).toEqual({
      status: 'ok',
      isWarrant: true,
    });

    expect(riskChecker.getWarrantDistanceInfo(true, 'BULL.HK', '20000.000000000000000002')).toEqual(
      {
        warrantType: 'BULL',
        distanceNumerator: '0.000000000000000001',
        distanceDenominator: '20000.000000000000000001',
      },
    );
    expect(riskChecker.checkWarrantRisk('BULL.HK', 'BUYCALL', '20070').allowed).toBeFalse();
    expect(riskChecker.getWarrantDistanceInfo(false, 'BEAR.HK', '19930')).toEqual({
      warrantType: 'BEAR',
      distanceNumerator: '-70',
      distanceDenominator: '20000',
    });
  });

  it('retains the old risk fact when the market port returns malformed text and rethrows the contract error', async () => {
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: checker,
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'BULL', callPrice: '2e4' }],
        }),
      },
    });
    let failure: unknown = null;
    let guardCalls = 0;
    try {
      await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => {
        guardCalls += 1;
        return false;
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect(guardCalls).toBe(0);
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toMatchObject({
      distanceDenominator: '20000',
    });
  });

  it('preserves the original reportable error result without publishing on an unbranded query failure', async () => {
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: checker,
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async (): Promise<MarketQuoteContext> => {
          throw new Error('business rejection');
        },
      },
    });
    expect(await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => false)).toEqual({
      status: 'error',
      isWarrant: false,
      reason: 'business rejection',
    });

    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toMatchObject({
      distanceDenominator: '20000',
    });
  });

  it('publishes non-warrant after a successful unknown-category read and never invents a call price', async () => {
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true);
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: checker,
      logger: createLoggerDouble(),
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'CALL', callPrice: '20000' }],
        }),
      },
    });
    expect(await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => true)).toEqual({
      status: 'notWarrant',
      isWarrant: false,
    });
    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toBeNull();
    expect(checker.checkRisk('BULL.HK', 'BUYCALL', '20000')).toEqual({ allowed: true });
  });

  it('observes type mismatch while preserving the actual warrant category for judgment', async () => {
    const messages: unknown[][] = [];
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    const refresh = createWarrantRiskRefresh({
      warrantRiskChecker: checker,
      logger: {
        info: () => {},
        warn: (...args) => {
          messages.push(args);
        },
      },
      marketDataClient: {
        getQuoteContext: async () => ({
          warrantList: async () => [],
          warrantQuote: async () => [{ symbol: 'MISMATCH.HK', category: 4, callPrice: '20000' }],
        }),
      },
    });
    expect(await refresh.refreshWarrantInfoForSymbol('MISMATCH.HK', true, () => true)).toEqual({
      status: 'ok',
      isWarrant: true,
    });

    expect(messages[0]?.[0]).toBe(
      '[风险检查警告] MISMATCH.HK 的牛熊证类型不符合预期：期望牛证，实际是熊证',
    );

    expect(checker.checkRisk('MISMATCH.HK', 'BUYCALL', '19930')).toMatchObject({
      allowed: true,
      warrantInfo: { warrantType: 'BEAR' },
    });
  });

  it('keeps the previous warrant fact after the read port exhausts retries, then refreshes on the next call', async () => {
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    checker.setWarrantInfoFromCallPrice('BULL.HK', '20000', true, 'BULL.HK');
    const cause = new Error('network unavailable');
    const exhausted = await createExternalApiRequestError({
      operation: 'QuoteContext.warrantQuote',
      attempts: 3,
      cause,
    });
    let queryCalls = 0;
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => ({
        warrantList: async () => [],
        warrantQuote: async () => {
          queryCalls += 1;
          if (queryCalls === 1) throw exhausted;

          return [{ symbol: 'BULL.HK', callPrice: '19000', category: 3 }];
        },
      }),
    });
    const refresh = createWarrantRiskRefresh({
      marketDataClient,
      warrantRiskChecker: checker,
      logger: createLoggerDouble(),
    });
    let caught: unknown = null;
    let guardCalls = 0;
    try {
      await refresh.refreshWarrantInfoForSymbol(
        'BULL.HK',
        true,
        () => {
          guardCalls += 1;
          return false;
        },
        'BULL.HK',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(exhausted);
    expect(guardCalls).toBe(0);
    expect(exhausted.cause).toBe(cause);
    expect(queryCalls).toBe(1);
    const before = checker.checkRisk('BULL.HK', 'BUYCALL', '20000');
    expect(before.allowed).toBeFalse();
    expect(before.reason).toContain('牛证距离回收价百分比');
    expect(
      await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => true, 'BULL.HK'),
    ).toEqual({
      status: 'ok',
      isWarrant: true,
    });
    expect(queryCalls).toBe(2);
    expect(checker.checkRisk('BULL.HK', 'BUYCALL', '20000').allowed).toBeTrue();
  });

  it('retains a recognized warrant with an unknown raw call price without inventing a zero price', async () => {
    const checker = createWarrantRiskChecker({
      onInvalidCallPrice: () => {},
      onWarrantInfoSet: () => {},
    });
    const marketDataClient = createMarketDataClientDouble({
      getQuoteContext: async () => ({
        warrantList: async () => [],
        warrantQuote: async () => [{ symbol: 'BULL.HK', category: 'BULL', callPrice: null }],
      }),
    });
    const refresh = createWarrantRiskRefresh({
      marketDataClient,
      warrantRiskChecker: checker,
      logger: createLoggerDouble(),
    });
    expect(
      await refresh.refreshWarrantInfoForSymbol('BULL.HK', true, () => true, 'BULL.HK'),
    ).toEqual({
      status: 'ok',
      isWarrant: true,
    });

    expect(checker.getWarrantDistanceInfo(true, 'BULL.HK', '20000')).toEqual({
      warrantType: 'BULL',
      distanceNumerator: null,
      distanceDenominator: null,
    });
    const result = checker.checkRisk('BULL.HK', 'BUYCALL', '20000');

    expect(result.allowed).toBeFalse();
    expect(result.reason).toContain('回收价无效（null）');
  });
});
