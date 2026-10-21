/** 订单快照测试装配：合法初始 native frame、中性 reply 控制及局部虚拟 timer，不执行账户 IO。 */
import type { RateLimiter } from '../../../../src/types/rateLimit.js';
import { createRateLimiterDouble } from '../../../helpers/testDoubles.js';
import { createBrokerIngressFixture, type BrokerIngressInput } from './brokerIngressFixture.js';
import type { OrderSnapshotReadFixture, OrderSnapshotTimerHarness } from './types.js';

/** 默认 frame 自身合法；缺失 revision/price 必须经 native reply 控制显式制造。 */
export function createSnapshotInput(overrides: Partial<BrokerIngressInput> = {}): BrokerIngressInput {
  return {
    orderId: 'ORDER',
    symbol: 'BULL.HK',
    stockName: 'HSI RC',
    remark: 'QuantDemo|PL',
    side: 'BUY',
    status: 'Filled',
    orderType: 'ELO',
    quantity: '100',
    executedQuantity: '100',
    submittedPrice: '1.000000000000000001',
    executedPrice: '1.2345678901234567890123456789',
    submittedAtMs: 1000,
    updatedAtMs: 3000,
    ...overrides,
  };
}

/** 测试直接使用唯一真实 adapter port，不再装配已删除 manager/domain policy。 */
export async function createOrderSnapshotReadFixture(
  history: ReadonlyArray<BrokerIngressInput> = [],
  today: ReadonlyArray<BrokerIngressInput> = [],
  rateLimiter: Pick<RateLimiter, 'throttle'> = createRateLimiterDouble(),
): Promise<OrderSnapshotReadFixture> {
  const native = await createBrokerIngressFixture(createSnapshotInput());
  native.setOrderSnapshotReplies(history, today);
  return { native, port: native.ports.createOrderSnapshotReadPort({ rateLimiter }) };
}

/** 排空有限层 Promise continuation，使断言只观察 IO/准入事件而不依赖真实 sleep。 */
export async function flushSnapshotMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

/** 只替换本测试作用域的 retry/limiter timer；还原交给调用方 finally。 */
export function createOrderSnapshotTimerHarness(): OrderSnapshotTimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = 10_000;
  const timers = new Map<unknown, Readonly<{ atMs: number; callback: () => void }>>();

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (typeof handler !== 'function') throw new TypeError('[测试] 快照 timer 只支持函数回调');

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, { atMs: nowMs + (timeout ?? 0), callback: () => { handler(); } });
      return handle;
    },
    { __promisify__: originalSetTimeout.__promisify__ },
  );
  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = (handle) => { timers.delete(handle); };

  return {
    nowMs: () => nowMs,
    pendingDelays: () => [...timers.values()].map((timer) => timer.atMs - nowMs).sort((a, b) => a - b),
    advanceBy: async (delayMs) => {
      nowMs += delayMs;
      for (const [handle, timer] of timers) {
        if (timer.atMs > nowMs) continue;

        timers.delete(handle);
        timer.callback();
      }

      await flushSnapshotMicrotasks();
    },
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}
