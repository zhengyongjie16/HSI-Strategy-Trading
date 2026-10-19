import type { AccountSnapshot, Position } from './account.js';
import type { BuySignal } from './signal.js';
import type {
  BullBearWarrantType,
  WarrantRiskPublisher,
  WarrantRiskReader,
} from './warrantRisk.js';
import type { UnrealizedLossProjection, UnrealizedLossReader } from './unrealizedLoss.js';

/**
 * 风险检查结果。
 * 类型用途：买入订单前/牛熊证风险检查的返回值，表示是否允许交易、原因及牛熊证风险信息。
 * 数据来源：RiskChecker.checkBeforeOrder、checkWarrantRisk 等。
 * 使用范围：信号处理、买卖流程、风控链路；全项目可引用。
 */
export type RiskCheckResult = {
  /** 是否允许交易 */
  readonly allowed: boolean;

  /** 不允许原因 */
  readonly reason?: string;

  /** 牛熊证风险信息 */
  readonly warrantInfo?: {
    /** 是否为牛熊证 */
    readonly isWarrant: boolean;

    /** 牛熊证类型 */
    readonly warrantType: BullBearWarrantType;

    /** 距离回收价百分比 */
    readonly distanceToStrikePercent: string;
  };
};

/** 买入前现金及单标的持仓限额的同步检查；不读取 API 或持有订单执行入口。 */
interface OrderRiskChecker {
  /** 买入订单前风险检查（现金与持仓限制） */
  readonly checkBeforeOrder: (params: {
    readonly account: AccountSnapshot | null;
    readonly positions: ReadonlyArray<Position> | null;
    readonly signal: BuySignal;
    readonly orderNotional: string;
  }) => RiskCheckResult;
}

/** 唯一同步 risk 工厂的真实产物；只组合已存在的 warrant/浮亏状态，不含 IO 或 workflow。 */
export interface RiskChecker
  extends
    OrderRiskChecker,
    WarrantRiskReader,
    WarrantRiskPublisher,
    UnrealizedLossReader,
    UnrealizedLossProjection {}
