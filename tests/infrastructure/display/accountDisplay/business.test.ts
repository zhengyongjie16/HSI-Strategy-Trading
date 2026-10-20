/** 账户展示测试：canonical 只读输入、精确估值、一次 half-even 与原生负零政策。 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  AccountPositionSnapshotReader,
  AccountPositionSnapshotView,
} from '../../../../src/types/accountPosition.js';
import { createAccountPositionSnapshotReaderDouble } from '../../../helpers/testDoubles.js';

const infoLogs: string[] = [];
mock.module('../../../../src/infrastructure/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: (message: string) => infoLogs.push(message),
    warn: () => {},
    error: () => {},
  },
}));
import { displayAccountAndPositions } from '../../../../src/infrastructure/display/accountDisplay/index.js';

const token = {
  dayEpoch: 1,
  snapshotGeneration: 1,
  commitRevision: 1,
  accountRevision: 1,
  positionRevision: 1,
  pairedRevision: 1,
};
const view: AccountPositionSnapshotView = {
  token,
  accountInitialized: true,
  positionsInitialized: true,
  accountValid: true,
  positionsValid: true,
  account: {
    currency: 'HKD',
    totalCash: '1234.5',
    netAssets: '2344.5',
    positionValue: '1111.1',
    cashInfos: [],
  },
  positions: [
    {
      symbol: '700.HK',
      symbolName: 'Tencent',
      accountChannel: 'live',
      quantity: 100,
      availableQuantity: 80,
      currency: 'HKD',
      costPrice: '12.34',
    },
  ],
};

function reader(value: AccountPositionSnapshotView): AccountPositionSnapshotReader {
  return createAccountPositionSnapshotReaderDouble({
    getView: () => value,
    isCurrent: (captured, components) =>
      captured.dayEpoch === value.token.dayEpoch &&
      captured.snapshotGeneration === value.token.snapshotGeneration &&
      (!components.account ||
        (value.accountValid && captured.accountRevision === value.token.accountRevision)) &&
      (!components.positions ||
        (value.positionsValid && captured.positionRevision === value.token.positionRevision)) &&
      (!components.paired || captured.pairedRevision === value.token.pairedRevision),
  });
}

describe('accountDisplay exact canonical view', () => {
  it('formats account channel, exact valuation and ratio', () => {
    infoLogs.length = 0;
    displayAccountAndPositions({
      snapshot: reader(view),
      quotesMap: new Map([
        [
          '700.HK',
          { symbol: '700.HK', name: 'Tencent', price: '40.125', prevClose: '39.5', timestamp: 1 },
        ],
      ]),
    });
    const output = infoLogs.join('\n');
    for (const text of [
      '账户概览 [HKD] 余额=1234.50',
      '[实盘交易]',
      'Tencent(700.HK)',
      '持仓=100.00',
      '可用=80.00',
      '现价=40.125',
      '市值=4012.50',
      '仓位=171.15%',
    ]) {
      expect(output).toContain(text);
    }
  });

  it('preserves high significant digits, single rounding and native-path negative zero', () => {
    infoLogs.length = 0;
    displayAccountAndPositions({
      snapshot: reader({
        ...view,
        account: {
          currency: 'HKD',
          totalCash: '9007199254740993.015',
          netAssets: '1.0051',
          positionValue: '-0.001',
          cashInfos: [],
        },
        positions: [],
      }),
    });
    expect(infoLogs[0]).toContain('余额=9007199254740993.02 市值=1.01 持仓市值≈-0.00');
  });

  it('keeps the original missing-quote placeholders and zero valuation without mutating readonly facts', () => {
    infoLogs.length = 0;
    const before = JSON.stringify(view);
    displayAccountAndPositions({ snapshot: reader(view), quotesMap: new Map() });
    expect(infoLogs.join('\n')).toContain(
      '持仓=100.00 可用=80.00 现价=N/A 市值=0.00 仓位=0.00% HKD',
    );
    expect(JSON.stringify(view)).toBe(before);
  });

  it('binds the readonly fixture to its original token and requested component validity without a ready default', () => {
    const snapshot = reader(view);
    const components = { account: true, positions: true, paired: true };
    expect(snapshot.isCurrent(token, components)).toBeTrue();
    expect(snapshot.isCurrent({ ...token, dayEpoch: token.dayEpoch + 1 }, components)).toBeFalse();
    expect(
      snapshot.isCurrent({ ...token, positionRevision: token.positionRevision + 1 }, components),
    ).toBeFalse();
    expect(reader({ ...view, accountValid: false }).isCurrent(token, components)).toBeFalse();
    expect(reader({ ...view, positionsValid: false }).isCurrent(token, components)).toBeFalse();
    expect(snapshot.getStatus().admission).toBe('CLOSED');
  });

  it('expands extreme double exponents without quantizing away a non-zero valuation', () => {
    infoLogs.length = 0;
    displayAccountAndPositions({
      snapshot: reader({
        ...view,
        positions: [
          {
            ...view.positions[0]!,
            symbol: 'BIG.HK',
            symbolName: 'Big',
            quantity: 1e21,
            availableQuantity: 1e21,
          },
          {
            ...view.positions[0]!,
            symbol: 'TINY.HK',
            symbolName: 'Tiny',
            quantity: 1e-21,
            availableQuantity: 1e-21,
          },
        ],
      }),
      quotesMap: new Map([
        ['BIG.HK', { symbol: 'BIG.HK', name: 'Big', price: '1', prevClose: '1', timestamp: 1 }],
        [
          'TINY.HK',
          {
            symbol: 'TINY.HK',
            name: 'Tiny',
            price: '1000000000000000000000',
            prevClose: '1',
            timestamp: 1,
          },
        ],
      ]),
    });

    const bigLine = infoLogs.find((line) => line.includes('BIG.HK')) ?? '';
    const tinyLine = infoLogs.find((line) => line.includes('TINY.HK')) ?? '';
    expect(bigLine).toContain('持仓=1000000000000000000000.00');
    expect(bigLine).toContain('市值=1000000000000000000000.00');
    expect(tinyLine).toContain('持仓=0.00');
    expect(tinyLine).toContain('市值=1.00');
    expect(tinyLine).not.toContain('市值=0.00');
  });

  it('does not swallow broken internal financial text', () => {
    expect(() => {
      displayAccountAndPositions({
        snapshot: reader({ ...view, account: { ...view.account!, totalCash: 'NaN' } }),
      });
    }).toThrow(TypeError);
  });
});
