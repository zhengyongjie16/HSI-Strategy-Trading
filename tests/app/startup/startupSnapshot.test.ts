/**
 * app/startupSnapshot 单元测试
 *
 * 覆盖：
 * - 启动快照成功时保留原始快照并不切换恢复状态
 * - 启动快照 API 失败时切换 pendingOpenRebuild 分支且不返回空事实
 */
import { describe, expect, it } from 'bun:test';
import { loadStartupSnapshot } from '../../../src/app/startup/startupSnapshot.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import { applyStartupSnapshotFailureState } from '../../../src/main/lifecycle/startupFailureState.js';
import type { Quote } from '../../../src/types/quote.js';
import type { LastState } from '../../../src/types/state.js';
import type { RawOrderFromAPI } from '../../../src/types/services.js';
import { createSnapshotFixture } from '../../main/fixtures/accountPositionSnapshot.js';
import { createAccountSnapshotDouble } from '../../helpers/testDoubles.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';

function createStartupTermination(lastState: LastState) {
  return createTerminationRuntime({
    closeTradingGate: () => {
      lastState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {},
    stopProducers: [],
    onSecondaryError: (error) => {
      throw error;
    },
  });
}

function createMinimalLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-03-09',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    isTradingEnabled: true,
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    allTradingSymbols: new Set(),
  };
}

