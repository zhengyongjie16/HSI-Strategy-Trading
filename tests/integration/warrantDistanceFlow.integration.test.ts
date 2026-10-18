/**
 * 牛熊证距离事实跨 owner 集成测试。
 * 真实 warrantRiskChecker → RiskChecker 门面 → 距离换标/行情展示，验证单位、精确边界和同标的抑制。
 * 只替换候选查询与非距离交易依赖，不手工构造距离事实，也不提交订单。
 */

import { describe, expect, it } from 'bun:test';
import { createRiskChecker } from '../../src/domain/risk/index.js';
import { createPositionLimitChecker } from '../../src/domain/risk/positionLimitChecker.js';
import { createUnrealizedLossChecker } from '../../src/domain/risk/unrealizedLossChecker.js';
import { createWarrantRiskChecker } from '../../src/domain/risk/warrantRiskChecker.js';
import { createSeatSwitchWorkflow } from '../../src/application/seatSwitch/index.js';
import { createSymbolRegistry } from '../../src/domain/seat/symbolRegistry.js';
import { buildPriceDisplayInfo } from '../../src/infrastructure/display/marketMonitor/priceDisplayInfo.js';
import { formatWarrantDistanceDisplay } from '../../src/infrastructure/display/marketMonitor/utils.js';
import {
  createMarketDataClientDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createTradeRuntimeDouble,
} from '../helpers/testDoubles.js';
import {
  captureSwitchSeatAuthorization,
  createWarrantCandidateWithOverrides,
  getDefaultAutoSearchConfig,
  createLoggerStub,
} from '../helpers/seatTestUtils.js';

/** 装配真实距离 producer、门面、席位/换标 owner；查询次数用于观察当日抑制。 */
function createDistanceFlowHarness(direction: 'LONG' | 'SHORT', sameSymbol = false) {
  const now = () => new Date('2026-02-16T03:00:00.000Z');
  const symbol = direction === 'LONG' ? 'BULL.HK' : 'BEAR.HK';
  const monitorConfig = createMonitorConfigDouble({
    autoSearchConfig: getDefaultAutoSearchConfig(),
  });
  const symbolRegistry = createSymbolRegistry(monitorConfig);
  symbolRegistry.updateSeatState(direction, {
    symbol,
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: now().getTime(),
    callPrice: '20000',
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  });
  const warrantRiskChecker = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  warrantRiskChecker.setWarrantInfoFromCallPrice(symbol, '20000', direction === 'LONG');
  const riskChecker = createRiskChecker({
    warrantRiskChecker,
    positionLimitChecker: createPositionLimitChecker({ maxPositionNotional: null }),
    unrealizedLossChecker: createUnrealizedLossChecker({
      maxUnrealizedLossPerSymbol: null,
      onMissingData: () => {},
    }),
  });
  const orderRecorder = createOrderRecorderDouble();
  let searchCalls = 0;
  const manager = createSeatSwitchWorkflow({
    readSwitchPositions: async () => [],
    logger: createLoggerStub(),
    monitorConfig,
    symbolRegistry,
    riskChecker,

    marketDataClient: createMarketDataClientDouble(),
    ...createTradeRuntimeDouble({
      orderExecutor: {
        executeSignals: async () => {
          throw new Error('距离换标 admission 不应提交订单');
        },
      },
    }),
    candidateSearch: {
      resolveDistanceRange: (candidateDirection) =>
        monitorConfig.autoSearchConfig[
          candidateDirection === 'LONG' ? 'switchDistanceRangeBull' : 'switchDistanceRangeBear'
        ],
      findCandidate: async () => {
        searchCalls += 1;
        return createWarrantCandidateWithOverrides(sameSymbol ? symbol : `NEXT_${symbol}`, {
          callPrice: '20000',
          distancePct: direction === 'LONG' ? '0.5' : '-0.5',
        });
      },
    },
    getTradingCalendarSnapshot: () =>
      new Map([['2026-02-16', { isTradingDay: true, isHalfDay: false }]]),
    clock: { now },
  });

  return {
    manager,
    riskChecker,
    orderRecorder,
    symbolRegistry,
    symbol,
    getSearchCalls: () => searchCalls,
    start: (monitorPrice: string) =>
      manager.startSwitchOnDistance({
        direction,
        monitorPrice,
        positions: [],
        canContinue: captureSwitchSeatAuthorization(symbolRegistry, direction),
      }),
  };
}

