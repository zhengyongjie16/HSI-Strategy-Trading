/**
 * factor runtime 开盘结构模块
 *
 * 职责：
 * - 计算 opening range、突破持续性与回踩保持
 * - 识别午后继续推进所需的基础结构条件
 */
import type {
  OpeningStructureRules,
  OpeningStructureSnapshot,
  PmContinuationRules,
  PmContinuationSnapshot,
} from '../../../types/factor.js';
import type { NormalizedBar } from './types.js';
import { sliceBarsFromEnd, computeReturns, computeRealizedVolatility } from './math.js';
import {
  AFTERNOON_SESSION_END,
  AFTERNOON_SESSION_START,
  getHongKongParts,
  MORNING_SESSION_END,
  MORNING_SESSION_START,
} from './session.js';

/**
 * 计算开盘结构。
 *
 * @param params bars、最新价格、ATR 参考与规则
 * @returns 开盘结构快照
 */
export function computeOpeningStructure(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly latestPrice: number;
  readonly atrReference: number | null;
  readonly rules: OpeningStructureRules;
}): OpeningStructureSnapshot {
  const openingBars = params.bars.filter((bar) => {
    const { minuteOfDay } = getHongKongParts(bar.timestamp);
    return (
      minuteOfDay >= MORNING_SESSION_START &&
      minuteOfDay < MORNING_SESSION_START + params.rules.openingRangeMinutes
    );
  });
  const afterOpeningBars = params.bars.filter((bar) => {
    const { minuteOfDay } = getHongKongParts(bar.timestamp);
    return minuteOfDay >= MORNING_SESSION_START + params.rules.openingRangeMinutes;
  });
  const highs = openingBars.map((bar) => bar.high);
  const lows = openingBars.map((bar) => bar.low);
  const orHigh = highs.length > 0 ? Math.max(...highs) : null;
  const orLow = lows.length > 0 ? Math.min(...lows) : null;
  const persistenceWindowBars = Math.max(1, Math.floor(params.rules.outsidePersistenceWindowBars));
  const persistenceWindow = sliceBarsFromEnd(afterOpeningBars, persistenceWindowBars);
  const hasFullPersistenceWindow = persistenceWindow.length >= persistenceWindowBars;
  const outsidePersistenceUp =
    !hasFullPersistenceWindow || orHigh === null
      ? null
      : persistenceWindow.filter((bar) => bar.close > orHigh).length / persistenceWindow.length;
  const outsidePersistenceDown =
    !hasFullPersistenceWindow || orLow === null
      ? null
      : persistenceWindow.filter((bar) => bar.close < orLow).length / persistenceWindow.length;
  const confirmBars = Math.max(1, Math.floor(params.rules.confirmBars));
  const recentConfirmationWindow = sliceBarsFromEnd(persistenceWindow, confirmBars);
  const hasConfirmedBreakoutUp =
    hasFullPersistenceWindow &&
    orHigh !== null &&
    recentConfirmationWindow.length >= confirmBars &&
    recentConfirmationWindow.every((bar) => bar.close > orHigh);
  const hasConfirmedBreakoutDown =
    hasFullPersistenceWindow &&
    orLow !== null &&
    recentConfirmationWindow.length >= confirmBars &&
    recentConfirmationWindow.every((bar) => bar.close < orLow);
  const breakoutDistanceUp =
    orHigh === null || params.atrReference === null || params.atrReference <= 0
      ? null
      : (params.latestPrice - orHigh) / params.atrReference;
  const breakoutDistanceDown =
    orLow === null || params.atrReference === null || params.atrReference <= 0
      ? null
      : (orLow - params.latestPrice) / params.atrReference;
  const breakoutUp =
    orHigh !== null &&
    breakoutDistanceUp !== null &&
    breakoutDistanceUp >= params.rules.breakoutScoreMin &&
    (outsidePersistenceUp ?? 0) >= params.rules.outsidePersistenceMin &&
    params.latestPrice > orHigh &&
    hasConfirmedBreakoutUp;
  const breakoutDown =
    orLow !== null &&
    breakoutDistanceDown !== null &&
    breakoutDistanceDown >= params.rules.breakoutScoreMin &&
    (outsidePersistenceDown ?? 0) >= params.rules.outsidePersistenceMin &&
    params.latestPrice < orLow &&
    hasConfirmedBreakoutDown;
  const tolerance =
    params.atrReference === null ? 0 : params.rules.retestToleranceAtr * params.atrReference;
  const retestHoldUp =
    orHigh !== null &&
    !breakoutUp &&
    (outsidePersistenceUp ?? 0) >= params.rules.outsidePersistenceMin &&
    params.latestPrice >= orHigh &&
    params.latestPrice <= orHigh + tolerance;
  const retestHoldDown =
    orLow !== null &&
    !breakoutDown &&
    (outsidePersistenceDown ?? 0) >= params.rules.outsidePersistenceMin &&
    params.latestPrice <= orLow &&
    params.latestPrice >= orLow - tolerance;
  const failureLookback = sliceBarsFromEnd(afterOpeningBars, persistenceWindowBars);
  let returnedInsideCount = 0;
  let returnedFromUpCount = 0;
  let returnedFromDownCount = 0;
  if (orHigh !== null && orLow !== null) {
    for (const bar of failureLookback) {
      if (bar.close > orHigh) {
        returnedFromUpCount += 1;
      }

      if (bar.close < orLow) {
        returnedFromDownCount += 1;
      }

      if (bar.close <= orHigh && bar.close >= orLow) {
        returnedInsideCount += 1;
      }
    }
  }

  return {
    orHigh,
    orLow,
    breakoutUp,
    breakoutDown,
    outsidePersistenceUp,
    outsidePersistenceDown,
    retestHoldUp,
    retestHoldDown,
    failedBreakout:
      returnedInsideCount >= confirmBars &&
      ((returnedFromUpCount > 0 && !breakoutUp && !retestHoldUp) ||
        (returnedFromDownCount > 0 && !breakoutDown && !retestHoldDown)),
  };
}

