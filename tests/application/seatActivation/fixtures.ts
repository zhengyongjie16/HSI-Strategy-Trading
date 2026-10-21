/** 席位激活测试装配：绑定同一 Context 的真实事实 owner，不复制激活规则或重试决定。 */
import { createDiagnosticObserverDouble } from '../../helpers/diagnostics.js';
import { createSeatActivationWorkflow } from '../../../src/application/seatActivation/index.js';
import { logger } from '../../../src/infrastructure/logger/index.js';
import type { SeatActivationWorkflow } from '../../../src/application/seatActivation/types.js';
import type { ActivationFixtureDeps } from './types.js';

/** 将现有上下文的窄能力绑定到真实 application owner，测试可显式替换 I/O 端口。 */
export function createSeatActivationFixture(deps: ActivationFixtureDeps): SeatActivationWorkflow {
  const {
    monitorContext: context,
    snapshot,
    clock,
    marketDataClient,
    quoteSubscriptionRuntime,
  } = deps;
  return createSeatActivationWorkflow({
    termination: deps.termination,
    diagnostics: createDiagnosticObserverDouble(),
    clock,
    config: context.config,
    symbolRegistry: context.symbolRegistry,
    orders: context.orderRecorder,
    dailyLoss: context.dailyLossTracker,
    risk: {
      prepareUnrealizedLossData: (symbol, isLong, lossOffset) =>
        context.riskChecker.prepareUnrealizedLossData(
          context.orderRecorder,
          symbol,
          isLong,
          lossOffset,
        ),
      publishUnrealizedLossData: (prepared) => {
        context.riskChecker.publishUnrealizedLossData(prepared);
      },
      setWarrantInfoFromCallPrice: (...args) =>
        context.riskChecker.setWarrantInfoFromCallPrice(...args),
    },
    snapshot,
    subscriptions: quoteSubscriptionRuntime,
    getQuotes: (symbols) => marketDataClient.getQuotes(symbols),
    setDirectionSymbolName: (direction, name) => {
      if (direction === 'LONG') context.longSymbolName = name;
      else context.shortSymbolName = name;
    },
    logger,
  });
}
