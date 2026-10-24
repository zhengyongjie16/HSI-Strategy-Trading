/**
 * 中性策略输出适配器：保存 origin 授权，先检查契约，再检查当前事实，最后白名单入队。
 * emitter 可被策略 pending 保存；不维护宿主 pending 表，不重新检查 SELL 买单记录。
 */
import { DIAGNOSTIC_OPERATIONS } from '../../constants/diagnostics.js';
import { ordinarySignalGuard } from '../../domain/strategy/ordinarySignalGuard.js';
import { isValidTimeMs, validateDecision } from './utils.js';
import type { StrategyDecision, StrategyEmitter } from '../../types/strategy.js';
import type { BusinessEventProgramDeps, StrategyOrigin, StrategyOriginRoute } from './types.js';

/** 创建单次新评估 origin 的逐动作输出边界；内部错误在当前调用栈先 fatal 再上抛。 */
export function createStrategyEmitter(
  deps: BusinessEventProgramDeps,
  origin: StrategyOrigin | null,
): StrategyEmitter {
  const emittedActions = new Set<StrategyDecision['action']>();

  /** 只记录当前事实拒绝；字段读取和 observer 失败均不得影响 action 消费或 fatal 边界。 */
  function recordRejection(
    decision: StrategyDecision,
    route: StrategyOriginRoute,
    reasonCode: 'ORIGIN_DAY_CHANGED' | 'ORDINARY_GATE_CLOSED' | 'SEAT_IDENTITY_CHANGED',
    currentDayKey?: string | null,
  ): void {
    try {
      deps.diagnostics.record(DIAGNOSTIC_OPERATIONS.SIGNAL_ADMISSION_RESULT, {
        stage: 'STRATEGY_EMITTER',
        outcome: 'REJECTED',
        reasonCode,
        symbol: route.symbol,
        action: decision.action,
        seatVersion: route.seatVersion,
        triggerTimeMs: decision.triggerTimeMs,
        ...(currentDayKey === undefined || origin === null
          ? {}
          : { originDayKey: origin.dayKey, currentDayKey }),
      });
    } catch {
      // 被动诊断不能改变策略输出授权、检查次数或错误路由。
    }
  }

  return (input): void => {
    if (deps.termination.isTerminated()) {
      return;
    }

    try {
      const decision = validateDecision(input);
      const { action } = decision;
      const direction = action === 'BUYCALL' || action === 'SELLCALL' ? 'LONG' : 'SHORT';
      const route = origin?.routes.find((candidate) => candidate.direction === direction);
      const isSell = action === 'SELLCALL' || action === 'SELLPUT';
      if (origin === null || route === undefined || (isSell && !route.hasFilledBuyOrders)) {
        throw new Error('策略 decision 缺少获准的 origin action/ACTIVE route');
      }

      if (emittedActions.has(action)) {
        throw new Error('策略同一 origin 重复输出 action');
      }

      emittedActions.add(action);
      const now = deps.clock.now();
      if (!isValidTimeMs(now.getTime())) {
        throw new Error('策略 emitter 门禁时间非法');
      }

      const currentDayKey = deps.lifecycleState.currentDayKey;
      if (currentDayKey !== origin.dayKey) {
        recordRejection(decision, route, 'ORIGIN_DAY_CHANGED', currentDayKey);
        return;
      }

      if (
        !ordinarySignalGuard({
          tradingTimeState: deps.tradingTimeState,
          lifecycleState: deps.lifecycleState,
          now,
          doomsdayProtectionEnabled: deps.tradingConfig.global.doomsdayProtection,
        })
      ) {
        recordRejection(decision, route, 'ORDINARY_GATE_CLOSED');
        return;
      }

      const registry = deps.monitorContext.symbolRegistry;
      const seat = registry.getSeatState(direction);
      if (
        seat.status !== 'ACTIVE' ||
        seat.symbol !== route.symbol ||
        registry.getSeatVersion(direction) !== route.seatVersion
      ) {
        recordRejection(decision, route, 'SEAT_IDENTITY_CHANGED');
        return;
      }

      const fields = {
        symbol: route.symbol,
        symbolName:
          direction === 'LONG'
            ? deps.monitorContext.longSymbolName
            : deps.monitorContext.shortSymbolName,
        seatVersion: route.seatVersion,
        triggerTime: new Date(decision.triggerTimeMs),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      };
      const admitted =
        action === 'BUYCALL' || action === 'BUYPUT'
          ? deps.buyTaskQueue.push({ type: 'STRATEGY_BUY', data: { ...fields, action } })
          : deps.sellTaskQueue.push({ type: 'STRATEGY_SELL', data: { ...fields, action } });
      if (!admitted && !deps.termination.isTerminated()) {
        throw new Error('策略输出与 queue admission 状态矛盾');
      }
    } catch (error) {
      deps.termination.reportFatalError(error);
      throw error;
    }
  };
}
