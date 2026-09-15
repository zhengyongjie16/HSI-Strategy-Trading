/** 策略 emitter 的同步契约检查、origin 权限和异步回流边界。 */
import { describe, expect, it } from 'bun:test';
import { createBusinessEventProgram } from '../../../src/main/businessEventProgram/index.js';
import type { StrategyDecision } from '../../../src/core/strategy/types.js';
import { createEventHarness } from './fixtures.js';

/** 只在不可信输出测试边界注入非法对象，不放宽生产端口。 */
function malformed(value: unknown): StrategyDecision {
  return value as StrategyDecision;
}

/** 建立真实事件 origin 并返回策略保存的 emitter。 */
async function originHarness() {
  const h = createEventHarness();
  h.program.start();
  h.publish();
  await Promise.resolve();
  return h;
}

describe('strategy emission adapter', () => {
  it.each([
    null,
    [],
    new Date(),
    { action: 'HOLD', triggerTimeMs: 0 },
    { action: 'BUYCALL' },
    { triggerTimeMs: 0 },
    { action: 'BUYCALL', triggerTimeMs: Number.NaN },
    { action: 'BUYCALL', triggerTimeMs: Number.POSITIVE_INFINITY },
    { action: 'BUYCALL', triggerTimeMs: 0.5 },
    { action: 'BUYCALL', triggerTimeMs: 8_640_000_000_000_001 },
    { action: 'BUYCALL', triggerTimeMs: 0, reason: undefined },
    { action: 'BUYCALL', triggerTimeMs: 0, reason: null },
    { action: 'BUYCALL', triggerTimeMs: 0, quantity: 1000 },
    { action: 'SELLCALL', triggerTimeMs: 0, isProtectiveLiquidation: true },
    { action: 'BUYCALL', triggerTimeMs: 0, [Symbol('authorization')]: true },
    Object.defineProperty({ action: 'BUYCALL', triggerTimeMs: 0 }, 'orderTypeOverride', {
      value: 'MO',
    }),
    Object.defineProperty({ action: 'BUYCALL' }, 'triggerTimeMs', { get: () => 0 }),
  ])('非法 decision %j 在返回前 fatal、关闭 admission 且零入队', async (value) => {
    const h = await originHarness();
    expect(() => {
      h.emitter()(malformed(value));
    }).toThrow();
    expect(h.termination.isTerminated()).toBeTrue();
    expect(h.lastState.isTradingEnabled).toBeFalse();
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    expect(h.sellTaskQueue.isEmpty()).toBeTrue();
    expect(
      h.buyTaskQueue.push({
        type: 'STRATEGY_BUY',
        data: { action: 'BUYCALL', symbol: 'BULL.HK', symbolName: null, seatVersion: 1 },
      }),
    ).toBeFalse();
    await h.program.stopAndDrain();
  });

  it('白名单建 Signal，保留原触发时间，省略 absent reason，四动作各只输出一次', async () => {
    const h = await originHarness();
    for (const action of ['BUYCALL', 'SELLCALL', 'BUYPUT', 'SELLPUT'] as const) {
      h.emitter()({ action, triggerTimeMs: 123 });
    }

    const buy = h.buyTaskQueue.pop();
    expect(buy).toEqual({
      type: 'STRATEGY_BUY',
      data: {
        action: 'BUYCALL',
        symbol: 'BULL.HK',
        symbolName: '牛',
        seatVersion: h.symbolRegistry.getSeatVersion('LONG'),
        triggerTime: new Date(123),
      },
    });
    expect(h.buyTaskQueue.pop()?.data.action).toBe('BUYPUT');
    expect(h.sellTaskQueue.pop()?.type).toBe('STRATEGY_SELL');
    expect(h.sellTaskQueue.pop()?.data.action).toBe('SELLPUT');
    expect(h.termination.isTerminated()).toBeFalse();
    await h.program.stopAndDrain();
  });

  it('先前合法动作入队不伪造回滚，后续重复 action 同步 fatal', async () => {
    const h = await originHarness();
    h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    expect(() => {
      h.emitter()({ action: 'BUYCALL', triggerTimeMs: 1 });
    }).toThrow('重复');
    expect(h.buyTaskQueue.pop()?.data.action).toBe('BUYCALL');
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    await h.program.stopAndDrain();
  });

  it('首次因当前 gate 丢弃仍占用 action，不能在重开后第二次输出', async () => {
    const h = await originHarness();
    h.lastState.canTrade = false;
    h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    h.lastState.canTrade = true;
    expect(() => {
      h.emitter()({ action: 'BUYCALL', triggerTimeMs: 1 });
    }).toThrow('重复');
    expect(h.buyTaskQueue.isEmpty()).toBeTrue();
    await h.program.stopAndDrain();
  });

  it.each(['disabled', 'day', 'route', 'sellPermission'] as const)(
    '缺初始 %s origin 为 fatal，不误判成当前失效',
    async (kind) => {
      const h = createEventHarness();
      if (kind === 'disabled') {
        h.lastState.openProtectionActive = true;
      }

      if (kind === 'day') {
        h.lastState.currentDayKey = '2026-02-30';
      }

      if (kind === 'sellPermission') {
        h.mutable.filled = false;
      }

      if (kind === 'route') {
        h.symbolRegistry.updateSeatState('LONG', {
          symbol: null,
          status: 'EMPTY',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: null,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        });
      }

      h.program.start();
      h.publish();
      await Promise.resolve();
      expect(() => {
        h.emitter()({
          action: kind === 'sellPermission' ? 'SELLCALL' : 'BUYCALL',
          triggerTimeMs: 0,
        });
      }).toThrow('origin');
      expect(h.termination.isTerminated()).toBeTrue();
      await h.program.stopAndDrain();
    },
  );

  it.each(['day', 'gate', 'state', 'symbol', 'version', 'takeover'] as const)(
    '当前 %s 失效正常丢弃，不 fatal',
    async (kind) => {
      const h = await originHarness();
      if (kind === 'day') {
        h.lastState.currentDayKey = '2026-07-16';
      }

      if (kind === 'gate') {
        h.lastState.canTrade = false;
      }

      if (kind === 'takeover') {
        h.mutable.nowMs = Date.parse('2026-07-15T07:56:00Z');
        Object.assign(h.deps.tradingConfig.global, { doomsdayProtection: true });
      }

      if (kind === 'state' || kind === 'symbol' || kind === 'version') {
        const seat = {
          symbol: kind === 'symbol' ? 'NEW.HK' : 'BULL.HK',
          status: kind === 'state' ? 'SWITCHING' : 'ACTIVE',
          lastSwitchAt: null,
          lastSearchAt: null,
          lastSeatActivatedAt: 100,
          searchFailCountToday: 0,
          frozenTradingDayKey: null,
        } as const;
        if (kind === 'version') {
          h.symbolRegistry.updateSeatStateWithVersionBump('LONG', seat);
        } else {
          h.symbolRegistry.updateSeatState('LONG', seat);
        }
      }

      h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
      expect(h.termination.isTerminated()).toBeFalse();
      expect(h.buyTaskQueue.isEmpty()).toBeTrue();
      await h.program.stopAndDrain();
    },
  );

  it('已有 SELL 回流不再读 filled BUY records，开盘保护本身不独立拒绝', async () => {
    const h = await originHarness();
    const reads = h.mutable.recordReads;
    h.mutable.filled = false;
    h.lastState.openProtectionActive = true;
    h.mutable.nowMs += 10_000;
    h.emitter()({ action: 'SELLCALL', triggerTimeMs: 123, reason: '末日保护程序' });
    expect(h.mutable.recordReads).toBe(reads);
    expect(h.sellTaskQueue.pop()?.data).toMatchObject({
      action: 'SELLCALL',
      triggerTime: new Date(123),
      reason: '末日保护程序',
    });
    expect(h.termination.isTerminated()).toBeFalse();
    await h.program.stopAndDrain();
  });

  it('终态先于非法 decision 检查，无入队/通知/新 fatal', async () => {
    const h = await originHarness();
    let notifications = 0;
    h.buyTaskQueue.onTaskAdded(() => {
      notifications += 1;
    });
    h.termination.requestShutdown();
    const fatal = h.termination.getFatalState();
    expect(() => {
      h.emitter()(malformed(null));
    }).not.toThrow();
    h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    expect(h.termination.getFatalState()).toEqual(fatal);
    expect(notifications).toBe(0);
    await h.program.stopAndDrain();
  });

  it('非终态队列拒绝是同步 fatal；终态拒绝是正常 no-op', async () => {
    const h = await originHarness();
    h.buyTaskQueue.close();
    expect(() => {
      h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    }).toThrow('admission');
    await h.program.stopAndDrain();
    const second = createEventHarness();
    const program = createBusinessEventProgram({
      ...second.deps,
      buyTaskQueue: {
        push: () => {
          second.termination.requestShutdown();
          return false;
        },
      },
    });
    program.start();
    second.publish();
    await Promise.resolve();
    expect(() => {
      second.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    }).not.toThrow();
    expect(second.termination.getFatalState()).toMatchObject({ hasFatalError: false });
    await program.stopAndDrain();
  });

  it('策略捕获非法 emit 的异常时，也已在当前调用栈关闭全局 gate', async () => {
    const h = createEventHarness();
    h.mutable.handler = (_, emit) => {
      expect(() => {
        emit(malformed({ action: 'HOLD', triggerTimeMs: 0 }));
      }).toThrow();
      expect(h.lastState.isTradingEnabled).toBeFalse();
      expect(h.termination.isTerminated()).toBeTrue();
      return [{ label: 'late', valueText: 'forbidden' }];
    };
    h.program.start();
    h.publish();
    await Promise.resolve();
    expect(h.displays).toHaveLength(0);
    await h.program.stopAndDrain();
  });
});
