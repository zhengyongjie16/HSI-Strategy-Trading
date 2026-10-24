/**
 * timeWakeupEvaluationProgram 模块
 *
 * 核心职责：执行权威时间评估、发布门禁变化并触发生命周期/末日用例，汇总下一次系统级时间计划。
 * 末日撤买→清仓、执行状态、成功副作用与失败重评估策略仅由 DoomsdayClearanceWorkflow 持有。
 */
import { TIME, TRADING } from '../../constants/common.js';
import {
  isWithinDoomsdayClearanceTakeoverWindow,
  resolveDoomsdayWindowEntryMs,
} from '../../domain/liquidation/doomsday/index.js';
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import { getHKDateKey, resolveHKDayStartUtcMs } from '../../utils/time/index.js';
import {
  isInContinuousHKSession,
  isWithinAfternoonOpenProtection,
  isWithinMorningOpenWindow,
} from '../../domain/tradingSession/index.js';
import { ordinarySignalGuard } from '../../domain/strategy/ordinarySignalGuard.js';
import { planNextTimeWakeup } from '../timeWakeupPlanner/index.js';
import type { TimeWakeupCandidate } from '../timeWakeupPlanner/types.js';
import type { TimeWakeupEvaluationContext, TimeWakeupEvaluationResult } from './types.js';

const takeoverStateByTradingTimeState = new WeakMap<
  TimeWakeupEvaluationContext['tradingTimeState'],
  boolean
>();
const autoSearchAuthorizationByTradingTimeState = new WeakMap<
  TimeWakeupEvaluationContext['tradingTimeState'],
  boolean
>();

/**
 * 发布自动寻标授权变化。
 *
 * 自动寻标授权由生命周期交易开关、连续交易门禁与末日清仓接管共同决定；开盘保护只阻断普通信号，
 * 不在此授权中。该函数只在时间控制平面这一权威边界计算并发布，消费方不重复复制判断。
 *
 * @param context 已完成时间与生命周期评估的必要上下文
 * @param currentTime 本次权威评估时间
 * @returns 无返回值；授权变化时同步发布事件
 */
function publishAutoSearchAuthorizationChange(
  context: Pick<
    TimeWakeupEvaluationContext,
    'tradingTimeState' | 'lifecycleState' | 'tradingConfig' | 'tradingGateEventRuntime'
  >,
  currentTime: Date,
): void {
  const previousAuthorized =
    autoSearchAuthorizationByTradingTimeState.get(context.tradingTimeState) ?? null;
  const nextAuthorized = ordinarySignalGuard({
    tradingTimeState: context.tradingTimeState,
    lifecycleState: context.lifecycleState,
    now: currentTime,
    doomsdayProtectionEnabled: context.tradingConfig.global.doomsdayProtection,
  });
  if (previousAuthorized === nextAuthorized) {
    return;
  }

  autoSearchAuthorizationByTradingTimeState.set(context.tradingTimeState, nextAuthorized);
  context.tradingGateEventRuntime.emitAutoSearchAuthorizationChanged({
    previousAuthorized,
    nextAuthorized,
  });
}

function createEvaluationResult(
  currentTime: Date,
  candidates: ReadonlyArray<TimeWakeupCandidate>,
): TimeWakeupEvaluationResult {
  return {
    plan: planNextTimeWakeup({
      nowMs: currentTime.getTime(),
      candidates,
    }),
  };
}

function appendFutureCandidate(
  candidates: Array<TimeWakeupCandidate>,
  atMs: number | null,
  nowMs: number,
): void {
  if (atMs === null || atMs <= nowMs) {
    return;
  }

  candidates.push({ atMs });
}

/**
 * 将外部 API 请求失败转换为下一次系统级时间重评估候选。
 *
 * @param candidates 候选集合
 * @param currentMs 当前时间戳
 * @returns 无返回值；候选仅在当前评估函数的局部 builder 中追加
 */
function appendApiRetryCandidate(candidates: Array<TimeWakeupCandidate>, currentMs: number): void {
  appendFutureCandidate(candidates, currentMs + TRADING.INTERVAL_MS, currentMs);
}

function resolveDayBoundaryMs(date: Date, minuteOfDay: number): number | null {
  const dayStartMs = resolveHKDayStartUtcMs(getHKDateKey(date));
  if (dayStartMs === null) {
    return null;
  }

  return dayStartMs + minuteOfDay * TIME.MILLISECONDS_PER_MINUTE;
}

function resolveNextHKDayBoundaryMs(date: Date): number | null {
  const dayStartMs = resolveHKDayStartUtcMs(getHKDateKey(date));
  if (dayStartMs === null) {
    return null;
  }

  return dayStartMs + TIME.MILLISECONDS_PER_DAY;
}

