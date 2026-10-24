/** 普通 BUY 被动诊断：既有拒绝分支、冷却与顺序保真，observer/字段异常不得改变业务。 */
import { describe, expect, it } from 'bun:test';
import { createBuyRiskChecks } from '../../../src/application/ordinaryBuy/riskChecks.js';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import {
  createAccountSnapshotDouble,
  createLiquidationCooldownTrackerDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTradeRuntimeDouble,
} from '../../helpers/testDoubles.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';

const cases = [
  { reasonCode: 'RISK_CHECK_COOLDOWN', stepCount: 0 },
  { reasonCode: 'BUY_FREQUENCY_LIMIT', stepCount: 1 },
  { reasonCode: 'BUY_FREQUENCY_LIMIT', stepCount: 1, waitSeconds: undefined },
  { reasonCode: 'LIQUIDATION_COOLDOWN', stepCount: 3 },
  { reasonCode: 'QUOTE_MISSING', stepCount: 3 },
  { reasonCode: 'QUOTE_INVALID', stepCount: 3 },
  { reasonCode: 'BUY_PRICE_LIMIT', stepCount: 4 },
  { reasonCode: 'DOOMSDAY_BUY_CUTOFF', stepCount: 4 },
  { reasonCode: 'WARRANT_RISK_REJECTED', stepCount: 5 },
  { reasonCode: 'UNREALIZED_LOSS_REJECTED', stepCount: 6 },
  { reasonCode: 'ACCOUNT_POSITION_READ_FAILED', stepCount: 8 },
  { reasonCode: 'BASIC_RISK_REJECTED', stepCount: 9 },
] as const;

