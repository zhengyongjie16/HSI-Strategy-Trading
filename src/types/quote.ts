import type { FactorSnapshot } from './factor.js';

/**
 * 行情静态信息。
 * 类型用途：标的静态元数据（名称、每手股数、回收价、到期日、牛熊证类型等），作为 Quote.staticInfo 的类型。
 * 数据来源：Longbridge 行情 API（如 getQuotes 返回的静态字段）。
 * 使用范围：Quote、风控与牛熊证距离计算等；全项目可引用。
 */
export type QuoteStaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly callPrice?: number | null;
  readonly expiryDate?: string | null;
  readonly issuePrice?: number | null;
  readonly conversionRatio?: number | null;
  readonly warrantType?: 'BULL' | 'BEAR' | null;
  readonly underlyingSymbol?: string | null;
};

/**
 * 行情数据。
 * 类型用途：实时行情快照，作为 getQuotes 返回值、策略与风控的行情入参。
 * 数据来源：Longbridge 行情推送或 getQuotes。
 * 使用范围：行情客户端、策略、风控、订单监控等；全项目可引用。
 */
export type Quote = {
  /** 标的代码 */
  readonly symbol: string;

  /** 标的名称 */
  readonly name: string | null;

  /** 当前价格 */
  readonly price: number;

  /** 前收盘价 */
  readonly prevClose: number;

  /** 行情时间戳 */
  readonly timestamp: number;

  /** 每手股数 */
  readonly lotSize?: number;

  /** 原始行情数据 */
  readonly raw?: unknown;

  /** 静态信息（如回收价、每手股数等） */
  readonly staticInfo?: QuoteStaticInfo | null;
};

/**
 * KDJ 指标。
 * 类型用途：表示 K/D/J 三个分量，供展示层、工具脚本与测试消费。
 * 数据来源：由指标计算逻辑生成。
 * 使用范围：IndicatorSnapshot、tools 与相关测试；全项目可引用。
 */
export type KDJIndicator = {
  readonly k: number;
  readonly d: number;
  readonly j: number;
};

/**
 * MACD 指标。
 * 类型用途：表示 macd/dif/dea 三个分量，供展示层、工具脚本与测试消费。
 * 数据来源：由指标计算逻辑生成。
 * 使用范围：IndicatorSnapshot、tools 与相关测试；全项目可引用。
 */
export type MACDIndicator = {
  readonly macd: number;
  readonly dif: number;
  readonly dea: number;
};

/**
 * 运行时快照。
 * 类型用途：承载趋势因子主链路向展示层和策略层交付的最小运行时视图。
 * 数据来源：由 factor runtime 与 processMonitor 组装得到。
 * 使用范围：展示层、策略层与相关测试；全项目可引用。
 */
export type IndicatorSnapshot = {
  /** 标的代码（可选，因为 Quote 已包含） */
  readonly symbol?: string;

  /** 当前价格 */
  readonly price: number;

  /** 涨跌幅（百分比） */
  readonly changePercent: number | null;

  /** 趋势策略的上层因子快照 */
  readonly factorSnapshot?: FactorSnapshot | null;

  /**
   * 旧指标字段保留为可选兼容字段，便于过渡期测试替身继续构造快照。
   * 主运行时链路不再消费这些字段。
   */
  readonly ema?: Readonly<Record<number, number>> | null;
  readonly rsi?: Readonly<Record<number, number>> | null;
  readonly psy?: Readonly<Record<number, number>> | null;
  readonly mfi?: number | null;
  readonly kdj?: KDJIndicator | null;
  readonly macd?: MACDIndicator | null;
  readonly adx?: number | null;
};