function resolveTradingGateEdgeMs(date: Date, isHalfDay: boolean): number | null {
  const nowMs = date.getTime();
  const morningOpenMs = resolveDayBoundaryMs(date, 9 * 60 + 30);
  const morningCloseMs = resolveDayBoundaryMs(date, 12 * 60);
  const afternoonOpenMs = resolveDayBoundaryMs(date, 13 * 60);
  const closeMs = resolveDayBoundaryMs(date, isHalfDay ? 12 * 60 : 16 * 60);
  if (
    morningOpenMs === null ||
    morningCloseMs === null ||
    afternoonOpenMs === null ||
    closeMs === null
  ) {
    return null;
  }

  if (nowMs < morningOpenMs) {
    return morningOpenMs;
  }

  if (nowMs < morningCloseMs) {
    return morningCloseMs;
  }

  if (!isHalfDay && nowMs < afternoonOpenMs) {
    return afternoonOpenMs;
  }

  if (!isHalfDay && nowMs < closeMs) {
    return closeMs;
  }

  return null;
}

function resolveMarketCloseMs(date: Date, isHalfDay: boolean): number | null {
  const closeMs = resolveDayBoundaryMs(date, isHalfDay ? 12 * 60 : 16 * 60);
  if (closeMs === null || closeMs <= date.getTime()) {
    return null;
  }

  return closeMs;
}

