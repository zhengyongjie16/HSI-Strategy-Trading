/**
 * 买入节流模块
 *
 * 职责：
 * - 维护买入频率限制运行态（lastBuyTime）
 * - 提供 canTradeNow / recordBuyAttempt / resetBuyThrottle
 * - 记录“买入尝试”时点，确保频率检查通过后立即占用窗口
 */
import { TIME } from '../../../constants/index.js';
import { isBuyAction } from '../../../utils/helpers/index.js';
import type { BuySignalAction, SignalType } from '../../../types/signal.js';
import type { BuyThrottle, BuyThrottleDeps } from './types.js';

function resolveBuyDirection(signalAction: BuySignalAction): 'LONG' | 'SHORT' {
  return signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
}

/**
 * 创建买入节流器。
 *
 * @param deps 已绑定唯一 monitor 的买入间隔与运行时时钟
 * @returns 买入节流器实例
 */
export function createBuyThrottle(deps: BuyThrottleDeps): BuyThrottle {
  const { buyIntervalSeconds, clock } = deps;
  const lastBuyTime = new Map<'LONG' | 'SHORT', number>();

  /**
   * 检查买入频率限制（卖出不限制）。
   *
   * @param signalAction 信号动作
   * @returns 频率检查结果
   */
  function canTradeNow(signalAction: SignalType) {
    if (!isBuyAction(signalAction)) {
      return { canTrade: true };
    }

    const direction = resolveBuyDirection(signalAction);
    const lastTime = lastBuyTime.get(direction);
    if (lastTime === undefined) {
      return { canTrade: true };
    }

    const now = clock.now().getTime();
    const timeDiff = now - lastTime;
    const intervalMs = buyIntervalSeconds * TIME.MILLISECONDS_PER_SECOND;
    if (timeDiff >= intervalMs) {
      return { canTrade: true };
    }

    const waitSeconds = Math.ceil((intervalMs - timeDiff) / TIME.MILLISECONDS_PER_SECOND);
    return {
      canTrade: false,
      waitSeconds,
    };
  }

  /**
   * 记录买入时间（用于频率限制）。
   *
   * @param signalAction 信号动作
   * @returns 无返回值
   */
  function recordBuyAttempt(signalAction: SignalType): void {
    if (isBuyAction(signalAction)) {
      lastBuyTime.set(resolveBuyDirection(signalAction), clock.now().getTime());
    }
  }

  /**
   * 清空买入节流状态。
   *
   * @returns 无返回值
   */
  function resetBuyThrottle(): void {
    lastBuyTime.clear();
  }

  return {
    canTradeNow,
    resetBuyThrottle,
    recordBuyAttempt,
  };
}
