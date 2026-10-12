/** 默认 QuoteContext 入口的离线 fixture：SDK context/位置参数私有化，仅向跨 owner 测试提供控制与断言。 */
import '../trade/offlineSdkGuard.js';
import { expect, mock } from 'bun:test';
import sdk, * as sdkNamespace from 'longbridge';
import {
  WarrantSortBy,
  SortOrderType,
  WarrantType,
  FilterWarrantExpiryDate,
  FilterWarrantInOutBoundsType,
  WarrantStatus,
  type QuoteContext,
} from 'longbridge';

// Bun namespace 在 mock.module 后仍为 live binding，必须在首个 fixture hook 前固化受保护值。
const protectedSdkExports = { ...sdk };
const protectedNamespaceExports = { ...sdkNamespace, default: protectedSdkExports };

function unexpected(): never {
  throw new Error('unconfigured offline quote SDK method');
}

/** 仅替换默认 SDK 工厂，不装配 quoteClient；restore 显式恢复具名和 default 的离线基线。 */
export function installNativeWarrantRequestFixture(): {
  readonly assertReceivedExpectedRequest: () => void;
  readonly getReadCount: () => number;
  readonly getFactoryCallCount: () => number;
  readonly tamperRequestSort: (request: object) => void;
  readonly restore: () => void;
} {
  const observed: unknown[][] = [];
  let factoryCalls = 0;
  const context: Pick<
    QuoteContext,
    | 'quote'
    | 'staticInfo'
    | 'subscribe'
    | 'unsubscribe'
    | 'realtimeQuote'
    | 'subscribeCandlesticks'
    | 'unsubscribeCandlesticks'
    | 'warrantQuote'
    | 'tradingDays'
    | 'setOnQuote'
    | 'setOnCandlestick'
    | 'warrantList'
  > = {
    quote: unexpected,
    staticInfo: unexpected,
    subscribe: unexpected,
    unsubscribe: unexpected,
    realtimeQuote: unexpected,
    subscribeCandlesticks: unexpected,
    unsubscribeCandlesticks: unexpected,
    warrantQuote: unexpected,
    tradingDays: unexpected,
    setOnQuote: () => {},
    setOnCandlestick: () => {},
    warrantList: async (...args) => {
      observed.push(args);
      return [];
    },
  };
  const installedSdkExports = {
    ...protectedSdkExports,
    QuoteContext: {
      new: () => {
        factoryCalls++;
        return context;
      },
    },
  };
  mock.module('longbridge', () => ({ ...installedSdkExports, default: installedSdkExports }));

  return {
    assertReceivedExpectedRequest: () => {
      expect(observed).toEqual([
        [
          'HSI.HK',
          WarrantSortBy.Turnover,
          SortOrderType.Descending,
          [WarrantType.Bear, WarrantType.Bull],
          [7, 2],
          [
            FilterWarrantExpiryDate.Between_3_6,
            FilterWarrantExpiryDate.Between_6_12,
            FilterWarrantExpiryDate.GT_12,
          ],
          [FilterWarrantInOutBoundsType.In],
          [WarrantStatus.Normal],
        ],
      ]);
    },
    getReadCount: () => observed.length,
    getFactoryCallCount: () => factoryCalls,
    tamperRequestSort: (request) => {
      Reflect.set(request, 'sortBy', WarrantSortBy.Turnover);
    },
    restore: () => {
      mock.module('longbridge', () => protectedNamespaceExports);
      expect(sdkNamespace.QuoteContext).toBe(protectedSdkExports.QuoteContext);
      expect(sdk.QuoteContext).toBe(protectedSdkExports.QuoteContext);
      expect(sdkNamespace.TradeContext).toBe(protectedSdkExports.TradeContext);
      expect(sdk.TradeContext).toBe(protectedSdkExports.TradeContext);
      expect(sdkNamespace.OAuth).toBe(protectedSdkExports.OAuth);
      expect(sdk.OAuth).toBe(protectedSdkExports.OAuth);
    },
  };
}
