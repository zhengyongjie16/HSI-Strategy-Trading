/**
 * factor runtime session VWAP 模块
 *
 * 职责：
 * - 计算 session-aware VWAP 与斜率
 * - 为 candle 路径提供统一的 VWAP 结果结构
 */
import type { VwapSnapshot } from '../../../types/factor.js';
import type { NormalizedBar } from './types.js';
import { computeCumulativeVwapSeries, computeSlope } from './math.js';
import { filterBarsBySession } from './session.js';

/**
 * 计算 session-aware VWAP 快照。
 *
 * @param params 全量 bars、当前 session bars、最新价格与斜率窗口
 * @returns VWAP 快照
 */
export function computeVwapSnapshot(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly activeSessionBars: ReadonlyArray<NormalizedBar>;
  readonly latestPrice: number;
  readonly slopeWindowBars: number;
}): VwapSnapshot {
  const amBars = filterBarsBySession(params.bars, 'am');
  const pmBars = filterBarsBySession(params.bars, 'pm');
  const slopeWindowBars = Math.max(1, Math.floor(params.slopeWindowBars));
  const activeSessionVwapSeries = computeCumulativeVwapSeries(params.activeSessionBars);
  const activeSessionVwap = activeSessionVwapSeries.at(-1) ?? null;
  const activeSessionVwapSlope = computeSlope(activeSessionVwapSeries.slice(-slopeWindowBars));
  const last10Bars = params.activeSessionBars.slice(-10);
  const last10VwapSeries = activeSessionVwapSeries.slice(-10);
  let crossCountLast10m = 0;
  if (last10Bars.length === last10VwapSeries.length) {
    let previousSide: 'above' | 'below' | 'equal' | null = null;
    for (const [index, bar] of last10Bars.entries()) {
      const sessionVwap = last10VwapSeries[index];
      if (sessionVwap === undefined) {
        continue;
      }

      let side: 'above' | 'below' | 'equal' = 'equal';
      if (bar.close > sessionVwap) {
        side = 'above';
      } else if (bar.close < sessionVwap) {
        side = 'below';
      }

      if (
        previousSide !== null &&
        side !== previousSide &&
        side !== 'equal' &&
        previousSide !== 'equal'
      ) {
        crossCountLast10m += 1;
      }

      previousSide = side;
    }
  }

  return {
    amVwap:
      params.activeSessionBars.length === 0
        ? null
        : (computeCumulativeVwapSeries(amBars).at(-1) ?? null),
    pmVwap:
      params.activeSessionBars.length === 0
        ? null
        : (computeCumulativeVwapSeries(pmBars).at(-1) ?? null),
    dayVwap:
      params.bars.length === 0 ? null : (computeCumulativeVwapSeries(params.bars).at(-1) ?? null),
    activeSessionVwap,
    activeSessionVwapSlope,
    crossCountLast10m,
    distanceFromActiveVwap:
      activeSessionVwap === null ? null : params.latestPrice - activeSessionVwap,
  };
}
