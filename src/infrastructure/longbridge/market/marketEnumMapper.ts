/** Longbridge 市场枚举边界：中性周期、交易时段、证券交易状态与市场在 SDK 边界显式映射。 */
import { Market, Period, TradeSessions, TradeStatus } from 'longbridge';
import type { CandlestickPeriod, SecurityTradingStatus } from '../../../types/marketPorts.js';

/** 映射中性 K 线周期；未知运行时输入属于内部契约错误，不交给 SDK 猜测。 */
export function mapCandlestickPeriodToSdk(period: CandlestickPeriod): Period {
  switch (period) {
    case 'MIN_1': {
      return Period.Min_1;
    }

    case 'MIN_2': {
      return Period.Min_2;
    }

    case 'MIN_3': {
      return Period.Min_3;
    }

    case 'MIN_5': {
      return Period.Min_5;
    }

    case 'MIN_10': {
      return Period.Min_10;
    }

    case 'MIN_15': {
      return Period.Min_15;
    }

    case 'MIN_20': {
      return Period.Min_20;
    }

    case 'MIN_30': {
      return Period.Min_30;
    }

    case 'MIN_45': {
      return Period.Min_45;
    }

    case 'MIN_60': {
      return Period.Min_60;
    }

    case 'MIN_120': {
      return Period.Min_120;
    }

    case 'MIN_180': {
      return Period.Min_180;
    }

    case 'MIN_240': {
      return Period.Min_240;
    }

    case 'DAY': {
      return Period.Day;
    }

    case 'WEEK': {
      return Period.Week;
    }

    case 'MONTH': {
      return Period.Month;
    }

    case 'QUARTER': {
      return Period.Quarter;
    }

    case 'YEAR': {
      return Period.Year;
    }

    default: {
      throw new TypeError(`Unknown market period: ${String(period)}`);
    }
  }
}

/** 映射 SDK push 周期，不让数字枚举进入缓存或策略上下文。 */
export function mapSdkPeriod(period: Period): CandlestickPeriod {
  switch (period) {
    case Period.Min_1: {
      return 'MIN_1';
    }

    case Period.Min_2: {
      return 'MIN_2';
    }

    case Period.Min_3: {
      return 'MIN_3';
    }

    case Period.Min_5: {
      return 'MIN_5';
    }

    case Period.Min_10: {
      return 'MIN_10';
    }

    case Period.Min_15: {
      return 'MIN_15';
    }

    case Period.Min_20: {
      return 'MIN_20';
    }

    case Period.Min_30: {
      return 'MIN_30';
    }

    case Period.Min_45: {
      return 'MIN_45';
    }

    case Period.Min_60: {
      return 'MIN_60';
    }

    case Period.Min_120: {
      return 'MIN_120';
    }

    case Period.Min_180: {
      return 'MIN_180';
    }

    case Period.Min_240: {
      return 'MIN_240';
    }

    case Period.Day: {
      return 'DAY';
    }

    case Period.Week: {
      return 'WEEK';
    }

    case Period.Month: {
      return 'MONTH';
    }

    case Period.Quarter: {
      return 'QUARTER';
    }

    case Period.Year: {
      return 'YEAR';
    }

    case Period.Unknown: {
      throw new TypeError('Unknown SDK candlestick period');
    }

    default: {
      throw new TypeError(`Unknown SDK candlestick period: ${String(period)}`);
    }
  }
}

/** 映射订阅时段，只接受已声明的日内或全部时段。 */
export function mapTradeSessionToSdk(session: unknown): TradeSessions {
  if (session === 'INTRADAY') return TradeSessions.Intraday;

  if (session === 'ALL') return TradeSessions.All;

  throw new TypeError(`Unknown market trade session: ${String(session)}`);
}

/** 严格解释 SDK 证券交易状态；缺失、未知及非法类型不得伪装成已确认非正常或 Normal。 */
export function mapSdkSecurityTradingStatus(status: unknown): SecurityTradingStatus {
  switch (status) {
    case TradeStatus.Normal: {
      return 'NORMAL';
    }

    case TradeStatus.Halted: {
      return 'HALTED';
    }

    case TradeStatus.Delisted: {
      return 'DELISTED';
    }

    case TradeStatus.Fuse: {
      return 'FUSE';
    }

    case TradeStatus.PrepareList: {
      return 'PREPARE_LIST';
    }

    case TradeStatus.CodeMoved: {
      return 'CODE_MOVED';
    }

    case TradeStatus.ToBeOpened: {
      return 'TO_BE_OPENED';
    }

    case TradeStatus.SplitStockHalts: {
      return 'SPLIT_STOCK_HALTS';
    }

    case TradeStatus.Expired: {
      return 'EXPIRED';
    }

    case TradeStatus.WarrantPrepareList: {
      return 'WARRANT_PREPARE_LIST';
    }

    case TradeStatus.Suspend: {
      return 'SUSPEND';
    }

    default: {
      throw new TypeError(`Unknown SDK security trading status: ${String(status)}`);
    }
  }
}

/** 映射交易日历市场参数，缺省港股由调用边界显式传入。 */
export function mapMarketToSdk(market: unknown): Market {
  if (market !== 'HK') throw new TypeError(`Unknown market region: ${String(market)}`);

  return Market.HK;
}
