/**
 * 信号处理流水线模块
 *
 * 功能：
 * - 接收策略生成的立即交易信号
 * - 进行席位状态校验（席位就绪、标的匹配、买入行情就绪）
 * - 丰富信号数据（补全标的名称与席位版本）
 * - 按买卖方向分流到对应任务队列
 *
 * 信号分流规则：
 * - 立即买入信号 → buyTaskQueue (IMMEDIATE_BUY)
 * - 立即卖出信号 → sellTaskQueue (IMMEDIATE_SELL)
 *
 * 席位校验条件：
 * 1. 席位状态必须为 ACTIVE
 * 2. 信号标的必须与席位当前标的匹配
 * 3. 买入信号要求席位行情已就绪
 */
import { logger } from '../../utils/logger/index.js';
import { isBuyAction } from '../../utils/helpers/index.js';
import { VALID_SIGNAL_ACTIONS } from '../../constants/index.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { describeSeatUnavailable } from '../../services/autoSymbolManager/utils.js';
import { formatSignalLog, getPositions } from './utils.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { SignalPipelineParams } from './types.js';
import { formatSymbolDisplay, isSellAction } from '../../utils/display/index.js';

function resolveSeatMode(
  config: SignalPipelineParams['monitorContext']['config'],
): 'static' | 'auto' {
  return Reflect.get(config, 'seatMode') === 'auto' ? 'auto' : 'static';
}

function computeDistancePercent(params: {
  readonly monitorPrice: number;
  readonly quote: Quote;
}): number | null {
  const callPrice = params.quote.staticInfo?.callPrice ?? null;
  if (!Number.isFinite(callPrice) || callPrice === null || callPrice <= 0) {
    return null;
  }

  return ((params.monitorPrice - callPrice) / callPrice) * 100;
}

function applyInstrumentAdaptationGate(params: {
  readonly signal: Signal;
  readonly monitorSnapshot: SignalPipelineParams['monitorSnapshot'];
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly monitorContext: SignalPipelineParams['monitorContext'];
}): {
  readonly passed: boolean;
  readonly reason: string;
} {
  if (!isBuyAction(params.signal.action)) {
    return {
      passed: true,
      reason: 'sell signal bypasses instrument adaptation gate',
    };
  }

  const monitorPrice = params.monitorSnapshot.price;
  if (!Number.isFinite(monitorPrice) || monitorPrice <= 0) {
    return {
      passed: false,
      reason: 'monitor price invalid',
    };
  }

  const seatMode = resolveSeatMode(params.monitorContext.config);
  const quote = params.signal.action === 'BUYCALL' ? params.longQuote : params.shortQuote;
  if (!quote?.staticInfo) {
    return {
      passed: false,
      reason: 'seat quote static info missing',
    };
  }

  const distancePercent = computeDistancePercent({
    monitorPrice,
    quote,
  });
  if (distancePercent === null) {
    return {
      passed: false,
      reason: 'call price invalid',
    };
  }

  const rules = params.monitorContext.config.strategyConfig.instrumentAdaptationRules;
  if (params.signal.action === 'BUYCALL') {
    if (quote.staticInfo.warrantType !== 'BULL') {
      return {
        passed: false,
        reason: 'non-bull instrument on long seat',
      };
    }

    const threshold =
      seatMode === 'auto' ? rules.autoSearchPrimaryDistanceBull : rules.bullBuyMinDistancePct;
    return distancePercent > threshold
      ? {
          passed: true,
          reason: `bull distance ${distancePercent.toFixed(3)}% > ${threshold.toFixed(3)}%`,
        }
      : {
          passed: false,
          reason: `bull distance ${distancePercent.toFixed(3)}% <= ${threshold.toFixed(3)}%`,
        };
  }

  if (quote.staticInfo.warrantType !== 'BEAR') {
    return {
      passed: false,
      reason: 'non-bear instrument on short seat',
    };
  }

  const threshold =
    seatMode === 'auto' ? rules.autoSearchPrimaryDistanceBear : rules.bearBuyMaxDistancePct;
  return distancePercent < threshold
    ? {
        passed: true,
        reason: `bear distance ${distancePercent.toFixed(3)}% < ${threshold.toFixed(3)}%`,
      }
    : {
        passed: false,
        reason: `bear distance ${distancePercent.toFixed(3)}% >= ${threshold.toFixed(3)}%`,
      };
}

/**
 * 执行信号处理流水线。
 * 调用策略生成平仓信号后，对每个信号进行席位校验（状态、版本、标的匹配）和数据丰富，
 * 再按信号类型分流到买卖任务队列。
 * 非交易时段或门禁关闭时记录日志并释放信号对象。
 */
