/**
 * 中性策略输出适配器：保存 origin 授权，先检查契约，再检查当前事实，最后白名单入队。
 * emitter 可被策略 pending 保存；不维护宿主 pending 表，不重新检查 SELL 买单记录。
 */
import { ordinarySignalGuard } from '../ordinarySignalGuard/index.js';
import { isValidTimeMs, validateDecision } from './utils.js';
import type { StrategyDecision, StrategyEmitter } from '../../core/strategy/types.js';
import type { BusinessEventProgramDeps, StrategyOrigin } from './types.js';

/** 创建单次新评估 origin 的逐动作输出边界；内部错误在当前调用栈先 fatal 再上抛。 */
export function createStrategyEmitter(
  deps: BusinessEventProgramDeps,
  origin: StrategyOrigin | null,
): StrategyEmitter {
  const emittedActions = new Set<StrategyDecision['action']>();
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

      if (
        deps.lastState.currentDayKey !== origin.dayKey ||
        !ordinarySignalGuard({
          lastState: deps.lastState,
          now,
          doomsdayProtectionEnabled: deps.tradingConfig.global.doomsdayProtection,
        })
      ) {
        return;
      }

      const registry = deps.monitorContext.symbolRegistry;
      const seat = registry.getSeatState(direction);
      if (
        seat.status !== 'ACTIVE' ||
        seat.symbol !== route.symbol ||
        registry.getSeatVersion(direction) !== route.seatVersion
      ) {
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
