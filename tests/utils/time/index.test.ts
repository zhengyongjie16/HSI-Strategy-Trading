/** 香港日期工具测试：格式化只消费明确日期，跨日枚举保留首尾日期且不含交易日政策。 */
import { describe, expect, it } from 'bun:test';
import {
  getHKDateKey,
  listHKDateKeysBetween,
  toHongKongTimeIso,
  toHongKongTimeLog,
} from '../../../src/utils/time/index.js';

describe('Hong Kong calendar utilities', () => {
  it('按传入时点转换香港格式和日期键，不读取默认当前时间', () => {
    const date = new Date('2026-04-29T16:00:00.123Z');
    expect(toHongKongTimeIso(date)).toBe('2026/04/30/00:00:00');
    expect(toHongKongTimeLog(date)).toBe('2026-04-30 00:00:00.123');
    expect(getHKDateKey(date)).toBe('2026-04-30');
  });

  it('日期枚举包含香港首尾日期，不按周末或半日市裁剪', () => {
    const startMs = Date.parse('2026-05-01T15:59:59.999Z');
    const endMs = Date.parse('2026-05-03T16:00:00.000Z');
    expect(listHKDateKeysBetween(startMs, endMs)).toEqual([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
    ]);
    expect(listHKDateKeysBetween(startMs, startMs)).toEqual(['2026-05-01']);
    expect(listHKDateKeysBetween(startMs + 1, startMs)).toEqual([]);
    expect(listHKDateKeysBetween(Number.NaN, endMs)).toEqual([]);
  });
});
