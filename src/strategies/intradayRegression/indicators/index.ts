/**
 * 日内回归增量指标计算模块
 *
 * 职责：
 * - 提供增量 runtime 的 bootstrap / update / snapshot 构造能力
 * - 对外快照统一构造成普通值对象，不持有 clock、timer、emitter 或 I/O
 */
import { isValidPositiveNumber } from '../../../utils/helpers/index.js';
import type { CandleData, NormalizedCandle } from '../../../types/data.js';
import type { IndicatorSnapshot } from '../types.js';
import type { IndicatorUsageProfile } from '../profile/types.js';
import type { StrategyCandlestickSnapshot } from '../../../types/strategy.js';
import {
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../indicatorHelpers/utils.js';
import { cloneAdxState, commitAdxCandle, createAdxState, readAdxValue } from './adx.js';
import { cloneEmaState, readEmaValue } from './ema.js';
import { cloneKdjState, commitKdjCandle, createKdjState, readKdjValue } from './kdj.js';
import { cloneMacdState, commitMacdClose, createMacdState, readMacdValue } from './macd.js';
import { cloneMfiState, commitMfiCandle, createMfiState, readMfiValue } from './mfi.js';
import { clonePsyState, commitPsyClose, createPsyState, readPsyValue } from './psy.js';
import { cloneRsiState, commitRsiClose, createRsiState, readRsiValue } from './rsi.js';
import { feedEmaStreamState, initEmaStreamState, toNumber } from './indicatorMath.js';
import type { IndicatorCommittedState, IndicatorRuntimeState } from './types.js';

function createRecordFromPeriods<T>(params: {
  readonly periods: ReadonlyArray<number>;
  readonly isValidPeriod: (period: unknown) => period is number;
  readonly createState: (period: number) => T;
}): Record<number, T> {
  const result: Record<number, T> = {};
  for (const period of params.periods) {
    if (!params.isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    result[period] = params.createState(period);
  }

  return result;
}

function cloneRecord<T>(source: Record<number, T>, cloneState: (value: T) => T): Record<number, T> {
  const result: Record<number, T> = {};
  for (const [periodKey, state] of Object.entries(source)) {
    const period = Number(periodKey);
    if (!Number.isFinite(period)) {
      continue;
    }

    result[period] = cloneState(state);
  }

  return result;
}

/**
 * 基于指标画像创建仅包含已确认收线状态的 committed 容器。
 *
 * 该状态只允许由 bootstrap 或 confirmed/shift commit 推进，不能直接承载活动 bar 的 preview 结果，
 * 从而保证运行期始终存在一份稳定、可复用的已提交指标基线。
 *
 * @param profile 指标画像
 * @returns 仅包含 committed 指标子状态的容器
 */
function buildCommittedState(profile: IndicatorUsageProfile): IndicatorCommittedState {
  return {
    lastValidClose: null,
    emaStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.ema,
      isValidPeriod: validateEmaPeriod,
      createState: initEmaStreamState,
    }),
    rsiStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.rsi,
      isValidPeriod: validateRsiPeriod,
      createState: createRsiState,
    }),
    psyStates: createRecordFromPeriods({
      periods: profile.requiredPeriods.psy,
      isValidPeriod: validatePsyPeriod,
      createState: createPsyState,
    }),
    mfiState: profile.requiredFamilies.mfi ? createMfiState(14) : null,
    kdjState: profile.requiredFamilies.kdj ? createKdjState(9, 3) : null,
    macdState: profile.requiredFamilies.macd ? createMacdState(12, 26, 9) : null,
    adxState: profile.requiredFamilies.adx ? createAdxState(14) : null,
  };
}

function cloneCommittedState(committed: IndicatorCommittedState): IndicatorCommittedState {
  return {
    lastValidClose: committed.lastValidClose,
    emaStates: cloneRecord(committed.emaStates, cloneEmaState),
    rsiStates: cloneRecord(committed.rsiStates, cloneRsiState),
    psyStates: cloneRecord(committed.psyStates, clonePsyState),
    mfiState: committed.mfiState === null ? null : cloneMfiState(committed.mfiState),
    kdjState: committed.kdjState === null ? null : cloneKdjState(committed.kdjState),
    macdState: committed.macdState === null ? null : cloneMacdState(committed.macdState),
    adxState: committed.adxState === null ? null : cloneAdxState(committed.adxState),
  };
}

