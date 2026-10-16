/**
 * 系统时间适配业务测试
 *
 * 覆盖真实时钟读取、原生 one-shot callback 与相同句柄的取消能力。
 */
import { describe, expect, it } from 'bun:test';
import {
  SYSTEM_RUNTIME_CLOCK,
  SYSTEM_RUNTIME_SCHEDULER,
} from '../../../src/infrastructure/time/index.js';

describe('system time adapters', () => {
  it('reads the current system time on each call', () => {
    const beforeMs = Date.now();
    const first = SYSTEM_RUNTIME_CLOCK.now();
    const second = SYSTEM_RUNTIME_CLOCK.now();
    const afterMs = Date.now();

    expect(first).not.toBe(second);
    expect(first.getTime()).toBeGreaterThanOrEqual(beforeMs);
    expect(second.getTime()).toBeLessThanOrEqual(afterMs);
  });

  it('runs a native one-shot callback and cancels the supplied handle', async () => {
    let cancelledCallbackRan = false;
    const handle = SYSTEM_RUNTIME_SCHEDULER.scheduleTimer(() => {
      cancelledCallbackRan = true;
    }, 0);
    SYSTEM_RUNTIME_SCHEDULER.clearTimer(handle);

    await new Promise<void>((resolve) => {
      SYSTEM_RUNTIME_SCHEDULER.scheduleTimer(resolve, 0);
    });

    expect(cancelledCallbackRan).toBe(false);
  });
});
