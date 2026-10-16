/**
 * mixed trade log repository 日文件路径
 *
 * 职责：按香港交易日生成仓储自身读写的 JSONL 路径。
 */
import path from 'node:path';
import { getHKDateKey } from '../../../utils/time/index.js';

/**
 * 构造交易日志文件路径（<logRootDir>/trades/YYYY-MM-DD.jsonl）。
 * 文件名按香港交易日切分，避免 UTC 跨日导致同一交易日写入错误日志文件。
 *
 * @param logRootDir 日志根目录
 * @param date 日志日期
 * @returns 交易日志文件完整路径
 */
export function buildTradeLogPath(logRootDir: string, date: Date): string {
  const dayKey = getHKDateKey(date);
  if (dayKey === null || !Number.isFinite(date.getTime())) {
    throw new TypeError('[tradeLogPath] 日志日期无效');
  }

  return path.join(logRootDir, 'trades', `${dayKey}.jsonl`);
}
