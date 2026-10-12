/** 从 P1Native/market/warrantRequestMapper 分离的纯 mapper case；真实 SDK 枚举和位置参数留在 infra。 */
import { describe, expect, it } from 'bun:test';
import { WarrantSortBy, WarrantType, WarrantStatus } from 'longbridge';
import { mapWarrantListRequest } from '../../../../src/infrastructure/longbridge/market/warrantRequestMapper.js';

describe('warrant request native mapping', () => {
  it('does not default absent filters or convert explicit issuer null into undefined', () => {
    const required = {
      symbol: 'HSI.HK',
      sortBy: 'TURNOVER',
      sortOrder: 'DESCENDING',
      types: ['BULL'],
    };
    expect(mapWarrantListRequest(required).slice(4)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    expect(mapWarrantListRequest({ ...required, issuerIds: null }).slice(4)).toEqual([
      null,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('unknown/native enum inputs and invalid structural IDs fail before native SDK entry', () => {
    const base = { symbol: 'HSI.HK', sortBy: 'TURNOVER', sortOrder: 'DESCENDING', types: ['BULL'] };
    const issued = { count: 0 };
    for (const patch of [
      { sortBy: WarrantSortBy.Turnover },
      { types: [WarrantType.Bull] },
      { status: [WarrantStatus.Normal] },
      { expiryFilters: ['UNKNOWN'] },
      { expiryFilters: null },
      { issuerIds: ['7'] },
      { issuerIds: [1.5] },
      { issuerIds: [9007199254740992] },
    ]) {
      expect(() => {
        mapWarrantListRequest({ ...base, ...patch });
        issued.count++;
      }).toThrow(TypeError);
    }

    expect(issued.count).toBe(0);
  });
});
