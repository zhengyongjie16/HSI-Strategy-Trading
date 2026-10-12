import type { Position } from '../../types/account.js';
import type { BuySignal, SignalType } from '../../types/signal.js';
import type {
  MarketDataClient,
  OrderRecorder,
  BullBearWarrantType,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
  UnrealizedLossData,
  PreparedUnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/services.js';

/**
 * 牛熊证信息。
 * 类型用途：区分非轮证（isWarrant=false）与轮证（isWarrant=true），供风险检查使用。
 * 数据来源：WarrantRiskChecker 通过 Longbridge API 查询后解析填充。
 * 使用范围：仅在 riskController 模块内部使用。
 */
export type WarrantInfo =
  | { readonly isWarrant: false }
  | {
      readonly isWarrant: true;
      readonly warrantType: BullBearWarrantType;
      readonly callPrice: string | null;
      readonly symbol: string;
    };

// ==================== 服务接口定义 ====================

/**
 * 牛熊证风险检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供牛熊证风险与距离检查。
 * 数据来源：如适用。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface WarrantRiskChecker {
  setWarrantInfoFromCallPrice: (
    symbol: string,
    callPrice: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => WarrantRefreshResult;
  refreshWarrantInfoForSymbol: (
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ) => Promise<WarrantRefreshResult>;
  checkRisk: (
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: string,
  ) => RiskCheckResult;
  checkWarrantDistanceLiquidation: (
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: string,
  ) => WarrantDistanceLiquidationResult;
  getWarrantDistanceInfo: (
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: string | null,
  ) => WarrantDistanceInfo | null;
  clearLongWarrantInfo: () => void;
  clearShortWarrantInfo: () => void;
}

/**
 * 持仓限制检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供买入前单标的最大持仓市值限制检查。
 * 数据来源：如适用（配置中的 maxPositionNotional）。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface PositionLimitChecker {
  checkLimit: (
    signal: BuySignal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: string,
  ) => RiskCheckResult;
}

/**
 * 浮亏检查器接口。
 * 类型用途：依赖注入，由 RiskChecker 门面聚合，提供浮亏计算与阈值检查。
 * 数据来源：如适用。
 * 使用范围：仅 riskController 模块实现；主程序通过 RiskChecker 使用。
 */
export interface UnrealizedLossChecker {
  getUnrealizedLossData: (symbol: string) => UnrealizedLossData | undefined;

  /** 清空浮亏数据，symbol 为空时清空全部 */
  clearUnrealizedLossData: (symbol?: string | null) => void;
  prepare: (
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    dailyLossOffset: string,
  ) => PreparedUnrealizedLossData;
  publish: (prepared: PreparedUnrealizedLossData) => void;
  check: (symbol: string, currentPrice: string, isLongSymbol: boolean) => UnrealizedLossCheckResult;
}

// ==================== 依赖类型定义 ====================

/**
 * 持仓限制检查器依赖。
 * 类型用途：用于创建 PositionLimitChecker 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxPositionNotional）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: string | null;
};

/**
 * 浮亏检查器依赖。
 * 类型用途：用于创建 UnrealizedLossChecker 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxUnrealizedLossPerSymbol）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type UnrealizedLossCheckerDeps = {
  readonly maxUnrealizedLossPerSymbol: string | null;
};

/**
 * 风险检查器依赖。
 * 类型用途：用于创建 RiskChecker 门面时的依赖注入；阈值配置由各子检查器依赖持有。
 * 数据来源：启动装配层创建的牛熊证、持仓限制与浮亏子检查器。
 * 使用范围：见调用方（如 riskDomain/启动层）。
 */
export type RiskCheckerDeps = {
  readonly warrantRiskChecker: WarrantRiskChecker;
  readonly positionLimitChecker: PositionLimitChecker;
  readonly unrealizedLossChecker: UnrealizedLossChecker;
};

/**
 * 浮亏监控器依赖。
 * 类型用途：用于创建 UnrealizedLossMonitor 时的依赖注入。
 * 数据来源：如适用（如配置中的 maxUnrealizedLossPerSymbol）。
 * 使用范围：仅 riskController 模块内部使用。
 */
export type UnrealizedLossMonitorDeps = {
  /** 单标的最大浮亏阈值（港币），<=0 表示禁用浮亏监控 */
  readonly maxUnrealizedLossPerSymbol: string;
};
