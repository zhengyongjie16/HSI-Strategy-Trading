/**
 * marketMonitor 业务测试
 *
 * 功能：
 * - 验证纯渲染器输出格式相关场景意图、边界条件与业务期望。
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger/index.js';

const infoLogs: string[] = [];
const warnLogs: string[] = [];

beforeEach(() => {
  infoLogs.length = 0;
  warnLogs.length = 0;
  spyOn(logger, 'info').mockImplementation((message: string) => {
    infoLogs.push(message);
  });

  spyOn(logger, 'warn').mockImplementation((message: string) => {
    warnLogs.push(message);
  });
});

afterEach(() => {
  mock.restore();
});

import { createMarketMonitor } from '../../../src/services/marketMonitor/index.js';
import {
  formatPositionDisplay,
  formatQuoteDisplay,
  formatWarrantDistanceDisplay,
} from '../../../src/services/marketMonitor/utils.js';
import { createQuoteDouble, createWarrantDistanceInfoDouble } from '../../helpers/testDoubles.js';

describe('marketMonitor renderer', () => {
  it('formats warrant distance display with unified label', () => {
    expect(formatWarrantDistanceDisplay(null)).toBeNull();

    const bullText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceNumerator: '1.9',
        distanceDenominator: '100',
      }),
    );
    expect(bullText).toBe('距回收价=+1.90%');

    const bearText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BEAR',
        distanceNumerator: '-2.35',
        distanceDenominator: '100',
      }),
    );
    expect(bearText).toBe('距回收价=-2.35%');

    const unknownText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceNumerator: null,
        distanceDenominator: null,
      }),
    );
    expect(unknownText).toBe('距回收价=未知');
  });

  it('formats position display text with required labels and order', () => {
    const display = formatPositionDisplay(
      {
        r1: '100',
        n1: 100,
        r2: '110',
        unrealizedPnL: '10',
      },
      2,
    );
    expect(display).toBe('持仓市值=110.00 持仓盈亏=+10.00 订单数量=2');

    const emptyDisplay = formatPositionDisplay(null, null);
    expect(emptyDisplay).toBe('持仓市值=- 持仓盈亏=- 订单数量=-');
  });

  it('renders monitor indicators directly without local change detection state', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderMonitorIndicators({
      items: [
        { label: 'EMA7', valueText: '19980.000' },
        { label: 'K', valueText: '51.000' },
        { label: 'MACD', valueText: '10.000' },
      ],
      monitorQuote: createQuoteDouble('HSI.HK', '20000'),
      monitorSymbol: 'HSI.HK',
      klineTimestamp: 1_708_000_000_000,
    });

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]).toContain('[监控标的]');
    expect(infoLogs[0]).toContain('HSI.HK');
    expect(infoLogs[0]).toContain('价格=20000.000');
    expect(infoLogs[0]).toContain('EMA7=19980.000');
    expect(infoLogs[0]).toContain('K=51.000');
    expect(infoLogs[0]).toContain('MACD=10.000');
  });

  it('renders single trading quote directly without dual-side coupling', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderTradingQuote({
      event: {
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.23'),
      },
      tradingSymbol: 'BULL.HK',
      direction: 'LONG',
      displayInfo: {
        warrantDistanceInfo: createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceNumerator: '0.7',
          distanceDenominator: '100',
        }),
        unrealizedLossMetrics: {
          r1: '100',
          n1: 100,
          r2: '110',
          unrealizedPnL: '10',
        },
        orderCount: 2,
      },
    });

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]).toContain('[做多标的]');
    expect(infoLogs[0]).toContain('BULL.HK');
    expect(infoLogs[0]).toContain('距回收价=+0.70%');
    expect(infoLogs[0]).toContain('持仓市值=110.00 持仓盈亏=+10.00 订单数量=2');
  });

  it('formats exact quote amounts and percentage directly at their field scales', () => {
    const display = formatQuoteDisplay(
      { ...createQuoteDouble('BULL.HK', '1.010051'), prevClose: '1' },
      'BULL.HK',
    );
    expect(display).toEqual({
      nameText: 'BULL.HK',
      codeText: 'BULL.HK',
      priceText: '1.010',
      changeAmountText: '+0.010',
      changePercentText: '+1.01%',
    });

    expect(formatQuoteDisplay(createQuoteDouble('BULL.HK', '1.2345'), 'BULL.HK')?.priceText).toBe(
      '1.234',
    );

    expect(formatQuoteDisplay(createQuoteDouble('BULL.HK', '1.2355'), 'BULL.HK')?.priceText).toBe(
      '1.236',
    );
    expect(formatQuoteDisplay(null, 'BULL.HK')).toBeNull();
  });

  it('retains native signed rounded zero for quotes and PnL but unsigned zero for warrant distance', () => {
    const negativeChange = formatQuoteDisplay(
      { ...createQuoteDouble('BULL.HK', '0.999999'), prevClose: '1' },
      'BULL.HK',
    );
    expect(negativeChange?.changeAmountText).toBe('-0.000');
    expect(negativeChange?.changePercentText).toBe('-0.00%');
    expect(
      formatQuoteDisplay(
        { ...createQuoteDouble('BULL.HK', '-0.000001'), prevClose: '0' },
        'BULL.HK',
      )?.priceText,
    ).toBe('-0.000');

    expect(
      formatPositionDisplay({ r1: '1', n1: 1, r2: '0.999999', unrealizedPnL: '-0.000001' }, 1),
    ).toBe('持仓市值=1.00 持仓盈亏=-0.00 订单数量=1');

    expect(
      formatWarrantDistanceDisplay({
        warrantType: 'BEAR',
        distanceNumerator: '-0.000001',
        distanceDenominator: '1',
      }),
    ).toBe('距回收价=0.00%');

    expect(
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: '0',
        distanceDenominator: '1',
      }),
    ).toBe('距回收价=+0.00%');
  });

  it('uses unrounded distance basis, including long exact values beyond number precision', () => {
    expect(
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: '1.0051',
        distanceDenominator: '100',
      }),
    ).toBe('距回收价=+1.01%');

    expect(
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: '1.005',
        distanceDenominator: '100',
      }),
    ).toBe('距回收价=+1.00%');

    expect(
      formatQuoteDisplay(
        { ...createQuoteDouble('BULL.HK', '9007199254740993.0001'), prevClose: '9007199254740993' },
        'BULL.HK',
      )?.changeAmountText,
    ).toBe('+0.000');

    expect(
      formatQuoteDisplay(createQuoteDouble('BULL.HK', '9007199254740993.0001'), 'BULL.HK')
        ?.priceText,
    ).toBe('9007199254740993.000');
  });

  it('fails fast for corrupt distance basis, financial text and integer display counts', () => {
    expect(() =>
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: '1',
        distanceDenominator: null,
      }),
    ).toThrow(TypeError);

    expect(() =>
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: null,
        distanceDenominator: '1',
      }),
    ).toThrow(TypeError);

    expect(() =>
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: '1',
        distanceDenominator: '0',
      }),
    ).toThrow(RangeError);

    expect(() =>
      formatWarrantDistanceDisplay({
        warrantType: 'BULL',
        distanceNumerator: 'NaN',
        distanceDenominator: '1',
      }),
    ).toThrow(TypeError);

    expect(() => formatQuoteDisplay(createQuoteDouble('BULL.HK', 'NaN'), 'BULL.HK')).toThrow(
      TypeError,
    );
    expect(() => formatPositionDisplay(null, 0.5)).toThrow(RangeError);
  });

  it('warns when trading quote is unavailable', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderTradingQuote({
      event: {
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', '1.23'),
      },
      tradingSymbol: 'OTHER.HK',
      direction: 'LONG',
      displayInfo: null,
    });

    expect(infoLogs).toEqual([]);
    expect(warnLogs).toEqual(['未获取到做多标的行情。']);
  });
});

describe('marketMonitor neutral strategy projection', () => {
  it('preserves arbitrary labels, text, order and missing-value policy without a host plan', () => {
    const monitor = createMarketMonitor();
    const params = {
      items: [
        { label: '自定义波动率', valueText: '0.0000123400 / ready' },
        { label: '缺少样本', valueText: 'warming-up' },
        { label: '状态', valueText: '' },
        { label: 'K', valueText: '-' },
      ],
      monitorQuote: {
        ...createQuoteDouble('HSI.HK', '20100'),
        name: '恒生指数',
        prevClose: '20000',
        timestamp: Date.UTC(2024, 0, 1, 8, 59),
      },
      monitorSymbol: 'HSI.HK',
      klineTimestamp: Date.UTC(2024, 0, 1, 1, 30),
    };
    monitor.renderMonitorIndicators(params);
    monitor.renderMonitorIndicators(params);

    expect(infoLogs).toHaveLength(2);
    expect(infoLogs[0]).toBe(infoLogs[1]);
    expect(infoLogs[0]).toContain('[K线时间: 09:30:00.000] [监控标的] 恒生指数(HSI.HK)');
    expect(infoLogs[0]).toContain('价格=20100.000 涨跌幅=+0.50%');
    expect(infoLogs[0]).toContain(
      '自定义波动率=0.0000123400 / ready 缺少样本=warming-up 状态= K=-',
    );
    expect(infoLogs[0]).not.toContain('16:59');
  });

  it('retains host quote facts and negative change when the strategy projection is empty', () => {
    createMarketMonitor().renderMonitorIndicators({
      items: [],
      monitorQuote: { ...createQuoteDouble('HSI.HK', '19900'), prevClose: '20000' },
      monitorSymbol: 'HSI.HK',
      klineTimestamp: null,
    });
    expect(infoLogs[0]).toContain('价格=19900.000 涨跌幅=-0.50%');
    expect(infoLogs[0]).not.toContain('[K线时间:');
  });

  it('uses symbol and placeholders for missing quote while preserving strategy text', () => {
    createMarketMonitor().renderMonitorIndicators({
      items: [{ label: '就绪', valueText: 'yes' }],
      monitorQuote: null,
      monitorSymbol: 'HSI.HK',
      klineTimestamp: null,
    });
    expect(infoLogs[0]).toContain('[监控标的] HSI.HK(HSI.HK) 价格=- 涨跌幅=- 就绪=yes');
  });

  it.each([
    { price: 'NaN', prevClose: '20000', priceText: '-' },
    { price: 'Infinity', prevClose: '20000', priceText: '-' },
    { price: '20000', prevClose: '0', priceText: '20000.000' },
    { price: '20000', prevClose: '-1', priceText: '20000.000' },
    { price: '20000', prevClose: 'NaN', priceText: '20000.000' },
    { price: '20000', prevClose: 'Infinity', priceText: '20000.000' },
    { price: '0', prevClose: '20000', priceText: '0.000' },
    { price: '-1', prevClose: '20000', priceText: '-1.000' },
  ])('keeps invalid quote semantics for price=$price prevClose=$prevClose', (scenario) => {
    const render = () => {
      createMarketMonitor().renderMonitorIndicators({
        items: [],
        monitorQuote: {
          ...createQuoteDouble('HSI.HK', scenario.price),
          name: null,
          prevClose: scenario.prevClose,
        },
        monitorSymbol: 'HSI.HK',
        klineTimestamp: Number.NaN,
      });
    };

    if (
      [scenario.price, scenario.prevClose].some((text) => text === 'NaN' || text === 'Infinity')
    ) {
      expect(render).toThrow(TypeError);
      expect(infoLogs).toEqual([]);
      return;
    }

    render();
    expect(infoLogs[0]).toContain(`HSI.HK(HSI.HK) 价格=${scenario.priceText} 涨跌幅=-`);
    expect(infoLogs[0]).not.toContain('[K线时间:');
  });
});
