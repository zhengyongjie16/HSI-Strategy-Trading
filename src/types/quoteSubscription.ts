/** quote subscription 的中性保留能力；runtime 不依赖具体 main 订阅 owner。 */
export type QuoteRetainReason =
  | 'MONITOR_BASE'
  | 'SEAT_BOUND'
  | 'POSITION_HOLD'
  | 'ORDER_HOLD'
  | 'SWITCH_WAKEUP'
  | 'STATIC_LIQUIDATION_WAIT'
  | 'SEAT_REFRESH_WAIT';

/** quote retain 请求的最小中性载荷。 */
export type QuoteRetainRequest = Readonly<{
  readonly ownerKey: string;
  readonly reason: QuoteRetainReason;
  readonly symbols: Iterable<string>;
}>;

/** monitor/switch runtime 共享的 quote retain 窄端口。 */
export interface QuoteRetainPort {
  readonly retainSymbols: (params: QuoteRetainRequest) => Promise<void>;
  readonly releaseRetain: (
    params: Pick<QuoteRetainRequest, 'ownerKey' | 'reason'>,
  ) => Promise<void>;
}
