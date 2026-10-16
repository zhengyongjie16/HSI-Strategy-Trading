import type { PostTradeConsistencyRuntime } from '../../../src/app/runtime/types.js';
import type { QuoteSubscriptionRuntime } from '../../../src/runtime/quoteSubscriptionRuntime/types.js';
import type { AccountPositionSnapshot } from '../../../src/types/accountPosition.js';
import type { RuntimeTermination } from '../../../src/types/runtime.js';

/** 重建用例共享的真实 H/S/订阅夹具结果；只记录受控行情订阅的外部 IO。 */
export type RebuildHarness = {
  readonly snapshot: AccountPositionSnapshot;
  readonly termination: RuntimeTermination;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyRuntime;
  readonly quoteSubscriptionRuntime: QuoteSubscriptionRuntime;
  readonly subscribed: ReadonlyArray<ReadonlyArray<string>>;
};