function resolveOpenProtectionEdgeMs(
  date: Date,
  isHalfDay: boolean,
  openProtection: TimeWakeupEvaluationContext['tradingConfig']['global']['openProtection'],
): number | null {
  const candidates: number[] = [];
  if (openProtection.morning.enabled && openProtection.morning.minutes !== null) {
    const morningEndMs = resolveDayBoundaryMs(date, 9 * 60 + 30 + openProtection.morning.minutes);
    if (morningEndMs !== null && date.getTime() < morningEndMs) {
      candidates.push(morningEndMs);
    }
  }

  if (!isHalfDay && openProtection.afternoon.enabled && openProtection.afternoon.minutes !== null) {
    const afternoonEndMs = resolveDayBoundaryMs(date, 13 * 60 + openProtection.afternoon.minutes);
    if (afternoonEndMs !== null && date.getTime() < afternoonEndMs) {
      candidates.push(afternoonEndMs);
    }
  }

  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * 执行单次权威时间唤醒评估。
 *
 * @param context 时间唤醒评估上下文，包含所有必要依赖
 * @returns 下一次系统级时间唤醒计划
 */
export async function timeWakeupEvaluationProgram({
  logger,
  marketDataClient,
  cacheManager,
  orderMonitor,
  orderExecutor,
  tradingTimeState,
  lifecycleState,
  tradingCalendarState,
  snapshot,
  doomsdayClearanceWorkflow,
  tradingConfig,
  monitorContext,
  tradingGateEventRuntime,
  dayLifecycleManager,
  now,
}: TimeWakeupEvaluationContext): Promise<TimeWakeupEvaluationResult> {
  const currentTime = now();
  const currentMs = currentTime.getTime();
  // 首个 await 前固定 origin epoch，不能让日切后的新 view 洗白旧时间评估。
  const dayEpoch = snapshot.getView().token.dayEpoch;
  const previousCanTrade = tradingTimeState.canTrade;
  const previousTakeoverActive = takeoverStateByTradingTimeState.get(tradingTimeState) ?? false;
  const candidates: Array<TimeWakeupCandidate> = [];
  appendFutureCandidate(candidates, resolveNextHKDayBoundaryMs(currentTime), currentMs);

  const currentDayKey = getHKDateKey(currentTime);
  const cachedTradingDayInfo =
    tradingCalendarState.cachedTradingDayInfo?.dateKey === currentDayKey
      ? tradingCalendarState.cachedTradingDayInfo.info
      : null;
  let isTradingDayToday: boolean | null = cachedTradingDayInfo?.isTradingDay ?? true;
  let isHalfDayToday = cachedTradingDayInfo?.isHalfDay ?? false;
  if (!cachedTradingDayInfo) {
    let tradingDayInfo: Awaited<
      ReturnType<TimeWakeupEvaluationContext['marketDataClient']['isTradingDay']>
    >;
    try {
      tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
    } catch (error) {
      if (!isExternalApiRequestError(error)) {
        throw error;
      }

      logger.warn(
        '[TimeWakeupEvaluation] 交易日 API 请求失败，等待下一次系统级重评估',
        error.message,
      );
      appendApiRetryCandidate(candidates, currentMs);
      return createEvaluationResult(currentTime, candidates);
    }

    isTradingDayToday = tradingDayInfo.isTradingDay;
    isHalfDayToday = tradingDayInfo.isHalfDay;
    tradingCalendarState.cachedTradingDayInfo = {
      dateKey: currentDayKey,
      info: tradingDayInfo,
    };

    if (tradingDayInfo.isTradingDay) {
      logger.info(`今天是${isHalfDayToday ? '半日交易日' : '交易日'}`);
    } else {
      logger.info('今天不是交易日');
    }
  }

  if (isTradingDayToday) {
    appendFutureCandidate(
      candidates,
      resolveTradingGateEdgeMs(currentTime, isHalfDayToday),
      currentMs,
    );

    appendFutureCandidate(candidates, resolveMarketCloseMs(currentTime, isHalfDayToday), currentMs);

    appendFutureCandidate(
      candidates,
      resolveOpenProtectionEdgeMs(currentTime, isHalfDayToday, tradingConfig.global.openProtection),
      currentMs,
    );

    if (tradingConfig.global.doomsdayProtection) {
      for (const windowEntryMs of resolveDoomsdayWindowEntryMs(currentTime, isHalfDayToday)) {
        appendFutureCandidate(candidates, windowEntryMs, currentMs);
      }
    }
  }

  const canTradeNow = isTradingDayToday && isInContinuousHKSession(currentTime, isHalfDayToday);
  let lifecycleResult: Awaited<
    ReturnType<TimeWakeupEvaluationContext['dayLifecycleManager']['tick']>
  >;
  try {
    lifecycleResult = await dayLifecycleManager.tick(currentTime, {
      dayKey: currentDayKey,
      canTradeNow,
      isTradingDay: isTradingDayToday,
    });
  } catch (error) {
    if (!isExternalApiRequestError(error)) {
      throw error;
    }

    logger.warn(
      '[TimeWakeupEvaluation] 生命周期 API 请求失败，等待下一次系统级重评估',
      error.message,
    );
    appendApiRetryCandidate(candidates, currentMs);
    return createEvaluationResult(currentTime, candidates);
  }

  appendFutureCandidate(candidates, lifecycleResult.nextRetryAtMs, currentMs);

  if (tradingTimeState.canTrade !== false && !isTradingDayToday) {
    logger.info('今天不是交易日，暂停实时监控。');
  }

  if (tradingTimeState.canTrade !== canTradeNow) {
    if (canTradeNow) {
      logger.info(`进入连续交易时段${isHalfDayToday ? '（半日交易）' : ''}，开始正常交易。`);
    } else if (isTradingDayToday) {
      logger.info('当前为竞价或非连续交易时段，连续交易门禁关闭。');
      monitorContext.strategy.invalidateAll();
      logger.info('[交易时段结束] 已清理普通待验证意图');
    }
  }

  tradingTimeState.canTrade = canTradeNow;
  tradingTimeState.isHalfDay = isHalfDayToday;
  if (canTradeNow) {
    const { morning, afternoon } = tradingConfig.global.openProtection;
    const morningActive =
      morning.enabled &&
      morning.minutes !== null &&
      isWithinMorningOpenWindow(currentTime, morning.minutes);
    const afternoonActive =
      !isHalfDayToday &&
      afternoon.enabled &&
      afternoon.minutes !== null &&
      isWithinAfternoonOpenProtection(currentTime, afternoon.minutes);
    const openProtectionActive = morningActive || afternoonActive;
    const anyProtectionEnabled =
      (morning.enabled && morning.minutes !== null) ||
      (!isHalfDayToday && afternoon.enabled && afternoon.minutes !== null);
    if (anyProtectionEnabled && tradingTimeState.openProtectionActive !== openProtectionActive) {
      if (openProtectionActive) {
        logger.info(
          morningActive
            ? `[开盘保护] 早盘开盘后 ${String(morning.minutes)} 分钟内暂停信号生成`
            : `[开盘保护] 午盘开盘后 ${String(afternoon.minutes)} 分钟内暂停信号生成`,
        );
      } else if (tradingTimeState.openProtectionActive !== null) {
        logger.info('[开盘保护] 保护期结束，恢复信号生成');
      }
    }

    tradingTimeState.openProtectionActive = openProtectionActive;
  } else {
    tradingTimeState.openProtectionActive = false;
  }

  const nextCanTrade = tradingTimeState.canTrade;
  if (previousCanTrade !== nextCanTrade) {
    tradingGateEventRuntime.emitGateStateChanged({
      previousCanTrade,
      nextCanTrade,
    });
  }

  const doomsdayTakeoverActive =
    tradingConfig.global.doomsdayProtection &&
    isWithinDoomsdayClearanceTakeoverWindow(currentTime, isHalfDayToday);
  if (!previousTakeoverActive && doomsdayTakeoverActive) {
    monitorContext.strategy.invalidateAll();
    logger.info('[清仓接管] 已清理普通待验证意图');
  }

  takeoverStateByTradingTimeState.set(tradingTimeState, doomsdayTakeoverActive);
  publishAutoSearchAuthorizationChange(
    {
      tradingTimeState,
      lifecycleState,
      tradingConfig,
      tradingGateEventRuntime,
    },
    currentTime,
  );

  if (!lifecycleState.isTradingEnabled) {
    return createEvaluationResult(currentTime, candidates);
  }

  if (!isTradingDayToday) {
    return createEvaluationResult(currentTime, candidates);
  }

  if (canTradeNow && tradingConfig.global.doomsdayProtection) {
    const result = await doomsdayClearanceWorkflow.evaluate({
      currentTime,
      isHalfDay: isHalfDayToday,
      dayEpoch,
      monitorContext,
      cacheManager,
      orderMonitor,
      orderExecutor,
      marketDataClient,
      lifecycleState,
      snapshot,
    });
    appendFutureCandidate(candidates, result.nextRetryAtMs, currentMs);
  }

  return createEvaluationResult(currentTime, candidates);
}
