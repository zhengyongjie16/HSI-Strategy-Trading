/**
 * K 线数据值类型。
 * 类型用途：承接 Longbridge SDK 的 Decimal 形态与原始数值，作为 CandleData 各 OHLCV 字段的类型。
 * 数据来源：Longbridge K 线 API 返回。
 * 使用范围：CandleData 字段内部复用，不作为跨模块公共类型导出。
 */
type CandleValue = number | string | { toString: () => string } | null | undefined;

/**
 * 已标准化的单根 K 线。
 * 类型用途：表示行情缓存交给事件宿主与策略的 primitive-only OHLCV 事实，避免 SDK 对象引用跨边界传播。
 * 数据来源：行情缓存对 Longbridge K 线推送或 seed 结果的标准化。
 * 使用范围：缓存快照、策略快照及其共享调用链；不作为数学模块的宽输入替代。
 */
export type NormalizedCandle = {
  /** K 线时间戳（毫秒） */
  readonly timestamp?: number;

  /** 开盘价；缺失或无效时保留为 undefined */
  readonly open: number | string | null | undefined;

  /** 最高价；缺失或无效时保留为 undefined */
  readonly high: number | string | null | undefined;

  /** 最低价；缺失或无效时保留为 undefined */
  readonly low: number | string | null | undefined;

  /** 收盘价；缺失或无效时保留为 undefined */
  readonly close: number | string | null | undefined;

  /** 成交量；缺失或无效时保留为 undefined */
  readonly volume: number | string | null | undefined;
};

/**
 * K 线数据。
 * 类型用途：表示单根 K 线的 OHLCV 数据，用于指标计算、策略输入等。
 * 数据来源：Longbridge K 线 API（如 candlesticks、实时 K 线）。
 * 使用范围：共享指标数学模块与策略等；全项目可引用。
 */
export type CandleData = {
  /** K 线时间戳（毫秒） */
  readonly timestamp?: number;

  /** 最高价 */
  readonly high?: CandleValue;

  /** 最低价 */
  readonly low?: CandleValue;

  /** 收盘价 */
  readonly close?: CandleValue;

  /** 开盘价 */
  readonly open?: CandleValue;

  /** 成交量 */
  readonly volume?: CandleValue;
};
