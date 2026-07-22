/**
 * TimeWakeupPlanner 业务测试
 *
 * 覆盖：系统级时间候选过滤、排序与最早唤醒选择，不包含周期换标候选。
 */
import { describe, expect, it } from 'bun:test';
import { planNextTimeWakeup } from '../../../src/main/timeWakeupPlanner/index.js';

describe('TimeWakeupPlanner', () => {
  it('从多个系统级未来候选中选择严格大于 nowMs 的最早时间', () => {
    const nowMs = 1_000;
    const plan = planNextTimeWakeup({
      nowMs,
      candidates: [{ atMs: 3_000 }, { atMs: 1_500 }, { atMs: 2_000 }],
    });

    expect(plan.hasWork).toBe(true);
    expect(plan.nextWakeupAtMs).toBe(1_500);
  });

  it('过滤 atMs 小于或等于 nowMs 的候选', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [{ atMs: 999 }, { atMs: 1_000 }, { atMs: 1_001 }],
    });

    expect(plan).toEqual({
      hasWork: true,
      nextWakeupAtMs: 1_001,
    });
  });

  it('过滤 NaN 和 Infinity 等非法数字候选', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [
        { atMs: Number.NaN },
        { atMs: Number.POSITIVE_INFINITY },
        { atMs: Number.NEGATIVE_INFINITY },
        { atMs: 2_000 },
      ],
    });

    expect(plan).toEqual({
      hasWork: true,
      nextWakeupAtMs: 2_000,
    });
  });

  it('无有效未来候选时返回 no-work 结果', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [{ atMs: 500 }, { atMs: Number.NaN }],
    });

    expect(plan).toEqual({
      hasWork: false,
      nextWakeupAtMs: null,
    });
  });
});
