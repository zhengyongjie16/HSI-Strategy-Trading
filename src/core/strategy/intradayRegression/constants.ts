/** 当前策略私有规则常量；不包含宿主风险冷却或全局发现规则。 */
export const SIGNAL_CONFIG_SUPPORTED_INDICATORS = Object.freeze(['MFI', 'K', 'D', 'J'] as const);
export const VERIFICATION_FIXED_INDICATORS: ReadonlyArray<string> = Object.freeze([
  'K',
  'D',
  'J',
  'MACD',
  'DIF',
  'DEA',
  'ADX',
]);
export const VERIFICATION_OFFSETS_MS = Object.freeze([0, 5_000, 10_000]);
export const VERIFICATION_READY_MS = 10_000;
export const RETENTION_MARGIN_MS = 15_000;
export const ACTION_RULES = Object.freeze([
  Object.freeze({
    action: 'BUYCALL',
    direction: 'LONG',
    side: 'buy',
    configKey: 'buycall',
    reasonPrefix: '买入做多信号',
  } as const),
  Object.freeze({
    action: 'SELLCALL',
    direction: 'LONG',
    side: 'sell',
    configKey: 'sellcall',
    reasonPrefix: '卖出做多信号',
  } as const),
  Object.freeze({
    action: 'BUYPUT',
    direction: 'SHORT',
    side: 'buy',
    configKey: 'buyput',
    reasonPrefix: '买入做空信号',
  } as const),
  Object.freeze({
    action: 'SELLPUT',
    direction: 'SHORT',
    side: 'sell',
    configKey: 'sellput',
    reasonPrefix: '卖出做空信号',
  } as const),
]);
