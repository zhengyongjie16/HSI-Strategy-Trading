/** 默认 SDK 入口→真实 quoteClient；原生 tuple oracle 与纯 mapper case 位于 tests/infrastructure/longbridge/market。 */
import { describe, expect, it } from 'bun:test';
import { createNativeWarrantMarketFixture } from '../../../infrastructure/longbridge/market/warrantMarketFixture.js';
import { EXPIRY_DATE_FILTERS } from '../../../../src/constants/index.js';
import type { MarketWarrantListRequest } from '../../../../src/types/marketPorts.js';

describe('warrant request native mapping', () => {
  it('retains actual finder metadata values, SDK positional arguments and caller array ordering', async () => {
    const request: MarketWarrantListRequest = {
      symbol: 'HSI.HK',
      sortBy: 'TURNOVER',
      sortOrder: 'DESCENDING',
      types: ['BEAR', 'BULL'],
      issuerIds: [7, 2],
      expiryFilters: [...EXPIRY_DATE_FILTERS],
      inOutBoundsTypes: ['IN'],
      status: ['NORMAL'],
    };
    const { port, controller: fixture } = await createNativeWarrantMarketFixture();
    try {
      expect(fixture.getFactoryCallCount()).toBe(1);
      expect(await port.warrantList(request)).toEqual([]);
      fixture.assertReceivedExpectedRequest();
      expect(fixture.getReadCount()).toBe(1);
      expect(request.types).toEqual(['BEAR', 'BULL']);
      const invalid = { ...request };
      fixture.tamperRequestSort(invalid);
      let rejected: unknown;
      try {
        await port.warrantList(invalid);
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toBeInstanceOf(TypeError);
      expect(fixture.getReadCount()).toBe(1);
      const internalFault = new RangeError('request getter contract');
      Object.defineProperty(invalid, 'symbol', {
        get: () => {
          throw internalFault;
        },
      });

      try {
        await port.warrantList(invalid);
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toBe(internalFault);
      expect(fixture.getReadCount()).toBe(1);
    } finally {
      fixture.restore();
    }
  });
});
