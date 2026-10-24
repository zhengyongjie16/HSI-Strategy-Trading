/** 市场元数据边界：提取 SDK 静态信息、周期日志名称与港股 NaiveDate，不承载交易规则。 */
import { NaiveDate } from 'longbridge';
import type { CandlestickPeriod } from '../../../types/marketPorts.js';
import { isRecord, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { StaticInfo } from './types.js';
import { getHKDateKey } from '../../../utils/time/index.js';

/** 转换中性周期日志标签，分钟/日周月季年均由明确语义表达。 */
export function formatPeriodForLog(period: CandlestickPeriod): string {
  switch (period) {
    case 'MIN_1':
    case 'MIN_2':
    case 'MIN_3':
    case 'MIN_5':
    case 'MIN_10':
    case 'MIN_15':
    case 'MIN_20':
    case 'MIN_30':
    case 'MIN_45':
    case 'MIN_60':
    case 'MIN_120':
    case 'MIN_180':
    case 'MIN_240': {
      const minutes = Number(period.slice(4));
      return minutes < 60 ? `${minutes}分钟` : `${minutes / 60}小时`;
    }

    case 'DAY': {
      return '日K';
    }

    case 'WEEK': {
      return '周K';
    }

    case 'MONTH': {
      return '月K';
    }

    case 'QUARTER': {
      return '季K';
    }

    case 'YEAR': {
      return '年K';
    }

    default: {
      throw new TypeError(`Unknown market period: ${String(period)}`);
    }
  }
}

/**
 * 类型保护：判断 unknown 是否可作为 StaticInfo 使用。
 *
 * @param value 待判断值
 * @returns true 表示包含可识别的静态信息字段
 */
function isStaticInfo(value: unknown): value is StaticInfo {
  if (!isRecord(value)) {
    return false;
  }

  const valueRecord = value;

  /**
   * 判断静态信息对象中的名称字段是否为可接受类型。
   *
   * @param propertyKey 静态信息中的名称字段键
   * @returns 当字段为 undefined/null/string 时返回 true
   */
  function isNullableStringProperty(propertyKey: 'nameHk' | 'nameCn' | 'nameEn'): boolean {
    const propertyValue: unknown = valueRecord[propertyKey];
    return (
      propertyValue === undefined || propertyValue === null || typeof propertyValue === 'string'
    );
  }
  const lotSizeValue: unknown = valueRecord['lotSize'];
  return (
    isNullableStringProperty('nameHk') &&
    isNullableStringProperty('nameCn') &&
    isNullableStringProperty('nameEn') &&
    (lotSizeValue === undefined || lotSizeValue === null || typeof lotSizeValue === 'number')
  );
}

/**
 * 从静态信息中安全提取 lotSize
 * @param staticInfo 静态信息对象
 * @returns lotSize 值，如果无效则返回 undefined
 */
export function extractLotSize(staticInfo: unknown): number | undefined {
  if (!isStaticInfo(staticInfo)) {
    return undefined;
  }

  const lotSizeValue = staticInfo.lotSize ?? null;
  if (lotSizeValue === null) {
    return undefined;
  }

  const parsed = lotSizeValue;
  if (isValidPositiveNumber(parsed) && Number.isSafeInteger(parsed)) {
    return parsed;
  }

  return undefined;
}

/**
 * 从静态信息中安全提取名称
 * @param staticInfo 静态信息对象
 * @returns 名称，优先返回香港名称，其次中文名称，最后英文名称
 */
export function extractName(staticInfo: unknown): string | null {
  if (!isStaticInfo(staticInfo)) {
    return null;
  }

  return staticInfo.nameHk ?? staticInfo.nameCn ?? staticInfo.nameEn ?? null;
}

/**
 * 将时间对象转换为港股日期的 NaiveDate
 * @param date 时间对象
 * @returns NaiveDate 实例
 */
export function resolveHKNaiveDate(date: Date): NaiveDate {
  const dateKey = getHKDateKey(date);
  const parts = dateKey.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return new NaiveDate(year, month, day);
}
