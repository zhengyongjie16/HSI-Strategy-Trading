/** SDK 枚举 seam 检查：双向周期、订阅时段及港股日历映射不把 SDK 数字传播到中性事实。 */
import { describe, expect, test } from 'bun:test';
import { Market, Period, TradeSessions, TradeStatus } from 'longbridge';
import type { CandlestickPeriod } from '../../../../src/types/marketPorts.js';
import {
  mapCandlestickPeriodToSdk,
  mapMarketToSdk,
  mapSdkPeriod,
  mapTradeSessionToSdk,
  mapSdkSecurityTradingStatus,
} from '../../../../src/infrastructure/longbridge/market/marketEnumMapper.js';

const periods: ReadonlyArray<readonly [CandlestickPeriod, Period]> = [
  ['MIN_1', Period.Min_1],
  ['MIN_2', Period.Min_2],
  ['MIN_3', Period.Min_3],
  ['MIN_5', Period.Min_5],
  ['MIN_10', Period.Min_10],
  ['MIN_15', Period.Min_15],
  ['MIN_20', Period.Min_20],
  ['MIN_30', Period.Min_30],
  ['MIN_45', Period.Min_45],
  ['MIN_60', Period.Min_60],
  ['MIN_120', Period.Min_120],
  ['MIN_180', Period.Min_180],
  ['MIN_240', Period.Min_240],
  ['DAY', Period.Day],
  ['WEEK', Period.Week],
  ['MONTH', Period.Month],
  ['QUARTER', Period.Quarter],
  ['YEAR', Period.Year],
];

describe('market enum mapper', () => {
  test('完整中性周期集合与 SDK 周期精确往返', () => {
    for (const [period, sdkPeriod] of periods) {
      expect(mapCandlestickPeriodToSdk(period)).toBe(sdkPeriod);
      expect(mapSdkPeriod(sdkPeriod)).toBe(period);
    }

    expect(mapTradeSessionToSdk('INTRADAY')).toBe(TradeSessions.Intraday);
    expect(mapTradeSessionToSdk('ALL')).toBe(TradeSessions.All);
    expect(mapMarketToSdk('HK')).toBe(Market.HK);
  });

  test('完整映射 11 个证券状态，终止交易与停牌保持不同事实', () => {
    for (const [sdkStatus, neutralStatus] of [
      [TradeStatus.Normal, 'NORMAL'],
      [TradeStatus.Halted, 'HALTED'],
      [TradeStatus.Delisted, 'DELISTED'],
      [TradeStatus.Fuse, 'FUSE'],
      [TradeStatus.PrepareList, 'PREPARE_LIST'],
      [TradeStatus.CodeMoved, 'CODE_MOVED'],
      [TradeStatus.ToBeOpened, 'TO_BE_OPENED'],
      [TradeStatus.SplitStockHalts, 'SPLIT_STOCK_HALTS'],
      [TradeStatus.Expired, 'EXPIRED'],
      [TradeStatus.WarrantPrepareList, 'WARRANT_PREPARE_LIST'],
      [TradeStatus.Suspend, 'SUSPEND'],
    ] as const) {
      expect(mapSdkSecurityTradingStatus(sdkStatus)).toBe(neutralStatus);
    }
  });

  test.each([undefined, null, 99999, 'Normal', String(TradeStatus.Normal), false, {}])(
    '未知、缺失或非法类型 %p 直接拒绝',
    (status) => {
      expect(() => mapSdkSecurityTradingStatus(status)).toThrow(TypeError);
    },
  );

  test('旧 SDK 周期与 Unknown 不作为中性输入的兼容回退', () => {
    expect(() => mapCandlestickPeriodToSdk(Period.Min_1 as unknown as CandlestickPeriod)).toThrow();
    expect(() => mapSdkPeriod(Period.Unknown)).toThrow();
    expect(() => mapTradeSessionToSdk(TradeSessions.Intraday)).toThrow();
    expect(() => mapMarketToSdk(Market.HK)).toThrow();
  });
});
