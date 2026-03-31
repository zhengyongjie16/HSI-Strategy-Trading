/**
 * factor runtime 确认层模块
 *
 * 职责：
 * - 结合 EMA、MACD、VWAP 对趋势方向做确认或否决
 * - 为 candle 路径提供统一确认结构
 */
import type {
  ConfirmationSnapshot,
  StrategyThresholdConfig,
  VwapSnapshot,
} from '../../../types/factor.js';
import { computeEmaSeries, computeMacd } from './utils';

/**
 * 计算趋势确认层。
 *
 * @param params 收盘价序列、最新价格、VWAP 与 ATR 参考
 * @returns 确认层快照
 */
export function computeConfirmation(params: {
  readonly closes: ReadonlyArray<number>;
  readonly latestPrice: number;
  readonly vwap: VwapSnapshot;
  readonly atr15: number | null;
  readonly strategyConfig: StrategyThresholdConfig;
}): ConfirmationSnapshot {
  const ema12 = computeEmaSeries(params.closes, 12);
  const ema26 = computeEmaSeries(params.closes, 26);
  const macd = computeMacd(params.closes);
  const band =
    params.atr15 === null
      ? 0
      : params.strategyConfig.vwapConfirmRules.distanceBandAtr * params.atr15;
  const activeVwap = params.vwap.activeSessionVwap;
  const vwapAlignedLong =
    activeVwap !== null &&
    params.latestPrice >= activeVwap + band &&
    (params.vwap.activeSessionVwapSlope ?? 0) > 0 &&
    params.vwap.crossCountLast10m <= params.strategyConfig.vwapConfirmRules.maxCrossCountLast10m;
  const vwapAlignedShort =
    activeVwap !== null &&
    params.latestPrice <= activeVwap - band &&
    (params.vwap.activeSessionVwapSlope ?? 0) < 0 &&
    params.vwap.crossCountLast10m <= params.strategyConfig.vwapConfirmRules.maxCrossCountLast10m;

  return {
    longAllowed:
      vwapAlignedLong &&
      ema12 !== null &&
      ema26 !== null &&
      macd.macd !== null &&
      ema12 > ema26 &&
      macd.macd >= 0,
    shortAllowed:
      vwapAlignedShort &&
      ema12 !== null &&
      ema26 !== null &&
      macd.macd !== null &&
      ema12 < ema26 &&
      macd.macd <= 0,
    emaAlignedLong: ema12 !== null && ema26 !== null && ema12 > ema26,
    emaAlignedShort: ema12 !== null && ema26 !== null && ema12 < ema26,
    macdAlignedLong: (macd.macd ?? -1) >= 0,
    macdAlignedShort: (macd.macd ?? 1) <= 0,
    vwapAlignedLong,
    vwapAlignedShort,
  };
}
