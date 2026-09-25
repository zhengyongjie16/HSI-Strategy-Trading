/**
 * KDJ（随机指标）计算模块
 *
 * 指标参数：
 * - RSV 窗口周期：默认 9（计算最高价、最低价的窗口大小）
 * - K/D 平滑周期：3（对 RSV 与 K 分别做 rolling SMA）
 * - J = 3K - 2D
 */
import { roundToFixed3 } from './utils.js';
import type { CandleData } from '../../../../types/data.js';
import type { KdjCandleCommitResult, KdjStreamState, KDJIndicator } from './types.js';

/**
 * 创建 KDJ 流式状态。
 *
 * @param period RSV 窗口周期
 * @param signalPeriod K/D 平滑周期
 * @returns 初始化状态
 */
export function createKdjState(period: number = 9, signalPeriod: number = 3): KdjStreamState {
  return {
    period,
    signalPeriod,
    index: 0,
    maxIndexDeque: [],
    maxValueDeque: [],
    minIndexDeque: [],
    minValueDeque: [],
    rsvWindow: [],
    rsvWindowSum: 0,
    kWindow: [],
    kWindowSum: 0,
    hasKdjValue: false,
    lastK: 0,
    lastD: 0,
  };
}

/**
 * 克隆 KDJ 状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneKdjState(state: KdjStreamState): KdjStreamState {
  return {
    period: state.period,
    signalPeriod: state.signalPeriod,
    index: state.index,
    maxIndexDeque: [...state.maxIndexDeque],
    maxValueDeque: [...state.maxValueDeque],
    minIndexDeque: [...state.minIndexDeque],
    minValueDeque: [...state.minValueDeque],
    rsvWindow: [...state.rsvWindow],
    rsvWindowSum: state.rsvWindowSum,
    kWindow: [...state.kWindow],
    kWindowSum: state.kWindowSum,
    hasKdjValue: state.hasKdjValue,
    lastK: state.lastK,
    lastD: state.lastD,
  };
}

function dropOutdatedEntries(state: KdjStreamState, windowStart: number): void {
  while (state.maxIndexDeque.length > 0) {
    const headIndex = state.maxIndexDeque[0];
    if (headIndex !== undefined && headIndex < windowStart) {
      state.maxIndexDeque.shift();
      state.maxValueDeque.shift();
      continue;
    }

    break;
  }

  while (state.minIndexDeque.length > 0) {
    const headIndex = state.minIndexDeque[0];
    if (headIndex !== undefined && headIndex < windowStart) {
      state.minIndexDeque.shift();
      state.minValueDeque.shift();
      continue;
    }

    break;
  }
}

function pushRollingWindow(window: number[], nextValue: number, size: number): number {
  window.push(nextValue);
  if (window.length > size) {
    return window.shift() ?? 0;
  }

  return 0;
}

/**
 * 以最大绝对值缩放后求窗口和，避免 next - removed 在相反极值间先溢出。
 *
 * 窗口中的每个值都必须已经通过有限值检查；缩放只改变求和的中间表示，最终乘回原尺度后仍以
 * Number.isFinite 结果表示当前轮是否可计算。窗口和本身不可表示时保留 Infinity/-Infinity，由下一轮
 * 重新按完整窗口求和，避免极值被淘汰后继续污染后续结果。
 *
 * @param values 已接受的滚动窗口
 * @returns 窗口和；数学结果不可由 number 表示时返回相应的非有限值
 */
function sumScaledWindow(values: ReadonlyArray<number>): number {
  let scale = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      return Number.NaN;
    }

    scale = Math.max(scale, Math.abs(value));
  }

  if (scale === 0) {
    return 0;
  }

  let normalizedSum = 0;
  let compensation = 0;
  for (const value of values) {
    const normalizedValue = value / scale;
    const nextSum = normalizedSum + normalizedValue;
    compensation +=
      Math.abs(normalizedSum) >= Math.abs(normalizedValue)
        ? normalizedSum - nextSum + normalizedValue
        : normalizedValue - nextSum + normalizedSum;

    normalizedSum = nextSum;
  }

  return (normalizedSum + compensation) * scale;
}

/**
 * 推进滚动窗口和。每轮以完整窗口的缩放和作为可恢复基线；普通输入在增量结果与该基线一致时沿用
 * 原有浮点加法顺序，只有发生溢出或灾难性消减时才采用重算值。
 *
 * 这样既保持普通输入原有的浮点运算结果，又能在极值被移出窗口后从未污染的窗口值恢复。
 *
 * @param window 滚动窗口
 * @param nextValue 待加入值
 * @param size 窗口大小
 * @param previousSum 上一轮窗口和
 * @returns 当前窗口和
 */
function pushAndSumRollingWindow(
  window: number[],
  nextValue: number,
  size: number,
  previousSum: number,
): number {
  const removedValue = pushRollingWindow(window, nextValue, size);
  const delta = nextValue - removedValue;
  const incrementalSum = previousSum + delta;
  const recomputedSum = sumScaledWindow(window);

  if (!Number.isFinite(recomputedSum)) {
    return recomputedSum;
  }

  if (
    !Number.isFinite(previousSum) ||
    !Number.isFinite(delta) ||
    !Number.isFinite(incrementalSum)
  ) {
    return recomputedSum;
  }

  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(incrementalSum), Math.abs(recomputedSum)) * window.length;
  return Math.abs(incrementalSum - recomputedSum) <= tolerance ? incrementalSum : recomputedSum;
}

