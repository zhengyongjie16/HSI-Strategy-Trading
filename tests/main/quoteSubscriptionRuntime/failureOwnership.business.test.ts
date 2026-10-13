/**
 * QuoteSubscriptionRuntime 工作失败责任测试。
 * 真实 snapshot 提交当前事实，验证 POSITION_HOLD 的准入/退订失败不会由后继普通命令偷重试，
 * 半成功 ACK 始终反映于 committed；显式 owner 重试从当前 truth 收口而非冻结旧期待。
 */
import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import type { Position } from '../../../src/types/account.js';
import type { OrderHoldSymbolsChangedEvent } from '../../../src/types/services.js';
import { createExternalApiRequestError } from '../../helpers/createExternalApiRequestError.js';
import {
  createAccountSnapshotDouble,
  createLoggerDouble,
  createMonitorConfigDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';
import { createSnapshotFixture } from '../fixtures/accountPositionSnapshot.js';

describe('POSITION_HOLD 失败不转移给普通事件', () => {
  it.each(['subscribe', 'unsubscribe'])(
    '%s 失败原样拒绝 awaited owner，排队的普通 order 只执行自己的 mutation',
    async (stage) => {
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const failure = await createExternalApiRequestError({
        operation: stage === 'subscribe' ? 'subscribeSymbols' : 'unsubscribeSymbols',
        attempts: 1,
        cause: new Error('position mutation unavailable'),
      });
      const monitor = createMonitorConfigDouble();
      const symbolRegistry = createSymbolRegistry(monitor);
      let positions: ReadonlyArray<Position> =
        stage === 'unsubscribe'
          ? [createPositionDouble({ symbol: 'OLD.HK', quantity: 100, availableQuantity: 100 })]
          : [];
      const snapshot = await createSnapshotFixture({
        account: createAccountSnapshotDouble('100000'),
        positions,
        readPort: {
          getAccountSnapshot: async () => createAccountSnapshotDouble('100000'),
          getStockPositions: async () => positions,
        },
      });
      const lastState = { allTradingSymbols: new Set<string>() };
      const actual = new Set<string>();
      const holds = new Set<string>();
      const listeners = new Set<(event: OrderHoldSymbolsChangedEvent) => void>();
      const fatalErrors: unknown[] = [];
      const subscriptions: string[][] = [];
      const unsubscriptions: string[][] = [];
      let failureAttempts = 0;
      let allowRetry = false;
      const runtime = createQuoteSubscriptionRuntime({
        snapshot,
        symbolRegistry,
        lastState,
        tradingConfig: createTradingConfig({ monitor }),
        logger: createLoggerDouble(),
        termination: {
          isTerminated: () => false,
          reportFatalError: (error) => {
            fatalErrors.push(error);
          },
        },
        trader: {
          getOrderHoldSymbols: () => new Set(holds),
          onOrderHoldSymbolsChanged: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        marketDataClient: {
          subscribeSymbols: async (symbols) => {
            subscriptions.push([...symbols]);
            if (stage === 'subscribe' && symbols.includes('NEXT.HK')) {
              failureAttempts += 1;
              entered.resolve();
              await release.promise;
              if (!allowRetry) throw failure;
            }

            for (const symbol of symbols) actual.add(symbol);
          },
          unsubscribeSymbols: async (symbols) => {
            unsubscriptions.push([...symbols]);
            if (stage === 'unsubscribe' && symbols.includes('OLD.HK')) {
              failureAttempts += 1;
              entered.resolve();
              await release.promise;
              if (!allowRetry) throw failure;
            }

            for (const symbol of symbols) actual.delete(symbol);
          },
        },
      });
      await runtime.reconcileFromCurrentTruth();
      runtime.start();
      try {
        positions = [
          createPositionDouble({ symbol: 'NEXT.HK', quantity: 100, availableQuantity: 100 }),
        ];
        const committed = await snapshot.requestRefresh({
          source: 'POSITION_MUTATION',
          dayEpoch: snapshot.getView().token.dayEpoch,
          refreshAccount: true,
          refreshPositions: true,
        }).result;
        if (committed.status !== 'COMMITTED') throw new Error('当前持仓未提交');

        const reconcile = runtime
          .reconcilePositionHoldFromCurrentTruth(committed.snapshotToken)
          .catch((error: unknown) => error);
        await entered.promise;
        expect(lastState.allTradingSymbols).toEqual(actual);
        expect(actual.has('NEXT.HK')).toBe(stage === 'unsubscribe');
        holds.add('ORDER.HK');
        for (const listener of listeners) listener({ symbol: 'ORDER.HK', action: 'ADDED' });

        const ordinary = runtime.waitForAdmission(['ORDER.HK']);
        release.resolve();
        expect(await reconcile).toBe(failure);
        await ordinary;
        await runtime.waitForAdmission(['NEXT.HK']);
        expect(failureAttempts).toBe(1);
        expect(fatalErrors).toEqual([]);
        expect(lastState.allTradingSymbols).toEqual(actual);
        expect(actual.has('ORDER.HK')).toBe(true);
        expect(actual.has('OLD.HK')).toBe(stage === 'unsubscribe');
        expect(actual.has('NEXT.HK')).toBe(stage === 'unsubscribe');
        expect(subscriptions.at(-1)).toEqual(['ORDER.HK']);
        expect(unsubscriptions).toEqual(stage === 'unsubscribe' ? [['OLD.HK']] : []);

        allowRetry = true;

        // 失败准入后事实已改变：旧 NEXT 不应在后继显式对账中被重放。
        if (stage === 'subscribe') {
          positions = [
            createPositionDouble({ symbol: 'LATEST.HK', quantity: 100, availableQuantity: 100 }),
          ];

          await snapshot.requestRefresh({
            source: 'LATEST_POSITION_MUTATION',
            dayEpoch: snapshot.getView().token.dayEpoch,
            refreshAccount: true,
            refreshPositions: true,
          }).result;
        }

        await runtime.reconcilePositionHoldFromCurrentTruth(committed.snapshotToken);
        expect(lastState.allTradingSymbols).toEqual(actual);
        expect(actual.has('OLD.HK')).toBe(false);
        expect(actual.has('NEXT.HK')).toBe(stage === 'unsubscribe');
        expect(actual.has('LATEST.HK')).toBe(stage === 'subscribe');
        expect(failureAttempts).toBe(stage === 'unsubscribe' ? 2 : 1);
        expect(fatalErrors).toEqual([]);
      } finally {
        release.resolve();
        allowRetry = true;
        await runtime.stopAndDrain().catch(() => runtime.stopAndDrain());
      }
    },
  );
});