export function runSignalPipeline(params: SignalPipelineParams): void {
  const {
    monitorSnapshot,
    monitorContext,
    mainContext,
    runtimeFlags,
    seatInfo,
    releaseSignal,
    releasePosition,
  } = params;
  const baseInstrumentSymbol = monitorContext.config.baseInstrumentSymbol;
  const { canTradeNow, openProtectionActive, isTradingEnabled } = runtimeFlags;
  const canEnqueue = isTradingEnabled && canTradeNow;
  const { strategy, orderRecorder } = monitorContext;
  const { lastState, buyTaskQueue, sellTaskQueue } = mainContext;
  const {
    longSeatState,
    shortSeatState,
    longSeatVersion,
    shortSeatVersion,
    longSymbol,
    shortSymbol,
    longQuote,
    shortQuote,
  } = seatInfo;
  const { longPosition, shortPosition } = getPositions(
    lastState.positionCache,
    longSymbol,
    shortSymbol,
  );
  try {
    if (openProtectionActive) {
      logger.debug(
        `[跳过信号] ${formatSymbolDisplay(baseInstrumentSymbol, monitorContext.baseInstrumentName)} 处于开盘保护窗口，暂停信号分流`,
      );
      return;
    }

    const signals = strategy.generateSignals(
      monitorSnapshot.factorSnapshot ?? null,
      longSymbol,
      shortSymbol,
      orderRecorder,
    );

    /**
     * 丰富信号：名称、价格、lotSize。
     * 买卖信号的 price/lotSize 均不在此处写入，由买卖处理器在执行时按「执行时行情」写入，保证委托价与当前价一致。
     */
    function enrichSignal(signal: Signal): void {
      const sigSymbol = signal.symbol;
      if (sigSymbol === longSymbol && longQuote) {
        if (signal.symbolName === null && longQuote.name !== null) {
          signal.symbolName = longQuote.name;
        }

        return;
      }

      if (
        sigSymbol === shortSymbol &&
        shortQuote &&
        signal.symbolName === null &&
        shortQuote.name !== null
      ) {
        signal.symbolName = shortQuote.name;
      }
    }

    function resolveSeatForSignal(signal: Signal): Readonly<{
      seatSymbol: string;
      seatVersion: number;
      quote: Quote | null;
      isBuySignal: boolean;
    }> | null {
      const isBuySignal = isBuyAction(signal.action);
      const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
      const seatState = isLongSignal ? longSeatState : shortSeatState;
      if (!isSeatActive(seatState)) {
        return null;
      }

      const seatSymbol = seatState.symbol;
      const seatVersion = isLongSignal ? longSeatVersion : shortSeatVersion;
      const quote = isLongSignal ? longQuote : shortQuote;
      return { seatSymbol, seatVersion, quote, isBuySignal };
    }

    /**
     * 校验信号合法性并完成数据丰富。
     * 依次检查信号字段完整性、action 合法性、席位就绪状态、标的匹配及行情就绪，
     * 任一校验失败则释放信号对象并返回 false。通过后写入当前席位版本与标的名称。
     */
    function prepareSignal(signal: Signal): boolean {
      if (!signal.symbol) {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(signal)}`);
        releaseSignal(signal);
        return false;
      }

      if (!VALID_SIGNAL_ACTIONS.has(signal.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${signal.action}, 标的: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)}`,
        );
        releaseSignal(signal);
        return false;
      }

      const seatInfoForSignal = resolveSeatForSignal(signal);
      if (!seatInfoForSignal) {
        const isLongSignal = signal.action === 'BUYCALL' || signal.action === 'SELLCALL';
        const seatState = isLongSignal ? longSeatState : shortSeatState;
        logger.debug(
          `[跳过信号] ${describeSeatUnavailable(seatState)}: ${formatSignalLog(signal)}`,
        );
        releaseSignal(signal);
        return false;
      }

      if (signal.symbol !== seatInfoForSignal.seatSymbol) {
        logger.debug(`[跳过信号] 席位已切换: ${formatSignalLog(signal)}`);
        releaseSignal(signal);
        return false;
      }

      if (seatInfoForSignal.isBuySignal && !seatInfoForSignal.quote) {
        logger.debug(`[跳过信号] 行情未就绪: ${formatSignalLog(signal)}`);
        releaseSignal(signal);
        return false;
      }

      signal.seatVersion = seatInfoForSignal.seatVersion;
      enrichSignal(signal);
      return true;
    }

    for (const signal of signals) {
      if (!prepareSignal(signal)) {
        continue;
      }

      if (canEnqueue) {
        const adaptationResult = applyInstrumentAdaptationGate({
          signal,
          monitorSnapshot,
          longQuote,
          shortQuote,
          monitorContext,
        });
        if (!adaptationResult.passed) {
          logger.debug(
            `[跳过信号] instrument adaptation rejected: ${formatSignalLog(signal)} reason=${adaptationResult.reason}`,
          );
          releaseSignal(signal);
          continue;
        }

        logger.debug(`[立即信号] ${formatSignalLog(signal)}`);
        const isSellSignal = isSellAction(signal.action);
        if (isSellSignal) {
          sellTaskQueue.push({
            type: 'IMMEDIATE_SELL',
            data: signal,
          });
        } else {
          buyTaskQueue.push({
            type: 'IMMEDIATE_BUY',
            data: signal,
          });
        }
      } else {
        const reason = isTradingEnabled ? '非交易时段，暂不执行' : '交易门禁关闭，暂不执行';
        logger.debug(`[立即信号] ${formatSignalLog(signal)}（${reason}）`);
        releaseSignal(signal);
      }
    }
  } finally {
    if (longPosition) {
      releasePosition(longPosition);
    }

    if (shortPosition) {
      releasePosition(shortPosition);
    }
  }
}