/**
 * 将单根已确认 K 线正式写入 committed 状态。
 *
 * 该函数只用于 confirmed bar 或 shift 后已完成的历史 bar，负责同步推进最近两个有效 close、
 * 周期指标状态以及依赖整根 OHLCV 的指标状态。活动 bar 的 preview 不会直接污染这里的输入状态。
 *
 * @param state committed 指标状态
 * @param candle 已确认收线的 K 线
 * @returns 本根柱是否产生当前可用的 K/D/J
 */
function commitCandleToCommittedState(state: IndicatorCommittedState, candle: CandleData): boolean {
  const close = toNumber(candle.close);
  if (isValidPositiveNumber(close)) {
    state.lastValidClose = close;

    for (const emaState of Object.values(state.emaStates)) {
      feedEmaStreamState(emaState, close);
    }

    for (const rsiState of Object.values(state.rsiStates)) {
      commitRsiClose(rsiState, close);
    }

    for (const psyState of Object.values(state.psyStates)) {
      commitPsyClose(psyState, close);
    }

    if (state.macdState !== null) {
      commitMacdClose(state.macdState, close);
    }
  }

  if (state.mfiState !== null) {
    commitMfiCandle(state.mfiState, candle);
  }

  const kdjAvailable =
    state.kdjState === null ? false : commitKdjCandle(state.kdjState, candle).available;

  if (state.adxState !== null) {
    commitAdxCandle(state.adxState, candle);
  }

  return kdjAvailable;
}

function buildPeriodSnapshotRecord<T>(params: {
  readonly periods: ReadonlyArray<number>;
  readonly isValidPeriod: (period: unknown) => period is number;
  readonly states: Record<number, T>;
  readonly readValue: (state: T) => number | null;
}): Record<number, number> | null {
  if (params.periods.length === 0) {
    return null;
  }

  const periodRecord: Record<number, number> = {};
  let hasValue = false;
  for (const period of params.periods) {
    if (!params.isValidPeriod(period) || !Number.isInteger(period)) {
      continue;
    }

    const state = params.states[period];
    if (!state) {
      continue;
    }

    const value = params.readValue(state);
    if (value === null) {
      continue;
    }

    periodRecord[period] = value;
    hasValue = true;
  }

  if (!hasValue) {
    return null;
  }

  return periodRecord;
}

function buildSnapshotFromCommitted(params: {
  readonly profile: IndicatorUsageProfile;
  readonly committed: IndicatorCommittedState;
  readonly kdjAvailable: boolean;
}): IndicatorSnapshot | null {
  const { profile, committed, kdjAvailable } = params;
  const price = committed.lastValidClose;
  if (price === null) {
    return null;
  }

  const ema = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.ema,
    isValidPeriod: validateEmaPeriod,
    states: committed.emaStates,
    readValue: readEmaValue,
  });
  const rsi = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.rsi,
    isValidPeriod: validateRsiPeriod,
    states: committed.rsiStates,
    readValue: readRsiValue,
  });
  const psy = buildPeriodSnapshotRecord({
    periods: profile.requiredPeriods.psy,
    isValidPeriod: validatePsyPeriod,
    states: committed.psyStates,
    readValue: readPsyValue,
  });
  const mfi =
    profile.requiredFamilies.mfi && committed.mfiState !== null
      ? readMfiValue(committed.mfiState)
      : null;
  const kdj =
    profile.requiredFamilies.kdj && kdjAvailable && committed.kdjState !== null
      ? readKdjValue(committed.kdjState)
      : null;
  const macd =
    profile.requiredFamilies.macd && committed.macdState !== null
      ? readMacdValue(committed.macdState)
      : null;
  const adx =
    profile.requiredFamilies.adx && committed.adxState !== null
      ? readAdxValue(committed.adxState)
      : null;

  return {
    ema,
    rsi,
    psy,
    mfi,
    kdj,
    macd,
    adx,
  };
}

