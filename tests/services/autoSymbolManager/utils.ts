/**
 * autoSymbolManager 业务测试共用工具
 *
 * 供 autoSearch、switchStateMachine 等测试使用。
 */
import type { AutoSearchConfig } from '../../../src/types/config.js';
import type {
  DirectionalAutoSearchPolicy,
  FindBestWarrantInput,
  WarrantCandidate,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import type { SymbolRegistry } from '../../../src/types/seat.js';
import type { SignalCallerAuthorization } from '../../../src/types/trader.js';

/**
 * 场景显式捕获原席位版本；异步期间真实版本变化后不得继续推进。
 * @param registry 本场景唯一席位事实源
 * @param direction 本轮方向
 * @returns 绑定原版本的授权闭包；不是默认放行或迟到重新取票
 */
export function captureSwitchSeatAuthorization(
  registry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
  direction: 'LONG' | 'SHORT',
): SignalCallerAuthorization {
  const capturedVersion = registry.getSeatVersion(direction);
  return () => {
    const seat = registry.getSeatState(direction);
    return (
      registry.getSeatVersion(direction) === capturedVersion &&
      (seat.status === 'ACTIVE' || seat.status === 'SWITCHING')
    );
  };
}

/**
 * 寻标场景捕获原EMPTY/SEARCHING席位版本；新版本或非寻标owner状态使原授权失效。
 * @param registry 场景唯一席位事实源
 * @param direction 原寻标方向
 * @returns 原版本授权，不给后继任务默认放行
 */
export function captureSearchSeatAuthorization(
  registry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
  direction: 'LONG' | 'SHORT',
): SignalCallerAuthorization {
  const capturedVersion = registry.getSeatVersion(direction);
  return () => {
    const seat = registry.getSeatState(direction);
    return (
      registry.getSeatVersion(direction) === capturedVersion &&
      (seat.status === 'EMPTY' || seat.status === 'SEARCHING')
    );
  };
}

/**
 * 创建无操作 logger 替身，用于隔离日志副作用的测试。
 *
 * @returns 含 debug、info、warn、error 空实现的 logger 对象
 */
export function createLoggerStub(): {
  readonly debug: Logger['debug'];
  readonly info: Logger['info'];
  readonly warn: Logger['warn'];
  readonly error: Logger['error'];
} {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 返回默认自动寻标配置，便于测试中覆盖单字段。
 *
 * @returns 符合 AutoSearchConfig 的默认配置对象
 */
export function getDefaultAutoSearchConfig(): AutoSearchConfig {
  return {
    autoSearchEnabled: true,
    autoSearchMinDistancePctBull: '0.35',
    autoSearchMinDistancePctBear: '-0.35',
    autoSearchMinTurnoverPerMinuteBull: '100000',
    autoSearchMinTurnoverPerMinuteBear: '100000',
    autoSearchExpiryMinMonths: 3,
    autoSearchOpenDelayMinutes: 0,
    switchIntervalMinutes: 0,
    switchDistanceRangeBull: { min: '0.2', max: '1.5' },
    switchDistanceRangeBear: { min: '-1.5', max: '-0.2' },
  };
}

/**
 * 构造方向化自动寻标策略，供 autoSymbolManager 相关测试复用。
 *
 * @param direction 方向（LONG/SHORT）
 * @returns 与默认自动寻标配置对齐的共享策略对象
 */
export function createDirectionalAutoSearchPolicy(
  direction: 'LONG' | 'SHORT',
): DirectionalAutoSearchPolicy {
  if (direction === 'LONG') {
    return {
      direction,
      primaryThreshold: '0.35',
      minTurnoverPerMinute: '100000',
      degradedRange: { min: '0.2', max: '0.35' },
      switchDistanceRange: { min: '0.2', max: '1.5' },
    };
  }

  return {
    direction,
    primaryThreshold: '-0.35',
    minTurnoverPerMinute: '100000',
    degradedRange: { min: '-0.35', max: '-0.2' },
    switchDistanceRange: { min: '-1.5', max: '-0.2' },
  };
}

/**
 * 构造自动寻标候选结果，避免测试中重复填写命中阶段字段。
 *
 * @param symbol 标的代码
 * @returns 默认命中主条件的候选
 */
export function createWarrantCandidate(symbol: string): WarrantCandidate {
  return createWarrantCandidateWithOverrides(symbol);
}

/**
 * 构造自动寻标候选结果，并允许覆盖默认字段。
 *
 * @param symbol 标的代码
 * @param overrides 需要覆盖的候选字段
 * @returns 默认命中主条件的候选
 */
export function createWarrantCandidateWithOverrides(
  symbol: string,
  overrides: Partial<WarrantCandidate> = {},
): WarrantCandidate {
  return {
    symbol,
    name: symbol,
    callPrice: '21000',
    distancePct: '0.5',
    turnover: '1000000',
    turnoverPerMinute: '100000',
    selectionStage: 'PRIMARY',
    distanceDeltaToThreshold: '0.15',
    ...overrides,
  };
}

/**
 * 构造最小可用的 FindBestWarrantInput，供 autoSymbolManager 相关测试复用。
 *
 * @param policy 寻标策略；默认使用 LONG 方向策略
 * @returns 类型完整的 finder 入参
 */
export function createFindBestWarrantInputDouble(
  policy: DirectionalAutoSearchPolicy = createDirectionalAutoSearchPolicy('LONG'),
): FindBestWarrantInput {
  return {
    ctx: { warrantQuote: async () => [], warrantList: async () => [] },
    monitorSymbol: 'HSI.HK',
    tradingMinutes: 10,
    policy,
    expiryMinMonths: 3,
    logger: createLoggerStub(),
  };
}
