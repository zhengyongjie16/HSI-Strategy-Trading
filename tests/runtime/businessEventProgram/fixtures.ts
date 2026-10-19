import type { RuntimeStateFixtures } from '../../helpers/types.js';
import { createRuntimeStateFixtures } from '../../helpers/runtimeStateFixtures.js';
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';

/** D-event 局部离线 fixture：真实 registry、trade queues、termination，无旧策略替身。 */
import { createSymbolRegistry } from '../../../src/domain/seat/symbolRegistry.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/runtime/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/runtime/lifecycle/terminationRuntime.js';
import { createBusinessEventProgram } from '../../../src/runtime/businessEventProgram/index.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { CandlestickUpdatedEvent } from '../../../src/types/marketPorts.js';
import type {
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/types/strategy.js';
import type { EventHarness, EventHarnessMutable } from './types.js';
import type { BusinessEventProgramDeps } from '../../../src/runtime/businessEventProgram/types.js';

type EventHarnessOptions = {
  readonly strategy?: TradingSignalStrategy;
  readonly createBusinessEventProgram?: typeof createBusinessEventProgram;
  readonly createBuyTaskQueue?: typeof createBuyTaskQueue;
  readonly createSellTaskQueue?: typeof createSellTaskQueue;
  readonly createSymbolRegistry?: typeof createSymbolRegistry;
  readonly createTerminationRuntime?: typeof createTerminationRuntime;
};

/** 仅供真实席位注册表使用的宿主配置。 */
export function monitorConfig(): MonitorConfig {
  return {
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    autoSearchConfig: {
      autoSearchEnabled: false,
      autoSearchMinDistancePctBull: null,
      autoSearchMinDistancePctBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 1,
      autoSearchOpenDelayMinutes: 0,
      switchIntervalMinutes: 0,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },
    orderOwnershipMapping: [],
    targetNotional: '1000',
    maxPositionNotional: '10000',
    maxUnrealizedLossPerSymbol: '1000',
    buyIntervalSeconds: 0,
    liquidationCooldown: null,
    liquidationTriggerLimit: 1,
    smartCloseEnabled: false,
    smartCloseTimeoutMinutes: null,
  };
}

/** 可显式推进时间和事件；同步 fatal 使用真实共享终止 owner。 */
export function createEventHarness(options: EventHarnessOptions = {}): EventHarness {
  const mutable: EventHarnessMutable = {
    nowMs: Date.parse('2026-07-15T02:00:00Z'),
    filled: true,
    recordReads: 0,
    subscriptions: 0,
    unsubscriptions: 0,
    handler: null,
    snapshot: {
      symbol: 'HSI.HK',
      period: 'MIN_1',
      version: 1,
      initialized: true,
      lastBarTimestamp: 1000,
      lastBarConfirmed: false,
      candles: [
        Object.freeze({
          timestamp: 1000,
          open: '100',
          high: 110,
          low: 90,
          close: 101,
          volume: 1000,
        }),
      ],
    },
  };
  const stateFixtures: RuntimeStateFixtures = createRuntimeStateFixtures({
    tradingTimeState: { canTrade: true, isHalfDay: false, openProtectionActive: false },
    lifecycleState: { isTradingEnabled: true, currentDayKey: '2026-07-15' },
    tradingCalendarState: {},
    quoteSubscriptionState: {},
  });
  const queueDeps = {
    clock: { now: () => new Date(mutable.nowMs) },
    diagnostics: createDiagnosticObserverDouble(),
  };
  const buyTaskQueue = (options.createBuyTaskQueue ?? createBuyTaskQueue)(queueDeps);
  const sellTaskQueue = (options.createSellTaskQueue ?? createSellTaskQueue)(queueDeps);
  const symbolRegistry = (options.createSymbolRegistry ?? createSymbolRegistry)(monitorConfig());
  const contexts: StrategyMarketContext[] = [];
  const emitters: StrategyEmitter[] = [];
  const displays: ReadonlyArray<StrategyDisplayItem>[] = [];
  const listeners = new Set<(event: CandlestickUpdatedEvent) => void>();
  const defaultStrategy: TradingSignalStrategy = {
    strategyId: 'event-test',
    onCandlestick: (context, emit) =>
      mutable.handler ? mutable.handler(context, emit) : [{ label: 'test', valueText: '1' }],
    invalidateDirection: () => {},
    invalidateAll: () => {},
    resetForTradingDay: () => {},
    destroy: () => {},
  };
  const configuredStrategy = options.strategy ?? defaultStrategy;
  const strategy: TradingSignalStrategy = {
    strategyId: configuredStrategy.strategyId,
    onCandlestick: (context, emit) => {
      contexts.push(context);
      emitters.push(emit);
      return configuredStrategy.onCandlestick(context, emit);
    },
    invalidateDirection: (direction) => {
      configuredStrategy.invalidateDirection(direction);
    },
    invalidateAll: () => {
      configuredStrategy.invalidateAll();
    },
    resetForTradingDay: () => {
      configuredStrategy.resetForTradingDay();
    },
    destroy: () => {
      configuredStrategy.destroy();
    },
  };
  const stopProducers: Array<() => void> = [];
  const termination = (options.createTerminationRuntime ?? createTerminationRuntime)({
    closeTradingGate: () => {
      stateFixtures.lifecycleState.isTradingEnabled = false;
    },
    closeProducerAdmission: () => {
      buyTaskQueue.close();
      sellTaskQueue.close();
    },
    stopProducers,
    onSecondaryError: () => {},
  });
  const deps: BusinessEventProgramDeps = {
    clock: { now: () => new Date(mutable.nowMs) },
    marketDataClient: {
      getCandlestickSnapshot: () => mutable.snapshot,
      onCandlestickUpdated: (listener) => {
        mutable.subscriptions += 1;
        listeners.add(listener);
        return () => {
          mutable.unsubscriptions += 1;
          listeners.delete(listener);
        };
      },
    },
    monitorContext: {
      config: monitorConfig(),
      strategy,
      symbolRegistry,
      orderRecorder: {
        getBuyOrdersForSymbol: (symbol) => {
          mutable.recordReads += 1;
          return mutable.filled
            ? [
                {
                  orderId: 'filled-buy',
                  symbol,
                  costAmount: '1000',
                  executedQuantity: 1000,
                  executedTime: 1,
                  submittedAt: undefined,
                  updatedAt: undefined,
                },
              ]
            : [];
        },
      },
      longSymbolName: '牛',
      shortSymbolName: '熊',
    },
    ...stateFixtures,
    tradingConfig: { global: { doomsdayProtection: false } },
    buyTaskQueue,
    sellTaskQueue,
    termination,
    monitorDisplayRuntime: {
      requestRender: ({ items }) => {
        displays.push(items);
      },
    },
  };
  const program = (options.createBusinessEventProgram ?? createBusinessEventProgram)(deps);
  stopProducers.push(program.stop);
  return {
    mutable,
    stateFixtures,
    buyTaskQueue,
    sellTaskQueue,
    symbolRegistry,
    contexts,
    displays,
    strategy,
    termination,
    deps,
    program,
    publish: (symbol = 'HSI.HK', period = 'MIN_1'): void => {
      for (const listener of listeners) {
        listener({ symbol, period });
      }
    },
    emitter: (): StrategyEmitter => {
      const emit = emitters.at(-1);
      if (!emit) {
        throw new Error('test origin missing');
      }

      return emit;
    },
  };
}
