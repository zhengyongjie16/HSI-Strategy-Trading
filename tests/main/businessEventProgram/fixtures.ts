/** D-event 局部离线 fixture：真实 registry、trade queues、termination，无旧策略替身。 */
import { Period } from 'longbridge';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createTerminationRuntime } from '../../../src/app/runtime/createTerminationRuntime.js';
import { createBusinessEventProgram } from '../../../src/main/businessEventProgram/index.js';
import type { MonitorConfig } from '../../../src/types/config.js';
import type { CandlestickUpdatedEvent } from '../../../src/types/services.js';
import type {
  StrategyDisplayItem,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../../../src/core/strategy/types.js';
import type { EventHarness, EventHarnessMutable } from './types.js';
import type { BusinessEventProgramDeps } from '../../../src/main/businessEventProgram/types.js';

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
    targetNotional: 1000,
    maxPositionNotional: 10000,
    maxUnrealizedLossPerSymbol: 1000,
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
      period: Period.Min_1,
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
  const lastState: BusinessEventProgramDeps['lastState'] = {
    isTradingEnabled: true,
    canTrade: true,
    isHalfDay: false,
    currentDayKey: '2026-07-15',
    openProtectionActive: false,
  };
  const buyTaskQueue = (options.createBuyTaskQueue ?? createBuyTaskQueue)();
  const sellTaskQueue = (options.createSellTaskQueue ?? createSellTaskQueue)();
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
      lastState.isTradingEnabled = false;
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
                  executedPrice: 1,
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
    lastState,
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
    lastState,
    buyTaskQueue,
    sellTaskQueue,
    symbolRegistry,
    contexts,
    emitters,
    displays,
    strategy,
    termination,
    deps,
    program,
    publish: (symbol = 'HSI.HK', period = Period.Min_1): void => {
      for (const listener of listeners) {
        listener({ symbol, period, snapshot: mutable.snapshot });
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
