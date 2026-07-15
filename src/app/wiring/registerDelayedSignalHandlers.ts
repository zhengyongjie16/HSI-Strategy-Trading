/**
 * app 延迟验证分流接线模块
 *
 * 职责：
 * - 为唯一 DelayedSignalVerifier 注册通过回调
 * - 校验生命周期门禁、席位版本与当前席位标的
 * - 将验证通过的信号分流到买入或卖出任务队列
 */
import {
  describeSignalSeatValidationFailure,
  validateSignalSeat,
} from '../../services/autoSymbolManager/utils.js';
import { ordinarySignalGuard } from '../../main/ordinarySignalGuard/index.js';
import { formatSymbolDisplay, isSellAction } from '../../utils/display/index.js';
import { isBuyAction } from '../../utils/helpers/index.js';
import type { RegisterDelayedSignalHandlersParams } from '../types.js';
import type { BuySignal, ExecutableSellSignal, Signal } from '../../types/signal.js';

function toSellSignal(signal: Signal): ExecutableSellSignal | null {
  if (!isSellAction(signal.action)) {
    return null;
  }

  const seatVersion = signal.seatVersion;
  if (typeof seatVersion !== 'number' || !Number.isFinite(seatVersion)) {
    return null;
  }

  if (signal.isProtectiveLiquidation === true) {
    return { ...signal, action: signal.action, seatVersion, isProtectiveLiquidation: true };
  }

  return { ...signal, action: signal.action, seatVersion };
}

function toBuySignal(signal: Signal): BuySignal | null {
  if (!isBuyAction(signal.action)) {
    return null;
  }

  const seatVersion = signal.seatVersion;
  if (typeof seatVersion !== 'number' || !Number.isFinite(seatVersion)) {
    return null;
  }

  if (signal.isProtectiveLiquidation === true) {
    throw new Error('[延迟验证通过] BUY 不得携带保护性清仓语义');
  }

  return { ...signal, action: signal.action, seatVersion };
}

/**
 * 注册唯一监控标的的延迟验证通过回调。
 *
 * @param params 注册回调所需的共享状态与任务队列
 * @returns 无返回值
 */
export function registerDelayedSignalHandlers(params: RegisterDelayedSignalHandlersParams): void {
  const {
    monitorContext,
    lastState,
    buyTaskQueue,
    sellTaskQueue,
    logger,
    doomsdayProtectionEnabled,
    now = () => new Date(),
  } = params;
  const monitorSymbol = monitorContext.config.monitorSymbol;

  monitorContext.delayedSignalVerifier.onVerified((signal) => {
    const signalLabel = `${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`;

    const discardSignal = (prefix: string): void => {
      logger.debug(`${prefix}: ${signalLabel}`);
    };

    if (
      !ordinarySignalGuard({
        lastState,
        now: now(),
        doomsdayProtectionEnabled,
      })
    ) {
      discardSignal('[延迟验证通过] 普通信号门禁关闭，丢弃信号');
      return;
    }

    if (!isBuyAction(signal.action) && !isSellAction(signal.action)) {
      discardSignal('[延迟验证通过] 非买卖动作信号，丢弃信号');
      return;
    }

    const seatValidation = validateSignalSeat({
      signal,
      symbolRegistry: monitorContext.symbolRegistry,
    });
    if (!seatValidation.valid) {
      discardSignal(
        `[延迟验证通过] ${describeSignalSeatValidationFailure(seatValidation)}，丢弃信号`,
      );
      return;
    }

    logger.debug(`[延迟验证通过] 信号推入任务队列: ${signalLabel}`);

    const sellSignal = toSellSignal(signal);
    if (sellSignal) {
      sellTaskQueue.push({
        type: 'VERIFIED_SELL',
        data: sellSignal,
      });
      return;
    }

    const buySignal = toBuySignal(signal);
    if (!buySignal) {
      discardSignal('[延迟验证通过] 非买入动作信号，丢弃信号');
      return;
    }

    buyTaskQueue.push({
      type: 'VERIFIED_BUY',
      data: buySignal,
    });
  });

  logger.debug(
    `[DelayedSignalVerifier] 监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} 的验证器已初始化`,
  );
}