for (const direction of ['LONG', 'SHORT'] as const) {
  describe(`真实 ${direction} warrant distance producer → switch/display`, () => {
    // 独立预期：回收价 20000，LONG 区间 (0.2, 1.5)%、SHORT 区间 (-1.5, -0.2)%。
    const cases =
      direction === 'LONG'
        ? [
            { price: '20070', text: '距回收价=+0.35%', started: false },
            { price: '20040.000000000000000001', text: '距回收价=+0.20%', started: false },
            { price: '20299.999999999999999999', text: '距回收价=+1.50%', started: false },
            { price: '20040', text: '距回收价=+0.20%', started: true },
            { price: '20020', text: '距回收价=+0.10%', started: true },
            { price: '20300', text: '距回收价=+1.50%', started: true },
            { price: '20400', text: '距回收价=+2.00%', started: true },
            { price: '19800', text: '距回收价=-1.00%', started: true },
            { price: '20000', text: '距回收价=+0.00%', started: true },
          ]
        : [
            { price: '19930', text: '距回收价=-0.35%', started: false },
            { price: '19959.999999999999999999', text: '距回收价=-0.20%', started: false },
            { price: '19700.000000000000000001', text: '距回收价=-1.50%', started: false },
            { price: '19960', text: '距回收价=-0.20%', started: true },
            { price: '19980', text: '距回收价=-0.10%', started: true },
            { price: '19700', text: '距回收价=-1.50%', started: true },
            { price: '19600', text: '距回收价=-2.00%', started: true },
            { price: '20200', text: '距回收价=+1.00%', started: true },
            { price: '20000', text: '距回收价=+0.00%', started: true },
          ];

    it.each(cases)(
      'price $price preserves percentage units and exact admission',
      async (scenario) => {
        const harness = createDistanceFlowHarness(direction);
        const display = buildPriceDisplayInfo({
          seatActive: true,
          symbol: harness.symbol,
          monitorCurrentPrice: scenario.price,
          quotePrice: '0.1',
          isLongSymbol: direction === 'LONG',
          riskChecker: harness.riskChecker,
          orderRecorder: harness.orderRecorder,
        });
        expect(display).not.toBeNull();
        expect(formatWarrantDistanceDisplay(display?.warrantDistanceInfo ?? null)).toBe(
          scenario.text,
        );
        const result = await harness.start(scenario.price);
        expect(result.started).toBe(scenario.started);
        expect(result.driveResult.kind).toBe(scenario.started ? 'WAIT' : 'NOOP');
        expect(harness.getSearchCalls()).toBe(scenario.started ? 1 : 0);
        expect(harness.manager.hasPendingSwitch(direction)).toBe(scenario.started);
        expect(harness.symbolRegistry.getSeatState(direction).status).toBe(
          scenario.started ? 'SWITCHING' : 'ACTIVE',
        );
      },
    );

    const sameSymbolCases =
      direction === 'LONG'
        ? [
            { side: 'SAFE', price: '20300', searches: 1 },
            { side: 'SAFE', price: '20400', searches: 1 },
            { side: 'DANGER', price: '20040', searches: 2 },
            { side: 'DANGER', price: '20020', searches: 2 },
          ]
        : [
            { side: 'SAFE', price: '19700', searches: 1 },
            { side: 'SAFE', price: '19600', searches: 1 },
            { side: 'DANGER', price: '19960', searches: 2 },
            { side: 'DANGER', price: '19980', searches: 2 },
          ];

    it.each(sameSymbolCases)(
      '$side side at $price suppresses same-symbol searches only on the safe side',
      async (scenario) => {
        const harness = createDistanceFlowHarness(direction, true);
        const first = await harness.start(scenario.price);
        expect(first.started).toBeFalse();
        expect(harness.getSearchCalls()).toBe(1);
        const second = await harness.start(scenario.price);
        expect(second.started).toBeFalse();
        expect(harness.getSearchCalls()).toBe(scenario.searches);
        expect(harness.manager.hasPendingSwitch(direction)).toBeFalse();
        expect(harness.symbolRegistry.getSeatState(direction)).toMatchObject({
          symbol: harness.symbol,
          status: 'ACTIVE',
        });
      },
    );

    it('does not let an existing safe-side suppression block later danger-side searches', async () => {
      const harness = createDistanceFlowHarness(direction, true);
      const safePrice = direction === 'LONG' ? '20300' : '19700';
      const dangerPrice = direction === 'LONG' ? '20040' : '19960';
      await harness.start(safePrice);
      await harness.start(safePrice);
      expect(harness.getSearchCalls()).toBe(1);
      await harness.start(dangerPrice);
      await harness.start(dangerPrice);
      expect(harness.getSearchCalls()).toBe(3);
      expect(harness.manager.hasPendingSwitch(direction)).toBeFalse();
      expect(harness.symbolRegistry.getSeatState(direction).status).toBe('ACTIVE');
    });
  });
}

it('formats repeating ratios once from the real unscaled producer basis', () => {
  const checker = createWarrantRiskChecker({
    onInvalidCallPrice: () => {},
    onWarrantInfoSet: () => {},
  });
  checker.setWarrantInfoFromCallPrice('BULL.HK', '300', true);
  checker.setWarrantInfoFromCallPrice('BEAR.HK', '300', false);
  expect(formatWarrantDistanceDisplay(checker.getWarrantDistanceInfo(true, 'BULL.HK', '301'))).toBe(
    '距回收价=+0.33%',
  );

  expect(
    formatWarrantDistanceDisplay(checker.getWarrantDistanceInfo(false, 'BEAR.HK', '299')),
  ).toBe('距回收价=-0.33%');

  expect(formatWarrantDistanceDisplay(checker.getWarrantDistanceInfo(true, 'BULL.HK', null))).toBe(
    '距回收价=未知',
  );

  expect(
    formatWarrantDistanceDisplay(checker.getWarrantDistanceInfo(false, 'OTHER.HK', '299')),
  ).toBeNull();
});
