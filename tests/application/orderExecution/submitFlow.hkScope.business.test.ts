/**
 * 最终提交入口市场门禁：非港股信号在读取持仓/行情与任何 broker 副作用之前被拒绝；
 * 港股信号仍进入原提交流程，证明门禁不是一概拒绝。
 */
import { describe, expect, it } from 'bun:test';
import { createSubmitTargetOrder } from '../../../src/application/orderExecution/submitFlow.js';
import type { ExecutableOrderCommand } from '../../../src/application/orderExecution/types.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import {
  createLoggerDouble,
  createMarketDataClientDouble,
  createOrderMonitorDouble,
  createOrderRecorderDouble,
  createRateLimiterDouble,
  createRiskCheckerDouble,
  createTradeMutationPortDouble,
} from '../../helpers/testDoubles.js';

function createBuyCommand(symbol: string): ExecutableOrderCommand {
  return {
    kind: 'BUY',
    signal: createSignal({ symbol, action: 'BUYCALL', triggerTimeMs: 0 }),
    direction: 'LONG',
    side: 'BUY',
    executionPurpose: 'ORDINARY',
    purpose: 'ORDINARY_BUY',
  } as unknown as ExecutableOrderCommand;
}

function createHarness() {
  const tradingConfig = createTradingConfig();
  const requestedQuoteSymbols: string[][] = [];
  let mutationCalls = 0;
  const submitTargetOrder = createSubmitTargetOrder({
    logger: createLoggerDouble(),
    diagnostics: createDiagnosticObserverDouble(),
    readSellPositions: async () => [],
    tradeMutationPort: createTradeMutationPortDouble({
      submitOrder: async () => {
        mutationCalls += 1;
        throw new Error('非港股不得进入 broker 提交');
      },
    }),
    rateLimiter: createRateLimiterDouble(),
    marketDataClient: createMarketDataClientDouble({
      getQuotes: async (symbols) => {
        requestedQuoteSymbols.push([...symbols]);
        return new Map();
      },
    }),
    cacheManager: { clearCache: () => {} },
    orderMonitor: createOrderMonitorDouble(),
    orderRecorder: createOrderRecorderDouble(),
    globalConfig: tradingConfig.global,
    monitorConfig: tradingConfig.monitor,
    unrealizedLossBuyGate: createRiskCheckerDouble(),
    canExecuteSignal: () => true,
    canTradeNow: () => ({ canTrade: true }),
    recordBuyAttempt: () => {},
    now: () => new Date(0),
  });

  return {
    submitTargetOrder,
    requestedQuoteSymbols,
    mutationCalls: () => mutationCalls,
  };
}

describe('submitTargetOrder Hong Kong scope gate', () => {
  it('rejects a US signal without reading positions or quotes or touching the mutation port', async () => {
    const harness = createHarness();
    const result = await harness.submitTargetOrder(createBuyCommand('AAPL.US'), () => true);

    expect(result).toEqual({ kind: 'SKIPPED' });
    expect(harness.requestedQuoteSymbols).toEqual([]);
    expect(harness.mutationCalls()).toBe(0);
  });

  it('still lets a Hong Kong signal enter the original submit flow', async () => {
    const harness = createHarness();
    const result = await harness.submitTargetOrder(createBuyCommand('BULL.HK'), () => true);

    expect(result).toEqual({ kind: 'QUOTE_MISSING', symbol: 'BULL.HK' });
    expect(harness.requestedQuoteSymbols).toEqual([['BULL.HK']]);
  });
});