function resolveActiveBar(params: {
  readonly candles: ReadonlyArray<NormalizedCandle>;
  readonly lastBarConfirmed: boolean | null;
}): NormalizedCandle | null {
  if (params.lastBarConfirmed !== false) {
    return null;
  }

  return params.candles.at(-1) ?? null;
}

/**
 * 从缓存快照 bootstrap 增量运行态。
 *
 * @param params bootstrap 参数
 * @returns 增量运行态，无有效输入时返回 null
 */
export function bootstrapIndicatorRuntime(params: {
  readonly symbol: string;
  readonly cacheSnapshot: StrategyCandlestickSnapshot;
  readonly indicatorProfile: IndicatorUsageProfile;
}): IndicatorRuntimeState | null {
  const { symbol, cacheSnapshot, indicatorProfile } = params;
  if (symbol !== cacheSnapshot.symbol) throw new Error('策略指标 bootstrap symbol 不一致');

  if (!cacheSnapshot.initialized || cacheSnapshot.candles.length === 0) {
    return null;
  }

  const activeBar = resolveActiveBar({
    candles: cacheSnapshot.candles,
    lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
  });
  const committed = buildCommittedState(indicatorProfile);
  const closedCandlesEnd =
    activeBar === null ? cacheSnapshot.candles.length : cacheSnapshot.candles.length - 1;
  let lastKdjAvailable = false;
  for (let index = 0; index < closedCandlesEnd; index += 1) {
    const candle = cacheSnapshot.candles[index];
    if (!candle) {
      continue;
    }

    lastKdjAvailable = commitCandleToCommittedState(committed, candle);
  }

  return {
    symbol,
    profile: indicatorProfile,
    lastProcessedVersion: cacheSnapshot.version,
    activeBarConfirmed: activeBar === null ? cacheSnapshot.lastBarConfirmed : false,
    activeBar,
    lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
    lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
    lastKdjAvailable,
    committed,
  };
}

/**
 * 无法可靠增量推进时，基于最新缓存快照回退重建 runtime。
 *
 * @param params 运行态与最新缓存快照
 * @returns 重建后的增量运行态；输入无效时返回 null
 */
function rebuildRuntimeFromSnapshot(params: {
  readonly runtime: IndicatorRuntimeState;
  readonly cacheSnapshot: StrategyCandlestickSnapshot;
}): IndicatorRuntimeState | null {
  return bootstrapIndicatorRuntime({
    symbol: params.runtime.symbol,
    cacheSnapshot: params.cacheSnapshot,
    indicatorProfile: params.runtime.profile,
  });
}

/**
 * 在缓存最后一根 timestamp 前进后，提交旧活动 bar 并衔接新的活动/已确认区间。
 *
 * 该分支负责处理“上一拍还是活动 bar，本拍只看到了最终 shift 后快照”的场景：
 * 如果旧最后一根尚未确认，就先把它按 finalized previous bar 提交，再继续消费后续新增 candles，
 * 从而保证 confirmed 与 next bar 在同一事件处理轮次内到达时，committed 状态仍与全量重算一致。
 *
 * @param params 运行态与最新缓存快照
 * @returns 推进后的增量运行态；无法可靠推进时回退为重建或返回 null
 */
