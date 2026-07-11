import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry, SeatState } from '../../types/seat.js';
import type { MonitorContextSeatSnapshot, MonitorContextSymbolNames } from './types.js';

/**
 * 解析可消费的 ACTIVE 席位标的代码。
 * 默认行为：仅当 seat 处于 ACTIVE 且 symbol 为非空字符串时返回 symbol，否则返回 null。
 *
 * @param seatState 席位状态
 * @returns 当前可消费的席位标的代码，或 null
 */
function resolveActiveSeatSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'ACTIVE') {
    return null;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0
    ? seatState.symbol
    : null;
}

/**
 * 解析唯一 monitorContext 的席位快照。
 * 默认行为：读取 symbolRegistry 中的多空席位状态与版本，并派生当前可消费的 ACTIVE 标的代码。
 *
 * @param symbolRegistry 席位注册表
 * @returns 席位状态、版本与当前就绪标的代码快照
 */
export function resolveMonitorContextSeatSnapshot(
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>,
): MonitorContextSeatSnapshot {
  const longSeatState = symbolRegistry.getSeatState('LONG');
  const shortSeatState = symbolRegistry.getSeatState('SHORT');
  return {
    seatState: {
      long: longSeatState,
      short: shortSeatState,
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion('LONG'),
      short: symbolRegistry.getSeatVersion('SHORT'),
    },
    longSymbol: resolveActiveSeatSymbol(longSeatState),
    shortSymbol: resolveActiveSeatSymbol(shortSeatState),
  };
}

/**
 * 解析唯一 monitorContext 的标的名称。
 * 默认行为：基于席位快照、已验证的唯一 monitorSymbol 与 quotesMap 派生名称字段。
 *
 * @param params 席位注册表、唯一监控标的与行情 Map
 * @returns MonitorContext 所需的名称派生结果
 */
export function resolveMonitorContextSymbolNames(params: {
  readonly symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion'>;
  readonly monitorSymbol: string;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}): MonitorContextSymbolNames {
  const { symbolRegistry, monitorSymbol, quotesMap } = params;
  const seatSnapshot = resolveMonitorContextSeatSnapshot(symbolRegistry);
  const { longSymbol, shortSymbol } = seatSnapshot;
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(monitorSymbol) ?? null;
  return {
    longSymbolName: longSymbol ? (longQuote?.name ?? longSymbol) : '',
    shortSymbolName: shortSymbol ? (shortQuote?.name ?? shortSymbol) : '',
    monitorSymbolName: monitorQuote?.name ?? monitorSymbol,
  };
}
