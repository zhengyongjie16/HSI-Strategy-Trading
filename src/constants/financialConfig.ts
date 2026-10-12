/** 金额配置普通十进制文本限制；不用于 SDK、历史或派生财务事实。 */
export const AMOUNT_CONFIG_TEXT_PATTERN = /^\d{1,10}(?:\.\d{1,3})?$/;

/** 金融配置默认值，直接以文本进入精确计算。 */
export const FINANCIAL_CONFIG_DEFAULTS = {
  targetNotional: '10000',
  maxPositionNotional: '100000',
  maxUnrealizedLossPerSymbol: '0',
} as const;
