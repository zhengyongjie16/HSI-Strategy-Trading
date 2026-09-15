/** 真实 registry mutation 的同步方向取消与队列清理；另一方向及 SEAT_REFRESH 保留。 */
import { describe, expect, it } from 'bun:test';
import { createSeatRuntimeCleanupDispatcher } from '../../../src/main/seatRuntimeCleanupDispatcher/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { RuntimeWritableSeatState } from '../../../src/types/seat.js';
import { createEventHarness } from '../businessEventProgram/fixtures.js';

/** 构造运行时 ACTIVE 状态而非 bootstrap ACTIVE/null。 */
function activeSeat(symbol: string): RuntimeWritableSeatState {
  return {
    symbol,
    status: 'ACTIVE',
    lastSeatActivatedAt: 100,
    lastSwitchAt: null,
    lastSearchAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

/** 构造退场状态。 */
function emptySeat(): RuntimeWritableSeatState {
  return {
    symbol: null,
    status: 'EMPTY',
    lastSeatActivatedAt: null,
    lastSwitchAt: null,
    lastSearchAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

describe('seatRuntimeCleanupDispatcher 同步方向取消', () => {
  it.each(['LONG', 'SHORT'] as const)(
    '%s 退场在 registry 返回前取消对应 pending，另一方向保留',
    (direction) => {
      const h = createEventHarness();
      const pending = new Set(['LONG', 'SHORT']);
      const order: string[] = [];
      const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
      const dispatcher = createSeatRuntimeCleanupDispatcher({
        symbolRegistry: h.symbolRegistry,
        monitorContext: {
          strategy: {
            invalidateDirection: (value) => {
              order.push(`cancel:${value}`);
              pending.delete(value);
            },
          },
          riskChecker: {
            clearLongWarrantInfo: () => {
              order.push('risk:LONG');
            },
            clearShortWarrantInfo: () => {
              order.push('risk:SHORT');
            },
          },
        },
        buyTaskQueue: h.buyTaskQueue,
        sellTaskQueue: h.sellTaskQueue,
        monitorTaskQueue,
      });
      for (const [action, symbol] of [
        ['BUYCALL', 'BULL.HK'],
        ['BUYPUT', 'BEAR.HK'],
      ] as const) {
        expect(
          h.buyTaskQueue.push({
            type: 'STRATEGY_BUY',
            data: { action, symbol, symbolName: null, seatVersion: 1 },
          }),
        ).toBeTrue();
      }

      for (const [action, symbol] of [
        ['SELLCALL', 'BULL.HK'],
        ['SELLPUT', 'BEAR.HK'],
      ] as const) {
        expect(
          h.sellTaskQueue.push({
            type: 'STRATEGY_SELL',
            data: { action, symbol, symbolName: null, seatVersion: 1 },
          }),
        ).toBeTrue();
      }

      for (const side of ['LONG', 'SHORT'] as const) {
        expect(
          monitorTaskQueue.scheduleLatest({
            type: 'AUTO_SYMBOL_TICK',
            dedupeKey: `tick:${side}`,
            data: {
              direction: side,
              seatVersion: 1,
              symbol: side === 'LONG' ? 'BULL.HK' : 'BEAR.HK',
              lastSeatActivatedAt: 100,
              currentTimeMs: 200,
            },
          }),
        ).toBeTrue();
      }

      expect(
        monitorTaskQueue.scheduleLatest({
          type: 'SEAT_REFRESH',
          dedupeKey: 'refresh',
          data: {
            direction,
            seatVersion: 2,
            previousSymbol: 'OLD.HK',
            nextSymbol: 'NEW.HK',
            callPrice: 20_000,
            symbolName: 'new',
          },
        }),
      ).toBeTrue();
      dispatcher.start();
      dispatcher.start();
      h.symbolRegistry.updateSeatStateWithVersionBump(direction, emptySeat());
      order.push('registry-return');
      expect(order).toEqual([`cancel:${direction}`, `risk:${direction}`, 'registry-return']);
      expect([...pending]).toEqual([direction === 'LONG' ? 'SHORT' : 'LONG']);
      expect(h.buyTaskQueue.pop()?.data.action).toBe(direction === 'LONG' ? 'BUYPUT' : 'BUYCALL');
      expect(h.sellTaskQueue.pop()?.data.action).toBe(
        direction === 'LONG' ? 'SELLPUT' : 'SELLCALL',
      );
      expect(h.buyTaskQueue.isEmpty()).toBeTrue();
      expect(h.sellTaskQueue.isEmpty()).toBeTrue();
      expect(monitorTaskQueue.pop()?.data).toMatchObject({
        direction: direction === 'LONG' ? 'SHORT' : 'LONG',
      });
      expect(monitorTaskQueue.pop()?.type).toBe('SEAT_REFRESH');
      expect(monitorTaskQueue.isEmpty()).toBeTrue();
      dispatcher.stop();
    },
  );

  it('ACTIVE→ACTIVE 标的或版本变化也取消，不因普通 metadata 更新取消', () => {
    const h = createEventHarness();
    const cancelled: string[] = [];
    const dispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry: h.symbolRegistry,
      monitorContext: {
        strategy: {
          invalidateDirection: (direction) => {
            cancelled.push(direction);
          },
        },
        riskChecker: { clearLongWarrantInfo: () => {}, clearShortWarrantInfo: () => {} },
      },
      buyTaskQueue: h.buyTaskQueue,
      sellTaskQueue: h.sellTaskQueue,
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskDataMap>(),
    });
    dispatcher.start();
    h.symbolRegistry.updateSeatState('LONG', activeSeat('BULL.HK'));
    expect(cancelled).toEqual([]);
    h.symbolRegistry.updateSeatState('LONG', activeSeat('NEW.HK'));
    expect(cancelled).toEqual(['LONG']);
    h.symbolRegistry.updateSeatStateWithVersionBump('LONG', activeSeat('NEW.HK'));
    expect(cancelled).toEqual(['LONG', 'LONG']);
    h.symbolRegistry.updateSeatState('LONG', emptySeat());
    expect(cancelled).toHaveLength(3);
    h.symbolRegistry.updateSeatStateWithVersionBump('LONG', emptySeat());
    expect(cancelled).toHaveLength(3);
    dispatcher.stop();
    h.symbolRegistry.updateSeatState('SHORT', emptySeat());
    expect(cancelled).toHaveLength(3);
  });
});
