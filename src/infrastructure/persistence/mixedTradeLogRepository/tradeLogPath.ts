/**
 * mixed trade log repository 日文件路径
 *
 * 职责：按香港交易日生成仓储自身读写的 JSONL 路径。
 */
import path from 'node:path';
import { getHKDateKey } from '../../../utils/time/index.js';

/**
 * 构造交易日志文件路径（<tradesDir>/YYYY-MM-DD.jsonl）。
 * 文件名按香港交易日切分，避免 UTC 跨日导致同一交易日写入错误日志文件。
 *
 * @param tradesDir 交易日志目录
 * @param date 日志日期
 * @returns 交易日志文件完整路径
 */
export function buildTradeLogPath(tradesDir: string, date: Date): string {
  const dayKey = getHKDateKey(date);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('[tradeLogPath] 日志日期无效');
  }

  return path.join(tradesDir, `${dayKey}.jsonl`);
}
