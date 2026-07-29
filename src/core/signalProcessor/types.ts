import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { BuySignal, ExecutableSellSignal } from '../../types/signal.js';
import type { TradingConfig } from '../../types/config.js';
import type { BuyRiskCheckContext, OrderRecorder } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

// ==================== 结果类型定义 ====================

/**
 * 卖出上下文校验结果（联合类型）。
 * 类型用途：描述卖出前上下文校验结果，成功时携带可用数量与当前价，失败时携带拒绝原因。
 * 数据来源：由 signalProcessor 卖出前校验逻辑构造。
 * 使用范围：仅 signalProcessor 模块内部与其直接调用方使用。
 */
export type SellContextValidationResult =
  | {
      readonly valid: true;
      readonly availableQuantity: number;
      readonly currentPrice: number;
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

/**
 * 卖量计算后被拒绝执行的卖出信号。
 * 类型用途：保留原可执行卖出信号的路由身份和业务上下文，同时将动作明确转为 HOLD。
 * 数据来源：processSellSignals 在持仓、行情或可卖数量不满足执行条件时构造。
 * 使用范围：signalProcessor 输出与 sellProcessor HOLD guard 之间。
 */
type HeldSellSignal = Omit<ExecutableSellSignal, 'action' | 'isProtectiveLiquidation'> & {
  readonly action: 'HOLD';
  readonly isProtectiveLiquidation: false;
};

/**
 * 卖量计算结果信号。
 * 类型用途：区分仍可执行的卖出信号与已明确转为 HOLD 的非保护性信号。
 * 数据来源：processSellSignals 对 ExecutableSellSignal 逐项计算后返回。
 * 使用范围：signalProcessor 与 sellProcessor 的返回值契约。
 */
export type ProcessedSellSignal = ExecutableSellSignal | HeldSellSignal;

/**
 * 卖出信号处理入参。
 * 类型用途：统一承载 processSellSignals 卖出数量计算所需的行情、持仓、订单记录与时间上下文。
 * 数据来源：由卖出处理链路在调用前组装。
 * 使用范围：signalProcessor 模块与调用方之间的参数契约。
 */
export type ProcessSellSignalsParams = {
  readonly signals: ReadonlyArray<ExecutableSellSignal>;
  readonly longPosition: Position | null;
  readonly shortPosition: Position | null;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly orderRecorder: OrderRecorder;
  readonly smartCloseEnabled: boolean;
  readonly smartCloseTimeoutMinutes: number | null;
  readonly nowMs: number;
  readonly isHalfDay: boolean;
  readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
};

// ==================== 服务接口定义 ====================

/**
 * 信号处理器接口。
 * 类型用途：定义卖出数量计算与买入信号风险检查能力，供主程序依赖注入。
 * 数据来源：由 createSignalProcessor 工厂实现并返回。
 * 使用范围：主程序与异步处理器通过该接口调用 signalProcessor 能力。
 */
export interface SignalProcessor {
  /**
   * 处理卖出信号，计算实际卖出数量
   * 根据智能平仓配置决定是全仓卖出还是按三阶段智能平仓卖出
   */
  processSellSignals: (params: ProcessSellSignalsParams) => ReadonlyArray<ProcessedSellSignal>;

  /**
   * 对买入信号列表应用风险检查。
   * 买入轻检查顺序：风险检查冷却 → 交易频率 → 清仓冷却 → 买入价格限制 → 末日保护 → 牛熊证风险。
   * 仅当上述轻检查全部通过后，才实时拉取账户/持仓并执行基础风险检查。
   * 风险检查阶段不会刷新买入频率状态，即不会在此阶段记录买入尝试。
   */
  applyRiskChecks: (
    signals: ReadonlyArray<BuySignal>,
    context: BuyRiskCheckContext,
  ) => Promise<ReadonlyArray<BuySignal>>;

  /**
   * 清空风险检查冷却时间记录
   * 跨日或重置场景下调用，确保新的一天不受前一天冷却状态影响
   */
  resetRiskCheckCooldown: () => void;
}

// ==================== 依赖类型定义 ====================

/**
 * 创建 SignalProcessor 所需依赖。
 * 类型用途：约束 createSignalProcessor 的依赖注入形状。
 * 数据来源：由 app 组装层在启动时注入。
 * 使用范围：仅 signalProcessor 工厂创建阶段使用。
 */
export type SignalProcessorDeps = {
  readonly tradingConfig: TradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};
