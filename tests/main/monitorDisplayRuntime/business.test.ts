/**
 * monitorDisplayRuntime 业务测试
 * 验证中性显示投影、行情来源、latest-only 合并、门禁与停止排空。
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { TRADING } from '../../../src/constants/index.js';
import { createMonitorDisplayRuntime } from '../../../src/main/monitorDisplayRuntime/index.js';
import type { MonitorDisplayRuntimeDeps } from '../../../src/main/monitorDisplayRuntime/types.js';
import type { RenderMonitorIndicatorsParams } from '../../../src/services/marketMonitor/types.js';
import type { Quote } from '../../../src/types/quote.js';
import { logger } from '../../../src/utils/logger/index.js';

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createHarness(overrides: Partial<MonitorDisplayRuntimeDeps> = {}) {
  const rendered: RenderMonitorIndicatorsParams[] = [];
  const quote: Quote = {
    symbol: 'HSI.HK',
    name: '恒生指数',
    price: 20_010,
    prevClose: 20_000,
    timestamp: 1_708_000_100_000,
  };
  const getQuotes = mock(async () => new Map([['HSI.HK', quote]]));
  const getCandlestickSnapshot = mock(() => ({
    symbol: 'HSI.HK',
    period: TRADING.CANDLE_PERIOD,
    version: 1,
    candles: [],
    lastBarTimestamp: 1_708_000_000_000,
    lastBarConfirmed: true,
    initialized: true,
  }));
  const lastState = { isTradingEnabled: true, canTrade: true };
  const runtime = createMonitorDisplayRuntime({
    marketDataClient: { getQuotes, getCandlestickSnapshot },
    monitorContext: { config: { monitorSymbol: 'HSI.HK' } },
    lastState,
    marketMonitor: {
      renderMonitorIndicators: (params) => {
        rendered.push(params);
      },
    },
    ...overrides,
  });
  return { runtime, rendered, quote, getQuotes, getCandlestickSnapshot, lastState };
}

afterEach(() => {
  mock.restore();
});

describe('monitorDisplayRuntime', () => {
  it('passes arbitrary strategy text with the current quote and cached candle timestamp', async () => {
    const harness = createHarness();
    const items = [{ label: '新指标', valueText: 'ready / 0.012340' }];
    harness.runtime.start();
    harness.runtime.requestRender({ items });
    await waitTick();

    expect(harness.getQuotes).toHaveBeenCalledWith(['HSI.HK']);
    expect(harness.getCandlestickSnapshot).toHaveBeenCalledWith('HSI.HK', TRADING.CANDLE_PERIOD);
    expect(harness.rendered).toEqual([
      {
        monitorSymbol: 'HSI.HK',
        items,
        monitorQuote: harness.quote,
        klineTimestamp: 1_708_000_000_000,
      },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('collapses blocked quote requests to the latest projection with one quote read', async () => {
    const blocked = Promise.withResolvers<Map<string, Quote>>();
    const getQuotes = mock(() => blocked.promise);
    const getCandlestickSnapshot = mock(() => null);
    const harness = createHarness({ marketDataClient: { getQuotes, getCandlestickSnapshot } });
    harness.runtime.start();
    harness.runtime.requestRender({ items: [{ label: '旧', valueText: '1' }] });
    harness.runtime.requestRender({ items: [{ label: '中间', valueText: '2' }] });
    const latest = [{ label: '最新', valueText: '3' }];
    harness.runtime.requestRender({ items: latest });
    blocked.resolve(new Map());
    await waitTick();

    expect(getQuotes).toHaveBeenCalledTimes(1);
    expect(harness.rendered).toEqual([
      { monitorSymbol: 'HSI.HK', items: latest, monitorQuote: null, klineTimestamp: null },
    ]);
    await harness.runtime.stopAndDrain();
  });

  it('accepts an empty projection without dropping host quote display', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.runtime.requestRender({ items: [] });
    await waitTick();
    expect(harness.rendered).toHaveLength(1);
    expect(harness.rendered[0]?.items).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('rejects requests before start and while either trading gate is closed', async () => {
    const harness = createHarness();
    harness.runtime.requestRender({ items: [] });
    harness.runtime.start();
    harness.lastState.isTradingEnabled = false;
    harness.runtime.requestRender({ items: [] });
    harness.lastState.isTradingEnabled = true;
    harness.lastState.canTrade = false;
    harness.runtime.requestRender({ items: [] });
    await waitTick();
    expect(harness.getQuotes).not.toHaveBeenCalled();
    expect(harness.rendered).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('rechecks the gate after a blocked quote read', async () => {
    const blocked = Promise.withResolvers<Map<string, Quote>>();
    const harness = createHarness({
      marketDataClient: {
        getQuotes: () => blocked.promise,
        getCandlestickSnapshot: () => null,
      },
    });
    harness.runtime.start();
    harness.runtime.requestRender({ items: [{ label: '旧', valueText: '1' }] });
    harness.lastState.canTrade = false;
    blocked.resolve(new Map());
    await waitTick();
    harness.lastState.canTrade = true;
    expect(harness.rendered).toEqual([]);
    await harness.runtime.stopAndDrain();
  });

  it('clears pending display synchronously on stop and never renders late quote results', async () => {
    const blocked = Promise.withResolvers<Map<string, Quote>>();
    const getQuotes = mock(() => blocked.promise);
    const getCandlestickSnapshot = mock(() => null);
    const harness = createHarness({ marketDataClient: { getQuotes, getCandlestickSnapshot } });
    harness.runtime.start();
    harness.runtime.requestRender({ items: [{ label: '旧', valueText: '1' }] });
    harness.runtime.requestRender({ items: [{ label: '待显示', valueText: '2' }] });
    let drained = false;
    const drain = harness.runtime.stopAndDrain().then(() => {
      drained = true;
    });
    harness.runtime.requestRender({ items: [{ label: '停止后', valueText: '3' }] });
    await waitTick();
    expect(drained).toBe(false);
    blocked.resolve(new Map());
    await drain;
    expect(harness.rendered).toEqual([]);
    expect(getCandlestickSnapshot).not.toHaveBeenCalled();

    harness.runtime.start();
    await waitTick();
    expect(getQuotes).toHaveBeenCalledTimes(1);
    expect(harness.rendered).toEqual([]);
    const freshItems = [{ label: '重启后', valueText: '4' }];
    harness.runtime.requestRender({ items: freshItems });
    await waitTick();
    expect(harness.rendered[0]?.items).toEqual(freshItems);
    await harness.runtime.stopAndDrain();
  });

  it('logs quote read failures and renders subsequent requests', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    let shouldFail = true;
    const harness = createHarness({
      marketDataClient: {
        getQuotes: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('quote fetch failed');
          }

          return new Map();
        },
        getCandlestickSnapshot: () => null,
      },
    });
    harness.runtime.start();
    harness.runtime.requestRender({ items: [] });
    await waitTick();
    harness.runtime.requestRender({ items: [{ label: '恢复', valueText: 'ok' }] });
    await waitTick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(harness.rendered[0]?.items).toEqual([{ label: '恢复', valueText: 'ok' }]);
    await harness.runtime.stopAndDrain();
  });

  it('logs renderer failures without preventing later display requests', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const renderMonitorIndicators = mock(() => {});
    renderMonitorIndicators.mockImplementationOnce(() => {
      throw new Error('render failed');
    });
    const harness = createHarness({ marketMonitor: { renderMonitorIndicators } });
    harness.runtime.start();
    harness.runtime.requestRender({ items: [] });
    await waitTick();
    harness.runtime.requestRender({ items: [] });
    await waitTick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(renderMonitorIndicators).toHaveBeenCalledTimes(2);
    await harness.runtime.stopAndDrain();
  });
});
