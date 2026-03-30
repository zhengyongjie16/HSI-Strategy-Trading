/**
 * 交易配置运行时投影模块。
 *
 * 负责把单实例 TradingConfig 投影为运行时消费的 StrategyRuntimeConfig，
 * 并在投影边界收敛趋势阈值结构。
 */
import type { StrategyRuntimeConfig, TradingConfig } from '../../types/config.js';
import type { StrategyThresholdConfig } from '../../types/factor.js';

/**
 * 将 HH:MM 配置转换为分钟数，供因子运行时消费。
 *
 * @param timeText HH:MM 文本
 * @returns 当日分钟数
 */
function convertTimeTextToMinutes(timeText: string): number {
  const [hourText = '0', minuteText = '0'] = timeText.split(':');
  const hours = Number(hourText);
  const minutes = Number(minuteText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
}

/**
 * 将策略配置收敛为因子与策略执行所需的阈值结构。
 *
 * @param config 单实例交易配置
 * @returns 运行时消费的趋势阈值配置
 */
function createStrategyThresholdConfig(config: TradingConfig): StrategyThresholdConfig {
  return {
    regimeThresholds: config.strategy.regimeThresholds,
    trendScoreThresholds: config.strategy.trendScoreThresholds,
    erThresholds: config.strategy.erThresholds,
    vwapConfirmRules: config.strategy.vwapConfirmRules,
    openingStructureRules: {
      openingRangeMinutes: config.strategy.openingStructureRules.openingRangeMinutes,
      breakoutScoreMin: config.strategy.openingStructureRules.breakoutScoreMin,
      outsidePersistenceWindowBars:
        config.strategy.openingStructureRules.outsidePersistenceWindowBars,
      outsidePersistenceMin: config.strategy.openingStructureRules.outsidePersistenceMin,
      retestToleranceAtr: config.strategy.openingStructureRules.retestToleranceAtr,
      confirmBars: config.strategy.openingStructureRules.confirmBars,
      morningNoiseWindowMinutes: config.strategy.openingStructureRules.morningNoiseWindowMinutes,
      afternoonNoiseWindowMinutes:
        config.strategy.openingStructureRules.afternoonNoiseWindowMinutes,
    },
    pmContinuationRules: {
      amMoveZMin: config.strategy.pmContinuationRules.amMoveZMin,
      middayHoldMin: config.strategy.pmContinuationRules.middayHoldMin,
      pmReExpansionTrendScoreMin: config.strategy.pmContinuationRules.pmReExpansionTrendScoreMin,
      pmReExpansionEr15Min: config.strategy.pmContinuationRules.pmReExpansionEr15Min,
      pmConfirmCutoffMinutes: convertTimeTextToMinutes(
        config.strategy.pmContinuationRules.pmConfirmCutoffTime,
      ),
    },
    instrumentAdaptationRules: {
      bullBuyMinDistancePct: config.strategy.instrumentAdaptationRules.bullBuyMinDistancePct,
      bearBuyMaxDistancePct: config.strategy.instrumentAdaptationRules.bearBuyMaxDistancePct,
      bullLiquidationDistancePct:
        config.strategy.instrumentAdaptationRules.bullLiquidationDistancePct,
      bearLiquidationDistancePct:
        config.strategy.instrumentAdaptationRules.bearLiquidationDistancePct,
      autoSearchOpenDelayMinutes: config.strategy.autoSearchConfig.autoSearchOpenDelayMinutes,
      autoSearchPrimaryDistanceBull:
        config.strategy.autoSearchConfig.autoSearchMinDistancePctBull ??
        config.strategy.instrumentAdaptationRules.bullBuyMinDistancePct,
      autoSearchPrimaryDistanceBear:
        config.strategy.autoSearchConfig.autoSearchMinDistancePctBear ??
        config.strategy.instrumentAdaptationRules.bearBuyMaxDistancePct,
      switchDistanceRangeBull: [
        config.strategy.autoSearchConfig.switchDistanceRangeBull?.min ??
          config.strategy.instrumentAdaptationRules.bullLiquidationDistancePct,
        config.strategy.autoSearchConfig.switchDistanceRangeBull?.max ??
          config.strategy.instrumentAdaptationRules.bullBuyMinDistancePct,
      ],
      switchDistanceRangeBear: [
        config.strategy.autoSearchConfig.switchDistanceRangeBear?.min ??
          config.strategy.instrumentAdaptationRules.bearBuyMaxDistancePct,
        config.strategy.autoSearchConfig.switchDistanceRangeBear?.max ??
          config.strategy.instrumentAdaptationRules.bearLiquidationDistancePct,
      ],
      autoSearchMinTurnoverPerMinuteBull:
        config.strategy.autoSearchConfig.autoSearchMinTurnoverPerMinuteBull ?? 0,
      autoSearchMinTurnoverPerMinuteBear:
        config.strategy.autoSearchConfig.autoSearchMinTurnoverPerMinuteBear ?? 0,
      autoSearchExpiryMinMonths: config.strategy.autoSearchConfig.autoSearchExpiryMinMonths,
    },
  };
}

/**
 * 将单实例 TradingConfig 收敛为运行时 StrategyRuntimeConfig。
 *
 * @param config 单实例交易配置
 * @returns 单实例运行时配置
 */
export function createStrategyRuntimeConfigFromTradingConfig(
  config: TradingConfig,
): StrategyRuntimeConfig {
  return {
    baseInstrumentSymbol: config.baseInstrument,
    longSymbol: config.strategy.longSymbol ?? '',
    shortSymbol: config.strategy.shortSymbol ?? '',
    autoSearchConfig: config.strategy.autoSearchConfig,
    orderOwnershipMapping: config.strategy.orderOwnershipMapping,
    targetNotional: config.strategy.targetNotional,
    maxPositionNotional: config.strategy.maxPositionNotional,
    maxUnrealizedLossPerSymbol: config.strategy.maxUnrealizedLoss,
    buyIntervalSeconds: config.strategy.buyIntervalSeconds,
    liquidationCooldown: config.strategy.liquidationCooldown,
    liquidationTriggerLimit: config.strategy.liquidationTriggerLimit,
    seatMode: config.strategy.seatMode,
    strategyConfig: createStrategyThresholdConfig(config),
  };
}