/**
 * 计算午后延续结构。
 *
 * @param params bars/latestPrice/trendScore/er15/vwap/rules
 * @returns 午后延续快照
 */
export function computePmContinuation(params: {
  readonly bars: ReadonlyArray<NormalizedBar>;
  readonly latestPrice: number;
  readonly trendScore: number | null;
  readonly er15: number | null;
  readonly vwap: {
    readonly activeSessionVwap: number | null;
  };
  readonly rules: PmContinuationRules;
}): PmContinuationSnapshot {
  const amBars = params.bars.filter((bar) => {
    const { minuteOfDay } = getHongKongParts(bar.timestamp);
    return minuteOfDay >= MORNING_SESSION_START + 20 && minuteOfDay <= MORNING_SESSION_END;
  });
  if (amBars.length === 0) {
    return {
      amQualified: false,
      middayHold: false,
      pmConfirmed: false,
    };
  }

  const firstAmBar = amBars[0];
  const lastAmBar = amBars.at(-1);
  const amReturns = computeReturns(amBars);
  const amRv = computeRealizedVolatility(amReturns);
  const amMove =
    firstAmBar && lastAmBar && firstAmBar.close > 0 && lastAmBar.close > 0
      ? Math.log(lastAmBar.close / firstAmBar.close)
      : null;
  const amQualified =
    amMove !== null &&
    amRv !== null &&
    amRv > 0 &&
    Math.abs(amMove) / (amRv + Number.EPSILON) >= params.rules.amMoveZMin;
  const pmBars = params.bars.filter((bar) => {
    const { minuteOfDay } = getHongKongParts(bar.timestamp);
    return minuteOfDay >= AFTERNOON_SESSION_START && minuteOfDay <= AFTERNOON_SESSION_END;
  });
  const latestBar = params.bars.at(-1) ?? null;
  const latestMinuteOfDay =
    latestBar === null ? null : getHongKongParts(latestBar.timestamp).minuteOfDay;
  const reachedPmCutoff =
    latestMinuteOfDay !== null && latestMinuteOfDay >= params.rules.pmConfirmCutoffMinutes;
  const holdBar =
    pmBars.find((bar) => {
      const { minuteOfDay } = getHongKongParts(bar.timestamp);
      return minuteOfDay >= AFTERNOON_SESSION_START + 15;
    }) ?? null;
  const amMoveDenominator =
    firstAmBar === undefined || lastAmBar === undefined ? 0 : lastAmBar.close - firstAmBar.close;
  const firstAmClose = firstAmBar?.close ?? null;
  const holdBarClose = holdBar?.close ?? null;
  const middayHold =
    amQualified &&
    holdBarClose !== null &&
    firstAmClose !== null &&
    amMove !== 0 &&
    amMoveDenominator !== 0 &&
    (holdBarClose - firstAmClose) / amMoveDenominator >= params.rules.middayHoldMin;
  const pmConfirmed =
    middayHold &&
    reachedPmCutoff &&
    params.trendScore !== null &&
    params.er15 !== null &&
    params.trendScore * amMove > 0 &&
    Math.abs(params.trendScore) >= params.rules.pmReExpansionTrendScoreMin &&
    params.er15 >= params.rules.pmReExpansionEr15Min &&
    params.vwap.activeSessionVwap !== null &&
    ((params.trendScore > 0 && params.latestPrice > params.vwap.activeSessionVwap) ||
      (params.trendScore < 0 && params.latestPrice < params.vwap.activeSessionVwap));

  return {
    amQualified,
    middayHold,
    pmConfirmed,
  };
}
