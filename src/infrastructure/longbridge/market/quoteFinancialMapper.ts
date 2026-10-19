/** Longbridge 报价金融 mapper：只从 SDK Decimal 文本读取，不经 number 金融桥。 */
import { WarrantStatus } from 'longbridge';
import { canonicalDecimal } from '../../../utils/numeric/exact.js';
import { isRecord } from '../../../utils/helpers/index.js';
import type { MarketQuoteContext } from '../../../types/marketPorts.js';

/**
 * 将 SDK Decimal 或已保真文本映射为规范文本；缺失行情由调用方按既有无行情语义处理。
 * @param value SDK 金融字段
 * @returns 保真文本，缺失字段返回 null
 */
export function mapQuoteDecimal(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    const normalized = canonicalDecimal(value);
    return normalized === '0' && value.startsWith('-') ? '-0' : normalized;
  }

  if (typeof value === 'object' && 'toString' in value) {
    const stringify: unknown = Reflect.get(value, 'toString');
    if (typeof stringify !== 'function') {
      throw new TypeError('Quote financial field must originate from Decimal text');
    }

    const text: unknown = Reflect.apply(stringify, value, []);
    if (typeof text !== 'string') {
      throw new TypeError('Quote Decimal.toString must return text');
    }

    const normalized = canonicalDecimal(text);
    return normalized === '0' && text.startsWith('-') ? '-0' : normalized;
  }

  throw new TypeError('Quote financial field must originate from Decimal text');
}

/** 保留 warrant 缺失字段的 undefined 与 null；不以默认零补金融事实。 */
function mapOptionalQuoteDecimal(value: unknown): string | null | undefined {
  return value === undefined ? undefined : mapQuoteDecimal(value);
}

/** 结构性 SDK enum 允许原 number/string，不作为金融数值读取。 */
function mapWarrantEnum(value: unknown): number | string | null | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string'
  )
    return value;

  throw new TypeError('Warrant enum field must be a scalar');
}

/** 仅adapter比较SDK状态enum；缺失保持原义，非正常状态不被默认放行。 */
function mapWarrantStatus(value: unknown): 'NORMAL' | 'NON_NORMAL' | null | undefined {
  if (value === null || value === undefined) return value;

  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new TypeError('Invalid SDK warrant status');

  return new Set<unknown>([WarrantStatus.Normal]).has(value) ? 'NORMAL' : 'NON_NORMAL';
}

/**
 * 将真实 SDK warrantQuote 的已消费字段映射为窄中立报价；金融值只从原文读取。
 * @param value SDK warrantQuote 原始行
 * @returns 不暴露 SDK Decimal 的中立报价，保留缺失语义
 */
export function mapWarrantQuote(
  value: unknown,
): Awaited<ReturnType<MarketQuoteContext['warrantQuote']>>[number] {
  if (!isRecord(value) || typeof value['symbol'] !== 'string')
    throw new TypeError('Warrant quote identity missing');

  const category = mapWarrantEnum(value['category']);
  return {
    ...('callPrice' in value ? { callPrice: mapOptionalQuoteDecimal(value['callPrice']) } : {}),
    ...(category === undefined ? {} : { category }),
  };
}

/**
 * 将真实 SDK warrantList 的已消费字段映射为窄中立列表行；不计算候选/距离/日志等领域公式。
 * @param value SDK warrantList 原始行
 * @returns 金融字段保真文本、结构字段保持原型别的中立列表行
 */
export function mapWarrantListItem(
  value: unknown,
): Awaited<ReturnType<MarketQuoteContext['warrantList']>>[number] {
  if (!isRecord(value) || typeof value['symbol'] !== 'string')
    throw new TypeError('Warrant list identity missing');

  // name/lastDone/warrantType 不再输出为列表事实，仍按原顺序校验原始 SDK 字段，拒绝输入行为不变。
  const name = value['name'];
  if (name !== undefined && name !== null && typeof name !== 'string')
    throw new TypeError('Warrant name must be text');

  mapOptionalQuoteDecimal(value['lastDone']);
  const toCallPrice = mapOptionalQuoteDecimal(value['toCallPrice']);
  const turnover = mapOptionalQuoteDecimal(value['turnover']);
  const callPrice = 'callPrice' in value ? mapOptionalQuoteDecimal(value['callPrice']) : undefined;
  mapWarrantEnum(value['warrantType']);
  const status = mapWarrantStatus(value['status']);

  return {
    symbol: value['symbol'],
    toCallPrice,
    turnover,
    ...('callPrice' in value ? { callPrice } : {}),
    status,
  };
}
