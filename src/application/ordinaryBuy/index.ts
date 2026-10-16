/**
 * 普通 BUY 唯一用例 owner。
 * 按席位/行情准入、冷却与轻检查、临时实时双读取、基础风控、最终调用方授权的顺序推进；
 * 外部读取失败仅丢弃本次信号，内部错误与 UNKNOWN submission 原样抛给 FIFO worker 的 fatal 通道。
 */
import { createBuyRiskChecks } from './riskChecks.js';
import { formatError } from '../../utils/error/index.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';
import { exactCompare } from '../../utils/numeric/exact.js';
import {
  isSeatActive,
  validateSignalSeat,
  describeSignalSeatValidationFailure,
} from '../../domain/seat/seatPolicy.js';

import {
  isExternalApiRequestError,
  isUnconfirmedOrderSubmissionError,
} from '../../utils/apiFailure/index.js';
import type { BuySignal } from '../../types/signal.js';
import type { OrdinaryBuyWorkflow, OrdinaryBuyWorkflowDeps } from './types.js';

/** 直接持有冷却与完整普通 BUY 业务；不再经 SignalProcessor 混合买卖职责。 */
export function createOrdinaryBuyWorkflow(deps: OrdinaryBuyWorkflowDeps): OrdinaryBuyWorkflow {
  const {
    logger,
    config,
    symbolRegistry,
    orderRecorder,
    riskChecker,
    accountService,
    tradeFrequencyReader,
    orderExecutor,
    marketDataClient,
    getIsHalfDay,
    now,
    getCanProcessTask,
    snapshot,
    termination,
  } = deps;
  const lastRiskCheckTime = new Map<string, number>();
  const checkRisk = createBuyRiskChecks({
    logger,
    doomsdayProtection: deps.doomsdayProtection,
    liquidationCooldownTracker: deps.liquidationCooldownTracker,
    lastRiskCheckTime,
    reportFatalError: termination.reportFatalError,
  });

  /** 异步返回后及 execution mutation permit 内复核原交易日、生命周期与席位身份。 */
  async function execute(signal: BuySignal): Promise<void> {
    const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
    const dayEpoch = snapshot.getView().token.dayEpoch;
    const callerAuthorization = (): boolean =>
      !termination.isTerminated() &&
      getCanProcessTask() &&
      snapshot.getView().token.dayEpoch === dayEpoch &&
      validateSignalSeat({ signal, symbolRegistry }).valid;
    try {
      const runtimeAction: unknown = signal.action;
      if (runtimeAction !== 'BUYCALL' && runtimeAction !== 'BUYPUT') {
        throw new TypeError('普通 BUY 只接受买入信号');
      }

      const validation = validateSignalSeat({ signal, symbolRegistry });
      if (!validation.valid) {
        logger.debug(
          `[OrdinaryBuy] ${describeSignalSeatValidationFailure(validation)}，跳过: ${symbolDisplay}`,
        );
        return;
      }

      if (!callerAuthorization()) return;

      const longSeat = symbolRegistry.getSeatState('LONG');
      const shortSeat = symbolRegistry.getSeatState('SHORT');
      const longSymbol = isSeatActive(longSeat) ? longSeat.symbol : '';
      const shortSymbol = isSeatActive(shortSeat) ? shortSeat.symbol : '';
      const symbols = [config.monitorSymbol];
      if (longSymbol) symbols.push(longSymbol);

      if (shortSymbol && shortSymbol !== longSymbol) symbols.push(shortSymbol);

      const quotes = await marketDataClient.getQuotes(symbols);
      if (!callerAuthorization()) return;

      const longQuote = longSymbol ? (quotes.get(longSymbol) ?? null) : null;
      const shortQuote = shortSymbol ? (quotes.get(shortSymbol) ?? null) : null;
      const monitorQuote = quotes.get(config.monitorSymbol) ?? null;
      const tradeQuote = signal.action === 'BUYCALL' ? longQuote : shortQuote;
      if (!tradeQuote) {
        logger.warn(`[OrdinaryBuy] 买入标的行情缺失，跳过: ${symbolDisplay}`);
        return;
      }

      if (!monitorQuote || exactCompare(monitorQuote.price, '0') <= 0) {
        logger.warn(`[OrdinaryBuy] 监控行情缺失或无效，跳过: ${config.monitorSymbol}`);
        return;
      }

      const checked = await checkRisk([signal], {
        accountService,
        tradeFrequencyReader,
        riskChecker,
        orderRecorder,
        longQuote,
        shortQuote,
        monitorQuote,
        longSymbol,
        shortSymbol,
        longSymbolName: longQuote?.name ?? null,
        shortSymbolName: shortQuote?.name ?? null,
        currentTime: now(),
        isHalfDay: getIsHalfDay(),
        config,
      });
      if (checked.length === 0 || !callerAuthorization()) return;

      // 不再读取第二份处理器报价；最新价/整手数量/频率记录与最终门禁由 execution permit 原 owner 负责。
      const result = await orderExecutor.executeSignals([signal], callerAuthorization);
      if (!Array.isArray(result.executedOrderIds)) {
        throw new TypeError('信号执行必须显式报告原 accepted order IDs');
      }

      logger.debug(`[OrdinaryBuy] 买入处理完成: ${symbolDisplay} ${signal.action}`);
    } catch (error) {
      if (!isExternalApiRequestError(error) || isUnconfirmedOrderSubmissionError(error))
        throw error;

      logger.error(`[OrdinaryBuy] 处理失败: ${symbolDisplay} ${signal.action}`, formatError(error));
    }
  }

  return {
    execute,
    resetRiskCheckCooldown: () => {
      lastRiskCheckTime.clear();
    },
  };
}
