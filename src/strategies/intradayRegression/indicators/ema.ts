/**
 * EMA（指数移动平均线）计算模块
 *
 * 指标特点：
 * - 赋予近期数据更高权重，对价格变化更敏感
 * - 周期范围：1-250
 */
import { roundToFixed3 } from './indicatorMath.js';
import type { EmaStreamState } from './types.js';

/**
 * 克隆 EMA 流式状态。
 *
 * @param state 原始状态
 * @returns 深拷贝状态
 */
export function cloneEmaState(state: EmaStreamState): EmaStreamState {
  return {
    period: state.period,
    per: state.per,
    seedCount: state.seedCount,
    seedSum: state.seedSum,
    emaValue: state.emaValue,
  };
}

/**
 * 从 EMA 状态读取当前可用值。
 *
 * @param state EMA 状态
 * @returns 可用 EMA 值，不可用返回 null
 */
export function readEmaValue(state: EmaStreamState): number | null {
  const ema = state.emaValue;
  if (ema === null || !Number.isFinite(ema) || ema <= 0) {
    return null;
  }

  return roundToFixed3(ema);
}
