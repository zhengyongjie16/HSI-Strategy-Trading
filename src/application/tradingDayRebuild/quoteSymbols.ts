/**
 * 交易日重建行情标的收集：按监控、席位、持仓和订单保留事实合并去重。
 */
import type { Position } from '../../types/account.js';
import type { SymbolRegistry } from '../../types/seat.js';

/**
 * 收集运行时需要获取行情的标的代码集合（监控标的 + 席位占用标的 + 持仓标的 + 订单持有标的）。默认行为：合并去重后返回 Set。
 *
 * @param monitorConfig 唯一监控配置（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，用于解析席位当前占用标的
 * @param positions 当前持仓数组
 * @param orderHoldSymbols 订单持有标的集合
 * @returns 需要拉取行情的标的代码集合
 */
export function collectRuntimeQuoteSymbols(
  monitorConfig: {
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  },
  symbolRegistry: SymbolRegistry,
  positions: ReadonlyArray<Position>,
  orderHoldSymbols: ReadonlySet<string>,
): Set<string> {
  const symbols = collectAllQuoteSymbols(monitorConfig, symbolRegistry);
  for (const position of positions) {
    if (position.symbol) {
      symbols.add(position.symbol);
    }
  }

  for (const symbol of orderHoldSymbols) {
    if (symbol) {
      symbols.add(symbol);
    }
  }

  return symbols;
}

/**
 * 收集所有需要获取行情的标的代码（监控标的 + 席位占用标的），供运行时快照与订阅链路批量拉取行情。
 *
 * @param monitorConfig 唯一监控配置（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，可选；传入时从席位状态解析做多/做空占用标的并加入集合
 * @returns 需要拉取行情的标的代码集合
 */
function collectAllQuoteSymbols(
  monitorConfig: {
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  },
  symbolRegistry?: SymbolRegistry | null,
): Set<string> {
  const symbols = [monitorConfig.monitorSymbol];
  if (!symbolRegistry) {
    return new Set(symbols);
  }

  const longSeat = symbolRegistry.getSeatState('LONG');
  const shortSeat = symbolRegistry.getSeatState('SHORT');
  if (longSeat.symbol) {
    symbols.push(longSeat.symbol);
  }

  if (shortSeat.symbol) {
    symbols.push(shortSeat.symbol);
  }

  return new Set(symbols);
}