describe('app startup snapshot branch', () => {
  it('retries same-day supersession locally and returns only the issued paired token', async () => {
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const lastState = createMinimalLastState();
    const capturedToken = snapshot.getView().token;
    let calls = 0;
    const result = await loadStartupSnapshot({
      now: new Date('2026-03-09T09:31:00.000Z'),
      lastState,
      snapshot,
      termination: createStartupTermination(lastState),
      loadTradingDayRuntimeSnapshot: async () => {
        calls += 1;
        return calls === 1
          ? { status: 'SUPERSEDED' }
          : {
              status: 'COMMITTED',
              snapshotToken: capturedToken,
              allOrders: [],
              quotesMap: new Map(),
            };
      },
      applyStartupSnapshotFailureState,
      logger: {
        error: () => {
          throw new Error('supersession is not API failure');
        },
      },
      formatError: String,
    });
    expect(calls).toBe(2);
    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') throw new Error('expected captured READY');

    expect(result.snapshotToken).toBe(capturedToken);
    expect(lastState.pendingOpenRebuild).toBe(false);
  });

  it('does not turn loader ABORTED into successful empty startup facts', async () => {
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const lastState = createMinimalLastState();
    const result = await loadStartupSnapshot({
      now: new Date('2026-03-09T09:31:00.000Z'),
      lastState,
      snapshot,
      termination: createStartupTermination(lastState),
      loadTradingDayRuntimeSnapshot: async () => ({ status: 'ABORTED' }),
      applyStartupSnapshotFailureState,
      logger: {
        error: () => {
          throw new Error('abort is not API failure');
        },
      },
      formatError: String,
    });
    expect(result.kind).toBe('ABORTED');
    expect('snapshotToken' in result).toBe(false);
    expect('allOrders' in result).toBe(false);
    expect(lastState.pendingOpenRebuild).toBe(false);
  });

  it('rejects late committed facts after termination closes the trading gate', async () => {
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const lastState = createMinimalLastState();
    const termination = createStartupTermination(lastState);
    const result = await loadStartupSnapshot({
      now: new Date('2026-03-09T09:31:00.000Z'),
      lastState,
      snapshot,
      termination,
      loadTradingDayRuntimeSnapshot: async () => {
        termination.requestShutdown();
        return {
          status: 'COMMITTED',
          snapshotToken: snapshot.getView().token,
          allOrders: [],
          quotesMap: new Map(),
        };
      },
      applyStartupSnapshotFailureState,
      logger: {
        error: () => {
          throw new Error('termination is not API failure');
        },
      },
      formatError: String,
    });
    expect(result.kind).toBe('ABORTED');
    expect(lastState.isTradingEnabled).toBe(false);
    expect('snapshotToken' in result).toBe(false);
  });

  it('returns startup snapshot directly when loading succeeds', async () => {
    const now = new Date('2026-03-09T09:31:00.000Z');
    const lastState = createMinimalLastState();
    const allOrders: ReadonlyArray<RawOrderFromAPI> = [
      {
        orderId: 'A',
        symbol: 'HSI-BULL.HK',
        stockName: 'HSI BULL',
        remark: '',
        executionSide: 'BUY',
        executionStatus: 'FILLED',
        executionPhase: 'TERMINAL',
        status: 'FILLED',
        orderType: 'LO',
        quantity: 100,
        executedQuantity: 100,
        price: '1',
        executedPrice: '1',
        executedAmount: '100',
        submittedAt: new Date(now),
        executionTimeMs: now.getTime(),
        updatedAtMs: now.getTime(),
        updatedAt: new Date(now),
      },
    ];
    const quotesMap = new Map<string, Quote | null>([['HSI.HK', null]]);

    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const result = await loadStartupSnapshot({
      now,
      lastState,
      snapshot,
      termination: createStartupTermination(lastState),
      loadTradingDayRuntimeSnapshot: async () => ({
        status: 'COMMITTED',
        snapshotToken: snapshot.getView().token,
        allOrders,
        quotesMap,
      }),
      applyStartupSnapshotFailureState,
      logger: {
        error: () => {},
      },
      formatError: String,
    });

    expect(result.kind).toBe('READY');
    if (result.kind !== 'READY') {
      throw new Error('预期启动快照成功');
    }

    expect(result.snapshotToken).toBe(snapshot.getView().token);
    expect(
      snapshot.isCurrent(result.snapshotToken, { account: true, positions: true, paired: true }),
    ).toBe(true);
    expect(result.allOrders).toEqual(allOrders);
    expect(result.quotesMap).toEqual(quotesMap);
    expect(lastState.pendingOpenRebuild).toBe(false);
    expect(lastState.lifecycleState).toBe('ACTIVE');
  });

  it('switches to pending open rebuild without empty facts when API loading fails', async () => {
    const now = new Date('2026-03-09T09:32:00.000Z');
    const lastState = createMinimalLastState();
    const errorMessages: string[] = [];
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });

    const result = await loadStartupSnapshot({
      now,
      lastState,
      snapshot,
      termination: createStartupTermination(lastState),
      loadTradingDayRuntimeSnapshot: async () => {
        throw await createExternalApiRequestError({
          operation: 'test.snapshot',
          attempts: 1,
          cause: new Error('snapshot failed'),
        });
      },
      applyStartupSnapshotFailureState,
      logger: {
        error: (message) => {
          errorMessages.push(message);
        },
      },
      formatError: String,
    });

    expect(result.kind).toBe('API_RETRY_PENDING');
    expect(lastState.pendingOpenRebuild).toBe(true);
    expect(lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(lastState.isTradingEnabled).toBe(false);
    expect(errorMessages).toEqual(['启动快照 API 请求失败：已阻断交易并切换为开盘重建重试模式']);
  });

  it('throws non API loading errors instead of entering rebuild retry', async () => {
    const now = new Date('2026-03-09T09:33:00.000Z');
    const lastState = createMinimalLastState();
    const snapshot = await createSnapshotFixture({
      account: createAccountSnapshotDouble('100000'),
      positions: [],
    });
    const contractError = new TypeError('snapshot contract broken');

    expect(
      loadStartupSnapshot({
        now,
        lastState,
        snapshot,
        termination: createStartupTermination(lastState),
        loadTradingDayRuntimeSnapshot: async () => {
          throw contractError;
        },
        applyStartupSnapshotFailureState,
        logger: {
          error: () => {},
        },
        formatError: String,
      }),
    ).rejects.toBe(contractError);
  });
});
