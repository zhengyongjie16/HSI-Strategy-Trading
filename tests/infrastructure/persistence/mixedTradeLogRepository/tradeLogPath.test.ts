/**
 * 仓储日文件路径测试
 *
 * 锁定香港跨日边界和非法日期 fail-fast，避免持久化路径随 UTC 日期漂移。
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { buildTradeLogPath } from '../../../../src/infrastructure/persistence/mixedTradeLogRepository/tradeLogPath.js';

describe('trade log repository path', () => {
  it('uses the Hong Kong trading date across UTC midnight boundaries', () => {
    const tradesDir = path.join('custom', 'data', 'trades');

    expect(buildTradeLogPath(tradesDir, new Date('2026-09-18T15:59:59.999Z'))).toBe(
      path.join(tradesDir, '2026-09-18.jsonl'),
    );

    expect(buildTradeLogPath(tradesDir, new Date('2026-09-18T16:00:00.000Z'))).toBe(
      path.join(tradesDir, '2026-09-19.jsonl'),
    );
  });

  it('rejects invalid dates rather than selecting another day file', () => {
    expect(() => buildTradeLogPath(path.join('data', 'trades'), new Date(Number.NaN))).toThrow(
      '[tradeLogPath] 日志日期无效',
    );
  });
});