function commitShiftedCandles(params: {
  readonly runtime: IndicatorRuntimeState;
  readonly cacheSnapshot: StrategyCandlestickSnapshot;
}): IndicatorRuntimeState | null {
  const { runtime, cacheSnapshot } = params;
  const previousTimestamp = runtime.lastBarTimestamp;
  if (previousTimestamp === null) {
    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  const previousIndex = cacheSnapshot.candles.findIndex(
    (candle) => candle.timestamp === previousTimestamp,
  );
  if (previousIndex === -1) {
    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  const nextCommitted = cloneCommittedState(runtime.committed);
  let lastKdjAvailable = runtime.lastKdjAvailable;
  if (runtime.lastBarConfirmed === false) {
    const finalizedPrevious = cacheSnapshot.candles[previousIndex];
    if (finalizedPrevious) {
      lastKdjAvailable = commitCandleToCommittedState(nextCommitted, finalizedPrevious);
    }
  }

  let activeBar: NormalizedCandle | null = null;
  let activeBarConfirmed: boolean | null = cacheSnapshot.lastBarConfirmed;
  const lastIndex = cacheSnapshot.candles.length - 1;
  for (let index = previousIndex + 1; index < cacheSnapshot.candles.length; index += 1) {
    const candle = cacheSnapshot.candles[index];
    if (!candle) {
      continue;
    }

    const isLast = index === lastIndex;
    if (isLast && cacheSnapshot.lastBarConfirmed === false) {
      activeBar = candle;
      activeBarConfirmed = false;
      continue;
    }

    lastKdjAvailable = commitCandleToCommittedState(nextCommitted, candle);
  }

  return {
    ...runtime,
    lastProcessedVersion: cacheSnapshot.version,
    activeBarConfirmed,
    activeBar,
    lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
    lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
    lastKdjAvailable,
    committed: nextCommitted,
  };
}

/**
 * 基于最新缓存快照推进增量运行态。
 *
 * @param params 更新参数
 * @returns 新运行态；输入无效时返回 null
 */
export function updateRuntimeForCandlestickSnapshot(params: {
  readonly runtime: IndicatorRuntimeState;
  readonly cacheSnapshot: StrategyCandlestickSnapshot;
}): IndicatorRuntimeState | null {
  const { runtime, cacheSnapshot } = params;
  if (runtime.symbol !== cacheSnapshot.symbol) throw new Error('策略指标运行态 symbol 不一致');

  if (!cacheSnapshot.initialized || cacheSnapshot.candles.length === 0) {
    return null;
  }

  if (cacheSnapshot.version === runtime.lastProcessedVersion) {
    return runtime;
  }

  const nextLastTimestamp = cacheSnapshot.lastBarTimestamp;
  const previousLastTimestamp = runtime.lastBarTimestamp;
  if (nextLastTimestamp === null || previousLastTimestamp === null) {
    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  if (nextLastTimestamp === previousLastTimestamp) {
    const latestCandle = cacheSnapshot.candles.at(-1) ?? null;
    if (latestCandle === null) {
      return null;
    }

    if (runtime.lastBarConfirmed === false && cacheSnapshot.lastBarConfirmed === false) {
      return {
        ...runtime,
        lastProcessedVersion: cacheSnapshot.version,
        activeBarConfirmed: false,
        activeBar: latestCandle,
        lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
        lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
      };
    }

    if (runtime.lastBarConfirmed === false && cacheSnapshot.lastBarConfirmed === true) {
      const nextCommitted = cloneCommittedState(runtime.committed);
      const lastKdjAvailable = commitCandleToCommittedState(nextCommitted, latestCandle);
      return {
        ...runtime,
        lastProcessedVersion: cacheSnapshot.version,
        activeBarConfirmed: true,
        activeBar: null,
        lastBarTimestamp: cacheSnapshot.lastBarTimestamp,
        lastBarConfirmed: cacheSnapshot.lastBarConfirmed,
        lastKdjAvailable,
        committed: nextCommitted,
      };
    }

    return rebuildRuntimeFromSnapshot({ runtime, cacheSnapshot });
  }

  return commitShiftedCandles({
    runtime,
    cacheSnapshot,
  });
}

/**
 * 从增量运行态构造对外指标快照。
 *
 * @param runtime 增量运行态
 * @returns 指标快照；无有效价格时返回 null
 */
export function buildSnapshotFromRuntime(runtime: IndicatorRuntimeState): IndicatorSnapshot | null {
  if (runtime.activeBar !== null && runtime.activeBarConfirmed === false) {
    const previewCommitted = cloneCommittedState(runtime.committed);
    const kdjAvailable = commitCandleToCommittedState(previewCommitted, runtime.activeBar);
    return buildSnapshotFromCommitted({
      profile: runtime.profile,
      committed: previewCommitted,
      kdjAvailable,
    });
  }

  return buildSnapshotFromCommitted({
    profile: runtime.profile,
    committed: runtime.committed,
    kdjAvailable: runtime.lastKdjAvailable,
  });
}
