/**
 * app pre-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 app 启动阶段必须完成的共享依赖
 * - 执行配置校验、行情客户端创建与启动交易日状态初始化
 * - 固定 pre-gate 对象所有权边界
 */
import { AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS } from '../../constants/index.js';
import { validateAllConfig } from '../../config/validator/index.js';
import { createTradingConfig } from '../../config/trading/index.js';
import { createWarrantListCache } from '../../infrastructure/longbridge/market/warrantListCache/index.js';
import { createSymbolRegistry } from '../../domain/seat/symbolRegistry.js';
import { createSeatDiagnosticRuntime } from '../../runtime/seatDiagnosticRuntime/index.js';
import { logger } from '../../infrastructure/logger/index.js';
import { getRequiredHKDateKey } from '../../utils/time/index.js';
import { formatError } from '../../utils/error/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { createTradingDayInfoResolver } from '../startup/tradingDayInfoResolver.js';
import { DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS } from './createPreGateRuntimeDeps.js';
import type { CreatePreGateRuntimeParams, PreGateRuntime } from '../types.js';

/**
 * 创建 pre-gate runtime 工厂。
 *
 * @param deps pre-gate 创建链路中的可注入依赖
 * @returns pre-gate runtime 创建函数
 */
function createPreGateRuntimeFactory(
  deps: typeof DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS,
): (params: CreatePreGateRuntimeParams) => Promise<PreGateRuntime | null> {
  const { createLongbridgeClientFactory: buildClientFactory } = deps;

  return async function createPreGateRuntime(
    params: CreatePreGateRuntimeParams,
  ): Promise<PreGateRuntime | null> {
    const { env, cleanup, termination, diagnostics, clock } = params;
    const tradingConfig = createTradingConfig({ logger: logger, env });
    await validateAllConfig({ logger: logger, env, tradingConfig });
    if (termination.isTerminated()) return null;

    const symbolRegistry = createSymbolRegistry(tradingConfig.monitor);
    const seatDiagnosticRuntime = createSeatDiagnosticRuntime({
      symbolRegistry,
      diagnostics,
      clock,
    });
    cleanup.register({
      phase: 'STOP_SEAT_DIAGNOSTIC_RUNTIME',
      step: '注销席位被动诊断订阅',
      handler: () => {
        seatDiagnosticRuntime.stop();
      },
    });
    // 仅订阅诊断，在首个启动席位 mutation 前开始；不启动业务清理或激活 dispatcher。
    seatDiagnosticRuntime.start();
    const warrantListCache = createWarrantListCache();
    const warrantListCacheConfig = {
      cache: warrantListCache,
      ttlMs: AUTO_SYMBOL_WARRANT_LIST_CACHE_TTL_MS,
      nowMs: () => Date.now(),
    };

    const brokerClientFactory = await buildClientFactory({
      env,
      warrantListCacheConfig,
      onOpenUrl: (url: string) => {
        logger.info(`请在浏览器中完成 Longbridge OAuth 授权：${url}`);
      },
    });
    if (termination.isTerminated()) return null;

    const marketDataClient = await brokerClientFactory.createMarketDataClient();
    cleanup.register({
      phase: 'RESET_MARKET_DATA_RUNTIME',
      step: '重置行情运行态订阅与缓存',
      handler: () => marketDataClient.resetRuntimeSubscriptionsAndCaches(),
    });

    if (termination.isTerminated()) return null;

    const resolveTradingDayInfo = createTradingDayInfoResolver({
      marketDataClient,
      onResolveError: (err: unknown) => {
        logger.warn('启动交易日信息解析失败，运行期将继续解析', formatError(err));
      },
    });
    const startupTime = new Date();
    const startupDateKey = getRequiredHKDateKey(startupTime);
    let startupTradingDayInfo: PreGateRuntime['startupTradingDayInfo'];
    try {
      startupTradingDayInfo = {
        dateKey: startupDateKey,
        info: await resolveTradingDayInfo(startupTime),
      };
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      startupTradingDayInfo = null;
    }

    if (termination.isTerminated()) return null;

    return {
      diagnostics,
      brokerClientFactory,
      tradingConfig,
      symbolRegistry,
      warrantListCache,
      marketDataClient,
      startupTradingDayInfo,
    };
  };
}

export const createPreGateRuntime = createPreGateRuntimeFactory(
  DEFAULT_CREATE_PRE_GATE_RUNTIME_DEPS,
);
