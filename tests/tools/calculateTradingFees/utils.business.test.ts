/**
 * calculateTradingFees 工具测试
 *
 * 覆盖：
 * - 校验 JSONL 交易记录边界解析与数值字段校验
 * - 只保留普通成交，并对损坏或未知日志记录 fail-fast
 */
import { describe, expect, it } from 'bun:test';
import { parseTradeNumbers, parseTrades } from '../../../tools/calculateTradingFees/utils.js';

const validTrade = {
  orderId: 'order-1',
  symbol: 'HK.12345',
  symbolName: null,
  monitorSymbol: 'HSI.HK',
  action: 'BUYCALL',
  side: 'BUY',
  quantity: '200',
  price: '0.123',
  orderType: 'LO',
  status: 'FILLED',
  error: null,
  reason: null,
  signalTriggerTime: null,
  executedAt: '2026/01/21/10:45:15',
  executedAtMs: 1768963515000,
  timestamp: '2026/01/21/10:45:17',
  isProtectiveClearance: false,
};

const protectiveProgressRecord = {
  recordType: 'PROTECTIVE_LIQUIDATION_EXECUTION_PROGRESS',
  schemaVersion: 1,
  progressId: 'v1:2026-01-21:HSI.HK:LONG:HK.12345:protective-order:1768963517000:200:OPEN',
  tradingDayKey: '2026-01-21',
  monitorSymbol: 'HSI.HK',
  direction: 'LONG',
  symbol: 'HK.12345',
  orderId: 'protective-order',
  factStage: 'OPEN',
  cumulativeQuantity: '200',
  cumulativeAmount: '24.6',
  lastExecutionTimeMs: 1768963515000,
  orderRevisionMs: 1768963517000,
};

const protectiveCompletionRecord = {
  recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
  schemaVersion: 1,
  completionId: 'v1:2026-01-21:HSI.HK:LONG:1768963515000',
  tradingDayKey: '2026-01-21',
  monitorSymbol: 'HSI.HK',
  direction: 'LONG',
  boundaryExecutedTimeMs: 1768963515000,
  orderBaselines: [
    {
      orderId: 'protective-order',
      symbol: 'HK.12345',
      side: 'SELL',
      cumulativeQuantity: '200',
      cumulativeAmount: '24.6',
      lastExecutionTimeMs: 1768963515000,
      orderRevisionMs: 1768963517000,
    },
  ],
};

function toJsonl(records: ReadonlyArray<unknown>): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('calculateTradingFees utils', () => {
  it('parses ordinary trades from JSONL records', () => {
    const jsonl = toJsonl([validTrade]);

    expect(parseTrades(jsonl)).toEqual([validTrade]);
  });

  it('skips interleaved protective progress and completion records', () => {
    const secondTrade = { ...validTrade, orderId: 'order-2' };
    const jsonl = toJsonl([
      validTrade,
      protectiveProgressRecord,
      protectiveCompletionRecord,
      secondTrade,
    ]);

    expect(parseTrades(jsonl)).toEqual([validTrade, secondTrade]);
  });

  it('accepts nullable non-fee fields from persisted trade logs', () => {
    const persistedTrade = {
      ...validTrade,
      symbolName: null,
      monitorSymbol: 'HSI.HK',
      orderType: null,
      error: null,
      reason: null,
      signalTriggerTime: null,
      executedAt: '2026/05/22/10:45:15',
      executedAtMs: 1779417915000,
      timestamp: '2026/05/22/10:45:17',
      isProtectiveClearance: false,
    };

    expect(parseTrades(toJsonl([persistedTrade]))).toEqual([persistedTrade]);
  });

  it('fails fast on a record with an unknown recordType', () => {
    const jsonl = toJsonl([validTrade, { recordType: 'UNKNOWN_RECORD' }]);

    expect(() => parseTrades(jsonl)).toThrow('第 2 行混合交易记录无效');
    expect(() => parseTrades(jsonl)).toThrow('unknown recordType');
  });

  it('strictly validates known typed records before filtering them out', () => {
    const incompleteCompletion = {
      recordType: 'PROTECTIVE_LIQUIDATION_COMPLETION',
      schemaVersion: 1,
    };
    const invalidProgressVersion = { ...protectiveProgressRecord, schemaVersion: 2 };

    expect(() => parseTrades(toJsonl([incompleteCompletion]))).toThrow(
      'completion record fields incomplete',
    );

    expect(() => parseTrades(toJsonl([invalidProgressVersion]))).toThrow(
      'invalid V1 execution progress record',
    );
  });

  it('fails fast on empty and invalid JSON lines, including a damaged tail line', () => {
    expect(() => parseTrades(`${toJsonl([validTrade])}\n`)).toThrow('第 2 行交易日志为空行');
    expect(() => parseTrades(`${toJsonl([validTrade])}{broken}\n`)).toThrow(
      '第 2 行交易日志 JSON 无效',
    );
  });

  it('fails fast when the final JSONL record is not LF-terminated', () => {
    expect(() => parseTrades('{"recordType":"PROTECTIVE_LIQUIDATION_COMPLETION"}')).toThrow(
      '交易日志必须以 LF 结束',
    );
  });

  it('does not accept legacy JSON array files', () => {
    expect(() => parseTrades(`${JSON.stringify([validTrade])}\n`)).toThrow(
      'trade record unexpected field',
    );
  });

  it('fails fast when a trade record is missing required string fields', () => {
    expect(() =>
      parseTrades(
        toJsonl([
          {
            ...validTrade,
            price: null,
          },
        ]),
      ),
    ).toThrow('第 1 行交易记录字段无效：price');
  });

  it('fails fast when optional typed fields have invalid values', () => {
    expect(() =>
      parseTrades(
        toJsonl([
          {
            ...validTrade,
            orderType: 123,
          },
        ]),
      ),
    ).toThrow('[MixedTradeLogRepository] invalid trade record');
  });

  it('fails fast when quantity or price cannot produce a positive finite amount', () => {
    expect(() =>
      parseTradeNumbers({
        ...validTrade,
        quantity: 'abc',
      }),
    ).toThrow('交易记录 order-1 的 quantity 无效');

    expect(() =>
      parseTradeNumbers({
        ...validTrade,
        price: '0',
      }),
    ).toThrow('交易记录 order-1 的 price 无效');
  });
});
