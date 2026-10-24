/** 策略 emitter 的同步契约检查、origin 权限和异步回流边界。 */
import { describe, expect, it } from 'bun:test';
import { DIAGNOSTIC_OPERATIONS } from '../../../src/constants/diagnostics.js';
import { createBusinessEventProgram } from '../../../src/runtime/businessEventProgram/index.js';
import { createStrategyEmitter } from '../../../src/runtime/businessEventProgram/emissionAdapter.js';
import type { DiagnosticFields } from '../../../src/types/diagnostics.js';
import type { StrategyDecision } from '../../../src/types/strategy.js';
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
    expect(h.stateFixtures.lifecycleState.isTradingEnabled).toBeFalse();
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
    h.stateFixtures.tradingTimeState.canTrade = false;
    h.emitter()({ action: 'BUYCALL', triggerTimeMs: 0 });
    h.stateFixtures.tradingTimeState.canTrade = true;
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
        h.stateFixtures.tradingTimeState.openProtectionActive = true;
      }

      if (kind === 'day') {
        h.stateFixtures.lifecycleState.currentDayKey = '2026-02-30';
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
        h.stateFixtures.lifecycleState.currentDayKey = '2026-07-16';
      }

      if (kind === 'gate') {
        h.stateFixtures.tradingTimeState.canTrade = false;
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

  it.each(['day', 'gate', 'state', 'symbol', 'version', 'valid'] as const)(
    '%s 诊断保留原 gate/seat 短路、单次时钟和 action 消费时点',
    (kind) => {
      const events: { readonly operation: string; readonly fields: DiagnosticFields }[] = [];
      const h = createEventHarness({
        diagnostics: {
          record: (operation, fields) => {
            events.push({ operation, fields });
          },
        },
      });
      let dayReads = 0;
      let gateReads = 0;
      let seatReads = 0;
      let versionReads = 0;
      let clockReads = 0;
      const version = h.symbolRegistry.getSeatVersion('LONG');
      const emit = createStrategyEmitter(
        {
          ...h.deps,
          clock: {
            now: () => {
              clockReads += 1;
              return new Date(h.mutable.nowMs);
            },
          },
          lifecycleState: {
            get currentDayKey() {
              dayReads += 1;
              return kind === 'day' ? '2026-07-16' : '2026-07-15';
            },
            get isTradingEnabled() {
              gateReads += 1;
              return kind !== 'gate';
            },
          },
          monitorContext: {
            ...h.deps.monitorContext,
            symbolRegistry: {
              getSeatState: () => {
                seatReads += 1;
                return {
                  symbol: kind === 'symbol' ? 'NEW.HK' : 'BULL.HK',
                  status: kind === 'state' ? 'SWITCHING' : 'ACTIVE',
                  lastSwitchAt: null,
                  lastSearchAt: null,
                  lastSeatActivatedAt: 100,
                  searchFailCountToday: 0,
                  frozenTradingDayKey: null,
                };
              },
              getSeatVersion: () => {
                versionReads += 1;
                return kind === 'version' ? version + 1 : version;
              },
            },
          },
        },
        {
          dayKey: '2026-07-15',
          routes: [
            {
              direction: 'LONG',
              symbol: 'BULL.HK',
              seatVersion: version,
              hasFilledBuyOrders: true,
            },
          ],
        },
      );
      emit({ action: 'BUYCALL', triggerTimeMs: 123 });
      expect(clockReads).toBe(1);
      expect(dayReads).toBe(1);
      expect(gateReads).toBe(kind === 'day' ? 0 : 1);
      expect(seatReads).toBe(kind === 'day' || kind === 'gate' ? 0 : 1);
      expect(versionReads).toBe(kind === 'version' || kind === 'valid' ? 1 : 0);
      const admission = events.filter(
        ({ operation }) => operation === DIAGNOSTIC_OPERATIONS.SIGNAL_ADMISSION_RESULT,
      );
      if (kind === 'valid') {
        expect(admission).toHaveLength(0);
        expect(
          events.filter(({ operation }) => operation === DIAGNOSTIC_OPERATIONS.SIGNAL_QUEUE_EVENT),
        ).toHaveLength(1);
      } else {
        const reasonCode = {
          day: 'ORIGIN_DAY_CHANGED',
          gate: 'ORDINARY_GATE_CLOSED',
          state: 'SEAT_IDENTITY_CHANGED',
          symbol: 'SEAT_IDENTITY_CHANGED',
          version: 'SEAT_IDENTITY_CHANGED',
        }[kind];
        expect(admission.map(({ fields }) => fields)).toEqual([
          {
            stage: 'STRATEGY_EMITTER',
            outcome: 'REJECTED',
            reasonCode,
            symbol: 'BULL.HK',
            action: 'BUYCALL',
            seatVersion: version,
            triggerTimeMs: 123,
            ...(kind === 'day' ? { originDayKey: '2026-07-15', currentDayKey: '2026-07-16' } : {}),
          },
        ]);
        expect(h.buyTaskQueue.isEmpty()).toBeTrue();
      }

      expect(() => {
        emit({ action: 'BUYCALL', triggerTimeMs: 124 });
      }).toThrow('重复');
      expect(clockReads).toBe(1);
      expect(dayReads).toBe(1);
    },
  );

  it.each(['day', 'gate', 'seat'] as const)(
    'observer 抛错不改变 %s 正常拒绝或产生 fatal',
    async (kind) => {
      let observerCalls = 0;
      const h = createEventHarness({
        diagnostics: {
          record: () => {
            observerCalls += 1;
            throw new Error('observer unavailable');
          },
        },
      });
      h.program.start();
      h.publish();
      await Promise.resolve();
      if (kind === 'day') h.stateFixtures.lifecycleState.currentDayKey = '2026-07-16';

      if (kind === 'gate') h.stateFixtures.tradingTimeState.canTrade = false;

      if (kind === 'seat') {
        h.symbolRegistry.updateSeatStateWithVersionBump('LONG', {
          ...h.symbolRegistry.getSeatState('LONG'),
          lastSeatActivatedAt: 100,
        });
      }

      expect(() => {
        h.emitter()({ action: 'BUYCALL', triggerTimeMs: 123 });
      }).not.toThrow();
      expect(observerCalls).toBe(1);
      expect(h.termination.isTerminated()).toBeFalse();
      expect(h.buyTaskQueue.isEmpty()).toBeTrue();
      await h.program.stopAndDrain();
    },
  );

  it('已有 SELL 回流不再读 filled BUY records，开盘保护本身不独立拒绝', async () => {
    const h = await originHarness();
    const reads = h.mutable.recordReads;
    h.mutable.filled = false;
    h.stateFixtures.tradingTimeState.openProtectionActive = true;
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
      expect(h.stateFixtures.lifecycleState.isTradingEnabled).toBeFalse();
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
