import type { RiskCheckResult } from './riskCheck.js';
import type { SignalType } from './signal.js';

/**
 * 牛熊证类型。
 * 类型用途：区分牛证（做多）与熊证（做空），用于 RiskCheckResult、WarrantInfo 等字段。
 * 数据来源：Longbridge 行情静态信息或 RiskChecker 解析。
 * 使用范围：RiskChecker、UI/监控展示等；全项目可引用。
 */
export type BullBearWarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息。
 * 类型用途：保存未除法、未舍入的距回收价比例基数，用于风控交叉乘比较与终态展示。
 * 数据来源：RiskChecker 根据权威行情与回收价计算；已知分母严格为正，未知时分子/分母同时为 null。
 * 使用范围：RiskChecker、UI/监控展示；全项目可引用。
 */
export type WarrantDistanceInfo = {
  /** 距回收价比例的精确十进制分子，尚未乘以百分比单位 100 */
  readonly distanceNumerator: string | null;

  /** 距回收价比例的精确十进制分母；已知时严格为正 */
  readonly distanceDenominator: string | null;
};

/**
 * 牛熊证信息刷新结果。
 * 类型用途：表示刷新牛熊证信息的结果（ok/notWarrant/error/skipped），作为 setWarrantInfoFromCallPrice、refreshWarrantInfoForSymbol 返回值。
 * 数据来源：同步 RiskChecker 的已知回收价发布，或 WarrantRiskRefresh 的外部事实查询。
 * 使用范围：同步风险检查、风险刷新用例、调用方与 UI；全项目可引用。
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok' }
  | { readonly status: 'notWarrant' }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'skipped' };

/**
 * 牛熊证距回收价清仓判定结果。
 * 类型用途：表示是否应因距回收价过近而清仓及原因，作为 checkWarrantDistanceLiquidation 返回值。
 * 数据来源：RiskChecker 根据当前价与回收价计算。
 * 使用范围：RiskChecker、信号处理/卖出逻辑；全项目可引用。
 */
export type WarrantDistanceLiquidationResult = {
  /** 是否触发清仓 */
  readonly shouldLiquidate: boolean;

  /** 判定原因 */
  readonly reason?: string;
};

/** 同一 warrant 缓存的同步风险/展示读取；买入、静态清仓和显示各自只取实际方法。 */
export interface WarrantRiskReader {
  /** 牛熊证风险检查（距离回收价阈值） */
  readonly checkWarrantRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: string,
  ) => RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  readonly checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: string,
  ) => WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  readonly getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: string | null,
  ) => WarrantDistanceInfo | null;
}

/** 回收价发布与席位清理共享既有 warrant 状态；不包含外部市场查询或异步重试。 */
export interface WarrantRiskPublisher {
  /** 从透传的回收价设置牛熊证信息（不调用 API） */
  readonly setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;

  /** 清空做多标的牛熊证信息缓存（换标时调用） */
  readonly clearLongWarrantInfo: () => void;

  /** 清空做空标的牛熊证信息缓存（换标时调用） */
  readonly clearShortWarrantInfo: () => void;
}
