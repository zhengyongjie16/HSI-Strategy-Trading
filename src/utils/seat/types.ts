import type { SeatState } from '../../types/seat.js';

/**
 * 监控上下文席位快照。
 * 类型用途：统一表达从 symbolRegistry 派生出的多空席位状态、版本与当前就绪标的代码。
 * 数据来源：由 resolveMonitorContextSeatSnapshot 基于 symbolRegistry 计算。
 * 使用范围：app/main 共享的 MonitorContext 运行时同步逻辑使用。
 */
export type MonitorContextSeatSnapshot = Readonly<{
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };
  longSymbol: string | null;
  shortSymbol: string | null;
}>;

/**
 * 监控上下文标的名称快照。
 * 类型用途：统一表达 MonitorContext 需要写回的名称派生结果。
 * 数据来源：由 resolveMonitorContextSymbolNames 基于席位快照、唯一 monitorSymbol 与 quotesMap 计算。
 * 使用范围：createMonitorContext、rebuildTradingDayState 等重建与装配链路使用。
 */
export type MonitorContextSymbolNames = Readonly<{
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
}>;