describe.each([false, true])('ordinaryBuy diagnostics observer throws=%s', (observerThrows) => {
  it.each(cases)('records $reasonCode without changing checks or cooldown', async (testCase) => {
    const { reasonCode, stepCount } = testCase;
    const waitSeconds = 'waitSeconds' in testCase ? testCase.waitSeconds : 7;
    const warnings: string[] = [];
    const steps: string[] = [];
    const events: DiagnosticFields[] = [];
    const operations: string[] = [];
    const fatalErrors: unknown[] = [];
    const originalError = new TypeError('原账户事实错误');
    const observerError = new Error('observer failed');
    const originalReason = '既有基础风控 reason：不解析、不重新推断规则';
    const currentTime = new Date('2026-02-16T07:50:00Z');
    const currentTimeMs = currentTime.getTime();
    const lastRiskCheckTime = new Map<string, number>();
    if (reasonCode === 'RISK_CHECK_COOLDOWN') lastRiskCheckTime.set('BULL.HK_BUY', currentTimeMs);

    const signal = {
      ...createSignalDouble('BUYCALL', 'BULL.HK'),
      seatVersion: 2,
      triggerTime: new Date('2026-02-16T02:00:00Z'),
    };
    const tradeRuntime = createTradeRuntimeDouble({
      orderExecutor: {
        canTradeNow: () => {
          steps.push('frequency');
          return {
            canTrade: reasonCode !== 'BUY_FREQUENCY_LIMIT',
            ...(waitSeconds === undefined ? {} : { waitSeconds }),
          };
        },
      },
      accountService: {
        getAccountSnapshot: async () => {
          steps.push('account');
          if (reasonCode === 'ACCOUNT_POSITION_READ_FAILED') throw originalError;

          return createAccountSnapshotDouble('100000');
        },
        getStockPositions: async () => {
          steps.push('positions');
          return [];
        },
      },
    });
    const pipeline = createBuyRiskChecks({
      logger: {
        ...createLoggerDouble(),
        warn: (message) => {
          warnings.push(message);
        },
      },
      diagnostics: {
        record: (operation, fields) => {
          operations.push(operation);
          events.push(fields);
          if (observerThrows) throw observerError;
        },
      },
      doomsdayProtection: reasonCode === 'DOOMSDAY_BUY_CUTOFF',
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: ({ direction }) => {
          steps.push(`cooldown:${direction}`);
          return reasonCode === 'LIQUIDATION_COOLDOWN' ? 5001 : 0;
        },
      }),
      lastRiskCheckTime,
      reportFatalError: (error) => {
        fatalErrors.push(error);
      },
    });
    const price = reasonCode === 'QUOTE_INVALID' ? '0' : '1.000000000000000001';
    const context = {
      accountService: tradeRuntime.accountService,
      tradeFrequencyReader: tradeRuntime.orderExecutor,
      riskChecker: createRiskCheckerDouble({
        checkWarrantRisk: () => {
          steps.push('warrant');
          return { allowed: reasonCode !== 'WARRANT_RISK_REJECTED', reason: '原牛熊证 reason' };
        },
        checkUnrealizedLoss: () => {
          steps.push('unrealized');
          return { shouldLiquidate: reasonCode === 'UNREALIZED_LOSS_REJECTED' };
        },
        checkBeforeOrder: () => {
          steps.push('basic');
          return { allowed: false, reason: originalReason };
        },
      }),
      orderRecorder: createOrderRecorderDouble({
        getLatestBuyOrderCost: () => {
          steps.push('latestPrice');
          return reasonCode === 'BUY_PRICE_LIMIT' ? { costAmount: '1000', quantity: 1000 } : null;
        },
      }),
      longQuote: reasonCode === 'QUOTE_MISSING' ? null : createQuoteDouble('BULL.HK', price),
      shortQuote: null,
      monitorQuote: createQuoteDouble('HSI.HK', '20000'),
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
      longSymbolName: null,
      shortSymbolName: null,
      currentTime,
      isHalfDay: false,
      config: createMonitorConfigDouble(),
    };

    let caught: unknown;
    let result;
    try {
      result = await pipeline([signal], context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reasonCode === 'ACCOUNT_POSITION_READ_FAILED' ? originalError : undefined);
    expect(result).toEqual(reasonCode === 'ACCOUNT_POSITION_READ_FAILED' ? undefined : []);
    expect(fatalErrors).toEqual(
      reasonCode === 'ACCOUNT_POSITION_READ_FAILED' ? [originalError] : [],
    );

    expect(steps).toEqual(
      [
        'frequency',
        'cooldown:LONG',
        'cooldown:SHORT',
        'latestPrice',
        'warrant',
        'unrealized',
        'account',
        'positions',
        'basic',
      ].slice(0, stepCount),
    );
    expect(lastRiskCheckTime.get('BULL.HK_BUY')).toBe(currentTimeMs);
    expect(events).toHaveLength(1);
    expect(operations).toEqual([DIAGNOSTIC_OPERATIONS.SIGNAL_PROCESSING_OUTCOME]);
    expect(events[0]).toMatchObject({
      stage: 'BUY_RISK_CHECK',
      outcome: reasonCode === 'ACCOUNT_POSITION_READ_FAILED' ? 'FAILED' : 'REJECTED',
      reasonCode,
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      seatVersion: 2,
      triggerTimeMs: signal.triggerTime.getTime(),
    });

    if (reasonCode === 'BUY_FREQUENCY_LIMIT') {
      if (waitSeconds === undefined) {
        expect(events[0]).not.toHaveProperty('waitSeconds');
      } else {
        expect(events[0]?.['waitSeconds']).toBe(waitSeconds);
      }

      expect(events[0]?.['detail']).toContain(`需等待 ${waitSeconds ?? 0} 秒`);
      expect(warnings[0]).toContain(`需等待 ${waitSeconds ?? 0} 秒`);
    }

    if (reasonCode === 'BASIC_RISK_REJECTED') expect(events[0]?.['detail']).toBe(originalReason);

    if (reasonCode === 'BUY_PRICE_LIMIT') {
      expect(events[0]).toMatchObject({
        currentPrice: '1.000000000000000001',
        latestBuyCostAmount: '1000',
        latestBuyQuantity: '1000',
      });
    }

    const stepsBeforeCooldown = [...steps];
    expect(await pipeline([signal], context)).toEqual([]);
    expect(steps).toEqual(stepsBeforeCooldown);
    expect(events[1]?.['reasonCode']).toBe('RISK_CHECK_COOLDOWN');
    expect(signal.reason).toBeUndefined();
  });
});

it('isolates diagnostic field construction while retaining the original base-risk result', async () => {
  let recorded = 0;
  let baseChecks = 0;
  const triggerTime = new Date('2026-02-16T02:00:00Z');
  triggerTime.getTime = () => {
    throw new Error('diagnostic triggerTime getter');
  };
  const tradeRuntime = createTradeRuntimeDouble();
  const pipeline = createBuyRiskChecks({
    logger: createLoggerDouble(),
    diagnostics: {
      record: () => {
        recorded += 1;
      },
    },
    doomsdayProtection: false,
    liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
    lastRiskCheckTime: new Map(),
    reportFatalError: () => {},
  });
  const result = await pipeline([{ ...createSignalDouble('BUYCALL', 'BULL.HK'), triggerTime }], {
    accountService: tradeRuntime.accountService,
    tradeFrequencyReader: tradeRuntime.orderExecutor,
    riskChecker: createRiskCheckerDouble({
      checkBeforeOrder: () => {
        baseChecks += 1;
        return { allowed: false };
      },
    }),
    orderRecorder: createOrderRecorderDouble(),
    longQuote: createQuoteDouble('BULL.HK', '1'),
    shortQuote: null,
    monitorQuote: createQuoteDouble('HSI.HK', '20000'),
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: null,
    shortSymbolName: null,
    currentTime: new Date('2026-02-16T02:00:00Z'),
    isHalfDay: false,
    config: createMonitorConfigDouble(),
  });
  expect(result).toEqual([]);
  expect(baseChecks).toBe(1);
  expect(recorded).toBe(0);
});
