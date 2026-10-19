/** 共享替身契约测试：终态/首错使用真实运行时语义，strategy 不恢复旧 owner。 */
import { describe, expect, it } from 'bun:test';
import type { AccountPositionSnapshotView } from '../../src/types/accountPosition.js';
import {
  createAccountPositionSnapshotReaderDouble,
  createAccountSnapshotDouble,
  createMarketDataClientDouble,
  createMonitorContextDouble,
  createPositionDouble,
  createQuoteContextDouble,
  createQuoteDouble,
  createStrategyDouble,
  createTerminationDouble,
} from './testDoubles.js';

describe('shared financial fact doubles', () => {
  it('preserves financial text without a numeric round-trip', () => {
    const cash = '9007199254740993.125';
    const account = createAccountSnapshotDouble(cash);
    expect(account.totalCash).toBe(cash);
    expect(account.netAssets).toBe(cash);
    expect(account.cashInfos[0]?.availableCash).toBe(cash);
    expect(account.positionValue).toBe('0');
    const position = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 50,
      costPrice: '0.1234567890123456789',
    });
    expect(position.costPrice).toBe('0.1234567890123456789');
    expect(position.quantity).toBe(100);
  });

  it.each([
    { quantity: 1.5, availableQuantity: 1 },
    { quantity: Number.MAX_SAFE_INTEGER + 1, availableQuantity: 0 },
    { quantity: -1, availableQuantity: 0 },
    { quantity: 100, availableQuantity: 101 },
    { quantity: 100, availableQuantity: -1 },
    { quantity: 100, availableQuantity: 1.5 },
    { quantity: 100, availableQuantity: Number.NaN },
  ])('rejects unproven position quantities (%j)', (quantities) => {
    expect(() => createPositionDouble({ symbol: 'BULL.HK', ...quantities })).toThrow();
  });

  it('preserves quote prices as text while keeping lot size and time structural', () => {
    const price = '0.123456789012345678901';
    const quote = createQuoteDouble('BULL.HK', price, 100);
    expect(quote.price).toBe(price);
    expect(quote.prevClose).toBe(price);
    expect(quote.lotSize).toBe(100);
    expect(Number.isSafeInteger(quote.timestamp)).toBe(true);
  });

  it('accepts neutral query overrides without projecting call prices or absent facts', async () => {
    const callPrice = '20000.1234567890123456789';
    const context = createQuoteContextDouble({
      warrantQuote: async () => [{ callPrice }],
    });
    expect(await context.warrantQuote(['BULL.HK'])).toEqual([{ callPrice }]);
    const absent = createQuoteContextDouble({
      warrantQuote: async () => [{ callPrice: null }, { callPrice: undefined }],
    });
    expect(await absent.warrantQuote([])).toEqual([{ callPrice: null }, { callPrice: undefined }]);
    expect(await createQuoteContextDouble().warrantQuote([])).toEqual([]);
  });

  it('provides neutral empty market queries without constructing an SDK mock', async () => {
    const context = await createMarketDataClientDouble().getQuoteContext();
    expect(await context.warrantQuote(['BULL.HK'])).toEqual([]);
  });
});

describe('shared readonly snapshot double', () => {
  it('delegates current authorization explicitly and never exposes writable cache capability', () => {
    const token = {
      dayEpoch: 1,
      snapshotGeneration: 2,
      commitRevision: 3,
      accountRevision: 3,
      positionRevision: 3,
      pairedRevision: 3,
    };
    const position = createPositionDouble({
      symbol: 'BULL.HK',
      quantity: 100,
      availableQuantity: 50,
    });
    let view: AccountPositionSnapshotView = {
      token,
      account: createAccountSnapshotDouble('100'),
      positions: [position],
      accountInitialized: true,
      positionsInitialized: true,
      accountValid: true,
      positionsValid: true,
    };
    let current = false;
    const reader = createAccountPositionSnapshotReaderDouble({
      getView: () => view,
      isCurrent: (candidate, components) =>
        current && candidate === token && components.positions && view.positionsValid,
    });
    expect(reader.getView()).toBe(view);
    expect(reader.isCurrent(token, { account: false, positions: true })).toBe(false);
    current = true;
    expect(reader.isCurrent(token, { account: false, positions: true })).toBe(true);
    expect(reader.isCurrent({ ...token }, { account: false, positions: true })).toBe(false);
    expect(reader.getAvailablePosition('BULL.HK')).toBe(position);
    expect(reader.getAvailablePosition('MISSING.HK')).toBeNull();
    view = { ...view, positionsValid: false };
    expect(reader.getAvailablePosition('BULL.HK')).toBeNull();
    expect(reader.isCurrent(token, { account: false, positions: true })).toBe(false);
    expect(reader.getStatus().admission).toBe('CLOSED');
    expect(Object.hasOwn(reader, 'update')).toBe(false);
    expect(Object.hasOwn(reader, 'requestRefresh')).toBe(false);
  });
});

describe('shared runtime doubles', () => {
  it.each([null, undefined])(
    'latches raw first fatal even with an observing override (%s)',
    async (error) => {
      const errors: unknown[] = [];
      const termination = createTerminationDouble({
        reportFatalError: (value) => {
          errors.push(value);
        },
      });
      termination.reportFatalError(error);
      expect(termination.isTerminated()).toBe(true);
      termination.reportFatalError(new Error('secondary'));
      expect(termination.getFatalState()).toEqual({ hasFatalError: true, error });
      expect(errors).toHaveLength(2);
      await termination.waitForTermination();
    },
  );

  it('normal shutdown does not invent fatal, while late real failure is retained', () => {
    const termination = createTerminationDouble();
    termination.requestShutdown();
    expect(termination.isTerminated()).toBe(true);
    expect(termination.getFatalState()).toEqual({ hasFatalError: false });
    const lateError = new Error('late resource failure');
    termination.reportFatalError(lateError);
    expect(termination.getFatalState()).toEqual({ hasFatalError: true, error: lateError });
  });

  it('injects the complete neutral strategy identity without old context owners', () => {
    const strategy = createStrategyDouble();
    const context = createMonitorContextDouble({ strategy });
    expect(context.strategy).toBe(strategy);
    expect(Object.keys(strategy).sort((left, right) => left.localeCompare(right))).toEqual([
      'destroy',
      'invalidateAll',
      'invalidateDirection',
      'onCandlestick',
      'resetForTradingDay',
      'strategyId',
    ]);
    expect(Object.hasOwn(context, 'state')).toBe(false);
    expect(Object.hasOwn(context, 'indicatorProfile')).toBe(false);
    expect(Object.hasOwn(context, 'delayedSignalVerifier')).toBe(false);
  });
});
