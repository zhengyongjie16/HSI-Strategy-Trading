/** 订单归属解析常量（标准化规则 + 多空标记），不依赖 SDK。 */
export const ORDER_OWNERSHIP = {
  NORMALIZE_PATTERN: /[^\p{L}\p{N}]/gu,
  LONG_MARKERS: ['RC', 'BULL', 'CALL', '\u725B'],
  SHORT_MARKERS: ['RP', 'BEAR', 'PUT', '\u718A'],
} as const;
