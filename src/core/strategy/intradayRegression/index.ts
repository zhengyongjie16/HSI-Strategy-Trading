/** 日内回归策略唯一实例：私有指标、采样、候选、验证与生命周期均在本闭包内。 */
import type {
  StrategyDecision,
  StrategyDeps,
  StrategyEmitter,
  StrategyMarketContext,
  TradingSignalStrategy,
} from '../types.js';
import type { IndicatorSnapshot, StrategyConfig } from './types.js';
import type { IndicatorRuntimeState } from './runtime/types.js';
import type { DelayedCandidate } from './verification/types.js';
import { ACTION_RULES, RETENTION_MARGIN_MS, VERIFICATION_READY_MS } from './constants.js';
import {
  buildIndicatorDisplayString,
  evaluateSignalConfig,
  needsDelayedVerification,
  validateIndicatorsForAction,
} from './utils.js';
import { getIndicatorValue } from './indicatorHelpers/utils.js';
import {
  bootstrapIndicatorRuntime,
  buildSnapshotFromRuntime,
  updateRuntimeForCandlestickSnapshot,
} from './runtime/index.js';
import { createVerificationSampleStore } from './verification/sampleStore.js';
import { projectVerificationSampleValues } from './verification/utils.js';
import { assertValidTime, createPendingVerification } from './verification/index.js';
import { buildStrategyDisplay } from './display.js';

/** 按旧动作位置分别读取 clock；先计算整批，再由调用方提交 immediate / delayed。 */
function evaluateCandidates(
  config: StrategyConfig,
  deps: StrategyDeps,
  context: StrategyMarketContext,
  snapshot: IndicatorSnapshot,
): {
  readonly immediate: ReadonlyArray<StrategyDecision>;
  readonly delayed: ReadonlyArray<DelayedCandidate>;
} {
  const immediate: StrategyDecision[] = [];
  const delayed: DelayedCandidate[] = [];
  for (const rule of ACTION_RULES) {
    const seat = context.seats.find((fact) => fact.direction === rule.direction);
    if (seat === undefined || seat.symbol === '') continue;

    const signalConfig = config.signalConfig[rule.configKey];
    if (!validateIndicatorsForAction({ state: snapshot, signalConfig })) continue;

    if (rule.side === 'sell' && !seat.hasFilledBuyOrders) continue;

    const result = evaluateSignalConfig(snapshot, signalConfig);
    if (!result.triggered) continue;

    const verification = config.verification[rule.side];
    const now = deps.clock.now().getTime();
    assertValidTime(now);
    const display = buildIndicatorDisplayString(snapshot);
    if (!needsDelayedVerification(verification)) {
      immediate.push({
        action: rule.action,
        triggerTimeMs: now,
        reason: `${rule.reasonPrefix}（立即执行）：${result.reason}，${display}`,
      });
      continue;
    }

    const rawTarget = now + verification.delaySeconds * 1000;
    if (!Number.isFinite(rawTarget)) throw new Error('策略延迟目标时间无效');

    // D3 必须在 Date 截断前比较；原始加法未推进时不降级为立即信号。
    if (rawTarget <= now) continue;

    const target = new Date(rawTarget).getTime();
    assertValidTime(target);
    assertValidTime(target + VERIFICATION_READY_MS);
    const indicators = config.profile.verificationIndicatorsBySide[rule.side];
    const initial: Record<string, number> = {};
    let ready = indicators.length > 0;
    for (const name of indicators) {
      const value = getIndicatorValue(snapshot, name);
      if (value === null) {
        ready = false;
        break;
      }

      initial[name] = value;
    }

    if (!ready) continue;

    const initialText = Object.entries(initial)
      .map(([name, value]) => `${name}1=${value.toFixed(3)}`)
      .join(' ');
    const timeText = new Date(target).toLocaleString('zh-CN', {
      timeZone: 'Asia/Hong_Kong',
      hour12: false,
    });
    delayed.push({
      symbol: seat.symbol,
      direction: rule.direction,
      initial,
      indicators,
      decision: {
        action: rule.action,
        triggerTimeMs: target,
        reason: `${rule.reasonPrefix}：${result.reason}，${display}，${initialText}，将在 ${timeText} 进行验证`,
      },
    });
  }

  return { immediate, delayed };
}

/** 构造仅建立状态并输出配置摘要，不启动 timer 或 emitter；跨日复用同一实例。 */
export function createIntradayRegressionStrategy(
  config: StrategyConfig,
  deps: StrategyDeps,
): TradingSignalStrategy {
  let destroyed = false;
  const isDestroyed = () => destroyed;
  let runtime: IndicatorRuntimeState | null = null;
  const retention =
    Math.max(config.verification.buy.delaySeconds, config.verification.sell.delaySeconds) * 1000 +
    VERIFICATION_READY_MS +
    RETENTION_MARGIN_MS;
  const samples = createVerificationSampleStore(retention);
  const pending = createPendingVerification(samples, deps);
  const verificationIndicators = [
    ...new Set([
      ...config.profile.verificationIndicatorsBySide.buy,
      ...config.profile.verificationIndicatorsBySide.sell,
    ]),
  ];
  deps.logger.info(
    `[策略 intraday-regression] ${JSON.stringify({ signals: config.signals, verification: config.verification })}`,
  );

  /** 正常 reset 不销毁实例；finally 保证取消失败也释放样本与指标引用。 */
  function reset(): void {
    try {
      pending.invalidate();
    } finally {
      runtime = null;
      samples.clearAll();
    }
  }

  /** 每次 K 线快照（含未确认活动柱更新）先提交有效指标及样本，再显示与新评估；错误同步报告 fatal 并上抛。 */
  function onCandlestick(context: StrategyMarketContext, emit: StrategyEmitter) {
    if (destroyed) return null;

    try {
      assertValidTime(context.observedAtMs);
      if (runtime !== null && runtime.profile !== config.profile)
        throw new Error('策略指标运行态 profile 不一致');

      const next =
        runtime === null
          ? bootstrapIndicatorRuntime({
              symbol: context.candlesticks.symbol,
              cacheSnapshot: context.candlesticks,
              indicatorProfile: config.profile,
            })
          : updateRuntimeForCandlestickSnapshot({ runtime, cacheSnapshot: context.candlesticks });
      if (next === null) return null;

      const snapshot = buildSnapshotFromRuntime(next);
      if (snapshot === null) return null;

      runtime = next;
      samples.push(
        projectVerificationSampleValues(snapshot, verificationIndicators),
        context.observedAtMs,
      );
      const display = buildStrategyDisplay(snapshot, config.profile);
      if (!context.allowNewEvaluation) return display;

      const candidates = evaluateCandidates(config, deps, context, snapshot);
      for (const decision of candidates.immediate) {
        if (isDestroyed()) break;

        emit(decision);
      }

      for (const candidate of candidates.delayed) {
        if (isDestroyed()) break;

        pending.register(candidate, emit);
      }

      return display;
    } catch (error) {
      deps.onFatalError(error);
      throw error;
    }
  }

  return {
    strategyId: 'intraday-regression',
    onCandlestick,
    invalidateDirection(direction) {
      if (!destroyed) pending.invalidate(direction);
    },
    invalidateAll() {
      if (!destroyed) pending.invalidate();
    },
    resetForTradingDay() {
      if (!destroyed) reset();
    },
    destroy() {
      if (destroyed) return;

      destroyed = true;
      try {
        pending.destroy();
      } finally {
        runtime = null;
        samples.clearAll();
      }
    },
  };
}
