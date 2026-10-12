/** 唯一轮证请求出站边界：当前finder中性语义→原SDK位置参数；不补渠道/筛选政策。 */
import {
  WarrantSortBy,
  SortOrderType,
  WarrantType,
  FilterWarrantExpiryDate,
  FilterWarrantInOutBoundsType,
  WarrantStatus,
  type QuoteContext,
} from 'longbridge';
import { isRecord } from '../../../utils/helpers/index.js';

/**
 * 先于SDK retry/IO验证完整请求，未知结构/语义保持内部契约错误。
 * @param request 当前实际caller可用的中性请求；运行时仍验证不可信边界
 * @returns 原SDK参数顺序、数组顺序与未提供undefined/null的含义
 */
export function mapWarrantListRequest(request: unknown): Parameters<QuoteContext['warrantList']> {
  if (
    !isRecord(request) ||
    typeof request['symbol'] !== 'string' ||
    request['symbol'].length === 0 ||
    request['sortBy'] !== 'TURNOVER' ||
    request['sortOrder'] !== 'DESCENDING' ||
    !Array.isArray(request['types'])
  ) {
    throw new TypeError('[WarrantRequestMapper] invalid neutral request identity/sort/types');
  }

  const types = request['types'].map((type: unknown) => {
    if (type === 'BULL') return WarrantType.Bull;

    if (type === 'BEAR') return WarrantType.Bear;

    throw new TypeError('[WarrantRequestMapper] unknown warrant type');
  });
  const rawIssuer = request['issuerIds'];
  let issuerIds: number[] | null | undefined;
  if (rawIssuer === null || rawIssuer === undefined) issuerIds = rawIssuer;
  else {
    if (!Array.isArray(rawIssuer))
      throw new TypeError('[WarrantRequestMapper] issuer IDs must be an array');

    issuerIds = rawIssuer.map((id: unknown) => {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)
        throw new TypeError('[WarrantRequestMapper] invalid structural issuer ID');

      return id;
    });
  }

  const rawExpiry = request['expiryFilters'];
  if (rawExpiry !== undefined && !Array.isArray(rawExpiry))
    throw new TypeError('[WarrantRequestMapper] expiry filters must be an array');

  const expiry = rawExpiry?.map((filter: unknown) => {
    if (filter === 'MONTHS_3_TO_6') return FilterWarrantExpiryDate.Between_3_6;

    if (filter === 'MONTHS_6_TO_12') return FilterWarrantExpiryDate.Between_6_12;

    if (filter === 'OVER_12_MONTHS') return FilterWarrantExpiryDate.GT_12;

    throw new TypeError('[WarrantRequestMapper] unknown expiry range');
  });
  const rawBounds = request['inOutBoundsTypes'];
  if (rawBounds !== undefined && !Array.isArray(rawBounds))
    throw new TypeError('[WarrantRequestMapper] bounds filters must be an array');

  const bounds = rawBounds?.map((filter: unknown) => {
    if (filter === 'IN') return FilterWarrantInOutBoundsType.In;

    throw new TypeError('[WarrantRequestMapper] unknown bounds filter');
  });
  const rawStatus = request['status'];
  if (rawStatus !== undefined && !Array.isArray(rawStatus))
    throw new TypeError('[WarrantRequestMapper] status filters must be an array');

  const status = rawStatus?.map((filter: unknown) => {
    if (filter === 'NORMAL') return WarrantStatus.Normal;

    throw new TypeError('[WarrantRequestMapper] unknown status filter');
  });
  return [
    request['symbol'],
    WarrantSortBy.Turnover,
    SortOrderType.Descending,
    types,
    issuerIds,
    expiry,
    bounds,
    status,
  ];
}
