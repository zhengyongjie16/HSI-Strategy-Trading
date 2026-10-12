/**
 * P0 金融字段/直接投影正反例；字段 closure 与实际 TS 契约角色决定分类。
 * 不把 occurrence 探针当作任意跨函数数据流、数量策略或 P1–P4 精度验收。
 */
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { frozenNumeric, newNumeric, numericOccurrences } from './numericProbe.js';
import { listTypeScript, sourceText } from './scanner.js';

const probe = (source: string) =>
  numericOccurrences('src/application/numericBoundaryProbe.ts', source);
const account =
  'type AccountSnapshot = { readonly positionValue: string; readonly netAssets: string };';
const quote = 'type Quote = { readonly price: string };';

describe('P0.3 staged financial boundaries', () => {
  it('freezes audited old financial occurrences, allowing deletion only', () => {
    const actual = listTypeScript('src').flatMap((file) =>
      numericOccurrences(file.replaceAll(path.sep, '/'), sourceText(file)),
    );
    for (const stage of ['P1', 'P4.5', 'P6'] as const)
      expect(newNumeric(actual, frozenNumeric, stage)).toEqual([]);
  });

  it.each([
    'type AccountSnapshot = { readonly positionValue: number };',
    'type AccountSnapshot = { readonly positionValue: string | number | null };',
    'type NumberBridge = number; type AccountSnapshot = { readonly positionValue: NumberBridge };',
    `${account} const f = (fact: AccountSnapshot) => Number(fact["positionValue"]);`,
    `${account} const f = (fact: AccountSnapshot) => Number(fact.positionValue);`,
    `${account} const f = (fact: AccountSnapshot) => parseFloat(fact.netAssets);`,
    `${account} const format = (fact: AccountSnapshot) => Number(fact.positionValue).toFixed(2);`,
    `${account} const format = (fact: AccountSnapshot) => { const raw = fact.positionValue; const projected = Number(raw); return projected.toFixed(2); };`,
    `${account} declare function toNumber(value: unknown): number; const f = (fact: AccountSnapshot) => toNumber(fact.positionValue);`,
    `${account} declare function decimalToNumberValue(value: unknown): number; const f = (fact: AccountSnapshot) => decimalToNumberValue(fact.positionValue);`,
    'type DailyLossAuthoritativeFactSnapshot = { readonly cumulativeAmount: string }; declare class Decimal { constructor(value: number); } const fact: DailyLossAuthoritativeFactSnapshot = { cumulativeAmount: new Decimal(0.1) };',
    'type AccountSnapshot = { readonly positionValue: { toNumber(): number } }; const f = (fact: AccountSnapshot) => fact.positionValue.toNumber();',
    `${quote} declare class Decimal { constructor(value: number); } const value: Quote = { price: new Decimal(0.1) };`,
    'type TradeRecord = { readonly price: string }; declare class Decimal { constructor(value: number); } const durable: TradeRecord = { price: new Decimal(0.1 + 0.2) };',
    `${account} const f = (fact: AccountSnapshot, count: number) => { if (!Number.isSafeInteger(count)) throw new Error(); return Number(fact.positionValue); };`,
  ])(
    'rejects financial facts, number-origin decimal construction, display and durable loss',
    (source) => {
      expect(probe(source).length).toBeGreaterThan(0);
    },
  );

  it.each([
    'type AccountSnapshot = { readonly positionValue: string };',
    'type AccountSnapshot = { readonly positionValue: string | null };',
    `${account} const f = (fact: AccountSnapshot) => fact.positionValue;`,
    'type Quote = { readonly price: { toNumber(): number } };',
    'type Quote = { readonly price: string }; declare class Decimal { constructor(value: string); } const value: Quote = { price: new Decimal("0.1") };',
    'type Storage = { readonly size: number; readonly positionValue: number; readonly price: number };',
    'const f = (size: string) => Number(size); for (let i = 0; i < 10; i++) {}',
    'type CandleData = { readonly close: { toNumber(): number } }; const sample = (candle: CandleData) => candle.close.toNumber();',
    'declare function toNumber(value: unknown): number; type CandleData = { readonly close: unknown }; const sample = (candle: CandleData) => toNumber(candle.close);',
    'const quantityView = (text: string) => { if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(); const quantity = BigInt(text); if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(); return Number(quantity); };',
    'const quantity = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(); return value; };',
    'type Clock = { readonly timestampMs: number; readonly revision: number; readonly count: number };',
    'const indicator = (sample: number, alpha: number) => sample * alpha;',
  ])(
    'allows financial text, proved quantity view, indicator boundary and structure numbers',
    (source) => {
      expect(probe(source)).toEqual([]);
    },
  );

  it('anchors field diagnostics to the typed declaration rather than an unrelated name', () => {
    expect(probe('type AccountSnapshot = { readonly positionValue: number };')).toEqual([
      JSON.stringify([
        'src/application/numericBoundaryProbe.ts',
        'FINANCIAL_NUMBER',
        'AccountSnapshot',
        'positionValue',
        'number',
      ]),
    ]);
    expect(probe('type Loop = { readonly positionValue: number };')).toEqual([]);
  });

  it('expires the original P1 financial contract at its old path, not only in new layers', () => {
    const actual = numericOccurrences(
      'src/types/services.ts',
      'type UnrealizedLossMetrics = { readonly r1: number };',
    );
    expect(actual).toHaveLength(1);
    expect(newNumeric(actual, frozenNumeric, 'P0')).toEqual([]);
    expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual(actual);
    expect(newNumeric(actual, frozenNumeric, 'P2')).toEqual(actual);
  });

  it.each([
    ['src/types/config.ts', 'MonitorConfig', 'targetNotional', 'number'],
    ['src/types/services.ts', 'RiskChecker', 'orderNotional', 'number'],
    ['src/types/services.ts', 'PendingOrder', 'submittedPrice', 'number | null'],
    ['src/core/riskController/types.ts', 'WarrantInfo', 'callPrice', 'number | null'],
    ['src/core/riskController/types.ts', 'DailyLossOrderBaseline', 'cumulativeAmount', 'number'],
    ['src/core/trader/types.ts', 'TrackedOrder', 'executedPrice', 'number | null'],
    [
      'src/core/trader/orderMonitor/types.ts',
      'OrderObservedFact',
      'executedPrice',
      'number | null',
    ],
  ])(
    'rejects a closed mixed-closure contract at its real original path: %s %s.%s',
    (file, parent, name, type) => {
      const actual = numericOccurrences(file, `type ${parent} = { readonly ${name}: ${type} };`);
      expect(actual).toHaveLength(1);
      expect(newNumeric(actual, frozenNumeric, 'P0')).toEqual([]);
      expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual(actual);
      expect(newNumeric(actual, frozenNumeric, 'P4.5')).toEqual(actual);
      expect(numericOccurrences(file, `type ${parent} = { readonly ${name}: string };`)).toEqual(
        [],
      );
    },
  );

  it('expires a closed command parameter at its original contract, not just property declarations', () => {
    const actual = numericOccurrences(
      'src/core/trader/orderExecutor/types.ts',
      'interface QuantityResolver { readonly resolveBuyQuantity: (targetNotional: number) => number; }',
    );
    expect(actual).toHaveLength(1);
    expect(newNumeric(actual, frozenNumeric, 'P0')).toEqual([]);
    expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual(actual);
  });

  it('keeps safe quantity fields in a closed contract numeric', () => {
    const actual = numericOccurrences(
      'src/core/trader/types.ts',
      'type TrackedOrder = { readonly executedPrice: string; readonly executedQuantity: number; readonly quantity: number };',
    );
    expect(actual).toEqual([]);
    expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual([]);
  });

  it('does not promote mixed future closure to P1 and preserves safe quantity numbers', () => {
    const deferred = numericOccurrences(
      'src/services/autoSymbolManager/types.ts',
      'type SwitchState = { readonly sellNotional: number | null };',
    );
    expect(deferred).toHaveLength(1);
    expect(newNumeric(deferred, frozenNumeric, 'P1')).toEqual([]);
    expect(newNumeric(deferred, frozenNumeric, 'P3C')).toEqual([]);
    expect(newNumeric(deferred, frozenNumeric, 'P3D')).toEqual(deferred);
    expect(newNumeric(deferred, frozenNumeric, 'P4.5')).toEqual(deferred);
    expect(newNumeric(deferred, frozenNumeric, 'P6')).toEqual(deferred);
    const safeQuantity = numericOccurrences(
      'src/types/services.ts',
      'type UnrealizedLossMetrics = { readonly r1: string; readonly n1: number };',
    );
    expect(safeQuantity).toEqual([]);
    expect(newNumeric(safeQuantity, frozenNumeric, 'P1')).toEqual([]);
  });

  it('expires remaining audited financial fields by final P4, not their physical directory deadline', () => {
    const actual = numericOccurrences(
      'src/services/autoSymbolFinder/types.ts',
      'type WarrantCandidate = { readonly turnover: number };',
    );
    expect(actual).toHaveLength(1);
    expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual([]);
    expect(newNumeric(actual, frozenNumeric, 'P4.5')).toEqual(actual);
    expect(newNumeric(actual, frozenNumeric, 'P6')).toEqual(actual);
  });

  it.each([
    [
      'src/config/utils.ts',
      `${quote} declare const q: Quote; const value = q.price; const projected = Number(value);`,
    ],
    [
      'src/config/utils.ts',
      `${quote} function getNumberConfig(q: Quote) { const value = q.price; return Number(value); }`,
    ],
    [
      'src/config/utils.ts',
      `${quote} function parseLiquidationCooldownConfig(q: Quote) { const value = q.price; return Number(value); }`,
    ],
    [
      'src/config/utils.ts',
      'type Quote = { readonly prevClose: string }; function getNumberConfig(q: Quote) { const value = q.prevClose; return Number(value); }',
    ],
    [
      'src/utils/time/index.ts',
      `${quote} function getHKTime(q: Quote) { const hours = q.price; return Number(hours); }`,
    ],
  ])('does not reuse old structural projections for a financial alias at %s', (file, source) => {
    const actual = numericOccurrences(file, source);
    expect(actual).toHaveLength(1);
    for (const stage of ['P0', 'P1', 'P4.5', 'P6'] as const)
      expect(newNumeric(actual, frozenNumeric, stage)).toEqual(actual);
  });

  it('preserves the original projection function and expires it with its financial slice', () => {
    const file = 'src/core/trader/accountService.ts';
    const source = `type AccountSnapshot = { readonly totalCash: string }; declare function decimalToNumber(value: unknown): number; function getAccountSnapshot(primary: AccountSnapshot) { const projected = decimalToNumber(primary.totalCash); return projected; }`;
    const actual = numericOccurrences(file, source);
    expect(actual).toEqual([
      JSON.stringify([
        file,
        'PROJECTION',
        'getAccountSnapshot',
        'decimalToNumber(primary.totalCash)',
      ]),
    ]);
    expect(newNumeric(actual, frozenNumeric, 'P0')).toEqual([]);
    expect(newNumeric([...actual, ...actual], frozenNumeric, 'P0')).toEqual(actual);
    for (const stage of ['P1', 'P4.5', 'P6'] as const)
      expect(newNumeric(actual, frozenNumeric, stage)).toEqual(actual);

    const relocated = numericOccurrences(
      file,
      source.replace('getAccountSnapshot(', 'readAccount('),
    );
    expect(relocated).toHaveLength(1);
    expect(newNumeric(relocated, frozenNumeric, 'P0')).toEqual(relocated);
  });

  it('keeps a future financial projection only until its owning slice', () => {
    const actual = numericOccurrences(
      'src/services/autoSymbolFinder/utils.ts',
      'type WarrantCandidate = { readonly turnover: string }; declare function decimalToNumberValue(value: unknown): number; function toWarrantCandidate(candidate: WarrantCandidate) { return decimalToNumberValue(candidate.turnover); }',
    );
    expect(actual).toHaveLength(1);
    expect(newNumeric(actual, frozenNumeric, 'P1')).toEqual([]);
    for (const stage of ['P3F', 'P4.5', 'P6'] as const)
      expect(newNumeric(actual, frozenNumeric, stage)).toEqual(actual);
  });

  it('registers prevClose as the real Quote financial role without changing the P0 audit', () => {
    const actual = numericOccurrences(
      'src/types/quote.ts',
      'type Quote = { readonly prevClose: number; readonly timestamp: number; readonly lotSize: number };',
    );
    expect(actual).toEqual([
      JSON.stringify(['src/types/quote.ts', 'FINANCIAL_NUMBER', 'Quote', 'prevClose', 'number']),
    ]);
    expect(newNumeric(actual, frozenNumeric, 'P0')).toEqual([]);
    for (const stage of ['P1', 'P4.5', 'P6'] as const)
      expect(newNumeric(actual, frozenNumeric, stage)).toEqual(actual);

    expect(numericOccurrences('src/types/quote.ts', sourceText('src/types/quote.ts'))).toEqual([]);
  });

  it.each([
    'Number(q.prevClose)',
    'Number(q["prevClose"])',
    'parseFloat(q.prevClose)',
    'Number.parseFloat(q.prevClose)',
    'Number(value).toFixed(2)',
  ])(
    'rejects direct/one-alias prevClose projection through the real imported contract: %s',
    (expression) => {
      const actual = numericOccurrences(
        'src/services/marketMonitor/utils.ts',
        `import type { Quote } from '../../types/quote.js'; declare const q: Quote; const value = q.prevClose; const projected = ${expression};`,
      );
      expect(actual).toHaveLength(1);
      for (const stage of ['P1', 'P4.5', 'P6'] as const)
        expect(newNumeric(actual, frozenNumeric, stage)).toEqual(actual);
    },
  );

  it.each([
    [
      'src/config/utils.ts',
      'function getNumberConfig(value: string) { return Number(value); } function parseLiquidationCooldownConfig(value: string) { return Number(value); }',
    ],
    [
      'src/utils/time/index.ts',
      'function getHKTime(hours: string, minutes: string) { return [Number(hours), Number(minutes)]; }',
    ],
    [
      'src/types/quote.ts',
      'type Quote = { readonly prevClose: string; readonly timestamp: number; readonly lotSize: number }; type Storage = { readonly prevClose: number };',
    ],
    [
      'src/application/numericBoundaryProbe.ts',
      'type Indicator = { readonly prevClose: string }; declare const sample: Indicator; const projected = Number(sample.prevClose);',
    ],
    [
      'src/services/autoSymbolManager/types.ts',
      'type SwitchState = { readonly sellNotional: string | null; readonly seatVersion: number; readonly quoteRetryAttempts: number; readonly quoteRetryNextAt: number | null };',
    ],
  ])(
    'preserves unrelated indicators, structure and quantity at %s in final stages',
    (file, source) => {
      const actual = numericOccurrences(file, source);
      expect(actual).toEqual([]);
      expect(newNumeric(actual, frozenNumeric, 'P6')).toEqual([]);
    },
  );

  it('keeps the real proved safe-quantity helper numeric in final stages', () => {
    const file = 'src/utils/numeric/exact.ts';
    const actual = numericOccurrences(file, sourceText(file));
    expect(actual).toEqual([]);
    expect(newNumeric(actual, frozenNumeric, 'P6')).toEqual([]);
  });

  it('uses multiset deletion, never a file/function-wide allowance', () => {
    const occurrence = probe('type AccountSnapshot = { readonly positionValue: number };')[0]!;
    expect(newNumeric([occurrence, occurrence], [occurrence], 'P0')).toEqual([occurrence]);
    expect(newNumeric([], [occurrence], 'P0')).toEqual([]);
  });
});