/**
 * 将 KDJ 所需的单个 H/L/C 输入转换为有限数值。
 *
 * KDJ 的校验不能复用 runtime/utils.ts 的宽松转换：null、undefined、空白文本和非有限值都必须在
 * 任何 KDJ 状态写入前拒绝；合法数值字符串（包括零、负数及带首尾空白的文本）仍可参与计算。
 *
 * @param value KDJ 输入字段
 * @returns 有限数值，输入缺失或无效时返回 null
 */
function readFiniteKdjValue(value: CandleData['close']): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  let text: string;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  try {
    text = (typeof value === 'string' ? value : value.toString()).trim();
  } catch {
    return null;
  }

  if (text === '') {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 提交一根 K 线到 KDJ 状态。
 *
 * H/L/C 的完整校验先于 index、单调队列和任何平滑窗口 mutation；因此坏柱严格保持整个 KDJ 状态不变。
 * 合法柱即使当前滚动高低范围为零，也会推进高低窗口并保留既有平滑状态，只让本轮输出不可用，待后续
 * 范围恢复后继续从保留的平滑状态计算。
 *
 * @param state KDJ 状态
 * @param candle K 线
 * @returns 本轮 K/D/J 是否可用
 */
export function commitKdjCandle(state: KdjStreamState, candle: CandleData): KdjCandleCommitResult {
  const high = readFiniteKdjValue(candle.high);
  const low = readFiniteKdjValue(candle.low);
  const close = readFiniteKdjValue(candle.close);
  if (high === null || low === null || close === null) {
    return { available: false };
  }

  const i = state.index;
  state.index += 1;

  while (state.maxValueDeque.length > 0) {
    const tailValue = state.maxValueDeque.at(-1);
    if (tailValue !== undefined && tailValue <= high) {
      state.maxValueDeque.pop();
      state.maxIndexDeque.pop();
      continue;
    }

    break;
  }

  state.maxIndexDeque.push(i);
  state.maxValueDeque.push(high);

  while (state.minValueDeque.length > 0) {
    const tailValue = state.minValueDeque.at(-1);
    if (tailValue !== undefined && tailValue >= low) {
      state.minValueDeque.pop();
      state.minIndexDeque.pop();
      continue;
    }

    break;
  }

  state.minIndexDeque.push(i);
  state.minValueDeque.push(low);

  if (i < state.period - 1) {
    return { available: false };
  }

  const windowStart = i - state.period + 1;
  dropOutdatedEntries(state, windowStart);

  const highestHigh = state.maxValueDeque[0];
  const lowestLow = state.minValueDeque[0];
  if (highestHigh === undefined || lowestLow === undefined) {
    return { available: false };
  }

  const range = highestHigh - lowestLow;
  if (!Number.isFinite(range) || range === 0) {
    return { available: false };
  }

  const rsv = ((close - lowestLow) / range) * 100;
  if (!Number.isFinite(rsv)) {
    return { available: false };
  }

  state.rsvWindowSum = pushAndSumRollingWindow(
    state.rsvWindow,
    rsv,
    state.signalPeriod,
    state.rsvWindowSum,
  );

  if (!Number.isFinite(state.rsvWindowSum)) {
    return { available: false };
  }

  if (state.rsvWindow.length < state.signalPeriod) {
    return { available: false };
  }

  const kValue = state.rsvWindowSum / state.signalPeriod;
  if (!Number.isFinite(kValue)) {
    return { available: false };
  }

  state.lastK = kValue;
  state.kWindowSum = pushAndSumRollingWindow(
    state.kWindow,
    kValue,
    state.signalPeriod,
    state.kWindowSum,
  );

  if (!Number.isFinite(state.kWindowSum)) {
    return { available: false };
  }

  if (state.kWindow.length < state.signalPeriod) {
    return { available: false };
  }

  const dValue = state.kWindowSum / state.signalPeriod;
  if (!Number.isFinite(dValue)) {
    return { available: false };
  }

  const jValue = 3 * kValue - 2 * dValue;
  if (!Number.isFinite(jValue)) {
    return { available: false };
  }

  state.lastD = dValue;
  state.hasKdjValue = true;
  return { available: true };
}

/**
 * 读取 KDJ 当前可用值。
 *
 * @param state KDJ 状态
 * @returns KDJ 值，不可用返回 null
 */
export function readKdjValue(state: KdjStreamState): KDJIndicator | null {
  if (!state.hasKdjValue) {
    return null;
  }

  const jValue = 3 * state.lastK - 2 * state.lastD;
  if (!Number.isFinite(state.lastK) || !Number.isFinite(state.lastD) || !Number.isFinite(jValue)) {
    return null;
  }

  return {
    k: roundToFixed3(state.lastK),
    d: roundToFixed3(state.lastD),
    j: roundToFixed3(jValue),
  };
}
