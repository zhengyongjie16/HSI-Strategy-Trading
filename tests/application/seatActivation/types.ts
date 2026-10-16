import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { RuntimeClock } from '../../../src/types/runtime.js';
import type { MonitorContextAssembly } from '../../../src/app/context/types.js';
import type { MarketDataClient } from '../../../src/types/marketPorts.js';
import type { SeatActivationSubscriptions } from '../../../src/application/seatActivation/types.js';

/** 激活测试使用的显式装配输入；生产 workflow 仅消费各 owner 的窄能力。 */
export type ActivationFixtureDeps = Readonly<{
  clock: RuntimeClock;
  monitorContext: MonitorContextAssembly;
  snapshot: Pick<AccountPositionSnapshot, 'getView' | 'isCurrent' | 'requestRefresh'>;
  marketDataClient: Pick<MarketDataClient, 'getQuotes'>;
  quoteSubscriptionRuntime: SeatActivationSubscriptions;
}>;
