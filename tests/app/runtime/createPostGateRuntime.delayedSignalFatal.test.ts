/**
 * createPostGateRuntime 延迟验证 fatal 装配测试
 *
 * 验证：延迟验证器内部不变量异常必须进入 post-gate 的统一 fatal drain，
 * 使 app 顶层能够终止运行并执行既有清理链路。
 */
import { describe, expect, it } from 'bun:test';

import { createMonitorContext } from '../../../src/app/context/createMonitorContext.js';
import { createPostGateRuntimeFactory } from '../../../src/app/runtime/createPostGateRuntime.js';
import { createCleanup } from '../../../src/app/shutdown/createCleanup.js';
import type { CreatePostGateRuntimeParams, PostGateRuntime } from '../../../src/app/types.js';
import { createWarrantListCache } from '../../../src/services/autoSymbolFinder/utils.js';
import { createSignal } from '../../../mock/factories/signalFactory.js';
import { createMonitorConfig, createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createMarketDataClientDouble,
  createSdkConfigDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';

const FATAL_DRAIN_TIMEOUT_MS = 100;

function createRuntimeParams(): CreatePostGateRuntimeParams {
  const warrantListCache = createWarrantListCache();
  const monitorConfig = createMonitorConfig({ monitorSymbol: 'HSI.HK' });

  return {
    env: {
      APP_RUNTIME_PROFILE: 'test',
    },
    now: new Date('2026-03-13T09:30:00+08:00'),
    cleanup: createCleanup(),
    preGateRuntime: {
      config: createSdkConfigDouble(),
      tradingConfig: createTradingConfig({ monitor: monitorConfig }),
      symbolRegistry: createSymbolRegistryDouble(),
      warrantListCache,
      warrantListCacheConfig: {
        cache: warrantListCache,
        ttlMs: 60_000,
        nowMs: () => 0,
      },
      marketDataClient: createMarketDataClientDouble(),
      startupTradingDayInfo: {
        dateKey: '2026-03-13',
        info: {
          isTradingDay: true,
          isHalfDay: false,
        },
      },
    },
  };
}

async function createRuntime(): Promise<{
  readonly params: CreatePostGateRuntimeParams;
  readonly runtime: PostGateRuntime;
}> {
  const params = createRuntimeParams();
  const createPostGateRuntime = createPostGateRuntimeFactory({
    createMonitorContext,
    createTrader: async () => createTraderDouble(),
  });

  return {
    params,
    runtime: await createPostGateRuntime(params),
  };
}

async function waitForFatalError(runtime: PostGateRuntime): Promise<Error> {
  const fatalError = await Promise.race([
    runtime.drainFatalError().catch((error: unknown) => error),
    Bun.sleep(FATAL_DRAIN_TIMEOUT_MS).then(() => null),
  ]);
  if (!(fatalError instanceof Error)) {
    throw new Error('expected delayed verifier failure to reject post-gate fatal drain');
  }

  return fatalError;
}

describe('createPostGateRuntime delayed signal fatal wiring', () => {
  it('drains a delayed verifier indicator-cache exception as a post-gate fatal error', async () => {
    const { params, runtime } = await createRuntime();
    const originalGetClosest = runtime.indicatorCache.getClosest;
    runtime.indicatorCache.getClosest = () => {
      throw new TypeError('indicator cache invariant broken');
    };

    try {
      runtime.monitorContext.delayedSignalVerifier.addSignal({
        signal: createSignal({
          symbol: 'BULL.HK',
          action: 'BUYCALL',
          triggerTimeMs: Date.now() - 11_000,
          indicators1: { K: 10 },
        }),
        verificationIndicators: ['K'],
      });

      const fatalError = await waitForFatalError(runtime);

      expect(fatalError).toBeInstanceOf(TypeError);
      expect(fatalError.message).toBe('indicator cache invariant broken');
    } finally {
      runtime.indicatorCache.getClosest = originalGetClosest;
      await params.cleanup.execute();
    }
  });
});
